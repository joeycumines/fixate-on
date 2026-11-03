// continuation-parity.test.ts — continuation-loop parity locks for the
// goal TRANSITION (the user observation 2026-08-25: "the current prompting
// around commands DOES cause the desired mutations of goal state but FAILS to
// produce the desired TRANSITION").
//
// Locks three mechanical parity fixes:
// FIX-A user-intervention pause RE-ARMS on the next idle (yield instantly,
// then keep grinding — the loop cancels the countdown on genuine human
// input and continues on the following session.idle). Explicit pauses
// ("paused") and restart recovery ("recovery") stay paused.
// FIX-B v1 no-agent-turn KICKOFF: a goal-creating slash command on stock v1
// launches no model turn, so no session.idle ever fires and the loop
// never wakes. command.execute.before now schedules a delayed kickoff
// probe that sends the first synthetic continuation ONLY when no
// assistant turn materialized.
// the v2 shim forwards the inherited agent display name instead of
// dropping it ("Agent not found" class).
import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createHooks,
  type HookDeps,
  isExplicitStopMessage,
  markSlashDispatch,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {createRuntimeState} from '../src/session-state-manager.ts';
import type {GoalState} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {GoalsPlugin} from '../src/plugin-runtime.ts';
import {v1PartsToV2Text} from '../src/plugin-v2.ts';

// FIX-A fixtures (mirror hooks.test.ts harness)

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

function makePausedGoal(stopReason: string): GoalState {
  const goal = createGoalState('session-1', 'Build the feature', {
    minDelayMs: 0,
    goalId: 'goal-1',
    runId: 'run-1',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {
    ...goal,
    usage: makeUsage(),
    status: 'paused',
    stopReason,
    turnCount: 1,
    lastAssistantText: 'progress made',
  };
}

function makeSessionContext(machine: GoalStateMachine | null): SessionContext {
  const activeGoals = machine ? [machine.snapshot()] : [];
  return {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => activeGoals,
    listArchivedResults: () => [],
    createGoal: () =>
      machine ??
      new GoalStateMachine(createGoalState('session-1', 'x'), {
        onCommit: async () => {},
      }),
    replaceGoals: async () =>
      machine ??
      new GoalStateMachine(createGoalState('session-1', 'x'), {
        onCommit: async () => {},
      }),
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => {
      if (!machine) return {ok: false as const, reason: 'no-session' as const};
      return {ok: true as const, machine};
    },
    addOrderedSession: () => {},
    isOrdered: () => false,
    setPendingIntent: () => {},
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
}

function makeMockSessionApi(messages: unknown[] = []): SessionApi & {
  promptsSent: Array<{text: string; agent?: unknown}>;
} {
  const promptsSent: Array<{text: string; agent?: unknown}> = [];
  return {
    messages: async () => messages,
    promptAsync: async (
      _sessionID: string,
      input: {parts: unknown[]} & Record<string, unknown>,
    ) => {
      const text = (input.parts[0] as {text?: string})?.text ?? '';
      promptsSent.push({text, agent: (input as {agent?: unknown}).agent});
      return {};
    },
    promptsSent,
  };
}

function makeDeps(session: SessionContext, sessionApi: SessionApi): HookDeps {
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi,
    logError: async () => {},
    completionGate: null,
    runtime: {
      ...createRuntimeState(),
      threadToolsRegistered: true,
      promptInFlightSessions: new Set<string>(),
    },
  };
}

describe('FIX-A: user-intervention pause re-arms on idle (yield-then-continue)', () => {
  test("paused 'user intervention' + idle -> re-armed active AND continuation prompt sent", async () => {
    const machine = new GoalStateMachine(makePausedGoal('user intervention'), {
      onCommit: async () => {},
    });
    const session = makeSessionContext(machine);
    const api = makeMockSessionApi([
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Answered the human'}],
      },
    ]);
    const hooks = createHooks(makeDeps(session, api));

    expect(machine.snapshot().status).toBe('paused');
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-rearm-1',
    });

    // The TRANSITION happened: goal is active again...
    expect(machine.snapshot().status).toBe('active');
    expect(machine.snapshot().stopReason).toBe('');
    //...and the loop drove it: exactly one synthetic continuation went out.
    expect(api.promptsSent.length).toBe(1);
    expect(api.promptsSent[0]!.text).toContain('Continue working');
  });

  test("explicit pause ('paused') stays paused — no auto-resume, no prompt", async () => {
    const machine = new GoalStateMachine(makePausedGoal('paused'), {
      onCommit: async () => {},
    });
    const session = makeSessionContext(machine);
    const api = makeMockSessionApi();
    const hooks = createHooks(makeDeps(session, api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-explicit-1',
    });

    expect(machine.snapshot().status).toBe('paused');
    expect(api.promptsSent.length).toBe(0);
  });

  test('restart recovery pause stays paused (survives death honestly)', async () => {
    const machine = new GoalStateMachine(makePausedGoal('recovery'), {
      onCommit: async () => {},
    });
    const session = makeSessionContext(machine);
    const api = makeMockSessionApi();
    const hooks = createHooks(makeDeps(session, api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-recovery-1',
    });

    expect(machine.snapshot().status).toBe('paused');
    expect(api.promptsSent.length).toBe(0);
  });

  test('max-turns pause stays paused (brake tiering respected)', async () => {
    const machine = new GoalStateMachine(makePausedGoal('max turns reached'), {
      onCommit: async () => {},
    });
    const session = makeSessionContext(machine);
    const api = makeMockSessionApi();
    const hooks = createHooks(makeDeps(session, api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-brake-1',
    });

    expect(machine.snapshot().status).toBe('paused');
    expect(api.promptsSent.length).toBe(0);
  });
});

// FIX-B: v1 no-agent-turn kickoff

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-'));
}

function recordingClient(
  opts: {
    lastRole?: string;
    /** Mutable message list — tests may swap it between schedule and fire. */
    messages?: unknown[];
  } = {},
): {
  client: unknown;
  prompts: Array<Record<string, unknown>>;
  setMessages: (m: unknown[]) => void;
  /**
   * Await the next prompt matching `predicate` (or resolve at once if one has
   * already landed). The kickoff probe fires on a real timer, so a test cannot
   * learn it landed without either sleeping (a race against a fixed deadline —
   * the flake the user banned weakening away on 2026-09-24) or awaiting the prompt
   * itself. The 2 s ceiling turns a kickoff that never fires into an explicit
   * failure rather than a wrong assertion.
   */
  waitForPrompt: (
    predicate?: (p: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
} {
  const prompts: Array<Record<string, unknown>> = [];
  let messages =
    opts.messages ??
    (opts.lastRole ? [{role: opts.lastRole, id: 'm-last', parts: []}] : []);
  const waiters: Array<{
    predicate: (p: Record<string, unknown>) => boolean;
    resolve: (p: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const pump = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      const hit = prompts.find(w.predicate);
      if (hit !== undefined) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(hit);
      }
    }
  };
  const client = {
    session: {
      messages: async () => messages,
      // The session API adapter invokes host methods with a SINGLE flat
      // argument: {sessionID,...payload}. Record that object verbatim.
      promptAsync: async (input: Record<string, unknown>) => {
        prompts.push(input);
        pump();
        return {};
      },
      abort: async () => ({}),
    },
  };
  const waitForPrompt = (
    predicate: (p: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> => {
    const existing = prompts.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no kickoff prompt within 2s')),
        2000,
      );
      waiters.push({predicate, resolve, timer});
    });
  };
  return {
    client,
    prompts,
    setMessages: (m: unknown[]) => {
      messages = m;
    },
    waitForPrompt,
  };
}

// Deadline sentinel
/**
 * Show that a kickoff deadline has PASSED without sleeping a guessed interval,
 * and return the kickoff prompts attributable to the session under test.
 *
 * A fixed sleep only shows a timer had not fired YET; a sentinel goal in a
 * DIFFERENT session, armed with the SAME kickoffDelayMs, gives the real deadline
 * a witness. Awaiting the SENTINEL's OWN prompt (matched by sessionID, not "the
 * next prompt of any kind") is what makes the witness sound: resolving on the
 * first prompt to arrive would let the session-under-test's own stray kickoff
 * satisfy the wait, so the negative assertion would pass while the defect it
 * exists to catch was firing.
 */
async function promptsAfterKickoffDeadline(
  hooks: Record<string, unknown>,
  sessionID: string,
  prompts: Array<Record<string, unknown>>,
  waitForPrompt: (
    p?: (x: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const handler = hooks['command.execute.before'] as
    | ((
        input: {sessionID: string; command: string; arguments: string},
        output: {
          parts: unknown[];
        },
      ) => Promise<void>)
    | undefined;
  const sentinelSessionID = `${sessionID}-deadline-sentinel`;
  await handler!(
    {
      sessionID: sentinelSessionID,
      command: 'goal',
      arguments: 'add sentinel deadline probe',
    },
    {parts: [] as unknown[]},
  );
  await waitForPrompt(p => p['sessionID'] === sentinelSessionID);
  return prompts.filter(p => p['sessionID'] === sessionID);
}

describe('FIX-B: v1 command.execute.before kicks off the loop when no agent turn exists', () => {
  test('/goal add schedules a kickoff prompt when no assistant responds', async () => {
    const dir = tmpdir();
    try {
      const {client, prompts, waitForPrompt} = recordingClient();
      const hooks = (await GoalsPlugin(
        {client, directory: dir},
        {persistState: false, kickoffDelayMs: 10, sdkShape: 'flat' as const},
      )) as unknown as Record<string, unknown>;
      const handler = hooks['command.execute.before'] as
        | ((
            input: {sessionID: string; command: string; arguments: string},
            output: {
              parts: unknown[];
            },
          ) => Promise<void>)
        | undefined;
      expect(typeof handler).toBe('function');

      const output = {parts: [] as unknown[]};
      await handler!(
        {
          sessionID: 'sess-kick-1',
          command: 'goal',
          arguments: 'add write the report',
        },
        output,
      );
      expect(output.parts.length).toBe(1);

      // Await the kickoff probe's own timer rather than racing it.
      const kickoff = await waitForPrompt();
      const parts = kickoff['parts'] as Array<{
        metadata?: {'fixate-on'?: {kind?: string}};
      }>;
      expect(parts?.[0]?.metadata?.['fixate-on']?.kind).toBe('kickoff');
      expect(prompts.length).toBe(1);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  // NOTE: the former "kickoff suppressed when last message role is assistant"
  // assertion encoded the stale-history bug and is intentionally gone —
  // suppression now requires a NEW assistant message after dispatch (see
  // stable-state describe block below).

  test('read-only subcommands (/goal status) schedule no kickoff', async () => {
    const dir = tmpdir();
    try {
      const {client, prompts, waitForPrompt} = recordingClient();
      const hooks = (await GoalsPlugin(
        {client, directory: dir},
        {persistState: false, kickoffDelayMs: 10, sdkShape: 'flat' as const},
      )) as unknown as Record<string, unknown>;
      const handler = hooks['command.execute.before'] as
        | ((
            input: {sessionID: string; command: string; arguments: string},
            output: {
              parts: unknown[];
            },
          ) => Promise<void>)
        | undefined;

      await handler!(
        {sessionID: 'sess-kick-3', command: 'goal', arguments: 'status'},
        {parts: [] as unknown[]},
      );
      await handler!(
        {sessionID: 'sess-kick-3', command: 'goal', arguments: 'list'},
        {parts: [] as unknown[]},
      );
      // A read-only subcommand schedules no timer, so absence must be witnessed
      // rather than assumed: the sentinel arms the SAME kickoffDelayMs in
      // another session, so when its prompt lands this session's deadline has
      // provably elapsed with nothing to show for it.
      const own = await promptsAfterKickoffDeadline(
        hooks,
        'sess-kick-3',
        prompts,
        waitForPrompt,
      );
      expect(own).toHaveLength(0);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('v1 order (OLDEST-first) -> kickoff still suppressed for a NEW assistant turn', async () => {
    const dir = tmpdir();
    try {
      // Stock v1 1.18.32 returns session.messages oldest-first. The guard
      // must reach the same verdict here as it does for the v2 descending
      // list above — this is the regression that stopped the idle poller from
      // ever firing on v1.
      const {client, prompts, setMessages, waitForPrompt} = recordingClient({
        messages: [
          {role: 'assistant', id: 'm-old', parts: [], time: {created: 1000}},
        ],
      });
      const hooks = (await GoalsPlugin(
        {client, directory: dir},
        {persistState: false, kickoffDelayMs: 30, sdkShape: 'flat' as const},
      )) as unknown as Record<string, unknown>;
      const handler = hooks['command.execute.before'] as
        | ((
            input: {sessionID: string; command: string; arguments: string},
            output: {
              parts: unknown[];
            },
          ) => Promise<void>)
        | undefined;

      await handler!(
        {
          sessionID: 'sess-race-asc',
          command: 'goal',
          arguments: 'add write the report',
        },
        {parts: [] as unknown[]},
      );
      setMessages([
        {role: 'assistant', id: 'm-old', parts: [], time: {created: 1000}},
        {role: 'user', id: 'm-cmd', parts: [], time: {created: 2000}},
        {role: 'assistant', id: 'm-new', parts: [], time: {created: 3000}},
      ]);
      const own = await promptsAfterKickoffDeadline(
        hooks,
        'sess-race-asc',
        prompts,
        waitForPrompt,
      );
      expect(own).toHaveLength(0);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

// v2 shim forwards the inherited agent to the host dispatch

describe('agent inheritance reaches the host dispatch', () => {
  test('v1PartsToV2Text carries the agent field through to the v2 payload', () => {
    const translated = v1PartsToV2Text({
      sessionID: 'ses-1',
      agent: 'Implementer',
      parts: [
        {
          type: 'text',
          text: 'Continue working.',
          metadata: {'fixate-on': {kind: 'continuation'}},
        },
      ],
    });
    expect(translated.agent).toBe('Implementer');
    expect(translated.text).toBe('Continue working.');
    // The marker object itself is HOISTED to message level (not nested).
    expect(translated.metadata).toEqual({kind: 'continuation'});
  });

  test('v1PartsToV2Text omits agent when absent (host default preserved)', () => {
    const translated = v1PartsToV2Text({
      sessionID: 'ses-1',
      parts: [{type: 'text', text: 'hello'}],
    });
    expect('agent' in translated).toBe(false);
  });

  test('hooks continuation dispatch attaches the resolved agent to promptAsync input', async () => {
    const goal = createGoalState('session-1', 'Build the feature', {
      minDelayMs: 0,
      goalId: 'goal-1',
      runId: 'run-1',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    goal.executionContext = {
      agent: 'Implementer',
      model: 'qwen-3.8-max',
      provider: 'dialagram',
      cwd: '/tmp/x',
    };
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const api = makeMockSessionApi([
      {
        role: 'assistant',
        id: 'msg-1',
        parts: [{type: 'text', text: 'Working'}],
      },
    ]);
    const hooks = createHooks(makeDeps(session, api));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-agent-1',
    });

    expect(api.promptsSent.length).toBe(1);
    expect(api.promptsSent[0]!.agent).toBe('Implementer');
  });
});

// v1 slash-echo: our own hook output must NOT pause a fresh goal

describe('v1 echo guard: chat.message replaying command-hook output', () => {
  test('text containing SERVER_MODE_HEADER does not pause the goal (live 1.18.19 defect)', async () => {
    const {SERVER_MODE_HEADER} = await import('../src/commands.ts');
    const goal = createGoalState('session-1', 'Build the feature', {
      minDelayMs: 0,
      goalId: 'goal-1',
      runId: 'run-1',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const api = makeMockSessionApi();
    const hooks = createHooks(makeDeps(session, api));

    // Exactly what stock v1 delivers after /goal add: our formatted hook output.
    await hooks['chat.message']!(
      {sessionID: 'session-1'},
      {
        parts: [
          {
            type: 'text',
            text: `${SERVER_MODE_HEADER} /add\nAdded and focused new goal: Build the feature`,
          },
        ],
      },
    );

    expect(machine.snapshot().status).toBe('active');

    // A genuine human message right after still pauses (guard is echo-specific).
    await hooks['chat.message']!(
      {sessionID: 'session-1'},
      {
        parts: [{type: 'text', text: 'stop working on that'}],
      },
    );
    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');

    // And FIX-A still re-arms it on the next idle.
    const api2 = makeMockSessionApi([
      {role: 'assistant', id: 'm1', parts: [{type: 'text', text: 'ack'}]},
    ]);
    const hooks2 = createHooks(makeDeps(session, api2));
    await hooks2.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-echo-rearm',
    });
    expect(machine.snapshot().status).toBe('active');
  });

  test("rapid successive dispatches queue their fingerprints — the FIRST command's echo stays suppressed", async () => {
    const goal = createGoalState('session-echo-q', 'Build the feature', {
      minDelayMs: 0,
      goalId: 'goal-echo-q',
      runId: 'run-echo-q',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const hooks = createHooks(makeDeps(session, makeMockSessionApi()));

    markSlashDispatch('session-echo-q', 'add fix the flake');
    markSlashDispatch('session-echo-q', 'status');

    await hooks['chat.message']!(
      {sessionID: 'session-echo-q'},
      {
        parts: [{type: 'text', text: 'add fix the flake'}],
      },
    );
    expect(machine.snapshot().status).toBe('active');

    await hooks['chat.message']!(
      {sessionID: 'session-echo-q'},
      {
        parts: [{type: 'text', text: 'status'}],
      },
    );
    expect(machine.snapshot().status).toBe('active');

    await hooks['chat.message']!(
      {sessionID: 'session-echo-q'},
      {
        parts: [{type: 'text', text: 'actually pivot to the docs instead'}],
      },
    );
    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');

    await hooks['chat.message']!(
      {sessionID: 'session-echo-q'},
      {
        parts: [{type: 'text', text: 'status'}],
      },
    );
    expect(machine.snapshot().status).toBe('paused');
  });
});

// FX-E: a whole-message stop imperative must NOT be auto-resumed

describe('FX-E explicit stop: conversational halt is not re-armed at idle', () => {
  test("'stop' pauses with 'explicit pause' and stays paused across idles", async () => {
    const goal = createGoalState('session-stop', 'Stop the grind', {
      minDelayMs: 0,
      goalId: 'goal-stop',
      runId: 'run-stop',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const hooks = createHooks(makeDeps(session, makeMockSessionApi()));

    await hooks['chat.message']!(
      {sessionID: 'session-stop'},
      {
        parts: [{type: 'text', text: 'Stop.'}],
      },
    );
    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('explicit pause');

    // The human's turn completes; TWO idles pass — the goal stays dead.
    const api2 = makeMockSessionApi([
      {
        role: 'assistant',
        id: 'm1',
        parts: [{type: 'text', text: 'understood, halting'}],
      },
    ]);
    const hooks2 = createHooks(makeDeps(session, api2));
    await hooks2.event!({
      type: 'session.idle',
      sessionID: 'session-stop',
      id: 'idle-stop-1',
    });
    await hooks2.event!({
      type: 'session.idle',
      sessionID: 'session-stop',
      id: 'idle-stop-2',
    });
    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('explicit pause');
  });

  test("a long mixed sentence containing 'stop' remains re-armable steering", async () => {
    const goal = createGoalState('session-steer', 'Fix the server', {
      minDelayMs: 0,
      goalId: 'goal-steer',
      runId: 'run-steer',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const hooks = createHooks(makeDeps(session, makeMockSessionApi()));

    await hooks['chat.message']!(
      {sessionID: 'session-steer'},
      {
        parts: [
          {
            type: 'text',
            text: 'stop the server first, then continue fixing the flaky tests',
          },
        ],
      },
    );
    expect(machine.snapshot().stopReason).toBe('user intervention');

    const api2 = makeMockSessionApi([
      {
        role: 'assistant',
        id: 'm1',
        parts: [{type: 'text', text: 'server stopped'}],
      },
    ]);
    const hooks2 = createHooks(makeDeps(session, api2));
    await hooks2.event!({
      type: 'session.idle',
      sessionID: 'session-steer',
      id: 'idle-steer-rearm',
    });
    expect(machine.snapshot().status).toBe('active');
  });

  test('isExplicitStopMessage normalizes punctuation and case, rejects mixed content', () => {
    expect(isExplicitStopMessage('STOP')).toBe(true);
    expect(isExplicitStopMessage('stand down.')).toBe(true);
    expect(isExplicitStopMessage('hold off')).toBe(true);
    expect(isExplicitStopMessage('wait')).toBe(true);
    expect(isExplicitStopMessage('stopping now would lose the work')).toBe(
      false,
    );
    expect(isExplicitStopMessage('please stop')).toBe(false);
  });
});

// Stable-state add: pre-existing assistant turn must NOT block kickoff

describe('stable-state add (user2026-08-25): kickoff ignores PRE-DISPATCH assistant history', () => {
  test("last message is the agent's OLD turn -> kickoff still fires", async () => {
    const dir = tmpdir();
    try {
      // Stable session: the previous conversation ended with an assistant turn.
      const {client, prompts, waitForPrompt} = recordingClient({
        messages: [
          {role: 'user', id: 'm1', parts: []},
          {role: 'assistant', id: 'm-old', parts: []},
        ],
      });
      const hooks = (await GoalsPlugin(
        {client, directory: dir},
        {persistState: false, kickoffDelayMs: 10, sdkShape: 'flat' as const},
      )) as unknown as Record<string, unknown>;
      const handler = hooks['command.execute.before'] as
        | ((
            input: {sessionID: string; command: string; arguments: string},
            output: {
              parts: unknown[];
            },
          ) => Promise<void>)
        | undefined;

      await handler!(
        {
          sessionID: 'sess-stable',
          command: 'goal',
          arguments: 'add write the report',
        },
        {parts: [] as unknown[]},
      );
      const kickoff = await waitForPrompt();
      expect(prompts.length).toBe(1);
      const parts = kickoff['parts'] as Array<{
        metadata?: {'fixate-on'?: {kind?: string}};
      }>;
      expect(parts?.[0]?.metadata?.['fixate-on']?.kind).toBe('kickoff');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('a NEW assistant message appears after dispatch -> kickoff suppressed (agent owns drive)', async () => {
    const dir = tmpdir();
    try {
      const {client, prompts, setMessages, waitForPrompt} = recordingClient({
        messages: [
          {role: 'assistant', id: 'm-old', parts: [], time: {created: 1000}},
        ],
      });
      const hooks = (await GoalsPlugin(
        {client, directory: dir},
        {persistState: false, kickoffDelayMs: 30, sdkShape: 'flat' as const},
      )) as unknown as Record<string, unknown>;
      const handler = hooks['command.execute.before'] as
        | ((
            input: {sessionID: string; command: string; arguments: string},
            output: {
              parts: unknown[];
            },
          ) => Promise<void>)
        | undefined;

      await handler!(
        {
          sessionID: 'sess-race',
          command: 'goal',
          arguments: 'add write the report',
        },
        {parts: [] as unknown[]},
      );
      // An agent turn lands BEFORE the probe fires. Timestamps are what
      // identify the newest record: the two host generations return
      // session.messages in OPPOSITE orders (v2 store defaults to "desc",
      // stock v1 1.18.32 was measured returning oldest-first), so a fixture
      // that relies on array position alone would encode one host's order as
      // the contract. This list is deliberately in DESCENDING order to show
      // the guard no longer depends on position.
      setMessages([
        {role: 'assistant', id: 'm-new', parts: [], time: {created: 3000}},
        {role: 'user', id: 'm-cmd', parts: [], time: {created: 2000}},
        {role: 'assistant', id: 'm-old', parts: [], time: {created: 1000}},
      ]);
      const own = await promptsAfterKickoffDeadline(
        hooks,
        'sess-race',
        prompts,
        waitForPrompt,
      );
      expect(own).toHaveLength(0);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

// v1 companion modals must close on confirm

describe('palette modal close (user2026-08-25)', () => {
  test('v1 Add/Edit/Checkpoint/Sequence/Focus handlers call dialog.clear() before dispatch', async () => {
    const src = await fs.promises.readFile(
      new URL('../src/tui.ts', import.meta.url),
      'utf8',
    );
    // Every DialogPrompt onConfirm / DialogSelect onSelect that dispatches a
    // goal command MUST clear the low-level replace modal first. The v2
    // companion uses the host's auto-closing prompt/select promises and
    // needs no such call — assert its absence there is untouched.
    const promptBlocks = src.split('DialogPrompt').length - 1;
    expect(promptBlocks).toBeGreaterThanOrEqual(4);
    const selectBlocks = src.split('DialogSelect').length - 1;
    expect(selectBlocks).toBeGreaterThanOrEqual(1);
    //: palette edit/checkpoint resolve their goal BEFORE the prompt
    // opens and dispatch `edit <goalId> <objective>` — the template carries
    // the id the prompt was opened for. That dispatch sits inside the
    // prompt's onConfirm (which clears first), so the stranded-modal
    // assertion searches a wider window for those two.
    const addIdx = src.indexOf('void sendGoalCommand(`add ${objective}`)');
    expect(addIdx).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, addIdx - 120), addIdx)).toContain(
      'api.ui.dialog.clear()',
    );
    const seqIdx = src.indexOf('void sendGoalCommand(`sequence ${text}`)');
    expect(seqIdx).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, seqIdx - 120), seqIdx)).toContain(
      'api.ui.dialog.clear()',
    );
    for (const cmd of [
      'edit ${goalId} ${objective}',
      'checkpoint ${goalId} ${summary}',
    ]) {
      const idx = src.indexOf(`void sendGoalCommand(\`${cmd}\`)`);
      expect(idx).toBeGreaterThan(-1);
      // The clear that closes the prompt lives at the TOP of the onConfirm
      // (before the empty-objective early return), not adjacent to dispatch.
      const handlerStart = src.lastIndexOf('onConfirm:', idx);
      expect(handlerStart).toBeGreaterThan(-1);
      expect(src.slice(handlerStart, idx)).toContain('api.ui.dialog.clear()');
    }
    const focusIdx = src.indexOf(
      'void sendGoalCommand(`focus ${option.value}`)',
    );
    expect(src.slice(Math.max(0, focusIdx - 120), focusIdx)).toContain(
      'api.ui.dialog.clear()',
    );
    // v2 dispatch actions use the host promise API (prompt/select auto-close),
    // but the cockpit dashboard is a custom dialog.show surface with no
    // auto-dismiss: exactly ONE manual dialog.clear is permitted, and it
    // must live on the dashboard close path — never on a dispatch path.
    const v2 = await fs.promises.readFile(
      new URL('../src/tui-v2.ts', import.meta.url),
      'utf8',
    );
    expect(v2.split('dialog.clear').length - 1).toBe(1);
    const v2ClearIdx = v2.indexOf('context.ui.dialog.clear()');
    expect(v2ClearIdx).toBeGreaterThan(-1);
    expect(v2.slice(Math.max(0, v2ClearIdx - 400), v2ClearIdx)).toContain(
      'dashboardOpen = false',
    );
  });
});

// M1 fix: defer classification bounded; failures stay failures

describe('isDeferError bounded + deferrals braked', () => {
  test('permanent-failure phrasings are NOT defers even when containing busy words', async () => {
    const {isDeferError} = await import('../src/hooks.ts');
    expect(isDeferError({message: "Model 'x' is not active"})).toBe(false);
    expect(isDeferError({message: 'account inactive'})).toBe(false);
    expect(isDeferError({message: 'unauthorized'})).toBe(false);
    expect(isDeferError({message: 'session is busy, retry later'})).toBe(true);
    expect(isDeferError(undefined)).toBe(false);
  });

  test('a busy defer does not consume the turn budget and is surfaced in lastStatus', async () => {
    const goal = createGoalState('session-defer', 'Busy host drill', {
      minDelayMs: 0,
      goalId: 'goal-defer',
      runId: 'run-defer',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const turnsBefore = machine.snapshot().turnCount;
    const busyApi = makeMockSessionApi();
    (
      busyApi as {
        promptAsync: (
          s: string,
          i: unknown,
        ) => Promise<{error?: {name: string; message: string}}>;
      }
    ).promptAsync = async () => ({
      error: {name: 'Error', message: 'session is busy'},
    });
    const hooks = createHooks(makeDeps(session, busyApi));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-defer',
      id: 'idle-defer-1',
    });

    const snap = machine.snapshot();
    expect(snap.status).toBe('active');
    expect(snap.turnCount).toBe(turnsBefore);
    expect(snap.lastStatus).toContain('Deferred');
  });

  test('consecutive busy-deferrals past maxPromptFailures pause the goal (no livelock)', async () => {
    const goal = createGoalState('session-defer2', 'Permanently busy host', {
      minDelayMs: 0,
      goalId: 'goal-defer2',
      runId: 'run-defer2',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const busyApi = makeMockSessionApi();
    (
      busyApi as {
        promptAsync: (
          s: string,
          i: unknown,
        ) => Promise<{error?: {name: string; message: string}}>;
      }
    ).promptAsync = async () => ({
      error: {name: 'Error', message: 'session is busy'},
    });
    const hooks = createHooks(makeDeps(session, busyApi));

    for (let i = 0; i < 3; i++) {
      await hooks.event!({
        type: 'session.idle',
        sessionID: 'session-defer2',
        id: `idle-defer2-${i}`,
      });
    }

    const snap = machine.snapshot();
    expect(snap.status).toBe('paused');
    // POL-2: busy-deferrals are not prompt failures — the persisted reason
    // must say what actually happened.
    expect(snap.stopReason).toBe('deferred too many times');
  });

  test("'not active' errors count as real failures (promptFailures), never deferred", async () => {
    const goal = createGoalState('session-notact', 'Dead provider drill', {
      minDelayMs: 0,
      goalId: 'goal-notact',
      runId: 'run-notact',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const deadApi = makeMockSessionApi();
    (
      deadApi as unknown as {
        promptAsync: (s: string, i: unknown) => Promise<never>;
      }
    ).promptAsync = async () => {
      throw new Error("Model 'x' is not active");
    };
    const hooks = createHooks(makeDeps(session, deadApi));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-notact',
      id: 'idle-notact-1',
    });

    expect(machine.snapshot().promptFailures).toBe(1);
    expect(machine.snapshot().status).toBe('active');
  });
});

// SESSION-GOAL-BINDING-1: a goal whose OWNING session is gone
//
// The acceptance requires that "unsupported APIs produce an explicit visible
// result rather than a false success". The owning session vanishing is the
// case that actually happens: the host deletes the session and every
// continuation addressed to it then fails permanently.
//
// MEASURED against stock v1 (1.18.32) with the session deleted first:
// `POST /session/<id>/prompt_async` answers HTTP 404 with
// `{"name":"NotFoundError","data":{"message":"Session not found: ses_…"}}`,
// and the SDK RETURNS that as `{ error }` rather than throwing (its generated
// client only throws when `throwOnError` is set, which the adapter does not
// set) — so it lands in the `response.error` branch, not the `catch`.

describe('a goal whose owning session is gone', () => {
  test('isSessionGoneError recognises the measured v1 not-found shape', async () => {
    const {isSessionGoneError} = await import('../src/hooks.ts');
    // The exact shape measured from stock v1.
    expect(
      isSessionGoneError({
        name: 'NotFoundError',
        message: 'Session not found: ses_abc',
      }),
    ).toBe(true);
    // Name-only, and message-only, both classify.
    expect(isSessionGoneError({name: 'NotFoundError'})).toBe(true);
    expect(isSessionGoneError({message: 'Session not found'})).toBe(true);
    expect(isSessionGoneError({message: 'session no longer exists'})).toBe(
      true,
    );
    expect(isSessionGoneError({message: 'session deleted'})).toBe(true);
    // Transient/other failures must NOT be classified as a vanished session.
    expect(isSessionGoneError(undefined)).toBe(false);
    expect(
      isSessionGoneError({name: 'Error', message: 'session is busy'}),
    ).toBe(false);
    expect(
      isSessionGoneError({name: 'Error', message: 'rate limit exceeded'}),
    ).toBe(false);
    expect(
      isSessionGoneError({name: 'Error', message: 'message not found'}),
    ).toBe(false);
  });

  test('a vanished session pauses with a reason that NAMES the cause', async () => {
    const goal = createGoalState('session-gone', 'Orphaned goal drill', {
      minDelayMs: 0,
      goalId: 'goal-gone',
      runId: 'run-gone',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const goneApi = makeMockSessionApi();
    (
      goneApi as unknown as {
        promptAsync: (
          s: string,
          i: unknown,
        ) => Promise<{error: {name: string; message: string}}>;
      }
    ).promptAsync = async () => ({
      error: {name: 'NotFoundError', message: 'Session not found: ses_abc'},
    });
    const hooks = createHooks(makeDeps(session, goneApi));

    for (let i = 0; i < 3; i++) {
      await hooks.event!({
        type: 'session.idle',
        sessionID: 'session-gone',
        id: `idle-gone-${i}`,
      });
    }

    const snap = machine.snapshot();
    expect(snap.status).toBe('paused');
    // The reason must name the CAUSE. The generic "auto-continue failures"
    // reads as a transient model error and sends a user hunting the provider
    // when the real problem is that their session was deleted.
    expect(snap.stopReason).toBe('session not found');
    expect(snap.lastStatus).toContain('session no longer exists');
    expect(snap.lastStatus).not.toContain('auto-continue failures');
  });

  test('a TRANSIENT failure keeps the generic reason (the triage is surgical)', async () => {
    // The contrast that shows the change is scoped: a rate limit must not be
    // reported as a vanished session, or the new wording would be worse than
    // the old — it would blame the user's session for a provider hiccup.
    const goal = createGoalState(
      'session-transient',
      'Transient failure drill',
      {
        minDelayMs: 0,
        goalId: 'goal-transient',
        runId: 'run-transient',
        maxTokens: 200000,
        maxTurns: 25,
        tokenBudget: 50000,
      },
    );
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const flakyApi = makeMockSessionApi();
    (
      flakyApi as unknown as {
        promptAsync: (
          s: string,
          i: unknown,
        ) => Promise<{error: {name: string; message: string}}>;
      }
    ).promptAsync = async () => ({
      error: {name: 'Error', message: 'rate limit exceeded'},
    });
    const hooks = createHooks(makeDeps(session, flakyApi));

    for (let i = 0; i < 3; i++) {
      await hooks.event!({
        type: 'session.idle',
        sessionID: 'session-transient',
        id: `idle-transient-${i}`,
      });
    }

    const snap = machine.snapshot();
    expect(snap.status).toBe('paused');
    expect(snap.stopReason).toBe('auto-continue failures');
    expect(snap.lastStatus).not.toContain('no longer exists');
  });

  test('a vanished session is a FAILURE, never a busy-deferral', async () => {
    // A not-found must not be deferred: deferrals are for a host that is
    // temporarily busy, and deferring a deleted session would retry forever.
    const goal = createGoalState('session-gone2', 'Orphaned goal drill 2', {
      minDelayMs: 0,
      goalId: 'goal-gone2',
      runId: 'run-gone2',
      maxTokens: 200000,
      maxTurns: 25,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(
      {...goal, usage: makeUsage()},
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext(machine);
    const goneApi = makeMockSessionApi();
    (
      goneApi as unknown as {
        promptAsync: (
          s: string,
          i: unknown,
        ) => Promise<{error: {name: string; message: string}}>;
      }
    ).promptAsync = async () => ({
      error: {name: 'NotFoundError', message: 'Session not found: ses_abc'},
    });
    const hooks = createHooks(makeDeps(session, goneApi));

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-gone2',
      id: 'idle-gone2-0',
    });

    const snap = machine.snapshot();
    expect(snap.promptFailures).toBe(1);
    expect(snap.status).toBe('active');
    expect(snap.lastStatus).not.toContain('Deferred');
  });
});
