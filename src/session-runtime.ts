/**
 * Per-process runtime isolation state for goals.
 *
 * Encapsulates runtime options, state tracking, and AsyncLocalStorage context
 * without requiring the full session state manager.
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import type {
  GoalState,
  GoalStateMachine,
  PendingIntent,
} from './state-machine.ts';
import type {GoalResult} from './persistence.ts';
import type {UsageSnapshot} from './accounting.ts';

export interface DefaultGoalOptions {
  maxTokens?: number;
  maxTurns?: number;
  maxDurationMs?: number;
  noProgressTokenThreshold?: number;
  noProgressTurnsBeforePause?: number;
  noToolCallTurnsBeforePause?: number;
  budgetWrapupRatio?: number;
  minDelayMs?: number;
  maxPromptFailures?: number;
  maxRecentMessages?: number;
  /** Completion-gate recovery turns limit propagated to new goals. */
  maxRecoveryTurns?: number;
  /** Completion-gate threshold for unchanged result verification. */
  maxUnchangedResults?: number;
  /** Threshold for consecutive turns marked as blocked (distinct from maxUnchangedResults). */
  maxBlockedTurns?: number;
  languageTriage?: boolean;
}

export const DEFAULT_GOAL_OPTIONS: Required<DefaultGoalOptions> = {
  // The cumulative context-token brake is opt-in; zero disables it.
  maxTokens: 0,
  // Turn counts do not reliably differentiate productive from stuck sessions.
  // Disabled by default (0) in favor of stall and context brakes.
  maxTurns: 0,
  // Stall brake tracking elapsed time since last progress (assistant turn or token increase).
  // Outstanding tool calls do not reset this timer, ensuring hung tool calls are paused after 30m.
  maxDurationMs: 1800000,
  noProgressTokenThreshold: 50,
  // Requires 3 consecutive low-output turns to avoid false pauses during transient re-reading lulls.
  noProgressTurnsBeforePause: 3,
  noToolCallTurnsBeforePause: 3,
  budgetWrapupRatio: 0.8,
  minDelayMs: 1500,
  maxPromptFailures: 3,
  maxRecentMessages: 50,
  // Completion-gate recovery limits (12 turns / 3 unchanged results).
  maxRecoveryTurns: 12,
  maxUnchangedResults: 3,
  maxBlockedTurns: 3,
  languageTriage: true,
};

export interface RuntimeState {
  /** Active and backgrounded goals indexed by session ID. */
  sessionGoals: Map<string, GoalStateMachine[]>;
  /** Currently focused goal ID for each session. */
  focusedGoalId: Map<string, string>;
  /** Archived goal results per session. */
  sessionArchive: Map<string, GoalResult[]>;
  /** Sessions executing an ordered sequence of goals. */
  sessionOrdered: Set<string>;
  seenTokens: Map<string, number>;
  seenUsage: Map<string, UsageSnapshot>;
  seenOutputTokens: Map<string, number>;
  /**
   * Last published cumulative usage per session.
   * Host v2 events carry running totals rather than deltas; tracking cumulative values
   * ensures only incremental usage is billed per event.
   */
  seenSessionUsage: Map<string, UsageSnapshot>;
  activeContinues: Map<string, string>;
  continuationControllers: Map<string, AbortController>;
  promptInFlightSessions: Set<string>;
  /**
   * Sessions restored with an active goal awaiting the first genuine host idle
   * event before safely resuming.
   */
  recoveryPendingSessions: Set<string>;
  seenIdleEventIDs: Set<string>;
  /**
   * Sessions where the host reported blocking background jobs. Value is a
   * deadline (epoch ms) after which the gate may be re-evaluated. Shared so the
   * fallback idle poller cannot defeat a deferral made by the native idle hook.
   */
  backgroundBlockedUntil: Map<string, number>;
  /**
   * Structured background-work deferrals: the job identities that caused the
   * deferral and when escalation should occur. The wall-clock gate alone is not
   * a completion signal; only a later host idle with an empty background is.
   */
  backgroundDeferrals?: Map<
    string,
    {
      jobKeys: string[];
      since: number;
      nextRecheckAt: number;
      extensions: number;
    }
  >;
  /** Consecutive busy-deferral counter per `${sessionID}:${goalId}` (M1 brake). */
  deferCounts: Map<string, number>;
  /**
   * Sliding window of compaction completion timestamps per session.
   * Used by the compaction-loop brake to pause goals when compaction churns indefinitely.
   */
  compactionTimestamps: Map<string, number[]>;
  threadToolsRegistered: boolean;
  /**
   * Sessions where message.updated usage events have been seen.
   * v1 hosts omit these events (requiring usage extraction from messages),
   * while v2 hosts emit them (where message inspection would double-count).
   */
  usageEventsObserved: Set<string>;
  hasTuiCompanion: boolean;
  /**
   * Sessions actively observed from the host during this process lifetime.
   * Prevents synthesizing idles or re-arming goals for stale sessions from previous runs.
   */
  liveSessions: Set<string>;
  pendingIntents: Map<string, PendingIntent>;
  /**
   * Message ids known to arrive as non-interrupting inbox input (delivery
   * "queue"): the host parks them for the next turn boundary instead of waking
   * execution mid-turn. Recorded from `session.inbox.enqueued` /
   * `session.inbox.delivery.changed` (OpenCode 2.x through v2.2.5) and
   * `session.input.admitted` / `session.input.queued` / `session.input.steered`
   * (newer hosts), keyed by session ID to a set of message ids. On 1.x hosts no
   * delivery distinction is observable, so queued input still pauses there. A
   * queued message must not yield the goal; it is surfaced to the user as a
   * notice instead.
   */
  queuedInputMessageIDs: Map<string, Set<string>>;
  /**
   * Message ids observed as interrupting inbox input (delivery "steer") while the
   * turn was running. Recorded from the same channels as `queuedInputMessageIDs`.
   */
  steeredInputMessageIDs: Map<string, Set<string>>;
  /**
   * Queued message ids already surfaced to the user as notices by the idle path,
   * keyed by session ID. Prevents repeated idle passes over the same message
   * from re-announcing it.
   */
  surfacedQueuedMessageIDs: Map<string, Set<string>>;
  /**
   * Original inbox payloads retained by inboxID so a queue→steer delivery change
   * (which carries no text) can synthesize steering with the original message.
   */
  inboxPayloadsByID?: Map<
    string,
    Map<string, {text: string; synthetic: boolean}>
  >;
  /**
   * Determines whether this process is permitted to drive a session's goals.
   * Prevents competing instances from dispatching actions on owned sessions.
   */
  canDriveSession?: (sessionID: string) => boolean;
  /** Clears any pending delayed kickoff timer for a session. */
  clearKickoffTimer?: (sessionID: string) => void;
  scheduleKickoff?: (sessionID: string, goalId: string, runId: string) => void;
  /** Original v2 command dispatch retained for a fenced admission retry. */
  pendingKickoffDispatch?: Map<
    string,
    {goalId: string; runId: string; dispatch: unknown; attempts?: number}
  >;
  /** Retries a retained v2 dispatch after a delayed kickoff's guards pass. */
  retryPendingKickoffDispatch?: (
    sessionID: string,
    dispatch: unknown,
  ) => Promise<void>;
  /** Reports the status of a session goal without mutating it. */
  getGoalStatus?: (
    sessionID: string,
    goalId: string | null,
  ) => string | undefined;
  /** Executes the plugin's parsed `/goal` slash command without going through v1 chat parts. */
  executeSlashCommand?: (
    input: {sessionID?: string; command?: string; arguments?: string},
    options?: {
      skipKickoff?: boolean;
      skipReplayRecord?: boolean;
      clearKickoffOnSkip?: boolean;
      preserveKickoffOnSkip?: boolean;
    },
  ) => Promise<{
    handled: boolean;
    ok: boolean;
    sessionID: string;
    args: string;
    subcmd: string;
    text: string;
    receipt: string;
    rendered: string;
    before: GoalState | null;
    after: GoalState | null;
    activatedGoal: GoalState | null;
    enteredActive: boolean;
    error?: string;
  }>;
  drainPersistence: (() => Promise<boolean>) | null;
  disposed: boolean;
}

export function createRuntimeState(): RuntimeState {
  return {
    sessionGoals: new Map(),
    focusedGoalId: new Map(),
    sessionArchive: new Map(),
    sessionOrdered: new Set(),
    seenTokens: new Map(),
    seenUsage: new Map(),
    seenOutputTokens: new Map(),
    seenSessionUsage: new Map(),
    activeContinues: new Map(),
    continuationControllers: new Map(),
    promptInFlightSessions: new Set(),
    recoveryPendingSessions: new Set(),
    pendingKickoffDispatch: new Map(),
    seenIdleEventIDs: new Set(),
    backgroundBlockedUntil: new Map(),
    backgroundDeferrals: new Map(),
    deferCounts: new Map(),
    compactionTimestamps: new Map(),
    threadToolsRegistered: false,
    usageEventsObserved: new Set(),
    hasTuiCompanion: false,
    liveSessions: new Set(),
    pendingIntents: new Map(),
    queuedInputMessageIDs: new Map(),
    steeredInputMessageIDs: new Map(),
    surfacedQueuedMessageIDs: new Map(),
    inboxPayloadsByID: new Map(),
    drainPersistence: null,
    disposed: false,
  };
}

/** Cap on ids held per delivery set (insertion-order eviction). */
export const DELIVERY_SET_CAP = 256;

/**
 * Adds `id` to a per-session set with insertion-order eviction at
 * DELIVERY_SET_CAP. Returns the set (creating and registering it on `target`
 * when absent). Null-safe: a missing runtime or empty key is a no-op.
 */
export function addToCappedIDSet(
  target: Map<string, Set<string>> | undefined,
  sessionID: string,
  id: string,
): void {
  if (!target || !sessionID || !id) return;
  let set = target.get(sessionID);
  if (!set) {
    set = new Set<string>();
    target.set(sessionID, set);
  }
  set.add(id);
  while (set.size > DELIVERY_SET_CAP) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/**
 * Records one input-delivery observation into the runtime's per-session sets.
 * Shared by every host event path (v1 event hook and v2 adapter) so the
 * recording logic lives in exactly one place.
 *
 * A `delivery.changed` observation moves the id across sets. Sets are capped
 * by insertion order. No-op when the runtime, session, id, or delivery is
 * unusable — an empty id must never win over a valid fallback, which is why
 * callers pass a resolved id rather than a ?? chain.
 */
export function recordInputDelivery(
  runtime:
    | {
        queuedInputMessageIDs: Map<string, Set<string>>;
        steeredInputMessageIDs: Map<string, Set<string>>;
      }
    | undefined,
  sessionID: string,
  id: string,
  delivery: unknown,
): void {
  if (!runtime || !sessionID || !id) return;
  if (delivery !== 'queue' && delivery !== 'steer') return;
  const target =
    delivery === 'queue'
      ? runtime.queuedInputMessageIDs
      : runtime.steeredInputMessageIDs;
  const other =
    delivery === 'queue'
      ? runtime.steeredInputMessageIDs
      : runtime.queuedInputMessageIDs;
  let set = target.get(sessionID);
  if (!set) {
    set = new Set<string>();
    target.set(sessionID, set);
  }
  set.add(id);
  // A delivery change moves the id from one mode to the other.
  other.get(sessionID)?.delete(id);
  if (set.size > DELIVERY_SET_CAP) {
    set.delete(set.values().next().value!);
  }
}

/**
 * Resolves the {sessionID, id, delivery} fields of a host input/inbox event
 * payload. Every field uses a valid-value check (not `??`) so an empty string
 * or an invalid literal never wins over a later valid candidate:
 *
 * - sessionID: caller-known id first, then a structural search of the payload
 *   (direct, properties, info, session — mirroring the v2 adapter).
 * - id: first non-empty string among inputID, inboxID, item.id, message id.
 * - delivery: first valid 'queue'|'steer' among input.delivery, item.delivery,
 *   top-level delivery, properties.delivery; when the event type is
 *   session.input.queued / session.input.steered the type itself implies the
 *   mode.
 */
export function resolveInputDeliveryFields(
  data: Record<string, unknown>,
  eventType?: string,
  fallbackSessionID?: string,
): {sessionID: string; id: string; delivery: unknown} {
  const asString = (v: unknown): string =>
    typeof v === 'string' && v.length > 0 ? v : '';
  const findSessionID = (value: unknown, depth: number): string => {
    if (!value || typeof value !== 'object' || depth > 3) return '';
    const obj = value as Record<string, unknown>;
    const direct = asString(obj.sessionID);
    if (direct) return direct;
    for (const key of ['properties', 'info', 'session']) {
      const found = findSessionID(obj[key], depth + 1);
      if (found) return found;
    }
    return '';
  };
  const sessionID = asString(fallbackSessionID) || findSessionID(data, 0);
  const props = (data.properties ?? {}) as Record<string, unknown>;
  const input = (data.input ?? props.input) as
    {delivery?: unknown; id?: unknown} | undefined;
  const item = (data.item ?? props.item) as
    {delivery?: unknown; id?: unknown} | undefined;
  const id =
    asString(data.inputID) ||
    asString(props.inputID) ||
    asString(data.inboxID) ||
    asString(props.inboxID) ||
    asString(input?.id) ||
    asString(item?.id);
  const implied =
    eventType === 'session.input.queued'
      ? 'queue'
      : eventType === 'session.input.steered'
        ? 'steer'
        : undefined;
  const delivery =
    implied ??
    (input?.delivery === 'queue' || input?.delivery === 'steer'
      ? input.delivery
      : undefined) ??
    (item?.delivery === 'queue' || item?.delivery === 'steer'
      ? item.delivery
      : undefined) ??
    (data.delivery === 'queue' || data.delivery === 'steer'
      ? data.delivery
      : undefined) ??
    (props.delivery === 'queue' || props.delivery === 'steer'
      ? props.delivery
      : undefined);
  return {sessionID, id, delivery};
}

/**
 * Records the delivery mode of a host input/inbox event into the runtime sets,
 * using {@link resolveInputDeliveryFields}. `fallbackSessionID` lets a caller
 * that already knows the session (e.g. the v2 event loop) record payloads that
 * carry no session id of their own.
 */
export function recordEventInputDelivery(
  runtime:
    | {
        queuedInputMessageIDs: Map<string, Set<string>>;
        steeredInputMessageIDs: Map<string, Set<string>>;
      }
    | undefined,
  data: Record<string, unknown>,
  eventType?: string,
  fallbackSessionID?: string,
): void {
  const {sessionID, id, delivery} = resolveInputDeliveryFields(
    data,
    eventType,
    fallbackSessionID,
  );
  recordInputDelivery(runtime, sessionID, id, delivery);
}

/**
 * Removes every per-session delivery-tracking key. Called on session clear and
 * on runtime dispose so stale ids cannot classify messages of a reused session.
 */
export function clearSessionDeliveryState(
  runtime: Pick<
    RuntimeState,
    | 'queuedInputMessageIDs'
    | 'steeredInputMessageIDs'
    | 'surfacedQueuedMessageIDs'
    | 'backgroundBlockedUntil'
    | 'backgroundDeferrals'
    | 'inboxPayloadsByID'
  >,
  sessionID: string,
): void {
  runtime.queuedInputMessageIDs.delete(sessionID);
  runtime.steeredInputMessageIDs.delete(sessionID);
  runtime.surfacedQueuedMessageIDs.delete(sessionID);
  runtime.backgroundBlockedUntil.delete(sessionID);
  runtime.backgroundDeferrals?.delete(sessionID);
  runtime.inboxPayloadsByID?.delete(sessionID);
}

/** Retain an inbox message's text so a later delivery change can promote it. */
export function recordInboxPayload(
  runtime: RuntimeState | undefined,
  sessionID: string,
  id: string,
  payload: {text: string; synthetic: boolean},
): void {
  const store = runtime?.inboxPayloadsByID;
  if (!store || !sessionID || !id || !payload.text) return;
  let byID = store.get(sessionID);
  if (!byID) {
    byID = new Map();
    store.set(sessionID, byID);
  }
  // The per-session cap is the memory bound. No time bound: a turn can run for
  // many minutes before a queued message is promoted, and the text must remain
  // available for as long as the id is still in the delivery sets.
  byID.set(id, {...payload});
  while (byID.size > DELIVERY_SET_CAP) {
    const oldest = byID.keys().next().value;
    if (oldest === undefined) break;
    byID.delete(oldest);
  }
}

/** Read a retained inbox payload without consuming it. */
export function peekInboxPayload(
  runtime: RuntimeState | undefined,
  sessionID: string,
  id: string,
): {text: string; synthetic: boolean} | undefined {
  const payload = runtime?.inboxPayloadsByID?.get(sessionID)?.get(id);
  if (!payload) return undefined;
  return {text: payload.text, synthetic: payload.synthetic};
}

/** Consume a retained inbox payload so a promotion is synthesized at most once. */
export function consumeInboxPayload(
  runtime: RuntimeState | undefined,
  sessionID: string,
  id: string,
): {text: string; synthetic: boolean} | undefined {
  const payload = peekInboxPayload(runtime, sessionID, id);
  runtime?.inboxPayloadsByID?.get(sessionID)?.delete(id);
  return payload;
}

export const runtimeStorage = new AsyncLocalStorage<RuntimeState>();
