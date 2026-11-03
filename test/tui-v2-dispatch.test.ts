// tui-v2-dispatch.test.ts — Regression test for the v2 TUI palette "does
// nothing" bug.
//
// opencode v2 dropped the `command.execute.before` hook (v1-only). The old
// dispatch in src/tui-v2.ts called `client.session.command({command:"goal",
// arguments})`, which on v2 only resolves the config `/goal` template into an
// agent prompt — the plugin subcommand handler never runs, so goals are never
// created/persisted: "appears in the palette but does nothing".
//
// The fixed contract: every goal palette action MUST issue
// `client.session.synthetic` (NOT `session.command`) with a deterministic
// directive telling the active agent to call the registered `goal-command`
// tool with the exact subcommand (the same handleCommand dispatcher the v1
// `/goal` hook used). A synthetic steer is the only v2-native channel that
// actually reaches goal state; the tool makes the agent turn deterministic.

import {describe, expect, test} from 'bun:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import GoalTuiPluginV2 from '../src/tui-v2.ts';
import {createGoalState} from '../src/state-machine.ts';
import {writeStateFile} from '../src/persistence-wal.ts';

/** The goal the seeded workspace holds, named so the dispatch assertions can be exact. */
const SESSION = 'test-session-123';
const GOAL_ID = 'goal-the-keys-name';

/**
 * The goal the workspace-only test adds AFTER the companion has baselined. A distinct id,
 * because the loop's baseline deliberately silences everything it already saw — so the
 * "Goal started" toast this test waits for can only be about a goal that was NOT there at
 * baseline. Reusing GOAL_ID would assert on a goal the baseline had already absorbed.
 */
const GOAL_ID_ADDED = 'goal-added-after-baseline';

/**
 * A workspace holding ONE real goal, written by the product's own writer.
 *
 * Hand-written `state.json` is not a shape the companion reads, and this repository has
 * now been bitten by that five times — so the fixture goes through `writeStateFile`, which
 * is the only writer whose output is known to be readable by the thing under test.
 */
async function makeGoalFixture(condition: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tui-v2-dispatch-'));
  const goal = createGoalState(SESSION, condition, {
    goalId: GOAL_ID,
    maxTokens: 200_000,
    maxTurns: 25,
  });
  await writeStateFile(
    join(dir, '.opencode', 'goals', 'sessions', SESSION, 'state.json'),
    [goal],
    [],
    [],
  );
  return dir;
}

/**
 * A workspace with NO goal state at all.
 *
 * The legitimate no-op case for a steering key: a session with nothing of its own to act
 * on. Kept beside `makeGoalFixture` so the two arms of the rule — a goal on screen, and
 * none — are built the same way and differ only in what they contain.
 */
async function makeEmptyWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tui-v2-empty-'));
}

/**
 * Wait for the companion's startup hydration to finish.
 *
 * `setup` subscribes to the host's `data.on` and hydrates from disk on a later tick, so a
 * test that presses a key immediately would find an empty store — and would then be
 * measuring a race rather than the rule. This waits on the CONDITION (the goal has landed)
 * rather than on a duration, which is the discipline `theMandatoryGateWasMostlyBroken`
 * records: a fixed settle is a race wearing a timeout.
 */
async function waitForHydration(workspace: string): Promise<void> {
  const {readDiskGoalSnapshots} = await import('../src/tui-disk-state.ts');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const read = await readDiskGoalSnapshots(workspace);
    if (read.snapshots.some(s => s.goalId === GOAL_ID)) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`the companion never hydrated ${GOAL_ID} from ${workspace}`);
}

/**
 * How long `startDiskLoop` may spend resolving a workspace before giving up: 12 attempts
 * at a 500ms sleep. A test that adds a goal before the loop exists would measure nothing,
 * so it waits on the CONDITION that the loop has had a chance to start — bounded, and long
 * enough to cover the worst case, rather than a guess tuned to a fast machine.
 */
const DISK_LOOP_START_BUDGET_MS = 12 * 500;

/**
 * Wait until the companion's disk loop has had time to resolve a directory and start.
 *
 * The loop is created asynchronously (`void startDiskLoop`), and its baseline read is
 * SILENT by design — a pre-existing goal must not toast as new. There is no callback that
 * reports "the loop is up" to a caller outside the plugin, so this bounds the wait at the
 * loop's own retry budget rather than pretending to observe a condition it cannot see. What
 * the test then asserts is the loop's OUTPUT (a toast for a goal added after this point),
 * which is the thing that was actually broken.
 */
async function waitForLoopReady(): Promise<void> {
  await new Promise(r => setTimeout(r, DISK_LOOP_START_BUDGET_MS));
}

/**
 * Add a goal to an existing workspace AFTER the companion has baselined, using the
 * product's own writer. Same discipline as `makeGoalFixture`: the file must be one the
 * companion can actually read, so it goes through `writeStateFile`.
 */
async function addGoalToWorkspace(
  workspace: string,
  condition: string,
): Promise<void> {
  const goal = createGoalState(SESSION, condition, {
    goalId: GOAL_ID_ADDED,
    maxTokens: 200_000,
    maxTurns: 25,
  });
  await writeStateFile(
    join(workspace, '.opencode', 'goals', 'sessions', SESSION, 'state.json'),
    [goal],
    [],
    [],
  );
}

/**
 * Wait for a toast whose message matches `pattern`, returning the matched message.
 *
 * The coalescer delivers on its own interval, so the toast lands some milliseconds after
 * the loop synthesizes the event. This waits on the CONDITION (a matching toast exists)
 * rather than a duration — a fixed settle would measure the machine, and a test that
 * asserts after one settle is the `theMandatoryGateWasMostlyBroken` shape.
 */
async function waitForToast(
  h: {toasts: Array<{message: string}>},
  pattern: RegExp,
  budgetMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const hit = h.toasts.find(t => pattern.test(t.message));
    if (hit) return hit.message;
    await new Promise(r => setTimeout(r, 25));
  }
  return undefined;
}

// Mock V2Context

interface SyntheticCall {
  sessionID: string;
  text: string;
  description?: string;
}

interface CommandCall {
  sessionID: string;
  command: string;
  arguments: string;
}

interface CreateCall {
  params: Record<string, unknown>;
}

interface V2Command {
  id: string;
  run: (input?: string, event?: unknown) => void | boolean | Promise<void>;
}

function createMockContext() {
  const synthetics: SyntheticCall[] = [];
  const commands: CommandCall[] = [];
  const creates: CreateCall[] = [];
  const openedTabs: string[] = [];
  const toasts: {variant?: string; title?: string; message: string}[] = [];
  const dialogs: {kind: string; title: string; value?: string}[] = [];
  let capturedCommands: V2Command[] = [];
  let location: {directory: string; workspaceID?: string} | undefined;
  let tabsEnabled = false;
  let failNextSynthetic = false;

  let route: {type: string; sessionID?: string} = {
    type: 'session',
    sessionID: 'test-session-123',
  };

  const dialog = {
    alert: async (opts: {title: string; message: string}) => {
      dialogs.push({kind: 'alert', title: opts.title});
      return undefined;
    },
    confirm: async () => true,
    // Resolve prompts with a fixed objective so add/edit/checkpoint/sequence
    // dispatch deterministically (the palette run awaits the `.then`).
    prompt: async (opts: {title: string}) => {
      dialogs.push({kind: 'prompt', title: opts.title, value: 'fix the tests'});
      return 'fix the tests';
    },
    select: async () => undefined,
    show: () => {},
    set: () => {},
    clear: () => {},
  };

  const ctx = {
    options: {logLevel: 'error'} as Record<string, unknown>,
    client: {
      session: {
        synthetic: async (params: {
          sessionID: string;
          text: string;
          description?: string;
        }) => {
          if (failNextSynthetic) {
            failNextSynthetic = false;
            throw new Error('synthetic failed');
          }
          synthetics.push({
            sessionID: params.sessionID,
            text: params.text,
            description: params.description,
          });
          return {};
        },
        command: async (params: {
          sessionID: string;
          command: string;
          arguments: string;
        }) => {
          commands.push({
            sessionID: params.sessionID,
            command: params.command,
            arguments: params.arguments,
          });
          return {};
        },
        create: async (params: {
          location: {directory: string; workspaceID?: string};
        }) => {
          creates.push({params: params as Record<string, unknown>});
          return {id: 'created-session-abc'};
        },
      },
    },
    keymap: {
      layer: (make: () => {commands: V2Command[]}) => {
        capturedCommands = make().commands;
      },
    },
    ui: {
      dialog,
      toast: {
        show: (opts: {
          variant?: string;
          title?: string;
          message: string;
          duration?: number;
        }) => {
          toasts.push(opts);
        },
      },
      router: {
        register: () => () => {},
        navigate: () => {},
        current: () => route,
      },
      tabs: {
        enabled: () => tabsEnabled,
        open: (sessionID: string) => {
          openedTabs.push(sessionID);
          return true;
        },
      },
      format: {path: (v: string) => v},
    },
    data: {
      // setup subscribes to "session.tool.success" and returns an unsub fn.
      on: () => () => {},
    },
    attention: {
      notify: async () => ({ok: true, notification: false, sound: false}),
    },
    // Live getter so tests can set the location via the handle AFTER creating ctx.
    get location() {
      return location;
    },
  };

  const stub = ctx as unknown as Parameters<typeof GoalTuiPluginV2.setup>[0];
  return {
    stub,
    getCommands: () => capturedCommands,
    find: (id: string) => capturedCommands.find(c => c.id === id),
    synthetics,
    commands,
    creates,
    openedTabs,
    toasts,
    dialogs,
    setLocation: (
      loc: {directory: string; workspaceID?: string} | undefined,
    ) => {
      location = loc;
    },
    setRoute: (r: {type: string; sessionID?: string}) => {
      route = r;
    },
    setOptions: (o: Record<string, unknown>) => {
      ctx.options = o;
    },
    enableTabs: () => {
      tabsEnabled = true;
    },
    failSynthetic: () => {
      failNextSynthetic = true;
    },
  };
}

function findDispatchText(
  synths: SyntheticCall[],
  needle: string,
): string | undefined {
  return synths.find(s => s.text.includes(needle))?.text;
}

// Palette commands are fire-and-forget (`void sendGoalCommand(...)` / `.then`) —
// `await run` returns before the chained synthetic dispatch lands. Drain the
// microtask/timer queue so assertions observe the dispatched state deterministically.
// Macrotask FLUSH (0 ms), not a timing guess: yields so already-scheduled
// macrotasks run. Deliberate — do not "convert" to waitFor (there is no
// condition to await; the point is to drain the queue).
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('palette actions dispatch via session.synthetic, NOT session.command', async () => {
  const h = createMockContext();
  // A REAL workspace holding a real goal, because the subject of this test changed when
  // landed: the keys now NAME their goal rather than sending a bare verb, so a
  // workspace with nothing in it has nothing for them to name. Seeding it through the
  // product's own writer is what keeps the fixture honest — a hand-written state.json is
  // not a shape the companion reads, which is the fixture-priming bug this repository has
  // now hit five times.
  const workspace = await makeGoalFixture('a goal the keys can name');
  h.setLocation({directory: workspace});
  const dispose = await GoalTuiPluginV2.setup(h.stub);
  await waitForHydration(workspace);
  try {
    const cases: Array<[string, string]> = [
      ['fixate-on.pause', 'pause'],
      ['fixate-on.resume', 'resume'],
      ['fixate-on.clear', 'clear'],
      ['fixate-on.list', 'list'],
      ['fixate-on.history', 'history'],
    ];
    for (const [id] of cases) {
      const cmd = h.find(id);
      expect(cmd, `command ${id} should exist`).toBeTruthy();
      await cmd!.run();
      await flush();
    }

    // Prompts: add/edit/checkpoint/sequence resolve via dialog.prompt.
    for (const [id, needle] of [
      ['fixate-on.add', 'add fix the tests'],
      ['fixate-on.edit', 'edit'],
      ['fixate-on.checkpoint', 'checkpoint'],
      ['fixate-on.sequence', 'sequence fix the tests'],
    ] as Array<[string, string]>) {
      const cmd = h.find(id);
      expect(cmd, `command ${id} should exist`).toBeTruthy();
      await cmd!.run();
      await flush();
      expect(
        findDispatchText(h.synthetics, needle),
        `${id} should dispatch ${needle}`,
      ).toBeTruthy();
    }

    // The core contract: the broken session.command path is NOT used.
    expect(h.commands.length).toBe(0);

    // Every dispatch targets the active session and names the goal-command tool.
    for (const s of h.synthetics) {
      expect(s.sessionID).toBe('test-session-123');
      expect(s.text).toContain('goal-command');
    }

    // Subcommand mapping is exact — and TARGETED. This assertion USED to be
    // `expect(findDispatchText(h.synthetics, "pause")).toContain("\npause\n")`, pinning
    // the bare verb that `commands.ts` resolves through the FOCUSED goal. Two tests could
    // not both be describing the shipped behaviour: one asserted the extracted rule targets
    // correctly, this one asserted the reachable key sent a bare command. The key is the
    // surface a user presses, so the key is what the rule has to reach — and the id is
    // asserted by NAME, because "contains pause" is satisfied by the bare form too.
    const pauseText = findDispatchText(h.synthetics, 'pause');
    expect(pauseText, 'the pause key dispatched nothing').toBeTruthy();
    expect(
      pauseText,
      'the pause key sent a BARE verb, which resolves through the focused goal',
    ).not.toContain('\npause\n');
    expect(
      pauseText,
      'the pause key did not name the goal it is pressing about',
    ).toContain(`\npause ${GOAL_ID}\n`);
  } finally {
    dispose();
  }
});

test('a palette action with no open session AND no location warns and does not dispatch', async () => {
  const h = createMockContext();
  // Route to home (no session), and no location — the fallback cannot create one.
  h.setRoute({type: 'home'});
  h.setLocation(undefined);
  const dispose = await GoalTuiPluginV2.setup(h.stub);
  try {
    const pause = h.find('fixate-on.pause')!;
    await pause.run();
    expect(h.synthetics.length).toBe(0);
    expect(h.commands.length).toBe(0);
    expect(h.creates.length).toBe(0);
    expect(h.toasts.some(t => t.message.includes('Open a session'))).toBe(true);
  } finally {
    dispose();
  }
});

test('a palette action on the welcome screen creates a session and dispatches there', async () => {
  const h = createMockContext();
  // Welcome/home state: no session is open yet, but there IS a current location.
  h.setRoute({type: 'home'});
  h.setLocation({directory: '/work/dir'});
  // The tile TUI supports session tabs — the new session should surface as a tab.
  h.enableTabs();
  const dispose = await GoalTuiPluginV2.setup(h.stub);
  try {
    const add = h.find('fixate-on.add')!;
    await add.run();
    await flush();
    // Prompt resolves to "fix the tests" via the mock dialog → `add fix the tests`.
    expect(h.creates.length).toBe(1);
    expect(
      (h.creates[0].params.location as {directory: string}).directory,
    ).toBe('/work/dir');

    // The synthetic dispatch must target the newly created session, not the (absent) active one.
    const s = h.synthetics[0];
    expect(s).toBeDefined();
    expect(s.sessionID).toBe('created-session-abc');
    expect(s.text).toContain('goal-command');
    expect(s.text).toContain('\nadd fix the tests\n');

    // The new session is surfaced in the TUI via a tab.
    expect(h.openedTabs).toContain('created-session-abc');

    // No warning — this is a successful dispatch, not a no-op.
    expect(h.toasts.some(t => t.message.includes('Open a session'))).toBe(
      false,
    );
  } finally {
    dispose();
  }
});

test('a palette action creates a session even when tabs are unsupported', async () => {
  const h = createMockContext();
  h.setRoute({type: 'home'});
  h.setLocation({directory: '/work/dir'});
  // tabs stay disabled (the returned handle only enables them on demand)
  const dispose = await GoalTuiPluginV2.setup(h.stub);
  try {
    const pause = h.find('fixate-on.pause')!;
    await pause.run();
    await flush();
    expect(h.creates.length).toBe(1);
    expect(h.synthetics[0].sessionID).toBe('created-session-abc');
    expect(h.openedTabs.length).toBe(0);
    expect(h.toasts.some(t => t.message.includes('Open a session'))).toBe(
      false,
    );
  } finally {
    dispose();
  }
});

test('focus with no active goals warns instead of dispatching an empty command', async () => {
  const h = createMockContext();
  const dispose = await GoalTuiPluginV2.setup(h.stub);
  try {
    const focus = h.find('fixate-on.focus')!;
    await focus.run();
    expect(h.synthetics.length).toBe(0);
    expect(h.toasts.some(t => t.message.includes('No active goals'))).toBe(
      true,
    );
  } finally {
    dispose();
  }
});

test('a failed dispatch to an auto-created session clears the cache so the next action creates a fresh session', async () => {
  const h = createMockContext();
  h.setRoute({type: 'home'});
  h.setLocation({directory: '/work/dir'});
  h.enableTabs();
  const dispose = await GoalTuiPluginV2.setup(h.stub);
  try {
    // First action creates + caches session S1 and dispatches there.
    await h.find('fixate-on.add')!.run();
    await flush();
    expect(h.creates.length).toBe(1);
    expect(h.synthetics[0].sessionID).toBe('created-session-abc');

    // Second action while still home reuses the cached S1 (no second create).
    await h.find('fixate-on.pause')!.run();
    await flush();
    expect(h.creates.length).toBe(1);
    expect(h.synthetics[1].sessionID).toBe('created-session-abc');

    // Now the dispatch to the cached S1 fails: the cache must be invalidated so
    // the NEXT action creates a fresh session instead of pinning a dead one.
    h.failSynthetic();
    await h.find('fixate-on.pause')!.run();
    await flush();
    expect(h.creates.length).toBe(1); // still the cached S1 — create isn't retried mid-failure
    expect(
      h.toasts.some(
        t => t.variant === 'error' && t.message.includes('Command failed'),
      ),
    ).toBe(true);

    // The cache was cleared; the next action creates a brand-new session.
    await h.find('fixate-on.pause')!.run();
    await flush();
    expect(h.creates.length).toBe(2);
    expect(h.synthetics[h.synthetics.length - 1].sessionID).toBe(
      'created-session-abc',
    );
  } finally {
    dispose();
  }
});

// THE CONTROL, and the half of the rule "the keys now send an id" cannot establish on its
// own: with nothing of THIS session's on screen, the action must steer NOTHING rather than
// fall back to the focused goal. A gate that only shows the targeting works shows half
// the contract — the interesting half is that guessing was removed rather than decorated.
//
// Driven through the real keymap layer, because the whole of this phase's defect was that
// the rule was correct and sat beside the reachable surface rather than inside it: a test
// on `dashboardGoalActions` alone stays green while every key a user can press is bare.
describe('a key with no goal of this session steers nothing', () => {
  test('pause, resume and clear dispatch NOTHING rather than the focused goal', async () => {
    const h = createMockContext();
    // A real session, an EMPTY workspace: the exact shape that produced the shipped bug,
    // where a bare verb resolved through `session.getMachine` and hit whatever was
    // focused regardless of what was on screen.
    const workspace = await makeGoalFixture('placeholder').then(async dir => {
      const {rm} = await import('node:fs/promises');
      await rm(join(dir, '.opencode'), {recursive: true, force: true});
      return dir;
    });
    h.setLocation({directory: workspace});
    const dispose = await GoalTuiPluginV2.setup(h.stub);
    try {
      await flush();
      expect(
        h.synthetics.length,
        'the fixture dispatched something before any key was pressed',
      ).toBe(0);

      for (const id of [
        'fixate-on.pause',
        'fixate-on.resume',
        'fixate-on.clear',
      ]) {
        await h.find(id)!.run();
        await flush();
      }

      expect(
        h.synthetics,
        'a key with no goal of this session on screen dispatched a command — it guessed a target',
      ).toEqual([]);
    } finally {
      await dispose();
    }
  }, 30_000);

  test("the footer's key hint is HIDDEN when there is no goal to press a key about", async () => {
    // The footer already reasoned as though the keys were safe: it hides `p pause | r
    // resume | c clear` when `resolveFocusedGoalId` is null, on the grounds that a key
    // which is shown and does nothing is worse than one absent. That reasoning was FALSE
    // for as long as the keys were bare — the hint was hidden and the key still fired on
    // the focused goal — so the hiding is now asserted in both directions rather than
    // assumed, and the text is asserted through the EXTRACTED function because the footer
    // itself only reaches a user through the host's terminal renderer.
    const {dashboardFooterText} = await import('../src/tui-views.ts');
    const render = (target: string | null): string =>
      dashboardFooterText(
        target,
        'ctrl+shift+g d',
        'ctrl+shift+g p',
        'ctrl+shift+g r',
        'ctrl+shift+g c',
        'esc',
      );

    expect(
      render(null),
      'the key hint is advertised with no goal of this session to act on',
    ).not.toContain('pause');
    // …and the navigation is still offered, because the dashboard itself is still openable.
    expect(
      render(null),
      'the footer lost its navigation along with the key hint',
    ).toContain('dashboard');

    expect(
      render(GOAL_ID),
      'the key hint is hidden even though there IS a goal to act on',
    ).toContain('pause');
  });
});

// THE ROUTE. The closing gate found that the fix reached the DIALOG and missed
// the ROUTE, because the keys resolved their session with `activeSessionID` — which is
// null for as long as a PLUGIN route is current — while the rows, the focus pointer and the
// footer all resolved it with the dashboard-aware expression. Reproduced through this
// mock's own route setter:
//
// route = session → fixate-on.pause → "pause goal-on-screen" ✅
// route = plugin "goal-dashboard" → fixate-on.pause → "pause" ❌ bare
//
// So on the surface where the footer was advertising `p pause | r resume | c clear` for a
// goal it had just resolved, the key sent a bare verb into a freshly created session.
//
// The existing suites never reached this because `router.register` THROWS in both of them
// (`tui-v2-live-dashboard.test.ts:142` says so in a comment), so the whole route render had
// no unit coverage at all and the comment deferred it to "E2E campaigns". This drives the
// keymap under the route directly — the keys are live wherever the companion is, which is
// the entire point of the defect.
describe('a key pressed while the DASHBOARD ROUTE is current', () => {
  const onRoute = (h: ReturnType<typeof createMockContext>): void => {
    h.setRoute({type: 'plugin', name: 'goal-dashboard'} as never);
  };

  test('pause, resume and clear name the goal the dashboard is showing', async () => {
    const h = createMockContext();
    const workspace = await makeGoalFixture('a goal on the dashboard');
    h.setLocation({directory: workspace});
    const dispose = await GoalTuiPluginV2.setup(h.stub);
    await waitForHydration(workspace);
    try {
      // The dashboard is open, so the companion is showing this goal and the footer is
      // advertising the three keys for it.
      await h.find('fixate-on.dashboard')!.run();
      await flush();
      onRoute(h);

      for (const verb of ['pause', 'resume', 'clear']) {
        await h.find(`fixate-on.${verb}`)!.run();
        await flush();
        const text = findDispatchText(h.synthetics, verb);
        expect(
          text,
          `the ${verb} key dispatched nothing on the route`,
        ).toBeTruthy();
        expect(
          text,
          `the ${verb} key sent a BARE verb on the dashboard route — it resolved a session ` +
            '(which is null while a plugin route is current) and dispatched into a new one',
        ).not.toContain(`\n${verb}\n`);
        expect(
          text,
          `the ${verb} key did not name the goal the dashboard is showing`,
        ).toContain(`\n${verb} ${GOAL_ID}\n`);
      }
    } finally {
      await dispose();
    }
  }, 30_000);

  test('edit and checkpoint name it too, rather than opening a prompt into a new session', async () => {
    const h = createMockContext();
    const workspace = await makeGoalFixture('a goal to edit from the route');
    h.setLocation({directory: workspace});
    const dispose = await GoalTuiPluginV2.setup(h.stub);
    await waitForHydration(workspace);
    try {
      await h.find('fixate-on.dashboard')!.run();
      await flush();
      onRoute(h);

      await h.find('fixate-on.edit')!.run();
      await flush();
      const editText = findDispatchText(h.synthetics, 'edit');
      expect(
        editText,
        'the edit key dispatched nothing on the route',
      ).toBeTruthy();
      expect(
        editText,
        'the edit key sent a bare verb on the dashboard route',
      ).toContain(`edit ${GOAL_ID} fix the tests`);

      await h.find('fixate-on.checkpoint')!.run();
      await flush();
      const checkpointText = findDispatchText(h.synthetics, 'checkpoint');
      expect(checkpointText).toContain(`checkpoint ${GOAL_ID} fix the tests`);
    } finally {
      await dispose();
    }
  }, 30_000);

  test('CONTROL: with NO goal on screen the keys still steer nothing, on the route too', async () => {
    // The other half, and the half 'the keys now send an id' cannot establish alone. A
    // gate that only shows the targeting works shows half the contract.
    const h = createMockContext();
    const workspace = await makeEmptyWorkspace();
    h.setLocation({directory: workspace});
    const dispose = await GoalTuiPluginV2.setup(h.stub);
    try {
      await flush();
      await h.find('fixate-on.dashboard')!.run();
      await flush();
      onRoute(h);

      for (const verb of ['pause', 'resume', 'clear']) {
        await h.find(`fixate-on.${verb}`)!.run();
        await flush();
      }
      expect(
        h.synthetics,
        'a key with no goal of this session on screen dispatched a command — it guessed a target',
      ).toEqual([]);
    } finally {
      await dispose();
    }
  }, 30_000);
});

// The configured workspace wins over the host's reported one

describe('v2 companion reads the configured workspaceDirectory', () => {
  /**
   * THE DEFECT THIS GATES, measured on a real from-source host (2026-10-13). The disk
   * refresh loop is the ONLY channel that produces curated lifecycle toasts on v2 — there
   * is no server->TUI publish, so `onEvent` from that loop is the whole toast pipeline. The
   * loop resolved its workspace from `context.location.directory`, which on a from-source
   * host (`bun run dev`) is the HOST SOURCE CHECKOUT, not the workspace the user opened:
   * measured `startDiskLoop: dir=/Users/.../opencode-2/packages/cli` against a campaign
   * workspace at `/Users/.../e2e-harness/work`. The loop polled a tree holding no goals, so
   * no create/transition event was ever synthesized and NO curated lifecycle toast could
   * ever fire — while the dashboard (hydrated separately) kept working, which is exactly
   * the silent split this assertion exists to catch.
   *
   * The v2 SERVER plugin was fixed for the same hazard by reading a `workspaceDirectory`
   * option (a7e1954); the TUI companion never received it because its `cli.json` entry was
   * a bare string with no options. Both halves are gated here: the option must be read, and
   * it must outrank the host's location — for the LOOP, whose directory is otherwise
   * invisible from outside. (Gating hydration alone would not do: a second, eager hydrate
   * path honors the option independently, so a loop that ignored it would still pass.)
   *
   * The loop's only observable output is `context.ui.toast.show`, so that is the seam: a
   * goal added AFTER the loop baselined must produce a "Goal started" toast. A loop
   * polling the host's empty tree emits nothing, so the two cannot both satisfy this.
   */
  test("the disk loop polls the configured workspace, not the host's location", async () => {
    const h = createMockContext();
    const configured = await makeGoalFixture(
      'a goal only the configured workspace holds',
    );
    const reported = await makeEmptyWorkspace();
    h.setLocation({directory: reported});
    h.setOptions({logLevel: 'error', workspaceDirectory: configured});

    const dispose = await GoalTuiPluginV2.setup(h.stub);
    try {
      // The baseline read is SILENT by design — pre-existing goals must not toast as new.
      // Wait for it on the CONDITION (the loop's directory resolved), then add a goal.
      await waitForLoopReady();
      await addGoalToWorkspace(
        configured,
        'a goal added after the loop baselined',
      );
      // The loop polls on a 1s interval; wait on the CONDITION (the toast appeared), not a
      // duration — the discipline `theMandatoryGateWasMostlyBroken` records.
      const toast = await waitForToast(h, /Goal started/, 6000);
      expect(
        toast,
        "the disk loop emitted no 'Goal started' toast for the configured workspace",
      ).toBeTruthy();
    } finally {
      await dispose();
    }
  }, 30_000);

  test('CONTROL: with no workspaceDirectory the host location still drives the loop', async () => {
    // The other arm, and the one that keeps the fix from being an unconditional override.
    // A host that reports its location and supplies no override must keep working — this is
    // the v1-parity path, and it is what a loop that ignored `context.location` outright
    // would fail. Both arms are gated, so neither can drift alone.
    const h = createMockContext();
    const workspace = await makeGoalFixture(
      'a goal the host location alone can find',
    );
    h.setLocation({directory: workspace});
    h.setOptions({logLevel: 'error'});

    const dispose = await GoalTuiPluginV2.setup(h.stub);
    try {
      await waitForLoopReady();
      await addGoalToWorkspace(
        workspace,
        'a goal added after the loop baselined',
      );
      const toast = await waitForToast(h, /Goal started/, 6000);
      expect(
        toast,
        'with no override the host location stopped driving the disk loop',
      ).toBeTruthy();
    } finally {
      await dispose();
    }
  }, 30_000);
});
