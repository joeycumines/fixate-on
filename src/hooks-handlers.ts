/**
 * Per-hook handler factories of the hooks layer.
 *
 * Each factory accepts the shared HookHandlerContext built once per createHooks
 * call and returns the hook function for one event name.
 */

import type {GoalStateMachine, TransitionSource} from './state-machine.ts';
import {TERMINAL_STATUSES} from './state-machine.ts';
import type {HookDeps, PluginHooks, SessionContext} from './hooks-types.ts';
import {POLL_EVENT_PREFIX} from './hooks-types.ts';
import {
  detectTerminalEvent,
  messageInfoFromEvent,
  trackTokenUsage,
} from './hooks-usage.ts';
import {processIdleEvent} from './hooks-idle.ts';
import {buildSystemBlock, goalPromptTag} from './steering.ts';
import {
  isCommandTemplateEcho,
  isExplicitStopMessage,
  matchSlashEcho,
} from './command-dispatch.ts';
import {USER_INTERVENTION_STOP_REASON} from './status-label.ts';
import {escapeGoalText} from './escape.ts';
import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';
import {SERVER_MODE_HEADER, TUI_MODE_HEADER} from './commands.ts';
import {captureRunBaseline} from './handback.ts';
import {getTextFromParts} from './message-helpers.ts';
import {isInternalAgent} from './agent-resolve.ts';
import {brakeCeiling, brakeCeilingFormatted} from './brake-format.ts';
import {copyGoalsToForkedSession, extractForkParentID} from './fork-bind.ts';
import {
  COMPACTION_LOOP_STOP_REASON,
  COMPACTION_LOOP_THRESHOLD,
  COMPACTION_LOOP_WINDOW_MS,
  inCompactionLoop,
  recordCompactionTimestamp,
} from './hooks-compaction.ts';

/**
 * Everything a per-hook factory needs that must exist exactly once per
 * createHooks call. Built in hooks.ts and threaded through, so handler state
 * (idle deduplication, fork bindings, and the poller's authentic-idle view)
 * is not duplicated per handler.
 */
export interface HookHandlerContext {
  deps: HookDeps;
  getSessionContext: (sessionID: string) => SessionContext | undefined;
  getLoopPolicy: () => import('./continuation-loop.ts').LoopPolicy;
  commandName: string;
  logError: (message: string, error?: unknown) => Promise<void>;
  sessionMachines: (session: SessionContext | undefined) => GoalStateMachine[];
  seenIdleEventIDs: Map<string, Set<string>>;
  forkedSessions: Set<string>;
  lastAuthenticIdleAt: Map<string, number>;
}

export function createChatParamsHook(
  ctx: HookHandlerContext,
): NonNullable<PluginHooks['chat.params']> {
  const {deps, getSessionContext} = ctx;
  return async input => {
    if (!input?.sessionID) return;
    if (deps.runtime?.disposed) return;

    // Liveness: a dispatched turn is host evidence the session is live.
    // chat.params fires per real turn; no synthetic path delivers it,
    // so no synthetic guard is needed here.
    if (typeof input.sessionID === 'string' && input.sessionID.trim()) {
      deps.runtime?.liveSessions.add(input.sessionID);
    }
    const session = getSessionContext(input.sessionID);
    if (!session) return;
    const machine = session.getMachine();
    if (machine) {
      // Capture the run-scoped baseline as soon as the working directory is known,
      // ensuring the handback diff reports only what this goal modified and
      // excludes preexisting in-flight modifications (HANDBACK-SCOPE-1).
      const captureCwd =
        machine.snapshot().executionContext?.cwd ??
        deps.workspaceDirectory ??
        process.cwd();
      const needsBaseline = machine.snapshot().baseline == null;
      const baseline = needsBaseline
        ? await captureRunBaseline(captureCwd)
        : null;
      await machine.mutate(
        goal => {
          if (!goal.executionContext?.cwd) {
            // Exclude internal host agents: recording an internal name would resurface
            // via executionContext fallbacks on subsequent dispatches.
            const agent = isInternalAgent(input.agent)
              ? goal.executionContext?.agent
              : input.agent;
            goal.executionContext = {
              ...goal.executionContext,
              agent,
              model: input.model,
              cwd: captureCwd,
            };
          }
          if (goal.baseline == null && baseline) goal.baseline = baseline;
        },
        {
          source: 'chat-message',
          detail: 'Captured execution context',
          skipRevision: true,
        },
      );
    }
  };
}

export function createChatMessageHook(
  ctx: HookHandlerContext,
): NonNullable<PluginHooks['chat.message']> {
  const {deps, getSessionContext, commandName, sessionMachines} = ctx;
  return async (input, output) => {
    if (!input?.sessionID) return;
    if (deps.runtime?.disposed) return;

    const parts = Array.isArray(output?.parts) ? output.parts : [];
    const isSynthetic = parts.some(p => {
      const part = p as Record<string, unknown> | null;
      return (
        part?.synthetic === true ||
        (part?.metadata as Record<string, unknown> | undefined)?.[
          GOAL_TUI_METADATA_KEY
        ]
      );
    });

    if (
      !isSynthetic &&
      deps.runtime?.promptInFlightSessions.has(input.sessionID)
    ) {
      try {
        await deps.sessionApi.abort?.(input.sessionID);
      } catch {
        // Best-effort abort; ignore failures.
      }
    }

    const session = getSessionContext(input.sessionID);
    if (!session) return;
    const machines = sessionMachines(session);
    if (machines.length === 0) return;
    const hasRunnable = machines.some(m => {
      const g = m.snapshot();
      return g.status === 'active' || g.finalizing;
    });
    // Sessions with solely yielding goals still need this message to renew
    // their yield timeout.
    const hasYielding = machines.some(m => {
      const g = m.snapshot();
      return (
        g.status === 'paused' &&
        g.stopReason === USER_INTERVENTION_STOP_REASON &&
        !m.isTerminal()
      );
    });
    if (!hasRunnable && !hasYielding) return;

    if (isSynthetic) return;

    const text = getTextFromParts(output?.parts);
    if (
      !text ||
      text === `/${commandName}` ||
      text.startsWith(`/${commandName} `)
    )
      return;

    // Stock v1 replays command-hook output as chat messages where the slash command
    // is replaced by rendered parts; detect our own echo via headers.
    if (text.includes(SERVER_MODE_HEADER) || text.includes(TUI_MODE_HEADER))
      return;

    // When the host executes the command template as a chat turn, it echoes the
    // template as a user message. Ignore this dispatch echo to avoid stalling
    // newly created goals.
    if (isCommandTemplateEcho(text)) return;

    // Ignore bare arguments echoing a just-dispatched fingerprint within its time window.
    if (matchSlashEcho(input.sessionID, text)) return;

    // Latest user instruction takes precedence session-wide: pause every active goal.
    // Explicit stop directives remain paused; regular text can be re-armed later.
    const explicitStop = isExplicitStopMessage(text);
    let pausedAny = false;
    for (const machine of machines) {
      const g = machine.snapshot();
      if (g.status !== 'active' && !g.finalizing) continue;
      await machine.transition('paused', {
        source: 'chat-message',
        stopReason: explicitStop
          ? 'explicit pause'
          : USER_INTERVENTION_STOP_REASON,
        detail: explicitStop
          ? 'Paused by an explicit stop directive; run /goal resume to continue.'
          : 'Paused because a new human message arrived; latest instruction wins.',
      });
      pausedAny = true;
    }

    // Refresh the yield timeout for user interventions upon receiving each human message.
    if (!explicitStop) {
      let renewedAny = false;
      for (const machine of machines) {
        const g = machine.snapshot();
        if (
          g.status !== 'paused' ||
          g.stopReason !== USER_INTERVENTION_STOP_REASON
        )
          continue;
        machine.markStopped();
        renewedAny = true;
      }
      if (renewedAny) await session.persist();
    } else {
      // Explicit stops park the goal until resumed. Mutate rather than transition
      // since 'paused' -> 'paused' is not a valid transition in the state machine.
      let restatedAny = false;
      for (const machine of machines) {
        const g = machine.snapshot();
        if (
          g.status !== 'paused' ||
          g.stopReason !== USER_INTERVENTION_STOP_REASON
        )
          continue;
        await machine.mutate(
          goal => {
            goal.stopReason = 'explicit pause';
            goal.stoppedAt = Date.now();
          },
          {
            source: 'chat-message',
            detail:
              'Explicit stop directive while yielding; the goal is parked until /goal resume.',
            skipPersist: true,
          },
        );
        restatedAny = true;
      }
      if (restatedAny) await session.persist();
    }
    if (pausedAny) await session.persist();
    const delayController = deps.runtime?.continuationControllers.get(
      input.sessionID,
    );
    if (delayController) {
      delayController.abort();
    }
  };
}

export function createSystemTransformHook(
  ctx: HookHandlerContext,
): NonNullable<PluginHooks['experimental.chat.system.transform']> {
  const {deps, getSessionContext, commandName, sessionMachines} = ctx;
  return async (input, output) => {
    if (!input?.sessionID || !output) return;
    if (deps.runtime?.disposed) return;
    const session = getSessionContext(input.sessionID);
    if (!session) return;
    const machines = sessionMachines(session);

    // Describe all non-terminal goals, prioritizing the focused goal to prevent
    // tools like `update_goal` from settling the wrong goal when multiple are active.
    const focusedId =
      deps.runtime?.focusedGoalId.get(input.sessionID) ??
      session.getMachine()?.state.goalId;
    const described = machines
      .filter(m => !m.isTerminal())
      .slice()
      .sort((a, b) =>
        a.state.goalId === focusedId
          ? -1
          : b.state.goalId === focusedId
            ? 1
            : 0,
      );
    if (described.length === 0) return;

    const systemBlocks = Array.isArray(output.system) ? [...output.system] : [];

    // Preserve prompt prefix cache across turns by avoiding turn-volatile fields.
    const availability =
      deps.verifierAvailability ??
      (deps.verifierConfigured === undefined
        ? 'unavailable'
        : deps.verifierConfigured
          ? 'configured'
          : 'unavailable');

    // Deduplicate by goal ID rather than exact string equality in case the host
    // modifies injected prompt blocks.
    const fresh = described.filter(m => {
      const tag = goalPromptTag(m.state.goalId);
      return !systemBlocks.some(
        existing => typeof existing === 'string' && existing.includes(tag),
      );
    });
    if (fresh.length === 0) return;

    systemBlocks.unshift(
      ...fresh.map(m =>
        buildSystemBlock(m.snapshot(), commandName, availability),
      ),
    );
    output.system = systemBlocks;
  };
}

export function createCompactingHook(
  ctx: HookHandlerContext,
): NonNullable<PluginHooks['experimental.session.compacting']> {
  const {deps, getSessionContext} = ctx;
  return async (input, output) => {
    if (!input?.sessionID || !output) return;
    if (deps.runtime?.disposed) return;
    const session = getSessionContext(input.sessionID);
    if (!session) return;
    const machine = session.getMachine();
    if (!machine) return;
    const goal = machine.snapshot();

    const recentHistory = goal.history
      .slice(-5)
      .map(h => `  ${h.type}: ${escapeGoalText(h.detail)}`);
    const summary = [
      `<goal_context id="${goal.goalId}">`,
      `Objective: ${escapeGoalText(goal.condition)}`,
      goal.successCriteria
        ? `Success criteria: ${escapeGoalText(goal.successCriteria)}`
        : '',
      goal.constraints
        ? `Constraints: ${escapeGoalText(goal.constraints)}`
        : '',
      `Status: ${goal.status}`,
      `Turns: ${goal.turnCount}/${brakeCeiling(goal.maxTurns)}`,
      `Tokens: ${goal.totalTokens.toLocaleString()}/${brakeCeilingFormatted(goal.maxTokens, n => n.toLocaleString())}`,
      goal.lastCheckpoint
        ? `Last checkpoint: ${escapeGoalText(goal.lastCheckpoint.summary)}`
        : '',
      recentHistory.length > 0
        ? `Recent events:\n${recentHistory.join('\n')}`
        : '',
      '</goal_context>',
    ]
      .filter(Boolean)
      .join('\n');

    if (Array.isArray(output.parts)) {
      output.parts.push({type: 'text', text: summary});
    }
  };
}

export function createEventHook(
  ctx: HookHandlerContext,
): NonNullable<PluginHooks['event']> {
  const {
    deps,
    getSessionContext,
    getLoopPolicy,
    logError,
    sessionMachines,
    seenIdleEventIDs,
    forkedSessions,
    lastAuthenticIdleAt,
  } = ctx;
  return async event => {
    const eventType = event?.type;
    if (!eventType) return;
    if (deps.runtime?.disposed) return;

    const sessionID = (event?.sessionID ?? event?.properties?.sessionID) as
      string | undefined;
    const runtime = deps.runtime;

    // Guard against modifying sessions not owned by this process host instance.
    // Unchecked state mutations would otherwise overwrite valid session token metrics.
    if (
      sessionID &&
      runtime?.canDriveSession &&
      !runtime.canDriveSession(sessionID)
    )
      return;

    // Track liveness for sessions delivered directly by the host in this process.
    // Exclude synthetic poller IDs so stale sessions are not inadvertently marked live.
    const pollerSyntheticID =
      typeof event?.id === 'string' && event.id.startsWith(POLL_EVENT_PREFIX);
    if (
      !pollerSyntheticID &&
      sessionID &&
      typeof sessionID === 'string' &&
      sessionID.trim()
    ) {
      runtime?.liveSessions.add(sessionID);
    }

    // Host v2 emits ephemeral `session.usage.updated` containing session-cumulative
    // values rather than per-step deltas. TrackTokenUsage translates running totals
    // into deltas to prevent quadratic budget inflation.
    if (eventType === 'session.usage.updated' && sessionID) {
      // Flag that the host publishes usage events directly so the idle loop
      // does not double-count by reading tokens from message histories.
      runtime?.usageEventsObserved.add(sessionID);
      try {
        const props = (event?.properties ?? {}) as Record<string, unknown>;
        const tokens = (props.tokens ?? {}) as Record<string, unknown>;
        // Use a static key `${sessionID}#usage` to track cumulative deltas against prior totals.
        const message = {
          id: `${sessionID}#usage`,
          role: 'assistant',
          info: {tokens, cost: props.cost},
        };
        const session = getSessionContext(sessionID);
        const machines = sessionMachines(session);
        const targets = machines.filter(m => !m.isTerminal());
        if (targets.length > 0) {
          await trackTokenUsage(
            sessionID,
            message as Record<string, unknown>,
            targets,
            runtime,
            session,
            true,
          );
        }
      } catch (error) {
        await logError('session.usage.updated handler error', error);
      }
    }

    if (eventType === 'message.updated' && sessionID) {
      runtime?.usageEventsObserved.add(sessionID);
      try {
        const message = messageInfoFromEvent(event);
        if (message) {
          const session = getSessionContext(sessionID);
          // Conversation context is shared across the session, so all non-terminal goals accrue usage.
          const machines = sessionMachines(session);
          const targets = machines.filter(m => !m.isTerminal());
          if (targets.length > 0) {
            await trackTokenUsage(
              sessionID,
              message,
              targets,
              runtime,
              session,
            );
          }
        }
      } catch (error) {
        await logError('message.updated handler error', error);
      }
    }

    const terminal = detectTerminalEvent(event);
    if (terminal?.sessionID) {
      try {
        const session = getSessionContext(terminal.sessionID);
        const machines = sessionMachines(session);
        let changed = false;
        for (const machine of machines) {
          if (machine.state.status !== 'active' && !machine.state.finalizing)
            continue;
          await machine.transition('paused', {
            source: 'chat-message',
            stopReason: terminal.stopReason,
            detail: terminal.detail,
          });
          changed = true;
        }
        if (changed) await session!.persist();
      } catch (error) {
        await logError('Terminal event handler error', error);
      }
      return;
    }

    if (eventType === 'session.compacted' && sessionID) {
      try {
        if (runtime)
          recordCompactionTimestamp(
            runtime.compactionTimestamps,
            sessionID,
            Date.now(),
          );
        const session = getSessionContext(sessionID);
        // Reset tracking state across all goals in the session to clear stale baselines.
        const machines = sessionMachines(session);
        for (const machine of machines) {
          await machine.mutate(
            g => {
              // Retain total token spend in compactionBaselineTokens so context budget
              // boundaries and wrapup notices persist across compactions.
              g.compactionBaselineTokens += g.totalTokens;
              g.messageIDs = new Set();
              g.totalTokens = 0;
              g.budgetWrapupSent = false;
              g.continuationClaim = null;
              g.lastAssistantMessageID = '';
              g.lastAssistantText = '';
              g.noProgressTurns = 0;
              g.noToolCallTurns = 0;
              g.lastCountedProgressMessageID = '';
              g.lastNoToolCallMessageID = '';
            },
            {
              source: 'system-transform',
              detail: 'Reset token tracking after compaction',
              skipRevision: true,
            },
          );
        }
        if (machines.length > 0) {
          await session!.persist();
        }
      } catch (error) {
        await logError('Compaction handler error', error);
      }
      return;
    }

    // In v2, compaction settlements occur via `session.compaction.ended`/`failed`
    // without emitting `session.compacted`. Total tokens in v2 is a monotonic maximum
    // of cumulative usage, so avoid resetting tokens to prevent double-counting.
    if (
      (eventType === 'session.compaction.ended' ||
        eventType === 'session.compaction.failed') &&
      sessionID
    ) {
      if (runtime)
        recordCompactionTimestamp(
          runtime.compactionTimestamps,
          sessionID,
          Date.now(),
        );
      return;
    }

    if (eventType === 'session.execution.failed') {
      if (sessionID && typeof sessionID === 'string') {
        const session = getSessionContext(sessionID);
        const machines = sessionMachines(session);
        let changed = false;
        for (const machine of machines) {
          if (machine.state.status !== 'active' && !machine.state.finalizing)
            continue;
          await machine.mutate(
            g => {
              g.promptFailures += 1;
              const errDetail =
                (event?.properties?.error as {message?: string})?.message ||
                'Stream execution failed';
              g.lastStatus = `Provider error: ${errDetail}`;
            },
            {source: 'idle-handler', detail: 'Provider stream failed'},
          );
          const snap = machine.snapshot();
          const maxFailures = deps.defaultOpts?.maxPromptFailures ?? 3;
          if (snap.promptFailures >= maxFailures) {
            await machine.transition('paused', {
              source: 'idle-handler',
              stopReason: 'execution failure',
              detail: `Paused after ${snap.promptFailures} consecutive provider stream failures.`,
            });
          }
          changed = true;
        }
        if (changed) await session!.persist();
      }
      return;
    }

    const isIdleEvent =
      eventType === 'session.idle' ||
      eventType === 'session.execution.succeeded' ||
      (eventType === 'session.status' &&
        (event?.properties?.status as {type?: string})?.type === 'idle');

    if (
      isIdleEvent &&
      sessionID &&
      runtime?.canDriveSession &&
      !runtime.canDriveSession(sessionID)
    ) {
      return;
    }

    // In v2 session forks, duplicate active goals into the fork while keeping parent goals intact.
    // Bound once per session fork ID to ensure idempotent copying.
    if (eventType === 'session.forked' && sessionID) {
      if (forkedSessions.has(sessionID)) return;
      forkedSessions.add(sessionID);

      const parentSessionID = extractForkParentID(event?.properties);
      if (parentSessionID) {
        if (
          runtime?.canDriveSession &&
          !runtime.canDriveSession(parentSessionID)
        )
          return;
        const parent = getSessionContext(parentSessionID);
        const fork = getSessionContext(sessionID);
        if (parent && fork) {
          const existingForkGoals = sessionMachines(fork);
          if (existingForkGoals.length > 0) return;
          const sourceGoals = (parent.listMachines?.() ?? [])
            .map(m => m.state)
            .filter(g => !TERMINAL_STATUSES.has(g.status));
          if (sourceGoals.length > 0) {
            try {
              await copyGoalsToForkedSession({
                sourceGoals,
                target: fork,
                parentSessionID,
                createdAt: Date.now(),
                focusedGoalId: parent.getMachine()?.state.goalId,
              });
              await fork.persist();
            } catch (error) {
              await logError('Failed to copy goals into forked session', error);
            }
          }
        }
      }
      return;
    }

    if (!isIdleEvent) return;
    if (!sessionID || typeof sessionID !== 'string') return;

    const eventID = event?.id;
    if (eventID) {
      const sessionEventIDs =
        seenIdleEventIDs.get(sessionID) ?? new Set<string>();
      if (sessionEventIDs.has(eventID)) return;
      sessionEventIDs.add(eventID);
      seenIdleEventIDs.set(sessionID, sessionEventIDs);
      if (sessionEventIDs.size > 256) {
        sessionEventIDs.delete(sessionEventIDs.values().next().value!);
      }

      // Maintain a global upper bound on tracked event IDs across all sessions.
      let totalEventIDs = 0;
      for (const ids of seenIdleEventIDs.values()) totalEventIDs += ids.size;
      while (totalEventIDs > 256) {
        const oldestSessionID = seenIdleEventIDs.keys().next().value;
        if (oldestSessionID === undefined) break;
        const oldestIDs = seenIdleEventIDs.get(oldestSessionID);
        const oldestID = oldestIDs?.values().next().value;
        if (oldestIDs && oldestID !== undefined) {
          oldestIDs.delete(oldestID);
          totalEventIDs--;
          if (oldestIDs.size === 0) seenIdleEventIDs.delete(oldestSessionID);
        } else {
          seenIdleEventIDs.delete(oldestSessionID);
        }
      }
    }

    const session = getSessionContext(sessionID);
    if (!session) return;

    // Authentic host idles reset the poller's grace window. Synthetic poll events
    // do not update this timestamp because liveness is managed directly in the poller sweep.
    const isSyntheticPollEvent =
      typeof eventID === 'string' && eventID.startsWith(POLL_EVENT_PREFIX);
    if (!isSyntheticPollEvent) {
      lastAuthenticIdleAt.set(sessionID, Date.now());
    }

    // Drive all non-terminal goals upon idle; focus state is for presentation rather than execution gating.
    const machines = sessionMachines(session);
    if (machines.length === 0) return;

    // Recovered active goals are paused during hydration to clear transient claims.
    // Only re-arm recovery-paused goals on the initial idle; user-paused or brake-paused goals remain paused.
    const sessionLive = deps.runtime?.liveSessions.has(sessionID) ?? false;
    if (!sessionLive) {
      deps.runtime?.recoveryPendingSessions.delete(sessionID);
    }
    const recoveryPending =
      deps.runtime?.recoveryPendingSessions.has(sessionID) ?? false;
    const rearmSource: TransitionSource = isSyntheticPollEvent
      ? 'poll-idle'
      : 'idle-handler';
    const rearmOrigin = isSyntheticPollEvent
      ? 'the host reported no idle, so the poller inferred one from a quiet turn'
      : 'the host reported the turn idle';

    if (recoveryPending) {
      for (const machine of machines) {
        const g = machine.snapshot();
        if (
          g.status === 'paused' &&
          g.stopReason === 'recovery' &&
          !machine.isTerminal()
        ) {
          await machine.transition('active', {
            source: rearmSource,
            stopReason: '',
            detail: `Resumed automatically when the restored session became idle (${rearmOrigin}).`,
          });
        }
      }
      deps.runtime?.recoveryPendingSessions.delete(sessionID);
      await session.persist();
    }

    const runnable = machines.filter(m => {
      const g = m.snapshot();
      return (
        g.status === 'active' ||
        g.finalizing ||
        // Re-arm user intervention pauses once the user's turn settles at this idle event.
        (g.status === 'paused' &&
          g.stopReason === USER_INTERVENTION_STOP_REASON &&
          !g.finalizing &&
          !m.isTerminal())
      );
    });
    if (runnable.length === 0) return;

    for (const machine of runnable) {
      const g = machine.snapshot();
      if (
        g.status !== 'paused' ||
        g.stopReason !== USER_INTERVENTION_STOP_REASON
      )
        continue;
      await machine.transition('active', {
        source: rearmSource,
        stopReason: '',
        detail: `Re-armed after user intervention (${rearmOrigin}); goal duties remain.`,
      });
    }
    await session.persist();

    // Compaction-loop brake: pause execution if the session has undergone repeated
    // compaction cycles within the configured time window to prevent token exhaustion loops.
    if (
      runtime &&
      inCompactionLoop(runtime.compactionTimestamps, sessionID, Date.now())
    ) {
      const minutes = Math.round(COMPACTION_LOOP_WINDOW_MS / 60_000);
      let pausedAny = false;
      for (const machine of machines) {
        const snap = machine.snapshot();
        if (snap.status !== 'active' && !snap.finalizing) continue;
        await machine.transition('paused', {
          source: 'idle-handler',
          stopReason: COMPACTION_LOOP_STOP_REASON,
          detail:
            `Paused after ${COMPACTION_LOOP_THRESHOLD} compactions in ${minutes} minutes — ` +
            'the session appears stuck in a compaction loop. Interrupt the session, then run /goal resume.',
        });
        await machine.addNotice(
          'compaction-loop',
          'Auto-continue paused: the session is compacting repeatedly without settling.',
        );
        pausedAny = true;
      }
      if (pausedAny) {
        runtime.compactionTimestamps.delete(sessionID);
        if (deps.announceGoalDecision) {
          await deps.announceGoalDecision(
            sessionID,
            `Goal auto-continue paused: ${COMPACTION_LOOP_THRESHOLD} compactions in ${minutes} minutes (compaction loop).`,
          );
        }
        await session.persist();
      }
      return;
    }

    if (runtime?.activeContinues.has(sessionID)) return;
    runtime?.activeContinues.set(sessionID, eventID || sessionID);

    try {
      const policy = getLoopPolicy();
      for (const machine of runnable) {
        const snap = machine.snapshot();
        if (snap.status !== 'active' && !snap.finalizing) continue;
        try {
          await processIdleEvent(sessionID, session, machine, policy, deps);
        } catch (error) {
          await logError(`Continuation loop error (${snap.goalId})`, error);
        }
      }
    } finally {
      runtime?.activeContinues.delete(sessionID);
    }
  };
}
