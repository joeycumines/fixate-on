// review-remediation-idle.test.ts — regressions for the idle/no-tool/queued
// findings in scratch/review-05..08.md. Each test reproduces a real defect
// before the corresponding source fix and must fail on the unfixed commit.
import {describe, expect, test} from 'bun:test';
import {
  createHooks,
  type HookDeps,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {createRuntimeState} from '../src/session-state-manager.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';

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

function makeActiveGoal(noToolTurns = 0): ReturnType<typeof createGoalState> {
  return {
    ...createGoalState('session-1', 'Build the feature', {
      goalId: 'goal-1',
      runId: 'run-1',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    }),
    usage: makeUsage(),
    status: 'active' as const,
    turnCount: 1,
    noToolCallTurns: noToolTurns,
  };
}

function makeSessionContext(machine: GoalStateMachine): SessionContext {
  return {
    sessionID: machine.state.sessionID,
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

function makeMockSessionApi(messages: unknown[]): SessionApi {
  return {
    messages: async () => messages,
    promptAsync: async () => ({}),
  } as SessionApi;
}

function makeDeps(
  session: SessionContext,
  sessionApi: SessionApi,
  announcements: string[] = [],
): HookDeps {
  const runtime = createRuntimeState();
  runtime.threadToolsRegistered = true;
  runtime.promptInFlightSessions = new Set<string>();
  runtime.liveSessions.add(session.sessionID);
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi,
    logError: async () => {},
    completionGate: null,
    announceGoalDecision: async (_sessionID: string, text: string) => {
      announcements.push(text);
    },
    runtime,
  } as unknown as HookDeps;
}

async function driveIdle(hooks: ReturnType<typeof createHooks>, id: string) {
  await hooks.event!({type: 'session.idle', sessionID: 'session-1', id});
}

function assistantMessage(id: string, text: string, tool = false): unknown {
  return {
    id,
    role: 'assistant',
    finish: tool ? 'tool-calls' : 'stop',
    parts: tool
      ? [
          {type: 'tool', text: 'call'},
          {type: 'text', text},
        ]
      : [{type: 'text', text}],
  };
}

describe('review 05-08 idle regressions', () => {
  test('a duplicate idle after a productive turn does not count it as tool-free', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'u0', role: 'user', parts: [{type: 'text', text: 'set goal'}]},
      assistantMessage('a1', 'using tools', true),
      assistantMessage('a2', 'done with tools'),
      {
        id: 's1',
        role: 'user',
        synthetic: true,
        parts: [{type: 'text', text: 'continue'}],
      },
    ]);
    const hooks = createHooks(makeDeps(makeSessionContext(machine), api));

    await driveIdle(hooks, 'idle-1');
    expect(machine.snapshot().noToolCallTurns).toBe(0);
    await driveIdle(hooks, 'idle-2');
    expect(machine.snapshot().noToolCallTurns).toBe(0);
    expect(machine.snapshot().status).toBe('active');
  });

  test('a queued user known only through runtime delivery does not cut the tool window', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'u0', role: 'user', parts: [{type: 'text', text: 'set goal'}]},
      assistantMessage('a1', 'using tools', true),
      {
        id: 'q1',
        role: 'user',
        parts: [{type: 'text', text: 'queued note'}],
      },
      assistantMessage('a2', 'prose summary'),
    ]);
    const deps = makeDeps(makeSessionContext(machine), api);
    deps.runtime!.queuedInputMessageIDs.set('session-1', new Set(['q1']));
    const hooks = createHooks(deps);

    await driveIdle(hooks, 'idle-1');
    expect(machine.snapshot().noToolCallTurns).toBe(0);
    expect(machine.snapshot().status).toBe('active');
  });

  test('a queued message already answered before idle still produces a notice exactly once', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {
        id: 'q1',
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'queued but answered'}],
      },
      assistantMessage('a1', 'answer one'),
      assistantMessage('a2', 'answer two'),
    ]);
    const hooks = createHooks(makeDeps(makeSessionContext(machine), api));

    await driveIdle(hooks, 'idle-1');
    const notices = machine
      .snapshot()
      .history.filter(
        h => h.type === 'notice' && h.detail.includes('queued but answered'),
      );
    expect(notices).toHaveLength(1);
    await driveIdle(hooks, 'idle-2');
    const noticesAfter = machine
      .snapshot()
      .history.filter(
        h => h.type === 'notice' && h.detail.includes('queued but answered'),
      );
    expect(noticesAfter).toHaveLength(1);
  });
});
