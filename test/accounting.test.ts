import {expect, test} from 'bun:test';
import {
  addUsageDelta,
  chargedTokens,
  emptyUsage,
  normalizeMessageUsage,
  normalizeUsage,
  totalTokensForMessage,
  type UsageSnapshot,
} from '../src/accounting.ts';

test('chargedTokens uses input + cacheWrite + output + reasoning', () => {
  // OpenCode stores input after subtracting cacheRead and cacheWrite, and output after
  // subtracting reasoning. The charged total reconstructs the full billable token count.
  const u: UsageSnapshot = {
    input: 10000,
    output: 1000,
    reasoning: 500,
    cacheRead: 90000,
    cacheWrite: 2000,
    cost: 0,
    costKnown: false,
  };
  expect(chargedTokens(u)).toBe(13500);

  // cacheRead > input does not clamp to 0 because input is already non-cached tokens.
  expect(
    chargedTokens({
      input: 50,
      output: 10,
      reasoning: 0,
      cacheRead: 999,
      cacheWrite: 0,
      cost: 0,
      costKnown: false,
    }),
  ).toBe(60);

  // cacheWrite represents newly written cache entries and is charged as input.
  expect(
    chargedTokens({
      input: 50,
      output: 10,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 200,
      cost: 0,
      costKnown: false,
    }),
  ).toBe(260);

  expect(chargedTokens(null)).toBe(0);
  expect(chargedTokens(undefined)).toBe(0);
  expect(chargedTokens(emptyUsage())).toBe(0);
});

test('normalizeUsage clamps invalid values to 0', () => {
  expect(normalizeUsage({input: -5, output: 'bad'})).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });
  expect(
    normalizeUsage({
      input: 10,
      output: 4,
      reasoning: 2,
      cacheRead: 30,
      cacheWrite: 5,
      cost: 0.01,
      costKnown: true,
    }),
  ).toEqual({
    input: 10,
    output: 4,
    reasoning: 2,
    cacheRead: 30,
    cacheWrite: 5,
    cost: 0.01,
    costKnown: true,
  });
});

test('normalizeMessageUsage reads from OpenCode message shape', () => {
  const msg = {
    info: {
      tokens: {
        input: 10,
        output: 20,
        reasoning: 5,
        cache: {read: 1000, write: 200},
      },
      cost: 0.01,
    },
  };
  expect(normalizeMessageUsage(msg)).toEqual({
    input: 10,
    output: 20,
    reasoning: 5,
    cacheRead: 1000,
    cacheWrite: 200,
    cost: 0.01,
    costKnown: true,
  });
  // Handles legacy flattened shape from older SDK adapters
  const flat = {tokens: {input: 3, cache_read: 7, cache_write: 2}, cost: 'bad'};
  expect(normalizeMessageUsage(flat)).toEqual({
    input: 3,
    output: 0,
    reasoning: 0,
    cacheRead: 7,
    cacheWrite: 2,
    cost: 0,
    costKnown: false,
  });
});

test('normalizeMessageUsage treats null cost as unknown (costKnown=false)', () => {
  const msg = {info: {tokens: {input: 10, output: 20}, cost: null}, cost: null};
  const usage = normalizeMessageUsage(msg);
  expect(usage.cost).toBe(0);
  expect(usage.costKnown).toBe(false);
});

test('addUsageDelta detects steps via token field decreases (zero-cost models)', () => {
  // For zero-cost models, cost does not change across steps.
  // Step boundaries are instead inferred when any charged token counter decreases,
  // indicating a new generation step where full usage values should be accumulated.
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const step2: UsageSnapshot = {
    input: 80,
    output: 40,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };

  let prev = emptyUsage();
  let result = addUsageDelta(total, step1, prev);
  prev = step1;
  expect(result.input).toBe(100);
  expect(result.output).toBe(50);

  // Input decreased (100 -> 80), triggering step detection where full step 2 values are added.
  result = addUsageDelta(result, step2, prev);
  expect(result.input).toBe(180);
  expect(result.output).toBe(90);
});

test('addUsageDelta detects steps via cost increase (paid models)', () => {
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
    costKnown: true,
  };
  const step2: UsageSnapshot = {
    input: 120,
    output: 60,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.02,
    costKnown: true,
  };

  let result = addUsageDelta(total, step1, emptyUsage());
  // Cost increased (0.01 -> 0.02), indicating a new step boundary so full step 2 values are accumulated.
  result = addUsageDelta(result, step2, step1);
  expect(result.input).toBe(220);
  expect(result.output).toBe(110);
});

test('cacheRead decrease does not trigger step boundary', () => {
  // cacheRead tracks cumulative/historical context rather than per-step generation work.
  // Downward adjustments (such as provider cache recalculations) must not trigger a new step boundary;
  // only charged fields (input, output, reasoning, cacheWrite) determine steps.
  const total: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 1000,
    cacheWrite: 10,
    cost: 0.01,
    costKnown: true,
  };
  const current: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 950,
    cacheWrite: 10,
    cost: 0.01,
    costKnown: true,
  };
  const previous: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 1000,
    cacheWrite: 10,
    cost: 0.01,
    costKnown: true,
  };

  // Charged fields are unchanged (delta = 0). Negative cacheRead delta is clamped to 0.
  const result = addUsageDelta(total, current, previous);

  expect(result.input).toBe(100);
  expect(result.output).toBe(50);
  expect(result.cacheWrite).toBe(10);
  expect(result.cacheRead).toBe(1000);
});

test('totalTokensForMessage computes context window size', () => {
  const msg = {
    info: {
      tokens: {
        input: 10,
        output: 20,
        reasoning: 5,
        cache: {read: 1000, write: 200},
      },
    },
  };
  expect(totalTokensForMessage(msg)).toBe(1235);

  // Prefers reported total when explicitly provided
  const withTotal = {info: {tokens: {total: 999, input: 1, output: 1}}};
  expect(totalTokensForMessage(withTotal)).toBe(999);
});

test('step detection triggers when only reasoning decreases', () => {
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 200,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const step2: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 100,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };

  let result = addUsageDelta(total, step1, emptyUsage());
  result = addUsageDelta(result, step2, step1);

  expect(result.reasoning).toBe(300);
  expect(result.input).toBe(200);
  expect(result.output).toBe(100);
});

test('step detection triggers when only cacheWrite decreases', () => {
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 500,
    cost: 0,
    costKnown: false,
  };
  const step2: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 300,
    cost: 0,
    costKnown: false,
  };

  let result = addUsageDelta(total, step1, emptyUsage());
  result = addUsageDelta(result, step2, step1);

  expect(result.cacheWrite).toBe(800);
  expect(result.input).toBe(200);
});

test('step detection triggers when only output decreases', () => {
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 100,
    output: 500,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const step2: UsageSnapshot = {
    input: 100,
    output: 300,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };

  let result = addUsageDelta(total, step1, emptyUsage());
  result = addUsageDelta(result, step2, step1);

  expect(result.output).toBe(800);
  expect(result.input).toBe(200);
});

test('step detection triggers when only input decreases', () => {
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 500,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const step2: UsageSnapshot = {
    input: 300,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };

  let result = addUsageDelta(total, step1, emptyUsage());
  result = addUsageDelta(result, step2, step1);

  expect(result.input).toBe(800);
  expect(result.output).toBe(100);
});

test('all charged fields decrease simultaneously triggers step', () => {
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 500,
    output: 300,
    reasoning: 200,
    cacheRead: 0,
    cacheWrite: 100,
    cost: 0,
    costKnown: false,
  };
  const step2: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 50,
    cacheRead: 0,
    cacheWrite: 30,
    cost: 0,
    costKnown: false,
  };

  let result = addUsageDelta(total, step1, emptyUsage());
  result = addUsageDelta(result, step2, step1);

  expect(result.input).toBe(600);
  expect(result.output).toBe(350);
  expect(result.reasoning).toBe(250);
  expect(result.cacheWrite).toBe(130);
});

test('no step detected when all fields increase (delta path)', () => {
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
    costKnown: true,
  };
  const step2: UsageSnapshot = {
    input: 150,
    output: 70,
    reasoning: 10,
    cacheRead: 0,
    cacheWrite: 20,
    cost: 0.01,
    costKnown: true,
  };

  let result = addUsageDelta(total, step1, emptyUsage());
  result = addUsageDelta(result, step2, step1);

  expect(result.input).toBe(150);
  expect(result.output).toBe(70);
  expect(result.reasoning).toBe(10);
  expect(result.cacheWrite).toBe(20);
  expect(result.cost).toBe(0.01);
});

test('zero-cost model with no token changes adds 0 delta', () => {
  const total: UsageSnapshot = {
    input: 500,
    output: 300,
    reasoning: 100,
    cacheRead: 0,
    cacheWrite: 50,
    cost: 0,
    costKnown: false,
  };
  const current: UsageSnapshot = {
    input: 500,
    output: 300,
    reasoning: 100,
    cacheRead: 0,
    cacheWrite: 50,
    cost: 0,
    costKnown: false,
  };
  const previous: UsageSnapshot = {
    input: 500,
    output: 300,
    reasoning: 100,
    cacheRead: 0,
    cacheWrite: 50,
    cost: 0,
    costKnown: false,
  };

  const result = addUsageDelta(total, current, previous);

  expect(result.input).toBe(500);
  expect(result.output).toBe(300);
  expect(result.reasoning).toBe(100);
  expect(result.cacheWrite).toBe(50);
});

test('3-step sequential accumulation (zero-cost model)', () => {
  const total = emptyUsage();
  const step1: UsageSnapshot = {
    input: 200,
    output: 100,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const step2: UsageSnapshot = {
    input: 150,
    output: 80,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const step3: UsageSnapshot = {
    input: 120,
    output: 60,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };

  let result = addUsageDelta(total, step1, emptyUsage());
  result = addUsageDelta(result, step2, step1);
  result = addUsageDelta(result, step3, step2);

  expect(result.input).toBe(470);
  expect(result.output).toBe(240);
});

test('costKnown propagates via OR-assignment', () => {
  const total: UsageSnapshot = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const current: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.05,
    costKnown: true,
  };
  const previous = emptyUsage();

  const result = addUsageDelta(total, current, previous);

  expect(result.costKnown).toBe(true);
});

test('costKnown stays false when current is false', () => {
  const total: UsageSnapshot = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const current: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const previous = emptyUsage();

  const result = addUsageDelta(total, current, previous);

  expect(result.costKnown).toBe(false);
});

test('costKnown stays true once set (no downgrade)', () => {
  const total: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
    costKnown: true,
  };
  const current: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const previous: UsageSnapshot = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
    costKnown: true,
  };

  const result = addUsageDelta(total, current, previous);

  expect(result.costKnown).toBe(true);
});

test("large values near MAX_SAFE_INTEGER don't overflow", () => {
  const big = Number.MAX_SAFE_INTEGER - 1000;
  const total = emptyUsage();
  const step: UsageSnapshot = {
    input: big,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };

  const result = addUsageDelta(total, step, emptyUsage());

  expect(result.input).toBe(big);
  expect(Number.isSafeInteger(result.input)).toBe(true);
});

test('normalizeMessageUsage handles null/undefined/empty/primitive', () => {
  expect(normalizeMessageUsage(null)).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });
  expect(normalizeMessageUsage(undefined)).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });
  expect(normalizeMessageUsage({})).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });
  expect(normalizeMessageUsage('string')).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });
  expect(normalizeMessageUsage(42)).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  });
});

test('normalizeMessageUsage with negative cost sets cost to 0', () => {
  const msg = {info: {tokens: {input: 100}, cost: -0.5}};
  const result = normalizeMessageUsage(msg);
  expect(result.cost).toBe(0);
  expect(result.costKnown).toBe(false);
});

test('normalizeMessageUsage with NaN cost sets cost to 0', () => {
  const msg = {info: {tokens: {input: 100}, cost: NaN}};
  const result = normalizeMessageUsage(msg);
  expect(result.cost).toBe(0);
  expect(result.costKnown).toBe(false);
});

test('totalTokensForMessage handles null/undefined/empty/primitive', () => {
  expect(totalTokensForMessage(null)).toBe(0);
  expect(totalTokensForMessage(undefined)).toBe(0);
  expect(totalTokensForMessage({})).toBe(0);
  expect(totalTokensForMessage('string')).toBe(0);
  expect(totalTokensForMessage(42)).toBe(0);
});

test('totalTokensForMessage uses cache.read and cache.write from nested object', () => {
  const msg = {
    info: {tokens: {input: 10, output: 20, cache: {read: 100, write: 50}}},
  };
  expect(totalTokensForMessage(msg)).toBe(180);
});

test('totalTokensForMessage uses flattened cache_read/cache_write', () => {
  const msg = {
    tokens: {input: 10, output: 20, cache_read: 100, cache_write: 50},
  };
  expect(totalTokensForMessage(msg)).toBe(180);
});

test('totalTokensForMessage prefers reported total over computed sum', () => {
  const msg = {
    info: {
      tokens: {
        total: 500,
        input: 10,
        output: 20,
        cache: {read: 100, write: 50},
      },
    },
  };
  expect(totalTokensForMessage(msg)).toBe(500);
});

test('chargedTokens with all fields at MAX_SAFE_INTEGER', () => {
  const usage: UsageSnapshot = {
    input: Number.MAX_SAFE_INTEGER,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  expect(chargedTokens(usage)).toBe(Number.MAX_SAFE_INTEGER);
});

test('normalizeUsage with Infinity and -Infinity', () => {
  const result = normalizeUsage({input: Infinity, output: -Infinity});
  expect(result.input).toBe(0);
  expect(result.output).toBe(0);
});

test('normalizeUsage with NaN values', () => {
  const result = normalizeUsage({input: NaN, output: NaN});
  expect(result.input).toBe(0);
  expect(result.output).toBe(0);
});

test('chargedTokens handles string fields without concatenation', () => {
  const result = chargedTokens({
    input: '100',
    cacheWrite: 10,
    output: 5,
    reasoning: 0,
    cacheRead: 0,
    cost: 0,
    costKnown: false,
  } as never);
  expect(result).toBe(115);
  expect(typeof result).toBe('number');
});

test('addUsageDelta normalizes current and previous inputs', () => {
  const total = emptyUsage();
  const current = {
    input: '100',
    output: '50',
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  } as never;
  const previous = {
    input: 200,
    output: 100,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  } as never;
  const result = addUsageDelta(total, current, previous);
  expect(result.input).toBe(100);
  expect(result.output).toBe(50);
  expect(typeof result.input).toBe('number');
});

test('addUsageDelta records a full replacement snapshot for a new zero-cost step', () => {
  const step1: UsageSnapshot = {
    input: 100,
    output: 10,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const step2: UsageSnapshot = {
    input: 1000,
    output: 100,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const afterFirst = addUsageDelta(emptyUsage(), step1, emptyUsage(), true);
  const result = addUsageDelta(afterFirst, step2, step1, true);

  expect(result.input).toBe(1100);
  expect(result.output).toBe(110);
});
