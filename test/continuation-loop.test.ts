import {expect, test} from 'bun:test';
import {
  budgetLimitNeeded,
  budgetWrapupNeeded,
  createLoopPolicy,
  decideContinuation,
  DEFAULT_POLICY_OPTIONS,
  durationLimitReached,
  type IdleContext,
  isLowProgressTurn,
  stopReason,
  turnLimitReached,
  validatePendingIntent,
} from '../src/continuation-loop.ts';
import type {GoalState, PendingIntent} from '../src/state-machine.ts';
import {createGoalState} from '../src/state-machine.ts';
import type {UsageSnapshot} from '../src/accounting.ts';

// Helpers

function makeUsage(partial: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    input: 1000,
    output: 500,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
    ...partial,
  };
}

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  const goal = createGoalState('session-1', 'Build the feature', {
    goalId: 'goal-1',
    runId: 'run-1',
    maxTokens: 200000,
    maxTurns: 25,
    maxDurationMs: 600000,
    tokenBudget: 50000,
  });
  return {...goal, usage: makeUsage(), ...overrides};
}

function makeIdleContext(overrides: Partial<IdleContext> = {}): IdleContext {
  const goal = makeGoal();
  return {
    goal,
    pendingIntent: null,
    latestOutputTokens: 100,
    latestHasToolCall: true,
    latestHasThinkingTokens: false,
    assistantChanged: true,
    assistantRepeated: false,
    userInterventionDetected: false,
    activationBoundary: false,
    ...overrides,
  };
}

function makePendingIntent(
  overrides: Partial<PendingIntent> = {},
): PendingIntent {
  return {
    goalId: 'goal-1',
    revision: 0,
    runId: 'run-1',
    messageID: '',
    toolCallID: '',
    targetStatus: 'complete',
    evidence: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

const defaultOpts = DEFAULT_POLICY_OPTIONS;

// budgetLimitNeeded

test('budgetLimitNeeded returns false when no budget', () => {
  const goal = makeGoal({tokenBudget: null});
  expect(budgetLimitNeeded(goal)).toBe(false);
});

test('budgetLimitNeeded returns false when under budget', () => {
  const goal = makeGoal({tokenBudget: 50000});
  goal.usage = makeUsage({input: 1000, output: 500}); // 1500 charged
  expect(budgetLimitNeeded(goal)).toBe(false);
});

test('budgetLimitNeeded returns true when at budget', () => {
  const goal = makeGoal({tokenBudget: 1500});
  goal.usage = makeUsage({input: 1000, output: 500}); // 1500 charged
  expect(budgetLimitNeeded(goal)).toBe(true);
});

test('budgetLimitNeeded returns true when over budget', () => {
  const goal = makeGoal({tokenBudget: 1000});
  goal.usage = makeUsage({input: 1000, output: 500}); // 1500 charged
  expect(budgetLimitNeeded(goal)).toBe(true);
});

test('budgetLimitNeeded returns false when already reported', () => {
  const goal = makeGoal({tokenBudget: 1000, budgetLimitReported: true});
  goal.usage = makeUsage({input: 1000, output: 500});
  expect(budgetLimitNeeded(goal)).toBe(false);
});

// budgetWrapupNeeded

test('budgetWrapupNeeded returns false when under threshold', () => {
  const goal = makeGoal({totalTokens: 1000, maxTokens: 200000});
  expect(budgetWrapupNeeded(goal)).toBe(false);
});

test('budgetWrapupNeeded returns true when over 80%', () => {
  const goal = makeGoal({totalTokens: 160000, maxTokens: 200000});
  expect(budgetWrapupNeeded(goal)).toBe(true);
});

test('budgetWrapupNeeded returns false when already sent', () => {
  const goal = makeGoal({
    totalTokens: 160000,
    maxTokens: 200000,
    budgetWrapupSent: true,
  });
  expect(budgetWrapupNeeded(goal)).toBe(false);
});

test('budgetWrapupNeeded respects custom ratio', () => {
  const goal = makeGoal({totalTokens: 100000, maxTokens: 200000}); // 50%
  expect(budgetWrapupNeeded(goal, 0.5)).toBe(true);
  expect(budgetWrapupNeeded(goal, 0.8)).toBe(false);
});

// turnLimitReached

test('turnLimitReached returns false when under limit', () => {
  const goal = makeGoal({turnCount: 5, maxTurns: 25});
  expect(turnLimitReached(goal)).toBe(false);
});

test('turnLimitReached returns true when at limit', () => {
  const goal = makeGoal({turnCount: 25, maxTurns: 25});
  expect(turnLimitReached(goal)).toBe(true);
});

test('turnLimitReached returns true when over limit', () => {
  const goal = makeGoal({turnCount: 30, maxTurns: 25});
  expect(turnLimitReached(goal)).toBe(true);
});

// durationLimitReached

test('durationLimitReached returns false when under limit', () => {
  const goal = makeGoal({startedAt: Date.now() - 10000, maxDurationMs: 600000});
  expect(durationLimitReached(goal)).toBe(false);
});

test('durationLimitReached returns true when over limit', () => {
  const goal = makeGoal({
    startedAt: Date.now() - 700000,
    maxDurationMs: 600000,
  });
  expect(durationLimitReached(goal)).toBe(true);
});

// stopReason

test('stopReason returns null when no limits reached', () => {
  const goal = makeGoal({
    turnCount: 5,
    totalTokens: 10000,
    startedAt: Date.now(),
  });
  expect(stopReason(goal)).toBeNull();
});

test('stopReason returns max turns when turn limit reached', () => {
  const goal = makeGoal({turnCount: 25, maxTurns: 25});
  expect(stopReason(goal)).toBe('max turns reached');
});

test('stopReason returns max duration when duration reached', () => {
  const goal = makeGoal({
    startedAt: Date.now() - 700000,
    maxDurationMs: 600000,
  });
  expect(stopReason(goal)).toBe('max stall reached');
});

test('durationLimitReached is a STALL brake: steady progress never trips it', () => {
  // The regression this locks: the brake used to measure wall-clock from
  // startedAt, so a goal working steadily was force-paused 15 minutes in with
  // most of its turn budget unused (live: paused at 1-2 turns of 10). Time
  // spent working must not count against the limit.
  const now = Date.now();
  const goal = makeGoal({
    maxDurationMs: 600000,
    startedAt: now - 3_600_000, // created an hour ago...
    lastProgressAt: now - 1_000, //...but produced output one second ago
  });
  expect(durationLimitReached(goal)).toBe(false);
  expect(stopReason(goal)).toBeNull();
});

test('durationLimitReached still fires when the goal genuinely stalls', () => {
  const now = Date.now();
  const goal = makeGoal({
    maxDurationMs: 600000,
    startedAt: now - 3_600_000,
    lastProgressAt: now - 700000, // no progress for 700s > 600s limit
  });
  expect(durationLimitReached(goal)).toBe(true);
  expect(stopReason(goal)).toBe('max stall reached');
});

test('durationLimitReached falls back to startedAt before any progress', () => {
  // A goal that never produces anything must still be bounded from creation.
  const now = Date.now();
  const goal = makeGoal({
    maxDurationMs: 600000,
    startedAt: now - 700000,
    lastProgressAt: 0,
  });
  expect(durationLimitReached(goal)).toBe(true);
});

test('decideContinuation keeps working a goal whose progress is fresh', () => {
  const now = Date.now();
  const goal = makeGoal({
    maxDurationMs: 600000,
    startedAt: now - 3_600_000,
    lastProgressAt: now - 5_000,
  });
  const result = decideContinuation(
    makeIdleContext({goal}),
    DEFAULT_POLICY_OPTIONS,
  );
  expect(result.type).not.toBe('stop');
});

test('stopReason returns max context tokens when context full', () => {
  const goal = makeGoal({totalTokens: 200000, maxTokens: 200000});
  expect(stopReason(goal)).toBe('max context tokens reached');
});

// isLowProgressTurn

test('isLowProgressTurn returns false for first turn', () => {
  const goal = makeGoal({turnCount: 0});
  const ctx = makeIdleContext({goal, latestOutputTokens: 10});
  expect(isLowProgressTurn(ctx, 50)).toBe(false);
});

test('isLowProgressTurn returns true for low output with no tools', () => {
  const goal = makeGoal({turnCount: 1, lastAssistantText: 'same'});
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 10,
    latestHasToolCall: false,
    latestHasThinkingTokens: false,
    assistantChanged: false,
    assistantRepeated: true,
  });
  expect(isLowProgressTurn(ctx, 50)).toBe(true);
});

test('isLowProgressTurn returns false when tool call present', () => {
  const goal = makeGoal({turnCount: 1});
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 10,
    latestHasToolCall: true,
  });
  expect(isLowProgressTurn(ctx, 50)).toBe(false);
});

test('isLowProgressTurn returns false when thinking tokens present', () => {
  const goal = makeGoal({turnCount: 1});
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 10,
    latestHasToolCall: false,
    latestHasThinkingTokens: true,
  });
  expect(isLowProgressTurn(ctx, 50)).toBe(false);
});

test('isLowProgressTurn returns false on activation boundary', () => {
  const goal = makeGoal({turnCount: 1});
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 10,
    activationBoundary: true,
  });
  expect(isLowProgressTurn(ctx, 50)).toBe(false);
});

// decideContinuation

test('decideContinuation returns continue by default', () => {
  const ctx = makeIdleContext();
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('continue');
});

test('decideContinuation pauses on user intervention', () => {
  const ctx = makeIdleContext({userInterventionDetected: true});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('pause');
  if (result.type === 'pause') {
    expect(result.stopReason).toBe('user intervention');
  }
});

test('decideContinuation applies pending intent when valid', () => {
  const intent = makePendingIntent();
  const ctx = makeIdleContext({pendingIntent: intent});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('apply-pending-intent');
  if (result.type === 'apply-pending-intent') {
    expect(result.intent.targetStatus).toBe('complete');
  }
});

test('decideContinuation ignores stale pending intent (wrong goalId)', () => {
  const intent = makePendingIntent({goalId: 'wrong-goal'});
  const ctx = makeIdleContext({pendingIntent: intent});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('continue');
});

test('decideContinuation ignores stale pending intent (wrong runId)', () => {
  const intent = makePendingIntent({runId: 'wrong-run'});
  const ctx = makeIdleContext({pendingIntent: intent});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('continue');
});

test('decideContinuation ignores stale pending intent (revision changed)', () => {
  const intent = makePendingIntent({revision: 0});
  const goal = makeGoal({revision: 1});
  const ctx = makeIdleContext({goal, pendingIntent: intent});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('continue');
});

test('decideContinuation returns budget-limit when budget exhausted', () => {
  const goal = makeGoal({tokenBudget: 1000});
  goal.usage = makeUsage({input: 1000, output: 500});
  const ctx = makeIdleContext({goal});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('budget-limit');
});

test('decideContinuation returns stop when turn limit reached', () => {
  const goal = makeGoal({turnCount: 25, maxTurns: 25});
  const ctx = makeIdleContext({goal});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('stop');
  if (result.type === 'stop') {
    expect(result.reason).toBe('max turns reached');
  }
});

test('decideContinuation returns stop when duration limit reached', () => {
  const goal = makeGoal({
    startedAt: Date.now() - 700000,
    maxDurationMs: 600000,
  });
  const ctx = makeIdleContext({goal});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('stop');
  if (result.type === 'stop') {
    expect(result.reason).toBe('max stall reached');
  }
});

test('decideContinuation pauses after no-progress threshold', () => {
  const goal = makeGoal({turnCount: 1, noProgressTurns: 3});
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 10,
    latestHasToolCall: false,
    latestHasThinkingTokens: false,
    assistantChanged: false,
    assistantRepeated: true,
  });
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('pause');
  if (result.type === 'pause') {
    expect(result.stopReason).toBe('no progress');
  }
});

test('decideContinuation continues with low progress but under threshold', () => {
  const goal = makeGoal({turnCount: 1, noProgressTurns: 1});
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 10,
    latestHasToolCall: false,
    latestHasThinkingTokens: false,
    assistantChanged: false,
    assistantRepeated: true,
  });
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('continue');
});

test('decideContinuation pauses after no-tool-call threshold', () => {
  const goal = makeGoal({turnCount: 2, noToolCallTurns: 3});
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 100,
    latestHasToolCall: false,
  });
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('pause');
  if (result.type === 'pause') {
    expect(result.stopReason).toBe('no tool calls');
  }
});

test('decideContinuation does NOT pause for no-tool-call when threshold is 0 (tool-free workflows)', () => {
  const goal = makeGoal({
    turnCount: 2,
    noToolCallTurns: 5,
    noToolCallTurnsBeforePause: 0,
  });
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 100,
    latestHasToolCall: false,
  });
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).not.toBe('pause');
});

test('decideContinuation continues with budget wrapup', () => {
  const goal = makeGoal({totalTokens: 160000, maxTokens: 200000});
  const ctx = makeIdleContext({goal});
  const result = decideContinuation(ctx, defaultOpts);
  expect(result.type).toBe('continue');
  if (result.type === 'continue') {
    expect(result.budgetWrapup).toBe(true);
  }
});

// createLoopPolicy

test('createLoopPolicy uses default options', () => {
  const policy = createLoopPolicy();
  const ctx = makeIdleContext();
  const result = policy.decideContinuation(ctx);
  expect(result.type).toBe('continue');
});

test('createLoopPolicy accepts custom options', () => {
  const policy = createLoopPolicy({noProgressTokenThreshold: 200});
  const goal = makeGoal({turnCount: 1});
  const ctx = makeIdleContext({
    goal,
    latestOutputTokens: 100, // Under custom threshold of 200
    latestHasToolCall: false,
    latestHasThinkingTokens: false,
    assistantChanged: false,
    assistantRepeated: true,
  });
  const result = policy.decideContinuation(ctx);
  // With threshold 200, 100 tokens is low progress
  // But noProgressTurns is 0, so it should continue
  expect(result.type).toBe('continue');
});

// validatePendingIntent

test('validatePendingIntent returns valid when matching', () => {
  const goal = makeGoal({goalId: 'goal-1', runId: 'run-1', revision: 0});
  const intent = makePendingIntent({
    goalId: 'goal-1',
    runId: 'run-1',
    revision: 0,
  });
  const result = validatePendingIntent(intent, goal);
  expect(result.valid).toBe(true);
});

test('validatePendingIntent returns invalid for wrong goalId', () => {
  const goal = makeGoal({goalId: 'goal-1'});
  const intent = makePendingIntent({goalId: 'wrong'});
  const result = validatePendingIntent(intent, goal);
  expect(result.valid).toBe(false);
  expect(result.reason).toContain('goalId');
});

test('validatePendingIntent returns invalid for wrong runId', () => {
  const goal = makeGoal({runId: 'run-1'});
  const intent = makePendingIntent({runId: 'wrong'});
  const result = validatePendingIntent(intent, goal);
  expect(result.valid).toBe(false);
  expect(result.reason).toContain('runId');
});

test('validatePendingIntent returns invalid for stale revision', () => {
  const goal = makeGoal({revision: 2});
  const intent = makePendingIntent({revision: 1});
  const result = validatePendingIntent(intent, goal);
  expect(result.valid).toBe(false);
  expect(result.reason).toContain('revision');
});

// zero-limit edge cases (0 = unlimited)

test('turnLimitReached returns false when maxTurns is 0 (unlimited)', () => {
  const goal = createGoalState('s1', 'test', {maxTurns: 0});
  expect(turnLimitReached(goal)).toBe(false);
});

test('durationLimitReached returns false when maxDurationMs is 0 (unlimited)', () => {
  const goal = createGoalState('s1', 'test', {maxDurationMs: 0});
  expect(durationLimitReached(goal)).toBe(false);
});

test('stopReason returns null when maxTokens is 0 (unlimited)', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 0});
  expect(stopReason(goal)).toBeNull();
});

test('budgetWrapupNeeded returns false when maxTokens is 0 (unlimited)', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 0});
  expect(budgetWrapupNeeded(goal)).toBe(false);
});

// Boundary condition stress tests

test('turnLimitReached with maxTurns=1 stops after exactly 1 turn', () => {
  const goal0 = createGoalState('s1', 'test', {maxTurns: 1});
  goal0.turnCount = 0;
  expect(turnLimitReached(goal0)).toBe(false);
  const goal1 = createGoalState('s1', 'test', {maxTurns: 1});
  goal1.turnCount = 1;
  expect(turnLimitReached(goal1)).toBe(true);
  const goal2 = createGoalState('s1', 'test', {maxTurns: 1});
  goal2.turnCount = 2;
  expect(turnLimitReached(goal2)).toBe(true);
});

test('stopReason with maxTokens=1 triggers immediately', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 1});
  goal.totalTokens = 0;
  expect(stopReason(goal)).toBeNull();
  goal.totalTokens = 1;
  expect(stopReason(goal)).toBe('max context tokens reached');
});

test('stopReason with maxTokens=1 and totalTokens=0 returns null but wrapup triggers', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 1});
  goal.totalTokens = 0;
  expect(stopReason(goal)).toBeNull();
  // maxTokens=1, ratio=0.8 → floor(0.8)=0 → 0>=0=true → wrapup needed immediately
  expect(budgetWrapupNeeded(goal)).toBe(true);
});

test('budgetWrapupNeeded at exact threshold boundary', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 100000});
  goal.budgetWrapupSent = false;
  goal.totalTokens = Math.floor(100000 * 0.8);
  expect(budgetWrapupNeeded(goal, 0.8)).toBe(true);
  goal.totalTokens = Math.floor(100000 * 0.8) - 1;
  expect(budgetWrapupNeeded(goal, 0.8)).toBe(false);
});

test('budgetWrapupNeeded with ratio=0 triggers immediately (even at 0 tokens)', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 100000});
  goal.totalTokens = 0;
  // floor(100000 * 0) = 0 → 0 >= 0 = true → wrapup always needed when ratio=0
  expect(budgetWrapupNeeded(goal, 0)).toBe(true);
  goal.totalTokens = 1;
  expect(budgetWrapupNeeded(goal, 0)).toBe(true);
});

test('budgetWrapupNeeded with ratio=1 triggers at 100%', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 100000});
  goal.totalTokens = 99999;
  expect(budgetWrapupNeeded(goal, 1)).toBe(false);
  goal.totalTokens = 100000;
  expect(budgetWrapupNeeded(goal, 1)).toBe(true);
});

test('durationLimitReached with maxDurationMs=1 triggers immediately', () => {
  // DETERMINISM (user directive: no flakes, no weakening). This test
  // previously set `startedAt = Date.now` and asserted `false` immediately,
  // while the brake compares `Date.now - since >= 1`. If a single millisecond
  // elapsed between the two Date.now calls the assertion failed — a genuine
  // 1 ms boundary race, measured at 4/25 failures. The negative case now uses a
  // start time in the FUTURE, so the elapsed idle is clamped to 0 and the result
  // cannot depend on how long the test takes. The positive case is unchanged and
  // is already deterministic (a 2 ms offset against a 1 ms limit).
  const goal = createGoalState('s1', 'test', {maxDurationMs: 1});
  goal.startedAt = Date.now() + 10_000;
  expect(durationLimitReached(goal)).toBe(false);
  goal.startedAt = Date.now() - 2;
  expect(durationLimitReached(goal)).toBe(true);
});

test('stopReason priority — turns checked before tokens', () => {
  const goal = createGoalState('s1', 'test', {maxTurns: 5, maxTokens: 100000});
  goal.turnCount = 5;
  goal.totalTokens = 100000;
  const reason = stopReason(goal);
  expect(reason).toBe('max turns reached');
});

test('stopReason returns token reason when only token limit reached', () => {
  const goal = createGoalState('s1', 'test', {
    maxTurns: 100,
    maxTokens: 100000,
    maxDurationMs: 999999999,
  });
  goal.turnCount = 1;
  goal.totalTokens = 100000;
  goal.startedAt = Date.now();
  const reason = stopReason(goal);
  expect(reason).toBe('max context tokens reached');
});

test('stopReason returns duration reason when only duration limit reached', () => {
  const goal = createGoalState('s1', 'test', {
    maxTurns: 100,
    maxTokens: 100000,
    maxDurationMs: 1000,
  });
  goal.turnCount = 1;
  goal.totalTokens = 0;
  goal.startedAt = Date.now() - 2000;
  const reason = stopReason(goal);
  expect(reason).toBe('max stall reached');
});

test('all limits set to 0 means no limits (unlimited goal)', () => {
  const goal = createGoalState('s1', 'test', {
    maxTurns: 0,
    maxDurationMs: 0,
    maxTokens: 0,
  });
  goal.turnCount = 999999;
  goal.totalTokens = 999999;
  goal.startedAt = 0;
  expect(turnLimitReached(goal)).toBe(false);
  expect(durationLimitReached(goal)).toBe(false);
  expect(budgetWrapupNeeded(goal)).toBe(false);
  expect(stopReason(goal)).toBeNull();
});

test('budgetWrapupNeeded false when budgetWrapupSent already true regardless of tokens', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 100000});
  goal.budgetWrapupSent = true;
  goal.totalTokens = 99999;
  expect(budgetWrapupNeeded(goal, 0.1)).toBe(false);
  goal.totalTokens = 100000;
  expect(budgetWrapupNeeded(goal, 0.01)).toBe(false);
});

test('noProgressTurnsBeforePause=0 means pause on first stalled turn', () => {
  const goal = createGoalState('s1', 'test', {
    noProgressTokenThreshold: 50,
    noProgressTurnsBeforePause: 0,
  });
  goal.turnCount = 1;
  goal.noProgressTurns = 0;
  expect(goal.noProgressTurnsBeforePause).toBe(0);
});

test('noToolCallTurnsBeforePause=0 means heuristic disabled', () => {
  const goal = createGoalState('s1', 'test', {noToolCallTurnsBeforePause: 0});
  expect(goal.noToolCallTurnsBeforePause).toBe(0);
});

test('durationLimitReached returns false when startedAt is 0 (corrupted state)', () => {
  const goal = makeGoal({startedAt: 0, maxDurationMs: 1000});
  expect(durationLimitReached(goal)).toBe(false);
});

// AGGRESSIVE-DEFAULTS-1: a progressing goal is not stopped by a default
//
// user: "Goals should be AGGRESSIVE by default. I've observed forced stops
// repeatedly." A default threshold must not stop a goal that is still making
// progress; only absent progress, an explicit user action, or an exhausted
// recovery budget may. These lock the derived posture so a later edit cannot
// quietly reintroduce a conservative default.

test('AGGRESSIVE-DEFAULTS: a real multi-step turn budget is not cut off by default', () => {
  // A real task on a strong model routinely exceeds 10 turns. The default must
  // not stop it: maxTurns 0 means no turn brake, so a long productive run keeps
  // going while the measured brakes still bound it.
  const goal = createGoalState('s1', 'a genuinely long task', {maxTurns: 0});
  goal.turnCount = 250;
  goal.totalTokens = 400000;
  goal.lastProgressAt = Date.now() - 1000;
  expect(turnLimitReached(goal)).toBe(false);
  expect(stopReason(goal)).toBe(null);
});

test('AGGRESSIVE-DEFAULTS: the context brake is a real ceiling, not an ordinary-work brake', () => {
  // 200k was reachable by ordinary long work and, because the budget is
  // CUMULATIVE (compaction does not relieve it), it paused goals that were
  // still progressing. The derived default must leave headroom above a
  // realistic productive run.
  const goal = createGoalState('s1', 'long task', {});
  goal.turnCount = 40;
  goal.totalTokens = 400000;
  expect(stopReason(goal)).toBe(null);
});

test('AGGRESSIVE-DEFAULTS: a stalled goal IS still stopped (the brake still works)', () => {
  // The posture change must not make a genuinely stuck goal un-stoppable.
  const goal = createGoalState('s1', 'stuck task', {maxDurationMs: 1000});
  goal.lastProgressAt = Date.now() - 5000;
  expect(durationLimitReached(goal)).toBe(true);
  expect(stopReason(goal)).toBe('max stall reached');
});

test('AGGRESSIVE-DEFAULTS: a goal with no progress recorded is bounded from creation', () => {
  const goal = createGoalState('s1', 'never started', {maxDurationMs: 1000});
  goal.startedAt = Date.now() - 5000;
  goal.lastProgressAt = 0;
  expect(durationLimitReached(goal)).toBe(true);
});
