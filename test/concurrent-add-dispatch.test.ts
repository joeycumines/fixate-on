// Regression: two concurrent `add` commands must each dispatch their own
// goalID, not both attach the first newly-active goal.
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

test('concurrent add commands each dispatch their own goalID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-concurrent-add-'));
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
  const sessionID = 's-concurrent';
  runtime.sessionGoals.set(sessionID, []);
  runtime.focusedGoalId.set(sessionID, '');

  const prompts: Array<{
    goalId: string;
    text: string;
  }> = [];
  const sessionApi = {
    messages: async () => [],
    promptAsync: async (_sid: string, input: Record<string, unknown>) => {
      const part = (input.parts as Array<Record<string, unknown>>)[0];
      prompts.push({
        goalId: String(
          (part?.metadata as Record<string, unknown> | undefined)?.goalId ??
            part?.text ??
            '',
        ),
        text: String(part?.text ?? ''),
      });
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
        replaceGoals: async () => manager.getMachine(sessionID),
        setPendingIntent: () => {},
        getPendingIntent: () => null,
        listArchivedResults: () => [],
        listActiveGoals: () =>
          manager.listMachines(sessionID).map(m => m.snapshot()),
        sessionID,
        createGoal: (objective: string, options?: Record<string, unknown>) =>
          manager.createGoal(sessionID, objective, options ?? {}),
        removeGoal: async () => {},
        clearSession: () => {},
        focusGoal: async () => ({
          ok: true as const,
          machine: manager.getMachine(sessionID),
        }),
        addOrderedSession: () => {},
        isOrdered: () => false,
        getAllPendingIntents: () => [],
        persist: async () => true,
        isOwnedElsewhere: () => false,
      }) as never,
    transitionReceipt: async () => ({receipt: '', changed: true}),
    commandName: 'goal',
    registerCommand: true,
    kickoffDelayMs: 0,
  });

  try {
    const [resA, resB] = await Promise.all([
      wiring.executeSlashCommand(
        {sessionID, command: 'goal', arguments: 'add first objective'},
        {skipKickoff: false},
      ),
      wiring.executeSlashCommand(
        {sessionID, command: 'goal', arguments: 'add second objective'},
        {skipKickoff: false},
      ),
    ]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    expect(resA.enteredActive).toBe(true);
    expect(resB.enteredActive).toBe(true);
    const goalA = resA.after?.goalId;
    const goalB = resB.after?.goalId;
    expect(goalA).toBeTruthy();
    expect(goalB).toBeTruthy();
    expect(goalA).not.toBe(goalB);

    await waitFor(
      () => prompts.length >= 1,
      'the kickoff prompt to be dispatched',
    );
    // scheduleKickoff clears the per-session timer on re-arm, so only the last
    // scheduled goal actually prompts. The dispatch identity is what matters:
    // each command result must name its own goal, and the prompt must target
    // one of them (never a goal neither command created).
    const texts = prompts.map(p => p.text).join('\n');
    const promptTargetsA = texts.includes('first objective');
    const promptTargetsB = texts.includes('second objective');
    expect(promptTargetsA !== promptTargetsB).toBe(true);
  } finally {
    for (const t of wiring.kickoffTimers.values()) clearTimeout(t);
    rmSync(root, {recursive: true, force: true});
  }
});
