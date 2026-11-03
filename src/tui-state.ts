/**
 * Cross-plugin state synchronization engine for the TUI companion.
 *
 * Responsibilities:
 * - TUI snapshot projection of a `GoalState`
 * - Event payload contract and wire validation
 * - In-process `TuiStateStore` (subscriber registry and current state)
 * - `GoalBroadcaster` (server adapter publishing transitions and lifecycle events)
 * - Buffering transport for host environments where tool metadata carries events
 *
 * Architecture and design invariants:
 * - Leaf dependency: Imports types only from `state-machine.ts` and `accounting.ts`
 *   to eliminate circular dependencies across plugin, hooks, and persistence modules.
 * - Transport abstraction: The broadcaster publishes via a generic `publish` callback,
 *   decoupling state updates from host-specific IPC or toast APIs.
 * - Monotonic revisions: The store drops stale revisions for existing goals, ensuring
 *   out-of-order event delivery cannot corrupt client state.
 * - Immutability: Snapshots are deeply frozen before emission and storage to prevent
 *   display surfaces from mutating shared state.
 */

import type {
  ClaimRecord,
  CommitTransition,
  GoalProposal,
  GoalState,
  GoalStatus,
} from './state-machine.ts';
import type {UsageSnapshot} from './accounting.ts';

/**
 * Event title marker stamped on published TUI events. The TUI companion filters
 * incoming host events by this marker to separate goal events from general host toast traffic.
 */
export const GOAL_TUI_EVENT_TITLE = 'fixate-on';

/**
 * Valid GoalStatus values used for payload validation. Malformed or unrecognized
 * status strings are rejected at the transport boundary.
 */
export const VALID_GOAL_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'paused',
  'blocked',
  'budgetLimited',
  'finalizing',
  'complete',
]);

export type GoalTuiEventKind = 'create' | 'transition' | 'usage' | 'remove';

/**
 * Frozen, serializable projection of a `GoalState` for consumption by the TUI layer.
 * Contains only rendering state, omitting internal bookkeeping (mutexes, claims, pending intents).
 */
export interface GoalTuiSnapshot {
  readonly goalId: string;
  readonly sessionID: string;
  readonly condition: string;
  readonly artifactPointers?: ReadonlyArray<string>;
  readonly pendingProposal?: Readonly<GoalProposal> | null;
  readonly claims?: ReadonlyArray<Readonly<ClaimRecord>>;
  readonly lastClaim?: Readonly<ClaimRecord> | null;
  readonly status: GoalStatus;
  readonly revision: number;
  readonly turnCount: number;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly maxTurns: number;
  readonly tokenBudget: number | null;
  readonly usage: Readonly<UsageSnapshot>;
  readonly stopReason: string;
  readonly blockedReason: string;
  /**
   * Timestamp (epoch ms) when the goal was last paused; 0 when not paused.
   * Used by display surfaces to determine how long a yield has been parked.
   */
  readonly pausedAt: number;
  /**
   * Timestamp (epoch ms) when the current stop state was applied; 0 when not stopped.
   * Unlike `pausedAt`, this is renewed on every stop to enforce yield-promise timeouts.
   */
  readonly stoppedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
  readonly lastCheckpoint: Readonly<{
    summary: string;
    timestamp: number;
  }> | null;
  readonly history: ReadonlyArray<
    Readonly<{type: string; detail: string; timestamp: number}>
  >;
  /**
   * Origin of the snapshot:
   * - "live": Dispatched during the active session.
   * - "disk": Rehydrated from disk persistence (may originate from a pre-restart session).
   */
  readonly origin?: 'live' | 'disk';
}

/**
 * Memoized frozen history cache.
 *
 * Frequent events (e.g. streaming usage updates) do not modify history.
 * Reusing the previously frozen array when reference and length match avoids
 * allocating and recursively freezing large arrays on every token tick.
 */
type HistoryEntry = {type: string; detail: string; timestamp: number};
let memoHistoryRef: ReadonlyArray<HistoryEntry> | null = null;
let memoHistoryLen = -1;
let memoHistoryFrozen: ReadonlyArray<HistoryEntry> = [];

function frozenHistory(
  history: ReadonlyArray<HistoryEntry>,
): ReadonlyArray<HistoryEntry> {
  if (history === memoHistoryRef && history.length === memoHistoryLen) {
    return memoHistoryFrozen;
  }
  memoHistoryRef = history;
  memoHistoryLen = history.length;
  memoHistoryFrozen = deepFreeze(
    history.map(h => ({
      type: h.type,
      detail: h.detail,
      timestamp: h.timestamp,
    })),
  );
  return memoHistoryFrozen;
}

/**
 * Projects a `GoalState` into a deeply frozen, immutable `GoalTuiSnapshot`.
 */
export function serializeGoalForTui(
  state: Readonly<GoalState>,
): GoalTuiSnapshot {
  const snapshot: GoalTuiSnapshot = {
    goalId: state.goalId,
    sessionID: state.sessionID,
    condition: state.condition,
    artifactPointers: state.artifactPointers ? [...state.artifactPointers] : [],
    pendingProposal: state.pendingProposal ? {...state.pendingProposal} : null,
    claims: state.claims ? state.claims.map(c => ({...c})) : [],
    lastClaim: state.lastClaim ? {...state.lastClaim} : null,
    status: state.status,
    revision: state.revision,
    turnCount: state.turnCount,
    totalTokens: state.totalTokens,
    maxTokens: state.maxTokens,
    maxTurns: state.maxTurns,
    tokenBudget: state.tokenBudget,
    usage: {
      input: state.usage.input,
      output: state.usage.output,
      reasoning: state.usage.reasoning,
      cacheRead: state.usage.cacheRead,
      cacheWrite: state.usage.cacheWrite,
      cost: state.usage.cost,
      costKnown: state.usage.costKnown,
    },
    stopReason: state.stopReason,
    blockedReason: state.blockedReason,
    pausedAt: state.pausedAt,
    stoppedAt: state.stoppedAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finishedAt: state.finishedAt,
    lastCheckpoint: state.lastCheckpoint
      ? {
          summary: state.lastCheckpoint.summary,
          timestamp: state.lastCheckpoint.timestamp,
        }
      : null,
    history: frozenHistory(state.history),
  };
  return deepFreeze(snapshot);
}

/**
 * Event payload exchanged between the server broadcaster and TUI state stores.
 */
export interface GoalTuiEvent {
  readonly kind: GoalTuiEventKind;
  readonly sessionID: string;
  readonly timestamp: number;
  /** Included for create, transition, and usage events. */
  readonly snapshot?: GoalTuiSnapshot;
  /** Included only for transition events. */
  readonly transition?: Readonly<CommitTransition>;
  /**
   * The status preceding this transition. Differentiates state entry from
   * continuation churn within the same status.
   */
  readonly previousStatus?: GoalStatus;
  /** Included only for remove events. */
  readonly goalId?: string;
}

/**
 * Parses and validates a JSON string into a `GoalTuiEvent`. Accepts either the raw
 * event payload or an envelope formatted as `{ title: GOAL_TUI_EVENT_TITLE, payload: ... }`.
 * Returns null if parsing fails or fields are invalid.
 */
export function parseTuiSyncEvent(raw: string): GoalTuiEvent | null {
  if (!raw || typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateTuiEvent(parsed);
}

function validateTuiEvent(value: unknown): GoalTuiEvent | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  if (
    obj.title === GOAL_TUI_EVENT_TITLE &&
    obj.payload &&
    typeof obj.payload === 'object'
  ) {
    return validateTuiEvent(obj.payload);
  }

  const kind = obj.kind;
  if (
    kind !== 'create' &&
    kind !== 'transition' &&
    kind !== 'usage' &&
    kind !== 'remove'
  ) {
    return null;
  }
  const sessionID = obj.sessionID;
  if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
  const timestamp = obj.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;

  if (kind === 'remove') {
    const goalId = obj.goalId;
    if (typeof goalId !== 'string' || goalId.length === 0) return null;
    return {kind, sessionID, timestamp, goalId};
  }

  const snapshot = validateSnapshot(obj.snapshot);
  if (!snapshot) return null;

  // Invariant: The envelope sessionID and snapshot sessionID must match to prevent
  // misrouted events from corrupting the session store index.
  if (snapshot.sessionID !== sessionID) return null;

  if (kind === 'transition') {
    const transition = validateTransition(obj.transition);
    if (!transition) return null;
    return {kind, sessionID, timestamp, snapshot, transition};
  }

  return {kind, sessionID, timestamp, snapshot};
}

function validateSnapshot(value: unknown): GoalTuiSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s.goalId !== 'string' ||
    typeof s.sessionID !== 'string' ||
    typeof s.condition !== 'string' ||
    typeof s.status !== 'string' ||
    !VALID_GOAL_STATUSES.has(s.status) ||
    typeof s.revision !== 'number' ||
    typeof s.turnCount !== 'number' ||
    typeof s.totalTokens !== 'number' ||
    typeof s.maxTokens !== 'number' ||
    typeof s.maxTurns !== 'number' ||
    (s.tokenBudget !== null && typeof s.tokenBudget !== 'number') ||
    typeof s.stopReason !== 'string' ||
    typeof s.pausedAt !== 'number' ||
    !Number.isFinite(s.pausedAt) ||
    s.pausedAt < 0 ||
    typeof s.stoppedAt !== 'number' ||
    !Number.isFinite(s.stoppedAt) ||
    s.stoppedAt < 0 ||
    typeof s.blockedReason !== 'string' ||
    typeof s.createdAt !== 'number' ||
    typeof s.updatedAt !== 'number'
  ) {
    return null;
  }
  if (s.finishedAt !== null && typeof s.finishedAt !== 'number') return null;
  const usage = validateUsage(s.usage);
  if (!usage) return null;
  const history = validateHistory(s.history);
  if (history === null) return null;

  const checkpoint = validateCheckpoint(s.lastCheckpoint);
  if (checkpoint === INVALID_CHECKPOINT) return null;

  const snapshot: GoalTuiSnapshot = {
    goalId: s.goalId,
    sessionID: s.sessionID,
    condition: s.condition,
    status: s.status as GoalStatus,
    revision: s.revision,
    turnCount: s.turnCount,
    totalTokens: s.totalTokens,
    maxTokens: s.maxTokens,
    maxTurns: s.maxTurns,
    tokenBudget: s.tokenBudget === null ? null : (s.tokenBudget as number),
    usage,
    stopReason: s.stopReason,
    blockedReason: s.blockedReason,
    pausedAt: s.pausedAt,
    stoppedAt: s.stoppedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    finishedAt: s.finishedAt === null ? null : (s.finishedAt as number),
    lastCheckpoint: checkpoint,
    history,
  };
  return deepFreeze(snapshot);
}

function validateUsage(value: unknown): UsageSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as Record<string, unknown>;
  if (
    typeof u.input !== 'number' ||
    typeof u.output !== 'number' ||
    typeof u.reasoning !== 'number' ||
    typeof u.cacheRead !== 'number' ||
    typeof u.cacheWrite !== 'number' ||
    typeof u.cost !== 'number' ||
    typeof u.costKnown !== 'boolean'
  ) {
    return null;
  }
  return {
    input: u.input,
    output: u.output,
    reasoning: u.reasoning,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    cost: u.cost,
    costKnown: u.costKnown,
  };
}

function validateHistory(value: unknown): ReadonlyArray<
  Readonly<{
    type: string;
    detail: string;
    timestamp: number;
  }>
> | null {
  if (!Array.isArray(value)) return null;
  const result: Array<
    Readonly<{type: string; detail: string; timestamp: number}>
  > = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.type !== 'string' ||
      typeof e.detail !== 'string' ||
      typeof e.timestamp !== 'number'
    ) {
      return null;
    }
    result.push({type: e.type, detail: e.detail, timestamp: e.timestamp});
  }
  return result;
}

/** Sentinel indicating a present but malformed checkpoint. */
const INVALID_CHECKPOINT: Readonly<{summary: string; timestamp: number}> =
  Object.freeze({summary: '', timestamp: -1});

function validateCheckpoint(value: unknown):
  | Readonly<{
      summary: string;
      timestamp: number;
    }>
  | null
  | typeof INVALID_CHECKPOINT {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return INVALID_CHECKPOINT;
  const c = value as Record<string, unknown>;
  if (typeof c.summary !== 'string' || typeof c.timestamp !== 'number')
    return INVALID_CHECKPOINT;
  return {summary: c.summary, timestamp: c.timestamp};
}

function validateTransition(value: unknown): Readonly<CommitTransition> | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>;
  if (
    typeof t.source !== 'string' ||
    typeof t.from !== 'string' ||
    typeof t.to !== 'string' ||
    typeof t.detail !== 'string'
  ) {
    return null;
  }
  // Unknown transition sources are preserved for forward compatibility across companion versions.
  return {
    source: t.source as CommitTransition['source'],
    from: t.from as GoalStatus,
    to: t.to as GoalStatus,
    detail: t.detail,
  };
}

type TuiSubscriber = (event: GoalTuiEvent) => void;

/**
 * In-process state cache for the TUI companion.
 *
 * Maintains the latest snapshot per goal indexed by session and goalId.
 * Enforces revision monotonicity: incoming events with an older revision
 * than the stored snapshot are ignored to prevent out-of-order race conditions.
 */
export interface TuiStateStore {
  applyEvent(event: GoalTuiEvent): void;
  getSnapshots(sessionID: string): GoalTuiSnapshot[];
  getAllSnapshots(): GoalTuiSnapshot[];
  getSnapshot(sessionID: string, goalId: string): GoalTuiSnapshot | undefined;
  getFocused(sessionID: string): GoalTuiSnapshot | undefined;
  subscribe(fn: TuiSubscriber): () => void;
  clear(): void;
}

interface SessionStore {
  goals: Map<string, GoalTuiSnapshot>;
  focusedId: string | null;
  order: string[];
}

function createSessionStore(): SessionStore {
  return {goals: new Map(), focusedId: null, order: []};
}

export function createTuiStateStore(): TuiStateStore {
  const sessions = new Map<string, SessionStore>();
  const subscribers = new Set<TuiSubscriber>();

  function getOrCreateSession(sessionID: string): SessionStore {
    let s = sessions.get(sessionID);
    if (!s) {
      s = createSessionStore();
      sessions.set(sessionID, s);
    }
    return s;
  }

  function notify(event: GoalTuiEvent): void {
    for (const sub of subscribers) {
      try {
        sub(event);
      } catch {
        // Isolate subscriber errors to prevent listener chain interruption.
      }
    }
  }

  function applyEvent(event: GoalTuiEvent): void {
    if (event.kind === 'remove') {
      const session = sessions.get(event.sessionID);
      if (session && event.goalId) {
        session.goals.delete(event.goalId);
        session.order = session.order.filter(id => id !== event.goalId);
        if (session.focusedId === event.goalId) {
          session.focusedId = session.order[session.order.length - 1] ?? null;
        }
      }
      notify(event);
      return;
    }

    if (!event.snapshot) return;
    const snapshot = deepFreeze(event.snapshot);
    const session = getOrCreateSession(event.sessionID);

    const existing = session.goals.get(snapshot.goalId);
    if (existing && snapshot.revision < existing.revision) {
      return;
    }

    if (!existing) {
      session.order.push(snapshot.goalId);
    }
    session.goals.set(snapshot.goalId, snapshot);
    session.focusedId = snapshot.goalId;
    notify(event);
  }

  function getSnapshots(sessionID: string): GoalTuiSnapshot[] {
    const session = sessions.get(sessionID);
    if (!session) return [];
    return session.order
      .map(id => session.goals.get(id))
      .filter((s): s is GoalTuiSnapshot => !!s);
  }

  function getAllSnapshots(): GoalTuiSnapshot[] {
    const all: GoalTuiSnapshot[] = [];
    for (const session of sessions.values()) {
      for (const id of session.order) {
        const snap = session.goals.get(id);
        if (snap) all.push(snap);
      }
    }
    return all;
  }

  function getSnapshot(
    sessionID: string,
    goalId: string,
  ): GoalTuiSnapshot | undefined {
    const session = sessions.get(sessionID);
    if (!session) return undefined;
    return session.goals.get(goalId);
  }

  function getFocused(sessionID: string): GoalTuiSnapshot | undefined {
    const session = sessions.get(sessionID);
    if (!session || !session.focusedId) return undefined;
    return session.goals.get(session.focusedId);
  }

  function subscribe(fn: TuiSubscriber): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function clear(): void {
    sessions.clear();
    subscribers.clear();
  }

  return {
    applyEvent,
    getSnapshots,
    getAllSnapshots,
    getSnapshot,
    getFocused,
    subscribe,
    clear,
  };
}

/**
 * Transport callback invoked by the broadcaster to send events to the client.
 */
export type GoalTuiPublishFn = (
  sessionID: string,
  event: GoalTuiEvent,
) => Promise<void> | void;

/**
 * Server-side adapter bridging state machine commits to the TUI event channel.
 */
export interface GoalBroadcaster {
  onCommit: (
    snapshot: Readonly<GoalState>,
    transition: CommitTransition,
  ) => Promise<void>;
  emitCreate: (snapshot: Readonly<GoalState>) => Promise<void>;
  emitRemove: (sessionID: string, goalId: string) => Promise<void>;
  emitUsage: (snapshot: Readonly<GoalState>) => Promise<void>;
}

export function createGoalBroadcaster(config: {
  publish: GoalTuiPublishFn;
  /**
   * Invoked when broadcast transmission fails. Failures are caught to protect
   * state machine execution, but this callback allows logging delivery failures
   * (such as dropped removals). Must never throw.
   */
  onDeliveryFailure?: (info: {
    kind: GoalTuiEventKind;
    sessionID: string;
    goalId?: string;
    error: unknown;
  }) => void;
}): GoalBroadcaster {
  const {publish, onDeliveryFailure} = config;

  async function emit(
    snapshot: Readonly<GoalState>,
    kind: GoalTuiEventKind,
    transition?: CommitTransition,
  ): Promise<void> {
    const event: GoalTuiEvent = {
      kind,
      sessionID: snapshot.sessionID,
      timestamp: Date.now(),
      snapshot: serializeGoalForTui(snapshot),
      ...(transition ? {transition, previousStatus: transition.from} : {}),
    };
    try {
      await publish(snapshot.sessionID, event);
    } catch (error) {
      try {
        onDeliveryFailure?.({
          kind,
          sessionID: snapshot.sessionID,
          goalId: snapshot.goalId,
          error,
        });
      } catch {
        // Prevent telemetry errors from disrupting caller flow.
      }
    }
  }

  return {
    onCommit: async (snapshot, transition) => {
      await emit(snapshot, 'transition', transition);
    },
    emitCreate: async snapshot => {
      await emit(snapshot, 'create');
    },
    emitRemove: async (sessionID, goalId) => {
      const event: GoalTuiEvent = {
        kind: 'remove',
        sessionID,
        goalId,
        timestamp: Date.now(),
      };
      try {
        await publish(sessionID, event);
      } catch (error) {
        try {
          onDeliveryFailure?.({kind: 'remove', sessionID, goalId, error});
        } catch {
          // Prevent telemetry errors from disrupting caller flow.
        }
      }
    },
    emitUsage: async snapshot => {
      await emit(snapshot, 'usage');
    },
  };
}

/**
 * Maximum events buffered per session before oldest entries are evicted.
 * Bounds memory consumption if high-frequency usage events occur between tool executions.
 */
const BUFFER_MAX_EVENTS = 64;

/**
 * Envelope key used to carry sync events inside `session.tool.success` metadata.
 */
export const GOAL_TUI_METADATA_KEY = 'fixate-on';

/**
 * Buffering transport for host architectures lacking a direct server-to-TUI channel.
 *
 * Events are queued in memory per session and drained into tool execution metadata
 * payloads, propagating to the companion over the standard tool success event stream.
 */
export interface BufferingTransport {
  publish: GoalTuiPublishFn;
  drain: (sessionID: string) => GoalTuiEvent[];
  peek: (sessionID: string) => GoalTuiEvent[];
  clear: () => void;
}

export function createBufferingTransport(): BufferingTransport {
  const buffers = new Map<string, GoalTuiEvent[]>();

  function get(sessionID: string): GoalTuiEvent[] {
    let buf = buffers.get(sessionID);
    if (!buf) {
      buf = [];
      buffers.set(sessionID, buf);
    }
    return buf;
  }

  return {
    publish: (_sessionID, event) => {
      const sessionID = event.sessionID;
      if (!sessionID) return;
      const buf = get(sessionID);
      buf.push(event);
      // When the buffer overflows, evict the oldest entries. The client store's
      // revision monotonicity guard safely handles discarded interim states.
      if (buf.length > BUFFER_MAX_EVENTS) {
        buf.splice(0, buf.length - BUFFER_MAX_EVENTS);
      }
    },
    drain: sessionID => {
      const buf = buffers.get(sessionID);
      if (!buf || buf.length === 0) return [];
      return buf.splice(0, buf.length);
    },
    peek: sessionID => {
      const buf = buffers.get(sessionID);
      return buf ? buf.slice() : [];
    },
    clear: () => {
      buffers.clear();
    },
  };
}

/**
 * Encodes buffered events into a tool result metadata payload.
 * Returns undefined if no events are queued, avoiding extraneous metadata on unmutated runs.
 */
export function encodeGoalToolMetadata(
  events: GoalTuiEvent[],
): Record<string, unknown> | undefined {
  if (!events || events.length === 0) return undefined;
  return {[GOAL_TUI_METADATA_KEY]: {events}};
}

/**
 * Extracts and validates sync events from a tool result metadata payload.
 * Returns null if the metadata is missing, malformed, or contains no valid events.
 */
export function decodeGoalToolMetadata(
  metadata: unknown,
): GoalTuiEvent[] | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const envelope = (metadata as Record<string, unknown>)[GOAL_TUI_METADATA_KEY];
  if (!envelope || typeof envelope !== 'object') return null;
  const events = (envelope as {events?: unknown}).events;
  if (!Array.isArray(events)) return null;

  const valid: GoalTuiEvent[] = [];
  for (const raw of events) {
    const event = validateTuiEvent(raw);
    if (event) valid.push(event);
  }
  return valid.length > 0 ? valid : null;
}

/**
 * Recursively freezes plain objects and arrays to ensure state immutability.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
