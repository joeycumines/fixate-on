import {expect, test} from 'bun:test';
import {
  type CommitTransition,
  createGoalState,
  type GoalState,
  GoalStateMachine,
  type GoalStatus,
  type TransitionResult,
} from '../src/state-machine.ts';

function makeSM(overrides: Partial<GoalState> = {}): GoalStateMachine {
  const goal = createGoalState('s1', 'test goal');
  return new GoalStateMachine({...goal, ...overrides});
}

// Transition Table

test('active → paused is permitted', async () => {
  const sm = makeSM({status: 'active'});
  const result = await sm.transition('paused', {
    source: 'slash-command',
    detail: 'user paused',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('paused');
  expect(sm.state.stopReason).toBe('');
  expect(sm.state.pausedAt).toBeGreaterThan(0);
});

test('active → blocked is permitted', async () => {
  const sm = makeSM({status: 'active'});
  const result = await sm.transition('blocked', {
    source: 'update_goal',
    blockedReason: 'missing dependency',
    detail: 'agent reported blocked',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('blocked');
  expect(sm.state.blockedReason).toBe('missing dependency');
});

test('active → finalizing is permitted', async () => {
  const sm = makeSM({status: 'active'});
  const result = await sm.transition('finalizing', {
    source: 'idle-handler',
    stopReason: 'budget exhausted',
    detail: 'budget limit reached',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('finalizing');
});

test('active → complete is permitted', async () => {
  const sm = makeSM({status: 'active'});
  const result = await sm.transition('complete', {
    source: 'update_goal',
    detail: 'goal achieved',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('complete');
  expect(sm.state.finishedAt).toBeGreaterThan(0);
});

test('blocked → complete sets finishedAt to completion time, not block time', async () => {
  const blockTime = Date.now() - 10000;
  const sm = makeSM({status: 'blocked', pausedAt: blockTime});
  const beforeTransition = Date.now();
  const result = await sm.transition('complete', {
    source: 'update_goal',
    detail: 'goal achieved after unblocking',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('complete');
  expect(sm.state.finishedAt).toBeGreaterThanOrEqual(beforeTransition);
  expect(sm.state.finishedAt).not.toBe(blockTime);
});

test('paused → active (resume) is permitted', async () => {
  const sm = makeSM({status: 'paused', pausedAt: Date.now()});
  const result = await sm.transition('active', {
    source: 'slash-command',
    detail: 'user resumed',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('active');
  expect(sm.state.pausedAt).toBe(0);
  expect(sm.state.stopReason).toBe('');
});

// Guard A: Terminal States

test('budgetLimited → active is rejected (terminal)', async () => {
  const sm = makeSM({status: 'budgetLimited', budgetLimitReported: true});
  const result = await sm.transition('active', {
    source: 'slash-command',
    detail: 'try resume',
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('terminal');
  expect(sm.state.status).toBe('budgetLimited');
});

test('budgetLimited → blocked is rejected (terminal)', async () => {
  const sm = makeSM({status: 'budgetLimited', budgetLimitReported: true});
  const result = await sm.transition('blocked', {
    source: 'update_goal',
    detail: 'try block',
  });
  expect(result.ok).toBe(false);
  expect(sm.state.status).toBe('budgetLimited');
});

test('budgetLimited → complete is rejected (terminal)', async () => {
  const sm = makeSM({status: 'budgetLimited', budgetLimitReported: true});
  const result = await sm.transition('complete', {
    source: 'update_goal',
    detail: 'try complete',
  });
  expect(result.ok).toBe(false);
  expect(sm.state.status).toBe('budgetLimited');
});

test('complete → active is rejected (terminal)', async () => {
  const sm = makeSM({status: 'complete', finishedAt: Date.now()});
  const result = await sm.transition('active', {
    source: 'slash-command',
    detail: 'try resume',
  });
  expect(result.ok).toBe(false);
  expect(sm.state.status).toBe('complete');
});

test('isBudgetLimited checks both status and flag', () => {
  // Status is budgetLimited
  const sm1 = makeSM({status: 'budgetLimited', budgetLimitReported: true});
  expect(sm1.isBudgetLimited()).toBe(true);

  // Status is paused but flag is set (user intervention overwrote stopReason)
  const sm2 = makeSM({
    status: 'paused',
    stopReason: 'user intervention',
    budgetLimitReported: true,
  });
  expect(sm2.isBudgetLimited()).toBe(true);

  // Neither
  const sm3 = makeSM({status: 'active', budgetLimitReported: false});
  expect(sm3.isBudgetLimited()).toBe(false);
});

// Revision & CAS

test('revision increments on status transition', async () => {
  const sm = makeSM({status: 'active'});
  const rev0 = sm.currentRevision;
  await sm.transition('paused', {source: 'slash-command', detail: 'pause'});
  expect(sm.currentRevision).toBe(rev0 + 1);
  await sm.transition('active', {source: 'slash-command', detail: 'resume'});
  expect(sm.currentRevision).toBe(rev0 + 2);
});

test('revision increments on field mutation', async () => {
  const sm = makeSM({status: 'active'});
  const rev0 = sm.currentRevision;
  await sm.mutate(
    g => {
      g.condition = 'new objective';
    },
    {source: 'slash-command', detail: 'objective edit'},
  );
  expect(sm.currentRevision).toBe(rev0 + 1);
  expect(sm.state.condition).toBe('new objective');
});

test('revision does NOT increment on usage update', async () => {
  const sm = makeSM({status: 'active'});
  const rev0 = sm.currentRevision;
  await sm.updateUsage({
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });
  expect(sm.currentRevision).toBe(rev0); // no revision change
  expect(sm.state.usage.input).toBe(100);
});

test('CAS validation detects semantic mutations', async () => {
  const sm = makeSM({status: 'active'});
  const rev = sm.currentRevision;
  expect(sm.validateRevision(rev)).toBe(true); // no mutation occurred

  // Now mutate
  await sm.mutate(
    g => {
      g.condition = 'changed';
    },
    {source: 'slash-command', detail: 'edit'},
  );
  expect(sm.validateRevision(rev)).toBe(false); // revision changed
});

test('CAS validation does not fail on usage updates', async () => {
  const sm = makeSM({status: 'active'});
  const rev = sm.currentRevision;
  await sm.updateUsage({
    input: 200,
    output: 100,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });
  expect(sm.validateRevision(rev)).toBe(true); // usage update doesn't change revision
});

// Mutex Serialization

test('mutex serializes parallel transitions — exactly one commits', async () => {
  const sm = makeSM({status: 'active'});
  // Start two transitions concurrently
  const [r1, r2] = await Promise.all([
    sm.transition('complete', {source: 'update_goal', detail: 'complete 1'}),
    sm.transition('blocked', {
      source: 'update_goal',
      detail: 'block 1',
      blockedReason: 'x',
    }),
  ]);
  // Exactly one should succeed
  const successes = [r1, r2].filter(r => r.ok).length;
  expect(successes).toBe(1);
  // The goal should be in one of the terminal/stop states
  expect(['complete', 'blocked']).toContain(sm.state.status);
});

test('mutex serializes transition + usage update', async () => {
  // The invariant under test is SERIALIZATION: while a transition is parked in
  // its onCommit await window, a concurrent usage update must not run. A sleep
  // inside onCommit could not show that — it only widened the window and hoped
  // the interleaving did not happen to occur. A test-controlled gate holds the
  // transition open for exactly as long as the assertion needs.
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>(resolve => {
    releaseCommit = resolve;
  });
  const commitOrder: string[] = [];
  const smWithCallback = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async () => {
      commitOrder.push('commit-start');
      await commitGate;
      commitOrder.push('commit-end');
    },
  });

  const transitionPromise = smWithCallback.transition('paused', {
    source: 'slash-command',
    detail: 'pause',
  });
  const usagePromise = smWithCallback.updateUsage({
    input: 50,
    output: 10,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });

  // Let every runnable microtask drain. The transition is parked on the gate, so
  // if the mutex did NOT serialize, the usage update would have completed here.
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
  expect(commitOrder).toEqual(['commit-start']);
  expect(smWithCallback.state.usage.input).toBe(0); // usage has NOT interleaved

  releaseCommit();
  await Promise.all([transitionPromise, usagePromise]);

  // The transition committed to completion before the usage update ran.
  expect(commitOrder).toEqual(['commit-start', 'commit-end']);
  expect(smWithCallback.state.usage.input).toBe(50);
  expect(smWithCallback.state.status).toBe('paused');
});

// Snapshot Immutability

test("snapshot is a deep copy — mutating it doesn't affect the goal", () => {
  const sm = makeSM({status: 'active'});
  const snap = sm.snapshot() as GoalState;
  // Mutate the snapshot
  snap.history.push({type: 'fake', detail: 'injected', timestamp: 0});
  snap.condition = 'hacked';
  snap.messageIDs.add('fake-msg');
  // The goal is unaffected
  expect(sm.state.history.length).toBe(0);
  expect(sm.state.condition).toBe('test goal');
  expect(sm.state.messageIDs.has('fake-msg')).toBe(false);
});

// Clock Operations

test('pauseClock sets pausedAt', () => {
  const sm = makeSM({status: 'active', pausedAt: 0});
  sm.pauseClock();
  expect(sm.state.pausedAt).toBeGreaterThan(0);
  // Idempotent — doesn't overwrite
  const first = sm.state.pausedAt;
  sm.pauseClock();
  expect(sm.state.pausedAt).toBe(first);
});

test('resumeClock shifts startedAt forward by paused interval', () => {
  const startedAt = Date.now() - 10000;
  const pausedAt = Date.now() - 5000;
  const sm = makeSM({status: 'paused', startedAt, pausedAt});
  sm.resumeClock();
  expect(sm.state.pausedAt).toBe(0);
  // startedAt should have shifted forward by ~5000ms (the paused interval)
  const shift = sm.state.startedAt - startedAt;
  expect(shift).toBeGreaterThan(4000);
  expect(shift).toBeLessThan(6000);
});

// History

test('transition pushes a history entry', async () => {
  const sm = makeSM({status: 'active'});
  expect(sm.state.history.length).toBe(0);
  await sm.transition('paused', {
    source: 'slash-command',
    detail: 'user paused',
    historyType: 'paused',
  });
  expect(sm.state.history.length).toBe(1);
  expect(sm.state.history[0].type).toBe('paused');
  expect(sm.state.history[0].detail).toBe('user paused');
});

// onCommit Callback

test('onCommit is called after successful transition', async () => {
  let committed = false;
  let committedSnapshot: GoalState | null = null;
  const sm = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async snap => {
      committed = true;
      committedSnapshot = snap;
    },
  });
  await sm.transition('paused', {source: 'slash-command', detail: 'pause'});
  expect(committed).toBe(true);
  expect(committedSnapshot!.status).toBe('paused');
});

test('onCommit is NOT called when skipPersist is true', async () => {
  let called = false;
  const sm = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async () => {
      called = true;
    },
  });
  await sm.transition('paused', {
    source: 'slash-command',
    detail: 'pause',
    skipPersist: true,
  });
  expect(called).toBe(false);
});

test('onCommit receives correct CommitTransition metadata from transition()', async () => {
  let captured: CommitTransition | null = null;
  const sm = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async (_snap, transition) => {
      captured = transition;
    },
  });
  await sm.transition('paused', {
    source: 'slash-command',
    detail: 'User paused',
  });
  expect(captured).not.toBeNull();
  expect(captured!.source).toBe('slash-command');
  expect(captured!.from).toBe('active');
  expect(captured!.to).toBe('paused');
  expect(captured!.detail).toBe('User paused');
});

test('onCommit receives correct CommitTransition metadata from mutate()', async () => {
  let captured: CommitTransition | null = null;
  const sm = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async (_snap, transition) => {
      captured = transition;
    },
  });
  await sm.mutate(
    g => {
      g.stopReason = 'backgrounded';
    },
    {source: 'idle-handler', detail: 'Backgrounded'},
  );
  expect(captured).not.toBeNull();
  expect(captured!.source).toBe('idle-handler');
  expect(captured!.from).toBe('active');
  expect(captured!.to).toBe('active');
  expect(captured!.detail).toBe('Backgrounded');
});

// Notices

test('addNotice stores a pending notice', async () => {
  const sm = makeSM({status: 'active'});
  await sm.addNotice('blocked', 'Agent reported blocked at step 3');
  expect(sm.state.pendingNotices.length).toBe(1);
  expect(sm.state.pendingNotices[0].kind).toBe('blocked');
  expect(sm.state.pendingNotices[0].message).toContain('step 3');
});

test('clearNotices removes all pending notices', async () => {
  const sm = makeSM({status: 'active'});
  await sm.addNotice('blocked', 'notice 1');
  await sm.addNotice('budget-limited', 'notice 2');
  expect(sm.state.pendingNotices.length).toBe(2);
  await sm.clearNotices();
  expect(sm.state.pendingNotices.length).toBe(0);
});

// createGoalState

test('createGoalState generates unique goalId and runId', () => {
  const g1 = createGoalState('s1', 'goal 1');
  const g2 = createGoalState('s1', 'goal 2');
  expect(g1.goalId).not.toBe(g2.goalId);
  expect(g1.runId).not.toBe(g2.runId);
  expect(g1.revision).toBe(0);
  expect(g1.status).toBe('active');
  expect(g1.tokenBudget).toBe(null); // unbounded by default
});

test('createGoalState accepts tokenBudget', () => {
  const g = createGoalState('s1', 'budgeted goal', {tokenBudget: 100000});
  expect(g.tokenBudget).toBe(100000);
});

// finalizing flag cleanup on transition

test('transition to paused clears finalizing flag', async () => {
  const sm = makeSM({status: 'active', finalizing: true});
  const result = await sm.transition('paused', {
    source: 'chat-message',
    detail: 'terminal event',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('paused');
  expect(sm.state.finalizing).toBe(false);
});

test('transition to blocked clears finalizing flag', async () => {
  const sm = makeSM({status: 'active', finalizing: true});
  const result = await sm.transition('blocked', {
    source: 'update_goal',
    detail: 'blocked',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('blocked');
  expect(sm.state.finalizing).toBe(false);
});

test('transition to complete clears finalizing flag', async () => {
  const sm = makeSM({status: 'active', finalizing: true});
  const result = await sm.transition('complete', {
    source: 'update_goal',
    detail: 'completed',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('complete');
  expect(sm.state.finalizing).toBe(false);
});

test('transition to budgetLimited clears finalizing flag', async () => {
  const sm = makeSM({status: 'active', finalizing: true});
  const result = await sm.transition('budgetLimited', {
    source: 'idle-handler',
    detail: 'budget exhausted',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('budgetLimited');
  expect(sm.state.finalizing).toBe(false);
});

// mutate revision safety

test('mutate with throwing callback does not increment revision', async () => {
  const sm = makeSM({
    status: 'active',
    condition: 'original objective',
    history: [{type: 'seed', detail: 'original', timestamp: 1}],
    pendingNotices: [
      {kind: 'user-intervention', message: 'original notice', timestamp: 2},
    ],
  });
  const revBefore = sm.state.revision;
  await expect(
    sm.mutate(
      goal => {
        goal.condition = 'partial objective';
        goal.history[0]!.detail = 'partial history';
        goal.pendingNotices[0]!.message = 'partial notice';
        goal.usage.input = 999;
        throw new Error('callback error');
      },
      {source: 'idle-handler', detail: 'throwing callback'},
    ),
  ).rejects.toThrow('callback error');
  // The callback is atomic: neither semantic nor nested state may leak.
  expect(sm.state.revision).toBe(revBefore);
  expect(sm.state.condition).toBe('original objective');
  expect(sm.state.history[0]!.detail).toBe('original');
  expect(sm.state.pendingNotices[0]!.message).toBe('original notice');

  // The mutex remains usable after the rejected operation.
  const next = await sm.mutate(
    goal => {
      goal.condition = 'next objective';
    },
    {
      source: 'slash-command',
      detail: 'subsequent edit',
    },
  );
  expect(next.ok).toBe(true);
  expect(sm.state.condition).toBe('next objective');
});

test('mutate callback rejection rethrows non-Error values unchanged', async () => {
  const sm = makeSM({status: 'active', condition: 'original objective'});
  const sentinel = {reason: 'callback sentinel'};
  await expect(
    sm.mutate(
      goal => {
        goal.condition = 'partial objective';
        throw sentinel;
      },
      {source: 'idle-handler', detail: 'throwing sentinel'},
    ),
  ).rejects.toBe(sentinel);
  expect(sm.state.condition).toBe('original objective');
});

/**
 * onCommit failures are surfaced to the caller without pretending the in-memory
 * transition did not happen: the callback may have durably written a WAL entry
 * before reporting its failure, so reverting here could diverge memory from the
 * durable ledger. Recovery/persistence repair owns convergence after the error.
 */
test('onCommit failure preserves the committed in-memory transition', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async () => {
      throw new Error('persist failed');
    },
  });

  await expect(
    sm.transition('paused', {source: 'slash-command', detail: 'pause'}),
  ).rejects.toThrow('persist failed');
  expect(sm.state.status).toBe('paused');
  expect(sm.currentRevision).toBe(1);
});

test('onCommit failure preserves the committed in-memory mutation', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async () => {
      throw new Error('persist failed');
    },
  });

  await expect(
    sm.mutate(
      goal => {
        goal.condition = 'edited objective';
      },
      {
        source: 'slash-command',
        detail: 'edit objective',
      },
    ),
  ).rejects.toThrow('persist failed');
  expect(sm.state.condition).toBe('edited objective');
  expect(sm.currentRevision).toBe(1);
});

// state-machine callback and rollback semantics

test('agent brake rejection restores all mutated fields and nested collections', async () => {
  const sm = makeSM({
    status: 'active',
    condition: 'original objective',
    history: [{type: 'seed', detail: 'original', timestamp: 1}],
    pendingNotices: [
      {kind: 'user-intervention', message: 'original notice', timestamp: 2},
    ],
  });
  const revision = sm.currentRevision;

  const result = await sm.mutate(
    goal => {
      goal.condition = 'tampered objective';
      goal.history[0]!.detail = 'tampered history';
      goal.pendingNotices[0]!.message = 'tampered notice';
      goal.maxTurns = 999;
    },
    {source: 'update_goal', detail: 'attempted brake escalation'},
  );

  expect(result.ok).toBe(false);
  expect(result.error).toContain('Brakes');
  expect(sm.currentRevision).toBe(revision);
  expect(sm.state.condition).toBe('original objective');
  expect(sm.state.history[0]!.detail).toBe('original');
  expect(sm.state.pendingNotices[0]!.message).toBe('original notice');
  expect(sm.state.maxTurns).not.toBe(999);
});

test('blocked → complete clears blockedReason', async () => {
  const sm = makeSM({status: 'blocked', blockedReason: 'missing dependency'});
  const result = await sm.transition('complete', {
    source: 'update_goal',
    stopReason: 'completed',
    detail: 'goal achieved after unblocking',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('complete');
  expect(sm.state.blockedReason).toBe('');
});

// transition("complete") clock cleanup

test('paused → complete clears pausedAt and adjusts startedAt', async () => {
  const startedAt = Date.now() - 60000; // 1 minute ago
  const pausedAt = Date.now() - 30000; // paused 30 seconds ago
  const sm = makeSM({status: 'paused', startedAt, pausedAt});
  const result = await sm.transition('complete', {
    source: 'update_goal',
    stopReason: 'completed',
    detail: 'goal achieved',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('complete');
  // pausedAt must be cleared — completed goals have no paused state
  expect(sm.state.pausedAt).toBe(0);
  // startedAt must be shifted forward to exclude the paused duration
  expect(sm.state.startedAt).toBeGreaterThan(startedAt);
  // finishedAt must be set
  expect(sm.state.finishedAt).toBeGreaterThan(0);
});

test('blocked → complete clears pausedAt and adjusts startedAt', async () => {
  const startedAt = Date.now() - 60000;
  const pausedAt = Date.now() - 30000;
  const sm = makeSM({
    status: 'blocked',
    startedAt,
    pausedAt,
    blockedReason: 'stuck',
  });
  const result = await sm.transition('complete', {
    source: 'update_goal',
    stopReason: 'completed',
    detail: 'goal achieved after unblocking',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('complete');
  expect(sm.state.pausedAt).toBe(0);
  expect(sm.state.startedAt).toBeGreaterThan(startedAt);
});

test('active → complete does not set pausedAt', async () => {
  const sm = makeSM({status: 'active', pausedAt: 0});
  const result = await sm.transition('complete', {
    source: 'update_goal',
    stopReason: 'completed',
    detail: 'goal achieved',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('complete');
  // An active goal has pausedAt=0; completing should keep it 0
  expect(sm.state.pausedAt).toBe(0);
  expect(sm.state.finishedAt).toBeGreaterThan(0);
});

// pendingNotices bounded

test('addNotice bounds pendingNotices array', async () => {
  const sm = makeSM({status: 'active'});
  for (let i = 0; i < 20; i++) {
    await sm.addNotice('tool-surface-unavailable', `notice ${i}`);
  }
  // The array must be bounded — not all 20 entries should survive
  expect(sm.state.pendingNotices.length).toBeLessThanOrEqual(10);
  // The most recent notices should be retained
  expect(sm.state.pendingNotices.length).toBeGreaterThan(0);
  const lastNotice =
    sm.state.pendingNotices[sm.state.pendingNotices.length - 1];
  expect(lastNotice.message).toBe('notice 19');
});

// Missing terminal state and transition coverage

test('complete → blocked is rejected (terminal)', async () => {
  const sm = makeSM({status: 'complete', finishedAt: Date.now()});
  const result = await sm.transition('blocked', {
    source: 'update_goal',
    detail: 'try block',
  });
  expect(result.ok).toBe(false);
  expect(sm.state.status).toBe('complete');
});

test('finalizing → complete is permitted', async () => {
  const sm = makeSM({status: 'finalizing'});
  const result = await sm.transition('complete', {
    source: 'update_goal',
    stopReason: 'completed',
    detail: 'completed during finalizing',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('complete');
  expect(sm.state.finalizing).toBe(false);
  expect(sm.state.finishedAt).toBeGreaterThan(0);
});

test('finalizing → paused is permitted', async () => {
  const sm = makeSM({status: 'finalizing'});
  const result = await sm.transition('paused', {
    source: 'chat-message',
    detail: 'user intervened',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('paused');
  expect(sm.state.finalizing).toBe(false);
});

test('finalizing → active is permitted', async () => {
  const sm = makeSM({status: 'finalizing'});
  const result = await sm.transition('active', {
    source: 'slash-command',
    detail: 'resumed from finalizing',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('active');
  expect(sm.state.finalizing).toBe(false);
  expect(sm.state.stopReason).toBe('');
});

test('paused → blocked is permitted', async () => {
  const sm = makeSM({status: 'paused', pausedAt: Date.now() - 1000});
  const result = await sm.transition('blocked', {
    source: 'update_goal',
    blockedReason: 'stuck',
    detail: 'blocked from paused',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('blocked');
});

test('paused → finalizing is permitted', async () => {
  const sm = makeSM({status: 'paused', pausedAt: Date.now() - 1000});
  const result = await sm.transition('finalizing', {
    source: 'idle-handler',
    stopReason: 'budget exhausted',
    detail: 'budget limit',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('finalizing');
});

test('resume clears all heuristic counters', async () => {
  const sm = makeSM({
    status: 'paused',
    pausedAt: Date.now() - 1000,
    stopReason: 'manual pause',
    blockedReason: 'was blocked',
    noProgressTurns: 3,
    noToolCallTurns: 2,
    promptFailures: 1,
    budgetWrapupSent: true,
  });
  const result = await sm.transition('active', {
    source: 'slash-command',
    detail: 'user resumed',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.stopReason).toBe('');
  expect(sm.state.blockedReason).toBe('');
  expect(sm.state.noProgressTurns).toBe(0);
  expect(sm.state.noToolCallTurns).toBe(0);
  expect(sm.state.promptFailures).toBe(0);
  expect(sm.state.budgetWrapupSent).toBe(false);
});

// Exhaustive transition table + side-effect stress tests

const ALL_STATUSES: GoalStatus[] = [
  'active',
  'paused',
  'blocked',
  'finalizing',
  'budgetLimited',
  'complete',
];

const EXPECTED_ALLOWED: Record<string, string[]> = {
  active: ['paused', 'blocked', 'finalizing', 'complete', 'budgetLimited'],
  paused: ['active', 'blocked', 'complete', 'finalizing'],
  blocked: ['active', 'complete'],
  finalizing: ['complete', 'paused', 'active'],
  budgetLimited: [],
  complete: [],
};

test('exhaustive transition table — all 36 (from,to) pairs', async () => {
  for (const from of ALL_STATUSES) {
    const allowed = EXPECTED_ALLOWED[from];
    for (const to of ALL_STATUSES) {
      // Create a goal in the `from` state with realistic field values.
      const baseOverrides: Partial<GoalState> = {status: from as GoalStatus};
      if (from === 'paused' || from === 'blocked' || from === 'finalizing') {
        baseOverrides.pausedAt = Date.now() - 5000;
        baseOverrides.startedAt = Date.now() - 60000;
      }
      if (from === 'complete') {
        baseOverrides.finishedAt = Date.now() - 1000;
      }
      if (from === 'budgetLimited') {
        baseOverrides.pausedAt = Date.now() - 3000;
        baseOverrides.startedAt = Date.now() - 60000;
      }
      const sm = makeSM(baseOverrides);
      const revBefore = sm.currentRevision;

      const result = await sm.transition(to as GoalStatus, {
        source: 'slash-command',
        detail: `test ${from}→${to}`,
      });

      if (allowed.includes(to)) {
        // Allowed transition should succeed.
        expect(result.ok).toBe(true);
        expect(result.revision).toBe(revBefore + 1);
        expect(sm.state.status).toBe(to);
        expect(sm.state.finalizing).toBe(false);
        expect(sm.state.updatedAt).toBeGreaterThan(0);
        // History entry pushed.
        const lastEntry = sm.state.history[sm.state.history.length - 1];
        expect(lastEntry).toBeDefined();
        expect(lastEntry.detail).toBe(`test ${from}→${to}`);
      } else {
        // Disallowed transition should fail.
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
        expect(sm.state.status).toBe(from);
        // Revision should NOT change for failed transitions.
        expect(sm.currentRevision).toBe(revBefore);
      }
    }
  }
});

test('transition(complete) clears pausedAt from all source states', async () => {
  const sources: GoalStatus[] = ['active', 'paused', 'blocked', 'finalizing'];
  for (const from of sources) {
    const overrides: Partial<GoalState> = {
      status: from,
      startedAt: Date.now() - 60000,
    };
    if (from !== 'active') {
      overrides.pausedAt = Date.now() - 5000;
    }
    const sm = makeSM(overrides);
    const result = await sm.transition('complete', {
      source: 'update_goal',
      detail: `complete from ${from}`,
    });
    expect(result.ok).toBe(true);
    expect(sm.state.status).toBe('complete');
    //: pausedAt must be 0 after completion.
    expect(sm.state.pausedAt).toBe(0);
    // finishedAt must be set.
    expect(sm.state.finishedAt).toBeGreaterThan(0);
    // blockedReason must be cleared ( fix).
    expect(sm.state.blockedReason).toBe('');
    // finalizing must be cleared.
    expect(sm.state.finalizing).toBe(false);
  }
});

// The budgetLimited transition test below covers the remaining terminal limit.

test('transition(budgetLimited) sets budgetLimitReported=true', async () => {
  const sm = makeSM({
    status: 'active',
    startedAt: Date.now() - 30000,
    pausedAt: 0,
  });
  const result = await sm.transition('budgetLimited', {
    source: 'idle-handler',
    detail: 'budget limit',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('budgetLimited');
  expect(sm.state.budgetLimitReported).toBe(true);
  expect(sm.state.pausedAt).toBeGreaterThan(0);
  expect(sm.isBudgetLimited()).toBe(true);
  expect(sm.isTerminal()).toBe(true);
});

test('transition(active) clears all heuristic counters from paused/blocked/finalizing', async () => {
  const sources: GoalStatus[] = ['paused', 'blocked', 'finalizing'];
  for (const from of sources) {
    const sm = makeSM({
      status: from,
      pausedAt: Date.now() - 5000,
      startedAt: Date.now() - 60000,
      stopReason: 'some reason',
      blockedReason: 'some blocker',
      noProgressTurns: 5,
      noToolCallTurns: 3,
      promptFailures: 2,
      budgetWrapupSent: true,
    });
    const result = await sm.transition('active', {
      source: 'slash-command',
      detail: `resume from ${from}`,
    });
    expect(result.ok).toBe(true);
    expect(sm.state.stopReason).toBe('');
    expect(sm.state.blockedReason).toBe('');
    expect(sm.state.noProgressTurns).toBe(0);
    expect(sm.state.noToolCallTurns).toBe(0);
    expect(sm.state.promptFailures).toBe(0);
    expect(sm.state.budgetWrapupSent).toBe(false);
    expect(sm.state.pausedAt).toBe(0);
    expect(sm.state.finalizing).toBe(false);
  }
});

test('transition(finalizing) pauses clock', async () => {
  const sm = makeSM({
    status: 'active',
    startedAt: Date.now() - 30000,
    pausedAt: 0,
  });
  const result = await sm.transition('finalizing', {
    source: 'idle-handler',
    detail: 'budget wrapup',
  });
  expect(result.ok).toBe(true);
  expect(sm.state.status).toBe('finalizing');
  expect(sm.state.finalizing).toBe(false);
  expect(sm.state.pausedAt).toBeGreaterThan(0);
});

test('concurrency stress — 100 concurrent transitions to same target serialize', async () => {
  const sm = makeSM({status: 'active', startedAt: Date.now() - 30000});
  const promises: Promise<TransitionResult>[] = [];
  for (let i = 0; i < 100; i++) {
    promises.push(
      sm.transition('paused', {
        source: 'slash-command',
        detail: `concurrent ${i}`,
      }),
    );
  }
  const results = await Promise.all(promises);
  const succeeded = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  // Exactly 1 succeeds (active→paused); remaining 99 fail (paused→paused not allowed).
  expect(succeeded.length).toBe(1);
  expect(failed.length).toBe(99);
  expect(succeeded[0].revision).toBeDefined();
  expect(sm.state.status).toBe('paused');
});

test('concurrency stress — 50 concurrent mutate calls serialize correctly', async () => {
  const sm = makeSM({status: 'active'});
  const revBefore = sm.currentRevision;
  const promises: Promise<TransitionResult>[] = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      sm.mutate(
        g => {
          g.turnCount = i;
        },
        {source: 'idle-handler', detail: `mutate ${i}`},
      ),
    );
  }
  const results = await Promise.all(promises);
  const succeeded = results.filter(r => r.ok);
  expect(succeeded.length).toBe(50);
  expect(sm.currentRevision).toBe(revBefore + 50);
  expect(sm.state.turnCount).toBeGreaterThanOrEqual(0);
  expect(sm.state.turnCount).toBeLessThan(50);
});

test('concurrency stress — mixed transition + mutate calls serialize', async () => {
  const sm = makeSM({status: 'active'});
  const revBefore = sm.currentRevision;
  const promises: Promise<unknown>[] = [];

  promises.push(
    sm.transition('paused', {source: 'slash-command', detail: 'pause'}),
  );
  promises.push(
    sm.transition('active', {source: 'slash-command', detail: 'resume'}),
  );
  promises.push(
    sm.transition('paused', {source: 'slash-command', detail: 'pause'}),
  );
  promises.push(
    sm.transition('active', {source: 'slash-command', detail: 'resume'}),
  );
  promises.push(
    sm.transition('paused', {source: 'slash-command', detail: 'pause'}),
  );

  for (let i = 0; i < 10; i++) {
    promises.push(
      sm.mutate(
        g => {
          g.turnCount = i;
        },
        {source: 'idle-handler', detail: `mutate ${i}`},
      ),
    );
  }

  const results = await Promise.allSettled(promises);
  const rejected = results.filter(r => r.status === 'rejected');
  expect(rejected.length).toBe(0);
  // Revision must have increased (exact count depends on execution order —
  // some transitions may fail if serialized after a status change).
  expect(sm.currentRevision).toBeGreaterThan(revBefore);
});

test('self-transitions are rejected for all statuses', async () => {
  for (const status of ALL_STATUSES) {
    const overrides: Partial<GoalState> = {status: status as GoalStatus};
    if (
      status === 'paused' ||
      status === 'blocked' ||
      status === 'finalizing' ||
      status === 'budgetLimited'
    ) {
      overrides.pausedAt = Date.now() - 5000;
      overrides.startedAt = Date.now() - 60000;
    }
    if (status === 'complete') {
      overrides.finishedAt = Date.now() - 1000;
    }
    const sm = makeSM(overrides);
    const result = await sm.transition(status as GoalStatus, {
      source: 'slash-command',
      detail: `self-transition ${status}→${status}`,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  }
});

test('terminal states reject all 6 targets exhaustively', async () => {
  const terminalStates: GoalStatus[] = ['budgetLimited', 'complete'];
  for (const terminal of terminalStates) {
    for (const target of ALL_STATUSES) {
      const overrides: Partial<GoalState> = {
        status: terminal,
        startedAt: Date.now() - 60000,
        pausedAt: terminal !== 'complete' ? Date.now() - 5000 : 0,
        finishedAt: terminal === 'complete' ? Date.now() - 1000 : null,
      };
      const sm = makeSM(overrides);
      const result = await sm.transition(target, {
        source: 'slash-command',
        detail: `${terminal}→${target}`,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('terminal');
      expect(sm.state.status).toBe(terminal);
    }
  }
});
