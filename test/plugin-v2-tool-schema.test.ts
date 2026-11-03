import {expect, test} from 'bun:test';
import {
  createV2ClientShim,
  getV2EventSessionID,
  setup,
  shapeToolResult,
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
function capturingCtx(tools: RegisteredTool[]): {
  ctx: Parameters<typeof setup>[0];
  captured: RegisteredTool[];
  contextHook: {current?: (input: unknown) => Promise<void> | void};
} {
  const contextHook: {current?: (input: unknown) => Promise<void> | void} = {};
  const ctx = {
    app: {name: 'test'},
    // persistState:false avoids acquiring the persistence lease (which would
    // conflict with any live opencode process). The tool-transform contract
    // under test does not depend on persistence.
    options: {persistState: false},
    session: {
      prompt: async () => ({}),
      synthetic: async () => ({}),
      command: async () => ({}),
      create: async () => ({data: {id: 's1'}}),
      get: async () => ({}),
      interrupt: async () => ({}),
      generate: async () => ({}),
      hook: async (
        _name: string,
        cb: (input: unknown) => Promise<void> | void,
      ) => {
        contextHook.current = cb;
        return {
          dispose: async () => {},
        };
      },
    },
    event: {
      // An immediately-ending async iterable so the subscribe loop exits.
      subscribe: async function* () {},
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
  } as unknown as Parameters<typeof setup>[0];
  return {ctx, captured: tools, contextHook};
}

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

test('v2 parent-bound child creation fails closed instead of creating an unbound session', async () => {
  let createCalls = 0;
  const shim = createV2ClientShim(
    {
      session: {
        create: async () => {
          createCalls++;
          return {};
        },
      },
    } as never,
    {bySession: new Map()},
  );
  await expect(
    shim.session.create!({
      parentID: 'parent',
      title: 'child',
    }),
  ).rejects.toThrow(/unsupported.*no fork performed/i);
  expect(createCalls).toBe(0);
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
