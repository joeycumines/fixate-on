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
  MAX_BACKGROUND_WAIT_MS,
  nextDeferralOnBlockedIdle,
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

describe('bounded escalation with mixed goal statuses', () => {
  function mixedSession(
    active: GoalStateMachine,
    paused: GoalStateMachine,
    blocked: GoalStateMachine,
  ): SessionContext {
    const session = makeSession(active);
    session.listMachines = () => [active, paused, blocked];
    session.listActiveGoals = () => [
      active.snapshot(),
      paused.snapshot(),
      blocked.snapshot(),
    ];
    return session;
  }

  test('expiry transitions only active/finalizing goals and still announces once', async () => {
    const activeGoal = makeGoal();
    activeGoal.goalId = 'g-active';
    const pausedGoal = {
      ...makeGoal(),
      goalId: 'g-paused',
      status: 'paused' as const,
    };
    const blockedGoal = {
      ...makeGoal(),
      goalId: 'g-blocked',
      status: 'blocked' as const,
    };
    const active = new GoalStateMachine(activeGoal, {onCommit: async () => {}});
    const paused = new GoalStateMachine(pausedGoal, {onCommit: async () => {}});
    const blocked = new GoalStateMachine(blockedGoal, {
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
    let announces = 0;
    const deps = makeDeps(mixedSession(active, paused, blocked), runtime);
    deps.announceGoalDecision = async () => {
      announces += 1;
    };
    const hooks = createHooks({
      ...deps,
      idlePoller: true,
      idlePollerIntervalMs: 20,
      idleQuietMs: 30,
      idleGraceMs: 0,
    });
    try {
      await sleep(200);
      // Only the active goal may transition to paused; paused->paused and
      // blocked->paused are not in TRANSITION_TABLE and must be skipped.
      expect(active.snapshot().status).toBe('paused');
      expect(active.snapshot().stopReason).toBe(
        'background completion unreported',
      );
      expect(paused.snapshot().status).toBe('paused');
      expect(paused.snapshot().stopReason).not.toBe(
        'background completion unreported',
      );
      expect(blocked.snapshot().status).toBe('blocked');
      // Every non-terminal goal still receives the receipt notice (notices
      // land in pendingNotices and flush into history on the next commit).
      for (const m of [active, paused, blocked]) {
        const snap = m.snapshot();
        const pending = snap.pendingNotices ?? [];
        const inHistory = snap.history.some(
          h =>
            h.type === 'notice' &&
            h.detail.includes('Background job completion was not reported'),
        );
        const inPending = pending.some(n =>
          n.message.includes('Background job completion was not reported'),
        );
        expect(inHistory || inPending).toBe(true);
      }
      expect(announces).toBe(1);
      expect(runtime.backgroundDeferrals!.has('s1')).toBe(false);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('expiry is skipped when canDriveSession fences the session', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const runtime = createRuntimeState();
    runtime.canDriveSession = () => false;
    const veryOld = Date.now() - 16 * 60_000;
    runtime.backgroundBlockedUntil.set('s1', veryOld);
    runtime.backgroundDeferrals!.set('s1', {
      jobKeys: ['subagent:child-1'],
      since: veryOld,
      nextRecheckAt: veryOld,
      extensions: 20,
    });
    let announces = 0;
    const deps = makeDeps(makeSession(machine), runtime);
    deps.announceGoalDecision = async () => {
      announces += 1;
    };
    const hooks = createHooks({
      ...deps,
      idlePoller: true,
      idlePollerIntervalMs: 20,
      idleQuietMs: 30,
      idleGraceMs: 0,
    });
    try {
      await sleep(200);
      expect(machine.snapshot().status).toBe('active');
      expect(announces).toBe(0);
      expect(runtime.backgroundDeferrals!.has('s1')).toBe(true);
    } finally {
      await hooks.dispose?.();
    }
  });
});

describe('nextDeferralOnBlockedIdle (clock preservation)', () => {
  test('overlapping job keys preserve since/extensions and only move the recheck', () => {
    const now = 1_000_000;
    const existing = {
      jobKeys: ['subagent:c1'],
      since: 500_000,
      nextRecheckAt: 900_000,
      extensions: 4,
    };
    const next = nextDeferralOnBlockedIdle({
      jobKeys: ['subagent:c1', 'image:img-2'],
      existing,
      now,
    });
    expect(next.since).toBe(500_000);
    expect(next.extensions).toBe(4);
    expect(next.nextRecheckAt).toBe(now + 30_000);
    expect(next.jobKeys).toEqual(['subagent:c1', 'image:img-2']);
  });

  test('a disjoint job set cannot restart a live escalation clock', () => {
    const now = 1_000_000;
    const existing = {
      jobKeys: ['subagent:c1'],
      since: 500_000,
      nextRecheckAt: 900_000,
      extensions: 4,
    };
    const next = nextDeferralOnBlockedIdle({
      jobKeys: ['image:img-9'],
      existing,
      now,
    });
    expect(next.since).toBe(500_000);
    expect(next.extensions).toBe(4);
    expect(next.jobKeys).toEqual(['image:img-9']);
    expect(next.nextRecheckAt).toBe(
      Math.min(now + 30_000, 500_000 + MAX_BACKGROUND_WAIT_MS),
    );
  });

  test('no existing deferral starts fresh', () => {
    const now = 1_000_000;
    const next = nextDeferralOnBlockedIdle({
      jobKeys: ['subagent:c1'],
      existing: undefined,
      now,
    });
    expect(next.since).toBe(now);
    expect(next.extensions).toBe(0);
    expect(next.nextRecheckAt).toBe(now + 30_000);
  });
});

describe('execution/step start does not clear a background deferral', () => {
  test('a step.started event between blocked idles keeps the deferral authoritative', async () => {
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
      // A control-only event (compaction / execution start) arrives while the
      // deferral is outstanding: it must NOT clear the deferral maps.
      await hooks.event!({
        type: 'session.execution.started',
        sessionID: 's1',
        id: 'ev-exec-1',
      });
      expect(runtime.backgroundDeferrals!.has('s1')).toBe(true);
      expect(runtime.backgroundBlockedUntil.has('s1')).toBe(true);
      await sleep(150);
      // The poller extended the deferral rather than driving a continuation.
      expect(machine.snapshot().status).toBe('active');
      expect((runtime.backgroundBlockedUntil.get('s1') ?? 0) > Date.now()).toBe(
        true,
      );
    } finally {
      await hooks.dispose?.();
    }
  });
});
