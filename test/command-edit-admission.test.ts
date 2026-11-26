import {expect, test} from 'bun:test';
import {
  handleCommandOutcome,
  type CommandSessionContext,
} from '../src/commands.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin-runtime.ts';
import {SessionStateManager} from '../src/session-state-manager.ts';
import {registerV2GoalCommandBridge} from '../src/plugin-v2-command-bridge.ts';
import {createRecentKickoffTextTracker} from '../src/plugin-v2-command.ts';
import type {PluginHooks} from '../src/hooks.ts';
import type {RuntimeState} from '../src/session-runtime.ts';
import type {V2CommandDraft, V2Context} from '../src/plugin-v2-helpers.ts';
import {deferred} from './fixtures/native-kickoff-host.ts';

test('a delayed replacement command cannot adopt a newer edit during its creation checkpoint', async () => {
  const created = deferred();
  const release = deferred();
  let machine: GoalStateMachine | null = null;
  const session: CommandSessionContext = {
    sessionID: 's',
    getMachine: () => machine,
    getMachineById: () => machine,
    listActiveGoals: () => (machine ? [machine.snapshot()] : []),
    listArchivedResults: () => [],
    createGoal: () => {
      throw new Error('unexpected synchronous creation');
    },
    replaceGoals: async (condition, options) => {
      machine = new GoalStateMachine(createGoalState('s', condition, options));
      created.resolve();
      await release.promise;
      return machine;
    },
    removeGoal: async () => {},
    clearSession: async () => {},
    focusGoal: async () => ({ok: false, reason: 'not-found'}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    persist: async () => true,
    hasRetainedKickoff: () => false,
  };
  const original = handleCommandOutcome(
    'original --token-budget 200',
    session,
    'goal',
    {hasAttachments: true},
  );
  await created.promise;
  const newer = await handleCommandOutcome('edit newer objective', session);
  release.resolve();
  const outcome = await original;
  expect(newer.ok).toBe(true);
  expect(outcome.ok).toBe(false);
  expect(session.getMachine()!.snapshot().condition).toBe('newer objective');
  expect(session.getMachine()!.snapshot().tokenBudget).toBe(200);
});

test('losing attached edit cannot clear the winning activation requirement or reset edit budgets', async () => {
  const machine = new GoalStateMachine({
    ...createGoalState('s', 'old objective', {}),
    status: 'paused',
    kickoffAdmissionPending: false,
    turnCount: 7,
    totalTokens: 1234,
  });
  const persisted: boolean[] = [];
  const session = {
    sessionID: 's',
    getMachine: () => machine,
    getMachineById: () => machine,
    listActiveGoals: () => [machine.snapshot()],
    hasRetainedKickoff: () => false,
    kickoffAdmissionInFlight: () => false,
    persist: async () => {
      persisted.push(machine.snapshot().kickoffAdmissionPending === true);
      return true;
    },
  } as unknown as CommandSessionContext;
  const outcomes = await Promise.all([
    handleCommandOutcome('edit first objective', session, 'goal', {
      hasAttachments: true,
    }),
    handleCommandOutcome('edit second objective', session, 'goal', {
      hasAttachments: true,
    }),
  ]);
  expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
  expect(machine.snapshot().kickoffAdmissionPending).toBe(true);
  expect(persisted.every(Boolean)).toBe(true);
  expect(machine.snapshot().turnCount).toBe(7);
  expect(machine.snapshot().totalTokens).toBe(1234);
});

test('an edit awaiting activation persistence cannot overwrite a newer objective edit', async () => {
  let entered!: () => void;
  let release!: () => void;
  const activationEntered = new Promise<void>(resolve => {
    entered = resolve;
  });
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const machine = new GoalStateMachine(
    {
      ...createGoalState('s', 'old objective', {}),
      status: 'paused',
    },
    {
      onCommit: async (_goal, transition) => {
        if (transition.from === 'paused' && transition.to === 'active') {
          entered();
          await hold;
        }
      },
    },
  );
  const session = {
    sessionID: 's',
    getMachine: () => machine,
    getMachineById: () => machine,
    listActiveGoals: () => [machine.snapshot()],
    hasRetainedKickoff: () => false,
    kickoffAdmissionInFlight: () => false,
    persist: async () => true,
  } as unknown as CommandSessionContext;
  const older = handleCommandOutcome('edit older objective', session, 'goal', {
    hasAttachments: true,
  });
  await activationEntered;
  const newer = handleCommandOutcome('edit newer objective', session, 'goal', {
    hasAttachments: true,
  });
  release();
  const outcomes = await Promise.all([older, newer]);
  expect(outcomes[0].ok).toBe(false);
  expect(outcomes[1].ok).toBe(true);
  expect(machine.snapshot().condition).toBe('newer objective');
  expect(machine.snapshot().kickoffAdmissionPending).toBe(true);
});

for (const verb of ['edit', 'checkpoint'] as const) {
  for (const stale of [false, true]) {
    test(`${verb} uses horizontal separators for ${stale ? 'a stale' : 'an unfocused'} explicit goal ID`, async () => {
      const focused = new GoalStateMachine(
        createGoalState('s', 'focused goal', {}),
      );
      const target = new GoalStateMachine(
        createGoalState('s', 'target goal', {}),
      );
      const machines = [focused, target];
      const session = {
        sessionID: 's',
        getMachine: () => focused,
        getMachineById: (id: string) =>
          machines.find(machine => machine.snapshot().goalId === id),
        listActiveGoals: () => machines.map(machine => machine.snapshot()),
        persist: async () => true,
      } as unknown as CommandSessionContext;
      const id = stale
        ? '00000000-0000-4000-8000-000000000000'
        : target.snapshot().goalId;
      const outcome = await handleCommandOutcome(
        `${verb}\t${id}\tupdated text`,
        session,
      );
      expect(outcome.ok).toBe(!stale);
      expect(focused.snapshot().condition).toBe('focused goal');
      expect(focused.snapshot().lastCheckpoint).toBeNull();
      if (stale) expect(outcome.text).toContain('could not be resolved');
      else if (verb === 'edit')
        expect(target.snapshot().condition).toBe('updated text');
      else
        expect(target.snapshot().lastCheckpoint?.summary).toBe('updated text');
    });
  }
}

test('native concurrent attached edits persist the winning input requirement before dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-review-edit-'));
  const stateRoot = join(directory, 'state');
  const sessionID = 'review-native-edits';
  type Hooks = PluginHooks & {runtime: RuntimeState; dispose(): Promise<void>};
  type NativeCommand = NonNullable<
    Parameters<NonNullable<V2CommandDraft['add']>>[0]['execute']
  >;
  let reachHold!: () => void;
  let releaseHold!: () => void;
  const holdReached = new Promise<void>(r => {
    reachHold = r;
  });
  const hold = new Promise<void>(r => {
    releaseHold = r;
  });
  let prompts = 0;
  let diskAtHold:
    | {goals: Array<{status: string; kickoffAdmissionPending?: boolean}>}
    | undefined;
  let commands: Promise<unknown>[] = [];
  const originalPersist = SessionStateManager.prototype.persist;
  const hooks = (await GoalsPlugin(
    {
      directory,
      client: {
        session: {messages: async () => [], promptAsync: async () => ({})},
      },
    },
    {
      stateRoot,
      persistState: true,
      idlePoller: false,
      childSessionJudge: false,
      registerAgents: false,
      minDelayMs: 0,
      kickoffDelayMs: 500000,
      goalMessenger: async () => {},
    },
  )) as Hooks;
  try {
    const runtime = hooks.runtime;
    await runtime.executeSlashCommand!(
      {sessionID, command: 'goal', arguments: 'old objective'},
      {skipKickoff: true},
    );
    await runtime.executeSlashCommand!(
      {sessionID, command: 'goal', arguments: 'pause'},
      {skipKickoff: true},
    );
    let execute!: NativeCommand;
    await registerV2GoalCommandBridge({
      ctx: {
        session: {
          prompt: async () => {
            prompts++;
            return {};
          },
          synthetic: async () => {
            prompts++;
            return {};
          },
        },
        command: {
          transform: async (edit: (draft: V2CommandDraft) => void) => {
            edit({
              add: entry => {
                execute = entry.execute!;
              },
            });
            return {dispose() {}};
          },
        },
      } as unknown as V2Context,
      hooks,
      pluginOptions: {},
      recentKickoffTexts: createRecentKickoffTextTracker(),
      disposers: [],
      publishOutput: async () => {},
    });
    SessionStateManager.prototype.persist = async function (id: string) {
      const result = await originalPersist.call(this, id);
      const goal = this.listMachines(id)[0]?.snapshot();
      if (
        id === sessionID &&
        goal?.status === 'active' &&
        goal.condition !== 'old objective' &&
        !diskAtHold
      ) {
        diskAtHold = JSON.parse(
          readFileSync(
            join(stateRoot, 'sessions', sessionID, 'state.json'),
            'utf8',
          ),
        );
        reachHold();
        await hold;
      }
      return result;
    };
    commands = ['first', 'second'].map(name =>
      Promise.resolve(
        execute({
          sessionID,
          prompt: {
            text: `edit ${name} objective`,
            files: [
              {
                uri: 'data:text/plain;base64,cmVxdWlyZWQgaW5wdXQ=',
                name: `${name}.txt`,
              },
            ],
          },
        }),
      ).then(
        () => ({ok: true}),
        error => ({ok: false, error: String(error)}),
      ),
    );
    await Promise.race([
      holdReached,
      Promise.all(commands).then(() => {
        throw new Error(
          'Both commands settled before the activation persistence boundary',
        );
      }),
    ]);
    expect(prompts).toBe(0);
    expect(diskAtHold!.goals[0].status).toBe('active');
    expect(diskAtHold!.goals[0].kickoffAdmissionPending).toBe(true);
  } finally {
    SessionStateManager.prototype.persist = originalPersist;
    releaseHold();
    await Promise.all(commands);
    await hooks.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});
