import {expect, test} from 'bun:test';
import {handleCommand} from '../src/commands.ts';
import {executeDecision, sendRecoveryPrompt} from '../src/hooks-decision.ts';
import type {HookDeps} from '../src/hooks-types.ts';
import {trackTokenUsage} from '../src/hooks-usage.ts';
import {handleUpdateGoal} from '../src/tools.ts';
import {validatePendingIntent} from '../src/continuation-loop.ts';
import {GoalStateMachine, type PendingIntent} from '../src/state-machine.ts';
import {createIdleStateFixture} from './idle-state-fixture.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function heldPrompt() {
  const fixture = createIdleStateFixture();
  const admitted = deferred<void>();
  const response = deferred<{error?: {name?: string; message?: string}}>();
  fixture.deps.sessionApi.promptAsync = async (_sid, input) => {
    fixture.prompts.push(input);
    admitted.resolve();
    return response.promise;
  };
  return {...fixture, admitted, response};
}

async function restart(fixture: ReturnType<typeof heldPrompt>) {
  await handleCommand('pause', fixture.session);
  await handleCommand('resume', fixture.session);
  expect(fixture.machine.state.status).toBe('active');
  expect(fixture.machine.state.turnCount).toBe(0);
}

for (const reply of ['failure', 'success', 'deferred', 'throw'] as const) {
  test(`a late ${reply} cannot modify a resumed continuation window`, async () => {
    const f = heldPrompt();
    f.deps.defaultOpts = {maxPromptFailures: 1} as HookDeps['defaultOpts'];
    const running = executeDecision(
      {type: 'continue', budgetWrapup: false, budgetLimit: false},
      f.session.sessionID,
      f.session,
      f.machine,
      f.deps,
    );
    await f.admitted.promise;
    await restart(f);
    // The resumed window may already have recorded another availability fault.
    await f.machine.mutate(
      goal => {
        goal.promptFailures = 2;
      },
      {
        source: 'idle-handler',
        detail: 'New window read fault',
        skipRevision: true,
      },
    );
    const resumed = f.machine.snapshot();
    if (reply === 'throw') f.response.reject(new Error('old transport failed'));
    else
      f.response.resolve(
        reply === 'success'
          ? {}
          : {
              error: {
                name: 'Error',
                message: reply === 'deferred' ? 'session busy' : 'failed',
              },
            },
      );
    await running;
    expect(f.machine.snapshot()).toEqual(resumed);
    expect(f.runtime.deferCounts.size).toBe(0);
    expect(f.runtime.promptInFlightSessions.size).toBe(0);
  });
}

test('old wrap-up cleanup cannot clear a newer prompt finalizing flag', async () => {
  const f = heldPrompt();
  const older = executeDecision(
    {type: 'continue', budgetWrapup: true, budgetLimit: false},
    f.session.sessionID,
    f.session,
    f.machine,
    f.deps,
  );
  await f.admitted.promise;
  await restart(f);
  const newerAdmitted = deferred<void>();
  const newerResponse = deferred<{}>();
  f.deps.sessionApi.promptAsync = async () => {
    newerAdmitted.resolve();
    return newerResponse.promise;
  };
  const newer = executeDecision(
    {type: 'continue', budgetWrapup: true, budgetLimit: false},
    f.session.sessionID,
    f.session,
    f.machine,
    f.deps,
  );
  await newerAdmitted.promise;
  const newerState = f.machine.snapshot();
  expect(newerState.finalizing).toBe(true);
  f.response.resolve({error: {name: 'Error', message: 'old admission failed'}});
  await older;
  expect(f.machine.snapshot()).toEqual(newerState);
  expect(f.runtime.promptInFlightSessions.has(f.session.sessionID)).toBe(true);
  newerResponse.resolve({});
  await newer;
  expect(f.machine.state.finalizing).toBe(false);
  expect(f.runtime.promptInFlightSessions.size).toBe(0);
});

for (const rollback of [
  'rejected brake change',
  'throwing mutation',
] as const) {
  test(`a ${rollback} does not strand a current wrap-up finalizing flag`, async () => {
    const f = heldPrompt();
    const running = executeDecision(
      {type: 'continue', budgetWrapup: true, budgetLimit: false},
      f.session.sessionID,
      f.session,
      f.machine,
      f.deps,
    );
    await f.admitted.promise;
    const revision = f.machine.currentRevision;
    if (rollback === 'rejected brake change') {
      const rejected = await f.machine.mutate(
        goal => {
          goal.maxTokens = 100;
        },
        {source: 'update_goal', detail: 'Attempt protected brake mutation'},
      );
      expect(rejected.ok).toBe(false);
    } else {
      await expect(
        f.machine.mutate(
          goal => {
            goal.lastStatus = 'Partial mutation';
            throw new Error('fixture rollback');
          },
          {source: 'idle-handler', detail: 'Throw after partial mutation'},
        ),
      ).rejects.toThrow('fixture rollback');
    }
    expect(f.machine.currentRevision).toBe(revision);
    f.response.resolve({});
    await running;
    expect(f.machine.state.finalizing).toBe(false);
  });
}

for (const loss of [
  'ownership',
  'removal',
  'disposal',
  'objective edit',
] as const) {
  test(`late prompt result cannot mutate after ${loss}`, async () => {
    const f = heldPrompt();
    const running = executeDecision(
      {type: 'continue', budgetWrapup: false, budgetLimit: false},
      f.session.sessionID,
      f.session,
      f.machine,
      f.deps,
    );
    await f.admitted.promise;
    if (loss === 'ownership') f.runtime.canDriveSession = () => false;
    else if (loss === 'removal') f.session.listMachines = () => [];
    else if (loss === 'disposal') f.runtime.disposed = true;
    else await handleCommand('edit Complete the new objective', f.session);
    const changed = f.machine.snapshot();
    f.response.resolve({error: {name: 'Error'}});
    await running;
    expect(f.machine.snapshot()).toEqual(changed);
  });
}

for (const budgetWrapup of [false, true]) {
  test(`a queued ${budgetWrapup ? 'wrap-up cleanup' : 'prompt response'} checks its guard after the newer pause acquires the lock`, async () => {
    const f = heldPrompt();
    const entered = deferred<void>();
    const release = deferred<void>();
    const machine = new GoalStateMachine(f.machine.snapshot(), {
      onCommit: async (_snapshot, transition) => {
        if (transition.detail === 'Hold a tracking writer') {
          entered.resolve();
          await release.promise;
        }
      },
    });
    f.session.getMachine = () => machine;
    f.session.listMachines = () => [machine];
    f.session.listActiveGoals = () => [machine.snapshot()];
    f.runtime.sessionGoals.set(f.session.sessionID, [machine]);
    const running = executeDecision(
      {type: 'continue', budgetWrapup, budgetLimit: false},
      f.session.sessionID,
      f.session,
      machine,
      f.deps,
    );
    await f.admitted.promise;
    const writer = machine.mutate(() => {}, {
      source: 'idle-handler',
      detail: 'Hold a tracking writer',
      skipRevision: true,
    });
    await entered.promise;
    const pause = machine.transition('paused', {
      source: 'slash-command',
      stopReason: 'explicit pause',
    });
    f.response.resolve({});
    // Releasing the prompt reservation precedes both cleanup and response
    // bookkeeping. The pause is already ahead of either operation in the lock.
    while (f.runtime.promptInFlightSessions.has(f.session.sessionID))
      await Bun.sleep(1);
    release.resolve();
    await writer;
    await pause;
    const paused = machine.snapshot();
    await running;
    expect(machine.snapshot()).toEqual(paused);
  });
}

for (const busy of [false, true]) {
  test(`current ${busy ? 'busy deferrals' : 'prompt failures'} still pause at the default three-attempt bound`, async () => {
    const f = heldPrompt();
    f.deps.sessionApi.promptAsync = async () => ({
      error: {
        name: 'Error',
        message: busy ? 'session busy' : 'provider failed',
      },
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await executeDecision(
        {type: 'continue', budgetWrapup: false, budgetLimit: false},
        f.session.sessionID,
        f.session,
        f.machine,
        f.deps,
      );
      expect(f.machine.state.status).toBe(attempt === 3 ? 'paused' : 'active');
    }
    expect(f.machine.state.promptFailures).toBe(3);
    expect(f.machine.state.stopReason).toBe(
      busy ? 'deferred too many times' : 'auto-continue failures',
    );
    if (busy) expect(f.machine.state.turnCount).toBe(1);
  });
}

test('discarding an old prompt result preserves the actual spend observed after resume', async () => {
  const f = heldPrompt();
  const running = executeDecision(
    {type: 'continue', budgetWrapup: false, budgetLimit: false},
    f.session.sessionID,
    f.session,
    f.machine,
    f.deps,
  );
  await f.admitted.promise;
  await restart(f);
  await trackTokenUsage(
    f.session.sessionID,
    {id: 'paid-output', role: 'assistant', tokens: {input: 40, output: 70}},
    [f.machine],
    f.runtime,
    f.session,
  );
  const charged = f.machine.snapshot();
  expect(charged.usage.input).toBe(40);
  expect(charged.usage.output).toBe(70);
  f.response.resolve({error: {name: 'Error'}});
  await running;
  expect(f.machine.snapshot()).toEqual(charged);
});

for (const budgetWrapup of [false, true]) {
  test(`successful ${budgetWrapup ? 'wrap-up' : 'ordinary'} prompt preserves its completion intent revision`, async () => {
    const f = heldPrompt();
    let intent: PendingIntent | null = null;
    f.session.setPendingIntent = (_goalId, next) => {
      intent = next;
    };
    f.session.getPendingIntent = () => intent;
    const running = executeDecision(
      {type: 'continue', budgetWrapup, budgetLimit: false},
      f.session.sessionID,
      f.session,
      f.machine,
      f.deps,
    );
    await f.admitted.promise;
    await handleUpdateGoal(f.session, {status: 'complete'});
    expect(intent).not.toBeNull();
    const claimedRevision = f.machine.currentRevision;
    f.response.resolve({});
    await running;
    expect(f.machine.currentRevision).toBe(claimedRevision);
    expect(validatePendingIntent(intent!, f.machine.snapshot()).valid).toBe(
      true,
    );
    expect(f.machine.state.finalizing).toBe(false);
  });
}

test('an agent bookkeeping mutation does not strand this prompt finalizing flag', async () => {
  const f = heldPrompt();
  const running = executeDecision(
    {type: 'continue', budgetWrapup: true, budgetLimit: false},
    f.session.sessionID,
    f.session,
    f.machine,
    f.deps,
  );
  await f.admitted.promise;
  await handleUpdateGoal(f.session, {status: 'blocked'});
  const currentRevision = f.machine.currentRevision;
  f.response.resolve({});
  await running;
  expect(f.machine.currentRevision).toBe(currentRevision);
  expect(f.machine.state.finalizing).toBe(false);
  expect(f.machine.state.blockedTurns).toBe(1);
});

for (const reply of ['failure', 'deferred'] as const) {
  test(`a current wrap-up ${reply} remains eligible for bounded retry`, async () => {
    const f = heldPrompt();
    const running = executeDecision(
      {type: 'continue', budgetWrapup: true, budgetLimit: false},
      f.session.sessionID,
      f.session,
      f.machine,
      f.deps,
    );
    await f.admitted.promise;
    f.response.resolve({
      error: {
        name: 'Error',
        message: reply === 'deferred' ? 'session busy' : 'failed',
      },
    });
    await running;
    expect(f.machine.state.finalizing).toBe(false);
    expect(f.machine.state.budgetWrapupSent).toBe(false);
    expect(f.machine.state.status).toBe('active');
  });
}

function recovery(f: ReturnType<typeof heldPrompt>) {
  return sendRecoveryPrompt(
    f.session.sessionID,
    f.session,
    f.machine,
    f.deps,
    {
      schema_version: 1,
      task_id: 'task',
      state: 'WORKING',
      candidate: 'head',
      fingerprint: 'tree',
      outstanding: ['remaining check'],
      evidence: ['review evidence'],
    },
    {recoveryTurns: 1, maxRecoveryTurns: 12},
    {
      taskID: 'task',
      recoveryTurns: 1,
      unchangedResults: 0,
      lastCandidate: 'head',
      lastFingerprint: 'tree',
    },
    null,
  );
}

for (const gate of ['persistence', 'announcement'] as const) {
  test(`recovery preparation cancelled during ${gate} does not start a later model turn`, async () => {
    const f = heldPrompt();
    const entered = deferred<void>();
    const release = deferred<void>();
    let once = false;
    const holdOnce = async () => {
      if (!once) {
        once = true;
        entered.resolve();
        await release.promise;
      }
      return true;
    };
    if (gate === 'persistence') f.session.persist = holdOnce;
    else
      f.deps.announceGoalDecision = async () => {
        await holdOnce();
      };
    const running = recovery(f);
    await entered.promise;
    await restart(f);
    const resumed = f.machine.snapshot();
    release.resolve();
    f.response.resolve({});
    await running;
    expect(f.machine.snapshot()).toEqual(resumed);
    expect(f.prompts).toHaveLength(0);
  });
}

for (const kind of ['stop', 'budget-limit'] as const) {
  for (const gate of ['persistence', 'response'] as const) {
    test(`${kind} cannot send or promote newer goals after ${gate} yields`, async () => {
      const f = heldPrompt();
      let promoted = 0;
      f.session.isOrdered = () => true;
      f.session.autoPromote = async () => {
        promoted += 1;
      };
      const entered = deferred<void>();
      const release = deferred<void>();
      if (gate === 'persistence')
        f.session.persist = async () => {
          entered.resolve();
          await release.promise;
          return true;
        };
      const running = executeDecision(
        kind === 'stop'
          ? {type: 'stop', reason: 'max turns'}
          : {type: 'budget-limit'},
        f.session.sessionID,
        f.session,
        f.machine,
        f.deps,
      );
      await (gate === 'persistence' ? entered.promise : f.admitted.promise);
      f.session.listMachines = () => [];
      const removed = f.machine.snapshot();
      release.resolve();
      f.response.resolve({});
      await running;
      expect(f.machine.snapshot()).toEqual(removed);
      expect(promoted).toBe(0);
      expect(f.prompts).toHaveLength(gate === 'persistence' ? 0 : 1);
    });
  }
}
