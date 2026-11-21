/**
 * Command-dispatch seam for v1 hosts.
 *
 * Manages the delayed kickoff probe (`scheduleKickoff` and timer registry) and
 * the `command.execute.before` hook that processes commands and schedules
 * continuation prompts when goals become active.
 */

import {parseGoalCommand} from './commands-args.ts';
import {markCommandDispatch, markSlashDispatch} from './command-dispatch.ts';
import {buildContinueMessage} from './steering.ts';
import {
  normalizeInheritedAgentForPrompt,
  stripAgentListSortPrefix,
} from './agent-resolve.ts';
import {findLatestAssistantMessage, getMessageID} from './message-helpers.ts';
import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';
import type {SessionContext} from './hooks-types.ts';
import {
  acquirePromptInFlight,
  removeKickoffDispatch,
  type RuntimeState,
  type PendingKickoffDispatch,
} from './session-runtime.ts';
import type {SessionStateManager} from './session-state-manager.ts';
import type {OpenCodeSessionApi} from './session-api.ts';
import {TERMINAL_STATUSES, type GoalState} from './state-machine.ts';

export interface SlashCommandResult {
  handled: boolean;
  ok: boolean;
  sessionID: string;
  args: string;
  subcmd: string;
  text: string;
  receipt: string;
  rendered: string;
  before: GoalState | null;
  after: GoalState | null;
  activatedGoal: GoalState | null;
  enteredActive: boolean;
  targetGoalId?: string;
  error?: string;
}

export interface KickoffWiring {
  kickoffTimers: Map<string, ReturnType<typeof setTimeout>>;
  clearKickoffTimer: (sessionID: string, goalId?: string) => void;
  scheduleKickoff: (sessionID: string, goalId: string, runId: string) => void;
  executeSlashCommand: (
    input: {sessionID?: string; command?: string; arguments?: string},
    options?: {
      skipKickoff?: boolean;
      skipReplayRecord?: boolean;
      clearKickoffOnSkip?: boolean;
      preserveKickoffOnSkip?: boolean;
      hasAttachments?: boolean;
      userCommandStartedAt?: number;
      source?: 'user-command' | 'goal-command';
    },
  ) => Promise<SlashCommandResult>;
  commandExecuteBefore: (
    input: {sessionID?: string; command?: string; arguments?: string},
    output: {parts: unknown[]},
  ) => Promise<void>;
}

export function createKickoffWiring(args: {
  runtime: RuntimeState;
  stateManager: SessionStateManager;
  sessionApi: OpenCodeSessionApi;
  getSessionContext: (sessionID: string) => SessionContext | undefined;
  transitionReceipt: (
    sessionID: string,
    before: GoalState | null,
    after: GoalState | null,
    source: 'user-command' | 'goal-command',
  ) => Promise<{receipt: string; changed: boolean}>;
  commandName: string;
  registerCommand: boolean;
  kickoffDelayMs?: number;
}): KickoffWiring {
  const {
    runtime,
    stateManager,
    sessionApi,
    getSessionContext,
    transitionReceipt,
    commandName,
    registerCommand,
    kickoffDelayMs,
  } = args;

  // On v1 hosts, `command.execute.before` intercepts execution before command
  // templates run, and /goal is registered without an agent to keep output user-visible.
  // Because no model turn is launched, `session.idle` does not fire and the continuation
  // loop would not wake automatically.
  //
  // To ensure continuation parity, schedule a delayed kickoff probe when a goal enters
  // active status. The kickoff sends an initial continuation prompt unless an agent turn
  // materialized in the interim. (v2 routes commands via templates and does not use this hook.)
  const kickoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const timerOwners = new Map<
    string,
    {sessionID: string; goalId: string; runId: string}
  >();
  const MAX_KICKOFF_RETRY_ATTEMPTS = 3;
  // Bound busy-session deferrals so a session left permanently in
  // promptInFlightSessions cannot respawn a 50ms timer forever. Reaching the
  // cap stops this timer chain; a later idle may schedule a fresh chain.
  const busyDefers = new Map<string, number>();
  const clearKickoffTimer = (sessionID: string, goalId?: string): void => {
    for (const [key, owner] of timerOwners) {
      if (
        owner.sessionID !== sessionID ||
        (goalId !== undefined && owner.goalId !== goalId)
      )
        continue;
      busyDefers.delete(key);
      const timer = kickoffTimers.get(key);
      if (timer !== undefined) clearTimeout(timer);
      kickoffTimers.delete(key);
      timerOwners.delete(key);
    }
  };
  const machineByGoalId = (
    sessionID: string,
    goalId: string,
  ): ReturnType<SessionStateManager['getMachine']> => {
    const context = getSessionContext(sessionID);
    const machine =
      context?.getMachineById?.(goalId) ??
      context?.listMachines?.().find(m => m.snapshot().goalId === goalId) ??
      stateManager.getMachine(sessionID);
    return machine?.snapshot().goalId === goalId ? machine : null;
  };
  const ownsDispatch = (
    sessionID: string,
    pending: PendingKickoffDispatch,
  ): boolean =>
    !runtime.disposed &&
    runtime.pendingKickoffDispatch?.get(sessionID)?.get(pending.goalId) ===
      pending;
  const prepareKickoffAdmission = async (
    sessionID: string,
    pending: PendingKickoffDispatch,
  ): Promise<void> => {
    if (!ownsDispatch(sessionID, pending))
      throw new Error('Kickoff changed before admission.');
    if ((pending.dispatch as {method?: string}).method !== 'prompt') return;
    const machine = machineByGoalId(sessionID, pending.goalId);
    if (!machine || machine.snapshot().runId !== pending.runId)
      throw new Error('Goal changed before kickoff admission.');
    const marked = await machine.mutate(
      goal => {
        if (ownsDispatch(sessionID, pending))
          goal.kickoffAdmissionPending = true;
      },
      {
        source: 'idle-handler',
        detail: 'Retain required kickoff inputs until host admission succeeds',
        skipRevision: true,
      },
    );
    if (!marked.ok || !(await getSessionContext(sessionID)?.persist()))
      throw new Error(
        'NOT SAVED — kickoff inputs were not admitted because the recovery marker could not be saved.',
      );
    if (!ownsDispatch(sessionID, pending))
      throw new Error('Kickoff changed before admission.');
  };
  const completeKickoffAdmission = async (
    sessionID: string,
    pending: PendingKickoffDispatch,
  ): Promise<void> => {
    // Acceptance is final even if saving its receipt fails: never retry an
    // accepted host input merely because the local persistence step failed.
    if (!removeKickoffDispatch(runtime, sessionID, pending)) return;
    const machine = machineByGoalId(sessionID, pending.goalId);
    if (!machine || machine.snapshot().runId !== pending.runId) return;
    if (!machine.snapshot().kickoffAdmissionPending) return;
    try {
      const cleared = await machine.mutate(
        goal => {
          if (
            !runtime.pendingKickoffDispatch?.get(sessionID)?.has(pending.goalId)
          )
            goal.kickoffAdmissionPending = false;
        },
        {
          source: 'idle-handler',
          detail: 'Host accepted the required kickoff inputs',
          skipRevision: true,
        },
      );
      if (!cleared.ok) throw new Error(cleared.error);
      if (!(await getSessionContext(sessionID)?.persist()))
        throw new Error('session persistence returned false');
    } catch (error) {
      throw new Error(
        `Kickoff was admitted, but its cleared recovery marker could not be saved. It will not be retried automatically. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  runtime.prepareKickoffAdmission = prepareKickoffAdmission;
  runtime.completeKickoffAdmission = completeKickoffAdmission;
  runtime.hasKickoffTimer = (sessionID: string, goalId: string) =>
    kickoffTimers.has(JSON.stringify([sessionID, goalId]));
  const lastAssistantIdOf = (messages: unknown[]): string | null => {
    if (!Array.isArray(messages)) return null;
    const latest = findLatestAssistantMessage(messages);
    return latest ? getMessageID(latest) : '';
  };
  const scheduleKickoff = (
    sessionID: string,
    goalId: string,
    runId: string,
    overrideDelayMs?: number,
    busyDeferrals = 0,
  ): void => {
    if (!sessionID || runtime.disposed) return;
    clearKickoffTimer(sessionID, goalId);
    const key = JSON.stringify([sessionID, goalId]);
    busyDefers.set(key, busyDeferrals);
    const hasPendingAtSchedule =
      runtime.pendingKickoffDispatch?.get(sessionID)?.has(goalId) ?? false;
    const baselinePromise = hasPendingAtSchedule
      ? Promise.resolve(null)
      : sessionApi
          .messages(sessionID, {limit: 5})
          .then(r => lastAssistantIdOf(Array.isArray(r) ? r : []))
          .catch(() => null);
    const baseDelayMs = Math.max(0, kickoffDelayMs ?? 2500);
    const delayMs =
      overrideDelayMs !== undefined ? overrideDelayMs : baseDelayMs;
    const busyDeferDelayMs = Math.max(baseDelayMs, 50);
    const timer = setTimeout(() => {
      if (kickoffTimers.get(key) !== timer) return;
      const deferrals = busyDefers.get(key) ?? 0;
      kickoffTimers.delete(key);
      timerOwners.delete(key);
      busyDefers.delete(key);
      void (async () => {
        if (runtime.disposed || !runtime.canDriveSession?.(sessionID)) return;
        let machine = machineByGoalId(sessionID, goalId);
        let snap = machine?.snapshot();
        let pending = runtime.pendingKickoffDispatch
          ?.get(sessionID)
          ?.get(goalId);
        if (!machine || snap?.runId !== runId || machine.isTerminal()) {
          if (pending && pending.runId === runId)
            removeKickoffDispatch(runtime, sessionID, pending);
          return;
        }
        if (snap.status !== 'active') return;
        if (pending && (pending.runId !== runId || pending.exhausted)) return;
        // Busy admissions defer their timer instead of silently losing the retry,
        // but only up to a bound; a permanently busy session must not spin here.
        if (
          runtime.promptInFlightSessions.has(sessionID) ||
          pending?.inFlight
        ) {
          if (deferrals < MAX_KICKOFF_RETRY_ATTEMPTS)
            scheduleKickoff(
              sessionID,
              goalId,
              runId,
              busyDeferDelayMs,
              deferrals + 1,
            );
          return;
        }
        // New assistant activity supersedes a generic kickoff, but can never
        // stand in for an attachment payload the host has not admitted.
        if (!pending) {
          const [baseline, recent] = await Promise.all([
            baselinePromise,
            sessionApi.messages(sessionID, {limit: 5}).catch(() => null),
          ]);
          const fresh = lastAssistantIdOf(Array.isArray(recent) ? recent : []);
          if (
            baseline !== null &&
            fresh !== null &&
            fresh !== '' &&
            fresh !== baseline
          )
            return;
        }
        machine = machineByGoalId(sessionID, goalId);
        snap = machine?.snapshot();
        if (
          !machine ||
          runtime.disposed ||
          !runtime.canDriveSession?.(sessionID) ||
          snap?.runId !== runId ||
          snap.status !== 'active'
        )
          return;
        pending = runtime.pendingKickoffDispatch?.get(sessionID)?.get(goalId);
        if (
          runtime.promptInFlightSessions.has(sessionID) ||
          pending?.inFlight
        ) {
          if (deferrals < MAX_KICKOFF_RETRY_ATTEMPTS)
            scheduleKickoff(
              sessionID,
              goalId,
              runId,
              busyDeferDelayMs,
              deferrals + 1,
            );
          return;
        }
        if (pending) {
          if (
            pending.runId !== runId ||
            pending.exhausted ||
            !runtime.retryPendingKickoffDispatch
          )
            return;
          const retained = pending;
          retained.inFlight = true;
          const releasePrompt = acquirePromptInFlight(runtime, sessionID);
          let admitted = false;
          let exhaustionAnnouncement: string | undefined;
          try {
            const dispatch = retained.dispatch as {
              payload?: Record<string, unknown>;
            };
            if (dispatch.payload)
              dispatch.payload.text = buildContinueMessage(snap, {});
            await prepareKickoffAdmission(sessionID, retained);
            const beforeAdmission = machineByGoalId(
              sessionID,
              goalId,
            )?.snapshot();
            if (
              runtime.canDriveSession?.(sessionID) === false ||
              !ownsDispatch(sessionID, retained) ||
              beforeAdmission?.status !== 'active' ||
              beforeAdmission.runId !== runId
            )
              return;
            await runtime.retryPendingKickoffDispatch(
              sessionID,
              retained.dispatch,
            );
            admitted = true;
          } catch {
            if (
              runtime.canDriveSession?.(sessionID) === false ||
              !ownsDispatch(sessionID, retained)
            )
              return;
            const current = machineByGoalId(sessionID, goalId);
            const goal = current?.snapshot();
            if (!current || goal?.runId !== runId || current.isTerminal()) {
              removeKickoffDispatch(runtime, sessionID, retained);
              return;
            }
            if (goal.status !== 'active') return;
            retained.attempts = (retained.attempts ?? 0) + 1;
            if (retained.attempts >= MAX_KICKOFF_RETRY_ATTEMPTS) {
              retained.exhausted = true;
              const isPromptDispatch =
                (retained.dispatch as {method?: string}).method === 'prompt';
              const message = isPromptDispatch
                ? `Kickoff admission failed after ${retained.attempts} retries; attachments are retained. Run \`/${commandName} resume ${goalId}\` after the host recovers.`
                : `Kickoff failed after ${retained.attempts} retries. Run \`/${commandName} resume ${goalId}\` after the host recovers.`;
              const paused = await current.transition('paused', {
                source: 'idle-handler',
                stopReason: isPromptDispatch
                  ? 'kickoff admission failed'
                  : 'kickoff failed',
                detail: message,
              });
              if (
                !paused.ok ||
                !ownsDispatch(sessionID, retained) ||
                current.snapshot().status !== 'paused'
              )
                return;
              await current.mutate(
                g => {
                  g.lastStatus = message;
                },
                {
                  source: 'idle-handler',
                  detail: 'Retained failed kickoff for explicit resume',
                  skipPersist: true,
                },
              );
              await current.addNotice('prompt-failure', message);
              await getSessionContext(sessionID)?.persist();
              if (ownsDispatch(sessionID, retained))
                exhaustionAnnouncement = message;
            } else {
              scheduleKickoff(sessionID, goalId, runId);
            }
          } finally {
            retained.inFlight = false;
            try {
              if (admitted) {
                try {
                  await completeKickoffAdmission(sessionID, retained);
                } catch (error) {
                  await runtime.announceKickoffFailure?.(
                    sessionID,
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }
            } finally {
              releasePrompt();
            }
          }
          if (exhaustionAnnouncement && ownsDispatch(sessionID, retained)) {
            await runtime.announceKickoffFailure?.(
              sessionID,
              exhaustionAnnouncement,
            );
          }
          return;
        }
        let message = buildContinueMessage(snap, {});
        if (typeof message !== 'string') message = String(message ?? '');
        const resolvedAgent = normalizeInheritedAgentForPrompt(
          snap.executionContext?.agent,
        );
        const promptInput: Record<string, unknown> = {
          parts: [
            {
              type: 'text',
              text: message,
              metadata: {[GOAL_TUI_METADATA_KEY]: {kind: 'kickoff'}},
              synthetic: true,
            },
          ],
        };
        if (resolvedAgent)
          promptInput.agent = stripAgentListSortPrefix(resolvedAgent);
        const releasePrompt = acquirePromptInFlight(runtime, sessionID);
        try {
          await sessionApi.promptAsync(
            sessionID,
            promptInput as {parts: unknown[]},
          );
        } catch {
          // The regular idle path owns continuation prompt failures.
        } finally {
          releasePrompt();
        }
      })().catch(() => {
        // A failed persistence/receipt must not escape as an unhandled rejection.
      });
    }, delayMs);
    kickoffTimers.set(key, timer);
    timerOwners.set(key, {sessionID, goalId, runId});
    if (typeof timer === 'object' && timer !== null && 'unref' in timer)
      (timer as {unref: () => void}).unref();
  };

  const executeSlashCommand = async (
    input: {sessionID?: string; command?: string; arguments?: string},
    options?: {
      skipKickoff?: boolean;
      skipReplayRecord?: boolean;
      clearKickoffOnSkip?: boolean;
      preserveKickoffOnSkip?: boolean;
      hasAttachments?: boolean;
      userCommandStartedAt?: number;
      source?: 'user-command' | 'goal-command';
    },
  ): Promise<SlashCommandResult> => {
    const userCommandStartedAt = options?.userCommandStartedAt ?? Date.now();
    const interventionAtStart = runtime.userInterventions.get(
      input?.sessionID ?? '',
    );
    const emptyResult = (
      overrides: Partial<SlashCommandResult>,
    ): SlashCommandResult => ({
      handled: false,
      ok: true,
      sessionID: input?.sessionID ?? '',
      args: '',
      subcmd: '',
      text: '',
      receipt: '',
      rendered: '',
      before: null,
      after: null,
      activatedGoal: null,
      enteredActive: false,
      ...overrides,
    });

    if (!input || !input.command || runtime.disposed) {
      return emptyResult({});
    }
    if (
      typeof input.arguments !== 'string' &&
      input.arguments !== undefined &&
      input.arguments !== null
    ) {
      return emptyResult({
        handled: true,
        ok: false,
        rendered: 'Goal command arguments must be text.',
        error: 'Goal command arguments must be text.',
      });
    }
    const cmd = input.command.trim();
    let commandArgs = '';
    if (cmd === commandName) {
      commandArgs =
        typeof input.arguments === 'string' ? input.arguments.trim() : '';
    } else if (cmd.startsWith(`${commandName} `)) {
      const sub = cmd.slice(commandName.length + 1).trim();
      const extra =
        typeof input.arguments === 'string' ? input.arguments.trim() : '';
      commandArgs = extra ? `${sub} ${extra}` : sub;
    } else {
      return emptyResult({});
    }
    const args = commandArgs.trim();
    const sessionID = input.sessionID ?? '';
    if (typeof sessionID === 'string' && sessionID.trim()) {
      runtime.liveSessions.add(sessionID);
    }

    const session = getSessionContext(sessionID);
    if (!session) {
      const msg =
        'No active goal. Set one with `/' + commandName + ' <condition>`.';
      return emptyResult({
        handled: true,
        ok: false,
        sessionID,
        args,
        rendered: msg,
        error: msg,
      });
    }

    const beforeMachine = session.getMachine();
    const before = beforeMachine?.snapshot() ?? null;
    const beforeByGoal = new Map(
      (session.listMachines?.() ?? (beforeMachine ? [beforeMachine] : [])).map(
        m => {
          const snap = m.snapshot();
          return [snap.goalId, snap] as const;
        },
      ),
    );
    // Mark slash dispatch so that v1 replaying the command as a chat message can be suppressed.
    if (options?.source !== 'goal-command') markSlashDispatch(sessionID, args);

    const subcmd = args.toLowerCase().split(/\s+/)[0] ?? '';
    const {handleCommandOutcome, formatCommandHeader} =
      await import('./commands.ts');
    try {
      const outcome = await handleCommandOutcome(args, session, commandName, {
        hasAttachments: options?.hasAttachments,
        userCommandStartedAt,
      });
      const intervention = runtime.userInterventions.get(sessionID);
      if (outcome.ok && intervention !== interventionAtStart && intervention) {
        const target = outcome.targetGoalId
          ? session.getMachineById?.(outcome.targetGoalId)
          : null;
        if (target?.snapshot().status === 'active') {
          const paused = await target.transition('paused', {
            source: 'chat-message',
            stopReason: intervention.stopReason,
            detail:
              'A human message arrived while the goal command was being saved; kickoff cancelled.',
          });
          if (paused.ok) {
            await session.persist();
            outcome.text +=
              '\nGoal paused because a newer human message arrived before kickoff.';
          }
        }
      }
      const text = outcome.text;
      const header = formatCommandHeader(runtime.hasTuiCompanion, subcmd);
      // Activation is a property of the goal the command actually targeted,
      // not of the focused presentation goal. A named resume can activate a
      // background goal while focus stays elsewhere.
      const afterMachine = session.getMachine();
      const focusedAfter = afterMachine?.snapshot() ?? null;
      const afterByGoal = new Map(
        (session.listMachines?.() ?? (afterMachine ? [afterMachine] : [])).map(
          m => {
            const snap = m.snapshot();
            return [snap.goalId, snap] as const;
          },
        ),
      );
      let activatedGoal: GoalState | null = null;
      // When the command outcome names its target goal deterministically (e.g.
      // `add`), prefer that goal over the first newly-active machine: two
      // concurrent `add` commands would otherwise both attach the first goal.
      const namedGoalId = outcome.targetGoalId;
      const action = parseGoalCommand(args).action;
      const canActivate = ['set', 'add', 'sequence', 'resume', 'edit'].includes(
        action,
      );
      if (canActivate && namedGoalId) {
        const named = afterByGoal.get(namedGoalId) ?? null;
        const prior = beforeByGoal.get(namedGoalId);
        if (
          named?.status === 'active' &&
          (!prior || prior.status !== 'active' || prior.runId !== named.runId)
        )
          activatedGoal = named;
      }
      if (canActivate && !namedGoalId) {
        for (const [goalId, afterGoal] of afterByGoal) {
          if (afterGoal.status !== 'active') continue;
          const beforeGoal = beforeByGoal.get(goalId) ?? null;
          if (
            beforeGoal === null ||
            beforeGoal.goalId !== afterGoal.goalId ||
            beforeGoal.runId !== afterGoal.runId ||
            beforeGoal.status !== 'active'
          ) {
            activatedGoal = afterGoal;
            break;
          }
        }
      }
      if (outcome.ok && action === 'resume' && namedGoalId) {
        const retained = runtime.pendingKickoffDispatch
          ?.get(sessionID)
          ?.get(namedGoalId);
        const resumed = afterByGoal.get(namedGoalId);
        if (
          retained &&
          resumed?.status === 'active' &&
          retained.runId === resumed.runId
        ) {
          if (retained.inFlight) {
            activatedGoal = null;
          } else {
            retained.exhausted = false;
            retained.attempts = 0;
            activatedGoal = resumed;
          }
        }
        if (
          !retained &&
          options?.hasAttachments &&
          resumed?.status === 'active' &&
          resumed.kickoffAdmissionPending
        )
          activatedGoal = resumed;
      }
      if (outcome.ok && action === 'edit' && namedGoalId) {
        const edited = afterByGoal.get(namedGoalId);
        const retained = runtime.pendingKickoffDispatch
          ?.get(sessionID)
          ?.get(namedGoalId);
        if (
          retained &&
          edited?.status === 'active' &&
          retained.runId === edited.runId
        ) {
          if (retained.inFlight) {
            activatedGoal = null;
          } else {
            retained.exhausted = false;
            retained.attempts = 0;
            activatedGoal = edited;
          }
        }
        if (
          !retained &&
          options?.hasAttachments &&
          edited?.status === 'active' &&
          edited.kickoffAdmissionPending
        )
          activatedGoal = edited;
        if (
          edited?.status === 'active' &&
          beforeByGoal.get(namedGoalId)?.kickoffAdmissionPending &&
          !edited.kickoffAdmissionPending
        )
          activatedGoal = edited;
      }
      const after = activatedGoal ?? focusedAfter;
      // Describe the state transition of the goal the command actually
      // targeted, not the focused presentation goal. A named resume/edit can
      // activate a background goal while focus stays elsewhere; comparing the
      // focused goal would produce no receipt for the goal that changed.
      const receiptGoalId = outcome.targetGoalId ?? after?.goalId;
      const receiptBefore =
        (receiptGoalId ? beforeByGoal.get(receiptGoalId) : null) ?? before;
      const receiptAfter =
        (receiptGoalId ? afterByGoal.get(receiptGoalId) : null) ?? after;
      const {receipt, changed: dispatchChanged} = await transitionReceipt(
        sessionID,
        receiptBefore,
        receiptAfter,
        options?.source ?? 'user-command',
      );
      // Record dispatch to prevent duplicate mutations if the host also invokes the command template.
      // Native v2 commands are the only invocation (no duplicate template channel), so they must
      // not populate this cache: a later deliberate goal-command call would replay a stale receipt.
      if (!options?.skipReplayRecord) {
        markCommandDispatch(sessionID, args, text, receipt, dispatchChanged);
      }
      const rendered = `${header}\n${text}${receipt ? `\n\n${receipt}` : ''}`;
      const enteredActive = outcome.ok && activatedGoal !== null;
      // Cancel only work whose own goal actually stopped or disappeared.
      // A rejected/unrelated command cannot cancel another goal's admission.
      if (outcome.ok) {
        for (const owner of [...timerOwners.values()]) {
          if (owner.sessionID !== sessionID) continue;
          const current = afterByGoal.get(owner.goalId);
          if (
            !current ||
            current.runId !== owner.runId ||
            current.status !== 'active'
          )
            clearKickoffTimer(sessionID, owner.goalId);
        }
        for (const pending of runtime.pendingKickoffDispatch
          ?.get(sessionID)
          ?.values() ?? []) {
          const current = afterByGoal.get(pending.goalId);
          if (
            !current ||
            current.runId !== pending.runId ||
            TERMINAL_STATUSES.has(current.status)
          )
            removeKickoffDispatch(runtime, sessionID, pending);
        }
      }
      if (
        enteredActive &&
        (registerCommand || options?.source === 'goal-command') &&
        !options?.skipKickoff
      ) {
        scheduleKickoff(sessionID, after!.goalId, after!.runId);
      } else if (
        outcome.ok &&
        !options?.preserveKickoffOnSkip &&
        options?.clearKickoffOnSkip &&
        outcome.targetGoalId
      ) {
        clearKickoffTimer(sessionID, outcome.targetGoalId);
      }
      return {
        handled: true,
        ok: outcome.ok,
        sessionID,
        args,
        subcmd,
        text,
        receipt,
        rendered,
        before,
        after,
        activatedGoal,
        enteredActive,
        ...(outcome.targetGoalId ? {targetGoalId: outcome.targetGoalId} : {}),
        ...(outcome.ok ? {} : {error: text}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        handled: true,
        ok: false,
        sessionID,
        args,
        subcmd,
        text: message,
        receipt: '',
        rendered: 'Goal command error: ' + message,
        before,
        after: before,
        activatedGoal: null,
        enteredActive: false,
        error: message,
      };
    }
  };

  const commandExecuteBefore = async (
    input: {sessionID?: string; command?: string; arguments?: string},
    output: {parts: unknown[]},
  ): Promise<void> => {
    if (!input || !input.command || !output) return;
    if (runtime.disposed) return;
    const res = await executeSlashCommand(input, {skipKickoff: false});
    if (!res.handled || !res.rendered) return;
    output.parts = [{type: 'text', text: res.rendered}];
  };

  return {
    kickoffTimers,
    clearKickoffTimer,
    scheduleKickoff,
    executeSlashCommand,
    commandExecuteBefore,
  };
}
