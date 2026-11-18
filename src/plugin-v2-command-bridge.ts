/**
 * Bridge 4 for the OpenCode v2 plugin adapter: registers the native `/goal`
 * command on add-only CommandEditor hosts (overriding built-in
 * `opencode.goal`, while letting post-plugin `commands.goal` config take
 * precedence when configured), with the update-only legacy fallback.
 *
 * Extracted from plugin-v2.ts to keep that module within the ~900-line
 * single-concern budget. Depends only on leaf helper modules — no import
 * back into plugin-v2.ts.
 */

import {buildContinueMessage} from './steering.ts';
import {
  applyV2LegacyCommandUpdates,
  assertV2AttachmentsBeforeRun,
  assertV2CommandCanDispatch,
  buildV2CommandKickoffDispatch,
  logV2DiagnosticEvent,
  validateV2CommandExecutionInput,
} from './plugin-v2-command.ts';
import {isReadOnlyGoalCommand} from './commands-args.ts';
import {
  normalizeInheritedAgentForPrompt,
  stripAgentListSortPrefix,
} from './agent-resolve.ts';
import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';
import {GOAL_COMMAND_TEMPLATE_PREFIX} from './native-agent-config.ts';
import type {PluginHooks} from './hooks.ts';
import type {RuntimeState} from './session-runtime.ts';
import type {PluginOptions} from './plugin-runtime.ts';
import type {RecentKickoffTextTracker} from './plugin-v2-command.ts';
import type {V2Context} from './plugin-v2-helpers.ts';

export interface V2CommandBridgeDeps {
  ctx: V2Context;
  hooks: PluginHooks & {runtime?: RuntimeState};
  pluginOptions: PluginOptions;
  recentKickoffTexts: RecentKickoffTextTracker;
  disposers: Array<() => Promise<void> | void>;
}

/**
 * Registers the native /goal command transform (Bridge 4). Returns true when
 * the transform was registered.
 */
export async function registerV2GoalCommandBridge(
  deps: V2CommandBridgeDeps,
): Promise<boolean> {
  const {ctx, hooks, pluginOptions, recentKickoffTexts, disposers} = deps;
  const commandName =
    (typeof pluginOptions.commandName === 'string' &&
      pluginOptions.commandName.trim().replace(/^\/+/, '').trim()) ||
    'goal';
  if (
    pluginOptions.registerCommand === false ||
    typeof ctx.command?.transform !== 'function'
  ) {
    return false;
  }
  try {
    const reg = await ctx.command.transform(draft => {
      if (typeof draft.add === 'function') {
        draft.add({
          name: commandName,
          description:
            'Set or manage the persistent thread goal [status|pause|resume|clear|list|history]',
          execute: async input => {
            const {sessionID, rawArgs, prompt, hasAttachments, delivery} =
              validateV2CommandExecutionInput(input);
            if (!rawArgs && hasAttachments) {
              throw new Error(
                `No objective provided. Use \`/${commandName} <condition>\` to set a goal.`,
              );
            }
            // Read-only = the line dispatches to a reporting subcommand
            // (status/info/history/log/list/ls) or is empty. Derived from
            // the same token rule as the command operation dispatch, so
            // `status-page ...` is a bare objective, not read-only.
            const readOnly = isReadOnlyGoalCommand(rawArgs);
            assertV2AttachmentsBeforeRun({
              rawArgs,
              hasAttachments,
              activeGoalStatus: goalId =>
                hooks.runtime?.getGoalStatus?.(sessionID, goalId),
              goalIds: () =>
                (hooks.runtime?.sessionGoals.get(sessionID) ?? []).map(
                  m => m.snapshot().goalId,
                ),
            });
            const runner = hooks.runtime?.executeSlashCommand;
            if (typeof runner !== 'function') {
              throw new Error('Goal command runner is unavailable.');
            }
            const res = await runner(
              {sessionID, command: commandName, arguments: rawArgs},
              {
                skipKickoff: true,
                skipReplayRecord: true,
                clearKickoffOnSkip: !readOnly,
                preserveKickoffOnSkip: readOnly,
              },
            );
            // Cancel a pending kickoff retry only when this command
            // succeeded AND supersedes the retained goal/run: unrelated,
            // rejected, or read-only commands must leave the retry armed.
            const pendingBefore =
              hooks.runtime?.pendingKickoffDispatch?.get(sessionID);
            const supersedesPending =
              res.ok &&
              pendingBefore !== undefined &&
              res.activatedGoal !== null &&
              pendingBefore.goalId === res.activatedGoal.goalId &&
              pendingBefore.runId === res.activatedGoal.runId;
            if (!readOnly || supersedesPending) {
              hooks.runtime?.clearKickoffTimer?.(sessionID);
              if (supersedesPending || !readOnly) {
                hooks.runtime?.pendingKickoffDispatch?.delete(sessionID);
              }
            }
            assertV2CommandCanDispatch({
              sessionID,
              rawArgs,
              hasAttachments,
              commandName,
              res,
              canDriveSession: hooks.runtime?.canDriveSession?.(sessionID),
            });
            logV2DiagnosticEvent(
              `command.transform ${sessionID} cmd=${res.subcmd || 'status'} enteredActive=${String(res.enteredActive)}`,
            );
            const activated = res.activatedGoal ?? res.after;
            if (!res.enteredActive || !activated) {
              // Non-activating commands (status/list/history/pause/clear/
              // handback/review) still produce output the host would
              // otherwise discard (the command contract is Promise<void>).
              // Deliver it as a synthetic, non-steering message so the
              // chat.message hook ignores it but the user sees it.
              if (res.ok && res.rendered) {
                try {
                  await ctx.session.synthetic({
                    sessionID,
                    text: res.rendered,
                    metadata: {
                      [GOAL_TUI_METADATA_KEY]: {kind: 'command-output'},
                    },
                  });
                } catch {
                  /* output delivery is best-effort */
                }
              }
              return;
            }
            const inherited = normalizeInheritedAgentForPrompt(
              activated.executionContext?.agent,
            );
            const dispatch = buildV2CommandKickoffDispatch({
              sessionID,
              goalID: activated.goalId,
              condition: activated.condition,
              kickoffText: buildContinueMessage(activated, {}),
              tuiMetadataKey: GOAL_TUI_METADATA_KEY,
              prompt,
              hasAttachments,
              delivery,
              resolvedAgent: inherited
                ? stripAgentListSortPrefix(inherited)
                : undefined,
            });
            try {
              hooks.runtime?.promptInFlightSessions.add(sessionID);
              try {
                if (dispatch.method === 'prompt') {
                  recentKickoffTexts.record(
                    sessionID,
                    String(dispatch.payload.text ?? ''),
                  );
                  await ctx.session.prompt(dispatch.payload);
                } else {
                  await ctx.session.synthetic(dispatch.payload);
                }
              } finally {
                hooks.runtime?.promptInFlightSessions.delete(sessionID);
              }
            } catch (error) {
              // A failed admission must not leave an active goal with no way
              // to start. Re-arm the delayed kickoff so a recovered host can
              // retry; surface the original failure to the caller.
              hooks.runtime?.pendingKickoffDispatch?.set(sessionID, {
                goalId: activated.goalId,
                runId: activated.runId,
                dispatch,
              });
              hooks.runtime?.scheduleKickoff?.(
                sessionID,
                activated.goalId,
                activated.runId,
              );
              logV2DiagnosticEvent(
                `command.transform ${sessionID} kickoff admission failed; retry scheduled: ${error instanceof Error ? error.message : String(error)}`,
              );
              throw error;
            }
            hooks.runtime?.pendingKickoffDispatch?.delete(sessionID);
          },
        });
        return;
      }
      if (typeof (draft as {update?: unknown}).update !== 'function') return;
      applyV2LegacyCommandUpdates(
        draft as {
          update: (
            name: string,
            edit: (command: Record<string, unknown>) => void,
          ) => void;
        },
        commandName,
        GOAL_COMMAND_TEMPLATE_PREFIX,
      );
    });
    disposers.push(() => reg.dispose());
    return true;
  } catch {
    /* optional command transform on older hosts */
    return false;
  }
}
// (isReadOnlyGoalCommand is imported directly from commands-args.ts above.)
