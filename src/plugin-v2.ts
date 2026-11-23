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
  type V2Context,
  type V2SessionOp,
  appendUniqueCompactionSystemParts,
  blockingBackgroundJobKeys,
  canonicalPath,
  extractSystemPartText,
  extractV2CreatePayload,
  extractV2SessionIDArg,
  extractV2UpdatePatch,
  hasAssistantReplyContent,
  latestTurnSignatureFromMessages,
  loadZodV2,
  MAX_BACKGROUND_WAIT_MS,
  nextDeferralOnBlockedIdle,
  normalizeV2Messages,
  reconcileSystemParts,
  unwrapV2Data,
} from './plugin-v2-helpers.ts';
import {
  type NativeAgentSpec,
  applyV2AgentTransforms,
  registerV2GoalTools,
} from './plugin-v2-tools-agents.ts';
import {v1PartsToV2Text} from './plugin-v2-event-leaf.ts';
import {runV2EventLoop} from './plugin-v2-event-bridge.ts';
import {registerV2GoalCommandBridge} from './plugin-v2-command-bridge.ts';
import type {SessionClientCapabilities} from './session-api.ts';
import {createGoalOutputPublisher} from './plugin-v2-command-output.ts';
import {
  type RecentKickoffTextTracker,
  createRecentKickoffTextTracker,
  dispatchV2Kickoff,
  markRecentKickoffMessages,
} from './plugin-v2-command.ts';
import {GoalsPlugin, type PluginOptions} from './plugin-runtime.ts';
import type {PluginHooks} from './hooks.ts';
import {
  createBufferingTransport,
  encodeGoalToolMetadata,
  GOAL_TUI_METADATA_KEY,
} from './tui-state.ts';

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
  sessionCapabilities: SessionClientCapabilities;
} {
  const session = ctx.session;
  const selectAgent = async (
    sessionID: string,
    agent: string,
  ): Promise<void> => {
    if (typeof session.switchAgent !== 'function') {
      throw new Error(
        `cannot select agent ${JSON.stringify(agent)}: host has no switchAgent operation`,
      );
    }
    try {
      await session.switchAgent({sessionID, agent});
    } catch (error) {
      throw new Error(
        `failed to select agent ${JSON.stringify(agent)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // v1 promptAsync callers mark steers with `synthetic: true`. Route to v2's
  // synthetic op to wake execution without injecting a genuine user turn.
  const promptAsync: V2SessionOp = async input => {
    const translated = v1PartsToV2Text(input);
    const asyncSessionID = translated.sessionID ?? '';
    if (translated.agent && asyncSessionID) {
      await selectAgent(asyncSessionID, translated.agent);
    }
    return session.synthetic({
      sessionID: asyncSessionID,
      text: translated.text,
      ...(translated.metadata ? {metadata: translated.metadata} : {}),
      ...(translated.agent ? {agent: translated.agent} : {}),
    });
  };

  // Regular prompt used for synchronous turns such as child-session verifiers.
  // On v2.2.7, session.prompt admits input and runs asynchronously; wait for idle
  // when no synchronous assistant reply is present. Without that barrier, a fresh
  // context read could still contain an interim verdict from an unfinished turn.
  const prompt = async (
    input: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      beforeAdmission?: () => Promise<void>;
    },
  ): Promise<unknown> => {
    options?.signal?.throwIfAborted();
    const translated = v1PartsToV2Text(input);
    const targetSessionID = translated.sessionID ?? '';
    if (translated.agent && targetSessionID) {
      await selectAgent(targetSessionID, translated.agent);
    }
    options?.signal?.throwIfAborted();
    let admissionHook: {dispose: () => Promise<void>} | undefined;
    let admissionChecked = false;
    let res: unknown;
    try {
      if (options?.beforeAdmission) {
        if (
          typeof session.hook !== 'function' ||
          typeof session.update !== 'function'
        ) {
          throw new Error(
            'Child policy refresh before prompt admission is unavailable on this host.',
          );
        }
        // OpenCode 2.2.7 applies config through later plugin transforms. Its
        // prompt hook runs after activation, before the input enters the inbox.
        // A policy read during setup or automatic recovery can be incomplete.
        admissionHook = await session.hook('prompt', async event => {
          if (event.sessionID !== targetSessionID) return;
          options.signal?.throwIfAborted();
          await options.beforeAdmission!();
          options.signal?.throwIfAborted();
          admissionChecked = true;
        });
      }
      options?.signal?.throwIfAborted();
      res = await session.prompt({
        sessionID: targetSessionID,
        text: translated.text,
        ...(translated.metadata ? {metadata: translated.metadata} : {}),
        ...(translated.agent ? {agent: translated.agent} : {}),
      });
      if (options?.beforeAdmission && !admissionChecked)
        throw new Error('Host did not run the child policy admission hook.');
    } finally {
      // Keep the hook until the actual host call settles, even if the outer
      // verifier deadline wins. A late admission must still see cancellation.
      // A dispose failure must not replace a verdict we already obtained.
      try {
        await admissionHook?.dispose();
      } catch {
        /* a late hook cleanup failure cannot invalidate a settled prompt */
      }
    }
    options?.signal?.throwIfAborted();
    if (!hasAssistantReplyContent(res)) {
      if (!targetSessionID || typeof session.wait !== 'function') {
        throw new Error(
          'Session completion wait is unavailable for asynchronous prompt admission.',
        );
      }
      const waitPromise = Promise.resolve(
        session.wait({sessionID: targetSessionID}),
      );
      if (options?.signal) {
        const signal = options.signal;
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
          }
          const onAbort = () => {
            reject(signal.reason ?? new Error('aborted'));
          };
          signal.addEventListener('abort', onAbort, {once: true});
          waitPromise.then(
            () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            err => {
              signal.removeEventListener('abort', onAbort);
              reject(err);
            },
          );
        });
      } else {
        await waitPromise;
      }
      // Admission is user input, even if a host includes text parts on it.
      // The verifier must obtain the completed assistant reply from context.
      return {};
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

  const readMessages = async (
    input: Record<string, unknown>,
    requireFresh = false,
  ): Promise<unknown[]> => {
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
        } else if (requireFresh) {
          throw new Error('Fresh session context did not contain messages.');
        }
      } catch (error) {
        if (requireFresh) throw error;
        /* fall back to pre-turn buffer if context endpoint is unavailable */
      }
    } else if (requireFresh) {
      throw new Error('Fresh session context is unavailable on this host.');
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
  const messages: V2SessionOp = input => readMessages(input);

  return {
    sessionCapabilities: {
      deleteSession: typeof session.remove === 'function',
      promptAbortSignal: true,
      promptAdmissionHook: true,
      readCumulativeUsage: sessionID => get({sessionID}),
      selectAgent,
      readFreshMessages: (sessionID, options) =>
        readMessages({sessionID, ...options}, true),
      readAgentPermissions: async agent => {
        if (typeof ctx.agent?.get !== 'function')
          throw new Error(
            'Resolved agent permission policy is unavailable on this host.',
          );
        const info = unwrapV2Data(await ctx.agent.get({agentID: agent})) as {
          id?: unknown;
          permissions?: unknown;
        } | null;
        if (info?.id !== agent || !Array.isArray(info.permissions))
          throw new Error(
            `Resolved permission policy for agent ${agent} is unavailable.`,
          );
        return info.permissions;
      },
    },
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
  const rawOptionsEarly = (ctx.options ?? {}) as PluginOptions;
  const earlyGoalName =
    (typeof rawOptionsEarly.goalAgentName === 'string' &&
      rawOptionsEarly.goalAgentName.trim()) ||
    'goal';
  const earlyVerifierName =
    (typeof rawOptionsEarly.verifierAgentName === 'string' &&
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
  const rawOptions = (ctx.options ?? {}) as PluginOptions;
  const goalOutput = createGoalOutputPublisher(rawOptions.goalMessenger);
  const pluginOptions: PluginOptions = {
    ...rawOptions,
    sdkShape: rawOptions.sdkShape ?? 'flat',
    tuiTransport: tuiTransport.publish,
    goalMessenger: goalOutput.publish,
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

  // A cleared session ID can be reused; stale idle/turn records would suppress
  // the new goal's first idle. Chain onto whatever the v1 hooks registered.
  if (hooks.runtime) {
    const previousClear = hooks.runtime.clearSessionIdleTracking;
    hooks.runtime.clearSessionIdleTracking = (sessionID: string) => {
      previousClear?.(sessionID);
      idleStateBySession.delete(sessionID);
      lastObservedTurnBySession.delete(sessionID);
    };
  }

  const disposers: Array<() => Promise<void> | void> = [goalOutput.dispose];
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
    await goalOutput.register(ctx.rpc);
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
            const deferral = nextDeferralOnBlockedIdle({
              jobKeys,
              existing: hooks.runtime?.backgroundDeferrals?.get(sessionID),
              now,
            });
            hooks.runtime?.backgroundBlockedUntil.set(
              sessionID,
              deferral.nextRecheckAt,
            );
            // Only an authoritative empty-background idle clears a deferral,
            // so any surviving record means continuous blocking even if the
            // host regenerated its job keys. Preserve the escalation clock.
            hooks.runtime?.backgroundDeferrals?.set(sessionID, deferral);
            if (
              now - deferral.since >= MAX_BACKGROUND_WAIT_MS &&
              hooks.runtime?.escalateBackgroundDeferral
            ) {
              await hooks.runtime.escalateBackgroundDeferral(sessionID);
            }
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
    eventLoop = runV2EventLoop({
      ctx,
      hooks,
      idleStateBySession,
      lastObservedTurnBySession,
      recentKickoffTexts,
      locationDirectory: resolvedDirectory,
      setEventIterator: it => {
        eventIterator = it as typeof eventIterator;
      },
      isStopped: () => stopEventLoop,
      stopSignal: stopEventLoopSignal,
      eventLogPath: process.env.FIXATE_ON_EVENT_LOG,
    });

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
      // Mirror the initial native-command dispatch: a retained payload may
      // carry the goal's resolved agent, and a retry must run under that same
      // agent rather than the host's current default. A switch failure fails
      // the retry so the bounded kickoff path retains the attachment inputs.
      await dispatchV2Kickoff({
        session: ctx.session,
        selectAgent: client.sessionCapabilities.selectAgent,
        recordKickoffText: (sid, text) => recentKickoffTexts.record(sid, text),
        sessionID,
        dispatch,
      });
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

    // Bridge 4: Register native `/goal` command on add-only CommandEditor hosts
    // (delegated to plugin-v2-command-bridge.ts to keep this module within the
    // single-concern size budget).
    await registerV2GoalCommandBridge({
      ctx,
      hooks,
      pluginOptions,
      recentKickoffTexts,
      disposers,
      publishOutput: (sessionID, text) =>
        goalOutput.publish(sessionID, text, 'command'),
      selectAgent: client.sessionCapabilities.selectAgent,
    });
    if (hooks.runtime) {
      hooks.runtime.announceKickoffFailure = goalOutput.publish;
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
            requireVerifierOwnership:
              pluginOptions.childSessionJudge !== false &&
              typeof pluginOptions.judge !== 'function',
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
