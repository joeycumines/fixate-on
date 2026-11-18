/**
 * v2 event-payload leaf helpers for the OpenCode v2 plugin adapter: session-id
 * extraction, v1->v2 input translation, input-delivery recording, and synthetic
 * chat.message synthesis. Extracted from plugin-v2.ts so the event bridge can
 * depend on a leaf module instead of importing back into plugin-v2.ts (which
 * would create an import cycle). Leaf module: no import from plugin-v2.ts.
 */

import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';
import type {PluginHooks} from './hooks.ts';
import {recordEventInputDelivery} from './session-runtime.ts';
import {extractV2SessionIDArg} from './plugin-v2-helpers.ts';
import type {RecentKickoffTextTracker} from './plugin-v2-command.ts';

/**
 * Extract the authoritative session identity from v2 event payloads.
 * Identity is never inferred from titles, ordering, or history; events lacking
 * an explicit session ID are treated as unscoped.
 */
export function getV2EventSessionID(data: unknown): string | undefined {
  const visited = new Set<object>();
  const find = (value: unknown, depth: number): string | undefined => {
    if (!value || typeof value !== 'object' || depth > 3) return undefined;
    const object = value as Record<string, unknown>;
    if (visited.has(object)) return undefined;
    visited.add(object);
    const direct = object.sessionID;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    for (const key of ['properties', 'info', 'session']) {
      const sessionID = find(object[key], depth + 1);
      if (sessionID) return sessionID;
    }
    return undefined;
  };
  return find(data, 0);
}

export function v1PartsToV2Text(input: Record<string, unknown>): {
  sessionID?: string;
  text: string;
  metadata?: Record<string, unknown>;
  agent?: string;
} {
  const sessionID = extractV2SessionIDArg(input);
  const body =
    input.body && typeof input.body === 'object' && !Array.isArray(input.body)
      ? (input.body as Record<string, unknown>)
      : input;
  const rawAgent = body.agent ?? input.agent;
  const agent = typeof rawAgent === 'string' ? rawAgent : undefined;
  const rawParts = body.parts ?? input.parts;
  const parts = Array.isArray(rawParts) ? rawParts : [];
  const texts: string[] = [];
  let metadata: Record<string, unknown> | undefined;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as {
      type?: string;
      text?: unknown;
      metadata?: Record<string, unknown>;
    };
    if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
    if (!metadata && p.metadata && typeof p.metadata === 'object') {
      const marker = p.metadata[GOAL_TUI_METADATA_KEY];
      if (marker && typeof marker === 'object')
        metadata = marker as Record<string, unknown>;
    }
  }
  const out: {
    sessionID?: string;
    text: string;
    metadata?: Record<string, unknown>;
    agent?: string;
  } = {
    sessionID,
    text: texts.join('\n\n'),
  };
  if (metadata) out.metadata = metadata;
  if (agent) out.agent = agent;
  return out;
}

/**
 * Records the delivery mode of a v2 input/inbox event into the runtime's
 * delivery tracking, via the shared helper in session-runtime.ts (the single
 * implementation used by both the v1 event hook and this adapter).
 *
 * v2.2.5 exposes the mode on `session.inbox.enqueued` (item.delivery) and
 * `session.inbox.delivery.changed`; newer hosts expose `session.input.admitted`
 * with `input.delivery`, and `session.input.queued`/`steered` imply the mode.
 * The caller-known sessionID is passed as a fallback so a payload without its
 * own session id is still recorded.
 */
export function recordV2InputDelivery(
  runtime:
    | {
        queuedInputMessageIDs: Map<string, Set<string>>;
        steeredInputMessageIDs: Map<string, Set<string>>;
      }
    | undefined,
  data: Record<string, unknown>,
  eventType?: string,
  fallbackSessionID?: string,
): void {
  recordEventInputDelivery(runtime, data, eventType, fallbackSessionID);
}

/**
 * Feeds a v2 `session.input.admitted` event into the v1 `chat.message` steering hook.
 *
 * Preserves steering guards (slash commands, mode headers, stop-intent detection)
 * during ongoing execution turns on hosts that do not fire `chat.message`.
 */
export async function synthesizeChatMessageFromText(
  chatMessageHook: PluginHooks['chat.message'] | undefined,
  sessionID: string,
  text: string,
  metadata?: Record<string, unknown>,
  isSynthetic = false,
): Promise<void> {
  if (typeof chatMessageHook !== 'function' || !sessionID || !text) return;
  await chatMessageHook(
    {sessionID},
    {
      parts: [
        {
          type: 'text',
          text,
          synthetic: isSynthetic ? true : undefined,
          metadata,
        },
      ],
    },
  );
}

export async function synthesizeChatMessageFromAdmitted(
  chatMessageHook: PluginHooks['chat.message'] | undefined,
  data: Record<string, unknown>,
  recentKickoffTexts?: RecentKickoffTextTracker,
): Promise<void> {
  if (typeof chatMessageHook !== 'function') return;
  const sessionID = getV2EventSessionID(data);
  if (!sessionID) return;
  const pendingInput = data.input as
    | {
        type?: string;
        metadata?: Record<string, unknown>;
        data?: {text?: unknown; metadata?: Record<string, unknown>};
      }
    | undefined;
  const pendingType = pendingInput?.type;
  const pendingData = pendingInput?.data;
  const text = typeof pendingData?.text === 'string' ? pendingData.text : '';
  if (!pendingData || !text) return;
  const metadata = pendingData.metadata ?? pendingInput?.metadata;
  const isSynthetic =
    pendingType === 'synthetic' ||
    Boolean(metadata?.[GOAL_TUI_METADATA_KEY]) ||
    Boolean(recentKickoffTexts?.matches(sessionID, text));
  await chatMessageHook(
    {sessionID},
    {
      parts: [
        {
          type: 'text',
          text,
          synthetic: isSynthetic ? true : undefined,
          metadata,
        },
      ],
    },
  );
}
