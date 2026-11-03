/**
 * plugin-v2.ts — V2 server plugin entry for fixate-on.
 *
 * Exports `{ id, setup(context) }` conforming to the v2 Promise-plugin API.
 * Acts as a wiring adapter that wraps the v2 Context into a v1-style client,
 * invokes GoalsPlugin, bridges v1 hooks to v2 domain methods, and handles cleanup.
 *
 * Dependency DAG: plugin-v2.ts -> plugin-runtime.ts (GoalsPlugin) -> hooks/loop/gate.
 */

import {GoalsPlugin, type PluginOptions} from './plugin-runtime.ts';
import type {PluginHooks} from './hooks.ts';
import {GOAL_COMMAND_TEMPLATE_PREFIX} from './native-agent-config.ts';
import {
  createBufferingTransport,
  encodeGoalToolMetadata,
  GOAL_TUI_METADATA_KEY,
} from './tui-state.ts';

// Define the minimal Context surface consumed from the unpublished v2 plugin SDK
// (@opencode-ai/plugin/promise). Unknown fields are typed as `unknown` and narrowed at call sites.

/** A v2 session operation: a method taking a flat input object. */
type V2SessionOp = (input: Record<string, unknown>) => Promise<unknown>;

interface V2SessionDomain {
  prompt: V2SessionOp;
  synthetic: V2SessionOp;
  command: V2SessionOp;
  create: V2SessionOp;
  get: V2SessionOp;
  interrupt: V2SessionOp;
  generate: V2SessionOp;
  hook: <N extends 'context'>(
    name: N,
    cb: (input: V2SessionContext) => Promise<void> | void,
  ) => Promise<{dispose: () => Promise<void>}>;
}

/** The mutable per-turn context handed to session.hook("context"). */
interface V2SessionContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: {id: string; providerID: string} | string;
  system: unknown[];
  messages: unknown[];
  tools: Record<string, unknown>;
}

interface V2ToolDraft {
  add(info: {
    name: string;
    description: string;
    input: unknown;
    output?: unknown;
    options?: {codemode?: boolean; permission?: string};
    execute: (input: unknown, ctx: unknown) => Promise<unknown> | unknown;
  }): void;
}

interface V2ToolDomain {
  transform: (
    cb: (draft: V2ToolDraft) => void,
  ) => Promise<{dispose: () => Promise<void>}>;
}

interface V2CommandDraft {
  add?: (cmd: {name: string; template?: string; description?: string}) => void;

  list(): ReadonlyArray<{name: string}>;

  update(
    name: string,
    update: (cmd: {
      name: string;
      template?: string;
      description?: string;
      agent?: string;
    }) => void,
  ): void;
}

interface V2CommandDomain {
  transform: (
    cb: (draft: V2CommandDraft) => void,
  ) => Promise<{dispose: () => Promise<void>}>;
}

interface V2EventDomain {
  subscribe: () => AsyncIterable<{
    id?: string;
    type: string;
    data?: Record<string, unknown>;
  }>;
}

interface V2App {
  readonly name?: string;
  readonly version?: string;
  readonly channel?: string;
}

interface V2Context {
  readonly app: V2App;
  readonly options: Readonly<Record<string, unknown>>;
  readonly session: V2SessionDomain;
  readonly event: V2EventDomain;
  readonly tool: V2ToolDomain;
  readonly command: V2CommandDomain;
}

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

/**
 * In-memory message cache per session, populated by `session.hook("context")`.
 * Used because the v2 Context lacks a `message` domain or `message.list` API.
 */
interface MessageBuffer {
  readonly bySession: Map<string, unknown[]>;
}

/**
 * Translates v1 `{ parts: [...] }` inputs to v2 prompt formats (`{ sessionID, text, metadata? }`).
 *
 * Joins text parts with newlines and hoists `metadata["fixate-on"]` to message-level
 * metadata so it propagates across tool events and stream listeners.
 */
export function v1PartsToV2Text(input: Record<string, unknown>): {
  sessionID?: string;
  text: string;
  metadata?: Record<string, unknown>;
  agent?: string;
} {
  const sessionID =
    typeof input.sessionID === 'string' ? input.sessionID : undefined;
  const agent =
    typeof (input as {agent?: unknown}).agent === 'string'
      ? (
          input as {
            agent: string;
          }
        ).agent
      : undefined;
  const parts = Array.isArray(input.parts) ? input.parts : [];
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
 * Feeds a v2 `session.input.admitted` event into the v1 `chat.message` steering hook.
 *
 * Preserves steering guards (slash commands, mode headers, stop-intent detection)
 * during ongoing execution turns on hosts that do not fire `chat.message`.
 */
export async function synthesizeChatMessageFromAdmitted(
  chatMessageHook: PluginHooks['chat.message'] | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  if (typeof chatMessageHook !== 'function') return;
  const sessionID = getV2EventSessionID(data);
  if (!sessionID) return;
  const pendingInput = data.input as
    | {
        type?: string;
        data?: {text?: unknown; metadata?: Record<string, unknown>};
      }
    | undefined;
  const pendingType = pendingInput?.type;
  const pendingData = pendingInput?.data;
  const text = typeof pendingData?.text === 'string' ? pendingData.text : '';
  if (!pendingData || !text) return;
  await chatMessageHook(
    {sessionID},
    {
      parts: [
        {
          type: 'text',
          text,
          synthetic: pendingType === 'synthetic' ? true : undefined,
          metadata: pendingData.metadata,
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

  // Regular prompt used for genuine turns, such as child session verifiers.
  const prompt: V2SessionOp = async input => {
    const translated = v1PartsToV2Text(input);
    return session.prompt({
      sessionID: translated.sessionID ?? '',
      text: translated.text,
      ...(translated.metadata ? {metadata: translated.metadata} : {}),
      ...(translated.agent ? {agent: translated.agent} : {}),
    });
  };

  const abort: V2SessionOp = async input => {
    const sessionID = (input as {sessionID?: string})?.sessionID;
    if (!sessionID) return {};
    return session.interrupt({sessionID});
  };

  const create: V2SessionOp = async input => {
    // The v2 host strips parentID during session creation. Fail fast rather than
    // silently creating an unparented session that callers assume is a fork.
    if (typeof input.parentID === 'string' && input.parentID.length > 0) {
      throw new Error(
        'parent-bound session creation unsupported by v2 host; no fork performed',
      );
    }
    return session.create({...input});
  };

  const get: V2SessionOp = async input => session.get({...input});

  // Destructive deletion is not exposed in the v2 pick; throw rather than aliasing interrupt.
  const remove: V2SessionOp = async () => {
    throw new Error('session deletion unsupported by v2 host');
  };

  const unsupported: V2SessionOp = async () => {
    throw new Error('session operation unsupported by v2 adapter');
  };

  const messages: V2SessionOp = async input => {
    const sessionID = (input as {sessionID?: string})?.sessionID;
    const limit = (input as {limit?: number})?.limit;
    if (!sessionID) return [];
    const all = buffer.bySession.get(sessionID) ?? [];
    const start =
      typeof limit === 'number' && limit > 0
        ? Math.max(0, all.length - limit)
        : 0;
    return all.slice(start);
  };

  return {
    session: {
      promptAsync,
      prompt,
      abort,
      create,
      get,
      delete: remove,
      update: unsupported,
      messages,
    },
  };
}

const MESSAGE_BUFFER_CAP = 100;

type ZodModule = typeof import('zod');

async function logToolRegistrationFailure(
  stage: string,
  error: unknown,
): Promise<void> {
  const eventLogPath = process.env.FIXATE_ON_EVENT_LOG;
  if (!eventLogPath) return;
  try {
    const {appendFileSync} = await import('node:fs');
    appendFileSync(
      eventLogPath,
      `${Date.now()} tool-registration-${stage} ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
    );
  } catch {
    /* diagnostics must never throw */
  }
}

async function loadZodV2(): Promise<ZodModule | null> {
  try {
    return await import('zod');
  } catch {
    return null;
  }
}

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

/**
 * Builds a v2 `Tool.Info.input` ValueSchema from a v1 Zod field map.
 *
 * Core checks for Standard Schema (`"~standard" in schema`) when generating JSON
 * Schema for models. Wrapping raw Zod field maps in `z.object(...)` prevents core
 * from exposing raw Zod internals (`_def`, `_parse`) to the model.
 */
function buildToolInputSchema(
  z: ZodModule | null,
  args: Record<string, unknown> | undefined,
): unknown {
  const hasFieldMap =
    args && typeof args === 'object' && Object.keys(args).length > 0;
  if (z && hasFieldMap) {
    return z.object(args);
  }
  if (z) {
    return z.object({});
  }
  return {type: 'object', properties: {}};
}

export async function setup(ctx: V2Context): Promise<() => Promise<void>> {
  // Bridge TUI sync over tool execution results. Since v2 lacks a direct server-to-TUI
  // push channel, buffered state events are drained into Result.metadata, which
  // core broadcasts over `session.tool.success`.
  const tuiTransport = createBufferingTransport();
  const pluginOptions: PluginOptions = {
    ...(ctx.options as PluginOptions),
    tuiTransport: tuiTransport.publish,
  };

  const buffer: MessageBuffer = {bySession: new Map()};
  const recordMessages = (sessionID: string, messages: unknown[]): void => {
    if (!sessionID || !Array.isArray(messages)) return;
    // Replace rather than concatenate to prevent unbounded memory growth and duplicate history.
    const next = messages.slice(-MESSAGE_BUFFER_CAP);
    buffer.bySession.set(sessionID, next);
  };

  // Fall back to cwd only if workspaceDirectory is omitted. The v2 plugin Context
  // omits the host workspace directory, so using cwd directly when running from source
  // risks targeting the repository checkout instead of the campaign directory.
  const client = createV2ClientShim(ctx, buffer);
  const directory =
    (typeof pluginOptions.workspaceDirectory === 'string' &&
      pluginOptions.workspaceDirectory.trim()) ||
    (typeof process.cwd === 'function' ? process.cwd() : undefined);
  const v1Result = await GoalsPlugin({client, directory}, pluginOptions);
  const hooks = v1Result as PluginHooks & {
    tool?: Record<string, unknown>;
    dispose?: () => Promise<void>;
  };

  const disposers: Array<() => Promise<void> | void> = [];

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

        // Apply system transformations through v1 hooks and reconstruct structured SystemPart objects.
        try {
          const nativeSystem = Array.isArray(input.system)
            ? input.system.slice()
            : [];
          const v1System = nativeSystem.map(part => {
            if (typeof part === 'string') return part;
            if (
              part &&
              typeof part === 'object' &&
              typeof (part as {text?: unknown}).text === 'string'
            ) {
              return (part as {text: string}).text;
            }
            return '';
          });
          await hooks['experimental.chat.system.transform']?.(
            {sessionID},
            {system: v1System},
          );
          if (v1System.length > nativeSystem.length) {
            const injected = v1System
              .slice(0, v1System.length - nativeSystem.length)
              .filter(text => text.length > 0);
            input.system = [
              ...injected.map(text => ({type: 'text', text})),
              ...nativeSystem,
            ];
          } else if (v1System.length !== nativeSystem.length) {
            input.system = v1System.map(text => ({type: 'text', text}));
          } else {
            input.system = nativeSystem;
          }
        } catch {
          /* best-effort system prompt injection */
        }
      });
      disposers.push(() => reg.dispose());
    } catch {
      /* context hook unavailable; fallback to event subscription */
    }
  }

  // Bridge 2: Subscribe to v2 event streams and map to v1 event handlers.
  let stopEventLoop = false;
  let stopEventLoopResolve: (() => void) | undefined;
  const stopEventLoopSignal = new Promise<void>(resolve => {
    stopEventLoopResolve = resolve;
  });
  let eventIterator:
    | AsyncIterator<{id?: string; type: string; data?: Record<string, unknown>}>
    | undefined;
  const eventLoop = (async () => {
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
                data?: Record<string, unknown>;
              }>,
          ),
        ]);
        if (result.done) break;
        const ev = result.value;
        if (!ev || typeof ev.type !== 'string') continue;
        const data = ev.data ?? {};
        const sessionID = getV2EventSessionID(data);
        if (eventLogPath) {
          try {
            const {appendFileSync} = await import('node:fs');
            const msgID = (data?.info as {id?: unknown} | undefined)?.id ?? '';
            appendFileSync(
              eventLogPath,
              `${Date.now()} ${ev.type} ${sessionID ?? ''} ${String(msgID)}\n`,
            );
          } catch {
            /* diagnostics must never break the loop */
          }
        }

        // v2 hosts do not trigger the v1 `chat.message` hook. Synthesize the hook call
        // from `session.input.admitted` so user steering commands (e.g. pause/stop) are respected.
        if (ev.type === 'session.input.admitted' && sessionID) {
          try {
            await synthesizeChatMessageFromAdmitted(
              hooks['chat.message'],
              data,
            );
          } catch {
            /* steering failures must not break the event loop */
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

  // Bridge 3: Register goal tools with v2 schema and codemode options.
  const z = await loadZodV2();
  if (
    typeof ctx.tool?.transform === 'function' &&
    hooks.tool &&
    typeof hooks.tool === 'object'
  ) {
    const registeredNames = new Set<string>();
    const registerTools = async (): Promise<void> => {
      const attemptNames = new Set<string>();
      const reg = await ctx.tool.transform(draft => {
        for (const [name, def] of Object.entries(
          hooks.tool as Record<string, unknown>,
        )) {
          if (!def || typeof def !== 'object') continue;
          if (registeredNames.has(name)) continue;
          const tool = def as {
            description?: string;
            args?: Record<string, unknown>;
            execute?: (
              args: Record<string, unknown>,
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
              input: buildToolInputSchema(z, tool.args),
              // Mark tools codemode:false so agents can execute them directly rather
              // than through the CodeMode wrapper.
              options: {codemode: false},
              execute: async (input: unknown, execCtx: unknown) => {
                const sid =
                  (execCtx as {sessionID?: string} | null)?.sessionID ?? '';
                const result = await tool.execute!(
                  (input ?? {}) as Record<string, unknown>,
                  {sessionID: sid},
                );
                const events = sid ? tuiTransport.drain(sid) : [];
                const goalMeta = encodeGoalToolMetadata(events);
                return shapeToolResult(result, goalMeta);
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
      disposers.push(() => reg.dispose());
      for (const name of attemptNames) registeredNames.add(name);
    };

    try {
      await registerTools();
    } catch (error) {
      console.error(
        '[fixate-on] tool registration failed (attempt 1):',
        error instanceof Error ? error.message : error,
      );
      await logToolRegistrationFailure('attempt-1', error);
      try {
        await registerTools();
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

  // Bridge 4: Route generated `/goal` command templates through deterministic goal tools.
  if (typeof ctx.command?.transform === 'function') {
    try {
      const reg = await ctx.command.transform(draft => {
        // Skip silently if the host uses an add-only CommandEditor without an update API.
        if (typeof (draft as {update?: unknown}).update !== 'function') return;
        const commandNames = [
          'goal',
          'goal status',
          'goal history',
          'goal pause',
          'goal resume',
          'goal clear',
          'goal list',
          'goal focus',
          'goal edit',
          'goal checkpoint',
          'goal add',
          'goal sequence',
        ];
        for (const name of commandNames) {
          (
            draft as {
              update: (
                name: string,
                edit: (command: Record<string, unknown>) => void,
              ) => void;
            }
          ).update(name, command => {
            const argument =
              name === 'goal'
                ? '$ARGUMENTS'
                : `${name.slice(5)} $ARGUMENTS`.trim();
            command.template =
              `${GOAL_COMMAND_TEMPLATE_PREFIX} ${argument}\n` +
              'Do not summarize, do not ask for confirmation, and do not perform any other work. Reply with only the tool output.';
            delete command.agent;
          });
        }
      });
      disposers.push(() => reg.dispose());
    } catch {
      /* optional command transform on older hosts */
    }
  }

  // Teardown: stop event loop, deregister v2 extensions, then run v1 disposal (draining WAL and releasing leases).
  return async () => {
    stopEventLoop = true;
    stopEventLoopResolve?.();
    try {
      await eventIterator?.return?.();
    } catch {
      /* best-effort iterator shutdown */
    }
    try {
      tuiTransport.clear();
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
}

export const GoalsPluginV2 = {
  id: 'fixate-on',
  setup,
};

export default GoalsPluginV2;
