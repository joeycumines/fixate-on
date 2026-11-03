/**
 * v2 TUI companion entrypoint.
 *
 * Exports the plugin object initialized by the opencode2 host: hydrate,
 * wire the keymap, register the route, subscribe, and dispose — in that order.
 * Subscribing before hydrating would cause pre-existing disk goals to be
 * falsely announced as newly added goals.
 */

import {
  createTuiStateStore,
  GOAL_TUI_EVENT_TITLE,
  type GoalTuiSnapshot,
} from './tui-state.ts';
import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';
import {hydrateStoreFromDisk} from './tui-disk-state.ts';
import {
  dashboardFooterText,
  dashboardGoalActions,
  formatGoalStatusDashboard,
  resolveFocusedGoalId,
} from './tui-views.ts';
import {
  createDegradedModeDetector,
  outcomeNeutralLabel,
  watchdogTimeoutMessage,
} from './tui-action-labels.ts';
import {DashboardRoute, type HostTheme} from './tui-dashboard-route.tsx';
import {createSignal, onCleanup} from 'solid-js';
import {type V2EventContext, wireV2Events} from './tui-v2-events.ts';

// Minimal Context interface consumed by the plugin until @opencode-ai/plugin/tui
// is officially published. Unknown-shaped fields are typed as `unknown` and narrowed at use sites.

interface V2KeymapCommand {
  id?: string;
  title?: string;
  description?: string;
  group?: string;
  enabled?: boolean | (() => boolean);
  bind?: false | string;
  palette?: true;
  slash?: {name: string; aliases?: string[]; arguments?: true};
  run: (input?: string, event?: unknown) => void | false | Promise<void>;
}

interface V2Context {
  readonly options: Readonly<Record<string, unknown>>;
  /**
   * Current workspace location (`host.location.current`).
   * Used as a fallback to auto-create a session if a palette goal action is triggered
   * when no session is active (e.g., from the welcome screen).
   */
  readonly location?: {directory: string; workspaceID?: string};
  readonly client: {
    session: {
      synthetic(params: {
        sessionID: string;
        text: string;
        description?: string;
        delivery?: string;
        resume?: boolean;
      }): Promise<unknown>;
      command(params: {
        sessionID: string;
        command: string;
        arguments: string;
      }): Promise<unknown>;
      create(params: {
        id?: string;
        title?: string;
        agent?: string;
        model?: unknown;
        location: {directory: string; workspaceID?: string};
      }): Promise<unknown>;
    };
  };
  readonly keymap: {
    layer(
      input: () => {
        mode?: string;
        enabled?: boolean | (() => boolean);
        priority?: number;
        commands?: ReadonlyArray<V2KeymapCommand>;
        bindings?: ReadonlyArray<{key: string; cmd: string}>;
      },
    ): void;
  };
  readonly theme?: unknown;
  readonly ui: {
    readonly dialog: {
      show(render: () => unknown, onClose?: () => void): void;
      set(options: {size?: string; centered?: boolean}): void;
      clear(): void;
      alert(opts: {title: string; message: string}): Promise<void>;
      confirm(opts: {
        title: string;
        message: string;
        label?: {confirm?: string; cancel?: string};
      }): Promise<boolean | undefined>;
      prompt(opts: {
        title: string;
        description?: string;
        placeholder?: string;
        value?: string;
      }): Promise<string | undefined>;
      select<V>(opts: {
        title: string;
        placeholder?: string;
        options: ReadonlyArray<{
          title: string;
          value: V;
          description?: string;
          category?: string;
          disabled?: boolean;
        }>;
        current?: V;
      }): Promise<V | undefined>;
    };
    readonly toast: {
      show(opts: {
        title?: string;
        message: string;
        variant?: string;
        duration?: number;
      }): void;
    };
    readonly router: {
      register(page: {
        name: string;
        render: (input: {data?: Record<string, unknown>}) => unknown;
      }): () => void;
      navigate(
        dest:
          | {
              type: string;
              id?: string;
              name?: string;
              data?: Record<string, unknown>;
            }
          | {type: 'home'}
          | {
              type: 'session';
              sessionID: string;
            },
      ): void;
      current(): {type: string; sessionID?: string; name?: string};
    };
    readonly tabs?: {
      enabled(): boolean;
      open(sessionID: string): boolean;
    };
    readonly format: {path(value: string): string};
  };
  readonly data: {
    on(type: string, handler: (event: unknown) => void): () => void;
  };
  readonly attention: {
    notify(opts: {
      title?: string;
      message: string;
      notification?: boolean | {when?: string};
      sound?: boolean | {name?: string; volume?: number; when?: string};
    }): Promise<{
      ok: boolean;
      notification: boolean;
      sound: boolean;
      skipped?: string;
    }>;
  };
}

const GOAL_PREFIX = 'ctrl+shift+g';

/**
 * Creates a keybinding chord (`ctrl+shift+g <actionKey>`).
 * Note: 's' is deliberately avoided because the host reserves `<leader>s` for status.
 */
function chord(actionKey: string): string {
  return `${GOAL_PREFIX} ${actionKey}`;
}

/**
 * Extracts `.directory` from a host response, handling both raw objects
 * and `{ data: ... }` response envelopes.
 */
function unwrapDirectory(out: unknown): string | undefined {
  if (!out || typeof out !== 'object') return undefined;
  const direct = out as {
    directory?: unknown;
    location?: {directory?: unknown};
    data?: unknown;
  };
  if (typeof direct.directory === 'string' && direct.directory)
    return direct.directory;
  if (direct.location && typeof direct.location === 'object') {
    const l = direct.location as {directory?: unknown};
    if (typeof l.directory === 'string' && l.directory) return l.directory;
  }
  if (direct.data && typeof direct.data === 'object')
    return unwrapDirectory(direct.data);
  return undefined;
}

export const GoalTuiPluginV2 = {
  id: 'fixate-on-tui',

  async setup(context: V2Context) {
    // When loaded through the server plugin path, keymap/ui/data are unavailable.
    // Return a no-op cleanup early and only perform setup in the TUI context.
    if (!context.keymap || typeof context.keymap.layer !== 'function') {
      return () => {};
    }

    const opts = {
      logLevel: (context.options?.logLevel as string) ?? 'info',
      // State root directory shared between the server plugin and this companion.
      stateRoot: context.options?.stateRoot as string | undefined,
      // When running from source (e.g., `bun run dev`), the host process cwd points
      // to the source checkout rather than the workspace opened by the user.
      // Use workspaceDirectory to ensure disk operations match the server plugin's directory.
      workspaceDirectory:
        typeof context.options?.workspaceDirectory === 'string' &&
        context.options.workspaceDirectory.trim()
          ? context.options.workspaceDirectory.trim()
          : undefined,
    };

    const store = createTuiStateStore();

    const activeSessionID = (): string | null => {
      const route = context.ui.router.current();
      if (route.type !== 'session' || !route.sessionID) return null;
      return route.sessionID;
    };

    const log = (level: string, message: string) => {
      if (opts.logLevel === 'error' && level !== 'error') return;
      if (opts.logLevel === 'info' && level === 'debug') return;
      try {
        if (level === 'error') {
          context.ui.toast.show({
            variant: 'error',
            title: PRODUCT_DISPLAY_NAME,
            message,
            duration: 6000,
          });
        }
        console[level === 'error' ? 'error' : 'log'](
          `[${GOAL_TUI_EVENT_TITLE}/tui] ${message}`,
        );
      } catch {
        // Logging failures should not interrupt execution.
      }
    };

    // Cache in-flight session creation to deduplicate rapid concurrent triggers,
    // and remember the last auto-created session to avoid spawning redundant empty sessions.
    let creatingSession: {key: string; promise: Promise<string | null>} | null =
      null;
    let lastAutoCreated: {
      directory: string;
      workspaceID?: string;
      sessionID: string;
    } | null = null;

    /**
     * Resolves the session to dispatch goal commands to.
     * Prefers the active session. If no session is open (e.g. on the welcome screen),
     * auto-creates a session for the workspace location and navigates to it.
     */
    const resolveGoalSession = async (): Promise<string | null> => {
      const active = activeSessionID();
      if (active) return active;

      const directory = context.location?.directory;
      const workspaceID = context.location?.workspaceID;
      if (!directory) {
        context.ui.toast.show({
          variant: 'warning',
          title: PRODUCT_DISPLAY_NAME,
          message: 'Open a session before controlling a goal.',
        });
        return null;
      }

      // Reuse recently auto-created session for this workspace to avoid duplicate session creation.
      if (
        lastAutoCreated &&
        lastAutoCreated.directory === directory &&
        lastAutoCreated.workspaceID === workspaceID
      ) {
        return lastAutoCreated.sessionID;
      }

      // Deduplicate concurrent session creation requests for the same directory.
      if (creatingSession?.key === directory) {
        return creatingSession.promise;
      }

      const promise = (async (): Promise<string | null> => {
        try {
          const created = await context.client.session.create({
            location: {directory},
          });
          const sessionID = (created as {id?: string})?.id;
          if (!sessionID)
            throw new Error('session.create returned no session id');

          // Surface the session using tabs if supported, otherwise navigate to it.
          const tabbed =
            context.ui.tabs &&
            typeof context.ui.tabs.enabled === 'function' &&
            context.ui.tabs.enabled();
          const surfaced = tabbed ? context.ui.tabs!.open(sessionID) : false;
          if (!surfaced) {
            try {
              context.ui.router.navigate({type: 'session', sessionID});
            } catch {
              // Navigation failure is handled gracefully.
            }
          }
          lastAutoCreated = {directory, workspaceID, sessionID};
          return sessionID;
        } catch (error) {
          context.ui.toast.show({
            variant: 'error',
            title: PRODUCT_DISPLAY_NAME,
            message: `Could not open a session: ${error instanceof Error ? error.message : String(error)}`,
          });
          return null;
        }
      })();

      creatingSession = {key: directory, promise};
      try {
        return await promise;
      } finally {
        if (creatingSession?.key === directory) creatingSession = null;
      }
    };

    // Active command watchdog timers. Cleared when execution confirmation is received;
    // triggers a warning toast if no response arrives before timeout.
    const activeWatchdogs = new Map<
      string,
      {
        timer: ReturnType<typeof setTimeout>;
        command: string;
        sessionID: string;
      }
    >();

    // Detects whether server plugin failed to load, which causes dispatches to fail silently.
    const degraded = createDegradedModeDetector();

    const armWatchdog = (
      sessionID: string,
      command: string,
      timeoutMs = 15000,
    ): void => {
      const rootCommand = command.trim().split(/\s+/)[0];
      const key = `${sessionID}:${rootCommand}`;
      const existing = activeWatchdogs.get(key);
      if (existing) {
        clearTimeout(existing.timer);
      }
      const timer = setTimeout(() => {
        activeWatchdogs.delete(key);
        context.ui.toast.show({
          variant: 'warning',
          title: PRODUCT_DISPLAY_NAME,
          message:
            degraded.checkDispatch() ??
            watchdogTimeoutMessage('v2', command, timeoutMs),
          duration: 8000,
        });
      }, timeoutMs);
      activeWatchdogs.set(key, {timer, command, sessionID});
    };

    const disarmWatchdogs = (sessionID: string): void => {
      for (const [key, w] of activeWatchdogs.entries()) {
        if (w.sessionID === sessionID) {
          clearTimeout(w.timer);
          activeWatchdogs.delete(key);
        }
      }
    };

    // Eagerly hydrate from disk to prevent initial views from displaying empty state.
    const eagerHydrateDir =
      opts.workspaceDirectory ?? context.location?.directory;
    if (eagerHydrateDir) {
      void hydrateStoreFromDisk(
        store,
        eagerHydrateDir,
        undefined,
        opts.stateRoot,
      ).catch(() => {});
    }

    const lastHydration: {dir?: string; count: number; evidence?: string} = {
      count: 0,
    };

    /**
     * Resolves the workspace directory in priority order:
     * 1. Explicitly configured `workspaceDirectory`
     * 2. Host reactive location (`context.location.directory`)
     * 3. Server location endpoint (`client.location.get`)
     * 4. Active session's location metadata (`client.session.get`)
     */
    const resolveWorkspaceDir = async (): Promise<string | undefined> => {
      const evidence: string[] = [];
      if (opts.workspaceDirectory) return opts.workspaceDirectory;
      const direct = context.location?.directory;
      if (direct) return direct;
      evidence.push('reactive-location:none');
      try {
        const client = context.client as {
          location?: {get?: () => Promise<unknown>};
          session?: {get?: (input: unknown) => Promise<unknown>};
        };
        const locOut = await client.location?.get?.();
        const locDir = unwrapDirectory(locOut);
        if (locDir) return locDir;
        evidence.push(
          `location.get=${JSON.stringify(locOut)?.slice(0, 120) ?? 'undefined'}`,
        );
      } catch (err) {
        evidence.push(
          `location.get=threw:${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            140,
          ),
        );
      }
      const sid = activeSessionID();
      if (sid) {
        try {
          const sessOut = await (
            context.client as {
              session?: {get?: (input: unknown) => Promise<unknown>};
            }
          ).session?.get?.({sessionID: sid});
          const sessDir = unwrapDirectory(sessOut);
          if (sessDir) return sessDir;
          evidence.push(
            `session.get=${JSON.stringify(sessOut)?.slice(0, 120) ?? 'undefined'}`,
          );
        } catch (err) {
          evidence.push(
            `session.get=threw:${err instanceof Error ? err.message : String(err)}`.slice(
              0,
              140,
            ),
          );
        }
      } else {
        evidence.push('no-active-session');
      }
      lastHydration.evidence = evidence.join(' | ');
      return undefined;
    };

    const ensureHydrated = async (): Promise<void> => {
      let lastDir: string | undefined;
      let lastCount = -1;
      for (let attempt = 0; attempt < 8; attempt++) {
        const dir = await resolveWorkspaceDir();
        lastDir = dir;
        if (dir) {
          await hydrateStoreFromDisk(
            store,
            dir,
            undefined,
            opts.stateRoot,
          ).catch(() => {});
          lastCount = store.getAllSnapshots().length;
          if (lastCount > 0) {
            lastHydration.dir = dir;
            lastHydration.count = lastCount;
            return;
          }
        }
        await new Promise(r => setTimeout(r, 350));
      }
      lastHydration.dir = lastDir;
      lastHydration.count = Math.max(lastCount, 0);
      log(
        'info',
        `hydration exhausted: dir=${lastDir ?? 'unresolved'} snapshots=${Math.max(lastCount, 0)}`,
      );
    };

    const sendGoalCommand = async (
      command: string,
      opts?: {label?: string; timeoutMs?: number},
    ): Promise<void> => {
      const sessionID = await resolveGoalSession();
      if (!sessionID) return;

      try {
        // In opencode v2, direct TUI-to-plugin RPC is unavailable and there is no before-execute hook.
        // Commands are driven deterministically by synthesizing an agent steer that instructs
        // the agent to call the registered `goal-command` tool with the subcommand.
        const directive =
          `[${PRODUCT_DISPLAY_NAME}] Execute the following goal command by calling the ` +
          '`goal-command` tool exactly once, passing its `subcommand` parameter ' +
          `verbatim as the single argument:\n\n${command}\n\n` +
          'Do not ask for confirmation, do not summarize or describe the action, ' +
          'and do not perform any other work. Call the tool now and reply with ' +
          'only its returned output.';
        await context.client.session.synthetic({
          sessionID,
          text: directive,
          description: `${PRODUCT_DISPLAY_NAME}: ${command}`,
        });
        armWatchdog(sessionID, command, opts?.timeoutMs);
        // Show an outcome-neutral toast: the command was requested, but asynchronous
        // execution outcome cannot be determined immediately.
        context.ui.toast.show({
          variant: 'info',
          title: PRODUCT_DISPLAY_NAME,
          message: opts?.label ?? outcomeNeutralLabel(command),
        });
      } catch (error) {
        // Invalidate cached session so subsequent attempts create a fresh session instead of retrying a dead one.
        lastAutoCreated = null;
        context.ui.toast.show({
          variant: 'error',
          title: PRODUCT_DISPLAY_NAME,
          message: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    };

    // DashboardRoute renders full goal cards, status gauges, and actions.
    const dashboardRouteName = 'goal-dashboard';

    const dashboardSections = (): {title: string; text: string}[] => {
      const sid = dashboardSessionID ?? activeSessionID();
      let snaps = sid ? store.getSnapshots(sid) : [];
      if (snaps.length === 0) {
        snaps = store.getAllSnapshots();
      }
      const sections = formatGoalStatusDashboard(snaps, sid ?? null);
      if (snaps.length === 0) {
        sections.push({
          title: 'Hydration',
          text: `No goals found on disk for this workspace${lastHydration.dir ? ` (checked ${lastHydration.dir})` : ' (workspace location not resolved yet)'}.`,
        });
        if (opts.logLevel === 'debug') {
          log(
            'debug',
            `hydration evidence: dir=${lastHydration.dir ?? 'unresolved'} snapshots=${lastHydration.count}${lastHydration.evidence ? ` ${lastHydration.evidence}` : ''}`,
          );
        }
      }
      return sections;
    };

    // Only display goal control keybindings in the footer if an active goal belongs
    // to the targeted session, preventing actions against foreign sessions.
    const dashboardFooter = (targetSessionID: () => string | null): string =>
      dashboardFooterText(
        resolveFocusedGoalId(store, targetSessionID()),
        chord('d'),
        chord('p'),
        chord('r'),
        chord('c'),
        'esc',
      );

    let dashboardRouteDispose: (() => void) | null = null;
    try {
      dashboardRouteDispose = context.ui.router.register({
        name: dashboardRouteName,
        render: () => {
          const theme = (context.theme ?? {}) as HostTheme;
          // SolidJS reactivity: trigger view updates on store events without route re-navigation.
          const [rev, setRev] = createSignal(0);
          const unsub = store.subscribe(() => setRev(r => r + 1));
          onCleanup(() => {
            try {
              unsub();
            } catch {
              // Teardown is best-effort.
            }
          });
          const sections = () => {
            rev();
            return dashboardSections();
          };
          const snapshots = () => {
            rev();
            const sid = dashboardSession();
            let snaps = sid ? store.getSnapshots(sid) : [];
            if (snaps.length === 0) snaps = store.getAllSnapshots();
            return snaps;
          };
          const focusedGoalId = () => {
            rev();
            const sid = dashboardSession();
            return resolveFocusedGoalId(store, sid ?? null);
          };
          const viewSessionID = (): string | null => {
            rev();
            return dashboardSession();
          };
          const hydrationText = () => {
            const s = sections();
            return s.length === 0
              ? `No goals found on disk for this workspace${lastHydration.dir ? ` (checked ${lastHydration.dir})` : ''}.`
              : undefined;
          };
          return DashboardRoute({
            sections,
            snapshots,
            activeSessionID: viewSessionID,
            focusedGoalId,
            onSelectGoal: (goalId: string) => {
              const sid = activeSessionID();
              if (sid) void store.getFocused(sid);
              void sendGoalCommand(`focus ${goalId}`);
            },
            ...dashboardGoalActions(
              store,
              dashboardSession,
              c => void sendGoalCommand(c),
            ),
            onFocus: (goalId: string) => {
              void sendGoalCommand(`focus ${goalId}`);
            },
            onClose: () => {
              dashboardOpen = false;
              dashboardSessionID = null;
              try {
                context.ui.router.navigate({type: 'home'});
              } catch {
                // Ignore navigation errors on dismissal.
              }
            },
            theme,
            footer: dashboardFooter(dashboardSession),
            hydrationText: hydrationText(),
          });
        },
      });
    } catch {
      dashboardRouteDispose = null;
    }

    let dashboardGeneration = 0;
    let dashboardOpen = false;
    let dashboardSessionID: string | null = null;
    let dashboardUnsubscribe: (() => void) | null = null;

    const isDashboardRouteActive = (): boolean => {
      try {
        const cur = context.ui.router.current();
        return cur?.type === 'plugin' && cur?.name === dashboardRouteName;
      } catch {
        return false;
      }
    };

    // Resolves the session for the dashboard. On custom routes, activeSessionID
    // is null, so fall back to the stored dashboardSessionID.
    const dashboardSession = (): string | null =>
      (isDashboardRouteActive() && dashboardSessionID
        ? dashboardSessionID
        : activeSessionID()) ?? null;

    /**
     * Renders or repaints the DashboardRoute within a host dialog.
     * Uses generation counters to ensure onClose callbacks from superseded repaints are ignored.
     */
    const repaintDashboard = (): void => {
      if (!dashboardOpen) return;
      const generation = ++dashboardGeneration;
      const theme = (context.theme ?? {}) as HostTheme;

      const renderContent = () =>
        DashboardRoute({
          sections: dashboardSections,
          snapshots: () => {
            const s = dashboardSessionID ?? activeSessionID();
            let snaps = s ? store.getSnapshots(s) : [];
            if (snaps.length === 0) snaps = store.getAllSnapshots();
            return snaps;
          },
          focusedGoalId: () => {
            const s = dashboardSessionID ?? activeSessionID();
            return resolveFocusedGoalId(store, s ?? null);
          },
          activeSessionID: dashboardSession,
          onSelectGoal: (goalId: string) => {
            void sendGoalCommand(`focus ${goalId}`);
          },
          ...dashboardGoalActions(
            store,
            () => dashboardSessionID ?? activeSessionID(),
            c => void sendGoalCommand(c),
          ),
          onFocus: (goalId: string) => {
            void sendGoalCommand(`focus ${goalId}`);
          },
          onClose: () => {
            dashboardOpen = false;
            dashboardSessionID = null;
            if (dashboardUnsubscribe) {
              try {
                dashboardUnsubscribe();
              } catch {
                // Teardown is best-effort.
              }
              dashboardUnsubscribe = null;
            }
            try {
              context.ui.dialog.clear();
            } catch {
              // Dialog might already be dismissed.
            }
          },
          theme,
          footer: dashboardFooter(
            () => dashboardSessionID ?? activeSessionID(),
          ),
          hydrationText:
            store.getAllSnapshots().length === 0
              ? `No goals found on disk for this workspace${lastHydration.dir ? ` (checked ${lastHydration.dir})` : ''}.`
              : undefined,
        });

      const onClose = () => {
        if (generation === dashboardGeneration) {
          dashboardOpen = false;
          dashboardSessionID = null;
          if (dashboardUnsubscribe) {
            try {
              dashboardUnsubscribe();
            } catch {
              // Teardown is best-effort.
            }
            dashboardUnsubscribe = null;
          }
        }
      };

      try {
        context.ui.dialog.set({size: 'xlarge'});
      } catch {
        // Dialog sizing is optional and host-dependent.
      }
      context.ui.dialog.show(renderContent, onClose);
    };

    const renderDashboard = async (): Promise<void> => {
      const sid = activeSessionID();
      if (
        (sid && store.getSnapshots(sid).length === 0) ||
        (!sid && store.getAllSnapshots().length === 0)
      ) {
        await ensureHydrated();
      }

      dashboardOpen = true;
      dashboardSessionID = sid;

      repaintDashboard();

      if (dashboardUnsubscribe) {
        try {
          dashboardUnsubscribe();
        } catch {
          // Teardown is best-effort.
        }
      }
      dashboardUnsubscribe = store.subscribe(event => {
        if (!dashboardOpen) return;
        const targetSid = dashboardSessionID ?? activeSessionID();
        if (targetSid && event.sessionID !== targetSid) return;
        repaintDashboard();
      });
    };

    /**
     * Dispatches keymap actions targeting the goal focused in the current dashboard context.
     * Uses `dashboardSession()` rather than `activeSessionID()` because `activeSessionID()`
     * is null when the dashboard route itself is active.
     */
    const keymapDispatch = async (
      targeted: (goalId: string) => string,
      bare: string,
    ): Promise<void> => {
      const sid = dashboardSession();
      if (sid === null) {
        await sendGoalCommand(bare);
        return;
      }
      const goalId = resolveFocusedGoalId(store, sid);
      if (goalId === null) return;
      await sendGoalCommand(targeted(goalId));
    };

    /**
     * Prompts the user for input and dispatches the command for the target goal.
     * Resolves the target goal ID before opening the prompt to avoid collecting input
     * when no appropriate goal is focused.
     */
    const keymapPromptThen = async (
      verb: 'edit' | 'checkpoint',
      prompt: () => Promise<string | undefined>,
    ): Promise<void> => {
      const sid = dashboardSession();
      const goalId = sid === null ? null : resolveFocusedGoalId(store, sid);
      if (sid !== null && goalId === null) return;
      const operand = await prompt();
      if (!operand) return;
      await sendGoalCommand(
        goalId === null ? `${verb} ${operand}` : `${verb} ${goalId} ${operand}`,
      );
    };

    context.keymap.layer(() => ({
      commands: [
        {
          id: 'fixate-on.dashboard',
          title: `${PRODUCT_DISPLAY_NAME}: Dashboard`,
          description: 'Open the live goal dashboard',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('d'),
          run: async () => {
            await renderDashboard();
          },
        },
        {
          id: 'fixate-on.pause',
          title: `${PRODUCT_DISPLAY_NAME}: Pause Goal`,
          description: 'Pause the active goal',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('p'),
          run: async () => {
            await keymapDispatch(id => `pause ${id}`, 'pause');
          },
        },
        {
          id: 'fixate-on.resume',
          title: `${PRODUCT_DISPLAY_NAME}: Resume Goal`,
          description: 'Resume a paused goal',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('r'),
          run: async () => {
            await keymapDispatch(id => `resume ${id}`, 'resume');
          },
        },
        {
          id: 'fixate-on.clear',
          title: `${PRODUCT_DISPLAY_NAME}: Clear Goals`,
          description: 'Clear active goal(s)',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('c'),
          run: async () => {
            await keymapDispatch(id => `clear ${id}`, 'clear');
          },
        },
        {
          id: 'fixate-on.list',
          title: `${PRODUCT_DISPLAY_NAME}: List Goals`,
          description: 'List all active and archived goals',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          run: async () => {
            await sendGoalCommand('list');
          },
        },
        {
          id: 'fixate-on.history',
          title: `${PRODUCT_DISPLAY_NAME}: Show History`,
          description: 'Show goal history and transition log',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          run: async () => {
            await sendGoalCommand('history');
          },
        },
        {
          id: 'fixate-on.edit',
          title: `${PRODUCT_DISPLAY_NAME}: Edit Objective`,
          description: 'Edit objective of the active goal',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('e'),
          run: async () => {
            await keymapPromptThen('edit', () =>
              context.ui.dialog.prompt({
                title: 'Edit Goal',
                placeholder: 'Updated objective',
              }),
            );
          },
        },
        {
          id: 'fixate-on.checkpoint',
          title: `${PRODUCT_DISPLAY_NAME}: Save Checkpoint`,
          description: 'Save a checkpoint for the active goal',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('k'),
          run: async () => {
            await keymapPromptThen('checkpoint', () =>
              context.ui.dialog.prompt({
                title: 'Save Checkpoint',
                placeholder: 'Checkpoint summary',
              }),
            );
          },
        },
        {
          id: 'fixate-on.focus',
          title: `${PRODUCT_DISPLAY_NAME}: Focus Goal`,
          description: 'Focus a specific goal in the session',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('f'),
          run: async () => {
            const sid = activeSessionID();
            let goals = sid ? store.getSnapshots(sid) : [];
            if (goals.length === 0 && sid) {
              await ensureHydrated();
              goals = store.getSnapshots(sid);
            }
            if (goals.length === 0) {
              context.ui.toast.show({
                variant: 'warning',
                title: PRODUCT_DISPLAY_NAME,
                message: 'No active goals to focus.',
              });
              return;
            }
            const goalId = await context.ui.dialog.select({
              title: 'Focus Goal',
              options: goals.map((g: GoalTuiSnapshot, idx: number) => ({
                title: `${idx + 1}. ${g.condition}`,
                value: g.goalId,
                description: `Status: ${g.status}`,
              })),
            });
            if (goalId) {
              await sendGoalCommand(`focus ${goalId}`);
            }
          },
        },
        {
          id: 'fixate-on.add',
          title: `${PRODUCT_DISPLAY_NAME}: Add Goal`,
          description: 'Add a new goal to the session',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('a'),
          run: async () => {
            const obj = await context.ui.dialog.prompt({
              title: 'Add New Goal',
              placeholder: 'New goal objective',
            });
            if (obj) {
              await sendGoalCommand(`add ${obj}`);
            }
          },
        },
        {
          id: 'fixate-on.sequence',
          title: `${PRODUCT_DISPLAY_NAME}: Start Sequence`,
          description: 'Start an ordered sequence of goals',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          run: async () => {
            const t = await context.ui.dialog.prompt({
              title: 'Start Goal Sequence',
              placeholder: 'Objective 1; Objective 2; Objective 3',
            });
            if (t) {
              await sendGoalCommand(`sequence ${t}`);
            }
          },
        },
        {
          id: 'fixate-on.handback',
          title: `${PRODUCT_DISPLAY_NAME}: Handback Deliverables`,
          description: 'Generate reviewable diff and handback deliverables',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          bind: chord('h'),
          run: async () => {
            await sendGoalCommand('handback');
          },
        },
        {
          id: 'fixate-on.review-payload',
          title: `${PRODUCT_DISPLAY_NAME}: External Review Payload`,
          description: 'Generate paste-ready external review payload',
          group: PRODUCT_DISPLAY_NAME,
          palette: true,
          run: async () => {
            await sendGoalCommand('review-payload');
          },
        },
      ],
    }));

    log('info', 'TUI companion initialized (v2) — subscribing to goal events.');

    // Wire up event listeners, disk watchers, and status sync handlers.
    const events = wireV2Events({
      context: context as unknown as V2EventContext,
      store,
      stateRoot: opts.stateRoot,
      resolveWorkspaceDir,
      ensureHydrated,
      disarmWatchdogs,
      dashboardRouteDispose,
      activeWatchdogs,
      log,
    });

    return () => {
      events.dispose();
    };
  },
};

export default GoalTuiPluginV2;
