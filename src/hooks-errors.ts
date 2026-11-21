/**
 * Determines whether a prompt failure indicates that the owning session no longer exists.
 *
 * When a session has been deleted, the host returns a permanent not-found error
 * rather than a transient fault (e.g., HTTP 404 `NotFoundError` or `SessionNotFoundError`).
 *
 * This recognition rule preserves the retry bound to guard against transient not-found
 * responses during host restarts, but allows reporting a specific missing-session error
 * to the user instead of a generic transient failure.
 */
export function isSessionGoneError(error: unknown): boolean {
  const visited = new Set<object>();
  for (let depth = 0; depth < 4; depth++) {
    if (!error || typeof error !== 'object' || visited.has(error)) return false;
    visited.add(error);
    const detail = error as {
      name?: unknown;
      _tag?: unknown;
      message?: unknown;
      data?: {message?: unknown};
      cause?: unknown;
    };
    const nonEmpty = (value: unknown): string =>
      typeof value === 'string' && value.length > 0 ? value : '';
    // Check name and _tag independently: a generic name ('Error') must not
    // mask a typed tag, and an empty message must not mask data.message.
    const names = [nonEmpty(detail.name), nonEmpty(detail._tag)];
    const messages = [nonEmpty(detail.message), nonEmpty(detail.data?.message)];
    if (
      names.some(
        n =>
          /notfound|sessionnotfound/i.test(n) ||
          (/session/i.test(n) && /not.*found/i.test(n)),
      )
    )
      return true;
    if (
      messages.some(m =>
        /session\s+(?:not\s+found|no\s+longer\s+exists|does\s+not\s+exist|deleted|expired)/i.test(
          m,
        ),
      )
    )
      return true;
    // HTTP SDK errors retain their typed response in Error.cause. Inspect it
    // rather than relying on a generic 404 or the wrapper's display message.
    error = detail.cause;
  }
  return false;
}

/**
 * Determines whether an error indicates the session is busy or queued and should
 * be deferred rather than treated as a prompt failure.
 *
 * Treating busy sessions as failures would increment failure counts and eventually
 * pause the goal prematurely. Deferring allows retrying on the next idle cycle.
 */
export function isDeferError(
  error: {name?: string; message?: string} | undefined,
): boolean {
  if (!error) return false;
  const name = (error.name ?? '').toLowerCase();
  const msg = (error.message ?? '').toLowerCase();
  const hay = `${name} ${msg}`;
  // Permanent failure phrasings containing busy-like words (e.g., "model not active",
  // "account inactive") must be classified as failures, not deferrals.
  if (
    /not\s+active|inactive|deactivat|unauthorized|forbidden|invalid\s+api/.test(
      hay,
    )
  )
    return false;
  return (
    /\bdeferred\b/.test(hay) ||
    /\breserved\b/.test(hay) ||
    /already\s+running/.test(hay) ||
    /\bbusy\b/.test(hay) ||
    /\bin\s+progress\b/.test(hay) ||
    /\bqueued\b/.test(hay)
  );
}
