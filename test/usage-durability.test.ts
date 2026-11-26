import {expect, test} from 'bun:test';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {processIdleEvent} from '../src/hooks-idle.ts';
import {trackTokenUsage} from '../src/hooks-usage.ts';
import {deserializeGoal, serializeGoal} from '../src/persistence.ts';
import {GoalStateMachine} from '../src/state-machine.ts';
import {createIdleStateFixture} from './idle-state-fixture.ts';
import {deferred} from './wait-for.ts';

type Fixture = ReturnType<typeof createIdleStateFixture>;
type Saved = ReturnType<typeof serializeGoal>;

function save(machines: GoalStateMachine[]): Saved[] {
  return JSON.parse(JSON.stringify(machines.map(m => serializeGoal(m.state))));
}

function install(f: Fixture, machines: GoalStateMachine[]) {
  f.session.getMachine = () => machines[0] ?? null;
  f.session.listMachines = () => machines;
  f.session.listActiveGoals = () => machines.map(m => m.snapshot());
  f.runtime.sessionGoals.set(f.session.sessionID, machines);
}

function restore(saved: Saved[]) {
  const f = createIdleStateFixture();
  const machines = saved.map(s => new GoalStateMachine(deserializeGoal(s)));
  install(f, machines);
  return {...f, machines};
}

function message(id = 'usage-message', input = 10, output = 20, cost = 0.1) {
  return {id, role: 'assistant', tokens: {input, output}, cost};
}

function track(f: Fixture, input: Record<string, unknown>, cumulative = false) {
  return trackTokenUsage(
    f.session.sessionID,
    input,
    f.session.listMachines!(),
    f.runtime,
    f.session,
    cumulative,
    async text => {
      f.announcements.push(text);
    },
  );
}

for (const cumulative of [false, true]) {
  test(`${cumulative ? 'cumulative' : 'message'} charges survive replay after a cold restart`, async () => {
    const f = createIdleStateFixture();
    const input = message();
    await track(f, input, cumulative);
    const recovered = restore(save([f.machine]));
    await track(recovered, input, cumulative);
    await track(recovered, input, cumulative);
    expect(recovered.machines[0].state.usage).toMatchObject({
      input: 10,
      output: 20,
      cost: 0.1,
    });
  });

  test(`a persisted partial ${cumulative ? 'cumulative' : 'message'} batch restores both charged and pending baselines`, async () => {
    const f = createIdleStateFixture();
    let owned = true;
    let saved: Saved[] = [];
    let live: GoalStateMachine[] = [];
    const first = new GoalStateMachine(f.machine.snapshot(), {
      onUsageUpdate: async () => {
        saved = save(live);
        owned = false;
      },
    });
    const second = new GoalStateMachine({
      ...f.machine.snapshot(),
      goalId: 'second-goal',
    });
    live = [first, second];
    install(f, live);
    f.runtime.canDriveSession = () => owned;
    const input = message();
    await track(f, input, cumulative);
    expect(first.state.usage.input).toBe(10);
    expect(second.state.usage.input).toBe(0);
    expect(saved).toHaveLength(2);

    const recovered = restore(saved);
    const late = new GoalStateMachine({
      ...createIdleStateFixture().machine.snapshot(),
      goalId: 'late-goal',
    });
    install(recovered, [...recovered.machines, late]);
    await track(recovered, input, cumulative);
    await track(recovered, input, cumulative);
    for (const machine of recovered.machines)
      expect(machine.state.usage).toMatchObject({
        input: 10,
        output: 20,
        cost: 0.1,
      });
    expect(late.state.usage.input).toBe(0);
    expect(late.state.usage.cost).toBe(0);
  });
}

test('missing or reduced cumulative message cost cannot be charged again', async () => {
  const f = createIdleStateFixture();
  const input = message();
  await track(f, input);
  const {cost: _cost, ...missingCost} = input;
  await track(f, missingCost);
  await track(f, {...input, cost: 0.05});
  const recovered = restore(save([f.machine]));
  await track(recovered, input);
  expect(recovered.machines[0].state.usage).toMatchObject({
    input: 10,
    output: 20,
    cost: 0.1,
    costKnown: true,
  });
});

test('compaction tombstones survive restart without recharging old messages', async () => {
  const f = createIdleStateFixture();
  const input = message();
  await track(f, input);
  await f.hooks.event!({
    type: 'session.compacted',
    sessionID: f.session.sessionID,
  });
  const recovered = restore(save([f.machine]));
  const compacted = recovered.machines[0].snapshot();
  await track(recovered, {...input, tokens: {input: 10, output: 30}});
  expect(recovered.machines[0].snapshot()).toEqual(compacted);
});

test('the first streamed event stops an already running history usage scan', async () => {
  let entered!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>(resolve => {
    entered = resolve;
  });
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const f = createIdleStateFixture();
  let once = true;
  const machine = new GoalStateMachine(f.machine.snapshot(), {
    onUsageUpdate: async () => {
      if (!once) return;
      once = false;
      entered();
      await pending;
    },
  });
  install(f, [machine]);
  f.deps.sessionApi.messages = async () => [
    message('first-history', 5, 5, 0),
    message('streamed-message', 8, 10, 0.05),
  ];
  const idle = processIdleEvent(
    f.session.sessionID,
    f.session,
    machine,
    createLoopPolicy(),
    f.deps,
  );
  await admitted;
  const event = f.hooks.event!({
    type: 'message.updated',
    sessionID: f.session.sessionID,
    properties: {info: message('streamed-message')},
  });
  await Bun.sleep(0);
  release();
  await Promise.all([idle, event]);
  expect(machine.state.usage).toMatchObject({
    input: 15,
    output: 25,
    cost: 0.1,
  });
});

for (const cumulative of [false, true]) {
  for (const exit of ['settled', 'removed'] as const) {
    test(`a ${exit} peer during ${cumulative ? 'cumulative' : 'message'} preparation cannot discard another active goal's spend`, async () => {
      const f = createIdleStateFixture();
      const entered = deferred<void>();
      const release = deferred<void>();
      const queued = deferred<void>();
      const second = new GoalStateMachine(
        {...f.machine.snapshot(), goalId: 'second-goal'},
        {
          onCommit: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      );
      install(f, [f.machine, second]);
      if (cumulative) {
        const prepare = second.prepareCumulativeUsage.bind(second);
        second.prepareCumulativeUsage = (...args) => {
          queued.resolve();
          return prepare(...args);
        };
      } else {
        const prepare = second.prepareMessageUsage.bind(second);
        second.prepareMessageUsage = (...args) => {
          queued.resolve();
          return prepare(...args);
        };
      }
      const held = second.mutate(() => {}, {
        source: 'idle-handler',
        detail: 'Hold peer before accounting preparation',
        skipRevision: true,
      });
      await entered.promise;
      const settling =
        exit === 'settled'
          ? second.transition('complete', {source: 'completion-gate'})
          : Promise.resolve();
      const observed = track(f, message(), cumulative);
      await queued.promise;
      if (exit === 'removed') install(f, [f.machine]);
      release.resolve();
      await Promise.all([held, settling, observed]);
      expect(second.state.usage.input).toBe(0);
      expect(f.machine.state.usage).toMatchObject({
        input: 10,
        output: 20,
        cost: 0.1,
      });
    });
  }

  test(`a snapshot taken partway through ${cumulative ? 'cumulative' : 'message'} preparation recovers original peers and excludes a later goal`, async () => {
    const f = createIdleStateFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const queued = deferred<void>();
    const second = new GoalStateMachine(
      {...f.machine.snapshot(), goalId: 'second-goal'},
      {
        onCommit: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    );
    install(f, [f.machine, second]);
    if (cumulative) {
      const prepare = second.prepareCumulativeUsage.bind(second);
      second.prepareCumulativeUsage = (...args) => {
        queued.resolve();
        return prepare(...args);
      };
    } else {
      const prepare = second.prepareMessageUsage.bind(second);
      second.prepareMessageUsage = (...args) => {
        queued.resolve();
        return prepare(...args);
      };
    }
    const held = second.mutate(() => {}, {
      source: 'idle-handler',
      detail: 'Hold peer before preparation',
      skipRevision: true,
    });
    await entered.promise;
    const observed = track(f, message(), cumulative);
    await queued.promise;
    const saved = save([f.machine, second]);
    f.runtime.canDriveSession = () => false;
    release.resolve();
    await Promise.all([held, observed]);
    const recovered = restore(saved);
    const late = new GoalStateMachine({
      ...createIdleStateFixture().machine.snapshot(),
      goalId: 'late-goal',
    });
    install(recovered, [...recovered.machines, late]);
    await track(recovered, message(), cumulative);
    for (const machine of recovered.machines)
      expect(machine.state.usage).toMatchObject({input: 10, output: 20});
    expect(late.state.usage.input).toBe(0);
  });
}

test('per-step token decreases still charge after receipt restoration', async () => {
  const f = createIdleStateFixture();
  await track(f, message());
  const recovered = restore(save([f.machine]));
  const step = message('usage-message', 8, 5, 0.1);
  await track(recovered, step);
  await track(recovered, step);
  expect(recovered.machines[0].state.usage).toMatchObject({
    input: 18,
    output: 25,
    cost: 0.1,
  });
});

for (const dated of [false, true]) {
  test(`legacy ${dated ? 'dated' : 'undated'} history preserves spend and reports its unknown baseline`, async () => {
    const f = createIdleStateFixture();
    await track(f, message());
    const saved = save([f.machine]);
    delete saved[0].messageUsage;
    saved[0].messageIDs = []; // Older compaction snapshots lost these IDs.
    const recovered = restore(saved);
    const boundary = recovered.machines[0].state.messageUsageBaselineAt!;
    const historical = {
      ...message(),
      ...(dated ? {time: {created: boundary - 1}} : {}),
    };
    await track(recovered, historical);
    expect(recovered.machines[0].state.usage).toMatchObject({
      input: 10,
      output: 20,
      cost: 0.1,
    });
    expect(recovered.announcements).toHaveLength(1);
    expect(recovered.announcements[0]).toContain('cannot be reconstructed');
    const again = restore(save(recovered.machines));
    expect(again.machines[0].state.messageUsageBaselineAt).toBe(boundary);
    await track(again, historical);
    await track(again, {...historical, tokens: {input: 10, output: 21}});
    await track(again, {
      ...message('new-message', 3, 4, 0.02),
      time: {created: boundary + 1},
    });
    expect(again.machines[0].state.usage).toMatchObject({
      input: 13,
      output: 25,
    });
    expect(again.announcements).toHaveLength(0);
  });
}

test('a legacy historical message with initially missing cost baselines its first known cost', async () => {
  const f = createIdleStateFixture();
  await track(f, message());
  const saved = save([f.machine]);
  delete saved[0].messageUsage;
  const recovered = restore(saved);
  const {cost: _cost, ...unknownCost} = message();
  await track(recovered, unknownCost);
  const again = restore(save(recovered.machines));
  await track(again, message());
  expect(again.machines[0].state.usage.cost).toBe(0.1);
  await track(again, message('usage-message', 8, 5, 0.2));
  expect(again.machines[0].state.usage).toMatchObject({
    input: 18,
    output: 25,
    cost: 0.2,
  });
});

test('a new message with initially missing cost charges its first known cost', async () => {
  const f = createIdleStateFixture();
  const {cost: _cost, ...unknownCost} = message();
  await track(f, unknownCost);
  await track(f, message());
  expect(f.machine.state.usage.cost).toBe(0.1);
});

test('invalid durable receipts migrate explicitly instead of treating old spend as zero', async () => {
  const f = createIdleStateFixture();
  await track(f, message());
  const saved = save([f.machine]);
  saved[0].messageUsage![0][1].reading.usage.input = -1;
  const recovered = restore(saved);
  await track(recovered, message());
  expect(recovered.machines[0].state.usage).toMatchObject({
    input: 10,
    output: 20,
    cost: 0.1,
  });
  expect(recovered.announcements).toHaveLength(1);
});

test('snapshot and rollback copies isolate nested durable message receipts', async () => {
  const f = createIdleStateFixture();
  await track(f, message());
  const snapshot = f.machine.snapshot();
  snapshot.messageUsage!.get('usage-message')!.reading.usage.input = 900;
  const serialized = serializeGoal(f.machine.state);
  serialized.messageUsage![0][1].reading.usage.output = 900;
  expect(
    f.machine.state.messageUsage!.get('usage-message')!.reading.usage,
  ).toMatchObject({input: 10, output: 20});
  await expect(
    f.machine.mutate(
      goal => {
        goal.messageUsage!.get('usage-message')!.reading.usage.input = 700;
        throw new Error('Reject this change');
      },
      {source: 'idle-handler', detail: 'Failed callback', skipPersist: true},
    ),
  ).rejects.toThrow('Reject this change');
  await track(f, message());
  expect(f.machine.state.usage).toMatchObject({input: 10, output: 20});
});

test('receipts protect retained and evicted replay across restart at the 1000-message boundary', async () => {
  const f = createIdleStateFixture();
  for (let n = 1; n <= 1001; n++)
    await track(f, {
      ...message(`m-${n}`, 1, 2, 0),
      time: {created: n},
    });
  expect(f.machine.state.messageUsage!.size).toBe(1000);
  expect(f.machine.state.usage.input).toBe(1001);
  expect(f.announcements).toHaveLength(1);
  const recovered = restore(save([f.machine]));
  for (const n of [2, 1, 2])
    await track(recovered, {
      ...message(`m-${n}`, 1, 2, 0),
      time: {created: n},
    });
  await track(recovered, message('undated-history', 1, 2, 0));
  expect(recovered.machines[0].state.usage.input).toBe(1001);
  await track(recovered, {
    ...message('new-message', 1, 2, 0),
    time: {created: Date.now() + 1},
  });
  expect(recovered.machines[0].state.usage.input).toBe(1002);
  expect(recovered.machines[0].state.messageUsage!.size).toBe(1000);
  // The same eviction boundary must work without a restart, when runtime
  // caches still remember the evicted message.
  for (const output of [3, 4])
    await track(f, {
      ...message('m-1', 1, output, 0),
      time: {created: 1},
    });
  expect(f.machine.state.usage.output).toBe(2003);
});

test('a streamed event fences history usage that is waiting for the state lock', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const queued = deferred<void>();
  const f = createIdleStateFixture();
  const machine = new GoalStateMachine(f.machine.snapshot(), {
    onCommit: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  install(f, [machine]);
  const prepare = machine.prepareMessageUsage.bind(machine);
  machine.prepareMessageUsage = (...args) => {
    queued.resolve();
    return prepare(...args);
  };
  const held = machine.mutate(() => {}, {
    source: 'idle-handler',
    detail: 'Hold state lock before history attribution',
    skipRevision: true,
  });
  await entered.promise;
  f.deps.sessionApi.messages = async () => [
    message('usage-message', 8, 10, 0.05),
  ];
  const idle = processIdleEvent(
    f.session.sessionID,
    f.session,
    machine,
    createLoopPolicy(),
    f.deps,
  );
  await queued.promise;
  const event = f.hooks.event!({
    type: 'message.updated',
    sessionID: f.session.sessionID,
    properties: {info: message()},
  });
  await Bun.sleep(0);
  release.resolve();
  await Promise.all([held, idle, event]);
  expect(machine.state.usage).toMatchObject({input: 10, output: 20, cost: 0.1});
});
