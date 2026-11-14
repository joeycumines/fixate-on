/**
 * Pure bridge helpers for adapting OpenCode v2 contexts, locations, and system parts.
 *
 * Kept as a leaf module (depends only on Node stdlib path/fs) so `plugin-v2.ts`
 * remains cohesive and well within the single-concern module budget.
 */

import {appendFileSync, realpathSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';

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
  hook: <N extends 'context' | 'compaction' | 'experimental.idle'>(
    name: N,
    cb: (
      input: N extends 'experimental.idle'
        ? V2SessionIdleContext
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
  const consumed = new Set<number>();
  const result: unknown[] = [];
  for (const text of updatedTexts) {
    if (typeof text !== 'string') continue;
    const matchIdx = nativeSystem.findIndex(
      (part, idx) => !consumed.has(idx) && extractSystemPartText(part) === text,
    );
    if (matchIdx !== -1) {
      consumed.add(matchIdx);
      result.push(nativeSystem[matchIdx]);
    } else if (text.length > 0) {
      result.push({type: 'text', text});
    }
  }
  for (let i = 0; i < nativeSystem.length; i++) {
    if (!consumed.has(i) && !isTextSystemPart(nativeSystem[i])) {
      result.push(nativeSystem[i]);
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
 * Returns true if `experimental.idle` reports any running subagent or image
 * background job scoped to `sessionID`. Shell background jobs do not block idle.
 */
export function hasBlockingBackgroundJobs(
  background: unknown,
  sessionID: string,
): boolean {
  if (!Array.isArray(background)) return false;
  for (const entry of background) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as {
      kind?: unknown;
      sessionID?: unknown;
      status?: unknown;
    };
    if (item.kind !== 'subagent' && item.kind !== 'image') continue;
    if (item.sessionID !== undefined && item.sessionID !== sessionID) continue;
    if (item.status !== undefined && item.status !== 'running') continue;
    return true;
  }
  return false;
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
): boolean {
  const entry = records.get(sessionID);
  if (!entry) return false;
  if (entry.backgroundBlocked) {
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
export async function registerV2GoalTools(args: {
  toolTransform: NonNullable<V2Context['tool']>['transform'];
  tools: Record<string, unknown>;
  z: ZodModule | null;
  drainTuiEvents: (sessionID: string) => unknown[];
  encodeMetadata: (events: unknown[]) => Record<string, unknown> | undefined;
  shapeResult: (
    result: unknown,
    goalMetadata: Record<string, unknown> | undefined,
  ) => unknown;
  disposers: Array<() => Promise<void> | void>;
}): Promise<void> {
  const registeredNames = new Set<string>();
  const registerOnce = async (): Promise<void> => {
    const attemptNames = new Set<string>();
    const reg = await args.toolTransform(draft => {
      for (const [name, def] of Object.entries(args.tools)) {
        if (!def || typeof def !== 'object') continue;
        if (registeredNames.has(name)) continue;
        const tool = def as {
          description?: string;
          args?: Record<string, unknown>;
          execute?: (
            toolArgs: Record<string, unknown>,
            ctx: {sessionID: string},
          ) => Promise<unknown> | unknown;
        };
        if (typeof tool.execute !== 'function') continue;
        try {
          draft.add({
            name,
            description:
              typeof tool.description === 'string'
                ? tool.description
                : `${name} (fixate-on)`,
            input: buildToolInputSchema(args.z, tool.args),
            options: {codemode: false},
            execute: async (input: unknown, execCtx: unknown) => {
              const sid =
                (execCtx as {sessionID?: string} | null)?.sessionID ?? '';
              const result = await tool.execute!(
                (input ?? {}) as Record<string, unknown>,
                {sessionID: sid},
              );
              const events = sid ? args.drainTuiEvents(sid) : [];
              const goalMeta = args.encodeMetadata(events);
              return args.shapeResult(result, goalMeta);
            },
          });
          attemptNames.add(name);
        } catch (error) {
          console.error(
            `[fixate-on] failed to register tool "${name}":`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    });
    args.disposers.push(() => reg.dispose());
    for (const name of attemptNames) registeredNames.add(name);
  };

  try {
    await registerOnce();
  } catch (error) {
    console.error(
      '[fixate-on] tool registration failed (attempt 1):',
      error instanceof Error ? error.message : error,
    );
    await logToolRegistrationFailure('attempt-1', error);
    try {
      await registerOnce();
      console.error('[fixate-on] tool registration succeeded on retry');
    } catch (retryError) {
      console.error(
        '[fixate-on] tool registration FAILED after retry — goal tools are UNAVAILABLE:',
        retryError instanceof Error ? retryError.message : retryError,
      );
      await logToolRegistrationFailure('retry-exhausted', retryError);
    }
  }
}

export interface NativeAgentSpec {
  readonly description?: string;
  readonly mode?: string;
  readonly prompt?: string;
  readonly hidden?: boolean;
}

/**
 * Mirrors native `goal` and read-only `goal-verify` agent registration into
 * OpenCode v2's `ctx.agent.transform` draft while failing closed on pre-existing
 * verifier collisions.
 */
export function applyV2AgentTransforms(
  draft: V2AgentDraft,
  agentsConfig: Record<string, NativeAgentSpec> | undefined,
  opts: {
    goalAgentName: string;
    verifierAgentName: string;
    registerAgents: boolean;
    requireVerifierOwnership: boolean;
  },
): void {
  if (opts.goalAgentName === opts.verifierAgentName) {
    throw new TypeError(
      'goalAgentName and verifierAgentName must be different',
    );
  }
  const existingVerifier = draft.get?.(opts.verifierAgentName);
  if (existingVerifier && opts.requireVerifierOwnership) {
    throw new Error(
      `childSessionJudge cannot safely use existing agent ${JSON.stringify(opts.verifierAgentName)}; choose an unused verifierAgentName`,
    );
  }
  if (!opts.registerAgents || !agentsConfig) return;

  const goalSpec = agentsConfig[opts.goalAgentName];
  if (goalSpec && !draft.get?.(opts.goalAgentName)) {
    draft.update(opts.goalAgentName, entry => {
      entry.name = opts.goalAgentName;
      if (goalSpec.description) entry.description = goalSpec.description;
      entry.mode = 'primary';
      entry.hidden = false;
      if (goalSpec.prompt) entry.system = goalSpec.prompt;
    });
  }

  const verifierSpec = agentsConfig[opts.verifierAgentName];
  if (verifierSpec && !existingVerifier) {
    draft.update(opts.verifierAgentName, entry => {
      entry.name = opts.verifierAgentName;
      if (verifierSpec.description) {
        entry.description = verifierSpec.description;
      }
      entry.mode = 'subagent';
      entry.hidden = true;
      if (verifierSpec.prompt) entry.system = verifierSpec.prompt;
      const perms = Array.isArray(entry.permissions)
        ? entry.permissions
        : (entry.permissions = []);
      perms.length = 0;
      perms.push(
        {action: '*', resource: '*', effect: 'deny'},
        {action: 'read', resource: '*', effect: 'allow'},
        {action: 'glob', resource: '*', effect: 'allow'},
        {action: 'grep', resource: '*', effect: 'allow'},
        {action: 'read', resource: '*.env', effect: 'deny'},
        {action: 'read', resource: '*.env.*', effect: 'deny'},
        {action: 'read', resource: '*.env.example', effect: 'allow'},
        {action: 'edit', resource: '*', effect: 'deny'},
        {action: 'write', resource: '*', effect: 'deny'},
        {action: 'patch', resource: '*', effect: 'deny'},
        {action: 'bash', resource: '*', effect: 'deny'},
        {action: 'shell', resource: '*', effect: 'deny'},
        {action: 'create_goal', resource: '*', effect: 'deny'},
        {action: 'update_goal', resource: '*', effect: 'deny'},
        {action: 'propose_goal_change', resource: '*', effect: 'deny'},
        {action: 'goal-command', resource: '*', effect: 'deny'},
      );
    });
  }
}
