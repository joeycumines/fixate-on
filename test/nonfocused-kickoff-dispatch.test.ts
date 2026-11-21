// nonfocused-kickoff-dispatch.test.ts — regression for the resume-of-nonfocused-goal
// finding in scratch/review-05..08.md. `enteredActive` must reflect the goal the
// command actually targeted, not whichever goal is currently focused.
import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createKickoffWiring} from '../src/plugin-kickoff.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {GOAL_TUI_METADATA_KEY} from '../src/tui-state.ts';
import {waitFor} from './wait-for.ts';

function makeOptions() {
  return {
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
}

test('resuming a named nonfocused goal reports and dispatches that goal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-review-kickoff-'));
  const runtime = createRuntimeState();
  runtime.canDriveSession = () => true;
  const manager = new SessionStateManager(
    runtime,
    async () => true,
    root,
    {version: 1, goals: [], results: [], sessionOrdered: []},
    new Map<string, readonly string[]>(),
    async () => true,
    1024,
    3,
    10,
    86_400_000,
    makeOptions(),
    async () => {},
  );
  const sessionID = 's-multi';
  const initialA = createGoalState(sessionID, 'Goal A', {
    goalId: 'goal-a',
    runId: 'run-a',
  });
  const initialB = createGoalState(sessionID, 'Goal B', {
    goalId: 'goal-b',
    runId: 'run-b',
  });
  const machineA = new GoalStateMachine(
    {...initialA, status: 'paused'},
    {
      onCommit: async () => {},
    },
  );
  const machineB = new GoalStateMachine(
    {...initialB, status: 'paused'},
    {
      onCommit: async () => {},
    },
  );
  const machines = [machineA, machineB];
  runtime.sessionGoals.set(sessionID, machines);
  runtime.focusedGoalId.set(sessionID, 'goal-b');
  const focused = machineB;
  const prompts: Array<Record<string, unknown>> = [];

  const sessionApi = {
    messages: async () => [],
    promptAsync: async (_sid: string, input: Record<string, unknown>) => {
      prompts.push(input);
      return {};
    },
  } as never;

  const wiring = createKickoffWiring({
    runtime,
    stateManager: manager,
    sessionApi,
    getSessionContext: () =>
      ({
        getMachine: () => manager.getMachine(sessionID),
        listMachines: () => manager.listMachines(sessionID),
        getMachineById: (id: string) =>
          manager
            .listMachines(sessionID)
            .find(m => m.snapshot().goalId === id) ?? null,
        replaceGoals: async () => focused,
        setPendingIntent: () => {},
        getPendingIntent: () => null,
        listArchivedResults: () => [],
        listActiveGoals: () => [machineA.snapshot(), machineB.snapshot()],
        sessionID,
        createGoal: () => focused,
        removeGoal: async () => {},
        clearSession: () => {},
        focusGoal: async () => ({ok: true as const, machine: focused}),
        addOrderedSession: () => {},
        isOrdered: () => false,
        getAllPendingIntents: () => [],
        persist: async () => true,
      }) as never,
    transitionReceipt: async () => ({receipt: '', changed: true}),
    commandName: 'goal',
    registerCommand: true,
    kickoffDelayMs: 0,
  });

  try {
    const res = await wiring.executeSlashCommand(
      {sessionID, command: 'goal', arguments: `resume ${initialA.goalId}`},
      {skipKickoff: false},
    );
    expect(machineA.snapshot().status).toBe('active');
    expect(res.enteredActive).toBe(true);
    expect(res.after?.goalId).toBe('goal-a');
    await waitFor(
      () => prompts.length === 1,
      'the kickoff prompt to be dispatched',
    );
    const part = (prompts[0]?.parts as Array<Record<string, unknown>>)[0];
    expect(
      (part?.metadata as Record<string, unknown>)?.[GOAL_TUI_METADATA_KEY],
    ).toBeDefined();
  } finally {
    for (const t of wiring.kickoffTimers.values()) clearTimeout(t);
    rmSync(root, {recursive: true, force: true});
  }
});
