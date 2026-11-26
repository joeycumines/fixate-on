import {expect, test} from 'bun:test';
import {handleCommand} from '../src/commands.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {processIdleEvent} from '../src/hooks-idle.ts';
import {trackTokenUsage} from '../src/hooks-usage.ts';
import {
  GoalStateMachine,
  type StateMachineCallbacks,
} from '../src/state-machine.ts';
import {createIdleStateFixture} from './idle-state-fixture.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return {promise, resolve};
}

function fixture(callbacks: StateMachineCallbacks = {}) {
  const f = createIdleStateFixture();
  const machine = new GoalStateMachine(f.machine.snapshot(), callbacks);
  let machines = [machine];
  let owned = true;
  let persists = 0;
  f.session.getMachine = () => machines[0] ?? null;
  f.session.listMachines = () => machines;
  f.session.listActiveGoals = () => machines.map(target => target.snapshot());
  f.session.persist = async () => {
    persists += 1;
    return true;
  };
  f.runtime.canDriveSession = () => owned;
  f.runtime.sessionGoals.set(f.session.sessionID, machines);
  return {
    ...f,
    machine,
    get persists() {
      return persists;
    },
    own(value: boolean) {
      owned = value;
    },
    list(next: GoalStateMachine[]) {
      machines = next;
      f.runtime.sessionGoals.set(f.session.sessionID, machines);
    },
    idle: () =>
      processIdleEvent(
        f.session.sessionID,
        f.session,
        machine,
        createLoopPolicy(),
        f.deps,
      ),
  };
}

type Fixture = ReturnType<typeof fixture>;
for (const cache of ['seenTokens', 'seenOutputTokens'] as const) {
  for (const value of [0, 4200]) {
    test(`${cache} alone prevents back-charging an observed message (${value})`, async () => {
      const f = fixture();
      const old = message(f, false);
      f.runtime[cache].set(old.id, value);
      const before = f.machine.snapshot().usage;
      await trackTokenUsage(
        f.session.sessionID,
        old,
        [f.machine],
        f.runtime,
        f.session,
      );
      expect(f.machine.state.usage).toEqual(before);
      await trackTokenUsage(
        f.session.sessionID,
        {...old, id: 'new-message'},
        [f.machine],
        f.runtime,
        f.session,
      );
      expect(f.machine.state.usage.input).toBe(before.input + 10);
      expect(f.machine.state.usage.output).toBe(before.output + 20);
    });
  }
}

type Loss = 'ownership' | 'removal' | 'disposal';
function lose(f: Fixture, loss: Loss) {
  if (loss === 'ownership') f.own(false);
  else if (loss === 'removal') f.list([]);
  else f.runtime.disposed = true;
}

function reading(f: Fixture) {
  return {
    id: f.session.sessionID,
    tokens: {input: 10, output: 20, reasoning: 0, cache: {read: 0, write: 0}},
    cost: 0,
  };
}

function message(f: Fixture, cumulative: boolean) {
  const value = reading(f);
  return cumulative
    ? {id: `${value.id}#usage`, role: 'assistant', info: value}
    : {
        id: 'usage-message',
        role: 'assistant',
        tokens: value.tokens,
        cost: value.cost,
      };
}

for (const loss of ['ownership', 'removal', 'disposal'] as const) {
  test(`an authoritative read returning after ${loss} cannot mutate or persist usage`, async () => {
    const f = fixture();
    const entered = deferred<void>();
    const response = deferred<unknown>();
    f.deps.sessionApi.usage = async () => {
      entered.resolve();
      return response.promise;
    };
    let messageReads = 0;
    f.deps.sessionApi.messages = async () => {
      messageReads += 1;
      return [];
    };
    const idle = f.idle();
    await entered.promise;
    lose(f, loss);
    const unowned = f.machine.snapshot();
    response.resolve(reading(f));
    await idle;
    expect(f.machine.snapshot()).toEqual(unowned);
    expect(f.persists).toBe(0);
    expect(f.runtime.seenUsage.size).toBe(0);
    expect(f.runtime.usageEventsObserved.size).toBe(0);
    expect(messageReads).toBe(0);
    expect(f.prompts).toHaveLength(0);
  });
}

for (const cumulative of [false, true]) {
  for (const loss of ['ownership', 'removal', 'disposal'] as const) {
    test(`${cumulative ? 'cumulative' : 'message'} accounting checks ${loss} after acquiring the state lock`, async () => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const f = fixture({
        onCommit: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const writer = f.machine.mutate(() => {}, {
        source: 'idle-handler',
        detail: 'Held tracking write',
        skipRevision: true,
      });
      await entered.promise;
      const tracking = trackTokenUsage(
        f.session.sessionID,
        message(f, cumulative),
        [f.machine],
        f.runtime,
        f.session,
        cumulative,
      );
      // Yield one event-loop turn so the accounting operation reaches the
      // already held state lock, while ownership is still valid.
      await Bun.sleep(0);
      lose(f, loss);
      const unowned = f.machine.snapshot();
      release.resolve();
      await writer;
      await tracking;
      expect(f.machine.snapshot()).toEqual(unowned);
      expect(f.runtime.seenUsage.size).toBe(0);
      expect(f.runtime.seenSessionUsage.size).toBe(0);
      expect(f.persists).toBe(0);
      expect(f.announcements).toHaveLength(0);
    });
  }

  test(`${cumulative ? 'cumulative' : 'message'} spend remains attributable when the same owned goal pauses and resumes`, async () => {
    const f = fixture();
    const entered = deferred<void>();
    const response = deferred<unknown>();
    if (cumulative)
      f.deps.sessionApi.usage = async () => {
        entered.resolve();
        return response.promise;
      };
    else
      f.deps.sessionApi.messages = async () => {
        entered.resolve();
        return (await response.promise) as unknown[];
      };
    const idle = f.idle();
    await entered.promise;
    await handleCommand('pause', f.session);
    await handleCommand('resume', f.session);
    const revision = f.machine.currentRevision;
    response.resolve(cumulative ? reading(f) : [message(f, false)]);
    await idle;
    expect(f.machine.state.usage.input).toBe(10);
    expect(f.machine.state.usage.output).toBe(20);
    expect(f.machine.currentRevision).toBe(revision);
    expect(f.machine.state.status).toBe('active');
    expect(f.machine.state.turnCount).toBe(0);
    expect(f.prompts).toHaveLength(0);
  });

  test(`a partially admitted ${cumulative ? 'cumulative' : 'message'} batch replays without losing or duplicating charges`, async () => {
    let interruptOnce = true;
    const f = fixture({
      onUsageUpdate: async () => {
        if (interruptOnce) {
          interruptOnce = false;
          f.own(false);
        }
      },
    });
    const seed = createIdleStateFixture().machine.snapshot();
    const second = new GoalStateMachine({...seed, goalId: 'second-goal'});
    f.list([f.machine, second]);
    const input = message(f, cumulative);
    await trackTokenUsage(
      f.session.sessionID,
      input,
      [f.machine, second],
      f.runtime,
      f.session,
      cumulative,
    );
    expect(f.machine.state.usage.input).toBe(10);
    expect(second.state.usage.input).toBe(0);
    expect(f.persists).toBe(0);

    f.own(true);
    const late = new GoalStateMachine({...seed, goalId: 'late-goal'});
    const live = [f.machine, second, late];
    f.list(live);
    await trackTokenUsage(
      f.session.sessionID,
      input,
      live,
      f.runtime,
      f.session,
      cumulative,
    );
    await trackTokenUsage(
      f.session.sessionID,
      input,
      live,
      f.runtime,
      f.session,
      cumulative,
    );
    for (const paid of [f.machine, second]) {
      expect(paid.state.usage.input).toBe(10);
      expect(paid.state.usage.output).toBe(20);
      expect(paid.state.totalTokens).toBe(30);
    }
    expect(late.state.usage.input).toBe(0);
    expect(late.state.usage.output).toBe(0);
  });
}

test('concurrent copies of a message update are charged once', async () => {
  const f = fixture();
  const input = message(f, false);
  await Promise.all([
    trackTokenUsage(
      f.session.sessionID,
      input,
      [f.machine],
      f.runtime,
      f.session,
    ),
    trackTokenUsage(
      f.session.sessionID,
      input,
      [f.machine],
      f.runtime,
      f.session,
    ),
  ]);
  expect(f.machine.state.usage.input).toBe(10);
  expect(f.machine.state.usage.output).toBe(20);
  expect([...f.machine.state.messageIDs]).toEqual(['usage-message']);
});

test('a completed message receipt respects the compaction history boundary', async () => {
  const f = fixture();
  const input = message(f, false);
  await trackTokenUsage(
    f.session.sessionID,
    input,
    [f.machine],
    f.runtime,
    f.session,
  );
  await f.hooks.event!({
    type: 'session.compacted',
    sessionID: f.session.sessionID,
  });
  const compacted = f.machine.snapshot();
  await trackTokenUsage(
    f.session.sessionID,
    {
      ...input,
      tokens: {input: 10, output: 30},
    },
    [f.machine],
    f.runtime,
    f.session,
  );
  expect(f.machine.snapshot()).toEqual(compacted);
});

test('a migration admitted before ownership loss is retained without a stale persistence or announcement', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = fixture({
    onUsageUpdate: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await f.machine.mutate(
    goal => {
      goal.lastSessionUsage = undefined;
    },
    {
      source: 'idle-handler',
      detail: 'Legacy restored state',
      skipPersist: true,
    },
  );
  const update = trackTokenUsage(
    f.session.sessionID,
    message(f, true),
    [f.machine],
    f.runtime,
    f.session,
    true,
    async text => {
      f.announcements.push(text);
    },
  );
  await entered.promise;
  const admitted = f.machine.snapshot();
  expect(
    admitted.pendingNotices.some(notice => notice.kind === 'usage-baseline'),
  ).toBe(true);
  f.own(false);
  release.resolve();
  await update;
  expect(f.machine.snapshot()).toEqual(admitted);
  expect(f.persists).toBe(0);
  expect(f.announcements).toHaveLength(0);
});
