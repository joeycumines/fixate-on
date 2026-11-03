// session-scoped-projection.test.ts — one session's file holds one session's goals.
//
// `getPersistedState(sessionID)` is the only place goal state crosses into
// persistence, and its whole job is to be incapable of emitting another
// session's data. Before this it took no argument and walked every session in
// the runtime, so a caller that forgot to filter — or a caller that did not
// know it had to — wrote every session's goals into whichever file it was
// pointed at. The result is not a crash: two sessions end up holding each
// other's objectives, and each one's recovery restores the other's work.
//
// These assertions read the FILES, not the API, because the API is the thing
// under suspicion. A test that asserted `getPersistedState("A").goals` has the
// right length would pass on a projection that also carried B's goals in a
// field nobody looked at.

import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';
import {
  ensureSessionDir,
  listSessionIDs,
  sessionStatePaths,
} from '../src/session-paths.ts';
import {deserializeGoal, type PersistedState} from '../src/persistence.ts';
import {recoverState, writeStateFile} from '../src/persistence-wal.ts';

/** Every session is writable in these fixtures: the lease and the sequence seeding are
 * decided by the composition root, and these tests exercise the manager directly. */
const CAN_WRITE_ANY = async (): Promise<boolean> => true;

/** No session was read at startup, so no invalidation fence was recovered. */
const EMPTY_INVALIDATION: ReadonlyMap<string, readonly string[]> = new Map();

describe("one session's file holds one session's goals", () => {
  test('two sessions produce two files, and neither mentions the other', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projection-'));
    try {
      const runtime = createRuntimeState();
      // The persistence callback needs the manager and a `const` cannot be
      // built from its own initialiser, so the back-reference is carried by a
      // holder — the same shape the other fixtures use, and with no lint
      // suppression. The callback only runs after construction.
      const self: {manager?: SessionStateManager} = {};
      const manager: SessionStateManager = new SessionStateManager(
        runtime,
        async (sessionID: string) => {
          const state = self.manager!.getPersistedState(sessionID);
          return writeStateFile(
            sessionStatePaths(root, sessionID).statePath,
            state.goals.map(g => deserializeGoal(g)),
            state.results,
            state.sessionOrdered,
            state.invalidatedGoalIds,
            state.pendingIntents,
            state.settlementReceipts,
            state.focusedGoalIds,
          );
        },
        root,
        undefined,
        EMPTY_INVALIDATION,
        CAN_WRITE_ANY,
        undefined,
        undefined,
        undefined,
        undefined,
        DEFAULT_GOAL_OPTIONS,
        async () => {},
      );
      self.manager = manager;

      const alpha = manager.createGoal('ses-alpha', 'alpha objective', {});
      const beta = manager.createGoal('ses-beta', 'beta objective', {});
      await manager.drainWalWrites();
      await manager.persist('ses-alpha');
      await manager.persist('ses-beta');

      const alphaRaw = await readFile(
        sessionStatePaths(root, 'ses-alpha').statePath,
        'utf8',
      );
      const betaRaw = await readFile(
        sessionStatePaths(root, 'ses-beta').statePath,
        'utf8',
      );

      // The other session's identity appears NOWHERE in this file — not its id,
      // not its goal id, not its objective. A substring check rather than a
      // structural one on purpose: it catches an id that leaked into a field
      // nobody thought to check.
      expect(alphaRaw).not.toContain('ses-beta');
      expect(alphaRaw).not.toContain(beta.state.goalId);
      expect(alphaRaw).not.toContain('beta objective');
      expect(betaRaw).not.toContain('ses-alpha');
      expect(betaRaw).not.toContain(alpha.state.goalId);
      expect(betaRaw).not.toContain('alpha objective');

      // And each file holds exactly its own goal.
      const alphaState = JSON.parse(alphaRaw) as PersistedState;
      const betaState = JSON.parse(betaRaw) as PersistedState;
      expect(alphaState.goals.map(g => g.goalId)).toEqual([alpha.state.goalId]);
      expect(betaState.goals.map(g => g.goalId)).toEqual([beta.state.goalId]);
      expect((await listSessionIDs(root)).sort()).toEqual([
        'ses-alpha',
        'ses-beta',
      ]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test("a projection for a session that has no goals writes an empty file, not another's", async () => {
    const root = await mkdtemp(join(tmpdir(), 'projection-empty-'));
    try {
      const runtime = createRuntimeState();
      // The persistence callback needs the manager and a `const` cannot be
      // built from its own initialiser, so the back-reference is carried by a
      // holder — the same shape the other fixtures use, and with no lint
      // suppression. The callback only runs after construction.
      const self: {manager?: SessionStateManager} = {};
      const manager: SessionStateManager = new SessionStateManager(
        runtime,
        async (sessionID: string) => {
          const state = self.manager!.getPersistedState(sessionID);
          return writeStateFile(
            sessionStatePaths(root, sessionID).statePath,
            state.goals.map(g => deserializeGoal(g)),
            state.results,
            state.sessionOrdered,
            state.invalidatedGoalIds,
            state.pendingIntents,
            state.settlementReceipts,
            state.focusedGoalIds,
          );
        },
        root,
        undefined,
        EMPTY_INVALIDATION,
        CAN_WRITE_ANY,
        undefined,
        undefined,
        undefined,
        undefined,
        DEFAULT_GOAL_OPTIONS,
        async () => {},
      );
      self.manager = manager;
      manager.createGoal('ses-one', 'only goal here', {});
      await manager.drainWalWrites();
      await manager.persist('ses-one');
      // Writing an unrelated session must not carry the first session's goal
      // along — this is the mutation that was NOT caught by any test when the
      // projection ignored its argument.
      await manager.persist('ses-two');
      const two = JSON.parse(
        await readFile(sessionStatePaths(root, 'ses-two').statePath, 'utf8'),
      ) as PersistedState;
      expect(two.goals).toEqual([]);
      expect(two.results).toEqual([]);
      expect(two.focusedGoalIds).toEqual([]);
      const one = JSON.parse(
        await readFile(sessionStatePaths(root, 'ses-one').statePath, 'utf8'),
      ) as PersistedState;
      expect(one.goals).toHaveLength(1);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test("a removed goal's fence stays in ITS session's file, not the other's", async () => {
    // The fence has to outlive the goal it fences, so it cannot be derived
    // from the live machines — and a workspace-wide fence would put one
    // session's removed goal ids into every other session's file, which is the
    // cross-session leak this whole change set is about, in the one field that
    // survives removal.
    const root = await mkdtemp(join(tmpdir(), 'projection-fence-'));
    try {
      const runtime = createRuntimeState();
      const self: {manager?: SessionStateManager} = {};
      const manager: SessionStateManager = new SessionStateManager(
        runtime,
        async (sessionID: string) => {
          const state = self.manager!.getPersistedState(sessionID);
          return writeStateFile(
            sessionStatePaths(root, sessionID).statePath,
            state.goals.map(g => deserializeGoal(g)),
            state.results,
            state.sessionOrdered,
            state.invalidatedGoalIds,
            state.pendingIntents,
            state.settlementReceipts,
            state.focusedGoalIds,
          );
        },
        root,
        undefined,
        EMPTY_INVALIDATION,
        CAN_WRITE_ANY,
        undefined,
        undefined,
        undefined,
        undefined,
        DEFAULT_GOAL_OPTIONS,
        async () => {},
      );
      self.manager = manager;
      const kept = manager.createGoal('ses-keep', 'kept goal', {});
      const removed = manager.createGoal('ses-gone', 'removed goal', {});
      await manager.drainWalWrites();
      await manager.persist('ses-keep');
      await manager.persist('ses-gone');
      await manager.removeGoal('ses-gone', removed.state.goalId, 'update_goal');
      await manager.persist('ses-gone');
      await manager.persist('ses-keep');

      const keep = JSON.parse(
        await readFile(sessionStatePaths(root, 'ses-keep').statePath, 'utf8'),
      ) as PersistedState;
      const gone = JSON.parse(
        await readFile(sessionStatePaths(root, 'ses-gone').statePath, 'utf8'),
      ) as PersistedState;
      expect(gone.invalidatedGoalIds).toContain(removed.state.goalId);
      expect(keep.invalidatedGoalIds).not.toContain(removed.state.goalId);
      expect(keep.goals.map(g => g.goalId)).toEqual([kept.state.goalId]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test('STARTUP recovers every session, not just the first one it finds', async () => {
    // The load-bearing claim, driven through the real plugin factory. At load
    // no session exists, so a startup that read only one file would find
    // nothing for a session about to be resumed and its active goal would
    // silently never re-arm — and nothing else in the suite would notice,
    // because a single-session test passes either way.
    const root = await mkdtemp(join(tmpdir(), 'projection-startup-plugin-'));
    try {
      for (const [sessionID, objective, goalId] of [
        ['ses-first', 'first session objective', 'goal-first'],
        ['ses-second', 'second session objective', 'goal-second'],
      ] as const) {
        await ensureSessionDir(root, sessionID);
        await writeStateFile(
          sessionStatePaths(root, sessionID).statePath,
          [makeGoal(sessionID, objective, goalId) as never],
          [],
          [],
        );
      }
      const hooks = await GoalsPlugin(
        {directory: root},
        {stateRoot: root, idlePoller: false},
      );
      try {
        for (const [sessionID, objective] of [
          ['ses-first', 'first session objective'],
          ['ses-second', 'second session objective'],
        ] as const) {
          const output: {parts: {type: string; text: string}[]} = {parts: []};
          await hooks['command.execute.before']!(
            {command: 'goal', sessionID, arguments: 'status'},
            output,
          );
          expect(output.parts[0]?.text, sessionID).toContain(objective);
        }
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test("an ordered session's file says so and names no other session", async () => {
    // `sessionOrdered` and `settlementReceipts` were the two fields the
    // per-session projection missed: both were written process-wide, so a
    // session's file named another session's ids — and because startup merges
    // every file and each file was rewritten with the merged whole, two ordered
    // sessions grew one entry per RESTART, until the cap dropped the tail,
    // which was other sessions' contributions.
    const root = await mkdtemp(join(tmpdir(), 'projection-ordered-'));
    try {
      const runtime = createRuntimeState();
      const self: {manager?: SessionStateManager} = {};
      const manager: SessionStateManager = new SessionStateManager(
        runtime,
        async (sessionID: string) => {
          const state = self.manager!.getPersistedState(sessionID);
          return writeStateFile(
            sessionStatePaths(root, sessionID).statePath,
            state.goals.map(g => deserializeGoal(g)),
            state.results,
            state.sessionOrdered,
            state.invalidatedGoalIds,
            state.pendingIntents,
            state.settlementReceipts,
            state.focusedGoalIds,
          );
        },
        root,
        undefined,
        EMPTY_INVALIDATION,
        CAN_WRITE_ANY,
        undefined,
        undefined,
        undefined,
        undefined,
        DEFAULT_GOAL_OPTIONS,
        async () => {},
      );
      self.manager = manager;
      const one = manager.createGoal('ses-one', 'first', {});
      const two = manager.createGoal('ses-two', 'second', {});
      await manager.drainWalWrites();
      manager.addOrderedSession('ses-two');
      await manager.beginSettlement({
        goalId: one.state.goalId,
        sessionID: 'ses-one',
        targetStatus: 'complete',
        kind: 'settle-complete',
        revision: one.snapshot().revision,
        startedAt: 1,
      });
      await manager.persist('ses-one');
      await manager.persist('ses-two');

      const oneRaw = await readFile(
        sessionStatePaths(root, 'ses-one').statePath,
        'utf8',
      );
      const twoRaw = await readFile(
        sessionStatePaths(root, 'ses-two').statePath,
        'utf8',
      );
      // The ordered session's own file says so, and only so.
      const oneState = JSON.parse(oneRaw) as {
        sessionOrdered: string[];
        settlementReceipts: {sessionID: string}[];
      };
      const twoState = JSON.parse(twoRaw) as {
        sessionOrdered: string[];
        settlementReceipts: {sessionID: string; goalId: string}[];
      };
      expect(oneState.sessionOrdered).toEqual([]);
      expect(twoState.sessionOrdered).toEqual(['ses-two']);
      expect(oneRaw).not.toContain('ses-two');
      expect(twoRaw).not.toContain('ses-one');
      // And each session's receipts, and nobody else's.
      expect(oneState.settlementReceipts.map(r => r.sessionID)).toEqual([
        'ses-one',
      ]);
      expect(twoState.settlementReceipts).toEqual([]);
      // Its OWN goal, yes; the other session's, no.
      expect(twoRaw).toContain(two.state.goalId);
      expect(twoRaw).not.toContain(one.state.goalId);

      // The growth: re-seeding from the merged view must not inflate either
      // file. Two restarts is enough to see a per-restart increment.
      for (let restart = 0; restart < 2; restart++) {
        const merged = JSON.parse(oneRaw);
        await manager.setPersistedState(merged);
        manager.setOrdered(['ses-two']);
        await manager.persist('ses-two');
      }
      const grown = JSON.parse(
        await readFile(sessionStatePaths(root, 'ses-two').statePath, 'utf8'),
      ) as {
        sessionOrdered: string[];
        settlementReceipts: unknown[];
      };
      expect(grown.sessionOrdered).toEqual(['ses-two']);
      expect(grown.settlementReceipts).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);

  test("startup finds BOTH sessions' goals, and each recovers into its own", async () => {
    // The claim that is easy to get wrong: at plugin load no session exists, so
    // reading only "the current session's" file silently breaks resume. This
    // drives the real startup enumeration and the real recovery.
    const root = await mkdtemp(join(tmpdir(), 'projection-startup-'));
    try {
      const write = async (
        sessionID: string,
        objective: string,
        goalId: string,
      ): Promise<void> => {
        await ensureSessionDir(root, sessionID);
        await writeStateFile(
          sessionStatePaths(root, sessionID).statePath,
          [makeGoal(sessionID, objective, goalId) as never],
          [],
          [],
        );
      };
      await write('ses-a', 'first session objective', 'goal-a');
      await write('ses-b', 'second session objective', 'goal-b');

      expect(await listSessionIDs(root)).toEqual(['ses-a', 'ses-b']);
      for (const sessionID of await listSessionIDs(root)) {
        const paths = sessionStatePaths(root, sessionID);
        const recovered = await recoverState(paths.statePath, paths.ledgerPath);
        expect(recovered.goals).toHaveLength(1);
        expect(recovered.goals[0]!.sessionID).toBe(sessionID);
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

function makeGoal(
  sessionID: string,
  objective: string,
  goalId: string,
): Record<string, unknown> {
  return {
    goalId,
    runId: 'run-1',
    revision: 1,
    condition: objective,
    successCriteria: '',
    constraints: '',
    artifactPointers: [],
    pendingProposal: null,
    mode: 'normal',
    sessionID,
    tokenBudget: null,
    maxTokens: 1000000,
    maxTurns: 0,
    maxDurationMs: 1800000,
    minDelayMs: 1500,
    noProgressTokenThreshold: 50,
    noProgressTurnsBeforePause: 3,
    noToolCallTurnsBeforePause: 3,
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    pausedAt: 0,
    finishedAt: null,
    status: 'paused',
    stopReason: 'recovery',
    blockedReason: '',
    finalizing: false,
    budgetLimitReported: false,
    budgetWrapupSent: false,
    objectiveUpdatedPending: false,
    noProgressTurns: 0,
    noToolCallTurns: 0,
    promptFailures: 0,
    recoveryTurns: 0,
    maxRecoveryTurns: 12,
    unchangedResults: 0,
    maxUnchangedResults: 3,
    lastCandidate: null,
    lastFingerprint: null,
    blockedTurns: 0,
    maxBlockedTurns: 3,
    blockedAssertedThisTurn: false,
    languageTriage: true,
    lastStatus: '',
    lastAssistantText: '',
    lastAssistantMessageID: '',
    lastContinueAt: 0,
    lastProgressAt: 0,
    continuationClaim: null,
    pendingNotices: [],
    history: [],
    lastCheckpoint: null,
    checkpoints: [],
    claims: [],
    lastClaim: null,
    messageIDs: [],
    executionContext: null,
  };
}
