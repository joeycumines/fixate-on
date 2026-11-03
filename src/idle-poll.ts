/**
 * Wall-clock fallback timer for host environments that do not emit idle events.
 * Manages interval scheduling and serializes ticks to prevent overlapping sweeps.
 */

export interface IdlePoller {
  start(): void;
  stop(): void;
}

export function createIdlePoller(
  intervalMs: number,
  tick: () => Promise<void>,
): IdlePoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const runTick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch {
      // Individual tick failures must not terminate the poller loop.
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => void runTick(), intervalMs);
      // Allow process exit even if timer is active.
      (timer as unknown as {unref?: () => void}).unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

export interface QuietWindow {
  key: string;
  since: number;
}

/**
 * Stability gate for synthetic idle polling: fires only when the latest message
 * fingerprint has remained unchanged for at least `quietMs`.
 * A changed fingerprint indicates an active turn and resets the window.
 */
export function evaluateQuietWindow(
  prev: QuietWindow | undefined,
  now: number,
  key: string,
  quietMs: number,
): {fire: boolean; next: QuietWindow} {
  if (!prev || prev.key !== key) {
    return {fire: false, next: {key, since: now}};
  }
  if (now - prev.since < quietMs) {
    return {fire: false, next: prev};
  }
  return {fire: true, next: {key, since: now}};
}
