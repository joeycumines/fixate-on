import {expect, test} from 'bun:test';
import {handleCommandOutcome} from '../src/commands.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {createHooks} from '../src/hooks.ts';
import {processIdleEvent} from '../src/hooks-idle.ts';
import type {HookDeps, SessionContext} from '../src/hooks-types.ts';
import {deserializeGoal, serializeGoal} from '../src/persistence.ts';
import {createKickoffWiring} from '../src/plugin-kickoff.ts';
import {SessionStateManager} from '../src/session-state-manager.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
} from '../src/session-runtime.ts';
import {handleCreateGoal} from '../src/tools.ts';
import {deferred} from './wait-for.ts';

for (const stopDuringReplacement of [true, false]) {
  test(
    stopDuringReplacement
      ? 'a human stop in the real replacement persistence gap stops the new goal'
      : 'a historical stop before the new command does not stop its replacement',
    async () => {
      const realNow = Date.now;
      let now = 1000;
      Date.now = () => now;
      const runtime = createRuntimeState();
      runtime.threadToolsRegistered = true;
      runtime.canDriveSession = () => true;
      runtime.usageEventsObserved.add('s-replace');
      const gapEntered = deferred<void>();
      const releaseGap = deferred<void>();
      let interceptRemoval = false;
      let prompts = 0;
      const manager = new SessionStateManager(
        runtime,
        async () => {
          if (interceptRemoval && manager.getMachine('s-replace') === null) {
            interceptRemoval = false;
            gapEntered.resolve();
            await releaseGap.promise;
          }
          return true;
        },
        '',
        undefined,
        new Map(),
        async () => true,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          ...DEFAULT_GOAL_OPTIONS,
          minDelayMs: 0,
          maxDurationMs: 0,
          noToolCallTurnsBeforePause: 0,
        },
        async () => {},
      );
      const session: SessionContext = {
        sessionID: 's-replace',
        getMachine: () => manager.getMachine('s-replace'),
        listMachines: () => manager.listMachines('s-replace'),
        listActiveGoals: () => manager.listActiveGoals('s-replace'),
        listArchivedResults: () => manager.listArchivedResults('s-replace'),
        createGoal: (text, opts) => manager.createGoal('s-replace', text, opts),
        replaceGoals: (text, opts) =>
          manager.replaceGoals('s-replace', text, opts),
        removeGoal: id => manager.removeGoal('s-replace', id),
        clearSession: () => manager.clearSession('s-replace'),
        focusGoal: id => manager.focusGoal('s-replace', id),
        addOrderedSession: () => manager.addOrderedSession('s-replace'),
        isOrdered: () => manager.isOrdered('s-replace'),
        getPendingIntent: () => null,
        getAllPendingIntents: () => [],
        setPendingIntent: () => {},
        persist: () => manager.persist('s-replace'),
      };
      const messages: unknown[] = [
        {
          id: 'a1',
          role: 'assistant',
          time: {created: 900},
          tokens: {output: 200},
          parts: [{type: 'text', text: 'Earlier response.'}],
        },
      ];
      const deps: HookDeps = {
        runtime,
        getSessionContext: () => session,
        getLoopPolicy: () => createLoopPolicy(),
        commandName: 'goal',
        idlePoller: false,
        completionGate: null,
        sessionApi: {
          messages: async () => messages,
          promptAsync: async () => {
            prompts++;
            return {};
          },
        },
        logError: async () => {},
        announceGoalDecision: async () => {},
      };
      const hooks = createHooks(deps);
      const stop = async () => {
        messages.push({
          id: `stop-${now}`,
          role: 'user',
          delivery: 'steer',
          time: {created: now},
          parts: [{type: 'text', text: 'stop'}],
        });
        await hooks['chat.message']!(
          {sessionID: 's-replace'},
          {
            parts: [{type: 'text', text: 'stop'}],
          },
        );
      };
      try {
        manager.createGoal('s-replace', 'The previous objective', {});
        await manager.drainWalWrites();
        if (!stopDuringReplacement) {
          now = 1500;
          await stop();
          expect(manager.getMachine('s-replace')!.snapshot().status).toBe(
            'paused',
          );
        }
        now = 2000;
        interceptRemoval = true;
        const replacing = handleCommandOutcome(
          'Work on the new objective',
          session,
          'goal',
        );
        await gapEntered.promise;
        // Real removeGoalOwned removed the last machine before awaiting the
        // persistence callback; chat.message has no goal to pause in this gap.
        expect(manager.getMachine('s-replace')).toBeNull();
        if (stopDuringReplacement) {
          now = 2100;
          await stop();
        }
        now = 2200;
        releaseGap.resolve();
        expect((await replacing).ok).toBe(true);
        const replacement = manager.getMachine('s-replace')!;
        expect(replacement.snapshot().createdAt).toBe(2200);
        expect(replacement.snapshot().userCommandStartedAt).toBe(2000);
        const saved = JSON.parse(
          JSON.stringify(serializeGoal(replacement.snapshot())),
        );
        expect(deserializeGoal(saved).userCommandStartedAt).toBe(2000);
        await processIdleEvent(
          's-replace',
          session,
          replacement,
          createLoopPolicy(),
          deps,
        );
        expect(replacement.snapshot().status).toBe(
          stopDuringReplacement ? 'paused' : 'active',
        );
        expect(replacement.snapshot().stopReason).toBe(
          stopDuringReplacement ? 'explicit pause' : '',
        );
        expect(prompts).toBe(stopDuringReplacement ? 0 : 1);
      } finally {
        releaseGap.resolve();
        await manager.drainWalWrites();
        runtime.disposed = true;
        Date.now = realNow;
      }
    },
  );
}

// The sequence branch removes every active goal before creating its ordered
// replacements — the same remove/persist gap as the plain replacement above.
// A human stop in that gap must order against the command admission, not the
// replacement object's creation time.
for (const command of [
  'sequence first replacement; second replacement',
  'sequence new first objective; new second objective',
]) {
  test(`a human stop in a sequence replacement gap pauses the first goal: ${command}`, async () => {
    const realNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    const runtime = createRuntimeState();
    runtime.threadToolsRegistered = true;
    runtime.canDriveSession = () => true;
    runtime.usageEventsObserved.add('s-sequence');
    const gapEntered = deferred<void>();
    const releaseGap = deferred<void>();
    let interceptRemoval = false;
    let prompts = 0;
    const manager = new SessionStateManager(
      runtime,
      async () => {
        if (interceptRemoval && manager.getMachine('s-sequence') === null) {
          interceptRemoval = false;
          gapEntered.resolve();
          await releaseGap.promise;
        }
        return true;
      },
      '',
      undefined,
      new Map(),
      async () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ...DEFAULT_GOAL_OPTIONS,
        minDelayMs: 0,
        maxDurationMs: 0,
        noToolCallTurnsBeforePause: 0,
      },
      async () => {},
    );
    const session: SessionContext = {
      sessionID: 's-sequence',
      getMachine: () => manager.getMachine('s-sequence'),
      listMachines: () => manager.listMachines('s-sequence'),
      listActiveGoals: () => manager.listActiveGoals('s-sequence'),
      listArchivedResults: () => manager.listArchivedResults('s-sequence'),
      createGoal: (text, opts) => manager.createGoal('s-sequence', text, opts),
      replaceGoals: (text, opts) =>
        manager.replaceGoals('s-sequence', text, opts),
      removeGoal: id => manager.removeGoal('s-sequence', id),
      clearSession: () => manager.clearSession('s-sequence'),
      focusGoal: id => manager.focusGoal('s-sequence', id),
      addOrderedSession: () => manager.addOrderedSession('s-sequence'),
      isOrdered: () => manager.isOrdered('s-sequence'),
      getPendingIntent: () => null,
      getAllPendingIntents: () => [],
      setPendingIntent: () => {},
      persist: () => manager.persist('s-sequence'),
    };
    const messages: unknown[] = [
      {
        id: 'a1',
        role: 'assistant',
        time: {created: 900},
        tokens: {output: 200},
        parts: [{type: 'text', text: 'Earlier response.'}],
      },
    ];
    const deps: HookDeps = {
      runtime,
      getSessionContext: () => session,
      getLoopPolicy: () => createLoopPolicy(),
      commandName: 'goal',
      idlePoller: false,
      completionGate: null,
      sessionApi: {
        messages: async () => messages,
        promptAsync: async () => {
          prompts++;
          return {};
        },
      },
      logError: async () => {},
      announceGoalDecision: async () => {},
    };
    const hooks = createHooks(deps);
    try {
      manager.createGoal('s-sequence', 'The previous objective', {});
      await manager.drainWalWrites();
      now = 2000;
      interceptRemoval = true;
      const replacing = handleCommandOutcome(command, session, 'goal');
      await gapEntered.promise;
      expect(manager.getMachine('s-sequence')).toBeNull();
      now = 2100;
      messages.push({
        id: 'stop-2100',
        role: 'user',
        delivery: 'steer',
        time: {created: now},
        parts: [{type: 'text', text: 'stop'}],
      });
      await hooks['chat.message']!(
        {sessionID: 's-sequence'},
        {parts: [{type: 'text', text: 'stop'}]},
      );
      now = 2200;
      releaseGap.resolve();
      expect((await replacing).ok).toBe(true);
      const first = manager
        .listMachines('s-sequence')
        .find(m => m.snapshot().mode === 'ordered')!;
      expect(first.snapshot().createdAt).toBe(2200);
      expect(first.snapshot().userCommandStartedAt).toBe(2000);
      await processIdleEvent(
        's-sequence',
        session,
        first,
        createLoopPolicy(),
        deps,
      );
      expect(first.snapshot().status).toBe('paused');
      expect(first.snapshot().stopReason).toBe('explicit pause');
      expect(prompts).toBe(0);
    } finally {
      releaseGap.resolve();
      await manager.drainWalWrites();
      runtime.disposed = true;
      Date.now = realNow;
    }
  });
}

test('executeSlashCommand forwards explicit userCommandStartedAt to handleCommandOutcome', async () => {
  const runtime = createRuntimeState();
  const manager = new SessionStateManager(
    runtime,
    async () => true,
    '',
    undefined,
    new Map(),
    async () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    DEFAULT_GOAL_OPTIONS,
    async () => {},
  );
  const session: SessionContext = {
    sessionID: 's-ts',
    getMachine: () => manager.getMachine('s-ts'),
    listMachines: () => manager.listMachines('s-ts'),
    listActiveGoals: () => manager.listActiveGoals('s-ts'),
    listArchivedResults: () => manager.listArchivedResults('s-ts'),
    createGoal: (text, opts) => manager.createGoal('s-ts', text, opts),
    replaceGoals: (text, opts) => manager.replaceGoals('s-ts', text, opts),
    removeGoal: id => manager.removeGoal('s-ts', id),
    clearSession: () => manager.clearSession('s-ts'),
    focusGoal: id => manager.focusGoal('s-ts', id),
    addOrderedSession: () => manager.addOrderedSession('s-ts'),
    isOrdered: () => manager.isOrdered('s-ts'),
    getPendingIntent: () => null,
    getAllPendingIntents: () => [],
    setPendingIntent: () => {},
    persist: () => manager.persist('s-ts'),
  };
  const wiring = createKickoffWiring({
    runtime,
    stateManager: manager,
    sessionApi: {
      messages: async () => [],
      promptAsync: async () => ({}),
      createChild: async () => ({}),
      prompt: async () => ({}),
      update: async () => ({}),
      get: async () => ({}),
      delete: async () => ({}),
      abort: async () => ({}),
    },
    getSessionContext: () => session,
    transitionReceipt: async () => ({receipt: '', changed: false}),
    commandName: 'goal',
    registerCommand: false,
  });
  const res = await wiring.executeSlashCommand(
    {sessionID: 's-ts', command: 'goal', arguments: 'Ship cleanly'},
    {skipKickoff: true, userCommandStartedAt: 12345} as never,
  );
  expect(res.ok).toBe(true);
  expect(manager.getMachine('s-ts')?.snapshot().userCommandStartedAt).toBe(
    12345,
  );
});

test('handleCreateGoal ignores internal admission fields supplied by untrusted tool args', async () => {
  const runtime = createRuntimeState();
  const manager = new SessionStateManager(
    runtime,
    async () => true,
    '',
    undefined,
    new Map(),
    async () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    DEFAULT_GOAL_OPTIONS,
    async () => {},
  );
  const session: SessionContext = {
    sessionID: 's-tool',
    getMachine: () => manager.getMachine('s-tool'),
    listMachines: () => manager.listMachines('s-tool'),
    listActiveGoals: () => manager.listActiveGoals('s-tool'),
    listArchivedResults: () => manager.listArchivedResults('s-tool'),
    createGoal: (text, opts) => manager.createGoal('s-tool', text, opts),
    replaceGoals: (text, opts) => manager.replaceGoals('s-tool', text, opts),
    removeGoal: id => manager.removeGoal('s-tool', id),
    clearSession: () => manager.clearSession('s-tool'),
    focusGoal: id => manager.focusGoal('s-tool', id),
    addOrderedSession: () => manager.addOrderedSession('s-tool'),
    isOrdered: () => manager.isOrdered('s-tool'),
    getPendingIntent: () => null,
    getAllPendingIntents: () => [],
    setPendingIntent: () => {},
    persist: () => manager.persist('s-tool'),
  };
  await handleCreateGoal(session, {
    objective: 'Build safely',
    kickoffAdmissionPending: true,
    userCommandStartedAt: 9e15,
  } as never);
  const snap = manager.getMachine('s-tool')!.snapshot();
  expect(snap.kickoffAdmissionPending).toBe(false);
  expect(snap.userCommandStartedAt).toBeUndefined();
});
