/**
 * TUI companion plugin entrypoint.
 *
 * The server plugin loads from the `opencode.json` plugin array; the TUI
 * companion loads ONLY from the `tui.json` plugin array, and registering it
 * in `opencode.json` does not load it on v1:
 *
 * `opencode.json`: `"plugin": ["fixate-on"]`
 * `tui.json`: `"plugin": ["fixate-on/tui"]`
 *
 * On stock v1 the client.tui.publish channel is contractually silent — the
 * host renders every published envelope as an on-screen toast, so the
 * companion derives truth from persisted state files instead: hydrate once
 * at startup plus a disk refresh loop that diffs revisions each second.
 * Curated moments surface as short toasts via tui-toast-policy.ts, never JSON.
 */

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginMeta,
} from '@opencode-ai/plugin/tui';
import type {PluginOptions} from '@opencode-ai/plugin';
import {
  createTuiStateStore,
  GOAL_TUI_EVENT_TITLE,
  type GoalTuiEvent,
  type GoalTuiSnapshot,
} from './tui-state.ts';
import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';
import {readDiskGoalSnapshots} from './tui-disk-state.ts';
import {createDiskRefreshLoop} from './tui-companion-refresh.ts';
import {
  createDegradedModeDetector,
  createGoalWatchdogs,
  isMutatingGoalCommand,
  outcomeNeutralLabel,
} from './tui-action-labels.ts';
import {
  BRIEFING_SESSION_KEY,
  summarizeGoalsNeedingYou,
  ToastCoalescer,
} from './tui-toast-policy.ts';
import {
  formatGoalStatusDashboard,
  goalListRow,
  resolveFocusedGoalId,
} from './tui-views.ts';
import {soundForEvent} from './tui-sound.ts';

/**
 * Options for the TUI companion plugin. All fields are optional — the TUI
 * works with zero configuration. These options are passed as the second
 * element of the plugin tuple in `tui.json`:
 *
 * ```json
 * ["fixate-on/tui", { "logLevel": "info" }]
 * ```
 */
export interface GoalTuiPluginOptions {
  /**
   * Log verbosity for the TUI companion. `"error"` logs only failures;
   * `"info"` logs initialization and event subscription; `"debug"` logs every
   * applied event.
   * @default "info"
   */
  logLevel?: 'error' | 'info' | 'debug';

  /**
   * Workspace directory to scan for persisted goal state, as
   * `<directory>/<stateRoot>/sessions/<sessionID>/state.json`. Defaults to the
   * TUI process's working directory, which matches where opencode is normally
   * launched.
   */
  directory?: string;

  /**
   * Where goal state lives, relative to `directory` or absolute — the same
   * setting the server plugin's `stateRoot` option controls. Set it here too
   * when you set it there (or use `FIXATE_ON_STATE_ROOT`, which both entries
   * see): the companion is a separate plugin entry with its own options.
   * @default ".opencode/goals"
   */
  stateRoot?: string;
}

/**
 * The chord prefix for all fixate-on keybindings (`g` = goal). A target-less
 * layer (no `target` field) stays active even when the text-area prompt is
 * focused. Prefix and continuation key are captured via `preventDefault` +
 * `stopPropagation` so the text input never sees them.
 */
const GOAL_PREFIX = 'ctrl+shift+g';

/**
 * Builds a chord binding string: prefix + space + action key.
 */
function chord(actionKey: string): string {
  return `${GOAL_PREFIX} ${actionKey}`;
}

/**
 * Creates the TUI companion plugin. Subscribes to host events, feeds them
 * into the TuiStateStore, registers a keymap chord layer for goal commands,
 * and renders a reactive dashboard dialog.
 *
 * This function is called by OpenCode's TUI plugin loader when the user
 * registers `fixate-on/tui` in their tui.json.
 */
export const GoalTuiPlugin: TuiPlugin = async (
  api: TuiPluginApi,
  options?: PluginOptions,
  _meta?: TuiPluginMeta,
): Promise<void> => {
  const opts: {
    logLevel: 'error' | 'info' | 'debug';
    directory?: string;
    stateRoot?: string;
  } = {
    logLevel: (options as GoalTuiPluginOptions | undefined)?.logLevel ?? 'info',
    directory: (options as GoalTuiPluginOptions | undefined)?.directory,
    stateRoot: (options as GoalTuiPluginOptions | undefined)?.stateRoot,
  };

  const store = createTuiStateStore();

  const activeSessionID = (): string | null => {
    const route = api.route.current;
    if (
      route.name !== 'session' ||
      !route.params ||
      typeof route.params.sessionID !== 'string'
    ) {
      return null;
    }
    return route.params.sessionID;
  };

  const log = (level: 'error' | 'info' | 'debug', message: string) => {
    if (opts.logLevel === 'error' && level !== 'error') return;
    if (opts.logLevel === 'info' && level === 'debug') return;
    try {
      if (level === 'error') {
        // Use the display name rather than the internal wire marker so users
        // see consistent product branding across all failure surfaces.
        api.ui.toast({
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
      // Best-effort logging — failures must not interrupt plugin operation.
    }
  };

  // Every mutating dispatch arms the watchdog; a store event for the same
  // session disarms it. Read-only commands are never armed.
  const degraded = createDegradedModeDetector();
  const watchdogs = createGoalWatchdogs('v1', message => {
    api.ui.toast({
      variant: 'warning',
      title: PRODUCT_DISPLAY_NAME,
      message: degraded.checkDispatch() ?? message,
      duration: 8000,
    });
  });
  store.subscribe(event => {
    degraded.noteSurfaceAlive();
    watchdogs.disarmSession(event.sessionID);
  });

  /**
   * Dispatches a goal subcommand to the active session via `session.command`.
   * Automatically creates a new session if none is currently active.
   */
  const sendGoalCommand = async (command: string): Promise<void> => {
    let sessionID = activeSessionID();
    if (!sessionID) {
      try {
        const created = await api.client.session.create(
          {} as Record<string, unknown>,
        );
        const data = (created as {data?: {id?: unknown}; id?: unknown}) ?? {};
        const newID =
          typeof data.data?.id === 'string'
            ? data.data.id
            : typeof data.id === 'string'
              ? data.id
              : '';
        if (newID) {
          sessionID = newID;
          api.ui.toast({
            variant: 'info',
            title: PRODUCT_DISPLAY_NAME,
            message: 'Started a new session for the goal.',
          });
        }
      } catch {
        // Session creation failed; proceed to prompt the user.
      }
    }
    if (!sessionID) {
      api.ui.toast({
        variant: 'warning',
        title: PRODUCT_DISPLAY_NAME,
        message: 'Open a session before controlling a goal.',
      });
      return;
    }
    try {
      await api.client.session.command({
        sessionID,
        command: 'goal',
        arguments: command,
      });
      if (isMutatingGoalCommand(command)) {
        watchdogs.arm(sessionID, command);
      }
    } catch (error) {
      api.ui.toast({
        variant: 'error',
        title: PRODUCT_DISPLAY_NAME,
        message: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  // The cockpit is a DialogSelect → DialogAlert → DialogSelect navigation flow
  // using the host's built-in arrow/enter support.
  const getCockpitSnapshots = (): GoalTuiSnapshot[] => {
    const sessionID = activeSessionID();
    let snaps = sessionID ? store.getSnapshots(sessionID) : [];
    if (snaps.length === 0) {
      snaps = store.getAllSnapshots().filter(s => s.origin === 'disk');
    }
    return snaps;
  };

  const dashboardSections = (): {title: string; text: string}[] => {
    return formatGoalStatusDashboard(getCockpitSnapshots(), activeSessionID());
  };

  const dashboardMessage = (): string => {
    return dashboardSections()
      .map(section => `${section.title}\n${section.text}`)
      .join('\n\n');
  };

  const formatGoalDetail = (snap: GoalTuiSnapshot): string => {
    // Provide the active session ID so cross-session goals retain their origin label in details.
    const sections = formatGoalStatusDashboard([snap], activeSessionID());
    return sections.map(s => `${s.title}\n${s.text}`).join('\n\n');
  };

  let dashboardUnsubscribe: (() => void) | null = null;
  let cockpitGeneration = 0;

  const cleanupCockpit = (): void => {
    if (dashboardUnsubscribe) {
      try {
        dashboardUnsubscribe();
      } catch {
        // Best-effort cleanup.
      }
      dashboardUnsubscribe = null;
    }
  };

  // On v1, DialogAlert Enter triggers onConfirm right before the host auto-clears
  // the dialog. A synchronous dialog replacement inside onConfirm would be destroyed
  // by that auto-clear, so we defer replacement past the clear cycle.
  const CHAIN_REOPEN_MS = 30;
  const chainReplace: typeof api.ui.dialog.replace = (render, onClose) => {
    api.ui.dialog.clear();
    setTimeout(() => {
      api.ui.dialog.replace(render, onClose);
    }, CHAIN_REOPEN_MS);
  };

  const showGoalActions = (goalId: string, gen: number): void => {
    if (gen !== cockpitGeneration) return;
    const actions = [
      {title: 'Pause', value: 'pause', description: 'Pause this goal'},
      {title: 'Resume', value: 'resume', description: 'Resume this goal'},
      {title: 'Focus', value: 'focus', description: 'Focus this goal'},
      {
        title: 'Edit Objective',
        value: 'edit',
        description: 'Change the objective',
      },
      {
        title: 'Checkpoint',
        value: 'checkpoint',
        description: 'Save a checkpoint',
      },
      {title: 'Clear', value: 'clear', description: 'Clear this goal'},
      {
        title: '← Back to Goals',
        value: 'back',
        description: 'Return to goal list',
      },
    ];
    chainReplace(
      () =>
        api.ui.DialogSelect({
          title: `Actions: ${goalId.substring(0, 8)}`,
          options: actions,
          onSelect: option => {
            if (gen !== cockpitGeneration) return;
            switch (option.value) {
              case 'pause':
                // Explicitly pass goalId; a bare verb defaults to the currently focused goal.
                void sendGoalCommand(`pause ${goalId}`);
                api.ui.toast({
                  variant: 'info',
                  title: PRODUCT_DISPLAY_NAME,
                  message: outcomeNeutralLabel('pause'),
                });
                showGoalDetail(goalId, gen);
                break;
              case 'resume':
                void sendGoalCommand(`resume ${goalId}`);
                api.ui.toast({
                  variant: 'info',
                  title: PRODUCT_DISPLAY_NAME,
                  message: outcomeNeutralLabel('resume'),
                });
                showGoalDetail(goalId, gen);
                break;
              case 'focus':
                void sendGoalCommand(`focus ${goalId}`);
                api.ui.toast({
                  variant: 'info',
                  title: PRODUCT_DISPLAY_NAME,
                  message: outcomeNeutralLabel(`focus ${goalId}`),
                });
                showGoalDetail(goalId, gen);
                break;
              case 'edit':
                chainReplace(() =>
                  api.ui.DialogPrompt({
                    title: 'Edit Goal',
                    placeholder: 'Updated objective',
                    onConfirm: objective => {
                      api.ui.dialog.clear();
                      if (!objective) {
                        showGoalActions(goalId, gen);
                        return;
                      }
                      // Target this specific goal; editing transitions a paused goal back to active.
                      void sendGoalCommand(`edit ${goalId} ${objective}`);
                      api.ui.toast({
                        variant: 'info',
                        title: PRODUCT_DISPLAY_NAME,
                        message: outcomeNeutralLabel('edit'),
                      });
                      showGoalDetail(goalId, gen);
                    },
                  }),
                );
                break;
              case 'checkpoint':
                chainReplace(() =>
                  api.ui.DialogPrompt({
                    title: 'Save Checkpoint',
                    placeholder: 'Checkpoint summary',
                    onConfirm: summary => {
                      api.ui.dialog.clear();
                      if (!summary) {
                        showGoalActions(goalId, gen);
                        return;
                      }
                      // Target this specific goal; a bare checkpoint would update the focused goal's clock.
                      void sendGoalCommand(`checkpoint ${goalId} ${summary}`);
                      api.ui.toast({
                        variant: 'info',
                        title: PRODUCT_DISPLAY_NAME,
                        message: outcomeNeutralLabel('checkpoint'),
                      });
                      showGoalDetail(goalId, gen);
                    },
                  }),
                );
                break;
              case 'clear':
                // Target this specific goal instead of clearing all goals in the session.
                void sendGoalCommand(`clear ${goalId}`);
                api.ui.toast({
                  variant: 'info',
                  title: PRODUCT_DISPLAY_NAME,
                  message: outcomeNeutralLabel('clear'),
                });
                cleanupCockpit();
                api.ui.dialog.clear();
                break;
              case 'back':
                showDashboard();
                break;
            }
          },
        }),
      () => {
        if (gen === cockpitGeneration) cleanupCockpit();
      },
    );
  };

  /** Step 2: Detail card for a selected goal. */
  const showGoalDetail = (goalId: string, gen: number): void => {
    if (gen !== cockpitGeneration) return;
    const snaps = getCockpitSnapshots();
    const snap = snaps.find(s => s.goalId === goalId);
    if (!snap) {
      showDashboard();
      return;
    }
    chainReplace(
      () =>
        api.ui.DialogAlert({
          title: `Goal: ${goalId.substring(0, 8)}`,
          message: formatGoalDetail(snap),
          // Confirm triggers onConfirm while replace onClose only fires on Escape.
          // Without onConfirm, this chained card is keyboard-inert on v1.
          onConfirm: () => {
            if (gen === cockpitGeneration) {
              showGoalActions(goalId, gen);
            }
          },
        }),
      () => {
        if (gen === cockpitGeneration) cleanupCockpit();
      },
    );
  };

  const renderGoalList = (snaps: GoalTuiSnapshot[], gen: number): void => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: PRODUCT_DISPLAY_NAME,
          // Goals belonging to other sessions are labelled to ensure attribution remains clear.
          options: snaps.map((s, idx) => ({
            ...goalListRow(s, idx, activeSessionID()),
            value: s.goalId,
          })),
          onSelect: option => {
            if (gen !== cockpitGeneration) return;
            cleanupCockpit();
            showGoalDetail(option.value, gen);
          },
        }),
      () => {
        if (gen === cockpitGeneration) cleanupCockpit();
      },
    );
  };

  const showDashboard = (): void => {
    cockpitGeneration++;
    const gen = cockpitGeneration;
    cleanupCockpit();

    const snaps = getCockpitSnapshots();
    if (snaps.length === 0) {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogAlert({
            title: PRODUCT_DISPLAY_NAME,
            message: dashboardMessage(),
            onConfirm: () => {
              cleanupCockpit();
              api.ui.dialog.clear();
            },
          }),
        () => cleanupCockpit(),
      );
      return;
    }

    renderGoalList(snaps, gen);

    dashboardUnsubscribe = store.subscribe(() => {
      if (gen !== cockpitGeneration) return;
      const currentSnaps = getCockpitSnapshots();
      if (currentSnaps.length === 0) {
        api.ui.dialog.replace(
          () =>
            api.ui.DialogAlert({
              title: PRODUCT_DISPLAY_NAME,
              message: 'No active goals.',
              onConfirm: () => {
                cleanupCockpit();
                api.ui.dialog.clear();
              },
            }),
          () => cleanupCockpit(),
        );
        return;
      }
      renderGoalList(currentSnaps, gen);
    });
  };

  // Palette and chord verbs explicitly specify the goal they act upon.
  // A bare verb acts on the focused goal, which might not be what the user is inspecting.
  // resolveFocusedGoalId resolves only for the current session, refusing execution
  // if no goal is active rather than guessing across session boundaries.
  const paletteTarget = (): {goalId: string} | {refusal: string} => {
    const sessionID = activeSessionID();
    if (sessionID === null)
      return {refusal: 'Open a session before controlling a goal.'};
    const snaps = store.getSnapshots(sessionID);
    if (snaps.length === 0) return {refusal: 'This session has no goals.'};
    const goalId = resolveFocusedGoalId(store, sessionID);
    if (goalId === null) return {refusal: 'This session has no goals.'};
    return {goalId};
  };

  const refuseWithReason = (refusal: string): void => {
    api.ui.toast({
      variant: 'warning',
      title: PRODUCT_DISPLAY_NAME,
      message: refusal,
    });
  };

  const handlePause = (): void => {
    const target = paletteTarget();
    if ('refusal' in target) {
      refuseWithReason(target.refusal);
      return;
    }
    void sendGoalCommand(`pause ${target.goalId}`);
    api.ui.toast({
      variant: 'info',
      title: PRODUCT_DISPLAY_NAME,
      message: outcomeNeutralLabel('pause'),
    });
  };

  const handleResume = (): void => {
    const target = paletteTarget();
    if ('refusal' in target) {
      refuseWithReason(target.refusal);
      return;
    }
    void sendGoalCommand(`resume ${target.goalId}`);
    api.ui.toast({
      variant: 'info',
      title: PRODUCT_DISPLAY_NAME,
      message: outcomeNeutralLabel('resume'),
    });
  };

  const handleClear = (): void => {
    const target = paletteTarget();
    if ('refusal' in target) {
      refuseWithReason(target.refusal);
      return;
    }
    void sendGoalCommand(`clear ${target.goalId}`);
    api.ui.toast({
      variant: 'info',
      title: PRODUCT_DISPLAY_NAME,
      message: outcomeNeutralLabel('clear'),
    });
  };

  const handleEdit = (): void => {
    const target = paletteTarget();
    if ('refusal' in target) {
      refuseWithReason(target.refusal);
      return;
    }
    const goalId = target.goalId;
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({
        title: 'Edit Goal',
        placeholder: 'Updated objective',
        onConfirm: objective => {
          // Close the modal before dispatching: the low-level replace API does not
          // auto-dismiss on confirm, which would leave the prompt dialog stuck open.
          api.ui.dialog.clear();
          if (!objective) return;
          void sendGoalCommand(`edit ${goalId} ${objective}`);
          api.ui.toast({
            variant: 'info',
            title: PRODUCT_DISPLAY_NAME,
            message: outcomeNeutralLabel('edit'),
          });
        },
      }),
    );
  };

  const handleCheckpoint = (): void => {
    const target = paletteTarget();
    if ('refusal' in target) {
      refuseWithReason(target.refusal);
      return;
    }
    const goalId = target.goalId;
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({
        title: 'Save Checkpoint',
        placeholder: 'Checkpoint summary',
        onConfirm: summary => {
          api.ui.dialog.clear();
          if (!summary) return;
          void sendGoalCommand(`checkpoint ${goalId} ${summary}`);
          api.ui.toast({
            variant: 'info',
            title: PRODUCT_DISPLAY_NAME,
            message: outcomeNeutralLabel('checkpoint'),
          });
        },
      }),
    );
  };

  // Register command palette entries and chord bindings (`ctrl+shift+g` + action key).
  // The layer is target-less so it stays active even when the prompt text area is focused.
  //
  // Action keys:
  // d = dashboard (avoids collision with <leader>s status)
  // p = pause, r = resume, c = clear, e = edit, k = checkpoint
  const unregisterCommands = api.keymap.registerLayer({
    // Explicitly set namespace: "palette" so commands are indexed by palette filters on v1.
    commands: [
      {
        name: 'fixate-on.dashboard',
        namespace: 'palette',
        slashName: 'goal-dashboard',
        title: `${PRODUCT_DISPLAY_NAME}: Dashboard`,
        description:
          'Open the live goal dashboard (goal status, tokens, turns)',
        category: PRODUCT_DISPLAY_NAME,
        run: showDashboard,
      },
      {
        name: 'fixate-on.pause',
        namespace: 'palette',
        slashName: 'goal-pause',
        title: `${PRODUCT_DISPLAY_NAME}: Pause Goal`,
        description: 'Pause the active goal',
        category: PRODUCT_DISPLAY_NAME,
        run: handlePause,
      },
      {
        name: 'fixate-on.resume',
        namespace: 'palette',
        slashName: 'goal-resume',
        title: `${PRODUCT_DISPLAY_NAME}: Resume Goal`,
        description: 'Resume a paused goal',
        category: PRODUCT_DISPLAY_NAME,
        run: handleResume,
      },
      {
        name: 'fixate-on.clear',
        namespace: 'palette',
        slashName: 'goal-clear',
        title: `${PRODUCT_DISPLAY_NAME}: Clear Goals`,
        description: 'Clear active goal(s)',
        category: PRODUCT_DISPLAY_NAME,
        run: handleClear,
      },
      {
        name: 'fixate-on.edit',
        namespace: 'palette',
        slashName: 'goal-edit',
        title: `${PRODUCT_DISPLAY_NAME}: Edit Objective`,
        description: 'Edit objective of the active goal',
        category: PRODUCT_DISPLAY_NAME,
        run: handleEdit,
      },
      {
        name: 'fixate-on.checkpoint',
        namespace: 'palette',
        slashName: 'goal-checkpoint',
        title: `${PRODUCT_DISPLAY_NAME}: Save Checkpoint`,
        description: 'Save a checkpoint for the active goal',
        category: PRODUCT_DISPLAY_NAME,
        run: handleCheckpoint,
      },
      {
        name: 'fixate-on.list',
        namespace: 'palette',
        slashName: 'goal-list',
        title: `${PRODUCT_DISPLAY_NAME}: List Goals`,
        description: 'List all active and archived goals',
        category: PRODUCT_DISPLAY_NAME,
        run: () => {
          void sendGoalCommand('list');
        },
      },
      {
        name: 'fixate-on.history',
        namespace: 'palette',
        slashName: 'goal-history',
        title: `${PRODUCT_DISPLAY_NAME}: Show History`,
        description: 'Show goal history and transition log',
        category: PRODUCT_DISPLAY_NAME,
        run: () => {
          void sendGoalCommand('history');
        },
      },
      {
        name: 'fixate-on.focus',
        namespace: 'palette',
        slashName: 'goal-focus',
        title: `${PRODUCT_DISPLAY_NAME}: Focus Goal`,
        description: 'Focus a specific goal in the session',
        category: PRODUCT_DISPLAY_NAME,
        run: () => {
          const sessionID = activeSessionID();
          const goals = sessionID ? store.getSnapshots(sessionID) : [];
          if (goals.length === 0) {
            api.ui.toast({
              variant: 'warning',
              title: PRODUCT_DISPLAY_NAME,
              message: 'No active goals to focus.',
            });
            return;
          }
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: 'Focus Goal',
              options: goals.map((g, idx) => ({
                title: `${idx + 1}. ${g.condition}`,
                value: g.goalId,
                description: `Status: ${g.status}`,
              })),
              onSelect: option => {
                api.ui.dialog.clear();
                void sendGoalCommand(`focus ${option.value}`);
                api.ui.toast({
                  variant: 'info',
                  title: PRODUCT_DISPLAY_NAME,
                  message: outcomeNeutralLabel(`focus ${option.value}`),
                });
              },
            }),
          );
        },
      },
      {
        name: 'fixate-on.add',
        namespace: 'palette',
        slashName: 'goal-add',
        title: `${PRODUCT_DISPLAY_NAME}: Add Goal`,
        description: 'Add a new goal to the session',
        category: PRODUCT_DISPLAY_NAME,
        run: () => {
          api.ui.dialog.replace(() =>
            api.ui.DialogPrompt({
              title: 'Add New Goal',
              placeholder: 'New goal objective',
              onConfirm: objective => {
                api.ui.dialog.clear();
                if (!objective) return;
                void sendGoalCommand(`add ${objective}`);
                api.ui.toast({
                  variant: 'info',
                  title: PRODUCT_DISPLAY_NAME,
                  message: outcomeNeutralLabel('add'),
                });
              },
            }),
          );
        },
      },
      {
        name: 'fixate-on.sequence',
        namespace: 'palette',
        slashName: 'goal-sequence',
        title: `${PRODUCT_DISPLAY_NAME}: Start Sequence`,
        description: 'Start an ordered sequence of goals',
        category: PRODUCT_DISPLAY_NAME,
        run: () => {
          api.ui.dialog.replace(() =>
            api.ui.DialogPrompt({
              title: 'Start Goal Sequence',
              placeholder: 'Objective 1; Objective 2; Objective 3',
              onConfirm: text => {
                api.ui.dialog.clear();
                if (!text) return;
                void sendGoalCommand(`sequence ${text}`);
                api.ui.toast({
                  variant: 'info',
                  title: PRODUCT_DISPLAY_NAME,
                  message: outcomeNeutralLabel('sequence'),
                });
              },
            }),
          );
        },
      },
    ],
    bindings: [
      {key: chord('d'), cmd: 'fixate-on.dashboard'},
      {key: chord('p'), cmd: 'fixate-on.pause'},
      {key: chord('r'), cmd: 'fixate-on.resume'},
      {key: chord('c'), cmd: 'fixate-on.clear'},
      {key: chord('e'), cmd: 'fixate-on.edit'},
      {key: chord('k'), cmd: 'fixate-on.checkpoint'},
    ],
  });

  log('info', 'TUI companion initialized — subscribing to goal events.');

  // Sound notifications are additive: dispatch is non-blocking and safe from pipeline failures.
  const playSound = (
    kind: GoalTuiEvent['kind'],
    status?: GoalTuiSnapshot['status'],
  ): void => {
    const soundName = soundForEvent(kind, status);
    if (!soundName) return;
    try {
      void Promise.resolve(
        api.attention.notify({
          message: `Goal ${kind}${status ? ` → ${status}` : ''}`,
          sound: {name: soundName, when: 'always'},
          notification: false,
        }),
      ).catch(() => {
        // Best-effort: audio failures must not interrupt the event pipeline.
      });
    } catch {
      // Best-effort: audio failures must not interrupt the event pipeline.
    }
  };

  // The v1 server transport is silent, so the companion derives goal truth
  // from persisted state files: hydrate once, then poll and diff revisions.
  const coalescer = new ToastCoalescer(
    toast => {
      try {
        api.ui.toast({
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
    500, // Flush queued notifications periodically even if no new events arrive.
  );
  coalescer.startAutoFlush();

  const refreshLoop = createDiskRefreshLoop({
    directory: opts.directory,
    stateRoot: opts.stateRoot,
    store,
    intervalMs: 1000,
    onEvent: event => {
      playSound(event.kind, event.snapshot?.status);
      coalescer.accept(event, event.sessionID);
    },
  });

  // A single authoritative read seeds both the store and the refresh loop's baseline.
  // Awaiting this read prevents race conditions where pre-existing goals would be
  // reported as newly created during startup.
  //
  // The silent baseline suppresses transitional notifications, but active goals awaiting
  // user intervention are still summarized via a one-time initial briefing.
  let disposed = false;

  // Register teardown before awaiting disk reads to capture disposals during hydration.
  api.lifecycle.onDispose(() => {
    disposed = true;
    unregisterCommands();
    coalescer.stopAutoFlush();
    refreshLoop.stop();
    if (dashboardUnsubscribe) {
      try {
        dashboardUnsubscribe();
      } catch {
        // Best-effort cleanup.
      }
      dashboardUnsubscribe = null;
    }
    log('info', 'TUI companion disposed.');
  });

  try {
    const read = await readDiskGoalSnapshots(
      opts.directory,
      undefined,
      opts.stateRoot,
    );
    if (!disposed) {
      for (const snap of read.snapshots) {
        store.applyEvent({
          kind: 'create',
          sessionID: snap.sessionID,
          goalId: snap.goalId,
          snapshot: {...snap, origin: 'disk'},
          timestamp: Date.now(),
        });
      }
      log(
        'info',
        `Hydrated ${read.snapshots.length} goal(s) from persisted state.`,
      );
      // Only seed baseline if files were successfully read or the directory is missing;
      // seeding from an unreadable state would cause false "create" events on the next tick.
      if (read.filesRead > 0 || read.stateDirMissing) {
        refreshLoop.seedBaseline(read.snapshots);
      } else {
        log(
          'info',
          'state file was unreadable at boot; deferring the baseline rather than assuming an empty workspace',
        );
      }
      refreshLoop.start();

      // Emit a one-time briefing for goals waiting on user action.
      if (read.filesRead > 0) {
        const briefing = summarizeGoalsNeedingYou(read.snapshots);
        if (briefing) {
          log('info', `Briefing: ${briefing.message}`);
          coalescer.brief(BRIEFING_SESSION_KEY, briefing);
        }
      }
    }
  } catch {
    // Start loop even on initial read failure; subsequent polling will establish baseline.
    if (!disposed) refreshLoop.start();
  }
};

/**
 * Default export consumed by OpenCode's TUI plugin loader:
 * `{ "fixate-on/tui": {... } }` in `tui.json` resolves `id`
 * and calls `tui` to initialize the TUI companion.
 *
 * Note: this is a `TuiPluginModule` (has `tui`, no `server`), mutually
 * exclusive with the server `PluginModule` in `src/plugin.ts`. Register the
 * server entry in opencode.json and this entry in tui.json.
 */
const goalTuiPluginModule = {
  id: 'fixate-on-tui',
  tui: GoalTuiPlugin,
};

export default goalTuiPluginModule;

export type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginMeta,
} from '@opencode-ai/plugin/tui';
export type {
  GoalTuiSnapshot,
  GoalTuiEvent,
  GoalTuiEventKind,
  TuiStateStore,
  GoalBroadcaster,
  GoalTuiPublishFn,
} from './tui-state.ts';
export {
  createTuiStateStore,
  createGoalBroadcaster,
  serializeGoalForTui,
  parseTuiSyncEvent,
  GOAL_TUI_EVENT_TITLE,
} from './tui-state.ts';
