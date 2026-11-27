import {expect, test} from 'bun:test';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {deferred} from './wait-for.ts';

for (const operation of ['mutation', 'transition'] as const) {
  test(`${operation} guard observes ownership after acquiring the state lock`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let commits = 0;
    const machine = new GoalStateMachine(createGoalState('session', 'goal'), {
      onCommit: async () => {
        if (++commits === 1) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const first = machine.mutate(
      goal => {
        goal.condition = 'new objective';
      },
      {
        source: 'slash-command',
        detail: 'first command',
      },
    );
    await entered.promise;
    const before = machine.snapshot();
    let owned = true;
    let guardCalls = 0;
    let callbackCalls = 0;
    const guard = () => {
      guardCalls++;
      return owned;
    };
    const pending =
      operation === 'mutation'
        ? machine.mutate(
            () => {
              callbackCalls++;
            },
            {
              source: 'idle-handler',
              detail: 'stale observation',
              guard,
            },
          )
        : machine.transition('paused', {
            source: 'idle-handler',
            detail: 'stale observation',
            guard,
          });
    expect(guardCalls).toBe(0);
    owned = false;
    release.resolve();
    await first;
    expect((await pending).ok).toBe(false);
    expect(guardCalls).toBe(1);
    expect(callbackCalls).toBe(0);
    expect(commits).toBe(1);
    expect(machine.snapshot()).toEqual(before);
  });

  test(`${operation} guard refusal precedes terminal validation`, async () => {
    const machine = new GoalStateMachine({
      ...createGoalState('session', 'goal'),
      status: 'budgetLimited',
    });
    const before = machine.snapshot();
    let guardCalls = 0;
    const guard = () => {
      guardCalls++;
      return false;
    };
    const result =
      operation === 'mutation'
        ? await machine.mutate(
            () => {
              throw new Error('must not run');
            },
            {
              source: 'idle-handler',
              detail: 'stale observation',
              guard,
            },
          )
        : await machine.transition('paused', {source: 'idle-handler', guard});
    expect(guardCalls).toBe(1);
    expect(result).toEqual({
      ok: false,
      error: `goal changed before the ${operation}`,
    });
    expect(machine.snapshot()).toEqual(before);
  });
}

test('a guarded tracking mutation preserves a valid completion revision', async () => {
  const machine = new GoalStateMachine(createGoalState('session', 'goal'));
  const observed = machine.snapshot();
  const result = await machine.mutate(
    goal => {
      goal.promptFailures++;
    },
    {
      source: 'idle-handler',
      detail: 'observed read failure',
      guard: goal => goal.revision === observed.revision,
      skipRevision: true,
    },
  );
  expect(result).toEqual({ok: true, revision: observed.revision});
  expect(machine.state.promptFailures).toBe(1);
  expect(machine.state.history.at(-1)?.type).toBe('tracking');
  expect(
    (
      await machine.transition('paused', {
        source: 'idle-handler',
        guard: goal => goal.promptFailures === 1,
      })
    ).ok,
  ).toBe(true);
  expect(machine.state.revision).toBe(observed.revision + 1);
});
