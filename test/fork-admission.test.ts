import {expect, test} from 'bun:test';
import {GoalsPlugin} from '../src/plugin-runtime.ts';
import {registerV2GoalCommandBridge} from '../src/plugin-v2-command-bridge.ts';
import {createRecentKickoffTextTracker} from '../src/plugin-v2-command.ts';
import {inheritOptionsFrom} from '../src/fork-bind.ts';
import {createGoalState} from '../src/state-machine.ts';
import type {RuntimeState} from '../src/session-runtime.ts';
import {TEST_WORKSPACE_DIR} from './identity-stub.ts';

test('fork intent preserves only the unresolved kickoff input requirement', () => {
  const parent = createGoalState('parent', 'Use the attached requirements', {
    kickoffAdmissionPending: true,
    userCommandStartedAt: 123,
  });
  parent.usage.input = 1000;
  parent.lastSessionUsage = {...parent.usage};
  const options = inheritOptionsFrom(parent);
  expect(options.kickoffAdmissionPending).toBe(true);
  expect(options).not.toHaveProperty('userCommandStartedAt');
  expect(options).not.toHaveProperty('runId');
  const fork = createGoalState('fork', parent.condition, options);
  expect(fork.lastSessionUsage).toBeNull();
  expect(fork.usage.input).toBe(0);
  expect(
    inheritOptionsFrom({...parent, kickoffAdmissionPending: false})
      .kickoffAdmissionPending,
  ).toBe(false);
});

test('fork of a rejected attachment kickoff pauses for inputs without a generic continuation', async () => {
  const parentID = 'attachment-parent';
  const forkID = 'attachment-fork';
  const prompts: unknown[] = [];
  const notices: string[] = [];
  const previousMessage = {
    info: {
      id: 'previous-turn',
      role: 'assistant',
      time: {created: Date.now() - 30000, completed: Date.now() - 20000},
      tokens: {input: 100, output: 100},
      finish: 'stop',
    },
    parts: [{type: 'text', text: 'Previous unrelated settled work.'}],
  };
  const hooks = await GoalsPlugin(
    {
      directory: TEST_WORKSPACE_DIR,
      client: {
        session: {
          messages: async () => [previousMessage],
          promptAsync: async (input: unknown) => {
            prompts.push(input);
            return {};
          },
          abort: async () => ({}),
        },
      },
    },
    {
      persistState: false,
      idlePoller: false,
      childSessionJudge: false,
      minDelayMs: 0,
      goalMessenger: async (_sessionID, text) => {
        notices.push(text);
      },
    },
  );
  const runtime = (hooks as typeof hooks & {runtime: RuntimeState}).runtime;
  // The rejected payload remains pending; retry timing is not under test.
  runtime.scheduleKickoff = () => {};
  let execute!: (input: unknown) => Promise<void>;
  try {
    await registerV2GoalCommandBridge({
      ctx: {
        session: {
          prompt: async () => {
            throw new Error('host rejected attachment admission');
          },
          synthetic: async () => {
            throw new Error('unexpected synthetic kickoff');
          },
        },
        command: {
          transform: async (callback: (draft: unknown) => void) => {
            callback({
              add: (entry: {execute: typeof execute}) => {
                execute = entry.execute;
              },
            });
            return {dispose() {}};
          },
        },
      } as never,
      hooks,
      pluginOptions: {},
      recentKickoffTexts: createRecentKickoffTextTracker(),
      disposers: [],
      publishOutput: async () => {},
    });
    await expect(
      execute({
        sessionID: parentID,
        prompt: {
          text: 'Recreate the attached screenshot',
          files: [
            {uri: 'file:///fixture/screenshot.png', name: 'screenshot.png'},
          ],
        },
        delivery: 'steer',
      }),
    ).rejects.toThrow('host rejected attachment admission');
    const parent = runtime.sessionGoals.get(parentID)![0]!.snapshot();
    expect(parent.kickoffAdmissionPending).toBe(true);
    const retained = runtime.pendingKickoffDispatch?.get(parentID);
    expect(retained?.size).toBe(1);

    await hooks.event!({
      type: 'session.forked',
      sessionID: forkID,
      properties: {
        sessionID: forkID,
        parentID,
        boundary: {type: 'through', messageID: previousMessage.info.id},
      },
    });
    const child = runtime.sessionGoals.get(forkID)![0]!;
    expect(child.state.goalId).not.toBe(parent.goalId);
    expect(child.state.kickoffAdmissionPending).toBe(true);
    expect(runtime.pendingKickoffDispatch?.has(forkID)).toBe(false);
    for (let i = 0; i < 2; i++) {
      await hooks.event!({
        type: 'session.idle',
        sessionID: forkID,
        id: `fork-idle-${i}`,
      });
    }
    expect(child.snapshot()).toMatchObject({
      kickoffAdmissionPending: true,
      status: 'paused',
      stopReason: 'kickoff admission failed',
      turnCount: 0,
    });
    expect(prompts).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('original attachments');
    expect(notices[0]).toContain(`/goal resume ${child.state.goalId}`);
    expect(runtime.pendingKickoffDispatch?.get(parentID)).toBe(retained);
    expect(runtime.sessionGoals.get(parentID)![0]!.state.status).toBe('active');
  } finally {
    await hooks.dispose?.();
  }
});
