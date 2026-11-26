/**
 * Session idle event handler (`processIdleEvent`) and its sleep helper.
 * Coordinates continuation decisions, progress tracking, and human intervention detection.
 */

import type {GoalState, GoalStateMachine} from './state-machine.ts';
import type {IdleContext, LoopPolicy} from './continuation-loop.ts';
import {isLowProgressTurn} from './continuation-loop.ts';
import type {HookDeps, SessionContext} from './hooks-types.ts';
import {cumulativeSessionUsageMessage, trackTokenUsage} from './hooks-usage.ts';
import {isSessionGoneError} from './hooks-errors.ts';
import {executeDecision} from './hooks-decision.ts';
import {
  assistantTurnKey,
  chronologicalMessages,
  detectRepetitiveDegeneration,
  findLatestAssistantMessage,
  getMessageDelivery,
  getMessageID,
  getTextFromParts,
  getThinkingTokens,
  messageHasToolCall,
  sliceCurrentCycleMessages,
  windowHasToolCallNewerThan,
} from './message-helpers.ts';
import {
  normalizeInheritedAgentForPrompt,
  pickInheritableAgent,
  stripAgentListSortPrefix,
} from './agent-resolve.ts';
import {
  isCommandTemplateEcho,
  isExplicitStopMessage,
  isSlashEchoMessage,
} from './command-dispatch.ts';
import {outputTokensForMessage} from './accounting.ts';
import {summarizeText} from './child-session-verifier.ts';
import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';
import {SERVER_MODE_HEADER, TUI_MODE_HEADER} from './commands.ts';

export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function ownsIdleMachine(
  sessionID: string,
  session: SessionContext,
  machine: GoalStateMachine,
  deps: HookDeps,
): boolean {
  return (
    !deps.runtime?.disposed &&
    deps.runtime?.canDriveSession?.(sessionID) !== false &&
    (session.listMachines
      ? session.listMachines().includes(machine)
      : session.getMachine() === machine)
  );
}

export async function recordIdleReadFailure(
  sessionID: string,
  session: SessionContext,
  machine: GoalStateMachine,
  deps: HookDeps,
  observed: {runId: string; revision: number},
  error: unknown,
): Promise<void> {
  const isOwnedTarget = () =>
    ownsIdleMachine(sessionID, session, machine, deps);
  const matchesObservation = (goal: Readonly<GoalState>) =>
    isOwnedTarget() &&
    goal.runId === observed.runId &&
    goal.revision === observed.revision &&
    (goal.status === 'active' || goal.finalizing);
  if (!isOwnedTarget()) return;
  const sessionGone = isSessionGoneError(error);
  const maxFailures = deps.defaultOpts?.maxPromptFailures ?? 3;
  let failures = 0;
  const mutation = await machine.mutate(
    goal => {
      failures = ++goal.promptFailures;
      goal.lastStatus = sessionGone
        ? "Cannot continue: the goal's session no longer exists."
        : 'Cannot continue until the host session state can be read.';
    },
    {
      source: 'idle-handler',
      detail: 'Session state read failed before continuation',
      // Read availability is bookkeeping, not a change to the completion claim.
      // Reject stale observations before mutate touches history or timestamps.
      guard: matchesObservation,
      skipRevision: true,
      skipPersist: true,
    },
  );
  if (!mutation.ok) return;
  let receipt: string | undefined;
  let pauseRevision: number | undefined;
  const stillPaused = (goal: Readonly<GoalState>) =>
    isOwnedTarget() &&
    goal.runId === observed.runId &&
    goal.revision === pauseRevision &&
    goal.status === 'paused';
  if (failures >= maxFailures) {
    const message = sessionGone
      ? `The goal's owning session no longer exists; paused after ${failures} failed session reads.`
      : `The host session state could not be read; paused after ${failures} consecutive failures. Run /${deps.commandName} resume when the host is available.`;
    const paused = await machine.transition('paused', {
      source: 'idle-handler',
      expectedRevision: mutation.revision,
      guard: matchesObservation,
      stopReason: sessionGone ? 'session not found' : 'auto-continue failures',
      detail: message,
    });
    if (paused.ok) {
      pauseRevision = paused.revision;
      await machine.addNotice('prompt-failure', message, {guard: stillPaused});
      receipt = message;
    }
  }
  if (!isOwnedTarget()) return;
  await session.persist();
  if (receipt && stillPaused(machine.snapshot()))
    await deps.announceGoalDecision?.(sessionID, receipt);
}

export async function processIdleEvent(
  sessionID: string,
  session: SessionContext,
  machine: GoalStateMachine,
  policy: LoopPolicy,
  deps: HookDeps,
): Promise<void> {
  const goal = machine.snapshot();
  if (goal.status !== 'active' && !goal.finalizing) return;
  const matchesObservation = (current: Readonly<GoalState>) =>
    ownsIdleMachine(sessionID, session, machine, deps) &&
    current.runId === goal.runId &&
    current.revision === goal.revision &&
    (current.status === 'active' || current.finalizing);

  const runtime = deps.runtime;
  const retainedKickoff = () => {
    const pending = runtime?.pendingKickoffDispatch
      ?.get(sessionID)
      ?.get(goal.goalId);
    return pending?.runId === goal.runId ? pending : undefined;
  };
  const waitingForKickoff = (): boolean =>
    Boolean(retainedKickoff()) ||
    machine.snapshot().kickoffAdmissionPending === true;
  if (runtime && !runtime.threadToolsRegistered && !machine.isTerminal()) {
    await machine.transition('paused', {
      source: 'idle-handler',
      stopReason: 'tool surface unavailable',
      detail:
        'Goal tool surface unavailable; the goal cannot be completed or blocked via tools.',
    });
    await machine.addNotice(
      'tool-surface-unavailable',
      'Goal tools (update_goal) are not registered. Paused to avoid an indefinite loop.',
    );
    if (deps.announceGoalDecision) {
      await deps.announceGoalDecision(
        sessionID,
        `Goal tool surface unavailable. The goal "${Array.from(goal.condition).slice(0, 100).join('')}" is paused.`,
      );
    }
    await session.persist();
    return;
  }

  let messages: unknown[] = [];
  try {
    if (deps.sessionApi.usage) {
      // On v2, durable totals are projected before experimental.idle, while
      // the usage event may still be queued behind another session's work.
      // Refresh every idle path before deciding whether a brake permits work.
      const reading = await deps.sessionApi.usage(sessionID);
      if (!ownsIdleMachine(sessionID, session, machine, deps)) return;
      const usage = cumulativeSessionUsageMessage(sessionID, reading);
      runtime?.usageEventsObserved.add(sessionID);
      const targets = (session.listMachines?.() ?? [machine]).filter(
        m => !m.isTerminal(),
      );
      await trackTokenUsage(
        sessionID,
        usage,
        targets,
        runtime,
        session,
        true,
        message =>
          deps.announceGoalDecision?.(sessionID, message) ?? Promise.resolve(),
      );
    }
    const hostMessages = await deps.sessionApi.messages(sessionID, {
      limit: deps.defaultOpts?.maxRecentMessages ?? 50,
    });
    messages = chronologicalMessages(
      Array.isArray(hostMessages) ? hostMessages : [],
    );
  } catch (error) {
    await deps.logError('Failed to read session state for continuation', error);
    await recordIdleReadFailure(sessionID, session, machine, deps, goal, error);
    return;
  }
  if (!ownsIdleMachine(sessionID, session, machine, deps)) return;

  // Hosts on v1 emit no `message.updated` events, leaving `goal.totalTokens` at 0.
  // Because session messages are already fetched here, attribute usage idempotently
  // on hosts where no usage events have been observed. Guarded by `usageEventsObserved`
  // so v2 hosts (which emit these events) are not double-charged.
  if (
    runtime &&
    !runtime.usageEventsObserved.has(sessionID) &&
    messages.length > 0
  ) {
    const targets = (session.listMachines?.() ?? [machine]).filter(
      m => !m.isTerminal(),
    );
    for (const message of messages) {
      if (runtime.usageEventsObserved.has(sessionID)) break;
      if (!message || typeof message !== 'object') continue;
      try {
        await trackTokenUsage(
          sessionID,
          message as Record<string, unknown>,
          targets,
          runtime,
          session,
          false,
          undefined,
          () => !runtime.usageEventsObserved.has(sessionID),
        );
      } catch {
        // Usage attribution failures must never block continuation.
      }
    }
  }

  // Usage remains attributable to the goal even if the user paused during the
  // read. Progress and continuation decisions belong to the observed revision.
  if (!matchesObservation(machine.snapshot())) return;
  const latestAssistant = findLatestAssistantMessage(messages);
  const latestText = getTextFromParts(
    (latestAssistant as {parts?: unknown[]})?.parts,
  );
  const latestOutputTokens = latestAssistant
    ? outputTokensForMessage(latestAssistant)
    : null;
  const latestHasThinkingTokens = getThinkingTokens(latestAssistant) > 0;
  const previousAssistantText = goal.lastAssistantText;
  const assistantChanged =
    summarizeText(latestText, 200) !==
    summarizeText(previousAssistantText, 200);
  const latestAssistantID = getMessageID(latestAssistant);
  const assistantRepeated = Boolean(
    latestAssistantID && latestAssistantID === goal.lastAssistantMessageID,
  );

  // Evaluate whether the agent executed any tools during THIS cycle only.
  // Restricting the scan to messages after the prior turn / prompt boundary
  // ensures a historical tool call cannot suppress `noToolCallTurns` forever.
  const turnKey = assistantTurnKey(latestAssistant);
  const currentDeliverySets = () => ({
    queued: deps.runtime?.queuedInputMessageIDs?.get(sessionID),
    steered: deps.runtime?.steeredInputMessageIDs?.get(sessionID),
    surfaced: deps.runtime?.surfacedQueuedMessageIDs?.get(sessionID),
  });
  const isQueuedMessage = (message: unknown, id: string): boolean => {
    const {queued, steered} = currentDeliverySets();
    if (id !== '' && steered?.has(id) === true) return false;
    if (id !== '' && queued?.has(id) === true) return true;
    return getMessageDelivery(message) === 'queue';
  };
  const cycleMessages = sliceCurrentCycleMessages(messages, {
    lastNoToolCallMessageID: goal.lastNoToolCallMessageID,
    lastAssistantMessageID: goal.lastAssistantMessageID,
    assistantRepeated,
    focusTurnKey: turnKey,
    isQueuedMessage,
  });
  const windowHasToolCall = windowHasToolCallNewerThan(
    cycleMessages,
    goal.lastNoToolCallMessageID ?? '',
  );
  const latestHasToolCall =
    messageHasToolCall(latestAssistant) || windowHasToolCall;

  // Turn identity scopes both the progress decision and its count. A host may
  // supply a creation timestamp instead of an ID; without either, a repeated
  // observation cannot establish a distinct turn and must not advance a brake.
  const sameProgressTurn =
    Boolean(turnKey) && turnKey === goal.lastCountedProgressMessageID;
  const alreadyCountedNoToolCall =
    !turnKey || turnKey === goal.lastNoToolCallMessageID;
  const turnPinnedProductive =
    sameProgressTurn && goal.stalledTurnCounted === false;
  const turnStallCounted = sameProgressTurn && goal.stalledTurnCounted === true;
  // Detect new turns using the pre-update snapshot before `lastAssistantMessageID` is overwritten.
  const isNewAssistantTurn =
    Boolean(latestAssistantID) &&
    latestAssistantID !== goal.lastAssistantMessageID;
  const repetitionInfo = detectRepetitiveDegeneration(latestText);
  const hasRepetition = repetitionInfo.isRepetitive;

  if (!waitingForKickoff()) {
    const tracking = await machine.mutate(
      g => {
        g.lastAssistantText = latestText;
        g.lastAssistantMessageID = latestAssistantID;

        // Record progress on a new turn rather than token growth so long-running
        // tool calls do not register as stalls, while hung turns still trip the brake.
        if (isNewAssistantTurn) {
          g.lastProgressAt = Date.now();
        }
        if (latestHasToolCall) {
          g.noToolCallTurns = 0;
          // Keep the evaluated assistant identity as the dedupe key even on a
          // productive cycle. A duplicate idle before the next assistant reply
          // must not reclassify this same turn as tool-free.
          g.lastNoToolCallMessageID = turnKey;
        } else if (g.turnCount > 0 && !alreadyCountedNoToolCall) {
          g.noToolCallTurns += 1;
          g.lastNoToolCallMessageID = turnKey;
        }
        const noProgressThreshold =
          g.noProgressTokenThreshold ??
          deps.defaultOpts?.noProgressTokenThreshold ??
          50;

        // Repetition and the ordinary stall predicate share the same eligibility
        // check. Neither may count a keyless turn or recount a decided turn.
        const isLowProgress =
          hasRepetition ||
          isLowProgressTurn(
            {
              goal: g,
              pendingIntent: null,
              latestOutputTokens,
              latestHasToolCall,
              latestHasThinkingTokens,
              assistantChanged,
              assistantRepeated: Boolean(assistantRepeated),
              userInterventionDetected: false,
              activationBoundary: false,
            },
            noProgressThreshold,
          );
        const confirmedProductive =
          latestHasToolCall ||
          latestHasThinkingTokens ||
          (latestOutputTokens !== null &&
            latestOutputTokens >= noProgressThreshold);
        if (isLowProgress) {
          if (turnKey && !turnPinnedProductive && !turnStallCounted) {
            g.noProgressTurns += 1;
            g.lastCountedProgressMessageID = turnKey;
            g.stalledTurnCounted = true;
          }
        } else if (!turnStallCounted || confirmedProductive) {
          g.noProgressTurns = 0;
          g.lastCountedProgressMessageID = turnKey;
          // A first, short prose observation remains tentative: observing it
          // unchanged may count one stall. Tools, thinking, or substantial output
          // confirm progress immediately, even if a later slice omits that work.
          // Preserve a counted stall only while its own turn remains unchanged.
          g.stalledTurnCounted =
            confirmedProductive || sameProgressTurn ? false : undefined;
        }
      },
      {
        source: 'idle-handler',
        detail: 'Updated tracking fields',
        guard: matchesObservation,
        skipRevision: true,
      },
    );
    if (!tracking.ok) return;
  }

  if (!waitingForKickoff() && goal.lastContinueAt && runtime) {
    const elapsed = Math.max(0, Date.now() - goal.lastContinueAt);
    const minDelay = goal.minDelayMs ?? deps.defaultOpts?.minDelayMs ?? 1500;
    if (elapsed < minDelay) {
      const controller = new AbortController();
      runtime.continuationControllers.set(sessionID, controller);
      const delayOk = await sleep(minDelay - elapsed, controller.signal);
      runtime.continuationControllers.delete(sessionID);
      if (!delayOk) return;
    }
  }

  const postDelayGoal = machine.snapshot();
  if (!matchesObservation(postDelayGoal)) return;

  // Detect pending user interventions: if a user submits input and the host delays or
  // drops the chat.message hook, avoid continuation so the human turn is respected.
  // Injected plugin prompts, command echoes, and mode headers are excluded.
  //
  // Only INTERRUPTING input yields the goal. OpenCode's inbox distinguishes "steer"
  // (wakes execution mid-turn) from "queue" (waits for the turn boundary); a queued
  // message — e.g. one sent by another agent while this turn runs — must not pause
  // the goal, it is surfaced as a notice instead (see below). When the host exposes
  // no delivery distinction (delivery undefined), a user message after the last
  // assistant message is treated as interrupting, preserving the v1 behavior.
  let latestHumanIntervention: string | null = null;
  const queuedNotices: string[] = [];
  const queuedIDs: string[] = [];
  // Two independent scans over the message history:
  //  - the trailing scan finds an UNANSWERED human intervention and stops at the
  //    newest assistant, so an old delivery-less user message is not a fresh stop;
  //  - the queued scan looks across the whole history for delivery-tagged user
  //    messages not yet surfaced. On v2 the host consumes and answers queued input
  //    before experimental.idle runs, so those messages sit BEHIND an assistant
  //    and are invisible to the trailing scan.
  const seenNoticeIDs = new Set<string>();
  const collectQueuedNotice = (msg: unknown): void => {
    if (!msg || typeof msg !== 'object') return;
    const parts =
      (msg as {parts?: unknown[]}).parts ??
      (
        (msg as {info?: {parts?: unknown[]}}).info as
          {parts?: unknown[]} | undefined
      )?.parts ??
      [];
    const msgInjected =
      (msg as {synthetic?: boolean}).synthetic === true ||
      (msg as {info?: {synthetic?: boolean}}).info?.synthetic === true ||
      Boolean(
        (msg as {metadata?: Record<string, unknown>}).metadata?.[
          GOAL_TUI_METADATA_KEY
        ],
      ) ||
      Boolean(
        (msg as {info?: {metadata?: Record<string, unknown>}}).info?.metadata?.[
          GOAL_TUI_METADATA_KEY
        ],
      );
    if (
      msgInjected ||
      parts.some(p => {
        const part = p as {
          synthetic?: boolean;
          metadata?: Record<string, unknown>;
        } | null;
        return (
          part?.synthetic === true ||
          Boolean(part?.metadata?.[GOAL_TUI_METADATA_KEY])
        );
      })
    )
      return;
    const text = getTextFromParts(parts);
    const messageID = getMessageID(msg);
    if (
      !text ||
      text.includes(SERVER_MODE_HEADER) ||
      text.includes(TUI_MODE_HEADER) ||
      isCommandTemplateEcho(text) ||
      isSlashEchoMessage(sessionID, messageID)
    )
      return;
    if (!isQueuedMessage(msg, messageID)) return;
    const messageTime =
      (msg as {time?: {created?: unknown}}).time?.created ??
      (msg as {info?: {time?: {created?: unknown}}}).info?.time?.created;
    // A replacement goal is created after the command began. A human stop that
    // arrived in the removal/persistence gap is newer than the command but older
    // than the replacement object, so creation time cannot bound interventions.
    const interventionBoundary = goal.userCommandStartedAt ?? goal.createdAt;
    if (
      typeof messageTime === 'number' &&
      Number.isFinite(messageTime) &&
      interventionBoundary > 0 &&
      messageTime < interventionBoundary
    )
      return;
    // Some hosts omit message IDs for queued input. Derive a stable dedup key
    // from the text so the same message is not re-announced on every idle.
    const noticeID =
      messageID !== ''
        ? messageID
        : `queued-text:${text.length}:${text.slice(0, 200)}`;
    const {surfaced} = currentDeliverySets();
    if (surfaced?.has(noticeID) === true || seenNoticeIDs.has(noticeID)) return;
    seenNoticeIDs.add(noticeID);
    queuedNotices.push(text);
    queuedIDs.push(noticeID);
  };

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      info?: {
        role?: string;
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      };
      role?: string;
      synthetic?: boolean;
      metadata?: Record<string, unknown>;
    } | null;
    if (!msg) continue;
    const role = msg.info?.role ?? msg.role;
    if (role === 'assistant' || role === 'agent') break;
    if (role !== 'user') continue;
    const effectiveDelivery = isQueuedMessage(msg, getMessageID(msg))
      ? 'queue'
      : undefined;
    // A queued message never interrupts; it is collected by the full-history
    // scan below. Only interrupting (or unknown-delivery) input yields the goal.
    if (effectiveDelivery === 'queue') continue;
    const parts =
      (msg as {parts?: unknown[]}).parts ??
      (msg.info as {parts?: unknown[]} | undefined)?.parts ??
      [];
    const msgInjected =
      (msg as {synthetic?: boolean}).synthetic === true ||
      msg.info?.synthetic === true ||
      Boolean(
        (msg as {metadata?: Record<string, unknown>}).metadata?.[
          GOAL_TUI_METADATA_KEY
        ],
      ) ||
      Boolean(msg.info?.metadata?.[GOAL_TUI_METADATA_KEY]);
    if (
      msgInjected ||
      parts.some(p => {
        const part = p as {
          synthetic?: boolean;
          metadata?: Record<string, unknown>;
        } | null;
        return (
          part?.synthetic === true ||
          Boolean(part?.metadata?.[GOAL_TUI_METADATA_KEY])
        );
      })
    )
      continue;
    const text = getTextFromParts(parts);
    if (
      !text ||
      text.includes(SERVER_MODE_HEADER) ||
      text.includes(TUI_MODE_HEADER) ||
      isCommandTemplateEcho(text) ||
      isSlashEchoMessage(sessionID, getMessageID(msg))
    )
      continue;
    // A command can await removal persistence before creating its replacement.
    // Human input in that gap is newer than the command but older than the new
    // goal object; the command's admission time is the ordering boundary. Old
    // records without it fall back to creation time.
    const interventionBoundary = goal.userCommandStartedAt ?? goal.createdAt;
    const messageTime =
      (msg as {time?: {created?: unknown}}).time?.created ??
      (msg as {info?: {time?: {created?: unknown}}}).info?.time?.created;
    if (
      latestHumanIntervention === null &&
      interventionBoundary > 0 &&
      typeof messageTime === 'number' &&
      Number.isFinite(messageTime) &&
      messageTime < interventionBoundary
    )
      continue;
    if (latestHumanIntervention === null) latestHumanIntervention = text;
  }
  for (let i = messages.length - 1; i >= 0; i--)
    collectQueuedNotice(messages[i]);
  if (queuedNotices.length > 0) {
    // Collect every unsurfaced queued message in chronological order (the scan
    // walked newest-first, so reverse) and surface them as one notice.
    const ordered = queuedNotices.slice().reverse();
    const orderedIDs = queuedIDs.slice().reverse();
    const slice = (s: string) => Array.from(s).slice(0, 200).join('');
    const noticeText = `Queued message(s) received while the goal was running (they did not interrupt the turn): ${ordered
      .map(slice)
      .join(' | ')}`;
    for (const m of session.listMachines?.() ?? [machine]) {
      if (m.isTerminal()) continue;
      await m.addNotice('user-intervention', noticeText);
    }
    // Record in the lifecycle trail (type 'notice', not 'tracking', so the
    // signal-filtered history view keeps it) — the ledger then carries why the
    // goal did not yield despite a user-role message being present. Guarded by
    // isTerminal because mutate throws on terminal machines.
    if (!machine.isTerminal()) {
      await machine.mutate(() => {}, {
        source: 'idle-handler',
        detail: noticeText,
        historyType: 'notice',
        skipRevision: true,
      });
    }
    // Mark surfaced only after the notice/history landed, so a failure retries
    // on the next idle instead of silently dropping the message.
    if (deps.runtime) {
      let set = deps.runtime.surfacedQueuedMessageIDs.get(sessionID);
      if (!set) {
        set = new Set<string>();
        deps.runtime.surfacedQueuedMessageIDs.set(sessionID, set);
      }
      for (const id of orderedIDs) {
        if (id === '') continue;
        set.add(id);
        if (set.size > 256) set.delete(set.values().next().value!);
      }
    }
    await session.persist();
  }
  if (!matchesObservation(machine.snapshot())) return;
  if (latestHumanIntervention !== null) {
    if (isExplicitStopMessage(latestHumanIntervention)) {
      await machine.transition('paused', {
        source: 'chat-message',
        guard: matchesObservation,
        stopReason: 'explicit pause',
        detail:
          'Paused by an explicit stop directive; run /goal resume to continue.',
      });
      await session.persist();
      return;
    }
  }

  // The host has not admitted this goal's original inputs yet. An ordinary
  // continuation would omit its retained attachments or settle it using an
  // unrelated turn. Human intervention still reaches the pause policy below;
  // the admission retry owns starting work, independently for each goal.
  if (waitingForKickoff() && latestHumanIntervention === null) {
    const retained = retainedKickoff();
    if (retained) {
      if (
        !retained.inFlight &&
        !retained.exhausted &&
        runtime?.canDriveSession?.(sessionID) !== false &&
        !runtime?.hasKickoffTimer?.(sessionID, goal.goalId)
      ) {
        runtime?.scheduleKickoff?.(sessionID, goal.goalId, goal.runId);
      }
      return;
    }
    if (!runtime?.promptInFlightSessions.has(sessionID)) {
      const message =
        'The original kickoff inputs are no longer available after recovery. ' +
        `Resubmit \`/${deps.commandName} resume ${goal.goalId}\` with the original attachments, ` +
        'or explicitly edit the objective to start a new kickoff.';
      const paused = await machine.transition('paused', {
        source: 'idle-handler',
        guard: matchesObservation,
        stopReason: 'kickoff admission failed',
        detail: message,
      });
      if (paused.ok) {
        await machine.addNotice('prompt-failure', message);
        await session.persist();
        await deps.announceGoalDecision?.(sessionID, message);
      }
    }
    return;
  }

  const idleCtx: IdleContext = {
    goal: machine.snapshot(),
    pendingIntent: session.getPendingIntent(machine.snapshot().goalId),
    latestOutputTokens,
    latestHasToolCall,
    latestHasThinkingTokens,
    assistantChanged,
    assistantRepeated: Boolean(assistantRepeated),
    userInterventionDetected: latestHumanIntervention !== null,
    activationBoundary: false,
  };

  // Resolve agent inheritance from the latest message for continuation dispatch.
  // Normalization ensures registered display names (e.g., "implementer") are passed
  // rather than lowercase keys. Internal agents (compaction/title/summary) are skipped
  // to avoid routing into toolless text-only agents.
  let inheritedAgent: string | undefined;
  try {
    inheritedAgent = pickInheritableAgent(messages);
  } catch {
    // Best effort agent inheritance.
  }
  const resolvedAgent = normalizeInheritedAgentForPrompt(
    inheritedAgent ?? goal.executionContext?.agent,
  );
  const cleanAgent = resolvedAgent
    ? stripAgentListSortPrefix(resolvedAgent)
    : undefined;

  const decision = policy.decideContinuation(idleCtx);
  if (
    decision.type !== 'apply-pending-intent' &&
    session.getPendingIntent(machine.snapshot().goalId)
  ) {
    session.setPendingIntent(machine.snapshot().goalId, null);
  }
  // The queued-notice announcement is only truthful when this idle actually
  // commits to an ordinary continuation. apply-pending-intent can settle the
  // goal as blocked/complete, so it uses the neutral branch below.
  if (
    queuedNotices.length > 0 &&
    deps.announceGoalDecision &&
    decision.type === 'continue'
  ) {
    const slice = (s: string) => Array.from(s).slice(0, 200).join('');
    await deps.announceGoalDecision(
      sessionID,
      `A message was queued for this session without interrupting the running turn; the goal keeps running. Queued text: ${queuedNotices
        .slice()
        .reverse()
        .map(slice)
        .join(' | ')}`,
    );
  } else if (queuedNotices.length > 0 && deps.announceGoalDecision) {
    const slice = (s: string) => Array.from(s).slice(0, 200).join('');
    await deps.announceGoalDecision(
      sessionID,
      `A message was queued for this session without interrupting the running turn, but a newer interrupting message (or a brake) takes precedence. Queued text: ${queuedNotices
        .slice()
        .reverse()
        .map(slice)
        .join(' | ')}`,
    );
  }
  if (!matchesObservation(machine.snapshot())) return;
  await executeDecision(decision, sessionID, session, machine, deps, {
    repetitionWarning:
      hasRepetition || (goal.turnCount > 0 && !latestHasToolCall),
    inheritedAgent: cleanAgent,
  });
}
