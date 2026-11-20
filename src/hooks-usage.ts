/**
 * Per-message token accounting and host terminal event detection.
 */

import type {GoalStateMachine} from './state-machine.ts';
import type {RuntimeState} from './session-state-manager.ts';
import type {SessionContext, TerminalEventInfo} from './hooks-types.ts';
import {getMessageID} from './message-helpers.ts';
import {
  addUsageDelta,
  emptyUsage,
  normalizeMessageUsage,
  outputTokensForMessage,
  totalTokensForMessage,
  USAGE_TOKEN_FIELDS,
  type UsageSnapshot,
} from './accounting.ts';

export function detectTerminalEvent(event: unknown): TerminalEventInfo | null {
  const e = event as {
    type?: string;
    sessionID?: string;
    properties?: Record<string, unknown>;
    data?: Record<string, unknown>;
  } | null;
  if (!e?.type) return null;

  const sessionID = (e.sessionID ??
    e.properties?.sessionID ??
    e.data?.sessionID) as string | undefined;
  if (!sessionID) return null;

  if (e.type === 'permission.rejected') {
    return {
      sessionID,
      stopReason: 'permission rejected',
      detail: 'Permission was rejected by the user.',
    };
  }
  if (e.type === 'session.error') {
    return {
      sessionID,
      stopReason: 'session error',
      detail: 'A session error occurred.',
    };
  }
  if (e.type === 'session.execution.interrupted') {
    return {
      sessionID,
      stopReason: 'execution interrupted',
      detail: 'The execution was interrupted.',
    };
  }
  if (e.type === 'message.aborted' || e.type === 'MessageAbortedError') {
    return {
      sessionID,
      stopReason: 'message aborted',
      detail: 'The message was aborted.',
    };
  }
  return null;
}

export function messageRole(message: unknown): string {
  const msg = message as {role?: string} | null;
  return String(msg?.role ?? '');
}

export function messageInfoFromEvent(
  event: unknown,
): Record<string, unknown> | null {
  const e = event as {
    properties?: {info?: unknown};
    data?: {info?: unknown};
  } | null;
  const info = e?.properties?.info ?? e?.data?.info;
  if (info && typeof info === 'object') return info as Record<string, unknown>;
  const data = (event as {data?: unknown})?.data;
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  return null;
}

/**
 * Validate a fresh host session read before trusting its cumulative totals.
 * A malformed/failed lookup must stop this idle attempt, not look like zero use.
 */
export function cumulativeSessionUsageMessage(
  sessionID: string,
  value: unknown,
): Record<string, unknown> {
  const info = value as {
    id?: unknown;
    tokens?: {
      input?: unknown;
      output?: unknown;
      reasoning?: unknown;
      cache?: {read?: unknown; write?: unknown};
    };
    cost?: unknown;
  } | null;
  const tokens = info?.tokens;
  const values = [
    tokens?.input,
    tokens?.output,
    tokens?.reasoning,
    tokens?.cache?.read,
    tokens?.cache?.write,
    info?.cost,
  ];
  if (
    info?.id !== sessionID ||
    values.some(
      value =>
        typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error(
      'Host cumulative session usage is unavailable or malformed',
    );
  }
  return {
    id: `${sessionID}#usage`,
    role: 'assistant',
    info: {tokens, cost: info.cost},
  };
}

interface CumulativeUsageUpdate {
  changed: boolean;
  notices: string[];
}

const cumulativeUsageUpdates = new WeakMap<
  RuntimeState,
  Map<string, Promise<CumulativeUsageUpdate>>
>();

export async function trackTokenUsage(
  sessionID: string,
  message: Record<string, unknown>,
  machines: GoalStateMachine[],
  runtime: RuntimeState | undefined,
  session?: SessionContext,
  sessionScopedUsage = false,
  announceMigration?: (message: string) => Promise<void>,
): Promise<void> {
  if (!runtime || machines.length === 0) return;
  if (!sessionScopedUsage) {
    await trackTokenUsageNow(message, machines, runtime, session);
    return;
  }

  // The native idle hook and the subscribed event stream can observe the same
  // running totals concurrently. Serialize the in-memory delta and baseline
  // update per session. Persistence happens after releasing this queue, so a
  // delayed write does not prevent the next idle from reading newer totals.
  let sessions = cumulativeUsageUpdates.get(runtime);
  if (!sessions) {
    sessions = new Map();
    cumulativeUsageUpdates.set(runtime, sessions);
  }
  const previous = sessions.get(sessionID) ?? Promise.resolve();
  const update = previous
    .catch(() => {})
    .then(() => trackCumulativeUsage(sessionID, message, machines, runtime));
  sessions.set(sessionID, update);
  let result: CumulativeUsageUpdate;
  try {
    result = await update;
  } finally {
    if (sessions.get(sessionID) === update) sessions.delete(sessionID);
  }
  if (result.changed && session) await session.persist();
  for (const notice of result.notices) await announceMigration?.(notice);
}

function mergeCumulativeUsage(
  target: UsageSnapshot,
  source: UsageSnapshot,
): void {
  for (const field of USAGE_TOKEN_FIELDS) {
    target[field] = Math.max(target[field], source[field]);
  }
  target.cost = Math.max(target.cost, source.cost);
  target.costKnown ||= source.costKnown;
}

async function trackCumulativeUsage(
  sessionID: string,
  message: Record<string, unknown>,
  machines: GoalStateMachine[],
  runtime: RuntimeState,
): Promise<CumulativeUsageUpdate> {
  const previous = {
    ...(runtime.seenSessionUsage.get(sessionID) ?? emptyUsage()),
  };
  // A restored goal can have a newer persisted watermark than the event stream
  // or this process's empty cache. It also supplies the prior session baseline
  // for goals created after restoration, preserving late-join accounting.
  for (const machine of machines) {
    const saved = machine.state.lastSessionUsage;
    if (saved) mergeCumulativeUsage(previous, saved);
  }
  const current = normalizeMessageUsage(message);
  mergeCumulativeUsage(current, previous);
  let changed = false;
  const notices: string[] = [];
  for (const machine of machines) {
    if (machine.isTerminal()) continue;
    const result = await machine.updateCumulativeUsage(current, previous);
    changed ||= result.changed;
    if (result.migrationNotice) notices.push(result.migrationNotice);
  }
  const id = `${sessionID}#usage`;
  runtime.seenSessionUsage.set(sessionID, current);
  runtime.seenUsage.set(id, current);
  runtime.seenTokens.set(
    id,
    USAGE_TOKEN_FIELDS.reduce((total, field) => total + current[field], 0),
  );
  runtime.seenOutputTokens.set(id, current.output);
  return {changed, notices};
}

async function trackTokenUsageNow(
  message: Record<string, unknown>,
  machines: GoalStateMachine[],
  runtime: RuntimeState | undefined,
  session?: SessionContext,
): Promise<boolean> {
  if (!runtime || machines.length === 0) return false;

  // Extract the message ID supporting both v2 (flat info) and v1 (nested info) envelopes.
  const currentMessageID = getMessageID(message);
  if (!currentMessageID) return false;

  const seenMessage = runtime.seenTokens.has(currentMessageID);
  let changed = false;
  const currentOutputTokens = outputTokensForMessage(message) ?? 0;
  const previousOutputTokens =
    runtime.seenOutputTokens.get(currentMessageID) ?? 0;
  const currentTokens = totalTokensForMessage(message);
  const previousTokens = runtime.seenTokens.get(currentMessageID) ?? 0;
  const currentUsage = normalizeMessageUsage(message);
  const previousUsage = runtime.seenUsage.get(currentMessageID) ?? emptyUsage();
  const usageChanged =
    USAGE_TOKEN_FIELDS.some(
      field => currentUsage[field] !== previousUsage[field],
    ) || currentUsage.cost !== previousUsage.cost;

  for (const machine of machines) {
    // Late-joiner guard: do not back-charge messages processed prior to goal creation.
    if (seenMessage && !machine.state.messageIDs.has(currentMessageID))
      continue;

    if (usageChanged) {
      await machine.updateUsage(
        addUsageDelta(
          machine.state.usage,
          currentUsage,
          previousUsage,
          !runtime.seenUsage.has(currentMessageID),
        ),
      );
      changed = true;
    }

    if (currentTokens > previousTokens) {
      await machine.mutate(
        g => {
          g.totalTokens = Math.max(g.totalTokens, currentTokens);
        },
        {
          source: 'idle-handler',
          detail: 'Updated total tokens',
          skipPersist: true,
          skipRevision: true,
        },
      );
      changed = true;
    }

    // Update progress timestamp on new assistant output and register the message ID once.
    if (
      currentOutputTokens > previousOutputTokens ||
      usageChanged ||
      currentTokens > previousTokens
    ) {
      const role = messageRole(message);
      if (
        (role === 'assistant' || role === 'agent') &&
        currentOutputTokens > previousOutputTokens
      ) {
        await machine.mutate(
          g => {
            g.lastProgressAt = Date.now();
          },
          {
            source: 'idle-handler',
            detail: 'Updated progress timestamp',
            skipPersist: true,
            skipRevision: true,
          },
        );
      }
      await machine.rememberMessageID(currentMessageID);
      changed = true;
    }
  }

  if (!changed) return false;

  runtime.seenUsage.set(currentMessageID, currentUsage);
  if (currentTokens > previousTokens) {
    runtime.seenTokens.set(currentMessageID, currentTokens);
  }
  if (currentOutputTokens > previousOutputTokens) {
    runtime.seenOutputTokens.set(currentMessageID, currentOutputTokens);
  }

  if (session) {
    await session.persist();
  }
  return true;
}
