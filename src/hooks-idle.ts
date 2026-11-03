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
  detectRepetitiveDegeneration,
  findLatestAssistantMessage,
  getMessageID,
  getTextFromParts,
  getThinkingTokens,
  messageHasToolCall,
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
    messages = Array.isArray(hostMessages) ? hostMessages : [];
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

  // Evaluate whether the agent executed any tools during this cycle.
  // On v1, tool-using cycles conclude with a text-only summary, so inspecting
  // only the newest message can yield a false negative. We inspect recent messages
  // since the last counted turn to detect any intermediate tool calls.
  // On ID-less hosts, `lastNoToolCallMessageID` is a `#<created>` turn key; the helper
  // handles this gracefully by accepting the tool call if either identifier is unusable.
  const windowHasToolCall = windowHasToolCallNewerThan(
    messages,
    goal.lastNoToolCallMessageID ?? '',
  );
  const latestHasToolCall =
    messageHasToolCall(latestAssistant) || windowHasToolCall;
  const latestHasThinkingTokens = getThinkingTokens(latestAssistant) > 0;
  const previousAssistantText = goal.lastAssistantText;
  const assistantChanged =
    summarizeText(latestText, 200) !==
    summarizeText(previousAssistantText, 200);
  const latestAssistantID = getMessageID(latestAssistant);
  const assistantRepeated =
    latestAssistantID && latestAssistantID === goal.lastAssistantMessageID;

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
  let latestHumanIntervention: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {info?: {role?: string}; role?: string} | null;
    if (!msg) continue;
    const role = msg.info?.role ?? msg.role;
    if (role === 'assistant' || role === 'agent') break;
    if (role !== 'user') continue;
    const parts =
      (msg as {parts?: unknown[]}).parts ??
      (msg.info as {parts?: unknown[]} | undefined)?.parts ??
      [];
    const injected = parts.some(p => {
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
    latestHumanIntervention = text;
    break;
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
  await executeDecision(decision, sessionID, session, machine, deps, {
    repetitionWarning:
      hasRepetition || (goal.turnCount > 0 && !latestHasToolCall),
    inheritedAgent: cleanAgent,
  });
}
