/**
 * V1 companion truth loop over persisted disk state.
 *
 * The v1 server does not publish events via client.tui.publish, as every envelope
 * there renders as an on-screen toast. The companion polls persisted state files,
 * diffs snapshot revisions, and synthesizes GoalTuiEvents to maintain store state
 * and trigger curated toasts.
 */

import {readDiskGoalSnapshots} from './tui-disk-state.ts';
import type {
  GoalTuiEvent,
  GoalTuiSnapshot,
  TuiStateStore,
} from './tui-state.ts';

export interface DiskRefreshLoopOptions {
  /**
   * Root directory containing `<directory>/<stateRoot>/sessions/<sessionID>/state.json`.
   * Defaults to process.cwd.
   */
  directory?: string;

  /**
   * Explicit path to a single state file. Overrides stateRoot resolution.
   *
   * Note: Single-file mode bypasses session directory discovery. If the target file
   * contains no goals, remove events are omitted to prevent generating false "Goal cleared"
   * events without verifiable session context.
   */
  explicitPath?: string;

  /**
   * Configured state root relative path (e.g. ".opencode/goals").
   * @default ".opencode/goals"
   */
  stateRoot?: string;

  /** Polling interval in milliseconds. @default 1000 */
  intervalMs?: number;

  store: TuiStateStore;

  /** Callback invoked for each synthesized event after applying to the store. */
  onEvent: (event: GoalTuiEvent) => void;
}

export interface DiskRefreshLoop {
  start: () => void;
  stop: () => void;

  /**
   * Executes a single refresh tick and awaits disk completion.
   * Provides deterministic synchronization for tests without arbitrary timeouts.
   */
  tick: () => Promise<void>;

  /**
   * Pre-seeds the baseline snapshot from an early disk read to prevent pre-existing
   * goals from emitting spurious "create" events during startup.
   */
  seedBaseline: (snapshots: GoalTuiSnapshot[]) => void;
}

/**
 * Composite diff key scoped by session to prevent cross-session ID collisions.
 */
function keyOf(sessionID: string, goalId: string): string {
  return `${sessionID}\u0000${goalId}`;
}

/**
 * Polling loop that diffs persisted disk snapshots against previous state
 * and dispatches synthetic lifecycle events (create, transition, remove).
 */
export function createDiskRefreshLoop(
  options: DiskRefreshLoopOptions,
): DiskRefreshLoop {
  const {store, onEvent} = options;
  const intervalMs = options.intervalMs ?? 1000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let baselined = false;
  let previous = new Map<string, GoalTuiSnapshot>();

  function synthesize(
    current: GoalTuiSnapshot[],
    readableSessions: ReadonlySet<string>,
  ): GoalTuiEvent[] {
    const events: GoalTuiEvent[] = [];
    const seen = new Set<string>();
    for (const snap of current) {
      const key = keyOf(snap.sessionID, snap.goalId);
      seen.add(key);
      const prev = previous.get(key);
      if (!prev) {
        events.push({
          kind: 'create',
          sessionID: snap.sessionID,
          timestamp: Date.now(),
          snapshot: {...snap, origin: 'disk'},
        });
      } else if (
        prev.revision !== snap.revision ||
        prev.status !== snap.status ||
        prev.totalTokens !== snap.totalTokens ||
        prev.turnCount !== snap.turnCount
      ) {
        // High-frequency token/turn updates do not bump the revision server-side.
        // The store's monotonicity check only rejects strictly lower revisions, so
        // same-revision updates are accepted. Do not fabricate revision increments,
        // which would cause subsequent genuine server updates to be rejected as stale.
        events.push({
          kind: 'transition',
          sessionID: snap.sessionID,
          timestamp: Date.now(),
          snapshot: {...snap, origin: 'disk'},
          // Persisted snapshots do not record previous status; supplying it from
          // the diff allows consumers to detect status transitions.
          previousStatus: prev.status,
        });
      }
    }
    for (const [key, prev] of previous) {
      if (seen.has(key)) continue;
      // Absence indicates deletion only if the session's file was successfully read
      // this tick. If a file is unreadable or missing, retain its goals to avoid false
      // removal events caused by transient I/O issues or torn writes.
      if (!readableSessions.has(prev.sessionID)) continue;
      events.push({
        kind: 'remove',
        sessionID: prev.sessionID,
        goalId: prev.goalId,
        timestamp: Date.now(),
      });
    }
    return events;
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const read = await readDiskGoalSnapshots(
        options.directory,
        options.explicitPath,
        options.stateRoot,
      );
      if (!baselined) {
        // Baseline only on a readable workspace or when the state directory is absent.
        // A transiently unreadable file must not be treated as empty, which would cause
        // the subsequent read to emit false "create" events for existing goals.
        if (read.filesRead === 0 && !read.stateDirMissing) return;
        baselined = true;
        previous = new Map(
          read.snapshots.map(s => [keyOf(s.sessionID, s.goalId), s]),
        );
        return;
      }

      // If no files could be read this tick (e.g. torn write or atomic replacement window),
      // preserve the baseline rather than assuming all goals were deleted.
      if (read.filesRead === 0 && previous.size > 0) return;
      for (const event of synthesize(read.snapshots, read.readableSessions)) {
        if (event.snapshot || event.goalId) store.applyEvent(event);
        onEvent(event);
      }

      // Preserve goals from sessions whose files were not readable this tick.
      // Iterating oldPrevious ensures unread sessions are not lost when rebuilding previous.
      const oldPrevious = previous;
      previous = new Map(
        read.snapshots.map(s => [keyOf(s.sessionID, s.goalId), s]),
      );
      for (const [key, snap] of oldPrevious) {
        if (!read.readableSessions.has(snap.sessionID) && !previous.has(key)) {
          previous.set(key, snap);
        }
      }
    } catch {
      // On unexpected read failure, retain existing state and retry on next tick.
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    seedBaseline(snapshots: GoalTuiSnapshot[]) {
      baselined = true;
      previous = new Map(snapshots.map(s => [keyOf(s.sessionID, s.goalId), s]));
    },
    start() {
      if (timer) return;
      if (!baselined) void tick();
      timer = setInterval(() => void tick(), intervalMs);
      // Do not keep the host event loop alive solely for background polling.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as unknown as {unref: () => void}).unref();
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
