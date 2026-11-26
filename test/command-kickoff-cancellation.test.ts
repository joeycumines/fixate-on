import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin-runtime.ts';
import {registerV2GoalCommandBridge} from '../src/plugin-v2-command-bridge.ts';
import {
  createRecentKickoffTextTracker,
  dispatchV2Kickoff,
} from '../src/plugin-v2-command.ts';
import type {PluginHooks} from '../src/hooks.ts';
import type {RuntimeState} from '../src/session-runtime.ts';
import type {V2CommandDraft, V2Context} from '../src/plugin-v2-helpers.ts';

type Hooks = PluginHooks & {runtime: RuntimeState; dispose(): Promise<void>};
type NativeCommand = NonNullable<
  Parameters<NonNullable<V2CommandDraft['add']>>[0]['execute']
>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

test('retained kickoff retry rechecks a stop after asynchronous agent selection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-retained-switch-'));
  const sessionID = 'retry-cancellation';
  const entered = deferred();
  const release = deferred();
  const finished = deferred();
  let prompts = 0;
  let switches = 0;
  const session = {
    prompt: async () => {
      prompts++;
      return {};
    },
    synthetic: async () => {
      prompts++;
      return {};
    },
  };
  const selectAgent = async () => {
    if (++switches === 1) throw new Error('temporary agent switch failure');
    entered.resolve();
    await release.promise;
  };
  const hooks = (await GoalsPlugin(
    {
      directory,
      client: {
        session: {
          messages: async () => [],
          abort: async () => ({}),
        },
      },
    },
    {
      persistState: false,
      idlePoller: false,
      childSessionJudge: false,
      registerAgents: false,
      minDelayMs: 0,
      kickoffDelayMs: 1,
      goalMessenger: async () => {},
    },
  )) as Hooks;
  try {
    const runtime = hooks.runtime;
    await runtime.executeSlashCommand!(
      {sessionID, command: 'goal', arguments: 'inspect requirements'},
      {skipKickoff: true},
    );
    await hooks['chat.params']!({sessionID, agent: 'goal'});
    await runtime.executeSlashCommand!(
      {sessionID, command: 'goal', arguments: 'pause'},
      {skipKickoff: true},
    );
    runtime.retryPendingKickoffDispatch = async (sid, value, assertActive) => {
      try {
        await dispatchV2Kickoff({
          session,
          sessionID: sid,
          dispatch: value as Parameters<
            typeof dispatchV2Kickoff
          >[0]['dispatch'],
          selectAgent,
          assertActive,
        });
      } finally {
        finished.resolve();
      }
    };
    let execute!: NativeCommand;
    await registerV2GoalCommandBridge({
      ctx: {
        session,
        command: {
          transform: async (edit: (draft: V2CommandDraft) => void) => {
            edit({
              add: entry => {
                execute = entry.execute!;
              },
            });
            return {dispose: async () => {}};
          },
        },
      } as unknown as V2Context,
      hooks,
      pluginOptions: {},
      recentKickoffTexts: createRecentKickoffTextTracker(),
      disposers: [],
      publishOutput: async () => {},
      selectAgent,
    });
    await expect(
      Promise.resolve(
        execute({
          sessionID,
          prompt: {
            text: 'resume',
            files: [
              {
                uri: 'data:text/plain;base64,cmVxdWlyZWQgaW5wdXQ=',
                name: 'required.txt',
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow('temporary agent switch failure');
    await entered.promise;
    await hooks['chat.message']!(
      {sessionID},
      {parts: [{type: 'text', text: 'stop'}]},
    );
    release.resolve();
    await finished.promise;
    expect(switches).toBe(2);
    expect(prompts).toBe(0);
    expect(runtime.sessionGoals.get(sessionID)![0].snapshot().status).toBe(
      'paused',
    );
  } finally {
    release.resolve();
    await hooks.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

for (const cancellation of [
  'human-stop',
  'pause',
  'clear',
  'replace',
  'dispose',
  'lease-loss',
  'pause-resume',
] as const) {
  test(`${cancellation} during native kickoff agent selection prevents admission`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixate-review-command-'));
    const sessionID = `review-${cancellation}`;
    const switchEntered = deferred();
    const finishSwitch = deferred();
    let prompts = 0;
    let aborts = 0;
    let command: Promise<unknown> | undefined;
    const hooks = (await GoalsPlugin(
      {
        directory,
        client: {
          session: {
            messages: async () => [],
            promptAsync: async () => {
              prompts++;
              return {};
            },
            abort: async () => {
              aborts++;
              return {};
            },
          },
        },
      },
      {
        persistState: false,
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
        {sessionID, command: 'goal', arguments: 'inspect requirements'},
        {skipKickoff: true},
      );
      const machine = runtime.sessionGoals.get(sessionID)![0];
      await hooks['chat.params']!({sessionID, agent: 'goal'});
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
        selectAgent: async () => {
          switchEntered.resolve();
          await finishSwitch.promise;
        },
      });
      command = Promise.resolve(
        execute({
          sessionID,
          prompt: {
            text: 'resume',
            files: [
              {
                uri: 'data:text/plain;base64,cmVxdWlyZWQgaW5wdXQ=',
                name: 'required.txt',
              },
            ],
          },
          delivery: 'steer',
        }),
      );
      await switchEntered.promise;
      expect(prompts).toBe(0);
      if (cancellation === 'human-stop') {
        await hooks['chat.message']!(
          {sessionID},
          {parts: [{type: 'text', text: 'stop'}]},
        );
        expect(machine.snapshot().status).toBe('paused');
        expect(machine.snapshot().stopReason).toBe('explicit pause');
      } else if (cancellation === 'clear') {
        await runtime.executeSlashCommand!(
          {sessionID, command: 'goal', arguments: 'clear'},
          {skipKickoff: true},
        );
        expect(runtime.sessionGoals.get(sessionID)?.length ?? 0).toBe(0);
      } else if (cancellation === 'dispose') {
        await hooks.dispose();
      } else if (cancellation === 'lease-loss') {
        runtime.canDriveSession = () => false;
      } else {
        await runtime.executeSlashCommand!(
          {
            sessionID,
            command: 'goal',
            arguments:
              cancellation === 'replace' ? 'replacement objective' : 'pause',
          },
          {skipKickoff: true},
        );
        if (cancellation === 'pause-resume') {
          await runtime.executeSlashCommand!(
            {sessionID, command: 'goal', arguments: 'resume'},
            {skipKickoff: true, preserveKickoffOnSkip: true},
          );
          expect(machine.snapshot().status).toBe('active');
        }
      }
      finishSwitch.resolve();
      await expect(command).rejects.toThrow(
        'Goal changed before kickoff admission completed.',
      );
      expect(prompts).toBe(0);
      if (cancellation === 'human-stop') expect(aborts).toBe(1);
    } finally {
      finishSwitch.resolve();
      await command?.catch(() => {});
      await hooks.dispose();
      rmSync(directory, {recursive: true, force: true});
    }
  });
}
