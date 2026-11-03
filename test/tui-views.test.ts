// tui-views.test.ts — Contract tests for the TUI dashboard formatting and
// toast system.
//
// Verifies: the dashboard renders a formatted summary from the TuiStateStore,
// and toast notifications fire for judge/recovery events.
//
// Since the @opentui/* packages are not installed, these tests use mock
// TuiPluginApi objects to verify the view logic — NOT JSX rendering (which
// requires the opentui runtime). The contract is: given a TuiStateStore with
// known state, the dashboard formatter produces the expected text output.

import {describe, expect, test} from 'bun:test';
import {
  formatGoalStatusDashboard,
  formatHistoryList,
  formatTokenGauge,
} from '../src/tui-views.ts';
import {createToastManager, type ToastInput} from '../src/tui-components.ts';
import {
  createTuiStateStore,
  type GoalTuiSnapshot,
  serializeGoalForTui,
} from '../src/tui-state.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';

// Helpers

function makeSnapshot(
  overrides: Partial<GoalTuiSnapshot> = {},
): GoalTuiSnapshot {
  return {
    goalId: 'g1',
    sessionID: 's1',
    condition: 'fix the failing tests',
    status: 'active',
    revision: 1,
    turnCount: 3,
    totalTokens: 12400,
    maxTokens: 200000,
    maxTurns: 10,
    tokenBudget: null,
    usage: {
      input: 100,
      output: 50,
      reasoning: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.02,
      costKnown: true,
    },
    stopReason: '',
    blockedReason: '',
    pausedAt: 0,
    stoppedAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
    ...overrides,
  };
}

// formatGoalStatusDashboard

describe('formatGoalStatusDashboard', () => {
  test('renders a dashboard with goal objective and status', () => {
    const sections = formatGoalStatusDashboard([makeSnapshot()]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('fix the failing tests');
    expect(text).toContain('active');
  });

  test('renders turn count and token usage', () => {
    const sections = formatGoalStatusDashboard([
      makeSnapshot({turnCount: 5, totalTokens: 50000}),
    ]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('5');
    expect(text).toContain('50,000');
  });

  test('renders multiple goals', () => {
    const goals = [
      makeSnapshot({goalId: 'g1', condition: 'fix tests'}),
      makeSnapshot({goalId: 'g2', condition: 'add docs', status: 'paused'}),
    ];
    const sections = formatGoalStatusDashboard(goals);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('fix tests');
    expect(text).toContain('add docs');
    expect(text).toContain('paused');
  });

  test('renders empty state when no goals exist', () => {
    const sections = formatGoalStatusDashboard([]);
    const text = sections.map(s => s.text).join('\n');
    expect(text.toLowerCase()).toContain('no active goals');
  });

  test('renders blocked reason when present', () => {
    const sections = formatGoalStatusDashboard([
      makeSnapshot({status: 'blocked', blockedReason: 'missing dependency'}),
    ]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('blocked');
    expect(text).toContain('missing dependency');
  });

  test('renders stop reason when present', () => {
    const sections = formatGoalStatusDashboard([
      makeSnapshot({status: 'paused', stopReason: 'user paused'}),
    ]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('user paused');
  });

  test('renders checkpoint when present', () => {
    const sections = formatGoalStatusDashboard([
      makeSnapshot({
        lastCheckpoint: {
          summary: 'step 1 complete',
          timestamp: 1700000000000,
        },
      }),
    ]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('step 1 complete');
  });

  test('renders history entries', () => {
    const sections = formatGoalStatusDashboard([
      makeSnapshot({
        history: [
          {type: 'paused', detail: 'user paused', timestamp: 1700000000000},
          {type: 'active', detail: 'resumed', timestamp: 1700000001000},
        ],
      }),
    ]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('user paused');
    expect(text).toContain('resumed');
  });

  test('sections have titles for structure', () => {
    const sections = formatGoalStatusDashboard([makeSnapshot()]);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.title).toBeDefined();
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.text).toBeDefined();
    }
  });

  test('formats token count with thousands separators', () => {
    const sections = formatGoalStatusDashboard([
      makeSnapshot({totalTokens: 1234567}),
    ]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('1,234,567');
  });
});

// formatTokenGauge

describe('formatTokenGauge', () => {
  test('renders a percentage gauge', () => {
    const gauge = formatTokenGauge(50000, 200000);
    expect(gauge).toContain('25%');
  });

  test('renders the usage percentage and both bounds', () => {
    const gauge = formatTokenGauge(100000, 200000);
    expect(gauge).toContain('50%');
    expect(gauge).toContain('100,000');
    expect(gauge).toContain('200,000');
  });

  test('handles zero usage', () => {
    const gauge = formatTokenGauge(0, 200000);
    expect(gauge).toContain('0%');
  });

  test('handles usage exceeding budget', () => {
    const gauge = formatTokenGauge(250000, 200000);
    expect(gauge).toContain('125%');
  });

  test('includes both used and max tokens', () => {
    const gauge = formatTokenGauge(50000, 200000);
    expect(gauge).toContain('50,000');
    expect(gauge).toContain('200,000');
  });
});

// formatHistoryList

describe('formatHistoryList', () => {
  test('formats history entries with type and detail', () => {
    const text = formatHistoryList([
      {type: 'paused', detail: 'user paused', timestamp: 1700000000000},
      {type: 'active', detail: 'resumed', timestamp: 1700000001000},
    ]);
    expect(text).toContain('paused');
    expect(text).toContain('user paused');
    expect(text).toContain('active');
    expect(text).toContain('resumed');
  });

  test('returns empty indicator for no history', () => {
    const text = formatHistoryList([]);
    expect(text.toLowerCase()).toContain('no lifecycle events');
  });
});

// createToastManager

describe('createToastManager', () => {
  test('creates a toast manager with a toast function', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    expect(typeof manager.toast).toBe('function');
  });

  test('toast with info variant for create events', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    manager.toastGoalCreated('fix the tests');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('info');
    expect(toasts[0].message).toContain('fix the tests');
  });

  test('toast with success variant for completion events', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    manager.toastGoalComplete('fix the tests');
    expect(toasts[0].variant).toBe('success');
  });

  test('toast with warning variant for blocked events', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    manager.toastGoalBlocked('missing dependency');
    expect(toasts[0].variant).toBe('warning');
    expect(toasts[0].message).toContain('missing dependency');
  });

  test('toast with error variant for budget-limited events', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    manager.toastBudgetLimited('token budget exhausted');
    expect(toasts[0].variant).toBe('error');
  });

  test('toast with warning variant for judge-rejected events', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    manager.toastJudgeRejected('tests still failing');
    expect(toasts[0].variant).toBe('warning');
  });

  test('toast with info variant for recovery events', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    manager.toastRecovery('attempting recovery (turn 3/12)');
    expect(toasts[0].variant).toBe('info');
  });

  test('toast includes a title identifying the plugin', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    manager.toastGoalCreated('test');
    expect(toasts[0].title).toBeDefined();
    expect(toasts[0].title!.length).toBeGreaterThan(0);
  });

  test('toast message is truncated to 500 characters', () => {
    const toasts: ToastInput[] = [];
    const manager = createToastManager({
      showToast: (input: ToastInput) => {
        toasts.push(input);
      },
    });
    const longMessage = 'x'.repeat(600);
    manager.toastGoalCreated(longMessage);
    expect(toasts[0].message.length).toBeLessThanOrEqual(500);
  });
});

// End-to-end: store → dashboard

describe('end-to-end: store → dashboard', () => {
  test('dashboard reflects store state after event application', () => {
    const store = createTuiStateStore();
    // Apply a create event
    const snapshot = serializeGoalForTui(
      new GoalStateMachine(
        createGoalState('s1', 'build the feature'),
      ).snapshot(),
    );
    store.applyEvent({
      kind: 'create',
      sessionID: 's1',
      snapshot,
      timestamp: Date.now(),
    });

    // Format dashboard from store state
    const goals = store.getSnapshots('s1');
    const sections = formatGoalStatusDashboard(goals);
    const text = sections.map(s => s.text).join('\n');

    expect(text).toContain('build the feature');
    expect(text).toContain('active');
  });
});

// TURNS-GAUGE-1: a DISABLED limit must not render as a zero denominator
//
// the user reported the dashboard showing "Turns: 3 / 0". Root cause: the turn brake
// is now disabled by default (maxTurns 0 means "no turn brake"), but the detail
// card and the token gauge printed the raw limit. `/goal status` (commands.ts)
// and the idle prompt (hooks.ts) already render "∞"/"unlimited" for a
// non-positive limit; these surfaces were the ones that did not.

describe('a disabled limit renders as unlimited', () => {
  test("formatTokenGauge reports 'unlimited' rather than a 0 denominator", () => {
    const gauge = formatTokenGauge(1200, 0);
    expect(gauge).toContain('unlimited');
    expect(gauge).not.toMatch(/\/\s*0\b/);
  });

  test('formatTokenGauge still renders a real limit', () => {
    const gauge = formatTokenGauge(50000, 200000);
    expect(gauge).toContain('200,000');
    expect(gauge).not.toContain('unlimited');
  });

  const dashboardText = (overrides: Partial<GoalTuiSnapshot> = {}): string =>
    formatGoalStatusDashboard([makeSnapshot(overrides)])
      .map(section => section.text ?? '')
      .join('\n');

  test("the goal detail card renders 'unlimited' turns when the brake is disabled", () => {
    const text = dashboardText({turnCount: 3, maxTurns: 0});
    expect(text).toContain('Turns:      3 / unlimited');
    expect(text).not.toContain('3 / 0');
  });

  test('the goal detail card still renders a real turn limit', () => {
    expect(dashboardText({turnCount: 3, maxTurns: 10})).toContain(
      'Turns:      3 / 10',
    );
  });
});

describe('the cockpit detail card never renders a zero denominator', () => {
  // TURNS-GAUGE-1. `Turns: 3 / 0` reads as a limit of zero — a goal already over
  // budget — when the truth is that the turn brake is DISABLED. The live stock-v1
  // run proved the /goal status surface prints `1/∞`; this locks the COCKPIT
  // DETAIL CARD, whose live capture needs the palette navigation that is a known
  // failure, so it is checked here rather than claimed from a capture I could
  // not take.
  test("a disabled turn brake reads 'unlimited', not a zero denominator", () => {
    const sections = formatGoalStatusDashboard([
      makeSnapshot({turnCount: 3, maxTurns: 0}),
    ]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('3 / unlimited');
    expect(text).not.toContain('3 / 0');
  });

  test('a REAL turn limit still renders N / M', () => {
    const sections = formatGoalStatusDashboard([
      makeSnapshot({turnCount: 3, maxTurns: 25}),
    ]);
    const text = sections.map(s => s.text).join('\n');
    expect(text).toContain('3 / 25');
  });
});
