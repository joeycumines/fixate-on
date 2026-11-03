/**
 * Deterministic test waits — the alternative to fixed sleeps.
 *
 * the user 2026-09-24 (binding): "If a test flakes under load, it is VERY LIKELY a
 * BAD, poorly-implemented test... ANY sort of flake is DEEPLY undesirable, and
 * deserving of prompt correction, in all cases."
 *
 * A `setTimeout(N)` used to "wait for" an async effect is the canonical bad
 * test: it encodes a guess about scheduling, passes on an idle machine and fails
 * on a loaded one, and — worst of all — asserts nothing about the effect it is
 * supposedly waiting for. It also hides defects: a timer that never fires reads
 * as a pass whenever the assertion after the sleep happens to be satisfied by
 * some other path.
 *
 * `waitFor` polls a PREDICATE and resolves the instant it holds. It cannot pass
 * early (the predicate IS the assertion) and it does not race a deadline (the
 * ceiling is a hang detector, not a timeout to beat).
 *
 * The predicate may be ASYNC, and that is not a convenience — it is a trap the
 * signature used to leave open. An `async => await exists(p)` returns a
 * Promise, and a Promise is truthy, so a ` => boolean` signature silently
 * treated every async predicate as satisfied on the FIRST poll. The wait became a
 * no-op and every caller inherited a flake it could not see. The condition most
 * often waited for here is a filesystem write, which is async, so the trap was the
 * common case rather than an edge one.
 */
export async function waitFor(
  predicate: () => boolean | Promise<unknown>,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  if (await predicate()) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise<void>(r => setTimeout(r, 2));
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
  }
}

/**
 * A promise plus its resolver — for tests that observe a callback landing rather
 * than polling for a condition.
 */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return {promise, resolve};
}
