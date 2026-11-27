import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {GoalsPlugin} from '../../src/plugin-runtime.ts';
import {registerV2GoalCommandBridge} from '../../src/plugin-v2-command-bridge.ts';
import {createRecentKickoffTextTracker} from '../../src/plugin-v2-command.ts';
import {registerV2KickoffAdmission} from '../../src/plugin-v2-kickoff-admission.ts';
import type {PluginHooks} from '../../src/hooks.ts';
import type {RuntimeState} from '../../src/session-runtime.ts';
import type {
  V2CommandDraft,
  V2Context,
  V2SessionContext,
  V2SessionDomain,
} from '../../src/plugin-v2-helpers.ts';

type Hooks = PluginHooks & {runtime: RuntimeState; dispose(): Promise<void>};
type NativeCommand = NonNullable<
  Parameters<NonNullable<V2CommandDraft['add']>>[0]['execute']
>;
export type RawMessage = {
  id: string;
  type: string;
  text: string;
  status?: string;
  metadata?: Record<string, unknown>;
};
type HookInput = V2SessionContext & {messageID: string; result?: string};

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

export const attachment = {
  uri: 'data:text/plain;base64,cmVxdWlyZWQgaW5wdXQ=',
  name: 'required.txt',
};

export async function createNativeKickoffFixture(
  directory: string,
  history = new Map<string, RawMessage[]>(),
  options: {
    persistState?: boolean;
    maxPromptFailures?: number;
    rejectHooks?: string[];
    omitHistory?: boolean;
  } = {},
) {
  const stateRoot = join(directory, 'state');
  const hooks = (await GoalsPlugin(
    {
      directory,
      client: {
        session: {
          messages: async () => [],
          promptAsync: async () => ({}),
          abort: async () => ({}),
        },
      },
    },
    {
      stateRoot,
      persistState: options.persistState ?? true,
      idlePoller: false,
      childSessionJudge: false,
      registerAgents: false,
      minDelayMs: 0,
      kickoffDelayMs: 500000,
      maxPromptFailures: options.maxPromptFailures,
      goalMessenger: async () => {},
    },
  )) as Hooks;
  const callbacks = new Map<
    string,
    Array<(input: HookInput) => Promise<void> | void>
  >();
  const forks = new Map<string, string>();
  let calls = 0;
  let beforePromptHook: () => Promise<void> = async () => {};
  let afterPromptHook: () => Promise<void> = async () => {};
  let onAdmitted: () => void = () => {};
  const host = {
    hook: async (
      name: string,
      callback: (input: HookInput) => Promise<void> | void,
    ) => {
      if (options.rejectHooks?.includes(name))
        throw new Error(`unsupported ${name}`);
      const list = callbacks.get(name) ?? [];
      callbacks.set(name, list);
      list.push(callback);
      return {
        dispose: async () => {
          list.splice(list.indexOf(callback), 1);
        },
      };
    },
    context: async ({sessionID}: {sessionID: string}) =>
      history.get(sessionID) ?? [],
    get: async ({sessionID}: {sessionID: string}) => ({
      id: sessionID,
      ...(forks.has(sessionID)
        ? {fork: {sessionID: forks.get(sessionID)}}
        : {}),
    }),
    prompt: async (payload: Record<string, unknown>) => {
      calls++;
      await beforePromptHook();
      for (const callback of callbacks.get('prompt') ?? [])
        await callback({
          sessionID: payload.sessionID,
          messageID: payload.id,
        } as HookInput);
      await afterPromptHook();
      return admit(payload, 'user');
    },
    synthetic: async (payload: Record<string, unknown>) => {
      calls++;
      await afterPromptHook();
      return admit(payload, 'synthetic');
    },
  } as unknown as V2SessionDomain;
  if (options.omitHistory) delete host.context;
  function admit(payload: Record<string, unknown>, type: string) {
    const sessionID = String(payload.sessionID);
    const rows = history.get(sessionID) ?? [];
    history.set(sessionID, rows);
    const message = {
      id: String(payload.id),
      type,
      text: String(payload.text),
      metadata: payload.metadata as Record<string, unknown>,
    };
    rows.push(message);
    onAdmitted();
    return message;
  }
  const admission = await registerV2KickoffAdmission({
    session: host,
    runtime: hooks.runtime,
  });
  let execute!: NativeCommand;
  await registerV2GoalCommandBridge({
    ctx: {
      session: host,
      command: {
        transform: async (edit: (draft: V2CommandDraft) => void) => {
          edit({
            add: entry => {
              execute = entry.execute!;
            },
          });
          return {dispose: async () => {}};
        },
      },
    } as unknown as V2Context,
    hooks,
    pluginOptions: {},
    recentKickoffTexts: createRecentKickoffTextTracker(),
    disposers: [],
    publishOutput: async () => {},
    dispatchKickoff: admission.dispatch,
  });
  return {
    hooks,
    execute,
    history,
    forks,
    get calls() {
      return calls;
    },
    set beforePromptHook(callback: () => Promise<void>) {
      beforePromptHook = callback;
    },
    set afterPromptHook(callback: () => Promise<void>) {
      afterPromptHook = callback;
    },
    set onAdmitted(callback: () => void) {
      onAdmitted = callback;
    },
    async context(
      sessionID: string,
      name: 'context' | 'compaction' | 'generate' = 'context',
      additional: unknown[] = [],
    ) {
      const input = {
        sessionID,
        messages: [
          ...(history.get(sessionID) ?? []).map(row => ({
            id: row.id,
            role: row.type === 'assistant' ? 'assistant' : 'user',
            content: [{type: 'text', text: row.text}],
          })),
          ...additional,
        ],
      } as HookInput;
      for (const callback of callbacks.get(name) ?? []) await callback(input);
      return input.messages;
    },
    async title(sessionID: string, opaqueText: string) {
      const input = {
        sessionID,
        messages: [{role: 'user', content: [{type: 'text', text: opaqueText}]}],
      } as HookInput;
      for (const callback of callbacks.get('title') ?? [])
        await callback(input);
      return input;
    },
    snapshot(sessionID: string) {
      return JSON.parse(
        readFileSync(
          join(stateRoot, 'sessions', sessionID, 'state.json'),
          'utf8',
        ),
      ) as {
        unconfirmedKickoffInputs?: Array<{sessionID: string; inputID: string}>;
        kickoffInputHistoryKnown?: boolean;
      };
    },
    async dispose() {
      await admission.dispose();
      await hooks.dispose();
    },
  };
}
