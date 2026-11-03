/**
 * Toast policy and rate-limiting for goal-store events.
 *
 * Companion clients surface human-readable summaries of goal state transitions
 * rather than raw data envelopes.
 */

import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';
import type {GoalStatus} from './state-machine.ts';
import type {GoalTuiEvent, GoalTuiSnapshot} from './tui-state.ts';
import {
  isLiveYield,
  isSelfResolvingStop,
  isYieldingPause,
  SELF_RESOLVING_STOP_REASONS,
  USER_INTERVENTION_STOP_REASON,
} from './status-label.ts';

/** Upper bound for any rendered toast message to prevent UI truncation. */
export const TOAST_MESSAGE_MAX = 120;

/**
 * Cap on per-session announcement memory to prevent unbounded accumulation
 * in long-running hosts.
 */
const REMEMBERED_LIMIT = 4096;

/** Minimum milliseconds between user-visible toasts per session. */
export const TOAST_MIN_INTERVAL_MS = 2000;

/** Coalescing window: transitions arriving within this span merge into one summary toast. */
export const TOAST_COALESCE_WINDOW_MS = 500;

/** Maximum toasts held during a min-interval window; oldest dropped beyond this. */
export const TOAST_QUEUE_MAX = 3;

export type ToastVariant = 'info' | 'warning' | 'error';

/**
 * Dedicated rate-limiter key for workspace load briefings, using a sentinel prefix
 * to prevent collisions with session IDs.
 */
export const BRIEFING_SESSION_KEY = '\u0000briefing';

export interface CuratedToast {
  title: string;
  message: string;
  variant: ToastVariant;
  /** Goal identifier retained for queue deduplication; stripped before emission. */
  goalId?: string;
}

/** Truncates a long condition or reason string to `max` characters on a word boundary. */
export function truncateCondition(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Determines whether a store event warrants a user-visible toast.
 * Only genuine status changes qualify; events lacking prior status remain silent.
 */
export function shouldToast(event: GoalTuiEvent): boolean {
  switch (event.kind) {
    case 'create':
      return true;
    case 'remove':
      return true;
    case 'usage':
      return false;
    case 'transition':
      return lifecycleSide(event) !== null;
    default:
      return false;
  }
}

/**
 * Indicates which side of the working boundary an event represents: "start", "stop", or null.
 *
 * Returns null for no-op status churn and self-cancelling stops (such as pauses
 * re-armed within a single turn). Events lacking previous status are announced only
 * when the snapshot asserts a conclusive outcome.
 */
export type LifecycleSide = 'start' | 'stop' | null;

export function lifecycleSide(event: GoalTuiEvent): LifecycleSide {
  const status = event.snapshot?.status;
  if (!status) return null;
  const from = previousStatusOf(event);

  if (from !== undefined && from === status) return null;

  if (from === undefined) {
    // Only snapshots declaring a conclusive terminal state are safe to announce without prior history.
    return status === 'active' || status === 'finalizing' ? null : 'stop';
  }
  // Terminal outcomes are announced whenever newly reached from any preceding status.
  if (status === 'complete' || status === 'blocked') return 'stop';
  if (status === 'active') return 'start';
  if (STOPPED_STATUSES.has(status)) {
    return SELF_RESOLVING_STOP_REASONS.has(event.snapshot?.stopReason ?? '')
      ? null
      : 'stop';
  }
  return null;
}

/**
 * Retrieves the goal status immediately preceding this event, if recorded.
 * Broadcaster events provide `transition.from`; disk syncs provide `previousStatus`.
 */
export function previousStatusOf(event: GoalTuiEvent): GoalStatus | undefined {
  return event.previousStatus ?? event.transition?.from;
}

/**
 * Terminal or paused statuses indicating work has ceased.
 * Note: `finalizing` is omitted as it immediately precedes `complete` to prevent duplicate notifications.
 */
const STOPPED_STATUSES: ReadonlySet<GoalStatus> = new Set([
  'paused',
  'blocked',
  'budgetLimited',
  'complete',
]);

/** Determines whether a stop reason represents an automated limit or escalation brake. */
export function isLimitOrEscalationPause(stopReason: string): boolean {
  return /recovery exhausted|escalated|max turns|max stall|max context tokens|budget/i.test(
    stopReason,
  );
}

const LIMIT_PAUSE_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/max turns/i, 'Goal stopped — it reached its turn limit'],
  [/max stall/i, 'Goal stopped — it ran for its time limit without finishing'],
  [/max context tokens/i, 'Goal stopped — it reached its context limit'],
  [/budget/i, 'Goal stopped — its token budget ran out'],
  [
    /recovery exhausted/i,
    'Goal paused after repeated failures — review needed',
  ],
  [/escalated/i, 'Goal escalated — it needs you to decide how to continue'],
];

/** Returns a plain-language explanation for limit or escalation stops, or `null` if inapplicable. */
export function limitPausePhrase(stopReason: string): string | null {
  for (const [pattern, phrase] of LIMIT_PAUSE_PHRASES) {
    if (pattern.test(stopReason)) return phrase;
  }
  return isLimitOrEscalationPause(stopReason)
    ? 'Goal stopped by a limit it reached'
    : null;
}

export {SELF_RESOLVING_STOP_REASONS} from './status-label.ts';

/** Stop reasons for user intervention yields whose subsequent re-arm should not be re-announced. */
export const YIELDING_STOP_REASONS: ReadonlySet<string> = new Set([
  USER_INTERVENTION_STOP_REASON,
]);

const NEEDS_YOU_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/tool surface unavailable/i, 'the goal tools are gone'],
  [
    /verifier:\s*(COMPLETE|NEEDS_INPUT|CANCELLED|BLOCKED|WORKING)/i,
    'a verifier stopped it',
  ],
  [
    /unattested completion asserted repeatedly|no attestation/i,
    'the claim could not be attested',
  ],
  [/judge rejected/i, 'the judge rejected the claim'],
  [/permission rejected/i, 'a permission was rejected'],
  [/session error/i, 'a session error'],
  [/execution (failure|interrupted)|message aborted/i, 'an execution error'],
  [/no tool calls/i, 'no tool calls'],
  [/no progress/i, 'no progress'],
  [/deferred too many times/i, 'deferred too many times'],
  [/compaction loop/i, 'the session is stuck compacting'],
  [/^(paused|explicit pause)$/i, 'paused'],
  [/blocked/i, 'blocked'],
];

/** Matches machine-generated verifier codes or internal IDs rather than conversational phrases. */
const MACHINE_STRING = /[()]|\w+:|[a-z][A-Z]|_/;

/** Translates an internal stop reason into a human-readable explanation. */
export function needsYouReason(stopReason: string): string {
  for (const [pattern, phrase] of NEEDS_YOU_PHRASES) {
    if (pattern.test(stopReason)) return phrase;
  }
  const clean = stopReason.trim();
  if (clean === '' || MACHINE_STRING.test(clean))
    return 'stopped for a reason the plugin did not name';
  return truncateCondition(clean);
}

/** Determines whether a goal is currently halted and requires user intervention to proceed. */
export function goalNeedsTheUser(
  snapshot: GoalTuiSnapshot,
  now?: number,
): boolean {
  const status = snapshot.status;
  if (status === 'active' || status === 'finalizing' || status === 'complete')
    return false;
  if (
    isSelfResolvingStop(
      status,
      snapshot.stopReason,
      snapshot.stoppedAt,
      now ?? Date.now(),
      snapshot.updatedAt,
    )
  )
    return false;
  return true;
}

/** Returns the specific reason why a halted goal is waiting for the user. */
export function reasonForGoal(snapshot: GoalTuiSnapshot, now?: number): string {
  if (snapshot.status === 'blocked') {
    return snapshot.blockedReason
      ? truncateCondition(snapshot.blockedReason, 40)
      : 'blocked';
  }
  // If a yielding pause expires without resuming, report the failure to pick the message back up.
  if (
    isYieldingPause(snapshot.status, snapshot.stopReason) &&
    !isLiveYield(
      snapshot.status,
      snapshot.stopReason,
      snapshot.stoppedAt,
      now ?? Date.now(),
      snapshot.updatedAt,
    )
  ) {
    return 'it did not pick your message back up';
  }
  if (snapshot.status === 'budgetLimited' && !snapshot.stopReason)
    return 'the token budget ran out';
  return needsYouReason(snapshot.stopReason);
}

/**
 * Aggregates all goals requiring user intervention across the workspace into a single summary toast,
 * prioritizing the most frequent stoppage reasons when truncating for length limits.
 */
export function summarizeGoalsNeedingYou(
  snapshots: readonly GoalTuiSnapshot[],
): CuratedToast | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const snapshot of snapshots) {
    if (!goalNeedsTheUser(snapshot)) continue;
    const reason = reasonForGoal(snapshot);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return null;

  // Sort descending by count, then alphabetically, so least common reasons are dropped first.
  const ordered = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const goalWord = total === 1 ? '1 goal needs you' : `${total} goals need you`;
  const budget = TOAST_MESSAGE_MAX - 1;
  const compose = (
    parts: ReadonlyArray<[string, number]>,
    dropped: number,
  ): string => {
    const list = parts
      .map(([reason, count]) => (count > 1 ? `${count} ${reason}` : reason))
      .join(', ');
    const tail = dropped > 0 ? `, +${dropped} more` : '';
    const text = `${goalWord}: ${list}${tail}`;
    return text.length <= TOAST_MESSAGE_MAX
      ? text
      : `${text.slice(0, TOAST_MESSAGE_MAX - 1)}…`;
  };
  let kept = ordered;
  let dropped = 0;
  while (kept.length > 1 && compose(kept, 0).length > budget) {
    const removed = kept[kept.length - 1]!;
    dropped += removed[1];
    kept = kept.slice(0, -1);
  }
  return {
    title: PRODUCT_DISPLAY_NAME,
    variant: 'warning',
    message: compose(kept, dropped),
  };
}

const CLAIM_PLAIN: Record<string, string> = {
  'verified-complete': 'attested',
  'unverifiable-claim': 'completed, but no attestation could be obtained',
  'claim-refuted': 'claimed done, but the evidence said otherwise',
  'blocked-acknowledged': 'stopped with a known blocker',
};

/** Formats a goal store event as a human-readable toast notification. */
export function formatCuratedToast(
  event: GoalTuiEvent,
  startAnnouncement = true,
): CuratedToast {
  const condition = truncateCondition(event.snapshot?.condition ?? 'goal');
  switch (event.kind) {
    case 'create':
      return {
        title: PRODUCT_DISPLAY_NAME,
        variant: 'info',
        message: `Goal started: ${condition}`,
      };
    case 'remove':
      return {
        title: PRODUCT_DISPLAY_NAME,
        variant: 'info',
        message: `Goal cleared: ${truncateCondition(event.snapshot?.condition ?? event.goalId ?? 'goal')}`,
      };
    case 'transition': {
      const status = event.snapshot?.status;
      if (status === 'complete') {
        const outcomeStatus = event.snapshot?.lastClaim?.outcome.status;
        const suffix =
          outcomeStatus && outcomeStatus !== 'verified-complete'
            ? ` (${CLAIM_PLAIN[outcomeStatus] ?? outcomeStatus})`
            : '';
        return {
          title: PRODUCT_DISPLAY_NAME,
          variant: 'info',
          message: `Goal complete: ${condition}${suffix}`,
        };
      }
      if (status === 'blocked') {
        const reason = truncateCondition(
          event.snapshot?.blockedReason ?? 'needs your input',
        );
        return {
          title: PRODUCT_DISPLAY_NAME,
          variant: 'warning',
          message: `Paused — ${reason}`,
        };
      }
      const limitPause = limitPausePhrase(event.snapshot?.stopReason ?? '');
      if (limitPause) {
        return {
          title: PRODUCT_DISPLAY_NAME,
          variant: 'error',
          message: `${limitPause} (${condition})`,
        };
      }
      // Distinguish the initial start from subsequent resumes after human turn-taking.
      if (status === 'active' && startAnnouncement) {
        return {
          title: PRODUCT_DISPLAY_NAME,
          variant: 'info',
          message: `Goal started: ${condition}`,
        };
      }
      if (status === 'active') {
        return {
          title: PRODUCT_DISPLAY_NAME,
          variant: 'info',
          message: `Goal running again: ${condition}`,
        };
      }
      // Non-terminal, non-limit stoppages (stalls, deferrals, execution errors, manual pauses).
      if (status !== undefined && STOPPED_STATUSES.has(status)) {
        return {
          title: PRODUCT_DISPLAY_NAME,
          variant: 'warning',
          message: `Goal stopped — ${needsYouReason(event.snapshot?.stopReason ?? '')} (${condition})`,
        };
      }
      return {
        title: PRODUCT_DISPLAY_NAME,
        variant: 'info',
        message: `Goal update: ${condition}`,
      };
    }
    default:
      return {
        title: PRODUCT_DISPLAY_NAME,
        variant: 'info',
        message: `Goal update: ${condition}`,
      };
  }
}

/**
 * Choke point between store events and toast emission.
 *
 * Implements per-session rate limiting, duplicate suppression, and bounded queuing.
 * Drains lazily on accept/brief/flush. When `autoFlushMs` is configured, runs an internal
 * timer to deliver queued notifications even in the absence of new events.
 */
export class ToastCoalescer {
  private queues = new Map<string, CuratedToast[]>();
  private lastEmittedAt = new Map<string, number>();
  private lastMessageBySession = new Map<
    string,
    {message: string; at: number}
  >();
  /** Tracks active announcements per `session|goal` to avoid duplicate start toasts. */
  private announced = new Set<string>();
  /** Goals paused for user intervention, awaiting resume. */
  private yielding = new Set<string>();
  private pumpTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly emit: (toast: CuratedToast) => void,
    private readonly now: () => number = Date.now,
    private readonly autoFlushMs: number | null = null,
  ) {}

  get queuedCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  /** Ingests store events; filters silent events and handles deduplication state. */
  accept(event: GoalTuiEvent, sessionKey: string): void {
    this.flush();
    const goalId = event.snapshot?.goalId;
    const memoryKey = goalId ? `${sessionKey}|${goalId}` : null;
    const side = lifecycleSide(event);

    if (memoryKey) {
      if (event.kind === 'remove' && event.goalId) {
        this.announced.delete(memoryKey);
        this.yielding.delete(memoryKey);
      } else if (event.kind === 'create') {
        this.claimStartAnnouncement(sessionKey, goalId);
      } else if (
        event.snapshot?.status === 'paused' &&
        YIELDING_STOP_REASONS.has(event.snapshot.stopReason)
      ) {
        // Track yields prior to emission checks so subsequent resumes can be identified and silenced.
        this.yielding.add(memoryKey);
        this.pruneRemembered();
      }
    }
    let firstTime = false;
    if (!shouldToast(event)) return;
    if (side === 'start' && memoryKey) {
      if (this.yielding.has(memoryKey)) {
        this.yielding.delete(memoryKey);
        return;
      }
    }
    if (side === 'start' && goalId)
      firstTime = this.claimStartAnnouncement(sessionKey, goalId);
    this.enqueue(sessionKey, formatCuratedToast(event, firstTime), goalId);
  }

  /** Dispatches an explicitly composed toast (such as workspace load briefings). */
  brief(sessionKey: string, toast: CuratedToast): void {
    this.flush();
    this.enqueue(sessionKey, toast, undefined);
  }

  /**
   * Flushes queued toasts whose minimum interval has elapsed.
   * Sessions are evaluated independently so pending delays in one session do not block others.
   */
  flush(): void {
    for (const [sessionKey, queue] of [...this.queues]) {
      while (queue.length > 0) {
        const nowTs = this.now();
        if (nowTs - this.emittedAtFor(sessionKey) < TOAST_MIN_INTERVAL_MS)
          break;
        const next = queue.shift();
        if (!next) break;
        this.emitNow(sessionKey, next, nowTs);
      }
      if (queue.length === 0) this.queues.delete(sessionKey);
    }
  }

  startAutoFlush(): void {
    if (this.pumpTimer || this.autoFlushMs === null) return;
    this.pumpTimer = setInterval(() => this.flush(), this.autoFlushMs);
    if (
      typeof this.pumpTimer === 'object' &&
      this.pumpTimer !== null &&
      'unref' in this.pumpTimer
    ) {
      (this.pumpTimer as unknown as {unref: () => void}).unref();
    }
  }

  stopAutoFlush(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  /**
   * Records initial start announcement for a goal.
   * Returns true on first announcement ("Goal started"), false on subsequent resumptions ("Goal running again").
   */
  private claimStartAnnouncement(
    sessionKey: string,
    goalId: string | undefined,
  ): boolean {
    if (!goalId) return true;
    const key = `${sessionKey}|${goalId}`;
    if (this.announced.has(key)) return false;
    this.announced.add(key);
    this.pruneRemembered();
    return true;
  }

  /** Enforces bounded memory limits across announcement and yielding tracking sets. */
  private pruneRemembered(): void {
    while (this.announced.size + this.yielding.size > REMEMBERED_LIMIT) {
      const oldest = this.announced.values().next();
      if (!oldest.done) {
        this.announced.delete(oldest.value);
        continue;
      }
      // If announced set is empty but memory still exceeds the cap, evict oldest yield.
      const oldestYield = this.yielding.values().next();
      if (oldestYield.done) return;
      this.yielding.delete(oldestYield.value);
    }
  }

  private enqueue(
    sessionKey: string,
    toast: CuratedToast,
    goalId: string | undefined,
  ): void {
    // Suppress identical messages within the coalescing window for this session.
    const last = this.lastMessageBySession.get(sessionKey);
    if (
      last &&
      toast.message === last.message &&
      this.now() - last.at < TOAST_COALESCE_WINDOW_MS
    ) {
      return;
    }
    this.lastMessageBySession.set(sessionKey, {
      message: toast.message,
      at: this.now(),
    });

    const nowTs = this.now();
    if (nowTs - this.emittedAtFor(sessionKey) >= TOAST_MIN_INTERVAL_MS) {
      this.emitNow(sessionKey, toast, nowTs);
      return;
    }
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = [];
      this.queues.set(sessionKey, queue);
    }
    if (goalId) {
      // Replace stale pending moments for the same goal with the latest event.
      const staleAt = queue.findIndex(queued => queued.goalId === goalId);
      if (staleAt >= 0) queue.splice(staleAt, 1);
    }
    queue.push({...toast, goalId});
    if (queue.length > TOAST_QUEUE_MAX) {
      queue.shift();
    }
  }

  private emittedAtFor(sessionKey: string): number {
    return this.lastEmittedAt.get(sessionKey) ?? Number.NEGATIVE_INFINITY;
  }

  private emitNow(
    sessionKey: string,
    toast: CuratedToast,
    nowTs: number,
  ): void {
    let final = toast;
    if (final.message.length > TOAST_MESSAGE_MAX) {
      final = {
        ...final,
        message: `${final.message.slice(0, TOAST_MESSAGE_MAX - 1)}…`,
      };
    }
    this.lastEmittedAt.set(sessionKey, nowTs);
    const {goalId: _goalId, ...visible} = final;
    this.emit(visible);
  }
}
