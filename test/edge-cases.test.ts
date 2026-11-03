import {expect, test} from 'bun:test';
import {
  createGoalState,
  GoalStateMachine,
  TERMINAL_STATUSES,
} from '../src/state-machine.ts';
import {
  addUsageDelta,
  chargedTokens,
  emptyUsage,
  normalizeMessageUsage,
  normalizeUsage,
  outputTokensForMessage,
  totalTokensForMessage,
} from '../src/accounting.ts';
import {
  deserializeGoal,
  deserializeResult,
  serializeGoal,
  serializeResult,
} from '../src/persistence.ts';
import {
  appendWalEntry,
  createAbortedEntry,
  createCommittedEntry,
  createProposedEntry,
  readWalEntries,
  recoverState,
  writeStateFile,
} from '../src/persistence-wal.ts';
import {escapeGoalText} from '../src/escape.ts';
import {
  budgetLimitNeeded,
  budgetWrapupNeeded,
  createLoopPolicy,
  DEFAULT_POLICY_OPTIONS,
  durationLimitReached,
  isLowProgressTurn,
  stopReason,
  turnLimitReached,
  validatePendingIntent,
} from '../src/continuation-loop.ts';
import {formatHistory, formatStatus} from '../src/commands.ts';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// State Machine: Transition Table

test('active can transition to paused', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(
    (await sm.transition('paused', {source: 'slash-command', detail: 'p'})).ok,
  ).toBe(true);
  expect(sm.state.status).toBe('paused');
});

test('active can transition to blocked', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(
    (await sm.transition('blocked', {source: 'update_goal', detail: 'b'})).ok,
  ).toBe(true);
  expect(sm.state.status).toBe('blocked');
});

test('active can transition to complete', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(
    (await sm.transition('complete', {source: 'update_goal', detail: 'c'})).ok,
  ).toBe(true);
  expect(sm.state.status).toBe('complete');
  expect(sm.isTerminal()).toBe(true);
});

test('active can transition to finalizing', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(
    (await sm.transition('finalizing', {source: 'idle-handler', detail: 'f'}))
      .ok,
  ).toBe(true);
  expect(sm.state.status).toBe('finalizing');
});

test('active can transition to budgetLimited', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(
    (
      await sm.transition('budgetLimited', {
        source: 'idle-handler',
        detail: 'bl',
      })
    ).ok,
  ).toBe(true);
  expect(sm.state.status).toBe('budgetLimited');
  expect(sm.isTerminal()).toBe(true);
});

test('paused can transition to active', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.transition('paused', {source: 'slash-command', detail: 'p'});
  expect(
    (await sm.transition('active', {source: 'slash-command', detail: 'r'})).ok,
  ).toBe(true);
  expect(sm.state.status).toBe('active');
});

test('paused can transition to complete', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.transition('paused', {source: 'slash-command', detail: 'p'});
  expect(
    (await sm.transition('complete', {source: 'update_goal', detail: 'c'})).ok,
  ).toBe(true);
});

test('blocked can transition to active', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.transition('blocked', {source: 'update_goal', detail: 'b'});
  expect(
    (await sm.transition('active', {source: 'slash-command', detail: 'r'})).ok,
  ).toBe(true);
});

test('finalizing can transition to complete', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.transition('finalizing', {source: 'idle-handler', detail: 'f'});
  expect(
    (await sm.transition('complete', {source: 'update_goal', detail: 'c'})).ok,
  ).toBe(true);
});

test('budgetLimited is terminal - cannot transition out', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.transition('budgetLimited', {source: 'idle-handler', detail: 'bl'});
  expect(
    (await sm.transition('paused', {source: 'slash-command', detail: 'p'})).ok,
  ).toBe(false);
  expect(
    (await sm.transition('active', {source: 'slash-command', detail: 'r'})).ok,
  ).toBe(false);
  expect(
    (await sm.transition('complete', {source: 'update_goal', detail: 'c'})).ok,
  ).toBe(false);
});

test('complete is terminal - cannot transition out', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.transition('complete', {source: 'update_goal', detail: 'c'});
  expect(
    (await sm.transition('paused', {source: 'slash-command', detail: 'p'})).ok,
  ).toBe(false);
  expect(
    (await sm.transition('active', {source: 'slash-command', detail: 'r'})).ok,
  ).toBe(false);
});

test('TERMINAL_STATUSES contains budgetLimited and complete', () => {
  expect(TERMINAL_STATUSES.has('budgetLimited')).toBe(true);
  expect(TERMINAL_STATUSES.has('complete')).toBe(true);
  expect(TERMINAL_STATUSES.has('active')).toBe(false);
});

// State Machine: Revision & CAS

test('revision starts at 0', () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(sm.currentRevision).toBe(0);
});

test('revision increments on each transition', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(sm.currentRevision).toBe(0);
  await sm.transition('paused', {source: 'slash-command', detail: 'p'});
  expect(sm.currentRevision).toBe(1);
  await sm.transition('active', {source: 'slash-command', detail: 'r'});
  expect(sm.currentRevision).toBe(2);
});

test('validateRevision returns true for current revision', () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  const rev = sm.currentRevision;
  expect(sm.validateRevision(rev)).toBe(true);
});

test('validateRevision returns false after mutation', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  const rev = sm.currentRevision;
  await sm.transition('paused', {source: 'slash-command', detail: 'p'});
  expect(sm.validateRevision(rev)).toBe(false);
});

// State Machine: Usage Updates

test('updateUsage does not increment revision', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  const rev = sm.currentRevision;
  await sm.updateUsage(emptyUsage());
  expect(sm.currentRevision).toBe(rev);
});

test('updateUsage sets the usage', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  const usage = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  await sm.updateUsage(usage);
  expect(sm.state.usage.input).toBe(100);
});

// State Machine: Notices

test('addNotice adds a notice', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.addNotice('blocked', 'Goal blocked');
  expect(sm.state.pendingNotices.length).toBe(1);
  expect(sm.state.pendingNotices[0].kind).toBe('blocked');
});

test('clearNotices removes all notices', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.addNotice('blocked', 'Goal blocked');
  await sm.addNotice('no-progress', 'No progress');
  await sm.clearNotices();
  expect(sm.state.pendingNotices.length).toBe(0);
});

// State Machine: Clock

test('pauseClock sets pausedAt', () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(sm.state.pausedAt).toBe(0);
  sm.pauseClock();
  expect(sm.state.pausedAt).toBeGreaterThan(0);
});

test('resumeClock shifts startedAt', () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  const originalStartedAt = sm.state.startedAt;
  sm.pauseClock();
  sm.resumeClock();
  expect(sm.state.startedAt).toBeGreaterThanOrEqual(originalStartedAt);
  expect(sm.state.pausedAt).toBe(0);
});

// State Machine: Message ID Tracking

test('rememberMessageID adds to set', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.rememberMessageID('msg-1');
  expect(sm.state.messageIDs.has('msg-1')).toBe(true);
});

test('rememberMessageID bounds the set size', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  for (let i = 0; i < 1100; i++) await sm.rememberMessageID(`msg-${i}`);
  expect(sm.state.messageIDs.size).toBeLessThanOrEqual(1000);
});

// State Machine: Snapshot

test('snapshot deep-copies history', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  const snap1 = sm.snapshot();
  await sm.addNotice('blocked', 'test');
  const snap2 = sm.snapshot();
  expect(snap1.pendingNotices.length).toBe(0);
  expect(snap2.pendingNotices.length).toBe(1);
});

test('snapshot deep-copies messageIDs', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.rememberMessageID('msg-1');
  const snap = sm.snapshot();
  snap.messageIDs.add('mutated');
  expect(sm.state.messageIDs.has('mutated')).toBe(false);
});

test('snapshot deep-copies continuationClaim', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.mutate(
    g => {
      g.continuationClaim = {runId: 'r1', sourceAssistantMessageID: 'm1'};
    },
    {source: 'idle-handler', detail: 'claim'},
  );
  const snap = sm.snapshot();
  expect(snap.continuationClaim).not.toBe(sm.state.continuationClaim);
  expect(snap.continuationClaim?.runId).toBe('r1');
});

// State Machine: isBudgetLimited

test('isBudgetLimited checks status field', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(sm.isBudgetLimited()).toBe(false);
  await sm.transition('budgetLimited', {source: 'idle-handler', detail: 'bl'});
  expect(sm.isBudgetLimited()).toBe(true);
});

test('isBudgetLimited checks budgetLimitReported flag', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  expect(sm.isBudgetLimited()).toBe(false);
  await sm.mutate(
    g => {
      g.budgetLimitReported = true;
    },
    {source: 'idle-handler', detail: 'blr'},
  );
  expect(sm.isBudgetLimited()).toBe(true);
});

// Accounting: chargedTokens

test('chargedTokens with zero usage returns 0', () => {
  expect(chargedTokens(emptyUsage())).toBe(0);
});

test('chargedTokens with cache reads excludes them', () => {
  expect(
    chargedTokens({
      input: 1000,
      output: 500,
      reasoning: 200,
      cacheRead: 5000,
      cacheWrite: 100,
      cost: 0,
      costKnown: false,
    }),
  ).toBe(1800);
});

test('chargedTokens with zero-cost model works', () => {
  expect(
    chargedTokens({
      input: 100,
      output: 50,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costKnown: false,
    }),
  ).toBe(150);
});

// Accounting: normalizeUsage

test('normalizeUsage handles undefined', () => {
  const result = normalizeUsage(undefined);
  expect(result.input).toBe(0);
  expect(result.output).toBe(0);
});

test('normalizeUsage handles string values', () => {
  const result = normalizeUsage({input: '100', output: '50'});
  expect(result.input).toBe(100);
  expect(result.output).toBe(50);
});

// Accounting: addUsageDelta

test('addUsageDelta with cost increase detects step', () => {
  const total = emptyUsage();
  const step1 = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
    costKnown: true,
  };
  const step2 = {
    input: 80,
    output: 30,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.02,
    costKnown: true,
  };
  const result = addUsageDelta(
    addUsageDelta(total, step1, emptyUsage()),
    step2,
    step1,
  );
  expect(result.cost).toBe(0.02);
});

test('addUsageDelta without cost change accumulates deltas', () => {
  const total = emptyUsage();
  const step1 = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const step2 = {
    input: 120,
    output: 60,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const result = addUsageDelta(
    addUsageDelta(total, step1, emptyUsage()),
    step2,
    step1,
  );
  expect(result.input).toBe(120);
  expect(result.output).toBe(60);
});

// Accounting: message helpers

test('normalizeMessageUsage extracts tokens from info', () => {
  const msg = {info: {tokens: {input: 100, output: 50}}};
  const result = normalizeMessageUsage(msg);
  expect(result.input).toBe(100);
  expect(result.output).toBe(50);
});

test('totalTokensForMessage sums all token fields', () => {
  const msg = {
    info: {
      tokens: {
        input: 100,
        output: 50,
        reasoning: 10,
        cache: {read: 20, write: 5},
      },
    },
  };
  expect(totalTokensForMessage(msg)).toBe(185);
});

test('outputTokensForMessage returns null when no tokens', () => {
  expect(outputTokensForMessage({})).toBe(null);
});

// Persistence: Serialization

test('serializeGoal converts Set to array', () => {
  const goal = createGoalState('s1', 'test');
  goal.messageIDs.add('msg-1');
  goal.messageIDs.add('msg-2');
  const serialized = serializeGoal(goal);
  expect(Array.isArray(serialized.messageIDs)).toBe(true);
  expect(serialized.messageIDs).toContain('msg-1');
  expect(serialized.messageIDs).toContain('msg-2');
});

test('deserializeGoal converts array back to Set', () => {
  const serialized = {
    ...createGoalState('s1', 'test'),
    messageIDs: ['a', 'b', 'c'],
  };
  const goal = deserializeGoal(serialized);
  expect(goal.messageIDs).toBeInstanceOf(Set);
  expect(goal.messageIDs.size).toBe(3);
});

test('deserializeGoal handles missing fields gracefully', () => {
  const goal = deserializeGoal({});
  expect(goal.goalId).toBe('');
  expect(goal.condition).toBe('');
  expect(goal.maxTokens).toBe(1000000);
});

test('deserializeGoal uses fallback for null fields (not 0)', () => {
  // Number(null) === 0 in JavaScript, but null should be treated as
  // "not present" and use the fallback, not 0.
  // 0 means "unlimited" for maxTokens/maxTurns/maxDurationMs — a
  // dangerous silent change from the defaults.
  const goal = deserializeGoal({
    maxTokens: null,
    maxTurns: null,
    maxDurationMs: null,
    minDelayMs: null,
    noProgressTokenThreshold: null,
    noProgressTurnsBeforePause: null,
    noToolCallTurnsBeforePause: null,
  });
  expect(goal.maxTokens).toBe(1000000); // not 0 (unlimited)
  expect(goal.maxTurns).toBe(0); // 0 = no turn brake by default (see DEFAULT_GOAL_OPTIONS)
  expect(goal.maxDurationMs).toBe(1800000); // not 0 (no limit)
  expect(goal.minDelayMs).toBe(1500); // not 0 (no delay)
  expect(goal.noProgressTokenThreshold).toBe(50); // not 0 (disabled)
  expect(goal.noProgressTurnsBeforePause).toBe(3); // not 0 (pause on first)
  expect(goal.noToolCallTurnsBeforePause).toBe(3); // not 0 (disabled)
});

test('deserializeGoal reads tokenBudget only if positive safe integer', () => {
  expect(deserializeGoal({tokenBudget: 100}).tokenBudget).toBe(100);
  expect(deserializeGoal({tokenBudget: -1}).tokenBudget).toBe(null);
  expect(deserializeGoal({tokenBudget: 'abc'}).tokenBudget).toBe(null);
  expect(deserializeGoal({}).tokenBudget).toBe(null);
});

test('serializeResult captures goal state', () => {
  const goal = createGoalState('s1', 'test', {tokenBudget: 1000});
  goal.turnCount = 5;
  const result = serializeResult(goal, 'achieved', 'done', 'evidence');
  expect(result.state).toBe('achieved');
  expect(result.turnCount).toBe(5);
  expect(result.tokenBudget).toBe(1000);
});

test('deserializeResult handles missing fields', () => {
  const result = deserializeResult({});
  expect(result.state).toBe('cleared');
  expect(result.turnCount).toBe(0);
});

// Persistence: WAL

test('createProposedEntry creates entry with proposed phase', () => {
  const goal = createGoalState('s1', 'test');
  const transition = {
    source: 'update_goal' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'complete' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'done',
  };
  const entry = createProposedEntry(
    goal,
    transition,
    '/nowhere/edge-proposed.ledger.jsonl',
  );
  expect(entry.phase).toBe('proposed');
  expect(entry.revision).toBe(goal.revision);
});

test('createCommittedEntry creates entry with committed phase', () => {
  const goal = createGoalState('s1', 'test');
  const transition = {
    source: 'update_goal' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'complete' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'done',
  };
  const entry = createCommittedEntry(
    goal,
    transition,
    '/nowhere/edge-committed.ledger.jsonl',
  );
  expect(entry.phase).toBe('committed');
});

test('createAbortedEntry creates entry with aborted phase', () => {
  const goal = createGoalState('s1', 'test');
  const transition = {
    source: 'update_goal' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'complete' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'done',
  };
  const entry = createAbortedEntry(
    goal,
    transition,
    '/nowhere/edge-aborted.ledger.jsonl',
  );
  expect(entry.phase).toBe('aborted');
});

test('appendWalEntry and readWalEntries round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  const goal = createGoalState('s1', 'test');
  const transition = {
    source: 'update_goal' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'complete' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'done',
  };
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(goal, transition, ledgerPath),
  );
  const entries = await readWalEntries(ledgerPath);
  expect(entries.length).toBe(1);
  expect(entries[0].phase).toBe('committed');
  await rm(dir, {recursive: true, force: true});
});

test('readWalEntries returns empty for missing file', async () => {
  const entries = await readWalEntries('/nonexistent/path/ledger.jsonl');
  expect(entries.length).toBe(0);
});

// Continuation Loop: Budget Detection

test('budgetLimitNeeded returns false when budgetLimitReported is true', () => {
  const goal = createGoalState('s1', 'test', {tokenBudget: 100});
  goal.budgetLimitReported = true;
  expect(budgetLimitNeeded(goal)).toBe(false);
});

test('budgetWrapupNeeded returns false when already sent', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 100000});
  goal.budgetWrapupSent = true;
  goal.totalTokens = 90000;
  expect(budgetWrapupNeeded(goal, 0.8)).toBe(false);
});

test('turnLimitReached checks turnCount vs maxTurns', () => {
  const goal = createGoalState('s1', 'test', {maxTurns: 5});
  goal.turnCount = 3;
  expect(turnLimitReached(goal)).toBe(false);
  goal.turnCount = 5;
  expect(turnLimitReached(goal)).toBe(true);
});

test('durationLimitReached checks elapsed time', () => {
  const goal = createGoalState('s1', 'test', {maxDurationMs: 1000});
  goal.startedAt = Date.now() - 2000;
  expect(durationLimitReached(goal)).toBe(true);
});

test('stopReason returns first limit reached', () => {
  const goal = createGoalState('s1', 'test', {
    maxTurns: 5,
    maxDurationMs: 100000,
    maxTokens: 100000,
  });
  expect(stopReason(goal)).toBe(null);
  goal.turnCount = 5;
  expect(stopReason(goal)).toBe('max turns reached');
});

// Continuation Loop: No-Progress Detection

test('isLowProgressTurn returns false for first turn', () => {
  const goal = createGoalState('s1', 'test');
  const ctx = {
    goal,
    pendingIntent: null,
    latestOutputTokens: 10,
    latestHasToolCall: false,
    latestHasThinkingTokens: false,
    assistantChanged: false,
    assistantRepeated: false,
    userInterventionDetected: false,
    activationBoundary: false,
  };
  expect(isLowProgressTurn(ctx, 50)).toBe(false);
});

test('isLowProgressTurn returns true for stalled continuation', () => {
  const goal = createGoalState('s1', 'test');
  goal.turnCount = 2;
  const ctx = {
    goal,
    pendingIntent: null,
    latestOutputTokens: 10,
    latestHasToolCall: false,
    latestHasThinkingTokens: false,
    assistantChanged: false,
    assistantRepeated: true,
    userInterventionDetected: false,
    activationBoundary: false,
  };
  expect(isLowProgressTurn(ctx, 50)).toBe(true);
});

test('isLowProgressTurn returns false when tool call present', () => {
  const goal = createGoalState('s1', 'test');
  goal.turnCount = 2;
  const ctx = {
    goal,
    pendingIntent: null,
    latestOutputTokens: 10,
    latestHasToolCall: true,
    latestHasThinkingTokens: false,
    assistantChanged: false,
    assistantRepeated: true,
    userInterventionDetected: false,
    activationBoundary: false,
  };
  expect(isLowProgressTurn(ctx, 50)).toBe(false);
});

// Continuation Loop: Pending Intent

test('validatePendingIntent rejects mismatched goalId', () => {
  const goal = createGoalState('s1', 'test');
  const intent = {
    goalId: 'wrong',
    revision: 0,
    runId: goal.runId,
    messageID: 'm1',
    toolCallID: 't1',
    targetStatus: 'complete' as const,
    evidence: '',
    createdAt: Date.now(),
  };
  expect(validatePendingIntent(intent, goal).valid).toBe(false);
});

test('validatePendingIntent rejects stale revision', () => {
  const goal = createGoalState('s1', 'test');
  const intent = {
    goalId: goal.goalId,
    revision: 99,
    runId: goal.runId,
    messageID: 'm1',
    toolCallID: 't1',
    targetStatus: 'complete' as const,
    evidence: '',
    createdAt: Date.now(),
  };
  expect(validatePendingIntent(intent, goal).valid).toBe(false);
});

test('validatePendingIntent accepts valid intent', () => {
  const goal = createGoalState('s1', 'test');
  const intent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: 'm1',
    toolCallID: 't1',
    targetStatus: 'complete' as const,
    evidence: '',
    createdAt: Date.now(),
  };
  expect(validatePendingIntent(intent, goal).valid).toBe(true);
});

// Steering: escapeGoalText

test('escapeGoalText escapes angle brackets and ampersands', () => {
  expect(escapeGoalText('</goal_objective>')).toBe('&lt;/goal_objective&gt;');
});

test('escapeGoalText escapes ampersands and angle brackets to prevent injection', () => {
  expect(escapeGoalText('a & b')).toBe('a &amp; b');
  expect(escapeGoalText('<script>')).toBe('&lt;script&gt;');
});

// Commands: formatStatus

test('formatStatus includes goal condition', () => {
  const goal = createGoalState('s1', 'my objective');
  expect(formatStatus(goal)).toMatch(/my objective/);
});

test('formatStatus includes token budget when set', () => {
  const goal = createGoalState('s1', 'test', {tokenBudget: 50000});
  const text = formatStatus(goal);
  expect(text).toMatch(/50,000/);
});

test('formatStatus includes stop reason when paused', () => {
  const goal = createGoalState('s1', 'test');
  goal.status = 'paused';
  goal.stopReason = 'user intervention';
  const text = formatStatus(goal);
  // PAUSED-VISIBILITY-1: the INVARIANT is that the stop reason is SHOWN. The
  // wording was re-specified because the raw ledger token is no longer rendered
  // — the user reported goals reading as bare "paused" while the model was still
  // working, so the user-intervention reason now says what is true AND what
  // happens next. The assertion is stronger than before: it requires the reason
  // to appear, and requires the ledger token NOT to leak.
  expect(text).toContain('yielding to your message; re-arms automatically');
  expect(text).not.toContain('user intervention');
});

// Commands: formatHistory

test('formatHistory with empty history', () => {
  expect(formatHistory([])).toBe('No lifecycle events recorded.');
});

test('formatHistory with entries', () => {
  const entries = [
    {type: 'set', detail: 'Goal created', timestamp: Date.now()},
    {type: 'paused', detail: 'User paused', timestamp: Date.now()},
  ];
  const text = formatHistory(entries);
  expect(text).toMatch(/Goal created/);
  expect(text).toMatch(/User paused/);
});

// Persistence: writeStateFile and recoverState

test('writeStateFile creates the state file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-state-'));
  const statePath = join(dir, 'state.json');
  const goal = createGoalState('s1', 'test');
  const ok = await writeStateFile(statePath, [goal], [], []);
  expect(ok).toBe(true);
  await rm(dir, {recursive: true, force: true});
});

test('recoverState returns empty when no files exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-recover-'));
  const result = await recoverState(
    join(dir, 'state.json'),
    join(dir, 'ledger.jsonl'),
  );
  expect(result.goals.length).toBe(0);
  expect(result.results.length).toBe(0);
  await rm(dir, {recursive: true, force: true});
});

test('recoverState reconstructs from state file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-recover2-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = join(dir, 'ledger.jsonl');
  const goal = createGoalState('s1', 'persisted goal', {tokenBudget: 50000});
  await writeStateFile(statePath, [goal], [], []);
  const recovered = await recoverState(statePath, ledgerPath);
  expect(recovered.goals.length).toBe(1);
  expect(recovered.goals[0].condition).toBe('persisted goal');
  await rm(dir, {recursive: true, force: true});
});

// createGoalState defaults

test('createGoalState sets default values', () => {
  const goal = createGoalState('s1', 'test');
  expect(goal.status).toBe('active');
  expect(goal.maxTokens).toBe(1000000);
  expect(goal.maxTurns).toBe(0);
  expect(goal.maxDurationMs).toBe(1800000);
  expect(goal.tokenBudget).toBe(null);
  expect(goal.mode).toBe('normal');
  expect(goal.turnCount).toBe(0);
  expect(goal.totalTokens).toBe(0);
  expect(goal.finalizing).toBe(false);
  expect(goal.budgetLimitReported).toBe(false);
  expect(goal.continuationClaim).toBe(null);
  expect(goal.pendingNotices).toEqual([]);
  expect(goal.history).toEqual([]);
  expect(goal.messageIDs).toBeInstanceOf(Set);
  expect(goal.executionContext).toBe(null);
});

test('createGoalState accepts custom options', () => {
  const goal = createGoalState('s1', 'test', {
    maxTokens: 100000,
    maxTurns: 20,
    maxDurationMs: 600000,
    tokenBudget: 50000,
    successCriteria: 'tests pass',
    constraints: 'no API changes',
    mode: 'ordered',
  });
  expect(goal.maxTokens).toBe(100000);
  expect(goal.maxTurns).toBe(20);
  expect(goal.maxDurationMs).toBe(600000);
  expect(goal.tokenBudget).toBe(50000);
  expect(goal.successCriteria).toBe('tests pass');
  expect(goal.constraints).toBe('no API changes');
  expect(goal.mode).toBe('ordered');
});

// DEFAULT_POLICY_OPTIONS

test('DEFAULT_POLICY_OPTIONS has expected values', () => {
  expect(DEFAULT_POLICY_OPTIONS.noProgressTokenThreshold).toBe(50);
  expect(DEFAULT_POLICY_OPTIONS.noProgressTurnsBeforePause).toBe(3);
  expect(DEFAULT_POLICY_OPTIONS.noToolCallTurnsBeforePause).toBe(3);
  expect(DEFAULT_POLICY_OPTIONS.budgetWrapupRatio).toBe(0.8);
});

// decideContinuation: more scenarios

test('decideContinuation returns budget-limit when budget exceeded', () => {
  const goal = createGoalState('s1', 'test', {tokenBudget: 100});
  goal.usage = {
    input: 50,
    output: 30,
    reasoning: 10,
    cacheRead: 0,
    cacheWrite: 20,
    cost: 0,
    costKnown: false,
  };
  const policy = createLoopPolicy();
  const decision = policy.decideContinuation({
    goal,
    pendingIntent: null,
    latestOutputTokens: 100,
    latestHasToolCall: true,
    latestHasThinkingTokens: false,
    assistantChanged: true,
    assistantRepeated: false,
    userInterventionDetected: false,
    activationBoundary: false,
  });
  expect(decision.type).toBe('budget-limit');
});

test('decideContinuation returns stop when turn limit reached', () => {
  const goal = createGoalState('s1', 'test', {maxTurns: 5});
  goal.turnCount = 5;
  const policy = createLoopPolicy();
  const decision = policy.decideContinuation({
    goal,
    pendingIntent: null,
    latestOutputTokens: 100,
    latestHasToolCall: true,
    latestHasThinkingTokens: false,
    assistantChanged: true,
    assistantRepeated: false,
    userInterventionDetected: false,
    activationBoundary: false,
  });
  expect(decision.type).toBe('stop');
});

test('decideContinuation returns continue with budgetWrapup when near limit', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 100000});
  goal.totalTokens = 85000;
  const policy = createLoopPolicy();
  const decision = policy.decideContinuation({
    goal,
    pendingIntent: null,
    latestOutputTokens: 100,
    latestHasToolCall: true,
    latestHasThinkingTokens: false,
    assistantChanged: true,
    assistantRepeated: false,
    userInterventionDetected: false,
    activationBoundary: false,
  });
  expect(decision.type).toBe('continue');
  if (decision.type === 'continue') {
    expect(decision.budgetWrapup).toBe(true);
  }
});

test('decideContinuation returns apply-pending-intent for valid intent', () => {
  const goal = createGoalState('s1', 'test');
  const intent = {
    goalId: goal.goalId,
    revision: goal.revision,
    runId: goal.runId,
    messageID: 'm1',
    toolCallID: 't1',
    targetStatus: 'complete' as const,
    evidence: '',
    createdAt: Date.now(),
  };
  const policy = createLoopPolicy();
  const decision = policy.decideContinuation({
    goal,
    pendingIntent: intent,
    latestOutputTokens: 100,
    latestHasToolCall: true,
    latestHasThinkingTokens: false,
    assistantChanged: true,
    assistantRepeated: false,
    userInterventionDetected: false,
    activationBoundary: false,
  });
  expect(decision.type).toBe('apply-pending-intent');
});
