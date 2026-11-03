import type {
  CommitTransition,
  GoalState,
  GoalStateMachine,
} from './state-machine.ts';
import type {PersistedState} from './persistence.ts';
import type {DefaultGoalOptions, RuntimeState} from './session-runtime.ts';
import type {GoalBroadcaster} from './tui-state.ts';

/**
 * Host interface implemented by SessionStateManager and consumed by goal lifecycle operations.
 * Declared separately to prevent circular import dependencies between SessionStateManager and session-lifecycle.
 */
export interface SessionLifecycleHost {
  runtime: RuntimeState;
  persistedState: PersistedState;
  persistFn: (sessionID: string) => Promise<boolean>;
  stateRoot: string;
  persistEnabled: boolean;
  ledgerMaxBytes: number;
  ledgerRetentionFiles: number;
  maxArchived: number;
  resultRetentionMs: number;
  defaultOpts: Required<DefaultGoalOptions>;
  logError: (message: string, error?: unknown) => Promise<void>;
  pendingWalWrite: Promise<void> | null;
  pendingCreateIds: Set<string>;
  invalidatedBySession: Map<string, Set<string>>;
  pendingInvalidationCheckpoints: Set<string>;
  clearingSessions: Set<string>;
  broadcaster: GoalBroadcaster | null;

  withSessionLifecycle<T>(
    sessionID: string,
    operation: () => Promise<T>,
  ): Promise<T>;

  getMachine(sessionID: string): GoalStateMachine | null;

  createOnCommit(): (
    snapshot: Readonly<GoalState>,
    transition: CommitTransition,
  ) => Promise<void>;

  createOnUsageUpdate():
    ((snapshot: Readonly<GoalState>) => Promise<void>) | undefined;

  writeWalEntry(
    snapshot: GoalState,
    phase: 'committed' | 'aborted',
    transition: CommitTransition,
    removed?: boolean,
  ): Promise<void>;

  drainWalWrites(): Promise<void>;

  persist(sessionID: string): Promise<boolean>;

  addInvalidation(sessionID: string, goalId: string): void;
}
