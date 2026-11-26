/**
 * Plugin framework hook registration (createHooks).
 *
 * Invariants:
 * - system.transform avoids volatile per-turn fields (token/turn counts) to
 *   preserve prefix caching across steady-state continuations; it updates only
 *   on status transitions and objective edits.
 * - chat.message pauses the active goal on user intervention ("latest wins").
 * - session.idle drives the continuation loop.
 */

import type {GoalStateMachine} from './state-machine.ts';
import {createIdlePoller, evaluateQuietWindow} from './idle-poll.ts';
import {USER_INTERVENTION_STOP_REASON} from './status-label.ts';
import {
  findNewestMessage,
  getMessageID,
  hostReportsCompletion,
  messageIsSettled,
} from './message-helpers.ts';
import {outputTokensForMessage} from './accounting.ts';
import {MAX_BACKGROUND_WAIT_MS} from './plugin-v2-helpers.ts';
import {recordIdleReadFailure} from './hooks-idle.ts';
import type {HookDeps, PluginHooks, SessionContext} from './hooks-types.ts';
import {POLL_EVENT_PREFIX} from './hooks-types.ts';
import {
  createChatMessageHook,
  createChatParamsHook,
  createCompactingHook,
  createEventHook,
  createSystemTransformHook,
  type HookHandlerContext,
} from './hooks-handlers.ts';

// Re-exported from hooks-compaction.ts to avoid circular dependencies.
export {
  COMPACTION_LOOP_THRESHOLD,
  COMPACTION_LOOP_WINDOW_MS,
  COMPACTION_LOOP_STOP_REASON,
  recordCompactionTimestamp,
  inCompactionLoop,
} from './hooks-compaction.ts';

// Re-exported from command-dispatch.ts for callers relying on hooks.ts entrypoint.
export {
  markSlashDispatch,
  markCommandDispatch,
  consumeCommandDispatch,
  matchSlashEcho,
  isCommandTemplateEcho,
  isExplicitStopMessage,
} from './command-dispatch.ts';

export type {
  RuntimeState,
  DefaultGoalOptions,
} from './session-state-manager.ts';

export type {
  SessionApi,
  HookDeps,
  JudgeRef,
  SessionContext,
  PluginHooks,
  TerminalEventInfo,
} from './hooks-types.ts';
export {POLL_EVENT_PREFIX} from './hooks-types.ts';
export {isDeferError, isSessionGoneError} from './hooks-errors.ts';
export {
  detectTerminalEvent,
  messageInfoFromEvent,
  messageRole,
  trackTokenUsage,
} from './hooks-usage.ts';
export {executeDecision, sendRecoveryPrompt} from './hooks-decision.ts';
export {processIdleEvent, sleep} from './hooks-idle.ts';
export {
  createChatParamsHook,
  createChatMessageHook,
  createSystemTransformHook,
  createCompactingHook,
  createEventHook,
} from './hooks-handlers.ts';

export function createHooks(deps: HookDeps): PluginHooks {
  const {getSessionContext, getLoopPolicy, commandName, logError} = deps;

  const sessionMachines = (
    session: SessionContext | undefined,
  ): GoalStateMachine[] => {
    if (!session) return [];
    const all = session.listMachines?.();
    if (all) return all;
    const one = session.getMachine();
    return one ? [one] : [];
  };

  // Host event identifiers are often unique only within a session. Scope
  // deduplication by session ID so identical IDs across conversations do not
  // suppress legitimate idle events.
  const seenIdleEventIDs = new Map<string, Set<string>>();

  // Deduplicate forked sessions by session ID. The idle path dedupes by event ID,
  // but session.forked runs before that check and may lack an event ID on some hosts.
  // Keying by session ID prevents duplicate goal hydration if session.forked is redelivered.
  const forkedSessions = new Set<string>();

  // Poller view of authentic idle timestamps, recorded by the event hook.
  const lastAuthenticIdleAt = new Map<string, number>();

  const ctx: HookHandlerContext = {
    deps,
    getSessionContext,
    getLoopPolicy,
    commandName,
    logError,
    sessionMachines,
    seenIdleEventIDs,
    forkedSessions,
    lastAuthenticIdleAt,
  };

  const hooksObject: PluginHooks = {
    'chat.params': createChatParamsHook(ctx),
    'chat.message': createChatMessageHook(ctx),
    'experimental.chat.system.transform': createSystemTransformHook(ctx),
    'experimental.session.compacting': createCompactingHook(ctx),
    event: createEventHook(ctx),
  };

  // Hosts that do not deliver events to the plugin event hook stall goals at turn 0.
  // The poller synthesizes session.idle events when the host is quiet and no
  // authentic idle event has arrived within IDLE_GRACE_MS.
  const IDLE_GRACE_MS = deps.idleGraceMs ?? 30_000;
  const QUIET_MS = deps.idleQuietMs ?? 10_000;
  let pollSeq = 0;
  const quietSince = new Map<string, {key: string; since: number}>();
  if (deps.runtime) {
    const previous = deps.runtime.clearSessionIdleTracking;
    deps.runtime.clearSessionIdleTracking = (sessionID: string) => {
      previous?.(sessionID);
      quietSince.delete(sessionID);
      lastAuthenticIdleAt.delete(sessionID);
      seenIdleEventIDs.delete(sessionID);
    };
  }

  const escalateBackgroundDeferral = async (
    sessionID: string,
  ): Promise<void> => {
    if (
      deps.runtime?.canDriveSession &&
      !deps.runtime.canDriveSession(sessionID)
    )
      return;
    // Bounded escalation: pause with an explicit receipt rather than
    // continue past an unattested completion or loop indefinitely.
    // Only active/finalizing goals can transition to paused per
    // TRANSITION_TABLE; already-paused/blocked goals keep their state
    // and stop reason but still receive the notice and announcement.
    const session = getSessionContext(sessionID);
    const allMachines = sessionMachines(session);
    for (const target of allMachines) {
      if (target.isTerminal()) continue;
      const snap = target.snapshot();
      if (
        snap.status === 'active' ||
        snap.status === 'finalizing' ||
        snap.finalizing
      ) {
        await target.transition('paused', {
          source: 'idle-handler',
          stopReason: 'background completion unreported',
          detail:
            'A background subagent/image job did not report completion within the wait bound; resume after it finishes.',
        });
      }
      await target.addNotice(
        'background-completion-unreported',
        'Background job completion was not reported; goal paused. Resume once the job has finished.',
      );
    }
    if (deps.announceGoalDecision) {
      await deps.announceGoalDecision(
        sessionID,
        'A background subagent/image job did not report completion within the wait bound; goal(s) paused. Resume once the job has finished.',
      );
    }
    if (session) await session.persist();
    deps.runtime?.backgroundDeferrals?.delete(sessionID);
    deps.runtime?.backgroundBlockedUntil.delete(sessionID);
  };
  if (deps.runtime) {
    deps.runtime.escalateBackgroundDeferral = escalateBackgroundDeferral;
  }

  const pollTick = async (): Promise<void> => {
    if (deps.runtime?.disposed) {
      poller.stop();
      return;
    }
    for (const sessionID of [...(deps.runtime?.sessionGoals.keys() ?? [])]) {
      try {
        if (!sessionID) continue;
        // Liveness check: synthesize idles only for sessions seen active during
        // this process lifetime, preventing resumption of un-opened persisted sessions.
        if (!deps.runtime?.liveSessions.has(sessionID)) continue;
        if (deps.runtime?.promptInFlightSessions.has(sessionID)) continue;
        if (
          deps.runtime?.canDriveSession &&
          !deps.runtime.canDriveSession(sessionID)
        )
          continue;
        // A host-reported background job defers idles. The wall-clock deadline
        // is NOT a completion signal — only a later native idle with an empty
        // background authoritatively clears it. On expiry we keep deferring and
        // extend with backoff, until a bounded cap pauses with an explicit
        // receipt instead of driving over live work or stalling forever.
        const deferral = deps.runtime?.backgroundDeferrals?.get(sessionID);
        const backgroundDeadline =
          deps.runtime?.backgroundBlockedUntil.get(sessionID);
        if (deferral || backgroundDeadline !== undefined) {
          const now = Date.now();
          const deadline = backgroundDeadline ?? deferral!.nextRecheckAt;
          if (
            deps.runtime?.canDriveSession &&
            !deps.runtime.canDriveSession(sessionID)
          )
            continue;
          const since = deferral?.since ?? now;
          if (now - since >= MAX_BACKGROUND_WAIT_MS) {
            await escalateBackgroundDeferral(sessionID);
            continue;
          }
          // A rolling recheck deadline cannot postpone the absolute wait bound.
          if (deadline > now) continue;
          // Still within the bound: extend the deferral with bounded backoff.
          // The host's next experimental.idle with empty background clears it.
          const extensions = (deferral?.extensions ?? 0) + 1;
          const nextRecheckAt = now + Math.min(60_000, 5_000 * extensions);
          deps.runtime?.backgroundDeferrals?.set(sessionID, {
            jobKeys: deferral?.jobKeys ?? [],
            since,
            nextRecheckAt,
            extensions,
          });
          deps.runtime?.backgroundBlockedUntil.set(sessionID, nextRecheckAt);
          continue;
        }
        const lastReal = lastAuthenticIdleAt.get(sessionID);
        if (lastReal !== undefined && Date.now() - lastReal < IDLE_GRACE_MS)
          continue;
        const session = getSessionContext(sessionID);
        if (!session) continue;
        const machines = sessionMachines(session);
        const recoveryPendingHere =
          deps.runtime?.recoveryPendingSessions.has(sessionID) ?? false;
        const runnable = machines.some(m => {
          const g = m.snapshot();
          if (g.status === 'active' || g.finalizing) return true;
          if (
            g.status === 'paused' &&
            g.stopReason === USER_INTERVENTION_STOP_REASON &&
            !g.finalizing &&
            !m.isTerminal()
          )
            return true;
          // Allow recovery-pending sessions to synthesize a single idle so the
          // recovery path can execute on hosts without native idle events.
          return (
            recoveryPendingHere &&
            g.status === 'paused' &&
            g.stopReason === 'recovery' &&
            !m.isTerminal()
          );
        });
        if (!runnable) continue;

        // Quiet-window gate: prompt only after the newest assistant turn has remained
        // unchanged for QUIET_MS to avoid interrupting in-flight turns.
        const observedGoals = machines.map(machine => ({
          machine,
          goal: machine.snapshot(),
        }));
        let messages: unknown[];
        try {
          messages = await deps.sessionApi.messages(sessionID, {limit: 5});
        } catch (error) {
          // No quiet-window observation was obtained. A failing host read must
          // not synthesize idle, but it also must not leave an active goal
          // silently stranded on hosts without a native idle event channel.
          quietSince.delete(sessionID);
          await logError(
            'Failed to read session state during idle polling',
            error,
          );
          for (const {machine, goal} of observedGoals) {
            await recordIdleReadFailure(
              sessionID,
              session,
              machine,
              deps,
              goal,
              error,
            );
          }
          continue;
        }
        if (!Array.isArray(messages) || messages.length === 0) continue;

        // Host versions return session.messages() in differing orders (v2 is desc,
        // older v1 is asc). Select by timestamp rather than array index.
        const newest = findNewestMessage(messages) as {
          info?: {role?: string};
          role?: string;
        } | null;
        if (!newest) continue;
        const role = newest.info?.role ?? newest.role;
        if (role !== 'assistant' && role !== 'agent') continue;

        // Settled-turn gate: ensure the newest turn has completed before synthesizing
        // idle, provided the host supports completion metadata.
        if (hostReportsCompletion(messages) && !messageIsSettled(newest))
          continue;
        const messageID = getMessageID(newest);
        if (!messageID) continue;
        const key = `${messageID}:${outputTokensForMessage(newest) ?? 0}`;
        const prev = quietSince.get(sessionID);
        const now = Date.now();
        const verdict = evaluateQuietWindow(prev, now, key, QUIET_MS);
        quietSince.set(sessionID, verdict.next);
        if (!verdict.fire) continue;

        deps.runtime?.liveSessions.add(sessionID);
        await hooksObject.event!({
          type: 'session.idle',
          sessionID,
          id: `${POLL_EVENT_PREFIX}${pollSeq++}`,
        });
      } catch {
        // Isolate failures to individual sessions to keep the sweep running.
      }
    }
  };

  const poller = createIdlePoller(deps.idlePollerIntervalMs ?? 5_000, pollTick);
  if (deps.idlePoller !== false) poller.start();

  return hooksObject;
}
