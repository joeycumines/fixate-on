import {createHooks} from '../src/hooks.ts';
import type {HookDeps, SessionContext} from '../src/hooks-types.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {processIdleEvent} from '../src/hooks-idle.ts';
import {createRuntimeState} from '../src/session-runtime.ts';
import {
  createGoalState,
  GoalStateMachine,
  type GoalState,
} from '../src/state-machine.ts';

/** Real hooks/state machine with an in-memory host and no background timers. */
export function createIdleStateFixture(seed: Partial<GoalState> = {}) {
  const machine = new GoalStateMachine(
    {
      ...createGoalState(
        'idle-state-session',
        'Complete the requested analysis',
        {
          goalId: 'idle-state-goal',
          runId: 'idle-state-run',
          maxTokens: 0,
          maxTurns: 0,
          maxDurationMs: 0,
          noProgressTurnsBeforePause: 3,
          noToolCallTurnsBeforePause: 0,
          minDelayMs: 0,
        },
      ),
      turnCount: 1,
      ...seed,
    },
    {onCommit: async () => {}},
  );
  const session: SessionContext = {
    sessionID: machine.state.sessionID,
    getMachine: () => machine,
    listMachines: () => [machine],
    listActiveGoals: () => [machine.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => machine,
    replaceGoals: async () => machine,
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: true, machine}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    setPendingIntent: () => {},
    getPendingIntent: () => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
  const runtime = createRuntimeState();
  runtime.threadToolsRegistered = true;
  runtime.sessionGoals.set(session.sessionID, [machine]);
  runtime.liveSessions.add(session.sessionID);
  runtime.canDriveSession = () => true;
  let messages: unknown[] = [];
  const prompts: unknown[] = [];
  const announcements: string[] = [];
  const errors: unknown[] = [];
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    runtime,
    completionGate: null,
    sessionApi: {
      messages: async () => messages,
      promptAsync: async (_sid, input) => {
        prompts.push(input);
        return {};
      },
    },
    logError: async (...args) => {
      errors.push(args);
    },
    announceGoalDecision: async (_sid, message) => {
      announcements.push(message);
    },
  };
  return {
    machine,
    session,
    runtime,
    deps,
    hooks: createHooks(deps),
    prompts,
    announcements,
    errors,
    setMessages: (next: unknown[]) => {
      messages = next;
    },
    idle: () =>
      processIdleEvent(
        session.sessionID,
        session,
        machine,
        createLoopPolicy(),
        deps,
      ),
  };
}

export function idleAssistant(
  id: string | undefined,
  text: string,
  output: number,
  extra: Record<string, unknown> = {},
) {
  return {
    ...(id ? {id} : {}),
    role: 'assistant',
    finish: 'stop',
    tokens: {input: 100, output},
    parts: [{type: 'text', text}],
    ...extra,
  };
}
