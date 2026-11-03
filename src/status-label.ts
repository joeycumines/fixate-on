// Turns a goal's state into a human-readable label.
//
// A `paused` goal can be halted by a brake, stalled by absent progress,
// paused by the user, or yielding to a human turn and scheduled to re-arm.
// Distinguishing these states prevents ambiguous "paused" displays.

/** The stopReason a yield-to-the-human pause carries. */
export const USER_INTERVENTION_STOP_REASON = 'user intervention';

/**
 * Stops that the plugin resolves automatically.
 *
 * A goal in one of these states resumes on its own; running `/goal resume`
 * manually would inadvertently reset the goal's turn count to zero.
 *
 * - "recovery": re-armed on the first idle after hydration
 * - "user intervention": re-armed when the user's turn ends
 * - "queued": ordered sequence position; started via auto-promote
 *
 * Located here because `status-label.ts` is a leaf module shared between the
 * server and TUI, ensuring both sides stay synchronized without duplicate lists.
 */
export const SELF_RESOLVING_STOP_REASONS: ReadonlySet<string> = new Set([
  'recovery',
  'user intervention',
  'queued',
]);

/**
 * Maximum duration (15 minutes) a yield promise is considered valid before
 * the plugin stops assuming it will re-arm automatically.
 *
 * Yields are applied on every human message and re-armed on idle. The bound is
 * evaluated against persisted `stoppedAt` so restarts do not reset elapsed wait time.
 */
export const YIELD_PROMISE_MS = 15 * 60_000;

/**
 * Determines whether a yield has been outstanding long enough that it can no
 * longer honestly be expected to re-arm on its own.
 *
 * Distinct from `isYieldingPause`, which only checks the goal's `stopReason`.
 * This checks temporal validity so stuck yields are not reported as perpetually pending.
 *
 * An absent or zero timestamp indicates the goal is not currently waiting.
 */
export function isYieldPastPromise(
  stoppedAt: number | undefined,
  now: number,
  promiseMs = YIELD_PROMISE_MS,
  updatedAt?: number,
): boolean {
  // Goals written before `stoppedAt` existed lack a stop timestamp.
  // Fall back to `updatedAt` (written on each transition) so legacy stuck yields
  // do not appear perpetually active.
  const since = stoppedAt && stoppedAt > 0 ? stoppedAt : updatedAt;
  if (!since || since <= 0) return false;

  // Future timestamps (clock skew or file corruption) are treated as immediately overdue.
  if (since > now) return true;
  return now - since >= promiseMs;
}

/**
 * Whether this stopped goal will resume without user intervention.
 *
 * Only applies when `status === "paused"`. The yield stop reason has an expiration
 * deadline via `isYieldPastPromise`; "recovery" and "queued" re-arm on idle or
 * promotion and do not expire.
 *
 * @param stoppedAt The stop instant (`stoppedAt`), not the elapsed clock (`pausedAt`).
 * @param now Defaults to Date.now(); caller can provide for deterministic testing or off-disk inspection.
 */
export function isSelfResolvingStop(
  status: string,
  stopReason: string | undefined,
  stoppedAt?: number,
  now: number = Date.now(),
  updatedAt?: number,
): boolean {
  if (status !== 'paused') return false;
  if (!SELF_RESOLVING_STOP_REASONS.has(stopReason ?? '')) return false;
  if (
    stopReason === USER_INTERVENTION_STOP_REASON &&
    isYieldPastPromise(stoppedAt, now, YIELD_PROMISE_MS, updatedAt)
  )
    return false;
  return true;
}

/**
 * Whether a pause is a yield to the human rather than an explicit halt.
 * Yields are transient and re-arm when the human turn completes.
 */
export function isYieldingPause(status: string, stopReason: string): boolean {
  return status === 'paused' && stopReason === USER_INTERVENTION_STOP_REASON;
}

/**
 * Whether a pause still holds its re-arm promise. A goal can still be
 * yielding (parked on `user intervention`) after the promise expired.
 *
 * @param stoppedAt The stop instant (`GoalState.stoppedAt`), not `pausedAt`.
 */
export function isLiveYield(
  status: string,
  stopReason: string,
  stoppedAt?: number,
  now?: number,
  updatedAt?: number,
): boolean {
  if (!isYieldingPause(status, stopReason)) return false;
  return !isYieldPastPromise(
    stoppedAt,
    now ?? Date.now(),
    YIELD_PROMISE_MS,
    updatedAt,
  );
}

/**
 * Short status tag for list rows (e.g. "paused: yielding").
 * Other stop reasons pass through the status unchanged.
 *
 * @param stoppedAt The stop instant (`GoalState.stoppedAt`), not `pausedAt`.
 */
export function statusTag(
  status: string,
  stopReason: string,
  stoppedAt?: number,
  now?: number,
  updatedAt?: number,
): string {
  return isLiveYield(status, stopReason, stoppedAt, now, updatedAt)
    ? 'paused: yielding'
    : status;
}

/**
 * Detailed stop reason label for detail cards explaining current state and next step.
 *
 * @param stoppedAt The stop instant (`GoalState.stoppedAt`), not `pausedAt`.
 */
export function stopReasonLabel(
  stopReason: string,
  status?: string,
  stoppedAt?: number,
  now?: number,
  updatedAt?: number,
): string {
  if (stopReason !== USER_INTERVENTION_STOP_REASON) return stopReason;
  if (
    status !== undefined &&
    !isLiveYield(status, stopReason, stoppedAt, now, updatedAt)
  ) {
    return 'yielding to your message; did not re-arm';
  }
  return 'yielding to your message; re-arms automatically';
}
