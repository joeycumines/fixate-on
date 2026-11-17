import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'bun:test';
import {waitFor} from './wait-for.ts';
import {
  createV2ClientShim,
  getV2EventSessionID,
  setup,
  shapeToolResult,
  v1PartsToV2Text,
} from '../src/plugin-v2.ts';

// v2 tool input schema contract
//
// Reproduces a real defect found by review (Rule-of-Two Run 1):
// plugin-v2.ts registered goal tools by passing the v1 `args` field map
// ({objective: z.string,...}) directly as the v2 `Tool.Info.input`. But a
// bare field map is NOT a Standard Schema — it has no top-level `~standard`
// marker — so opencode core's `inputJsonSchema` (packages/core/src/tool/
// runtime.ts:88-93) does NOT coerce it. It falls through to
// `schema as JsonSchema.JsonSchema`, emitting zod internals (_def/_parse) as
// the provider-facing JSON Schema. The model then cannot discover goal-tool
// parameters on the only deployment target (v2).
//
// Contract: every registered goal tool's `input` MUST be a real Standard Schema
// (carries the `~standard` marker that core's `isStandardSchema` checks) OR a
// valid static JSON-schema object (has `type`/`properties`). It MUST NOT be a
// bare field map of zod internals (no `_def`/`_parse` leakage).

interface RegisteredTool {
  name: string;
  input: unknown;
}

/** A minimal v2 Context whose tool.transform captures the registered inputs. */
function capturingCtx(
  tools: RegisteredTool[],
  opts?: {
    options?: Record<string, unknown>;
    location?: {directory: string; workspaceID?: string};
    events?: AsyncIterable<{
      id?: string;
      type: string;
      location?: {directory?: string; workspaceID?: string} | null;
      data?: Record<string, unknown>;
    }>;
    createdInputs?: Array<Record<string, unknown>>;
    rejectHooks?: string[];
    sessionContext?: (
      input: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
    onPrompt?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
    onSynthetic?: (
      input: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
    onRemove?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
    onUpdate?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
    onWait?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
    agentTransform?: (
      draft: unknown,
    ) =>
      Promise<{dispose: () => Promise<void>}> | {dispose: () => Promise<void>};
    onDispose?: () => void;
    onIterReturn?: () => void;
  },
): {
  ctx: Parameters<typeof setup>[0];
  captured: RegisteredTool[];
  contextHook: {current?: (input: unknown) => Promise<void> | void};
  sessionHooks: Record<string, (input: unknown) => Promise<void> | void>;
} {
  const contextHook: {current?: (input: unknown) => Promise<void> | void} = {};
  const sessionHooks: Record<string, (input: unknown) => Promise<void> | void> =
    {};
  const ctx = {
    app: {name: 'test'},
    ...(opts?.location ? {location: opts.location} : {}),
    // persistState:false avoids acquiring the persistence lease (which would
    // conflict with any live opencode process). The tool-transform contract
    // under test does not depend on persistence unless overridden via opts.options.
    options: opts?.options ?? {persistState: false},
    session: {
      prompt: async (input: Record<string, unknown>) =>
        opts?.onPrompt ? opts.onPrompt(input) : {},
      synthetic: async (input: Record<string, unknown>) =>
        opts?.onSynthetic ? opts.onSynthetic(input) : {},
      command: async () => ({}),
      create: async (input: Record<string, unknown>) => {
        opts?.createdInputs?.push(input);
        return {data: {id: 's1'}};
      },
      get: async () => ({}),
      interrupt: async () => ({}),
      generate: async () => ({}),
      ...(opts?.sessionContext ? {context: opts.sessionContext} : {}),
      ...(opts?.onRemove ? {remove: opts.onRemove} : {}),
      ...(opts?.onUpdate ? {update: opts.onUpdate} : {}),
      ...(opts?.onWait ? {wait: opts.onWait} : {}),
      hook: async (
        name: string,
        cb: (input: unknown) => Promise<void> | void,
      ) => {
        if (opts?.rejectHooks?.includes(name)) {
          throw new Error(`unsupported session hook: ${name}`);
        }
        sessionHooks[name] = cb;
        if (name === 'context') {
          contextHook.current = cb;
        }
        return {
          dispose: async () => {},
        };
      },
    },
    event: {
      // An immediately-ending async iterable unless tests provide a custom stream.
      subscribe: () =>
        opts?.events ??
        ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({done: true, value: undefined}),
            return: async () => {
              opts?.onIterReturn?.();
              return {done: true, value: undefined};
            },
          }),
        } as AsyncIterable<{
          id?: string;
          type: string;
          location?: {directory?: string; workspaceID?: string} | null;
          data?: Record<string, unknown>;
        }>),
    },
    tool: {
      transform: async (
        cb: (draft: {add: (i: RegisteredTool) => void}) => void,
      ) => {
        const draft = {
          add: (info: RegisteredTool) => {
            tools.push(info);
          },
        };
        cb(draft);
        return {
          dispose: async () => {},
        };
      },
    },
    command: {
      transform: async () => ({
        dispose: async () => {},
      }),
    },
    ...(opts?.agentTransform ? {agent: {transform: opts.agentTransform}} : {}),
  } as unknown as Parameters<typeof setup>[0];
  return {ctx, captured: tools, contextHook, sessionHooks};
}

test('v2 setup unwires live resources when a late agent transform throws', async () => {
  let iterReturned = 0;
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-unwind-'));
  try {
    const tools: RegisteredTool[] = [];
    const h = capturingCtx(tools, {
      options: {persistState: false, childSessionJudge: false},
      onIterReturn: () => {
        iterReturned++;
      },
      agentTransform: async () => {
        throw new Error('late transform failure');
      },
    });
    await expect(setup(h.ctx)).rejects.toThrow('late transform failure');
    expect(iterReturned).toBe(1);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 event session IDs accept direct and authoritative nested shapes only', () => {
  expect(getV2EventSessionID({sessionID: 'direct'})).toBe('direct');
  expect(getV2EventSessionID({properties: {sessionID: 'properties'}})).toBe(
    'properties',
  );
  expect(getV2EventSessionID({info: {sessionID: 'info'}})).toBe('info');
  expect(getV2EventSessionID({session: {sessionID: 'session'}})).toBe(
    'session',
  );
  expect(
    getV2EventSessionID({properties: {info: {sessionID: 'nested-info'}}}),
  ).toBe('nested-info');
  expect(
    getV2EventSessionID({properties: {title: '(fork #1)'}}),
  ).toBeUndefined();
  expect(getV2EventSessionID({})).toBeUndefined();
});

test('v2 parent-bound child creation delegates when supported and fails closed (cleaning up orphans) if host strips parentID', async () => {
  // Supported host: preserves parentID on returned child session.
  const supportedCalls: Array<Record<string, unknown>> = [];
  const supportedShim = createV2ClientShim(
    {
      session: {
        create: async (input: Record<string, unknown>) => {
          supportedCalls.push(input);
          return {id: 'child-1', parentID: input.parentID};
        },
        remove: async () => {
          throw new Error('should not remove valid parent-bound child');
        },
      },
    } as never,
    {bySession: new Map()},
  );
  const child = (await supportedShim.session.create!({
    parentID: 'parent',
    title: 'child',
  })) as {id?: string; parentID?: string};
  expect(child).toEqual({id: 'child-1', parentID: 'parent'});
  expect(supportedCalls).toHaveLength(1);
  expect(supportedCalls[0]?.parentID).toBe('parent');

  // Legacy host that strips parentID: clean up orphan via remove and fail closed.
  const removedIDs: string[] = [];
  const legacyShim = createV2ClientShim(
    {
      session: {
        create: async () => ({data: {id: 'orphan-1'}}),
        remove: async (input: {sessionID?: string}) => {
          if (input.sessionID) removedIDs.push(input.sessionID);
        },
      },
    } as never,
    {bySession: new Map()},
  );
  await expect(
    legacyShim.session.create!({
      parentID: 'parent',
      title: 'child',
    }),
  ).rejects.toThrow(/unsupported.*no fork performed/i);
  expect(removedIDs).toEqual(['orphan-1']);
});

test('v2 prompt fails closed when the requested agent cannot be selected', async () => {
  let promptCalls = 0;
  const shim = createV2ClientShim(
    {
      session: {
        switchAgent: async () => {
          throw new Error('Agent not found: goal-verify');
        },
        prompt: async () => {
          promptCalls++;
          return {parts: [{type: 'text', text: 'verdict'}]};
        },
      },
    } as never,
    {bySession: new Map()},
  );
  await expect(
    shim.session.prompt!({
      sessionID: 'ses-child',
      agent: 'goal-verify',
      parts: [{type: 'text', text: 'judge'}],
    }),
  ).rejects.toThrow(/agent/i);
  expect(promptCalls).toBe(0);

  // A host without switchAgent must also fail closed for an explicit agent.
  const noSwitch = createV2ClientShim(
    {
      session: {
        prompt: async () => {
          promptCalls++;
          return {parts: [{type: 'text', text: 'verdict'}]};
        },
      },
    } as never,
    {bySession: new Map()},
  );
  await expect(
    noSwitch.session.prompt!({
      sessionID: 'ses-child',
      agent: 'goal-verify',
      parts: [{type: 'text', text: 'judge'}],
    }),
  ).rejects.toThrow(/agent/i);
  expect(promptCalls).toBe(0);
});

test('v2 delete, update, and prompt wait delegate cleanly when host exposes remove/update/wait/switchAgent', async () => {
  const events: string[] = [];
  let interruptCalls = 0;
  let switchedTo: unknown;
  let updatePayload: unknown;
  let removedPayload: unknown;

  const shim = createV2ClientShim(
    {
      session: {
        interrupt: async () => {
          interruptCalls++;
        },
        remove: async (input: unknown) => {
          removedPayload = input;
        },
        update: async (input: unknown) => {
          updatePayload = input;
        },
        switchAgent: async (input: unknown) => {
          switchedTo = input;
          events.push('switchAgent');
        },
        prompt: async () => {
          events.push('prompt');
          return {
            id: 'in-1',
            sessionID: 'ses-child',
            type: 'user',
            payload: {text: 'judge'},
          };
        },
        wait: async () => {
          events.push('wait');
        },
      },
    } as never,
    {bySession: new Map()},
  );

  await shim.session.delete!({sessionID: 'ses-del'});
  expect(removedPayload).toEqual({sessionID: 'ses-del'});
  expect(interruptCalls).toBe(0);

  await shim.session.update!({
    path: {id: 'ses-upd'},
    body: {title: 'Renamed', archived: true},
  });
  expect(updatePayload).toEqual({
    sessionID: 'ses-upd',
    title: 'Renamed',
    archived: true,
  });

  await shim.session.prompt!({
    sessionID: 'ses-child',
    agent: 'goal-verify',
    parts: [{type: 'text', text: 'Judge completion'}],
  });
  expect(switchedTo).toEqual({sessionID: 'ses-child', agent: 'goal-verify'});
  expect(events).toEqual(['switchAgent', 'prompt', 'wait']);

  // Synchronous host replies carrying parts must not block on session.wait.
  events.length = 0;
  const syncShim = createV2ClientShim(
    {
      session: {
        prompt: async () => ({
          parts: [{type: 'text', text: '{"verdict":"pass"}'}],
        }),
        wait: async () => {
          events.push('unexpected-wait');
        },
      },
    } as never,
    {bySession: new Map()},
  );
  await syncShim.session.prompt!({
    sessionID: 'ses-sync',
    parts: [{type: 'text', text: 'Judge'}],
  });
  expect(events).toEqual([]);
});

// SESSION-GOAL-BINDING-1: unsupported ops must fail LOUDLY
//
// The task's acceptance requires that "unsupported APIs produce an explicit
// visible result rather than a false success". The v2 plugin Context
// (`SessionDomain` in packages/plugin/src/promise/session.ts) exposes only
// create/get/switchAgent/switchModel/prompt/generate/command/synthetic/
// interrupt/rename/move/wait/context. There is no delete and no update, and no
// fork. An adapter that returned `{}` for those would report success for an
// operation the host never performed, and a caller would then believe a child
// judge session was released (or a goal forked) when neither happened.
//
// These lock the refusal, and — the half that actually matters — that the
// underlying host op is never reached when the shim refuses.

test('v2 delete refuses loudly and never reaches the host', async () => {
  let interruptCalls = 0;
  const shim = createV2ClientShim(
    {
      session: {
        // `interrupt` is the op the shim could most plausibly confuse with a
        // destructive delete. Counting it shows the refusal is not merely a
        // relabelled interrupt.
        interrupt: async () => {
          interruptCalls++;
          return {};
        },
      },
    } as never,
    {bySession: new Map()},
  );

  await expect(shim.session.delete!({sessionID: 'ses_x'})).rejects.toThrow(
    /deletion unsupported/i,
  );
  expect(interruptCalls).toBe(0);
});

test('v2 update refuses loudly rather than reporting a no-op success', async () => {
  const shim = createV2ClientShim({session: {}} as never, {
    bySession: new Map(),
  });
  await expect(
    shim.session.update!({sessionID: 'ses_x', title: 'renamed'}),
  ).rejects.toThrow(/operation unsupported/i);
});

test('the v2 shim exposes no fork, so a fork cannot silently no-op', () => {
  // MEASURED, and recorded rather than left implicit: the v2 plugin Context
  // has no fork, even though the v2 HTTP protocol DOES
  // (`POST /api/session/:sessionID/fork`, and `Session.Info` carries
  // `fork: { sessionID, boundary }`). Because the shim does not define the op,
  // a caller reaching for `shim.session.fork` gets `undefined` and a TypeError
  // at the call site — an explicit failure, never a silent no-op. If a future
  // host exposes fork in the Context pick, this test is the signal that the
  // adapter must grow a real implementation rather than a stub.
  const shim = createV2ClientShim({session: {}} as never, {
    bySession: new Map(),
  });
  expect(shim.session.fork).toBeUndefined();
});

test('v2 goal tools register a real Standard Schema (no zod-internal leakage)', async () => {
  const tools: RegisteredTool[] = [];
  const {ctx} = capturingCtx(tools);
  const dispose = await setup(ctx);
  try {
    // The five canonical goal tools must all register.
    const names = tools.map(t => t.name);
    expect(names).toContain('create_goal');
    expect(names).toContain('update_goal');
    expect(names).toContain('focus_goal');
    expect(names).toContain('get_goal');
    expect(names).toContain('list_goals');
    // goal-command is the v2-native subcommand dispatch tunnel (the v1
    // `command.execute.before` hook is v1-only; the TUI companion drives goal
    // lifecycle through this tool). It MUST ride the same Bridge-3 tool channel.
    expect(names).toContain('goal-command');

    for (const tool of tools) {
      const input = tool.input;
      // Every input must be a non-null object.
      expect(input).toBeTruthy();
      expect(typeof input).toBe('object');

      if (input && typeof input === 'object') {
        // The defect: a bare field map of zod field schemas leaks zod internals
        // (_def, _parse) and carries NO ~standard marker. core treats it as raw
        // JSON Schema and emits garbage to the model. Reject that.
        const obj = input as Record<string, unknown>;
        const hasStandard = '~standard' in obj;
        const isStaticJsonSchema =
          obj['type'] !== undefined || obj['properties'] !== undefined;
        const leaksZodInternals =
          '_def' in obj || '_parse' in obj || '$schema' in obj;

        // HARD INVARIANT (no dead branches): the input must be a Standard Schema
        // OR a static JSON-schema object. A bare zod field map is NEITHER — that
        // is the defect. (A zod *object* schema like z.object({...}) IS a
        // Standard Schema and legitimately carries its own _def internals, but
        // those are never emitted to the provider because core consumes the
        // ~standard.jsonSchema path, not the fall-through.)
        expect(hasStandard || isStaticJsonSchema).toBe(true);

        // The defect's signature: when the input is NOT a Standard Schema (so
        // core falls through to `schema as JsonSchema.JsonSchema`) AND it leaks
        // zod internals, the model receives garbage. A real Standard Schema
        // (z.object) may carry _def internally, but that's invisible to core.
        if (!hasStandard) {
          expect(leaksZodInternals).toBe(false);
        }

        if (hasStandard) {
          // Preferred: a real Standard Schema (z.object or similar). Verify it
          // produces a valid JSON Schema via the marker core consumes.
          const marker = (
            obj as {
              '~standard': {jsonSchema?: {input?: (o: unknown) => unknown}};
            }
          )['~standard'];
          expect(marker).toBeTruthy();
          // jsonSchema.input must be callable and yield a JSON-schema object.
          if (
            marker.jsonSchema &&
            typeof marker.jsonSchema.input === 'function'
          ) {
            const js = marker.jsonSchema.input({target: 'draft-2020-12'}) as
              Record<string, unknown> | undefined;
            if (js && typeof js === 'object') {
              // A coerced schema has type:"object" with properties — not internals.
              expect(js['type']).toBe('object');
              expect(js['_def']).toBeUndefined();
            }
          }
        }
      }
    }
  } finally {
    await dispose();
  }
});

test('v2 context bridge preserves native SystemPart metadata while injecting goal text', async () => {
  const tools: RegisteredTool[] = [];
  const {ctx, contextHook} = capturingCtx(tools);
  const dispose = await setup(ctx);
  try {
    expect(contextHook.current).toBeDefined();
    const native = [
      {
        type: 'text',
        text: 'host prompt',
        cache: {ttl: 60},
        metadata: {host: 'yes'},
      },
    ];
    const input = {
      sessionID: 'system-bridge-session',
      agent: 'goal',
      model: {id: 'model', providerID: 'provider'},
      system: native as unknown[],
      messages: [],
      tools: {},
    };
    await contextHook.current!(input);
    const bridged = input.system;
    expect(bridged).toHaveLength(1);
    expect(bridged[0]).toMatchObject({
      type: 'text',
      text: 'host prompt',
      cache: {ttl: 60},
      metadata: {host: 'yes'},
    });
  } finally {
    await dispose();
  }
});

test('v2 create_goal input schema exposes `objective` as a required string parameter', async () => {
  const tools: RegisteredTool[] = [];
  const {ctx} = capturingCtx(tools);
  const dispose = await setup(ctx);
  try {
    const createGoal = tools.find(t => t.name === 'create_goal');
    expect(createGoal).toBeDefined();
    const input = createGoal!.input as Record<string, unknown>;
    // Must be a Standard Schema (the fix); a bare field map would fail here.
    expect('~standard' in input).toBe(true);
    const js = (
      input as {
        '~standard': {
          jsonSchema: {input: (o: unknown) => Record<string, unknown>};
        };
      }
    )['~standard'].jsonSchema.input({target: 'draft-2020-12'});
    expect(js['type']).toBe('object');
    const props = js['properties'] as Record<string, {type: string}>;
    expect(props).toBeDefined();
    expect(props['objective']).toBeDefined();
    expect(props['objective'].type).toBe('string');
    expect(
      Array.isArray(js['required'])
        ? (js['required'] as string[]).includes('objective')
        : false,
    ).toBe(true);
  } finally {
    await dispose();
  }
});

// v2 tool Result shaping contract (task #37)
//
// Reproduces a latent defect flagged by Rule-of-Two Run-2' (#35):
// plugin-v2.ts wrapped each goal tool's return value into a v2 Tool.Result.
// For a non-string, non-object return (e.g. undefined/null/number) WITH
// buffered goal metadata, the wrapper returned `{ metadata: goalMeta }` — a
// Result with NO `content` field. opencode core's content normalization
// (packages/core/src/session/runner/publish-llm-event.ts:536-542) maps
// `content === undefined` → `[]` → `Effect.die("Tool execution has no content")`.
// Unreachable for the current 5 tools (all return strings), but a trap for any
// future tool returning a non-string non-object.
//
// Contract (shapeToolResult): EVERY Result it returns MUST have a defined
// `content` (string or non-empty Content[]) so core's normalization survives —
// even when the underlying tool returned undefined/null and there is metadata.

const META = {'fixate-on': {events: []}};

test('#37: shapeToolResult never returns a content-less Result (undefined + metadata)', () => {
  // The trap: undefined result + metadata must NOT yield {metadata} alone.
  const r = shapeToolResult(undefined, META);
  expect(r).toHaveProperty('content');
  expect((r as {content: unknown}).content).not.toBeUndefined();
  // metadata is still attached.
  expect((r as {metadata: unknown}).metadata).toEqual(META);
});

test('#37: shapeToolResult shapes every result variant with a non-undefined content', () => {
  const cases: Array<{
    result: unknown;
    goalMeta?: Record<string, unknown>;
    expectMeta?: boolean;
  }> = [
    {result: 'hello', goalMeta: META, expectMeta: true}, // string + meta
    {result: 'hello'}, // string, no meta
    {result: {content: 'obj'}, goalMeta: META, expectMeta: true}, // object + meta
    {result: {content: 'obj'}}, // object, no meta
    {result: undefined, goalMeta: META, expectMeta: true}, // THE TRAP
    {result: undefined}, // undefined, no meta
    {result: null, goalMeta: META, expectMeta: true}, // null + meta
    {result: 42, goalMeta: META, expectMeta: true}, // number + meta
  ];
  for (const {result, goalMeta, expectMeta} of cases) {
    const r = shapeToolResult(result, goalMeta) as {
      content?: unknown;
      metadata?: unknown;
    };
    // EVERY result must have a non-undefined content (core dies on content===undefined).
    expect(r.content).not.toBeUndefined();
    // core normalizes content==="" to [{type:"text",text:""}] (length 1) — survives.
    if (expectMeta) {
      expect(r.metadata).toEqual(goalMeta);
    }
  }
});

test('#37: shapeToolResult preserves a string result as Result.content', () => {
  const r = shapeToolResult('the serialized goal payload', undefined) as {
    content: unknown;
  };
  expect(r.content).toBe('the serialized goal payload');
});

// goal-command execution contract (R1-f / R2-f5)
//
// The TUI "does nothing" fix routes every palette action through the
// `goal-command` tool (synthetic steer → agent → tool). The schema tests above
// only show the tool is REGISTERED with a valid schema. This test drives the
// registered tool's Execute against the real runtime to show the forward path
// actually reaches handleCommand and creates a goal — so a mis-forwarded
// subcommand (wrong key, skipped execute) can no longer pass the suite while
// the palette silently does nothing.

interface ExecutableGoalTool extends RegisteredTool {
  execute?: (input: unknown, execCtx: unknown) => Promise<unknown>;
}

test('goal-command executes a subcommand against the real runtime and creates a goal', async () => {
  const tools: RegisteredTool[] = [];
  const {ctx} = capturingCtx(tools);
  const dispose = await setup(ctx);
  try {
    const gc: ExecutableGoalTool | undefined = tools.find(
      t => t.name === 'goal-command',
    );
    expect(gc).toBeDefined();
    expect(typeof gc!.execute).toBe('function');

    const ok = (await gc!.execute!(
      {subcommand: 'add integration probe goal'},
      {sessionID: 'goal-command-e2e'},
    )) as {
      content?: unknown;
    };
    const content =
      typeof ok.content === 'string' ? ok.content : JSON.stringify(ok);
    // handleCommand's `add` path returns this exact creation marker — showing the
    // subcommand was forwarded (not dropped) and a goal was actually created.
    expect(content).toContain('Added and focused new goal');
    expect(content).toContain('integration probe goal');
  } finally {
    await dispose();
  }
});

test('goal-command with an empty sessionID fails loudly instead of hitting a phantom scope', async () => {
  const tools: RegisteredTool[] = [];
  const {ctx} = capturingCtx(tools);
  const dispose = await setup(ctx);
  try {
    const gc: ExecutableGoalTool | undefined = tools.find(
      t => t.name === 'goal-command',
    );
    expect(gc).toBeDefined();
    // getSessionContext("") never returns undefined, so without the explicit
    // guard an empty sessionID would silently create a goal in a phantom ""
    // scope — the palette action "does nothing" with no error. The guard must
    // return an explicit refusal instead.
    const empty = (await gc!.execute!(
      {subcommand: 'add probe goal'},
      {sessionID: ''},
    )) as {content?: unknown};
    expect(JSON.stringify(empty)).toContain('requires an active session');

    // A missing sessionID (undefined execCtx) degrades to the same explicit refusal.
    const missing = (await gc!.execute!(
      {subcommand: 'add probe goal'},
      {},
    )) as {content?: unknown};
    expect(JSON.stringify(missing)).toContain('requires an active session');
  } finally {
    await dispose();
  }
});

test('v2 context bridge injects <fixate_on> into input.system for active goals while preserving native metadata and non-text parts', async () => {
  const tools: RegisteredTool[] = [];
  const {ctx, contextHook} = capturingCtx(tools);
  const dispose = await setup(ctx);
  try {
    const createGoal = tools.find(t => t.name === 'create_goal') as
      ExecutableGoalTool | undefined;
    expect(createGoal?.execute).toBeDefined();
    await createGoal!.execute!(
      {objective: 'Write alpha.txt and check output'},
      {sessionID: 'sys-active-s1'},
    );

    const input = {
      sessionID: 'sys-active-s1',
      agent: 'build',
      model: {id: 'm1', providerID: 'p1'},
      system: [
        {
          type: 'text',
          text: 'host base prompt',
          cache: {ttl: 60},
          metadata: {host: 'yes'},
        },
        {type: 'effort', effort: 'high'},
      ] as unknown[],
      messages: [],
      tools: {},
    };

    await contextHook.current!(input);
    expect(input.system).toHaveLength(3);
    expect(input.system[0]).toMatchObject({
      type: 'text',
    });
    const injectedText = (input.system[0] as {text?: string}).text ?? '';
    expect(injectedText).toContain('<fixate_on');
    expect(injectedText).toContain('<goal_objective>');
    expect(injectedText).toContain('Write alpha.txt and check output');
    expect(input.system[1]).toMatchObject({
      type: 'text',
      text: 'host base prompt',
      cache: {ttl: 60},
      metadata: {host: 'yes'},
    });
    expect(input.system[2]).toEqual({type: 'effort', effort: 'high'});

    // Re-running context hook must not duplicate <fixate_on> or drop non-text parts.
    await contextHook.current!(input);
    expect(input.system).toHaveLength(3);
    expect(input.system[2]).toEqual({type: 'effort', effort: 'high'});
  } finally {
    await dispose();
  }
});

test('v2 setup tolerates host rejecting experimental compaction hook', async () => {
  const tools: RegisteredTool[] = [];
  const {ctx, sessionHooks} = capturingCtx(tools, {
    rejectHooks: ['compaction'],
  });
  const dispose = await setup(ctx);
  try {
    expect(sessionHooks.context).toBeDefined();
    expect(sessionHooks.compaction).toBeUndefined();
    expect(tools.some(t => t.name === 'create_goal')).toBe(true);
  } finally {
    await dispose();
  }
});

test('v2 compaction hook injects active goal context into compaction input.system without duplicating retries', async () => {
  const tools: RegisteredTool[] = [];
  const {ctx, sessionHooks} = capturingCtx(tools);
  const dispose = await setup(ctx);
  try {
    expect(sessionHooks.compaction).toBeDefined();
    const goalCommand = tools.find(t => t.name === 'goal-command') as
      ExecutableGoalTool | undefined;
    await goalCommand!.execute!(
      {
        subcommand:
          'set Finish migration cleanly --constraints "Keep tests passing"',
      },
      {sessionID: 'compact-active-s1'},
    );

    const input = {
      sessionID: 'compact-active-s1',
      agent: 'compaction',
      model: {id: 'm1', providerID: 'p1'},
      system: [
        {
          type: 'text',
          text: 'Summarize conversation accurately.',
          cache: {ttl: 120},
        },
      ] as unknown[],
      messages: [{role: 'user', content: 'Summarize'}],
      tools: {},
    };

    await sessionHooks.compaction!(input);
    expect(input.system.length).toBeGreaterThanOrEqual(2);
    const allTexts = input.system.map(p => (p as {text?: string}).text ?? '');
    expect(allTexts.some(t => t.includes('<goal_context'))).toBe(true);
    expect(allTexts.some(t => t.includes('Finish migration cleanly'))).toBe(
      true,
    );
    expect(allTexts.some(t => t.includes('Keep tests passing'))).toBe(true);
    expect(input.system[0]).toMatchObject({
      type: 'text',
      text: 'Summarize conversation accurately.',
      cache: {ttl: 120},
    });

    // Repeated compaction hook invocations must not duplicate <goal_context>.
    const countBeforeRetry = input.system.length;
    await sessionHooks.compaction!(input);
    expect(input.system).toHaveLength(countBeforeRetry);
  } finally {
    await dispose();
  }
});

interface TestV2Event {
  id?: string;
  type: string;
  location?: {directory?: string; workspaceID?: string} | null;
  data?: Record<string, unknown>;
}

function createEventQueue(): {
  stream: AsyncIterable<TestV2Event>;
  push: (ev: TestV2Event) => void;
  close: () => void;
  /** True once the plugin's subscription loop has consumed every pushed event and
   * parked on `next()` — which it can only do after awaiting the handler for the
   * last delivered event. That makes "the event has been handled" observable
   * without a timer: the loop calls `next()` only after its body returns. */
  drained: () => boolean;
} {
  const buffered: TestV2Event[] = [];
  const waiters: Array<(res: IteratorResult<TestV2Event>) => void> = [];
  let closed = false;
  let parked = 0;
  return {
    push(ev: TestV2Event) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        parked -= 1;
        waiter({done: false, value: ev});
      } else {
        buffered.push(ev);
      }
    },
    close() {
      closed = true;
      while (waiters.length > 0) {
        parked -= 1;
        waiters.shift()!({done: true, value: undefined});
      }
    },
    drained: () => buffered.length === 0 && parked > 0,
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (buffered.length > 0) {
              return Promise.resolve({done: false, value: buffered.shift()!});
            }
            if (closed) {
              return Promise.resolve({done: true, value: undefined});
            }
            return new Promise<IteratorResult<TestV2Event>>(resolve => {
              parked += 1;
              waiters.push(resolve);
            });
          },
        };
      },
    },
  };
}

test('v2 adapter uses ctx.location.directory, forwards it on unparented create, ignores foreign-location events, and canonicalizes symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-loc-'));
  const wsA = join(root, 'ws-a');
  const wsB = join(root, 'ws-b');
  mkdirSync(wsA, {recursive: true});
  mkdirSync(wsB, {recursive: true});
  const wsALink = join(root, 'ws-a-link');
  symlinkSync(wsA, wsALink);

  const createdInputs: Array<Record<string, unknown>> = [];
  const queue = createEventQueue();
  const tools: RegisteredTool[] = [];
  const {ctx} = capturingCtx(tools, {
    options: {logLevel: 'error'},
    location: {directory: wsA},
    createdInputs,
    events: queue.stream,
  });

  const dispose = await setup(ctx);
  try {
    const createGoal = tools.find(t => t.name === 'create_goal') as
      ExecutableGoalTool | undefined;
    const getGoal = tools.find(t => t.name === 'get_goal') as
      ExecutableGoalTool | undefined;
    await createGoal!.execute!(
      {objective: 'Stay in workspace A'},
      {sessionID: 'loc-s1'},
    );

    // Emit foreign-location event AFTER the goal exists in active state.
    queue.push({
      type: 'session.error',
      location: {directory: wsB},
      data: {sessionID: 'loc-s1'},
    });
    await waitFor(
      () => queue.drained(),
      'the foreign-location session.error to be consumed',
    );

    // State must persist under ctx.location.directory (wsA), not process.cwd().
    const expectedStatePath = join(
      wsA,
      '.opencode',
      'goals',
      'sessions',
      'loc-s1',
      'state.json',
    );
    expect(existsSync(expectedStatePath)).toBe(true);

    // Foreign-location session.error for wsB must not settle/pause wsA's goal.
    const stateAfterForeign = (await getGoal!.execute!(
      {},
      {sessionID: 'loc-s1'},
    )) as {content?: string};
    const parsedForeign = JSON.parse(stateAfterForeign.content ?? '{}') as {
      goal?: {status?: string};
    };
    expect(parsedForeign.goal?.status).toBe('active');

    // Same workspace via symlink alias MUST match and settle/pause the goal.
    queue.push({
      type: 'session.error',
      location: {directory: wsALink},
      data: {sessionID: 'loc-s1'},
    });
    await waitFor(
      () => queue.drained(),
      'the symlink-alias session.error to be consumed',
    );

    const stateAfterLocal = (await getGoal!.execute!(
      {},
      {sessionID: 'loc-s1'},
    )) as {content?: string};
    const parsedLocal = JSON.parse(stateAfterLocal.content ?? '{}') as {
      goal?: {status?: string};
    };
    expect(parsedLocal.goal?.status).toBe('paused');

    // Unparented session.create forwards location from ctx.location, while
    // preserving an explicit caller-provided location.
    const shim = createV2ClientShim(ctx, {bySession: new Map()});
    await shim.session.create!({title: 'top-level'});
    await shim.session.create!({
      title: 'explicit',
      location: {directory: wsB},
    });
    expect(createdInputs).toHaveLength(2);
    expect(createdInputs[0]?.location).toEqual({directory: wsA});
    expect(createdInputs[1]?.location).toEqual({directory: wsB});
  } finally {
    queue.close();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 pluginOptions.workspaceDirectory overrides ctx.location.directory for persistence and location filtering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-override-'));
  const overrideWs = join(root, 'override-ws');
  const ctxWs = join(root, 'ctx-ws');
  mkdirSync(overrideWs, {recursive: true});
  mkdirSync(ctxWs, {recursive: true});

  const queue = createEventQueue();
  const tools: RegisteredTool[] = [];
  const {ctx} = capturingCtx(tools, {
    options: {logLevel: 'error', workspaceDirectory: overrideWs},
    location: {directory: ctxWs},
    events: queue.stream,
  });

  const dispose = await setup(ctx);
  try {
    const createGoal = tools.find(t => t.name === 'create_goal') as
      ExecutableGoalTool | undefined;
    const getGoal = tools.find(t => t.name === 'get_goal') as
      ExecutableGoalTool | undefined;
    await createGoal!.execute!(
      {objective: 'Use workspaceDirectory override'},
      {sessionID: 'override-s1'},
    );

    expect(
      existsSync(
        join(
          overrideWs,
          '.opencode',
          'goals',
          'sessions',
          'override-s1',
          'state.json',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ctxWs,
          '.opencode',
          'goals',
          'sessions',
          'override-s1',
          'state.json',
        ),
      ),
    ).toBe(false);

    // Event from ctxWs (different from workspaceDirectory) is ignored.
    queue.push({
      type: 'session.error',
      location: {directory: ctxWs},
      data: {sessionID: 'override-s1'},
    });
    await waitFor(
      () => queue.drained(),
      'the foreign-workspace session.error to be consumed',
    );

    const state = (await getGoal!.execute!({}, {sessionID: 'override-s1'})) as {
      content?: string;
    };
    const parsed = JSON.parse(state.content ?? '{}') as {
      goal?: {status?: string};
    };
    expect(parsed.goal?.status).toBe('active');
  } finally {
    queue.close();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 shim messages() normalizes ctx.session.context Session.Message.Info[] and buffered ModelMessage fallback', async () => {
  const {
    findLatestAssistantMessage,
    getTextFromParts,
    messageHasToolCall,
    messageIsSettled,
  } = await import('../src/message-helpers.ts');
  const {normalizeMessageUsage} = await import('../src/accounting.ts');

  const sessionContextMessages = [
    {
      id: 'msg_1',
      type: 'user',
      text: 'Fix the tests',
      agent: 'build',
      time: {created: 1000},
    },
    {
      id: 'msg_2',
      type: 'assistant',
      agent: 'build',
      model: {id: 'claude-sonnet-4', providerID: 'anthropic'},
      finish: 'tool-calls',
      cost: 0.015,
      tokens: {
        input: 300,
        output: 80,
        reasoning: 12,
        cache: {read: 20, write: 10},
      },
      content: [
        {type: 'text', text: 'Running bun test now.'},
        {
          type: 'tool',
          id: 'tc_1',
          name: 'bash',
          state: {status: 'completed', input: {command: 'bun test'}},
        },
      ],
      time: {created: 1100, completed: 1200},
    },
    {
      id: 'msg_3',
      type: 'synthetic',
      text: 'Continue working on goal',
      metadata: {source: 'goal'},
      time: {created: 1300},
    },
  ];

  const shim = createV2ClientShim(
    {
      session: {
        context: async () => sessionContextMessages,
      },
    } as never,
    {bySession: new Map()},
  );

  const normalized = (await shim.session.messages!({
    sessionID: 'ctx-msg-s1',
  })) as Array<{
    info?: Record<string, unknown>;
    parts?: Array<Record<string, unknown>>;
  }>;
  expect(normalized).toHaveLength(3);

  const latest = findLatestAssistantMessage(normalized);
  expect(latest).toBeTruthy();
  expect(getTextFromParts((latest as {parts?: unknown[]}).parts)).toBe(
    'Running bun test now.',
  );
  expect(messageHasToolCall(latest)).toBe(true);
  expect(messageIsSettled(latest)).toBe(true);
  expect(normalizeMessageUsage(latest)).toEqual({
    input: 300,
    output: 80,
    reasoning: 12,
    cacheRead: 20,
    cacheWrite: 10,
    cost: 0.015,
    costKnown: true,
  });

  // Synthetic v2 messages must carry synthetic:true on parts so idle detection
  // never mistakes continuation steers for human intervention.
  expect(normalized[2]?.info?.role).toBe('user');
  expect(normalized[2]?.info?.synthetic).toBe(true);
  expect(normalized[2]?.parts?.[0]?.synthetic).toBe(true);
  expect(normalized[0]?.info?.synthetic).toBeUndefined();

  // Trailing limit preserves newest items.
  const limited = (await shim.session.messages!({
    sessionID: 'ctx-msg-s1',
    limit: 2,
  })) as Array<{info?: {id?: string}}>;
  expect(limited.map(m => m.info?.id)).toEqual(['msg_2', 'msg_3']);

  // Fallback to pre-turn buffered @opencode/ai ModelMessage when context() errors.
  const buffer = {
    bySession: new Map<string, unknown[]>([
      [
        'buf-s1',
        [
          {role: 'user', content: 'Hello'},
          {
            role: 'assistant',
            content: [
              {type: 'text', text: 'Checking files'},
              {
                type: 'tool-call',
                toolCallId: 't1',
                toolName: 'read',
                input: {},
              },
            ],
          },
        ],
      ],
    ]),
  };
  const fallbackShim = createV2ClientShim(
    {
      session: {
        context: async () => {
          throw new Error('session.context failed');
        },
      },
    } as never,
    buffer,
  );
  const fallbackMsgs = (await fallbackShim.session.messages!({
    sessionID: 'buf-s1',
  })) as unknown[];
  const fallbackLatest = findLatestAssistantMessage(fallbackMsgs);
  expect(getTextFromParts((fallbackLatest as {parts?: unknown[]})?.parts)).toBe(
    'Checking files',
  );
  expect(messageHasToolCall(fallbackLatest)).toBe(true);
});

test('v2 experimental.idle drives continuation synchronously, respects background jobs, dedupes trailing execution.succeeded, and falls back when unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-idle-'));
  try {
    // Part 1: Active experimental.idle continuation + background gating + dedupe + cancellable minDelayMs
    const wsA = join(root, 'ws-idle');
    mkdirSync(wsA, {recursive: true});
    const queue = createEventQueue();
    const syntheticCalls: Array<{sessionID: string; text: string}> = [];
    const contextMessagesBySession = new Map<string, unknown[]>();
    const tools: RegisteredTool[] = [];

    const {ctx, sessionHooks} = capturingCtx(tools, {
      options: {logLevel: 'error', minDelayMs: 250},
      location: {directory: wsA},
      events: queue.stream,
      sessionContext: async (input: Record<string, unknown>) =>
        contextMessagesBySession.get(String(input.sessionID ?? '')) ?? [],
      onSynthetic: async (input: Record<string, unknown>) => {
        syntheticCalls.push({
          sessionID: String(input.sessionID ?? ''),
          text: String(input.text ?? ''),
        });
      },
    });

    const dispose = await setup(ctx);
    try {
      expect(sessionHooks['experimental.idle']).toBeDefined();
      const createGoal = tools.find(t => t.name === 'create_goal') as
        ExecutableGoalTool | undefined;
      const getGoal = tools.find(t => t.name === 'get_goal') as
        ExecutableGoalTool | undefined;
      await createGoal!.execute!(
        {objective: 'Run multi-turn v2 task until complete'},
        {sessionID: 'exp-s1'},
      );

      // Turn 1 finished with tool call and token usage; shell background job must NOT block idle.
      contextMessagesBySession.set('exp-s1', [
        {id: 'u1', type: 'user', text: 'Go', time: {created: 1000}},
        {
          id: 'a1',
          type: 'assistant',
          agent: 'build',
          finish: 'stop',
          tokens: {
            input: 200,
            output: 100,
            reasoning: 0,
            cache: {read: 0, write: 0},
          },
          content: [
            {type: 'text', text: 'Edited file A, next edit B.'},
            {
              type: 'tool',
              id: 't1',
              name: 'edit',
              state: {status: 'completed', input: {}},
            },
          ],
          time: {created: 1100, completed: 1200},
        },
      ]);

      await sessionHooks['experimental.idle']!({
        sessionID: 'exp-s1',
        background: [
          {kind: 'shell', sessionID: 'exp-s1', command: 'bun run dev'},
        ],
      });
      // synthetic must have been admitted BEFORE experimental.idle returned!
      expect(syntheticCalls).toHaveLength(1);
      expect(syntheticCalls[0]?.sessionID).toBe('exp-s1');

      const state1 = JSON.parse(
        (
          (await getGoal!.execute!({}, {sessionID: 'exp-s1'})) as {
            content: string;
          }
        ).content,
      ) as {
        goal: {status: string; tokensUsed: number};
      };
      expect(state1.goal.status).toBe('active');
      expect(state1.goal.tokensUsed).toBeGreaterThanOrEqual(300);

      const goalCommand = tools.find(t => t.name === 'goal-command') as
        ExecutableGoalTool | undefined;
      const statusOut = (await goalCommand!.execute!(
        {subcommand: 'status'},
        {sessionID: 'exp-s1'},
      )) as {content: string};
      expect(statusOut.content).toContain('1/unlimited turns');

      // Blocking subagent background job prevents continuation AND suppresses trailing execution.succeeded.
      await sessionHooks['experimental.idle']!({
        sessionID: 'exp-s1',
        background: [
          {kind: 'subagent', sessionID: 'exp-s1', childSessionID: 'sub-1'},
        ],
      });
      expect(syntheticCalls).toHaveLength(1);

      queue.push({
        type: 'session.execution.succeeded',
        location: {directory: wsA},
        data: {sessionID: 'exp-s1'},
      });
      await waitFor(
        () => queue.drained(),
        'the trailing session.execution.succeeded to be consumed',
      );
      expect(syntheticCalls).toHaveLength(1);

      // New step clears background lock and respects cancellable minDelayMs cooldown before continuing.
      queue.push({
        type: 'session.step.started',
        location: {directory: wsA},
        data: {sessionID: 'exp-s1'},
      });
      await waitFor(
        () => queue.drained(),
        'the session.step.started to be consumed',
      );

      contextMessagesBySession.set('exp-s1', [
        ...contextMessagesBySession.get('exp-s1')!,
        {
          id: 'a2',
          type: 'assistant',
          agent: 'build',
          finish: 'stop',
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache: {read: 0, write: 0},
          },
          content: [{type: 'text', text: 'Repeating idle stall.'}],
          time: {created: 2000, completed: 2100},
        },
      ]);

      // Start experimental.idle (waits minDelayMs cooldown) and verify mid-delay human stop cancels continuation.
      const delayedIdle = sessionHooks['experimental.idle']!({
        sessionID: 'exp-s1',
        background: [],
      });
      // Immediately admit an interrupting explicit-stop user message while cooldown sleeps.
      queue.push({
        type: 'session.input.admitted',
        location: {directory: wsA},
        data: {
          sessionID: 'exp-s1',
          input: {
            id: 'stop-1',
            type: 'user',
            delivery: 'steer',
            data: {text: 'stop'},
          },
        },
      });
      await delayedIdle;
      expect(syntheticCalls).toHaveLength(1);

      // Trailing session.execution.succeeded after experimental.idle must be deduplicated
      // so the explicitly paused goal is not double-evaluated.
      queue.push({
        type: 'session.execution.succeeded',
        location: {directory: wsA},
        data: {sessionID: 'exp-s1'},
      });
      await waitFor(
        () => queue.drained(),
        'the post-stop trailing session.execution.succeeded to be consumed',
      );
      expect(syntheticCalls).toHaveLength(1);
    } finally {
      queue.close();
      await dispose();
    }

    // Part 2: Fallback when experimental.idle is unavailable on host -> session.execution.succeeded drives continuation.
    const wsFallback = join(root, 'ws-fallback');
    mkdirSync(wsFallback, {recursive: true});
    const fbQueue = createEventQueue();
    const fbSynthetics: string[] = [];
    const fbTools: RegisteredTool[] = [];
    const {ctx: fbCtx, sessionHooks: fbHooks} = capturingCtx(fbTools, {
      options: {logLevel: 'error', minDelayMs: 0},
      location: {directory: wsFallback},
      rejectHooks: ['experimental.idle'],
      events: fbQueue.stream,
      sessionContext: async () => [
        {
          id: 'fb-a1',
          type: 'assistant',
          finish: 'stop',
          tokens: {
            input: 50,
            output: 100,
            reasoning: 0,
            cache: {read: 0, write: 0},
          },
          content: [
            {type: 'text', text: 'Completed step 1.'},
            {
              type: 'tool',
              id: 'ft1',
              name: 'edit',
              state: {status: 'completed', input: {}},
            },
          ],
          time: {created: 1000, completed: 1100},
        },
      ],
      onSynthetic: async (input: Record<string, unknown>) => {
        fbSynthetics.push(String(input.text ?? ''));
      },
    });
    const fbDispose = await setup(fbCtx);
    try {
      expect(fbHooks['experimental.idle']).toBeUndefined();
      const createGoal = fbTools.find(t => t.name === 'create_goal') as
        ExecutableGoalTool | undefined;
      await createGoal!.execute!(
        {objective: 'Fallback event continuation'},
        {sessionID: 'fb-s1'},
      );
      fbQueue.push({
        type: 'session.execution.succeeded',
        location: {directory: wsFallback},
        data: {sessionID: 'fb-s1'},
      });
      await waitFor(
        () => fbSynthetics.length === 1,
        'the fallback session.execution.succeeded to produce a continuation',
      );
      expect(fbSynthetics).toHaveLength(1);
    } finally {
      fbQueue.close();
      await fbDispose();
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('v1PartsToV2Text and createV2ClientShim accept both flat and legacy shapes', async () => {
  const flatTranslated = v1PartsToV2Text({
    sessionID: 's-flat',
    agent: 'build',
    parts: [
      {type: 'text', text: 'Continue'},
      {type: 'text', text: 'Next', metadata: {'fixate-on': {goalId: 'g1'}}},
    ],
  });
  expect(flatTranslated).toEqual({
    sessionID: 's-flat',
    text: 'Continue\n\nNext',
    metadata: {goalId: 'g1'},
    agent: 'build',
  });

  const legacyTranslated = v1PartsToV2Text({
    path: {id: 's-legacy'},
    body: {
      agent: 'verifier',
      parts: [
        {
          type: 'text',
          text: 'Check claim',
          metadata: {'fixate-on': {phase: 'verify'}},
        },
      ],
    },
  });
  expect(legacyTranslated).toEqual({
    sessionID: 's-legacy',
    text: 'Check claim',
    metadata: {phase: 'verify'},
    agent: 'verifier',
  });

  const createPayloads: Array<Record<string, unknown>> = [];
  const getPayloads: Array<Record<string, unknown>> = [];
  const shim = createV2ClientShim(
    {
      app: {},
      location: {directory: '/tmp/ws-shape'},
      options: {},
      session: {
        prompt: async () => ({}),
        synthetic: async () => ({}),
        command: async () => ({}),
        create: async input => {
          createPayloads.push(input);
          return {data: {id: 'child-1', parentID: input.parentID}};
        },
        get: async input => {
          getPayloads.push(input);
          return {id: input.sessionID};
        },
        interrupt: async () => ({}),
        generate: async () => ({}),
        hook: async () => ({dispose: async () => {}}),
      },
      event: {
        subscribe: async function* () {},
      },
      tool: {transform: async () => ({dispose: async () => {}})},
      command: {transform: async () => ({dispose: async () => {}})},
    },
    {bySession: new Map()},
  );

  await shim.session.create!({
    body: {parentID: 'parent-99', title: 'Judge Session'},
  });
  expect(createPayloads).toEqual([
    {parentID: 'parent-99', title: 'Judge Session'},
  ]);

  await shim.session.get!({path: {id: 's-legacy'}});
  expect(getPayloads).toEqual([{sessionID: 's-legacy'}]);
});

test('v2 ctx.agent.transform registers goal + read-only goal-verify agents, disposes cleanly, and fails closed on verifier collision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-agent-'));
  try {
    // 1. Default setup registers goal (primary) and goal-verify (hidden read-only subagent).
    const registeredAgents = new Map<string, Record<string, unknown>>();
    let agentDisposed = false;
    const tools: RegisteredTool[] = [];
    const {ctx} = capturingCtx(tools, {
      options: {logLevel: 'error', workspaceDirectory: root},
    });
    (ctx as unknown as Record<string, unknown>).agent = {
      transform: async (
        cb: (draft: {
          get: (id: string) => Record<string, unknown> | undefined;
          update: (
            id: string,
            edit: (entry: Record<string, unknown>) => void,
          ) => void;
        }) => void,
      ) => {
        cb({
          get: id => registeredAgents.get(id),
          update: (id, edit) => {
            const entry = registeredAgents.get(id) ?? {
              id,
              permissions: [{action: '*', resource: '*', effect: 'allow'}],
            };
            registeredAgents.set(id, entry);
            edit(entry);
          },
        });
        return {
          dispose: async () => {
            agentDisposed = true;
          },
        };
      },
    };
    const dispose = await setup(ctx);
    expect(registeredAgents.has('goal')).toBe(true);
    expect(registeredAgents.get('goal')?.mode).toBe('primary');
    expect(registeredAgents.get('goal')?.hidden).toBe(false);
    expect(registeredAgents.has('goal-verify')).toBe(true);
    const verifier = registeredAgents.get('goal-verify') as {
      mode?: string;
      hidden?: boolean;
      system?: string;
      permissions?: Array<{action: string; resource: string; effect: string}>;
    };
    expect(verifier.mode).toBe('subagent');
    expect(verifier.hidden).toBe(true);
    expect(verifier.system).toBeTruthy();
    expect(verifier.permissions?.[0]).toEqual({
      action: '*',
      resource: '*',
      effect: 'deny',
    });
    expect(
      verifier.permissions?.some(
        r => r.action === 'read' && r.resource === '*' && r.effect === 'allow',
      ),
    ).toBe(true);
    expect(
      verifier.permissions?.some(
        r => r.action === 'edit' && r.resource === '*' && r.effect === 'deny',
      ),
    ).toBe(true);
    expect(
      verifier.permissions?.some(
        r => r.action === 'update_goal' && r.effect === 'deny',
      ),
    ).toBe(true);
    await dispose();
    expect(agentDisposed).toBe(true);

    // 2. Pre-existing verifier collision refuses setup rather than reusing untrusted agent.
    const {ctx: collisionCtx} = capturingCtx([], {
      options: {logLevel: 'error', workspaceDirectory: root},
    });
    (collisionCtx as unknown as Record<string, unknown>).agent = {
      transform: async (
        cb: (draft: {
          get: (id: string) => Record<string, unknown> | undefined;
          update: (
            id: string,
            edit: (entry: Record<string, unknown>) => void,
          ) => void;
        }) => void,
      ) => {
        cb({
          get: id =>
            id === 'goal-verify'
              ? {id: 'goal-verify', mode: 'subagent'}
              : undefined,
          update: () => {},
        });
        return {dispose: async () => {}};
      },
    };
    await expect(setup(collisionCtx)).rejects.toThrow(
      /childSessionJudge cannot safely use existing agent/,
    );

    // 3. registerAgents: false skips agent creation.
    const skippedAgents = new Map<string, Record<string, unknown>>();
    const {ctx: skipCtx} = capturingCtx([], {
      options: {
        logLevel: 'error',
        workspaceDirectory: root,
        registerAgents: false,
      },
    });
    (skipCtx as unknown as Record<string, unknown>).agent = {
      transform: async (
        cb: (draft: {
          get: (id: string) => Record<string, unknown> | undefined;
          update: (
            id: string,
            edit: (entry: Record<string, unknown>) => void,
          ) => void;
        }) => void,
      ) => {
        cb({
          get: id => skippedAgents.get(id),
          update: (id, edit) => {
            const entry = skippedAgents.get(id) ?? {id, permissions: []};
            skippedAgents.set(id, entry);
            edit(entry);
          },
        });
        return {dispose: async () => {}};
      },
    };
    const skipDispose = await setup(skipCtx);
    expect(skippedAgents.has('goal')).toBe(false);
    expect(skippedAgents.has('goal-verify')).toBe(false);
    await skipDispose();

    // 4. Equal goal/verifier names are rejected, matching the v1 config-hook guard.
    const equalNameCtx = capturingCtx([], {
      options: {
        logLevel: 'error',
        workspaceDirectory: root,
        goalAgentName: 'same',
        verifierAgentName: 'same',
      },
    }).ctx;
    (equalNameCtx as unknown as Record<string, unknown>).agent = {
      transform: async (
        cb: (draft: {
          get: (id: string) => Record<string, unknown> | undefined;
          update: (
            id: string,
            edit: (entry: Record<string, unknown>) => void,
          ) => void;
        }) => void,
      ) => {
        cb({get: () => undefined, update: () => {}});
        return {dispose: async () => {}};
      },
    };
    await expect(setup(equalNameCtx)).rejects.toThrow(
      /goalAgentName and verifierAgentName must be different/,
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
