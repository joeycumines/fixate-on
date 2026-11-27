import {expect, test} from 'bun:test';
import {createOpenCodeSessionApi} from '../src/session-api.ts';
import {createHooks} from '../src/hooks.ts';
import {recordIdleReadFailure} from '../src/hooks-idle.ts';
import {GoalStateMachine} from '../src/state-machine.ts';
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
  const paused = fixture.machine.snapshot();
  finishRead.resolve();
  await idle;
  expect(fixture.machine.snapshot()).toEqual(paused);
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
  const resumed = fixture.machine.snapshot();
  finishRead.resolve();
  await idle;
  expect(fixture.machine.snapshot()).toEqual(resumed);
  expect(fixture.machine.state.status).toBe('active');
  expect(fixture.machine.state.promptFailures).toBe(0);
  expect(fixture.machine.state.pendingNotices).toHaveLength(0);
  expect(fixture.announcements).toHaveLength(0);
});

for (const invalidation of ['ownership', 'removal', 'disposal'] as const) {
  test(`read failure queued before ${invalidation} cannot mutate the goal`, async () => {
    const fixture = createIdleStateFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const machine = new GoalStateMachine(fixture.machine.snapshot(), {
      onCommit: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    fixture.session.getMachine = () => machine;
    fixture.session.listMachines = () => [machine];
    let persists = 0;
    fixture.session.persist = async () => {
      persists++;
      return true;
    };
    const lock = machine.mutate(() => {}, {
      source: 'idle-handler',
      detail: 'prior bookkeeping',
      skipRevision: true,
    });
    await entered.promise;
    const before = machine.snapshot();
    const failed = recordIdleReadFailure(
      fixture.session.sessionID,
      fixture.session,
      machine,
      fixture.deps,
      before,
      new Error('read failed'),
    );
    if (invalidation === 'ownership')
      fixture.runtime.canDriveSession = () => false;
    else if (invalidation === 'removal')
      fixture.session.listMachines = () => [];
    else fixture.runtime.disposed = true;
    release.resolve();
    await lock;
    await failed;
    expect(machine.snapshot()).toEqual(before);
    expect(persists).toBe(0);
    expect(fixture.announcements).toHaveLength(0);
  });
}

test('ownership lost after counting a read failure cannot pause or announce it', async () => {
  const fixture = createIdleStateFixture({promptFailures: 2, finalizing: true});
  const mutate = fixture.machine.mutate.bind(fixture.machine);
  fixture.machine.mutate = async (fn, opts) => {
    const result = await mutate(fn, opts);
    if (opts.detail === 'Session state read failed before continuation')
      fixture.runtime.canDriveSession = () => false;
    return result;
  };
  let persists = 0;
  fixture.session.persist = async () => {
    persists++;
    return true;
  };
  await recordIdleReadFailure(
    fixture.session.sessionID,
    fixture.session,
    fixture.machine,
    fixture.deps,
    fixture.machine.snapshot(),
    new Error('read failed'),
  );
  expect(fixture.machine.state.status).toBe('active');
  expect(fixture.machine.state.finalizing).toBe(true);
  expect(fixture.machine.state.pendingNotices).toHaveLength(0);
  expect(persists).toBe(0);
  expect(fixture.announcements).toHaveLength(0);
});

test('a resume during pause persistence suppresses late failure notice insertion', async () => {
  const fixture = createIdleStateFixture({promptFailures: 2});
  const entered = deferred<void>();
  const release = deferred<void>();
  const machine = new GoalStateMachine(fixture.machine.snapshot(), {
    onCommit: async (_snapshot, transition) => {
      if (transition.to === 'paused') {
        entered.resolve();
        await release.promise;
      }
    },
  });
  fixture.session.getMachine = () => machine;
  fixture.session.listMachines = () => [machine];
  const failed = recordIdleReadFailure(
    fixture.session.sessionID,
    fixture.session,
    machine,
    fixture.deps,
    machine.snapshot(),
    new Error('read failed'),
  );
  await entered.promise;
  const resume = machine.transition('active', {source: 'slash-command'});
  release.resolve();
  await resume;
  const resumed = machine.snapshot();
  await failed;
  expect(machine.snapshot()).toEqual(resumed);
  expect(machine.state.pendingNotices).toHaveLength(0);
  expect(fixture.announcements).toHaveLength(0);
});

test('a resume while a read-failure receipt is being persisted suppresses its stale announcement', async () => {
  const fixture = createIdleStateFixture({promptFailures: 2});
  const entered = deferred<void>();
  const release = deferred<void>();
  fixture.session.persist = async () => {
    entered.resolve();
    await release.promise;
    return true;
  };
  const failed = recordIdleReadFailure(
    fixture.session.sessionID,
    fixture.session,
    fixture.machine,
    fixture.deps,
    fixture.machine.snapshot(),
    new Error('read failed'),
  );
  await entered.promise;
  await fixture.machine.transition('active', {source: 'slash-command'});
  release.resolve();
  await failed;
  expect(fixture.machine.state.status).toBe('active');
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
