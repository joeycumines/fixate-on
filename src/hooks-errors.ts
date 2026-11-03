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
export function isSessionGoneError(
  error: {name?: string; message?: string} | undefined,
): boolean {
  if (!error) return false;
  const name = (error.name ?? '').toLowerCase();
  const msg = (error.message ?? '').toLowerCase();
  if (/notfound|sessionnotfound/.test(name)) return true;
  return /session\s+(?:not\s+found|no\s+longer\s+exists|does\s+not\s+exist|deleted|expired)/.test(
    msg,
  );
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
