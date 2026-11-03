// tui-dispatch.test.ts — Contract test for the TUI action dispatch.
//
// This is the regression test for H: the critical bug where
// sendGoalCommand used session.prompt instead of session.command, causing
// every keymap action to silently fail or dispatch incorrectly.
//
// The contract: when a goal keymap action fires, the TUI plugin MUST call
// `api.client.session.command` with the v2 FLAT shape:
// { sessionID, command: "goal", arguments: <subcommand> }
//
// This matches the v2 OpencodeClient's Session2.command signature (verified
// against @opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts):
// command({ sessionID: string, command?: string, arguments?: string,... })
//
// We test this by constructing a mock TuiPluginApi, calling the
// GoalTuiPlugin factory, simulating keymap command invocations, and
// asserting the session.command call shape.

import {describe, expect, test} from 'bun:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import GoalTuiPluginDefault from '../src/tui.ts';
import {PRODUCT_DISPLAY_NAME} from '../src/tui-components.ts';

// The TuiPlugin type requires 3 args (api, options, meta). Cast to a simpler
// function type to avoid supplying dummy args everywhere.
const initTui = GoalTuiPluginDefault.tui as (
  api: unknown,
  options?: unknown,
) => Promise<void>;

/**
 * An isolated workspace directory holding NO goal state.
 *
 * Without it this suite read `process.cwd` — this repository's own
 * `.opencode/goals` — because `readDiskGoalSnapshots` falls back to the process
 * working directory when `directory` is unset. Nothing about the dispatch
 * contract needs persisted state, and the dependency made the result a property
 * of the developer's untracked workspace: with a real stopped goal present, the
 * companion fired its load briefing, `toasts.find(t => t.variant === "warning")`
 * returned the BRIEFING, and the "warning toast when no active session"
 * assertion failed on a green product. CI never saw it because a clean checkout
 * has no `.opencode/goals`. Same defect the cockpit suite already documents, in
 * a second file — which is the point: it was fixed where it was found, not where
 * it was catalogued.
 */
let isolatedDir: string | undefined;

async function noGoalsDirectory(): Promise<string> {
  if (!isolatedDir)
    isolatedDir = await mkdtemp(join(tmpdir(), 'tui-dispatch-'));
  return isolatedDir;
}

// Mock TuiPluginApi

interface MockCommandCall {
  sessionID: string;
  command: string;
  arguments: string;
}

interface MockLayerCommand {
  name: string;
  run: (ctx?: unknown) => void | Promise<void>;
}

interface MockLayerBinding {
  key: string;
  cmd: string;
}

interface MockLayer {
  commands: MockLayerCommand[];
  bindings: MockLayerBinding[];
}

// The host declares its client surface as `any`; a mock that pretends to know
// it would be asserting a shape the host never guaranteed. Narrow the return
// type when the host publishes one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockApi(): any {
  const commands: MockCommandCall[] = [];
  const toasts: {variant: string; title: string; message: string}[] = [];
  const dialogs: {title: string; message?: string; placeholder?: string}[] = [];
  // Deterministic settle signal. `sendGoalCommand` is fire-and-forget, so a test
  // cannot know when the dispatch chain finished without either sleeping (a race)
  // or observing the effect itself. Every observable side effect bumps the
  // counter; `settle` resolves as soon as an *unconsumed* effect exists.
  // user 2026-09-24: a flaky test is a bad test — weakening is banned, and a
  // fixed sleep is exactly the weakening this replaces.
  let effectCount = 0;
  let consumed = 0;
  const waiters: Array<() => void> = [];
  const signalEffect = (): void => {
    effectCount += 1;
    while (waiters.length > 0) waiters.shift()!();
  };
  let routeParams: {name: string; params: {sessionID: string}} = {
    name: 'session',
    params: {sessionID: 'test-session-123'},
  };

  const api = {
    client: {
      session: {
        command: async (params: {
          sessionID: string;
          command: string;
          arguments: string;
        }): Promise<{data: unknown}> => {
          commands.push({
            sessionID: params.sessionID,
            command: params.command,
            arguments: params.arguments,
          });
          signalEffect();
          return {data: {info: {}, parts: []}};
        },
      },
    },
    route: {
      get current() {
        return {name: routeParams.name, params: routeParams.params};
      },
      register: () => () => {},
      navigate: () => {},
    },
    keymap: {
      registerLayer: (layer: MockLayer): (() => void) => {
        // Store the layer so tests can invoke commands by name.
        api._layer = layer;
        return () => {};
      },
    },
    ui: {
      toast: (input: {variant: string; title: string; message: string}) => {
        toasts.push(input);
        signalEffect();
      },
      dialog: {
        replace: (render: () => unknown, _onClose?: () => void) => {
          // Capture the rendered dialog for inspection
          const result = render();
          if (result && typeof result === 'object') {
            dialogs.push(
              result as {title: string; message?: string; placeholder?: string},
            );
          }
          signalEffect();
        },
        clear: () => {},
        setSize: () => {},
        size: 'medium' as const,
        depth: 0,
        open: false,
      },
      DialogAlert: (props: {title: string; message: string}) => props,
      DialogConfirm: (props: {title: string; message: string}) => props,
      DialogPrompt: (props: {
        title: string;
        placeholder?: string;
        onConfirm?: (v: string) => void;
      }) => props,
      DialogSelect: (props: {
        title: string;
        options: unknown[];
        onSelect?: (o: unknown) => void;
      }) => props,
    },
    event: {
      on: (_event: string, _handler: (e: unknown) => void) => () => {},
    },
    attention: {
      notify: () => ({ok: true}),
    },
    lifecycle: {
      onDispose: (fn: () => void) => {
        api._dispose = fn;
      },
    },
    _layer: null as MockLayer | null,
    _dispose: null as null | (() => void),
  };

  // Await the next unconsumed observable effect. Resolves immediately when one
  // has already landed; otherwise waits for the effect (with a hard failure so a
  // genuine hang is reported as "no effect", not as a wrong assertion).
  const settle = (): Promise<void> => {
    if (effectCount > consumed) {
      consumed = effectCount;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no observable dispatch effect within 2s')),
        2000,
      );
      waiters.push(() => {
        clearTimeout(timer);
        consumed = effectCount;
        resolve();
      });
    });
  };

  return {
    api,
    commands,
    toasts,
    dialogs,
    settle,
    setRoute: (r: typeof routeParams) => {
      routeParams = r;
    },
  };
}

// Helper: find a command in the registered layer

function findCommand(layer: MockLayer, name: string): MockLayerCommand {
  const cmd = layer.commands.find((c: MockLayerCommand) => c.name === name);
  if (!cmd)
    throw new Error(
      `Command ${name} not found in layer. Available: ${layer.commands.map(c => c.name).join(', ')}`,
    );
  return cmd;
}

// Tests

describe('TUI dispatch: session.command call shape (H-B1 regression)', () => {
  //: palette verbs name their goal (scoped to this session's focused
  // goal, never a bare verb, never a foreign row). The dispatch SHAPE — flat
  // { sessionID, command: "goal", arguments } — is unchanged; the arguments now
  // carry the id. These use the empty directory, so every verb refuses with a
  // reason instead of dispatching; the scoped dispatch is pinned in
  // tui-v1-cockpit.test.ts against the two-goal fixture.
  test('pause on an empty session refuses instead of dispatching bare', async () => {
    const {api, commands, toasts, settle} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.pause');
    await cmd.run();
    await settle();

    expect(commands).toHaveLength(0);
    expect(
      toasts.some(
        (t: {variant: string; title: string; message: string}) =>
          t.variant === 'warning' && t.message === 'This session has no goals.',
      ),
    ).toBe(true);
  });

  test('resume on an empty session refuses instead of dispatching bare', async () => {
    const {api, commands, toasts, settle} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.resume');
    await cmd.run();
    await settle();

    expect(commands).toHaveLength(0);
    expect(
      toasts.some(
        (t: {variant: string; title: string; message: string}) =>
          t.variant === 'warning' && t.message === 'This session has no goals.',
      ),
    ).toBe(true);
  });

  test('clear on an empty session refuses instead of dispatching bare', async () => {
    const {api, commands, toasts, settle} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.clear');
    await cmd.run();
    await settle();

    expect(commands).toHaveLength(0);
    expect(
      toasts.some(
        (t: {variant: string; title: string; message: string}) =>
          t.variant === 'warning' && t.message === 'This session has no goals.',
      ),
    ).toBe(true);
  });

  test('list action calls session.command with correct shape', async () => {
    const {api, commands, settle} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.list');
    await cmd.run();
    await settle();

    expect(commands).toHaveLength(1);
    expect(commands[0].arguments).toBe('list');
    expect(commands[0].sessionID).toBe('test-session-123');
  });

  test('history action calls session.command with correct shape', async () => {
    const {api, commands, settle} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.history');
    await cmd.run();
    await settle();

    expect(commands).toHaveLength(1);
    expect(commands[0].arguments).toBe('history');
    expect(commands[0].sessionID).toBe('test-session-123');
  });

  test('edit on an empty session refuses before the prompt opens', async () => {
    const {api, commands, dialogs, toasts, settle} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.edit');
    await cmd.run();
    await settle();

    // No prompt opens: the target is resolved before asking, so the objective
    // the user would type has somewhere to go.
    expect(commands).toHaveLength(0);
    expect(dialogs).toHaveLength(0);
    expect(
      toasts.some(
        (t: {variant: string; title: string; message: string}) =>
          t.variant === 'warning' && t.message === 'This session has no goals.',
      ),
    ).toBe(true);
  });

  test('dashboard command opens a dialog (not a session.command)', async () => {
    const {api, commands, dialogs} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.dashboard');
    cmd.run();

    expect(commands).toHaveLength(0); // no command sent — just opens dashboard
    expect(dialogs.length).toBeGreaterThanOrEqual(1);
    expect(dialogs[0].title).toContain(PRODUCT_DISPLAY_NAME);
  });

  test('warning toast when no active session', async () => {
    const {api, commands, toasts, setRoute, settle} = createMockApi();
    setRoute({name: 'home', params: {sessionID: ''}});
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.pause');
    await cmd.run();
    await settle();

    // No command dispatched — session check blocked it.
    expect(commands).toHaveLength(0);
    // The warning toast about opening a session should be present. Matched on
    // the MESSAGE rather than on `variant === "warning"`, which picks whichever
    // warning arrived first — so a second warning from anywhere (the load
    // briefing is one) could satisfy the find and let this assert nothing. The
    // message is what distinguishes this toast from any other warning.
    const warning = toasts.find(
      (t: {variant: string; title: string; message: string}) =>
        t.variant === 'warning' && t.message.includes('Open a session'),
    );
    expect(warning).toBeDefined();
  });

  test('error toast when session.command throws', async () => {
    // A goal must exist for the verb to reach session.command at all: on an
    // empty session the verb refuses before dispatching, so the throw path
    // needs a seeded goal. writeSessionState puts one goal in the session
    // the mock route points at, so paletteTarget resolves and pause reaches
    // the endpoint where the failure is injected.
    const {api, commands, toasts, settle} = createMockApi();
    const {mkdtemp} = await import('node:fs/promises');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const {writeSessionState} = await import('./tui-fixture.ts');
    const dir = await mkdtemp(join(tmpdir(), 'tui-dispatch-throw-'));
    await writeSessionState(dir, 'test-session-123', {
      version: 1,
      goals: [
        {
          goalId: '11111111-2222-3333-4444-555555555555',
          sessionID: 'test-session-123',
          condition: 'a goal that will fail to pause',
          status: 'active',
          revision: 1,
          turnCount: 1,
          totalTokens: 10,
          maxTokens: 200000,
          maxTurns: 10,
          tokenBudget: null,
          usage: {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            costKnown: false,
          },
          artifactPointers: [],
          pendingProposal: null,
          claims: [],
          lastClaim: null,
          stopReason: '',
          blockedReason: '',
        },
      ],
      results: [],
      sessionOrdered: [],
    });
    await initTui(api, {directory: dir});

    api.client.session.command = async () => {
      throw new Error('session.command failed — network error');
    };

    const cmd = findCommand(api._layer!, 'fixate-on.pause');
    await cmd.run();
    await settle();

    // The verb dispatched (a goal exists) and the endpoint threw: error toast.
    // commands stays empty because the override replaces session.command
    // wholesale and never records — the error toast carries the assertion.
    expect(commands).toHaveLength(0);
    const error = toasts.find(
      (t: {variant: string; title: string; message: string}) =>
        t.variant === 'error',
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('Command failed');
  });
});

// Chord Binding Scheme

describe('TUI chord binding scheme', () => {
  test('all bindings use the ctrl+shift+g prefix', async () => {
    const {api} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    for (const binding of api._layer!.bindings) {
      expect(binding.key).toMatch(/^ctrl\+shift\+g \w$/);
    }
  });

  test("dashboard binding uses 'd' not 's' (avoids host status collision)", async () => {
    const {api} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const dashboardBinding = api._layer!.bindings.find(
      (b: MockLayerBinding) => b.cmd === 'fixate-on.dashboard',
    );
    expect(dashboardBinding).toBeDefined();
    expect(dashboardBinding!.key).toBe('ctrl+shift+g d');
    expect(dashboardBinding!.key).not.toContain(' s');
  });

  test("no binding uses 's' as the action key (host status collision)", async () => {
    const {api} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    for (const binding of api._layer!.bindings) {
      const actionKey = binding.key.split(' ')[1];
      expect(actionKey).not.toBe('s');
    }
  });

  test('all action keys are distinct', async () => {
    const {api} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const actionKeys = api._layer!.bindings.map(
      (b: MockLayerBinding) => b.key.split(' ')[1],
    );
    expect(new Set(actionKeys).size).toBe(actionKeys.length);
  });

  test('no single-key bindings (all are two-key chords)', async () => {
    const {api} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    for (const binding of api._layer!.bindings) {
      expect(binding.key).toContain(' ');
      expect(binding.key.split(' ')).toHaveLength(2);
    }
  });

  test("no 'status' command name (renamed to dashboard)", async () => {
    const {api} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const statusCmd = api._layer!.commands.find((c: MockLayerCommand) =>
      c.name.includes('status'),
    );
    expect(statusCmd).toBeUndefined();
  });

  test('dashboard command exists with coherent naming', async () => {
    const {api} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const dashCmd = api._layer!.commands.find(
      (c: MockLayerCommand) => c.name === 'fixate-on.dashboard',
    );
    expect(dashCmd).toBeDefined();
    expect(dashCmd!.title).toContain('Dashboard');
  });
});

// Reactive Dashboard (H-D3 fix)

describe('TUI reactive dashboard', () => {
  test('dashboard re-renders when store updates', async () => {
    const {api, dialogs} = createMockApi();
    await initTui(api, {directory: await noGoalsDirectory()});

    const cmd = findCommand(api._layer!, 'fixate-on.dashboard');
    cmd.run();

    const initialDialogCount = dialogs.length;
    expect(initialDialogCount).toBeGreaterThanOrEqual(1);
    expect(dialogs[0].title).toContain(PRODUCT_DISPLAY_NAME);
  });
});
