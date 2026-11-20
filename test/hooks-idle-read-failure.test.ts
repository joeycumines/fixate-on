import {expect, test} from 'bun:test';
import {createOpenCodeSessionApi} from '../src/session-api.ts';
import {createHooks} from '../src/hooks.ts';
import {createIdleStateFixture, idleAssistant} from './idle-state-fixture.ts';
import {deferred, waitFor} from './wait-for.ts';

test('HTTP SDK message error envelopes pause a missing session within the failure bound', async () => {
  const fixture = createIdleStateFixture();
  let reads = 0;
  fixture.deps.sessionApi.messages = createOpenCodeSessionApi({
    session: {
      messages: async () => {
        reads++;
        return {
          error: {name: 'NotFoundError', data: {message: 'Resource not found'}},
          response: {status: 404},
        };
      },
    },
  }).messages;
  for (let i = 0; i < 4; i++) await fixture.idle();
  expect(reads).toBe(3);
  expect(fixture.prompts).toHaveLength(0);
  expect(fixture.machine.snapshot()).toMatchObject({
    status: 'paused',
    stopReason: 'session not found',
    promptFailures: 3,
    turnCount: 1,
  });
  expect(fixture.announcements).toHaveLength(1);
  expect(fixture.announcements[0]).toContain('no longer exists');
  expect(fixture.machine.state.pendingNotices[0]?.kind).toBe('prompt-failure');
});

test('transient message read failures are bounded and pause with a visible receipt', async () => {
  const fixture = createIdleStateFixture();
  fixture.deps.sessionApi.messages = async () => {
    throw new Error('transport temporarily unavailable');
  };
  await fixture.idle();
  await fixture.idle();
  expect(fixture.machine.state.status).toBe('active');
  expect(fixture.machine.state.promptFailures).toBe(2);
  await fixture.idle();
  expect(fixture.machine.state.status).toBe('paused');
  expect(fixture.machine.state.stopReason).toBe('auto-continue failures');
  expect(fixture.prompts).toHaveLength(0);
  expect(fixture.announcements).toHaveLength(1);
  expect(fixture.announcements[0]).toContain('/goal resume');
});

test('a successful continuation clears preceding transient read failures', async () => {
  const fixture = createIdleStateFixture();
  let reads = 0;
  fixture.deps.sessionApi.messages = async () => {
    if (++reads < 3) throw new Error('temporary transport failure');
    return [idleAssistant('fresh', 'Made useful progress.', 100)];
  };
  await fixture.idle();
  await fixture.idle();
  await fixture.idle();
  expect(fixture.machine.state.status).toBe('active');
  expect(fixture.machine.state.promptFailures).toBe(0);
  expect(fixture.prompts).toHaveLength(1);
  expect(fixture.announcements).toHaveLength(0);
});

test('a late failed read cannot replace a newer explicit pause', async () => {
  const fixture = createIdleStateFixture({promptFailures: 2});
  const finishRead = deferred<void>();
  fixture.deps.sessionApi.messages = async () => {
    await finishRead.promise;
    throw new Error('temporary read failure');
  };
  const idle = fixture.idle();
  await fixture.machine.transition('paused', {
    source: 'chat-message',
    stopReason: 'explicit pause',
  });
  finishRead.resolve();
  await idle;
  expect(fixture.machine.state.stopReason).toBe('explicit pause');
  expect(fixture.machine.state.promptFailures).toBe(2);
  expect(fixture.prompts).toHaveLength(0);
  expect(fixture.announcements).toHaveLength(0);
});

test('a failed read from before resume cannot charge the fresh run window', async () => {
  const fixture = createIdleStateFixture({promptFailures: 2});
  const finishRead = deferred<void>();
  fixture.deps.sessionApi.messages = async () => {
    await finishRead.promise;
    throw new Error('read from before resume failed');
  };
  const idle = fixture.idle();
  await fixture.machine.transition('paused', {source: 'slash-command'});
  await fixture.machine.transition('active', {source: 'slash-command'});
  finishRead.resolve();
  await idle;
  expect(fixture.machine.state.status).toBe('active');
  expect(fixture.machine.state.promptFailures).toBe(0);
  expect(fixture.announcements).toHaveLength(0);
});

test('a newer resume between failure counting and pausing wins the transition', async () => {
  const fixture = createIdleStateFixture({promptFailures: 2});
  fixture.deps.sessionApi.messages = async () => {
    throw new Error('host unavailable');
  };
  const mutate = fixture.machine.mutate.bind(fixture.machine);
  fixture.machine.mutate = async (fn, opts) => {
    const result = await mutate(fn, opts);
    if (opts.detail === 'Session state read failed before continuation') {
      await fixture.machine.transition('paused', {source: 'slash-command'});
      await fixture.machine.transition('active', {source: 'slash-command'});
    }
    return result;
  };
  await fixture.idle();
  expect(fixture.machine.state.status).toBe('active');
  expect(fixture.machine.state.promptFailures).toBe(0);
  expect(fixture.announcements).toHaveLength(0);
});

test('the fallback poller bounds missing-session reads without synthesizing a turn', async () => {
  const fixture = createIdleStateFixture();
  let reads = 0;
  fixture.deps.sessionApi.messages = createOpenCodeSessionApi({
    session: {
      messages: async () => {
        reads++;
        return {
          error: {name: 'NotFoundError', data: {message: 'Resource not found'}},
          response: {status: 404},
        };
      },
    },
  }).messages;
  createHooks({
    ...fixture.deps,
    idlePoller: true,
    idlePollerIntervalMs: 5,
    idleQuietMs: 0,
    idleGraceMs: 0,
  });
  try {
    await waitFor(
      () => fixture.announcements.length === 1,
      'missing session polling pause receipt',
    );
    expect(reads).toBe(3);
    expect(fixture.machine.state.status).toBe('paused');
    expect(fixture.machine.state.stopReason).toBe('session not found');
    expect(fixture.machine.state.promptFailures).toBe(3);
    expect(fixture.prompts).toHaveLength(0);
    expect(fixture.machine.state.turnCount).toBe(1);
  } finally {
    fixture.runtime.disposed = true;
  }
});

for (const missing of [true, false]) {
  test(`failed authoritative usage ${missing ? 'lookup' : 'validation'} cannot drive with stale counters`, async () => {
    const fixture = createIdleStateFixture({maxTokens: 10000});
    fixture.setMessages([idleAssistant('fresh', 'Made useful progress.', 100)]);
    fixture.deps.sessionApi.usage = async () => {
      if (missing) throw new Error('could not read cumulative usage');
      return {id: fixture.session.sessionID, tokens: {input: 0}};
    };
    for (let i = 0; i < 3; i++) await fixture.idle();
    expect(fixture.machine.state.status).toBe('paused');
    expect(fixture.machine.state.stopReason).toBe('auto-continue failures');
    expect(fixture.prompts).toHaveLength(0);
    expect(fixture.announcements).toHaveLength(1);
  });
}
