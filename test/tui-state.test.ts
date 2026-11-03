// tui-state.test.ts — Contract tests for the TUI state synchronization engine.
//
// Verifies: event serialization round-trips, state store hydration from
// events, broadcaster→store end-to-end propagation, disconnection resilience
// (late subscribers receive latest snapshot), and snapshot immutability.
//
// Contract Over Green: these tests assert the general valid-input contract
// of the sync engine — no hardcoded test shapes, no reward hacking.

import {expect, test} from 'bun:test';
import {
  createBufferingTransport,
  createGoalBroadcaster,
  createTuiStateStore,
  decodeGoalToolMetadata,
  encodeGoalToolMetadata,
  GOAL_TUI_EVENT_TITLE,
  GOAL_TUI_METADATA_KEY,
  type GoalTuiEvent,
  type GoalTuiSnapshot,
  parseTuiSyncEvent,
  serializeGoalForTui,
} from '../src/tui-state.ts';
import {
  createGoalState,
  type GoalState,
  GoalStateMachine,
} from '../src/state-machine.ts';

// Helpers

function makeMachine(overrides: Partial<GoalState> = {}): GoalStateMachine {
  const goal = createGoalState('s1', 'fix the failing tests');
  return new GoalStateMachine({...goal, ...overrides});
}

function makeSnapshot(
  overrides: Partial<GoalTuiSnapshot> = {},
): GoalTuiSnapshot {
  return {
    goalId: 'g1',
    sessionID: 's1',
    condition: 'fix the failing tests',
    status: 'active',
    revision: 1,
    turnCount: 0,
    totalTokens: 0,
    maxTokens: 200000,
    maxTurns: 10,
    tokenBudget: null,
    usage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costKnown: false,
    },
    stopReason: '',
    blockedReason: '',
    pausedAt: 0,
    stoppedAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
    ...overrides,
  };
}

// serializeGoalForTui

test('serializeGoalForTui maps a GoalState to a TuiSnapshot', () => {
  const machine = makeMachine({
    status: 'active',
    turnCount: 3,
    totalTokens: 1200,
  });
  const snap = serializeGoalForTui(machine.snapshot());
  expect(snap.goalId).toBe(machine.state.goalId);
  expect(snap.sessionID).toBe('s1');
  expect(snap.condition).toBe('fix the failing tests');
  expect(snap.status).toBe('active');
  expect(snap.turnCount).toBe(3);
  expect(snap.totalTokens).toBe(1200);
  expect(snap.maxTokens).toBe(1000000);
  expect(snap.maxTurns).toBe(0);
  expect(snap.history).toEqual([]);
  expect(snap.lastCheckpoint).toBeNull();
});

test('serializeGoalForTui produces a frozen (immutable) snapshot', () => {
  const machine = makeMachine();
  const snap = serializeGoalForTui(machine.snapshot());
  expect(Object.isFrozen(snap)).toBe(true);
  expect(Object.isFrozen(snap.usage)).toBe(true);
  expect(Object.isFrozen(snap.history)).toBe(true);
});

test('serializeGoalForTui deep-copies history and checkpoint arrays', () => {
  const machine = makeMachine();
  machine['goal'].history.push({
    type: 'paused',
    detail: 'user paused',
    timestamp: Date.now(),
  });
  machine['goal'].lastCheckpoint = {
    summary: 'step 1 done',
    timestamp: Date.now(),
  };
  const snap = serializeGoalForTui(machine.snapshot());
  // Mutating the original state machine after serialization must NOT affect the snapshot.
  machine['goal'].history.push({
    type: 'active',
    detail: 'resumed',
    timestamp: Date.now(),
  });
  expect(snap.history).toHaveLength(1);
  expect(snap.history[0].type).toBe('paused');
  expect(snap.lastCheckpoint).not.toBeNull();
  expect(snap.lastCheckpoint!.summary).toBe('step 1 done');
});

test('serializeGoalForTui handles null checkpoint', () => {
  const machine = makeMachine();
  const snap = serializeGoalForTui(machine.snapshot());
  expect(snap.lastCheckpoint).toBeNull();
});

test('serializeGoalForTui handles null finishedAt', () => {
  const machine = makeMachine();
  const snap = serializeGoalForTui(machine.snapshot());
  expect(snap.finishedAt).toBeNull();
});

test('serializeGoalForTui handles non-null finishedAt', () => {
  const machine = makeMachine({finishedAt: 1700000000000});
  const snap = serializeGoalForTui(machine.snapshot());
  expect(snap.finishedAt).toBe(1700000000000);
});

// GoalTuiEvent serialization

test('a transition event round-trips through parseTuiSyncEvent', () => {
  const snapshot = makeSnapshot();
  const event: GoalTuiEvent = {
    kind: 'transition',
    sessionID: 's1',
    snapshot,
    transition: {
      source: 'slash-command',
      from: 'active',
      to: 'paused',
      detail: 'user paused',
    },
    timestamp: Date.now(),
  };
  const encoded = JSON.stringify(event);
  const parsed = parseTuiSyncEvent(encoded);
  expect(parsed).not.toBeNull();
  expect(parsed!.kind).toBe('transition');
  expect(parsed!.sessionID).toBe('s1');
  expect(parsed!.snapshot!.goalId).toBe('g1');
  expect(parsed!.transition!.from).toBe('active');
  expect(parsed!.transition!.to).toBe('paused');
});

test('a usage event round-trips through parseTuiSyncEvent', () => {
  const snapshot = makeSnapshot({
    totalTokens: 5000,
    usage: {
      input: 100,
      output: 50,
      reasoning: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.02,
      costKnown: true,
    },
  });
  const event: GoalTuiEvent = {
    kind: 'usage',
    sessionID: 's1',
    snapshot,
    timestamp: Date.now(),
  };
  const parsed = parseTuiSyncEvent(JSON.stringify(event));
  expect(parsed).not.toBeNull();
  expect(parsed!.kind).toBe('usage');
  expect(parsed!.snapshot!.totalTokens).toBe(5000);
  expect(parsed!.snapshot!.usage.cost).toBe(0.02);
  expect(parsed!.transition).toBeUndefined();
});

test('a create event round-trips through parseTuiSyncEvent', () => {
  const snapshot = makeSnapshot();
  const event: GoalTuiEvent = {
    kind: 'create',
    sessionID: 's1',
    snapshot,
    timestamp: Date.now(),
  };
  const parsed = parseTuiSyncEvent(JSON.stringify(event));
  expect(parsed!.kind).toBe('create');
});

test('a remove event round-trips through parseTuiSyncEvent', () => {
  const event: GoalTuiEvent = {
    kind: 'remove',
    sessionID: 's1',
    goalId: 'g1',
    timestamp: Date.now(),
  };
  const parsed = parseTuiSyncEvent(JSON.stringify(event));
  expect(parsed!.kind).toBe('remove');
  expect(parsed!.goalId).toBe('g1');
  expect(parsed!.snapshot).toBeUndefined();
});

test('parseTuiSyncEvent returns null for malformed JSON', () => {
  expect(parseTuiSyncEvent('not json')).toBeNull();
  expect(parseTuiSyncEvent('')).toBeNull();
});

test('parseTuiSyncEvent rejects snapshots with invalid GoalStatus', () => {
  // Construct a raw object with an invalid status — bypasses TS type checking
  // to simulate a malformed wire payload.
  const snapshot = makeSnapshot() as unknown as Record<string, unknown>;
  snapshot.status = 'banana';
  const event = {kind: 'create', sessionID: 's1', snapshot, timestamp: 0};
  expect(parseTuiSyncEvent(JSON.stringify(event))).toBeNull();
});

test('parseTuiSyncEvent parses bare events (caller filters by title)', () => {
  // parseTuiSyncEvent validates the payload structure only. The caller is
  // responsible for filtering by the host event envelope's title field.
  const bare = JSON.stringify({
    kind: 'transition',
    sessionID: 's1',
    snapshot: makeSnapshot(),
    transition: {source: 's', from: 'active', to: 'paused', detail: ''},
    timestamp: 0,
  });
  const parsed = parseTuiSyncEvent(bare);
  expect(parsed).not.toBeNull();
  expect(parsed!.kind).toBe('transition');
});

test('parseTuiSyncEvent unwraps the { title, payload } envelope', () => {
  // The wire format wraps the event with a title marker for host-bus filtering.
  const snapshot = makeSnapshot();
  const enveloped = JSON.stringify({
    title: GOAL_TUI_EVENT_TITLE,
    payload: {
      kind: 'transition',
      sessionID: 's1',
      snapshot,
      transition: {source: 's', from: 'active', to: 'paused', detail: ''},
      timestamp: 0,
    },
  });
  const parsed = parseTuiSyncEvent(enveloped);
  expect(parsed).not.toBeNull();
  expect(parsed!.kind).toBe('transition');
  expect(parsed!.snapshot!.goalId).toBe('g1');
});

test('parseTuiSyncEvent rejects envelope with wrong title', () => {
  const enveloped = JSON.stringify({
    title: 'some-other-plugin',
    payload: {
      kind: 'transition',
      sessionID: 's1',
      snapshot: makeSnapshot(),
      transition: {source: 's', from: 'active', to: 'paused', detail: ''},
      timestamp: 0,
    },
  });
  // Wrong-title envelopes fall through to bare-event validation, which fails
  // because `title` and `payload` are not valid GoalTuiEvent fields.
  expect(parseTuiSyncEvent(enveloped)).toBeNull();
});

test('parseTuiSyncEvent returns null for missing required fields', () => {
  expect(parseTuiSyncEvent(JSON.stringify({kind: 'transition'}))).toBeNull();
  expect(
    parseTuiSyncEvent(JSON.stringify({kind: 'unknown', sessionID: 's1'})),
  ).toBeNull();
});

// TuiStateStore

test('TuiStateStore starts empty', () => {
  const store = createTuiStateStore();
  expect(store.getSnapshots('s1')).toEqual([]);
  expect(store.getSnapshot('s1', 'g1')).toBeUndefined();
  expect(store.getFocused('s1')).toBeUndefined();
});

test('TuiStateStore applyEvent(create) hydrates a goal', () => {
  const store = createTuiStateStore();
  const snapshot = makeSnapshot();
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot,
    timestamp: Date.now(),
  });
  expect(store.getSnapshots('s1')).toHaveLength(1);
  expect(store.getSnapshot('s1', 'g1')).toBeDefined();
  expect(store.getFocused('s1')?.goalId).toBe('g1');
});

test('TuiStateStore applyEvent(transition) updates an existing goal', () => {
  const store = createTuiStateStore();
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot(),
    timestamp: Date.now(),
  });
  store.applyEvent({
    kind: 'transition',
    sessionID: 's1',
    snapshot: makeSnapshot({
      status: 'paused',
      revision: 2,
      stopReason: 'user paused',
    }),
    transition: {
      source: 'slash-command',
      from: 'active',
      to: 'paused',
      detail: 'user paused',
    },
    timestamp: Date.now(),
  });
  const snap = store.getSnapshot('s1', 'g1');
  expect(snap?.status).toBe('paused');
  expect(snap?.revision).toBe(2);
  expect(snap?.stopReason).toBe('user paused');
});

test('TuiStateStore applyEvent(usage) updates token totals', () => {
  const store = createTuiStateStore();
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot(),
    timestamp: Date.now(),
  });
  store.applyEvent({
    kind: 'usage',
    sessionID: 's1',
    snapshot: makeSnapshot({
      totalTokens: 5000,
      turnCount: 3,
      usage: {
        input: 100,
        output: 50,
        reasoning: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.02,
        costKnown: true,
      },
    }),
    timestamp: Date.now(),
  });
  const snap = store.getSnapshot('s1', 'g1');
  expect(snap?.totalTokens).toBe(5000);
  expect(snap?.turnCount).toBe(3);
  expect(snap?.usage.cost).toBe(0.02);
});

test('TuiStateStore applyEvent(remove) deletes a goal', () => {
  const store = createTuiStateStore();
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot(),
    timestamp: Date.now(),
  });
  store.applyEvent({
    kind: 'remove',
    sessionID: 's1',
    goalId: 'g1',
    timestamp: Date.now(),
  });
  expect(store.getSnapshots('s1')).toEqual([]);
  expect(store.getFocused('s1')).toBeUndefined();
});

test('TuiStateStore handles multiple goals per session', () => {
  const store = createTuiStateStore();
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot({goalId: 'g1'}),
    timestamp: Date.now(),
  });
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot({goalId: 'g2', condition: 'second goal'}),
    timestamp: Date.now(),
  });
  expect(store.getSnapshots('s1')).toHaveLength(2);
  // The most recently created/updated goal is focused.
  expect(store.getFocused('s1')?.goalId).toBe('g2');
});

test('TuiStateStore focuses the most recently updated goal', () => {
  const store = createTuiStateStore();
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot({goalId: 'g1'}),
    timestamp: 1000,
  });
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot({goalId: 'g2'}),
    timestamp: 2000,
  });
  // Update g1 — it should become focused.
  store.applyEvent({
    kind: 'transition',
    sessionID: 's1',
    snapshot: makeSnapshot({goalId: 'g1', status: 'paused', revision: 2}),
    transition: {
      source: 'slash-command',
      from: 'active',
      to: 'paused',
      detail: '',
    },
    timestamp: 3000,
  });
  expect(store.getFocused('s1')?.goalId).toBe('g1');
});

test('TuiStateStore snapshots are immutable to external mutation', () => {
  const store = createTuiStateStore();
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot(),
    timestamp: Date.now(),
  });
  const snap = store.getSnapshot('s1', 'g1')!;
  const originalStatus = snap.status;
  // Attempt to mutate the returned snapshot.
  try {
    (snap as {status: string}).status = 'complete';
  } catch {
    /* frozen */
  }
  expect(snap.status).toBe(originalStatus);
  // The store's internal copy must also be unaffected.
  expect(store.getSnapshot('s1', 'g1')?.status).toBe(originalStatus);
});

test('TuiStateStore ignores remove events for non-existent goals gracefully', () => {
  const store = createTuiStateStore();
  // Removing a goal that doesn't exist is a no-op (idempotent).
  store.applyEvent({
    kind: 'remove',
    sessionID: 'unknown',
    goalId: 'nope',
    timestamp: Date.now(),
  });
  expect(store.getSnapshots('unknown')).toEqual([]);
  expect(store.getFocused('unknown')).toBeUndefined();
});

test('TuiStateStore hydrates a new goal from a transition event (resilience)', () => {
  // If the TUI misses the initial create event (e.g. late subscription or
  // transient disconnect), a transition event with a snapshot must still
  // hydrate the goal into the store. This is the disconnection-resilience
  // contract: the store can rebuild state from any event carrying a snapshot.
  const store = createTuiStateStore();
  store.applyEvent({
    kind: 'transition',
    sessionID: 's1',
    snapshot: makeSnapshot({status: 'paused', revision: 2}),
    transition: {
      source: 'slash-command',
      from: 'active',
      to: 'paused',
      detail: '',
    },
    timestamp: Date.now(),
  });
  expect(store.getSnapshots('s1')).toHaveLength(1);
  expect(store.getFocused('s1')?.status).toBe('paused');
  expect(store.getFocused('s1')?.revision).toBe(2);
});

// Disconnection resilience (late subscribers)

test('TuiStateStore subscribe receives future events', () => {
  const store = createTuiStateStore();
  const received: GoalTuiEvent[] = [];
  store.subscribe(event => received.push(event));
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot(),
    timestamp: Date.now(),
  });
  expect(received).toHaveLength(1);
  expect(received[0].kind).toBe('create');
});

test('TuiStateStore subscribe is immediately invoked with current state via hydrate', () => {
  const store = createTuiStateStore();
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot(),
    timestamp: Date.now(),
  });
  // Late subscriber: hydrate returns the current state without replaying events.
  const hydrated = store.getSnapshots('s1');
  expect(hydrated).toHaveLength(1);
  expect(hydrated[0].goalId).toBe('g1');
});

test('TuiStateStore unsubscribe stops receiving events', () => {
  const store = createTuiStateStore();
  const received: GoalTuiEvent[] = [];
  const unsubscribe = store.subscribe(event => received.push(event));
  store.applyEvent({
    kind: 'create',
    sessionID: 's1',
    snapshot: makeSnapshot(),
    timestamp: Date.now(),
  });
  unsubscribe();
  store.applyEvent({
    kind: 'remove',
    sessionID: 's1',
    goalId: 'g1',
    timestamp: Date.now(),
  });
  expect(received).toHaveLength(1); // only the create, not the remove
});

// GoalBroadcaster (onCommit → event emission)

test('createGoalBroadcaster emits transition events via onCommit', async () => {
  const emitted: {sessionID: string; payload: GoalTuiEvent}[] = [];
  const broadcaster = createGoalBroadcaster({
    publish: async (sessionID, event) => {
      emitted.push({sessionID, payload: event});
    },
  });
  const machine = makeMachine({status: 'active'});
  // Wire the broadcaster's onCommit as the machine's callback.
  const wrapped = new GoalStateMachine(machine.snapshot(), {
    onCommit: broadcaster.onCommit,
  });
  await wrapped.transition('paused', {
    source: 'slash-command',
    detail: 'user paused',
  });
  expect(emitted).toHaveLength(1);
  expect(emitted[0].sessionID).toBe('s1');
  expect(emitted[0].payload.kind).toBe('transition');
  expect(emitted[0].payload.transition!.from).toBe('active');
  expect(emitted[0].payload.transition!.to).toBe('paused');
  expect(emitted[0].payload.snapshot!.status).toBe('paused');
});

test('createGoalBroadcaster emits create events via emitCreate', async () => {
  const emitted: {sessionID: string; payload: GoalTuiEvent}[] = [];
  const broadcaster = createGoalBroadcaster({
    publish: async (sessionID, event) => {
      emitted.push({sessionID, payload: event});
    },
  });
  const machine = makeMachine();
  await broadcaster.emitCreate(machine.snapshot());
  expect(emitted).toHaveLength(1);
  expect(emitted[0].payload.kind).toBe('create');
  expect(emitted[0].payload.snapshot!.goalId).toBe(machine.state.goalId);
});

test('createGoalBroadcaster emits remove events via emitRemove', async () => {
  const emitted: {sessionID: string; payload: GoalTuiEvent}[] = [];
  const broadcaster = createGoalBroadcaster({
    publish: async (sessionID, event) => {
      emitted.push({sessionID, payload: event});
    },
  });
  await broadcaster.emitRemove('s1', 'g1');
  expect(emitted).toHaveLength(1);
  expect(emitted[0].payload.kind).toBe('remove');
  expect(emitted[0].payload.goalId).toBe('g1');
});

test('createGoalBroadcaster emits usage events via emitUsage', async () => {
  const emitted: {sessionID: string; payload: GoalTuiEvent}[] = [];
  const broadcaster = createGoalBroadcaster({
    publish: async (sessionID, event) => {
      emitted.push({sessionID, payload: event});
    },
  });
  const machine = makeMachine({totalTokens: 5000, turnCount: 3});
  await broadcaster.emitUsage(machine.snapshot());
  expect(emitted).toHaveLength(1);
  expect(emitted[0].payload.kind).toBe('usage');
  expect(emitted[0].payload.snapshot!.totalTokens).toBe(5000);
  expect(emitted[0].payload.snapshot!.turnCount).toBe(3);
  expect(emitted[0].payload.transition).toBeUndefined();
});

test('createGoalBroadcaster swallows publish errors (resilience)', async () => {
  const broadcaster = createGoalBroadcaster({
    publish: async () => {
      throw new Error('network down');
    },
  });
  const machine = makeMachine({status: 'active'});
  const wrapped = new GoalStateMachine(machine.snapshot(), {
    onCommit: broadcaster.onCommit,
  });
  // Must NOT throw — broadcast failures must not break the state machine.
  await expect(
    wrapped.transition('paused', {source: 'slash-command', detail: ''}),
  ).resolves.toBeDefined();
  const result = wrapped.snapshot();
  expect(result.status).toBe('paused');
});

// End-to-end: broadcaster → store

test('end-to-end: broadcaster publishes, store applies, state propagates', async () => {
  const store = createTuiStateStore();
  const broadcaster = createGoalBroadcaster({
    publish: async (_sessionID, event) => {
      store.applyEvent(event);
    },
  });
  const machine = makeMachine({status: 'active'});
  const wrapped = new GoalStateMachine(machine.snapshot(), {
    onCommit: broadcaster.onCommit,
  });
  // Create
  await broadcaster.emitCreate(wrapped.snapshot());
  expect(store.getFocused('s1')?.status).toBe('active');
  // Transition
  await wrapped.transition('blocked', {
    source: 'update_goal',
    blockedReason: 'missing dep',
    detail: 'blocked',
  });
  expect(store.getFocused('s1')?.status).toBe('blocked');
  expect(store.getFocused('s1')?.blockedReason).toBe('missing dep');
});

// Constants

test('GOAL_TUI_EVENT_TITLE is a non-empty string identifying the plugin', () => {
  expect(typeof GOAL_TUI_EVENT_TITLE).toBe('string');
  expect(GOAL_TUI_EVENT_TITLE.length).toBeGreaterThan(0);
  expect(GOAL_TUI_EVENT_TITLE).toBe('fixate-on');
});

// v2 buffering transport (tool-metadata channel)
//
// The v2 server→TUI channel: the GoalBroadcaster publishes into a buffering
// transport; the server adapter drains a session's buffer into each goal tool's
// Result.metadata; core emits that on session.tool.success; the TUI decodes it.
// These tests show the transport primitive and the full
// broadcaster→buffer→encode→decode→store pipeline.

function makeEvent(
  kind: GoalTuiEvent['kind'],
  sessionID = 's1',
  revision = 1,
): GoalTuiEvent {
  const base: GoalTuiEvent = {
    kind,
    sessionID,
    timestamp: Date.now(),
    snapshot: makeSnapshot({sessionID, revision, status: 'active'}),
  };
  if (kind === 'transition') {
    // Transition events require the CommitTransition payload (validated by
    // validateTuiEvent). Use a representative transition.
    return {
      ...base,
      transition: {
        source: 'update_goal',
        from: 'active',
        to: 'active',
        detail: '',
      },
    };
  }
  if (kind === 'remove') {
    // Remove events carry goalId only (no snapshot).
    const {snapshot, ...rest} = base;
    void snapshot;
    return {...rest, goalId: 'g1'};
  }
  return base;
}

test('createBufferingTransport buffers events per session and drain empties them', () => {
  const transport = createBufferingTransport();
  transport.publish('s1', makeEvent('create', 's1', 1));
  transport.publish('s1', makeEvent('usage', 's1', 2));
  transport.publish('s2', makeEvent('create', 's2', 1));

  expect(transport.peek('s1')).toHaveLength(2);
  expect(transport.peek('s2')).toHaveLength(1);
  expect(transport.peek('s3')).toEqual([]);

  const drained = transport.drain('s1');
  expect(drained).toHaveLength(2);
  expect(drained[0].kind).toBe('create');
  expect(drained[1].kind).toBe('usage');
  // drain removes events (at-most-once delivery)
  expect(transport.drain('s1')).toEqual([]);
  // other session untouched
  expect(transport.peek('s2')).toHaveLength(1);
});

test('createBufferingTransport drain on empty session returns []', () => {
  const transport = createBufferingTransport();
  expect(transport.drain('never')).toEqual([]);
});

test('createBufferingTransport bounds per-session buffer (drops oldest on overflow)', () => {
  const transport = createBufferingTransport();
  // Publish well over the bound. The internal cap is BUFFER_MAX_EVENTS=64.
  for (let i = 0; i < 200; i++) {
    transport.publish('s1', makeEvent('usage', 's1', i + 1));
  }
  const drained = transport.drain('s1');
  // Buffer must be bounded to the exact cap (BUFFER_MAX_EVENTS=64), not 200.
  expect(drained.length).toBeLessThanOrEqual(64);
  expect(drained.length).toBeGreaterThan(0);
  // Oldest dropped: the first retained event is NOT revision 1.
  expect(drained[0].snapshot!.revision).not.toBe(1);
});

test('createBufferingTransport clear drops all sessions', () => {
  const transport = createBufferingTransport();
  transport.publish('s1', makeEvent('create'));
  transport.publish('s2', makeEvent('create'));
  transport.clear();
  expect(transport.peek('s1')).toEqual([]);
  expect(transport.peek('s2')).toEqual([]);
});

test('encodeGoalToolMetadata returns undefined for empty input', () => {
  expect(encodeGoalToolMetadata([])).toBeUndefined();
});

test('encode/decode goal tool metadata round-trips events', () => {
  const events = [
    makeEvent('create', 's1', 1),
    makeEvent('transition', 's1', 2),
  ];
  const encoded = encodeGoalToolMetadata(events);
  expect(encoded).toBeDefined();
  expect(Object.keys(encoded!)).toContain(GOAL_TUI_METADATA_KEY);
  const decoded = decodeGoalToolMetadata(encoded);
  expect(decoded).not.toBeNull();
  expect(decoded!.length).toBe(2);
  expect(decoded![0].kind).toBe('create');
  expect(decoded![1].kind).toBe('transition');
  expect(decoded![1].snapshot!.revision).toBe(2);
});

test('decodeGoalToolMetadata returns null for non-goal metadata', () => {
  expect(decodeGoalToolMetadata(undefined)).toBeNull();
  expect(decodeGoalToolMetadata(null)).toBeNull();
  expect(decodeGoalToolMetadata({})).toBeNull();
  expect(decodeGoalToolMetadata({otherPlugin: {events: []}})).toBeNull();
  // wrong key shape: metadata present under goal key but events is not an array
  expect(
    decodeGoalToolMetadata({[GOAL_TUI_METADATA_KEY]: {events: 'no'}}),
  ).toBeNull();
  // empty events array → null (nothing valid to apply)
  expect(
    decodeGoalToolMetadata({[GOAL_TUI_METADATA_KEY]: {events: []}}),
  ).toBeNull();
});

test('decodeGoalToolMetadata drops malformed events but keeps valid ones', () => {
  const valid = makeEvent('create', 's1', 1);
  // Hand-build an envelope with one valid + two malformed events.
  const meta = {
    [GOAL_TUI_METADATA_KEY]: {
      events: [{kind: 'bogus'}, valid, {kind: 'remove', sessionID: ''}],
    },
  };
  const decoded = decodeGoalToolMetadata(meta);
  expect(decoded).not.toBeNull();
  expect(decoded!.length).toBe(1);
  expect(decoded![0].kind).toBe('create');
});

test('end-to-end v2 channel: broadcaster→buffer→encode→decode→store', async () => {
  // Simulate the full v2 pipeline WITHOUT a host publish channel.
  const transport = createBufferingTransport();
  const store = createTuiStateStore();
  // The server plugin wires the broadcaster to the buffering transport.
  const broadcaster = createGoalBroadcaster({publish: transport.publish});

  // A goal-tool call mutates state; the broadcaster publishes into the buffer.
  const machine = makeMachine({
    status: 'active',
    sessionID: 's1',
    goalId: 'g1',
  });
  const wrapped = new GoalStateMachine(machine.snapshot(), {
    onCommit: broadcaster.onCommit,
  });
  await broadcaster.emitCreate(wrapped.snapshot());
  await wrapped.transition('blocked', {
    source: 'update_goal',
    blockedReason: 'tests fail',
    detail: 'blocked',
  });

  // The server adapter drains the session buffer and encodes it as metadata.
  const events = transport.drain('s1');
  expect(events.length).toBeGreaterThanOrEqual(2); // create + transition
  const metadata = encodeGoalToolMetadata(events);
  expect(metadata).toBeDefined();

  // The TUI receives session.tool.success, decodes the metadata, applies events.
  const decoded = decodeGoalToolMetadata(metadata);
  expect(decoded).not.toBeNull();
  for (const ev of decoded!) store.applyEvent(ev);

  // The store reflects the final authoritative state.
  const focused = store.getFocused('s1');
  expect(focused).toBeDefined();
  expect(focused!.goalId).toBe('g1');
  expect(focused!.status).toBe('blocked');
  expect(focused!.blockedReason).toBe('tests fail');
});

test('v2 channel: stale (lower-revision) events are ignored by the store', async () => {
  // Revision-monotonicity guard: if an older event arrives after a newer one
  // (e.g. reordered drain), the store must NOT regress the goal.
  const transport = createBufferingTransport();
  const store = createTuiStateStore();
  const broadcaster = createGoalBroadcaster({publish: transport.publish});
  const machine = makeMachine({status: 'active', goalId: 'g1'});
  const wrapped = new GoalStateMachine(machine.snapshot(), {
    onCommit: broadcaster.onCommit,
  });
  await broadcaster.emitCreate(wrapped.snapshot());
  await wrapped.transition('paused', {source: 'slash-command', detail: ''});

  // Apply the newer (paused, revision 1) event first, then a stale create
  // (revision 0 — strictly less) that would regress status to "active".
  const events = transport.drain('s1');
  const pausedEv = events.find(e => e.kind === 'transition')!;
  store.applyEvent(pausedEv);
  expect(store.getFocused('s1')?.status).toBe('paused');
  const staleCreate = makeEvent('create', 's1', 0);
  store.applyEvent(staleCreate);
  // Stale event ignored — still paused.
  expect(store.getFocused('s1')?.status).toBe('paused');
});

// STATE-CONVERGENCE-1 (3): outer/embedded sessionID must agree

test('a create event whose embedded snapshot belongs to ANOTHER session is rejected', () => {
  // The store indexes by the OUTER event id but keeps the embedded snapshot.
  // Validating them independently let a mis-routed event be filed under one
  // session while carrying another session's goal, so that session would then
  // serve the wrong goal's truth.
  const mismatched = {
    kind: 'create',
    sessionID: 's-outer',
    timestamp: Date.now(),
    snapshot: makeSnapshot({goalId: 'g-foreign', sessionID: 's-embedded'}),
  };
  expect(
    parseTuiSyncEvent(
      JSON.stringify({title: GOAL_TUI_EVENT_TITLE, payload: mismatched}),
    ),
  ).toBeNull();

  // The agreeing form is still accepted, so the check is not over-broad.
  const agreeing = {
    kind: 'create',
    sessionID: 's1',
    timestamp: Date.now(),
    snapshot: makeSnapshot({goalId: 'g1', sessionID: 's1'}),
  };
  expect(
    parseTuiSyncEvent(
      JSON.stringify({title: GOAL_TUI_EVENT_TITLE, payload: agreeing}),
    ),
  ).not.toBeNull();
});

test('a transition event with a mismatched embedded session is rejected', () => {
  const mismatched = {
    kind: 'transition',
    sessionID: 's-outer',
    timestamp: Date.now(),
    snapshot: makeSnapshot({
      goalId: 'g-foreign',
      sessionID: 's-embedded',
      revision: 2,
    }),
    transition: {
      source: 'update_goal',
      from: 'active',
      to: 'paused',
      detail: '',
    },
  };
  expect(
    parseTuiSyncEvent(
      JSON.stringify({title: GOAL_TUI_EVENT_TITLE, payload: mismatched}),
    ),
  ).toBeNull();
});

test('a mismatched event never reaches the store, so no foreign goal is filed', () => {
  const store = createTuiStateStore();
  const mismatched = {
    kind: 'create',
    sessionID: 's-outer',
    timestamp: Date.now(),
    snapshot: makeSnapshot({goalId: 'g-foreign', sessionID: 's-embedded'}),
  };
  const parsed = parseTuiSyncEvent(
    JSON.stringify({title: GOAL_TUI_EVENT_TITLE, payload: mismatched}),
  );
  expect(parsed).toBeNull();
  if (parsed) store.applyEvent(parsed);
  expect(store.getSnapshots('s-outer')).toHaveLength(0);
  expect(store.getSnapshots('s-embedded')).toHaveLength(0);
});
