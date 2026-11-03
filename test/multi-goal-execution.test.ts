// multi-goal-execution.test.ts — locks the MULTI-GOAL EXECUTION invariant
// (user 2026-08-25: "Execute ALL goals... you are working with the latest
// v1 plugin"). The focused goal is a cockpit concept, never an execution gate:
// every idle event drives EVERY unfinished goal in the session; `add` no
// longer backgrounds running work; human steering pauses/re-arms the WHOLE
// session; pending intents are isolated per goal.
import {describe, expect, test} from 'bun:test';
import {
  createHooks,
  type HookDeps,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {handleCommand} from '../src/commands.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';
import {sessionStatePaths} from '../src/session-paths.ts';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {PersistedState} from '../src/persistence.ts';
import type {GoalState, PendingIntent} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';

const managerOptions = {
  maxTokens: DEFAULT_GOAL_OPTIONS.maxTokens,
  maxTurns: DEFAULT_GOAL_OPTIONS.maxTurns,
  maxDurationMs: DEFAULT_GOAL_OPTIONS.maxDurationMs,
  noProgressTokenThreshold: DEFAULT_GOAL_OPTIONS.noProgressTokenThreshold,
  noProgressTurnsBeforePause: DEFAULT_GOAL_OPTIONS.noProgressTurnsBeforePause,
  noToolCallTurnsBeforePause: DEFAULT_GOAL_OPTIONS.noToolCallTurnsBeforePause,
  budgetWrapupRatio: DEFAULT_GOAL_OPTIONS.budgetWrapupRatio,
  minDelayMs: DEFAULT_GOAL_OPTIONS.minDelayMs,
  maxPromptFailures: DEFAULT_GOAL_OPTIONS.maxPromptFailures,
  maxRecentMessages: DEFAULT_GOAL_OPTIONS.maxRecentMessages,
  maxRecoveryTurns: DEFAULT_GOAL_OPTIONS.maxRecoveryTurns,
  maxUnchangedResults: DEFAULT_GOAL_OPTIONS.maxUnchangedResults,
  maxBlockedTurns: DEFAULT_GOAL_OPTIONS.maxBlockedTurns,
  languageTriage: DEFAULT_GOAL_OPTIONS.languageTriage,
};

/**
 * The manager now takes a state ROOT (a directory) rather than a ledger path:
 * it resolves each goal's own ledger from the root and the goal's session id.
 */
async function makeManagerForTest(
  stateRoot: string,
  persistFn: (sessionID: string) => Promise<boolean>,
) {
  const runtime = createRuntimeState();
  const initial: PersistedState = {
    version: 1,
    goals: [],
    results: [],
    sessionOrdered: [],
  };
  return {
    runtime,
    manager: new SessionStateManager(
      runtime,
      persistFn,
      stateRoot,
      initial,
      EMPTY_INVALIDATION,
      CAN_WRITE_ANY,
      1024,
      3,
      10,
      86_400_000,
      managerOptions,
      async () => {},
    ),
  };
}

/** Every session is writable in these fixtures: the lease and the sequence seeding are
 * decided by the composition root, and these tests exercise the manager directly. */
const CAN_WRITE_ANY = async (): Promise<boolean> => true;

/** No session was read at startup, so no invalidation fence was recovered. */
const EMPTY_INVALIDATION: ReadonlyMap<string, readonly string[]> = new Map();

function makeUsage(): UsageSnapshot {
  return {
    input: 1000,
    output: 500,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
}

function makeGoal(objective: string, id: string): GoalState {
  const g = createGoalState('session-1', objective, {
    goalId: id,
    runId: `run-${id}`,
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {
    ...g,
    usage: makeUsage(),
    turnCount: 1,
    lastAssistantText: 'prior progress',
  };
}

class MultiGoalSession implements SessionContext {
  readonly sessionID = 'session-1';
  readonly machines: GoalStateMachine[];
  persisted = 0;
  private intents = new Map<string, PendingIntent>();
  private focusId: string;

  constructor(goals: Array<[string, string]>) {
    this.machines = goals.map(
      ([id, obj]) =>
        new GoalStateMachine(makeGoal(obj, id), {
          onCommit: async () => {},
        }),
    );
    this.focusId = goals[goals.length - 1]![0];
  }

  getMachine = () =>
    this.machines.find(m => m.state.goalId === this.focusId) ??
    this.machines[this.machines.length - 1] ??
    null;
  listMachines = () => [...this.machines];
  listActiveGoals = () => this.machines.map(m => m.snapshot());
  listArchivedResults = () => [];
  createGoal = (objective: string) => {
    const id = `goal-${this.machines.length + 1}`;
    const m = new GoalStateMachine(makeGoal(objective, id), {
      onCommit: async () => {},
    });
    this.machines.push(m);
    this.focusId = id;
    return m;
  };
  replaceGoals = async (objective: string) => this.createGoal(objective);
  removeGoal = async () => {};
  clearSession = () => {};
  focusGoal = async (goalId: string) => {
    const m = this.machines.find(x => x.state.goalId === goalId);
    return m
      ? {ok: true as const, machine: m}
      : {ok: false as const, reason: 'not-found' as const};
  };
  addOrderedSession = () => {};
  isOrdered = () => false;
  autoPromote = async () => {};
  setPendingIntent = (goalId: string, intent: PendingIntent | null) => {
    if (intent) this.intents.set(goalId, intent);
    else this.intents.delete(goalId);
  };
  getPendingIntent = (goalId: string) => this.intents.get(goalId) ?? null;
  getAllPendingIntents = () => [...this.intents.values()];
  persist = async () => {
    this.persisted += 1;
    return true;
  };
}

function makeApi(perGoalMessages?: Map<string, unknown[]>) {
  const calls: Array<{sessionID: string; text: string; agent?: unknown}> = [];
  return {
    api: {
      messages: async (sessionID: string) =>
        perGoalMessages?.get(sessionID) ?? [],
      promptAsync: async (
        sessionID: string,
        input: {parts: Array<{text?: string}>} & Record<string, unknown>,
      ) => {
        calls.push({
          sessionID,
          text: input.parts[0]?.text ?? '',
          agent: (input as {agent?: unknown}).agent,
        });
        return {};
      },
    },
    calls,
  };
}

function makeDeps(
  session: SessionContext,
  api: ReturnType<typeof makeApi>['api'],
): HookDeps {
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi: api as unknown as SessionApi,
    logError: async () => {},
    completionGate: null,
    runtime: {
      ...createRuntimeState(),
      threadToolsRegistered: true,
      promptInFlightSessions: new Set<string>(),
    },
  };
}

test('clearSession fences synchronous creates while its lifecycle operation is queued', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-clear-fence-'));
  try {
    const {manager} = await makeManagerForTest(
      join(dir, 'ledger.jsonl'),
      async () => true,
    );
    manager.createGoal('session-1', 'existing', {});
    const clear = manager.clearSession('session-1');
    expect(() => manager.createGoal('session-1', 'racing create', {})).toThrow(
      /being cleared/,
    );
    await clear;
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('removeGoal WAL failure clears persisted ordering with the last goal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-remove-rollback-'));
  try {
    const {runtime, manager} = await makeManagerForTest(dir, async () => true);
    const goal = manager.createGoal('session-1', 'ordered goal', {});
    await manager.drainWalWrites();
    manager.addOrderedSession('session-1');
    // Make the WAL append fail WITHOUT removing the directory: the manager now
    // creates the session directory itself, so "the parent is gone" no longer
    // fails. A ledger path occupied by a DIRECTORY fails the same open the
    // append needs, and does so on every platform.
    const ledger = sessionStatePaths(dir, 'session-1').ledgerPath;
    await mkdir(ledger, {recursive: true});
    await expect(
      manager.removeGoal('session-1', goal.state.goalId),
    ).rejects.toThrow();
    expect(runtime.sessionOrdered.has('session-1')).toBe(false);
    expect(manager.getPersistedState('session-1').sessionOrdered).toEqual([]);
    expect(manager.getPersistedState('session-1').goals).toEqual([]);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('createGoal rolls back when its WAL append fails, including focused state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-create-rollback-'));
  try {
    // The manager creates the session directory itself now, so a missing
    // parent is no longer a way to make the ledger write fail. A path whose
    // parent is a REGULAR FILE is: mkdir cannot create anything beneath it,
    // and the failure is the same ENOTDIR a real permission or full-disk
    // failure would produce at that point.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    const stateRoot = join(blocker, 'root');
    let persistCalls = 0;
    const {runtime, manager} = await makeManagerForTest(stateRoot, async () => {
      persistCalls += 1;
      return true;
    });
    const first = manager.createGoal('session-1', 'first', {});
    // Macrotask FLUSH (0 ms), not a timing guess: it yields to the event loop so
    // already-scheduled macrotasks run. Deliberate — do not "convert".
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = manager.createGoal('session-1', 'second', {});
    await manager.drainWalWrites();
    expect(
      runtime.sessionGoals.get('session-1')?.map(m => m.state.goalId),
    ).toEqual([]);
    expect(manager.getFocusedGoalId('session-1')).toBeNull();
    expect(manager.getPersistedState('session-1').goals).toEqual([]);
    expect(persistCalls).toBeGreaterThanOrEqual(1);
    expect(first.state.goalId).not.toBe(second.state.goalId);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

describe('multi-goal execution: one idle drives EVERY unfinished goal', () => {
  test('two active goals -> two continuation prompts, each with its own objective', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'First objective alpha'],
      ['goal-B', 'Second objective beta'],
    ]);
    const {api, calls} = makeApi(
      new Map([
        [
          'session-1',
          [
            {
              role: 'assistant',
              id: 'm1',
              parts: [{type: 'text', text: 'progress'}],
            },
          ],
        ],
      ]),
    );
    const hooks = createHooks(makeDeps(session, api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-multi-1',
    });

    expect(calls.length).toBe(2);
    expect(calls[0]!.text).toContain('First objective alpha');
    expect(calls[1]!.text).toContain('Second objective beta');
    // Both goals advanced a turn.
    expect(session.machines[0]!.state.turnCount).toBe(2);
    expect(session.machines[1]!.state.turnCount).toBe(2);
  });

  test('autoPromote only promotes a QUEUED candidate, never a user-paused one (D8)', async () => {
    // D8: the promotion loop read the FOCUSED goal's terminality and never the
    // CANDIDATE's stopReason. A queued successor is the only valid promotion
    // target; a candidate parked by the user (or by a brake) must stay parked,
    // or promotion silently wipes a pause the user made.
    const dir = await mkdtemp(join(tmpdir(), 'fx-d8-promotion-'));
    const {runtime, manager} = await makeManagerForTest(dir, async () => true);
    manager.addOrderedSession('session-1');

    const focused = manager.createGoal('session-1', 'focused goal', {})!;
    const queued = manager.createGoal('session-1', 'queued successor', {})!;
    const userPaused = manager.createGoal('session-1', 'user-paused goal', {})!;
    await queued.mutate(
      g => {
        g.status = 'paused';
        g.stopReason = 'queued';
      },
      {source: 'slash-command', detail: 'queued'},
    );
    await userPaused.mutate(
      g => {
        g.status = 'paused';
        g.stopReason = 'explicit pause';
      },
      {source: 'slash-command', detail: 'user paused it'},
    );
    runtime.focusedGoalId.set('session-1', focused.state.goalId);

    // While the focused goal is still runnable, nothing promotes.
    expect(await manager.autoPromote('session-1')).toBeNull();
    expect(queued.state.status).toBe('paused');

    // The focused goal settles terminally: the QUEUED candidate promotes.
    await focused.mutate(
      g => {
        g.status = 'complete';
      },
      {source: 'update_goal', detail: 'settled'},
    );
    const promoted = await manager.autoPromote('session-1');
    expect(promoted?.state.goalId).toBe(queued.state.goalId);
    expect(queued.state.status).toBe('active');
    expect(queued.state.stopReason).toBe('');

    // The user-paused goal was never touched by any promotion.
    expect(userPaused.state.status).toBe('paused');
    expect(userPaused.state.stopReason).toBe('explicit pause');

    // With only the user-paused goal left non-terminal, promotion REFUSES
    // rather than resurrecting the user's pause.
    await queued.mutate(
      g => {
        g.status = 'complete';
      },
      {source: 'update_goal', detail: 'settled'},
    );
    expect(await manager.autoPromote('session-1')).toBeNull();
    expect(userPaused.state.status).toBe('paused');
    expect(userPaused.state.stopReason).toBe('explicit pause');
  });

  test('queued ordered-sequence goals are NOT driven (autoPromote owns them)', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'Active sequence head'],
      ['goal-B', 'Queued successor'],
    ]);
    // Simulate queued state on B.
    const b = session.machines[1]!;
    b.state.status = 'paused';
    b.state.stopReason = 'queued';
    const {api, calls} = makeApi();
    const hooks = createHooks(makeDeps(session, api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-queue-1',
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toContain('Active sequence head');
    expect(b.state.status).toBe('paused');
  });
});

describe('human steering pauses and re-arms the WHOLE session', () => {
  test('chat.message pauses all running goals; next idle re-arms and continues all', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'Alpha duties'],
      ['goal-B', 'Beta duties'],
    ]);
    let msgs: unknown[] = [{role: 'assistant', id: 'm1', parts: []}];
    const {api, calls} = makeApi();
    (api as {messages: (s: string) => Promise<unknown[]>}).messages =
      async () => msgs;
    const hooks = createHooks(makeDeps(session, api));

    await hooks['chat.message']!(
      {sessionID: 'session-1'},
      {parts: [{type: 'text', text: 'hold on, real quick'}]},
    );

    expect(session.machines[0]!.state.status).toBe('paused');
    expect(session.machines[0]!.state.stopReason).toBe('user intervention');
    expect(session.machines[1]!.state.status).toBe('paused');
    expect(session.machines[1]!.state.stopReason).toBe('user intervention');

    // The human's turn completes; next idle re-arms BOTH goals and drives both.
    msgs = [{role: 'assistant', id: 'm2', parts: []}];
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-rearm-multi',
    });

    expect(session.machines[0]!.state.status).toBe('active');
    expect(session.machines[1]!.state.status).toBe('active');
    expect(calls.length).toBe(2);
    expect(calls[0]!.text).toContain('Alpha duties');
    expect(calls[1]!.text).toContain('Beta duties');
  });

  test("a second human message RENEWES the yield's promise", async () => {
    //, and the reason the promise clock is its own field. `chat.message` only
    // pauses goals that are active or finalizing, so a goal ALREADY in a yield is
    // never re-paused — and with the clock anchored to the pause, a
    // conversation's opening message set a 15-minute window that nothing could
    // renew. Measured before this rule: two messages with no idle between them
    // left the instant identical, and every surface flipped to "did not re-arm"
    // on schedule while the user was actively talking to the agent.
    //
    // So the assertion is on the RENEWAL, through the real hook, and the goal
    // differs from the case above in one thing only: it is already yielded.
    const session = new MultiGoalSession([['goal-A', 'Alpha duties']]);
    const {api} = makeApi();
    const hooks = createHooks(makeDeps(session, api));
    const state = session.machines[0]!.state;

    await hooks['chat.message']!(
      {sessionID: 'session-1'},
      {parts: [{type: 'text', text: 'first'}]},
    );
    expect(state.stopReason).toBe('user intervention');
    const afterFirst = state.stoppedAt;
    expect(afterFirst).toBeGreaterThan(0);

    // The goal is still paused, and still promising. A second message must move
    // the promise forward — otherwise the bound is measuring the first message
    // of the conversation rather than the promise it is supposed to measure.
    await new Promise<void>(r => setTimeout(r, 5));
    await hooks['chat.message']!(
      {sessionID: 'session-1'},
      {parts: [{type: 'text', text: 'second'}]},
    );
    expect(state.status).toBe('paused');
    expect(state.stopReason).toBe('user intervention');
    expect(state.stoppedAt).toBeGreaterThan(afterFirst);

    // And an EXPLICIT stop is not a yield, so it must not renew a promise the
    // plugin is not making. "pause" is the phrasing the dispatch module's own
    // EXPLICIT_STOP_PHRASES list recognises; "/goal pause" would not reach here
    // at all, because a slash line is filtered as a command before any of this.
    //
    // The assertion is on the CLOCK, not on the stopReason, and that is
    // deliberate: the pause loop only touches goals that are active or finalizing,
    // so a goal already in a yield keeps its stopReason through an explicit-stop
    // message. That is pre-existing behaviour and out of scope here — what this
    // test owns is that an explicit stop does not extend a promise the plugin has
    // stopped making. (Two earlier versions of this assertion each reported a
    // defect that was the test's own phrasing, which is the same lesson as the
    // substring bug recorded in test/goal-lifecycle-toasts.test.ts.)
    await hooks['chat.message']!(
      {sessionID: 'session-1'},
      {parts: [{type: 'text', text: 'pause'}]},
    );
    const afterStop = state.stoppedAt;
    await new Promise<void>(r => setTimeout(r, 5));
    await hooks['chat.message']!(
      {sessionID: 'session-1'},
      {parts: [{type: 'text', text: 'still there?'}]},
    );
    expect(state.stoppedAt).toBe(afterStop);
  });
});

describe('the system prompt describes EVERY goal the agent is driven to work on', () => {
  // Multi-goal execution is a supported feature on the zero-flag path (the user,
  // 2026-08-25, "execute ALL goals"), and the idle path honours it: one idle sends
  // one continuation prompt PER unfinished goal. The system-transform hook described
  // only `getMachine`, which resolves the FOCUSED goal.
  //
  // So with two active goals the agent was prompted to work on one and told, in
  // the system prompt for that same turn, that its goal was the other. Driven to
  // the end, `update_goal` — which takes no goal id — then recorded "achieved"
  // against the goal nobody had finished, while the finished one stayed active. A
  // premature exit, written durably.
  //
  // The two halves are asserted separately because they are different failures: a
  // prompt naming a goal the system block does not describe (the agent works on
  // something it was never told about), and a description that omits a goal the
  // agent IS prompted for (the agent works on something nobody described).
  test('with two active goals, both are described and neither is preferred over the other', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'FIRST_OBJECTIVE'],
      ['goal-B', 'SECOND_OBJECTIVE'],
    ]);
    const deps = makeDeps(session, makeApi().api);
    deps.runtime!.focusedGoalId.set('session-1', 'goal-B');
    const hooks = createHooks(deps);

    const output = {system: [] as string[]};
    await hooks['experimental.chat.system.transform']!(
      {sessionID: 'session-1'},
      output,
    );
    const text = output.system.join('\n');

    expect(text, 'every goal the loop drives must be described').toContain(
      'FIRST_OBJECTIVE',
    );
    expect(text, 'every goal the loop drives must be described').toContain(
      'SECOND_OBJECTIVE',
    );

    // The FOCUSED goal is emitted first, because it is the tool default target and
    // the dashboard's emphasis. The ordering is a product decision, so it is
    // asserted rather than left to whichever sort the implementation happened to do.
    const firstId = /<fixate_on id="([^"]+)">/.exec(
      output.system[0] ?? '',
    )?.[1];
    const secondId = /<fixate_on id="([^"]+)">/.exec(
      output.system[1] ?? '',
    )?.[1];
    expect(firstId, 'the focused goal leads the system prompt').toBe('goal-B');
    expect(secondId).toBe('goal-A');
  });

  test('a second turn does not re-inject either block', async () => {
    // The dedupe is by goal id, not by string equality: a host may hand back a
    // block it has already modified, and an equality check then re-injects ours
    // every turn. A first version of this change used equality and
    // test/hooks.test.ts caught it immediately.
    const session = new MultiGoalSession([
      ['goal-A', 'FIRST_OBJECTIVE'],
      ['goal-B', 'SECOND_OBJECTIVE'],
    ]);
    const hooks = createHooks(makeDeps(session, makeApi().api));
    const output = {system: [] as string[]};
    await hooks['experimental.chat.system.transform']!(
      {sessionID: 'session-1'},
      output,
    );
    const afterFirst = output.system.length;
    await hooks['experimental.chat.system.transform']!(
      {sessionID: 'session-1'},
      output,
    );
    expect(
      output.system.length,
      'the per-turn guard must not grow the prompt',
    ).toBe(afterFirst);
  });

  test('a session with ONE goal describes exactly one block, as before', async () => {
    // The control. A fix that describes every goal indiscriminately would pass the
    // two-goal case and change the shape of every single-goal turn, which is the
    // overwhelmingly common one.
    const session = new MultiGoalSession([['goal-A', 'ONLY_OBJECTIVE']]);
    const hooks = createHooks(makeDeps(session, makeApi().api));
    const output = {system: [] as string[]};
    await hooks['experimental.chat.system.transform']!(
      {sessionID: 'session-1'},
      output,
    );
    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain('ONLY_OBJECTIVE');
  });

  test('a settled goal is not described, because there is nothing left to do', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'LIVE_OBJECTIVE'],
      ['goal-B', 'SETTLED_OBJECTIVE'],
    ]);
    await session.machines[1]!.transition('complete', {
      source: 'update_goal',
      stopReason: '',
    });
    const hooks = createHooks(makeDeps(session, makeApi().api));
    const output = {system: [] as string[]};
    await hooks['experimental.chat.system.transform']!(
      {sessionID: 'session-1'},
      output,
    );
    const text = output.system.join('\n');
    expect(text, 'a live goal is still described').toContain('LIVE_OBJECTIVE');
    // ON THE BLOCK, NOT ON THE OBJECTIVE TEXT. A first version of this asserted
    // the objective string was absent, and a mutation that dropped the terminal
    // filter SURVIVED it — because `buildSystemBlock` never prints the objective
    // for a non-active goal, so the string is absent either way and the test was
    // measuring nothing.
    //
    // The harm the filter prevents is sharper than the objective text anyway: a
    // COMPLETED goal would be handed a block saying "A goal exists for this
    // session, but it is paused… the user can run /goal resume", i.e. the agent
    // would be told to resume work that is finished and verified.
    const settledIds = output.system
      .map(block => /<fixate_on id="([^"]+)">/.exec(block)?.[1])
      .filter((id): id is string => Boolean(id));
    expect(settledIds, 'a settled goal must get no block at all').not.toContain(
      'goal-B',
    );
    expect(settledIds).toContain('goal-A');
  });
});

describe('token accounting covers EVERY goal in the session', () => {
  test('message.updated usage accrues to focused AND background goals alike', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'Alpha budget'],
      ['goal-B', 'Beta budget'],
    ]);
    const hooks = createHooks(makeDeps(session, makeApi().api));

    await hooks.event!({
      type: 'message.updated',
      sessionID: 'session-1',
      properties: {
        info: {
          id: 'msg-shared-1',
          role: 'assistant',
          info: {
            tokens: {
              input: 2000,
              output: 700,
              reasoning: 0,
              cache: {read: 0, write: 0},
            },
            cost: 0.01,
          },
        },
      },
    });

    for (const machine of session.machines) {
      expect(machine.state.usage.input).toBe(3000);
      expect(machine.state.usage.output).toBe(1200);
      expect(machine.state.usage.cost).toBeCloseTo(0.01);
      expect(machine.state.totalTokens).toBe(2700);
      expect(machine.state.messageIDs.has('msg-shared-1')).toBe(true);
    }
  });

  test('a message the runtime already attributed is never back-charged to a late-joining goal', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'Alpha joined early'],
      ['goal-B', 'Beta joined late'],
    ]);
    const deps = makeDeps(session, makeApi().api);
    deps.runtime!.seenTokens.set('msg-old-1', 4200);
    const before = session.machines.map(m => m.snapshot().usage.input);
    const hooks = createHooks(deps);

    await hooks.event!({
      type: 'message.updated',
      sessionID: 'session-1',
      properties: {
        info: {
          id: 'msg-old-1',
          role: 'assistant',
          info: {tokens: {input: 900, output: 100}, cost: 0.02},
        },
      },
    });

    expect(session.machines.map(m => m.snapshot().usage.input)).toEqual(before);
  });
});

describe('v2 usage events feed token accounting (FX-H)', () => {
  test('session.usage.updated accrues usage to every non-terminal goal across steps', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'Alpha usage'],
      ['goal-B', 'Beta usage'],
    ]);
    const hooks = createHooks(makeDeps(session, makeApi().api));

    // Step 1 of the model turn.
    await hooks.event!({
      type: 'session.usage.updated',
      sessionID: 'session-1',
      properties: {
        tokens: {
          input: 1000,
          output: 300,
          reasoning: 0,
          cache: {read: 0, write: 0},
        },
        cost: 0.01,
      },
    } as never);
    // Step 2: the host publishes the session's RUNNING TOTAL, not this step's
    // numbers. `applyUsage` accumulates into the session row and
    // `publishSessionUsage` republishes those columns
    // (packages/core/src/session/projector.ts), so the second event carries
    // 1200/500 as the session total — NOT an extra 1200/500 to charge.
    await hooks.event!({
      type: 'session.usage.updated',
      sessionID: 'session-1',
      properties: {
        tokens: {
          input: 1200,
          output: 500,
          reasoning: 0,
          cache: {read: 0, write: 0},
        },
        cost: 0.02,
      },
    } as never);

    for (const machine of session.machines) {
      const u = machine.state.usage;
      // Seed (1000/500) + the session total reached at each reading:
      // reading 1 = 1000/300 (charged in full, it is the first), reading 2 =
      // 1200/500 (charged only the +200/+200 increase), so 1000+1000+200 and
      // 500+300+200. Treating the second
      // reading as a fresh step charged the whole 1200 again and made a goal's
      // usage grow with the square of the step count — the token budget then
      // fired at a fraction of the real spend.
      expect(u.input).toBe(2200);
      expect(u.output).toBe(1000);
      // cost is session-cumulative too, so only the increase accrues.
      expect(u.cost).toBeCloseTo(0.02);
      expect(machine.state.totalTokens).toBe(1700);
    }
  });

  test('regression: a goal added AFTER the first usage event still accrues (no constant-id starvation)', async () => {
    const session = new MultiGoalSession([['goal-A', 'Alpha usage']]);
    const hooks = createHooks(makeDeps(session, makeApi().api));

    // Step 1 happens while only goal-A exists: A records the constant
    // synthetic id `${sessionID}#usage` into its messageIDs.
    await hooks.event!({
      type: 'session.usage.updated',
      sessionID: 'session-1',
      properties: {
        tokens: {
          input: 1000,
          output: 300,
          reasoning: 0,
          cache: {read: 0, write: 0},
        },
        cost: 0.01,
      },
    } as never);

    // Goal B joins mid-run — the documented `/goal add` flow.
    session.createGoal('Beta usage');
    const before = JSON.stringify(session.machines[1].state.usage);

    // Step 2 arrives: B must accrue despite never having recorded the
    // constant id (the late-joiner guard must not permanently starve it —
    // otherwise the token brake and token_budget are dead for every
    // late-added goal on v2).
    await hooks.event!({
      type: 'session.usage.updated',
      sessionID: 'session-1',
      properties: {
        tokens: {
          input: 1200,
          output: 500,
          reasoning: 0,
          cache: {read: 0, write: 0},
        },
        cost: 0.02,
      },
    } as never);

    const b = session.machines[1].state.usage;
    expect(JSON.stringify(b)).not.toBe(before);
    expect(b.input).toBeGreaterThan(1000);
    expect(b.cost).toBeGreaterThan(0);
    expect(session.machines[1].state.totalTokens).toBeGreaterThan(0);

    // And A keeps accruing the correct cumulative deltas: the session total
    // went 1000 -> 1200, so A is charged +200 on top of its earlier reading.
    const a = session.machines[0].state.usage;
    expect(a.input).toBe(2200);
    expect(a.cost).toBeCloseTo(0.02);
  });

  test('FX-H magnitude: N steps of cumulative usage charge the FINAL total, not N times it', async () => {
    // The defect this locks (Run-9 BLK-9.1): session.usage.updated carries the
    // session's RUNNING TOTAL. Charging each event in full made a goal's usage
    // grow with the SQUARE of the step count, so the token budget fired at a
    // fraction of the real spend. The Run-8 regression test could not see it —
    // it only asserted that idle did not grow the total, never the magnitude.
    const session = new MultiGoalSession([['goal-A', 'Magnitude']]);
    const hooks = createHooks(makeDeps(session, makeApi().api));

    // Eight steps of a realistic turn: the session total rises by 2000 in /
    // 500 out each step, so the last reading is 16000 / 4000.
    for (let step = 1; step <= 8; step++) {
      await hooks.event!({
        type: 'session.usage.updated',
        sessionID: 'session-1',
        properties: {
          tokens: {
            input: 2000 * step,
            output: 500 * step,
            reasoning: 0,
            cache: {read: 0, write: 0},
          },
          cost: 0.01 * step,
        },
      } as never);
    }

    const u = session.machines[0].state.usage;
    // Seed (1000 in / 500 out) + the session's final cumulative total.
    expect(u.input).toBe(1000 + 16000);
    expect(u.output).toBe(500 + 4000);
    // Under the old per-step reading this was ~72,000 / 18,000 — a 4x overcharge
    // that would have tripped a 20k budget after roughly two steps.
    expect(u.input).toBeLessThan(20000);
    expect(u.cost).toBeCloseTo(0.08);
  });

  test('message.updated late-joiner guard is UNCHANGED: pre-existing messages are never back-charged', async () => {
    const session = new MultiGoalSession([['goal-A', 'Alpha']]);
    const hooks = createHooks(makeDeps(session, makeApi().api));

    await hooks.event!({
      type: 'message.updated',
      sessionID: 'session-1',
      properties: {
        info: {
          id: 'msg-old',
          role: 'assistant',
          tokens: {input: 5000, output: 900},
        },
      },
    } as never);

    session.createGoal('Beta');

    await hooks.event!({
      type: 'message.updated',
      sessionID: 'session-1',
      properties: {
        info: {
          id: 'msg-old',
          role: 'assistant',
          tokens: {input: 6000, output: 950},
        },
      },
    } as never);

    const a = session.machines[0].state.usage;
    const b = session.machines[1].state.usage;
    expect(a.input).toBeGreaterThan(5000);
    // B joined after msg-old was attributed; per-message truth is never
    // back-charged to it.
    expect(b.input).toBe(1000);
    expect(b.costKnown).toBe(false);
  });
});

describe('compaction resets tracking for EVERY goal in the session', () => {
  test('session.compacted folds totals into baselines across all machines', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'Alpha compaction'],
      ['goal-B', 'Beta compaction'],
    ]);
    session.machines[0]!.state.totalTokens = 500;
    session.machines[1]!.state.totalTokens = 700;
    session.machines[0]!.state.messageIDs = new Set(['m-a']);
    session.machines[1]!.state.messageIDs = new Set(['m-b']);
    const hooks = createHooks(makeDeps(session, makeApi().api));

    await hooks.event!({type: 'session.compacted', sessionID: 'session-1'});

    for (const [index, expectedBaseline] of [
      [0, 500],
      [1, 700],
    ] as const) {
      const g = session.machines[index]!.state;
      expect(g.compactionBaselineTokens).toBe(expectedBaseline);
      expect(g.totalTokens).toBe(0);
      expect(g.messageIDs.size).toBe(0);
      expect(g.continuationClaim).toBeNull();
    }
  });
});

describe('pending intents are isolated per goal', () => {
  test("a completion intent on goal-A does not block goal-B's continuation", async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'Alpha completing'],
      ['goal-B', 'Beta still grinding'],
    ]);
    const intentsByGoal = new Map<string, unknown[]>([
      [
        'session-1',
        [
          {
            role: 'assistant',
            id: 'm1',
            parts: [{type: 'text', text: 'done with alpha'}],
          },
        ],
      ],
    ]);
    const msgs = intentsByGoal.get('session-1')!;
    const {api, calls} = makeApi();
    (api as {messages: (s: string) => Promise<unknown[]>}).messages =
      async () => msgs;

    const deps = makeDeps(session, api);
    // Gate that REFUTES goal-A's completion (verifier says WORKING).
    deps.completionGate = {
      runVerifier: async () => ({
        verdict: {
          schema_version: 1 as const,
          task_id: 'goal-A',
          state: 'WORKING' as const,
          candidate: 'c',
          fingerprint: 'f',
          outstanding: ['not done yet'],
          evidence: [],
        },
        checkPath: 'judge',
        checkTarget: 'bun test',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const hooks = createHooks(deps);

    session.setPendingIntent('goal-A', {
      goalId: 'goal-A',
      revision: session.machines[0]!.currentRevision,
      runId: session.machines[0]!.state.runId,
      messageID: '',
      toolCallID: '',
      targetStatus: 'complete',
      evidence: '',
      createdAt: Date.now(),
    });

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-isolate-1',
    });

    // goal-A entered the verifier flow: refuted claim recorded, recovery sent.
    expect(session.machines[0]!.snapshot().claims.length).toBe(1);
    expect(
      calls.some(
        c =>
          c.text.includes('Recovery') ||
          c.text.includes('not done yet') ||
          c.text.includes('Continue working'),
      ),
    ).toBe(true);
    // goal-B was STILL driven with its own ordinary continuation.
    const betaCall = calls.find(c => c.text.includes('Beta still grinding'));
    expect(betaCall).toBeDefined();
  });
});

// BLAST-RADIUS-1: `clear <goalId>` must clear exactly ONE goal
//
// The cockpit renders a per-goal card titled `Actions: <goalId>` with an option
// reading "Clear this goal", but it dispatched a BARE `clear`, whose handler
// removed EVERY goal in the session (measured: 2 goals -> 0). The surface said
// one goal and the effect was the session. A goal-scoped form now exists, and
// the cockpit targets the goal its card names.

describe('goal-scoped clear', () => {
  test('`clear <goalId>` removes exactly that goal and leaves the others', async () => {
    const session = new MultiGoalSession([
      ['goal-A', 'Alpha duties'],
      ['goal-B', 'Beta duties'],
    ]);
    const removed: string[] = [];
    (session as {removeGoal: (goalId: string) => Promise<void>}).removeGoal =
      async (goalId: string) => {
        removed.push(goalId);
        const index = session.machines.findIndex(
          m => m.state.goalId === goalId,
        );
        if (index >= 0) session.machines.splice(index, 1);
      };
    const text = await handleCommand('clear goal-A', session);

    expect(removed).toEqual(['goal-A']);
    expect(session.machines.map(m => m.state.goalId)).toEqual(['goal-B']);
    expect(text).toContain('Alpha duties');
  });

  test('a bare `clear` with one goal clears it; with two it refuses and names the blast radius', async () => {
    const single = new MultiGoalSession([['goal-A', 'Alpha duties']]);
    const singleRemoved: string[] = [];
    (single as {removeGoal: (goalId: string) => Promise<void>}).removeGoal =
      async (goalId: string) => {
        singleRemoved.push(goalId);
        const index = single.machines.findIndex(m => m.state.goalId === goalId);
        if (index >= 0) single.machines.splice(index, 1);
      };
    const singleText = await handleCommand('clear', single);
    expect(singleRemoved).toEqual(['goal-A']);
    expect(singleText).toContain('Goal cleared.');

    const session = new MultiGoalSession([
      ['goal-A', 'Alpha duties'],
      ['goal-B', 'Beta duties'],
    ]);
    const removed: string[] = [];
    (session as {removeGoal: (goalId: string) => Promise<void>}).removeGoal =
      async (goalId: string) => {
        removed.push(goalId);
        const index = session.machines.findIndex(
          m => m.state.goalId === goalId,
        );
        if (index >= 0) session.machines.splice(index, 1);
      };
    const text = await handleCommand('clear', session);
    // A bare clear that would wipe two goals refuses and says which command
    // names one. The palette never sends this shape (it names its goal); the
    // refusal is the backstop for a human typing it at the prompt.
    expect(removed).toEqual([]);
    expect(session.machines.length).toBe(2);
    expect(text).toContain('holds 2 goals');
  });

  test('`clear <unknown-ref>` removes NOTHING and says so', async () => {
    const session = new MultiGoalSession([['goal-A', 'Alpha duties']]);
    const removed: string[] = [];
    (session as {removeGoal: (goalId: string) => Promise<void>}).removeGoal =
      async (goalId: string) => {
        removed.push(goalId);
      };
    const text = await handleCommand('clear nope', session);

    expect(removed).toEqual([]);
    expect(session.machines.length).toBe(1);
    expect(text.length).toBeGreaterThan(0);
  });
});
