import {expect, spyOn, test} from 'bun:test';
import {createV2ClientShim} from '../src/plugin-v2.ts';
import {createChildSessionVerifier} from '../src/child-session-verifier.ts';
import {createGoalState} from '../src/state-machine.ts';

function host(remove: () => Promise<unknown>) {
  let removes = 0;
  const ctx = {
    agent: {get: async () => ({id: 'goal-verify', permissions: []})},
    session: {
      get: async ({sessionID}: {sessionID: string}) => ({
        id: sessionID,
        location: {directory: '/fixture'},
        permissions: [],
      }),
      create: async (): Promise<unknown> => ({id: 'orphan'}),
      prompt: async () => {
        throw new Error('Unexpected prompt');
      },
      remove: async () => {
        removes++;
        return remove();
      },
    },
  };
  const goal = createGoalState('parent', 'Verify', {goalId: 'goal'});
  return {
    ctx,
    count: () => removes,
    shim: createV2ClientShim(ctx as never, {bySession: new Map()}),
    input: {
      goal,
      taskId: goal.goalId,
      latestText: 'Done',
      cwd: '/fixture',
      candidateIdentity: {candidate: 'candidate', fingerprint: 'fingerprint'},
    },
  };
}

for (const envelope of [false, true]) {
  test(`a parent-stripping host retains ${envelope ? 'enveloped' : 'thrown'} orphan cleanup failure`, async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fixture = host(async () => {
        const error = new Error('Controlled deletion storage failure');
        if (envelope) return {error};
        throw error;
      });
      await expect(
        createChildSessionVerifier(fixture.shim)(fixture.input),
      ).rejects.toThrow('child-session cleanup failed (child orphan):');
      expect(fixture.count()).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain(
        'Controlled deletion storage failure',
      );
    } finally {
      log.mockRestore();
    }
  });
}

test('late orphan cleanup failure remains observable after the verifier deadline', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const fixture = host(async () => {
      throw new Error('Late storage failure');
    });
    let created!: (value: unknown) => void;
    fixture.ctx.session.create = () =>
      new Promise(resolve => {
        created = resolve;
      });
    await expect(
      createChildSessionVerifier(fixture.shim, {timeoutMs: 10})(fixture.input),
    ).rejects.toThrow('timed out');
    expect(fixture.count()).toBe(0);
    created({id: 'orphan'});
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.count()).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(
      'child-session cleanup failed (child orphan): Late storage failure',
    );
  } finally {
    log.mockRestore();
  }
});

test('a typed missing receipt for the orphan does not invent a cleanup failure', async () => {
  const fixture = host(async () => {
    throw {_tag: 'Session.NotFoundError', sessionID: 'orphan'};
  });
  const error = await createChildSessionVerifier(fixture.shim)(
    fixture.input,
  ).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('parent-bound session creation unsupported');
  expect(error.message).not.toContain('cleanup failed');
  expect(fixture.count()).toBe(1);
});
