import type {UsageSnapshot} from './accounting.ts';
import {buildRetractionNotice} from './recovery-pressure.ts';
import {claimQualityLabel} from './claim-vocabulary.ts';
import {
  type ClaimRecord,
  type GoalMode,
  type GoalState,
  type GoalStatus,
  type MutationOptions,
  type NoticeKind,
  type StateMachineCallbacks,
  TERMINAL_STATUSES,
  TRANSITION_TABLE,
  type TransitionOptions,
  type TransitionResult,
  type TransitionSource,
} from './goal-types.ts';

// History and notice caps are machine-internal bounds enforced by the class.
const MAX_HISTORY_ENTRIES = 100;
const MAX_PENDING_NOTICES = 10;

export {
  TERMINAL_STATUSES,
  TRANSITION_TABLE,
  MAX_LIVE_GOALS,
} from './goal-types.ts';
export type {
  GoalStatus,
  GoalMode,
  GoalLifecycleEvent,
  GoalProgressNote,
  ContinuationClaim,
  NoticeKind,
  PendingNotice,
  GoalProposal,
  ClaimActor,
  ClaimCheckPath,
  ClaimCheckVerdict,
  ClaimOutcomeStatus,
  ClaimCheck,
  ClaimOutcome,
  ClaimRecord,
  TransitionSource,
  PendingIntent,
  ExecutionContext,
  RunBaseline,
  FocusResult,
  GoalState,
  TransitionOptions,
  TransitionResult,
  MutationOptions,
  CommitTransition,
  StateMachineCallbacks,
} from './goal-types.ts';

/**
 * An async mutex that serializes operations. Synchronous operations
 * complete immediately (no queuing); operations with awaits cause
 * subsequent operations to wait in sequence.
 *
 * This prevents race conditions between a transition's await window (e.g.
 * onCommit persisting to disk) and a usage update or another transition.
 */
class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    // Catch errors so a failed operation does not block subsequent ones.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * The authoritative goal state machine. All mutations go through this class.
 *
 * Terminal statuses (budgetLimited, complete) cannot transition out.
 * Every semantic mutation increments the revision. All mutations are
 * serialized by the mutex. Snapshots are deep copies.
 * Budget-limited goals cannot be resumed.
 */
export class GoalStateMachine {
  private goal: GoalState;
  private revision: number;
  private readonly mutex: AsyncMutex;
  private readonly callbacks: StateMachineCallbacks;

  constructor(goal: GoalState, callbacks: StateMachineCallbacks = {}) {
    this.goal = goal;
    this.revision = goal.revision;
    this.mutex = new AsyncMutex();
    this.callbacks = callbacks;
  }

  /** The current goal state. Read-only — do not mutate directly. */
  get state(): GoalState {
    return this.goal;
  }

  /** The current revision. Incremented on every semantic mutation. */
  get currentRevision(): number {
    return this.revision;
  }

  /**
   * Create an immutable snapshot for inspection or async operations.
   * Deep-copies mutable fields (history, messageIDs, pendingNotices).
   */
  snapshot(): Readonly<GoalState> {
    return {
      ...this.goal,
      usage: {...this.goal.usage},
      artifactPointers: [...this.goal.artifactPointers],
      pendingProposal: this.goal.pendingProposal
        ? {
            ...this.goal.pendingProposal,
            artifactPointers: this.goal.pendingProposal.artifactPointers
              ? [...this.goal.pendingProposal.artifactPointers]
              : undefined,
          }
        : null,
      history: this.goal.history.map(entry => ({...entry})),
      pendingNotices: this.goal.pendingNotices.map(notice => ({...notice})),
      checkpoints: this.goal.checkpoints.map(checkpoint => ({...checkpoint})),
      claims: this.goal.claims.map(c => ({
        ...c,
        check: {
          ...c.check,
          evidence: c.check.evidence ? [...c.check.evidence] : undefined,
        },
        outcome: {...c.outcome},
      })),
      lastClaim: this.goal.lastClaim
        ? {
            ...this.goal.lastClaim,
            check: {
              ...this.goal.lastClaim.check,
              evidence: this.goal.lastClaim.check.evidence
                ? [...this.goal.lastClaim.check.evidence]
                : undefined,
            },
            outcome: {...this.goal.lastClaim.outcome},
          }
        : null,
      messageIDs: new Set(this.goal.messageIDs),
      continuationClaim: this.goal.continuationClaim
        ? {...this.goal.continuationClaim}
        : null,
      executionContext: this.goal.executionContext
        ? {...this.goal.executionContext}
        : null,
    };
  }

  /**
   * Compare-and-swap (CAS) validation: verify whether the revision matches
   * an expected value to detect semantic mutations during async operations.
   *
   * @example
   * const rev = sm.currentRevision
   * await fetchLatestAssistantText(sessionID)
   * if (!sm.validateRevision(rev)) {
   *   // Stale — abort operation
   * }
   */
  validateRevision(expected: number): boolean {
    return this.revision === expected;
  }

  /**
   * Transition to a new status. Validates against the transition table,
   * increments the revision, applies the transition, and calls onCommit.
   */
  async transition(
    target: GoalStatus,
    opts: TransitionOptions,
  ): Promise<TransitionResult> {
    return this.mutex.run(async () => {
      const from = this.goal.status;

      if (TERMINAL_STATUSES.has(from)) {
        return {
          ok: false,
          error: `goal is ${from} (terminal); it cannot transition to ${target}. Budget-limited goals are frozen until replaced.`,
        };
      }

      const allowed = TRANSITION_TABLE.get(from);
      if (!allowed || !allowed.has(target)) {
        return {
          ok: false,
          error: `transition ${from}→${target} is not permitted`,
        };
      }

      this.revision++;
      this.goal.revision = this.revision;
      this.goal.status = target;
      this.goal.updatedAt = Date.now();

      // The finalizing flag is set when the budget wrapup prompt is sent and
      // cleared upon prompt completion. If the goal transitions while the
      // prompt is in-flight (terminal event, user message), clear it here to
      // prevent idle/chat handlers from treating a paused goal as finalizing.
      this.goal.finalizing = false;
      this.goal.continuationClaim = null;

      if (target === 'active') {
        this.goal.stopReason = '';
        this.goal.blockedReason = '';
        this.goal.noProgressTurns = 0;
        this.goal.noToolCallTurns = 0;
        // Clear per-turn tracking IDs with their counters. Retaining them would
        // make subsequent observations of the same message ID appear counted,
        // prematurely suppressing the brake until a new turn occurs.
        this.goal.lastCountedProgressMessageID = '';
        this.goal.lastNoToolCallMessageID = '';
        this.goal.promptFailures = 0;
        this.goal.budgetWrapupSent = false;
        // A fresh resume starts a fresh recovery budget and blocked streak.
        this.goal.blockedTurns = 0;
        this.goal.blockedAssertedThisTurn = false;
        this.goal.recoveryTurns = 0;
        this.goal.unchangedResults = 0;
        this.goal.lastCandidate = null;
        this.goal.lastFingerprint = null;
        // Reset the consecutive fault streak so resuming does not inherit
        // pre-pause faults and settle unattested on the first new fault.
        this.goal.attestationFaults = 0;
        this.goal.attestationRetryAt = 0;
        this.goal.lastBlockedAttemptText = '';
        this.resumeClock();
        this.goal.stoppedAt = 0;
      } else if (target === 'complete') {
        this.resumeClock();
        this.goal.stoppedAt = 0;
        this.goal.finishedAt = Date.now();
        this.goal.blockedReason = '';
      } else if (target === 'budgetLimited') {
        this.goal.budgetLimitReported = true;
        this.pauseClock();
        this.markStopped();
      } else if (target === 'finalizing') {
        this.pauseClock();
        this.markStopped();
      } else {
        this.pauseClock();
        this.markStopped();
      }

      if (opts.stopReason !== undefined) this.goal.stopReason = opts.stopReason;
      if (opts.blockedReason !== undefined)
        this.goal.blockedReason = opts.blockedReason;

      this.goal.history.push({
        type: opts.historyType ?? target,
        detail: opts.detail ?? '',
        timestamp: Date.now(),
      });
      if (this.goal.history.length > MAX_HISTORY_ENTRIES) {
        this.goal.history.splice(
          0,
          this.goal.history.length - MAX_HISTORY_ENTRIES,
        );
      }

      if (!opts.skipPersist && this.callbacks.onCommit) {
        await this.callbacks.onCommit(this.snapshot(), {
          source: opts.source,
          from,
          to: target,
          detail: opts.detail ?? '',
        });
      }

      return {ok: true, revision: this.revision};
    });
  }

  /**
   * Apply a field mutation without changing status. Increments the
   * revision and calls onCommit. Used for objective edits, budget resets,
   * focus changes, etc.
   *
   * The mutation function receives a mutable copy of the goal; callers
   * must not retain references after mutate returns.
   */
  async mutate(
    fn: (goal: GoalState) => void,
    opts: MutationOptions,
  ): Promise<TransitionResult> {
    return this.mutex.run(async () => {
      // Terminal statuses are frozen for field mutations (except 'complete',
      // which allows appending notices).
      if (
        TERMINAL_STATUSES.has(this.goal.status) &&
        this.goal.status !== 'complete'
      ) {
        return {
          ok: false,
          error: `goal is ${this.goal.status} (terminal); it cannot be mutated.`,
        };
      }

      const beforeSnapshot = this.snapshot();
      const beforeBrakes = {
        maxTurns: this.goal.maxTurns,
        maxTokens: this.goal.maxTokens,
        tokenBudget: this.goal.tokenBudget,
        maxDurationMs: this.goal.maxDurationMs,
        // maxBlockedTurns is a contract brake evaluated live by update_goal(blocked).
        maxBlockedTurns: this.goal.maxBlockedTurns,
      };

      try {
        fn(this.goal);
      } catch (error) {
        // Restore pre-callback snapshot on mutation failure to prevent
        // partially applied state changes from persisting across errors.
        this.goal = beforeSnapshot as GoalState;
        this.revision = beforeSnapshot.revision;
        throw error;
      }

      // Enforce mechanical brake contract: agent tools cannot modify safety ceilings mid-run.
      const agentSources: TransitionSource[] = [
        'update_goal',
        'propose_goal_change',
        'list_goals',
        'focus_goal',
      ];
      if (agentSources.includes(opts.source)) {
        if (
          this.goal.maxTurns !== beforeBrakes.maxTurns ||
          this.goal.maxTokens !== beforeBrakes.maxTokens ||
          this.goal.tokenBudget !== beforeBrakes.tokenBudget ||
          this.goal.maxDurationMs !== beforeBrakes.maxDurationMs ||
          this.goal.maxBlockedTurns !== beforeBrakes.maxBlockedTurns
        ) {
          this.goal.maxTurns = beforeBrakes.maxTurns;
          this.goal.maxTokens = beforeBrakes.maxTokens;
          this.goal.tokenBudget = beforeBrakes.tokenBudget;
          this.goal.maxDurationMs = beforeBrakes.maxDurationMs;
          this.goal.maxBlockedTurns = beforeBrakes.maxBlockedTurns;
          this.goal = beforeSnapshot as GoalState;
          this.revision = beforeSnapshot.revision;
          return {
            ok: false,
            error:
              'Brakes (turn/token/duration/blocked ceilings) are contract-tier and cannot be modified by agent mid-run.',
          };
        }
      }

      if (!opts.skipRevision) {
        this.revision++;
        this.goal.revision = this.revision;
      }
      this.goal.updatedAt = Date.now();

      // Non-semantic bookkeeping (skipRevision) is marked "tracking" so
      // user-facing views can filter it while keeping full ledger fidelity.
      this.goal.history.push({
        type: opts.historyType ?? (opts.skipRevision ? 'tracking' : 'mutation'),
        detail: opts.detail,
        timestamp: Date.now(),
      });
      if (this.goal.history.length > MAX_HISTORY_ENTRIES) {
        this.goal.history.splice(
          0,
          this.goal.history.length - MAX_HISTORY_ENTRIES,
        );
      }

      if (!opts.skipPersist && this.callbacks.onCommit) {
        await this.callbacks.onCommit(this.snapshot(), {
          source: opts.source,
          from: this.goal.status,
          to: this.goal.status,
          detail: opts.detail,
        });
      }

      return {ok: true, revision: this.revision};
    });
  }

  /**
   * Update goal token usage. Serialized via mutex to prevent interleaving
   * with transition await windows, but does not increment revision since
   * usage represents external tracking data rather than semantic state.
   */
  async updateUsage(delta: UsageSnapshot): Promise<void> {
    return this.mutex.run(async () => {
      this.goal.usage = delta;
      if (this.callbacks.onUsageUpdate) {
        try {
          await this.callbacks.onUsageUpdate(this.snapshot());
        } catch {
          // Usage broadcast failures are swallowed to maintain state machine resilience.
        }
      }
    });
  }

  /**
   * Add a pending notice to the goal. Notices are injected into the next
   * continuation prompt and cleared after delivery.
   */
  async addNotice(kind: NoticeKind, message: string): Promise<void> {
    await this.mutate(
      g => {
        g.pendingNotices.push({kind, message, timestamp: Date.now()});
        if (g.pendingNotices.length > MAX_PENDING_NOTICES) {
          g.pendingNotices.splice(
            0,
            g.pendingNotices.length - MAX_PENDING_NOTICES,
          );
        }
      },
      {
        source: 'idle-handler',
        detail: 'Added notice',
        skipRevision: true,
        skipPersist: true,
      },
    );
  }

  /**
   * Clear pending notices after delivery.
   */
  async clearNotices(): Promise<void> {
    await this.mutate(
      g => {
        g.pendingNotices = [];
      },
      {
        source: 'idle-handler',
        detail: 'Cleared notices',
        skipRevision: true,
        skipPersist: true,
      },
    );
  }

  /**
   * Record a claim/check/outcome triad in the claim ledger.
   */
  async recordClaim(
    claim: Omit<ClaimRecord, 'claimId' | 'timestamp'> & {
      claimId?: string;
      timestamp?: number;
    },
  ): Promise<ClaimRecord> {
    const record: ClaimRecord = {
      claimId: claim.claimId ?? crypto.randomUUID(),
      timestamp: claim.timestamp ?? Date.now(),
      actor: claim.actor,
      claimedStatus: claim.claimedStatus,
      claimText: claim.claimText,
      check: {
        ...claim.check,
        evidence: claim.check.evidence ? [...claim.check.evidence] : undefined,
      },
      outcome: {
        ...claim.outcome,
      },
    };
    await this.mutate(
      g => {
        g.claims.push(record);
        g.lastClaim = record;
      },
      // Prefix is load-bearing: isSignalHistoryEntry matches on it for UI rendering.
      {
        source: 'update_goal',
        detail: `Recorded claim ${record.claimId}: ${claimQualityLabel(record.outcome.status)}`,
      },
    );
    return record;
  }

  /**
   * Emit an evidence-cited retraction notice when prior pressure or verifier findings
   * are shown wrong or superseded.
   */
  async emitRetraction(notice: {
    originalEvidence: string[];
    retractionReason: string;
  }): Promise<void> {
    const formatted = buildRetractionNotice({
      goalId: this.goal.goalId,
      originalEvidence: notice.originalEvidence,
      retractionReason: notice.retractionReason,
      timestamp: Date.now(),
    });
    await this.mutate(
      g => {
        g.pendingNotices.push({
          kind: 'retraction',
          message: formatted,
          timestamp: Date.now(),
        });
        if (g.pendingNotices.length > MAX_PENDING_NOTICES) {
          g.pendingNotices.splice(
            0,
            g.pendingNotices.length - MAX_PENDING_NOTICES,
          );
        }
      },
      {
        source: 'retraction',
        detail: notice.retractionReason,
        historyType: 'retraction',
      },
    );
  }

  /**
   * Pause the elapsed-time clock. Sets pausedAt if not already set.
   * Does not increment the revision (bookkeeping only).
   */
  pauseClock(): void {
    if (!this.goal.pausedAt) this.goal.pausedAt = Date.now();
  }

  /**
   * Record the stop timestamp. Restamped on every stop to indicate when
   * the plugin last yielded or made a claim.
   */
  markStopped(): void {
    this.goal.stoppedAt = Date.now();
  }

  /**
   * Resume the elapsed-time clock. Shifts startedAt forward by the
   * paused duration so paused intervals are not counted against the goal.
   */
  resumeClock(): void {
    resumeClockInPlace(this.goal);
  }

  async rememberMessageID(messageID: string): Promise<void> {
    await this.mutex.run(async () => {
      this.goal.messageIDs.add(messageID);
      const MAX = 1000;
      while (this.goal.messageIDs.size > MAX) {
        const first = this.goal.messageIDs.values().next().value;
        if (first) this.goal.messageIDs.delete(first);
      }
    });
  }

  /**
   * Check if the goal is budget-limited (terminal). A "paused" wire status
   * with budgetLimitReported set remains terminal if user intervention occurred
   * during the finalizing window.
   */
  isBudgetLimited(): boolean {
    return (
      this.goal.status === 'budgetLimited' || this.goal.budgetLimitReported
    );
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.goal.status);
  }
}

/**
 * Resume the elapsed-time clock in place: folds the paused interval into
 * startedAt, clears pausedAt, and resets the stall window via lastProgressAt.
 */
export function resumeClockInPlace(goal: {
  startedAt: number;
  pausedAt: number;
  lastProgressAt?: number;
  stoppedAt?: number;
}): void {
  if (goal.pausedAt) {
    goal.startedAt += Math.max(0, Date.now() - goal.pausedAt);
    goal.pausedAt = 0;
  }
  if (goal.stoppedAt !== undefined) goal.stoppedAt = 0;
  goal.lastProgressAt = Date.now();
}

/**
 * Create a new goal state initialized with default thresholds and bookkeeping.
 */
export function createGoalState(
  sessionID: string,
  condition: string,
  options: {
    goalId?: string;
    runId?: string;
    maxTokens?: number;
    maxTurns?: number;
    maxDurationMs?: number;
    minDelayMs?: number;
    noProgressTokenThreshold?: number;
    noProgressTurnsBeforePause?: number;
    noToolCallTurnsBeforePause?: number;
    tokenBudget?: number | null;
    successCriteria?: string;
    constraints?: string;
    artifactPointers?: string[];
    mode?: GoalMode;
    maxRecoveryTurns?: number;
    maxUnchangedResults?: number;
    maxBlockedTurns?: number;
    languageTriage?: boolean;
  } = {},
): GoalState {
  const now = Date.now();
  return {
    goalId: options.goalId ?? crypto.randomUUID(),
    runId: options.runId ?? crypto.randomUUID(),
    revision: 0,
    condition,
    successCriteria: options.successCriteria ?? '',
    constraints: options.constraints ?? '',
    artifactPointers: options.artifactPointers
      ? [...options.artifactPointers]
      : [],
    pendingProposal: null,
    mode: options.mode ?? 'normal',
    sessionID,
    tokenBudget: options.tokenBudget ?? null,
    maxTokens: options.maxTokens ?? 1000000,
    maxTurns: options.maxTurns ?? 0,
    maxDurationMs: options.maxDurationMs ?? 1800000,
    minDelayMs: options.minDelayMs ?? 1500,
    noProgressTokenThreshold: options.noProgressTokenThreshold ?? 50,
    noProgressTurnsBeforePause: options.noProgressTurnsBeforePause ?? 3,
    noToolCallTurnsBeforePause: options.noToolCallTurnsBeforePause ?? 3,
    turnCount: 0,
    totalTokens: 0,
    compactionBaselineTokens: 0,
    usage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costKnown: false,
    },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    pausedAt: 0,
    stoppedAt: 0,
    finishedAt: null,
    status: 'active',
    stopReason: '',
    blockedReason: '',
    finalizing: false,
    budgetLimitReported: false,
    budgetWrapupSent: false,
    objectiveUpdatedPending: false,
    noProgressTurns: 0,
    noToolCallTurns: 0,
    promptFailures: 0,
    recoveryTurns: 0,
    maxRecoveryTurns: options.maxRecoveryTurns ?? 12,
    unchangedResults: 0,
    attestationFaults: 0,
    maxUnchangedResults: options.maxUnchangedResults ?? 3,
    lastCandidate: null,
    lastFingerprint: null,
    blockedTurns: 0,
    maxBlockedTurns: options.maxBlockedTurns ?? 3,
    blockedAssertedThisTurn: false,
    languageTriage: options.languageTriage ?? true,
    lastStatus: 'Goal set.',
    lastAssistantText: '',
    lastAssistantMessageID: '',
    lastCountedProgressMessageID: '',
    lastNoToolCallMessageID: '',
    lastContinueAt: 0,
    lastProgressAt: 0,
    continuationClaim: null,
    pendingNotices: [],
    history: [],
    lastCheckpoint: null,
    checkpoints: [],
    claims: [],
    lastClaim: null,
    messageIDs: new Set(),
    executionContext: null,
  };
}
