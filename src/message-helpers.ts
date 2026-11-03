/**
 * Readers for the OpenCode SDK message shape, shared by the continuation loop,
 * token accounting, and the completion judge.
 */

import {toNonNegativeInteger} from './accounting.ts';

/** Minimal structural view of an OpenCode message used by role detection. */
interface MessageLike {
  parts?: unknown[];
  role?: string;
}

/**
 * Concatenate the `text` fields of every `{type:"text", text:string}` part.
 * Non-array input, non-text parts, and non-string text are all ignored
 * (returned as empty / skipped), so a malformed part never throws.
 */
export function getTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === 'object' && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string') {
        texts.push(p.text);
      }
    }
  }
  return texts.join('');
}

/**
 * Find the most recent assistant/agent message.
 *
 * The OpenCode SDK messages response is Array<{ info: Message, parts: Array<Part> }>;
 * role lives at `msg.info.role`, not `msg.role`. Also tolerates a flat shape
 * (role at the top level) for non-SDK/legacy hosts. Without the `info`
 * fallback, SDK-shaped messages return null here, breaking the
 * continuation loop's no-progress / tool-call / thinking-token detection.
 *
 * Selection is order-agnostic (see findNewestMessage): the two host
 * generations return `session.messages` in opposite orders, so "the last
 * assistant in the array" is only the newest one on an ascending host. When
 * every candidate carries a timestamp the newest is chosen by time; otherwise
 * array order is preserved.
 */
export function findLatestAssistantMessage(
  messages: unknown[],
): unknown | null {
  if (!Array.isArray(messages)) return null;
  const assistants = messages.filter(message => {
    if (!message || typeof message !== 'object') return false;
    const msg = message as MessageLike & {info?: {role?: string}};
    const role = msg.info?.role ?? msg.role;
    return role === 'assistant' || role === 'agent';
  });
  if (assistants.length === 0) return null;
  return findNewestMessage(assistants);
}

/**
 * Timestamp used to order messages, tolerant of both host shapes.
 *
 * The SDK message envelope carries `info.time.created` (assistant messages add
 * `completed`); flat/legacy hosts put `time` or `createdAt` at the top level.
 * Returns null when nothing usable is present.
 */
function messageCreatedAt(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const info = msg.info as Record<string, unknown> | undefined;
  const candidates = [
    (info?.time as Record<string, unknown> | undefined)?.created,
    (msg.time as Record<string, unknown> | undefined)?.created,
    info?.createdAt,
    msg.createdAt,
  ];
  for (const candidate of candidates) {
    const n = toNonNegativeInteger(candidate);
    if (n > 0) return n;
  }
  return null;
}

/**
 * The TURN KEY of an assistant message: a value that changes exactly when the
 * host delivers a genuinely new turn, and repeats on every re-observation of
 * the same one.
 *
 * The per-turn brakes (`noProgressTurns`, `noToolCallTurns`) count TURNS, but
 * the idle handler re-reads the SAME newest message on every tick. They are
 * therefore keyed to a turn, and the key must exist on BOTH host shapes:
 *
 * - An id-bearing host is keyed by message id. Real ids are monotone by
 *   construction, so this is exact.
 * - An ID-LESS host has no id at all, and treating that as "never already counted"
 *   causes it to count EVERY tick, reaching thresholds prematurely on a single
 *   unchanged turn. Failing to count id-less messages entirely avoids false pauses
 *   but disables brakes completely on such hosts.
 *
 * Such a host still stamps `time.created` (which `findNewestMessage` reads for ordering),
 * so the creation timestamp serves as a turn key wherever present. The `#` prefix
 * avoids collisions with real message ids, keeping both key spaces disjoint.
 *
 * Returns "" when the message carries neither signal, which callers treat as
 * unkeyable and skip counting.
 */
export function assistantTurnKey(message: unknown): string {
  const id = getMessageID(message);
  if (id) return id;
  const createdAt = messageCreatedAt(message);
  return createdAt === null ? '' : `#${createdAt}`;
}

/**
 * Return the NEWEST message from a `session.messages` result, regardless of
 * the order the host returned them in.
 *
 * The two host generations disagree on ordering: the v2 store defaults to `desc`
 * (`packages/core/src/session/store.ts`, `input.order ?? "desc"`), while stock
 * v1 1.18.32 returns the array oldest-first. A caller that assumes one order
 * silently picks the wrong end on the other host.
 *
 * When every message carries a usable timestamp the newest is selected by
 * time. When timestamps are absent, the array order is preserved as a
 * whole-list fallback: an empty/heuristic comparison is never mixed with
 * timestamps, so a partially-timestamped list cannot invert a known order.
 */
export function findNewestMessage(messages: unknown[]): unknown | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const times: number[] = [];
  let allTimed = true;
  for (const message of messages) {
    const t = messageCreatedAt(message);
    if (t === null) {
      allTimed = false;
      break;
    }
    times.push(t);
  }
  if (allTimed) {
    let bestIndex = 0;
    for (let i = 1; i < times.length; i++) {
      if (times[i] > times[bestIndex]) {
        bestIndex = i;
        continue;
      }
      // Equal timestamps are a genuine tie, and array position cannot break it:
      // the later index is the newer record on an ascending host (v1) but the
      // older one on a descending host (v2). Message ids are monotone within a
      // millisecond by construction (timestamp * 0x1000 + counter, rendered as
      // fixed-width hex), so the lexicographically greater id is newer on both
      // hosts. Without usable ids, the earlier index is retained.
      if (times[i] === times[bestIndex]) {
        const bestID = getMessageID(messages[bestIndex]);
        const thisID = getMessageID(messages[i]);
        if (bestID && thisID && thisID > bestID) bestIndex = i;
      }
    }
    return messages[bestIndex] ?? null;
  }
  // When no usable timestamps exist anywhere, compare the two ends by id:
  // both hosts mint ascending ids whose first 12 characters after "msg_" are a
  // fixed-width hex encoding of (timestamp * 0x1000 + counter), so a string
  // compare corresponds to chronological order. The comparison requires matching
  // lengths (e.g. 24 characters on v1, 30 on v2) to prevent false ordering from
  // variable-width custom ids.
  const first = messages[0];
  const last = messages[messages.length - 1];
  const firstID = getMessageID(first);
  const lastID = getMessageID(last);
  if (
    firstID &&
    lastID &&
    firstID !== lastID &&
    firstID.length === lastID.length
  ) {
    return lastID > firstID ? last : first;
  }
  // Fall back to array order if ids are absent or have mismatched widths.
  return last ?? null;
}

/**
 * Coerce a message's `id` to a string. Missing/non-object messages return "".
 */
export function getMessageID(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const msg = message as Record<string, unknown>;
  const info = msg.info as Record<string, unknown> | undefined;
  return String(msg.id ?? info?.id ?? '');
}

/**
 * Extract the reasoning/thinking token count from a message.
 *
 * Reads `usage.reasoning` (or `reasoning_tokens`) first, then falls back to
 * the nested SDK `info.tokens.reasoning` shape. Numeric strings are coerced;
 * negatives and non-numeric values clamp to 0.
 */
export function getThinkingTokens(message: unknown): number {
  if (!message || typeof message !== 'object') return 0;
  const msg = message as Record<string, unknown>;
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (usage) {
    const parsed = toNonNegativeInteger(
      usage.reasoning ?? usage.reasoning_tokens,
    );
    if (parsed > 0) return parsed;
  }
  const info = msg.info as Record<string, unknown> | undefined;
  const tokens = (info?.tokens ?? msg.tokens) as
    Record<string, unknown> | undefined;
  if (tokens) {
    const parsed = toNonNegativeInteger(
      tokens.reasoning ?? tokens.reasoning_tokens,
    );
    if (parsed > 0) return parsed;
  }
  return 0;
}

/** Every part-type value that counts as a tool invocation across hosts. */
export const TOOL_PART_TYPES = new Set([
  'tool',
  'tool-invocation',
  'subtask',
  'tool_use',
  'function_call',
  'tool-call',
  'tool_call',
]);

/**
 * Whether ANY assistant message in the window carries a tool invocation NEWER
 * than a reference message id.
 *
 * On stock v1, a tool-using cycle emits two assistant messages: one with the
 * tool invocation (`finish: "tool-calls"`) followed by a text summary (`finish: "stop"`).
 * Checking only the newest message inspects the summary, causing false "no tool call"
 * detections and prematurely triggering the safety brake.
 *
 * Scanning the window for any newer tool-bearing assistant message verifies if
 * the agent acted during the cycle. If an id is missing or unusable, it defaults
 * to true since resetting the brake is safe against false stalls.
 */
export function windowHasToolCallNewerThan(
  messages: unknown[],
  referenceID: string,
): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const msg = message as MessageLike & {info?: {role?: string; id?: string}};
    const role = msg.info?.role ?? msg.role;
    if (role !== 'assistant' && role !== 'agent') continue;
    if (!messageHasToolCall(message)) continue;
    const id = getMessageID(message);
    // Accept tool calls when references or ids are unavailable to prevent false stalls.
    if (!referenceID || !id) return true;
    if (id > referenceID) return true;
  }
  return false;
}

/**
 * Whether an assistant message carries the host's "this turn is finished"
 * marker.
 *
 * Both generations stamp completion metadata on settled turns: `info.time.completed`
 * or `info.finish` ("stop" / "tool-calls"). Streaming turns lack this metadata.
 */
export function messageIsSettled(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  const info = msg.info as Record<string, unknown> | undefined;
  const time = (info?.time ?? msg.time) as Record<string, unknown> | undefined;
  const completed = time?.completed;
  if (typeof completed === 'number' && completed > 0) return true;
  const finish = info?.finish ?? msg.finish;
  return typeof finish === 'string' && finish.length > 0;
}

/**
 * Whether a message list comes from a host that reports turn-completion metadata.
 * Returns true if ANY message carries completion indicators, allowing streaming
 * messages to be recognized as part of a completion-reporting host.
 */
export function hostReportsCompletion(messages: unknown[]): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (messageIsSettled(message)) return true;
  }
  return false;
}

/**
 * Whether a message's parts contain any tool invocation across known part types.
 */
export function messageHasToolCall(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  const parts = msg.parts;
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    if (typeof part === 'object' && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type && TOOL_PART_TYPES.has(String(p.type))) return true;
    }
  }
  return false;
}

/**
 * Detect degenerative repetition loops in assistant text (e.g. models repeating
 * identical lines or phrases until token exhaustion).
 */
export function detectRepetitiveDegeneration(text: string): {
  isRepetitive: boolean;
  pattern?: string;
  count?: number;
} {
  if (!text || text.length < 60) return {isRepetitive: false};

  // 1. Line-level repetition (identical non-empty lines repeating >= 4 times)
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length >= 8);
  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    const count = (lineCounts.get(line) ?? 0) + 1;
    lineCounts.set(line, count);
    if (count >= 4) {
      return {isRepetitive: true, pattern: line.slice(0, 50), count};
    }
  }

  // 2. Phrase-level repetition (e.g. repeated phrase loops >= 4 times)
  const match = text.match(/(.{10,50}?)\1{3,}/);
  if (match && match[1]) {
    return {
      isRepetitive: true,
      pattern: match[1].trim().slice(0, 50),
      count: 4,
    };
  }

  return {isRepetitive: false};
}
