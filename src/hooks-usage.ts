/**
 * Per-message token accounting and host terminal event detection.
 */

import type {GoalStateMachine} from './state-machine.ts';
import type {RuntimeState} from './session-state-manager.ts';
import type {SessionContext, TerminalEventInfo} from './hooks-types.ts';
import {getMessageID} from './message-helpers.ts';
import {
  addToUsageField,
  addUsageDelta,
  emptyUsage,
  normalizeMessageUsage,
  outputTokensForMessage,
  totalTokensForMessage,
  USAGE_TOKEN_FIELDS,
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

export async function trackTokenUsage(
  sessionID: string,
  message: Record<string, unknown>,
  machines: GoalStateMachine[],
  runtime: RuntimeState | undefined,
  session?: SessionContext,
  sessionScopedUsage = false,
): Promise<void> {
  if (!runtime || machines.length === 0) return;

  // Extract the message ID supporting both v2 (flat info) and v1 (nested info) envelopes.
  const currentMessageID = getMessageID(message);
  if (!currentMessageID) return;

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
    // For cumulative session events (`session.usage.updated`), incoming metrics
    // represent session running totals. Goals must be charged only the delta
    // since the prior reading to prevent polynomial growth.
    if (sessionScopedUsage) {
      const prevSession =
        runtime.seenSessionUsage.get(sessionID) ?? emptyUsage();
      if (usageChanged) {
        for (const field of USAGE_TOKEN_FIELDS) {
          const delta = Math.max(0, currentUsage[field] - prevSession[field]);
          if (delta > 0)
            await machine.updateUsage(
              addToUsageField(machine.state.usage, field, delta),
            );
        }
        const costDelta = Math.max(0, currentUsage.cost - prevSession.cost);
        if (costDelta > 0) {
          await machine.updateUsage({
            ...machine.state.usage,
            cost: machine.state.usage.cost + costDelta,
            costKnown: true,
          });
        }
        changed = true;
      }
      if (currentTokens > (runtime.seenTokens.get(currentMessageID) ?? 0)) {
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
      continue;
    }

    // Late-joiner guard: do not back-charge messages processed prior to goal creation.
    // Session-scoped usage events are exempt as they represent shared ongoing spend.
    if (
      !sessionScopedUsage &&
      seenMessage &&
      !machine.state.messageIDs.has(currentMessageID)
    )
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

  if (!changed) return;

  // Cache running session usage so subsequent events charge only new increments.
  if (sessionScopedUsage) runtime.seenSessionUsage.set(sessionID, currentUsage);

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
}
