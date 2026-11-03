// create-rollback-fence.test.ts — a failed rollback persist must keep the
// invalidation checkpoint.
//
// The invariant: when a goal's create-WAL write fails, the rollback path adds
// the goal to `pendingInvalidationCheckpoints` BEFORE it attempts the rollback
// snapshot, and releases that checkpoint ONLY when the snapshot is durable. If
// the snapshot persist fails, the checkpoint MUST remain, because it is the
// only record that the stale on-disk snapshot is not trustworthy — and, under
// zero-retention rotation, the only thing suppressing a post-append unlink that
// would otherwise discard the rollback tombstone while the stale snapshot still
// names the goal live.
//
// The mutant removes the `.add` from the rollback catch block. Without it the
// checkpoint set is empty after a failed persist, and the assertion below fails.
//
// `pendingInvalidationCheckpoints` is private — deliberately: it is an internal
// durability book that no caller should steer by. bun erases access modifiers at
// runtime, which lets this test observe the invariant directly. If this cast
// stops compiling, the field was renamed or removed: re-derive the observation
// rather than deleting the test.
import {describe, expect, test} from 'bun:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';
import type {PersistedState} from '../src/persistence.ts';

const EMPTY_INVALIDATION: ReadonlyMap<string, readonly string[]> = new Map();
const CAN_WRITE_ANY = async (): Promise<boolean> => true;
const managerOptions = {
  maxTokens: DEFAULT_GOAL_OPTIONS.maxTokens,
  maxTurns: DEFAULT_GOAL_OPTIONS.maxTurns,
  maxDurationMs: DEFAULT_GOAL_OPTIONS.maxDurationMs,
  noProgressTokenThreshold: DEFAULT_GOAL_OPTIONS.noProgressTokenThreshold,
  noProgressTurnsBeforePause: DEFAULT_GOAL_OPTIONS.noProgressTurnsBeforePause,
  noToolCallTurnsBeforePause: DEFAULT_GOAL_OPTIONS.noToolCallTurnsBeforePause,
  budgetWrapupRatio: DEFAULT_GOAL_OPTIONS.budgetWrapupRatio,
  minDelayMs: DEFAULT_GOAL_OPTIONS.minDelayMs,
  maxPromptFailures: DEFAULT_GOAL_OPTIONS.maxPromptFailures,
  maxRecentMessages: DEFAULT_GOAL_OPTIONS.maxRecentMessages,
  maxRecoveryTurns: DEFAULT_GOAL_OPTIONS.maxRecoveryTurns,
  maxUnchangedResults: DEFAULT_GOAL_OPTIONS.maxUnchangedResults,
  maxBlockedTurns: DEFAULT_GOAL_OPTIONS.maxBlockedTurns,
  languageTriage: DEFAULT_GOAL_OPTIONS.languageTriage,
};

function pendingInvalidationCheckpointsOf(
  manager: SessionStateManager,
): ReadonlySet<string> {
  return (manager as unknown as {pendingInvalidationCheckpoints: Set<string>})
    .pendingInvalidationCheckpoints;
}

describe('create rollback fence (46E)', () => {
  test('a failed rollback persist keeps the invalidation checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fx-rollback-fence-'));
    try {
      // Make the create's WAL write fail: a state root placed under a regular
      // file fails mkdir/append with ENOTDIR at the write path.
      const blocker = join(dir, 'blocker');
      await writeFile(blocker, 'not a directory', 'utf8');
      const stateRoot = join(blocker, 'root');

      let persistCalls = 0;
      const runtime = createRuntimeState();
      const initial: PersistedState = {
        version: 1,
        goals: [],
        results: [],
        sessionOrdered: [],
      };
      const manager = new SessionStateManager(
        runtime,
        async () => {
          persistCalls += 1;
          // The rollback snapshot is NOT persisted: the checkpoint must remain.
          return false;
        },
        stateRoot,
        initial,
        EMPTY_INVALIDATION,
        CAN_WRITE_ANY,
        1024,
        3,
        10,
        86_400_000,
        managerOptions,
        async () => {},
      );

      // createGoal returns synchronously; the WAL write is chained and fails
      // asynchronously, driving the rollback.
      const machine = manager.createGoal('session-1', 'doomed goal', {});
      expect(machine).not.toBeNull();
      const goalId = machine!.state.goalId;

      await manager.drainWalWrites();

      // The goal is gone from the runtime and from the persisted projection...
      const live = runtime.sessionGoals.get('session-1') ?? [];
      expect(live.some(m => m.state.goalId === goalId)).toBe(false);
      expect(manager.getPersistedState('session-1').goals).toEqual([]);
      //...and the rollback really did attempt the snapshot persist.
      expect(persistCalls).toBeGreaterThanOrEqual(1);

      // THE INVARIANT: a failed rollback persist keeps the checkpoint.
      expect(
        pendingInvalidationCheckpointsOf(manager).has(goalId),
        'a failed rollback persist must keep the invalidation checkpoint',
      ).toBe(true);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
