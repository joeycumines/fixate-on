// idle-progress-and-delivery.test.ts — regressions for the idle/delivery findings in
// scratch/review-09.md and scratch/review-10.md.
import {describe, expect, test} from 'bun:test';
import {
  createHooks,
  type HookDeps,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {createRuntimeState} from '../src/session-state-manager.ts';
import {recordSlashEchoMessage} from '../src/command-dispatch.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';

function makeGoal(): ReturnType<typeof createGoalState> {
  return {
    ...createGoalState('session-1', 'Build the feature', {
      goalId: 'goal-1',
      runId: 'run-1',
      maxTokens: 200000,
    }),
    status: 'active',
    turnCount: 1,
  };
}

function makeSession(machine: GoalStateMachine): SessionContext {
  return {
    sessionID: 'session-1',
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

function makeDeps(session: SessionContext, messages: unknown[]): HookDeps {
  const api: SessionApi = {
    messages: async () => messages,
    promptAsync: async () => ({}),
  } as SessionApi;
  const runtime = createRuntimeState();
  runtime.threadToolsRegistered = true;
  runtime.liveSessions.add('session-1');
  // Register the session's machines on the runtime so the pre-goal createdAt
  // guard reads a real machine list (runtime.sessionGoals drives the guard).
  runtime.sessionGoals.set('session-1', [session.getMachine()!]);
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

function assistant(id: string, text: string, output: number, tool = false) {
  return {
    id,
    role: 'assistant',
    finish: tool ? 'tool-calls' : 'stop',
    tokens: {output},
    parts: tool
      ? [
          {type: 'tool', text: 'call'},
          {type: 'text', text},
        ]
      : [{type: 'text', text}],
  };
}

describe('idle progress and delivery classification', () => {
  test('an unconsumed slash echo does not swallow a later identical human message', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    // The only echo suppression that survives to idle is ID-scoped: the echo
    // that chat.message consumed. A later human message with the same text has
    // a different ID and must still pause the goal.
    recordSlashEchoMessage('session-1', 'slash-echo-1');
    const hooks = createHooks(
      makeDeps(makeSession(machine), [
        assistant('a1', 'working', 200, true),
        {
          id: 'human-resume',
          role: 'user',
          parts: [{type: 'text', text: 'resume'}],
        },
      ]),
    );
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-human-resume',
    });
    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');
  });

  test('duplicate idle does not consume no-progress budget for productive work', async () => {
    const state = makeGoal();
    state.noProgressTurnsBeforePause = 1;
    const machine = new GoalStateMachine(state, {onCommit: async () => {}});
    const hooks = createHooks(
      makeDeps(makeSession(machine), [
        assistant('p1', 'using tools', 200, true),
        assistant('p2', 'short summary', 5),
        {
          id: 'cont',
          role: 'user',
          synthetic: true,
          parts: [{type: 'text', text: 'continue'}],
        },
      ]),
    );
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-1',
    });
    expect(machine.snapshot().noProgressTurns).toBe(0);
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-2',
    });
    expect(machine.snapshot().noProgressTurns).toBe(0);
    expect(machine.snapshot().status).toBe('active');
  });

  test('a delivery set created between idles is observed by the next pass', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const deps = makeDeps(makeSession(machine), [
      assistant('a1', 'working', 200),
      {
        id: 'q-late',
        role: 'user',
        parts: [{type: 'text', text: 'late queued note'}],
      },
    ]);
    const hooks = createHooks(deps);
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'host-idle-1',
    });
    deps.runtime!.queuedInputMessageIDs.set('session-1', new Set(['q-late']));
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'host-idle-2',
    });
    const notices = machine
      .snapshot()
      .history.filter(
        h => h.type === 'notice' && h.detail.includes('late queued note'),
      );
    expect(notices).toHaveLength(1);
    expect(machine.snapshot().status).toBe('active');
  });

  test('pre-goal queued input is not attributed to a newly created goal', async () => {
    const state = makeGoal();
    // The goal was created 60s ago; the queued message predates it by 30s.
    state.createdAt = Date.now() - 60_000;
    const machine = new GoalStateMachine(state, {
      onCommit: async () => {},
    });
    const deps = makeDeps(makeSession(machine), [
      {
        id: 'old-q',
        role: 'user',
        delivery: 'queue',
        time: {created: Date.now() - 90_000},
        parts: [{type: 'text', text: 'answered before goal'}],
      },
      assistant('a1', 'answer', 200),
    ]);
    const hooks = createHooks(deps);
    await hooks.event!({
      type: 'session.inbox.enqueued',
      sessionID: 'session-1',
      id: 'pre-goal-queue',
      properties: {
        inboxID: 'old-q',
        item: {
          type: 'user',
          delivery: 'queue',
          payload: {text: 'answered before goal'},
        },
      },
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-1',
    });
    const notices = machine
      .snapshot()
      .history.filter(
        h => h.type === 'notice' && h.detail.includes('answered before goal'),
      );
    expect(notices).toHaveLength(0);
  });
});
