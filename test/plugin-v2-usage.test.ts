import {expect, test} from 'bun:test';
import {setup} from '../src/plugin-v2.ts';
import {SessionStateManager} from '../src/session-state-manager.ts';
import {deserializeGoal, serializeGoal} from '../src/persistence.ts';
import {GoalStateMachine} from '../src/state-machine.ts';
import {
  cumulativeSessionUsageMessage,
  trackTokenUsage,
} from '../src/hooks-usage.ts';
import {createIdleStateFixture} from './idle-state-fixture.ts';
import {TEST_WORKSPACE_DIR} from './identity-stub.ts';
import {deferred, waitFor} from './wait-for.ts';

function usage(sessionID: string, input: number, output: number, cost = 0) {
  return {
    id: sessionID,
    cost,
    tokens: {input, output, reasoning: 0, cache: {read: 0, write: 0}},
  };
}

test('a cumulative reading queued behind settlement cannot charge the terminal goal', async () => {
  const fixture = createIdleStateFixture();
  const sessionID = fixture.session.sessionID;
  const mutationEntered = deferred<void>();
  const finishMutation = deferred<void>();
  const usageQueued = deferred<void>();
  const machine = new GoalStateMachine(fixture.machine.snapshot(), {
    onCommit: async (_snapshot, transition) => {
      if (transition.detail === 'hold mutex before settlement') {
        mutationEntered.resolve();
        await finishMutation.promise;
      }
    },
  });
  const update = machine.updateCumulativeUsage.bind(machine);
  machine.updateCumulativeUsage = (...args) => {
    usageQueued.resolve();
    return update(...args);
  };
  const held = machine.mutate(() => {}, {
    source: 'idle-handler',
    detail: 'hold mutex before settlement',
  });
  await mutationEntered.promise;
  const settled = machine.transition('complete', {source: 'completion-gate'});
  const observed = trackTokenUsage(
    sessionID,
    cumulativeSessionUsageMessage(sessionID, usage(sessionID, 900, 100, 1)),
    [machine],
    fixture.runtime,
    fixture.session,
    true,
  );
  // The attribution's outer nonterminal check has passed; its actual mutation
  // waits behind a settlement already queued on the state-machine mutex.
  await usageQueued.promise;
  finishMutation.resolve();
  await Promise.all([held, settled, observed]);
  expect(machine.state.status).toBe('complete');
  expect(machine.state.usage).toEqual(fixture.machine.state.usage);
  expect(machine.state.lastSessionUsage).toBeNull();
  expect(machine.state.totalTokens).toBe(0);
});

test('replaying the same cumulative usage after restart does not charge it twice', async () => {
  const before = createIdleStateFixture();
  const sessionID = before.session.sessionID;
  const observed = cumulativeSessionUsageMessage(
    sessionID,
    usage(sessionID, 900, 100, 1),
  );
  await trackTokenUsage(
    sessionID,
    observed,
    [before.machine],
    before.runtime,
    before.session,
    true,
  );
  const restored = createIdleStateFixture(
    deserializeGoal(
      JSON.parse(JSON.stringify(serializeGoal(before.machine.snapshot()))),
    ),
  );
  await trackTokenUsage(
    sessionID,
    observed,
    [restored.machine],
    restored.runtime,
    restored.session,
    true,
  );
  expect(restored.machine.state.usage).toEqual(before.machine.state.usage);
  expect(restored.machine.state.totalTokens).toBe(1000);
});

test('a goal added after another goal retains its own charged delta across restart and resume', async () => {
  const first = createIdleStateFixture({goalId: 'first'});
  const second = createIdleStateFixture({goalId: 'later'});
  const sessionID = first.session.sessionID;
  await trackTokenUsage(
    sessionID,
    cumulativeSessionUsageMessage(sessionID, usage(sessionID, 900, 100, 1)),
    [first.machine],
    first.runtime,
    first.session,
    true,
  );
  await trackTokenUsage(
    sessionID,
    cumulativeSessionUsageMessage(sessionID, usage(sessionID, 1300, 200, 2)),
    [first.machine, second.machine],
    first.runtime,
    first.session,
    true,
  );
  expect(first.machine.state.usage.input).toBe(1300);
  expect(second.machine.state.usage).toMatchObject({
    input: 400,
    output: 100,
    cost: 1,
  });
  const restored = [first, second].map(fixture =>
    createIdleStateFixture(
      deserializeGoal(
        JSON.parse(JSON.stringify(serializeGoal(fixture.machine.snapshot()))),
      ),
    ),
  );
  await restored[1]!.machine.transition('paused', {source: 'slash-command'});
  await restored[1]!.machine.transition('active', {source: 'slash-command'});
  const restoredRuntime = restored[0]!.runtime;
  const machines = restored.map(fixture => fixture.machine);
  await trackTokenUsage(
    sessionID,
    cumulativeSessionUsageMessage(sessionID, usage(sessionID, 1600, 300, 3)),
    machines,
    restoredRuntime,
    restored[0]!.session,
    true,
  );
  expect(machines[0]!.state.usage).toMatchObject({
    input: 1600,
    output: 300,
    cost: 3,
  });
  expect(machines[1]!.state.usage).toMatchObject({
    input: 700,
    output: 200,
    cost: 2,
  });
  // Reading an older event after the restart cannot undo the retained watermark.
  await trackTokenUsage(
    sessionID,
    cumulativeSessionUsageMessage(sessionID, usage(sessionID, 1300, 200, 2)),
    machines,
    restoredRuntime,
    restored[0]!.session,
    true,
  );
  expect(machines[1]!.state.usage).toMatchObject({
    input: 700,
    output: 200,
    cost: 2,
  });
});

test('legacy restored usage keeps recorded spend and persists one explicit migration receipt', async () => {
  const legacy = serializeGoal(
    createIdleStateFixture({
      totalTokens: 1000,
      usage: {
        input: 300,
        output: 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.5,
        costKnown: true,
      },
    }).machine.snapshot(),
  );
  delete legacy.lastSessionUsage;
  const fixture = createIdleStateFixture(deserializeGoal(legacy));
  const sessionID = fixture.session.sessionID;
  const receipts: string[] = [];
  let saved: ReturnType<typeof serializeGoal> | undefined;
  fixture.session.persist = async () => {
    saved = JSON.parse(
      JSON.stringify(serializeGoal(fixture.machine.snapshot())),
    );
    return true;
  };
  const observe = (input: number, cost: number) =>
    trackTokenUsage(
      sessionID,
      cumulativeSessionUsageMessage(
        sessionID,
        usage(sessionID, input, 100, cost),
      ),
      [fixture.machine],
      fixture.runtime,
      fixture.session,
      true,
      async message => {
        receipts.push(message);
      },
    );
  await observe(1400, 3);
  expect(fixture.machine.state.usage).toEqual(legacy.usage);
  expect(fixture.machine.state.totalTokens).toBe(1500);
  expect(saved?.lastSessionUsage).toMatchObject({
    input: 1400,
    output: 100,
    cost: 3,
  });
  expect(saved?.pendingNotices).toHaveLength(1);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toContain('cannot be reconstructed');
  await observe(1400, 3);
  expect(receipts).toHaveLength(1);
  await observe(1500, 4);
  expect(fixture.machine.state.usage).toMatchObject({
    input: 400,
    output: 100,
    cost: 1.5,
  });
  const reloaded = createIdleStateFixture(deserializeGoal(saved));
  await trackTokenUsage(
    sessionID,
    cumulativeSessionUsageMessage(sessionID, usage(sessionID, 1500, 100, 4)),
    [reloaded.machine],
    reloaded.runtime,
    reloaded.session,
    true,
    async message => {
      receipts.push(message);
    },
  );
  expect(reloaded.machine.state.usage).toEqual(fixture.machine.state.usage);
  expect(receipts).toHaveLength(1);
});

test('new, malformed, and observed cumulative watermarks remain distinct after serialization', async () => {
  const fixture = createIdleStateFixture();
  const fresh = serializeGoal(fixture.machine.snapshot());
  expect(deserializeGoal(fresh).lastSessionUsage).toBeNull();
  expect(
    deserializeGoal({...fresh, lastSessionUsage: {input: 'bad'}})
      .lastSessionUsage,
  ).toBeUndefined();
  const sessionID = fixture.session.sessionID;
  await trackTokenUsage(
    sessionID,
    cumulativeSessionUsageMessage(sessionID, usage(sessionID, 900, 100, 1)),
    [fixture.machine],
    fixture.runtime,
    fixture.session,
    true,
  );
  const snapshot = fixture.machine.snapshot();
  const saved = serializeGoal(fixture.machine.state);
  snapshot.lastSessionUsage!.input = 0;
  saved.lastSessionUsage!.input = 0;
  expect(fixture.machine.state.lastSessionUsage!.input).toBe(900);
});

test('delayed cumulative readings cannot lower a baseline and double-charge a later increment', async () => {
  const fixture = createIdleStateFixture();
  const sessionID = fixture.session.sessionID;
  const observe = (input: number, output: number, cost: number) =>
    trackTokenUsage(
      sessionID,
      cumulativeSessionUsageMessage(
        sessionID,
        usage(sessionID, input, output, cost),
      ),
      [fixture.machine],
      fixture.runtime,
      fixture.session,
      true,
    );
  await observe(900, 100, 1);
  // The direct idle read races the old stream reading, including an older cost.
  await Promise.all([
    observe(19700, 300, 3),
    observe(900, 100, 1),
    observe(1900, 100, 2),
  ]);
  expect(fixture.machine.state.totalTokens).toBe(20000);
  expect(fixture.machine.state.usage).toMatchObject({
    input: 19700,
    output: 300,
    cost: 3,
  });
  await observe(20600, 400, 4);
  expect(fixture.machine.state.totalTokens).toBe(21000);
  expect(fixture.machine.state.usage).toMatchObject({
    input: 20600,
    output: 400,
    cost: 4,
  });
  expect(fixture.runtime.seenSessionUsage.get(sessionID)).toEqual(
    fixture.machine.state.usage,
  );
});

test('authoritative session totals include reasoning and both cache fields', async () => {
  const fixture = createIdleStateFixture();
  const sessionID = fixture.session.sessionID;
  const observed = {
    id: sessionID,
    cost: 1.5,
    tokens: {
      input: 100,
      output: 200,
      reasoning: 300,
      cache: {read: 400, write: 500},
    },
  };
  await trackTokenUsage(
    sessionID,
    cumulativeSessionUsageMessage(sessionID, observed),
    [fixture.machine],
    fixture.runtime,
    fixture.session,
    true,
  );
  expect(fixture.machine.state.totalTokens).toBe(1500);
  expect(fixture.machine.state.usage).toEqual({
    input: 100,
    output: 200,
    reasoning: 300,
    cacheRead: 400,
    cacheWrite: 500,
    cost: 1.5,
    costKnown: true,
  });
});

test('native idle refreshes durable totals while another session blocks the usage event consumer', async () => {
  type Event = {id?: string; type: string; data: Record<string, unknown>};
  const pending: Event[] = [];
  let waiter: ((value: IteratorResult<Event>) => void) | undefined;
  let closed = false;
  const push = (event: Event) => {
    if (waiter) {
      const callback = waiter;
      waiter = undefined;
      callback({done: false, value: event});
    } else pending.push(event);
  };
  const events = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Event>> {
          const event = pending.shift();
          if (event) return {done: false, value: event};
          if (closed) return {done: true, value: undefined};
          return new Promise(resolve => {
            waiter = resolve;
          });
        },
        async return(): Promise<IteratorResult<Event>> {
          closed = true;
          waiter?.({done: true, value: undefined});
          return {done: true, value: undefined};
        },
      };
    },
  };
  const sessionID = 'native-idle-budget';
  const otherID = 'native-idle-other';
  const totals = new Map([
    [sessionID, usage(sessionID, 900, 100)],
    [otherID, usage(otherID, 10, 10)],
  ]);
  const sessionHooks = new Map<string, (input: unknown) => Promise<void>>();
  const tools = new Map<
    string,
    {execute: (input: unknown, context: unknown) => Promise<unknown>}
  >();
  const prompts: Array<{sessionID: string; text: string}> = [];
  const blockedPersist = deferred<void>();
  const releasePersist = deferred<void>();
  let block = false;
  let listMachines: SessionStateManager['listMachines'] | undefined;
  const originalCommit = SessionStateManager.prototype.createOnCommit;
  const originalPersist = SessionStateManager.prototype.persist;
  SessionStateManager.prototype.createOnCommit = function () {
    listMachines = this.listMachines.bind(this);
    return originalCommit.call(this);
  };
  SessionStateManager.prototype.persist = async function (id: string) {
    if (block && id === otherID) {
      block = false;
      blockedPersist.resolve();
      await releasePersist.promise;
    }
    return originalPersist.call(this, id);
  };
  const messages = [
    {
      id: 'msg_00000000000100000000000000',
      type: 'assistant',
      agent: 'build',
      finish: 'stop',
      time: {created: Date.now() - 10, completed: Date.now() - 1},
      tokens: {
        input: 18800,
        output: 200,
        reasoning: 0,
        cache: {read: 0, write: 0},
      },
      content: [
        {type: 'text', text: 'Made progress; another work step remains.'},
      ],
    },
  ];
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = await setup({
      app: {name: 'test'},
      location: {directory: TEST_WORKSPACE_DIR},
      options: {
        persistState: false,
        idlePoller: false,
        childSessionJudge: false,
        maxTokens: 10000,
        minDelayMs: 0,
        noToolCallTurnsBeforePause: 0,
        noProgressTurnsBeforePause: 100,
        goalMessenger: async () => {},
      },
      session: {
        hook: async (
          name: string,
          callback: (input: unknown) => Promise<void>,
        ) => {
          sessionHooks.set(name, callback);
          return {dispose: async () => {}};
        },
        synthetic: async (input: {sessionID: string; text: string}) => {
          prompts.push(input);
          return {};
        },
        prompt: async () => ({}),
        command: async () => ({}),
        create: async () => ({}),
        get: async (input: {sessionID: string}) => totals.get(input.sessionID),
        interrupt: async () => ({}),
        generate: async () => ({}),
        context: async () => messages,
      },
      event: {subscribe: () => events},
      tool: {
        transform: async (callback: (draft: unknown) => void) => {
          callback({
            add: (tool: {
              name: string;
              execute: (input: unknown, context: unknown) => Promise<unknown>;
            }) => {
              tools.set(tool.name, tool);
            },
          });
          return {dispose: async () => {}};
        },
      },
      command: {transform: async () => ({dispose: async () => {}})},
    } as never);
    for (const id of [otherID, sessionID]) {
      await tools
        .get('create_goal')!
        .execute(
          {objective: 'Do useful work until independently verified.'},
          {sessionID: id},
        );
    }
    expect(listMachines).toBeDefined();
    const machine = listMachines!(sessionID)[0]!;
    push({
      type: 'session.usage.updated',
      data: {sessionID, ...totals.get(sessionID)},
    });
    await waitFor(() => machine.state.totalTokens === 1000, 'initial usage');
    block = true;
    push({
      type: 'session.usage.updated',
      data: {sessionID: otherID, ...totals.get(otherID)},
    });
    await blockedPersist.promise;
    totals.set(sessionID, usage(sessionID, 19700, 300));
    push({
      type: 'session.usage.updated',
      data: {sessionID, ...totals.get(sessionID)},
    });
    await sessionHooks.get('experimental.idle')!({sessionID, background: []});
    expect(
      prompts.filter(
        p => p.sessionID === sessionID && p.text.includes('Continue working'),
      ),
    ).toHaveLength(0);
    expect(machine.snapshot()).toMatchObject({
      totalTokens: 20000,
      status: 'paused',
      stopReason: 'max context tokens reached',
    });
    expect(machine.state.usage.input).toBe(19700);
    releasePersist.resolve();
    await waitFor(
      () => pending.length === 0 && waiter !== undefined,
      'event consumer caught up',
    );
    // The late stream delivery must not add the freshly reconciled usage again.
    expect(machine.state.usage.input).toBe(19700);
    expect(machine.state.usage.output).toBe(300);
    expect(machine.state.totalTokens).toBe(20000);
  } finally {
    releasePersist.resolve();
    await dispose?.();
    SessionStateManager.prototype.createOnCommit = originalCommit;
    SessionStateManager.prototype.persist = originalPersist;
  }
});
