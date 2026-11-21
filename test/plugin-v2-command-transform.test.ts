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
import type {
  GoalCommandOutput,
  GoalOutputRpcDomain,
} from '../src/plugin-v2-command-output.ts';

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
  onSynthetic?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
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
  const commandOutputs: GoalCommandOutput[] = [];
  const rpc: GoalOutputRpcDomain = {
    register: async () => ({
      events: {
        emit: async (_name, output) => {
          commandOutputs.push(output);
        },
      },
      dispose: async () => {},
    }),
  };
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
    rpc,
    location: {directory: opts.directory},
    options: {logLevel: 'error', ...opts.options},
    session: {
      prompt: async (input: Record<string, unknown>) => {
        promptCalls.push(input);
        return {id: `prm-${promptCalls.length}`, type: 'user'};
      },
      synthetic: async (input: Record<string, unknown>) => {
        if (opts?.onSynthetic) return opts.onSynthetic(input);
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
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {read: 0, write: 0},
        },
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
    commandOutputs,
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

test('v2 command.transform rejects attachments before mutating state on clear', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-cmd-attach-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const harness = createV2CommandTestCtx({directory: ws});
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    await goalCmd.execute!({
      sessionID: 's-attach',
      prompt: {text: 'Build the feature'},
    });

    const fileAttachment = {path: 'spec.md', mime: 'text/markdown'};
    await expect(
      goalCmd.execute!({
        sessionID: 's-attach',
        prompt: {text: 'clear', files: [fileAttachment]},
      }),
    ).rejects.toThrow(/starting or resuming/i);

    // The rejected clear must not have destroyed the goal.
    const store = createTuiStateStore();
    await hydrateStoreFromDisk(store, ws);
    const snap = store.getFocused('s-attach');
    expect(snap?.status).toBe('active');
    expect(snap?.condition).toBe('Build the feature');
  } finally {
    harness.closeEvents();
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

    // Read-only commands spawn zero LLM turns; their output is delivered as
    // passive RPC receipts (one per command).
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'status'}});
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'list'}});
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'history'}});
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: ''}});
    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.syntheticCalls).toHaveLength(0);
    expect(harness.commandOutputs).toHaveLength(4);
    for (const output of harness.commandOutputs) {
      expect(output.text).toMatch(/goal/i);
      expect(output.kind).toBe('command');
    }

    // Pause updates persisted state to paused without spawning a turn; its
    // receipt is delivered without entering the model inbox.
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'pause'}});
    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.syntheticCalls).toHaveLength(0);
    expect(harness.commandOutputs).toHaveLength(5);

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

    // Clear removes the goal without spawning an LLM turn; its receipt is
    // delivered through the passive output channel.
    await goalCmd.execute!({sessionID: 's-cmd-2', prompt: {text: 'clear'}});
    expect(harness.syntheticCalls).toHaveLength(1);
    expect(harness.commandOutputs).toHaveLength(6);
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

test('v2 native commands do not poison the v1 replay cache for later goal-command calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-cmd-replay-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const harness = createV2CommandTestCtx({directory: ws});
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    const goalCommandTool = harness.registeredTools.find(
      t => t.name === 'goal-command',
    )!;

    await goalCmd.execute!({
      sessionID: 's-replay',
      prompt: {text: 'Set the replay objective'},
    });
    await goalCmd.execute!({sessionID: 's-replay', prompt: {text: 'pause'}});
    await goalCmd.execute!({sessionID: 's-replay', prompt: {text: 'resume'}});

    // A later deliberate goal-command pause must execute for real, not replay
    // the native pause's cached receipt and report success while staying active.
    const out = (await goalCommandTool.execute!(
      {subcommand: 'pause'},
      {sessionID: 's-replay'},
    )) as {content: string};
    expect(out.content).toContain('source=goal-command');
    expect(out.content).not.toContain('source=user-command');

    const store = createTuiStateStore();
    await hydrateStoreFromDisk(store, ws);
    expect(store.getFocused('s-replay')?.status).toBe('paused');
  } finally {
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 initial synthetic admission failure re-arms a retryable kickoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-kickfail-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  let attempts = 0;
  const harness = createV2CommandTestCtx({
    directory: ws,
    options: {kickoffDelayMs: 5000, idlePoller: false},
    onSynthetic: () => {
      attempts++;
      if (attempts === 1) throw new Error('admission rejected');
      return {id: 'syn-retry', type: 'synthetic'};
    },
  });
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    // Observe the scheduling DECISION: on admission failure the plugin must
    // arm a delayed retry kickoff instead of dropping the active goal's intent.
    const armedDelays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      armedDelays.push(Number(delay ?? 0));
      return realSetTimeout(fn, 0);
    }) as typeof globalThis.setTimeout;
    try {
      await expect(
        goalCmd.execute!({
          sessionID: 's-kickfail',
          prompt: {text: 'Build the retry goal'},
        }),
      ).rejects.toThrow(/admission rejected/i);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(armedDelays.filter(d => d >= 5000)).toHaveLength(1);

    // The retry kickoff re-attempts the synthetic admission and succeeds.
    await waitFor(() => attempts === 2, 'the retry kickoff to fire');
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

test('v2 attachment preflight accepts objectives the command parser treats as bare', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-preflight-parser-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const harness = createV2CommandTestCtx({directory: ws});
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    const objectives = [
      'Reset the test database and repair the failing migration',
      'clear the stale cache entries described in the attachment',
      'clear\nplain multiline objective',
    ];
    for (const [index, text] of objectives.entries()) {
      const sessionID = `s-parser-${index}`;
      await goalCmd.execute!({
        sessionID,
        prompt: {text, files: [{path: 'schema.sql'}]},
      });
      const store = createTuiStateStore();
      await hydrateStoreFromDisk(store, ws);
      expect(store.getFocused(sessionID)?.condition).toBe(
        text.replace(/\s+/g, ' ').trim(),
      );
    }
    expect(harness.promptCalls).toHaveLength(objectives.length);
  } finally {
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 attached edit of an active goal is rejected before mutating state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-attached-edit-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const harness = createV2CommandTestCtx({directory: ws});
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    await goalCmd.execute!({
      sessionID: 's-edit',
      prompt: {text: 'Original objective'},
    });
    await expect(
      goalCmd.execute!({
        sessionID: 's-edit',
        prompt: {
          text: 'edit Replacement objective',
          files: [{path: 'spec.md'}],
        },
      }),
    ).rejects.toThrow(/starting or resuming/i);
    const store = createTuiStateStore();
    await hydrateStoreFromDisk(store, ws);
    expect(store.getFocused('s-edit')?.condition).toBe('Original objective');
    expect(store.getFocused('s-edit')?.status).toBe('active');
  } finally {
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 admission retry preserves the full dispatch and survives a status command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-admission-retry-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const promptCalls: Array<Record<string, unknown>> = [];
  const harness = createV2CommandTestCtx({
    directory: ws,
    options: {kickoffDelayMs: 5000},
  });
  harness.ctx.session.prompt = async (input: Record<string, unknown>) => {
    promptCalls.push(input);
    if (promptCalls.length === 1) throw new Error('admission rejected');
    return {id: 'retried-prompt', type: 'user'};
  };
  const dispose = await setup(harness.ctx);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, delay?: number) =>
    realSetTimeout(
      fn,
      delay === 5000 ? 0 : delay,
    )) as typeof globalThis.setTimeout;
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    const files = [{path: 'must-read.md'}];
    const agents = [{name: 'required-agent'}];
    const skills = [{name: 'required-skill'}];
    await expect(
      goalCmd.execute!({
        sessionID: 's-retry-payload',
        prompt: {
          text: 'Follow attached requirements',
          files,
          agents,
          skills,
        },
        delivery: 'queue',
      }),
    ).rejects.toThrow(/admission rejected/i);
    await goalCmd.execute!({
      sessionID: 's-retry-payload',
      prompt: {text: 'status'},
    });
    await waitFor(
      () => promptCalls.length === 2,
      'the original dispatch to be retried',
    );
    expect(promptCalls[1]?.files).toEqual(files);
    expect(promptCalls[1]?.agents).toEqual(agents);
    expect(promptCalls[1]?.skills).toEqual(skills);
    expect(promptCalls[1]?.delivery).toBe('queue');
    // The intervening status uses passive output; only the original attachment
    // dispatch reaches the host prompt API.
    expect(harness.syntheticCalls).toHaveLength(0);
    expect(harness.commandOutputs).toHaveLength(1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 queue-to-steer promotion of an inbox stop pauses the goal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-inbox-promote-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const harness = createV2CommandTestCtx({directory: ws});
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    await goalCmd.execute!({
      sessionID: 's-promote',
      prompt: {text: 'Build the feature'},
    });

    // A queued 'stop' arrives with no text on the later delivery-change event.
    harness.pushEvent({
      type: 'session.inbox.enqueued',
      data: {
        sessionID: 's-promote',
        inboxID: 'inbox-stop',
        item: {
          id: 'inbox-stop',
          type: 'user',
          delivery: 'queue',
          payload: {text: 'stop'},
        },
      },
    });
    await waitFor(
      () => harness.eventsDrained(),
      'the queued inbox event to be handled',
    );
    harness.pushEvent({
      type: 'session.inbox.delivery.changed',
      data: {sessionID: 's-promote', inboxID: 'inbox-stop', delivery: 'steer'},
    });
    await waitFor(
      () => harness.eventsDrained(),
      'the delivery change to be handled',
    );

    const store = createTuiStateStore();
    await hydrateStoreFromDisk(store, ws);
    expect(store.getFocused('s-promote')?.status).toBe('paused');
    expect(store.getFocused('s-promote')?.stopReason).toBe('explicit pause');
  } finally {
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 native read-only command output uses the passive receipt channel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-cmd-output-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const harness = createV2CommandTestCtx({directory: ws});
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    // Set a goal first so `status` has state to report.
    await goalCmd.execute!({
      sessionID: 's-out',
      prompt: {text: 'Ship the release'},
    });
    expect(harness.promptCalls).toHaveLength(0);
    await goalCmd.execute!({sessionID: 's-out', prompt: {text: 'status'}});
    // No model turn was spawned for the read-only command...
    expect(harness.promptCalls).toHaveLength(0);
    // The only synthetic is the initial kickoff. Status is published to
    // the passive channel with its full text and session identity.
    expect(harness.syntheticCalls).toHaveLength(1);
    const out = harness.commandOutputs.at(-1)!;
    expect(out.kind).toBe('command');
    expect(out.sessionID).toBe('s-out');
    expect(String(out.text)).toContain('Ship the release');
  } finally {
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 repeated blocked idles with the same job key preserve the escalation clock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-defer-clock-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const harness = createV2CommandTestCtx({
    directory: ws,
    options: {idlePoller: false},
  });
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    await goalCmd.execute!({
      sessionID: 's-defer',
      prompt: {text: 'Run the background job goal'},
    });
    const idleHook = harness.hooksByName.get('experimental.idle')!;
    const job = [
      {kind: 'subagent', sessionID: 's-defer', childSessionID: 'c1'},
    ];
    const firstAt = Date.now();
    await idleHook!({sessionID: 's-defer', background: job});
    // Re-report the same stuck job shortly afterwards: the deferral must keep
    // the original `since`, not reset the 15-minute escalation clock.
    await idleHook!({sessionID: 's-defer', background: job});
    // A different job set starts a fresh clock (no overlap).
    const otherJob = [
      {kind: 'image', sessionID: 's-defer', childSessionID: 'img-9'},
    ];
    await idleHook!({sessionID: 's-defer', background: otherJob});
    // An empty-background idle is the authoritative clear: it must drive the
    // goal (synthesize the idle event) and release the deferral.
    const syntheticsBefore = harness.syntheticCalls.length;
    await idleHook!({sessionID: 's-defer', background: []});
    const store = createTuiStateStore();
    await hydrateStoreFromDisk(store, ws);
    expect(store.getFocused('s-defer')?.status).toBe('active');
    // The empty idle routes through the v1 event hook; any extra synthetic
    // call is the initial goal-set kickoff, not a new dispatch.
    expect(harness.syntheticCalls.length).toBeLessThanOrEqual(
      syntheticsBefore + 1,
    );
    expect(firstAt).toBeLessThanOrEqual(Date.now());
  } finally {
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});

test('v2 experimental.idle escalates after MAX_BACKGROUND_WAIT_MS even when idlePoller is false', async () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const root = mkdtempSync(join(tmpdir(), 'fixate-v2-defer-no-poller-'));
  const ws = join(root, 'ws');
  mkdirSync(ws, {recursive: true});
  const harness = createV2CommandTestCtx({
    directory: ws,
    options: {idlePoller: false},
  });
  const dispose = await setup(harness.ctx);
  try {
    const goalCmd = harness.registeredByAdd.get('goal')!;
    await goalCmd.execute!({
      sessionID: 's-escalate',
      prompt: {text: 'Wait on a stuck background job'},
    });
    const idleHook = harness.hooksByName.get('experimental.idle')!;
    const job = [
      {kind: 'subagent', sessionID: 's-escalate', childSessionID: 'c1'},
    ];
    await idleHook!({sessionID: 's-escalate', background: job});
    now += 15 * 60 * 1000 + 1;
    await idleHook!({sessionID: 's-escalate', background: job});
    const store = createTuiStateStore();
    await hydrateStoreFromDisk(store, ws);
    expect(store.getFocused('s-escalate')?.status).toBe('paused');
    expect(store.getFocused('s-escalate')?.stopReason).toBe(
      'background completion unreported',
    );
    expect(
      harness.commandOutputs.some(o =>
        o.text.includes('did not report completion within the wait bound'),
      ),
    ).toBe(true);
  } finally {
    Date.now = realNow;
    harness.closeEvents();
    await dispose();
    rmSync(root, {recursive: true, force: true});
  }
});
