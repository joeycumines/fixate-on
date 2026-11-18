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

  // Track turns rather than raw idle ticks. The idle handler fires repeatedly on the
  // same message during polling cycles, so state changes are keyed by turn identity
  // to avoid prematurely tripping stall thresholds. An id-less turn keys on its
  // creation timestamp; a truly key-less turn (no id, no timestamp) gets the empty
  // key and is never counted (alreadyCountedThisTurn is true for it).
  const alreadyCountedThisTurn =
    !turnKey || turnKey === goal.lastCountedProgressMessageID;
  const alreadyCountedNoToolCall =
    !turnKey || turnKey === goal.lastNoToolCallMessageID;
  // A turn whose key was pinned by a PRODUCTIVE evaluation (tool call or
  // prose) in a previous idle is exempt from low-progress re-evaluation: a
  // duplicate idle on the same turn recomputes assistantChanged=false /
  // assistantRepeated=true, which isLowProgressTurn would read as a stall and
  // wrongly increment noProgressTurns for an already-judged turn. Only an
  // unpinned or stall-pinned turn remains eligible to be counted once.
  // The productive flag is tri-state: undefined on the FIRST observation of a
  // turn (so a duplicate idle can still count a genuine stall exactly once),
  // false on a confirmed productive re-observation, true on a counted stall.
  const turnPinnedProductive =
    Boolean(turnKey) &&
    turnKey === goal.lastCountedProgressMessageID &&
    goal.stalledTurnCounted === false;
  // A duplicate idle must not count a stall for a turn that has ALREADY been
  // counted as a stall (key pinned with flag=true). The first observation of
  // a turn always has an empty pin, so it is never "already counted"; the
  // duplicate observation of the same stalled turn IS already-counted only
  // AFTER the stall branch pinned it. Between the first (productive-looking)
  // observation and the stall-counting duplicate, the pin is set with
  // flag=undefined, which is NOT stall-counted — that is what lets the
  // duplicate count the stall exactly once, and later duplicates (flag=true)
  // are blocked.
  const turnStallCounted =
    Boolean(turnKey) &&
    turnKey === goal.lastCountedProgressMessageID &&
    goal.stalledTurnCounted === true;
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

      // Evaluate progress using the canonical predicate, treating repetitive
      // degeneration as an additional stall indicator. A turn already pinned by
      // a PRODUCTIVE evaluation (tool call or prose) must not be re-evaluated
      // as low progress by a duplicate idle.
      const isLowProgress =
        hasRepetition ||
        (isLowProgressTurn(
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
        ) &&
          !turnPinnedProductive &&
          // A turn already counted as a stall must not be re-counted by a
          // duplicate idle.
          !turnStallCounted);
      if (isLowProgress) {
        // Advance stall count only once per turn. The first observation of a
        // stalled turn is NOT low progress (assistantChanged=true on first
        // sight of the text), so it falls through to the productive-prose
        // branch below, which pins the key WITHOUT the productive flag; the
        // duplicate idle then counts the stall exactly once here.
        g.noProgressTurns += 1;
        g.lastCountedProgressMessageID = turnKey;
        g.stalledTurnCounted = true;
      } else if (latestHasToolCall) {
        g.noProgressTurns = 0;
        // The cycle was just evaluated as productive. Remember that evaluation
        // so a duplicate idle, whose re-sliced window may hide the tool call,
        // cannot reclassify the same turn as low progress.
        g.lastCountedProgressMessageID = turnKey;
        g.stalledTurnCounted = false;
      } else {
        // The turn was just evaluated as productive prose; pin the dedupe key
        // so a duplicate idle on the same turn cannot reclassify it as low
        // progress and double-count the stall brake. This mirrors the
        // tool-call branch above (the F9 fix): without this pin a duplicate
        // idle on a productive prose turn recomputes assistantChanged=false /
        // assistantRepeated=true and wrongly increments noProgressTurns.
        // The flag is left UNSET (undefined) on the first observation of the
        // turn so the duplicate idle remains eligible to count a genuine
        // stall exactly once; it becomes false (confirmed-productive) only
        // when the same turn is re-observed, and true when counted as a
        // stall. A stall-counted turn (flag=true) must keep its flag AND its
        // streak so later duplicates stay blocked.
        g.lastCountedProgressMessageID = turnKey;
        if (g.stalledTurnCounted === true) {
          // already counted as a stall: keep the flag and the streak
        } else {
          g.noProgressTurns = 0;
          g.stalledTurnCounted = alreadyCountedThisTurn ? false : undefined;
        }
      }
      // A low-progress evaluation also pins the turn key, so a duplicate idle
      // cannot re-count it; the key only moves on with a genuinely new turn.
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
    if (
      !text ||
      text.includes(SERVER_MODE_HEADER) ||
      text.includes(TUI_MODE_HEADER) ||
      isCommandTemplateEcho(text) ||
      matchSlashEcho(sessionID, text)
    )
      return;
    const messageID = getMessageID(msg);
    if (!isQueuedMessage(msg, messageID)) return;
    const messageTime =
      (msg as {time?: {created?: unknown}}).time?.created ??
      (msg as {info?: {time?: {created?: unknown}}}).info?.time?.created;
    if (
      typeof messageTime === 'number' &&
      Number.isFinite(messageTime) &&
      goal.createdAt > 0 &&
      messageTime < goal.createdAt
    )
      return;
    const {surfaced} = currentDeliverySets();
    if (
      (messageID !== '' && surfaced?.has(messageID) === true) ||
      (messageID !== '' && seenNoticeIDs.has(messageID))
    )
      return;
    seenNoticeIDs.add(messageID);
    queuedNotices.push(text);
    queuedIDs.push(messageID);
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
      matchSlashEcho(sessionID, text)
    )
      continue;
    // The newest interrupting message wins. Messages that predate the goal's
    // creation cannot be interventions in this goal: they were already answered
    // (or deliberately ignored) before the goal existed.
    const messageTimeOf = (msg: unknown): number | undefined => {
      const t =
        (msg as {time?: {created?: unknown}}).time?.created ??
        (msg as {info?: {time?: {created?: unknown}}}).info?.time?.created;
      return typeof t === 'number' && Number.isFinite(t) ? t : undefined;
    };
    if (
      latestHumanIntervention === null &&
      goal.createdAt > 0 &&
      messageTimeOf(msg) !== undefined &&
      messageTimeOf(msg)! < goal.createdAt
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
  await executeDecision(decision, sessionID, session, machine, deps, {
    repetitionWarning:
      hasRepetition || (goal.turnCount > 0 && !latestHasToolCall),
    inheritedAgent: cleanAgent,
  });
}
