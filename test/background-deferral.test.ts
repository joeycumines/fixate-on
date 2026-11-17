// review-10 residual fixes: (A) background deferral expiry must not authorize
// continuation without an authoritative clear; (B) queue→steer inbox promotion
// must synthesize steering with the retained enqueue payload.
import {describe, expect, test} from 'bun:test';
import {
  createHooks,
  type HookDeps,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {createRuntimeState} from '../src/session-runtime.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {
  blockingBackgroundJobKeys,
  shouldSuppressTrailingIdle,
} from '../src/plugin-v2-helpers.ts';

function makeGoal(): ReturnType<typeof createGoalState> {
  return {
    ...createGoalState('s1', 'Build feature', {
      goalId: 'g1',
      runId: 'r1',
      maxTokens: 200000,
    }),
    status: 'active',
    turnCount: 1,
  };
}

function makeSession(machine: GoalStateMachine): SessionContext {
  return {
    sessionID: 's1',
    getMachine: () => machine,
    listMachines: () => [machine],
    listActiveGoals: () => [machine.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => machine,
    replaceGoals: async () => machine,
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: true as const, machine}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    setPendingIntent: () => {},
    getPendingIntent: () => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
}

function makeDeps(
  session: SessionContext,
  runtime = createRuntimeState(),
): HookDeps {
  const api: SessionApi = {
    messages: async () => [
      {
        id: 'a1',
        role: 'assistant',
        parts: [{type: 'text', text: 'working'}],
        tokens: {output: 200},
      },
    ],
    promptAsync: async () => ({}),
  } as SessionApi;
  runtime.threadToolsRegistered = true;
  runtime.liveSessions.add('s1');
  runtime.sessionGoals.set('s1', [session.getMachine()!]);
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi: api,
    logError: async () => {},
    completionGate: null,
    announceGoalDecision: async () => {},
    runtime,
  } as unknown as HookDeps;
}

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('background job keys (authoritative identity)', () => {
  test('uses childSessionID and excludes shell/finished jobs', () => {
    expect(
      blockingBackgroundJobKeys(
        [
          {kind: 'subagent', sessionID: 's1', childSessionID: 'child-1'},
          {kind: 'shell', sessionID: 's1'},
          {kind: 'subagent', sessionID: 's1', status: 'done'},
          {kind: 'image', childSessionID: 'img-2'},
        ],
        's1',
      ),
    ).toEqual(['subagent:child-1', 'image:img-2']);
  });
});

describe('background deferral expiry', () => {
  test('an expired deferral never drives a continuation without an authoritative clear', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const runtime = createRuntimeState();
    const past = Date.now() - 60_000;
    runtime.backgroundBlockedUntil.set('s1', past);
    runtime.backgroundDeferrals!.set('s1', {
      jobKeys: ['subagent:child-1'],
      since: past,
      nextRecheckAt: past,
      extensions: 0,
    });
    const deps = makeDeps(makeSession(machine), runtime);
    const hooks = createHooks({
      ...deps,
      idlePoller: true,
      idlePollerIntervalMs: 20,
      idleQuietMs: 30,
      idleGraceMs: 0,
    });
    try {
      await sleep(200);
      // Still deferred: the poller extended the gate, never synthesized idle.
      expect(machine.snapshot().status).toBe('active');
      expect(
        (deps.runtime!.backgroundBlockedUntil.get('s1') ?? 0) > Date.now(),
      ).toBe(true);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('bounded escalation pauses with an explicit receipt instead of driving forever', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const runtime = createRuntimeState();
    const veryOld = Date.now() - 16 * 60_000;
    runtime.backgroundBlockedUntil.set('s1', veryOld);
    runtime.backgroundDeferrals!.set('s1', {
      jobKeys: ['subagent:child-1'],
      since: veryOld,
      nextRecheckAt: veryOld,
      extensions: 20,
    });
    const deps = makeDeps(makeSession(machine), runtime);
    const hooks = createHooks({
      ...deps,
      idlePoller: true,
      idlePollerIntervalMs: 20,
      idleQuietMs: 30,
      idleGraceMs: 0,
    });
    try {
      await sleep(200);
      expect(machine.snapshot().status).toBe('paused');
      expect(machine.snapshot().stopReason).toBe(
        'background completion unreported',
      );
      expect(runtime.backgroundDeferrals!.has('s1')).toBe(false);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('bounded escalation pauses every active goal in a multi-goal session', async () => {
    const first = makeGoal();
    first.goalId = 'g1';
    const second = makeGoal();
    second.goalId = 'g2';
    const machineA = new GoalStateMachine(first, {onCommit: async () => {}});
    const machineB = new GoalStateMachine(second, {onCommit: async () => {}});
    const session = makeSession(machineA);
    session.listMachines = () => [machineA, machineB];
    session.listActiveGoals = () => [first, second];
    const runtime = createRuntimeState();
    const veryOld = Date.now() - 16 * 60_000;
    runtime.backgroundBlockedUntil.set('s1', veryOld);
    runtime.backgroundDeferrals!.set('s1', {
      jobKeys: ['subagent:child-1'],
      since: veryOld,
      nextRecheckAt: veryOld,
      extensions: 20,
    });
    const deps = makeDeps(session, runtime);
    const hooks = createHooks({
      ...deps,
      idlePoller: true,
      idlePollerIntervalMs: 20,
      idleQuietMs: 30,
      idleGraceMs: 0,
    });
    try {
      await sleep(200);
      expect(machineA.snapshot().status).toBe('paused');
      expect(machineB.snapshot().status).toBe('paused');
      expect(machineA.snapshot().stopReason).toBe(
        'background completion unreported',
      );
      expect(machineB.snapshot().stopReason).toBe(
        'background completion unreported',
      );
    } finally {
      await hooks.dispose?.();
    }
  });

  test('trailing idle suppression stays active while a deferral is authoritative', () => {
    const records = new Map([
      [
        's1',
        {
          turnSignature: 'id:a1',
          ts: Date.now() - 60_000,
          backgroundBlocked: true,
        },
      ],
    ]);
    const isDeferred = () => true;
    expect(
      shouldSuppressTrailingIdle(
        records,
        's1',
        'id:a1',
        Date.now(),
        isDeferred,
      ),
    ).toBe(true);
    expect(records.has('s1')).toBe(true);
  });
});

// Inbox promotion is covered by the full bridge test in
// test/plugin-v2-command-transform.test.ts and payload retention by
// test/inbox-payload-retention.test.ts.
