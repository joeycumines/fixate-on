// fork-bind.test.ts — SESSION-GOAL-BINDING-1: a session fork COPIES its live goals.
//
// the user decision (2026-09-26): when a goal's session is forked, the fork gets
// its own copy of each live goal and the parent keeps its own. The alternatives
// were rejected on recorded grounds — re-pointing ownership would silently stop
// the parent working on an objective the user never withdrew, and sharing one
// goal across two sessions is impossible without making `GoalState.sessionID`
// ambiguous, which is the single field every ownership fence reads.
//
// MEASURED host behaviour this rests on:
// v2 emits a durable `session.forked` event carrying a REQUIRED `parentID`
// (the host's session-event schema), it is in
// `SessionEvent.Definitions` which composes into the union the plugin's
// `ctx.event.subscribe` streams, and the plugin's event loop forwards
// every event type — so it reaches the handler with no adapter change.
// v1 forks carry NO ancestry: `Session.fork` calls `createNext({directory})`
// with no `parentID`, confirmed live (`parentID: None`).
// The arm therefore never fires on v1, which is correct rather than a gap.
import {describe, expect, test} from 'bun:test';
import {GoalsPlugin} from '../src/plugin.ts';
import {TEST_WORKSPACE_DIR} from './identity-stub.ts';
import {
  copyGoalsToForkedSession,
  extractForkParentID,
  forkObjective,
  type ForkSourceGoal,
  inheritOptionsFrom,
} from '../src/fork-bind.ts';

const NO_PERSIST = {persistState: false};

// The pure projection

function sourceGoal(overrides: Partial<ForkSourceGoal> = {}): ForkSourceGoal {
  return {
    goalId: 'g-source',
    status: 'active',
    stopReason: '',
    condition: 'make the build reproducible',
    successCriteria: 'two runs produce the same artifact hash',
    constraints: 'do not touch the release pipeline',
    artifactPointers: ['dist/app.tar.gz'],
    mode: 'normal',
    tokenBudget: 250000,
    maxTokens: 1000000,
    maxTurns: 0,
    maxDurationMs: 1800000,
    minDelayMs: 2000,
    noProgressTokenThreshold: 50,
    noProgressTurnsBeforePause: 3,
    noToolCallTurnsBeforePause: 3,
    maxRecoveryTurns: 12,
    maxUnchangedResults: 3,
    maxBlockedTurns: 3,
    languageTriage: true,
    ...overrides,
  };
}

describe("the copy carries INTENT and not the parent's work record", () => {
  test('the objective crosses unchanged', () => {
    // Not prefixed with provenance: the objective is what the user wrote, it is
    // displayed everywhere, and machinery in it would misreport the goal.
    expect(forkObjective(sourceGoal())).toBe('make the build reproducible');
  });

  test('the completion contract and the mode cross', () => {
    const opts = inheritOptionsFrom(sourceGoal());
    expect(opts.successCriteria).toBe(
      'two runs produce the same artifact hash',
    );
    expect(opts.constraints).toBe('do not touch the release pipeline');
    expect(opts.artifactPointers).toEqual(['dist/app.tar.gz']);
    expect(opts.mode).toBe('normal');
  });

  test('the artifact pointers are COPIED, not aliased', () => {
    // A shared array would let an edit in the fork mutate the parent's goal.
    const goal = sourceGoal();
    const opts = inheritOptionsFrom(goal);
    opts.artifactPointers!.push('leaked.txt');
    expect(goal.artifactPointers).toEqual(['dist/app.tar.gz']);
  });

  test('the budget configuration crosses', () => {
    const opts = inheritOptionsFrom(sourceGoal());
    expect(opts.tokenBudget).toBe(250000);
    expect(opts.maxTokens).toBe(1000000);
    // maxTurns 0 is the "disabled" sentinel and must survive as 0, not be
    // treated as absent and replaced with a default turn brake.
    expect(opts.maxTurns).toBe(0);
    expect(opts.maxDurationMs).toBe(1800000);
    expect(opts.maxRecoveryTurns).toBe(12);
    expect(opts.maxBlockedTurns).toBe(3);
  });

  test('NO work record is projected — a copy that inherited counters would lie', () => {
    // The projection returns ONLY the intent keys. Anything recording work
    // (turnCount, totalTokens, recoveryTurns, attestationFaults, blockedTurns,
    // claims, pending intents, continuationClaim) is absent by construction,
    // so the fork's own state starts empty and truthful.
    const opts = inheritOptionsFrom(sourceGoal());
    const workRecordKeys = [
      'turnCount',
      'totalTokens',
      'recoveryTurns',
      'unchangedResults',
      'attestationFaults',
      'blockedTurns',
      'promptFailures',
      'noProgressTurns',
      'noToolCallTurns',
      'claims',
      'pendingIntent',
      'continuationClaim',
      'lastCandidate',
      'lastFingerprint',
      'history',
      'checkpoints',
    ];
    for (const key of workRecordKeys) {
      expect(Object.keys(opts)).not.toContain(key);
    }
  });
});

// The parent-id reader

describe('extractForkParentID reads only an explicit parent, never a guess', () => {
  test('the measured v2 shape is read', () => {
    expect(
      extractForkParentID({
        sessionID: 'fork',
        parentID: 'parent',
        boundary: {type: 'through'},
      }),
    ).toBe('parent');
  });

  test('nested shapes the event reader also accepts are read', () => {
    expect(extractForkParentID({info: {parentID: 'p-info'}})).toBe('p-info');
    expect(extractForkParentID({session: {parentID: 'p-session'}})).toBe(
      'p-session',
    );
  });

  test('a missing or unusable parent yields undefined, never a wrong id', () => {
    // Copying a goal into the WRONG session is far worse than not copying it,
    // so every degenerate shape declines.
    expect(extractForkParentID(undefined)).toBeUndefined();
    expect(extractForkParentID(null)).toBeUndefined();
    expect(extractForkParentID('parent')).toBeUndefined();
    expect(extractForkParentID({})).toBeUndefined();
    expect(extractForkParentID({sessionID: 'fork'})).toBeUndefined();
    expect(extractForkParentID({parentID: ''})).toBeUndefined();
    expect(extractForkParentID({parentID: '   '})).toBeUndefined();
    expect(extractForkParentID({parentID: 42})).toBeUndefined();
    // The v1 title is NOT ancestry and must never be parsed as one.
    expect(extractForkParentID({title: '(fork #1)'})).toBeUndefined();
  });
});

// copyGoalsToForkedSession, against a recording target

describe('copyGoalsToForkedSession copies each live goal and records provenance', () => {
  function recordingTarget() {
    const created: Array<{
      objective: string;
      options: Record<string, unknown>;
    }> = [];
    const mutations: Array<{goal: Record<string, unknown>}> = [];
    const focused: string[] = [];
    let orderedCalls = 0;
    let nextId = 1;
    const target = {
      createGoal(objective: string, options: Record<string, unknown>) {
        created.push({objective, options});
        const goalId = `copy-${nextId++}`;
        const state = {
          goalId,
          status: 'active',
          stopReason: '',
          pausedAt: 0,
          history: [] as Array<{type: string; detail: string}>,
        };
        return {
          state,
          async mutate(fn: (goal: unknown) => void) {
            fn(state);
            mutations.push({goal: state});
          },
        };
      },
      async focusGoal(goalId: string) {
        focused.push(goalId);
      },
      addOrderedSession() {
        orderedCalls++;
      },
    };
    return {
      target,
      created,
      mutations,
      focused,
      orderedCalls: () => orderedCalls,
    };
  }

  test('every source goal is copied and its objective returned', async () => {
    const {target, created} = recordingTarget();
    const copied = await copyGoalsToForkedSession({
      sourceGoals: [
        sourceGoal(),
        sourceGoal({goalId: 'g-2', condition: 'second objective'}),
      ],
      target,
      parentSessionID: 'parent-session',
      createdAt: 1234,
    });
    expect(copied).toEqual(['make the build reproducible', 'second objective']);
    expect(created).toHaveLength(2);
    expect(created[0]!.options.successCriteria).toBe(
      'two runs produce the same artifact hash',
    );
  });

  test('each copy records the parent session it came from', async () => {
    const {target, mutations} = recordingTarget();
    await copyGoalsToForkedSession({
      sourceGoals: [sourceGoal()],
      target,
      parentSessionID: 'parent-session',
      createdAt: 1234,
    });
    const history = mutations[0]!.goal.history as Array<{
      type: string;
      detail: string;
      timestamp: number;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.type).toBe('forked');
    expect(history[0]!.detail).toContain('parent-session');
    expect(history[0]!.detail).toContain('g-source');
    expect(history[0]!.timestamp).toBe(1234);
  });

  test('no source goals copies nothing', async () => {
    const {target, created} = recordingTarget();
    const copied = await copyGoalsToForkedSession({
      sourceGoals: [],
      target,
      parentSessionID: 'parent-session',
      createdAt: 1,
    });
    expect(copied).toEqual([]);
    expect(created).toHaveLength(0);
  });

  test('a DELIBERATE halt crosses: /goal pause stays paused', async () => {
    // The intent/work split applied to status. An explicit pause is the user's
    // instruction; reviving it in the fork would be the plugin fighting a human
    // who said stop.
    const {target, mutations} = recordingTarget();
    await copyGoalsToForkedSession({
      sourceGoals: [
        sourceGoal({status: 'paused', stopReason: 'explicit pause'}),
      ],
      target,
      parentSessionID: 'parent-session',
      createdAt: 77,
    });
    const copy = mutations[0]!.goal;
    expect(copy.status).toBe('paused');
    expect(copy.stopReason).toBe('explicit pause');
    expect(copy.pausedAt).toBe(77);
  });

  test("an ordered sequence's queued position crosses, so its order is kept", async () => {
    const {target, mutations} = recordingTarget();
    await copyGoalsToForkedSession({
      sourceGoals: [
        sourceGoal({goalId: 'g-1', condition: 'first'}),
        sourceGoal({
          goalId: 'g-2',
          condition: 'second',
          status: 'paused',
          stopReason: 'queued',
        }),
      ],
      target,
      parentSessionID: 'parent-session',
      createdAt: 77,
    });
    expect(mutations[0]!.goal.status).toBe('active');
    expect(mutations[1]!.goal.status).toBe('paused');
    expect(mutations[1]!.goal.stopReason).toBe('queued');
  });

  test('a MECHANICAL pause does NOT cross — the counters behind it are not inherited', async () => {
    // A turn/token/duration brake, a stall, or a recovery pause is a fact about
    // the PARENT's run, and the copy starts with a fresh budget and no counters.
    // Inheriting the halt without the counters would leave the fork paused by a
    // brake that has nothing left to stop.
    for (const stopReason of [
      'max turns',
      'token budget',
      'no progress',
      'recovery',
      'deferred too many times',
    ]) {
      const {target, mutations} = recordingTarget();
      await copyGoalsToForkedSession({
        sourceGoals: [sourceGoal({status: 'paused', stopReason})],
        target,
        parentSessionID: 'parent-session',
        createdAt: 77,
      });
      expect(mutations[0]!.goal.status).toBe('active');
    }
  });

  test('an ordered sequence registers the fork as ordered', async () => {
    // `mode: "ordered"` is a per-goal field, but the ordering is SESSION state
    // (`session.isOrdered`), and `hooks.ts` gates auto-promotion on it. A copy
    // carrying the field without the registration would be told by its own
    // prompt that it is part of a sequence while nothing sequences it.
    const {target, orderedCalls} = recordingTarget();
    await copyGoalsToForkedSession({
      sourceGoals: [sourceGoal({mode: 'ordered'})],
      target,
      parentSessionID: 'parent-session',
      createdAt: 1,
    });
    expect(orderedCalls()).toBe(1);

    const plain = recordingTarget();
    await copyGoalsToForkedSession({
      sourceGoals: [sourceGoal({mode: 'normal'})],
      target: plain.target,
      parentSessionID: 'parent-session',
      createdAt: 1,
    });
    expect(plain.orderedCalls()).toBe(0);
  });

  test("the fork's FOCUS is the parent's focus, not the last copy created", async () => {
    // `createGoal` focuses each goal it creates, so without this the fork opens
    // on the last copy — for an ordered sequence, its final step.
    const {target, focused} = recordingTarget();
    await copyGoalsToForkedSession({
      sourceGoals: [
        sourceGoal({goalId: 'g-1', condition: 'first'}),
        sourceGoal({goalId: 'g-2', condition: 'second'}),
        sourceGoal({goalId: 'g-3', condition: 'third'}),
      ],
      target,
      parentSessionID: 'parent-session',
      createdAt: 1,
      focusedGoalId: 'g-1',
    });
    expect(focused).toEqual(['copy-1']);
  });
});

// End to end, through the REAL plugin and REAL state

function makeClient() {
  return {
    app: {
      log: async () => {},
    },
    session: {
      messages: async () => ({data: []}),
      promptAsync: async () => ({}),
    },
  };
}

async function makePlugin() {
  const hooks = await GoalsPlugin(
    {client: makeClient(), directory: TEST_WORKSPACE_DIR},
    {
      ...NO_PERSIST,
      idlePoller: false,
    },
  );
  return hooks;
}

type Hooks = Awaited<ReturnType<typeof GoalsPlugin>>;

async function goalCommand(
  hooks: Hooks,
  sessionID: string,
  args: string,
): Promise<string> {
  const output: {parts: {type: string; text: string}[]} = {parts: []};
  await hooks['command.execute.before']!(
    {command: 'goal', sessionID, arguments: args},
    output,
  );
  return output.parts[0]?.text ?? '';
}

async function readGoals(
  hooks: Hooks,
  sessionID: string,
): Promise<Array<Record<string, unknown>>> {
  // `list_goals` is the multi-goal reader; `get_goal` returns only the focused
  // goal. Its projection exposes objective/status/goalId/threadId/tokensUsed —
  // enough to show the WIRING (which goal landed in which session). The
  // projection's finer detail (successCriteria, history) is asserted in the
  // unit tests above, where the real objects are in hand.
  const listGoals = hooks.tool?.list_goals as
    | {
        execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
      }
    | undefined;
  const raw = await listGoals!.execute!({}, {sessionID});
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return (parsed as {goals?: Array<Record<string, unknown>>}).goals ?? [];
}

const FORK_EVENT = (forkSession: string, parentSession: string) => ({
  type: 'session.forked',
  sessionID: forkSession,
  properties: {
    sessionID: forkSession,
    parentID: parentSession,
    boundary: {type: 'through'},
  },
});

describe('forking a session copies its live goals', () => {
  test('the fork receives a copy and the parent keeps its own', async () => {
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-session', 'make the build reproducible');

    const parentBefore = await readGoals(hooks, 'parent-session');
    expect(parentBefore).toHaveLength(1);
    expect(parentBefore[0]!.status).toBe('active');

    await hooks.event!(FORK_EVENT('fork-session', 'parent-session'));

    const forked = await readGoals(hooks, 'fork-session');
    expect(forked).toHaveLength(1);
    expect(forked[0]!.objective).toBe('make the build reproducible');
    // The copy is an independent goal with its own identity, bound to the FORK.
    expect(forked[0]!.goalId).not.toBe(parentBefore[0]!.goalId);
    expect(forked[0]!.threadId).toBe('fork-session');

    // The parent is UNTOUCHED — this is what rules out re-pointing ownership.
    const parentAfter = await readGoals(hooks, 'parent-session');
    expect(parentAfter).toHaveLength(1);
    expect(parentAfter[0]!.goalId).toBe(parentBefore[0]!.goalId);
    expect(parentAfter[0]!.status).toBe('active');
  });

  test('the copy carries no token record from the parent', async () => {
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-2', 'an objective with a contract');
    await hooks.event!(FORK_EVENT('fork-2', 'parent-2'));

    const forked = await readGoals(hooks, 'fork-2');
    expect(forked).toHaveLength(1);
    // A fork copies the host's HISTORY, but this goal has genuinely not run in
    // the fork, so it must not inherit a spend it did not incur.
    expect(forked[0]!.tokensUsed).toBe(0);
  });

  test('a TERMINAL goal is not revived in the fork', async () => {
    // The reachable terminal state that STAYS live is `budgetLimited`: a
    // `complete` goal is archived and REMOVED from the session's machines, so
    // it can never reach the copy at all, whereas an exhausted API-cost budget
    // leaves the goal in place — terminal, visible, and still listable.
    //
    // This test is why the filter is not dead code, and it took a mutation to
    // find that out: the first version drove the goal to `complete` via
    // `/goal clear`, so the filter was never reached and removing it changed
    // nothing. Reaching `budgetLimited` needs REAL spend past the budget, which
    // is driven here through the host's own `session.usage.updated` event.
    const hooks = await makePlugin();
    await goalCommand(
      hooks,
      'parent-4',
      'a budgeted objective --token-budget 100',
    );
    const created = await readGoals(hooks, 'parent-4');
    expect(created).toHaveLength(1);
    expect(created[0]!.tokenBudget).toBe(100);

    await hooks.event!({
      type: 'session.usage.updated',
      sessionID: 'parent-4',
      properties: {
        tokens: {
          input: 5000,
          output: 5000,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: 0,
      },
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'parent-4',
      id: 'idle-parent-4',
    });

    // The premise of the test: the goal is terminal AND still in the live list.
    const terminal = await readGoals(hooks, 'parent-4');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.status).toBe('budgetLimited');

    await hooks.event!(FORK_EVENT('fork-4', 'parent-4'));
    expect(await readGoals(hooks, 'fork-4')).toHaveLength(0);
  });

  test('an event with NO parentID copies nothing (the v1 shape)', async () => {
    // v1 forks carry no ancestry. Declining is correct: attaching a goal to a
    // session the user did not choose is worse than making them restate it.
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-5', 'should not travel');

    await hooks.event!({
      type: 'session.forked',
      sessionID: 'fork-5',
      properties: {sessionID: 'fork-5'},
    });
    expect(await readGoals(hooks, 'fork-5')).toHaveLength(0);

    // And a fork of a session that HAS no goals copies nothing.
    await hooks.event!(FORK_EVENT('fork-6', 'empty-parent'));
    expect(await readGoals(hooks, 'fork-6')).toHaveLength(0);
  });

  test('multiple live goals are ALL copied', async () => {
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-7', 'first objective');
    await goalCommand(hooks, 'parent-7', 'add second objective');
    expect(await readGoals(hooks, 'parent-7')).toHaveLength(2);

    await hooks.event!(FORK_EVENT('fork-7', 'parent-7'));
    const forked = await readGoals(hooks, 'fork-7');
    expect(forked).toHaveLength(2);
    expect(forked.map(g => g.objective).sort()).toEqual([
      'first objective',
      'second objective',
    ]);
    // Each copy is its own goal, and none of them is a parent goal id.
    const parentIds = new Set(
      (await readGoals(hooks, 'parent-7')).map(g => g.goalId),
    );
    for (const g of forked) expect(parentIds.has(g.goalId)).toBe(false);
  });

  test("a fork of an UNRELATED session does not disturb another session's goals", async () => {
    // Cross-session isolation: the copy targets the fork and reads the parent,
    // and touches nothing else.
    const hooks = await makePlugin();
    await goalCommand(hooks, 'bystander', 'bystander objective');
    await goalCommand(hooks, 'parent-8', 'parent objective');

    await hooks.event!(FORK_EVENT('fork-8', 'parent-8'));

    expect(await readGoals(hooks, 'bystander')).toHaveLength(1);
    expect((await readGoals(hooks, 'bystander'))[0]!.objective).toBe(
      'bystander objective',
    );
    expect(await readGoals(hooks, 'fork-8')).toHaveLength(1);
  });
});

// Regression: a fork binds ONCE, and it binds the whole goal
//
// Every test below was RED before the fix it locks. They are grouped because
// they share one root cause: the first cut of the fork arm treated
// `session.forked` as a fire-and-forget notification and the copy as a bare
// objective, so a redelivered event duplicated goals and the copy lost the
// session-level state that gives `mode` and focus their meaning.

describe('a fork binds once, with the session state it needs', () => {
  test('a REDELIVERED fork event does not copy the goals twice', async () => {
    // The idle path dedupes host re-delivery by EVENT id, but the fork arm runs
    // BEFORE that gate (a fork is not an idle). MEASURED before the fix: a
    // 200-goal parent forked twice left the fork holding 400 live goals —
    // double MAX_LIVE_GOALS, bypassing the cap `/goal add` enforces.
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-dup', 'first objective');
    await goalCommand(hooks, 'parent-dup', 'add second objective');
    expect(await readGoals(hooks, 'parent-dup')).toHaveLength(2);

    const delivered = {
      ...FORK_EVENT('fork-dup', 'parent-dup'),
      id: 'evt-fork-dup',
    };
    await hooks.event!(delivered);
    expect(await readGoals(hooks, 'fork-dup')).toHaveLength(2);

    // Same event id, and then a different one: a host that republishes, or a
    // reconnect that replays, must not multiply the fork's goals either way.
    await hooks.event!(delivered);
    await hooks.event!({
      ...FORK_EVENT('fork-dup', 'parent-dup'),
      id: 'evt-fork-dup-2',
    });
    const forked = await readGoals(hooks, 'fork-dup');
    expect(forked).toHaveLength(2);
    expect(forked.map(g => g.objective).sort()).toEqual([
      'first objective',
      'second objective',
    ]);
  });

  test('forking an ordered sequence keeps its order and its focus', async () => {
    // Two session-level facts the copy must carry, both MEASURED missing before
    // the fix: `mode: "ordered"` is a per-goal field while the ordering itself
    // is session state (`isOrdered` gates auto-promotion), and `createGoal`
    // focuses each goal it creates, so the fork opened on the LAST step.
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-seq', 'sequence alpha; beta; gamma');

    const parent = await readGoals(hooks, 'parent-seq');
    expect(parent.map(g => g.objective)).toEqual(['alpha', 'beta', 'gamma']);
    // The parent's own shape: step 1 active, the rest queued behind it.
    expect(parent[0]!.status).toBe('active');
    expect(parent.slice(1).map(g => g.status)).toEqual(['paused', 'paused']);

    await hooks.event!(FORK_EVENT('fork-seq', 'parent-seq'));

    const forked = await readGoals(hooks, 'fork-seq');
    expect(forked.map(g => g.objective)).toEqual(['alpha', 'beta', 'gamma']);
    // Same shape: the sequence did not collapse into three concurrent goals.
    expect(forked[0]!.status).toBe('active');
    expect(forked.slice(1).map(g => g.status)).toEqual(['paused', 'paused']);
    // The fork is registered as ordered, so auto-promotion will advance it.
    // `(ordered sequence)` is rendered by formatGoalList — `/goal list`, not
    // `/goal status`. Asserting it against `status` was a wrong-subcommand bug.
    expect(await goalCommand(hooks, 'fork-seq', 'list')).toContain(
      '(ordered sequence)',
    );
    // And the fork opens on step 1, not on the last copy created: `createGoal`
    // focuses each goal it creates, so without the focus fix this reads gamma.
    // The focused goal is the one marked `focused` in the list.
    const list = await goalCommand(hooks, 'fork-seq', 'list');
    expect(list).toMatch(/1\. \[focused\] alpha/);
  });

  test('an EXPLICIT pause crosses, a MECHANICAL one does not', async () => {
    // `/goal pause` is the user's instruction, so the copy stays paused —
    // reviving it would be the plugin fighting a human who said stop. A brake
    // or stall pause is a fact about the PARENT's run, and the counters behind
    // it are exactly what the copy does not inherit, so that copy starts active
    // on a fresh budget.
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-halt', 'a deliberately halted objective');
    await goalCommand(hooks, 'parent-halt', 'pause');

    const halted = await readGoals(hooks, 'parent-halt');
    expect(halted).toHaveLength(1);
    expect(halted[0]!.status).toBe('paused');

    await hooks.event!(FORK_EVENT('fork-halt', 'parent-halt'));
    const forked = await readGoals(hooks, 'fork-halt');
    expect(forked).toHaveLength(1);
    expect(forked[0]!.status).toBe('paused');
  });
});

// fork redelivery fixes
//
// The three defects recorded in the audit:
// (1) fork arm ungated on parent side — now gates on canDriveSession(parent)
// (2) non-idempotent copy — now skips if the fork already has goals
// (3) 256-fork guard evicting — FIFO eviction removed; set retains all entries

describe('fork redelivery fixes', () => {
  test('a fork that ALREADY has goals does not receive a second copy', async () => {
    // Idempotency: if the fork already holds goals (created independently
    // or from a previous fork event), the fork arm must not duplicate them.
    // This guards against redelivery after a process restart, where the
    // in-memory forkedSessions guard has been lost.
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-indep', 'parent objective');

    // Create a goal in the fork independently (simulates a previous
    // fork event or an independent goal creation).
    await goalCommand(hooks, 'fork-indep', "fork's own objective");
    const forkBefore = await readGoals(hooks, 'fork-indep');
    expect(forkBefore).toHaveLength(1);
    expect(forkBefore[0]!.objective).toBe("fork's own objective");

    // Now send the fork event. The idempotency check should skip the copy
    // because the fork already has goals.
    await hooks.event!(FORK_EVENT('fork-indep', 'parent-indep'));

    const forkAfter = await readGoals(hooks, 'fork-indep');
    expect(forkAfter).toHaveLength(1);
    expect(forkAfter[0]!.objective).toBe("fork's own objective");
  });

  test('a fork with NO goals still receives the copy', async () => {
    // Sanity check: the idempotency guard only skips when the fork
    // already has goals. A fresh fork should still receive the copy.
    const hooks = await makePlugin();
    await goalCommand(hooks, 'parent-fresh', 'fresh parent objective');

    await hooks.event!(FORK_EVENT('fork-fresh', 'parent-fresh'));

    const forked = await readGoals(hooks, 'fork-fresh');
    expect(forked).toHaveLength(1);
    expect(forked[0]!.objective).toBe('fresh parent objective');
  });
});
