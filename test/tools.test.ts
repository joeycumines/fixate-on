import {describe, expect, test} from 'bun:test';
import {
  type CreateGoalOptions,
  handleCreateGoal,
  handleFocusGoal,
  handleGetGoal,
  handleListGoals,
  handleUpdateGoal,
  remainingTokens,
  serializeToolResponse,
  threadStatusFor,
  type ToolSessionContext,
  toThreadGoal,
  toThreadGoalFromResult,
} from '../src/tools.ts';
import type {GoalState, PendingIntent} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {GoalResult} from '../src/persistence.ts';
import type {UsageSnapshot} from '../src/accounting.ts';

// Helpers

function makeUsage(partial: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    input: 1000,
    output: 500,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
    ...partial,
  };
}

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  const goal = createGoalState('session-1', 'Build the feature', {
    goalId: 'goal-1',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {...goal, usage: makeUsage(), ...overrides};
}

function makeResult(overrides: Partial<GoalResult> = {}): GoalResult {
  return {
    goalId: 'goal-old-1',
    sessionID: 'session-1',
    condition: 'Old completed goal',
    state: 'achieved',
    reason: '',
    evidence: '',
    blockedReason: '',
    turnCount: 5,
    totalTokens: 10000,
    tokenBudget: 50000,
    createdAt: Date.now() - 60000,
    usage: makeUsage({input: 8000, output: 2000}),
    startedAt: Date.now() - 60000,
    finishedAt: Date.now() - 30000,
    lastStatus: 'Goal completed.',
    lastCheckpoint: null,
    checkpoints: [],
    history: [],
    ...overrides,
  };
}

function makeSessionContext(
  opts: {
    machine?: GoalStateMachine | null;
    activeGoals?: GoalState[];
    archived?: GoalResult[];
    createdGoal?: GoalStateMachine;
    focusedGoal?: GoalStateMachine | null;
    pendingIntent?: PendingIntent | null;
    persistResult?: boolean;
    persistCalls?: number[];
  } = {},
): ToolSessionContext {
  const machine = opts.machine ?? null;
  const activeGoals = opts.activeGoals ?? (machine ? [machine.snapshot()] : []);
  const archived = opts.archived ?? [];
  const pendingIntents = new Map<string, PendingIntent>();
  if (opts.pendingIntent && opts.machine) {
    pendingIntents.set(opts.machine.snapshot().goalId, opts.pendingIntent);
  }
  const persistResult = opts.persistResult ?? true;

  return {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => activeGoals,
    listArchivedResults: () => archived,
    createGoal: (_objective: string, _options: CreateGoalOptions) => {
      return (
        opts.createdGoal ??
        new GoalStateMachine(makeGoal(), {
          onCommit: async () => {},
        })
      );
    },
    removeGoal: async (_goalId: string) => {},
    focusGoal: async (_goalId: string) => {
      const m = opts.focusedGoal;
      return m
        ? {ok: true as const, machine: m}
        : {ok: false as const, reason: 'not-found' as const};
    },
    setPendingIntent: (goalId: string, intent: PendingIntent | null) => {
      if (intent) pendingIntents.set(goalId, intent);
      else pendingIntents.delete(goalId);
    },
    getPendingIntent: (goalId: string) => pendingIntents.get(goalId) ?? null,
    getAllPendingIntents: () => [...pendingIntents.values()],
    persist: async () => {
      opts.persistCalls?.push(Date.now());
      return persistResult;
    },
  };
}

// threadStatusFor

test('threadStatusFor maps all statuses', () => {
  expect(threadStatusFor(makeGoal({status: 'active'}))).toBe('active');
  expect(threadStatusFor(makeGoal({status: 'paused'}))).toBe('paused');
  expect(threadStatusFor(makeGoal({status: 'blocked'}))).toBe('blocked');
  expect(threadStatusFor(makeGoal({status: 'complete'}))).toBe('complete');
  expect(threadStatusFor(makeGoal({status: 'budgetLimited'}))).toBe(
    'budgetLimited',
  );
  expect(threadStatusFor(makeGoal({status: 'finalizing'}))).toBe('active');
});

// remainingTokens

test('remainingTokens returns null when no budget', () => {
  const goal = makeGoal({tokenBudget: null});
  expect(remainingTokens(goal)).toBeNull();
});

test('remainingTokens returns remaining when budget set', () => {
  const goal = makeGoal({tokenBudget: 10000});
  goal.usage = makeUsage({input: 3000, output: 1000});
  // chargedTokens = 3000 + 1000 = 4000
  expect(remainingTokens(goal)).toBe(6000);
});

test('remainingTokens returns 0 when over budget', () => {
  const goal = makeGoal({tokenBudget: 1000});
  goal.usage = makeUsage({input: 2000, output: 1000});
  expect(remainingTokens(goal)).toBe(0);
});

// toThreadGoal

test('toThreadGoal produces correct wire format', () => {
  const goal = makeGoal();
  const tg = toThreadGoal(goal, 'session-1');
  expect(tg.threadId).toBe('session-1');
  expect(tg.goalId).toBe('goal-1');
  expect(tg.objective).toBe('Build the feature');
  expect(tg.status).toBe('active');
  expect(tg.tokenBudget).toBe(50000);
  expect(tg.tokensUsed).toBe(1500); // 1000 input + 500 output
  expect(tg.timeUsedSeconds).toBeGreaterThanOrEqual(0);
  expect(tg.createdAt).toBe(Math.floor(goal.createdAt / 1000));
  expect(tg.updatedAt).toBe(Math.floor(goal.updatedAt / 1000));
});

test('toThreadGoal returns null tokenBudget when 0', () => {
  const goal = makeGoal({tokenBudget: 0});
  const tg = toThreadGoal(goal, 'session-1');
  expect(tg.tokenBudget).toBeNull();
});

// toThreadGoalFromResult

test('toThreadGoalFromResult maps achieved state', () => {
  const result = makeResult({state: 'achieved'});
  const tg = toThreadGoalFromResult(result, 'session-1');
  expect(tg.status).toBe('complete');
});

test('toThreadGoalFromResult maps blocked state', () => {
  const result = makeResult({state: 'blocked'});
  const tg = toThreadGoalFromResult(result, 'session-1');
  expect(tg.status).toBe('blocked');
});

test('toThreadGoalFromResult maps cleared state', () => {
  const result = makeResult({state: 'cleared'});
  const tg = toThreadGoalFromResult(result, 'session-1');
  expect(tg.status).toBe('paused');
});

// handleGetGoal

test('handleGetGoal returns goal when machine exists', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(await handleGetGoal(session));
  expect(result.goal).not.toBeNull();
  expect(result.goal.objective).toBe('Build the feature');
  expect(result.pendingCompletion).toBe(false);
});

test('handleGetGoal returns null when no machine', async () => {
  const session = makeSessionContext({machine: null});
  const result = JSON.parse(await handleGetGoal(session));
  expect(result.goal).toBeNull();
  expect(result.pendingCompletion).toBe(false);
});

// handleCreateGoal

test('handleCreateGoal creates a goal successfully', async () => {
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    createdGoal: new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    }),
  });
  const result = JSON.parse(
    await handleCreateGoal(session, {objective: 'New goal'}),
  );
  expect(result.goal).not.toBeNull();
  expect(result.goal.objective).toBe('Build the feature');
  expect(result.error).toBeUndefined();
});

test('handleCreateGoal fails when unfinished goal exists', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({
    machine,
    activeGoals: [machine.snapshot()],
  });
  const result = JSON.parse(
    await handleCreateGoal(session, {objective: 'New goal'}),
  );
  expect(result.error).toContain('unfinished goal');
  expect(result.goal).not.toBeNull();
});

test('handleCreateGoal rejects empty objective', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = JSON.parse(await handleCreateGoal(session, {objective: ''}));
  expect(result.error).toContain('objective is required');
});

test('handleCreateGoal rejects whitespace-only objective', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = JSON.parse(
    await handleCreateGoal(session, {objective: '   '}),
  );
  expect(result.error).toContain('objective is required');
});

test('handleCreateGoal rejects too-long objective', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = JSON.parse(
    await handleCreateGoal(session, {objective: 'x'.repeat(4001)}),
  );
  expect(result.error).toContain('at most 4000');
});

test('handleCreateGoal rejects invalid token_budget', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = JSON.parse(
    await handleCreateGoal(session, {objective: 'New goal', token_budget: -5}),
  );
  expect(result.error).toContain('positive integer');
});

test('handleCreateGoal rejects zero token_budget', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = JSON.parse(
    await handleCreateGoal(session, {objective: 'New goal', token_budget: 0}),
  );
  expect(result.error).toContain('positive integer');
});

test('handleCreateGoal accepts valid token_budget', async () => {
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    createdGoal: new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    }),
  });
  const result = JSON.parse(
    await handleCreateGoal(session, {
      objective: 'New goal',
      token_budget: 100000,
    }),
  );
  expect(result.error).toBeUndefined();
});

test('handleCreateGoal rolls back goal when persist fails', async () => {
  const createdGoal = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const removedGoals: string[] = [];
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    createdGoal,
    persistResult: false,
  });
  session.removeGoal = async (goalId: string) => {
    removedGoals.push(goalId);
  };
  const result = JSON.parse(
    await handleCreateGoal(session, {objective: 'New goal'}),
  );
  expect(result.error).toContain('could not be persisted');
  expect(result.error).toContain('rolled back');
  expect(removedGoals).toContain(createdGoal.snapshot().goalId);
});

// handleUpdateGoal

test('handleUpdateGoal complete records pending intent', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );
  expect(result.pendingCompletion).toBe(true);
  expect(result.goal.status).toBe('active');
  expect(session.getPendingIntent('goal-1')).not.toBeNull();
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('complete');
});

test('handleUpdateGoal complete sets pendingIntent goalId and revision', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  await handleUpdateGoal(session, {status: 'complete'});
  const intent = session.getPendingIntent('goal-1');
  expect(intent).not.toBeNull();
  expect(intent!.goalId).toBe('goal-1');
  expect(intent!.revision).toBe(machine.snapshot().revision);
});

test('handleUpdateGoal complete fails when already pending', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const goal = machine.snapshot();
  const existingIntent: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({machine, pendingIntent: existingIntent});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );
  expect(result.error).toContain('already pending');
});

test('handleUpdateGoal rejects completion when a conflicting blocked intent is pending', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const goal = machine.snapshot();
  const blockedIntent: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'blocked',
    evidence: 'missing input',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({machine, pendingIntent: blockedIntent});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );
  expect(result.error).toContain('conflicting blocked intent');
  expect(result.pendingCompletion).toBe(false);
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('blocked');
});

test('handleUpdateGoal rejects blocked transition when completion intent is pending', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const goal = machine.snapshot();
  const completionIntent: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: 'done',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({
    machine,
    pendingIntent: completionIntent,
  });
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'blocked'}),
  );
  expect(result.error).toContain('completion intent is already pending');
  expect(result.pendingCompletion).toBe(true);
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('complete');
});

// The SAME rule, one arm over. `update_goal(blocked)` already refuses when a completion
// intent is pending; `update_goal(complete)` — the arm that IS the step barrier for
// settling a goal — compared revisions with `===` while the other two copies of this
// predicate in the same file used `>=`.
//
// Equality is the wrong operator because a startup that finds a valid intent re-pins it
// to the revision the goal WILL carry once the pending terminal transition is applied:
// the recovery pause (+1) and the re-arm (+1), so `snapshotRevision + 2`
// (plugin-runtime.ts). Until that idle arrives the intent sits ABOVE the live goal, so
// `===` never held after a restart and both guards were skipped exactly when they
// mattered — `update_goal complete` overwrote a durably recorded completion claim and
// answered `error: undefined` rather than "a completion is already pending".
describe('a pending intent AHEAD of the goal is still pending — the shape a restart produces', () => {
  /**
   * An intent as a RESTART leaves it: the same goal and run, at the revision the goal
   * will carry once the recovery pause (+1) and the re-arm (+1) have been applied.
   *
   * Derived from the live goal rather than written out, because `runId` is a generated
   * uuid and `revision` starts at 0 — a fixture with literal values for either compares
   * unequal for a reason that has nothing to do with the rule, which is the fixture bug
   * this repository has now hit four times.
   */
  const intentAhead = (
    goal: GoalState,
    over: Partial<PendingIntent> = {},
  ): PendingIntent => ({
    goalId: goal.goalId,
    runId: goal.runId,
    revision: goal.revision + 2,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: 'the agent claimed this before the restart',
    createdAt: Date.now(),
    ...over,
  });

  test('update_goal complete refuses to overwrite a completion claim that is ahead of the goal', async () => {
    const goal = makeGoal();
    const machine = new GoalStateMachine(goal, {
      onCommit: async () => {},
    });
    const session = makeSessionContext({
      machine,
      pendingIntent: intentAhead(goal),
    });
    expect(
      session.getPendingIntent('goal-1')!.revision,
      "the fixture's intent is not AHEAD of the goal, so the case is not the one it claims",
    ).toBeGreaterThan(machine.snapshot().revision);

    const result = JSON.parse(
      await handleUpdateGoal(session, {status: 'complete'}),
    );

    expect(
      result.error,
      'a completion claim was overwritten and the agent was told nothing',
    ).toContain('a completion is already pending');
    expect(result.pendingCompletion).toBe(true);
    // …and the CLAIM is still the one that was recorded, not a fresh one.
    expect(session.getPendingIntent('goal-1')?.evidence).toBe(
      'the agent claimed this before the restart',
    );
  });

  test('update_goal complete refuses to overwrite a BLOCKED intent that is ahead of the goal either', async () => {
    // The other guard, same drift. A conflicting non-complete intent must stop a
    // completion request rather than being overwritten by one.
    const goal = makeGoal();
    const machine = new GoalStateMachine(goal, {
      onCommit: async () => {},
    });
    const session = makeSessionContext({
      machine,
      pendingIntent: intentAhead(goal, {
        targetStatus: 'blocked',
        evidence: 'blocked before the restart',
      }),
    });

    const result = JSON.parse(
      await handleUpdateGoal(session, {status: 'complete'}),
    );

    expect(result.error).toContain(
      'conflicting blocked intent is already pending',
    );
    expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('blocked');
  });

  test('an intent BEHIND the goal is stale and does not block — the settled direction, still true', async () => {
    // The control, and the reason the rule is `>=` rather than `===`: making it `>` would
    // fix the restart case and break this one. A goal edited after the claim leaves the
    // intent behind, and a stale intent must not refuse a fresh completion request.
    const goal = makeGoal({revision: 5});
    const machine = new GoalStateMachine(goal, {
      onCommit: async () => {},
    });
    const session = makeSessionContext({
      machine,
      pendingIntent: intentAhead(goal, {revision: 2}),
    });
    expect(session.getPendingIntent('goal-1')!.revision).toBeLessThan(
      machine.snapshot().revision,
    );

    const result = JSON.parse(
      await handleUpdateGoal(session, {status: 'complete'}),
    );

    expect(
      result.error,
      'a stale intent behind the goal blocked a fresh completion request',
    ).toBeUndefined();
    expect(session.getPendingIntent('goal-1')?.revision).toBeGreaterThanOrEqual(
      machine.snapshot().revision,
    );
  });
});

test('stale pending intent after revision change does not block new completion', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});

  // Step 1: Assistant calls update_goal {status: "complete"} — sets pending intent
  await handleUpdateGoal(session, {status: 'complete'});
  expect(session.getPendingIntent('goal-1')).not.toBeNull();
  const originalRevision = session.getPendingIntent('goal-1')!.revision;

  // Step 2: User calls /goal edit or /goal resume — mutate increments revision
  await machine.mutate(
    g => {
      g.condition = 'New objective after edit';
    },
    {source: 'slash-command', detail: 'Simulate /goal edit'},
  );

  // The pending intent is now stale (revision mismatch)
  expect(machine.snapshot().revision).not.toBe(originalRevision);

  // Step 3: Assistant calls update_goal {status: "complete"} again
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );

  // Step 4: The new completion should NOT be blocked by the stale intent
  expect(result.error).toBeUndefined();
  expect(result.pendingCompletion).toBe(true);
});

test('stale pending intent after runId change does not block new completion', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const goal = machine.snapshot();
  // Create a stale intent with wrong runId
  const staleIntent: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: 'wrong-run-id',
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({machine, pendingIntent: staleIntent});

  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );

  // Should NOT be blocked — runId doesn't match
  expect(result.error).toBeUndefined();
  expect(result.pendingCompletion).toBe(true);
});

test('handleUpdateGoal blocked rejects until threshold (mechanical 3-consecutive rule)', async () => {
  //: the 3-consecutive-blocked rule is now mechanically enforced
  // (AGENTS.md Principle 1 — was prompt-only). The first two blocked
  // attempts are rejected; the third (when blockedTurns >= maxBlockedTurns)
  // sets the pending intent. (maxBlockedTurns, not maxUnchangedResults.)
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});

  // Attempt 1: rejected (blockedTurns 0 → 1, threshold 3).
  let result = JSON.parse(await handleUpdateGoal(session, {status: 'blocked'}));
  expect(result.error).toContain('must recur');
  expect(result.pendingCompletion).toBe(false);
  expect(session.getPendingIntent('goal-1')).toBeNull();

  // Attempt 2: rejected (blockedTurns 1 → 2).
  result = JSON.parse(await handleUpdateGoal(session, {status: 'blocked'}));
  expect(result.error).toContain('must recur');
  expect(result.pendingCompletion).toBe(false);

  // Attempt 3: accepted (blockedTurns 2 → threshold met → pending intent set).
  result = JSON.parse(await handleUpdateGoal(session, {status: 'blocked'}));
  expect(result.goal.status).toBe('active');
  expect(result.pendingCompletion).toBe(true);
  const intent = session.getPendingIntent('goal-1');
  expect(intent).not.toBeNull();
  expect(intent?.targetStatus).toBe('blocked');
});

test('handleUpdateGoal blocked on terminal goal returns error', async () => {
  const goal = makeGoal({
    status: 'budgetLimited',
    stopReason: 'budget exhausted',
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'blocked'}),
  );
  expect(result.error).toContain('terminal');
  expect(result.pendingCompletion).toBe(false);
  expect(session.getPendingIntent('goal-1')).toBeNull();
});

test('handleUpdateGoal blocked on already-blocked goal is no-op', async () => {
  const goal = makeGoal({
    status: 'blocked',
    stopReason: 'blocked',
    blockedReason: 'need input',
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'blocked'}),
  );
  expect(result.goal.status).toBe('blocked');
  expect(result.pendingCompletion).toBe(false);
  expect(session.getPendingIntent('goal-1')).toBeNull();
});

test('handleUpdateGoal rejects invalid status', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'paused' as 'complete'}),
  );
  expect(result.error).toContain('can only mark');
});

test('handleUpdateGoal fails when no goal', async () => {
  const session = makeSessionContext({machine: null});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );
  expect(result.error).toContain('no active goal');
});

// handleListGoals

test('handleListGoals returns active and archived goals', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const archived = [makeResult()];
  const session = makeSessionContext({
    machine,
    activeGoals: [machine.snapshot()],
    archived,
  });
  const result = JSON.parse(await handleListGoals(session));
  expect(result.goals).toHaveLength(1);
  expect(result.goals[0].objective).toBe('Build the feature');
  expect(result.archived).toHaveLength(1);
  expect(result.archived[0].objective).toBe('Old completed goal');
  expect(result.focusedGoalId).toBe('goal-1');
});

test('handleListGoals returns error when no goals', async () => {
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    archived: [],
  });
  const result = JSON.parse(await handleListGoals(session));
  expect(result.error).toContain('no goals exist');
});

// handleFocusGoal

test('handleFocusGoal switches to a different goal', async () => {
  const otherGoal = makeGoal({goalId: 'goal-2', condition: 'Other goal'});
  const otherMachine = new GoalStateMachine(otherGoal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({
    machine: null,
    activeGoals: [otherGoal],
    focusedGoal: otherMachine,
  });
  const result = JSON.parse(
    await handleFocusGoal(session, {goal_id: 'goal-2'}),
  );
  expect(result.goal).not.toBeNull();
  expect(result.goal.goalId).toBe('goal-2');
  expect(result.goal.objective).toBe('Other goal');
});

test('handleFocusGoal fails for archived goals', async () => {
  const archived = [makeResult({goalId: 'goal-old-1'})];
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    archived,
  });
  const result = JSON.parse(
    await handleFocusGoal(session, {goal_id: 'goal-old-1'}),
  );
  expect(result.error).toContain('archived');
});

test('handleFocusGoal fails for nonexistent goalId', async () => {
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    focusedGoal: null,
  });
  const result = JSON.parse(
    await handleFocusGoal(session, {goal_id: 'nonexistent'}),
  );
  // the focus contract: the outcome now NAMES which thing happened. `null` used to
  // collapse "no such goal", "that goal is finished", and "no session" into one
  // generic failure, so a user could not tell a typo from a completed goal.
  expect(result.error).toContain('no goal with id');
  expect(result.error).toContain('nonexistent');
});

test('handleFocusGoal rejects empty goal_id', async () => {
  const session = makeSessionContext({machine: null});
  const result = JSON.parse(await handleFocusGoal(session, {goal_id: ''}));
  expect(result.error).toContain('goal_id is required');
});

// Regression: focus_goal must NOT invalidate a pending completion.
// update_goal(complete) records a PendingIntent keyed on goal.revision (the
// step barrier; the continuation loop applies the terminal state after
// step-finish). focus_goal mutated the goal (bumping revision + clearing
// recovery state), which made the pending intent stale — so the completion
// never applied and the goal looped forever. focus must refuse when a
// completion is pending for the target goal, and must NOT mutate it.
test('handleFocusGoal refuses to focus a goal with a pending completion', async () => {
  let focusCalled = false;
  const goal = makeGoal({goalId: 'goal-pending', condition: 'Pending goal'});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const pendingIntent: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({
    machine,
    activeGoals: [goal],
    pendingIntent,
    focusedGoal: machine,
  });
  // Override focusGoal to detect whether it was called (it must NOT be).
  (session as {focusGoal: (id: string) => Promise<unknown>}).focusGoal =
    async () => {
      focusCalled = true;
      return machine;
    };
  const result = JSON.parse(
    await handleFocusGoal(session, {goal_id: 'goal-pending'}),
  );
  expect(result.error).toMatch(/pending completion|completion is pending/i);
  expect(focusCalled).toBe(false);
  // The pending intent must be preserved (focus did not touch it).
  expect(session.getPendingIntent('goal-pending')).not.toBeNull();
  expect(session.getPendingIntent('goal-pending')?.targetStatus).toBe(
    'complete',
  );
});

// Regression (R-rule, Finding 1): focus_goal must refuse to focus AWAY from a
// goal that holds a pending completion. The pending intent is a single
// per-session slot keyed on goal.revision. focusGoal backgrounds the
// currently-focused goal via machine.mutate (bumping ITS revision), which
// makes the pending intent stale → the completion NEVER applies → the goal
// loops forever. The same-goal guard alone was insufficient; this test covers
// the cross-goal path. focus must not run, and the intent must survive.
test('handleFocusGoal refuses to focus away from a goal with a pending completion (cross-goal)', async () => {
  let focusCalled = false;
  // Currently-focused goal A holds the pending completion.
  const goalA = makeGoal({
    goalId: 'goal-A',
    condition: 'Goal A (pending completion)',
  });
  const machineA = new GoalStateMachine(goalA, {
    onCommit: async () => {},
  });
  const pendingIntent: PendingIntent = {
    goalId: goalA.goalId,
    revision: goalA.revision,
    runId: goalA.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  // Target goal B is a distinct, active, non-terminal goal.
  const goalB = makeGoal({goalId: 'goal-B', condition: 'Goal B'});
  const machineB = new GoalStateMachine(goalB, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({
    machine: machineA, // A is focused (holds the pending intent)
    activeGoals: [goalA, goalB],
    pendingIntent,
    focusedGoal: machineB, // if focus were allowed, it would return B
  });
  // Detect whether focusGoal was actually invoked (it must NOT be).
  (session as {focusGoal: (id: string) => Promise<unknown>}).focusGoal =
    async () => {
      focusCalled = true;
      return machineB;
    };
  const result = JSON.parse(
    await handleFocusGoal(session, {goal_id: 'goal-B'}),
  );
  // Focus was refused.
  expect(focusCalled).toBe(false);
  expect(result.error).toMatch(/pending completion|different goal/i);
  // The pending completion for goal A is preserved (focus did not touch it).
  const surviving = session.getPendingIntent('goal-A');
  expect(surviving).not.toBeNull();
  expect(surviving?.goalId).toBe('goal-A');
  expect(surviving?.targetStatus).toBe('complete');
});

// Regression (R-rule, Round-2 review Finding): the focus guard must ALSO cover
// a pending BLOCKED intent, not just completion. update_goal(blocked) sets a
// pending intent through the SAME revision-keyed step barrier as completion
// (validatePendingIntent does not discriminate by targetStatus). focusGoal
// backgrounds the currently-focused goal via mutate (bumping ITS revision),
// which makes a pending blocked intent stale → it's silently discarded at the
// next idle (hooks.ts:604-605 clears it on the non-apply path) → goal A settles
// as "paused" instead of "blocked", losing the agent's asserted impasse + its
// blocker reason. The guard must block focus for ANY pending intent.
test('handleFocusGoal refuses to focus away from a goal with a pending BLOCKED intent (cross-goal)', async () => {
  let focusCalled = false;
  // Currently-focused goal A holds the pending blocked intent.
  const goalA = makeGoal({
    goalId: 'goal-A',
    condition: 'Goal A (pending blocked)',
  });
  const machineA = new GoalStateMachine(goalA, {
    onCommit: async () => {},
  });
  const pendingIntent: PendingIntent = {
    goalId: goalA.goalId,
    revision: goalA.revision,
    runId: goalA.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'blocked',
    evidence: '',
    createdAt: Date.now(),
  };
  // Target goal B is a distinct, active, non-terminal goal.
  const goalB = makeGoal({goalId: 'goal-B', condition: 'Goal B'});
  const machineB = new GoalStateMachine(goalB, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({
    machine: machineA, // A is focused (holds the pending intent)
    activeGoals: [goalA, goalB],
    pendingIntent,
    focusedGoal: machineB, // if focus were allowed, it would return B
  });
  (session as {focusGoal: (id: string) => Promise<unknown>}).focusGoal =
    async () => {
      focusCalled = true;
      return machineB;
    };
  const result = JSON.parse(
    await handleFocusGoal(session, {goal_id: 'goal-B'}),
  );
  // Focus was refused (the blocked path is no longer an escape hatch).
  expect(focusCalled).toBe(false);
  expect(result.error).toMatch(/blocked transition|different goal/i);
  // The pending blocked intent for goal A is preserved (focus did not touch it).
  const surviving = session.getPendingIntent('goal-A');
  expect(surviving).not.toBeNull();
  expect(surviving?.goalId).toBe('goal-A');
  expect(surviving?.targetStatus).toBe('blocked');
});

// serializeToolResponse

test('serializeToolResponse includes all fields', () => {
  const json = serializeToolResponse({
    goal: toThreadGoal(makeGoal(), 'session-1'),
    remainingTokens: 5000,
    completionBudgetReport: null,
    pendingCompletion: false,
  });
  const parsed = JSON.parse(json);
  expect(parsed.goal).not.toBeNull();
  expect(parsed.remainingTokens).toBe(5000);
  expect(parsed.completionBudgetReport).toBeNull();
  expect(parsed.pendingCompletion).toBe(false);
});

test('serializeToolResponse includes error when present', () => {
  const json = serializeToolResponse({
    goal: null,
    remainingTokens: null,
    completionBudgetReport: null,
    pendingCompletion: false,
    error: 'something went wrong',
  });
  const parsed = JSON.parse(json);
  expect(parsed.error).toBe('something went wrong');
});

test('blocked transition cannot replace pending completion intent', async () => {
  //: the mechanical 3-consecutive-blocked rule requires blockedTurns to
  // reach the threshold (default 3) before the intent is set. Set
  // blockedTurns to just-below-threshold so this one call clears it.
  const goal = makeGoal({blockedTurns: 2});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});

  await handleUpdateGoal(session, {status: 'complete'});
  expect(session.getPendingIntent('goal-1')).not.toBeNull();
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('complete');

  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'blocked'}),
  );
  expect(result.error).toContain('completion intent is already pending');
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('complete');
});

test('handleGetGoal pendingCompletion false when intent is for different goal', async () => {
  const goal2 = makeGoal({goalId: 'goal-2'});
  const machine2 = new GoalStateMachine(goal2, {
    onCommit: async () => {},
  });
  const intent: PendingIntent = {
    goalId: 'goal-1',
    revision: 0,
    runId: 'run-1',
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({
    machine: machine2,
    pendingIntent: intent,
  });
  const result = await handleGetGoal(session);
  const parsed = JSON.parse(result);
  expect(parsed.pendingCompletion).toBe(false);
});

// Tool handler edge case stress tests

test('handleCreateGoal rejects non-integer token_budget (3.5)', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = JSON.parse(
    await handleCreateGoal(session, {
      objective: 'test',
      token_budget: 3.5 as number,
    }),
  );
  expect(result.error).toContain('token_budget must be a positive integer');
});

test('handleCreateGoal rejects string token_budget that is non-integer', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = JSON.parse(
    await handleCreateGoal(session, {
      objective: 'test',
      token_budget: '3.5' as unknown as number,
    }),
  );
  expect(result.error).toContain('token_budget must be a positive integer');
});

test('handleCreateGoal accepts string token_budget that parses to integer', async () => {
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    createdGoal: new GoalStateMachine(makeGoal({tokenBudget: 100000}), {
      onCommit: async () => {},
    }),
  });
  const result = JSON.parse(
    await handleCreateGoal(session, {
      objective: 'test',
      token_budget: '100000' as unknown as number,
    }),
  );
  expect(result.error).toBeUndefined();
  expect(result.goal).not.toBeNull();
});

test('handleUpdateGoal accepts case-insensitive status (COMPLETE)', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'COMPLETE' as 'complete'}),
  );
  expect(result.pendingCompletion).toBe(true);
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('complete');
});

test('handleUpdateGoal accepts status with whitespace ( blocked )', async () => {
  //: set blockedTurns to threshold-1 so this call clears it.
  const machine = new GoalStateMachine(makeGoal({blockedTurns: 2}), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: ' blocked ' as 'blocked'}),
  );
  expect(result.pendingCompletion).toBe(true);
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('blocked');
});

test('handleUpdateGoal complete on paused goal sets pending intent', async () => {
  const pausedGoal = makeGoal({status: 'paused', pausedAt: Date.now() - 1000});
  const machine = new GoalStateMachine(pausedGoal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );
  expect(result.pendingCompletion).toBe(true);
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('complete');
});

test('handleUpdateGoal complete during in-flight finalizing sets pending intent', async () => {
  const finalizingGoal = makeGoal({
    status: 'finalizing',
    finalizing: true,
    pausedAt: Date.now() - 1000,
  });
  const machine = new GoalStateMachine(finalizingGoal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );
  expect(result.pendingCompletion).toBe(true);
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('complete');
});

test('handleUpdateGoal complete after finalizing prompt completed returns error', async () => {
  const finalizingGoal = makeGoal({
    status: 'finalizing',
    finalizing: false,
    pausedAt: Date.now() - 1000,
  });
  const machine = new GoalStateMachine(finalizingGoal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'complete'}),
  );
  expect(result.pendingCompletion).toBe(false);
  expect(result.error).toContain(
    'complete can only be called on an active, paused, or blocked goal',
  );
});

test('handleUpdateGoal blocked on finalizing goal returns error', async () => {
  const finalizingGoal = makeGoal({
    status: 'finalizing',
    pausedAt: Date.now() - 1000,
  });
  const machine = new GoalStateMachine(finalizingGoal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'blocked'}),
  );
  expect(result.error).toContain('finalizing');
  expect(result.pendingCompletion).toBe(false);
});

test('handleUpdateGoal blocked on paused goal sets pending intent', async () => {
  //: set blockedTurns to threshold-1 so this call clears it.
  const pausedGoal = makeGoal({
    status: 'paused',
    pausedAt: Date.now() - 1000,
    blockedTurns: 2,
  });
  const machine = new GoalStateMachine(pausedGoal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const result = JSON.parse(
    await handleUpdateGoal(session, {status: 'blocked'}),
  );
  expect(result.pendingCompletion).toBe(true);
  expect(session.getPendingIntent('goal-1')?.targetStatus).toBe('blocked');
  expect(session.getPendingIntent('goal-1')?.revision).toBe(
    machine.snapshot().revision,
  );
});

test('handleFocusGoal rejects whitespace-only goal_id', async () => {
  const session = makeSessionContext({machine: null});
  const result = JSON.parse(await handleFocusGoal(session, {goal_id: '   '}));
  expect(result.error).toContain('goal_id is required');
});

test('handleCreateGoal with exactly MAX_OBJECTIVE_LENGTH chars succeeds', async () => {
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    createdGoal: new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    }),
  });
  const result = JSON.parse(
    await handleCreateGoal(session, {objective: 'x'.repeat(4000)}),
  );
  expect(result.error).toBeUndefined();
  expect(result.goal).not.toBeNull();
});

test('toThreadGoal handles startedAt=0 from corrupted state without huge timeUsedSeconds', () => {
  const goal = makeGoal({startedAt: 0, status: 'paused', pausedAt: Date.now()});
  const threadGoal = toThreadGoal(goal, 'session-1');
  expect(threadGoal.timeUsedSeconds).toBeLessThan(1000000);
});

test('toThreadGoal handles pausedAt=0 from corrupted state without zero timeUsedSeconds', () => {
  const startedAt = Date.now() - 60000;
  const goal = makeGoal({
    startedAt,
    status: 'paused',
    pausedAt: 0,
    finishedAt: null,
  });
  const threadGoal = toThreadGoal(goal, 'session-1');
  expect(threadGoal.timeUsedSeconds).toBeGreaterThan(0);
  expect(threadGoal.timeUsedSeconds).toBeLessThan(1000000);
});

test('handleGetGoal pendingCompletion false for blocked intent', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const goal = machine.snapshot();
  const blockedIntent: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'blocked',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({machine, pendingIntent: blockedIntent});
  const result = JSON.parse(await handleGetGoal(session));
  expect(result.pendingCompletion).toBe(false);
});

test('handleGetGoal pendingCompletion false for stale intent (revision mismatch)', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const goal = machine.snapshot();
  const staleIntent: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({machine, pendingIntent: staleIntent});
  await machine.mutate(
    g => {
      g.condition = 'New objective';
    },
    {source: 'slash-command', detail: 'Simulate /goal edit'},
  );
  const result = JSON.parse(await handleGetGoal(session));
  expect(result.pendingCompletion).toBe(false);
});

test('a completion claim survives a RESTART, and a blocked verdict cannot overwrite it', async () => {
  // THE DEFECT. Startup restores a pending intent at `snapshotRevision + 2`,
  // correctly anticipating the recovery pause (+1) and the authentic-idle re-arm
  // (+1). Until that idle arrives the goal's live revision is one lower, so every
  // `intent.revision === goal.revision` comparison in the tool layer disagreed
  // with itself:
  //
  // - `get_goal` reported `pendingCompletion: false` for a goal whose completion
  // claim was durably recorded;
  // - and the blocked clobber-guard did not fire, so `update_goal(blocked)`
  // replaced the agent's COMPLETION claim with a blocked one and returned
  // `error: null`. The durable record of "achieved" became "blocked" with the
  // tool reporting success.
  //
  // Reproduced on an ordinary restart, with no second process involved. The rule
  // is DIRECTIONAL — a claim recorded against an OLDER state of the goal is stale,
  // and one recorded against the pending re-arm is ahead and live — because
  // equality cannot distinguish an edit from a restart, and both move the revision.
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const goal = machine.snapshot();
  // The restart shape: the goal advanced one revision (the recovery pause) and the
  // intent was restored anticipating the re-arm, so it sits one AHEAD.
  await machine.mutate(
    g => {
      g.revision = goal.revision + 1;
    },
    {source: 'recovery', detail: 'recovery pause', skipPersist: true},
  );
  const restored: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision + 2,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({machine, pendingIntent: restored});

  // The claim is still on record, and the tool must say so.
  const status = JSON.parse(await handleGetGoal(session));
  expect(
    status.pendingCompletion,
    'a completion claim that survived a restart is still pending',
  ).toBe(true);

  // And the claim is a BARRIER: a blocked verdict must not replace it.
  const blocked = JSON.parse(
    await handleUpdateGoal(session, {
      status: 'blocked',
      reason: 'the same blocker recurred',
      toolCallId: 'c1',
    } as never),
  );
  expect(
    blocked.error,
    'a blocked request must be refused while a completion claim is on record',
  ).toContain('already pending');
  expect(
    session.getPendingIntent(goal.goalId)?.targetStatus,
    'the completion claim must still be the one on record',
  ).toBe('complete');
});

test('handleGetGoal pendingCompletion true for valid complete intent', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const goal = machine.snapshot();
  const validIntent: PendingIntent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({machine, pendingIntent: validIntent});
  const result = JSON.parse(await handleGetGoal(session));
  expect(result.pendingCompletion).toBe(true);
});

// STATE-CONVERGENCE-1 (1): pending intents are durable on return

test('update_goal(complete) PERSISTS the pending intent before returning', async () => {
  // The crash window this locks: the intent lived only in a runtime map and was
  // projected on the NEXT unrelated persistence call, so a crash between the
  // two lost the agent's completion claim silently. update_goal must not return
  // until the intent is durable.
  const machine = new GoalStateMachine(
    makeGoal({status: 'active', revision: 3}),
    {
      onCommit: async () => {},
    },
  );
  const persistCalls: number[] = [];
  const session = makeSessionContext({machine, persistCalls});
  const before = persistCalls.length;

  const result = await handleUpdateGoal(session, {status: 'complete'});
  expect(JSON.parse(result).pendingCompletion).toBe(true);
  expect(persistCalls.length).toBeGreaterThan(before);
  expect(session.getPendingIntent(machine.snapshot().goalId)).not.toBeNull();
});

test('update_goal(blocked) past the threshold PERSISTS the blocked intent before returning', async () => {
  const goal = makeGoal({
    status: 'active',
    revision: 2,
    blockedTurns: 2,
    maxBlockedTurns: 3,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const persistCalls: number[] = [];
  const session = makeSessionContext({machine, persistCalls});
  const before = persistCalls.length;

  await handleUpdateGoal(session, {status: 'blocked'});
  expect(persistCalls.length).toBeGreaterThan(before);
  const intent = session.getPendingIntent(machine.snapshot().goalId);
  expect(intent?.targetStatus).toBe('blocked');
});

// The 3-consecutive-blocked rule compares the BLOCKER, not just a count
//
// The rule's message says "the same blocker must recur", but the counter alone
// could be satisfied with three DIFFERENT blockers — making the message untrue
// and the guard weaker than it claimed. These lock the comparison.
test('a CHANGED blocker restarts the streak', async () => {
  const machine = new GoalStateMachine(
    makeGoal({lastAssistantText: 'the CI runner is down'}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  // Attempt 1 with blocker A.
  await handleUpdateGoal(session, {status: 'blocked'});
  expect(machine.snapshot().blockedTurns).toBe(1);
  // A DIFFERENT blocker must not inherit that streak.
  await machine.mutate(
    g => {
      g.lastAssistantText = 'I need a credential I do not have';
    },
    {source: 'update_goal', detail: 'x', skipPersist: true},
  );
  await handleUpdateGoal(session, {status: 'blocked'});
  expect(machine.snapshot().blockedTurns).toBe(1); // restarted, not 2
});

test('the SAME blocker does accumulate to the threshold', async () => {
  const machine = new GoalStateMachine(
    makeGoal({lastAssistantText: 'the CI runner is down'}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  await handleUpdateGoal(session, {status: 'blocked'});
  await handleUpdateGoal(session, {status: 'blocked'});
  expect(machine.snapshot().blockedTurns).toBe(2);
  // Third identical assertion meets the threshold and is accepted.
  const out = await handleUpdateGoal(session, {status: 'blocked'});
  expect(JSON.parse(out).pendingCompletion).toBe(true);
  expect(machine.snapshot().blockedTurns).toBe(0);
});

test('trivial rewording (case/whitespace) still counts as the same blocker', async () => {
  const machine = new GoalStateMachine(
    makeGoal({lastAssistantText: 'the CI   runner is down'}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  await handleUpdateGoal(session, {status: 'blocked'});
  await machine.mutate(
    g => {
      g.lastAssistantText = 'The CI runner is DOWN';
    },
    {source: 'update_goal', detail: 'x', skipPersist: true},
  );
  await handleUpdateGoal(session, {status: 'blocked'});
  expect(machine.snapshot().blockedTurns).toBe(2);
});

test('a realistically REWORDED blocker still accumulates (the rule stays reachable)', async () => {
  // Byte-identical comparison made the rule unreachable: `lastAssistantText` is
  // the whole turn, so a real agent restating one obstacle across turns almost
  // never reproduces it verbatim. That silently disabled the documented terminal
  // route for a genuinely stuck agent.
  const machine = new GoalStateMachine(
    makeGoal({
      lastAssistantText:
        'I cannot proceed: the CI runner is down and I lack access.',
    }),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  await handleUpdateGoal(session, {status: 'blocked'});
  expect(machine.snapshot().blockedTurns).toBe(1);

  await machine.mutate(
    g => {
      g.lastAssistantText =
        'Still blocked. The CI runner is down and I have no access to it.';
    },
    {source: 'update_goal', detail: 'x', skipPersist: true},
  );
  await handleUpdateGoal(session, {status: 'blocked'});
  expect(machine.snapshot().blockedTurns).toBe(2); // same obstacle, reworded

  await machine.mutate(
    g => {
      g.lastAssistantText =
        'Blocked again: the CI runner is down; I still lack the access needed.';
    },
    {source: 'update_goal', detail: 'x', skipPersist: true},
  );
  const out = await handleUpdateGoal(session, {status: 'blocked'});
  expect(JSON.parse(out).pendingCompletion).toBe(true); // 3rd attempt accepted
});

test('a genuinely DIFFERENT blocker still restarts the streak', async () => {
  const machine = new GoalStateMachine(
    makeGoal({lastAssistantText: 'The CI runner is down.'}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  await handleUpdateGoal(session, {status: 'blocked'});
  expect(machine.snapshot().blockedTurns).toBe(1);
  await machine.mutate(
    g => {
      g.lastAssistantText =
        'I need a credential that was never provided, and the design is ambiguous.';
    },
    {source: 'update_goal', detail: 'x', skipPersist: true},
  );
  await handleUpdateGoal(session, {status: 'blocked'});
  expect(machine.snapshot().blockedTurns).toBe(1); // a new obstacle restarts
});
