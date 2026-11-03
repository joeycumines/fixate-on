import {describe, expect, test} from 'bun:test';
import {
  type CommandSessionContext,
  formatGoalList,
  formatGoalResult,
  formatHistory,
  formatStatus,
  handleCommand,
} from '../src/commands.ts';
import type {GoalLifecycleEvent, GoalState} from '../src/state-machine.ts';
import {
  createGoalState,
  GoalStateMachine,
  TERMINAL_STATUSES,
} from '../src/state-machine.ts';
import type {GoalResult} from '../src/persistence.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import type {CreateGoalOptions} from '../src/tools.ts';

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
    constraints: 'No external deps',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {...goal, usage: makeUsage(), ...overrides};
}

function makeMachine(goal?: GoalState): GoalStateMachine {
  return new GoalStateMachine(goal ?? makeGoal(), {
    onCommit: async () => {},
  });
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
    removedGoalIds?: string[];
    persistResult?: boolean;
  } = {},
): CommandSessionContext {
  const machine = opts.machine ?? null;
  const activeGoals = opts.activeGoals ?? (machine ? [machine.snapshot()] : []);
  const archived = opts.archived ?? [];
  const removedGoalIds = opts.removedGoalIds ?? [];
  const persistResult = opts.persistResult ?? true;

  return {
    sessionID: 'session-1',
    getMachine: () => machine,
    // Present because the explicit form (`edit <goalId> …`) is the only way a card
    // action can name its own goal, and a fixture that omits it would make that
    // path unreachable and therefore untested.
    getMachineById: (goalId: string) => {
      const found = activeGoals.find(g => g.goalId === goalId);
      return found ? makeMachine(found) : null;
    },
    listActiveGoals: () => activeGoals,
    listArchivedResults: () => archived,
    createGoal: (_objective: string, _options: CreateGoalOptions) => {
      return opts.createdGoal ?? makeMachine();
    },
    replaceGoals: async (_objective: string, _options: CreateGoalOptions) => {
      return opts.createdGoal ?? makeMachine();
    },
    removeGoal: async (goalId: string) => {
      removedGoalIds.push(goalId);
    },
    clearSession: () => {},
    focusGoal: async (_goalId: string) => {
      const m = opts.focusedGoal;
      return m
        ? {ok: true as const, machine: m}
        : {ok: false as const, reason: 'not-found' as const};
    },
    addOrderedSession: () => {},
    isOrdered: () => false,
    persist: async () => persistResult,
  };
}

// Stateful replacement context: models real replace semantics (remove every
// unfinished goal, then create) so the command tests show actual live-state
// effects and remove-before-create ordering — not merely that a callback fired.
function makeReplaceContext(initial: GoalState[]): {
  session: CommandSessionContext;
  liveGoals: () => GoalState[];
  ops: string[];
} {
  const live = new Map<string, GoalState>(initial.map(g => [g.goalId, g]));
  const ops: string[] = [];
  let seq = 0;
  const createLive = (objective: string): GoalStateMachine => {
    ops.push('create');
    seq += 1;
    const goal = makeGoal({
      goalId: `goal-repl-${seq}`,
      condition: objective,
      status: 'active',
    });
    live.set(goal.goalId, goal);
    return makeMachine(goal);
  };
  const session: CommandSessionContext = {
    sessionID: 'session-1',
    getMachine: () => {
      const arr = [...live.values()];
      return arr.length > 0 ? makeMachine(arr[arr.length - 1]) : null;
    },
    listActiveGoals: () => [...live.values()],
    listArchivedResults: () => [],
    createGoal: (objective: string) => createLive(objective),
    replaceGoals: async (objective: string) => {
      const unfinished = [...live.values()].filter(
        g => !TERMINAL_STATUSES.has(g.status),
      );
      for (const g of unfinished) {
        ops.push(`remove:${g.goalId}`);
        live.delete(g.goalId);
      }
      return createLive(objective);
    },
    removeGoal: async (goalId: string) => {
      ops.push(`remove:${goalId}`);
      live.delete(goalId);
    },
    clearSession: () => {
      live.clear();
    },
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    persist: async () => true,
  };
  return {session, liveGoals: () => [...live.values()], ops};
}

// formatStatus

test('formatStatus shows objective and criteria', () => {
  const goal = makeGoal({successCriteria: 'All tests pass'});
  const status = formatStatus(goal, 'goal');
  expect(status).toContain('Active goal: Build the feature');
  expect(status).toContain('Success criteria: All tests pass');
  expect(status).toContain('Constraints: No external deps');
});

test('formatStatus shows budget info', () => {
  const goal = makeGoal();
  const status = formatStatus(goal, 'goal');
  expect(status).toContain('Token budget:');
  expect(status).toContain('50,000');
  expect(status).toContain('1,500'); // chargedTokens = 1000 + 500
});

test('formatStatus shows turn and token counts', () => {
  const goal = makeGoal({turnCount: 5, totalTokens: 50000});
  const status = formatStatus(goal, 'goal');
  expect(status).toContain('Auto-continues sent: 5/25');
  expect(status).toContain('Context tokens: 50,000/200,000');
});

test('formatStatus shows stopped state', () => {
  const goal = makeGoal({
    status: 'paused',
    stopReason: 'paused',
    pausedAt: Date.now(),
  });
  const status = formatStatus(goal, 'goal');
  expect(status).toContain('Stopped: paused');
  expect(status).toContain('Suggested action:');
});

test('formatStatus omits empty criteria and constraints', () => {
  const goal = makeGoal({successCriteria: '', constraints: ''});
  const status = formatStatus(goal, 'goal');
  expect(status).not.toContain('Success criteria:');
  expect(status).not.toContain('Constraints:');
});

test('formatStatus shows unlimited when limits are 0', () => {
  const goal = makeGoal({maxTurns: 0, maxTokens: 0, maxDurationMs: 0});
  const status = formatStatus(goal, 'goal');
  expect(status).toContain('0/unlimited');
  expect(status).not.toMatch(/\/0\b/);
});

// formatHistory

test('formatHistory returns message for empty history', () => {
  expect(formatHistory([])).toBe('No lifecycle events recorded.');
});

test('formatHistory formats entries', () => {
  const history: GoalLifecycleEvent[] = [
    {timestamp: Date.now() - 60000, type: 'set', detail: 'Goal created'},
    {timestamp: Date.now(), type: 'paused', detail: 'User paused'},
  ];
  const result = formatHistory(history);
  expect(result).toContain('set: Goal created');
  expect(result).toContain('paused: User paused');
});

// formatGoalList

test('formatGoalList shows active goals', () => {
  const goals = [makeGoal()];
  const result = formatGoalList(goals, [], 'goal-1', 'goal');
  expect(result).toContain('Goals (1):');
  expect(result).toContain('Build the feature');
  expect(result).toContain('[focused]');
});

test('formatGoalList shows archived goals', () => {
  const archived = [makeResult()];
  const result = formatGoalList([], archived, null, 'goal');
  expect(result).toContain('Archived (1');
  expect(result).toContain('[achieved] Old completed goal');
});

test('formatGoalList shows empty message', () => {
  const result = formatGoalList([], [], null, 'goal');
  expect(result).toContain('No goals yet');
});

test('formatGoalList shows stopReason for backgrounded active goals', () => {
  const goals = [makeGoal({stopReason: 'backgrounded'})];
  const result = formatGoalList(goals, [], null, 'goal');
  expect(result).toContain('backgrounded');
});

test('formatGoalList shows [background] marker for backgrounded active goals', () => {
  const goals = [makeGoal({stopReason: 'backgrounded'})];
  const result = formatGoalList(goals, [], null, 'goal');
  expect(result).toContain('[background]');
  expect(result).not.toContain('[idle]');
});

// formatGoalResult

test('formatGoalResult shows achieved result', () => {
  const result = makeResult();
  const formatted = formatGoalResult(result);
  expect(formatted).toContain('Last goal: Old completed goal');
  expect(formatted).toContain('State: achieved');
});

// handleCommand

test('handleCommand with no args shows status', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand('', session, 'goal');
  expect(result).toContain('Working: Build the feature');
});

test('handleCommand with status shows status', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand('status', session, 'goal');
  expect(result).toContain('Working: Build the feature');
});

test('handleCommand with no goal shows message', async () => {
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    archived: [],
  });
  const result = await handleCommand('', session, 'goal');
  expect(result).toContain('No active goal');
});

test('handleCommand history shows history', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand('history', session, 'goal');
  expect(result).toContain('Goal history for:');
});

test('handleCommand list shows goal list', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand('list', session, 'goal');
  expect(result).toContain('Goals (1):');
  expect(result).toContain('Build the feature');
});

test('handleCommand clear removes goal', async () => {
  const machine = makeMachine();
  const removedIds: string[] = [];
  const session = makeSessionContext({machine, removedGoalIds: removedIds});
  const result = await handleCommand('clear', session, 'goal');
  expect(result).toContain('Goal cleared');
  expect(removedIds).toContain('goal-1');
});

test('handleCommand clear with no goal shows message', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = await handleCommand('clear', session, 'goal');
  expect(result).toContain('No active goal');
});

test('handleCommand pause pauses goal', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand('pause', session, 'goal');
  expect(result).toContain('Goal paused');
  expect(machine.snapshot().status).toBe('paused');
});

test('handleCommand resume resumes paused goal', async () => {
  const goal = makeGoal({status: 'paused', stopReason: 'paused'});
  const machine = makeMachine(goal);
  const session = makeSessionContext({machine});
  const result = await handleCommand('resume', session, 'goal');
  expect(result).toContain('Goal resumed');
  expect(machine.snapshot().status).toBe('active');
});

test('resume resets the pressure ladder so a post-resume r1 is not worded as escalation', async () => {
  const goal = makeGoal({
    status: 'paused',
    stopReason: 'recovery exhausted',
    pressureRung: 'r4',
  });
  const machine = makeMachine(goal);
  const session = makeSessionContext({machine});
  await handleCommand('resume', session, 'goal');
  expect(machine.snapshot().pressureRung).toBeUndefined();
});

test('handleCommand resume on active goal says already running', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand('resume', session, 'goal');
  expect(result).toContain('already running');
});

test('handleCommand resume on budget-limited goal says terminal', async () => {
  const goal = makeGoal({
    status: 'budgetLimited',
    stopReason: 'budget exhausted',
  });
  const machine = makeMachine(goal);
  const session = makeSessionContext({machine});
  const result = await handleCommand('resume', session, 'goal');
  expect(result).toContain('terminal');
  expect(result).toContain('clear');
});

test('handleCommand resume resets turnCount (fresh budget window)', async () => {
  const goal = makeGoal({
    status: 'paused',
    stopReason: 'max turns reached',
    maxTurns: 2,
    turnCount: 2,
  });
  const machine = makeMachine(goal);
  const session = makeSessionContext({machine});
  const result = await handleCommand('resume', session, 'goal');
  expect(result).toContain('Goal resumed');
  // The count restart is surfaced in the reply, not silent.
  expect(result).toContain('turn count restarted at 0');
  expect(machine.snapshot().status).toBe('active');
  expect(machine.snapshot().turnCount).toBe(0);
});

test('handleCommand bare clear with two goals refuses and names the blast radius', async () => {
  const removedIds: string[] = [];
  const session = makeSessionContext({
    machine: makeMachine(),
    activeGoals: [
      makeGoal({}),
      makeGoal({goalId: 'goal-2', condition: 'Second goal'}),
    ],
    removedGoalIds: removedIds,
  });
  let wiped = false;
  const twoGoalSession: CommandSessionContext = {
    ...session,
    clearSession: () => {
      wiped = true;
    },
  };
  const result = await handleCommand('clear', twoGoalSession, 'goal');
  expect(result).toContain('holds 2 goals');
  expect(result).toContain('clear <goalId>');
  expect(removedIds).toHaveLength(0);
  expect(wiped).toBe(false);
});

test('handleCommand edit on a paused goal says it reactivated', async () => {
  const goal = makeGoal({status: 'paused', stopReason: 'paused'});
  const machine = makeMachine(goal);
  const session = makeSessionContext({machine});
  const result = await handleCommand('edit A new direction', session, 'goal');
  expect(result).toContain('Goal objective updated');
  expect(result).toContain('The goal was paused and is now active again');
  expect(machine.snapshot().status).toBe('active');
});

test('handleCommand edit with a STALE goal id refuses instead of rewriting the wrong goal', async () => {
  // The palette resolves its goal before the prompt opens; if that goal is
  // cleared while the prompt is open, the id arrives naming a goal that no
  // longer exists. The stale id must be REPORTED — folding it into the
  // objective would rewrite the focused goal with the dead id in its text.
  const live = makeGoal({
    goalId: 'bbbbbbbb-0000-0000-0000-000000000002',
    condition: 'Beta duties',
  });
  const machine = makeMachine(live);
  const session = makeSessionContext({machine, activeGoals: [live]});
  const result = await handleCommand(
    'edit aaaaaaaa-0000-0000-0000-000000000001 my new objective',
    session,
    'goal',
  );
  expect(result).toContain('could not be resolved');
  expect(machine.snapshot().condition).toBe('Beta duties');
});

test('handleCommand checkpoint with a STALE goal id refuses instead of writing the wrong clock', async () => {
  const live = makeGoal({
    goalId: 'bbbbbbbb-0000-0000-0000-000000000002',
    condition: 'Beta duties',
  });
  const machine = makeMachine(live);
  const session = makeSessionContext({machine, activeGoals: [live]});
  const result = await handleCommand(
    'checkpoint aaaaaaaa-0000-0000-0000-000000000001 my note',
    session,
    'goal',
  );
  expect(result).toContain('could not be resolved');
  expect(machine.snapshot().lastCheckpoint).toBeNull();
});

test('handleCommand edit with a plain sentence stays an objective, not a reference', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand(
    'edit fix the failing tests',
    session,
    'goal',
  );
  expect(result).toContain('Goal objective updated: fix the failing tests');
  expect(machine.snapshot().condition).toBe('fix the failing tests');
});

test('handleCommand edit changes objective', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand(
    'edit New improved objective',
    session,
    'goal',
  );
  expect(result).toContain('Goal objective updated');
  expect(machine.snapshot().condition).toBe('New improved objective');
  expect(machine.snapshot().objectiveUpdatedPending).toBe(true);
});

test('handleCommand edit with no new objective shows error', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand('edit', session, 'goal');
  expect(result).toContain('No new objective');
});

test('handleCommand edit with no goal shows error', async () => {
  const session = makeSessionContext({machine: null});
  const result = await handleCommand('edit something', session, 'goal');
  expect(result).toContain('No active goal to edit');
});

test('handleCommand focus by number switches goal', async () => {
  const goal1 = makeGoal({goalId: 'goal-1', condition: 'First goal'});
  const goal2 = makeGoal({goalId: 'goal-2', condition: 'Second goal'});
  const machine2 = makeMachine(goal2);
  const session = makeSessionContext({
    machine: makeMachine(goal1),
    activeGoals: [goal1, goal2],
    focusedGoal: machine2,
  });
  const result = await handleCommand('focus 2', session, 'goal');
  expect(result).toContain('Focused goal: Second goal');
});

test('handleCommand focus with no args shows list', async () => {
  const goal1 = makeGoal({goalId: 'goal-1', condition: 'First goal'});
  const session = makeSessionContext({
    machine: makeMachine(goal1),
    activeGoals: [goal1],
  });
  const result = await handleCommand('focus', session, 'goal');
  expect(result).toContain('Specify which goal');
});

test('handleCommand focus with no goals shows error', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = await handleCommand('focus 1', session, 'goal');
  expect(result).toContain('No goals to focus');
});

test('handleCommand checkpoint saves checkpoint', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand(
    'checkpoint Halfway done',
    session,
    'goal',
  );
  expect(result).toContain('Checkpoint saved');
  expect(machine.snapshot().lastCheckpoint?.summary).toBe('Halfway done');
});

test('handleCommand checkpoint with no summary shows error', async () => {
  const machine = makeMachine();
  const session = makeSessionContext({machine});
  const result = await handleCommand('checkpoint', session, 'goal');
  expect(result).toContain('Provide a checkpoint summary');
});

// `edit` and `checkpoint` take a free-text OPERAND, so unlike `pause <ref>` they
// could not name a goal — and the v1 cockpit dispatched both bare, which resolves
// through the FOCUSED goal. These hold the grammar that fixes it, in both
// directions: named, and plain language.
describe('a verb with a free-text operand can still name its goal', () => {
  const FOCUSED = 'goal-focused-1';
  const OTHER = 'goal-other-2';

  function twoGoalSession() {
    const focused = makeMachine(
      makeGoal({
        goalId: FOCUSED,
        condition: 'the focused goal',
        status: 'active',
      }),
    );
    const other = makeMachine(
      makeGoal({goalId: OTHER, condition: 'the other goal', status: 'paused'}),
    );
    // A map of the REAL machines, not snapshots: `getMachineById` returning a machine
    // rebuilt from a snapshot would send every mutation to a throwaway, and the
    // assertion "the named goal was edited" would fail for a reason that has nothing
    // to do with the rule under test.
    const byId = new Map([
      [focused.snapshot().goalId, focused],
      [other.snapshot().goalId, other],
    ]);
    const session = makeSessionContext({
      machine: focused,
      activeGoals: [focused.snapshot(), other.snapshot()],
    });
    session.getMachineById = (goalId: string) => byId.get(goalId) ?? null;
    return {focused, other, session};
  }

  test('`edit <goalId> <objective>` edits THAT goal, and does not touch the focused one', async () => {
    const {focused, other, session} = twoGoalSession();
    const result = await handleCommand(
      `edit ${OTHER} A NEW OBJECTIVE`,
      session,
      'goal',
    );
    expect(result).toContain('A NEW OBJECTIVE');
    expect(other.snapshot().condition, 'the named goal was not edited').toBe(
      'A NEW OBJECTIVE',
    );
    expect(
      focused.snapshot().condition,
      'the FOCUSED goal was edited instead',
    ).toBe('the focused goal');
  });

  test('`checkpoint <goalId> <summary>` checkpoints THAT goal', async () => {
    const {focused, other, session} = twoGoalSession();
    const result = await handleCommand(
      `checkpoint ${OTHER} a note about the other goal`,
      session,
      'goal',
    );
    expect(result).toContain('a note about the other goal');
    expect(other.snapshot().lastCheckpoint?.summary).toBe(
      'a note about the other goal',
    );
    expect(
      focused.snapshot().lastCheckpoint,
      'the FOCUSED goal was checkpointed instead',
    ).toBeNull();
  });

  test('the PLAIN form is still plain language, not a reference', async () => {
    // The reason the leading token is read as a reference only when it is the FULL
    // id of a goal that exists: design principle 4 makes natural language primary,
    // and `/goal edit 2 fix the failing tests` must not become an edit of goal 2.
    const {focused, session} = twoGoalSession();
    await handleCommand('edit 2 fix the failing tests', session, 'goal');
    expect(focused.snapshot().condition).toBe('2 fix the failing tests');
    await handleCommand('checkpoint 1 done for now', session, 'goal');
    expect(focused.snapshot().lastCheckpoint?.summary).toBe('1 done for now');
  });

  test("a leading token that is not a goal's full id stays part of the objective", async () => {
    const {focused, session} = twoGoalSession();
    await handleCommand(
      `edit ${OTHER}-partial a new objective`,
      session,
      'goal',
    );
    expect(
      focused.snapshot().condition,
      'a PREFIX was read as a reference',
    ).toBe(`${OTHER}-partial a new objective`);
  });

  test('a MISTYPED id is part of the objective, not a reference that falls back', async () => {
    // The deliberate price of keeping plain language primary (design principle 4):
    // a leading token is read as a reference only when it is the full id of a goal
    // that exists, so a typo cannot be reported as a bad reference. It becomes part
    // of the objective instead — visible, and never silently aimed at another goal.
    const {focused, session} = twoGoalSession();
    const edited = await handleCommand(
      'edit goal-does-not-exist some objective',
      session,
      'goal',
    );
    expect(edited).toContain('some objective');
    expect(focused.snapshot().condition).toBe(
      'goal-does-not-exist some objective',
    );
  });

  test('a resolvable id on a host WITHOUT getMachineById is reported, not aimed at the focused goal', async () => {
    // `getMachineById` is optional on the session context, so a host can resolve a
    // goal by name and then be unable to act on it. Falling back to the focused goal
    // there would reintroduce the defect the explicit form exists to remove.
    const {focused, session} = twoGoalSession();
    session.getMachineById = undefined;
    const result = await handleCommand(
      `edit ${OTHER} A NEW OBJECTIVE`,
      session,
      'goal',
    );
    expect(result).toContain('could not be resolved');
    expect(
      focused.snapshot().condition,
      'the objective was applied to the focused goal',
    ).toBe('the focused goal');
  });
});

test('handleCommand with objective creates goal', async () => {
  const newMachine = makeMachine(makeGoal({condition: 'New objective'}));
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    createdGoal: newMachine,
  });
  const result = await handleCommand('Build something new', session, 'goal');
  expect(result).toContain('New active goal: Build something new');
});

test('handleCommand bare /goal replaces a single unfinished goal (live state shows removal)', async () => {
  const existing = makeGoal({
    goalId: 'goal-old',
    condition: 'Old objective',
    status: 'active',
  });
  const {session, liveGoals, ops} = makeReplaceContext([existing]);
  const result = await handleCommand('New objective', session, 'goal');
  expect(result).toContain('New active goal: New objective');
  expect(result).not.toContain('unfinished goal');
  const live = liveGoals();
  expect(live.length).toBe(1);
  expect(live[0].condition).toBe('New objective');
  expect(live.some(g => g.goalId === 'goal-old')).toBe(false);
  expect(ops).toEqual(['remove:goal-old', 'create']);
});

test('handleCommand bare /goal replaces ALL unfinished goals (multi-goal)', async () => {
  const a = makeGoal({goalId: 'goal-a', condition: 'First', status: 'active'});
  const b = makeGoal({goalId: 'goal-b', condition: 'Second', status: 'paused'});
  const {session, liveGoals, ops} = makeReplaceContext([a, b]);
  const result = await handleCommand('Replacement', session, 'goal');
  expect(result).toContain('New active goal: Replacement');
  const live = liveGoals();
  expect(live.length).toBe(1);
  expect(live[0].condition).toBe('Replacement');
  expect(ops).toEqual(['remove:goal-a', 'remove:goal-b', 'create']);
});

test('handleCommand bare /goal keeps terminal goals but replaces unfinished ones', async () => {
  const terminal = makeGoal({
    goalId: 'goal-term',
    condition: 'Done',
    status: 'complete',
  });
  const unfinished = makeGoal({
    goalId: 'goal-wip',
    condition: 'In flight',
    status: 'active',
  });
  const {session, liveGoals, ops} = makeReplaceContext([terminal, unfinished]);
  const result = await handleCommand('Fresh', session, 'goal');
  expect(result).toContain('New active goal: Fresh');
  const live = liveGoals();
  expect(live.length).toBe(2);
  expect(live.some(g => g.goalId === 'goal-term')).toBe(true);
  expect(live.some(g => g.goalId === 'goal-wip')).toBe(false);
  expect(ops).toEqual(['remove:goal-wip', 'create']);
});

test('handleCommand with too-long objective shows error', async () => {
  const session = makeSessionContext({machine: null, activeGoals: []});
  const result = await handleCommand('x'.repeat(4001), session, 'goal');
  expect(result).toContain('4000 characters or fewer');
});

test('handleCommand with quoted objective strips quotes', async () => {
  const newMachine = makeMachine(makeGoal({condition: 'Quoted objective'}));
  const session = makeSessionContext({
    machine: null,
    activeGoals: [],
    createdGoal: newMachine,
  });
  const result = await handleCommand('"Quoted objective"', session, 'goal');
  expect(result).toContain('New active goal: Quoted objective');
});

test('handleCommand creates new goal when completed goal exists', async () => {
  const completedGoal = makeGoal({status: 'complete'});
  const newMachine = makeMachine(makeGoal({condition: 'New objective'}));
  const session = makeSessionContext({
    machine: null,
    activeGoals: [completedGoal],
    createdGoal: newMachine,
  });
  const result = await handleCommand('New objective', session, 'goal');
  expect(result).toContain('New active goal: New objective');
});

test('handleCommand creates new goal when budgetLimited goal exists', async () => {
  const budgetGoal = makeGoal({status: 'budgetLimited'});
  const newMachine = makeMachine(makeGoal({condition: 'Fresh start'}));
  const session = makeSessionContext({
    machine: null,
    activeGoals: [budgetGoal],
    createdGoal: newMachine,
  });
  const result = await handleCommand('Fresh start', session, 'goal');
  expect(result).toContain('New active goal: Fresh start');
});

test('resume resets turnCount before transition to active (race: idle could re-pause)', async () => {
  const goal = makeGoal({
    status: 'paused',
    stopReason: 'max turns reached',
    maxTurns: 2,
    turnCount: 2,
  });
  const commitSnapshots: {turnCount: number; status: string}[] = [];
  const machine = new GoalStateMachine(goal, {
    onCommit: async snapshot => {
      commitSnapshots.push({
        turnCount: snapshot.turnCount,
        status: snapshot.status,
      });
    },
  });
  const session = makeSessionContext({machine});
  await handleCommand('resume', session, 'goal');

  const activeCommit = commitSnapshots.find(s => s.status === 'active');
  expect(activeCommit).toBeDefined();
  expect(activeCommit!.turnCount).toBe(0);
});

test('/goal add rejects objective exceeding MAX_OBJECTIVE_LENGTH', async () => {
  const session = makeSessionContext({machine: null});
  const longObjective = 'x'.repeat(4001);
  const result = await handleCommand(`add ${longObjective}`, session, 'goal');
  expect(result).toContain('4000 characters or fewer');
  expect(result).not.toContain('Added and focused new goal');
});

test('formatStatus uses finishedAt for completed goal elapsed time', () => {
  const startedAt = Date.now() - 120000;
  const goal = makeGoal({
    status: 'complete',
    startedAt,
    finishedAt: startedAt + 60000,
    pausedAt: 0,
  });
  const result = formatStatus(goal, 'goal');
  expect(result).toContain('Elapsed: 60s/');
});

test('/goal sequence queues goals with status paused (not active)', async () => {
  const createdMachines: GoalStateMachine[] = [];
  const session: CommandSessionContext = {
    sessionID: 'session-1',
    getMachine: () => createdMachines[0] ?? null,
    listActiveGoals: () => createdMachines.map(m => m.snapshot()),
    listArchivedResults: () => [],
    createGoal: (objective: string, options: CreateGoalOptions) => {
      const goal = createGoalState('session-1', objective, {
        goalId: `goal-${createdMachines.length + 1}`,
        runId: 'run-1',
        ...options,
      });
      const machine = new GoalStateMachine(goal, {
        onCommit: async () => {},
      });
      createdMachines.push(machine);
      return machine;
    },
    replaceGoals: async (objective: string, options: CreateGoalOptions) => {
      const goal = createGoalState('session-1', objective, {
        goalId: `goal-${createdMachines.length + 1}`,
        runId: 'run-1',
        ...options,
      });
      const machine = new GoalStateMachine(goal, {
        onCommit: async () => {},
      });
      createdMachines.push(machine);
      return machine;
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async (goalId: string) => {
      const m = createdMachines.find(x => x.state.goalId === goalId);
      return m
        ? {ok: true as const, machine: m}
        : {ok: false as const, reason: 'not-found' as const};
    },
    addOrderedSession: () => {},
    isOrdered: () => false,
    persist: async () => true,
  };

  await handleCommand(
    'sequence first goal; second goal; third goal',
    session,
    'goal',
  );

  expect(createdMachines[0].state.status).toBe('active');
  expect(createdMachines[1].state.status).toBe('paused');
  expect(createdMachines[2].state.status).toBe('paused');
  expect(createdMachines[1].state.stopReason).toBe('queued');
  expect(createdMachines[2].state.stopReason).toBe('queued');
});

test('formatStatus clamps elapsed to 0 on clock skew and startedAt=0', () => {
  const goal = makeGoal({
    status: 'active',
    startedAt: Date.now() + 60000,
    lastProgressAt: Date.now() + 60000,
  });
  const result = formatStatus(goal, 'goal');
  expect(result).not.toContain('Elapsed: -');
  expect(result).toContain('Elapsed: 0s/');
  expect(result).not.toContain('Last progress: -');
  expect(result).toContain('Last progress: 0s ago');
});

test('formatStatus handles startedAt=0 without huge elapsed time', () => {
  const goal = makeGoal({
    status: 'active',
    startedAt: 0,
  });
  const result = formatStatus(goal, 'goal');
  expect(result).toContain('Elapsed: 0s/');
});

test('MULTI-GOAL: add keeps the current goal ACTIVE', async () => {
  const goal1 = createGoalState('session-1', 'First goal', {
    goalId: 'goal-1',
    runId: 'run-1',
  });
  const machine1 = new GoalStateMachine(goal1, {
    onCommit: async () => {},
  });
  const createdMachines: GoalStateMachine[] = [machine1];
  let focusedMachine: GoalStateMachine | null = machine1;

  const session: CommandSessionContext = {
    sessionID: 'session-1',
    getMachine: () => focusedMachine,
    listActiveGoals: () => createdMachines.map(m => m.snapshot()),
    listArchivedResults: () => [],
    createGoal: (objective: string, options: CreateGoalOptions) => {
      const goal = createGoalState('session-1', objective, {
        goalId: `goal-${createdMachines.length + 1}`,
        runId: 'run-1',
        ...options,
      });
      const machine = new GoalStateMachine(goal, {
        onCommit: async () => {},
      });
      createdMachines.push(machine);
      focusedMachine = machine;
      return machine;
    },
    replaceGoals: async (objective: string, options: CreateGoalOptions) => {
      const goal = createGoalState('session-1', objective, {
        goalId: `goal-${createdMachines.length + 1}`,
        runId: 'run-1',
        ...options,
      });
      const machine = new GoalStateMachine(goal, {
        onCommit: async () => {},
      });
      createdMachines.push(machine);
      focusedMachine = machine;
      return machine;
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async (goalId: string) => {
      const m = createdMachines.find(x => x.state.goalId === goalId);
      return m
        ? {ok: true as const, machine: m}
        : {ok: false as const, reason: 'not-found' as const};
    },
    addOrderedSession: () => {},
    isOrdered: () => false,
    persist: async () => true,
  };

  await handleCommand('add Second goal', session, 'goal');

  // The new goal exists and is focused...
  expect(createdMachines.length).toBe(2);
  expect(focusedMachine).toBe(createdMachines[1]);
  expect(createdMachines[1]!.state.condition).toBe('Second goal');
  //...and the PREVIOUS goal is UNTOUCHED — still active, never backgrounded.
  expect(machine1.state.status).toBe('active');
  expect(machine1.state.stopReason).toBe('');
});
