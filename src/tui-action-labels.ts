/**
 * Outcome-neutral palette labels and watchdog recovery hints, shared by both companions.
 *
 * A palette action only dispatches a request; until a confirmed effect is
 * observed the label states what was requested, never that it succeeded.
 */

import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';

export type GoalHostKind = 'v1' | 'v2';

/** Commands that modify goal state. Read-only commands do not arm watchdogs. */
const MUTATING_ROOTS = new Set([
  'pause',
  'resume',
  'clear',
  'edit',
  'checkpoint',
  'focus',
  'add',
  'sequence',
  'accept',
  'reject',
  'handback',
  'review-payload',
]);

export function isMutatingGoalCommand(command: string): boolean {
  const root = command.trim().split(/\s+/)[0];
  return MUTATING_ROOTS.has(root);
}

/** Formats an outcome-neutral toast label for a dispatched goal subcommand. */
export function outcomeNeutralLabel(command: string): string {
  const root = command.trim().split(/\s+/)[0];
  return `Goal requested: ${root}`;
}

/**
 * Formats a watchdog timeout message. On v1, includes the slash-command retry
 * alternative; v2 supports palette retries only.
 */
export function watchdogTimeoutMessage(
  host: GoalHostKind,
  command: string,
  timeoutMs: number,
): string {
  const seconds = Math.round(timeoutMs / 1000);
  const shown = seconds < 1 ? '<1s' : `${seconds}s`;
  const root = command.trim().split(/\s+/)[0];
  const retry =
    host === 'v1'
      ? `Retry from the Goal palette or /goal ${root}.`
      : 'Retry from the Goal palette.';
  return `Goal action "${root}" did not land within ${shown}. ${retry}`;
}

/**
 * Notice displayed when user actions cannot take effect because the server plugin
 * has not loaded.
 */
export const DEGRADED_MODE_MESSAGE =
  `${PRODUCT_DISPLAY_NAME} is not loaded: actions from this palette cannot take effect. ` +
  'Check the server plugin loaded, then reopen this palette.';

export interface DegradedModeDetector {
  readonly isDegraded: boolean;

  /** Records that the plugin surface has been observed active. */
  noteSurfaceAlive(): void;

  /**
   * Evaluates dispatch readiness. Returns a one-time degraded notice if the
   * surface has never responded; returns null otherwise to avoid repetitive warnings.
   */
  checkDispatch(): string | null;
}

export function createDegradedModeDetector(): DegradedModeDetector {
  let surfaceAlive = false;
  let announcedThisEpisode = false;
  return {
    noteSurfaceAlive() {
      surfaceAlive = true;
      announcedThisEpisode = false;
    },
    checkDispatch() {
      if (surfaceAlive || announcedThisEpisode) return null;
      announcedThisEpisode = true;
      return DEGRADED_MODE_MESSAGE;
    },
    get isDegraded() {
      return !surfaceAlive;
    },
  };
}

export interface GoalWatchdogs {
  readonly armedCount: number;

  /** Arms (or re-arms) the watchdog for a session and root command pair. */
  arm(sessionID: string, command: string, timeoutMs?: number): void;

  /** Disarms all watchdogs associated with a session. */
  disarmSession(sessionID: string): void;

  /** Cancels a specific command watchdog when dispatch fails immediately. */
  cancel(sessionID: string, command: string): void;
}

/**
 * Creates a shared watchdog tracker managing timers, deduplication, and
 * timeout notifications for dispatched commands.
 */
export function createGoalWatchdogs(
  host: GoalHostKind,
  notifyTimeout: (message: string) => void,
  defaultTimeoutMs = 15000,
): GoalWatchdogs {
  const active = new Map<
    string,
    {timer: ReturnType<typeof setTimeout>; command: string; sessionID: string}
  >();
  const keyOf = (sessionID: string, command: string): string =>
    `${sessionID}:${command.trim().split(/\s+/)[0]}`;
  return {
    arm(sessionID, command, timeoutMs = defaultTimeoutMs) {
      const key = keyOf(sessionID, command);
      const existing = active.get(key);
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        active.delete(key);
        notifyTimeout(watchdogTimeoutMessage(host, command, timeoutMs));
      }, timeoutMs);
      active.set(key, {timer, command, sessionID});
    },
    disarmSession(sessionID) {
      for (const [key, w] of active.entries()) {
        if (w.sessionID === sessionID) {
          clearTimeout(w.timer);
          active.delete(key);
        }
      }
    },
    cancel(sessionID, command) {
      const key = keyOf(sessionID, command);
      const w = active.get(key);
      if (w) {
        clearTimeout(w.timer);
        active.delete(key);
      }
    },
    get armedCount() {
      return active.size;
    },
  };
}
