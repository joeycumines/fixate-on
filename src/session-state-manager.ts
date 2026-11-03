/**
 * Multi-goal session state and runtime isolation.
 *
 * Provides `SessionStateManager` to coordinate mutable runtime state across multiple
 * goals per session (focused and backgrounded), result archives, ordered sequences,
 * and WAL-write coordination. Operates on a `RuntimeState` snapshot plus persistence
 * callbacks provided by the composition root.
 */

import type {
  CommitTransition,
  FocusResult,
  GoalState,
  TransitionSource,
} from './state-machine.ts';
import {GoalStateMachine} from './state-machine.ts';
import {
  type GoalResult,
  type PersistedState,
  type SerializedPendingIntent,
  serializeGoal,
  serializePendingIntent,
  type SettlementReceipt,
  type WalTransition,
} from './persistence.ts';
import {
  appendWalEntry,
  createAbortedEntry,
  createCommittedEntry,
  rotateLedgerIfNeeded,
} from './persistence-wal.ts';
import type {GoalBroadcaster} from './tui-state.ts';
import {ensureSessionDir, sessionStatePaths} from './session-paths.ts';
import type {CreateGoalOptions} from './tools.ts';
import {
  autoPromoteOwned,
  clearSessionOwned,
  createGoalOwned,
  focusGoalOwned,
  removeGoalOwned,
  replaceGoalsOwned,
} from './session-lifecycle.ts';
import type {SessionLifecycleHost} from './session-lifecycle-types.ts';
import type {DefaultGoalOptions, RuntimeState} from './session-runtime.ts';

const MAX_ARCHIVED_PER_SESSION = 10;

/** Shared empty fence to avoid allocations on `??` fallback lookups. */
const EMPTY_FENCE: ReadonlySet<string> = new Set<string>();

// Re-exported so external callers can resolve runtime types and defaults from a single entry point.
export {
  createRuntimeState,
  runtimeStorage,
  DEFAULT_GOAL_OPTIONS,
} from './session-runtime.ts';
export type {RuntimeState, DefaultGoalOptions} from './session-runtime.ts';

export class SessionStateManager implements SessionLifecycleHost {
  runtime: RuntimeState;
  persistedState: PersistedState;
  persistFn: (sessionID: string) => Promise<boolean>;

  /**
   * Establishes write permissions for a session by seeding its sequence counter
   * from its ledger and acquiring its lease before any writes occur. A host skipping
   * this step risks reusing sequences already recorded in history.
   */
  prepareSession: (sessionID: string) => Promise<boolean>;

  /**
   * Root directory containing session goal state. Resolved per write from the root
   * and the goal's session ID to maintain isolated per-session ledgers.
   */
  stateRoot: string;

  /**
   * Indicates whether persistence is enabled. When false, prevents directory
   * creation side effects during path resolution.
   */
  persistEnabled: boolean;
  ledgerMaxBytes: number;
  ledgerRetentionFiles: number;
  maxArchived: number;
  resultRetentionMs: number;
  defaultOpts: Required<DefaultGoalOptions>;
  logError: (message: string, error?: unknown) => Promise<void>;
  pendingWalWrite: Promise<void> | null = null;
  pendingCreateIds = new Set<string>();

  /**
   * Invalidation fence per session. Goal IDs invalidated by clear or remove while
   * a serialized WAL operation is queued are tracked here so they do not commit
   * after leaving the runtime (which would risk resurrecting them during recovery).
   * Keyed by session because the goal is already removed from live machines by
   * the time the fence is consulted.
   */
  invalidatedBySession = new Map<string, Set<string>>();

  /** Invalidation tombstones that must survive WAL rotation until their snapshot fence is durable. */
  pendingInvalidationCheckpoints = new Set<string>();

  /** Tracks sessions currently being cleared to prevent new goals from being created concurrently. */
  clearingSessions = new Set<string>();

  /**
   * Serializes lifecycle operations (focus, remove, clear, promote) per session
   * to prevent concurrent index mutations across asynchronous boundaries.
   */
  sessionLifecycleLocks = new Map<string, Promise<void>>();

  /** Broadcaster for publishing goal lifecycle transitions to the TUI companion. Null in server-only mode. */
  broadcaster: GoalBroadcaster | null = null;

  /**
   * In-memory settlement receipts across all sessions.
   *
   * Maintained here rather than directly on `persistedState` because persisted
   * files store only their own session's projected receipts to prevent unbounded
   * cross-session data growth across restarts.
   */
  settlementReceipts: SettlementReceipt[] = [];

  constructor(
    runtime: RuntimeState,
    persistFn: (sessionID: string) => Promise<boolean>,
    stateRoot: string,
    initialState: PersistedState | undefined,
    initialInvalidatedBySession: ReadonlyMap<string, readonly string[]>,
    prepareSession: (sessionID: string) => Promise<boolean>,
    ledgerMaxBytes: number | undefined,
    ledgerRetentionFiles: number | undefined,
    maxStoredResults: number | undefined,
    resultRetentionMs: number | undefined,
    defaultOpts: Required<DefaultGoalOptions>,
    logError: (message: string, error?: unknown) => Promise<void>,
  ) {
    this.runtime = runtime;
    this.persistFn = persistFn;
    this.stateRoot = stateRoot;
    this.persistEnabled = stateRoot.length > 0;
    this.prepareSession = prepareSession;
    this.persistedState = initialState ?? {
      version: 1,
      goals: [],
      results: [],
      sessionOrdered: [],
      invalidatedGoalIds: [],
    };
    // Restore per-session invalidation fences from initial state.
    for (const [sessionID, ids] of initialInvalidatedBySession) {
      this.invalidatedBySession.set(sessionID, new Set(ids));
    }
    this.settlementReceipts = [...(initialState?.settlementReceipts ?? [])];
    // Seed live focus pointers from persisted state so focus survives restarts.
    for (const entry of this.persistedState.focusedGoalIds ?? []) {
      this.runtime.focusedGoalId.set(entry.sessionID, entry.goalId);
    }
    this.ledgerMaxBytes = ledgerMaxBytes ?? 2 * 1024 * 1024;
    this.ledgerRetentionFiles = ledgerRetentionFiles ?? 3;
    this.maxArchived = maxStoredResults ?? MAX_ARCHIVED_PER_SESSION;
    this.resultRetentionMs = resultRetentionMs ?? 604800000;
    this.defaultOpts = defaultOpts;
    this.logError = logError;
  }

  /**
   * Sets the TUI broadcaster for publishing goal lifecycle transitions.
   * Passing null disables broadcasting (server-only mode).
   */
  setBroadcaster(broadcaster: GoalBroadcaster | null): void {
    this.broadcaster = broadcaster;
  }

  /**
   * Composes WAL persistence with optional TUI broadcasting.
   * Broadcast events fire only after persistence succeeds to ensure TUI errors
   * or latency cannot interrupt the persistence chain.
   */
  createOnCommit(): (
    snapshot: Readonly<GoalState>,
    transition: CommitTransition,
  ) => Promise<void> {
    const baseCommit = async (
      snapshot: Readonly<GoalState>,
      transition: CommitTransition,
    ) => {
      await this.chainWalWrite(snapshot, transition);
      await this.persistFn(snapshot.sessionID);
    };
    if (!this.broadcaster) return baseCommit;
    const broadcaster = this.broadcaster;
    return async (snapshot, transition) => {
      await baseCommit(snapshot, transition);
      await broadcaster.onCommit(snapshot, transition);
    };
  }

  /**
   * Creates the state machine callback for streaming usage updates to the TUI.
   * Returns undefined when running without a broadcaster.
   */
  createOnUsageUpdate():
    ((snapshot: Readonly<GoalState>) => Promise<void>) | undefined {
    if (!this.broadcaster) return undefined;
    const broadcaster = this.broadcaster;
    return async snapshot => {
      await broadcaster.emitUsage(snapshot);
    };
  }

  async withSessionLifecycle<T>(
    sessionID: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.sessionLifecycleLocks.get(sessionID) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.sessionLifecycleLocks.set(sessionID, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionLifecycleLocks.get(sessionID) === current) {
        this.sessionLifecycleLocks.delete(sessionID);
      }
    }
  }

  getMachine(sessionID: string): GoalStateMachine | null {
    const goals = this.runtime.sessionGoals.get(sessionID);
    if (!goals || goals.length === 0) return null;
    const focusedId = this.runtime.focusedGoalId.get(sessionID);
    if (focusedId) {
      const focused = goals.find(m => m.state.goalId === focusedId);
      if (focused) return focused;
    }
    return goals[goals.length - 1];
  }

  /**
   * Records an invalidation fence for a removed goal within its owning session.
   * Fences outlive the goal in memory to guard against stale snapshot rehydration.
   */
  addInvalidation(sessionID: string, goalId: string): void {
    let fence = this.invalidatedBySession.get(sessionID);
    if (!fence) {
      fence = new Set<string>();
      this.invalidatedBySession.set(sessionID, fence);
    }
    fence.add(goalId);
  }

  /**
   * Returns all active state machines for a session, ordered from oldest to newest.
   * Multi-goal workflows execute across all live machines; focus is a UX/dashboard
   * emphasis rather than an execution gate.
   */
  listMachines(sessionID: string): GoalStateMachine[] {
    return [...(this.runtime.sessionGoals.get(sessionID) ?? [])];
  }

  getFocusedGoalId(sessionID: string): string | null {
    return this.runtime.focusedGoalId.get(sessionID) ?? null;
  }

  listActiveGoals(sessionID: string): GoalState[] {
    const goals = this.runtime.sessionGoals.get(sessionID);
    if (!goals) return [];
    return goals.map(m => m.snapshot());
  }

  listArchivedResults(sessionID: string): GoalResult[] {
    const archive = this.runtime.sessionArchive.get(sessionID);
    if (!archive) return [];
    const now = Date.now();
    return archive.filter(r => now - r.finishedAt < this.resultRetentionMs);
  }

  createGoal(
    sessionID: string,
    objective: string,
    options: CreateGoalOptions,
  ): GoalStateMachine {
    if (this.clearingSessions.has(sessionID)) {
      throw new Error(`session ${sessionID} is being cleared`);
    }
    if (this.sessionLifecycleLocks.has(sessionID)) {
      throw new Error(
        `session ${sessionID} has a lifecycle operation in progress`,
      );
    }
    return this.createGoalOwned(sessionID, objective, options);
  }

  /**
   * Replaces the focused goal with a new goal under the lifecycle lock.
   */
  async replaceGoals(
    sessionID: string,
    objective: string,
    options: CreateGoalOptions,
  ): Promise<GoalStateMachine> {
    return replaceGoalsOwned(this, sessionID, objective, options);
  }

  async removeGoal(
    sessionID: string,
    goalId: string,
    caller: TransitionSource = 'slash-command',
  ): Promise<void> {
    return this.withSessionLifecycle(sessionID, () =>
      this.removeGoalOwned(sessionID, goalId, caller),
    );
  }

  /**
   * Focuses a target goal. Per the focus contract, this updates only the pointer
   * and lastStatus; it does not pause, activate, or alter turn counters and recovery states.
   */
  async focusGoal(sessionID: string, goalId: string): Promise<FocusResult> {
    return this.withSessionLifecycle(sessionID, () =>
      this.focusGoalOwned(sessionID, goalId),
    );
  }

  /**
   * Clears a session and records durable removal tombstones. Callers should
   * await this method; clearSessionQueued is provided for fire-and-forget hook contexts.
   */
  async clearSession(sessionID: string): Promise<void> {
    if (this.clearingSessions.has(sessionID)) {
      throw new Error(`session ${sessionID} is already being cleared`);
    }
    // Immediately block new goal creation even while waiting for queued lifecycle locks.
    this.clearingSessions.add(sessionID);
    return this.withSessionLifecycle(sessionID, async () => {
      try {
        await this.clearSessionOwned(sessionID);
      } finally {
        this.clearingSessions.delete(sessionID);
      }
    });
  }

  /** Best-effort synchronous session clear for non-async hook callers. */
  clearSessionQueued(sessionID: string): void {
    void this.clearSession(sessionID).catch(error => {
      void this.logError('Failed to persist clear-session tombstone', error);
    });
  }

  addOrderedSession(sessionID: string): void {
    this.runtime.sessionOrdered.add(sessionID);
    if (!this.persistedState.sessionOrdered.includes(sessionID)) {
      this.persistedState.sessionOrdered.push(sessionID);
    }
  }

  isOrdered(sessionID: string): boolean {
    return this.runtime.sessionOrdered.has(sessionID);
  }

  /**
   * Seeds in-memory ordered session flags from startup state. Persisted projections
   * remain partitioned per session file.
   */
  setOrdered(sessions: string[]): void {
    this.runtime.sessionOrdered = new Set(sessions);
  }

  async autoPromote(sessionID: string): Promise<GoalStateMachine | null> {
    return this.withSessionLifecycle(sessionID, () =>
      this.autoPromoteOwned(sessionID),
    );
  }

  /**
   * Persists an intent receipt prior to terminal settlement execution.
   * If the process terminates midway, recovery uses this receipt to reconcile
   * partially settled state.
   */
  async beginSettlement(receipt: SettlementReceipt): Promise<void> {
    this.settlementReceipts.push(receipt);
    this.settlementReceipts = this.settlementReceipts.slice(-256);
    await this.persist(receipt.sessionID);
  }

  /** Marks a settlement as fully converged after goal archival and removal. */
  async completeSettlement(goalId: string): Promise<void> {
    const idx = this.settlementReceipts.findIndex(
      r => r.goalId === goalId && r.completedAt === undefined,
    );
    if (idx < 0) return;
    const completed = this.settlementReceipts[idx]!;
    this.settlementReceipts[idx] = {...completed, completedAt: Date.now()};
    // Lookup session ID directly from receipt since the goal has already been removed from runtime.
    await this.persist(completed.sessionID);
  }

  /** Returns settlement receipts that began but have not yet completed convergence. */
  getUnconvergedSettlements(): SettlementReceipt[] {
    return this.settlementReceipts.filter(r => r.completedAt === undefined);
  }

  /**
   * Projects and returns persisted state for a specific session.
   *
   * Scoping by session ID prevents state cross-contamination between session files.
   */
  getPersistedState(sessionID: string): PersistedState {
    const liveGoals: typeof this.persistedState.goals = [];
    for (const machine of this.runtime.sessionGoals.get(sessionID) ?? []) {
      // Defer checkpointing until create WAL commit succeeds to prevent crash resurrection of snapshot-only goals.
      if (this.pendingCreateIds.has(machine.state.goalId)) continue;
      liveGoals.push(serializeGoal(machine.snapshot()));
    }
    this.persistedState.goals = liveGoals;

    // Project focus pointers only if they reference an active, non-removed goal.
    this.persistedState.focusedGoalIds = [
      ...this.runtime.focusedGoalId.entries(),
    ]
      .filter(
        ([pointerSessionID, goalId]) =>
          pointerSessionID === sessionID &&
          (this.runtime.sessionGoals.get(pointerSessionID) ?? []).some(
            m => m.state.goalId === goalId,
          ),
      )
      .map(([, goalId]) => ({sessionID, goalId}));
    this.persistedState.invalidatedGoalIds = [
      ...(this.invalidatedBySession.get(sessionID) ?? []),
    ];
    this.persistedState.sessionOrdered = this.runtime.sessionOrdered.has(
      sessionID,
    )
      ? [sessionID]
      : [];
    this.persistedState.settlementReceipts = this.settlementReceipts
      .filter(receipt => receipt.sessionID === sessionID)
      .slice(-256);

    const results: GoalResult[] = [];
    const now = Date.now();
    for (const result of this.runtime.sessionArchive.get(sessionID) ?? []) {
      if (now - result.finishedAt < this.resultRetentionMs) {
        results.push(result);
      }
    }
    this.persistedState.results = results;

    // Persist pending intents for live, non-terminal, un-fenced goals so terminal convergence survives restarts.
    const liveById = new Map<
      string,
      {
        sessionID: string;
        machine: import('./state-machine.ts').GoalStateMachine;
      }
    >();
    for (const machine of this.runtime.sessionGoals.get(sessionID) ?? []) {
      liveById.set(machine.state.goalId, {sessionID, machine});
    }
    const persistedIntents: SerializedPendingIntent[] = [];
    for (const [key, intent] of this.runtime.pendingIntents) {
      if (persistedIntents.length >= 2000) break;
      if (this.pendingCreateIds.has(intent.goalId)) continue;
      if (
        (this.invalidatedBySession.get(sessionID) ?? EMPTY_FENCE).has(
          intent.goalId,
        )
      )
        continue;
      const entry = liveById.get(intent.goalId);
      if (!entry || entry.machine.isTerminal()) continue;
      const colon = key.indexOf(':');
      const keySessionID = colon >= 0 ? key.slice(0, colon) : '';
      const keyGoalId = colon >= 0 ? key.slice(colon + 1) : key;
      if (!keySessionID || keyGoalId !== intent.goalId) continue;
      if (entry.sessionID !== keySessionID) continue;
      if (entry.machine.state.sessionID !== keySessionID) continue;
      persistedIntents.push(serializePendingIntent(keySessionID, intent));
    }
    this.persistedState.pendingIntents = persistedIntents;
    return this.persistedState;
  }

  setPersistedState(state: PersistedState): void {
    this.persistedState = state;
  }

  /** Flushes a session's projected state to disk. */
  async persist(sessionID: string): Promise<boolean> {
    return this.persistFn(sessionID);
  }

  async chainWalWrite(
    snapshot: GoalState,
    transition: CommitTransition,
  ): Promise<void> {
    const walPromise = (this.pendingWalWrite ?? Promise.resolve()).then(() =>
      this.writeWalEntry(snapshot, 'committed', transition),
    );
    this.pendingWalWrite = walPromise;
    try {
      await walPromise;
    } finally {
      if (this.pendingWalWrite === walPromise) {
        this.pendingWalWrite = null;
      }
    }
  }

  async drainWalWrites(): Promise<void> {
    while (this.pendingWalWrite) {
      const walPromise = this.pendingWalWrite;
      try {
        await walPromise;
      } catch {
        // Suppress errors during drain; WAL writes are best-effort during shutdown.
      }
      if (this.pendingWalWrite === walPromise) {
        this.pendingWalWrite = null;
      }
    }
  }

  async writeWalEntry(
    snapshot: GoalState,
    phase: 'committed' | 'aborted',
    transition: CommitTransition,
    removed?: boolean,
  ): Promise<void> {
    if (!this.persistEnabled) return;
    // Abort if the session lease cannot be acquired to avoid conflicting ledger writes across processes.
    if (!(await this.prepareSession(snapshot.sessionID))) return;

    const ledgerPath = sessionStatePaths(
      this.stateRoot,
      snapshot.sessionID,
    ).ledgerPath;
    await ensureSessionDir(this.stateRoot, snapshot.sessionID);
    if (
      (this.invalidatedBySession.get(snapshot.sessionID) ?? EMPTY_FENCE).has(
        snapshot.goalId,
      ) &&
      !removed &&
      !this.pendingCreateIds.has(snapshot.goalId)
    ) {
      throw new Error(
        `goal ${snapshot.goalId} was invalidated by session clear or removal`,
      );
    }
    const walTransition: WalTransition = {
      source: transition.source,
      goalId: snapshot.goalId,
      fromStatus: transition.from,
      toStatus: transition.to,
      stopReason: snapshot.stopReason,
      blockedReason: snapshot.blockedReason,
      detail: transition.detail,
    };
    const entry =
      phase === 'committed'
        ? createCommittedEntry(snapshot, walTransition, ledgerPath, removed)
        : createAbortedEntry(snapshot, walTransition, ledgerPath);
    try {
      // Append entry before rotating to ensure transition durability if rotation encounters errors.
      await appendWalEntry(ledgerPath, entry);
      // Retain tombstones during zero-retention mode until checkpointing completes to avoid re-creation windows.
      if (!(
        this.ledgerRetentionFiles === 0 &&
        (removed || this.pendingInvalidationCheckpoints.has(snapshot.goalId))
      )) {
        try {
          await rotateLedgerIfNeeded(
            ledgerPath,
            this.ledgerMaxBytes,
            this.ledgerRetentionFiles,
          );
        } catch (rotationError) {
          // Entry is already durable; do not treat rotation errors as a commit failure.
          await this.logError(
            'WAL rotation failed after durable append',
            rotationError,
          );
        }
      }
    } catch (error) {
      await this.logError('WAL write failed', error);
      throw error;
    }
  }

  private createGoalOwned(
    sessionID: string,
    objective: string,
    options: CreateGoalOptions,
  ): GoalStateMachine {
    return createGoalOwned(this, sessionID, objective, options);
  }

  private async removeGoalOwned(
    sessionID: string,
    goalId: string,
    caller: TransitionSource,
  ): Promise<void> {
    return removeGoalOwned(this, sessionID, goalId, caller);
  }

  private async focusGoalOwned(
    sessionID: string,
    goalId: string,
  ): Promise<FocusResult> {
    return focusGoalOwned(this, sessionID, goalId);
  }

  private async clearSessionOwned(sessionID: string): Promise<void> {
    return clearSessionOwned(this, sessionID);
  }

  private async autoPromoteOwned(
    sessionID: string,
  ): Promise<GoalStateMachine | null> {
    return autoPromoteOwned(this, sessionID);
  }
}
