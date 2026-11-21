// v2-input-steering.test.ts — FX-I locks: human steering must reach the
// goal loop on opencode v2, where the v1 `chat.message` hook never fires.
//
// Live evidence (drill-v2 campaign 2026-08-26): a whole-message "stop"
// submitted mid-turn produced `session.input.admitted` at submit time but ZERO
// state change — no pause transition — and the idle loop drove straight
// through it. The fix synthesizes the v1 hook from admitted events and adds an
// idle-path defense that never continues over a pending human turn.
import {describe, expect, test} from 'bun:test';
import {
  createHooks,
  type HookDeps,
  isExplicitStopMessage,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {createRuntimeState} from '../src/session-state-manager.ts';
import type {GoalState} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {
  synthesizeChatMessageFromAdmitted,
  synthesizeChatMessageFromText,
} from '../src/plugin-v2-event-leaf.ts';
import {reconcileSystemParts} from '../src/plugin-v2-helpers.ts';
import {mapV2EventToHandlers} from '../src/plugin-v2-event-bridge.ts';
import {createRecentKickoffTextTracker} from '../src/plugin-v2-command.ts';

function makeUsage(): UsageSnapshot {
  return {
    input: 1000,
    output: 500,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
}

function makeActiveGoal(sessionID = 'session-1'): GoalState {
  const goal = createGoalState(sessionID, 'Build the feature', {
    goalId: 'goal-1',
    runId: 'run-1',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {...goal, usage: makeUsage(), status: 'active', turnCount: 1};
}

function makeSessionContext(machine: GoalStateMachine): SessionContext {
  return {
    sessionID: machine.state.sessionID,
    getMachine: () => machine,
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
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
}

function makeMockSessionApi(
  messages: unknown[] = [],
): SessionApi & {promptsSent: Array<{text: string}>} {
  const promptsSent: Array<{text: string}> = [];
  return {
    messages: async () => messages,
    promptAsync: async (_sessionID: string, input: {parts: unknown[]}) => {
      promptsSent.push({text: (input.parts[0] as {text?: string})?.text ?? ''});
      return {};
    },
    promptsSent,
  } as SessionApi & {promptsSent: Array<{text: string}>};
}

function makeDeps(session: SessionContext, sessionApi: SessionApi): HookDeps {
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi,
    logError: async () => {},
    completionGate: null,
    runtime: {
      ...createRuntimeState(),
      threadToolsRegistered: true,
      promptInFlightSessions: new Set<string>(),
    },
  } as unknown as HookDeps;
}

function admittedEvent(
  sessionID: string,
  text: string,
  type: 'user' | 'synthetic' = 'user',
) {
  return {
    type: 'session.input.admitted',
    data: {
      sessionID,
      inputID: `in_${Math.random().toString(36).slice(2)}`,
      input: {type, data: {text}},
    },
  };
}

describe('v2 input synthesis: session.input.admitted drives the chat.message hook', () => {
  test("human 'stop' reaches the hook with synthetic undefined and pauses explicitly", async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const hooks = createHooks(
      makeDeps(makeSessionContext(machine), makeMockSessionApi()),
    );

    await synthesizeChatMessageFromAdmitted(
      hooks['chat.message'],
      admittedEvent('session-1', 'stop').data,
    );

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('explicit pause');
  });

  test("inbox 'stop' with steer delivery reaches the hook and pauses explicitly", async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const hooks = createHooks(
      makeDeps(makeSessionContext(machine), makeMockSessionApi()),
    );

    await synthesizeChatMessageFromText(
      hooks['chat.message'],
      'session-1',
      'stop',
      {sessionID: 'session-1', item: {delivery: 'steer'}},
    );

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('explicit pause');
  });

  test("ordinary human text pauses as re-armable 'user intervention'", async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const hooks = createHooks(
      makeDeps(makeSessionContext(machine), makeMockSessionApi()),
    );

    await synthesizeChatMessageFromAdmitted(
      hooks['chat.message'],
      admittedEvent('session-1', 'also update the docs').data,
    );

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');
  });

  test("synthetic pending input is marked so the handler's own guard skips it", async () => {
    let seen: unknown = null;
    const hook = async (_input: unknown, output: {parts: unknown[]}) => {
      seen = output.parts[0];
    };
    await synthesizeChatMessageFromAdmitted(
      hook,
      admittedEvent('s1', 'continuation prose', 'synthetic').data,
    );
    expect((seen as {synthetic?: boolean}).synthetic).toBe(true);
  });

  test('user pending input keeps parts unmarked', async () => {
    let seen: unknown = null;
    const hook = async (_input: unknown, output: {parts: unknown[]}) => {
      seen = output.parts[0];
    };
    await synthesizeChatMessageFromAdmitted(
      hook,
      admittedEvent('s1', 'hello').data,
    );
    expect((seen as {synthetic?: boolean}).synthetic).toBeUndefined();
  });

  test('no text → hook not called; missing hook → no throw; throwing hook contained by caller pattern', async () => {
    let called = 0;
    const spyHook = async () => {
      called += 1;
    };
    await synthesizeChatMessageFromAdmitted(spyHook, {
      input: {type: 'user', data: {}},
    });
    await synthesizeChatMessageFromAdmitted(spyHook, {});
    await synthesizeChatMessageFromAdmitted(
      undefined,
      admittedEvent('s1', 'stop').data,
    );
    expect(called).toBe(0);

    const boom = async (): Promise<void> => {
      throw new Error('hook exploded');
    };
    // Containment is the event loop caller's job (try/catch around each
    // admitted event); the helper itself must propagate so callers can choose.
    expect(
      synthesizeChatMessageFromAdmitted(
        boom as unknown as Parameters<
          typeof synthesizeChatMessageFromAdmitted
        >[0],
        admittedEvent('s1', 'stop').data,
      ),
    ).rejects.toThrow('hook exploded');
  });

  test('slash-command echo shape still ignored end-to-end (guard passthrough)', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const hooks = createHooks(
      makeDeps(makeSessionContext(machine), makeMockSessionApi()),
    );
    // Simulate the host replaying our just-dispatched slash args verbatim.
    await synthesizeChatMessageFromAdmitted(
      hooks['chat.message'],
      admittedEvent('session-1', '/goal status').data,
    );
    expect(machine.snapshot().status).toBe('active');
  });
});

describe('idle defense: the loop never drives over a pending human turn', () => {
  test("newest message human 'stop' → explicit pause, no continuation prompt sent", async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {id: 'm2', role: 'user', parts: [{type: 'text', text: 'stop'}]},
    ]);
    const hooks = createHooks(makeDeps(makeSessionContext(machine), api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-1',
    });

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('explicit pause');
    expect(api.promptsSent).toHaveLength(0);
  });

  test("newest message ordinary human text → 'user intervention' pause, no prompt sent", async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        parts: [{type: 'text', text: 'switch to the other module first'}],
      },
    ]);
    const hooks = createHooks(makeDeps(makeSessionContext(machine), api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-1',
    });

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');
    expect(api.promptsSent).toHaveLength(0);
  });

  test('newest message assistant (normal idle) → continuation proceeds', async () => {
    const machine = new GoalStateMachine(
      {
        ...makeActiveGoal(),
        lastAssistantText: 'earlier turn',
      },
      {
        onCommit: async () => {},
      },
    );
    const api = makeMockSessionApi([
      {id: 'm0', role: 'user', parts: [{type: 'text', text: 'go'}]},
      {
        id: 'm1',
        role: 'assistant',
        parts: [{type: 'text', text: 'made progress on the build'}],
      },
    ]);
    const hooks = createHooks(makeDeps(makeSessionContext(machine), api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-1',
    });

    expect(api.promptsSent.length).toBeGreaterThan(0);
    expect(machine.snapshot().turnCount).toBe(2);
  });
});

describe('stop classification anchor used by both steering paths', () => {
  test('whole-message stop imperatives classify; mixed sentences do not', () => {
    expect(isExplicitStopMessage('stop')).toBe(true);
    expect(isExplicitStopMessage('halt')).toBe(true);
    expect(isExplicitStopMessage('hold off')).toBe(true);
    expect(isExplicitStopMessage('please stop')).toBe(false);
    expect(isExplicitStopMessage('stop the server then fix tests')).toBe(false);
  });
});

describe('v2 system prompt parts survive goal-context injection', () => {
  test('prepended goal context keeps native cache-control parts in place', () => {
    const cachePart = {
      type: 'text',
      text: 'a',
      cache_control: {type: 'ephemeral'},
    };
    const out = reconcileSystemParts(
      [cachePart, {type: 'text', text: 'b'}],
      ['<goal_context>injected</goal_context>', 'a', 'b'],
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      type: 'text',
      text: '<goal_context>injected</goal_context>',
    });
    expect(out[1]).toBe(cachePart);
    expect(out[2]).toEqual({type: 'text', text: 'b'});
  });

  test('non-text native parts keep their original positions', () => {
    const cachePart = {
      type: 'text',
      text: 'a',
      cache_control: {type: 'ephemeral'},
    };
    const effortPart = {type: 'effort', effort: 'high'};
    const out = reconcileSystemParts(
      [cachePart, effortPart, {type: 'text', text: 'b'}],
      ['<goal_context>injected</goal_context>', 'a', '', 'b'],
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({
      type: 'text',
      text: '<goal_context>injected</goal_context>',
    });
    expect(out[1]).toBe(cachePart);
    expect(out[2]).toBe(effortPart);
    expect(out[3]).toEqual({type: 'text', text: 'b'});
  });

  test('rewriting a native text part keeps its host metadata', () => {
    const cachePart = {
      type: 'text',
      text: 'a',
      cache_control: {type: 'ephemeral'},
    };
    const out = reconcileSystemParts(
      [cachePart, {type: 'text', text: 'b'}],
      ['a-rewritten', 'b'],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      type: 'text',
      text: 'a-rewritten',
      cache_control: {type: 'ephemeral'},
    });
    expect(out[1]).toEqual({type: 'text', text: 'b'});
  });
});

describe('v2 mode-implied input events drive steering', () => {
  function bridgeDeps(hooks: ReturnType<typeof createHooks>) {
    return {
      ctx: {},
      hooks,
      idleStateBySession: new Map(),
      lastObservedTurnBySession: new Map(),
      recentKickoffTexts: createRecentKickoffTextTracker(),
      locationDirectory: undefined,
      isStopped: () => false,
      stopSignal: new Promise<void>(() => {}),
    };
  }

  test('session.input.steered pauses an active goal for a human stop', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const depsForHooks = makeDeps(
      makeSessionContext(machine),
      makeMockSessionApi(),
    );
    const hooks = createHooks(depsForHooks) as ReturnType<
      typeof createHooks
    > & {
      runtime?: typeof depsForHooks.runtime;
    };
    hooks.runtime = depsForHooks.runtime;
    await mapV2EventToHandlers(
      {
        type: 'session.input.steered',
        data: {
          sessionID: 'session-1',
          inputID: 'steer-1',
          item: {type: 'user', payload: {text: 'stop'}},
        },
      },
      bridgeDeps(hooks),
    );
    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('explicit pause');
  });

  test('a queued payload promoted to steered reaches the hook by ID', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const depsForHooks = makeDeps(
      makeSessionContext(machine),
      makeMockSessionApi(),
    );
    const hooks = createHooks(depsForHooks) as ReturnType<
      typeof createHooks
    > & {
      runtime?: typeof depsForHooks.runtime;
    };
    hooks.runtime = depsForHooks.runtime;
    const deps = bridgeDeps(hooks);
    await mapV2EventToHandlers(
      {
        type: 'session.input.queued',
        data: {
          sessionID: 'session-1',
          inputID: 'promote-1',
          item: {type: 'user', payload: {text: 'stop'}},
        },
      },
      deps,
    );
    expect(machine.snapshot().status).toBe('active');
    await mapV2EventToHandlers(
      {
        type: 'session.input.steered',
        data: {sessionID: 'session-1', inputID: 'promote-1'},
      },
      deps,
    );
    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('explicit pause');
  });
});
