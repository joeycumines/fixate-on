/**
 * Reads persisted goal state from disk for companion processes.
 */

import {resolve} from 'node:path';
import {portableReadBounded} from './fs-portable.ts';
import {
  DEFAULT_STATE_ROOT,
  SESSION_ID_PATTERN,
  SESSIONS_DIRNAME,
  STATE_FILENAME,
} from './session-paths.ts';
import type {GoalTuiSnapshot, TuiStateStore} from './tui-state.ts';
import {VALID_GOAL_STATUSES} from './tui-state.ts';
import type {ClaimRecord, GoalStatus} from './state-machine.ts';

/**
 * Resolves the state root directory according to precedence:
 * 1. Explicit companion stateRoot option
 * 2. FIXATE_ON_STATE_ROOT environment variable
 * 3. Default state root relative to workspace directory
 */
export function resolveStateRoot(
  directory: string | undefined,
  stateRoot?: string,
): string {
  const configured = stateRoot ?? process.env.FIXATE_ON_STATE_ROOT;
  return resolve(
    directory ? resolve(directory) : process.cwd(),
    configured ?? DEFAULT_STATE_ROOT,
  );
}

/**
 * Derives the session ID from a state file path.
 * In the standard layout, the session ID is always the immediate parent directory.
 */
function sessionIDFromStatePath(path: string): string | undefined {
  const parts = path.split(/[\\/]/);
  const idx = parts.lastIndexOf(SESSIONS_DIRNAME);
  if (idx < 0 || idx + 1 >= parts.length - 1) return undefined;
  return parts[idx + 1];
}

/**
 * Discovers state files to read for a workspace.
 *
 * Honours `explicitPath` when provided; otherwise enumerates `<root>/sessions/<sessionID>/state.json`.
 * Legacy non-session layouts are deliberately excluded to avoid reading stale files.
 */
export async function discoverStateFiles(
  directory?: string,
  explicitPath?: string,
  stateRoot?: string,
): Promise<string[]> {
  const {readdir, stat} = await import('node:fs/promises');
  const {join} = await import('node:path');

  if (explicitPath) {
    const direct = resolve(explicitPath);
    try {
      return (await stat(direct)).isFile() ? [direct] : [];
    } catch {
      return [];
    }
  }

  const sessionsRoot = join(
    resolveStateRoot(directory, stateRoot),
    SESSIONS_DIRNAME,
  );
  try {
    const entries = await readdir(sessionsRoot, {withFileTypes: true});
    return entries
      .filter(
        entry => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name),
      )
      .map(entry => join(sessionsRoot, entry.name, STATE_FILENAME))
      .sort();
  } catch {
    // Missing sessions directory indicates a workspace that has never run a goal.
    return [];
  }
}

/**
 * Hydrates a TuiStateStore directly from every session's persisted state.
 */
export async function hydrateStoreFromDisk(
  store: TuiStateStore,
  directory?: string,
  explicitPath?: string,
  stateRoot?: string,
): Promise<{hydratedCount: number; error?: string}> {
  const foundPaths = await discoverStateFiles(
    directory,
    explicitPath,
    stateRoot,
  );
  let hydratedCount = 0;
  for (const foundPath of foundPaths) {
    const count = await hydrateFromStateFile(store, foundPath);
    hydratedCount += count;
  }
  return {hydratedCount};
}

async function hydrateFromStateFile(
  store: TuiStateStore,
  filePath: string,
): Promise<number> {
  try {
    const {text, truncated} = await portableReadBounded(filePath);
    // Files exceeding the read ceiling must not be parsed partially, as a truncated
    // snapshot would falsely present goals as absent.
    if (truncated) return 0;
    if (!text.trim()) return 0;
    const parsed = parseStateJson(text);
    if (!parsed) return 0;
    const snapshots = snapshotsFromParsed(
      parsed,
      sessionIDFromStatePath(filePath),
    );
    for (const snapshot of snapshots) {
      store.applyEvent({
        kind: 'create',
        sessionID: snapshot.sessionID,
        goalId: snapshot.goalId,
        snapshot: {...snapshot, origin: 'disk'},
        timestamp: Date.now(),
      });
    }
    return snapshots.length;
  } catch {
    return 0;
  }
}

/**
 * Parses JSON safely without throwing, returning `null` on failure.
 * Ensures state files are parsed only once per read cycle.
 */
function parseStateJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Parses persisted state file JSON text into TUI snapshots.
 * Skipped entries or malformed JSON yield an empty array without throwing.
 */
export function parseStateFileGoals(
  content: string,
  originSessionID?: string,
): GoalTuiSnapshot[] {
  const parsed = parseStateJson(content);
  return parsed ? snapshotsFromParsed(parsed, originSessionID) : [];
}

/**
 * Projects pre-parsed JSON into TUI goal snapshots, skipping re-parsing.
 */
function snapshotsFromParsed(
  parsed: unknown,
  originSessionID?: string,
): GoalTuiSnapshot[] {
  const rawGoals = Array.isArray((parsed as {goals?: unknown[]})?.goals)
    ? (parsed as {goals: unknown[]}).goals
    : [];
  const out: GoalTuiSnapshot[] = [];
  for (const g of rawGoals) {
    if (
      !g ||
      typeof g !== 'object' ||
      !(g as Record<string, unknown>).goalId ||
      !(g as Record<string, unknown>).sessionID
    )
      continue;
    const r = g as Record<string, unknown>;
    // Reject goals whose internal sessionID does not match the enclosing directory,
    // protecting against corrupted or manually altered state files.
    if (
      originSessionID !== undefined &&
      String(r.sessionID) !== originSessionID
    )
      continue;
    out.push({
      goalId: String(r.goalId),
      sessionID: String(r.sessionID),
      condition: String(r.condition ?? ''),
      artifactPointers: Array.isArray(r.artifactPointers)
        ? [...(r.artifactPointers as string[])]
        : [],
      pendingProposal: r.pendingProposal
        ? ({
            ...(r.pendingProposal as object),
          } as GoalTuiSnapshot['pendingProposal'])
        : null,
      claims: Array.isArray(r.claims)
        ? (r.claims.map((c: unknown) => ({
            ...(c as Record<string, unknown>),
          })) as unknown as ReadonlyArray<Readonly<ClaimRecord>>)
        : [],
      lastClaim: r.lastClaim
        ? ({...r.lastClaim} as unknown as Readonly<ClaimRecord>)
        : null,
      status: VALID_GOAL_STATUSES.has(String(r.status))
        ? (r.status as GoalStatus)
        : 'active',
      revision: typeof r.revision === 'number' ? r.revision : 0,
      turnCount: typeof r.turnCount === 'number' ? r.turnCount : 0,
      totalTokens: typeof r.totalTokens === 'number' ? r.totalTokens : 0,
      maxTokens: typeof r.maxTokens === 'number' ? r.maxTokens : 1000000,
      maxTurns: typeof r.maxTurns === 'number' ? r.maxTurns : 0,
      tokenBudget: typeof r.tokenBudget === 'number' ? r.tokenBudget : null,
      usage: (r.usage ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        costKnown: false,
      }) as GoalTuiSnapshot['usage'],
      stopReason: String(r.stopReason ?? ''),
      blockedReason: String(r.blockedReason ?? ''),
      // Bound timestamps to valid finite positive numbers; coerce missing/invalid to 0.
      pausedAt:
        typeof r.pausedAt === 'number' &&
        Number.isFinite(r.pausedAt) &&
        r.pausedAt > 0
          ? r.pausedAt
          : 0,
      stoppedAt:
        typeof r.stoppedAt === 'number' &&
        Number.isFinite(r.stoppedAt) &&
        r.stoppedAt > 0
          ? r.stoppedAt
          : 0,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
      finishedAt: typeof r.finishedAt === 'number' ? r.finishedAt : null,
      lastCheckpoint: r.lastCheckpoint
        ? {
            summary: String(
              (r.lastCheckpoint as Record<string, unknown>).summary,
            ),
            timestamp: Number(
              (r.lastCheckpoint as Record<string, unknown>).timestamp,
            ),
          }
        : null,
      history: Array.isArray(r.history)
        ? r.history.map((h: unknown) => ({
            type: String((h as Record<string, unknown>).type ?? ''),
            detail: String((h as Record<string, unknown>).detail ?? ''),
            timestamp: Number((h as Record<string, unknown>).timestamp ?? 0),
          }))
        : [],
    });
  }
  return out;
}

export interface DiskGoalRead {
  snapshots: GoalTuiSnapshot[];
  filesRead: number;
  /**
   * True when no state directory exists at all (empty workspace), as opposed
   * to existing state files being temporarily unreadable or invalid.
   */
  stateDirMissing: boolean;
  /**
   * Set of session IDs successfully read and parsed during this pass.
   * Enables callers to track continuity and avoid treating transient read errors as deletions.
   */
  readableSessions: ReadonlySet<string>;
}

/**
 * Reads current on-disk goal snapshots across discovered sessions.
 * Snapshots are returned without the `origin: "disk"` marker.
 */
export async function readDiskGoalSnapshots(
  directory?: string,
  explicitPath?: string,
  stateRoot?: string,
): Promise<DiskGoalRead> {
  const {join} = await import('node:path');

  const foundPaths = await discoverStateFiles(
    directory,
    explicitPath,
    stateRoot,
  );

  const out: GoalTuiSnapshot[] = [];
  const readableSessions = new Set<string>();
  let filesRead = 0;
  for (const p of foundPaths) {
    try {
      // Enforce bounded reads and refuse symlinks to prevent excessive RSS and symlink attacks.
      const {text, truncated} = await portableReadBounded(p);
      if (truncated) continue;
      if (!text.trim()) continue;

      const parsed = parseStateJson(text);
      if (!parsed) continue;
      filesRead += 1;

      const pathSession = sessionIDFromStatePath(p);
      if (pathSession) readableSessions.add(pathSession);
      const snaps = snapshotsFromParsed(parsed, pathSession);
      for (const s of snaps) readableSessions.add(s.sessionID);
      out.push(...snaps);
    } catch {
      // Skip unreadable files (permissions, transient writes, or symlinks)
    }
  }

  // Stat the resolved root's sessions directory to distinguish an uninitialized workspace
  // from one with unreadable state files.
  let stateDirMissing = false;
  try {
    const {stat} = await import('node:fs/promises');
    if (explicitPath) {
      stateDirMissing = false;
    } else {
      await stat(
        join(resolveStateRoot(directory, stateRoot), SESSIONS_DIRNAME),
      );
    }
  } catch {
    stateDirMissing = true;
  }
  return {snapshots: out, filesRead, stateDirMissing, readableSessions};
}
