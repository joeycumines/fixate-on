/**
 * Persistence: write-ahead log plus snapshot. Each transition appends one
 * entry; recovery replays committed entries. Snapshots serve as checkpoints.
 */

import type {
  ClaimCheckPath,
  ClaimCheckVerdict,
  ClaimOutcomeStatus,
  ClaimRecord,
  ContinuationClaim,
  ExecutionContext,
  GoalLifecycleEvent,
  GoalMode,
  GoalProgressNote,
  GoalProposal,
  GoalState,
  GoalStatus,
  PendingNotice,
  RunBaseline,
  TransitionSource,
} from './state-machine.ts';
import type {UsageSnapshot} from './accounting.ts';
import {normalizeUsage, toNonNegativeInteger} from './accounting.ts';
import {MAX_STATE_FILE_BYTES, portableReadBounded} from './fs-portable.ts';

// Bounds: state files are untrusted input, so lengths are capped and
// symlinks/non-regular files are rejected.
export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
export const MAX_GOAL_META_LENGTH = 2000;
const MAX_GOAL_BLOCKER_LENGTH = 4000;
const MAX_LAST_ASSISTANT_TEXT_LENGTH = 16_000;
export const MAX_PERSISTED_ENTRIES = 2000;
const MAX_MESSAGE_IDS_PER_GOAL = 2000;

/** Cap a deserialized string field to a maximum length. */
export function capString(value: unknown, max: number): string {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Stat a path, rejecting symlinks and non-regular files. Returns null when
 * the file is missing or unsafe.
 */
async function safeLstat(
  path: string,
): Promise<{isFile: true; size: number} | null> {
  const {lstat} = await import('node:fs/promises');
  let info;
  try {
    info = await lstat(path);
  } catch {
    return null;
  }
  // Reject symlinks, directories, FIFOs, sockets, and devices.
  if (info.isSymbolicLink() || !info.isFile()) return null;
  return {isFile: true, size: info.size};
}

/** True only if the path exists and is a regular file (not a symlink). */
export async function safeFileExists(path: string): Promise<boolean> {
  return (await safeLstat(path)) !== null;
}

/**
 * Read up to MAX_STATE_FILE_BYTES from a regular file (symlinks rejected).
 *
 * Whether it truncated is returned: a partial read beats no read, and reading
 * one without knowing it is the defect. The ledger's prefix is its OLDEST
 * 16 MiB — the part replay needs least, since a removal tombstone lives at
 * the END — so a prefix read turns a cleared goal back into a live one and
 * re-issues numbers the ledger already holds. The snapshot must not have a
 * prefix at all: it is intact on disk, and treating a prefix as "no goals"
 * empties the workspace and lets the next write replace it.
 */
export async function readBoundedText(
  path: string,
): Promise<{text: string; truncated: boolean}> {
  return portableReadBounded(path, MAX_STATE_FILE_BYTES);
}

/**
 * A serialized goal for persistence. All fields are JSON-serializable
 * (no Sets — messageIDs is an array).
 */
export interface SerializedGoal {
  goalId: string;
  runId: string;
  revision: number;
  condition: string;
  successCriteria: string;
  constraints: string;
  artifactPointers: string[];
  pendingProposal: GoalProposal | null;
  mode: GoalMode;
  sessionID: string;
  tokenBudget: number | null;
  maxTokens: number;
  maxTurns: number;
  maxDurationMs: number;
  minDelayMs: number;
  noProgressTokenThreshold: number;
  noProgressTurnsBeforePause: number;
  noToolCallTurnsBeforePause: number;
  turnCount: number;
  totalTokens: number;
  compactionBaselineTokens: number;
  usage: UsageSnapshot;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  pausedAt: number;
  finishedAt: number | null;
  status: GoalStatus;
  stopReason: string;
  blockedReason: string;
  finalizing: boolean;
  budgetLimitReported: boolean;
  budgetWrapupSent: boolean;
  objectiveUpdatedPending: boolean;
  noProgressTurns: number;
  noToolCallTurns: number;
  promptFailures: number;
  recoveryTurns: number;
  attestationFaults?: number;
  attestationRetryAt?: number;
  lastBlockedAttemptText?: string;
  maxRecoveryTurns: number;
  unchangedResults: number;
  maxUnchangedResults: number;
  lastCandidate: string | null;
  lastFingerprint: string | null;
  blockedTurns: number;
  maxBlockedTurns: number;
  blockedAssertedThisTurn: boolean;
  languageTriage: boolean;
  lastStatus: string;
  lastAssistantText: string;
  lastAssistantMessageID: string;
  lastCountedProgressMessageID?: string;
  lastNoToolCallMessageID?: string;
  baseline?: RunBaseline | null;
  lastContinueAt: number;
  lastProgressAt: number;
  continuationClaim: ContinuationClaim | null;
  pendingNotices: PendingNotice[];
  history: GoalLifecycleEvent[];
  lastCheckpoint: GoalProgressNote | null;
  checkpoints: GoalProgressNote[];
  claims: ClaimRecord[];
  lastClaim: ClaimRecord | null;
  messageIDs: string[];
  executionContext: ExecutionContext | null;
}

/**
 * An archived goal result.
 */
export interface GoalResult {
  goalId: string;
  sessionID: string;
  condition: string;
  state: 'achieved' | 'blocked' | 'cleared';
  reason: string;
  evidence: string;
  blockedReason: string;
  turnCount: number;
  totalTokens: number;
  tokenBudget: number | null;
  createdAt: number;
  usage: UsageSnapshot;
  startedAt: number;
  finishedAt: number;
  lastStatus: string;
  lastCheckpoint: GoalProgressNote | null;
  checkpoints: GoalProgressNote[];
  history: GoalLifecycleEvent[];
  lastClaim?: ClaimRecord | null;
}

/**
 * A WAL entry in the JSONL ledger.
 */
export interface WalEntry {
  seq: number;
  revision: number;
  phase: 'proposed' | 'committed' | 'aborted';
  transition: WalTransition;
  timestamp: number;
  snapshot: SerializedGoal;
  removed?: boolean;
}

export interface WalTransition {
  source: TransitionSource;
  goalId: string;
  fromStatus: GoalStatus;
  toStatus: GoalStatus;
  stopReason: string;
  blockedReason: string;
  detail: string;
}

/**
 * A persisted pending intent — JSON-safe projection of PendingIntent plus
 * its owning session. Persisted intents survive restart so the step barrier
 * (update_goal complete/blocked → apply on authentic idle) converges after
 * a host restart. Bounds and validation mirror the goal caps.
 */
export interface SerializedPendingIntent {
  sessionID: string;
  goalId: string;
  revision: number;
  runId: string;
  messageID: string;
  toolCallID: string;
  targetStatus: GoalStatus;
  evidence: string;
  createdAt: number;
}

/**
 * The persisted state file. Contains live goals and archived results.
 */
export interface PersistedState {
  version: number;
  goals: SerializedGoal[];
  results: GoalResult[];
  sessionOrdered: string[];
  invalidatedGoalIds?: string[];
  pendingIntents?: SerializedPendingIntent[];
  /**
   * Durable settlement receipts.
   *
   * Terminal settlement happens in several stages (claim -> transition ->
   * archive -> remove -> persist). If the process dies between them, the goal
   * could be left live-but-complete, or archived without a claim. A receipt
   * written at the START of settlement records the intended transition so
   * recovery can detect incomplete settlements instead of silently accepting
   * an inconsistent state.
   */
  settlementReceipts?: SettlementReceipt[];
  /**
   * Persisted focus pointers per session, ensuring focus survives host restarts.
   */
  focusedGoalIds?: Array<{sessionID: string; goalId: string}>;
}

/** A terminal transition the plugin intended to perform, written before it begins. */
export interface SettlementReceipt {
  goalId: string;
  sessionID: string;
  targetStatus: string;
  /** The outcome classification that justified it (e.g. settle-complete). */
  kind: string;
  /** The goal revision the decision was made against. */
  revision: number;
  startedAt: number;
  /** Set once the goal is archived/removed and the settlement is fully converged. */
  completedAt?: number;
}

/**
 * Narrow a persisted baseline. Tolerates old state files (absent field) and
 * malformed input by returning null, so a corrupt baseline degrades to the
 * whole-worktree diff rather than throwing.
 */
function normalizeBaseline(raw: unknown): RunBaseline | null {
  if (!isPlainObject(raw)) return null;
  const untracked = Array.isArray(raw.untracked)
    ? raw.untracked
        .slice(0, 5000)
        .filter((u): u is Record<string, unknown> => isPlainObject(u))
        .map(u => ({
          path: capString(u.path, MAX_GOAL_META_LENGTH),
          hash: capString(u.hash, MAX_GOAL_META_LENGTH),
        }))
    : [];
  return {
    ref: capString(raw.ref, MAX_GOAL_META_LENGTH),
    untracked,
    capturedAt: toNonNegativeInteger(raw.capturedAt),
  };
}

export function serializeGoal(goal: GoalState): SerializedGoal {
  return {
    ...goal,
    artifactPointers: [...goal.artifactPointers],
    pendingProposal: goal.pendingProposal
      ? {
          ...goal.pendingProposal,
          artifactPointers: goal.pendingProposal.artifactPointers
            ? [...goal.pendingProposal.artifactPointers]
            : undefined,
        }
      : null,
    claims: goal.claims.map(c => ({
      ...c,
      check: {
        ...c.check,
        evidence: c.check.evidence ? [...c.check.evidence] : undefined,
      },
      outcome: {...c.outcome},
    })),
    lastClaim: goal.lastClaim
      ? {
          ...goal.lastClaim,
          check: {
            ...goal.lastClaim.check,
            evidence: goal.lastClaim.check.evidence
              ? [...goal.lastClaim.check.evidence]
              : undefined,
          },
          outcome: {...goal.lastClaim.outcome},
        }
      : null,
    messageIDs: [...goal.messageIDs],
  };
}

export function deserializeGoal(raw: unknown): GoalState {
  const source =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    goalId: capString(source.goalId, MAX_GOAL_META_LENGTH),
    runId: capString(source.runId, MAX_GOAL_META_LENGTH),
    revision: toNonNegativeInteger(source.revision),
    condition: capString(source.condition, MAX_GOAL_OBJECTIVE_LENGTH),
    successCriteria: capString(
      source.successCriteria,
      MAX_GOAL_OBJECTIVE_LENGTH,
    ),
    constraints: capString(source.constraints, MAX_GOAL_OBJECTIVE_LENGTH),
    artifactPointers: Array.isArray(source.artifactPointers)
      ? source.artifactPointers.map(p =>
          capString(p, MAX_GOAL_OBJECTIVE_LENGTH),
        )
      : Array.isArray((source as Record<string, unknown>).pointers)
        ? ((source as Record<string, unknown>).pointers as unknown[]).map(p =>
            capString(p, MAX_GOAL_OBJECTIVE_LENGTH),
          )
        : [],
    pendingProposal:
      isPlainObject(source.pendingProposal) &&
      typeof source.pendingProposal.reason === 'string'
        ? {
            proposalId:
              capString(
                source.pendingProposal.proposalId,
                MAX_GOAL_META_LENGTH,
              ) || 'prop-1',
            proposedAt: toNonNegativeInteger(source.pendingProposal.proposedAt),
            objective:
              typeof source.pendingProposal.objective === 'string'
                ? capString(
                    source.pendingProposal.objective,
                    MAX_GOAL_OBJECTIVE_LENGTH,
                  )
                : undefined,
            successCriteria:
              typeof source.pendingProposal.successCriteria === 'string'
                ? capString(
                    source.pendingProposal.successCriteria,
                    MAX_GOAL_OBJECTIVE_LENGTH,
                  )
                : undefined,
            constraints:
              typeof source.pendingProposal.constraints === 'string'
                ? capString(
                    source.pendingProposal.constraints,
                    MAX_GOAL_OBJECTIVE_LENGTH,
                  )
                : undefined,
            artifactPointers: Array.isArray(
              source.pendingProposal.artifactPointers,
            )
              ? (source.pendingProposal.artifactPointers as unknown[]).map(p =>
                  capString(p, MAX_GOAL_OBJECTIVE_LENGTH),
                )
              : undefined,
            reason: capString(
              source.pendingProposal.reason,
              MAX_GOAL_OBJECTIVE_LENGTH,
            ),
          }
        : null,
    mode: source.mode === 'ordered' ? 'ordered' : 'normal',
    sessionID: capString(source.sessionID, MAX_GOAL_META_LENGTH),
    // Token budget must be a positive safe integer.
    tokenBudget:
      Number.isSafeInteger(Number(source.tokenBudget)) &&
      Number(source.tokenBudget) > 0
        ? Number(source.tokenBudget)
        : null,
    maxTokens: toNonNegativeInteger(source.maxTokens, 1000000),
    maxTurns: toNonNegativeInteger(source.maxTurns, 0),
    maxDurationMs: toNonNegativeInteger(source.maxDurationMs, 1800000),
    minDelayMs: toNonNegativeInteger(source.minDelayMs, 1500),
    noProgressTokenThreshold: toNonNegativeInteger(
      source.noProgressTokenThreshold,
      50,
    ),
    noProgressTurnsBeforePause: toNonNegativeInteger(
      source.noProgressTurnsBeforePause,
      3,
    ),
    noToolCallTurnsBeforePause: toNonNegativeInteger(
      source.noToolCallTurnsBeforePause,
      3,
    ),
    turnCount: toNonNegativeInteger(source.turnCount),
    totalTokens: toNonNegativeInteger(source.totalTokens),
    compactionBaselineTokens: toNonNegativeInteger(
      source.compactionBaselineTokens,
    ),
    usage: normalizeUsage(source.usage),
    createdAt: toNonNegativeInteger(source.createdAt),
    updatedAt: toNonNegativeInteger(source.updatedAt),
    startedAt: toNonNegativeInteger(source.startedAt),
    pausedAt: toNonNegativeInteger(source.pausedAt),
    // Absent on records written before this field existed. 0 means "unknown stop
    // time", which is distinct from "not stopped" — the promise bound treats the
    // two differently, and collapsing them would cause stuck yields to hold promises indefinitely.
    stoppedAt: toNonNegativeInteger(source.stoppedAt),
    finishedAt:
      typeof source.finishedAt === 'number' ? source.finishedAt : null,
    status: validGoalStatus(source.status),
    stopReason: capString(source.stopReason, MAX_GOAL_META_LENGTH),
    blockedReason: capString(source.blockedReason, MAX_GOAL_BLOCKER_LENGTH),
    finalizing: source.finalizing === true,
    budgetLimitReported: source.budgetLimitReported === true,
    budgetWrapupSent: source.budgetWrapupSent === true,
    objectiveUpdatedPending: source.objectiveUpdatedPending === true,
    noProgressTurns: toNonNegativeInteger(source.noProgressTurns),
    noToolCallTurns: toNonNegativeInteger(source.noToolCallTurns),
    promptFailures: toNonNegativeInteger(source.promptFailures),
    // Completion-gate recovery state defaults for older state files.
    recoveryTurns: toNonNegativeInteger(source.recoveryTurns),
    attestationFaults: toNonNegativeInteger(source.attestationFaults),
    attestationRetryAt: toNonNegativeInteger(source.attestationRetryAt),
    lastBlockedAttemptText:
      typeof source.lastBlockedAttemptText === 'string'
        ? source.lastBlockedAttemptText
        : '',
    maxRecoveryTurns: toNonNegativeInteger(source.maxRecoveryTurns, 12),
    unchangedResults: toNonNegativeInteger(source.unchangedResults),
    maxUnchangedResults: toNonNegativeInteger(source.maxUnchangedResults, 3),
    lastCandidate:
      typeof source.lastCandidate === 'string' ? source.lastCandidate : null,
    lastFingerprint:
      typeof source.lastFingerprint === 'string'
        ? source.lastFingerprint
        : null,
    blockedTurns: toNonNegativeInteger(source.blockedTurns),
    maxBlockedTurns: toNonNegativeInteger(source.maxBlockedTurns, 3),
    blockedAssertedThisTurn: source.blockedAssertedThisTurn === true,
    // Backward compatibility: default language triage to true when absent.
    languageTriage: source.languageTriage !== false,
    lastStatus: capString(source.lastStatus, MAX_GOAL_META_LENGTH),
    lastAssistantText: capString(
      source.lastAssistantText,
      MAX_LAST_ASSISTANT_TEXT_LENGTH,
    ),
    lastAssistantMessageID: capString(
      source.lastAssistantMessageID,
      MAX_GOAL_META_LENGTH,
    ),
    lastCountedProgressMessageID: capString(
      source.lastCountedProgressMessageID,
      MAX_GOAL_META_LENGTH,
    ),
    lastNoToolCallMessageID: capString(
      source.lastNoToolCallMessageID,
      MAX_GOAL_META_LENGTH,
    ),
    baseline: normalizeBaseline(source.baseline),
    lastContinueAt: toNonNegativeInteger(source.lastContinueAt),
    lastProgressAt: toNonNegativeInteger(source.lastProgressAt),
    continuationClaim:
      isPlainObject(source.continuationClaim) &&
      typeof source.continuationClaim.runId === 'string'
        ? {
            runId: source.continuationClaim.runId,
            sourceAssistantMessageID: String(
              source.continuationClaim.sourceAssistantMessageID ?? '',
            ),
          }
        : null,
    pendingNotices: Array.isArray(source.pendingNotices)
      ? source.pendingNotices
          .slice(0, MAX_PERSISTED_ENTRIES)
          .map(normalizeNotice)
          .filter((n): n is PendingNotice => n !== null)
      : [],
    history: Array.isArray(source.history)
      ? source.history
          .slice(0, MAX_PERSISTED_ENTRIES)
          .map(normalizeHistoryEntry)
          .filter((n): n is GoalLifecycleEvent => n !== null)
      : [],
    lastCheckpoint: isPlainObject(source.lastCheckpoint)
      ? {
          summary: capString(
            source.lastCheckpoint.summary,
            MAX_GOAL_META_LENGTH,
          ),
          timestamp: toNonNegativeInteger(source.lastCheckpoint.timestamp),
        }
      : null,
    checkpoints: Array.isArray(source.checkpoints)
      ? source.checkpoints
          .slice(0, MAX_PERSISTED_ENTRIES)
          .map(normalizeCheckpoint)
          .filter((n): n is GoalProgressNote => n !== null)
      : [],
    claims: Array.isArray(source.claims)
      ? source.claims
          .slice(0, MAX_PERSISTED_ENTRIES)
          .map(normalizeClaimRecord)
          .filter((n): n is ClaimRecord => n !== null)
      : [],
    lastClaim: isPlainObject(source.lastClaim)
      ? normalizeClaimRecord(source.lastClaim)
      : null,
    messageIDs: new Set(
      Array.isArray(source.messageIDs)
        ? source.messageIDs
            .slice(-MAX_MESSAGE_IDS_PER_GOAL)
            .map(id => capString(id, MAX_GOAL_META_LENGTH))
        : [],
    ),
    executionContext: isPlainObject(source.executionContext)
      ? {
          agent: String(source.executionContext.agent ?? ''),
          model: String(source.executionContext.model ?? ''),
          provider: String(source.executionContext.provider ?? ''),
          ...(typeof source.executionContext.cwd === 'string'
            ? {cwd: source.executionContext.cwd}
            : {}),
        }
      : null,
  };
}

export function serializeResult(
  goal: GoalState,
  state: 'achieved' | 'blocked' | 'cleared',
  reason = '',
  evidence = '',
): GoalResult {
  return {
    goalId: goal.goalId,
    sessionID: goal.sessionID,
    condition: goal.condition,
    state,
    reason,
    evidence,
    blockedReason: goal.blockedReason,
    turnCount: goal.turnCount,
    totalTokens: goal.totalTokens,
    tokenBudget: goal.tokenBudget,
    createdAt: goal.createdAt,
    usage: normalizeUsage(goal.usage),
    startedAt: goal.startedAt,
    finishedAt: goal.finishedAt ?? (goal.pausedAt || Date.now()),
    lastStatus: goal.lastStatus,
    lastCheckpoint: goal.lastCheckpoint,
    checkpoints: [...goal.checkpoints],
    history: [...goal.history],
    lastClaim: goal.lastClaim ?? null,
  };
}

export function deserializeResult(raw: unknown): GoalResult {
  const source =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    goalId: String(source.goalId ?? ''),
    sessionID: String(source.sessionID ?? ''),
    condition: String(source.condition ?? ''),
    state:
      source.state === 'achieved' || source.state === 'blocked'
        ? source.state
        : 'cleared',
    reason: String(source.reason ?? ''),
    evidence: String(source.evidence ?? ''),
    blockedReason: String(source.blockedReason ?? ''),
    turnCount: toNonNegativeInteger(source.turnCount),
    totalTokens: toNonNegativeInteger(source.totalTokens),
    tokenBudget:
      Number.isSafeInteger(Number(source.tokenBudget)) &&
      Number(source.tokenBudget) > 0
        ? Number(source.tokenBudget)
        : null,
    createdAt: toNonNegativeInteger(source.createdAt),
    usage: normalizeUsage(source.usage),
    startedAt: toNonNegativeInteger(source.startedAt),
    finishedAt: toNonNegativeInteger(source.finishedAt),
    lastStatus: String(source.lastStatus ?? ''),
    lastCheckpoint: isPlainObject(source.lastCheckpoint)
      ? {
          summary: String(source.lastCheckpoint.summary ?? ''),
          timestamp: toNonNegativeInteger(source.lastCheckpoint.timestamp),
        }
      : null,
    checkpoints: Array.isArray(source.checkpoints)
      ? source.checkpoints
          .map(normalizeCheckpoint)
          .filter((n): n is GoalProgressNote => n !== null)
      : [],
    history: Array.isArray(source.history)
      ? source.history
          .map(normalizeHistoryEntry)
          .filter((n): n is GoalLifecycleEvent => n !== null)
      : [],
    lastClaim: isPlainObject(source.lastClaim)
      ? normalizeClaimRecord(source.lastClaim)
      : null,
  };
}

export function serializePendingIntent(
  sessionID: string,
  intent: import('./state-machine.ts').PendingIntent,
): SerializedPendingIntent {
  return {
    sessionID: capString(sessionID, MAX_GOAL_META_LENGTH),
    goalId: capString(intent.goalId, MAX_GOAL_META_LENGTH),
    revision: toNonNegativeInteger(intent.revision),
    runId: capString(intent.runId, MAX_GOAL_META_LENGTH),
    messageID: capString(intent.messageID, MAX_GOAL_META_LENGTH),
    toolCallID: capString(intent.toolCallID, MAX_GOAL_META_LENGTH),
    targetStatus: validGoalStatus(
      intent.targetStatus,
    ) as import('./state-machine.ts').PendingIntent['targetStatus'],
    evidence: capString(intent.evidence, MAX_GOAL_BLOCKER_LENGTH),
    createdAt: toNonNegativeInteger(intent.createdAt),
  };
}

export function normalizePendingIntent(
  raw: unknown,
): SerializedPendingIntent | null {
  if (!isPlainObject(raw)) return null;
  const r = raw as Record<string, unknown>;
  const sessionID = capString(r.sessionID, MAX_GOAL_META_LENGTH);
  const goalId = capString(r.goalId, MAX_GOAL_META_LENGTH);
  const runId = capString(r.runId, MAX_GOAL_META_LENGTH);
  const targetStatus = String(r.targetStatus ?? '');
  if (!sessionID || !goalId || !runId) return null;
  if (targetStatus !== 'complete' && targetStatus !== 'blocked') return null;

  return {
    sessionID,
    goalId,
    revision: toNonNegativeInteger(r.revision),
    runId,
    messageID: capString(r.messageID, MAX_GOAL_META_LENGTH),
    toolCallID: capString(r.toolCallID, MAX_GOAL_META_LENGTH),
    targetStatus:
      targetStatus as import('./state-machine.ts').PendingIntent['targetStatus'],
    evidence: capString(r.evidence, MAX_GOAL_BLOCKER_LENGTH),
    createdAt: toNonNegativeInteger(r.createdAt),
  };
}

export function parseWalEntry(raw: unknown): WalEntry {
  const source =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const rawTransition = isPlainObject(source.transition)
    ? source.transition
    : {};
  return {
    seq: toNonNegativeInteger(source.seq),
    revision: toNonNegativeInteger(source.revision),
    phase:
      source.phase === 'committed' || source.phase === 'aborted'
        ? source.phase
        : 'proposed',
    transition: {
      source: String(rawTransition.source ?? 'recovery') as TransitionSource,
      goalId: String(rawTransition.goalId ?? ''),
      fromStatus: validGoalStatus(rawTransition.fromStatus),
      toStatus: validGoalStatus(rawTransition.toStatus),
      stopReason: String(rawTransition.stopReason ?? ''),
      blockedReason: String(rawTransition.blockedReason ?? ''),
      detail: String(rawTransition.detail ?? ''),
    },
    timestamp: toNonNegativeInteger(source.timestamp),
    snapshot: (source.snapshot ?? {}) as SerializedGoal,
    ...(source.removed === true ? {removed: true} : {}),
  };
}

export function validGoalStatus(value: unknown): GoalStatus {
  const valid: GoalStatus[] = [
    'active',
    'paused',
    'blocked',
    'budgetLimited',
    'finalizing',
    'complete',
  ];
  // Unrecognized values intentionally map to "active" so a goal resumes instead
  // of being stuck in an unrecognized state.
  return valid.includes(value as GoalStatus) ? (value as GoalStatus) : 'active';
}

export function normalizeHistoryEntry(raw: unknown): GoalLifecycleEvent | null {
  if (!isPlainObject(raw)) return null;
  return {
    type: String((raw as Record<string, unknown>).type ?? ''),
    detail: String((raw as Record<string, unknown>).detail ?? ''),
    timestamp: toNonNegativeInteger((raw as Record<string, unknown>).timestamp),
  };
}

export function normalizeCheckpoint(raw: unknown): GoalProgressNote | null {
  if (!isPlainObject(raw)) return null;
  return {
    summary: String((raw as Record<string, unknown>).summary ?? ''),
    timestamp: toNonNegativeInteger((raw as Record<string, unknown>).timestamp),
  };
}

export function normalizeNotice(raw: unknown): PendingNotice | null {
  if (!isPlainObject(raw)) return null;
  return {
    kind: String(
      (raw as Record<string, unknown>).kind ?? 'user-intervention',
    ) as PendingNotice['kind'],
    message: String((raw as Record<string, unknown>).message ?? ''),
    timestamp: toNonNegativeInteger((raw as Record<string, unknown>).timestamp),
  };
}

/**
 * Canonicalize a persisted check path. This plugin has never been published,
 * so no state file carrying another spelling exists to translate: `judge` is
 * kept, and any other value degrades honestly to "none".
 */
export function migrateCheckPath(raw: unknown): ClaimCheckPath {
  return raw === 'judge' ? 'judge' : 'none';
}

/** Canonicalize a persisted check verdict; any unrecognized value is NONE. */
export function migrateCheckVerdict(raw: unknown): ClaimCheckVerdict {
  switch (raw) {
    case 'COMPLETE':
    case 'WORKING':
    case 'BLOCKED':
    case 'NEEDS_INPUT':
    case 'CANCELLED':
    case 'JUDGE_APPROVED':
    case 'JUDGE_REJECTED':
    case 'JUDGE_FAILURE':
    case 'VERIFIER_FAILURE':
    case 'NONE':
      return raw;
    default:
      return 'NONE';
  }
}

export function normalizeClaimRecord(raw: unknown): ClaimRecord | null {
  if (!isPlainObject(raw)) return null;
  const r = raw as Record<string, unknown>;
  const check = isPlainObject(r.check)
    ? (r.check as Record<string, unknown>)
    : {};
  const outcome = isPlainObject(r.outcome)
    ? (r.outcome as Record<string, unknown>)
    : {};

  return {
    claimId: capString(r.claimId, MAX_GOAL_META_LENGTH) || 'claim-1',
    timestamp: toNonNegativeInteger(r.timestamp),
    actor:
      r.actor === 'human' || r.actor === 'slash-command' ? r.actor : 'agent',
    claimedStatus: r.claimedStatus === 'blocked' ? 'blocked' : 'complete',
    claimText: capString(r.claimText, MAX_GOAL_OBJECTIVE_LENGTH),
    check: {
      path: migrateCheckPath(check.path),
      target:
        typeof check.target === 'string'
          ? capString(check.target, MAX_GOAL_META_LENGTH)
          : undefined,
      verdict: migrateCheckVerdict(check.verdict),
      evidence: Array.isArray(check.evidence)
        ? check.evidence.map(e => capString(e, MAX_GOAL_OBJECTIVE_LENGTH))
        : undefined,
      timestamp: toNonNegativeInteger(check.timestamp),
    },
    outcome: {
      status:
        typeof outcome.status === 'string'
          ? (outcome.status as ClaimOutcomeStatus)
          : 'unverifiable-claim',
      detail: capString(outcome.detail, MAX_GOAL_OBJECTIVE_LENGTH),
      timestamp: toNonNegativeInteger(outcome.timestamp),
    },
  };
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Note: WAL management functions (append/rotate/read/recover/writeStateFile) live
// in persistence-wal.ts to avoid circular dependencies. Deserialization helpers
// and normalizers reside here.
