import {describe, expect, it} from 'bun:test';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {writeSessionState} from './tui-fixture.ts';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import GoalTuiPluginDefault from '../src/tui.ts';
import {PRODUCT_DISPLAY_NAME} from '../src/tui-components.ts';

const initTui = GoalTuiPluginDefault.tui as (
  api: unknown,
  options?: unknown,
) => Promise<void>;

/**
 * Create an isolated goal-state fixture directory.
 *
 * These tests MUST NOT hydrate the repository's own `.opencode/goals/state.json`.
 * `hydrateStoreFromDisk` falls back to `process.cwd` when no `directory` is
 * given, so a developer's untracked local state made
 * three of these tests pass while they FAILED on a clean checkout — the suite
 * was green only in the author's working tree. Every test here now passes an
 * explicit isolated directory, so the result does not depend on local state.
 */
async function makeGoalFixture(
  condition: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'goal-cockpit-fixture-'));
  await writeSessionState(dir, 'test-session-123', {
    version: 1,
    goals: [
      {
        goalId: '11111111-2222-3333-4444-555555555555',
        sessionID: 'test-session-123',
        condition,
        status: 'active',
        revision: 1,
        turnCount: 2,
        totalTokens: 1234,
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
        ...overrides,
      },
    ],
    results: [],
    sessionOrdered: [],
  });
  return dir;
}

/** An isolated directory with NO goal state (for tests that need none). */
async function makeEmptyFixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'goal-cockpit-empty-'));
}

/** Two goals in ONE session, so a card can name a goal that is not the focused one. */
const GOAL_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const GOAL_B = 'bbbbbbbb-0000-0000-0000-000000000002';

async function makeTwoGoalFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'goal-cockpit-two-'));
  const goal = (goalId: string, condition: string, status: string) => ({
    goalId,
    sessionID: 'test-session-123',
    condition,
    status,
    revision: 1,
    turnCount: 2,
    totalTokens: 1234,
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
  });
  // Disk order is A then B: the store's recency-focus lands on B, so the
  // palette verbs must name B — the goal on screen — not A.
  await writeSessionState(dir, 'test-session-123', {
    version: 1,
    goals: [
      goal(GOAL_A, 'the first goal', 'active'),
      goal(GOAL_B, 'the goal on screen', 'active'),
    ],
    results: [],
    sessionOrdered: [],
  });
  return dir;
}

interface MockCommandCall {
  sessionID: string;
  command: string;
  arguments: string;
}

interface MockLayerCommand {
  name: string;
  run: (ctx?: unknown) => void | Promise<void>;
}

interface MockDialogRender {
  _dialogType: string;
  title: string;
  message?: string;
  options?: Array<{title: string; value: string; description?: string}>;
  onSelect?: (option: {value: string}) => void;
  onConfirm?: (value: string) => void;
  placeholder?: string;
}

function createMockApi() {
  const commands: MockCommandCall[] = [];
  const toasts: Array<{variant: string; title: string; message: string}> = [];
  const dialogRenders: MockDialogRender[] = [];
  const routeParams = {
    name: 'session',
    params: {sessionID: 'test-session-123'},
  };

  // Deterministic effect signalling. `chainReplace` defers its reopen by
  // CHAIN_REOPEN_MS past the host auto-clear (src/tui.ts) and `sendGoalCommand`
  // is fire-and-forget, so a test cannot know when a chained dialog or a
  // dispatch landed without either sleeping (a race against a fixed deadline —
  // exactly the flake the user banned weakening away on 2026-09-24) or awaiting the
  // effect itself. `waitForRender`/`waitForCommand` await a PREDICATE, so they
  // resolve the moment the real effect lands and fail loudly (never silently
  // pass) if it never does.
  type Waiter = {
    check: () => boolean;
    onReady: () => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const waiters: Waiter[] = [];
  const pump = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.check()) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.onReady();
      }
    }
  };
  const awaitEffect = <T>(
    find: () => T | undefined,
    label: string,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const existing = find();
      if (existing !== undefined) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`no ${label} within 2s`)),
        2000,
      );
      waiters.push({
        check: () => find() !== undefined,
        onReady: () => resolve(find() as T),
        timer,
      });
    });

  const waitForRender = (
    predicate: (d: MockDialogRender) => boolean,
    label: string,
  ): Promise<MockDialogRender> =>
    awaitEffect(() => dialogRenders.find(predicate), label);

  /**
   * Await a render that appears AFTER `afterIndex`.
   *
   * `waitForRender` searches the WHOLE history, so an assertion about a
   * navigation step would match the render that step was meant to leave — the
   * vacuity trap: the lock passes because the earlier dialog is still in the
   * list. A transition must assert on a genuinely NEW render.
   */
  const waitForNewRender = (
    afterIndex: number,
    predicate: (d: MockDialogRender) => boolean,
    label: string,
  ): Promise<MockDialogRender> =>
    awaitEffect(() => dialogRenders.slice(afterIndex).find(predicate), label);

  const waitForCommand = (
    predicate: (c: MockCommandCall) => boolean,
    label: string,
  ): Promise<MockCommandCall> =>
    awaitEffect(() => commands.find(predicate), label);

  const api = {
    client: {
      session: {
        command: async (params: {
          sessionID: string;
          command: string;
          arguments: string;
        }) => {
          commands.push(params);
          pump();
          return {data: {}};
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
      registerLayer: (layer: {commands: MockLayerCommand[]}) => {
        api._layer = layer;
        return () => {};
      },
    },
    ui: {
      toast: (input: {variant: string; title: string; message: string}) => {
        toasts.push(input);
      },
      dialog: {
        replace: (render: () => unknown, _onClose?: () => void) => {
          const result = render();
          if (result && typeof result === 'object') {
            dialogRenders.push(result as unknown as MockDialogRender);
          }
          pump();
        },
        clear: () => {},
        setSize: () => {},
        size: 'medium' as const,
        depth: 0,
        open: false,
      },
      DialogAlert: (props: {title: string; message: string}) => ({
        _dialogType: 'alert',
        ...props,
      }),
      DialogPrompt: (props: {
        title: string;
        placeholder?: string;
        onConfirm?: (v: string) => void;
      }) => ({_dialogType: 'prompt', ...props}),
      DialogSelect: (props: {
        title: string;
        options: Array<{title: string; value: string; description?: string}>;
        onSelect?: (o: {value: string}) => void;
      }) => ({_dialogType: 'select', ...props}),
    },
    event: {
      on: () => () => {},
    },
    attention: {
      notify: () => ({ok: true}),
    },
    lifecycle: {
      onDispose: () => {},
    },
    _layer: null as {commands: MockLayerCommand[]} | null,
  };

  return {
    api,
    commands,
    toasts,
    dialogRenders,
    waitForRender,
    waitForNewRender,
    waitForCommand,
  };
}

function findCommand(
  layer: {commands: MockLayerCommand[]},
  name: string,
): MockLayerCommand {
  const cmd = layer.commands.find(c => c.name === name);
  if (!cmd) throw new Error(`Command ${name} not found`);
  return cmd;
}

/**
 * Resolve once `check` is true, or REJECT after `ms` having said it never was.
 *
 * Waiting on the effect rather than on a duration, everywhere in this file. The
 * polling loop's interval is 1 s, so a fixed settle either wastes time or races,
 * and a race that loses looks exactly like a product defect — which is what
 * the mandatory-gate audit records happening to a real
 * campaign here. Failing loudly is the point: a wait that expires must report
 * itself, not proceed into assertions against nothing.
 */
async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return check();
}

// A fixture whose goals live under a CONFIGURED state root rather than the
// default one, so the companion's WIRING can be gated — the lesson being
// that a test on the reader is not a test on the surface that calls it. A
// decoy goal is written to the default root so "found something" cannot be
// satisfied by reading the wrong place.
async function makeConfiguredRootFixture(
  condition: string,
): Promise<{directory: string; stateRoot: string}> {
  const dir = await mkdtemp(join(tmpdir(), 'goal-cockpit-rooted-'));
  const stateRoot = join('configured', 'state');
  const goal = {
    goalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionID: 'test-session-123',
    condition,
    status: 'active' as const,
    revision: 1,
    turnCount: 2,
    totalTokens: 1234,
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
    stopReason: '',
    blockedReason: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
  };
  const state = (g: Record<string, unknown>) =>
    JSON.stringify({
      version: 1,
      goals: [g],
      results: [],
      sessionOrdered: [],
      invalidatedGoalIds: [],
      pendingIntents: [],
      settlementReceipts: [],
      focusedGoalIds: [],
    });
  // The goal, in the CONFIGURED root — at the path the companion is about to be
  // told to read.
  await mkdir(join(dir, stateRoot, 'sessions', 'test-session-123'), {
    recursive: true,
  });
  await writeFile(
    join(dir, stateRoot, 'sessions', 'test-session-123', 'state.json'),
    state(goal),
    'utf8',
  );
  // A decoy in the DEFAULT root, so "the cockpit opened with something" cannot be
  // satisfied by reading the wrong place.
  await writeSessionState(dir, 'test-session-123', {
    version: 1,
    goals: [
      {
        ...goal,
        goalId: '99999999-8888-7777-6666-555555555555',
        condition: 'a decoy in the DEFAULT root',
      },
    ],
    results: [],
    sessionOrdered: [],
    invalidatedGoalIds: [],
    pendingIntents: [],
    settlementReceipts: [],
    focusedGoalIds: [],
  });
  return {directory: dir, stateRoot};
}

describe('cockpit navigation flow', () => {
  // THE WIRING GATE, and the reason it is here rather than in the reader's own
  // suite. `discoverStateFiles` honouring a configured root is a property of the
  // READER; the companion actually PASSING that root to it is a property of the
  // COMPANION. The review found two defects that lived only in the second
  // kind, and a companion that resolved the root correctly and then read the
  // default one anyway passes every test that drives the reader directly.
  it('reads the CONFIGURED state root, not the decoy sitting in the default one', async () => {
    const {directory, stateRoot} = await makeConfiguredRootFixture(
      'a goal in a configured root',
    );
    const {api, waitForRender} = createMockApi();
    await initTui(api, {directory, stateRoot});
    const dashboardCmd = findCommand(api._layer!, 'fixate-on.dashboard');
    dashboardCmd.run();
    const selectDialog = await waitForRender(
      d => d._dialogType === 'select' && d.title === PRODUCT_DISPLAY_NAME,
      'dashboard select over a configured root',
    );
    const rendered = selectDialog
      .options!.map(o => `${o.title} ${o.description ?? ''}`)
      .join(' | ');
    console.log(`V1-ROOTED-OPTIONS ${rendered}`);
    expect(
      rendered,
      'the goal under the CONFIGURED root must be the one on screen',
    ).toContain('a goal in a configured root');
    expect(
      rendered,
      'and the decoy in the default root must not be',
    ).not.toContain('a decoy in the DEFAULT root');
  });

  // THE SECOND HALF OF THE SAME GATE, and it was missing. The test above shows
  // the v1 companion's BOOT read honours a configured root. Boot is one call
  // site; the companion then hands the same root to a 1 s refresh loop, which is
  // a second call site into the same reader. Dropping the option there left both
  // the boot gate and the reader gate green, and the production symptom is the
  // live one: the dashboard shows a configured workspace's goals at open and then
  // goes quiet forever, because every later poll reads a directory the plugin
  // never writes to. Verified by mutation — dropping `stateRoot` from the
  // `createDiskRefreshLoop` call leaves this whole file green without it.
  //
  // A second goal is written to the CONFIGURED root AFTER boot, so only a poll
  // that resolved that root can notice it; a boot-only read cannot, which is what
  // makes this a separate test rather than a repeat. The observable is the
  // companion's own `create` toast for it, which is the same curated moment a
  // user sees, and the wait is on that toast rather than on a duration — a fixed
  // settle here would be a race wearing a number.
  it('keeps reading the CONFIGURED root after boot, so a later goal is noticed', async () => {
    const {directory, stateRoot} = await makeConfiguredRootFixture(
      'a goal present at boot',
    );
    const {api, toasts} = createMockApi();
    await initTui(api, {directory, stateRoot});

    await writeSessionState(
      directory,
      'later-session',
      {
        version: 1,
        goals: [
          {
            goalId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
            sessionID: 'later-session',
            condition: 'a goal that appeared after boot',
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
            stopReason: '',
            blockedReason: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            finishedAt: null,
            lastCheckpoint: null,
            history: [],
          },
        ],
        results: [],
        sessionOrdered: [],
        invalidatedGoalIds: [],
        pendingIntents: [],
        settlementReceipts: [],
        focusedGoalIds: [],
      },
      stateRoot,
    );

    const appeared = await waitFor(
      () =>
        toasts.some(t => t.message.includes('a goal that appeared after boot')),
      6000,
    );
    expect(
      appeared,
      'a goal written to the CONFIGURED root after boot was never picked up — the refresh loop is not reading that root',
    ).toBe(true);

    // THE CONTROL, and it is here rather than before the wait because before the
    // wait it could not fail: at that point no poll has run, and the only
    // boot-time toast is the briefing, which is a COUNT plus reasons and never
    // carries a goal's condition. So "no toast for the boot goal" was true of
    // every possible product behaviour and established nothing.
    //
    // After several polls it means what it should: the loop has demonstrably
    // ticked, it read the CONFIGURED root, and it did NOT announce a goal that
    // was already there — because the loop's first tick is a silent baseline,
    // which is the property `toastYieldIsNotAMoment` depends on. If the loop had
    // been reading the default root instead, this goal would still be silent, so
    // the control does not distinguish the roots — it establishes that the
    // positive assertion below came from the loop's `create` synthesis and not
    // from a companion that announces everything it reads.
    expect(
      toasts.some(t => t.message.includes('a goal present at boot')),
      'a goal that was already on disk at boot must never be announced as newly started',
    ).toBe(false);
  }, 20_000);

  it('dashboard opens DialogSelect when goals exist after hydration', async () => {
    const {api, waitForRender} = createMockApi();
    // Hydration is awaited by initTui, so the goal is already in the store here.
    await initTui(api, {
      directory: await makeGoalFixture('hydrated goal for cockpit test'),
    });
    const dashboardCmd = findCommand(api._layer!, 'fixate-on.dashboard');
    dashboardCmd.run();

    const selectDialog = await waitForRender(
      d => d._dialogType === 'select' && d.title === PRODUCT_DISPLAY_NAME,
      'dashboard select',
    );
    expect(selectDialog.options!.length).toBeGreaterThanOrEqual(1);
  });

  it('dashboard shows DialogAlert fallback when no goals exist', async () => {
    const {api, waitForRender} = createMockApi();
    Object.defineProperty(api.route, 'current', {
      get: () => ({name: 'home', params: {}}),
    });
    await initTui(api, {directory: await makeEmptyFixture()});
    const dashboardCmd = findCommand(api._layer!, 'fixate-on.dashboard');
    dashboardCmd.run();

    const alertDialog = await waitForRender(
      d => d._dialogType === 'alert' && d.title === PRODUCT_DISPLAY_NAME,
      'dashboard fallback',
    );
    expect(alertDialog.title).toBe(PRODUCT_DISPLAY_NAME);
  });

  it('goal list options include status and token metadata', async () => {
    const {api, waitForRender} = createMockApi();
    await initTui(api, {
      directory: await makeGoalFixture('metadata goal for cockpit test'),
    });
    const dashboardCmd = findCommand(api._layer!, 'fixate-on.dashboard');
    dashboardCmd.run();

    const selectDialog = await waitForRender(
      d => d._dialogType === 'select' && d.title === PRODUCT_DISPLAY_NAME,
      'dashboard select',
    );
    const firstOption = selectDialog.options![0];
    expect(firstOption.title).toContain('[');
    expect(firstOption.description).toContain('Tokens:');
    expect(firstOption.description).toContain('Turns:');
  });

  it('detail card confirm transitions to action menu (onConfirm wired)', async () => {
    const {api, waitForRender} = createMockApi();
    await initTui(api, {
      directory: await makeGoalFixture('action menu goal for cockpit test'),
    });
    const dashboardCmd = findCommand(api._layer!, 'fixate-on.dashboard');
    dashboardCmd.run();

    const listDialog = await waitForRender(
      d => d._dialogType === 'select' && d.title === PRODUCT_DISPLAY_NAME,
      'goal list',
    );
    const goalValue = listDialog.options![0].value;
    listDialog.onSelect!({value: goalValue});
    // showGoalDetail chains via chainReplace (CHAIN_REOPEN_MS defer past the host
    // auto-clear); waitForRender awaits that render rather than racing it.
    const detailDialog = await waitForRender(
      d => d._dialogType === 'alert' && d.title.startsWith('Goal: '),
      'goal detail',
    );
    expect(detailDialog.onConfirm).toBeDefined();

    detailDialog.onConfirm!('');
    const actionMenu = await waitForRender(
      d => d._dialogType === 'select' && d.title.startsWith('Actions: '),
      'action menu',
    );
    const titles = actionMenu.options!.map(o => o.title);
    expect(titles).toContain('Pause');
    expect(titles).toContain('Resume');
    expect(titles).toContain('\u2190 Back to Goals');
  });

  it("'← Back to Goals' actually returns to the goal list", async () => {
    // The step that was never driven: the suite asserted "← Back to Goals"
    // EXISTED and never selected it, so the last hop of the cockpit was
    // untested. It is also the hop that was reported FAILING live.
    //
    // The live failure turned out to be a HARNESS defect, not a product one
    // (scripts/e2e-harness/drive-cockpit-v1.sh sent Down x7 for a 7-item menu,
    // and the select WRAPS, so it selected "Pause" and never reached "Back to
    // Goals"). No mock could have caught that — but this test does pin the
    // product half: the transition must land on the list.
    //
    // A FALSIFIED MODEL, RECORDED SO IT IS NOT REBUILT: the first version of
    // this test had the mock grant "focus" only to a dialog rendered outside a
    // callback, on the recorded root cause that replace inside
    // onSelect/onConfirm loses keyboard focus on stock v1. The live run
    // FALSIFIED that for this transition: with the chaining removed, the
    // returned list still rendered AND still accepted keys. The mechanism is
    // dialog-type-specific (a DialogAlert auto-clears on confirm, which is why
    // chainReplace exists for those), not general. A mock asserting a host
    // behaviour nobody verified is a FALSE lock — worse than no lock, because
    // it reads as enforced.
    const {api, dialogRenders, waitForRender, waitForNewRender} =
      createMockApi();
    await initTui(api, {
      directory: await makeGoalFixture('back navigation goal'),
    });
    const dashboardCmd = findCommand(api._layer!, 'fixate-on.dashboard');
    dashboardCmd.run();

    const listDialog = await waitForRender(
      d => d._dialogType === 'select' && d.title === PRODUCT_DISPLAY_NAME,
      'goal list',
    );
    listDialog.onSelect!({value: listDialog.options![0].value});
    const detailDialog = await waitForRender(
      d => d._dialogType === 'alert' && d.title.startsWith('Goal: '),
      'goal detail',
    );
    detailDialog.onConfirm!('');
    const actionMenu = await waitForRender(
      d => d._dialogType === 'select' && d.title.startsWith('Actions: '),
      'action menu',
    );

    // Assert on a render NEWER than everything so far: `waitForRender` would
    // match the ORIGINAL list dialog and pass without navigating at all.
    const before = dialogRenders.length;
    const back = actionMenu.options!.find(o => o.title === '← Back to Goals');
    expect(back).toBeDefined();
    actionMenu.onSelect!({value: back!.value});

    const listAgain = await waitForNewRender(
      before,
      d => d._dialogType === 'select' && d.title === PRODUCT_DISPLAY_NAME,
      'goal list after Back',
    );
    expect(listAgain.options!.length).toBeGreaterThanOrEqual(1);
  });

  it('pause on an empty session refuses with a reason instead of dispatching', async () => {
    const {api, toasts} = createMockApi();
    await initTui(api, {directory: await makeEmptyFixture()});

    const pauseCmd = findCommand(api._layer!, 'fixate-on.pause');
    await pauseCmd.run();
    await new Promise(r => setTimeout(r, 100));
    const refusal = toasts.find(t => t.variant === 'warning');
    expect(
      refusal,
      'bare pause on an empty session must refuse, not guess a target',
    ).toBeDefined();
    expect(refusal!.message).toBe('This session has no goals.');
  });

  it('pause names the focused goal instead of sending a bare verb', async () => {
    const {api, waitForCommand} = createMockApi();
    await initTui(api, {directory: await makeTwoGoalFixture()});

    const pauseCmd = findCommand(api._layer!, 'fixate-on.pause');
    await pauseCmd.run();
    const dispatched = await waitForCommand(
      c => c.arguments.startsWith('pause '),
      'pause dispatch',
    );

    expect(dispatched.command).toBe('goal');
    expect(dispatched.arguments).toBe(`pause ${GOAL_B}`);
  });

  it('clear names one goal instead of wiping the session', async () => {
    const {api, waitForCommand} = createMockApi();
    await initTui(api, {directory: await makeTwoGoalFixture()});

    const clearCmd = findCommand(api._layer!, 'fixate-on.clear');
    await clearCmd.run();
    const dispatched = await waitForCommand(
      c => c.arguments.startsWith('clear '),
      'clear dispatch',
    );

    expect(dispatched.command).toBe('goal');
    // One goal id, not a bare `clear` (which removes every goal + clearSession).
    expect(dispatched.arguments).toBe(`clear ${GOAL_B}`);
  });

  it('edit and checkpoint name the goal resolved before the prompt opens', async () => {
    const {api, waitForRender, waitForCommand} = createMockApi();
    await initTui(api, {directory: await makeTwoGoalFixture()});

    const editCmd = findCommand(api._layer!, 'fixate-on.edit');
    await editCmd.run();
    const editPrompt = await waitForRender(
      d => d._dialogType === 'prompt' && d.title === 'Edit Goal',
      'edit prompt',
    );
    editPrompt.onConfirm!('a palette objective');
    const editCall = await waitForCommand(
      c => c.arguments.startsWith('edit '),
      'edit dispatch',
    );
    expect(editCall.arguments).toBe(`edit ${GOAL_B} a palette objective`);

    const checkpointCmd = findCommand(api._layer!, 'fixate-on.checkpoint');
    await checkpointCmd.run();
    const checkpointPrompt = await waitForRender(
      d => d._dialogType === 'prompt' && d.title === 'Save Checkpoint',
      'checkpoint prompt',
    );
    checkpointPrompt.onConfirm!('a palette note');
    const checkpointCall = await waitForCommand(
      c => c.arguments.startsWith('checkpoint '),
      'checkpoint dispatch',
    );
    expect(checkpointCall.arguments).toBe(
      `checkpoint ${GOAL_B} a palette note`,
    );
  });

  it('resume names the focused goal instead of sending a bare verb', async () => {
    const {api, waitForCommand} = createMockApi();
    await initTui(api, {directory: await makeTwoGoalFixture()});

    const resumeCmd = findCommand(api._layer!, 'fixate-on.resume');
    await resumeCmd.run();
    const dispatched = await waitForCommand(
      c => c.arguments.startsWith('resume '),
      'resume dispatch',
    );

    expect(dispatched.command).toBe('goal');
    expect(dispatched.arguments).toBe(`resume ${GOAL_B}`);
  });

  // EVERY CARD ACTION NAMES ITS OWN GOAL, which is the rule the file states for
  // `pause` and never extended to `edit` and `checkpoint`. Those two dispatched a
  // BARE command, and a bare `edit`/`checkpoint` resolves through the FOCUSED goal
  // — so with two goals on screen, the card titled `Actions: <B>` edited A's
  // objective and took A from `paused` to `active`, and wrote A's checkpoint. `edit`
  // is the worse of the two because it is a state change, not a note.
  //
  // Driven through the REAL cockpit rather than asserted on the source, because the
  // reviewer that found this also found that mutating the v1 LIST ROW's attribution
  // call site to `null` left 85 tests green — every assertion drove the helper and
  // none drove the call site. This drives the call site.
  it("every card action on a NON-focused goal dispatches that goal's id", async () => {
    const {api, waitForRender, waitForCommand} = createMockApi();
    await initTui(api, {directory: await makeTwoGoalFixture()});
    findCommand(api._layer!, 'fixate-on.dashboard').run();

    const listDialog = await waitForRender(
      d => d._dialogType === 'select' && d.title === PRODUCT_DISPLAY_NAME,
      'goal list',
    );
    // The card for the goal that is NOT the focused one.
    const otherCard = listDialog.options!.find(o => o.value.includes(GOAL_B));
    expect(
      otherCard,
      "the second goal's card is not on the list, so this case is not the one it claims to be",
    ).toBeDefined();
    listDialog.onSelect!({value: otherCard!.value});
    const detailDialog = await waitForRender(
      d => d._dialogType === 'alert' && d.title.startsWith('Goal: '),
      'goal detail',
    );
    expect(detailDialog.title).toContain(GOAL_B.slice(0, 8));
    detailDialog.onConfirm!('');

    const actionMenu = await waitForRender(
      d => d._dialogType === 'select' && d.title.startsWith('Actions: '),
      'action menu',
    );
    expect(actionMenu.title).toBe(`Actions: ${GOAL_B.slice(0, 8)}`);

    const choose = (title: string) => {
      const option = actionMenu.options!.find(o => o.title === title);
      expect(option, `the action menu has no ${title}`).toBeDefined();
      actionMenu.onSelect!({value: option!.value});
    };

    // CONTROL FIRST, and it is a real control rather than a formality: `pause`
    // already carried the goal id, so if the assertion shape were wrong — searching
    // the wrong list, or matching a prefix — this is the line that would still pass.
    choose('Pause');
    const pauseCall = await waitForCommand(
      c => c.arguments.includes('pause'),
      'pause dispatch',
    );
    expect(pauseCall.arguments, 'the control action lost its goal id').toBe(
      `pause ${GOAL_B}`,
    );

    choose('Edit Objective');
    const editPrompt = await waitForRender(
      d => d._dialogType === 'prompt' && d.title === 'Edit Goal',
      'edit prompt',
    );
    editPrompt.onConfirm!('A BRAND NEW OBJECTIVE');
    const editCall = await waitForCommand(
      c => c.arguments.includes('edit'),
      'edit dispatch',
    );
    expect(
      editCall.arguments,
      "the card's Edit acted on the FOCUSED goal, not the card's — and it resumes the goal it lands on",
    ).toBe(`edit ${GOAL_B} A BRAND NEW OBJECTIVE`);

    choose('Checkpoint');
    const checkpointPrompt = await waitForRender(
      d => d._dialogType === 'prompt' && d.title === 'Save Checkpoint',
      'checkpoint prompt',
    );
    checkpointPrompt.onConfirm!('a note about this goal');
    const checkpointCall = await waitForCommand(
      c => c.arguments.includes('checkpoint'),
      'checkpoint dispatch',
    );
    expect(
      checkpointCall.arguments,
      "the card's Checkpoint wrote the FOCUSED goal's progress clock, which is the clock the stall brake reads",
    ).toBe(`checkpoint ${GOAL_B} a note about this goal`);
  });
});
