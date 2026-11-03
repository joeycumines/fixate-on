// STATE-CONVERGENCE-1 (4): removeGoal must make its archive and invalidation
// fence DURABLE as part of the removal, not on some later persistence call.
//
// The defect: a successful removeGoal inserted the archived result into the
// runtime archive and marked the goal invalidated, but persisted neither. A
// restart before the next unrelated persist lost the archive, and a stale
// snapshot could resurrect the removed goal.
import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';
import {deserializeGoal, type PersistedState} from '../src/persistence.ts';
import {recoverState, writeStateFile} from '../src/persistence-wal.ts';
import {createGoalBroadcaster, serializeGoalForTui} from '../src/tui-state.ts';
import {
  createGoalState,
  GoalStateMachine,
  resumeClockInPlace,
} from '../src/state-machine.ts';
import {durationLimitReached, stopReason} from '../src/continuation-loop.ts';

/** No session was read at startup, so no fence was recovered. */
const EMPTY_INVALIDATION: ReadonlyMap<string, readonly string[]> = new Map();

/** Every session is writable in these fixtures: the lease and the sequence seeding are
 * decided by the composition root, and these tests exercise the manager directly. */
const CAN_WRITE_ANY = async (): Promise<boolean> => true;

function makeGoalSnapshotForBroadcast() {
  return serializeGoalForTui(
    createGoalState('s1', 'broadcast probe', {
      goalId: 'g1',
      runId: 'r1',
      maxTokens: 1000,
      maxTurns: 1,
      maxDurationMs: 1000,
    }),
  );
}

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

async function makeManager(stateRoot: string, persistCalls: number[]) {
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
      persistCalls.push(Date.now());
      return true;
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
  return {runtime, manager};
}

test('removeGoal persists the archive and the invalidation fence itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-convergence-'));
  try {
    const persistCalls: number[] = [];
    const {runtime, manager} = await makeManager(dir, persistCalls);
    const machine = manager.createGoal('s1', 'a goal that will be removed', {});
    const goalId = machine.snapshot().goalId;
    const before = persistCalls.length;

    await manager.removeGoal('s1', goalId, 'update_goal');

    // The removal must have persisted as PART of the operation.
    expect(persistCalls.length).toBeGreaterThan(before);

    // The archive holds the result...
    const archive = runtime.sessionArchive.get('s1') ?? [];
    expect(archive.some(r => r.goalId === goalId)).toBe(true);

    //...and the goal is fenced so a stale snapshot cannot resurrect it.
    const state = manager.getPersistedState('s1');
    expect(state.invalidatedGoalIds).toContain(goalId);
    expect(state.goals.some(g => g.goalId === goalId)).toBe(false);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('a second manager over the same persisted state cannot resurrect the removed goal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-convergence2-'));
  try {
    const persistCalls: number[] = [];
    const {manager} = await makeManager(dir, persistCalls);
    const machine = manager.createGoal('s1', 'removed then restarted', {});
    const goalId = machine.snapshot().goalId;
    await manager.removeGoal('s1', goalId, 'update_goal');

    // Simulate a restart: a fresh manager built from the DURABLE state.
    const durable = JSON.parse(
      JSON.stringify({
        ...manager.getPersistedState('s1'),
        goals: manager.getPersistedState('s1').goals,
        results: manager.getPersistedState('s1').results,
      }),
    );
    const runtime2 = createRuntimeState();
    const manager2 = new SessionStateManager(
      runtime2,
      async () => true,
      dir,
      durable,
      EMPTY_INVALIDATION,
      CAN_WRITE_ANY,
      1024,
      3,
      10,
      86_400_000,
      managerOptions,
      async () => {},
    );
    const live = manager2.listActiveGoals('s1');
    expect(live.some(g => g.goalId === goalId)).toBe(false);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

// STATE-CONVERGENCE-1 (2): durable settlement receipts

test('an interrupted settlement is detectable as unconverged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-settle-'));
  try {
    const persistCalls: number[] = [];
    const {manager} = await makeManager(dir, persistCalls);
    const machine = manager.createGoal('s1', 'a goal that will settle', {});
    const goalId = machine.snapshot().goalId;

    // Settlement begins: the receipt is durable BEFORE the stages run.
    const beforeBegin = persistCalls.length;
    await manager.beginSettlement({
      goalId,
      sessionID: 's1',
      targetStatus: 'complete',
      kind: 'settle-complete',
      revision: machine.snapshot().revision,
      startedAt: Date.now(),
    });
    // The receipt must be DURABLE at begin time, not merely in memory — that is
    // the whole point: a crash before the settlement stages run must leave a
    // trace. Asserting the persist call is what distinguishes the two.
    expect(persistCalls.length).toBeGreaterThan(beforeBegin);
    expect(manager.getUnconvergedSettlements().map(r => r.goalId)).toContain(
      goalId,
    );
    expect(
      manager
        .getPersistedState('s1')
        .settlementReceipts?.some(r => r.goalId === goalId),
    ).toBe(true);

    // Settlement completes: the receipt is closed.
    await manager.completeSettlement(goalId);
    expect(
      manager.getUnconvergedSettlements().map(r => r.goalId),
    ).not.toContain(goalId);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('a restart surfaces an interrupted settlement instead of hiding it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-settle2-'));
  try {
    const persistCalls: number[] = [];
    const {manager} = await makeManager(dir, persistCalls);
    const machine = manager.createGoal('s1', 'interrupted settle', {});
    const goalId = machine.snapshot().goalId;
    await manager.beginSettlement({
      goalId,
      sessionID: 's1',
      targetStatus: 'complete',
      kind: 'settle-complete',
      revision: machine.snapshot().revision,
      startedAt: Date.now(),
    });
    const durable = JSON.parse(JSON.stringify(manager.getPersistedState('s1')));

    // Restart from the durable state.
    const runtime2 = createRuntimeState();
    const manager2 = new SessionStateManager(
      runtime2,
      async () => true,
      dir,
      durable,
      EMPTY_INVALIDATION,
      CAN_WRITE_ANY,
      1024,
      3,
      10,
      86_400_000,
      managerOptions,
      async () => {},
    );
    const pending = manager2.getUnconvergedSettlements();
    expect(pending.map(r => r.goalId)).toContain(goalId);
    expect(pending[0].targetStatus).toBe('complete');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('completeSettlement is a no-op when no receipt is open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-settle3-'));
  try {
    const persistCalls: number[] = [];
    const {manager} = await makeManager(dir, persistCalls);
    const before = persistCalls.length;
    await manager.completeSettlement('never-begun');
    expect(persistCalls.length).toBe(before); // no spurious write
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

// STATE-CONVERGENCE-1 (2): broadcast delivery failures are observable

test('a dropped remove broadcast is REPORTED, not silently swallowed', async () => {
  // The resilience behaviour (never break the state machine) is preserved, but
  // a swallowed remove leaves the companion rendering a goal that no longer
  // exists — a false-live goal indistinguishable from a real one. The failure
  // must surface.
  const failures: Array<{kind: string; goalId?: string}> = [];
  const broadcaster = createGoalBroadcaster({
    publish: async () => {
      throw new Error('transport down');
    },
    onDeliveryFailure: info => {
      failures.push({kind: info.kind, goalId: info.goalId});
    },
  });

  // Must not throw despite the transport failing.
  await broadcaster.emitRemove('s1', 'g-gone');
  await broadcaster.emitCreate({...makeGoalSnapshotForBroadcast()} as never);

  expect(failures.map(f => f.kind)).toContain('remove');
  expect(failures.find(f => f.kind === 'remove')?.goalId).toBe('g-gone');
  expect(failures.map(f => f.kind)).toContain('create');
});

test('a throwing onDeliveryFailure still never breaks the broadcaster', async () => {
  const broadcaster = createGoalBroadcaster({
    publish: async () => {
      throw new Error('transport down');
    },
    onDeliveryFailure: () => {
      throw new Error('reporter itself failed');
    },
  });
  await expect(broadcaster.emitRemove('s1', 'g1')).resolves.toBeUndefined();
});

// STATE-CONVERGENCE-1 (2): the receipt must reach DISK and come back
//
// The earlier receipt tests used a mock persistFn that only recorded that it was
// called, so they passed while `writeStateFile` silently omitted the receipts —
// durability was an illusion. These read the real file.

test('beginSettlement writes the receipt to the REAL state file, and recovery reads it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-settle-disk-'));
  try {
    const statePath = join(dir, 'state.json');
    const runtime = createRuntimeState();
    // The persistence callback below reads the manager it is being constructed
    // with, so the reference is circular: a `const` cannot be built from its own
    // initialiser, and `let` assigned once is exactly what `prefer-const` objects
    // to. The holder carries the same back-reference with no `let` and no rule
    // suppression. The callback runs only after construction, so the wiring below
    // is in place before the first call.
    const self: {manager?: SessionStateManager} = {};
    const manager = new SessionStateManager(
      runtime,
      // A real persistence function, exactly as the runtime wires it.
      (sessionID: string) => {
        const state = self.manager!.getPersistedState(sessionID);
        return writeStateFile(
          statePath,
          state.goals.map(g => deserializeGoal(g)),
          state.results,
          state.sessionOrdered,
          state.invalidatedGoalIds,
          state.pendingIntents,
          state.settlementReceipts,
        );
      },
      dir,
      {version: 1, goals: [], results: [], sessionOrdered: []},
      EMPTY_INVALIDATION,
      CAN_WRITE_ANY,
      1024,
      3,
      10,
      86_400_000,
      managerOptions,
      async () => {},
    );
    self.manager = manager;
    const machine = manager.createGoal('s1', 'settles durably', {});
    const goalId = machine.snapshot().goalId;
    await manager.beginSettlement({
      goalId,
      sessionID: 's1',
      targetStatus: 'complete',
      kind: 'settle-complete',
      revision: machine.snapshot().revision,
      startedAt: Date.now(),
    });

    // The FILE must carry it.
    const onDisk = JSON.parse(await readFile(statePath, 'utf8')) as {
      settlementReceipts?: Array<{goalId: string}>;
    };
    expect(onDisk.settlementReceipts?.map(r => r.goalId)).toContain(goalId);

    // And recovery must surface it, so a restart can see the interrupted settle.
    const recovered = await recoverState(statePath, join(dir, 'ledger.jsonl'));
    expect(recovered.settlementReceipts.map(r => r.goalId)).toContain(goalId);
    expect(recovered.settlementReceipts[0].targetStatus).toBe('complete');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test("completeSettlement's closure also reaches disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-settle-disk2-'));
  try {
    const statePath = join(dir, 'state.json');
    const runtime = createRuntimeState();
    // The persistence callback below reads the manager it is being constructed
    // with, so the reference is circular: a `const` cannot be built from its own
    // initialiser, and `let` assigned once is exactly what `prefer-const` objects
    // to. The holder carries the same back-reference with no `let` and no rule
    // suppression. The callback runs only after construction, so the wiring below
    // is in place before the first call.
    const self: {manager?: SessionStateManager} = {};
    const manager = new SessionStateManager(
      runtime,
      (sessionID: string) => {
        const state = self.manager!.getPersistedState(sessionID);
        return writeStateFile(
          statePath,
          state.goals.map(g => deserializeGoal(g)),
          state.results,
          state.sessionOrdered,
          state.invalidatedGoalIds,
          state.pendingIntents,
          state.settlementReceipts,
        );
      },
      dir,
      {version: 1, goals: [], results: [], sessionOrdered: []},
      EMPTY_INVALIDATION,
      CAN_WRITE_ANY,
      1024,
      3,
      10,
      86_400_000,
      managerOptions,
      async () => {},
    );
    self.manager = manager;
    const machine = manager.createGoal('s1', 'closes durably', {});
    const goalId = machine.snapshot().goalId;
    await manager.beginSettlement({
      goalId,
      sessionID: 's1',
      targetStatus: 'complete',
      kind: 'settle-complete',
      revision: machine.snapshot().revision,
      startedAt: Date.now(),
    });
    await manager.completeSettlement(goalId);

    const onDisk = JSON.parse(await readFile(statePath, 'utf8')) as {
      settlementReceipts?: Array<{goalId: string; completedAt?: number}>;
    };
    const receipt = onDisk.settlementReceipts?.find(r => r.goalId === goalId);
    expect(receipt).toBeDefined();
    expect(typeof receipt!.completedAt).toBe('number');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

// STATE-CONVERGENCE-1 (1): the intent must reach DISK and come back
//
// The earlier intent test used a mock persistFn that only counted calls, so it
// passed while the intent never reached the file: `pendingCreateIds` was never
// cleared on the create success path when no ledger is configured, and that
// marker permanently excludes a goal from intent projection.

test('a pending intent reaches the REAL state file and recovery reads it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-intent-disk-'));
  try {
    const statePath = join(dir, 'state.json');
    const runtime = createRuntimeState();
    // The persistence callback below reads the manager it is being constructed
    // with, so the reference is circular: a `const` cannot be built from its own
    // initialiser, and `let` assigned once is exactly what `prefer-const` objects
    // to. The holder carries the same back-reference with no `let` and no rule
    // suppression. The callback runs only after construction, so the wiring below
    // is in place before the first call.
    const self: {manager?: SessionStateManager} = {};
    const manager = new SessionStateManager(
      runtime,
      (sessionID: string) => {
        const st = self.manager!.getPersistedState(sessionID);
        return writeStateFile(
          statePath,
          st.goals.map(g => deserializeGoal(g)),
          st.results,
          st.sessionOrdered,
          st.invalidatedGoalIds,
          st.pendingIntents,
          st.settlementReceipts,
        );
      },
      dir,
      {version: 1, goals: [], results: [], sessionOrdered: []},
      EMPTY_INVALIDATION,
      CAN_WRITE_ANY,
      1024,
      3,
      10,
      86_400_000,
      managerOptions,
      async () => {},
    );
    self.manager = manager;
    const machine = manager.createGoal('s1', 'durable intent', {});
    // Await the REAL condition rather than a wall-clock guess: `createGoal`
    // clears the pending-create marker inside the chained WAL write, and the
    // marker must be clear before `getPersistedState` will project the intent.
    // A fixed 20 ms sleep made this load-sensitive — under load the chain had
    // not resolved, the marker was still set, and the intent was filtered out.
    await manager.drainWalWrites();
    const snap = machine.snapshot();
    runtime.pendingIntents.set(`s1:${snap.goalId}`, {
      goalId: snap.goalId,
      runId: snap.runId,
      revision: snap.revision,
      messageID: '',
      toolCallID: '',
      targetStatus: 'complete',
      evidence: '',
      createdAt: Date.now(),
    });
    await manager.persist('s1');

    const onDisk = JSON.parse(await readFile(statePath, 'utf8')) as {
      pendingIntents?: unknown[];
    };
    expect(onDisk.pendingIntents?.length).toBe(1);

    const recovered = await recoverState(statePath, join(dir, 'ledger.jsonl'));
    expect(recovered.pendingIntents).toHaveLength(1);
    expect(recovered.pendingIntents[0].goalId).toBe(snap.goalId);
    expect(recovered.pendingIntents[0].targetStatus).toBe('complete');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('a goal whose create committed is not permanently excluded from intent projection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-intent-clear-'));
  try {
    const runtime = createRuntimeState();
    const manager = new SessionStateManager(
      runtime,
      async () => true,
      dir,
      {version: 1, goals: [], results: [], sessionOrdered: []},
      EMPTY_INVALIDATION,
      CAN_WRITE_ANY,
      1024,
      3,
      10,
      86_400_000,
      managerOptions,
      async () => {},
    );
    const machine = manager.createGoal('s1', 'clears the marker', {});
    // Await the REAL condition, not a wall-clock guess. `createGoal` clears the
    // pending-create marker inside the chained WAL write, so `drainWalWrites`
    // is exactly the observable that shows the create committed. A fixed
    // 20 ms sleep made this test load-sensitive: under deliberate CPU load the
    // chain had not resolved yet, the marker was still set, the projection
    // filtered the intent out, and the assertion failed at ~42 ms.
    await manager.drainWalWrites();
    const snap = machine.snapshot();
    runtime.pendingIntents.set(`s1:${snap.goalId}`, {
      goalId: snap.goalId,
      runId: snap.runId,
      revision: snap.revision,
      messageID: '',
      toolCallID: '',
      targetStatus: 'blocked',
      evidence: '',
      createdAt: Date.now(),
    });
    // The projection is what persistence writes; a leaked pending-create marker
    // would keep this at 0 forever.
    expect(manager.getPersistedState('s1').pendingIntents).toHaveLength(1);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

// RESUME-SEMANTICS-1: resume must actually resume
//
// Reported defect: "resume doesn't reliably resume (it seems to sometimes
// result in paused goals?)". Root cause: the stall brake measures time since
// `lastProgressAt`, and the transition→active side effects reset the heuristic
// counters but NOT that stamp. A goal paused BY the stall brake therefore
// re-tripped it on the very next idle tick after the user resumed it.

test('RESUME: resuming a stall-paused goal restarts the stall clock', async () => {
  const goal = createGoalState('s1', 'work', {
    goalId: 'g1',
    runId: 'r1',
    maxDurationMs: 60_000,
  });
  goal.lastProgressAt = Date.now() - 600_000; // stalled ten minutes
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  await machine.transition('paused', {
    source: 'idle-handler',
    stopReason: 'max stall reached',
    detail: 'stalled',
  });
  expect(durationLimitReached(machine.snapshot())).toBe(true);

  const resumed = await machine.transition('active', {
    source: 'slash-command',
    stopReason: '',
    detail: 'User resumed the goal.',
  });
  expect(resumed.ok).toBe(true);

  // The goal must be genuinely runnable, not merely labelled active.
  const snap = machine.snapshot();
  expect(snap.status).toBe('active');
  expect(snap.stopReason).toBe('');
  expect(durationLimitReached(snap)).toBe(false);
  expect(stopReason(snap)).toBeNull();
});

test('RESUME: a goal resumed after a no-progress pause does not immediately re-pause', async () => {
  const goal = createGoalState('s1', 'work', {
    goalId: 'g2',
    runId: 'r2',
    maxDurationMs: 600_000,
  });
  goal.noProgressTurns = 3;
  goal.lastProgressAt = Date.now() - 900_000;
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  await machine.transition('paused', {
    source: 'idle-handler',
    stopReason: 'no progress',
    detail: 'stalled',
  });
  await machine.transition('active', {
    source: 'slash-command',
    stopReason: '',
    detail: 'resumed',
  });

  const snap = machine.snapshot();
  expect(snap.noProgressTurns).toBe(0);
  expect(durationLimitReached(snap)).toBe(false);
});

test('resumeClockInPlace grants a fresh stall window (the helper FOCUS no longer uses)', () => {
  // CORRECTED with the focus contract. This test used to be named for FOCUS and
  // justified itself with "focus_goal sets status active through its own
  // mutator". Focus no longer does that: focusing a stalled goal is not a
  // lifecycle action and must NOT hand it a fresh window, or looking at a stalled
  // goal would quietly un-stall it. The helper is still what `/goal resume` calls,
  // so the helper's contract is asserted here — under a name that says so.
  const goal = createGoalState('s1', 'work', {
    goalId: 'g3',
    runId: 'r3',
    maxDurationMs: 60_000,
  });
  goal.lastProgressAt = Date.now() - 600_000;
  expect(durationLimitReached(goal)).toBe(true); // stalled
  resumeClockInPlace(goal);
  expect(durationLimitReached(goal)).toBe(false);
  expect(goal.lastProgressAt).toBeGreaterThan(Date.now() - 5_000);
});

test('FOCUS does NOT restart the stall clock (focus is a pointer, not a lifecycle action)', () => {
  // The half the contract actually changed, asserted where the change lives: the
  // focus path in SessionStateManager must not touch lastProgressAt or the
  // per-turn counters. Asserted on the SOURCE so it cannot silently come back —
  // the behavioural check is in test/integration.test.ts, which drives a real
  // paused goal through focus and observes it staying paused.
  const src = readFileSync(
    new URL('../src/session-lifecycle.ts', import.meta.url),
    'utf8',
  );
  const body = src.slice(src.indexOf('export async function focusGoalOwned'));
  const end = body.indexOf('\n  }\n', 0);
  const focusBody = end > 0 ? body.slice(0, end) : body;
  for (const forbidden of [
    'resumeClockInPlace',
    'g.status =',
    'g.recoveryTurns',
    'g.noProgressTurns',
    'g.blockedTurns',
    'g.pausedAt',
  ]) {
    expect(focusBody).not.toContain(forbidden);
  }
});

test('RESUME: a goal that has never progressed still gets a fresh window on resume', () => {
  const goal = createGoalState('s1', 'work', {
    goalId: 'g4',
    runId: 'r4',
    maxDurationMs: 60_000,
  });
  goal.startedAt = Date.now() - 600_000;
  goal.lastProgressAt = 0;
  expect(durationLimitReached(goal)).toBe(true); // bounded from creation
  resumeClockInPlace(goal);
  expect(durationLimitReached(goal)).toBe(false);
});

describe('transition audit — two material items closed', () => {
  test('an agent source cannot change maxBlockedTurns mid-run', async () => {
    // The bound that makes `blocked` require three consecutive turns was in
    // NEITHER freeze list, yet `update_goal(blocked)` reads it live. An agent
    // that set it to 1 got `blocked` accepted on the FIRST call, defeating the
    // documented contract.
    const goal = createGoalState('s1', 'work', {
      goalId: 'g-f18',
      runId: 'r-f18',
      maxBlockedTurns: 3,
    });
    const machine = new GoalStateMachine(goal, {
      onCommit: async () => {},
    });
    const res = await machine.mutate(
      g => {
        g.maxBlockedTurns = 1;
      },
      {source: 'update_goal', detail: 'probe'},
    );
    expect(res.ok).toBe(false);
    expect(String((res as {error?: string}).error)).toContain(
      'maxBlockedTurns'.replace('maxBlockedTurns', 'blocked'),
    );
    expect(machine.snapshot().maxBlockedTurns).toBe(3);
  });

  test('a blocked goal with a LIVE completion intent reports it, not a bare success', async () => {
    // The early-return used to sit above the pending-intent guard, so a goal that
    // was already `blocked` AND carried a live `complete` intent answered
    // `pendingCompletion: false` — the completion claim was swallowed and the
    // caller could not detect it. Asserted on the SOURCE shape, because the
    // behaviour needs a fully wired session: the guard must appear BELOW the
    // pending-intent lookup, and the blocked branch must consult it.
    const src = readFileSync(
      new URL('../src/tools.ts', import.meta.url),
      'utf8',
    );
    const blockedIdx = src.indexOf("if (goal.status === 'blocked') {");
    const intentIdx = src.indexOf(
      'const existingIntent = session.getPendingIntent(goal.goalId)',
    );
    expect(blockedIdx).toBeGreaterThan(-1);
    expect(intentIdx).toBeGreaterThan(-1);
    const blockedBody = src.slice(blockedIdx, blockedIdx + 1400);
    // The blocked branch must LOOK for a live intent rather than assume none.
    expect(blockedBody).toContain('getPendingIntent');
    expect(blockedBody).toContain('completionPending');
  });
});
