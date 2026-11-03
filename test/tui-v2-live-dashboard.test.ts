// tui-v2-live-dashboard.test.ts — Contract test for the LIVE reactive v2
// dashboard (permanent tail #14(a): "verify the dashboard updates live via a
// PTY probe once server plugins load" — the cheap, deterministic layer of that
// check).
//
// The v2 dashboard is a dialog.alert that refreshes in place: every decoded
// goal event for the ACTIVE session re-invokes alert with fresh content.
// Host mechanics (packages/tui/src/plugin/api.tsx + ui/dialog.tsx): Dialog
// `show` → `replace` swaps the dialog stack to a single fresh element IN
// PLACE, so re-alerting reads as a live update, not a dialog flash.
// Crucially, alert's promise resolves BOTH on genuine user close AND when a
// refresh replaces the stale dialog (replace fires the old item's onClose →
// the old `done`). A generation token in the plugin separates those: only a
// resolution observed against the CURRENT generation closes the dashboard.
//
// This test models the host precisely:
// - alert records every call; each NEW alert resolves the PREVIOUS alert's
// promise (the host replace firing the stale dialog's onClose).
// - resolveCurrent resolves the CURRENT alert's promise (user esc/ok).
//
// It drives the plugin through the same surface a user would — run the
// `Goal: Dashboard` palette command, then inject `session.tool.success`
// envelopes via the data.on subscription — and asserts that dialog content
// tracks the active session's store while staying open, ignores other-session
// traffic, and stops refreshing once genuinely closed.

import {expect, test} from 'bun:test';
import GoalTuiPluginV2 from '../src/tui-v2.ts';
import {
  encodeGoalToolMetadata,
  type GoalTuiEvent,
  type GoalTuiSnapshot,
} from '../src/tui-state.ts';

// Snapshot helper (satisfies the GoalTuiSnapshot contract)

function makeSnapshot(
  overrides: Partial<GoalTuiSnapshot> = {},
): GoalTuiSnapshot {
  return {
    goalId: 'g1',
    sessionID: 'test-session-123',
    condition: 'fix the failing tests',
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
    pausedAt: 0,
    stoppedAt: 0,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<GoalTuiEvent> = {}): GoalTuiEvent {
  return {
    kind: 'create',
    sessionID: 'test-session-123',
    timestamp: 1,
    snapshot: makeSnapshot(),
    ...overrides,
  };
}

// Mock V2Context

interface AlertRecord {
  title: string;
  message: string;
}

interface V2Command {
  id: string;
  run: (input?: string, event?: unknown) => void | boolean | Promise<void>;
}

function createMockContext() {
  const handlers = new Map<string, (event: unknown) => void>();
  const alertCalls: Array<{alert: AlertRecord; resolve: () => void}> = [];
  const showCalls: Array<{onClose?: () => void}> = [];
  const toasts: {variant?: string; title?: string; message: string}[] = [];
  let capturedCommands: V2Command[] = [];
  let route: {type: string; sessionID?: string} = {
    type: 'session',
    sessionID: 'test-session-123',
  };

  // alert records the call and returns a pending promise. When a NEWER
  // alert is invoked, the PREVIOUS alert's promise is resolved — modeling
  // the host dialog.replace firing the superseded dialog's onClose. The
  // stored resolve additionally lets the test simulate a GENUINE user close
  // of the currently displayed alert via resolveCurrent.
  const dialog = {
    alert: (opts: {title: string; message: string}): Promise<void> => {
      return new Promise(resolve => {
        const prev = alertCalls.at(-1);
        alertCalls.push({
          alert: {title: opts.title, message: opts.message},
          resolve,
        });
        if (prev) prev.resolve(); // refresh replaced the previous dialog
      });
    },
    confirm: async () => true, // unused by dashboard
    prompt: async () => undefined, // unused by dashboard
    select: async () => undefined, // unused by dashboard
    show: (_render: () => unknown, onClose?: () => void) => {
      const prev = showCalls.at(-1);
      showCalls.push({onClose});
      if (prev?.onClose) prev.onClose(); // replace fires previous onClose
    },
    set: () => {},
    clear: () => {},
  };

  const ctx = {
    options: {logLevel: 'error'},
    client: {
      session: {
        synthetic: async () => ({}),
        command: async () => ({}),
        create: async () => ({id: 'created-session-abc'}),
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
        // Throw so dashboardRouteDispose stays null and the dialog fallback
        // path is exercised. The route path is validated via E2E campaigns.
        register: () => {
          throw new Error('no router in unit test');
        },
        navigate: () => {},
        current: () => route,
      },
      tabs: {
        enabled: () => false,
        open: () => false,
      },
      format: {path: (v: string) => v},
    },
    data: {
      on: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, handler);
        return () => {
          handlers.delete(type);
        };
      },
    },
    attention: {
      notify: async () => ({ok: true, notification: false, sound: false}),
    },
  };

  const stub = ctx as unknown as Parameters<typeof GoalTuiPluginV2.setup>[0];
  return {
    stub,
    getCommands: () => capturedCommands,
    find: (id: string) => capturedCommands.find(c => c.id === id),
    alerts: () => alertCalls.map(c => c.alert),
    resolveCurrent: () => {
      const cur = alertCalls.at(-1);
      if (cur) cur.resolve();
    },
    showCount: () => showCalls.length,
    closeCurrentShow: () => {
      const cur = showCalls.at(-1);
      if (cur?.onClose) cur.onClose();
    },
    toastCount: () => toasts.length,
    setRoute: (r: {type: string; sessionID?: string}) => {
      route = r;
    },
    // Inject a goal event batch exactly as host SSE delivery would.
    emitEvents: (events: GoalTuiEvent[]) => {
      const handler = handlers.get('session.tool.success');
      expect(
        handler,
        'session.tool.success subscription should exist',
      ).toBeTypeOf('function');
      handler!({data: {metadata: encodeGoalToolMetadata(events)}});
    },
  };
}

// Drain alert promise-resolution microtasks so close state settles
// deterministically before asserting on subsequent behavior.
// Macrotask FLUSH (0 ms), not a timing guess: yields so already-scheduled
// macrotasks run. Deliberate — do not "convert" to waitFor (there is no
// condition to await; the point is to drain the queue).
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('live dashboard tracks active-session events, stays open while replaced, and stops when closed', async () => {
  const h = createMockContext();
  const dispose = await GoalTuiPluginV2.setup(h.stub);
  try {
    // 0. Open the dashboard with an empty store → show #1 (dialog.show).
    const dash = h.find('fixate-on.dashboard')!;
    expect(dash).toBeTruthy();
    await dash.run();
    await flush();
    expect(h.showCount()).toBe(1);

    // 1. A create event lands for the active session → live refresh (show #2).
    // The host dialog.replace fires the previous onClose, but our generation
    // token prevents the stale close from marking the dashboard closed.
    h.emitEvents([
      makeEvent({
        snapshot: makeSnapshot({
          goalId: 'g1',
          condition: 'fix the integration flake',
          status: 'active',
          revision: 2,
        }),
      }),
    ]);
    await flush();
    expect(h.showCount()).toBe(2);

    // 2. A transition event for the same session → ANOTHER refresh (show #3).
    // The stale onClose from step 1 did NOT close the dashboard.
    h.emitEvents([
      makeEvent({
        kind: 'transition',
        snapshot: makeSnapshot({
          goalId: 'g1',
          condition: 'fix the integration flake',
          status: 'paused',
          revision: 3,
        }),
        transition: {
          source: 'slash-command',
          from: 'active',
          to: 'paused',
          detail: 'user paused the goal',
        },
      }),
    ]);
    await flush();
    expect(h.showCount()).toBe(3);

    // 3. Traffic for a DIFFERENT session must NOT refresh the live dashboard.
    h.emitEvents([
      makeEvent({
        sessionID: 'other-session-999',
        snapshot: makeSnapshot({
          goalId: 'g2',
          sessionID: 'other-session-999',
          condition: 'unrelated goal',
          revision: 1,
        }),
      }),
    ]);
    await flush();
    expect(h.showCount()).toBe(3); // no repaint for other session

    // 4. A GENUINE user close (onClose of the current show) closes the
    // dashboard. Subsequent events for the active session do NOT revive it.
    h.closeCurrentShow();
    await flush();
    h.emitEvents([
      makeEvent({
        kind: 'transition',
        snapshot: makeSnapshot({
          goalId: 'g1',
          condition: 'fix the integration flake',
          status: 'active',
          revision: 4,
        }),
        transition: {
          source: 'slash-command',
          from: 'paused',
          to: 'active',
          detail: 'user resumed the goal',
        },
      }),
    ]);
    await flush();
    expect(h.showCount()).toBe(3); // closed → no show #4
  } finally {
    dispose();
  }
});
