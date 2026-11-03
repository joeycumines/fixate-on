/**
 * Compaction-loop brake: pauses runnable goals when a session repeatedly triggers
 * compactions within a short window (e.g., fixed-point context growth or repeated failures).
 *
 * This prevents burning tokens on continuations in an unrecoverable compaction cycle.
 * It pauses goals and hands the session back to the user, complementing
 * `experimental.compaction.autocontinue` (which denies the host's automatic continue).
 */
export const COMPACTION_LOOP_THRESHOLD = 4;
export const COMPACTION_LOOP_WINDOW_MS = 5 * 60_000;
export const COMPACTION_LOOP_STOP_REASON = 'compaction loop';
const COMPACTION_LOOP_MAX_ENTRIES = COMPACTION_LOOP_THRESHOLD * 4;

/**
 * Records a compaction settlement (completion or failure) for the session.
 * Prunes expired entries and bounds history size to prevent memory leaks.
 */
export function recordCompactionTimestamp(
  timestamps: Map<string, number[]>,
  sessionID: string,
  now: number,
): void {
  if (!sessionID || !Number.isFinite(now) || now <= 0) return;
  const cutoff = now - COMPACTION_LOOP_WINDOW_MS;
  const recent = (timestamps.get(sessionID) ?? []).filter(t => t > cutoff);
  recent.push(now);
  timestamps.set(sessionID, recent.slice(-COMPACTION_LOOP_MAX_ENTRIES));
}

/**
 * Checks whether the session has settled at least COMPACTION_LOOP_THRESHOLD
 * compactions within the configured window.
 */
export function inCompactionLoop(
  timestamps: Map<string, number[]>,
  sessionID: string,
  now: number,
): boolean {
  const entries = timestamps.get(sessionID);
  if (!entries || entries.length === 0) return false;
  const cutoff = now - COMPACTION_LOOP_WINDOW_MS;
  let count = 0;
  for (const t of entries) {
    if (t > cutoff) count++;
  }
  return count >= COMPACTION_LOOP_THRESHOLD;
}
