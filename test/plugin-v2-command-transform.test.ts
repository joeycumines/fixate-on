import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'bun:test';
import {setup} from '../src/plugin-v2.ts';
import {markCommandDispatch} from '../src/hooks.ts';
import {createGoalState} from '../src/state-machine.ts';
import {hydrateStoreFromDisk} from '../src/tui-disk-state.ts';
import {createTuiStateStore} from '../src/tui-state.ts';
import {waitFor} from './wait-for.ts';

interface AddCommandEntry {
  name: string;
  description?: string;
  execute?: (input: {
    sessionID: string;
    prompt?: {
      text?: unknown;
      files?: unknown[];
      agents?: unknown[];
      skills?: unknown[];
    };
    delivery?: unknown;
  }) => Promise<void> | void;
}

function createV2CommandTestCtx(opts: {
  directory: string;
  options?: Record<string, unknown>;
  mode?: 'add-only' | 'update-only';
  preRegisteredGoal?: AddCommandEntry;
  contextMessages?: () => unknown[];
}) {
  const registeredByAdd = new Map<string, AddCommandEntry>();
  if (opts.preRegisteredGoal) {
    registeredByAdd.set(opts.preRegisteredGoal.name, opts.preRegisteredGoal);
  }
  const legacyCommands = new Map<
    string,
    {name: string; template?: string; agent?: string}
  >([
    ['goal', {name: 'goal', agent: 'build'}],
    ['goal status', {name: 'goal status', agent: 'build'}],
    ['goal pause', {name: 'goal pause', agent: 'build'}],
    ['goal resume', {name: 'goal resume', agent: 'build'}],
    ['goal clear', {name: 'goal clear', agent: 'build'}],
  ]);

  const promptCalls: Array<Record<string, unknown>> = [];
  const syntheticCalls: Array<Record<string, unknown>> = [];
  const eventHandlers: Array<
    (input: {type: string; data?: Record<string, unknown>}) => void
  > = [];
  const hooksByName = new Map<
    string,
    (input: unknown) => Promise<void> | void
  >();
  const eventQueue: Array<{type: string; data?: Record<string, unknown>}> = [];
  const eventWaiters: Array<() => void> = [];
  let eventStreamClosed = false;
  let parked = 0;
  const registeredTools: Array<{
    name: string;
    execute?: (input: unknown, ctx: unknown) => Promise<unknown>;
  }> = [];

  const pushEvent = (ev: {type: string; data?: Record<string, unknown>}) => {
    eventQueue.push(ev);
    for (const h of eventHandlers) h(ev);
    while (eventWaiters.length > 0) {
      parked -= 1;
      eventWaiters.shift()!();
    }
  };
  /** True once the plugin's subscription loop has consumed every pushed event and
   * parked on the next one — it can only do that after awaiting the handler for
   * the last delivered event, so this observes "handled" without a timer. */
  const eventsDrained = () => eventQueue.length === 0 && parked > 0;

  const ctx = {
    app: {name: 'opencode', version: '2.2.7'},
    location: {directory: opts.directory},
    options: {logLevel: 'error', ...opts.options},
    session: {
      prompt: async (input: Record<string, unknown>) => {
        promptCalls.push(input);
        return {id: `prm-${promptCalls.length}`, type: 'user'};
      },
      synthetic: async (input: Record<string, unknown>) => {
        syntheticCalls.push(input);
        return {id: `syn-${syntheticCalls.length}`, type: 'synthetic'};
      },
      command: async () => ({}),
      create: async (input: Record<string, unknown>) => ({
        id: 'created-1',
        ...input,
      }),
      get: async (input: Record<string, unknown>) => ({
        id: input.sessionID,
      }),
      interrupt: async () => ({}),
      generate: async () => ({}),
      context: async () => opts.contextMessages?.() ?? [],
      hook: async (
        name: string,
        cb: (input: unknown) => Promise<void> | void,
      ) => {
        hooksByName.set(name, cb);
        return {dispose: async () => {}};
      },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              while (!eventStreamClosed) {
                if (eventQueue.length > 0) {
                  return {done: false as const, value: eventQueue.shift()!};
                }
                parked += 1;
                await new Promise<void>(resolve => eventWaiters.push(resolve));
              }
              return {done: true as const, value: undefined};
            },
            async return() {
              eventStreamClosed = true;
              while (eventWaiters.length > 0) {
                parked -= 1;
                eventWaiters.shift()!();
              }
              return {done: true as const, value: undefined};
            },
          };
        },
      }),
    },
    tool: {
      transform: async (
        cb: (draft: {
          add: (info: {
            name: string;
            execute: (input: unknown, ctx: unknown) => Promise<unknown>;
          }) => void;
        }) => void,
      ) => {
        cb({
          add(info: {
            name: string;
            execute: (input: unknown, ctx: unknown) => Promise<unknown>;
          }) {
            registeredTools.push(info);
          },
        });
        return {dispose: async () => {}};
      },
    },
    command: {
      transform: async (
        cb: (draft: {
          add?: (entry: AddCommandEntry) => void;
          list?: () => Array<{name: string; template?: string; agent?: string}>;
          update?: (
            name: string,
            edit: (cmd: {
              name: string;
              template?: string;
              agent?: string;
            }) => void,
          ) => void;
        }) => void,
      ) => {
        if (opts.mode === 'update-only') {
          cb({
            list: () => Array.from(legacyCommands.values()),
            update: (
              name: string,
              edit: (cmd: {
                name: string;
                template?: string;
                agent?: string;
              }) => void,
            ) => {
              const entry = legacyCommands.get(name);
              if (entry) edit(entry);
            },
          });
        } else {
          cb({
            add: (entry: AddCommandEntry) => {
              registeredByAdd.set(entry.name, entry);
            },
          });
        }
        return {dispose: async () => {}};
      },
    },
  };

  return {
    ctx: ctx as unknown as Parameters<typeof setup>[0],
    registeredByAdd,
    legacyCommands,
    promptCalls,
    syntheticCalls,
    registeredTools,
    hooksByName,
    pushEvent,
    eventsDrained,
    closeEvents() {
      eventStreamClosed = true;
      while (eventWaiters.length > 0) {
        parked -= 1;
        eventWaiters.shift()!();
      }
    },
  };
}

test('v2 add-only command.transform overrides opencode.goal and drives active kickoff once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-cmd-add-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});

  let builtinCalled = 0;
  const harness = createV2CommandTestCtx({
    directory: ws,
    options: {kickoffDelayMs: 15},
    preRegisteredGoal: {
      name: 'goal',
      description: 'built-in goal',
      execute: () => {
        builtinCalled++;
      },
    },
  });

  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal');
    expect(goalCmd).toBeDefined();
    expect(typeof goalCmd!.execute).toBe('function');

    // Observe the scheduling DECISION rather than sleeping past a guessed delay.
    // The v2 path runs the command with `skipKickoff` and clears any pending
    // kickoff timer, so no delayed duplicate is possible because nothing was
    // armed. A fixed sleep would only show a timer had not fired YET; this shows
    // the timer was never created. `kickoffDelayMs` is 15 here and a v1-style
    // kickoff probe would be armed at exactly that delay.
    const armedDelays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      armedDelays.push(Number(delay ?? 0));
      return realSetTimeout(fn, delay);
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle: unknown) =>
      realClearTimeout(
        handle as Parameters<typeof realClearTimeout>[0],
      )) as typeof globalThis.clearTimeout;
    try {
      await goalCmd!.execute!({
        sessionID: 's-cmd-1',
        prompt: {text: 'Fix v2 command execution'},
        delivery: 'steer',
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
    expect(armedDelays.filter(d => d >= 15)).toEqual([]);

    expect(builtinCalled).toBe(0);
    expect(harness.promptCalls).toHaveLength(0);
    // One continuation, dispatched synchronously during execute — not a second
    // one later from a kickoff timer.
    expect(harness.syntheticCalls).toHaveLength(1);
    expect(harness.syntheticCalls[0]?.sessionID).toBe('s-cmd-1');
    expect(String(harness.syntheticCalls[0]?.text)).toContain(
      'Fix v2 command execution',
    );
    expect(
      (harness.syntheticCalls[0]?.metadata as Record<string, unknown>)?.[
        'fixate-on'
      ],
    ).toBeDefined();

    // Persisted goal state reflects the active goal in `ws`.
    const store = createTuiStateStore();
    const hydrated = await hydrateStoreFromDisk(store, ws);
    expect(hydrated.hydratedCount).toBe(1);
    const snap = store.getFocused('s-cmd-1');
    expect(snap?.status).toBe('active');
    expect(snap?.condition).toBe('Fix v2 command execution');
    expect(snap?.maxTokens).toBe(0);
  } finally {
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 command.transform forwards attachments via session.prompt and supports pause/status/resume/clear without spurious turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-cmd-ops-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});

  const harness = createV2CommandTestCtx({
    directory: ws,
    options: {kickoffDelayMs: 15},
  });

  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    const fileAttachment = {path: 'spec.md', mime: 'text/markdown'};

    // Goal with file attachment routes through session.prompt preserving files.
    await goalCmd.execute!({
      sessionID: 's-cmd-2',
      prompt: {text: 'Implement @spec.md', files: [fileAttachment]},
      delivery: 'queue',
    });
    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.syntheticCalls).toHaveLength(0);
    expect(harness.promptCalls[0]?.files).toEqual([fileAttachment]);
    expect(harness.promptCalls[0]?.delivery).toBe('queue');

    // Read-only commands spawn zero LLM turns.
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'status'}});
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'list'}});
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'history'}});
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: ''}});
    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.syntheticCalls).toHaveLength(0);

    // Pause updates persisted state to paused without spawning a turn.
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'pause'}});
    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.syntheticCalls).toHaveLength(0);

    const storeAfterPause = createTuiStateStore();
    await hydrateStoreFromDisk(storeAfterPause, ws);
    expect(storeAfterPause.getFocused('s-cmd-2')?.status).toBe('paused');

    // Resume transitions back to active and triggers one synthetic kickoff.
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'resume'}});
    expect(harness.syntheticCalls).toHaveLength(1);
    expect(harness.promptCalls).toHaveLength(1);

    const storeAfterResume = createTuiStateStore();
    await hydrateStoreFromDisk(storeAfterResume, ws);
    expect(storeAfterResume.getFocused('s-cmd-2')?.status).toBe('active');

    // Clear removes the goal without spawning an LLM turn.
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'clear'}});
    expect(harness.syntheticCalls).toHaveLength(1);
    expect(harness.promptCalls).toHaveLength(1);

    const storeAfterClear = createTuiStateStore();
    await hydrateStoreFromDisk(storeAfterClear, ws);
    expect(storeAfterClear.getFocused('s-cmd-2')).toBeUndefined();
  } finally {
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 command.transform surfaces validation errors, attachment guards, fenced session refusal, and update-only fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-cmd-edge-'));
  const ws1 = join(root, 'ws1');
  const ws2 = join(root, 'ws2');
  const ws3 = join(root, 'ws3');
  const ws4 = join(root, 'ws4');
  mkdirSync(ws1, {recursive: true});
  mkdirSync(ws2, {recursive: true});
  mkdirSync(ws3, {recursive: true});
  mkdirSync(ws4, {recursive: true});

  // 1. Validation, malformed prompt, and attachment errors throw cleanly without spawning turns.
  const h1 = createV2CommandTestCtx({directory: ws1});
  const d1 = await setup(h1.ctx);
  try {
    const goalCmd = h1.registeredByAdd.get('goal')!;
    await expect(
      goalCmd.execute!({sessionID: '  ', prompt: {text: 'Test'}}),
    ).rejects.toThrow(/active session/i);
    await expect(
      goalCmd.execute!({
        sessionID: 's-err',
        prompt: {text: 'Test --token-budget nope'},
      }),
    ).rejects.toThrow(/--budget/i);
    await expect(
      goalCmd.execute!({
        sessionID: 's-err',
        prompt: 'malformed' as unknown as {text?: string},
      }),
    ).rejects.toThrow(/must be an object/i);
    await expect(
      goalCmd.execute!({
        sessionID: 's-err',
        prompt: [] as unknown as {text?: string},
      }),
    ).rejects.toThrow(/must be an object/i);
    await expect(
      goalCmd.execute!({
        sessionID: 's-err',
        prompt: {text: 'Test', files: 'bad' as unknown as unknown[]},
      }),
    ).rejects.toThrow(/must be an array/i);
    await expect(
      goalCmd.execute!({
        sessionID: 's-err',
        prompt: {text: '   ', files: [{path: 'spec.md'}]},
      }),
    ).rejects.toThrow(/No objective provided/i);
    await expect(
      goalCmd.execute!({
        sessionID: 's-err',
        prompt: {text: 'status', files: [{path: 'spec.md'}]},
      }),
    ).rejects.toThrow(/starting or resuming/i);
    expect(h1.syntheticCalls).toHaveLength(0);
    expect(h1.promptCalls).toHaveLength(0);
  } finally {
    h1.closeEvents();
    await d1();
  }

  // Calling execute after dispose rejects rather than no-oping.
  await expect(
    h1.registeredByAdd.get('goal')!.execute!({
      sessionID: 's-err',
      prompt: {text: 'After dispose'},
    }),
  ).rejects.toThrow(/unavailable/i);

  // 2. registerCommand: false leaves built-in command untouched.
  const h2 = createV2CommandTestCtx({
    directory: ws2,
    options: {registerCommand: false},
    preRegisteredGoal: {name: 'goal', description: 'builtin'},
  });
  const d2 = await setup(h2.ctx);
  try {
    expect(h2.registeredByAdd.get('goal')?.description).toBe('builtin');
  } finally {
    h2.closeEvents();
    await d2();
  }

  // 3. Fenced session (over-ceiling WAL) refuses kickoff cleanly while surfacing NOT SAVED.
  const fencedSession = 's-fenced-1';
  const fencedDir = join(ws4, '.opencode', 'goals', 'sessions', fencedSession);
  mkdirSync(fencedDir, {recursive: true});
  const seed = createGoalState(fencedSession, 'seed', {});
  const padLine = `${JSON.stringify({
    seq: 1,
    source: 'idle',
    from: 'paused',
    to: 'paused',
    detail: 'pad',
    snapshot: JSON.stringify({...seed, status: 'paused'}),
    removed: false,
  })}\n`;
  writeFileSync(
    join(fencedDir, 'state.json.ledger.jsonl'),
    padLine.repeat(Math.ceil((17 * 1024 * 1024) / padLine.length)),
  );
  const h4 = createV2CommandTestCtx({directory: ws4});
  const d4 = await setup(h4.ctx);
  try {
    const goalCmd4 = h4.registeredByAdd.get('goal')!;
    await expect(
      goalCmd4.execute!({
        sessionID: fencedSession,
        prompt: {text: 'Try driving fenced session'},
      }),
    ).rejects.toThrow(/NOT SAVED/i);
    expect(h4.promptCalls).toHaveLength(0);
    expect(h4.syntheticCalls).toHaveLength(0);
  } finally {
    h4.closeEvents();
    await d4();
  }

  // 4. Legacy update-only fallback still rewrites command templates cleanly.
  const h3 = createV2CommandTestCtx({directory: ws3, mode: 'update-only'});
  const d3 = await setup(h3.ctx);
  try {
    const updatedGoal = h3.legacyCommands.get('goal');
    expect(updatedGoal?.template).toContain('goal-command');
    expect(updatedGoal?.template).toContain('$ARGUMENTS');
    expect(updatedGoal?.agent).toBeUndefined();
    expect(h3.legacyCommands.get('goal status')?.template).toContain(
      'goal-command',
    );
    expect(h3.legacyCommands.get('goal status')?.template).toContain(
      'status $ARGUMENTS',
    );
  } finally {
    h3.closeEvents();
    await d3();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 attachment kickoff avoids false user-intervention pauses and ignores extra prompt keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-cmd-attach-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});

  let storedMessages: unknown[] = [];
  const harness = createV2CommandTestCtx({
    directory: ws,
    options: {
      minDelayMs: 0,
      noToolCallTurnsBeforePause: 5,
      noProgressTurnsBeforePause: 5,
    },
    contextMessages: () => storedMessages,
  });
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    const fileAttachment = {path: 'spec.md', mime: 'text/markdown'};
    await goalCmd.execute!({
      sessionID: 's-att-1',
      prompt: {
        text: 'Verify attachment kickoff',
        files: [fileAttachment],
        delivery: 'queue',
        staleExtra: 'must-not-leak',
      } as {text: string; files: unknown[]},
      delivery: 'steer',
    });

    expect(harness.promptCalls).toHaveLength(1);
    const dispatched = harness.promptCalls[0]!;
    expect(dispatched.files).toEqual([fileAttachment]);
    expect(dispatched.delivery).toBe('steer');
    expect(dispatched.staleExtra).toBeUndefined();

    // Even if a stripped host admits the prompt WITHOUT metadata, recentKickoffTexts
    // + msg.metadata handling prevents chat.message and experimental.idle from pausing.
    harness.pushEvent({
      type: 'session.input.admitted',
      data: {
        sessionID: 's-att-1',
        input: {
          id: 'in-1',
          type: 'prompt',
          delivery: 'steer',
          data: {text: dispatched.text},
        },
      },
    });
    await waitFor(
      () => harness.eventsDrained(),
      'the admitted input event to be consumed',
    );

    // Simulate v2 session.context returning both content-array user message (with
    // top-level metadata) AND an un-annotated message matching the kickoff prompt text.
    storedMessages = [
      {
        id: 'm-u1',
        type: 'user',
        role: 'user',
        content: [
          {type: 'text', text: dispatched.text},
          {type: 'file', path: 'spec.md'},
        ],
        metadata: dispatched.metadata,
      },
      {
        id: 'm-a1',
        type: 'assistant',
        content: [{type: 'text', text: 'Working on spec.md now.'}],
        tokens: {
          input: 100,
          output: 40,
          reasoning: 0,
          cache: {read: 0, write: 0},
        },
      },
      {
        id: 'm-u2',
        type: 'user',
        role: 'user',
        parts: [{type: 'text', text: dispatched.text}],
      },
    ];

    const idleHook = harness.hooksByName.get('experimental.idle');
    expect(idleHook).toBeDefined();
    await idleHook!({sessionID: 's-att-1', background: []});

    const store = createTuiStateStore();
    await hydrateStoreFromDisk(store, ws);
    const snap = store.getFocused('s-att-1');
    expect(snap?.status).toBe('active');
    expect(snap?.stopReason).not.toBe('user intervention');
    expect(harness.syntheticCalls).toHaveLength(1);
  } finally {
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 commands.goal config override coexists with draft.add and consumeCommandDispatch preserves goalId', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-cmd-cfg-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});

  const harness = createV2CommandTestCtx({
    directory: ws,
    options: {kickoffDelayMs: 5000},
  });
  const dispose = await setup(harness.ctx);
  try {
    const goalCommandTool = harness.registeredTools.find(
      t => t.name === 'goal-command',
    );
    expect(goalCommandTool).toBeDefined();

    // 1. Post-plugin `commands.goal` workflow calls `goal-command` directly.
    const out = (await goalCommandTool!.execute!(
      {subcommand: 'Deploy release safely'},
      {sessionID: 's-cfg-1'},
    )) as {content: string};
    expect(out.content).toContain('Deploy release safely');

    const store = createTuiStateStore();
    await hydrateStoreFromDisk(store, ws);
    const createdSnap = store.getFocused('s-cfg-1');
    expect(createdSnap?.status).toBe('active');
    expect(createdSnap?.condition).toBe('Deploy release safely');
    const createdGoalId = createdSnap!.goalId;

    // 2. When markCommandDispatch was recorded for the session, goal-command consumes
    // the cached dispatch instead of re-creating the goal and changing goalId.
    markCommandDispatch(
      's-cfg-1',
      'Deploy release safely',
      'Cached goal result: Deploy release safely',
      '[Goal transition receipt] cached',
      true,
    );
    const dedupedOut = (await goalCommandTool!.execute!(
      {subcommand: 'Deploy release safely'},
      {sessionID: 's-cfg-1'},
    )) as {content: string};
    expect(dedupedOut.content).toContain(
      'Cached goal result: Deploy release safely',
    );

    const storeAfter = createTuiStateStore();
    await hydrateStoreFromDisk(storeAfter, ws);
    expect(storeAfter.getSnapshots('s-cfg-1')).toHaveLength(1);
    expect(storeAfter.getFocused('s-cfg-1')?.goalId).toBe(createdGoalId);
  } finally {
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});
