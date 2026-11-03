import {expect, test} from 'bun:test';
import {waitFor} from './wait-for.ts';
import {
  createHooks,
  type HookDeps,
  type RuntimeState,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import type {CompletionGateDeps} from '../src/completion-gate-run.ts';
import {createRuntimeState} from '../src/session-state-manager.ts';
import type {GoalState, PendingIntent} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {GoalResult} from '../src/persistence.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import type {CreateGoalOptions} from '../src/tools.ts';
import {assertClean} from './vocabulary-lock.ts';
import {stubIdentity} from './identity-stub.ts';
import {formatStatus} from '../src/commands.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {join} from 'node:path';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';

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

// A shared, empty workspace for tests that do not need a specific one. Created
// once at module load so the hooks suite never depends on the developer's cwd.
const TEST_WORKSPACE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hooks-ws-'));
  return dir;
})();

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  const goal = createGoalState('session-1', 'Build the feature', {
    goalId: 'goal-1',
    runId: 'run-1',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {...goal, usage: makeUsage(), ...overrides};
}

function makeSessionContext(
  opts: {
    machine?: GoalStateMachine | null;
    activeGoals?: GoalState[];
    archived?: GoalResult[];
    createdGoal?: GoalStateMachine;
    focusedGoal?: GoalStateMachine | null;
    pendingIntent?: PendingIntent | null;
    removedGoalIds?: string[];
    persistResult?: boolean;
  } = {},
): SessionContext {
  const machine = opts.machine ?? null;
  const activeGoals = opts.activeGoals ?? (machine ? [machine.snapshot()] : []);
  const archived = opts.archived ?? [];
  const removedGoalIds = opts.removedGoalIds ?? [];
  const persistResult = opts.persistResult ?? true;
  const pendingIntents = new Map<string, PendingIntent>();
  if (opts.pendingIntent && opts.machine) {
    pendingIntents.set(opts.machine.snapshot().goalId, opts.pendingIntent);
  }

  return {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => activeGoals,
    listArchivedResults: () => archived,
    createGoal: (_objective: string, _options: CreateGoalOptions) =>
      opts.createdGoal ??
      new GoalStateMachine(makeGoal(), {
        onCommit: async () => {},
      }),
    replaceGoals: async (_objective: string, _options: CreateGoalOptions) =>
      opts.createdGoal ??
      new GoalStateMachine(makeGoal(), {
        onCommit: async () => {},
      }),
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
    setPendingIntent: (goalId: string, intent: PendingIntent | null) => {
      if (intent) pendingIntents.set(goalId, intent);
      else pendingIntents.delete(goalId);
    },
    getPendingIntent: (goalId: string) => pendingIntents.get(goalId) ?? null,
    getAllPendingIntents: () => Object.values(pendingIntents),
    persist: async () => persistResult,
  };
}

function makeMockSessionApi(
  opts: {
    messages?: unknown[];
    promptError?: string;
  } = {},
): SessionApi & {promptsSent: string[]} {
  const promptsSent: string[] = [];
  return {
    messages: async () => opts.messages ?? [],
    promptAsync: async (sessionID: string, input: {parts: unknown[]}) => {
      const text = (input.parts[0] as {text?: string})?.text ?? '';
      promptsSent.push(text);
      if (opts.promptError) return {error: {name: opts.promptError}};
      return {};
    },
    promptsSent,
  };
}

function makeDeps(
  opts: {
    session?: SessionContext;
    sessionApi?: SessionApi & {promptsSent: string[]};
    commandName?: string;
    completionGate?: CompletionGateDeps | null;
    completionJudge?: HookDeps['completionJudge'];
    verifierAvailability?: HookDeps['verifierAvailability'];
    workspaceDirectory?: string;
  } = {},
): HookDeps & {mockSessionApi: SessionApi & {promptsSent: string[]}} {
  const mockSessionApi = opts.sessionApi ?? makeMockSessionApi();
  const session = opts.session ?? makeSessionContext();
  // Every gate fixture gets the deterministic capture unless it supplies its
  // own. Injected HERE rather than at the eight call sites so a new test cannot
  // silently reintroduce the ambient-git dependency.
  const completionGate = opts.completionGate
    ? {captureIdentity: stubIdentity, ...opts.completionGate}
    : null;
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: opts.commandName ?? 'goal',
    idlePoller: false,
    sessionApi: mockSessionApi,
    logError: async () => {},
    completionGate,
    completionJudge: opts.completionJudge,
    verifierAvailability: opts.verifierAvailability,
    // Hermetic by default. Without an explicit workspace, the gate's
    // candidate-identity capture falls back to `process.cwd` — the developer's
    // own repo, where >512 untracked paths make every capture do bounded work
    // over the whole tree (~390ms measured). That made the hooks suite scale
    // with ambient machine state: a test that passes standalone timed out at
    // bun's 5s default under parallel load. A shared empty temp dir keeps
    // capture trivial and the suite independent of what is on disk.
    workspaceDirectory: opts.workspaceDirectory ?? TEST_WORKSPACE,
    mockSessionApi,
  };
}

// system.transform

test('system.transform injects goal block when goal exists', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  const output = {system: ['You are a helpful assistant.']};
  await hooks['experimental.chat.system.transform']!(
    {sessionID: 'session-1'},
    output,
  );

  expect(output.system.length).toBe(2);
  expect(output.system[0]).toContain('fixate_on');
  expect(output.system[0]).toContain('Build the feature');
  expect(output.system[1]).toBe('You are a helpful assistant.');
});

test('system.transform accurately describes possible auto-detected verification', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const hooks = createHooks(
    makeDeps({session, verifierAvailability: 'unavailable'}),
  );

  const output = {system: [] as string[]};
  await hooks['experimental.chat.system.transform']!(
    {sessionID: 'session-1'},
    output,
  );

  expect(output.system[0]).toContain('No judge is currently available');
  expect(output.system[0]).not.toContain('will independently verify');
});

test('system.transform does not inject when no goal', async () => {
  const session = makeSessionContext({machine: null});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  const output = {system: ['You are a helpful assistant.']};
  await hooks['experimental.chat.system.transform']!(
    {sessionID: 'session-1'},
    output,
  );

  expect(output.system.length).toBe(1);
  expect(output.system[0]).toBe('You are a helpful assistant.');
});

test('system.transform does not duplicate goal block', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  const existingBlock = '<fixate_on id="goal-1">existing</fixate_on>';
  const output = {system: [existingBlock]};
  await hooks['experimental.chat.system.transform']!(
    {sessionID: 'session-1'},
    output,
  );

  expect(output.system.length).toBe(1);
});

test('system.transform creates system array when empty', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  const output = {system: [] as string[]};
  await hooks['experimental.chat.system.transform']!(
    {sessionID: 'session-1'},
    output,
  );

  expect(output.system.length).toBe(1);
  expect(output.system[0]).toContain('fixate_on');
});

test('system.transform handles non-string system blocks without throwing', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  const output = {
    system: [123, {nested: true}, 'existing string'] as unknown as string[],
  };
  await hooks['experimental.chat.system.transform']!(
    {sessionID: 'session-1'},
    output,
  );

  expect(output.system.length).toBe(4);
  expect(output.system[0]).toContain('fixate_on');
});

// chat.message

test('chat.message pauses active goal on user intervention', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  await hooks['chat.message']!(
    {sessionID: 'session-1'},
    {parts: [{type: 'text', text: 'Let me fix something'}]},
  );

  expect(machine.snapshot().status).toBe('paused');
  expect(machine.snapshot().stopReason).toBe('user intervention');
});

test('chat.message ignores slash commands', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  await hooks['chat.message']!(
    {sessionID: 'session-1'},
    {parts: [{type: 'text', text: '/goal status'}]},
  );

  expect(machine.snapshot().status).toBe('active');
});

test('chat.message ignores when no goal', async () => {
  const session = makeSessionContext({machine: null});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  // Should not throw
  await hooks['chat.message']!(
    {sessionID: 'session-1'},
    {parts: [{type: 'text', text: 'hello'}]},
  );
});

test('chat.message ignores when goal is paused', async () => {
  const goal = makeGoal({status: 'paused', stopReason: 'paused'});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  await hooks['chat.message']!(
    {sessionID: 'session-1'},
    {parts: [{type: 'text', text: 'hello'}]},
  );

  expect(machine.snapshot().status).toBe('paused');
});

// event (session.idle)

test('event with session.idle continues the goal', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working on it'}],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  // Should have sent a continuation prompt
  expect(mockApi.promptsSent.length).toBe(1);
  expect(mockApi.promptsSent[0]).toContain('Continue working');
});

test('BUDGET-D2: noProgressTurns counts TURNS, not idle ticks', async () => {
  // The regression this locks: the idle handler re-evaluates the SAME latest
  // message on every tick, so one unchanged stalled message advanced the streak
  // to the threshold of 2 by itself (measured live: 6 tracking runs for
  // turnCount=2) and paused a goal that had not actually stalled twice.
  const goal = makeGoal({
    turnCount: 5,
    maxTurns: 25,
    noToolCallTurnsBeforePause: 0,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-stall',
        parts: [{type: 'text', text: 'Done'}],
        info: {tokens: {output: 10}}, // low output, no tools, no reasoning
      },
    ],
  });
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi: mockApi,
    logError: async () => {},
    runtime,
  };
  const hooks = createHooks(deps);

  // Tick 1 is the grace observation: the message is recorded, not yet counted.
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-a',
  });
  expect(machine.snapshot().noProgressTurns).toBe(0);

  // Tick 2 is a genuine second observation of the same stalled turn.
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-b',
  });
  expect(machine.snapshot().noProgressTurns).toBe(1);

  // Ticks 3-5 re-observe the SAME message. Before the fix the streak climbed
  // 1 -> 2 -> 3 -> 4 and the threshold of 2 paused the goal; a single stalled
  // turn must never accumulate into a pause by itself.
  for (const id of ['idle-c', 'idle-d', 'idle-e']) {
    await hooks.event!({type: 'session.idle', sessionID: 'session-1', id});
    expect(machine.snapshot().noProgressTurns).toBe(1);
  }
  expect(machine.snapshot().status).toBe('active');
});

test('BUDGET-D3: a host with no usage events attributes usage from fetched messages', async () => {
  // v1 hosts deliver no message.updated, so goal.totalTokens stayed 0, the token
  // brake never fired, and the cockpit rendered a false 0 / N gauge. The idle
  // handler already fetches the messages, so it must attribute them.
  const goal = makeGoal({
    turnCount: 1,
    maxTurns: 25,
    noToolCallTurnsBeforePause: 0,
    minDelayMs: 0,
    usage: makeUsage({input: 0, output: 0}),
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-usage-1',
        parts: [{type: 'text', text: 'working'}],
        info: {tokens: {total: 5000, input: 1000, output: 4000}},
      },
    ],
  });
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };
  const hooks = createHooks(deps);
  expect(machine.snapshot().totalTokens).toBe(0);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-u1',
  });
  expect(machine.snapshot().totalTokens).toBe(5000);
  expect(machine.snapshot().usage.output).toBe(4000);
});

test('BUDGET-D3: a v2 host (session.usage.updated, never message.updated) is not double-counted', async () => {
  // The hole this locks: the guard was set only on `message.updated`, which v2
  // NEVER emits, so on v2 the idle path attributed usage that the usage event had
  // already charged — measured: 4000 became 8000, which fires the token-budget
  // brake at half the real spend. This drives the REAL v2 channel.
  const goal = makeGoal({
    turnCount: 1,
    maxTurns: 25,
    noToolCallTurnsBeforePause: 0,
    minDelayMs: 0,
    usage: makeUsage({input: 0, output: 0}),
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-v2',
        parts: [{type: 'text', text: 'working'}],
        info: {tokens: {total: 5000, input: 1000, output: 4000}},
      },
    ],
  });
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.usage.updated',
    sessionID: 'session-1',
    properties: {tokens: {total: 5000, input: 1000, output: 4000}},
  });
  const afterUsage = machine.snapshot().usage.output;
  expect(afterUsage).toBe(4000);

  // An idle tick on the same session must not charge it a second time.
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-v2',
  });
  expect(machine.snapshot().usage.output).toBe(afterUsage);
});

test('BUDGET-D3: on a usage-emitting host, idle does NOT attribute messages events never covered', async () => {
  // The guard's real job: on v2 the host's own usage events are the authority,
  // and the idle handler must not ADD attribution the host never reported. This
  // message is in the goal's message set and in the fetched list, but no
  // message.updated ever carried it — so idle must leave the total alone.
  const goal = makeGoal({
    turnCount: 1,
    maxTurns: 25,
    noToolCallTurnsBeforePause: 0,
    minDelayMs: 0,
    usage: makeUsage({input: 0, output: 0}),
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  await machine.rememberMessageID('msg-unreported');
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-unreported',
        parts: [{type: 'text', text: 'working'}],
        info: {tokens: {total: 7777, input: 1000, output: 6777}},
      },
    ],
  });
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };
  const hooks = createHooks(deps);

  // The host shows it delivers usage events (for a different message).
  await hooks.event!({
    type: 'message.updated',
    sessionID: 'session-1',
    properties: {
      info: {role: 'assistant', id: 'msg-other', tokens: {total: 100}},
    },
  });
  const afterEvent = machine.snapshot().totalTokens;

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-u2',
  });
  expect(machine.snapshot().totalTokens).toBe(afterEvent);
});

test('BUDGET-D3: a host that DOES emit usage events is not double-counted', async () => {
  // The v2 guard: attributing from fetched messages on a host that already
  // delivers message.updated would charge every token twice.
  const goal = makeGoal({
    turnCount: 1,
    maxTurns: 25,
    noToolCallTurnsBeforePause: 0,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-usage-2',
        parts: [{type: 'text', text: 'working'}],
        info: {tokens: {total: 5000, input: 1000, output: 4000}},
      },
    ],
  });
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };
  const hooks = createHooks(deps);

  // The host shows it delivers usage events.
  await hooks.event!({
    type: 'message.updated',
    sessionID: 'session-1',
    properties: {
      info: {
        role: 'assistant',
        id: 'msg-usage-2',
        tokens: {total: 5000, input: 1000, output: 4000},
      },
    },
  });
  const afterEvent = machine.snapshot().totalTokens;
  expect(afterEvent).toBeGreaterThan(0);

  // Now an idle tick: the fetched message must NOT be charged a second time.
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-u2',
  });
  expect(machine.snapshot().totalTokens).toBe(afterEvent);
});

test('event with session.idle ignores non-idle events', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi();
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({type: 'session.start', sessionID: 'session-1'});

  expect(mockApi.promptsSent.length).toBe(0);
});

test('event with session.idle ignores when no goal', async () => {
  const session = makeSessionContext({machine: null});
  const mockApi = makeMockSessionApi();
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(mockApi.promptsSent.length).toBe(0);
});

test('event with session.idle ignores when goal is paused', async () => {
  const goal = makeGoal({status: 'paused', stopReason: 'paused'});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi();
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(mockApi.promptsSent.length).toBe(0);
});

test('event deduplicates idle events by ID', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  // Send the same event twice
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-dup',
  });
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-dup',
  });

  // Should only process once
  expect(mockApi.promptsSent.length).toBe(1);
});

test('event with session.idle applies pending complete intent', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(machine.snapshot().status).toBe('active');
  expect(machine.snapshot().lastStatus).toContain('verification unavailable');
  expect(session.getPendingIntent('goal-1')).toBeNull();
});

test('completed goal is archived via removeGoal after pending intent applied', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
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
  const removedGoalIds: string[] = [];
  const session = makeSessionContext({
    machine,
    pendingIntent: intent,
    removedGoalIds,
  });
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(machine.snapshot().status).toBe('active');
  expect(machine.snapshot().lastStatus).toContain('verification unavailable');
  expect(session.getPendingIntent('goal-1')).toBeNull();
  expect(removedGoalIds).not.toContain('goal-1');
});

test('event with session.idle transitions to budgetLimited when budget exhausted', async () => {
  const goal = makeGoal({tokenBudget: 1000});
  goal.usage = makeUsage({input: 1000, output: 500}); // 1500 > 1000
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(machine.snapshot().status).toBe('budgetLimited');
  expect(machine.snapshot().budgetLimitReported).toBe(true);
});

test('event with session.idle stops when turn limit reached', async () => {
  const goal = makeGoal({turnCount: 25, maxTurns: 25});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(machine.snapshot().status).toBe('paused');
  expect(machine.snapshot().stopReason).toContain('max turns');
});

// compaction

test('compaction injects goal context', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  const output = {parts: [{type: 'text', text: 'Compacted context'}]};
  await hooks['experimental.session.compacting']!(
    {sessionID: 'session-1'},
    output,
  );

  expect(output.parts.length).toBe(2);
  const goalContext = (output.parts[1] as {text?: string}).text ?? '';
  expect(goalContext).toContain('goal_context');
  expect(goalContext).toContain('Build the feature');
});

test('compaction does nothing when no goal', async () => {
  const session = makeSessionContext({machine: null});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  const output = {parts: [{type: 'text', text: 'Compacted'}]};
  await hooks['experimental.session.compacting']!(
    {sessionID: 'session-1'},
    output,
  );

  expect(output.parts.length).toBe(1);
});

// chat.message plugin continuation detection

test('chat.message ignores plugin continuation messages with synthetic flag', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  await hooks['chat.message']!(
    {sessionID: 'session-1'},
    {parts: [{type: 'text', text: 'Continue working', synthetic: true}]},
  );

  expect(machine.snapshot().status).toBe('active');
});

test('chat.message ignores plugin continuation messages with metadata', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  await hooks['chat.message']!(
    {sessionID: 'session-1'},
    {
      parts: [
        {
          type: 'text',
          text: 'Continue working',
          metadata: {'fixate-on': {kind: 'continuation'}},
        },
      ],
    },
  );

  expect(machine.snapshot().status).toBe('active');
});

// noProgressTurns incrementing

test('event with session.idle increments noProgressTurns on low-output turn', async () => {
  const goal = makeGoal({
    turnCount: 1,
    noProgressTurns: 0,
    lastAssistantText: 'ok',
    lastAssistantMessageID: 'msg-0',
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 10, reasoning: 0},
        parts: [{type: 'text', text: 'ok'}],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(machine.snapshot().noProgressTurns).toBe(1);
});

test('event with session.idle resets noProgressTurns on high-output turn', async () => {
  const goal = makeGoal({turnCount: 1, noProgressTurns: 2});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 500, reasoning: 0},
        parts: [
          {type: 'text', text: 'Working extensively on the implementation'},
        ],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(machine.snapshot().noProgressTurns).toBe(0);
});

test('compaction does not increment revision (preserves pending intent validity)', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const intent: PendingIntent = {
    goalId: 'goal-1',
    revision: machine.state.revision,
    runId: machine.state.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  };
  const session = makeSessionContext({machine, pendingIntent: intent});
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  await hooks.event!({type: 'session.compacted', sessionID: 'session-1'});

  expect(machine.state.revision).toBe(intent.revision);
});

// promptFailures reset-to-0

test('promptFailures resets to 0 on successful continuation (not decremented by 1)', async () => {
  const goal = makeGoal({turnCount: 1, promptFailures: 2});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        usage: {input: 1000, output: 500, reasoning: 0},
        parts: [
          {type: 'text', text: 'Working extensively on the implementation'},
        ],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(machine.snapshot().promptFailures).toBe(0);
});

// autoPromote only in ordered sessions

test('autoPromote not called when session is not ordered', async () => {
  const goal = makeGoal();
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  let promoteCalled = false;
  session.autoPromote = async () => {
    promoteCalled = true;
  };
  session.setPendingIntent('goal-1', {
    goalId: 'goal-1',
    revision: machine.state.revision,
    runId: goal.runId,
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
  });
  const deps = makeDeps({session});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(promoteCalled).toBe(false);
});

// judge rejection on goal paused during judge await

test('judge rejection sets stopReason even when goal paused during judge await', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = {
    ...makeDeps({session, sessionApi: mockApi}),
    completionJudge: async () => {
      // Simulate race: user sends a message during the judge's async await,
      // triggering the chat.message hook which pauses the goal.
      await machine.transition('paused', {
        source: 'chat-message',
        stopReason: 'user intervention',
      });
      return {approved: false, reason: 'tests still failing'};
    },
  };
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  const result = machine.snapshot();
  expect(result.status).toBe('paused');
  expect(result.stopReason).toBe('judge rejected');
  expect(result.lastStatus).toContain('The judge rejected the claim');
  expect(result.lastStatus).toContain('tests still failing');
  expect(session.getPendingIntent('goal-1')).toBeNull();
});

test('judge rejection sets stopReason even when goal blocked during judge await', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = {
    ...makeDeps({session, sessionApi: mockApi}),
    completionJudge: async () => {
      // Simulate race: goal transitions to blocked during judge's async await
      await machine.transition('blocked', {
        source: 'chat-message',
        stopReason: 'blocked',
        blockedReason: 'Need user input',
      });
      return {approved: false, reason: 'incomplete tests'};
    },
  };
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  const result = machine.snapshot();
  expect(result.status).toBe('blocked');
  expect(result.stopReason).toBe('judge rejected');
  expect(result.lastStatus).toContain('The judge rejected the claim');
  expect(result.lastStatus).toContain('incomplete tests');
  expect(session.getPendingIntent('goal-1')).toBeNull();
});

test('approved judge does not complete goal paused by user during judge async call', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
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
  const removedGoalIds: string[] = [];
  const session = makeSessionContext({
    machine,
    pendingIntent: intent,
    removedGoalIds,
  });
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = {
    ...makeDeps({session, sessionApi: mockApi}),
    completionJudge: async () => {
      // Simulate race: user sends a message during the judge's async await,
      // triggering the chat.message hook which pauses the goal.
      await machine.transition('paused', {
        source: 'chat-message',
        stopReason: 'user intervention',
      });
      return {approved: true, reason: ''};
    },
  };
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  const result = machine.snapshot();
  // Goal should remain paused — user intervention takes precedence over the
  // assistant's completion claim, even when the judge approved.
  expect(result.status).toBe('paused');
  expect(result.stopReason).toBe('user intervention');
  // Pending intent should be discarded so it is not re-applied on resume.
  expect(session.getPendingIntent('goal-1')).toBeNull();
  // Goal should NOT be removed (not completed).
  expect(removedGoalIds).toEqual([]);
});

test('transition clears continuationClaim to prevent stuck goal after resume', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });

  // Set continuationClaim (simulating what executeDecision does)
  await machine.mutate(
    g => {
      g.continuationClaim = {runId: g.runId, sourceAssistantMessageID: 'msg-1'};
    },
    {
      source: 'idle-handler',
      detail: 'Set continuation claim',
      skipPersist: true,
    },
  );

  expect(machine.snapshot().continuationClaim).not.toBeNull();

  // Pause the goal (simulating chat.message handler when user sends a message)
  await machine.transition('paused', {
    source: 'chat-message',
    stopReason: 'user intervention',
  });

  // continuationClaim should be cleared on transition — a stale claim would
  // block continuation when the goal is resumed and the assistant message
  // hasn't changed (the claim's sourceAssistantMessageID still matches).
  expect(machine.snapshot().continuationClaim).toBeNull();
});

test('goal continues after resume when continuationClaim was set before pause', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };

  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };
  const hooks = createHooks(deps);

  // Set continuationClaim (simulating a previous continuation that set the claim)
  await machine.mutate(
    g => {
      g.continuationClaim = {runId: g.runId, sourceAssistantMessageID: 'msg-1'};
      g.lastAssistantMessageID = 'msg-1';
    },
    {
      source: 'idle-handler',
      detail: 'Set continuation claim',
      skipPersist: true,
    },
  );

  // Pause the goal (simulating chat.message handler when user sends a message)
  await machine.transition('paused', {
    source: 'chat-message',
    stopReason: 'user intervention',
  });

  // Resume the goal (simulating /goal resume)
  await machine.transition('active', {
    source: 'slash-command',
    stopReason: '',
    detail: 'User resumed',
  });

  // Trigger idle event — the goal should continue despite the stale claim
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  // A continuation prompt should have been sent (not blocked by stale claim)
  expect(mockApi.promptsSent.length).toBeGreaterThan(0);
});

test('ordered budget-limit prompt is sent before the next goal is promoted', async () => {
  const machine = new GoalStateMachine(
    makeGoal({tokenBudget: 1, usage: makeUsage()}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  let promotions = 0;
  session.isOrdered = () => true;
  session.autoPromote = async () => {
    promotions += 1;
  };
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });
  mockApi.promptAsync = async () => {
    expect(promotions).toBe(0);
    return {};
  };
  const hooks = createHooks(makeDeps({session, sessionApi: mockApi}));

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(promotions).toBe(1);
});

test('prompt failure does not overwrite stopReason when goal paused during prompt', async () => {
  const goal = makeGoal({promptFailures: 2});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });
  mockApi.promptAsync = async (
    _sessionID: string,
    input: {parts: unknown[]},
  ) => {
    const text = (input.parts[0] as {text?: string})?.text ?? '';
    mockApi.promptsSent.push(text);
    // Simulate user intervention during prompt: chat.message hook pauses the goal
    await machine.transition('paused', {
      source: 'chat-message',
      stopReason: 'user intervention',
    });
    return {error: {name: 'provider_error'}};
  };
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  const result = machine.snapshot();
  expect(result.status).toBe('paused');
  expect(result.stopReason).toBe('user intervention');
  expect(result.promptFailures).toBe(3);
});

test('prompt failure does not overwrite stopReason when goal blocked during prompt', async () => {
  const goal = makeGoal({promptFailures: 2});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });
  mockApi.promptAsync = async (
    _sessionID: string,
    input: {parts: unknown[]},
  ) => {
    const text = (input.parts[0] as {text?: string})?.text ?? '';
    mockApi.promptsSent.push(text);
    // Simulate goal blocked during prompt (e.g. update_goal blocked via tool)
    await machine.transition('blocked', {
      source: 'update_goal',
      stopReason: 'blocked',
      blockedReason: 'Need user input',
    });
    return {error: {name: 'provider_error'}};
  };
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  const result = machine.snapshot();
  expect(result.status).toBe('blocked');
  expect(result.stopReason).toBe('blocked');
  expect(result.promptFailures).toBe(3);
});

test('blockedTurns survives the idle boundary when blocked was asserted this turn', async () => {
  // Regression: case "continue" unconditionally reset
  // blockedTurns=0, so a below-threshold update_goal(blocked) (which sets no
  // pending intent) was zeroed on the very next idle — the 3-consecutive rule
  // could never accrue across turns. The fix: tools.ts sets
  // blockedAssertedThisTurn; case "continue" preserves blockedTurns when that
  // flag is set, then clears it.
  const machine = new GoalStateMachine(makeGoal({maxBlockedTurns: 3}), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  // Simulate the tool handler's below-threshold effect (attempt 1/3).
  await machine.mutate(
    g => {
      g.blockedTurns = 1;
      g.blockedAssertedThisTurn = true;
    },
    {
      source: 'update_goal',
      detail: 'blocked attempt 1/3; continuing',
      skipPersist: true,
    },
  );

  // No pending intent → decideContinuation returns "continue".
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  // The streak MUST be preserved (previously reset to 0), and the flag cleared.
  const after = machine.snapshot();
  expect(after.blockedTurns).toBe(1);
  expect(after.blockedAssertedThisTurn).toBe(false);
});

test('a normal continuation (no blocked assertion) resets blockedTurns', async () => {
  // When the agent did NOT assert blocked this turn, the streak resets — the
  // "consecutive" invariant. This guards against the fix over-preserving.
  const machine = new GoalStateMachine(
    makeGoal({maxBlockedTurns: 3, blockedTurns: 2}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ],
  });
  const deps = makeDeps({session, sessionApi: mockApi});
  const hooks = createHooks(deps);

  // blockedAssertedThisTurn is false (default) — a normal working turn.
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  expect(machine.snapshot().blockedTurns).toBe(0);
});

test('a fault obtaining an attestation keeps the goal non-terminal and retries', async () => {
  // The INVARIANT is unchanged: no verifier answered, so nothing may be
  // archived and the agent must not be trapped. What changed (user2026-09-25)
  // is the MECHANISM: an unobtainable attestation is a FAULT to retry, not an
  // abstention that leaves the goal active forever. The old shape let a
  // finished goal loop (~594k tokens) with no terminal action but to
  // misrepresent the work as blocked.
  const machine = new GoalStateMachine(makeGoal(), {
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
  const removedGoalIds: string[] = [];
  const session = makeSessionContext({
    machine,
    pendingIntent: intent,
    removedGoalIds,
  });
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const completionGate: CompletionGateDeps = {
    runVerifier: async () => ({failure: {kind: 'unavailable'}}),
    recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
  };
  const deps = makeDeps({session, sessionApi: mockApi, completionGate});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  // Still non-terminal, still visible, still not archived — and now it also
  // records that a retry is pending, so the user can see WHY it has not settled.
  expect(machine.snapshot().status).toBe('active');
  expect(machine.snapshot().lastStatus).toContain(
    'Attestation could not be obtained',
  );
  expect(machine.snapshot().lastStatus).toContain('Retrying');
  expect(machine.snapshot().attestationFaults).toBe(1);
  expect(mockApi.promptsSent).toHaveLength(0);
  expect(removedGoalIds).not.toContain('goal-1');
});

test('a fault never records an approval as verified completion', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    completionGate: {
      runVerifier: async () => ({failure: {kind: 'unavailable'}}),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
    completionJudge: async () => ({approved: true, reason: 'legacy says done'}),
  });
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-abstain-judge',
  });

  // The invariant this test exists for, unchanged and now enforced on the fault
  // path: a legacy judge's approval must NEVER become a verified completion
  // when no attestation was obtained.
  const claims = machine.snapshot().claims;
  expect(machine.snapshot().status).toBe('active');
  expect(
    claims.some(claim => claim.outcome.status === 'verified-complete'),
  ).toBe(false);
});

test('an operational verifier failure is a fault — retried, not escalated', async () => {
  // The asymmetry MOVED, and this test is the record of where it now sits:
  // - a failure to OBTAIN an attestation (timeout, spawn, unparseable,
  // unavailable) says nothing about the goal -> retry with backoff;
  // - a verifier that RAN and answered negatively (nonzero-exit) is real
  // evidence about the goal -> bounded recovery, then escalate.
  // Escalating on a transient network failure used to pause a HEALTHY goal.
  const machine = new GoalStateMachine(makeGoal({recoveryTurns: 12}), {
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const completionGate: CompletionGateDeps = {
    runVerifier: async () => ({
      failure: {kind: 'judge-error', error: 'timed out'},
    }),
    recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
  };
  const deps = makeDeps({session, sessionApi: mockApi, completionGate});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  // An exhausted RECOVERY budget must not escalate a fault: the two are
  // different axes. The goal stays active and the fault is retried.
  expect(machine.snapshot().status).toBe('active');
  expect(machine.snapshot().lastStatus).toContain(
    'Attestation could not be obtained',
  );
  expect(machine.snapshot().attestationFaults).toBe(1);
});

// per-goal recovery bounds

test('per-goal maxRecoveryTurns is respected, not plugin-level defaults', async () => {
  // Reproduces hooks.ts must construct the RecoveryConfig from
  // postRunGoal.maxRecoveryTurns/maxUnchangedResults, NOT from
  // gate.recoveryConfig (plugin defaults). A goal with maxRecoveryTurns=3
  // must escalate at turn 4, not turn 13.
  const machine = new GoalStateMachine(
    makeGoal({maxRecoveryTurns: 3, recoveryTurns: 3}),
    {
      onCommit: async () => {},
    },
  );
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  // The gate's recoveryConfig has the PLUGIN defaults (12/3).
  // The fix uses the GOAL's bounds (3/3) instead.
  const completionGate: CompletionGateDeps = {
    runVerifier: async ctx => ({
      verdict: {
        schema_version: 1,
        task_id: 'goal-1',
        state: 'WORKING',
        candidate: ctx.candidateIdentity.candidate,
        fingerprint: ctx.candidateIdentity.fingerprint,
        outstanding: ['still working'],
        evidence: ['verifier says no'],
      },
    }),
    recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
  };
  const deps = makeDeps({session, sessionApi: mockApi, completionGate});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-r4-1',
  });

  // recoveryTurns goes from 3 to 4. With per-goal maxRecoveryTurns=3,
  // 4 > 3 → escalate → paused. Without the fix (using plugin default 12),
  // 4 > 12 is false → recover → active + recovery prompt sent.
  const goal = machine.snapshot();
  expect(goal.status).toBe('paused');
  expect(goal.stopReason).toContain('escalated');
  expect(goal.lastStatus).toContain('Escalated');
});

// languageTriage=false skips scanPrematureExit

test('languageTriage=false suppresses phrase triage in recovery prompt', async () => {
  // Reproduces: when languageTriage is false, scanPrematureExit
  // must NOT run — no "Advisory:" line should appear in the recovery prompt.
  const machine = new GoalStateMachine(
    makeGoal({languageTriage: false, maxRecoveryTurns: 12}),
    {
      onCommit: async () => {},
    },
  );
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  // The assistant text contains a phrase that WOULD trigger scanPrematureExit
  // ("remaining tasks"). With languageTriage=false, this must be ignored.
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [
          {type: 'text', text: "I have remaining tasks to do but I'm done."},
        ],
      },
    ],
  });
  const completionGate: CompletionGateDeps = {
    runVerifier: async ctx => ({
      verdict: {
        schema_version: 1,
        task_id: 'goal-1',
        state: 'WORKING',
        candidate: ctx.candidateIdentity.candidate,
        fingerprint: ctx.candidateIdentity.fingerprint,
        outstanding: ['tests fail'],
        evidence: ['gmake check exited 2'],
      },
    }),
    recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
  };
  const deps = makeDeps({session, sessionApi: mockApi, completionGate});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-r5-1',
  });

  // The recovery prompt was sent (WORKING → recover)
  expect(mockApi.promptsSent.length).toBeGreaterThan(0);
  // No "Advisory:" line because languageTriage=false
  const recoveryPrompt = mockApi.promptsSent[mockApi.promptsSent.length - 1];
  expect(recoveryPrompt).not.toContain('Advisory:');
});

test('languageTriage=true (default) includes phrase triage in recovery prompt', async () => {
  // Contrast: with languageTriage=true (default), the phrase triage reason
  // IS included in the recovery prompt.
  const machine = new GoalStateMachine(
    makeGoal({languageTriage: true, maxRecoveryTurns: 12}),
    {
      onCommit: async () => {},
    },
  );
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [
          {type: 'text', text: "I have remaining tasks to do but I'm done."},
        ],
      },
    ],
  });
  const completionGate: CompletionGateDeps = {
    runVerifier: async ctx => ({
      verdict: {
        schema_version: 1,
        task_id: 'goal-1',
        state: 'WORKING',
        candidate: ctx.candidateIdentity.candidate,
        fingerprint: ctx.candidateIdentity.fingerprint,
        outstanding: ['tests fail'],
        evidence: ['gmake check exited 2'],
      },
    }),
    recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
  };
  const deps = makeDeps({session, sessionApi: mockApi, completionGate});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-r5-1b',
  });

  expect(mockApi.promptsSent.length).toBeGreaterThan(0);
  const recoveryPrompt = mockApi.promptsSent[mockApi.promptsSent.length - 1];
  expect(recoveryPrompt).toContain('Advisory:');
});

// variant: failed transition must not archive

test('explicitly authorized verifier mutation permits the verdict', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'goal-verifier-artifact-'));
  try {
    const machine = new GoalStateMachine(makeGoal({executionContext: {cwd}}), {
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
    const removedGoalIds: string[] = [];
    const session = makeSessionContext({
      machine,
      pendingIntent: intent,
      removedGoalIds,
    });
    const mockApi = makeMockSessionApi({
      messages: [
        {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
      ],
    });
    const completionGate: CompletionGateDeps = {
      runVerifier: async ({candidateIdentity}) => {
        await writeFile(
          join(cwd, 'generated-snapshot.txt'),
          'authorized by verifier',
        );
        return {
          verdict: {
            schema_version: 1,
            task_id: 'goal-1',
            state: 'COMPLETE',
            candidate: candidateIdentity.candidate,
            fingerprint: candidateIdentity.fingerprint,
            outstanding: [],
            evidence: ['verifier generated snapshot and all checks passed'],
          },
          allowWorkingTreeMutations: true,
        };
      },
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const deps = makeDeps({session, sessionApi: mockApi, completionGate});
    const hooks = createHooks(deps);

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-r8-2',
    });

    expect(removedGoalIds).toContain('goal-1');
    expect(machine.snapshot().status).toBe('complete');
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('a JUDGE-attestation mismatch is recorded as the judge, not as gmake-target', async () => {
  // LIVE DEFECT, stock v1, 2026-09-26. The identity fence OVERWRITES the
  // verifier result, and the local type restated the gate's return shape
  // WITHOUT checkPath/checkTarget. So a judge that returned a verdict not
  // attesting to the captured candidate was recorded as
  // `check.path=gmake-target` — the user was told the PROJECT'S CHECK rejected
  // the claim when it was the judge. The live state file recorded exactly that.
  // An attestation must name the verifier that produced it, or the label is a
  // false statement about what happened.
  const cwd = await mkdtemp(join(tmpdir(), 'goal-verifier-identity-path-'));
  try {
    const machine = new GoalStateMachine(makeGoal({executionContext: {cwd}}), {
      onCommit: async () => {},
    });
    const session = makeSessionContext({machine});
    const mockApi = makeMockSessionApi({
      messages: [
        {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
      ],
    });
    const completionGate: CompletionGateDeps = {
      runVerifier: async () => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'COMPLETE',
          candidate: 'foreign-candidate',
          fingerprint: 'foreign-fingerprint',
          outstanding: [],
          evidence: ['stale verdict'],
        },
        checkPath: 'judge' as const,
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const deps = makeDeps({session, sessionApi: mockApi, completionGate});
    const hooks = createHooks(deps);
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: 0,
      runId: 'run-1',
      messageID: '',
      toolCallID: '',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-r8-3-path',
    });

    const claim = machine.snapshot().lastClaim;
    expect(claim?.check.path).toBe('judge');
    expect(claim?.check.path).not.toBe('none');
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('a judge verdict is host-stamped with the captured candidate identity', async () => {
  // Since prune #4 (user ruling 2026-11-01) the only verifier is the judge, and
  // a judge is a model: it cannot compute a git HEAD sha or a tree fingerprint,
  // so the gate stamps the judge's verdict with the host's own capture of what
  // was verified (completion-gate-run.ts). The judge's tools are bound to the
  // goal's tree at session.create, which is what fences the wrong-tree risk.
  // A foreign candidate in the RAW verdict is therefore corrected, not
  // rejected — the location binding, not the verdict fields, is the fence.
  const cwd = await mkdtemp(join(tmpdir(), 'goal-verifier-identity-'));
  try {
    const machine = new GoalStateMachine(makeGoal({executionContext: {cwd}}), {
      onCommit: async () => {},
    });
    const session = makeSessionContext({machine});
    const mockApi = makeMockSessionApi({
      messages: [
        {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
      ],
    });
    const completionGate: CompletionGateDeps = {
      runVerifier: async () => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'COMPLETE',
          candidate: 'foreign-candidate',
          fingerprint: 'foreign-fingerprint',
          outstanding: [],
          evidence: ['stale verdict'],
        },
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const deps = makeDeps({session, sessionApi: mockApi, completionGate});
    const hooks = createHooks(deps);
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: 0,
      runId: 'run-1',
      messageID: '',
      toolCallID: '',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-r8-3',
    });
    const claim = machine.snapshot().lastClaim;
    expect(claim?.check.path).toBe('judge');
    expect(claim?.check.verdict).not.toBe('VERIFIER_FAILURE');
    expect(session.getPendingIntent('goal-1')).toBeNull();
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('failed transition to complete does NOT archive the goal', async () => {
  // Reproduces if machine.transition("complete") fails, the
  // goal must NOT be archived via session.removeGoal. The fix adds `break`
  // after the error log to skip the archive code.
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  // Mock transition to fail for "complete"
  const origTransition = machine.transition.bind(machine);
  (machine as unknown as {transition: typeof origTransition}).transition =
    async (
      target: Parameters<typeof origTransition>[0],
      opts: Parameters<typeof origTransition>[1],
    ) => {
      if (target === 'complete')
        return {ok: false, error: 'mocked: transition blocked'};
      return origTransition(target, opts);
    };
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
  const removedGoalIds: string[] = [];
  const session = makeSessionContext({
    machine,
    pendingIntent: intent,
    removedGoalIds,
  });
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  // Verifier returns COMPLETE → settle-complete → transition("complete") fails
  const completionGate: CompletionGateDeps = {
    runVerifier: async ctx => ({
      verdict: {
        schema_version: 1,
        task_id: 'goal-1',
        state: 'COMPLETE',
        candidate: ctx.candidateIdentity.candidate,
        fingerprint: ctx.candidateIdentity.fingerprint,
        outstanding: [],
        evidence: ['all pass'],
      },
    }),
    recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
  };
  const deps = makeDeps({session, sessionApi: mockApi, completionGate});
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-r8-1',
  });

  // The transition failed → goal must NOT be archived
  expect(removedGoalIds).not.toContain('goal-1');
  // The goal should still be active (not complete, because the transition failed)
  expect(machine.snapshot().status).toBe('active');
  // The pending intent must be cleared to prevent a retry loop
  expect(session.getPendingIntent('goal-1')).toBeNull();
});

test('throwing judge does not leave pending intent stuck', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
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
  const session = makeSessionContext({machine, pendingIntent: intent});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = {
    ...makeDeps({session, sessionApi: mockApi}),
    completionJudge: async () => {
      throw new Error('judge crashed');
    },
  };
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-1',
  });

  const result = machine.snapshot();
  expect(result.status).toBe('paused');
  expect(result.stopReason).toBe('judge rejected');
  // The wording moved to the shared vocabulary with the collapse; the
  // INVARIANT is unchanged — the throw is surfaced, not swallowed.
  expect(result.lastStatus).toContain('judge error');
  expect(session.getPendingIntent('goal-1')).toBeNull();
});

// compaction global map clearing

test('compaction of one session does not double-count usage in another session', async () => {
  // Two goals in two sessions, sharing a single runtime (as in the real plugin)
  const goalA = createGoalState('session-A', 'Goal A', {
    goalId: 'goal-A',
    runId: 'run-A',
  });
  const machineA = new GoalStateMachine(goalA, {
    onCommit: async () => {},
  });
  const goalB = createGoalState('session-B', 'Goal B', {
    goalId: 'goal-B',
    runId: 'run-B',
  });
  const machineB = new GoalStateMachine(goalB, {
    onCommit: async () => {},
  });

  const sessionA: SessionContext = {
    sessionID: 'session-A',
    getMachine: () => machineA,
    listActiveGoals: () => [machineA.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => {
      throw new Error('not used');
    },
    replaceGoals: async () => {
      throw new Error('not used');
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    autoPromote: async () => {},
    setPendingIntent: () => {}, // goal-aware in prod
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
  const sessionB: SessionContext = {
    sessionID: 'session-B',
    getMachine: () => machineB,
    listActiveGoals: () => [machineB.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => {
      throw new Error('not used');
    },
    replaceGoals: async () => {
      throw new Error('not used');
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    autoPromote: async () => {},
    setPendingIntent: () => {}, // goal-aware in prod
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };

  const sessions = new Map<string, SessionContext>();
  sessions.set('session-A', sessionA);
  sessions.set('session-B', sessionB);

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };

  const deps: HookDeps = {
    getSessionContext: (id: string) => sessions.get(id),
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: makeMockSessionApi(),
    logError: async () => {},
    idlePoller: false,
    runtime,
  };
  const hooks = createHooks(deps);

  // Message with usage data for session B
  const messageEvent = {
    type: 'message.updated',
    sessionID: 'session-B',
    properties: {
      info: {
        id: 'msg-B-1',
        role: 'assistant',
        info: {
          tokens: {
            input: 1000,
            output: 500,
            reasoning: 0,
            cache: {read: 0, write: 0},
          },
          cost: 0.01,
        },
      },
    },
  };

  // Step 1: Fire message.updated for session B — tracks usage
  await hooks.event!(messageEvent);
  expect(machineB.state.usage.input).toBe(1000);
  expect(machineB.state.usage.output).toBe(500);

  // Step 2: Fire session.compacted for session A (a DIFFERENT session)
  await hooks.event!({type: 'session.compacted', sessionID: 'session-A'});

  // Step 3: Fire the same message.updated for session B again
  await hooks.event!(messageEvent);

  // Verify usage was NOT double-counted
  expect(machineB.state.usage.input).toBe(1000); // NOT 2000
  expect(machineB.state.usage.output).toBe(500); // NOT 1000
});

// continuation prompt not sent for goal paused during prep

test('executeDecision skips prompt when goal is paused during continuation prep', async () => {
  const goal = createGoalState('session-1', 'Test goal', {
    goalId: 'goal-1',
    runId: 'run-1',
  });
  let paused = false;
  const machine = new GoalStateMachine(goal, {
    onCommit: async snapshot => {
      // Simulate chat.message handler pausing the goal right after turn count is incremented
      if (snapshot.turnCount > 0 && !paused) {
        paused = true;
        machine.state.status = 'paused';
        machine.state.stopReason = 'user intervention';
      }
    },
  });

  const mockSessionApi = makeMockSessionApi({messages: []});
  const session: SessionContext = {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => [machine.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => {
      throw new Error('not used');
    },
    replaceGoals: async () => {
      throw new Error('not used');
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    autoPromote: async () => {},
    setPendingIntent: () => {}, // goal-aware in prod
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockSessionApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'event-1',
  });

  expect(mockSessionApi.promptsSent).toHaveLength(0);
  expect(paused).toBe(true);
});

// stop and budget-limit actions track promptInFlightSessions

test('stop action tracks promptInFlightSessions during prompt', async () => {
  const goal = makeGoal({
    maxTurns: 1,
    turnCount: 1,
    maxTokens: 0,
    maxDurationMs: 0,
    tokenBudget: 0,
    lastContinueAt: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };

  let wasTrackedDuringPrompt = false;
  const promptsSent: string[] = [];
  const mockSessionApi: SessionApi = {
    messages: async () => [],
    promptAsync: async (sessionID: string, input: {parts: unknown[]}) => {
      wasTrackedDuringPrompt = runtime.promptInFlightSessions.has(sessionID);
      const text = (input.parts[0] as {text?: string})?.text ?? '';
      promptsSent.push(text);
      return {};
    },
  };

  const session: SessionContext = {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => [machine.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => {
      throw new Error('not used');
    },
    replaceGoals: async () => {
      throw new Error('not used');
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    autoPromote: async () => {},
    setPendingIntent: () => {}, // goal-aware in prod
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };

  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockSessionApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };

  const hooks = createHooks(deps);
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'event-1',
  });

  expect(promptsSent).toHaveLength(1);
  expect(wasTrackedDuringPrompt).toBe(true);
  expect(runtime.promptInFlightSessions.has('session-1')).toBe(false);
});

test('budget-limit action tracks promptInFlightSessions during prompt', async () => {
  const goal = makeGoal({
    maxTurns: 0,
    maxTokens: 0,
    maxDurationMs: 0,
    tokenBudget: 100,
    budgetLimitReported: false,
    lastContinueAt: 0,
    usage: makeUsage({input: 100, output: 0, reasoning: 0, cacheWrite: 0}),
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };

  let wasTrackedDuringPrompt = false;
  const promptsSent: string[] = [];
  const mockSessionApi: SessionApi = {
    messages: async () => [],
    promptAsync: async (sessionID: string, input: {parts: unknown[]}) => {
      wasTrackedDuringPrompt = runtime.promptInFlightSessions.has(sessionID);
      const text = (input.parts[0] as {text?: string})?.text ?? '';
      promptsSent.push(text);
      return {};
    },
  };

  const session: SessionContext = {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => [machine.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => {
      throw new Error('not used');
    },
    replaceGoals: async () => {
      throw new Error('not used');
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    autoPromote: async () => {},
    setPendingIntent: () => {}, // goal-aware in prod
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };

  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockSessionApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };

  const hooks = createHooks(deps);
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'event-1',
  });

  expect(promptsSent).toHaveLength(1);
  expect(wasTrackedDuringPrompt).toBe(true);
  expect(runtime.promptInFlightSessions.has('session-1')).toBe(false);
});

// chat.message should abort in-flight prompts for non-active goals

test('chat.message aborts in-flight prompt even when goal is paused (stop wrap-up)', async () => {
  const goal = makeGoal({status: 'paused', stopReason: 'max turns reached'});
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  let abortCalled = false;
  const mockSessionApi: SessionApi = {
    messages: async () => [],
    promptAsync: async () => ({}),
    abort: async () => {
      abortCalled = true;
    },
  };

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
    promptInFlightSessions: new Set(['session-1']),
  };

  const session: SessionContext = {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => [machine.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => {
      throw new Error('not used');
    },
    replaceGoals: async () => {
      throw new Error('not used');
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    autoPromote: async () => {},
    setPendingIntent: () => {}, // goal-aware in prod
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };

  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockSessionApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };

  const hooks = createHooks(deps);

  await hooks['chat.message']!(
    {sessionID: 'session-1'},
    {
      parts: [
        {type: 'text', text: 'Hey, stop summarizing and do this instead'},
      ],
    },
  );

  expect(abortCalled).toBe(true);
});

test('compaction does not cause double-counting when same message.updated refires', async () => {
  const goal = createGoalState('session-1', 'Test goal', {
    goalId: 'goal-1',
    runId: 'run-1',
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  const session: SessionContext = {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => [machine.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => {
      throw new Error('not used');
    },
    replaceGoals: async () => {
      throw new Error('not used');
    },
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    autoPromote: async () => {},
    setPendingIntent: () => {}, // goal-aware in prod
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };

  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: makeMockSessionApi(),
    logError: async () => {},
    idlePoller: false,
    runtime,
  };
  const hooks = createHooks(deps);

  const messageEvent = {
    type: 'message.updated',
    sessionID: 'session-1',
    properties: {
      info: {
        id: 'msg-1',
        role: 'assistant',
        info: {
          tokens: {
            input: 1000,
            output: 500,
            reasoning: 0,
            cache: {read: 0, write: 0},
          },
          cost: 0.01,
        },
      },
    },
  };

  await hooks.event!(messageEvent);
  expect(machine.state.usage.input).toBe(1000);
  expect(machine.state.usage.output).toBe(500);

  await hooks.event!({type: 'session.compacted', sessionID: 'session-1'});

  await hooks.event!(messageEvent);

  expect(machine.state.usage.input).toBe(1000);
  expect(machine.state.usage.output).toBe(500);
});

// stop and budget-limit must check transition result before sending prompt

test('stop action does not send prompt when transition fails', async () => {
  const goal = makeGoal({
    maxTurns: 1,
    turnCount: 1,
    maxTokens: 0,
    maxDurationMs: 0,
    tokenBudget: 0,
    lastContinueAt: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  (
    machine as unknown as {
      transition: (target: string) => Promise<{ok: boolean; error?: string}>;
    }
  ).transition = async (newStatus: string) => {
    if (newStatus === 'paused') {
      return {ok: false, error: 'transition blocked by test'};
    }
    return {ok: true};
  };

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };

  const mockSessionApi = makeMockSessionApi();
  const session = makeSessionContext({machine});
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockSessionApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };

  const hooks = createHooks(deps);
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'event-1',
  });

  // With the fix: no prompt should be sent because the transition failed
  expect(mockSessionApi.promptsSent).toHaveLength(0);
});

test('budget-limit action does not send prompt when transition fails', async () => {
  const goal = makeGoal({
    maxTurns: 0,
    maxTokens: 0,
    maxDurationMs: 0,
    tokenBudget: 100,
    budgetLimitReported: false,
    lastContinueAt: 0,
    usage: makeUsage({input: 100, output: 0, reasoning: 0, cacheWrite: 0}),
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  (
    machine as unknown as {
      transition: (target: string) => Promise<{ok: boolean; error?: string}>;
    }
  ).transition = async (newStatus: string) => {
    if (newStatus === 'budgetLimited') {
      return {ok: false, error: 'transition blocked by test'};
    }
    return {ok: true};
  };

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };

  const mockSessionApi = makeMockSessionApi();
  const session = makeSessionContext({machine});
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockSessionApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };

  const hooks = createHooks(deps);
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'event-1',
  });

  // With the fix: no prompt should be sent because the transition failed
  expect(mockSessionApi.promptsSent).toHaveLength(0);
});

// clock rollback must not block the continuation loop

test('cooldown elapsed clamped to 0 on clock rollback', async () => {
  const goal = makeGoal({
    maxTurns: 0,
    maxTokens: 0,
    maxDurationMs: 0,
    tokenBudget: 0,
    lastContinueAt: Date.now() + 60000,
    minDelayMs: 50,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });

  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };

  const mockSessionApi = makeMockSessionApi();
  const session = makeSessionContext({machine});
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockSessionApi,
    logError: async () => {},
    idlePoller: false,
    runtime,
  };

  const hooks = createHooks(deps);

  let timedOut = false;
  const timeout = new Promise<void>(resolve => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, 5000);
  });

  await Promise.race([
    hooks.event!({type: 'session.idle', sessionID: 'session-1', id: 'event-1'}),
    timeout,
  ]);

  expect(timedOut).toBe(false);
});

// Phrase triage (stop-guard) — advisory, not a gate
//
// Language triage is demoted to an advisory step
// of 9: "optional," "may abstain," "cannot override a stronger state
// check." The scan returns {tier, reason} — there is NO `block` field.
// Puffery patterns were removed (README.md:202-208 rejects "puffery is the
// tell"). The scan is advisory; it cannot block a verifier-OK COMPLETE.

test('scanPrematureExit: returns {tier, reason}, not {block, reason}', async () => {
  const {scanPrematureExit} = await import('../src/stop-guard.ts');
  const v = scanPrematureExit('remaining tasks: fix bugs');
  expect(v.tier).toBe('phrase');
  expect(v.reason).toBeTruthy();
  // No block field — the triage is advisory.
  expect(v).not.toHaveProperty('block');
});

test('scanPrematureExit: matches remaining-work, deferral, permission, session-length', async () => {
  const {scanPrematureExit} = await import('../src/stop-guard.ts');
  // Remaining-work (anchored).
  expect(
    scanPrematureExit('There are remaining tasks to implement.').tier,
  ).toBe('phrase');
  expect(scanPrematureExit('Next steps: run the integration tests.').tier).toBe(
    'phrase',
  );
  expect(scanPrematureExit('The tests were not run.').tier).toBe('phrase');
  expect(scanPrematureExit('The feature is not complete.').tier).toBe('phrase');
  // Deferral (anchored).
  expect(scanPrematureExit("I'll pick this up later.").tier).toBe('phrase');
  expect(scanPrematureExit('at some point we should').tier).toBe('phrase');
  // Permission-seeking.
  expect(scanPrematureExit('Should I continue with the migration?').tier).toBe(
    'phrase',
  );
  // Session-length.
  expect(scanPrematureExit('This is a good stopping point.').tier).toBe(
    'phrase',
  );
});

test('scanPrematureExit: puffery does NOT match (rejected by design)', async () => {
  const {scanPrematureExit} = await import('../src/stop-guard.ts');
  // The 5 puffery patterns were removed. These verified completions must
  // NOT trip the triage.
  expect(
    scanPrematureExit("I've implemented the full feature. That should do it.")
      .tier,
  ).toBe('none');
  expect(scanPrematureExit('the task is complete').tier).toBe('none');
  expect(scanPrematureExit('All done!').tier).toBe('none');
});

test('scanPrematureExit: clean completions with evidence do not trip', async () => {
  const {scanPrematureExit} = await import('../src/stop-guard.ts');
  expect(
    scanPrematureExit('Tests pass: 871/871. Build clean. tsc: 0 errors.').tier,
  ).toBe('none');
  expect(scanPrematureExit('').tier).toBe('none');
  expect(
    scanPrematureExit('The build exited 0 and all 50 tests passed.').tier,
  ).toBe('none');
});

test('scanPrematureExit: word-boundary anchors prevent substring false positives', async () => {
  const {scanPrematureExit} = await import('../src/stop-guard.ts');
  // "for now" was a bare pattern in an earlier revision; there is no equivalent here.
  expect(
    scanPrematureExit('All tests pass for now and forever. Verified.').tier,
  ).toBe('none');
  // "eventuallyConsistent" must not trip the defunct /eventually/i.
  expect(
    scanPrematureExit(
      'The eventuallyConsistent field is implemented and verified.',
    ).tier,
  ).toBe('none');
});

test('recoveryTurns persists across state serialization', async () => {
  const goal = createGoalState('s1', 'test', {maxRecoveryTurns: 15});
  goal.recoveryTurns = 3;
  goal.unchangedResults = 1;
  goal.lastCandidate = 'abc123';
  goal.lastFingerprint = 'def456';
  const {serializeGoal, deserializeGoal} =
    await import('../src/persistence.ts');
  const serialized = serializeGoal(goal);
  const restored = deserializeGoal(serialized);
  expect(restored.recoveryTurns).toBe(3);
  expect(restored.maxRecoveryTurns).toBe(15);
  expect(restored.unchangedResults).toBe(1);
  expect(restored.lastCandidate).toBe('abc123');
  expect(restored.lastFingerprint).toBe('def456');
});

// The poller's createHooks integration (previously untested)

test('by DEFAULT the synthetic-idle poller runs and drives a continuation', async () => {
  // Guards against the inverse of the flake fix: if the poller were disabled by
  // default, stock v1 (which delivers no events at all) would never continue.
  // A fast interval + short quiet window make the integration observable here.
  const machine = new GoalStateMachine(
    makeGoal({
      status: 'active',
      turnCount: 1,
      maxTurns: 25,
      minDelayMs: 0,
    }),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-poll',
        parts: [{type: 'text', text: 'working'}],
        info: {tokens: {output: 500}},
      },
    ],
  });
  // The poller iterates runtime.sessionGoals, so the session must be registered
  // there for the sweep to see it (production does this on goal creation).
  // It also consults liveSessions: only sessions the host has delivered an
  // event for in this process lifetime are polled, so the fixture marks the
  // session live the way a chat.params dispatch would.
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  runtime.sessionGoals.set('session-1', [machine]);
  runtime.liveSessions.add('session-1');
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockApi,
    logError: async () => {},
    runtime,
    idlePollerIntervalMs: 20,
    idleQuietMs: 30,
    idleGraceMs: 0,
    // NOTE: idlePoller deliberately NOT set — the default must be ON.
  };
  const hooks = createHooks(deps);
  try {
    // The first tick records the quiet window; a later one fires the synthetic
    // idle. Await the effect rather than budgeting ticks for it: a fixed tick
    // budget is a deadline to race, and on a loaded machine the poller legitimately
    // needs more of them.
    await waitFor(
      () => mockApi.promptsSent.length > 0,
      'the default idle poller to synthesize an idle and send a continuation',
    );
    expect(mockApi.promptsSent.length).toBeGreaterThan(0);
  } finally {
    await hooks.dispose?.();
  }
});

test('idlePoller:false starts no poller at all', async () => {
  const machine = new GoalStateMachine(
    makeGoal({
      status: 'active',
      turnCount: 1,
      maxTurns: 25,
      minDelayMs: 0,
    }),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-nopoll',
        parts: [{type: 'text', text: 'x'}],
        info: {tokens: {output: 500}},
      },
    ],
  });
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  // Register the goal where the poller's sweep looks. Without this the poller
  // has nothing to act on, so this test would pass even with the option ignored
  // entirely — the negative would be vacuous (mutation-verified). Mark the
  // session live as well: the poller skips sessions the host never spoke for.
  runtime.sessionGoals.set('session-1', [machine]);
  runtime.liveSessions.add('session-1');
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockApi,
    logError: async () => {},
    runtime,
    idlePoller: false,
    idlePollerIntervalMs: 10,
    idleQuietMs: 20,
  };
  const hooks = createHooks(deps);

  // Absence needs a WITNESS. "Nothing fired in 150ms" cannot distinguish "the
  // option suppressed the poller" from "the poller had not fired yet". An
  // otherwise-identical hook set with the poller left ON must produce a prompt;
  // once it has, the disabled set's silence is a real behavioural difference
  // rather than an unelapsed wait.
  const witnessMachine = new GoalStateMachine(
    makeGoal({
      status: 'active',
      turnCount: 1,
      maxTurns: 25,
      minDelayMs: 0,
    }),
    {
      onCommit: async () => {},
    },
  );
  const witnessSession = makeSessionContext({machine: witnessMachine});
  const witnessApi = makeMockSessionApi({
    messages: [
      {
        role: 'assistant',
        id: 'msg-nopoll-w',
        parts: [{type: 'text', text: 'x'}],
        info: {tokens: {output: 500}},
      },
    ],
  });
  const witnessRuntime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  witnessRuntime.sessionGoals.set('session-1', [witnessMachine]);
  witnessRuntime.liveSessions.add('session-1');
  const witnessHooks = createHooks({
    ...deps,
    getSessionContext: () => witnessSession,
    sessionApi: witnessApi,
    runtime: witnessRuntime,
    // The ONLY difference from the set under test: the poller is ON.
    idlePoller: true,
  });

  try {
    await waitFor(
      () => witnessApi.promptsSent.length > 0,
      'the witness poller (idlePoller unset) to fire',
    );
    expect(witnessApi.promptsSent.length).toBeGreaterThan(0);
    expect(mockApi.promptsSent).toHaveLength(0);
  } finally {
    await hooks.dispose?.();
    await witnessHooks.dispose?.();
  }
});

// BUDGET-D3: the v1 message WRAPPER shape must be attributable
//
// Live falsification (2026-09-23): on stock v1 both goals reported
// totalTokens 0 while the agent visibly ran turns, and `Updated tracking
// fields` proved the idle handler ran. Cause: `trackTokenUsage` read
// `message.id`, but the v1 session.messages response nests the id under
// `info.id`, so it early-returned with no attribution. Every earlier test used
// the v2 shape (info object passed directly), so none could see it.

test('BUDGET-D3: a v1-shaped message ({ info, parts }) is attributed, not skipped', async () => {
  const goal = makeGoal({
    turnCount: 1,
    maxTurns: 25,
    noToolCallTurnsBeforePause: 0,
    minDelayMs: 0,
    usage: makeUsage({input: 0, output: 0}),
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  // Exactly the v1 shape: the id and tokens live under `info`.
  const mockApi = makeMockSessionApi({
    messages: [
      {
        info: {
          id: 'msg-v1-wrapped',
          role: 'assistant',
          tokens: {
            input: 1200,
            output: 800,
            reasoning: 40,
            cache: {read: 0, write: 0},
          },
        },
        parts: [{type: 'text', text: 'working'}],
      },
    ],
  });
  const runtime: RuntimeState = {
    ...createRuntimeState(),
    threadToolsRegistered: true,
  };
  const deps: HookDeps = {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi: mockApi,
    logError: async () => {},
    runtime,
    idlePoller: false,
  };
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'idle-v1wrap',
  });

  expect(machine.snapshot().totalTokens).toBe(2040); // 1200 + 800 + 40
  expect(machine.snapshot().usage.output).toBe(800);
});

// noToolCallTurns counts TURNS, not idle ticks
//
// The no-tool-call brake incremented its counter on EVERY idle tick while
// looking at the SAME latest assistant message, unlike noProgressTurns which is
// keyed to a message id. On stock v1 the FX-J poller synthesizes an idle every
// ~10 s, so a SINGLE prose-only turn was counted once per tick and two ticks
// paused the goal at "no tool calls" while the agent was still working — a
// "forced stop" the user never earned. The counter now carries its own turn key,
// mirroring noProgressTurns. (Reasoning tokens are NOT exempt: this counter
// tracks tool-call absence specifically, and a separate reasoning exemption was
// considered and deliberately not adopted.)

function toolFreeSettledMessage(id: string, output = 2000): unknown {
  return {
    info: {
      id,
      role: 'assistant',
      time: {created: 2000, completed: 2500},
      finish: 'stop',
      tokens: {input: 9000, output},
    },
    parts: [
      {
        type: 'text',
        text: 'I have reviewed the code and will now explain my findings.',
      },
    ],
  };
}

test('noToolCallTurns does not accumulate across idle ticks on one unchanged message', async () => {
  const goal = makeGoal({
    turnCount: 1,
    noToolCallTurns: 0,
    noToolCallTurnsBeforePause: 2,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const sessionApi = makeMockSessionApi({
    messages: [toolFreeSettledMessage('msg-same')],
  });
  const hooks = createHooks(makeDeps({session, sessionApi}));

  // Three ticks, one message, ids unique so the dedupe set does not swallow them.
  for (const id of ['poll-1', 'poll-2', 'poll-3']) {
    await hooks.event!({type: 'session.idle', sessionID: 'session-1', id});
  }

  const snap = machine.snapshot();
  // One distinct turn observed three times is ONE no-tool-call turn, so the
  // threshold of 2 is not reached and the goal keeps running.
  expect(snap.noToolCallTurns).toBe(1);
  expect(snap.status).toBe('active');
});

test('noToolCallTurns still advances for a genuinely NEW tool-free turn', async () => {
  const goal = makeGoal({
    turnCount: 1,
    noToolCallTurns: 0,
    noToolCallTurnsBeforePause: 2,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  let current: unknown[] = [toolFreeSettledMessage('msg-a')];
  const sessionApi = makeMockSessionApi();
  sessionApi.messages = async () => current;
  const hooks = createHooks(makeDeps({session, sessionApi}));

  await hooks.event!({type: 'session.idle', sessionID: 'session-1', id: 'p1'});
  expect(machine.snapshot().noToolCallTurns).toBe(1);

  // A DIFFERENT tool-free turn is a new stalled turn and must still count.
  current = [toolFreeSettledMessage('msg-b')];
  await hooks.event!({type: 'session.idle', sessionID: 'session-1', id: 'p2'});
  expect(machine.snapshot().noToolCallTurns).toBe(2);
});

// A2: the stall brake's progress clock on a v2-shaped host
//
// On a host that emits usage events (v2 `session.usage.updated`), the runtime
// records `usageEventsObserved` for the session, and `trackTokenUsage`'s
// output-token branch returns early via the session-scoped path — so the
// `lastProgressAt` stamp inside it is UNREACHABLE. Without the idle handler's
// own stamp on a new assistant turn, a v2 goal would sit at `lastProgressAt: 0`
// and be paused by the stall brake despite working. This test locks that stamp.

test('a new assistant turn stamps lastProgressAt on a v2-shaped host', async () => {
  const runtime = createRuntimeState();
  const goal = makeGoal({
    turnCount: 1,
    lastProgressAt: 0,
    maxDurationMs: 900000,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  runtime.sessionGoals.set('session-1', [machine]);
  runtime.threadToolsRegistered = true;
  // A v2-shaped host: usage events are observed for this session, which makes
  // the session-scoped branch in trackTokenUsage return early.
  runtime.usageEventsObserved.add('session-1');

  const session = makeSessionContext({machine});
  const message = {
    info: {
      id: 'msg-v2-turn',
      role: 'assistant',
      time: {created: 2000, completed: 2500},
      finish: 'stop',
      tokens: {input: 1000, output: 500},
    },
    parts: [{type: 'text', text: 'I finished that step.'}],
  };
  const sessionApi = makeMockSessionApi({messages: [message]});
  const deps = {...makeDeps({session, sessionApi}), runtime} as HookDeps;
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'v2-1',
  });

  // The stamp must have advanced even though the usage-event path short-circuits.
  expect(machine.snapshot().lastProgressAt).toBeGreaterThan(0);
});

// RECOVERY RE-ARM: must work on a host with no authentic idles
//
// Reported as "resume doesn't reliably resume". On stock v1 the host delivers
// NO authentic idle events, so a goal that was ACTIVE at shutdown hydrated to
// paused/recovery and then deadlocked: the re-arm required an authentic idle
// that never came, and the FX-J poller refused to fire for a recovery-paused
// goal, so the only wake path skipped it. The `recoveryPendingSessions` flag is
// one-shot, which is the real guard against looping.

function recoveryPausedSetup(): {machine: GoalStateMachine; deps: HookDeps} {
  const runtime = createRuntimeState();
  const goal = createGoalState('session-1', 'work', {
    goalId: 'g1',
    runId: 'r1',
  });
  goal.status = 'paused';
  goal.stopReason = 'recovery';
  goal.pausedAt = Date.now();
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  runtime.sessionGoals.set('session-1', [machine]);
  runtime.threadToolsRegistered = true;
  runtime.recoveryPendingSessions.add('session-1');
  // Liveness: the re-arm fires for a session the host owns in this process.
  // The stale-session shape (flag without liveness) is covered in
  // fxj-idle-poll.test.ts, which asserts the flag is consumed un-armed.
  runtime.liveSessions.add('session-1');
  const session = makeSessionContext({machine});
  const sessionApi = makeMockSessionApi({
    messages: [
      {
        info: {
          id: 'msg-a',
          role: 'assistant',
          time: {created: 1000, completed: 1500},
          finish: 'stop',
        },
        parts: [{type: 'text', text: 'done'}],
      },
    ],
  });
  return {
    machine,
    deps: {...makeDeps({session, sessionApi}), runtime} as HookDeps,
  };
}

test('RECOVERY: a SYNTHETIC poll idle re-arms a recovery-paused goal (v1 has no authentic idles)', async () => {
  const {machine, deps} = recoveryPausedSetup();
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'v1-poll-1',
  } as never);

  const snap = machine.snapshot();
  expect(snap.status).toBe('active');
  expect(snap.stopReason).toBe('');
});

test('RECOVERY: the re-arm is ONE-SHOT — the flag is consumed, so it cannot loop', async () => {
  const {machine, deps} = recoveryPausedSetup();
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'v1-poll-1',
  } as never);
  expect(machine.snapshot().status).toBe('active');
  expect(deps.runtime?.recoveryPendingSessions.has('session-1')).toBe(false);
});

test('RECOVERY: an explicit pause is NOT re-armed by a poll idle', async () => {
  // Only `recovery` re-arms. A user-issued pause must stay paused.
  const runtime = createRuntimeState();
  const goal = createGoalState('session-1', 'work', {
    goalId: 'g2',
    runId: 'r2',
  });
  goal.status = 'paused';
  goal.stopReason = 'explicit pause';
  goal.pausedAt = Date.now();
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  runtime.sessionGoals.set('session-1', [machine]);
  runtime.threadToolsRegistered = true;
  runtime.recoveryPendingSessions.add('session-1');
  const session = makeSessionContext({machine});
  const deps = {...makeDeps({session}), runtime} as HookDeps;
  const hooks = createHooks(deps);

  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'v1-poll-9',
  } as never);

  expect(machine.snapshot().status).toBe('paused');
  expect(machine.snapshot().stopReason).toBe('explicit pause');
});

// NO-TOOL-CALL-BRAKE-1: a tool-USING cycle must not count as tool-free
//
// On stock v1 a tool-using cycle emits TWO assistant messages: one carrying the
// tool part (`finish: "tool-calls"`) and then a text-only summary
// (`finish: "stop"`). By the time the idle handler runs, the newest message is
// the SUMMARY, so a check of the newest message alone saw no tool call and
// counted a productive cycle as a stall — pausing a goal whose agent called a
// tool every single cycle. Reproduced: the goal paused at cycle 3 with
// stopReason "no tool calls" while its history recorded three `update_goal`
// claims.

/** A v1 tool-using cycle: the tool message, then the prose summary. */
function toolCycle(n: number): unknown[] {
  return [
    {
      info: {
        id: `msg-tool-${n}`,
        role: 'assistant',
        time: {created: 1000 + n * 100, completed: 1050 + n * 100},
        finish: 'tool-calls',
        tokens: {input: 9000, output: 400},
      },
      parts: [
        {type: 'tool', tool: 'update_goal', state: {status: 'completed'}},
      ],
    },
    {
      info: {
        id: `msg-text-${n}`,
        role: 'assistant',
        time: {created: 1100 + n * 100, completed: 1150 + n * 100},
        finish: 'stop',
        tokens: {input: 9000, output: 700},
      },
      parts: [
        {
          type: 'text',
          text: `Done. Created the file and verified it (pass ${n}).`,
        },
      ],
    },
  ];
}

test('NO-TOOL-CALL-BRAKE: a goal whose agent calls a tool EVERY cycle is not paused', async () => {
  const goal = makeGoal({
    turnCount: 1,
    noToolCallTurns: 0,
    noToolCallTurnsBeforePause: 3,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  let list: unknown[] = [
    {info: {id: 'msg-u', role: 'user', time: {created: 900}}, parts: []},
  ];
  const sessionApi = makeMockSessionApi();
  sessionApi.messages = async () => list;
  const hooks = createHooks(makeDeps({session, sessionApi}));

  for (let n = 1; n <= 6; n++) {
    list = [...list, ...toolCycle(n)];
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: `poll-${n}`,
    });
    const snap = machine.snapshot();
    expect(snap.status).toBe('active');
    expect(snap.noToolCallTurns).toBe(0);
  }
});

test('NO-TOOL-CALL-BRAKE: a genuinely talk-only goal STILL pauses', async () => {
  // The fix must not neuter the brake it protects: with no tool part anywhere
  // in the window, the counter must still reach the threshold.
  const goal = makeGoal({
    turnCount: 1,
    noToolCallTurns: 0,
    noToolCallTurnsBeforePause: 3,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  let list: unknown[] = [
    {info: {id: 'msg-u', role: 'user', time: {created: 900}}, parts: []},
  ];
  const sessionApi = makeMockSessionApi();
  sessionApi.messages = async () => list;
  const hooks = createHooks(makeDeps({session, sessionApi}));

  for (let n = 1; n <= 3; n++) {
    list = [
      ...list,
      {
        info: {
          id: `msg-talk-${n}`,
          role: 'assistant',
          time: {created: 1000 + n * 100, completed: 1050 + n * 100},
          finish: 'stop',
          tokens: {input: 9000, output: 900},
        },
        parts: [{type: 'text', text: `Here is my plan, revision ${n}.`}],
      },
    ];
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: `talk-${n}`,
    });
  }

  const snap = machine.snapshot();
  expect(snap.noToolCallTurns).toBe(3);
  expect(snap.status).toBe('paused');
  expect(snap.stopReason).toBe('no tool calls');
});

// PER-TURN-GUARD-1: an id-less host must not disable both per-turn brakes
//
// The guards read `Boolean(latestAssistantID) && id === lastKey`, which INVERTS
// when the host omits message ids: the guard becomes false, so every idle tick
// counts a new "turn" and one unchanged prose turn reaches the threshold by
// itself. Reproduced: three ticks of ONE turn drove noToolCallTurns to 3 and
// paused the goal.
//
// The first repair ("an id-less message is never counted") removed the false
// pause but disabled BOTH brakes for the whole run on such a host — the wrong
// trade, since the plugin exists to check a completion claim and a host without
// ids is exactly where an unchecked loop is possible. The key is now a TURN KEY
// (`assistantTurnKey`): the message id when the host reports one, otherwise the
// message's `time.created` — a signal such a host still stamps, and the same one
// `findNewestMessage` orders by. `#` prefixes the timestamp form so the two key
// spaces cannot collide.
//
// These tests therefore assert HOST PARITY: the same scenario yields the same
// counters whether or not the host reports ids. A turn is counted once, not once
// per tick and not never.

function idlessProseTurn(text: string): unknown {
  return {
    info: {
      role: 'assistant',
      time: {created: 1000, completed: 1500},
      finish: 'stop',
      tokens: {input: 9000, output: 900},
    },
    parts: [{type: 'text', text}],
  };
}

test('PER-TURN-GUARD: an id-less unchanged turn cannot accumulate the no-tool-call brake', async () => {
  const goal = makeGoal({
    turnCount: 1,
    noToolCallTurns: 0,
    noToolCallTurnsBeforePause: 3,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const messages = [idlessProseTurn('Here is my plan.')];
  const sessionApi = makeMockSessionApi({messages});
  const hooks = createHooks(makeDeps({session, sessionApi}));

  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
    await hooks.event!({type: 'session.idle', sessionID: 'session-1', id});
  }

  const snap = machine.snapshot();
  // ONE turn, observed five times, counts ONCE. `0` would mean the brake is
  // disabled on this host; `5` is the original defect (one turn reaching the
  // threshold alone); `3`+ would pause a goal for a single turn's prose.
  expect(snap.noToolCallTurns).toBe(1);
  expect(snap.status).toBe('active');
});

test('PER-TURN-GUARD: an id-less turn cannot accumulate the no-progress brake either', async () => {
  const goal = makeGoal({
    turnCount: 1,
    noProgressTurns: 0,
    noProgressTurnsBeforePause: 3,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  // Low output (below the 50-token threshold) and no tool call: the classic
  // stall signature, but id-less, so it must not be counted per tick.
  const messages = [
    {
      info: {
        role: 'assistant',
        time: {created: 1000, completed: 1500},
        finish: 'stop',
        tokens: {input: 9000, output: 10},
      },
      parts: [{type: 'text', text: 'ok'}],
    },
  ];
  const sessionApi = makeMockSessionApi({messages});
  const hooks = createHooks(makeDeps({session, sessionApi}));

  for (const id of ['q1', 'q2', 'q3', 'q4', 'q5']) {
    await hooks.event!({type: 'session.idle', sessionID: 'session-1', id});
  }

  expect(machine.snapshot().noProgressTurns).toBe(1);
});

test('PER-TURN-GUARD: a genuinely NEW id-less turn still advances BOTH counters', async () => {
  // The fail-safe must not disable the brakes on an id-less host either. This is
  // the id-less TWIN of the id-bearing test below: same shape, same threshold,
  // same expected counts.
  const goal = makeGoal({
    turnCount: 1,
    noToolCallTurns: 0,
    noProgressTurns: 0,
    noToolCallTurnsBeforePause: 3,
    noProgressTurnsBeforePause: 3,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  let list: unknown[] = [
    {info: {role: 'user', time: {created: 900}}, parts: []},
  ];
  const sessionApi = makeMockSessionApi();
  sessionApi.messages = async () => list;
  const hooks = createHooks(makeDeps({session, sessionApi}));

  for (let n = 1; n <= 3; n++) {
    list = [
      ...list,
      {
        // NO id — the host omits it. A distinct `time.created` is the only
        // thing marking this as a new turn, and the text is identical each
        // time, so the low-progress predicate sees a genuine repeat.
        info: {
          role: 'assistant',
          time: {created: 1000 + n * 1000, completed: 1500 + n * 1000},
          finish: 'stop',
          tokens: {input: 9000, output: 10},
        },
        parts: [{type: 'text', text: 'ok'}],
      },
    ];
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: `s${n}`,
    });
  }

  const snap = machine.snapshot();
  // Every turn is tool-free, so all three advance the no-tool-call brake.
  expect(snap.noToolCallTurns).toBe(3);
  // Only the SECOND and THIRD are low-progress: the first turn changed the
  // assistant text, and `isLowProgressTurn` requires the text to be unchanged
  // (a turn that produced new prose is not a stall). That asymmetry is the
  // predicate's design, and it is asserted identically for an id-bearing host.
  expect(snap.noProgressTurns).toBe(2);
  expect(snap.status).toBe('paused');
});

test('PER-TURN-GUARD: an ID-BEARING host still counts turns normally', async () => {
  // The fail-safe must not disable the brakes on a normal host.
  const goal = makeGoal({
    turnCount: 1,
    noToolCallTurns: 0,
    noToolCallTurnsBeforePause: 3,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  let list: unknown[] = [
    {info: {id: 'u1', role: 'user', time: {created: 900}}, parts: []},
  ];
  const sessionApi = makeMockSessionApi();
  sessionApi.messages = async () => list;
  const hooks = createHooks(makeDeps({session, sessionApi}));

  for (let n = 1; n <= 3; n++) {
    list = [
      ...list,
      {
        info: {
          id: `msg-${n}`,
          role: 'assistant',
          time: {created: 1000 + n, completed: 1500 + n},
          finish: 'stop',
          tokens: {input: 9000, output: 900},
        },
        parts: [{type: 'text', text: `plan ${n}`}],
      },
    ];
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: `r${n}`,
    });
  }

  const snap = machine.snapshot();
  expect(snap.noToolCallTurns).toBe(3);
  expect(snap.status).toBe('paused');
});

test('PER-TURN-GUARD: an ID-BEARING host yields the SAME counters as the id-less twin', async () => {
  // HOST PARITY, driven rather than asserted: identical turns, the only
  // difference being that this host reports ids. Any divergence between this
  // test and the id-less one above is a host-dependent brake — the class of bug
  // PER-TURN-GUARD-1 exists to remove.
  const goal = makeGoal({
    turnCount: 1,
    noToolCallTurns: 0,
    noProgressTurns: 0,
    noToolCallTurnsBeforePause: 3,
    noProgressTurnsBeforePause: 3,
    minDelayMs: 0,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  let list: unknown[] = [
    {info: {id: 'u1', role: 'user', time: {created: 900}}, parts: []},
  ];
  const sessionApi = makeMockSessionApi();
  sessionApi.messages = async () => list;
  const hooks = createHooks(makeDeps({session, sessionApi}));

  for (let n = 1; n <= 3; n++) {
    list = [
      ...list,
      {
        info: {
          id: `msg-${n}`,
          role: 'assistant',
          time: {created: 1000 + n * 1000, completed: 1500 + n * 1000},
          finish: 'stop',
          tokens: {input: 9000, output: 10},
        },
        parts: [{type: 'text', text: 'ok'}],
      },
    ];
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: `t${n}`,
    });
  }

  const snap = machine.snapshot();
  expect(snap.noToolCallTurns).toBe(3);
  expect(snap.noProgressTurns).toBe(2);
  expect(snap.status).toBe('paused');
});

// COMPLETION-ATTESTATION-1: the reported defect, end to end
//
// A live session released software and PROVED it, yet the goal never settled:
// 8 auto-continues, ~594k tokens, and the only terminal action left to the agent
// was to misrepresent finished work as `blocked`. These tests drive the real
// hooks path and assert the goal ENDS.

test('ATTESTATION: a sustained fault over a CHANGING workspace SETTLES the goal', async () => {
  // A static workspace CANNOT settle on a fault streak, and must not: with
  // nothing changing, a fault streak is a STUCK AGENT, and the stuck-agent
  // pause (unchanged > maxUnchangedResults) correctly fires before the fault
  // bound. This test therefore drives a CHANGING workspace, which is the case
  // the settlement bound exists for — the agent is doing work we simply cannot
  // check. (An earlier version drove a static workspace and passed only in a
  // repo with >512 untracked paths, where the fingerprint degrades to
  // `freshness-unknown` and the unchanged axis is pinned to 0. On a clean
  // checkout it was RED. Found in review.)
  const {mkdtemp} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {writeFile} = await import('node:fs/promises');
  const cwd = await mkdtemp(join(tmpdir(), 'goal-attest-'));
  const machine = new GoalStateMachine(
    makeGoal({executionContext: {cwd} as never}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    workspaceDirectory: cwd,
    completionGate: {
      runVerifier: async () => ({failure: {kind: 'unavailable'}}),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
  });
  const hooks = createHooks(deps);

  let settled = false;
  for (let n = 1; n <= 12 && !settled; n++) {
    // Real work between claims: the candidate identity must advance, or the
    // stuck-agent pause is the correct outcome instead of settlement.
    await writeFile(join(cwd, `progress-${n}.txt`), `work ${n}\n`);
    // Model the backoff window having elapsed: in production a host turn is
    // seconds apart, so the retry deadline has always passed by the next idle.
    // Advancing it here keeps this test about the SETTLEMENT bound rather than
    // about wall-clock timing.
    await machine.mutate(
      g => {
        g.attestationRetryAt = 0;
      },
      {source: 'update_goal', detail: 'elapsed', skipPersist: true},
    );
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: machine.currentRevision,
      runId: 'run-1',
      messageID: `msg-${n}`,
      toolCallID: `call-${n}`,
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: `fault-${n}`,
    });
    const st = machine.snapshot().status;
    settled = st === 'complete' || st === 'blocked';
  }

  // The whole point: it must END. The old behaviour kept it active forever.
  expect(settled).toBe(true);
  const snap = machine.snapshot();
  expect(snap.status).toBe('complete');
  // And the settlement is labelled honestly — never a plain "verified" claim.
  expect(snap.claims.some(c => c.outcome.status === 'verified-complete')).toBe(
    false,
  );
  expect(snap.claims.some(c => c.outcome.status === 'unverifiable-claim')).toBe(
    true,
  );
});

test('ATTESTATION: a fault over a STATIC workspace PAUSES (stuck agent), never settles', async () => {
  // The other half, and the reason the test above must move the workspace: with
  // nothing changing, repeated unverifiable completion assertions are a stuck
  // agent. Settling there would accept a looping agent's assertions as
  // completion — the premature exit this gate exists to prevent.
  const {mkdtemp} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'goal-attest-static-'));
  const machine = new GoalStateMachine(
    makeGoal({executionContext: {cwd} as never}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    workspaceDirectory: cwd,
    completionGate: {
      runVerifier: async () => ({failure: {kind: 'unavailable'}}),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
  });
  const hooks = createHooks(deps);

  let terminal: string | null = null;
  for (let n = 1; n <= 12 && !terminal; n++) {
    await machine.mutate(
      g => {
        g.attestationRetryAt = 0;
      },
      {source: 'update_goal', detail: 'elapsed', skipPersist: true},
    );
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: machine.currentRevision,
      runId: 'run-1',
      messageID: `msg-${n}`,
      toolCallID: `call-${n}`,
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: `static-${n}`,
    });
    const st = machine.snapshot().status;
    if (st !== 'active') terminal = st;
  }

  expect(terminal).toBe('paused');
  const snap = machine.snapshot();
  expect(snap.status).not.toBe('complete');
  // The vocabulary rule, applied to the surface this path PRODUCES rather than
  // to a fixture that hardcodes the expected string. `formatStatus` prints
  // `Stopped: <stopReason>`, so a stopReason is user-facing text; an earlier
  // revision of it read "unverifiable completion asserted repeatedly" — the
  // ledger's word, on a user surface, while the ban list said `unverifiable` was
  // forbidden. Asserting here is what makes that ban non-vacuous: the assertion
  // reads the value the pause path actually wrote.
  assertClean('the stuck-agent pause surface', formatStatus(snap, 'goal'));
  assertClean('the stuck-agent stopReason', snap.stopReason);
  expect(snap.stopReason).toContain(
    'unattested completion asserted repeatedly',
  );
});

test('ATTESTATION: the fault path is visible and persistent, not silent', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    completionGate: {
      runVerifier: async () => ({failure: {kind: 'unavailable'}}),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
  });
  const hooks = createHooks(deps);
  session.setPendingIntent('goal-1', {
    goalId: 'goal-1',
    revision: machine.currentRevision,
    runId: 'run-1',
    messageID: 'msg-1',
    toolCallID: 'call-1',
    targetStatus: 'complete',
    evidence: 'done',
    createdAt: Date.now(),
  });
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'fault-visible-1',
  });

  const snap = machine.snapshot();
  // A user watching must be able to tell "we could not check it" apart from
  // "the work is wrong" — that distinction is what makes a loop legible.
  expect(snap.lastStatus).toContain('Attestation could not be obtained');
  expect(snap.lastStatus).toContain('Retrying');
  expect(snap.attestationFaults).toBe(1);
  expect(snap.status).toBe('active');
});

// COMPLETION-ATTESTATION-1: the JUDGE tier, end to end
//
// The judge's prompt is asserted in child-session-verifier.test.ts and the gate's
// handling of a verdict is asserted in completion-gate.test.ts. What was not
// asserted is the wiring BETWEEN them: a judge that answers COMPLETE must
// actually SETTLE the goal through the real hooks path, and one that answers
// WORKING must keep it working. That wiring is the whole point of the tier.

test('ATTESTATION: a judge that concurs SETTLES the goal, recorded as attested', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    completionGate: {
      // Stands in for the judge: it inspected the workspace and concurred.
      runVerifier: async ctx => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'COMPLETE',
          candidate: ctx.candidateIdentity.candidate,
          fingerprint: ctx.candidateIdentity.fingerprint,
          outstanding: [],
          evidence: ['inspected the workspace; nothing outstanding'],
        },
        checkPath: 'judge' as const,
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
  });
  const hooks = createHooks(deps);
  session.setPendingIntent('goal-1', {
    goalId: 'goal-1',
    revision: machine.currentRevision,
    runId: 'run-1',
    messageID: 'msg-1',
    toolCallID: 'call-1',
    targetStatus: 'complete',
    evidence: 'done',
    createdAt: Date.now(),
  });
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'judge-yes',
  });

  const snap = machine.snapshot();
  // The goal ENDS. This is the transcript's shape, fixed.
  expect(snap.status).toBe('complete');
  expect(session.getPendingIntent('goal-1')).toBeNull();
  // And the record says a verifier checked it — never that it was unchecked.
  const last = snap.claims.at(-1);
  expect(last?.outcome.status).toBe('verified-complete');
});

test('ATTESTATION: a judge that refuses keeps the goal WORKING with its objections', async () => {
  const machine = new GoalStateMachine(makeGoal(), {
    onCommit: async () => {},
  });
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    completionGate: {
      runVerifier: async ctx => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'WORKING',
          candidate: ctx.candidateIdentity.candidate,
          fingerprint: ctx.candidateIdentity.fingerprint,
          outstanding: ['the release tag was never pushed'],
          evidence: ['checked the remote refs; no tag'],
        },
        checkPath: 'judge' as const,
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
  });
  const hooks = createHooks(deps);
  session.setPendingIntent('goal-1', {
    goalId: 'goal-1',
    revision: machine.currentRevision,
    runId: 'run-1',
    messageID: 'msg-1',
    toolCallID: 'call-1',
    targetStatus: 'complete',
    evidence: 'done',
    createdAt: Date.now(),
  });
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'judge-no',
  });

  const snap = machine.snapshot();
  // NOT settled — and NOT silently continued either: the refusal must reach the
  // agent as an instruction, which is the whole value of asking a judge.
  expect(snap.status).toBe('active');
  expect(snap.status).not.toBe('complete');
  expect(mockApi.promptsSent.length).toBeGreaterThan(0);
  expect(mockApi.promptsSent.join('\n')).toContain(
    'release tag was never pushed',
  );
});

test('ATTESTATION: resume resets the fault streak, so the bound is CONSECUTIVE', async () => {
  // The pause message tells the user to run /goal resume. If the streak survived
  // the resume, the very next fault would settle the goal unattested — the
  // "consecutive" invariant would be false for exactly the user who followed
  // the advice.
  const {mkdtemp, writeFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'goal-attest-resume-'));
  const machine = new GoalStateMachine(
    makeGoal({executionContext: {cwd} as never, attestationFaults: 4}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    workspaceDirectory: cwd,
    completionGate: {
      runVerifier: async () => ({failure: {kind: 'unavailable'}}),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
  });
  const hooks = createHooks(deps);
  expect(machine.snapshot().attestationFaults).toBe(4);

  // The real flow: the goal is PAUSED with a live streak, then the user resumes
  // (which is what the pause message recommends).
  await machine.transition('paused', {
    source: 'idle-handler',
    stopReason: 'test',
  });
  expect(machine.snapshot().attestationFaults).toBe(4); // a pause preserves it
  await machine.transition('active', {
    source: 'slash-command',
    detail: 'resume',
  });
  expect(machine.snapshot().attestationFaults).toBe(0);

  // ONE more fault must NOT settle it.
  await writeFile(join(cwd, 'p.txt'), 'x');
  session.setPendingIntent('goal-1', {
    goalId: 'goal-1',
    revision: machine.currentRevision,
    runId: 'run-1',
    messageID: 'msg-r',
    toolCallID: 'call-r',
    targetStatus: 'complete',
    evidence: 'done',
    createdAt: Date.now(),
  });
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'post-resume',
  });
  expect(machine.snapshot().status).toBe('active');
  expect(machine.snapshot().attestationFaults).toBe(1);
});

test('ATTESTATION: an unattestable settlement is ARCHIVED, not left active-complete', async () => {
  // The label must survive archiving: a goal that settled without an attestation
  // has to leave the active set and appear in the archive with its honest
  // marker. Before this it stayed active-complete, so the label never reached
  // the surface a user reads, and an ordered sequence stalled behind it.
  const {mkdtemp, writeFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'goal-attest-archive-'));
  // Seed the streak at the bound so a single fault settles — the bound is under
  // test here, not the grind, and grinding costs load-dependent identity work.
  const machine = new GoalStateMachine(
    makeGoal({executionContext: {cwd} as never, attestationFaults: 5}),
    {
      onCommit: async () => {},
    },
  );
  const removedGoalIds: string[] = [];
  const session = makeSessionContext({machine, removedGoalIds});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    workspaceDirectory: cwd,
    completionGate: {
      runVerifier: async () => ({failure: {kind: 'unavailable'}}),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
  });
  const hooks = createHooks(deps);

  await writeFile(join(cwd, 'p-1.txt'), 'x');
  session.setPendingIntent('goal-1', {
    goalId: 'goal-1',
    revision: machine.currentRevision,
    runId: 'run-1',
    messageID: 'm-1',
    toolCallID: 'c-1',
    targetStatus: 'complete',
    evidence: 'done',
    createdAt: Date.now(),
  });
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'arch-1',
  });

  expect(machine.snapshot().status).toBe('complete');
  // It left the active set, so the archived surface is the one that carries it.
  expect(removedGoalIds).toContain('goal-1');
});

// COMPLETION-IDENTITY-1: a judge cannot compute an identity
//
// Found LIVE on stock v1 (2026-09-26): a working goal recorded SEVEN completion
// claims and could not settle. Three died on `identity-mismatch`, two more on
// unparseable verifier output, and the agent ended by declaring itself BLOCKED —
// the "finished goal that cannot end" class this work exists to remove.
//
// Root cause: `buildVerdictPrompt` asked the JUDGE for `candidate` and
// `fingerprint`, and the gate rejected any disagreement. A language model cannot
// compute a sha256 of a working tree, so the only ways to "agree" were to echo
// perfectly or to copy the prompt — and the check could not detect the wrong-tree
// inspection it appeared to guard, because the prompt supplies the host's values
// either way. The host's own POST-RUN re-capture is the fence that actually
// works, and it is unaffected by this change.

test('identity-mismatch remains a rejection, not a fault', async () => {
  // classifyVerdictIdentity still rejects a verdict whose candidate differs
  // from the captured one — the command-verifier path that produced such a
  // verdict is pruned (user ruling 2026-11-01), but the classifier is the
  // guard against a future verifier being reintroduced without the fence.
  // Locked at the unit level: a mismatch is a rejection (recover/escalate
  // path), never a retry-fault.
  const {classifyVerdictIdentity} = await import('../src/completion-gate.ts');
  const captured = {candidate: 'head-abc1234', fingerprint: 'fp-deadbeef'};
  expect(
    classifyVerdictIdentity(captured, {
      candidate: 'other-head',
      fingerprint: 'fp-x',
    }),
  ).toEqual({kind: 'identity-mismatch', detail: expect.any(String)});
  expect(
    classifyVerdictIdentity(captured, {
      candidate: 'head-abc1234',
      fingerprint: 'fp-y',
    }),
  ).toBeNull();
});

test('a judge that OMITS the identity fields still settles', async () => {
  // The prompt now marks both fields OPTIONAL, because requiring them only turns
  // a formatting slip into a lost verdict. A judge that spends its effort on
  // `outstanding`/`evidence` instead must not be punished for it.
  const {mkdtemp} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'goal-identity-omit-'));
  const machine = new GoalStateMachine(
    makeGoal({executionContext: {cwd} as never}),
    {
      onCommit: async () => {},
    },
  );
  const session = makeSessionContext({machine});
  const mockApi = makeMockSessionApi({
    messages: [
      {role: 'assistant', id: 'msg-1', parts: [{type: 'text', text: 'Done'}]},
    ],
  });
  const deps = makeDeps({
    session,
    sessionApi: mockApi,
    workspaceDirectory: cwd,
    completionGate: {
      runVerifier: async () => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'COMPLETE',
          candidate: '',
          fingerprint: '',
          outstanding: [],
          evidence: ['globbed the tree; the artifact is present'],
        },
        checkPath: 'judge',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    },
  });
  const hooks = createHooks(deps);
  session.setPendingIntent('goal-1', {
    goalId: 'goal-1',
    revision: machine.currentRevision,
    runId: 'run-1',
    messageID: 'msg-1',
    toolCallID: 'call-1',
    targetStatus: 'complete',
    evidence: 'done',
    createdAt: Date.now(),
  });
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: 'identity-2',
  });

  expect(machine.snapshot().status).toBe('complete');
});
