/**
 * plugin-v2.ts — V2 server plugin entry for fixate-on.
 *
 * Exports `{ id, setup(context) }` conforming to the v2 Promise-plugin API.
 * Acts as a wiring adapter that wraps the v2 Context into a v1-style client,
 * invokes GoalsPlugin, bridges v1 hooks to v2 domain methods, and handles cleanup.
 *
 * Dependency DAG: plugin-v2.ts -> plugin-runtime.ts (GoalsPlugin) -> hooks/loop/gate.
 */

import {
  type IdleHandledRecord,
  type MessageBuffer,
  type NativeAgentSpec,
  type V2Context,
  type V2SessionOp,
  appendUniqueCompactionSystemParts,
  applyV2AgentTransforms,
  blockingBackgroundJobKeys,
  canonicalPath,
  extractInboxMessage,
  extractSystemPartText,
  extractV2CreatePayload,
  extractV2SessionIDArg,
  extractV2UpdatePatch,
  hasAssistantReplyContent,
  isSameWorkspaceLocation,
  latestTurnSignatureFromMessages,
  loadZodV2,
  normalizeV2Messages,
  reconcileSystemParts,
  registerV2GoalTools,
  shouldSuppressTrailingIdle,
  unwrapV2Data,
} from './plugin-v2-helpers.ts';
import {
  type RecentKickoffTextTracker,
  applyV2LegacyCommandUpdates,
  assertV2AttachmentsBeforeRun,
  assertV2CommandCanDispatch,
  buildV2CommandKickoffDispatch,
  createRecentKickoffTextTracker,
  logV2DiagnosticEvent,
  markRecentKickoffMessages,
  validateV2CommandExecutionInput,
} from './plugin-v2-command.ts';
import {
  normalizeInheritedAgentForPrompt,
  stripAgentListSortPrefix,
} from './agent-resolve.ts';
import {buildContinueMessage} from './steering.ts';
import {GoalsPlugin, type PluginOptions} from './plugin-runtime.ts';
import type {PluginHooks} from './hooks.ts';
import {GOAL_COMMAND_TEMPLATE_PREFIX} from './native-agent-config.ts';
import {
  consumeInboxPayload,
  recordEventInputDelivery,
  recordInboxPayload,
  resolveInputDeliveryFields,
} from './session-runtime.ts';
import {
  createBufferingTransport,
  encodeGoalToolMetadata,
  GOAL_TUI_METADATA_KEY,
} from './tui-state.ts';

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

/**
 * Adapts v2 session operations to match the v1 client interface required by GoalsPlugin.
 */
export function createV2ClientShim(
  ctx: V2Context,
  buffer: MessageBuffer,
  onMessagesObserved?: (sessionID: string, signature: string) => void,
  recentKickoffTexts?: RecentKickoffTextTracker,
): {
  session: Record<string, V2SessionOp | undefined>;
} {
  const session = ctx.session;

  // v1 promptAsync callers mark steers with `synthetic: true`. Route to v2's
  // synthetic op to wake execution without injecting a genuine user turn.
  const promptAsync: V2SessionOp = async input => {
    const translated = v1PartsToV2Text(input);
    return session.synthetic({
      sessionID: translated.sessionID ?? '',
      text: translated.text,
      ...(translated.metadata ? {metadata: translated.metadata} : {}),
      ...(translated.agent ? {agent: translated.agent} : {}),
    });
  };

  // Regular prompt used for synchronous turns such as child-session verifiers.
  // On v2.2.7, session.prompt admits input and runs asynchronously; wait for idle
  // when no assistant reply parts are present and the host exposes session.wait.
  const prompt: V2SessionOp = async input => {
    const translated = v1PartsToV2Text(input);
    const targetSessionID = translated.sessionID ?? '';
    if (translated.agent && targetSessionID) {
      if (typeof session.switchAgent !== 'function') {
        throw new Error(
          `cannot select agent ${JSON.stringify(translated.agent)}: host has no switchAgent operation`,
        );
      }
      try {
        await session.switchAgent({
          sessionID: targetSessionID,
          agent: translated.agent,
        });
      } catch (error) {
        throw new Error(
          `failed to select agent ${JSON.stringify(translated.agent)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const res = await session.prompt({
      sessionID: targetSessionID,
      text: translated.text,
      ...(translated.metadata ? {metadata: translated.metadata} : {}),
      ...(translated.agent ? {agent: translated.agent} : {}),
    });
    if (
      !hasAssistantReplyContent(res) &&
      targetSessionID &&
      typeof session.wait === 'function'
    ) {
      await session.wait({sessionID: targetSessionID});
    }
    return res;
  };

  const abort: V2SessionOp = async input => {
    const sessionID = extractV2SessionIDArg(input);
    if (!sessionID) return {};
    return session.interrupt({sessionID});
  };

  const create: V2SessionOp = async input => {
    const createInput = extractV2CreatePayload(input);
    const hasParentID =
      typeof createInput.parentID === 'string' &&
      createInput.parentID.length > 0;
    const locationDir =
      typeof ctx.location?.directory === 'string' &&
      ctx.location.directory.trim()
        ? ctx.location.directory.trim()
        : undefined;
    const payload =
      !hasParentID && createInput.location === undefined && locationDir
        ? {...createInput, location: {directory: locationDir}}
        : {...createInput};
    const raw = await session.create(payload);
    if (hasParentID) {
      const created = unwrapV2Data(raw);
      const createdParentID =
        created && typeof created === 'object'
          ? (created as {parentID?: unknown}).parentID
          : undefined;
      if (createdParentID !== createInput.parentID) {
        const createdID =
          created && typeof created === 'object'
            ? (created as {id?: unknown}).id
            : undefined;
        if (
          typeof createdID === 'string' &&
          createdID &&
          typeof session.remove === 'function'
        ) {
          await session.remove({sessionID: createdID}).catch(() => {});
        }
        throw new Error(
          'parent-bound session creation unsupported by v2 host; no fork performed',
        );
      }
    }
    return raw;
  };

  const get: V2SessionOp = async input => {
    const sessionID = extractV2SessionIDArg(input);
    return session.get(sessionID ? {sessionID} : {...input});
  };

  const remove: V2SessionOp = async input => {
    if (typeof session.remove !== 'function') {
      throw new Error('session deletion unsupported by v2 host');
    }
    const sessionID = extractV2SessionIDArg(input);
    if (!sessionID) {
      throw new TypeError('sessionID is required for session deletion');
    }
    const res = await session.remove({sessionID});
    return res ?? {};
  };

  const update: V2SessionOp = async input => {
    if (typeof session.update !== 'function') {
      throw new Error('session operation unsupported by v2 adapter');
    }
    const sessionID = extractV2SessionIDArg(input);
    if (!sessionID) {
      throw new TypeError('sessionID is required for session update');
    }
    const patch = extractV2UpdatePatch(input);
    const res = await session.update({...patch, sessionID});
    return res ?? {};
  };

  const messages: V2SessionOp = async input => {
    const sessionID = extractV2SessionIDArg(input);
    const rawLimit =
      (input as {limit?: unknown; query?: {limit?: unknown}})?.limit ??
      (input as {query?: {limit?: unknown}})?.query?.limit;
    const limit = typeof rawLimit === 'number' ? rawLimit : undefined;
    if (!sessionID) return [];
    let rawList: unknown[] | undefined;
    if (typeof session.context === 'function') {
      try {
        const ctxResult = await session.context({sessionID});
        const unwrapped = unwrapV2Data(ctxResult);
        if (Array.isArray(unwrapped)) {
          rawList = unwrapped;
        }
      } catch {
        /* fall back to pre-turn buffer if context endpoint is unavailable */
      }
    }
    const sourceList = rawList ?? buffer.bySession.get(sessionID) ?? [];
    const normalized = markRecentKickoffMessages(
      normalizeV2Messages(sourceList),
      sessionID,
      GOAL_TUI_METADATA_KEY,
      recentKickoffTexts,
    );
    onMessagesObserved?.(
      sessionID,
      latestTurnSignatureFromMessages(normalized),
    );
    const start =
      typeof limit === 'number' && limit > 0
        ? Math.max(0, normalized.length - limit)
        : 0;
    return normalized.slice(start);
  };

  return {
    session: {
      promptAsync,
      prompt,
      abort,
      create,
      get,
      delete: remove,
      update,
      messages,
    },
  };
}

const MESSAGE_BUFFER_CAP = 100;

/**
 * Normalizes tool execution results into opencode v2's `Tool.Result` schema.
 *
 * Core rejects results where `content === undefined`, terminating execution.
 * Any non-string or non-object result is normalized to `{ content: "" }` with
 * attached metadata to guarantee safe delivery over session events.
 */
export function shapeToolResult(
  result: unknown,
  goalMetadata: Record<string, unknown> | undefined,
):
  | {content: string | unknown[]; metadata?: Record<string, unknown>}
  | Record<string, unknown> {
  if (typeof result === 'string') {
    return goalMetadata
      ? {content: result, metadata: goalMetadata}
      : {content: result};
  }
  if (result && typeof result === 'object') {
    if (goalMetadata) {
      const obj = result as {metadata?: Record<string, unknown>};
      obj.metadata = obj.metadata
        ? {...obj.metadata, ...goalMetadata}
        : goalMetadata;
    }
    return result as Record<string, unknown>;
  }
  return goalMetadata ? {content: '', metadata: goalMetadata} : {content: ''};
}

export async function setup(ctx: V2Context): Promise<() => Promise<void>> {
  // Validate static agent names before acquiring any runtime/persistence resources.
  const rawOptionsEarly = ctx.options as PluginOptions;
  const earlyGoalName =
    (typeof rawOptionsEarly?.goalAgentName === 'string' &&
      rawOptionsEarly.goalAgentName.trim()) ||
    'goal';
  const earlyVerifierName =
    (typeof rawOptionsEarly?.verifierAgentName === 'string' &&
      rawOptionsEarly.verifierAgentName.trim()) ||
    'goal-verify';
  if (earlyGoalName === earlyVerifierName) {
    throw new TypeError(
      'goalAgentName and verifierAgentName must be different',
    );
  }

  // Bridge TUI sync over tool execution results. Since v2 lacks a direct server-to-TUI
  // push channel, buffered state events are drained into Result.metadata, which
  // core broadcasts over `session.tool.success`.
  const tuiTransport = createBufferingTransport();
  const rawOptions = ctx.options as PluginOptions;
  const pluginOptions: PluginOptions = {
    ...rawOptions,
    sdkShape: rawOptions?.sdkShape ?? 'flat',
    tuiTransport: tuiTransport.publish,
  };

  const buffer: MessageBuffer = {bySession: new Map()};
  const recordMessages = (sessionID: string, messages: unknown[]): void => {
    if (!sessionID || !Array.isArray(messages)) return;
    // Replace rather than concatenate to prevent unbounded memory growth and duplicate history.
    const next = messages.slice(-MESSAGE_BUFFER_CAP);
    buffer.bySession.set(sessionID, next);
  };

  // Track per-session idle turn state across experimental.idle and event streams.
  const idleStateBySession = new Map<string, IdleHandledRecord>();
  const lastObservedTurnBySession = new Map<string, string>();
  const recentKickoffTexts = createRecentKickoffTextTracker();
  let idleSeq = 0;

  // Resolve workspace directory: explicit plugin option > host ctx.location.directory > cwd.
  const client = createV2ClientShim(
    ctx,
    buffer,
    (sessionID, signature) => {
      lastObservedTurnBySession.set(sessionID, signature);
    },
    recentKickoffTexts,
  );
  const directory =
    (typeof pluginOptions.workspaceDirectory === 'string' &&
      pluginOptions.workspaceDirectory.trim()) ||
    (typeof ctx.location?.directory === 'string' &&
      ctx.location.directory.trim()) ||
    (typeof process.cwd === 'function' ? process.cwd() : undefined);
  const resolvedDirectory = directory ? canonicalPath(directory) : undefined;
  const v1Result = await GoalsPlugin({client, directory}, pluginOptions);
  const hooks = v1Result as PluginHooks & {
    tool?: Record<string, unknown>;
    dispose?: () => Promise<void>;
    runtime?: import('./session-state-manager.ts').RuntimeState;
  };

  const disposers: Array<() => Promise<void> | void> = [];
  let stopEventLoop = false;
  let stopEventLoopResolve: (() => void) | undefined;
  const stopEventLoopSignal = new Promise<void>(resolve => {
    stopEventLoopResolve = resolve;
  });
  let eventIterator:
    | AsyncIterator<{
        id?: string;
        type: string;
        location?: {directory?: string; workspaceID?: string} | null;
        data?: Record<string, unknown>;
      }>
    | undefined;
  let eventLoop: Promise<void> = Promise.resolve();
  let disposed = false;
  const disposeAll = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    stopEventLoop = true;
    stopEventLoopResolve?.();
    try {
      await eventIterator?.return?.();
    } catch {
      /* best-effort iterator shutdown */
    }
    try {
      tuiTransport.clear();
      recentKickoffTexts.clear();
    } catch {
      /* best-effort transport cleanup */
    }
    try {
      await eventLoop.catch(() => {});
    } catch {
      /* ignore */
    }
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        /* best-effort dispose */
      }
    }
    try {
      await hooks.dispose?.();
    } catch {
      /* best-effort v1 hook dispose */
    }
  };

  // The rest of setup can throw (late transforms, config hooks, agent transforms).
  // Unwind every acquired resource on failure — the host only receives the disposer
  // when setup resolves, so a throw otherwise leaks leases, intervals and hooks.
  try {
    await registerBridges();
  } catch (error) {
    await disposeAll();
    throw error;
  }
  return disposeAll;

  async function registerBridges(): Promise<void> {
    // Bridge 1: session.hook("context") -> chat.params + system.transform
    if (typeof ctx.session?.hook === 'function') {
      try {
        const reg = await ctx.session.hook('context', async input => {
          if (!input?.sessionID) return;
          const sessionID = input.sessionID;
          recordMessages(
            sessionID,
            Array.isArray(input.messages) ? input.messages : [],
          );

          // Note: input.tools supplies native tool definitions, not a boolean allowlist.
          // Goal tools are registered via tool.transform; do not inject boolean placeholders.

          try {
            await hooks['chat.params']?.({
              sessionID,
              agent: input.agent,
              model:
                typeof input.model === 'string' ? input.model : input.model?.id,
            });
          } catch {
            /* best-effort diagnostics */
          }

          // Apply system transformations through v1 hooks and reconcile back onto native SystemPart objects.
          try {
            const nativeSystem = Array.isArray(input.system)
              ? input.system.slice()
              : [];
            const systemOutput = {
              system: nativeSystem.map(extractSystemPartText),
            };
            await hooks['experimental.chat.system.transform']?.(
              {sessionID},
              systemOutput,
            );
            if (Array.isArray(systemOutput.system)) {
              input.system = reconcileSystemParts(
                nativeSystem,
                systemOutput.system,
              );
            }
          } catch {
            /* best-effort system prompt injection */
          }
        });
        disposers.push(() => reg.dispose());
      } catch {
        /* context hook unavailable; fallback to event subscription */
      }

      // Bridge 1b: session.hook("compaction") -> experimental.session.compacting
      try {
        const reg = await ctx.session.hook('compaction', async input => {
          if (!input?.sessionID) return;
          try {
            const compactOutput: {parts: unknown[]} = {parts: []};
            await hooks['experimental.session.compacting']?.(
              {sessionID: input.sessionID},
              compactOutput,
            );
            const candidateTexts = compactOutput.parts
              .map(extractSystemPartText)
              .filter(text => text.length > 0);
            if (candidateTexts.length === 0) return;
            const nativeSystem = Array.isArray(input.system)
              ? input.system.slice()
              : [];
            input.system = appendUniqueCompactionSystemParts(
              nativeSystem,
              candidateTexts,
            );
          } catch {
            /* best-effort compaction context injection */
          }
        });
        disposers.push(() => reg.dispose());
      } catch {
        /* compaction hook unavailable on older hosts */
      }

      // Bridge 1c: session.hook("experimental.idle") -> in-loop continuation before host Complete()
      try {
        const reg = await ctx.session.hook('experimental.idle', async input => {
          if (!input?.sessionID) return;
          const sessionID = input.sessionID;
          const jobKeys = blockingBackgroundJobKeys(
            input.background,
            sessionID,
          );
          if (jobKeys.length > 0) {
            idleStateBySession.set(sessionID, {
              turnSignature: lastObservedTurnBySession.get(sessionID) ?? '',
              ts: Date.now(),
              backgroundBlocked: true,
            });
            const now = Date.now();
            const deadline = now + 30_000;
            hooks.runtime?.backgroundBlockedUntil.set(sessionID, deadline);
            hooks.runtime?.backgroundDeferrals?.set(sessionID, {
              jobKeys,
              since: now,
              nextRecheckAt: deadline,
              extensions: 0,
            });
            return;
          }
          // An idle with no blocking jobs is the authoritative clear: the
          // previously reported jobs have finished. Release the deferral before
          // driving the goal so the fallback poller cannot keep deferring.
          hooks.runtime?.backgroundDeferrals?.delete(sessionID);
          hooks.runtime?.backgroundBlockedUntil.delete(sessionID);
          const preSignature = lastObservedTurnBySession.get(sessionID) ?? '';
          idleStateBySession.set(sessionID, {
            turnSignature: preSignature,
            ts: Date.now(),
            backgroundBlocked: false,
          });
          try {
            await hooks.event?.({
              type: 'session.idle',
              sessionID,
              id: `v2-exp-idle:${sessionID}:${++idleSeq}`,
              properties: {},
            });
          } finally {
            const postSignature =
              lastObservedTurnBySession.get(sessionID) ?? preSignature;
            idleStateBySession.set(sessionID, {
              turnSignature: postSignature,
              ts: Date.now(),
              backgroundBlocked: false,
            });
          }
        });
        disposers.push(() => reg.dispose());
      } catch {
        /* experimental.idle unavailable on older hosts; event stream handles fallback */
      }
    }

    // Bridge 2: Subscribe to v2 event streams and map to v1 event handlers.
    eventLoop = (async () => {
      if (typeof ctx.event?.subscribe !== 'function') return;
      try {
        const stream = ctx.event.subscribe();
        eventIterator = stream[Symbol.asyncIterator]();

        // Opt-in debug logging: set FIXATE_ON_EVENT_LOG=<path> to capture event flow.
        const eventLogPath = process.env.FIXATE_ON_EVENT_LOG;
        while (!stopEventLoop) {
          const result = await Promise.race([
            eventIterator.next(),
            stopEventLoopSignal.then(
              () =>
                ({done: true, value: undefined}) as IteratorResult<{
                  id?: string;
                  type: string;
                  location?: {directory?: string; workspaceID?: string} | null;
                  data?: Record<string, unknown>;
                }>,
            ),
          ]);
          if (result.done) break;
          const ev = result.value;
          if (!ev || typeof ev.type !== 'string') continue;
          if (!isSameWorkspaceLocation(ev.location, resolvedDirectory))
            continue;
          const data = ev.data ?? {};
          const sessionID = getV2EventSessionID(data);
          if (eventLogPath) {
            try {
              const {appendFileSync} = await import('node:fs');
              const msgID =
                (data?.info as {id?: unknown} | undefined)?.id ?? '';
              appendFileSync(
                eventLogPath,
                `${Date.now()} ${ev.type} ${sessionID ?? ''} ${String(msgID)}\n`,
              );
            } catch {
              /* diagnostics must never break the loop */
            }
          }

          // v2 hosts do not trigger the v1 `chat.message` hook. Synthesize the hook call
          // from `session.input.admitted` so user steering commands (e.g. pause/stop) are
          // respected. Queued input (delivery "queue") is NOT synthesized: it waits for
          // the turn boundary by definition and is surfaced as a notice by the idle path.
          if (ev.type === 'session.input.admitted' && sessionID) {
            const {delivery} = resolveInputDeliveryFields(
              data,
              ev.type,
              sessionID,
            );
            recordV2InputDelivery(hooks.runtime, data, ev.type, sessionID);
            if (delivery !== 'queue') {
              try {
                await synthesizeChatMessageFromAdmitted(
                  hooks['chat.message'],
                  data,
                  recentKickoffTexts,
                );
              } catch {
                /* steering failures must not break the event loop */
              }
            }
          }
          if (
            (ev.type === 'session.step.started' ||
              ev.type === 'session.execution.started') &&
            sessionID
          ) {
            idleStateBySession.delete(sessionID);
            hooks.runtime?.backgroundBlockedUntil.delete(sessionID);
            hooks.runtime?.backgroundDeferrals?.delete(sessionID);
          }
          if (
            ev.type === 'session.execution.succeeded' &&
            sessionID &&
            shouldSuppressTrailingIdle(
              idleStateBySession,
              sessionID,
              lastObservedTurnBySession.get(sessionID) ?? '',
              Date.now(),
              id =>
                (hooks.runtime?.backgroundDeferrals?.has(id) ?? false) ||
                (hooks.runtime?.backgroundBlockedUntil.get(id) ?? 0) >
                  Date.now(),
            )
          ) {
            continue;
          }

          // Record inbox delivery mode on released 2.x (through v2.2.5), which emits
          // session.inbox.enqueued / delivery.changed instead of session.input.*.
          if (
            (ev.type === 'session.inbox.enqueued' ||
              ev.type === 'session.inbox.delivery.changed') &&
            sessionID
          ) {
            recordV2InputDelivery(hooks.runtime, data, ev.type, sessionID);
            const {id: inboxID, delivery} = resolveInputDeliveryFields(
              data,
              ev.type,
              sessionID,
            );
            if (ev.type === 'session.inbox.enqueued') {
              const message = extractInboxMessage(
                data.item,
                GOAL_TUI_METADATA_KEY,
              );
              const routable =
                message &&
                !message.synthetic &&
                !recentKickoffTexts.matches(sessionID, message.text);
              if (delivery === 'queue') {
                // Retain the text: delivery.changed carries only an id, so a
                // later queue→steer promotion needs the original payload.
                if (message)
                  recordInboxPayload(
                    hooks.runtime,
                    sessionID,
                    inboxID,
                    message,
                  );
              } else if (routable && message) {
                // Initially-steered items synthesize immediately as before.
                try {
                  await synthesizeChatMessageFromText(
                    hooks['chat.message'],
                    sessionID,
                    message.text,
                    {
                      inputID: inboxID,
                      ...((data.item as {delivery?: unknown})?.delivery
                        ? {
                            delivery: (data.item as {delivery: unknown})
                              .delivery,
                          }
                        : {}),
                    },
                  );
                } catch {
                  /* steering failures must not break the event loop */
                }
              }
            } else if (
              ev.type === 'session.inbox.delivery.changed' &&
              delivery === 'steer'
            ) {
              // Genuine queue→steer promotion: the host sends no text, so use
              // the payload retained at enqueue time. Synthesize at most once.
              const retained = consumeInboxPayload(
                hooks.runtime,
                sessionID,
                inboxID,
              );
              if (
                retained &&
                !retained.synthetic &&
                !recentKickoffTexts.matches(sessionID, retained.text)
              ) {
                try {
                  await synthesizeChatMessageFromText(
                    hooks['chat.message'],
                    sessionID,
                    retained.text,
                    {inputID: inboxID, delivery: 'steer'},
                  );
                } catch {
                  /* steering failures must not break the event loop */
                }
              }
            }
          }
          try {
            await hooks.event?.({
              type: ev.type,
              sessionID,
              id: ev.id,
              properties: data,
            });
          } catch {
            /* best-effort event dispatch */
          }
        }
      } catch {
        /* stream closed or errored */
      }
    })();

    // Retained native command dispatch: an admission failure keeps the original
    // attachment-bearing payload so a delayed retry does not silently drop it.
    hooks.runtime!.retryPendingKickoffDispatch = async (
      sessionID: string,
      retained: unknown,
    ) => {
      const dispatch = retained as {
        method: 'prompt' | 'synthetic';
        payload: Record<string, unknown>;
      };
      if (dispatch.method === 'prompt') {
        recentKickoffTexts.record(
          sessionID,
          String(dispatch.payload.text ?? ''),
        );
        await ctx.session.prompt(dispatch.payload);
      } else {
        await ctx.session.synthetic(dispatch.payload);
      }
    };

    // Bridge 3: Register goal tools with v2 schema and codemode options.
    const z = await loadZodV2();
    if (
      typeof ctx.tool?.transform === 'function' &&
      hooks.tool &&
      typeof hooks.tool === 'object'
    ) {
      await registerV2GoalTools({
        toolTransform: ctx.tool.transform,
        tools: hooks.tool as Record<string, unknown>,
        z,
        drainTuiEvents: sid => tuiTransport.drain(sid),
        encodeMetadata: events =>
          encodeGoalToolMetadata(
            events as Parameters<typeof encodeGoalToolMetadata>[0],
          ),
        shapeResult: shapeToolResult,
        disposers,
      });
    }

    // Bridge 4: Register native `/goal` command on add-only CommandEditor hosts (overriding
    // built-in `opencode.goal`, while letting post-plugin `commands.goal` config take precedence
    // when configured), or fall back to template rewriting on older `update`-only hosts.
    const commandName =
      (typeof pluginOptions.commandName === 'string' &&
        pluginOptions.commandName.trim().replace(/^\/+/, '').trim()) ||
      'goal';
    if (
      pluginOptions.registerCommand !== false &&
      typeof ctx.command?.transform === 'function'
    ) {
      try {
        const reg = await ctx.command.transform(draft => {
          if (typeof draft.add === 'function') {
            draft.add({
              name: commandName,
              description:
                'Set or manage the persistent thread goal [status|pause|resume|clear|list|history]',
              execute: async input => {
                const {sessionID, rawArgs, prompt, hasAttachments, delivery} =
                  validateV2CommandExecutionInput(input);
                if (!rawArgs && hasAttachments) {
                  throw new Error(
                    `No objective provided. Use \`/${commandName} <condition>\` to set a goal.`,
                  );
                }
                const readOnly =
                  /^(?:status|info|history|log|list|ls)\b/i.test(rawArgs) ||
                  rawArgs === '';
                assertV2AttachmentsBeforeRun({
                  rawArgs,
                  hasAttachments,
                  activeGoalStatus: goalId =>
                    hooks.runtime?.getGoalStatus?.(sessionID, goalId),
                });
                const runner = hooks.runtime?.executeSlashCommand;
                if (typeof runner !== 'function') {
                  throw new Error('Goal command runner is unavailable.');
                }
                const res = await runner(
                  {sessionID, command: commandName, arguments: rawArgs},
                  {
                    skipKickoff: true,
                    skipReplayRecord: true,
                    clearKickoffOnSkip: !readOnly,
                    preserveKickoffOnSkip: readOnly,
                  },
                );
                if (!readOnly) {
                  hooks.runtime?.clearKickoffTimer?.(sessionID);
                  hooks.runtime?.pendingKickoffDispatch?.delete(sessionID);
                }
                assertV2CommandCanDispatch({
                  sessionID,
                  rawArgs,
                  hasAttachments,
                  commandName,
                  res,
                  canDriveSession: hooks.runtime?.canDriveSession?.(sessionID),
                });
                logV2DiagnosticEvent(
                  `command.transform ${sessionID} cmd=${res.subcmd || 'status'} enteredActive=${String(res.enteredActive)}`,
                );
                const activated = res.activatedGoal ?? res.after;
                if (!res.enteredActive || !activated) return;
                const inherited = normalizeInheritedAgentForPrompt(
                  activated.executionContext?.agent,
                );
                const dispatch = buildV2CommandKickoffDispatch({
                  sessionID,
                  goalID: activated.goalId,
                  condition: activated.condition,
                  kickoffText: buildContinueMessage(activated, {}),
                  tuiMetadataKey: GOAL_TUI_METADATA_KEY,
                  prompt,
                  hasAttachments,
                  delivery,
                  resolvedAgent: inherited
                    ? stripAgentListSortPrefix(inherited)
                    : undefined,
                });
                try {
                  if (dispatch.method === 'prompt') {
                    recentKickoffTexts.record(
                      sessionID,
                      String(dispatch.payload.text ?? ''),
                    );
                    await ctx.session.prompt(dispatch.payload);
                    return;
                  }
                  await ctx.session.synthetic(dispatch.payload);
                } catch (error) {
                  // A failed admission must not leave an active goal with no way
                  // to start. Re-arm the delayed kickoff so a recovered host can
                  // retry; surface the original failure to the caller.
                  hooks.runtime?.pendingKickoffDispatch?.set(sessionID, {
                    goalId: activated.goalId,
                    runId: activated.runId,
                    dispatch,
                  });
                  hooks.runtime?.scheduleKickoff?.(
                    sessionID,
                    activated.goalId,
                    activated.runId,
                  );
                  logV2DiagnosticEvent(
                    `command.transform ${sessionID} kickoff admission failed; retry scheduled: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  throw error;
                }
                hooks.runtime?.pendingKickoffDispatch?.delete(sessionID);
              },
            });
            return;
          }
          if (typeof (draft as {update?: unknown}).update !== 'function')
            return;
          applyV2LegacyCommandUpdates(
            draft as {
              update: (
                name: string,
                edit: (command: Record<string, unknown>) => void,
              ) => void;
            },
            commandName,
            GOAL_COMMAND_TEMPLATE_PREFIX,
          );
        });
        disposers.push(() => reg.dispose());
      } catch {
        /* optional command transform on older hosts */
      }
    }

    // Bridge 5: Register `goal` and read-only `goal-verify` agents on OpenCode v2 so
    // child-session completion verification has its dedicated hidden subagent without
    // manual opencode.json agent configuration.
    if (typeof ctx.agent?.transform === 'function') {
      const configDraft: Record<string, unknown> = {};
      await hooks.config?.(configDraft);
      const goalAgentName =
        (typeof pluginOptions.goalAgentName === 'string' &&
          pluginOptions.goalAgentName.trim()) ||
        'goal';
      const verifierAgentName =
        (typeof pluginOptions.verifierAgentName === 'string' &&
          pluginOptions.verifierAgentName.trim()) ||
        'goal-verify';
      const agentReg = await ctx.agent.transform(draft =>
        applyV2AgentTransforms(
          draft,
          configDraft.agent as Record<string, NativeAgentSpec> | undefined,
          {
            goalAgentName,
            verifierAgentName,
            registerAgents: pluginOptions.registerAgents !== false,
            requireVerifierOwnership: pluginOptions.childSessionJudge !== false,
          },
        ),
      );
      disposers.push(() => agentReg.dispose());
    }
  }

  // Teardown is registered above (disposeAll) and returned after successful setup.
}

export const GoalsPluginV2 = {
  id: 'fixate-on',
  setup,
};

export default GoalsPluginV2;
