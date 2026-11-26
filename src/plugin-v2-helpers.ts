/**
 * Pure bridge helpers for adapting OpenCode v2 contexts, locations, and system parts.
 *
 * Kept as a leaf module (depends only on Node stdlib path/fs) so `plugin-v2.ts`
 * remains cohesive and well within the single-concern module budget.
 */

import {appendFileSync, realpathSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import type {GoalOutputRpcDomain} from './plugin-v2-command-output.ts';

/** Minimal type surface consumed from the OpenCode v2 plugin promise Context. */
export type V2SessionOp = (input: Record<string, unknown>) => Promise<unknown>;

export interface V2SessionContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: {id: string; providerID: string} | string;
  system: unknown[];
  messages: unknown[];
  tools: Record<string, unknown>;
}

export interface V2SessionIdleContext {
  readonly sessionID: string;
  readonly background?: ReadonlyArray<unknown>;
}

export interface V2SessionPromptContext {
  readonly sessionID: string;
  readonly messageID: string;
}

export interface V2SessionTitleContext {
  readonly sessionID: string;
  messages: unknown[];
  result?: string;
}

export interface V2SessionDomain {
  prompt: V2SessionOp;
  synthetic: V2SessionOp;
  command: V2SessionOp;
  create: V2SessionOp;
  get: V2SessionOp;
  interrupt: V2SessionOp;
  generate: V2SessionOp;
  context?: V2SessionOp;
  remove?: V2SessionOp;
  update?: V2SessionOp;
  wait?: V2SessionOp;
  switchAgent?: V2SessionOp;
  hook: <
    N extends
      | 'context'
      | 'compaction'
      | 'generate'
      | 'title'
      | 'experimental.idle'
      | 'prompt',
  >(
    name: N,
    cb: (
      input: N extends 'experimental.idle'
        ? V2SessionIdleContext
        : N extends 'prompt'
          ? V2SessionPromptContext
          : N extends 'title'
            ? V2SessionTitleContext
            : V2SessionContext,
    ) => Promise<void> | void,
  ) => Promise<{dispose: () => Promise<void>}>;
}

export interface V2ToolDraft {
  add(info: {
    name: string;
    description: string;
    input: unknown;
    output?: unknown;
    options?: {codemode?: boolean; permission?: string};
    execute: (input: unknown, ctx: unknown) => Promise<unknown> | unknown;
  }): void;
}

export interface V2CommandDraft {
  add?: (cmd: {
    name: string;
    template?: string;
    description?: string;
    execute?: (input: {
      sessionID: string;
      prompt?: {
        text?: string;
        files?: unknown[];
        agents?: unknown[];
        skills?: unknown[];
      };
      delivery?: string;
    }) => Promise<void> | void;
  }) => void;
  list?: () => ReadonlyArray<{name: string}>;
  update?: (
    name: string,
    update: (cmd: {
      name: string;
      template?: string;
      description?: string;
      agent?: string;
    }) => void,
  ) => void;
}

export interface V2EventItem {
  id?: string;
  type: string;
  location?: {directory?: string; workspaceID?: string} | null;
  data?: Record<string, unknown>;
}

export interface V2PermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

export interface V2AgentEntry {
  id?: string;
  name?: string;
  description?: string;
  system?: string;
  mode?: string;
  hidden?: boolean;
  permissions?: V2PermissionRule[];
}

export interface V2AgentDraft {
  list?: () => ReadonlyArray<V2AgentEntry>;
  get?: (id: string) => V2AgentEntry | undefined;
  update: (id: string, edit: (agent: V2AgentEntry) => void) => void;
}

export interface V2Context {
  readonly rpc?: GoalOutputRpcDomain;
  readonly app: {
    readonly name?: string;
    readonly version?: string;
    readonly channel?: string;
  };
  readonly location?: {
    readonly directory?: string;
    readonly workspaceID?: string;
    readonly project?: Readonly<Record<string, unknown>>;
  };
  readonly options: Readonly<Record<string, unknown>>;
  readonly session: V2SessionDomain;
  readonly event: {subscribe: () => AsyncIterable<V2EventItem>};
  readonly tool: {
    transform: (
      cb: (draft: V2ToolDraft) => void,
    ) => Promise<{dispose: () => Promise<void>}>;
  };
  readonly command: {
    transform: (
      cb: (draft: V2CommandDraft) => void,
    ) => Promise<{dispose: () => Promise<void>}>;
  };
  readonly agent?: {
    get?: V2SessionOp;
    transform?: (
      cb: (draft: V2AgentDraft) => void,
    ) => Promise<{dispose: () => Promise<void>}>;
  };
}

/** Per-session message buffer populated by `session.hook("context")`. */
export interface MessageBuffer {
  readonly bySession: Map<string, unknown[]>;
}

export type ZodModule = typeof import('zod');

export async function logToolRegistrationFailure(
  stage: string,
  error: unknown,
): Promise<void> {
  const eventLogPath = process.env.FIXATE_ON_EVENT_LOG;
  if (!eventLogPath) return;
  try {
    appendFileSync(
      eventLogPath,
      `${Date.now()} tool-registration-${stage} ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
    );
  } catch {
    /* diagnostics must never throw */
  }
}

export async function loadZodV2(): Promise<ZodModule | null> {
  try {
    return await import('zod');
  } catch {
    return null;
  }
}

/** Builds a v2 `Tool.Info.input` Standard Schema from a v1 Zod field map. */
export function buildToolInputSchema(
  z: ZodModule | null,
  args: Record<string, unknown> | undefined,
): unknown {
  const hasFieldMap =
    args && typeof args === 'object' && Object.keys(args).length > 0;
  if (z && hasFieldMap) return z.object(args);
  if (z) return z.object({});
  return {type: 'object', properties: {}};
}

/**
 * Resolves symlinks along a path even when trailing subdirectories do not yet exist.
 *
 * Resolves the deepest existing ancestor via `realpathSync` and reattaches the
 * remaining relative segments, falling back to `path.resolve` if needed.
 */
export function canonicalPath(target: string): string {
  let current = resolve(target);
  try {
    return realpathSync(current);
  } catch {
    const trailingSegments: string[] = [];
    while (true) {
      const parent = dirname(current);
      if (parent === current) break;
      const base = basename(current);
      if (base) trailingSegments.unshift(base);
      current = parent;
      try {
        const realAncestor = realpathSync(current);
        return trailingSegments.length > 0
          ? join(realAncestor, ...trailingSegments)
          : realAncestor;
      } catch {
        // Walk up until an existing ancestor is reached.
      }
    }
    return resolve(target);
  }
}

/** Extracts displayable text from a v2 `SystemPart` (or string part). */
export function extractSystemPartText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (
    part &&
    typeof part === 'object' &&
    'text' in part &&
    typeof (part as {text?: unknown}).text === 'string'
  ) {
    return (part as {text: string}).text;
  }
  return '';
}

function isTextSystemPart(part: unknown): boolean {
  if (typeof part === 'string') return true;
  if (!part || typeof part !== 'object') return false;
  if ('type' in part) {
    return (part as {type?: unknown}).type === 'text';
  }
  return typeof (part as {text?: unknown}).text === 'string';
}

/**
 * Maps mutated plain-string system prompt entries back onto native v2 `SystemPart`
 * objects so host metadata (e.g. cache control) and non-text parts survive intact.
 */
export function reconcileSystemParts(
  nativeSystem: unknown[],
  updatedTexts: string[],
): unknown[] {
  // The v1 hook sees a text-only view of the native parts and prepends new
  // blocks to it. Every native part owns exactly one view slot, so align from
  // the tail: text beyond the native count was prepended by the transform.
  // Rewrites keep the native part object (including host metadata); non-text
  // parts stay in their original positions with their slots skipped.
  const prepended = Math.max(0, updatedTexts.length - nativeSystem.length);
  const texts = updatedTexts.slice(prepended);
  const result: unknown[] = updatedTexts
    .slice(0, prepended)
    .filter(text => text.length > 0)
    .map(text => ({type: 'text', text}));
  for (let i = 0; i < nativeSystem.length; i++) {
    const part = nativeSystem[i];
    if (!isTextSystemPart(part)) {
      result.push(part);
      continue;
    }
    const text = texts[i];
    if (text === undefined) continue;
    if (typeof part === 'string') {
      result.push(text);
    } else if (text === extractSystemPartText(part)) {
      result.push(part);
    } else {
      const nativePart = part as Record<string, unknown>;
      result.push({...nativePart, text});
    }
  }
  return result;
}

/**
 * Appends unique goal-context text parts onto compaction `input.system`,
 * skipping candidates already present (by exact text or `<goal_context id="...">`).
 */
export function appendUniqueCompactionSystemParts(
  nativeSystem: unknown[],
  candidateTexts: string[],
): unknown[] {
  const existingTexts = nativeSystem.map(extractSystemPartText);
  const appended: unknown[] = [];
  for (const text of candidateTexts) {
    if (!text) continue;
    const tagMatch = text.match(/<goal_context\s+id="([^"]+)"/);
    const tagPrefix = tagMatch ? `<goal_context id="${tagMatch[1]}"` : null;
    const alreadyPresent = existingTexts.some(
      existing =>
        existing === text ||
        (tagPrefix !== null && existing.includes(tagPrefix)),
    );
    if (alreadyPresent) continue;
    existingTexts.push(text);
    appended.push({type: 'text', text});
  }
  return appended.length > 0 ? [...nativeSystem, ...appended] : nativeSystem;
}

/**
 * Returns true if an event belongs to the plugin instance's workspace directory,
 * or carries no directory scope (global/unscoped event).
 */
export function isSameWorkspaceLocation(
  eventLocation: unknown,
  canonicalWorkspaceRoot: string | undefined,
): boolean {
  if (
    !canonicalWorkspaceRoot ||
    !eventLocation ||
    typeof eventLocation !== 'object'
  ) {
    return true;
  }
  const dir = (eventLocation as {directory?: unknown}).directory;
  if (typeof dir !== 'string' || !dir.trim()) return true;
  return canonicalPath(dir.trim()) === canonicalWorkspaceRoot;
}

/** Unwraps `{ data }` response envelopes returned by SDK mocks and HTTP adapters. */
export function unwrapV2Data(response: unknown): unknown {
  if (
    response &&
    typeof response === 'object' &&
    'data' in (response as Record<string, unknown>)
  ) {
    return (response as {data?: unknown}).data;
  }
  return response;
}

/** Extracts `sessionID` from flat or legacy `{ path: { id } }` shim inputs. */
export function extractV2SessionIDArg(
  input: Record<string, unknown>,
): string | undefined {
  if (typeof input.sessionID === 'string' && input.sessionID.length > 0) {
    return input.sessionID;
  }
  const path = input.path;
  if (
    path &&
    typeof path === 'object' &&
    typeof (path as {id?: unknown}).id === 'string' &&
    (path as {id: string}).id.length > 0
  ) {
    return (path as {id: string}).id;
  }
  return undefined;
}

/** Extracts `create` fields from either flat `{ parentID, ... }` or `{ body: { ... } }` inputs. */
export function extractV2CreatePayload(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    input.body &&
    typeof input.body === 'object' &&
    !Array.isArray(input.body)
  ) {
    return {...(input.body as Record<string, unknown>)};
  }
  return {...input};
}

/** Extracts `update` fields from either flat `{ title, ... }` or `{ body: { ... } }` inputs. */
export function extractV2UpdatePatch(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    input.body &&
    typeof input.body === 'object' &&
    !Array.isArray(input.body)
  ) {
    return {...(input.body as Record<string, unknown>)};
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      key === 'sessionID' ||
      key === 'path' ||
      key === 'query' ||
      key === 'body'
    ) {
      continue;
    }
    patch[key] = value;
  }
  return patch;
}

/** Checks whether a `session.prompt` return value already contains synchronous assistant output. */
export function hasAssistantReplyContent(response: unknown): boolean {
  const unwrapped = unwrapV2Data(response);
  if (!unwrapped || typeof unwrapped !== 'object') return false;
  const obj = unwrapped as Record<string, unknown>;
  const info = obj.info as {role?: unknown} | null | undefined;
  if (obj.type === 'user' || obj.role === 'user' || info?.role === 'user')
    return false;
  if (Array.isArray(obj.parts) && obj.parts.length > 0) return true;
  if (typeof obj.content === 'string' && obj.content.length > 0) return true;
  if (Array.isArray(obj.content) && obj.content.length > 0) return true;
  if (
    typeof obj.text === 'string' &&
    obj.text.length > 0 &&
    obj.type !== 'user'
  ) {
    return true;
  }
  return false;
}

function mergePartMetadata(
  part: Record<string, unknown>,
  metadata: unknown,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return part;
  }
  const existing =
    part.metadata &&
    typeof part.metadata === 'object' &&
    !Array.isArray(part.metadata)
      ? (part.metadata as Record<string, unknown>)
      : {};
  return {
    ...part,
    metadata: {...(metadata as Record<string, unknown>), ...existing},
  };
}

function normalizeContentParts(
  content: unknown,
  syntheticFlag: boolean,
  fallbackText?: unknown,
  metadata?: unknown,
): unknown[] {
  const parts: unknown[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(
          mergePartMetadata(
            {
              type: 'text',
              text: item,
              ...(syntheticFlag ? {synthetic: true} : {}),
            },
            metadata,
          ),
        );
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const partObj = item as Record<string, unknown>;
      const normalized: Record<string, unknown> =
        partObj.type === 'tool' &&
        typeof partObj.name === 'string' &&
        partObj.tool === undefined
          ? {...partObj, tool: partObj.name}
          : syntheticFlag && partObj.type === 'text'
            ? {...partObj, synthetic: true}
            : {...partObj};
      parts.push(
        normalized.type === 'text' || normalized.type === 'file'
          ? mergePartMetadata(normalized, metadata)
          : normalized,
      );
    }
  } else if (typeof content === 'string' && content.length > 0) {
    parts.push(
      mergePartMetadata(
        {
          type: 'text',
          text: content,
          ...(syntheticFlag ? {synthetic: true} : {}),
        },
        metadata,
      ),
    );
  }
  if (
    parts.length === 0 &&
    typeof fallbackText === 'string' &&
    fallbackText.length > 0
  ) {
    parts.push(
      mergePartMetadata(
        {
          type: 'text',
          text: fallbackText,
          ...(syntheticFlag ? {synthetic: true} : {}),
        },
        metadata,
      ),
    );
  }
  return parts;
}

/**
 * Normalizes a single OpenCode v2 `Session.Message.Info` entry or buffered
 * `@opencode/ai` message into the `{ info, parts }` shape expected by v1-compatible
 * idle, accounting, agent-resolution, and child-verifier helpers.
 */
export function normalizeV2Message(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const msg = raw as Record<string, unknown>;
  if (msg.info && typeof msg.info === 'object' && Array.isArray(msg.parts)) {
    return raw;
  }

  const msgType = typeof msg.type === 'string' ? msg.type : undefined;
  const rawRole = typeof msg.role === 'string' ? msg.role : undefined;

  if (msgType === 'assistant' || (!msgType && rawRole === 'assistant')) {
    const modelObj =
      msg.model && typeof msg.model === 'object'
        ? (msg.model as Record<string, unknown>)
        : undefined;
    const modelID = modelObj?.id ?? modelObj?.modelID;
    const providerID = modelObj?.providerID;
    const info: Record<string, unknown> = {
      ...(msg.id !== undefined ? {id: msg.id} : {}),
      role: 'assistant',
      ...(typeof msg.agent === 'string' ? {agent: msg.agent} : {}),
      ...(modelID !== undefined ? {modelID} : {}),
      ...(providerID !== undefined ? {providerID} : {}),
      ...(msg.model !== undefined ? {model: msg.model} : {}),
      ...(msg.finish !== undefined ? {finish: msg.finish} : {}),
      ...(msg.rawFinish !== undefined ? {rawFinish: msg.rawFinish} : {}),
      ...(msg.error !== undefined ? {error: msg.error} : {}),
      ...(msg.cost !== undefined ? {cost: msg.cost} : {}),
      ...(msg.tokens !== undefined ? {tokens: msg.tokens} : {}),
      ...(msg.metadata !== undefined ? {metadata: msg.metadata} : {}),
      ...(msg.time !== undefined ? {time: msg.time} : {}),
    };
    const parts = Array.isArray(msg.parts)
      ? msg.parts
      : normalizeContentParts(msg.content, false, msg.text);
    return {info, parts};
  }

  if (
    msgType === 'user' ||
    msgType === 'synthetic' ||
    (!msgType && rawRole === 'user')
  ) {
    const isSynthetic = msgType === 'synthetic' || msg.synthetic === true;
    const info: Record<string, unknown> = {
      ...(msg.id !== undefined ? {id: msg.id} : {}),
      role: 'user',
      ...(isSynthetic ? {synthetic: true} : {}),
      ...(typeof msg.agent === 'string' ? {agent: msg.agent} : {}),
      ...(msg.delivery !== undefined ? {delivery: msg.delivery} : {}),
      ...(msg.metadata !== undefined ? {metadata: msg.metadata} : {}),
      ...(msg.time !== undefined ? {time: msg.time} : {}),
    };
    const parts = Array.isArray(msg.parts)
      ? msg.parts.map(p => {
          if (!p || typeof p !== 'object') return p;
          const withSynthetic = isSynthetic
            ? {...(p as Record<string, unknown>), synthetic: true}
            : {...(p as Record<string, unknown>)};
          return mergePartMetadata(withSynthetic, msg.metadata);
        })
      : normalizeContentParts(msg.content, isSynthetic, msg.text, msg.metadata);
    return {
      info,
      parts,
      ...(msg.delivery !== undefined ? {delivery: msg.delivery} : {}),
    };
  }

  const effectiveRole = msgType ?? rawRole;
  if (effectiveRole) {
    const info: Record<string, unknown> = {
      ...(msg.id !== undefined ? {id: msg.id} : {}),
      role: effectiveRole,
      ...(typeof msg.agent === 'string' ? {agent: msg.agent} : {}),
      ...(msg.metadata !== undefined ? {metadata: msg.metadata} : {}),
      ...(msg.time !== undefined ? {time: msg.time} : {}),
    };
    const parts = Array.isArray(msg.parts)
      ? msg.parts
      : normalizeContentParts(msg.content, false, msg.text, msg.metadata);
    return {info, parts};
  }

  return raw;
}

/** Normalizes an array of v2 context/buffered messages. */
export function normalizeV2Messages(messages: unknown[]): unknown[] {
  return messages.map(normalizeV2Message);
}

/**
 * Stable identities for the subagent/image jobs that block an idle turn. The
 * childSessionID (when present) distinguishes concurrent jobs; using these keys
 * lets a later idle establish that the same job set has cleared.
 */
export function blockingBackgroundJobKeys(
  background: unknown,
  sessionID: string,
): string[] {
  if (!Array.isArray(background)) return [];
  const keys: string[] = [];
  for (const entry of background) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as {
      kind?: unknown;
      sessionID?: unknown;
      status?: unknown;
      childSessionID?: unknown;
    };
    if (item.kind !== 'subagent' && item.kind !== 'image') continue;
    if (item.sessionID !== undefined && item.sessionID !== sessionID) continue;
    if (item.status !== undefined && item.status !== 'running') continue;
    const identity =
      typeof item.childSessionID === 'string' && item.childSessionID.length > 0
        ? item.childSessionID
        : sessionID;
    keys.push(`${String(item.kind)}:${identity}`);
  }
  return keys;
}

/**
 * Returns true if `experimental.idle` reports any running subagent or image
 * background job scoped to `sessionID`. Shell background jobs do not block idle.
 */
export function hasBlockingBackgroundJobs(
  background: unknown,
  sessionID: string,
): boolean {
  return blockingBackgroundJobKeys(background, sessionID).length > 0;
}

/** Shape of one background-deferral record (mirrors RuntimeState's map value). */
export interface BackgroundDeferral {
  jobKeys: string[];
  since: number;
  nextRecheckAt: number;
  extensions: number;
}

/** Absolute bound for one overlapping set of unreported background jobs. */
export const MAX_BACKGROUND_WAIT_MS = 15 * 60_000;

/**
 * Computes the next deferral record for a blocked idle. Only an authoritative
 * empty-background idle (or bounded escalation) removes a deferral, so a
 * surviving record means the session has been blocked continuously — the host
 * may regenerate job keys on every report. The clock is therefore preserved for
 * any existing deferral, and only the capped `nextRecheckAt` moves.
 */
export function nextDeferralOnBlockedIdle(args: {
  jobKeys: string[];
  existing: BackgroundDeferral | undefined;
  now: number;
  recheckDelayMs?: number;
}): BackgroundDeferral {
  const {jobKeys, existing, now} = args;
  const recheckDelayMs = args.recheckDelayMs ?? 30_000;
  const since = existing?.since ?? now;
  return {
    jobKeys,
    since,
    nextRecheckAt: Math.min(
      now + recheckDelayMs,
      since + MAX_BACKGROUND_WAIT_MS,
    ),
    extensions: existing?.extensions ?? 0,
  };
}

/**
 * Extract routable text from a v2 inbox item. `synthetic` marks plugin-generated
 * items (kickoffs/continuations) that must never be treated as human steering.
 */
export function extractInboxMessage(
  item: unknown,
  tuiMetadataKey: string,
): {text: string; synthetic: boolean} | null {
  if (!item || typeof item !== 'object') return null;
  const entry = item as {
    type?: string;
    synthetic?: boolean;
    metadata?: Record<string, unknown>;
    payload?: {text?: unknown; metadata?: Record<string, unknown>};
    text?: unknown;
  };
  const text = entry.payload?.text ?? entry.text;
  if (typeof text !== 'string' || !text.trim()) return null;
  const synthetic =
    entry.type === 'synthetic' ||
    entry.synthetic === true ||
    Boolean(entry.metadata?.[tuiMetadataKey]) ||
    Boolean(entry.payload?.metadata?.[tuiMetadataKey]);
  return {text, synthetic};
}

/** Computes a lightweight turn signature from normalized messages for idle dedupe. */
export function latestTurnSignatureFromMessages(messages: unknown[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as {
      id?: unknown;
      info?: {id?: unknown; role?: unknown; time?: {created?: unknown}};
      role?: unknown;
      time?: {created?: unknown};
    };
    const role = m.info?.role ?? m.role;
    if (role !== 'assistant' && role !== 'agent') continue;
    const id = m.id ?? m.info?.id;
    if (typeof id === 'string' && id.length > 0) return `id:${id}`;
    const created = m.info?.time?.created ?? m.time?.created;
    if (typeof created === 'number' && created > 0) return `ts:${created}`;
    return `idx:${i}:${messages.length}`;
  }
  return `len:${messages.length}`;
}

/** Per-session record of a handled `experimental.idle` turn for trailing-event deduplication. */
export interface IdleHandledRecord {
  readonly turnSignature: string;
  readonly ts: number;
  readonly backgroundBlocked: boolean;
}

/**
 * Returns true if a trailing `session.execution.succeeded` event corresponds to an
 * idle cycle already evaluated (or deferred for background jobs) by `experimental.idle`.
 */
export function shouldSuppressTrailingIdle(
  records: Map<string, IdleHandledRecord>,
  sessionID: string,
  currentTurnSignature: string,
  now: number,
  stillDeferred?: (sessionID: string) => boolean,
): boolean {
  // Execution/step start may remove the turn record without completing the
  // background jobs. The authoritative deferral gates all trailing idles.
  if (stillDeferred?.(sessionID)) return true;
  const entry = records.get(sessionID);
  if (!entry) return false;
  if (entry.backgroundBlocked) {
    // Keep suppressing while a deferral is authoritative; only the native idle
    // that clears the background, or bounded escalation, removes the record.
    if (now - entry.ts < 30_000) return true;
    records.delete(sessionID);
    return false;
  }
  records.delete(sessionID);
  if (
    entry.turnSignature !== '' &&
    entry.turnSignature === currentTurnSignature
  ) {
    return true;
  }
  return now - entry.ts < 5_000;
}

/** Registers v1 goal tools on the v2 `tool.transform` host surface with retry logging. */
