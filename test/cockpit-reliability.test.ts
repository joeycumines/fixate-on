// cockpit-reliability.test.ts — Contract tests for cockpit reliability:
// - Cockpit reliability & truthfulness: effective-or-visibly-failed + hydration
// - Hydration of TuiStateStore from persisted disk state
// - Action outcome tracking and watchdog failure surfacing
// - Truthful dashboard and focus picker displays without false-empty claims

/** The session whose state file these fixtures write; a companion reads every
 * session, so one is enough, and naming it keeps the layout visible here. */

import {afterEach, beforeEach, describe, expect, it, test} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createTuiStateStore,
  encodeGoalToolMetadata,
  type GoalTuiSnapshot,
} from '../src/tui-state.ts';
import {hydrateStoreFromDisk} from '../src/tui-disk-state.ts';
import {GoalTuiPluginV2} from '../src/tui-v2.ts';
import {writeSessionState} from './tui-fixture.ts';

interface MockToast {
  variant?: string;
  title?: string;
  message: string;
  duration?: number;
}

interface MockKeymapCommand {
  id?: string;
  title?: string;
  description?: string;
  group?: string;
  palette?: boolean;
  bind?: false | string;
  run: (input?: string, event?: unknown) => void | false | Promise<void>;
}

function makeMockContext(opts: {
  directory: string;
  sessionID: string;
  toasts: MockToast[];
  /** Plugin options handed to the companion — e.g. a configured `stateRoot`. */
  options?: Record<string, unknown>;
  onLayer: (layer: () => {commands?: ReadonlyArray<MockKeymapCommand>}) => void;
  onToolSuccess?: (handler: (event: unknown) => void) => void;
  onAlert?: (opts: {title: string; message: string}) => void;
  onShow?: (render: () => unknown, onClose?: () => void) => void;
  onPrompt?: (opts: {
    title: string;
    placeholder?: string;
  }) => string | undefined;
  onSelect?: (opts: {
    title: string;
    options: ReadonlyArray<{
      title: string;
      value: unknown;
      description?: string;
      category?: string;
      disabled?: boolean;
    }>;
  }) => unknown;
}) {
  return {
    // The v2 companion reads goal state from a CONFIGURED root when told one, and
    // it is a SEPARATE plugin entry from the server plugin, so it can read the
    // wrong root independently. `options` is therefore part of this harness rather
    // than hardcoded — otherwise that wiring is ungated, which is how two
    // defects survived a suite that drove the helpers directly.
    options: {...(opts.options ?? {})},
    location: {directory: opts.directory},
    client: {
      session: {
        synthetic: async () => ({id: 'msg-1'}),
        command: async () => ({}),
        create: async () => ({id: opts.sessionID}),
      },
    },
    keymap: {
      layer: (input: () => {commands?: ReadonlyArray<MockKeymapCommand>}) => {
        opts.onLayer(input);
      },
    },
    ui: {
      dialog: {
        show: (render: () => unknown, onClose?: () => void) => {
          if (opts.onShow) opts.onShow(render, onClose);
        },
        set: () => {},
        clear: () => {},
        alert: async (alertOpts: {title: string; message: string}) => {
          if (opts.onAlert) opts.onAlert(alertOpts);
        },
        confirm: async () => true,
        prompt: async (promptOpts: {title: string; placeholder?: string}) => {
          return opts.onPrompt ? opts.onPrompt(promptOpts) : undefined;
        },
        select: async <V>(selectOpts: {
          title: string;
          placeholder?: string;
          options: ReadonlyArray<{
            title: string;
            value: V;
            description?: string;
            category?: string;
            disabled?: boolean;
          }>;
          current?: V;
        }): Promise<V | undefined> => {
          return opts.onSelect
            ? (opts.onSelect(selectOpts) as V | undefined)
            : undefined;
        },
      },
      toast: {
        show: (toastOpts: MockToast) => {
          opts.toasts.push(toastOpts);
        },
      },
      router: {
        // Throw so dashboardRouteDispose stays null and the dialog fallback
        // path is exercised; the route surface is validated via E2E campaigns.
        register: () => {
          throw new Error('no router in unit test');
        },
        navigate: () => {},
        current: () => ({type: 'session', sessionID: opts.sessionID}),
      },
      format: {path: (v: string) => v},
    },
    data: {
      on: (type: string, handler: (event: unknown) => void) => {
        if (type === 'session.tool.success' && opts.onToolSuccess) {
          opts.onToolSuccess(handler);
        }
        return () => {};
      },
    },
    attention: {
      notify: async () => ({ok: true, notification: false, sound: false}),
    },
  };
}

// THE V2 WIRING GATE, and the reason it lives beside an existing v2 hydration
// test rather than in a suite of its own. The v2 companion resolves the state
// root and then PASSES it to the reader, and those are two facts: a companion can
// resolve the configured root correctly and still hand the reader the default
// one, which is precisely the bug the option exists to prevent and precisely what
// no test driving the reader directly can see. Two of the defects lived
// in that second layer.
//
// The load briefing is the observable, and it is a COUNT by the product's own
// deliberate design rather than a list — so the fixture puts TWO goals in the
// configured root and one decoy in the default, which makes "2 goals need you"
// producible only by reading the configured root.
describe('companion wiring: the CONFIGURED state root reaches the reader', () => {
  test('two goals in a configured root, one decoy in the default: the briefing counts the configured ones', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'v4-rooted-'));
    const stateRoot = join('configured', 'state');
    const toasts: MockToast[] = [];
    try {
      const goal = (id: string, condition: string) => ({
        goalId: id,
        runId: 'r1',
        revision: 1,
        condition,
        status: 'paused' as const,
        stopReason: 'paused',
        sessionID: 'session-rooted',
        turnCount: 1,
        totalTokens: 0,
        maxTokens: 0,
        maxTurns: 0,
        history: [],
      });
      // The SHARED fixture writes this, not a private writer. Both companions'
      // configured-root cases go through `tui-fixture.ts` so the layout, the
      // session directory name and the state envelope cannot drift per suite —
      // the acceptance criterionb states in exactly those terms. The two
      // private copies this replaced were written while the reader's own gate was
      // passing, so nothing noticed they had drifted from the product's shape.
      const envelope = (goals: unknown[]) => ({
        version: 1,
        goals,
        results: [],
        sessionOrdered: [],
        invalidatedGoalIds: [],
        pendingIntents: [],
        settlementReceipts: [],
        focusedGoalIds: [],
      });
      await writeSessionState(
        tmpDir,
        'session-rooted',
        envelope([
          goal('g-cfg-1', 'configured one'),
          goal('g-cfg-2', 'configured two'),
        ]),
        stateRoot,
      );
      // And the decoy in the DEFAULT root, which is what makes the count
      // unambiguous: "2 goals need you" is producible only by reading the
      // configured one.
      await writeSessionState(
        tmpDir,
        'session-rooted',
        envelope([goal('g-decoy', 'a decoy in the DEFAULT root')]),
      );

      const mockContext = makeMockContext({
        directory: tmpDir,
        sessionID: 'session-rooted',
        toasts,
        onLayer: () => {},
        options: {stateRoot},
      });
      const cleanup = await GoalTuiPluginV2.setup(mockContext);
      try {
        // The briefing is emitted after hydration, which is fire-and-forget with
        // a retry — so this polls for it rather than sleeping a guessed interval.
        // A fixed settle is a race wearing a duration.
        let messages = '';
        for (
          let attempt = 0;
          attempt < 40 && !messages.includes('needs you');
          attempt++
        ) {
          await new Promise(r => setTimeout(r, 5));
          messages = toasts.map(t => t.message).join(' | ');
        }
        console.log(`V2-ROOTED-BRIEFING ${messages}`);
        expect(
          messages,
          "the briefing must count the CONFIGURED root's two goals",
        ).toContain('2 goals need you');
        expect(
          messages,
          "so the default root's goal was never read",
        ).not.toContain('1 goal need');
      } finally {
        await cleanup();
      }
    } finally {
      await rm(tmpDir, {recursive: true, force: true});
    }
  }, 30_000);

  // THE LOOP, not the boot read. The test above covers hydration, and hydration
  // had already been passing `opts.stateRoot` — so the v2 companion looked
  // correct while its 1 s refresh loop, a SEPARATE call site into the same
  // reader, still polled the default root forever. The production symptom is
  // the live one: a configured workspace shows its goals at open and then goes
  // quiet. The v1 equivalent gate exists (test/tui-v1-cockpit.test.ts,
  // 58c111f); this one was missing, which is how the same defect survived in one
  // companion after being fixed in the other.
  //
  // A second goal is written to the CONFIGURED root AFTER boot, so only a poll
  // that resolved that root can notice it. An ACTIVE goal rather than a paused
  // one, because the observable is the loop's `create` → curated "Goal started"
  // toast, and a paused goal at boot would only add to the briefing.
  test('the refresh loop keeps reading the CONFIGURED root, so a later goal is noticed', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'v4-rooted-loop-'));
    const stateRoot = join('configured', 'state');
    const toasts: MockToast[] = [];
    try {
      const goal = (
        id: string,
        condition: string,
        status: 'active' | 'paused',
      ) => ({
        goalId: id,
        runId: 'r1',
        revision: 1,
        condition,
        status,
        stopReason: status === 'paused' ? 'paused' : '',
        sessionID: 'session-rooted',
        turnCount: 1,
        totalTokens: 0,
        maxTokens: 0,
        maxTurns: 0,
        history: [],
      });
      const envelope = (goals: unknown[]) => ({
        version: 1,
        goals,
        results: [],
        sessionOrdered: [],
        invalidatedGoalIds: [],
        pendingIntents: [],
        settlementReceipts: [],
        focusedGoalIds: [],
      });
      await writeSessionState(
        tmpDir,
        'session-rooted',
        envelope([
          goal('g-at-boot', 'a goal that was there at boot', 'active'),
        ]),
        stateRoot,
      );

      const mockContext = makeMockContext({
        directory: tmpDir,
        sessionID: 'session-rooted',
        toasts,
        onLayer: () => {},
        options: {stateRoot},
      });
      const cleanup = await GoalTuiPluginV2.setup(mockContext);
      try {
        // Written AFTER boot, to a root only a poll of the CONFIGURED one can see.
        //
        // And REPEATED until observed, because `startDiskLoop` is fire-and-forget:
        // the loop's first tick is its own silent baseline, so a goal written in
        // the instant after `setup` returns can be swallowed INTO that baseline
        // and never produce a `create`. Rewriting the same goal is idempotent for
        // the reader, so one of the writes necessarily lands after the baseline
        // without the test having to guess how long that takes — which is the
        // "a fixed settle is a race wearing a duration" rule applied to the
        // fixture rather than to the assertion.
        const writeLater = async () => {
          await writeSessionState(
            tmpDir,
            'later-session',
            envelope([
              {
                ...goal('g-later', 'a goal that appeared after boot', 'active'),
                sessionID: 'later-session',
              },
            ]),
            stateRoot,
          );
        };

        let sawLater = false;
        for (let attempt = 0; attempt < 200 && !sawLater; attempt++) {
          await new Promise(r => setTimeout(r, 25));
          if (!sawLater) await writeLater();
          sawLater = toasts.some(t =>
            t.message.includes('a goal that appeared after boot'),
          );
        }
        const messages = toasts.map(t => t.message).join(' | ');
        console.log(`V2-ROOTED-LOOP ${messages}`);
        expect(
          sawLater,
          'a goal written to the CONFIGURED root after boot was never picked up — the v2 refresh loop is not reading that root',
        ).toBe(true);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(tmpDir, {recursive: true, force: true});
    }
  }, 30_000);
});

describe('Cockpit Reliability & Truthfulness: Effective-or-Visibly-Failed + Hydration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'goal-cockpit-test-'));
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, {recursive: true, force: true});
    } catch {
      // ignore
    }
  });

  // 1. Hydration from Persisted State

  it('hydrates TuiStateStore from persisted state on disk without data loss', async () => {
    const goalsDir = join(
      tmpDir,
      '.opencode',
      'goals',
      'sessions',
      'session-abc',
    );
    await mkdir(goalsDir, {recursive: true});
    const stateFile = join(goalsDir, 'state.json');

    const persistedState = {
      version: 1,
      goals: [
        {
          goalId: 'goal-auth-1',
          sessionID: 'session-abc',
          condition: 'Implement JWT authentication',
          status: 'active',
          revision: 5,
          turnCount: 4,
          totalTokens: 12500,
          maxTokens: 200000,
          maxTurns: 10,
          tokenBudget: 50000,
          usage: {
            input: 10000,
            output: 2500,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.05,
            costKnown: true,
          },
          stopReason: '',
          blockedReason: '',
          pausedAt: 0,
          stoppedAt: 0,
          createdAt: 1000,
          updatedAt: 5000,
          finishedAt: null,
          lastCheckpoint: {
            summary: 'Tokens generated and verified',
            timestamp: 4000,
          },
          history: [
            {type: 'transition', detail: 'Active progress', timestamp: 2000},
          ],
          claims: [
            {
              claimId: 'claim-1',
              claimText: 'Auth endpoints complete',
              timestamp: 3000,
              actor: 'agent',
              check: {
                path: 'judge',
                timestamp: 3500,
                verdict: 'WORKING',
                details: '1 test failing',
              },
              outcome: {
                status: 'claim-refuted',
                timestamp: 3600,
                details: 'verifier failed',
              },
            },
          ],
        },
      ],
      results: [],
      sessionOrdered: false,
    };

    await writeFile(stateFile, JSON.stringify(persistedState, null, 2), 'utf8');

    const store = createTuiStateStore();
    const result = await hydrateStoreFromDisk(store, tmpDir);

    expect(result.hydratedCount).toBe(1);
    expect(result.error).toBeUndefined();

    const snapshots = store.getSnapshots('session-abc');
    expect(snapshots.length).toBe(1);
    const g = snapshots[0];
    expect(g.goalId).toBe('goal-auth-1');
    expect(g.condition).toBe('Implement JWT authentication');
    expect(g.status).toBe('active');
    expect(g.revision).toBe(5);
    expect(g.tokenBudget).toBe(50000);
    expect(g.lastCheckpoint?.summary).toBe('Tokens generated and verified');
    expect(g.claims?.length).toBe(1);
    expect(g.claims?.[0].outcome.status).toBe('claim-refuted');
  });

  it('handles missing state files gracefully without throwing or corrupting store', async () => {
    const store = createTuiStateStore();
    const result = await hydrateStoreFromDisk(
      store,
      join(tmpDir, 'non-existent-dir'),
    );
    expect(result.hydratedCount).toBe(0);
    expect(result.error).toBeUndefined();
    expect(store.getSnapshots('any-session')).toEqual([]);
  });

  // 2. Action Outcome Tracking & Watchdog

  /**
   * Seed a session with ONE goal so a palette key has something to NAME.
   *
   * changed what a key does when the session holds no goal of its own: it steers
   * nothing rather than falling back to the focused goal. That is the fix, and it makes an
   * empty workspace a legitimate no-op — so a test whose subject is "the key dispatched
   * something" now has to give it a goal, or it is asserting the behaviour that was
   * defective. The control for the new behaviour lives in `test/tui-v2-dispatch.test.ts`,
   * which drives the same keys against a deliberately empty workspace.
   *
   * Written through the SHARED fixture for the reason the configured-root cases name: the
   * layout, the session directory name and the state envelope must not drift per suite,
   * and two private copies of this writer already existed here and had.
   */
  async function seedSessionWithGoal(
    sessionID: string,
    goalId: string,
  ): Promise<void> {
    await writeSessionState(tmpDir, sessionID, {
      version: 1,
      goals: [
        {
          goalId,
          runId: 'r1',
          revision: 1,
          condition: 'a goal for the key to name',
          status: 'paused',
          stopReason: 'paused',
          sessionID,
          turnCount: 1,
          totalTokens: 0,
          maxTokens: 0,
          maxTurns: 0,
          history: [],
        },
      ],
      results: [],
      sessionOrdered: [],
      invalidatedGoalIds: [],
      pendingIntents: [],
      settlementReceipts: [],
      focusedGoalIds: [],
    });
  }

  /**
   * Wait until the COMPANION has hydrated the seeded goal into its own store.
   *
   * `setup` does not hydrate synchronously — it polls the workspace every 350 ms
   * (`ensureHydrated`), so a key pressed immediately finds an empty store and no-ops. The
   * wait is on the companion's own OBSERVABLE effect, the load briefing toast it raises
   * once a stopped goal is on screen, rather than on a duration: the file being readable is
   * not the claim, the companion having read it is. A fixed settle here is a race wearing a
   * timeout — it passes on a fast machine and fails on a slow one, which is the opposite of
   * what a gate should do.
   */
  async function waitForCompanionGoal(
    toasts: MockToast[],
    goalId: string,
  ): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (toasts.some(t => t.message.includes('needs you'))) return;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(
      `the companion never hydrated ${goalId}: toasts=${toasts.map(t => t.message).join(' | ')}`,
    );
  }

  it('surfaces honest failure toast when an action is dispatched but unconfirmed within timeout', async () => {
    const toasts: MockToast[] = [];
    let layerFn: (() => {commands?: ReadonlyArray<MockKeymapCommand>}) | null =
      null;

    const mockContext = makeMockContext({
      directory: tmpDir,
      sessionID: 'session-xyz',
      toasts,
      onLayer: l => {
        layerFn = l;
      },
    });

    await seedSessionWithGoal('session-xyz', 'goal-watchdog');
    const cleanup = await GoalTuiPluginV2.setup(mockContext);
    await waitForCompanionGoal(toasts, 'goal-watchdog');
    expect(typeof cleanup).toBe('function');
    expect(layerFn).not.toBeNull();

    const layer = layerFn!();
    const pauseCmd = layer.commands?.find(c => c.id === 'fixate-on.pause');
    expect(pauseCmd).toBeDefined();

    // Execute pause command
    await pauseCmd!.run();

    // 1. Emits initial outcome-neutral requested toast
    expect(
      toasts.some(
        t => t.message === 'Goal requested: pause' && t.variant === 'info',
      ),
    ).toBe(true);

    cleanup();
  });

  it('disarms watchdog when tool.success confirmation event arrives', async () => {
    const toasts: MockToast[] = [];
    let toolSuccessHandler: ((event: unknown) => void) | null = null;
    let layerFn: (() => {commands?: ReadonlyArray<MockKeymapCommand>}) | null =
      null;

    const mockContext = makeMockContext({
      directory: tmpDir,
      sessionID: 'session-xyz',
      toasts,
      onLayer: l => {
        layerFn = l;
      },
      onToolSuccess: h => {
        toolSuccessHandler = h;
      },
    });

    const cleanup = await GoalTuiPluginV2.setup(mockContext);
    const layer = layerFn!();
    const resumeCmd = layer.commands?.find(c => c.id === 'fixate-on.resume');
    expect(resumeCmd).toBeDefined();

    await resumeCmd!.run();

    // Confirm execution via tool.success event
    const snapshot: GoalTuiSnapshot = {
      goalId: 'goal-1',
      sessionID: 'session-xyz',
      condition: 'Test goal',
      status: 'active',
      revision: 2,
      turnCount: 1,
      totalTokens: 100,
      maxTokens: 200000,
      maxTurns: 10,
      tokenBudget: null,
      usage: {
        input: 80,
        output: 20,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        costKnown: false,
      },
      stopReason: '',
      blockedReason: '',
      pausedAt: 0,
      stoppedAt: 0,
      createdAt: 1000,
      updatedAt: 2000,
      finishedAt: null,
      lastCheckpoint: null,
      history: [],
    };

    const meta = encodeGoalToolMetadata([
      {
        kind: 'transition',
        sessionID: 'session-xyz',
        timestamp: Date.now(),
        snapshot,
      },
    ]);

    expect(toolSuccessHandler).not.toBeNull();
    toolSuccessHandler!({data: {metadata: meta}});

    // No warning toast should be logged
    const warningToasts = toasts.filter(t => t.variant === 'warning');
    expect(warningToasts.length).toBe(0);

    cleanup();
  });

  // 3. Hydrated Dashboard & Truthful Displays

  it('hydrates before opening interactive dashboard when store is initially empty', async () => {
    const goalsDir = join(
      tmpDir,
      '.opencode',
      'goals',
      'sessions',
      'session-dash',
    );
    await mkdir(goalsDir, {recursive: true});
    const stateFile = join(goalsDir, 'state.json');

    const persistedState = {
      version: 1,
      goals: [
        {
          goalId: 'goal-hydrated-1',
          sessionID: 'session-dash',
          condition: 'Fix all failing tests',
          status: 'active',
          revision: 1,
          turnCount: 0,
          totalTokens: 0,
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
          stopReason: '',
          blockedReason: '',
          createdAt: 1000,
          updatedAt: 1000,
          finishedAt: null,
          lastCheckpoint: null,
          history: [],
        },
      ],
      results: [],
      sessionOrdered: false,
    };

    await writeFile(stateFile, JSON.stringify(persistedState, null, 2), 'utf8');

    let showCalled = false;
    let selectTitle = '';
    let selectOptions: ReadonlyArray<{title: string; value: unknown}> = [];
    let layerFn: (() => {commands?: ReadonlyArray<MockKeymapCommand>}) | null =
      null;

    const mockContext = makeMockContext({
      directory: tmpDir,
      sessionID: 'session-dash',
      toasts: [],
      onLayer: l => {
        layerFn = l;
      },
      onShow: () => {
        showCalled = true;
      },
      onSelect: s => {
        selectTitle = s.title;
        selectOptions = s.options;
        return undefined;
      },
    });

    const cleanup = await GoalTuiPluginV2.setup(mockContext);
    const layer = layerFn!();

    const dashCmd = layer.commands?.find(c => c.id === 'fixate-on.dashboard');
    expect(dashCmd).toBeDefined();
    await dashCmd!.run();
    expect(showCalled).toBe(true);

    const focusCmd = layer.commands?.find(c => c.id === 'fixate-on.focus');
    expect(focusCmd).toBeDefined();
    await focusCmd!.run();
    expect(selectTitle).toBe('Focus Goal');
    expect(selectOptions.length).toBe(1);
    expect(selectOptions[0].title).toContain('Fix all failing tests');
    expect(selectOptions[0].value).toBe('goal-hydrated-1');

    cleanup();
  });

  it('hydrates before opening focus goal selector and presents disk goals', async () => {
    const goalsDir = join(
      tmpDir,
      '.opencode',
      'goals',
      'sessions',
      'session-focus',
    );
    await mkdir(goalsDir, {recursive: true});
    const stateFile = join(goalsDir, 'state.json');

    const persistedState = {
      version: 1,
      goals: [
        {
          goalId: 'goal-hydrated-focus',
          sessionID: 'session-focus',
          condition: 'Port legacy auth module',
          status: 'active',
          revision: 1,
          turnCount: 0,
          totalTokens: 0,
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
          stopReason: '',
          blockedReason: '',
          createdAt: 1000,
          updatedAt: 1000,
          finishedAt: null,
          lastCheckpoint: null,
          history: [],
        },
      ],
      results: [],
      sessionOrdered: false,
    };

    await writeFile(stateFile, JSON.stringify(persistedState, null, 2), 'utf8');

    let selectTitle = '';
    let selectOptions: ReadonlyArray<{
      title: string;
      value: unknown;
      description?: string;
      category?: string;
      disabled?: boolean;
    }> = [];
    let layerFn: (() => {commands?: ReadonlyArray<MockKeymapCommand>}) | null =
      null;

    const mockContext = makeMockContext({
      directory: tmpDir,
      sessionID: 'session-focus',
      toasts: [],
      onLayer: l => {
        layerFn = l;
      },
      onSelect: s => {
        selectTitle = s.title;
        selectOptions = s.options;
        return 'goal-hydrated-focus';
      },
    });

    const cleanup = await GoalTuiPluginV2.setup(mockContext);
    const layer = layerFn!();
    const focusCmd = layer.commands?.find(c => c.id === 'fixate-on.focus');
    expect(focusCmd).toBeDefined();

    await focusCmd!.run();

    expect(selectTitle).toBe('Focus Goal');
    expect(selectOptions.length).toBe(1);
    expect(selectOptions[0].title).toContain('Port legacy auth module');
    expect(selectOptions[0].value).toBe('goal-hydrated-focus');

    cleanup();
  });

  it('enforces outcome neutrality across all mutating palette commands', async () => {
    const toasts: MockToast[] = [];
    let layerFn: (() => {commands?: ReadonlyArray<MockKeymapCommand>}) | null =
      null;

    const mockContext = makeMockContext({
      directory: tmpDir,
      sessionID: 'session-mut',
      toasts,
      onLayer: l => {
        layerFn = l;
      },
      onPrompt: opts => {
        if (opts.title === 'Edit Goal') return 'New objective';
        if (opts.title === 'Save Checkpoint') return 'New checkpoint';
        if (opts.title === 'Add New Goal') return 'Added goal';
        if (opts.title === 'Start Goal Sequence') return 'Seq 1; Seq 2';
        return undefined;
      },
    });

    await seedSessionWithGoal('session-mut', 'goal-mut');
    const cleanup = await GoalTuiPluginV2.setup(mockContext);
    await waitForCompanionGoal(toasts, 'goal-mut');
    const layer = layerFn!();

    const clearCmd = layer.commands?.find(c => c.id === 'fixate-on.clear');
    const listCmd = layer.commands?.find(c => c.id === 'fixate-on.list');
    const histCmd = layer.commands?.find(c => c.id === 'fixate-on.history');
    const editCmd = layer.commands?.find(c => c.id === 'fixate-on.edit');
    const ckptCmd = layer.commands?.find(c => c.id === 'fixate-on.checkpoint');
    const addCmd = layer.commands?.find(c => c.id === 'fixate-on.add');
    const seqCmd = layer.commands?.find(c => c.id === 'fixate-on.sequence');

    await clearCmd!.run();
    await listCmd!.run();
    await histCmd!.run();
    await editCmd!.run();
    await ckptCmd!.run();
    await addCmd!.run();
    await seqCmd!.run();

    expect(toasts.some(t => t.message === 'Goal requested: clear')).toBe(true);
    expect(toasts.some(t => t.message === 'Goal requested: list')).toBe(true);
    expect(toasts.some(t => t.message === 'Goal requested: history')).toBe(
      true,
    );
    expect(toasts.some(t => t.message === 'Goal requested: edit')).toBe(true);
    expect(toasts.some(t => t.message === 'Goal requested: checkpoint')).toBe(
      true,
    );
    expect(toasts.some(t => t.message === 'Goal requested: add')).toBe(true);
    expect(toasts.some(t => t.message === 'Goal requested: sequence')).toBe(
      true,
    );

    // Ensure zero false-success toasts claiming state was mutated before tool execution
    const falseSuccessToasts = toasts.filter(
      t =>
        t.message.includes('cleared') ||
        t.message.includes('added successfully'),
    );
    expect(falseSuccessToasts.length).toBe(0);

    cleanup();
  });
});
