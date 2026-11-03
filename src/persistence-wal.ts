/**
 * Write-ahead log (WAL) subsystem for persistence:
 * - Appending WAL entries and rotating ledger generations
 * - Reading ledger windows across generations
 * - Managing per-ledger monotonic sequence counters
 * - WAL entry factories (proposed, committed, aborted)
 * - State recovery (`recoverState`) combining snapshot and WAL replay
 * - State file snapshot writing (`writeStateFile`)
 */

import {type GoalState, TERMINAL_STATUSES} from './state-machine.ts';
import {
  MAX_STATE_FILE_BYTES,
  portableFileExists,
  portableFileSize,
  portableWriteFile,
} from './fs-portable.ts';
import {
  lstat as fsLstat,
  rename as fsRename,
  unlink as fsUnlink,
} from 'node:fs/promises';
import {toNonNegativeInteger} from './accounting.ts';
import {
  capString,
  deserializeGoal,
  deserializeResult,
  type GoalResult,
  MAX_GOAL_META_LENGTH,
  MAX_PERSISTED_ENTRIES,
  normalizePendingIntent,
  parseWalEntry,
  type PersistedState,
  readBoundedText,
  safeFileExists,
  type SerializedPendingIntent,
  serializeGoal,
  type SettlementReceipt,
  type WalEntry,
  type WalTransition,
} from './persistence.ts';

const STATE_VERSION = 1;

/**
 * Append a WAL entry to the JSONL ledger file as a single line.
 *
 * Employs atomic no-follow checks where supported (`O_NOFOLLOW`) and repairs torn
 * trailing writes before appending to avoid corrupting subsequent log lines.
 */
export async function appendWalEntry(
  ledgerPath: string,
  entry: WalEntry,
): Promise<void> {
  const {open} = await import('node:fs/promises');
  const {constants} = await import('node:fs');
  const line = JSON.stringify(entry) + '\n';

  // Reject symlinked ledger files. Where O_NOFOLLOW is available, opening with
  // O_NOFOLLOW fails with ELOOP on symlinks to eliminate TOCTOU race conditions.
  // On platforms lacking O_NOFOLLOW, we perform a pre-open lstat and verify identity post-open.
  const noFollowAvailable = Boolean(constants.O_NOFOLLOW);
  const before = noFollowAvailable
    ? undefined
    : await fsLstat(ledgerPath).catch(() => undefined);
  if (before?.isSymbolicLink() || (before && !before.isFile())) {
    throw new Error(
      `refusing to append to non-regular ledger file: ${ledgerPath}`,
    );
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const exclusiveCreate = !noFollowAvailable && !before ? constants.O_EXCL : 0;
  let handle;
  try {
    // Open O_RDWR instead of O_WRONLY to inspect the final byte before writing.
    // If a previous process crashed mid-append without a trailing newline, the next append
    // at EOF would merge the torn fragment and this entry into a single invalid line.
    handle = await open(
      ledgerPath,
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        exclusiveCreate |
        noFollow,
      0o600,
    );
  } catch (error) {
    // A concurrent creator won the exclusive first-open race; retry via the regular path.
    if (exclusiveCreate && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      return appendWalEntry(ledgerPath, entry);
    }
    throw error;
  }
  try {
    // On platforms without O_NOFOLLOW, verify that the opened file matches
    // the pre-open lstat identity to guard against symlink replacement races.
    if (!noFollowAvailable) {
      const after = await handle.stat();
      if (
        !after.isFile() ||
        (before && (after.dev !== before.dev || after.ino !== before.ino))
      ) {
        throw new Error(`ledger path changed during safe open: ${ledgerPath}`);
      }
    }

    // Repair torn tails before appending: if the file ends without a newline,
    // write a newline first so the malformed prefix is isolated as its own line
    // (which readers discard) and this new entry remains an intact record.
    const {size} = await handle.stat();
    if (size > 0) {
      const lastByte = Buffer.alloc(1);
      const {bytesRead} = await handle.read(lastByte, 0, 1, size - 1);
      if (bytesRead === 1 && lastByte[0] !== 0x0a) {
        await handle.write('\n');
      }
    }
    await handle.writeFile(line, 'utf8');
    try {
      await handle.chmod(0o600);
    } catch {
      // chmod is best-effort (e.g., unsupported on some filesystems).
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Rotate the ledger if it exceeds `maxBytes`.
 * Renames the current file to `.1`, shifts older generations up to `retentionFiles`,
 * and unlinks the oldest. If retention is 0, the active file is discarded directly.
 */
export async function rotateLedgerIfNeeded(
  ledgerPath: string,
  maxBytes: number,
  retentionFiles: number,
): Promise<void> {
  if (maxBytes <= 0) return;
  const size = await portableFileSize(ledgerPath);
  if (size < 0) return;
  if (size < maxBytes) return;

  if (retentionFiles === 0) {
    await fsUnlink(ledgerPath).catch((error: unknown) => {
      if ((error as {code?: string})?.code !== 'ENOENT') throw error;
    });
    return;
  }

  // Propagate filesystem errors: swallowing rename/unlink failures could mislead
  // callers into assuming rotation succeeded while leaving ledger generations in an
  // inconsistent state.
  await fsUnlink(`${ledgerPath}.${retentionFiles}`).catch((error: unknown) => {
    if ((error as {code?: string})?.code !== 'ENOENT') throw error;
  });
  for (let i = retentionFiles - 1; i >= 1; i--) {
    const src = `${ledgerPath}.${i}`;
    const dst = `${ledgerPath}.${i + 1}`;
    if (await portableFileExists(src)) {
      await fsRename(src, dst);
    }
  }
  await fsRename(ledgerPath, `${ledgerPath}.1`);
}

/**
 * Read all WAL entries from a single JSONL ledger file generation.
 */
async function readWalGeneration(
  ledgerPath: string,
): Promise<{entries: WalEntry[]; truncated: boolean}> {
  if (!(await safeFileExists(ledgerPath)))
    return {entries: [], truncated: false};
  let text: string;
  let truncated = false;
  try {
    // If the file exceeds the read ceiling, bounded reading returns the prefix and flags truncation.
    ({text, truncated} = await readBoundedText(ledgerPath));
  } catch {
    // Non-regular file (e.g. symlink) or unreadable — treat as no ledger.
    return {entries: [], truncated: false};
  }
  const entries: WalEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(parseWalEntry(JSON.parse(trimmed)));
    } catch {
      // Skip malformed entries to preserve readable records.
    }
  }
  return {entries, truncated};
}

/**
 * Read WAL entries across the active ledger and all configured rotated generations.
 * Returns entries sorted by sequence number and reports whether any generation was truncated.
 */
async function readWalWindow(
  ledgerPath: string,
  retentionFiles: number,
): Promise<{entries: WalEntry[]; truncated: boolean}> {
  const first = await readWalGeneration(ledgerPath);
  // Bound generations read to prevent unbounded disk lookups.
  const generations = Math.max(0, Math.min(Math.floor(retentionFiles), 100));
  const entries = first.entries;
  let truncated = first.truncated;
  for (let generation = 1; generation <= generations; generation++) {
    const rotated = await readWalGeneration(`${ledgerPath}.${generation}`);
    // Continue through missing generations to recover from interrupted rotations.
    entries.push(...rotated.entries);
    if (rotated.truncated) truncated = true;
  }
  return {entries: entries.sort((a, b) => a.seq - b.seq), truncated};
}

export async function readWalEntries(
  ledgerPath: string,
  retentionFiles = 3,
): Promise<WalEntry[]> {
  return (await readWalWindow(ledgerPath, retentionFiles)).entries;
}

/**
 * Recovered session state yielded from snapshot and WAL replay.
 */
export interface RecoveredState {
  goals: GoalState[];
  results: GoalResult[];
  sessionOrdered: string[];
  invalidatedGoalIds: string[];
  pendingIntents: SerializedPendingIntent[];
  settlementReceipts: SettlementReceipt[];
  focusedGoalIds: Array<{sessionID: string; goalId: string}>;
  /**
   * Set when a ledger generation in the retention window was truncated by the read ceiling.
   * Callers must not persist state derived from a partial ledger, as trailing entries
   * (e.g. removal tombstones) may be missing and could resurrect cleared goals.
   */
  ledgerOverCeiling: boolean;
  /**
   * Set when the state snapshot file exists but was truncated by the read ceiling.
   * Callers must not overwrite the snapshot file with a partial recovery, which would
   * erase snapshot-only records (results, focus pointers, settlement receipts).
   */
  snapshotOverCeiling: boolean;
}

/**
 * Recover goal state from the state file snapshot and WAL ledger replay.
 *
 * Strategy:
 * 1. Read the snapshot file for base state and snapshot-only metadata.
 * 2. Read WAL entries across retained generations.
 * 3. Invalidate proposed creations that were never committed to prevent resurrection.
 * 4. Apply committed WAL entries in sequence order against snapshot high-water marks.
 * 5. Purge terminal goals, tombstones, and orphaned pending intents from active state.
 */
export async function recoverState(
  statePath: string,
  ledgerPath: string,
  retentionFiles = 3,
): Promise<RecoveredState> {
  const exists = await safeFileExists(statePath);
  let snapshot: PersistedState = {
    version: STATE_VERSION,
    goals: [],
    results: [],
    sessionOrdered: [],
    invalidatedGoalIds: [],
    pendingIntents: [],
    settlementReceipts: [],
    focusedGoalIds: [],
  };
  let snapshotOverCeiling = false;
  if (exists) {
    try {
      const {text, truncated} = await readBoundedText(statePath);
      if (truncated) {
        snapshotOverCeiling = true;
        throw new Error(
          `state file is past the ${MAX_STATE_FILE_BYTES}-byte read ceiling; refusing to treat a prefix of it as the whole snapshot`,
        );
      }
      const raw = JSON.parse(text);
      const version = Number(raw.version ?? STATE_VERSION);
      if (version !== STATE_VERSION) {
        throw new Error(`unsupported state version: ${version}`);
      }
      snapshot = {
        version,
        goals: Array.isArray(raw.goals)
          ? raw.goals.slice(0, MAX_PERSISTED_ENTRIES)
          : [],
        results: Array.isArray(raw.results)
          ? raw.results.slice(0, MAX_PERSISTED_ENTRIES)
          : [],
        sessionOrdered: Array.isArray(raw.sessionOrdered)
          ? raw.sessionOrdered.slice(0, MAX_PERSISTED_ENTRIES)
          : [],
        invalidatedGoalIds: Array.isArray(raw.invalidatedGoalIds)
          ? raw.invalidatedGoalIds
              .filter((id: unknown): id is string => typeof id === 'string')
              .slice(0, MAX_PERSISTED_ENTRIES)
          : [],
        pendingIntents: Array.isArray(
          (raw as Record<string, unknown>).pendingIntents,
        )
          ? ((raw as Record<string, unknown>).pendingIntents as unknown[])
              .slice(0, MAX_PERSISTED_ENTRIES)
              .map(normalizePendingIntent)
              .filter((p): p is SerializedPendingIntent => p !== null)
          : [],
        settlementReceipts: Array.isArray(
          (raw as Record<string, unknown>).settlementReceipts,
        )
          ? ((raw as Record<string, unknown>).settlementReceipts as unknown[])
              .slice(0, 256)
              .filter(
                (r): r is Record<string, unknown> =>
                  typeof r === 'object' && r !== null,
              )
              .map(r => ({
                goalId: capString(r.goalId, MAX_GOAL_META_LENGTH),
                sessionID: capString(r.sessionID, MAX_GOAL_META_LENGTH),
                targetStatus: capString(r.targetStatus, MAX_GOAL_META_LENGTH),
                kind: capString(r.kind, MAX_GOAL_META_LENGTH),
                revision: toNonNegativeInteger(r.revision),
                startedAt: toNonNegativeInteger(r.startedAt),
                ...(typeof r.completedAt === 'number'
                  ? {completedAt: r.completedAt}
                  : {}),
              }))
          : [],
        focusedGoalIds: Array.isArray(
          (raw as Record<string, unknown>).focusedGoalIds,
        )
          ? ((raw as Record<string, unknown>).focusedGoalIds as unknown[])
              .slice(0, MAX_PERSISTED_ENTRIES)
              .filter(
                (r): r is Record<string, unknown> =>
                  typeof r === 'object' && r !== null,
              )
              .map(r => ({
                sessionID: capString(r.sessionID, MAX_GOAL_META_LENGTH),
                goalId: capString(r.goalId, MAX_GOAL_META_LENGTH),
              }))
              .filter(r => r.sessionID !== '' && r.goalId !== '')
          : [],
      };
    } catch {
      // Corrupted state file — fall back to WAL only.
    }
  }

  const wal = await readWalWindow(ledgerPath, retentionFiles);
  const walEntries = wal.entries;

  // Keep snapshot high-water marks separate from the live map. Terminal goals
  // are omitted from the active set, but their revisions must still fence off
  // older retained WAL entries during replay.
  const goalsById = new Map<string, GoalState>();
  const snapshotHighWater = new Map<
    string,
    {revision: number; terminal: boolean}
  >();
  const invalidatedGoalIds = new Set(snapshot.invalidatedGoalIds ?? []);

  for (const serialized of snapshot.goals) {
    const goal = deserializeGoal(serialized);
    const terminal = TERMINAL_STATUSES.has(goal.status);
    snapshotHighWater.set(goal.goalId, {revision: goal.revision, terminal});
    if (terminal || invalidatedGoalIds.has(goal.goalId)) continue;
    goalsById.set(goal.goalId, goal);
  }

  const committedGoalIds = new Set<string>();
  const proposedCreateGoalIds = new Set<string>();
  for (const entry of walEntries) {
    const goalId = entry.transition.goalId;
    if (entry.phase === 'committed') committedGoalIds.add(goalId);
    else if (
      entry.phase === 'proposed' &&
      entry.transition.source === 'create_goal'
    ) {
      proposedCreateGoalIds.add(goalId);
    }
  }
  // Only uncommitted creations invalidate a snapshot goal. Proposed updates may
  // legitimately follow an older committed create that has rotated out of retention.
  for (const id of proposedCreateGoalIds) {
    if (!committedGoalIds.has(id)) goalsById.delete(id);
  }

  const terminalGoalIds = new Set<string>();
  const removedGoalIds = new Set<string>();
  for (const entry of walEntries) {
    if (entry.phase === 'committed') {
      if (entry.removed) {
        removedGoalIds.add(entry.transition.goalId);
        invalidatedGoalIds.add(entry.transition.goalId);
        continue;
      }
      // Removal tombstones override late commits from in-flight continuations.
      if (removedGoalIds.has(entry.transition.goalId)) continue;
      const goal = deserializeGoal(entry.snapshot);
      if (invalidatedGoalIds.has(goal.goalId)) continue;
      const current = goalsById.get(goal.goalId);
      const highWater = snapshotHighWater.get(goal.goalId);
      if (highWater && goal.revision < highWater.revision) continue;
      if (current && goal.revision < current.revision) continue;

      // For entries at equal revisions (e.g. skipRevision transitions), chronological
      // sequence order determines the winning state.
      if (highWater?.terminal) continue;
      goalsById.set(goal.goalId, goal);
      snapshotHighWater.set(goal.goalId, {
        revision: goal.revision,
        terminal: TERMINAL_STATUSES.has(goal.status),
      });
      if (TERMINAL_STATUSES.has(entry.snapshot.status)) {
        terminalGoalIds.add(goal.goalId);
      }
    }
    // Discard uncommitted 'proposed' and 'aborted' entries.
  }

  for (const id of terminalGoalIds) {
    goalsById.delete(id);
  }
  for (const id of removedGoalIds) {
    goalsById.delete(id);
  }

  const results = snapshot.results.map(deserializeResult);

  // Pending intents are stored only in the snapshot. Filter to active goals and bounds,
  // dropping terminal or invalidated references so archived goals never resurrect intents.
  const rawPending = (snapshot.pendingIntents ?? []).slice(
    0,
    MAX_PERSISTED_ENTRIES,
  );
  const pendingIntents: SerializedPendingIntent[] = [];
  for (const raw of rawPending) {
    const p = normalizePendingIntent(raw);
    if (!p) continue;
    if (invalidatedGoalIds.has(p.goalId)) continue;
    const liveGoal = goalsById.get(p.goalId);
    const highWater = snapshotHighWater.get(p.goalId);
    if (highWater?.terminal) continue;
    if (liveGoal && TERMINAL_STATUSES.has(liveGoal.status)) continue;
    pendingIntents.push(p);
  }

  return {
    goals: [...goalsById.values()],
    results,
    sessionOrdered: snapshot.sessionOrdered,
    invalidatedGoalIds: [...invalidatedGoalIds],
    pendingIntents,
    settlementReceipts: snapshot.settlementReceipts ?? [],
    focusedGoalIds: snapshot.focusedGoalIds ?? [],
    snapshotOverCeiling,
    ledgerOverCeiling: wal.truncated,
  };
}

/**
 * Write the full state snapshot checkpoint to disk.
 * Permissions are pinned to 0o600 on creation.
 */
export async function writeStateFile(
  statePath: string,
  goals: GoalState[],
  results: GoalResult[],
  sessionOrdered: string[],
  invalidatedGoalIds: string[] = [],
  pendingIntents: SerializedPendingIntent[] = [],
  settlementReceipts: SettlementReceipt[] = [],
  focusedGoalIds: Array<{sessionID: string; goalId: string}> = [],
): Promise<boolean> {
  const cappedIntents = pendingIntents
    .slice(0, MAX_PERSISTED_ENTRIES)
    .map(p => normalizePendingIntent(p))
    .filter((p): p is SerializedPendingIntent => p !== null);
  const state: PersistedState = {
    version: STATE_VERSION,
    goals: goals.map(serializeGoal),
    results,
    sessionOrdered,
    invalidatedGoalIds,
    pendingIntents: cappedIntents,
    settlementReceipts: settlementReceipts.slice(-256),
    focusedGoalIds: focusedGoalIds.slice(0, MAX_PERSISTED_ENTRIES),
  };
  try {
    // portableWriteFile applies permissions through the open descriptor to avoid symlink replacement races.
    await portableWriteFile(statePath, JSON.stringify(state, null, 2), 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sequence counters tracked per ledger file path.
 *
 * Keying by absolute ledger path rather than session ID ensures independent
 * sequence counters when different plugin instances or state roots operate concurrently.
 */
const walSeqByLedger = new Map<string, number>();

export function nextWalSeq(ledgerPath: string): number {
  const next = (walSeqByLedger.get(ledgerPath) ?? 0) + 1;
  walSeqByLedger.set(ledgerPath, next);
  return next;
}

/**
 * Initialize a ledger's sequence counter from its existing history on disk
 * to guarantee sequence numbers remain strictly monotonic across process restarts.
 *
 * Returns `true` if the ledger read was truncated (in which case seeding is refused).
 */
export async function initWalSeqFromLedger(
  ledgerPath: string,
  retentionFiles = 3,
): Promise<boolean> {
  const {entries, truncated} = await readWalWindow(ledgerPath, retentionFiles);
  if (truncated) return true;
  if (entries.length === 0) return false;

  const fromLedger = entries.reduce((max, e) => Math.max(max, e.seq), 0);
  const current = walSeqByLedger.get(ledgerPath) ?? 0;
  if (fromLedger > current) walSeqByLedger.set(ledgerPath, fromLedger);
  return false;
}

/**
 * Retrieve the current sequence counter for a ledger without incrementing.
 * Used primarily by tests verifying cross-ledger counter isolation.
 */
export function peekWalSeq(ledgerPath: string): number {
  return walSeqByLedger.get(ledgerPath) ?? 0;
}

/**
 * Create a proposed WAL entry before applying an in-memory transition.
 */
export function createProposedEntry(
  goal: GoalState,
  transition: WalTransition,
  ledgerPath: string,
): WalEntry {
  return {
    seq: nextWalSeq(ledgerPath),
    revision: goal.revision,
    phase: 'proposed',
    transition,
    timestamp: Date.now(),
    snapshot: serializeGoal(goal),
  };
}

/**
 * Create a committed WAL entry after persistence succeeds.
 */
export function createCommittedEntry(
  goal: GoalState,
  transition: WalTransition,
  ledgerPath: string,
  removed?: boolean,
): WalEntry {
  return {
    seq: nextWalSeq(ledgerPath),
    revision: goal.revision,
    phase: 'committed',
    transition,
    timestamp: Date.now(),
    snapshot: serializeGoal(goal),
    ...(removed ? {removed: true} : {}),
  };
}

/**
 * Create an aborted WAL entry when a transition fails to persist.
 */
export function createAbortedEntry(
  goal: GoalState,
  transition: WalTransition,
  ledgerPath: string,
): WalEntry {
  return {
    seq: nextWalSeq(ledgerPath),
    revision: goal.revision,
    phase: 'aborted',
    transition,
    timestamp: Date.now(),
    snapshot: serializeGoal(goal),
  };
}
