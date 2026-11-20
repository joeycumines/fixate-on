import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin-runtime.ts';
import {SessionStateManager} from '../src/session-state-manager.ts';
import {registerV2GoalCommandBridge} from '../src/plugin-v2-command-bridge.ts';
import {createRecentKickoffTextTracker} from '../src/plugin-v2-command.ts';
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

async function nativeCommand(
  hooks: Hooks,
  admit: (input: unknown) => Promise<unknown>,
): Promise<NativeCommand> {
  let execute!: NativeCommand;
  await registerV2GoalCommandBridge({
    ctx: {
      session: {prompt: admit, synthetic: admit},
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
  return execute;
}

test('a losing attached resume cannot clear the winning admission marker before native idle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-concurrent-resume-'));
  const sessionID = 'concurrent-resume';
  const persistEntered = deferred();
  const finishPersist = deferred();
  const finishAdmission = deferred();
  let genericPrompts = 0;
  let attachmentPrompts = 0;
  const hooks = (await GoalsPlugin(
    {
      directory,
      client: {
        session: {
          messages: async () => [],
          promptAsync: async () => {
            genericPrompts++;
            return {};
          },
        },
      },
    },
    {
      stateRoot: join(directory, 'state'),
      persistState: true,
      idlePoller: false,
      childSessionJudge: false,
      registerAgents: false,
      minDelayMs: 0,
      kickoffDelayMs: 500000,
    },
  )) as Hooks;
  const runtime = hooks.runtime;
  const execute = await nativeCommand(hooks, async () => {
    attachmentPrompts++;
    await finishAdmission.promise;
    return {};
  });
  const originalPersist = SessionStateManager.prototype.persist;
  let commands: Promise<unknown>[] = [];
  try {
    await runtime.executeSlashCommand!(
      {sessionID, command: 'goal', arguments: 'inspect requirements'},
      {skipKickoff: true},
    );
    await runtime.executeSlashCommand!(
      {sessionID, command: 'goal', arguments: 'pause'},
      {skipKickoff: true},
    );
    let hold = true;
    SessionStateManager.prototype.persist = async function (id: string) {
      if (id === sessionID && hold) {
        hold = false;
        persistEntered.resolve();
        await finishPersist.promise;
      }
      return originalPersist.call(this, id);
    };
    commands = ['first', 'second'].map(name =>
      Promise.resolve(
        execute({
          sessionID,
          prompt: {text: 'resume', files: [{path: `${name}.txt`}]},
          delivery: 'steer',
        }),
      ).then(
        () => ({ok: true}),
        error => ({ok: false, error: String(error)}),
      ),
    );
    await persistEntered.promise;
    await Promise.race(commands);
    expect(
      runtime.sessionGoals.get(sessionID)![0].snapshot()
        .kickoffAdmissionPending,
    ).toBe(true);
    expect(runtime.promptInFlightSessions.has(sessionID)).toBe(true);
    await hooks.event!({
      type: 'session.idle',
      sessionID,
      id: 'while-resume-persisting',
    });
    expect(genericPrompts).toBe(0);
    expect(attachmentPrompts).toBe(0);
    expect(runtime.sessionGoals.get(sessionID)![0].snapshot().status).toBe(
      'active',
    );
  } finally {
    SessionStateManager.prototype.persist = originalPersist;
    finishPersist.resolve();
    finishAdmission.resolve();
    await Promise.all(commands);
    await hooks.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

for (const native of [false, true]) {
  test(`${native ? 'native' : 'legacy'} kickoff honors a stop during the empty replacement interval`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixate-stop-replacement-'));
    const sessionID = `replacement-stop-${native}`;
    const removalReached = deferred();
    const releaseRemoval = deferred();
    const releaseInterrupt = deferred();
    let prompts = 0;
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
            // A slow host interrupt must not delay recording or applying the stop.
            abort: async () => releaseInterrupt.promise,
          },
        },
      },
      {
        persistState: false,
        idlePoller: false,
        childSessionJudge: false,
        minDelayMs: 0,
        kickoffDelayMs: 500000,
        goalMessenger: async () => {},
      },
    )) as Hooks;
    const runtime = hooks.runtime;
    const execute = native
      ? await nativeCommand(hooks, async () => {
          prompts++;
          return {};
        })
      : null;
    const originalPersist = SessionStateManager.prototype.persist;
    let command: Promise<unknown> | undefined;
    try {
      await runtime.executeSlashCommand!(
        {sessionID, command: 'goal', arguments: 'original objective'},
        {skipKickoff: true},
      );
      let held = false;
      SessionStateManager.prototype.persist = async function (id: string) {
        if (id === sessionID && !held && this.listMachines(id).length === 0) {
          held = true;
          removalReached.resolve();
          await releaseRemoval.promise;
        }
        return originalPersist.call(this, id);
      };
      command = execute
        ? Promise.resolve(
            execute({
              sessionID,
              prompt: {
                text: 'replacement objective',
                files: [{path: 'required.txt'}],
              },
            }),
          )
        : hooks['command.execute.before']!(
            {sessionID, command: 'goal', arguments: 'replacement objective'},
            {parts: []},
          );
      await removalReached.promise;
      expect(runtime.sessionGoals.get(sessionID)?.length ?? 0).toBe(0);
      await hooks['chat.message']!(
        {sessionID},
        {parts: [{type: 'text', text: 'stop'}]},
      );
      releaseRemoval.resolve();
      await command;
      const goal = runtime.sessionGoals.get(sessionID)![0].snapshot();
      expect(goal.condition).toBe('replacement objective');
      expect(goal.status).toBe('paused');
      expect(goal.stopReason).toBe('explicit pause');
      expect(runtime.hasKickoffTimer?.(sessionID, goal.goalId)).toBe(false);
      await hooks.event!({
        type: 'session.idle',
        sessionID,
        id: 'after-replacement-stop',
      });
      expect(prompts).toBe(0);
      expect(runtime.sessionGoals.get(sessionID)![0].snapshot().status).toBe(
        'paused',
      );
    } finally {
      SessionStateManager.prototype.persist = originalPersist;
      releaseRemoval.resolve();
      releaseInterrupt.resolve();
      await command;
      await hooks.dispose();
      rmSync(directory, {recursive: true, force: true});
    }
  });
}
