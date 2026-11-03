// compaction-loop-brake.test.ts — tests for the compaction-loop brake
// (hooks.ts). The brake pauses a goal whose session keeps compacting without
// settling, instead of driving continuations into a session the host cannot
// make progress on.
//
// Upstream context: opencode's auto-compaction can be a fixed point that never
// shrinks the context (anomalyco/opencode#52697), an inflated usage report can
// re-trigger compaction every step (#50474), and a permanently-failing
// compaction leaves the session unrecoverable (#52463). In all three, a
// continuation the plugin sends into the session only spends tokens against a
// session with no usable exit. The brake is the plugin's mechanical protection.

import {expect, test} from 'bun:test';
import {
  COMPACTION_LOOP_STOP_REASON,
  COMPACTION_LOOP_THRESHOLD,
  COMPACTION_LOOP_WINDOW_MS,
  createHooks,
  type HookDeps,
  inCompactionLoop,
  recordCompactionTimestamp,
  type RuntimeState,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {createRuntimeState} from '../src/session-state-manager.ts';
import type {GoalState} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';

// Helpers

function makeUsage(partial: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    input: 1000,
    output: 500,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
    ...partial,
  };
}

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  const goal = createGoalState('session-1', 'Build the feature', {
    goalId: 'goal-1',
    runId: 'run-1',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {...goal, usage: makeUsage(), ...overrides};
}

function makeSessionContext(
  opts: {machine?: GoalStateMachine | null} = {},
): SessionContext {
  const machine = opts.machine ?? null;
  const activeGoals = machine ? [machine.snapshot()] : [];
  return {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => activeGoals,
    listArchivedResults: () => [],
    createGoal: (_o: string) =>
      new GoalStateMachine(makeGoal(), {
        onCommit: async () => {},
      }),
    replaceGoals: async (_o: string) =>
      new GoalStateMachine(makeGoal(), {
        onCommit: async () => {},
      }),
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    setPendingIntent: () => {},
    getPendingIntent: () => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
}

function makeMockSessionApi(
  opts: {messages?: unknown[]} = {},
): SessionApi & {promptsSent: string[]} {
  const promptsSent: string[] = [];
  return {
    messages: async () => opts.messages ?? [],
    promptAsync: async (_sessionID: string, input: {parts: unknown[]}) => {
      const text = (input.parts[0] as {text?: string})?.text ?? '';
      promptsSent.push(text);
      return {};
    },
    promptsSent,
  };
}

function makeDeps(
  opts: {
    session?: SessionContext;
    sessionApi?: SessionApi & {promptsSent: string[]};
    runtime?: RuntimeState;
  } = {},
): HookDeps & {mockSessionApi: SessionApi & {promptsSent: string[]}} {
  const mockSessionApi = opts.sessionApi ?? makeMockSessionApi();
  const session = opts.session ?? makeSessionContext();
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi: mockSessionApi,
    logError: async () => {},
    runtime: opts.runtime,
    mockSessionApi,
  };
}

// Pure helpers

test('recordCompactionTimestamp is a no-op for empty sessionID or invalid time', () => {
  const timestamps = new Map<string, number[]>();
  recordCompactionTimestamp(timestamps, '', 1000);
  recordCompactionTimestamp(timestamps, 'session-1', 0);
  recordCompactionTimestamp(timestamps, 'session-1', -1);
  recordCompactionTimestamp(timestamps, 'session-1', Number.NaN);
  expect(timestamps.size).toBe(0);
});

test('recordCompactionTimestamp appends entries in order', () => {
  const timestamps = new Map<string, number[]>();
  recordCompactionTimestamp(timestamps, 'session-1', 1000);
  recordCompactionTimestamp(timestamps, 'session-1', 2000);
  recordCompactionTimestamp(timestamps, 'session-1', 3000);
  expect(timestamps.get('session-1')).toEqual([1000, 2000, 3000]);
});

test('recordCompactionTimestamp prunes entries outside the window on write', () => {
  const timestamps = new Map<string, number[]>();
  const now = 1_000_000;
  // An entry outside the window. The prune cutoff on a write at `t` is
  // `t - WINDOW`, so an entry written later at `now - 1000` prunes anything
  // older than `now - 1000 - WINDOW`.
  recordCompactionTimestamp(
    timestamps,
    'session-1',
    now - COMPACTION_LOOP_WINDOW_MS - 2000,
  );
  // An entry inside the window.
  recordCompactionTimestamp(timestamps, 'session-1', now - 1000);
  // After the second write, the first (outside-window) entry is pruned.
  const entries = timestamps.get('session-1')!;
  expect(entries.length).toBe(1);
  expect(entries[0]).toBe(now - 1000);
});

test('inCompactionLoop returns false for unknown session', () => {
  const timestamps = new Map<string, number[]>();
  expect(inCompactionLoop(timestamps, 'session-1', Date.now())).toBe(false);
});

test('inCompactionLoop returns false below threshold', () => {
  const timestamps = new Map<string, number[]>();
  const now = 1_000_000;
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD - 1; i++) {
    recordCompactionTimestamp(timestamps, 'session-1', now - i * 1000);
  }
  expect(inCompactionLoop(timestamps, 'session-1', now)).toBe(false);
});

test('inCompactionLoop returns true at threshold', () => {
  const timestamps = new Map<string, number[]>();
  const now = 1_000_000;
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD; i++) {
    recordCompactionTimestamp(timestamps, 'session-1', now - i * 1000);
  }
  expect(inCompactionLoop(timestamps, 'session-1', now)).toBe(true);
});

test('inCompactionLoop ignores entries outside the window', () => {
  const timestamps = new Map<string, number[]>();
  const now = 1_000_000;
  // Three entries inside the window, plus many outside.
  for (let i = 0; i < 3; i++) {
    recordCompactionTimestamp(timestamps, 'session-1', now - i * 1000);
  }
  for (let i = 0; i < 10; i++) {
    recordCompactionTimestamp(
      timestamps,
      'session-1',
      now - COMPACTION_LOOP_WINDOW_MS - 1000 - i * 100,
    );
  }
  expect(inCompactionLoop(timestamps, 'session-1', now)).toBe(false);
});

// Integration: event recording

test('session.compacted records a compaction timestamp', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps = makeDeps({session, runtime});
  const hooks = createHooks(deps);

  await hooks.event!({type: 'session.compacted', sessionID: 'session-1'});

  const entries = runtime.compactionTimestamps.get('session-1');
  expect(entries).toBeDefined();
  expect(entries!.length).toBe(1);
});

test('session.compaction.ended records a compaction timestamp (v2)', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps = makeDeps({session, runtime});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.compaction.ended',
    sessionID: 'session-1',
  });

  const entries = runtime.compactionTimestamps.get('session-1');
  expect(entries).toBeDefined();
  expect(entries!.length).toBe(1);
});

test('session.compaction.failed records a compaction timestamp (v2)', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps = makeDeps({session, runtime});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.compaction.failed',
    sessionID: 'session-1',
  });

  const entries = runtime.compactionTimestamps.get('session-1');
  expect(entries).toBeDefined();
  expect(entries!.length).toBe(1);
});

// Integration: brake fires

test('brake pauses goal after threshold compactions inside the window', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 500, reasoning: 0},
        parts: [
          {type: 'text', text: 'Working extensively on the implementation'},
        ],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi, runtime});
  const hooks = createHooks(deps);

  // Record threshold compactions inside the window.
  const now = Date.now();
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD; i++) {
    recordCompactionTimestamp(
      runtime.compactionTimestamps,
      'session-1',
      now - i * 1000,
    );
  }

  // An idle event would normally drive a continuation; the brake fires instead.
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-brake-1',
  });

  const snap = machine.snapshot();
  expect(snap.status).toBe('paused');
  expect(snap.stopReason).toBe(COMPACTION_LOOP_STOP_REASON);
  // No continuation prompt was sent.
  expect(mockApi.promptsSent.length).toBe(0);
});

test('brake does not fire below threshold', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 500, reasoning: 0},
        parts: [
          {type: 'text', text: 'Working extensively on the implementation'},
        ],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi, runtime});
  const hooks = createHooks(deps);

  // Record one fewer than threshold.
  const now = Date.now();
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD - 1; i++) {
    recordCompactionTimestamp(
      runtime.compactionTimestamps,
      'session-1',
      now - i * 1000,
    );
  }

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-nobrake-1',
  });

  const snap = machine.snapshot();
  expect(snap.status).toBe('active');
  // A continuation prompt was sent.
  expect(mockApi.promptsSent.length).toBeGreaterThan(0);
});

test('brake does not fire when compactions are spread outside the window', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 500, reasoning: 0},
        parts: [
          {type: 'text', text: 'Working extensively on the implementation'},
        ],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi, runtime});
  const hooks = createHooks(deps);

  // Record threshold compactions, but spread them so only threshold-1 are
  // inside the window at idle time.
  const now = Date.now();
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD - 1; i++) {
    recordCompactionTimestamp(
      runtime.compactionTimestamps,
      'session-1',
      now - i * 1000,
    );
  }
  // One more, but outside the window.
  recordCompactionTimestamp(
    runtime.compactionTimestamps,
    'session-1',
    now - COMPACTION_LOOP_WINDOW_MS - 10_000,
  );

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-nobrake-2',
  });

  const snap = machine.snapshot();
  expect(snap.status).toBe('active');
  expect(mockApi.promptsSent.length).toBeGreaterThan(0);
});

test('brake clears the window after pausing so a resume gets a fresh budget', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 500, reasoning: 0},
        parts: [
          {type: 'text', text: 'Working extensively on the implementation'},
        ],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi, runtime});
  const hooks = createHooks(deps);

  const now = Date.now();
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD; i++) {
    recordCompactionTimestamp(
      runtime.compactionTimestamps,
      'session-1',
      now - i * 1000,
    );
  }

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-brake-clear-1',
  });

  // The brake fired and cleared the window.
  expect(machine.snapshot().status).toBe('paused');
  expect(runtime.compactionTimestamps.has('session-1')).toBe(false);
});

test('brake pauses all runnable goals in a multi-goal session', async () => {
  const machine1 = new GoalStateMachine(makeGoal({goalId: 'goal-1'}), {
    onCommit: async () => {},
  });
  const machine2 = new GoalStateMachine(
    makeGoal({goalId: 'goal-2', condition: 'Second goal'}),
    {
      onCommit: async () => {},
    },
  );
  const session: SessionContext = {
    sessionID: 'session-1',
    getMachine: () => machine1,
    listActiveGoals: () => [machine1.snapshot(), machine2.snapshot()],
    listArchivedResults: () => [],
    createGoal: (_o: string) =>
      new GoalStateMachine(makeGoal(), {
        onCommit: async () => {},
      }),
    replaceGoals: async (_o: string) =>
      new GoalStateMachine(makeGoal(), {
        onCommit: async () => {},
      }),
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    setPendingIntent: () => {},
    getPendingIntent: () => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
    // Multi-goal: listMachines returns both.
    listMachines: () => [machine1, machine2],
  };
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 500, reasoning: 0},
        parts: [{type: 'text', text: 'Working extensively'}],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi, runtime});
  const hooks = createHooks(deps);

  const now = Date.now();
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD; i++) {
    recordCompactionTimestamp(
      runtime.compactionTimestamps,
      'session-1',
      now - i * 1000,
    );
  }

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-multi-1',
  });

  expect(machine1.snapshot().status).toBe('paused');
  expect(machine1.snapshot().stopReason).toBe(COMPACTION_LOOP_STOP_REASON);
  expect(machine2.snapshot().status).toBe('paused');
  expect(machine2.snapshot().stopReason).toBe(COMPACTION_LOOP_STOP_REASON);
  expect(mockApi.promptsSent.length).toBe(0);
});

test('brake does not pause goals that are already paused', async () => {
  const machine = new GoalStateMachine(
    makeGoal({
      status: 'paused',
      stopReason: 'explicit pause',
    }),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps = makeDeps({session, runtime});
  const hooks = createHooks(deps);

  const now = Date.now();
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD; i++) {
    recordCompactionTimestamp(
      runtime.compactionTimestamps,
      'session-1',
      now - i * 1000,
    );
  }

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-paused-1',
  });

  // Already paused; the brake should not change the stopReason.
  expect(machine.snapshot().status).toBe('paused');
  expect(machine.snapshot().stopReason).toBe('explicit pause');
});

test('brake announces via announceGoalDecision when configured', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 500, reasoning: 0},
        parts: [{type: 'text', text: 'Working extensively'}],
      },
    ],
  });
  const announcements: string[] = [];
  const deps = {
    ...makeDeps({session, sessionApi: mockApi, runtime}),
    announceGoalDecision: async (_sessionID: string, text: string) => {
      announcements.push(text);
    },
  };
  const hooks = createHooks(deps);

  const now = Date.now();
  for (let i = 0; i < COMPACTION_LOOP_THRESHOLD; i++) {
    recordCompactionTimestamp(
      runtime.compactionTimestamps,
      'session-1',
      now - i * 1000,
    );
  }

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-announce-1',
  });

  expect(announcements.length).toBe(1);
  expect(announcements[0]).toContain('compaction loop');
});
