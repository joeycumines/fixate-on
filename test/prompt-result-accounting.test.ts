import {expect, test} from 'bun:test';
import {handleCommand} from '../src/commands.ts';
import {executeDecision} from '../src/hooks-decision.ts';
import {handleProposeGoalChange} from '../src/tools.ts';
import {GoalStateMachine} from '../src/state-machine.ts';
import {createIdleStateFixture} from './idle-state-fixture.ts';
import {deferred} from './wait-for.ts';

type Fixture = ReturnType<typeof createIdleStateFixture>;
const busy = {error: {name: 'Error', message: 'session busy'}};
const failed = {error: {name: 'Error', message: 'provider unavailable'}};
const run = (fixture: Fixture) =>
  executeDecision(
    {type: 'continue', budgetWrapup: false, budgetLimit: false},
    fixture.session.sessionID,
    fixture.session,
    fixture.machine,
    fixture.deps,
  );

async function proposal(fixture: Fixture) {
  const result = JSON.parse(
    await handleProposeGoalChange(fixture.session, {
      reason: 'Record a more precise acceptance condition.',
      success_criteria: 'The revised test matrix passes.',
    }),
  );
  expect(result.error).toBeUndefined();
}

for (const reply of ['success', 'failure'] as const) {
  test(`a current ${reply} is accounted after a normal agent proposal`, async () => {
    const fixture = createIdleStateFixture({promptFailures: 2});
    fixture.deps.sessionApi.promptAsync = async () => {
      await proposal(fixture);
      return reply === 'success' ? {} : failed;
    };
    await run(fixture);
    expect(fixture.machine.state.pendingProposal).not.toBeNull();
    expect(fixture.machine.state.promptFailures).toBe(
      reply === 'success' ? 0 : 3,
    );
    expect(fixture.machine.state.status).toBe(
      reply === 'success' ? 'active' : 'paused',
    );
  });
}

test('same-prompt agent mutations cannot bypass the busy-deferral bound', async () => {
  const fixture = createIdleStateFixture();
  fixture.deps.sessionApi.promptAsync = async () => {
    await proposal(fixture);
    return busy;
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await run(fixture);
    expect(fixture.machine.state.status).toBe(
      attempt === 3 ? 'paused' : 'active',
    );
  }
  expect(fixture.machine.state.stopReason).toBe('deferred too many times');
});

for (const reply of ['success', 'failure', 'deferred'] as const) {
  test(`an active user edit still supersedes the old ${reply}`, async () => {
    const fixture = createIdleStateFixture({promptFailures: 2});
    const entered = deferred<void>();
    const finish = deferred<typeof failed | Record<string, never>>();
    fixture.deps.sessionApi.promptAsync = async () => {
      entered.resolve();
      return finish.promise;
    };
    const running = run(fixture);
    await entered.promise;
    await handleCommand(
      'edit The user replaced the objective',
      fixture.session,
    );
    const edited = fixture.machine.snapshot();
    finish.resolve(
      reply === 'success' ? {} : reply === 'failure' ? failed : busy,
    );
    await running;
    expect(fixture.machine.snapshot()).toEqual(edited);
    expect(fixture.runtime.deferCounts.size).toBe(0);
  });
}

test('resuming starts a fresh busy-deferral sequence', async () => {
  const fixture = createIdleStateFixture();
  fixture.deps.sessionApi.promptAsync = async () => busy;
  await run(fixture);
  await run(fixture);
  await handleCommand('pause', fixture.session);
  await handleCommand('resume', fixture.session);
  await run(fixture);
  expect(fixture.machine.state.status).toBe('active');
  expect(
    fixture.runtime.deferCounts.get(
      `${fixture.session.sessionID}:${fixture.machine.state.goalId}`,
    ),
  ).toBe(1);
});

test('a non-busy failure ends the prior consecutive busy-deferral sequence', async () => {
  const fixture = createIdleStateFixture();
  fixture.deps.sessionApi.promptAsync = async () => busy;
  await run(fixture);
  await run(fixture);
  fixture.deps.sessionApi.promptAsync = async () => failed;
  await run(fixture);
  fixture.deps.sessionApi.promptAsync = async () => busy;
  await run(fixture);
  expect(fixture.machine.state.status).toBe('active');
  expect(fixture.machine.state.promptFailures).toBe(1);
  expect(
    fixture.runtime.deferCounts.get(
      `${fixture.session.sessionID}:${fixture.machine.state.goalId}`,
    ),
  ).toBe(1);
});

test('rejected commands and rolled-back writes do not supersede a real prompt result', async () => {
  const fixture = createIdleStateFixture({promptFailures: 2});
  fixture.deps.sessionApi.promptAsync = async () => {
    await handleCommand('edit', fixture.session);
    const rejected = await fixture.machine.mutate(
      goal => {
        goal.maxTokens = 7;
      },
      {source: 'update_goal', detail: 'Reject protected budget change'},
    );
    expect(rejected.ok).toBe(false);
    await expect(
      fixture.machine.mutate(
        () => {
          throw new Error('rollback fixture');
        },
        {source: 'slash-command', detail: 'Rollback failed command'},
      ),
    ).rejects.toThrow('rollback fixture');
    return {};
  };
  await run(fixture);
  expect(fixture.machine.state.promptFailures).toBe(0);
  expect(fixture.machine.state.status).toBe('active');
});

for (const response of [busy, failed]) {
  test(`an active edit can retry after superseded ${response.error.message}`, async () => {
    const fixture = createIdleStateFixture({
      lastAssistantMessageID: 'prior-assistant',
    });
    const entered = deferred<void>();
    const finish = deferred<typeof failed>();
    let calls = 0;
    fixture.deps.sessionApi.promptAsync = async () => {
      if (++calls > 1) return {};
      entered.resolve();
      return finish.promise;
    };
    const running = run(fixture);
    await entered.promise;
    await handleCommand('edit Follow the revised objective', fixture.session);
    const edited = fixture.machine.snapshot();
    finish.resolve(response);
    await running;
    expect(fixture.machine.snapshot()).toEqual(edited);
    await run(fixture);
    await run(fixture);
    expect(calls).toBe(2);
    expect(fixture.machine.state.promptFailures).toBe(0);
  });
}

test('an agent proposal during preparation does not strand the undispatched claim', async () => {
  const fixture = createIdleStateFixture({
    lastAssistantMessageID: 'prior-assistant',
  });
  const initialTurns = fixture.machine.state.turnCount;
  const entered = deferred<void>();
  const release = deferred<void>();
  let first = true;
  const machine = new GoalStateMachine(fixture.machine.snapshot(), {
    onCommit: async () => {
      if (!first) return;
      first = false;
      entered.resolve();
      await release.promise;
    },
  });
  fixture.machine = machine;
  fixture.session.getMachine = () => machine;
  fixture.session.listMachines = () => [machine];
  fixture.runtime.sessionGoals.set(fixture.session.sessionID, [machine]);
  let calls = 0;
  fixture.deps.sessionApi.promptAsync = async () => {
    calls++;
    return {};
  };
  const running = run(fixture);
  await entered.promise;
  const changing = proposal(fixture);
  release.resolve();
  await Promise.all([running, changing]);
  expect(machine.state.pendingProposal).not.toBeNull();
  await run(fixture);
  expect(calls).toBe(1);
  expect(machine.state.turnCount).toBe(initialTurns + 1);
});
