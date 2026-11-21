import {expect, test} from 'bun:test';
import {createChildSessionVerifier} from '../src/child-session-verifier.ts';
import {createV2ClientShim} from '../src/plugin-v2.ts';
import {createGoalState} from '../src/state-machine.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

type Rule = {action: string; resource: string; effect: string};
type Admission = (input: {
  sessionID: string;
  messageID: string;
}) => Promise<void>;

/** A deterministic lifecycle host; no network or filesystem operations. */
function lifecycleHost() {
  const activation = deferred<void>();
  const promptStarted = deferred<void>();
  const promptSettled = deferred<void>();
  const hookStarted = deferred<void>();
  const hookDisposed = deferred<void>();
  const updateStarted = deferred<void>();
  const hooks = new Set<Admission>();
  const goal = createGoalState('parent', 'Check admission ordering', {
    goalId: 'goal',
  });
  const state = {
    agentRules: [] as Rule[],
    parentRules: [] as Rule[],
    initialPolicy: [] as Rule[],
    childPolicy: [] as Rule[],
    admittedPolicy: [] as Rule[],
    admissionFailure: undefined as Error | undefined,
    registrationGate: undefined as Promise<void> | undefined,
    updateGate: undefined as Promise<void> | undefined,
    skipHook: false,
    reads: 0,
    updates: 0,
    prompts: 0,
    admissions: 0,
    deletions: 0,
    disposedHooks: 0,
  };
  const ctx = {
    agent: {
      get: async () => {
        state.reads++;
        return {
          id: 'goal-verify',
          permissions: structuredClone(state.agentRules),
        };
      },
    },
    session: {
      create: async (input: {permissions: Rule[]}) => {
        state.initialPolicy = structuredClone(input.permissions);
        state.childPolicy = structuredClone(input.permissions);
        return {id: 'child', parentID: 'parent'};
      },
      get: async ({sessionID}: {sessionID: string}) =>
        sessionID === 'parent'
          ? {
              id: 'parent',
              location: {directory: '/workspace'},
              permissions: structuredClone(state.parentRules),
            }
          : {
              id: 'child',
              parentID: 'parent',
              agent: 'goal-verify',
              location: {directory: '/workspace'},
              permissions: structuredClone(state.childPolicy),
            },
      switchAgent: async () => {},
      hook: async (_name: string, callback: Admission) => {
        hooks.add(callback);
        hookStarted.resolve();
        await state.registrationGate;
        return {
          dispose: async () => {
            if (hooks.delete(callback)) {
              state.disposedHooks++;
              hookDisposed.resolve();
            }
          },
        };
      },
      update: async (input: {permissions: Rule[]}) => {
        state.updates++;
        updateStarted.resolve();
        await state.updateGate;
        if (state.admissionFailure) throw state.admissionFailure;
        state.childPolicy = structuredClone(input.permissions);
      },
      prompt: async () => {
        state.prompts++;
        promptStarted.resolve();
        try {
          await activation.promise;
          if (!state.skipHook) {
            for (const hook of hooks) {
              await hook({sessionID: 'other', messageID: 'other-message'});
              // A different session cannot trigger this child's refresh.
              expect(state.updates).toBe(0);
              await hook({sessionID: 'child', messageID: 'child-message'});
            }
          }
          state.admissions++;
          state.admittedPolicy = structuredClone(state.childPolicy);
          return {
            info: {role: 'assistant'},
            parts: [
              {
                type: 'text',
                text: JSON.stringify({
                  schema_version: 1,
                  task_id: goal.goalId,
                  state: 'WORKING',
                  outstanding: ['Controlled unfinished work'],
                  evidence: ['Controlled lifecycle response'],
                }),
              },
            ],
          };
        } finally {
          promptSettled.resolve();
        }
      },
      remove: async () => {
        state.deletions++;
      },
      interrupt: async () => {},
    },
  };
  const input = {
    goal,
    taskId: goal.goalId,
    cwd: '/workspace',
    latestText: 'Controlled claim',
    candidateIdentity: {candidate: 'candidate', fingerprint: 'fingerprint'},
  };
  return {
    ctx,
    state,
    hooks,
    activation,
    promptStarted,
    promptSettled,
    hookStarted,
    hookDisposed,
    updateStarted,
    run: (timeoutMs = 1000) =>
      createChildSessionVerifier(
        createV2ClientShim(ctx as never, {bySession: new Map()}),
        {timeoutMs},
      )(input),
  };
}

const denyAll = [{action: '*', resource: '*', effect: 'deny'}];

test('child stays inert until the completed configuration is installed before admission', async () => {
  const host = lifecycleHost();
  const update = deferred<void>();
  host.state.updateGate = update.promise;
  const running = host.run();
  await host.promptStarted.promise;
  expect(host.state.initialPolicy).toEqual(denyAll);
  expect(host.state.reads).toBe(1);
  expect(host.state.admissions).toBe(0);
  const configured = {action: 'read', resource: '*configured', effect: 'deny'};
  const parent = {action: 'grep', resource: '*parent', effect: 'ask'};
  host.state.agentRules = [configured];
  host.state.parentRules = [parent];
  host.activation.resolve();
  await host.updateStarted.promise;
  expect(host.state.reads).toBe(2);
  expect(host.state.updates).toBe(1);
  expect(host.state.admissions).toBe(0);
  update.resolve();
  expect((await running).state).toBe('WORKING');
  expect(host.state.admittedPolicy).toContainEqual(configured);
  expect(host.state.admittedPolicy).toContainEqual(parent);
  expect(host.state.admissions).toBe(1);
  expect(host.state.deletions).toBe(1);
  expect(host.state.disposedHooks).toBe(1);
  expect(host.hooks.size).toBe(0);
});

test('a failed policy update cannot admit the child prompt', async () => {
  const host = lifecycleHost();
  host.state.admissionFailure = new Error('Controlled update failure');
  host.activation.resolve();
  await expect(host.run()).rejects.toThrow('Controlled update failure');
  expect(host.state.childPolicy).toEqual(denyAll);
  expect(host.state.admissions).toBe(0);
  expect(host.state.deletions).toBe(1);
  expect(host.state.disposedHooks).toBe(1);
});

test('a failed policy refresh cannot use the earlier startup snapshot', async () => {
  const host = lifecycleHost();
  const running = host.run();
  const fault = running.catch(error => error as Error);
  await host.promptStarted.promise;
  host.ctx.agent.get = async () => {
    throw new Error('Controlled policy read failure');
  };
  host.activation.resolve();
  expect(await fault).toMatchObject({
    message: expect.stringContaining('Controlled policy read failure'),
  });
  expect(host.state.childPolicy).toEqual(denyAll);
  expect(host.state.updates).toBe(0);
  expect(host.state.admissions).toBe(0);
  expect(host.state.deletions).toBe(1);
  expect(host.state.disposedHooks).toBe(1);
});

test('cancellation during a policy update prevents admission after the update settles', async () => {
  const host = lifecycleHost();
  const update = deferred<void>();
  host.state.updateGate = update.promise;
  host.activation.resolve();
  const running = host.run(20);
  const assertion = expect(running).rejects.toThrow('timed out');
  await host.updateStarted.promise;
  await assertion;
  expect(host.state.deletions).toBe(1);
  update.resolve();
  await host.promptSettled.promise;
  await host.hookDisposed.promise;
  expect(host.state.admissions).toBe(0);
  expect(host.state.deletions).toBe(1);
  expect(host.state.disposedHooks).toBe(1);
});

test('cancellation retains the hook until a delayed host prompt settles', async () => {
  const host = lifecycleHost();
  const running = host.run(20);
  const assertion = expect(running).rejects.toThrow('timed out');
  await host.promptStarted.promise;
  await assertion;
  expect(host.state.deletions).toBe(1);
  expect(host.hooks.size).toBe(1);
  host.activation.resolve();
  await host.promptSettled.promise;
  await host.hookDisposed.promise;
  expect(host.state.admissions).toBe(0);
  expect(host.state.updates).toBe(0);
  expect(host.state.disposedHooks).toBe(1);
  expect(host.hooks.size).toBe(0);
});

test('late hook registration is disposed after cancellation without a host prompt', async () => {
  const host = lifecycleHost();
  const registration = deferred<void>();
  host.state.registrationGate = registration.promise;
  const running = host.run(20);
  const assertion = expect(running).rejects.toThrow('timed out');
  await host.hookStarted.promise;
  await assertion;
  registration.resolve();
  await host.hookDisposed.promise;
  expect(host.state.prompts).toBe(0);
  expect(host.state.admissions).toBe(0);
  expect(host.state.deletions).toBe(1);
  expect(host.state.disposedHooks).toBe(1);
});

test('a host that skips the admission hook cannot attest or inherit read access', async () => {
  const host = lifecycleHost();
  host.state.skipHook = true;
  host.activation.resolve();
  await expect(host.run()).rejects.toThrow(
    'did not run the child policy admission hook',
  );
  expect(host.state.admittedPolicy).toEqual(denyAll);
  expect(host.state.updates).toBe(0);
  expect(host.state.deletions).toBe(1);
  expect(host.state.disposedHooks).toBe(1);
});

for (const absent of ['hook', 'update'] as const) {
  test(`a host without ${absent} cannot admit an unrefreshed child`, async () => {
    const host = lifecycleHost();
    (host.ctx.session as Record<string, unknown>)[absent] = undefined;
    await expect(host.run()).rejects.toThrow(
      'policy refresh before prompt admission is unavailable',
    );
    expect(host.state.initialPolicy).toEqual(denyAll);
    expect(host.state.prompts).toBe(0);
    expect(host.state.deletions).toBe(1);
  });
}
