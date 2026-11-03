// tui-analytics.test.ts — Contract tests for token cost analytics.
//
// Verifies: cost computation, budget projection, ETA estimation,
// edge cases (zero turns, no budget, unknown cost), and
// formatting helpers.

import {describe, expect, test} from 'bun:test';
import {
  computeAnalytics,
  formatAnalyticsSummary,
  formatBudgetWarning,
} from '../src/tui-analytics.ts';
import type {GoalTuiSnapshot} from '../src/tui-state.ts';

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
    turnCount: 5,
    totalTokens: 50000,
    maxTokens: 200000,
    maxTurns: 10,
    tokenBudget: null,
    usage: {
      input: 30000,
      output: 15000,
      reasoning: 3000,
      cacheRead: 0,
      cacheWrite: 2000,
      cost: 0.5,
      costKnown: true,
    },
    stopReason: '',
    blockedReason: '',
    pausedAt: 0,
    stoppedAt: 0,
    createdAt: Date.now() - 300000, // 5 minutes ago
    updatedAt: Date.now(),
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
    ...overrides,
  };
}

// computeAnalytics

describe('computeAnalytics', () => {
  test('computes charged tokens from usage fields', () => {
    const a = computeAnalytics(makeSnapshot());
    // charged = input + output + reasoning + cacheWrite
    expect(a.chargedTokens).toBe(30000 + 15000 + 3000 + 2000);
  });

  test('computes budget percentage when tokenBudget is set', () => {
    const a = computeAnalytics(makeSnapshot({tokenBudget: 100000}));
    // charged = 50000, budget = 100000 → 50%
    expect(a.budgetPercentage).toBe(50);
  });

  test('returns null budgetPercentage when no tokenBudget', () => {
    const a = computeAnalytics(makeSnapshot());
    expect(a.budgetPercentage).toBeNull();
  });

  test('computes tokens per turn', () => {
    const a = computeAnalytics(
      makeSnapshot({turnCount: 5, totalTokens: 50000}),
    );
    expect(a.tokensPerTurn).toBe(10000);
  });

  test('tokens per turn is 0 when turnCount is 0', () => {
    const a = computeAnalytics(makeSnapshot({turnCount: 0, totalTokens: 0}));
    expect(a.tokensPerTurn).toBe(0);
  });

  test('uses charged tokens rather than cache-read context for budget forecasts', () => {
    const a = computeAnalytics(
      makeSnapshot({
        turnCount: 1,
        totalTokens: 10160,
        tokenBudget: 1000,
        usage: {
          input: 100,
          output: 40,
          reasoning: 0,
          cacheRead: 10000,
          cacheWrite: 20,
          cost: 0,
          costKnown: false,
        },
      }),
    );
    expect(a.tokensPerTurn).toBe(160);
    expect(a.turnsRemaining).toBe(5);
  });

  test('computes projected total tokens at maxTurns', () => {
    const a = computeAnalytics(
      makeSnapshot({turnCount: 5, totalTokens: 50000, maxTurns: 10}),
    );
    // tokensPerTurn = 10000, maxTurns = 10 → 100000
    expect(a.projectedTotalTokens).toBe(100000);
  });

  test('projected total is null when turnCount is 0', () => {
    const a = computeAnalytics(makeSnapshot({turnCount: 0, totalTokens: 0}));
    expect(a.projectedTotalTokens).toBeNull();
  });

  test('computes turns remaining before budget exhaustion', () => {
    const a = computeAnalytics(
      makeSnapshot({tokenBudget: 100000, turnCount: 5, totalTokens: 50000}),
    );
    // charged = 50000, budget = 100000, tokensPerTurn = 10000
    // turnsRemaining = floor((100000 - 50000) / 10000) = 5
    expect(a.turnsRemaining).toBe(5);
  });

  test('turns remaining is 0 when budget exceeded', () => {
    const a = computeAnalytics(
      makeSnapshot({tokenBudget: 40000, turnCount: 5, totalTokens: 50000}),
    );
    // charged = 50000 > budget = 40000
    expect(a.turnsRemaining).toBe(0);
  });

  test('turns remaining is null when no budget', () => {
    const a = computeAnalytics(makeSnapshot());
    expect(a.turnsRemaining).toBeNull();
  });

  test('computes cost per turn when cost is known', () => {
    const a = computeAnalytics(
      makeSnapshot({
        turnCount: 5,
        usage: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.5,
          costKnown: true,
        },
      }),
    );
    expect(a.costPerTurn).toBeCloseTo(0.1, 2);
  });

  test('cost per turn is 0 when cost is unknown', () => {
    const a = computeAnalytics(
      makeSnapshot({
        usage: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          costKnown: false,
        },
      }),
    );
    expect(a.costPerTurn).toBe(0);
  });

  test('computes projected total cost at maxTurns', () => {
    const a = computeAnalytics(
      makeSnapshot({
        turnCount: 5,
        maxTurns: 10,
        usage: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.5,
          costKnown: true,
        },
      }),
    );
    // costPerTurn = 0.10, maxTurns = 10 → 1.00
    expect(a.projectedTotalCost).toBeCloseTo(1.0, 2);
  });

  test('projected cost is null when cost unknown', () => {
    const a = computeAnalytics(
      makeSnapshot({
        usage: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          costKnown: false,
        },
      }),
    );
    expect(a.projectedTotalCost).toBeNull();
  });

  test('computes burn rate (tokens per second)', () => {
    const a = computeAnalytics(makeSnapshot({createdAt: Date.now() - 10000})); // 10s ago
    // charged = 50000, elapsed = 10s → 5000 tok/s
    expect(a.burnRate).toBeGreaterThan(0);
  });

  test('burn rate is 0 for just-created goals', () => {
    const a = computeAnalytics(makeSnapshot({createdAt: Date.now()}));
    // elapsed ≈ 0 → burnRate = 0
    expect(a.burnRate).toBe(0);
  });

  test('handles budget percentage over 100', () => {
    const a = computeAnalytics(makeSnapshot({tokenBudget: 25000}));
    // charged = 50000, budget = 25000 → 200%
    expect(a.budgetPercentage).toBe(200);
  });
});

// formatAnalyticsSummary

describe('formatAnalyticsSummary', () => {
  test('includes charged tokens', () => {
    const a = computeAnalytics(makeSnapshot());
    const summary = formatAnalyticsSummary(a);
    expect(summary).toContain('Charged:');
  });

  test('includes budget percentage when set', () => {
    const a = computeAnalytics(makeSnapshot({tokenBudget: 100000}));
    const summary = formatAnalyticsSummary(a);
    expect(summary).toContain('Budget:');
    expect(summary).toContain('50%');
  });

  test('omits budget when null', () => {
    const a = computeAnalytics(makeSnapshot());
    const summary = formatAnalyticsSummary(a);
    expect(summary).not.toContain('Budget:');
  });

  test('includes tokens per turn when > 0', () => {
    const a = computeAnalytics(
      makeSnapshot({turnCount: 5, totalTokens: 50000}),
    );
    const summary = formatAnalyticsSummary(a);
    expect(summary).toContain('/turn');
  });

  test('includes cost per turn when > 0', () => {
    const a = computeAnalytics(
      makeSnapshot({
        turnCount: 5,
        usage: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.5,
          costKnown: true,
        },
      }),
    );
    const summary = formatAnalyticsSummary(a);
    expect(summary).toContain('$');
    expect(summary).toContain('/turn');
  });

  test('includes burn rate when > 0', () => {
    const a = computeAnalytics(makeSnapshot({createdAt: Date.now() - 10000}));
    const summary = formatAnalyticsSummary(a);
    expect(summary).toContain('tok/s');
  });

  test('joins parts with separator', () => {
    const a = computeAnalytics(
      makeSnapshot({
        tokenBudget: 100000,
        turnCount: 5,
        totalTokens: 50000,
        createdAt: Date.now() - 10000,
      }),
    );
    const summary = formatAnalyticsSummary(a);
    expect(summary).toContain(' | ');
  });
});

// formatBudgetWarning

describe('formatBudgetWarning', () => {
  test('returns null when no budget', () => {
    const a = computeAnalytics(makeSnapshot());
    expect(formatBudgetWarning(a)).toBeNull();
  });

  test('returns null when budget under 80%', () => {
    const a = computeAnalytics(makeSnapshot({tokenBudget: 100000})); // 50%
    expect(formatBudgetWarning(a)).toBeNull();
  });

  test('returns warning at 80%', () => {
    const a = computeAnalytics(makeSnapshot({tokenBudget: 62500})); // 80%
    const warning = formatBudgetWarning(a);
    expect(warning).not.toBeNull();
    expect(warning).toContain('80%');
  });

  test('returns warning at 100%', () => {
    const a = computeAnalytics(makeSnapshot({tokenBudget: 50000})); // 100%
    const warning = formatBudgetWarning(a);
    expect(warning).not.toBeNull();
    expect(warning).toContain('limit reached');
  });

  test('returns warning over 100%', () => {
    const a = computeAnalytics(makeSnapshot({tokenBudget: 25000})); // 200%
    const warning = formatBudgetWarning(a);
    expect(warning).not.toBeNull();
    expect(warning).toContain('200%');
  });

  test('includes projection when over budget projected', () => {
    const a = computeAnalytics(
      makeSnapshot({
        tokenBudget: 60000,
        turnCount: 5,
        totalTokens: 50000,
        maxTurns: 10,
      }),
    );
    // charged = 50000, budget = 60000 → 83%, projected = 100000 > 60000
    const warning = formatBudgetWarning(a);
    expect(warning).not.toBeNull();
    expect(warning).toContain('Projected');
  });
});

test('a goal with no turn brake reports no projection rather than zero', () => {
  // maxTurns 0 is the DEFAULT (no turn brake). Multiplying by 0 reported a
  // projected total of 0, which silently disabled the "projected to exceed
  // budget" advisory instead of saying it cannot be computed.
  const analytics = computeAnalytics(
    makeSnapshot({
      turnCount: 5,
      maxTurns: 0,
      tokenBudget: 60000,
      usage: {
        input: 20000,
        output: 30000,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        costKnown: false,
      },
    }),
  );
  expect(analytics.projectedTotalTokens).toBeNull();
  expect(analytics.tokensPerTurn).toBe(10000);
});
