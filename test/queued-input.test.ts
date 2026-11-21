// queued-input.test.ts — FX-K locks: a message sent to the session WITHOUT
// interrupting the running turn (inbox delivery "queue") must not yield the goal,
// and the user must be notified. Only interrupting ("steer") human input pauses
// with 'user intervention' — the existing intervention tests remain the contract.
//
// Host evidence: OpenCode (1.x and 2.x through v2.2.5) keeps the delivery mode on
// the session inbox (packages/schema/src/session-inbox.ts: Delivery = "steer" |
// "queue"); a steer wakes execution mid-turn, a queue waits for the turn boundary.
// On 2.x the mode is observable via session.inbox.enqueued (item.delivery) /
// session.inbox.delivery.changed (delivery) on released builds through v2.2.5, and
// via session.input.admitted (input.delivery) / session.input.queued|steered on
// newer hosts. The persisted message Info carries no delivery field, so the plugin
// records the mode from those events (hooks-handlers.ts / plugin-v2.ts) and also
// honors a structural `delivery` on the message itself.
import {describe, expect, test} from 'bun:test';
import {
  createHooks,
  type HookDeps,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {createRuntimeState} from '../src/session-state-manager.ts';
import type {GoalState} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {getMessageDelivery} from '../src/message-helpers.ts';
import {
  recordEventInputDelivery,
  recordInputDelivery,
} from '../src/session-runtime.ts';

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

function makeActiveGoal(sessionID = 'session-1'): GoalState {
  const goal = createGoalState(sessionID, 'Build the feature', {
    goalId: 'goal-1',
    runId: 'run-1',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {...goal, usage: makeUsage(), status: 'active', turnCount: 1};
}

function makeSessionContext(machine: GoalStateMachine): SessionContext {
  return {
    sessionID: machine.state.sessionID,
    getMachine: () => machine,
    listMachines: () => [machine],
    listActiveGoals: () => [machine.snapshot()],
    listArchivedResults: () => [],
    createGoal: () => machine,
    replaceGoals: async () => machine,
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: true as const, machine}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    setPendingIntent: () => {},
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
}

function makeMockSessionApi(
  messages: unknown[] = [],
): SessionApi & {promptsSent: Array<{text: string}>} {
  const promptsSent: Array<{text: string}> = [];
  return {
    messages: async () => messages,
    promptAsync: async (_sessionID: string, input: {parts: unknown[]}) => {
      promptsSent.push({text: (input.parts[0] as {text?: string})?.text ?? ''});
      return {};
    },
    promptsSent,
  } as SessionApi & {promptsSent: Array<{text: string}>};
}

function makeDeps(
  session: SessionContext,
  sessionApi: SessionApi,
  announcements: string[] = [],
): HookDeps {
  const runtime = createRuntimeState();
  runtime.threadToolsRegistered = true;
  runtime.promptInFlightSessions = new Set<string>();
  runtime.liveSessions.add(session.sessionID);
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi,
    logError: async () => {},
    completionGate: null,
    announceGoalDecision: async (_sessionID: string, text: string) => {
      announcements.push(text);
    },
    runtime,
  } as unknown as HookDeps;
}

async function driveIdle(hooks: ReturnType<typeof createHooks>) {
  await hooks.event!({
    type: 'session.idle',
    sessionID: 'session-1',
    id: `idle-${Math.random().toString(36).slice(2)}`,
  });
}

describe('getMessageDelivery structural reader', () => {
  test('reads steer/queue from top-level, info, inbox, and pending placements', () => {
    expect(getMessageDelivery({delivery: 'queue'})).toBe('queue');
    expect(getMessageDelivery({info: {delivery: 'steer'}})).toBe('steer');
    expect(getMessageDelivery({inbox: {delivery: 'queue'}})).toBe('queue');
    expect(getMessageDelivery({pending: {delivery: 'steer'}})).toBe('steer');
    expect(getMessageDelivery({delivery: 'bogus'})).toBeUndefined();
    expect(getMessageDelivery({})).toBeUndefined();
    expect(getMessageDelivery(null)).toBeUndefined();
  });
});

describe('event recording: inbox and queued input lands in runtime delivery sets', () => {
  test('recordEventInputDelivery maps admitted/inbox event shapes to delivery sets', () => {
    const runtime = createRuntimeState();
    // v2.2.5 released shape: session.inbox.enqueued {sessionID, inboxID, item:{delivery}}
    recordEventInputDelivery(
      runtime,
      {
        sessionID: 's1',
        inboxID: 'msg_q1',
        item: {type: 'user', payload: {text: 'queued note'}, delivery: 'queue'},
      },
      'session.inbox.enqueued',
    );
    // newer host shape: session.input.admitted {sessionID, inputID, input:{delivery}}
    recordEventInputDelivery(
      runtime,
      {
        sessionID: 's1',
        inputID: 'msg_s1',
        input: {type: 'user', delivery: 'steer', data: {text: 'stop'}},
      },
      'session.input.admitted',
    );
    // delivery.changed moves the id across sets
    recordEventInputDelivery(
      runtime,
      {sessionID: 's1', inboxID: 'msg_q1', delivery: 'steer'},
      'session.inbox.delivery.changed',
    );
    expect(runtime.queuedInputMessageIDs.get('s1')?.has('msg_q1')).toBe(false);
    expect(runtime.steeredInputMessageIDs.get('s1')?.has('msg_q1')).toBe(true);
    expect(runtime.steeredInputMessageIDs.get('s1')?.has('msg_s1')).toBe(true);
    // no session id anywhere -> no record
    recordEventInputDelivery(
      runtime,
      {inboxID: 'msg_x', item: {delivery: 'queue'}},
      'session.inbox.enqueued',
    );
    expect(runtime.queuedInputMessageIDs.get('s1')?.has('msg_x')).toBe(false);
  });

  test('shared helper: caller-known sessionID fallback, valid-value precedence, implied modes', () => {
    const runtime = createRuntimeState();
    // payload carries no sessionID, but the caller knows it
    recordEventInputDelivery(
      runtime,
      {inputID: 'msg_f', input: {delivery: 'queue'}},
      'session.input.admitted',
      's9',
    );
    expect(runtime.queuedInputMessageIDs.get('s9')?.has('msg_f')).toBe(true);
    // empty-string id must not win over a later valid fallback
    recordEventInputDelivery(
      runtime,
      {inputID: '', inboxID: 'msg_g', delivery: 'steer'},
      'session.inbox.enqueued',
      's9',
    );
    expect(runtime.steeredInputMessageIDs.get('s9')?.has('msg_g')).toBe(true);
    expect(runtime.steeredInputMessageIDs.get('s9')?.has('')).toBe(false);
    // invalid delivery strings are skipped in favour of a later valid one
    recordEventInputDelivery(
      runtime,
      {inboxID: 'msg_h', item: {delivery: 'bogus'}, delivery: 'queue'},
      'session.inbox.enqueued',
      's9',
    );
    expect(runtime.queuedInputMessageIDs.get('s9')?.has('msg_h')).toBe(true);
    // session.input.queued implies the mode with no delivery field at all
    recordEventInputDelivery(
      runtime,
      {inputID: 'msg_i'},
      'session.input.queued',
      's9',
    );
    expect(runtime.queuedInputMessageIDs.get('s9')?.has('msg_i')).toBe(true);
    // direct helper: cross-set move and cap behaviour
    recordInputDelivery(runtime, 's9', 'msg_j', 'queue');
    recordInputDelivery(runtime, 's9', 'msg_j', 'steer');
    expect(runtime.steeredInputMessageIDs.get('s9')?.has('msg_j')).toBe(true);
    expect(runtime.queuedInputMessageIDs.get('s9')?.has('msg_j')).toBe(false);
    recordInputDelivery(runtime, 's9', 'msg_j', 'bogus');
    expect(runtime.steeredInputMessageIDs.get('s9')?.has('msg_j')).toBe(true);
  });

  test('clearSessionOwned prunes every per-session delivery-tracking key', async () => {
    const {clearSessionOwned} = await import('../src/session-lifecycle.ts');
    const runtime = createRuntimeState();
    recordInputDelivery(runtime, 's-clear', 'msg_q', 'queue');
    recordInputDelivery(runtime, 's-clear', 'msg_s', 'steer');
    runtime.surfacedQueuedMessageIDs.get('s-clear')?.add('msg_q');
    // An unrelated session's keys must survive the clear.
    recordInputDelivery(runtime, 's-other', 'msg_keep', 'queue');

    const persistedState = {
      goals: [],
      sessionOrdered: [],
      archived: [],
      proposals: [],
    };
    const mgr = {
      runtime,
      persistedState,
      persistFn: async () => true,
      stateRoot: '/nonexistent',
      persistEnabled: false,
      ledgerMaxBytes: 0,
      ledgerRetentionFiles: 0,
      maxArchived: 0,
      resultRetentionMs: 0,
      defaultOpts: {},
      logError: async () => {},
      pendingWalWrite: null,
      pendingCreateIds: new Set<string>(),
      invalidatedBySession: new Map(),
      pendingInvalidationCheckpoints: new Set<string>(),
      clearingSessions: new Set<string>(),
      broadcaster: null,
      withSessionLifecycle: async (_id: string, op: () => Promise<unknown>) =>
        op(),
      getMachine: () => null,
      createOnCommit: () => async () => {},
      createOnUsageUpdate: () => undefined,
      writeWalEntry: async () => {},
      drainWalWrites: async () => {},
      persist: async () => true,
      addInvalidation: () => {},
    };
    await clearSessionOwned(
      mgr as unknown as Parameters<typeof clearSessionOwned>[0],
      's-clear',
    );
    expect(runtime.queuedInputMessageIDs.has('s-clear')).toBe(false);
    expect(runtime.steeredInputMessageIDs.has('s-clear')).toBe(false);
    expect(runtime.surfacedQueuedMessageIDs.has('s-clear')).toBe(false);
    expect(runtime.queuedInputMessageIDs.get('s-other')?.has('msg_keep')).toBe(
      true,
    );
  });
});

describe('idle path: queued input does not yield the goal and notifies the user', () => {
  test('message annotated delivery queue after the last assistant message keeps the goal active and announces', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const announcements: string[] = [];
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'note from another agent: use module B'}],
      },
    ]);
    const hooks = createHooks(
      makeDeps(makeSessionContext(machine), api, announcements),
    );

    await driveIdle(hooks);

    expect(machine.snapshot().status).toBe('active');
    expect(machine.snapshot().stopReason).not.toBe('user intervention');
    // The loop continued (a continuation prompt was sent) instead of pausing.
    expect(api.promptsSent.length).toBeGreaterThan(0);
    // The user was notified through the announce channel.
    expect(announcements.length).toBe(1);
    expect(announcements[0]).toContain('queued');
    // The notice was delivered into the continuation prompt (buildContinueMessage
    // renders pendingNotices, then the continue branch clears them), so the
    // announce text carrying the queued text is the durable user-visible record.
    expect(announcements[0]).toContain('note from another agent');
  });

  test('queued id recorded via runtime event (no inline annotation) also keeps the goal active', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const announcements: string[] = [];
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        parts: [{type: 'text', text: 'queued via event'}],
      },
    ]);
    const deps = makeDeps(makeSessionContext(machine), api, announcements);
    deps.runtime!.queuedInputMessageIDs.set('session-1', new Set(['m2']));
    const hooks = createHooks(deps);

    await driveIdle(hooks);

    expect(machine.snapshot().status).toBe('active');
    expect(machine.snapshot().stopReason).not.toBe('user intervention');
    expect(api.promptsSent.length).toBeGreaterThan(0);
    expect(announcements.length).toBe(1);
  });

  test('steer-annotated message after the last assistant message still pauses as user intervention', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        delivery: 'steer',
        parts: [{type: 'text', text: 'change course now'}],
      },
    ]);
    const hooks = createHooks(makeDeps(makeSessionContext(machine), api));

    await driveIdle(hooks);

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');
    expect(api.promptsSent).toHaveLength(0);
  });

  test('steer id recorded via runtime event still pauses as user intervention', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        parts: [{type: 'text', text: 'interrupt please'}],
      },
    ]);
    const deps = makeDeps(makeSessionContext(machine), api);
    deps.runtime!.steeredInputMessageIDs.set('session-1', new Set(['m2']));
    const hooks = createHooks(deps);

    await driveIdle(hooks);

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');
    expect(api.promptsSent).toHaveLength(0);
  });

  test('delivery-less user message after the last assistant message still pauses (v1 behavior preserved)', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {id: 'm2', role: 'user', parts: [{type: 'text', text: 'hello there'}]},
    ]);
    const hooks = createHooks(makeDeps(makeSessionContext(machine), api));

    await driveIdle(hooks);

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');
  });

  test('queued message is skipped over: a delivery-less message behind it still wins (pauses)', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'queued note'}],
      },
      {
        id: 'm3',
        role: 'user',
        parts: [{type: 'text', text: 'change course now'}],
      },
    ]);
    const announcements: string[] = [];
    const hooks = createHooks(
      makeDeps(makeSessionContext(machine), api, announcements),
    );

    await driveIdle(hooks);

    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe('user intervention');
    // The queued message ahead of it was still surfaced to the user before the
    // pause: the notice rides the goal's notice channel into the pause detail.
    expect(
      machine.snapshot().history.some(h => h.detail.includes('queued note')),
    ).toBe(true);
    // The announce must not claim the goal keeps running when an interrupting
    // message is also present — that would be a false, user-visible statement.
    expect(announcements.some(a => a.includes('the goal keeps running'))).toBe(
      false,
    );
  });

  test('a repeated idle over the same queued message does not re-notice or re-announce', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const announcements: string[] = [];
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'queued note once'}],
      },
    ]);
    const deps = makeDeps(makeSessionContext(machine), api, announcements);
    const hooks = createHooks(deps);

    await driveIdle(hooks);
    await driveIdle(hooks);
    await driveIdle(hooks);

    const noticeEntries = machine
      .snapshot()
      .history.filter(
        h => h.type === 'notice' && h.detail.includes('queued note once'),
      );
    expect(noticeEntries).toHaveLength(1);
    expect(announcements).toHaveLength(1);
    expect(
      deps.runtime!.surfacedQueuedMessageIDs.get('session-1')?.has('m2'),
    ).toBe(true);
  });

  test('ID-less queued messages are deduped by text across repeated idles', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const announcements: string[] = [];
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'queued without an id'}],
      },
    ]);
    const deps = makeDeps(makeSessionContext(machine), api, announcements);
    const hooks = createHooks(deps);

    await driveIdle(hooks);
    await driveIdle(hooks);
    await driveIdle(hooks);

    const noticeEntries = machine
      .snapshot()
      .history.filter(h => h.detail.includes('queued without an id'));
    expect(noticeEntries).toHaveLength(1);
    expect(
      announcements.filter(a => a.includes('queued without an id')),
    ).toHaveLength(1);
  });

  test('an older user message before the assistant message is outside the scan window', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const announcements: string[] = [];
    const api = makeMockSessionApi([
      {
        id: 'u0',
        role: 'user',
        parts: [{type: 'text', text: 'original request'}],
      },
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'queued note'}],
      },
    ]);
    const hooks = createHooks(
      makeDeps(makeSessionContext(machine), api, announcements),
    );

    await driveIdle(hooks);

    // The assistant-role break must stop the scan before u0: no intervention,
    // no notice about the original request, goal keeps running.
    expect(machine.snapshot().status).toBe('active');
    expect(machine.snapshot().stopReason).not.toBe('user intervention');
    expect(
      machine
        .snapshot()
        .history.some(h => h.detail.includes('original request')),
    ).toBe(false);
    expect(announcements.some(a => a.includes('original request'))).toBe(false);
  });

  test('multiple queued messages in one turn are all surfaced, oldest first', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const announcements: string[] = [];
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'first queued'}],
      },
      {
        id: 'm3',
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'second queued'}],
      },
    ]);
    const hooks = createHooks(
      makeDeps(makeSessionContext(machine), api, announcements),
    );

    await driveIdle(hooks);

    expect(machine.snapshot().status).toBe('active');
    const history = machine.snapshot().history;
    const noticeEntries = history.filter(
      h => h.type === 'notice' && h.detail.includes('Queued message'),
    );
    expect(noticeEntries).toHaveLength(1);
    const detail = noticeEntries[0]!.detail;
    expect(detail.indexOf('first queued')).toBeGreaterThanOrEqual(0);
    expect(detail.indexOf('first queued')).toBeLessThan(
      detail.indexOf('second queued'),
    );
    // one announce carrying both, in order
    expect(announcements).toHaveLength(1);
    expect(announcements[0]!.indexOf('first queued')).toBeLessThan(
      announcements[0]!.indexOf('second queued'),
    );
  });

  test('a delivery.changed to queue overrides a stale static steer annotation on the message', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'working'}]},
      {
        id: 'm2',
        role: 'user',
        delivery: 'steer', // stale inline annotation
        parts: [{type: 'text', text: 'queued after all'}],
      },
    ]);
    const deps = makeDeps(makeSessionContext(machine), api);
    // the host later reported this id changed to queue
    deps.runtime!.queuedInputMessageIDs.set('session-1', new Set(['m2']));
    deps.runtime!.steeredInputMessageIDs.set('session-1', new Set());
    const hooks = createHooks(deps);

    await driveIdle(hooks);

    expect(machine.snapshot().status).toBe('active');
    expect(machine.snapshot().stopReason).not.toBe('user intervention');
  });

  test('queued notice recording on a terminal machine does not throw', async () => {
    const goal = makeActiveGoal();
    goal.status = 'complete';
    const machine = new GoalStateMachine(goal, {onCommit: async () => {}});
    const api = makeMockSessionApi([
      {id: 'm1', role: 'assistant', parts: [{type: 'text', text: 'done'}]},
      {
        id: 'm2',
        role: 'user',
        delivery: 'queue',
        parts: [{type: 'text', text: 'late queued note'}],
      },
    ]);
    const hooks = createHooks(makeDeps(makeSessionContext(machine), api));
    // processIdleEvent returns early for terminal goals, so this must not throw.
    await driveIdle(hooks);
    expect(machine.isTerminal()).toBe(true);
  });
});

describe('event hook records inbox delivery from host events', () => {
  test('session.inbox.enqueued and delivery.changed feed the runtime sets through the event hook', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const deps = makeDeps(makeSessionContext(machine), makeMockSessionApi());
    const hooks = createHooks(deps);

    await hooks.event!({
      type: 'session.inbox.enqueued',
      sessionID: 'session-1',
      properties: {
        sessionID: 'session-1',
        inboxID: 'msg_q',
        item: {type: 'user', payload: {text: 'hi'}, delivery: 'queue'},
      },
    });
    await hooks.event!({
      type: 'session.inbox.delivery.changed',
      sessionID: 'session-1',
      properties: {
        sessionID: 'session-1',
        inboxID: 'msg_q',
        delivery: 'steer',
      },
    });
    await hooks.event!({
      type: 'session.input.queued',
      sessionID: 'session-1',
      properties: {sessionID: 'session-1', inputID: 'msg_q2'},
    });
    await hooks.event!({
      type: 'session.input.steered',
      sessionID: 'session-1',
      properties: {sessionID: 'session-1', inputID: 'msg_s2'},
    });

    expect(
      deps.runtime!.queuedInputMessageIDs.get('session-1')?.has('msg_q2'),
    ).toBe(true);
    expect(
      deps.runtime!.steeredInputMessageIDs.get('session-1')?.has('msg_q'),
    ).toBe(true);
    expect(
      deps.runtime!.queuedInputMessageIDs.get('session-1')?.has('msg_q'),
    ).toBe(false);
    expect(
      deps.runtime!.steeredInputMessageIDs.get('session-1')?.has('msg_s2'),
    ).toBe(true);
  });
});
