/**
 * Event-driven truth channels for the TUI companion:
 * - Disk-refresh polling loop for mid-turn progress (`state.json`)
 * - Curated lifecycle toasts with auto-flush coalescing
 * - Initial state briefing for goals needing attention
 * - Tool metadata subscription decoding goal events from tool results
 */

import {
  decodeGoalToolMetadata,
  type GoalTuiEventKind,
  type TuiStateStore,
} from './tui-state.ts';
import type {GoalStatus} from './state-machine.ts';
import {createDiskRefreshLoop} from './tui-companion-refresh.ts';
import {
  BRIEFING_SESSION_KEY,
  summarizeGoalsNeedingYou,
  ToastCoalescer,
} from './tui-toast-policy.ts';
import {soundForEvent} from './tui-sound.ts';
import {createDegradedModeDetector} from './tui-action-labels.ts';
import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';

/** Minimal host surface the event wiring consumes. */
export interface V2EventContext {
  data: {on: (event: string, handler: (event: unknown) => void) => () => void};
  ui: {
    toast: {
      show: (opts: {
        variant?: string;
        title: string;
        message: string;
        duration?: number;
      }) => void;
    };
  };
  attention: {
    notify: (opts: {
      message: string;
      sound?: {name: string; when: string};
      notification: boolean;
    }) => Promise<unknown>;
  };
}

export interface V2EventWiring {
  dispose: () => void;
}

export function wireV2Events(args: {
  context: V2EventContext;
  store: TuiStateStore;
  stateRoot: string | undefined;
  resolveWorkspaceDir: () => Promise<string | undefined>;
  ensureHydrated: () => Promise<void>;
  disarmWatchdogs: (sessionID: string) => void;
  dashboardRouteDispose: (() => void) | null;
  activeWatchdogs: Map<string, {timer: ReturnType<typeof setTimeout>}>;
  log: (level: string, message: string) => void;
}): V2EventWiring {
  const {
    context,
    store,
    stateRoot,
    resolveWorkspaceDir,
    ensureHydrated,
    disarmWatchdogs,
    dashboardRouteDispose,
    activeWatchdogs,
    log,
  } = args;

  const playSound = (kind: GoalTuiEventKind, status?: string): void => {
    const name = soundForEvent(kind, status as GoalStatus | undefined);
    if (!name) return;
    try {
      void context.attention
        .notify({
          message: `Goal ${kind}${status ? ` → ${status}` : ''}`,
          sound: {name, when: 'always'},
          notification: false,
        })
        .catch(() => {});
    } catch {
      // Best-effort notification; host attention service may be unavailable.
    }
  };

  // The metadata channel only fires when a goal tool executes. Between goal creation
  // and completion, the agent calls host tools (read, bash, etc.) whose success events
  // carry no goal metadata. Consequently, buffered turn/usage updates would stall without
  // an additional truth channel.
  //
  // Polling `state.json` provides mid-turn diffs because it is written on every continuation.
  // Both channels update the store, where revision monotonicity guards against duplicates.
  //
  // We defer starting the disk loop until `resolveWorkspaceDir` succeeds because the workspace
  // path is synced asynchronously by the host; falling back to cwd risks reading foreign goals.
  let diskLoop: ReturnType<typeof createDiskRefreshLoop> | null = null;
  let disposed = false;

  // Toast notifications alert the user to goal lifecycle transitions without requiring
  // them to manually open the dashboard. Uses ToastCoalescer to de-duplicate and throttle
  // rapid bursts of events.
  const coalescer = new ToastCoalescer(
    toast => {
      try {
        context.ui.toast.show({
          variant: toast.variant,
          title: PRODUCT_DISPLAY_NAME,
          message: toast.message,
          duration: 5000,
        });
      } catch {
        // Host may be shutting down; toasts are additive, never load-bearing.
      }
    },
    Date.now,
    500, // autoFlushMs: ensure queued notifications deliver even if no subsequent event arrives
  );
  coalescer.startAutoFlush();
  let briefingFired = false;

  /** Emits a single briefing summarizing pending goals on first load once state is hydrated. */
  const briefIfNeeded = (): void => {
    if (briefingFired || disposed) return;
    briefingFired = true;
    const briefing = summarizeGoalsNeedingYou(store.getAllSnapshots());
    if (!briefing) return;
    log('info', `Briefing: ${briefing.message}`);
    coalescer.brief(BRIEFING_SESSION_KEY, briefing);
  };

  const startDiskLoop = async (): Promise<void> => {
    if (diskLoop || disposed) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (disposed) return;
      const dir = await resolveWorkspaceDir();
      if (dir) {
        diskLoop = createDiskRefreshLoop({
          directory: dir,
          // Use the configured stateRoot so polling matches the directory where the
          // plugin persists state, preventing the dashboard from going stale after boot.
          stateRoot,
          store,
          intervalMs: 1000,
          onEvent: event => {
            if (disposed) return;
            // Audio cue matches the toast notification to maintain parity across hosts.
            playSound(event.kind, event.snapshot?.status);
            coalescer.accept(event, event.sessionID);
          },
        });
        diskLoop.start();
        log('info', `disk-refresh loop started (dir=${dir})`);
        // The disk loop's first tick establishes a silent baseline. Running an explicit
        // hydration ensures the store has valid data before the initial briefing runs.
        await ensureHydrated();
        briefIfNeeded();
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    log(
      'info',
      'disk-refresh loop: workspace directory never resolved; loop not started',
    );
  };
  void startDiskLoop();

  // Goal tools attach buffered GoalTuiEvents to their result metadata. The host core
  // re-emits this under `session.tool.success`, which we subscribe to here to decode
  // and apply events directly to the store.
  const degraded = createDegradedModeDetector();
  let unsub: (() => void) | null = null;
  try {
    unsub = context.data.on('session.tool.success', (event: unknown) => {
      try {
        const evData = (
          event as
            | {
                data?: {sessionID?: string; tool?: string; metadata?: unknown};
              }
            | null
            | undefined
        )?.data;
        if (
          evData?.sessionID &&
          (evData.tool === 'goal-command' ||
            (typeof evData.tool === 'string' && evData.tool.endsWith('_goal')))
        ) {
          disarmWatchdogs(evData.sessionID);
        }
        const meta = evData?.metadata;
        const events = decodeGoalToolMetadata(meta);
        if (!events) return;
        // Decoded goal events confirm the plugin is active and publishing.
        degraded.noteSurfaceAlive();
        for (const parsed of events) {
          disarmWatchdogs(parsed.sessionID);
          store.applyEvent(parsed);
          playSound(parsed.kind, parsed.snapshot?.status);
        }
      } catch (err) {
        log(
          'error',
          `Event error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  } catch (err) {
    log(
      'error',
      `Subscribe error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    dispose: () => {
      disposed = true;
      if (unsub) {
        try {
          unsub();
        } catch {
          // Best-effort unsubscription
        }
      }
      if (diskLoop) diskLoop.stop();
      coalescer.stopAutoFlush();
      for (const w of activeWatchdogs.values()) {
        clearTimeout(w.timer);
      }
      activeWatchdogs.clear();
      if (dashboardRouteDispose) {
        try {
          dashboardRouteDispose();
        } catch {
          // Best-effort cleanup
        }
      }
    },
  };
}
