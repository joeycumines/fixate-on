import {expect, test} from 'bun:test';
import {createV2ClientShim} from '../src/plugin-v2.ts';
import {
  createChildSessionJudge,
  createChildSessionVerifier,
} from '../src/child-session-verifier.ts';
import {createGoalState} from '../src/state-machine.ts';

function scenario(context: (() => Promise<unknown>) | undefined) {
  const goal = createGoalState('parent', 'Review the fixture', {
    goalId: 'goal',
  });
  const verdict = (state: 'COMPLETE' | 'WORKING') =>
    JSON.stringify({
      schema_version: 1,
      task_id: goal.goalId,
      state,
      outstanding: state === 'WORKING' ? ['The fixture is unfinished.'] : [],
      evidence: ['Controlled verifier response.'],
    });
  const interim = {
    type: 'assistant',
    id: 'interim',
    content: [
      {type: 'text', text: verdict('COMPLETE')},
      {
        type: 'tool',
        name: 'read',
        input: {path: '/fixture.txt'},
        state: {status: 'completed'},
      },
    ],
  };
  const final = {
    type: 'assistant',
    id: 'final',
    agent: 'goal-verify',
    finish: 'stop',
    time: {created: 2, completed: 3},
    content: [{type: 'text', text: verdict('WORKING')}],
  };
  const admitted = {
    type: 'user',
    id: 'admitted',
    sessionID: 'child',
    time: {created: 1},
    payload: {text: 'review'},
  };
  let deleted = 0;
  let contextReads = 0;
  let created = 0;
  let admission: ((event: {sessionID: string}) => Promise<void>) | undefined;
  const admit = async () => admission?.({sessionID: 'child'});
  const ctx = {
    agent: {get: async () => ({id: 'goal-verify', permissions: []})},
    session: {
      create: async () => {
        created++;
        return {id: 'child', parentID: 'parent'};
      },
      get: async ({sessionID}: {sessionID: string}) =>
        sessionID === 'parent'
          ? {id: 'parent', location: {directory: '/workspace'}, permissions: []}
          : {
              id: 'child',
              parentID: 'parent',
              agent: 'goal-verify',
              location: {directory: '/workspace'},
              outcome: 'succeeded',
              time: {busy: 1, idle: 4},
            },
      switchAgent: async () => {},
      hook: async (
        _name: string,
        callback: (event: {sessionID: string}) => Promise<void>,
      ) => {
        admission = callback;
        return {
          dispose: async () => {
            admission = undefined;
          },
        };
      },
      update: async () => {},
      prompt: async () => {
        await admit();
        return admitted;
      },
      wait: async () => {},
      context: context
        ? async () => {
            contextReads++;
            const rows = await context();
            return Array.isArray(rows)
              ? [
                  admitted,
                  ...rows,
                  {type: 'idle', outcome: 'succeeded', time: {created: 4}},
                ]
              : rows;
          }
        : undefined,
      remove: async () => {
        deleted++;
      },
      interrupt: async () => {},
    },
  };
  const buffer = {
    bySession: new Map<string, unknown[]>([['child', [interim]]]),
  };
  return {
    ctx,
    buffer,
    final,
    admitted,
    admit,
    shim: createV2ClientShim(ctx as never, buffer),
    counts: () => ({created, deleted, contextReads}),
    input: {
      goal,
      taskId: goal.goalId,
      cwd: '/workspace',
      latestText: 'Done',
      candidateIdentity: {candidate: 'candidate', fingerprint: 'fingerprint'},
    },
  };
}

for (const failurePolicy of ['reject', 'approve'] as const) {
  test(`failed fresh context never reuses interim COMPLETE under ${failurePolicy}`, async () => {
    const host = scenario(async () => {
      throw new Error('post-turn context unavailable');
    });
    const running = createChildSessionVerifier(host.shim, {failurePolicy})(
      host.input,
    );
    if (failurePolicy === 'reject') {
      await expect(running).rejects.toThrow('post-turn context unavailable');
    } else {
      const result = await running;
      expect(result.state).toBe('WORKING');
      expect(result.outstanding.join(' ')).toContain(
        'post-turn context unavailable',
      );
    }
    expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 1});
  });
}

test('fresh final WORKING supersedes pre-turn COMPLETE', async () => {
  const host = scenario(async () => [host.final]);
  const result = await createChildSessionVerifier(host.shim)(host.input);
  expect(result.state).toBe('WORKING');
  expect(result.outstanding).toEqual(['The fixture is unfinished.']);
  expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 1});
});

test('a host without fresh context faults instead of attesting from its cache', async () => {
  const host = scenario(undefined);
  await expect(
    createChildSessionVerifier(host.shim)(host.input),
  ).rejects.toThrow('Fresh session context is unavailable');
  expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 0});
});

test('malformed fresh context faults instead of falling back to cached COMPLETE', async () => {
  const host = scenario(async () => ({unexpected: []}));
  await expect(
    createChildSessionVerifier(host.shim)(host.input),
  ).rejects.toThrow('Fresh session context did not contain messages');
  expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 1});
});

test('missing resolved v2 agent policy faults before creating a child', async () => {
  const host = scenario(async () => []);
  const shim = createV2ClientShim(
    {...host.ctx, agent: undefined} as never,
    host.buffer,
  );
  await expect(createChildSessionVerifier(shim)(host.input)).rejects.toThrow(
    'Resolved agent permission policy is unavailable',
  );
  expect(host.counts()).toEqual({created: 0, deleted: 0, contextReads: 0});
});

for (const failurePolicy of ['reject', 'approve'] as const) {
  test(`async admission without a completion wait cannot attest interim COMPLETE under ${failurePolicy}`, async () => {
    const host = scenario(async () => host.buffer.bySession.get('child'));
    const shim = createV2ClientShim(
      {...host.ctx, session: {...host.ctx.session, wait: undefined}} as never,
      host.buffer,
    );
    const running = createChildSessionVerifier(shim, {failurePolicy})(
      host.input,
    );
    if (failurePolicy === 'reject') {
      await expect(running).rejects.toThrow(
        'Session completion wait is unavailable',
      );
    } else {
      const result = await running;
      expect(result.state).toBe('WORKING');
      expect(result.outstanding.join(' ')).toContain(
        'Session completion wait is unavailable',
      );
    }
    expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 0});
  });
}

function completedReply(taskId: string) {
  return {
    parts: [
      {
        type: 'text',
        text: JSON.stringify({
          schema_version: 1,
          task_id: taskId,
          state: 'COMPLETE',
          outstanding: [],
          evidence: ['Synchronous completed response.'],
        }),
      },
    ],
  };
}

test('a synchronous assistant response does not require an asynchronous wait', async () => {
  const host = scenario(async () => {
    throw new Error('A synchronous response needs no context read.');
  });
  const shim = createV2ClientShim(
    {
      ...host.ctx,
      session: {
        ...host.ctx.session,
        wait: undefined,
        prompt: async () => {
          await host.admit();
          return completedReply(host.input.goal.goalId);
        },
      },
    } as never,
    host.buffer,
  );
  expect((await createChildSessionVerifier(shim)(host.input)).state).toBe(
    'COMPLETE',
  );
  expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 0});
});

test('an explicitly user-role response with text parts is admission, not a synchronous attestation', async () => {
  const host = scenario(async () => host.buffer.bySession.get('child'));
  const shim = createV2ClientShim(
    {
      ...host.ctx,
      session: {
        ...host.ctx.session,
        wait: undefined,
        prompt: async () => {
          await host.admit();
          return {
            ...completedReply(host.input.goal.goalId),
            info: {role: 'user'},
          };
        },
      },
    } as never,
    host.buffer,
  );
  await expect(createChildSessionVerifier(shim)(host.input)).rejects.toThrow(
    'Session completion wait is unavailable',
  );
  expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 0});
});

test('after waiting, user admission text cannot replace the fresh final verdict', async () => {
  const host = scenario(async () => [host.final]);
  const shim = createV2ClientShim(
    {
      ...host.ctx,
      session: {
        ...host.ctx.session,
        prompt: async () => {
          await host.admit();
          return {
            ...completedReply(host.input.goal.goalId),
            ...host.admitted,
          };
        },
      },
    } as never,
    host.buffer,
  );
  expect((await createChildSessionVerifier(shim)(host.input)).state).toBe(
    'WORKING',
  );
  expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 1});
});

for (const failurePolicy of ['reject', 'approve'] as const) {
  test(`a failed v2 assistant stream cannot attest its COMPLETE text under ${failurePolicy}`, async () => {
    const host = scenario(async () => [
      {
        type: 'assistant',
        id: 'failed-complete',
        content: completedReply(host.input.goal.goalId).parts,
        finish: 'error',
        error: {
          type: 'provider',
          message: 'Provider stream ended unexpectedly.',
        },
        time: {created: 1, completed: 2},
      },
    ]);
    const running = createChildSessionVerifier(host.shim, {failurePolicy})(
      host.input,
    );
    if (failurePolicy === 'reject') {
      await expect(running).rejects.toThrow(
        'Provider stream ended unexpectedly.',
      );
    } else {
      const result = await running;
      expect(result.state).toBe('WORKING');
      expect(result.outstanding.join(' ')).toContain(
        'Provider stream ended unexpectedly.',
      );
    }
    expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 1});
  });
}

test('a synchronous response carrying a failed assistant status is an operational fault', async () => {
  const host = scenario(undefined);
  const shim = createV2ClientShim(
    {
      ...host.ctx,
      session: {
        ...host.ctx.session,
        prompt: async () => {
          await host.admit();
          return {
            ...completedReply(host.input.goal.goalId),
            info: {role: 'assistant', finish: 'content-filter'},
          };
        },
      },
    } as never,
    host.buffer,
  );
  await expect(createChildSessionVerifier(shim)(host.input)).rejects.toThrow(
    'Child assistant failed: content-filter',
  );
  expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 0});
});

test('the legacy judge also rejects an approved marker retained by a failed stream', async () => {
  const host = scenario(async () => [
    {
      type: 'assistant',
      id: 'failed-approved',
      content: [{type: 'text', text: '[judge:approved]'}],
      finish: 'error',
      error: {type: 'provider', message: 'Provider failed after text.'},
    },
  ]);
  const result = await createChildSessionJudge(host.shim)({
    goal: host.input.goal,
    sessionID: 'parent',
    latestText: 'Done',
  });
  expect(result.approved).toBe(false);
  expect(result.reason).toContain('Provider failed after text.');
  expect(host.counts()).toEqual({created: 1, deleted: 1, contextReads: 1});
});
