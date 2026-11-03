/**
 * Goal state shape and associated value types: statuses, transition table,
 * lifecycle events, claims, proposals, and pending intents.
 *
 * Extracted from state-machine.ts to keep the state machine module focused.
 * Depends only on accounting.ts (type-only). FocusResult references GoalState
 * structurally so this module remains at the base of the dependency graph without
 * circular dependencies.
 */

import type {UsageSnapshot} from './accounting.ts';

export type GoalStatus =
  'active' | 'paused' | 'blocked' | 'budgetLimited' | 'finalizing' | 'complete';

/** Terminal statuses — no transitions out. */
export const TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  'budgetLimited',
  'complete',
]);

/**
 * Maximum number of live (non-archived) goals a single session may hold.
 * Shared between tool and command entry points.
 * 200 balances multi-goal ordered sequences against bounded memory.
 */
export const MAX_LIVE_GOALS = 200;

/**
 * The transition table. Terminal statuses have empty sets (no exits).
 * Runtime conditions (blocked streak, budget-limited resume) are enforced
 * in the transition handler rather than in this static table.
 */
export const TRANSITION_TABLE: ReadonlyMap<
  GoalStatus,
  ReadonlySet<GoalStatus>
> = new Map([
  [
    'active',
    new Set(['paused', 'blocked', 'finalizing', 'complete', 'budgetLimited']),
  ],
  ['paused', new Set(['active', 'blocked', 'complete', 'finalizing'])],
  ['blocked', new Set(['active', 'complete'])],
  ['finalizing', new Set(['complete', 'paused', 'active'])],
  ['budgetLimited', new Set()],
  ['complete', new Set()],
]);
export type GoalMode = 'normal' | 'ordered';

export interface GoalLifecycleEvent {
  type: string;
  detail: string;
  timestamp: number;
}

export interface GoalProgressNote {
  summary: string;
  timestamp: number;
}

export interface ContinuationClaim {
  runId: string;
  sourceAssistantMessageID: string;
}

export type NoticeKind =
  | 'judge-approved'
  | 'judge-rejected'
  | 'judge-unavailable'
  | 'premature-exit'
  | 'blocked'
  | 'budget-limited'
  | 'no-progress'
  | 'no-tool-call'
  | 'hard-limit'
  | 'prompt-failure'
  | 'persistence-failure'
  | 'tool-surface-unavailable'
  | 'user-intervention'
  | 'retraction'
  | 'completion-gate'
  | 'sequence-replace'
  | 'create_goal-rollback'
  /**
   * The compaction-loop brake paused the goal: the session repeatedly settled
   * compactions inside the window without host progress, and further continuations
   * would consume tokens without advancing. Recorded so the reason is preserved
   * beyond the transition's detail text and remains queryable in the ledger.
   */
  | 'compaction-loop'
  /**
   * The host does not emit authentic session.idle events on stock v1, so the
   * poller synthesizes one from a quiet window. Distinguished from idle-handler
   * in the transition source to record which mechanism re-armed the goal.
   */
  | 'poll-idle';

export interface PendingNotice {
  kind: NoticeKind;
  message: string;
  timestamp: number;
}

export interface GoalProposal {
  proposalId: string;
  proposedAt: number;
  objective?: string;
  successCriteria?: string;
  constraints?: string;
  artifactPointers?: string[];
  reason: string;
}

export type ClaimActor = 'agent' | 'human' | 'slash-command';

/**
 * Claim verification path. Only `judge` is produced; any other persisted value
 * is normalized to `none` on read (persistence.ts).
 */
export type ClaimCheckPath = 'judge' | 'none';

export type ClaimCheckVerdict =
  | 'COMPLETE'
  | 'WORKING'
  | 'BLOCKED'
  | 'NEEDS_INPUT'
  | 'CANCELLED'
  | 'JUDGE_APPROVED'
  | 'JUDGE_REJECTED'
  | 'JUDGE_FAILURE'
  | 'VERIFIER_FAILURE'
  | 'NONE';

export type ClaimOutcomeStatus =
  | 'verified-complete'
  | 'claim-refuted'
  | 'unverifiable-claim'
  | 'blocked-acknowledged';

export interface ClaimCheck {
  path: ClaimCheckPath;
  target?: string;
  verdict: ClaimCheckVerdict;
  evidence?: string[];
  timestamp: number;
}

export interface ClaimOutcome {
  status: ClaimOutcomeStatus;
  detail: string;
  timestamp: number;
}

export interface ClaimRecord {
  claimId: string;
  timestamp: number;
  actor: ClaimActor;
  claimedStatus: 'complete' | 'blocked';
  claimText: string;
  check: ClaimCheck;
  outcome: ClaimOutcome;
}

export type TransitionSource =
  | 'create_goal'
  | 'update_goal'
  | 'propose_goal_change'
  | 'list_goals'
  | 'focus_goal'
  | 'slash-command'
  | 'idle-handler'
  | 'chat-message'
  | 'system-transform'
  | 'recovery'
  | 'retraction'
  | 'completion-gate'
  | 'sequence-replace'
  | 'create_goal-rollback'
  | 'poll-idle';

export interface PendingIntent {
  goalId: string;
  revision: number;
  runId: string;
  messageID: string;
  toolCallID: string;
  targetStatus: GoalStatus;
  evidence: string;
  createdAt: number;
}

export interface ExecutionContext {
  agent?: string;
  model?: string;
  provider?: string;
  /** Working directory for the goal (may differ from process.cwd). */
  cwd?: string;
}

/**
 * A run-scoped baseline for the handback diff (HANDBACK-SCOPE-1).
 *
 * `ref` is the commit returned by `git stash create` at capture time, or "" when
 * the worktree had nothing to stash (in which case HEAD is the base).
 * `untracked` lists pre-existing untracked files with their content hashes so
 * files already present before the goal began are excluded from handback.
 */
export interface RunBaseline {
  ref: string;
  untracked: Array<{path: string; hash: string}>;
  capturedAt: number;
}

/**
 * Discriminated result of a focus request. Distinguishes missing sessions,
 * non-existent goals, and completed goals so the caller can present precise feedback.
 *
 * Declared here to avoid circular dependencies between session-state-manager and tools.
 * `machine` is typed structurally to avoid importing state-machine.ts directly.
 */
export type FocusResult =
  | {
      ok: true;
      machine: {readonly state: GoalState; snapshot(): Readonly<GoalState>};
    }
  | {ok: false; reason: 'no-session' | 'not-found' | 'terminal'};

/**
 * The full goal state. All mutations must go through GoalStateMachine.
 * Direct field mutations outside the state machine are prohibited.
 */
export interface GoalState {
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
  /**
   * Timestamp when the current STOP was applied, or 0 when not stopped.
   * Distinct from `pausedAt` (the cumulative elapsed-time clock): `stoppedAt` is
   * re-stamped on every user message while running to track the 15-minute re-arm window.
   */
  stoppedAt: number;
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
  /** Number of forced continuation turns spent in completion-gate recovery. */
  recoveryTurns: number;
  /** Maximum forced continuation turns allowed before recovery aborts. */
  maxRecoveryTurns: number;
  /** Consecutive recovery iterations where the candidate+fingerprint tuple was unchanged. */
  unchangedResults: number;
  /** Maximum unchanged recovery results allowed before concluding progress has stalled. */
  maxUnchangedResults: number;
  lastCandidate: string | null;
  lastFingerprint: string | null;
  /**
   * Consecutive operational faults encountered while requesting an attestation
   * (e.g. verifier timeout, spawn error, or unparseable output). Retried with backoff;
   * resets to 0 upon any successful response. Optional for backwards compatibility.
   */
  attestationFaults?: number;
  /**
   * Earliest timestamp (ms) for the next attestation retry under exponential backoff.
   * 0 indicates no fault is pending.
   */
  attestationRetryAt?: number;
  /**
   * The blocker reason asserted in the most recent rejected `blocked` attempt.
   * Used to enforce that the same blocker recurs across consecutive attempts before pausing.
   */
  lastBlockedAttemptText?: string;
  /** Highest pressure-ladder rung reached for this goal ("r1".."r4" or ""). */
  pressureRung?: string;
  /** Consecutive turns where the goal asserted a blocked status below the threshold. */
  blockedTurns: number;
  /** Threshold of consecutive blocked turns required before transitioning to blocked. */
  maxBlockedTurns: number;
  /**
   * Set when update_goal(blocked) is invoked below threshold, consumed across the
   * idle boundary to maintain streak tracking.
   */
  blockedAssertedThisTurn: boolean;
  /**
   * Advisory phrase triage toggle. When false, scanPrematureExit is skipped entirely
   * and no phrase triage reason appears in recovery prompts.
   */
  languageTriage: boolean;
  lastStatus: string;
  lastAssistantText: string;
  lastAssistantMessageID: string;
  /**
   * Assistant message ID already counted toward `noProgressTurns`, preventing
   * multiple idle ticks on the same turn from advancing the streak counter.
   */
  lastCountedProgressMessageID?: string;
  /**
   * Assistant message ID already counted toward `noToolCallTurns`, ensuring turns
   * rather than idle ticks are counted.
   */
  lastNoToolCallMessageID?: string;
  /**
   * Baseline snapshot captured when the workspace cwd was first identified,
   * used to isolate file modifications made specifically by this goal.
   */
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
  messageIDs: Set<string>;
  executionContext: ExecutionContext | null;
}

export interface TransitionOptions {
  source: TransitionSource;
  stopReason?: string;
  blockedReason?: string;
  detail?: string;
  historyType?: string;
  /** If true, omit calling onCommit (the caller will handle persistence). */
  skipPersist?: boolean;
}

export interface TransitionResult {
  ok: boolean;
  error?: string;
  revision?: number;
}

export interface MutationOptions {
  source: TransitionSource;
  detail: string;
  /** If true, omit calling onCommit. */
  skipPersist?: boolean;
  /** If true, do not increment the revision (for non-semantic tracking updates). */
  skipRevision?: boolean;
  /** Optional custom history entry type (defaults to "mutation"). */
  historyType?: string;
}

/** Transition metadata passed to onCommit for WAL entries. */
export interface CommitTransition {
  source: TransitionSource;
  from: GoalStatus;
  to: GoalStatus;
  detail: string;
}

/**
 * Callbacks invoked by the state machine for WAL persistence, notifications,
 * and external synchronization.
 */
export interface StateMachineCallbacks {
  /** Invoked after a successful state transition or mutation before returning. */
  onCommit?: (
    snapshot: Readonly<GoalState>,
    transition: CommitTransition,
  ) => Promise<void>;
  /**
   * Invoked after usage updates (token and turn counts). Does not increment revision.
   * Broadcasts updates to companions; errors should be caught and handled gracefully.
   */
  onUsageUpdate?: (snapshot: Readonly<GoalState>) => Promise<void>;
}
