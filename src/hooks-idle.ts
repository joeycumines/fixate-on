/**
 * Session idle event handler (`processIdleEvent`) and its sleep helper.
 * Coordinates continuation decisions, progress tracking, and human intervention detection.
 */

import type {GoalStateMachine} from './state-machine.ts';
import type {IdleContext, LoopPolicy} from './continuation-loop.ts';
import {isLowProgressTurn} from './continuation-loop.ts';
import type {HookDeps, SessionContext} from './hooks-types.ts';
import {trackTokenUsage} from './hooks-usage.ts';
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
  matchSlashEcho,
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

export async function processIdleEvent(
  sessionID: string,
  session: SessionContext,
  machine: GoalStateMachine,
  policy: LoopPolicy,
  deps: HookDeps,
): Promise<void> {
  const goal = machine.snapshot();
  if (goal.status !== 'active' && !goal.finalizing) return;

  const runtime = deps.runtime;
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
    const hostMessages = await deps.sessionApi.messages(sessionID, {
      limit: deps.defaultOpts?.maxRecentMessages ?? 50,
    });
    messages = chronologicalMessages(
      Array.isArray(hostMessages) ? hostMessages : [],
    );
  } catch (error) {
    await deps.logError(
      'Failed to fetch session messages for continuation',
      error,
    );
    return;
  }

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
      if (!message || typeof message !== 'object') continue;
      try {
        await trackTokenUsage(
          sessionID,
          message as Record<string, unknown>,
          targets,
          runtime,
          session,
        );
      } catch {
        // Usage attribution failures must never block continuation.
      }
    }
  }

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
  const cycleMessages = sliceCurrentCycleMessages(messages, {
    lastNoToolCallMessageID: goal.lastNoToolCallMessageID,
    lastAssistantMessageID: goal.lastAssistantMessageID,
    assistantRepeated,
  });
  const windowHasToolCall = windowHasToolCallNewerThan(
    cycleMessages,
    goal.lastNoToolCallMessageID ?? '',
  );
  const latestHasToolCall =
    messageHasToolCall(latestAssistant) || windowHasToolCall;

  // Track turns rather than raw idle ticks. The idle handler fires repeatedly on the
  // same message during polling cycles, so state changes are keyed by turn identity
  // to avoid prematurely tripping stall thresholds.
  const turnKey = assistantTurnKey(latestAssistant);
  const alreadyCountedThisTurn =
    !turnKey || turnKey === goal.lastCountedProgressMessageID;
  const alreadyCountedNoToolCall =
    !turnKey || turnKey === goal.lastNoToolCallMessageID;

  // Detect new turns using the pre-update snapshot before `lastAssistantMessageID` is overwritten.
  const isNewAssistantTurn =
    Boolean(latestAssistantID) &&
    latestAssistantID !== goal.lastAssistantMessageID;
  const repetitionInfo = detectRepetitiveDegeneration(latestText);
  const hasRepetition = repetitionInfo.isRepetitive;

  await machine.mutate(
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
        g.lastNoToolCallMessageID = '';
      } else if (g.turnCount > 0 && !alreadyCountedNoToolCall) {
        g.noToolCallTurns += 1;
        g.lastNoToolCallMessageID = turnKey;
      }
      const noProgressThreshold =
        g.noProgressTokenThreshold ??
        deps.defaultOpts?.noProgressTokenThreshold ??
        50;

      // Evaluate progress using the canonical predicate, treating repetitive degeneration
      // as an additional stall indicator.
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
      if (isLowProgress) {
        // Advance stall count only once per turn.
        if (!alreadyCountedThisTurn) {
          g.noProgressTurns += 1;
          g.lastCountedProgressMessageID = turnKey;
        }
      } else {
        g.noProgressTurns = 0;
        g.lastCountedProgressMessageID = '';
      }
    },
    {
      source: 'idle-handler',
      detail: 'Updated tracking fields',
      skipRevision: true,
    },
  );

  if (goal.lastContinueAt && runtime) {
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
  if (postDelayGoal.status !== 'active' && !postDelayGoal.finalizing) return;

  // Verify the goal is still assigned to this session (it might have been removed during delay).
  const stillListed = session
    .listMachines?.()
    ?.some(m => m.state.goalId === machine.state.goalId);
  if (stillListed === false) return;

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
  const runtimeQueued = deps.runtime?.queuedInputMessageIDs?.get(sessionID);
  const runtimeSteered = deps.runtime?.steeredInputMessageIDs?.get(sessionID);
  const surfacedQueued = deps.runtime?.surfacedQueuedMessageIDs?.get(sessionID);
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
    const parts =
      (msg as {parts?: unknown[]}).parts ??
      (msg.info as {parts?: unknown[]} | undefined)?.parts ??
      [];
    const msgInjected =
      msg.synthetic === true ||
      msg.info?.synthetic === true ||
      Boolean(msg.metadata?.[GOAL_TUI_METADATA_KEY]) ||
      Boolean(msg.info?.metadata?.[GOAL_TUI_METADATA_KEY]);
    const injected =
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
      });
    if (injected) continue;
    const text = getTextFromParts(parts);
    if (!text) continue;
    if (text.includes(SERVER_MODE_HEADER) || text.includes(TUI_MODE_HEADER))
      continue;
    if (isCommandTemplateEcho(text)) continue;
    if (matchSlashEcho(sessionID, text)) continue;
    const messageID = getMessageID(msg);
    // Runtime event sets carry the host's latest delivery observation, so they
    // take precedence over a (possibly stale) static annotation on the message.
    const inRuntimeQueued =
      messageID !== '' && runtimeQueued?.has(messageID) === true;
    const inRuntimeSteered =
      messageID !== '' && runtimeSteered?.has(messageID) === true;
    const effectiveDelivery = inRuntimeSteered
      ? 'steer'
      : inRuntimeQueued
        ? 'queue'
        : getMessageDelivery(msg);
    if (effectiveDelivery === 'queue') {
      // Non-interrupting input: keep the goal running, but make the message
      // visible to the user through the goal notice channel. Skip ids already
      // surfaced on an earlier idle pass, and keep scanning so an interrupting
      // message further back still wins.
      if (messageID !== '' && surfacedQueued?.has(messageID) === true) continue;
      queuedNotices.push(text);
      queuedIDs.push(messageID);
      continue;
    }
    // The newest interrupting message wins; keep scanning older messages only
    // to surface queued ones as notices before the assistant-role break.
    if (latestHumanIntervention === null) latestHumanIntervention = text;
  }
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
  if (latestHumanIntervention !== null) {
    if (isExplicitStopMessage(latestHumanIntervention)) {
      await machine.transition('paused', {
        source: 'chat-message',
        stopReason: 'explicit pause',
        detail:
          'Paused by an explicit stop directive; run /goal resume to continue.',
      });
      await session.persist();
      return;
    }
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
  // commits to continuing. Announce here — after the decision — rather than
  // before the intervention check, so a pause/stop/brake on the same turn can
  // never be preceded by a false "the goal keeps running".
  if (
    queuedNotices.length > 0 &&
    deps.announceGoalDecision &&
    (decision.type === 'continue' || decision.type === 'apply-pending-intent')
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
  await executeDecision(decision, sessionID, session, machine, deps, {
    repetitionWarning:
      hasRepetition || (goal.turnCount > 0 && !latestHasToolCall),
    inheritedAgent: cleanAgent,
  });
}
