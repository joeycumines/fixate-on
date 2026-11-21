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
import {parseGoalCommand} from './commands-args.ts';
import {
  normalizeInheritedAgentForPrompt,
  stripAgentListSortPrefix,
} from './agent-resolve.ts';
import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';
import {GOAL_COMMAND_TEMPLATE_PREFIX} from './native-agent-config.ts';
import type {PluginHooks} from './hooks.ts';
import {
  acquirePromptInFlight,
  retainKickoffDispatch,
  removeKickoffDispatch,
  type RuntimeState,
  type PendingKickoffDispatch,
} from './session-runtime.ts';
import type {PluginOptions} from './plugin-runtime.ts';
import type {RecentKickoffTextTracker} from './plugin-v2-command.ts';
import type {V2Context} from './plugin-v2-helpers.ts';

export interface V2CommandBridgeDeps {
  ctx: V2Context;
  hooks: PluginHooks & {runtime?: RuntimeState};
  pluginOptions: PluginOptions;
  recentKickoffTexts: RecentKickoffTextTracker;
  disposers: Array<() => Promise<void> | void>;
  publishOutput?: (sessionID: string, text: string) => Promise<void>;
  /** Host-level agent switching, mirroring the v1->v2 prompt shim. */
  selectAgent?: (sessionID: string, agent: string) => Promise<void>;
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
            const userCommandStartedAt = Date.now();
            const {sessionID, rawArgs, prompt, hasAttachments, delivery} =
              validateV2CommandExecutionInput(input);
            const interventionAtStart =
              hooks.runtime?.userInterventions.get(sessionID);
            if (!rawArgs && hasAttachments) {
              throw new Error(
                `No objective provided. Use \`/${commandName} <condition>\` to set a goal.`,
              );
            }
            const command = parseGoalCommand(rawArgs);
            assertV2AttachmentsBeforeRun({
              rawArgs,
              hasAttachments,
              activeGoalStatus: goalId =>
                hooks.runtime?.getGoalStatus?.(sessionID, goalId),
              canRecoverAttachedEdit: goalId => {
                const machines =
                  hooks.runtime?.sessionGoals.get(sessionID) ?? [];
                // Resolve the same goal the status check uses: the explicit
                // id, else the focused goal, else the most recently added
                // machine (getMachine's fallback), never blindly machines[0].
                const targetId =
                  goalId ?? hooks.runtime?.focusedGoalId.get(sessionID);
                const machine = targetId
                  ? machines.find(m => m.snapshot().goalId === targetId)
                  : machines[machines.length - 1];
                const snap = machine?.snapshot();
                return Boolean(
                  snap?.kickoffAdmissionPending &&
                  !hooks.runtime?.pendingKickoffDispatch
                    ?.get(sessionID)
                    ?.has(snap.goalId),
                );
              },
              goalIds: () =>
                (hooks.runtime?.sessionGoals.get(sessionID) ?? []).map(
                  m => m.snapshot().goalId,
                ),
            });
            const runner = hooks.runtime?.executeSlashCommand;
            if (typeof runner !== 'function') {
              throw new Error('Goal command runner is unavailable.');
            }
            // The first persisted activation already carries the input marker.
            // Fence idle while the command prepares its retained dispatch.
            const releaseCommand = hasAttachments
              ? acquirePromptInFlight(hooks.runtime, sessionID)
              : () => {};
            try {
              const res = await runner(
                {sessionID, command: commandName, arguments: rawArgs},
                {
                  skipKickoff: true,
                  skipReplayRecord: true,
                  preserveKickoffOnSkip: true,
                  hasAttachments,
                  userCommandStartedAt,
                },
              );
              const runtime = hooks.runtime;
              if (!runtime) {
                throw new Error('Goal runtime is unavailable.');
              }
              const targetGoalId =
                res.targetGoalId ?? res.activatedGoal?.goalId;
              const retained = targetGoalId
                ? runtime.pendingKickoffDispatch
                    ?.get(sessionID)
                    ?.get(targetGoalId)
                : undefined;
              const target = targetGoalId
                ? runtime.sessionGoals
                    .get(sessionID)
                    ?.find(m => m.snapshot().goalId === targetGoalId)
                    ?.snapshot()
                : undefined;
              // Explicit resume can re-admit a retained payload even if the goal
              // was already active. Never duplicate an admission still in flight.
              if (
                res.ok &&
                command.action === 'resume' &&
                retained &&
                target?.status === 'active' &&
                target.runId === retained.runId
              ) {
                res.enteredActive = !retained.inFlight;
                res.activatedGoal = retained.inFlight ? null : target;
                res.after = target;
              }
              assertV2CommandCanDispatch({
                sessionID,
                rawArgs,
                hasAttachments,
                commandName,
                res,
                cancelledByHuman:
                  runtime.userInterventions.get(sessionID) !==
                  interventionAtStart,
                canDriveSession: hooks.runtime?.canDriveSession?.(sessionID),
              });
              logV2DiagnosticEvent(
                `command.transform ${sessionID} cmd=${res.subcmd || 'status'} enteredActive=${String(res.enteredActive)}`,
              );
              const activated = res.activatedGoal ?? res.after;
              if (!res.enteredActive || !activated) {
                // Non-activating commands (status/list/history/pause/clear/
                // handback/review) need a passive display channel: even a
                // synthetic with resume:false enters the host's model inbox.
                if (res.ok && res.rendered) {
                  const publishOutput =
                    deps.publishOutput ?? pluginOptions.goalMessenger;
                  if (!publishOutput)
                    throw new Error(
                      `Goal command output is unavailable.\n${res.rendered}`,
                    );
                  await publishOutput(sessionID, res.rendered);
                }
                return;
              }
              const live = runtime.sessionGoals
                .get(sessionID)
                ?.find(m => m.snapshot().goalId === activated.goalId)
                ?.snapshot();
              if (
                !live ||
                live.runId !== activated.runId ||
                live.status !== 'active'
              )
                throw new Error(
                  'Goal changed before kickoff admission; no prompt was sent.',
                );
              const previous = runtime.pendingKickoffDispatch
                ?.get(sessionID)
                ?.get(live.goalId);
              const waitForPrevious = previous?.inFlight === true;
              const previousPayload =
                previous?.runId === live.runId
                  ? (previous.dispatch as {payload?: Record<string, unknown>})
                      .payload
                  : undefined;
              const inherited = normalizeInheritedAgentForPrompt(
                live.executionContext?.agent,
              );
              const mergedPrompt: Record<string, unknown> = {...prompt};
              for (const key of ['files', 'agents', 'skills'] as const) {
                const before = Array.isArray(previousPayload?.[key])
                  ? (previousPayload[key] as unknown[])
                  : [];
                const added = Array.isArray(prompt?.[key])
                  ? (prompt[key] as unknown[])
                  : [];
                if (before.length || added.length) {
                  const seen = new Set<string>();
                  mergedPrompt[key] = [...before, ...added].filter(item => {
                    const k =
                      typeof item === 'string'
                        ? `s:${item}`
                        : `j:${JSON.stringify(item)}`;
                    if (seen.has(k)) return false;
                    seen.add(k);
                    return true;
                  });
                }
              }
              const carriesAttachments = ['files', 'agents', 'skills'].some(
                key =>
                  Array.isArray(mergedPrompt[key]) &&
                  (mergedPrompt[key] as unknown[]).length > 0,
              );
              const dispatch = buildV2CommandKickoffDispatch({
                sessionID,
                goalID: live.goalId,
                condition: live.condition,
                kickoffText: buildContinueMessage(live, {}),
                tuiMetadataKey: GOAL_TUI_METADATA_KEY,
                prompt: mergedPrompt,
                hasAttachments: carriesAttachments,
                // The host fills an omitted command delivery with "steer".
                // A resume is a retry of the retained admission, so that
                // default must not turn a queued payload into an interruption.
                delivery:
                  typeof previousPayload?.delivery === 'string'
                    ? previousPayload.delivery
                    : delivery,
                resolvedAgent: inherited
                  ? stripAgentListSortPrefix(inherited)
                  : undefined,
              });
              const pending: PendingKickoffDispatch = {
                goalId: live.goalId,
                runId: live.runId,
                dispatch,
                attempts: 0,
                inFlight: !waitForPrevious,
              };
              // Claim this goal's dispatch before the await. Late completion can
              // only remove this exact object, never another goal or replacement.
              runtime.clearKickoffTimer?.(sessionID, live.goalId);
              retainKickoffDispatch(runtime, sessionID, pending);
              if (waitForPrevious) {
                // Another command can claim admission while this command awaits
                // its state commit. Keep the new inputs as the successor; the
                // older call's completion cannot remove this dispatch identity.
                runtime.scheduleKickoff?.(sessionID, live.goalId, live.runId);
                return;
              }
              const releasePrompt = acquirePromptInFlight(runtime, sessionID);
              let admitted = false;
              try {
                if (!runtime.prepareKickoffAdmission)
                  throw new Error(
                    'Kickoff admission persistence is unavailable.',
                  );
                await runtime.prepareKickoffAdmission(sessionID, pending);
                const beforeAdmissionMachine = runtime.sessionGoals
                  .get(sessionID)
                  ?.find(m => m.snapshot().goalId === live.goalId);
                const beforeAdmission = beforeAdmissionMachine?.snapshot();
                const intervention = runtime.userInterventions.get(sessionID);
                if (
                  intervention !== interventionAtStart &&
                  intervention &&
                  beforeAdmission?.status === 'active' &&
                  beforeAdmission.runId === live.runId
                ) {
                  await beforeAdmissionMachine!.transition('paused', {
                    source: 'chat-message',
                    stopReason: intervention.stopReason,
                    detail:
                      'A newer human message cancelled kickoff admission.',
                  });
                }
                if (
                  runtime.canDriveSession?.(sessionID) === false ||
                  runtime.pendingKickoffDispatch
                    ?.get(sessionID)
                    ?.get(live.goalId) !== pending ||
                  beforeAdmission?.status !== 'active' ||
                  beforeAdmission.runId !== live.runId ||
                  intervention !== interventionAtStart
                )
                  throw new Error(
                    'Goal changed before kickoff admission; no prompt was sent.',
                  );
                if (dispatch.method === 'prompt') {
                  recentKickoffTexts.record(
                    sessionID,
                    String(dispatch.payload.text ?? ''),
                  );
                  const kickoffAgent = dispatch.payload.agent;
                  if (
                    typeof kickoffAgent === 'string' &&
                    kickoffAgent.length > 0 &&
                    deps.selectAgent
                  )
                    await deps.selectAgent(sessionID, kickoffAgent);
                  await ctx.session.prompt(dispatch.payload);
                } else {
                  await ctx.session.synthetic(dispatch.payload);
                }
                admitted = true;
              } catch (error) {
                const current = runtime.sessionGoals
                  .get(sessionID)
                  ?.find(m => m.snapshot().goalId === live.goalId);
                const currentGoal = current?.snapshot();
                const owns =
                  runtime.pendingKickoffDispatch
                    ?.get(sessionID)
                    ?.get(live.goalId) === pending;
                if (owns && !runtime.disposed) {
                  if (
                    !current ||
                    current.isTerminal() ||
                    currentGoal?.runId !== live.runId
                  ) {
                    removeKickoffDispatch(runtime, sessionID, pending);
                  } else if (currentGoal.status === 'active') {
                    runtime.scheduleKickoff?.(
                      sessionID,
                      live.goalId,
                      live.runId,
                    );
                  }
                }
                logV2DiagnosticEvent(
                  `command.transform ${sessionID} kickoff admission failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                throw error;
              } finally {
                pending.inFlight = false;
                try {
                  if (admitted)
                    await runtime.completeKickoffAdmission?.(
                      sessionID,
                      pending,
                    );
                } finally {
                  releasePrompt();
                }
              }
            } finally {
              releaseCommand();
            }
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
