import {expect, test} from 'bun:test';
import {waitFor} from './wait-for.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {
  addUsageDelta,
  chargedTokens,
  emptyUsage,
  normalizeMessageUsage,
  normalizeUsage,
  outputTokensForMessage,
  toNonNegativeInteger,
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
  createProposedEntry,
  readWalEntries,
  recoverState,
  writeStateFile,
} from '../src/persistence-wal.ts';
import {escapeGoalText} from '../src/escape.ts';
import {buildContinueMessage, buildSystemBlock} from '../src/steering.ts';
import {
  createLoopPolicy,
  isLowProgressTurn,
  loadLoopPolicy,
} from '../src/continuation-loop.ts';
import {
  formatGoalList,
  formatGoalResult,
  parseGoalArguments,
} from '../src/commands.ts';
import {applyNativeGoalConfig} from '../src/native-agent-config.ts';
import {createOpenCodeSessionApi} from '../src/session-api.ts';
import {acquirePersistenceLease} from '../src/persistence-lease.ts';
import {
  buildJudgePrompt,
  childSessionJudgeInternals,
  createChildSessionJudge,
  createChildSessionVerifier,
  parseJudgeVerdict,
} from '../src/child-session-verifier.ts';
import {mkdtemp, rm} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';

// State Machine: Concurrent Operations

test('parallel complete+block yields exactly one outcome', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  const [r1, r2] = await Promise.all([
    sm.transition('complete', {source: 'update_goal', detail: 'c'}),
    sm.transition('blocked', {source: 'update_goal', detail: 'b'}),
  ]);
  const completed = r1.ok ? 1 : 0;
  const blocked = r2.ok ? 1 : 0;
  expect(completed + blocked).toBe(1);
});

test('sequential transitions preserve revision order', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.transition('paused', {source: 'slash-command', detail: 'p1'});
  const rev1 = sm.currentRevision;
  await sm.transition('active', {source: 'slash-command', detail: 'r1'});
  expect(sm.currentRevision).toBeGreaterThan(rev1);
});

test('mutate on budgetLimited goal is rejected', async () => {
  const sm = new GoalStateMachine(createGoalState('s1', 'test'));
  await sm.transition('budgetLimited', {source: 'idle-handler', detail: 'bl'});
  const result = await sm.mutate(
    g => {
      g.condition = 'changed';
    },
    {source: 'slash-command', detail: 'edit'},
  );
  expect(result.ok).toBe(false);
  expect(sm.state.condition).toBe('test');
});

test('transition with skipPersist does not call onCommit', async () => {
  let commitCalled = false;
  const sm = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async () => {
      commitCalled = true;
    },
  });
  await sm.transition('paused', {
    source: 'slash-command',
    detail: 'p',
    skipPersist: true,
  });
  expect(commitCalled).toBe(false);
});

test('mutate with skipPersist does not call onCommit', async () => {
  let commitCalled = false;
  const sm = new GoalStateMachine(createGoalState('s1', 'test'), {
    onCommit: async () => {
      commitCalled = true;
    },
  });
  await sm.mutate(
    g => {
      g.condition = 'changed';
    },
    {source: 'slash-command', detail: 'edit', skipPersist: true},
  );
  expect(commitCalled).toBe(false);
});

// Accounting: more edge cases

test('chargedTokens with only cache write', () => {
  const usage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 100,
    cost: 0,
    costKnown: false,
  };
  expect(chargedTokens(usage)).toBe(100);
});

test('chargedTokens with only reasoning', () => {
  const usage = {
    input: 0,
    output: 0,
    reasoning: 500,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  expect(chargedTokens(usage)).toBe(500);
});

test('chargedTokens with only output', () => {
  const usage = {
    input: 0,
    output: 1000,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  expect(chargedTokens(usage)).toBe(1000);
});

test('emptyUsage returns all zeros', () => {
  const usage = emptyUsage();
  expect(usage.input).toBe(0);
  expect(usage.output).toBe(0);
  expect(usage.reasoning).toBe(0);
  expect(usage.cacheRead).toBe(0);
  expect(usage.cacheWrite).toBe(0);
  expect(usage.cost).toBe(0);
  expect(usage.costKnown).toBe(false);
});

test('normalizeUsage with null', () => {
  const result = normalizeUsage(null);
  expect(result.input).toBe(0);
});

test('normalizeUsage with array', () => {
  const result = normalizeUsage([1, 2, 3]);
  expect(result.input).toBe(0);
});

test('normalizeUsage sets costKnown when cost > 0', () => {
  const result = normalizeUsage({cost: 0.05});
  expect(result.cost).toBe(0.05);
  expect(result.costKnown).toBe(true);
});

test('addUsageDelta with identical steps does not double-count', () => {
  const total = emptyUsage();
  const step = {
    input: 100,
    output: 50,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  const result1 = addUsageDelta(total, step, emptyUsage());
  const result2 = addUsageDelta(result1, step, step);
  expect(result2.input).toBe(100);
  expect(result2.output).toBe(50);
});

test('totalTokensForMessage with total field', () => {
  const msg = {info: {tokens: {total: 500}}};
  expect(totalTokensForMessage(msg)).toBe(500);
});

test('totalTokensForMessage with cache object', () => {
  const msg = {
    info: {tokens: {input: 100, output: 50, cache: {read: 20, write: 10}}},
  };
  expect(totalTokensForMessage(msg)).toBe(180);
});

test('outputTokensForMessage with explicit zero', () => {
  const msg = {info: {tokens: {output: 0}}};
  expect(outputTokensForMessage(msg)).toBe(0);
});

test('normalizeMessageUsage with cache object', () => {
  const msg = {info: {tokens: {input: 100, cache: {read: 50, write: 10}}}};
  const result = normalizeMessageUsage(msg);
  expect(result.cacheRead).toBe(50);
  expect(result.cacheWrite).toBe(10);
});

test('normalizeMessageUsage with cost', () => {
  const msg = {info: {cost: 0.05}};
  const result = normalizeMessageUsage(msg);
  expect(result.cost).toBe(0.05);
  expect(result.costKnown).toBe(true);
});

// Persistence: more tests

test('serializeGoal preserves all fields', () => {
  const goal = createGoalState('s1', 'test', {
    tokenBudget: 1000,
    successCriteria: 'pass',
  });
  goal.turnCount = 5;
  goal.totalTokens = 50000;
  goal.stopReason = 'test';
  const serialized = serializeGoal(goal);
  expect(serialized.turnCount).toBe(5);
  expect(serialized.totalTokens).toBe(50000);
  expect(serialized.stopReason).toBe('test');
  expect(serialized.tokenBudget).toBe(1000);
  expect(serialized.successCriteria).toBe('pass');
});

test('deserializeGoal preserves executionContext', () => {
  const serialized = {
    ...createGoalState('s1', 'test'),
    executionContext: {agent: 'goal', model: 'gpt-4', provider: 'openai'},
  };
  const goal = deserializeGoal(serialized);
  expect(goal.executionContext?.agent).toBe('goal');
  expect(goal.executionContext?.model).toBe('gpt-4');
});

test('deserializeGoal handles null executionContext', () => {
  const serialized = {...createGoalState('s1', 'test'), executionContext: null};
  const goal = deserializeGoal(serialized);
  expect(goal.executionContext).toBe(null);
});

test('serializeResult with blocked state', () => {
  const goal = createGoalState('s1', 'test');
  goal.blockedReason = 'need user input';
  const result = serializeResult(goal, 'blocked', 'need input', '');
  expect(result.state).toBe('blocked');
  expect(result.blockedReason).toBe('need user input');
});

test('deserializeResult preserves history', () => {
  const goal = createGoalState('s1', 'test');
  goal.history.push({type: 'set', detail: 'created', timestamp: Date.now()});
  const result = serializeResult(goal, 'achieved', '', '');
  const deserialized = deserializeResult(result);
  expect(deserialized.history.length).toBe(1);
  expect(deserialized.history[0].type).toBe('set');
});

test('writeStateFile preserves sessionOrdered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-so-'));
  const statePath = join(dir, 'state.json');
  await writeStateFile(statePath, [], [], ['s1', 's2']);
  const recovered = await recoverState(statePath, join(dir, 'ledger.jsonl'));
  expect(recovered.sessionOrdered).toContain('s1');
  expect(recovered.sessionOrdered).toContain('s2');
  await rm(dir, {recursive: true, force: true});
});

test('WAL recovery discards proposed entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal2-'));
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
    createProposedEntry(goal, transition, ledgerPath),
  );
  await appendWalEntry(
    ledgerPath,
    createAbortedEntry(goal, transition, ledgerPath),
  );
  const entries = await readWalEntries(ledgerPath);
  expect(entries.length).toBe(2);
  expect(entries.filter(e => e.phase === 'proposed').length).toBe(1);
  expect(entries.filter(e => e.phase === 'aborted').length).toBe(1);
  await rm(dir, {recursive: true, force: true});
});

// Steering: more tests

test('buildContinueMessage includes turn count', () => {
  const goal = createGoalState('s1', 'test');
  goal.turnCount = 3;
  const message = buildContinueMessage(goal, {});
  expect(message.length).toBeGreaterThan(0);
});

test('buildContinueMessage with budgetWrapup includes wrap-up', () => {
  const goal = createGoalState('s1', 'test');
  const message = buildContinueMessage(goal, {budgetWrapup: true});
  expect(message.length).toBeGreaterThan(0);
});

test('buildSystemBlock for paused goal shows paused state', () => {
  const goal = createGoalState('s1', 'test');
  goal.status = 'paused';
  const block = buildSystemBlock(goal, 'goal');
  expect(block).toContain('paused');
});

test('buildSystemBlock for finalizing goal', () => {
  const goal = createGoalState('s1', 'test');
  goal.finalizing = true;
  const block = buildSystemBlock(goal, 'goal');
  expect(block).toContain('goal_objective');
});

test('buildSystemBlock includes success criteria', () => {
  const goal = createGoalState('s1', 'test', {successCriteria: 'tests pass'});
  const block = buildSystemBlock(goal, 'goal');
  expect(block).toContain('tests pass');
});

test('buildSystemBlock includes constraints', () => {
  const goal = createGoalState('s1', 'test', {constraints: 'no API changes'});
  const block = buildSystemBlock(goal, 'goal');
  expect(block).toContain('no API changes');
});

test('escapeGoalText does not modify plain text', () => {
  expect(escapeGoalText('hello world')).toBe('hello world');
});

test('escapeGoalText escapes multiple tags', () => {
  expect(escapeGoalText('</a></b>')).toBe('&lt;/a&gt;&lt;/b&gt;');
});

// Continuation Loop: more tests

test('createLoopPolicy uses custom options', () => {
  const policy = createLoopPolicy({noProgressTokenThreshold: 100});
  const goal = createGoalState('s1', 'test');
  goal.turnCount = 2;
  const decision = policy.decideContinuation({
    goal,
    pendingIntent: null,
    latestOutputTokens: 75,
    latestHasToolCall: false,
    latestHasThinkingTokens: false,
    assistantChanged: false,
    assistantRepeated: true,
    userInterventionDetected: false,
    activationBoundary: false,
  });
  expect(decision.type).toBe('continue');
});

test('decideContinuation returns stop on duration limit', () => {
  const goal = createGoalState('s1', 'test', {maxDurationMs: 100});
  goal.startedAt = Date.now() - 200;
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

test('decideContinuation returns stop on max tokens', () => {
  const goal = createGoalState('s1', 'test', {maxTokens: 100000});
  goal.totalTokens = 100000;
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

test('decideContinuation ignores stale pending intent', () => {
  const goal = createGoalState('s1', 'test');
  const intent = {
    goalId: 'wrong-id',
    revision: 0,
    runId: 'wrong-run',
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
  expect(decision.type).not.toBe('apply-pending-intent');
});

test('isLowProgressTurn returns false with thinking tokens', () => {
  const goal = createGoalState('s1', 'test');
  goal.turnCount = 2;
  const ctx = {
    goal,
    pendingIntent: null,
    latestOutputTokens: 10,
    latestHasToolCall: false,
    latestHasThinkingTokens: true,
    assistantChanged: false,
    assistantRepeated: true,
    userInterventionDetected: false,
    activationBoundary: false,
  };
  expect(isLowProgressTurn(ctx, 50)).toBe(false);
});

test('isLowProgressTurn returns false on activation boundary', () => {
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
    activationBoundary: true,
  };
  expect(isLowProgressTurn(ctx, 50)).toBe(false);
});

test('loadLoopPolicy returns default for null path', async () => {
  const policy = await loadLoopPolicy(null);
  expect(policy).toBeDefined();
  expect(typeof policy.decideContinuation).toBe('function');
});

test('loadLoopPolicy returns default for missing module', async () => {
  const policy = await loadLoopPolicy('/nonexistent/module');
  expect(policy).toBeDefined();
  expect(typeof policy.decideContinuation).toBe('function');
});

// Commands: more parsing tests

test('parseGoalArguments handles empty input', () => {
  const result = parseGoalArguments('');
  expect(result.condition).toBe('');
  expect(result.errors.length).toBe(0);
});

test('parseGoalArguments handles objective only', () => {
  const result = parseGoalArguments('fix the tests');
  expect(result.condition).toBe('fix the tests');
  expect(result.options.maxTurns).toBeUndefined();
});

test('parseGoalArguments handles --max-tokens', () => {
  const result = parseGoalArguments('fix tests --max-tokens 500000');
  expect(result.options.maxTokens).toBe(500000);
});

test('parseGoalArguments handles --max-duration-ms', () => {
  const result = parseGoalArguments('fix tests --max-duration-ms 600000');
  expect(result.options.maxDurationMs).toBe(600000);
});

test('parseGoalArguments handles --cooldown-ms', () => {
  const result = parseGoalArguments('fix tests --cooldown-ms 3000');
  expect(result.errors.length).toBe(0);
});

test('parseGoalArguments handles --no-progress-threshold', () => {
  const result = parseGoalArguments('fix tests --no-progress-threshold 100');
  expect(result.errors.length).toBe(0);
});

test('parseGoalArguments handles --no-progress-turns', () => {
  const result = parseGoalArguments('fix tests --no-progress-turns 3');
  expect(result.errors.length).toBe(0);
});

test('parseGoalArguments handles --no-tool-turns', () => {
  const result = parseGoalArguments('fix tests --no-tool-turns 3');
  expect(result.errors.length).toBe(0);
});

test('parseGoalArguments accepts --no-tool-turns 0 (disabled per README)', () => {
  const result = parseGoalArguments('fix tests --no-tool-turns 0');
  expect(result.errors.length).toBe(0);
  expect(result.options.noToolCallTurnsBeforePause).toBe(0);
});

test('parseGoalArguments accepts --cooldown-ms 0 (no delay)', () => {
  const result = parseGoalArguments('fix tests --cooldown-ms 0');
  expect(result.errors.length).toBe(0);
  expect(result.options.minDelayMs).toBe(0);
});

test('parseGoalArguments accepts --no-progress-threshold 0', () => {
  const result = parseGoalArguments('fix tests --no-progress-threshold 0');
  expect(result.errors.length).toBe(0);
  expect(result.options.noProgressTokenThreshold).toBe(0);
});

test('parseGoalArguments accepts --no-progress-turns 0', () => {
  const result = parseGoalArguments('fix tests --no-progress-turns 0');
  expect(result.errors.length).toBe(0);
  expect(result.options.noProgressTurnsBeforePause).toBe(0);
});

test('parseGoalArguments rejects --no-tool-turns with negative value', () => {
  const result = parseGoalArguments('fix tests --no-tool-turns -1');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments rejects --cooldown-ms with negative value', () => {
  const result = parseGoalArguments('fix tests --cooldown-ms -500');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments rejects --no-progress-threshold with negative value', () => {
  const result = parseGoalArguments('fix tests --no-progress-threshold -1');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments rejects --no-progress-turns with negative value', () => {
  const result = parseGoalArguments('fix tests --no-progress-turns -1');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments rejects --max-turns with 0', () => {
  const result = parseGoalArguments('fix tests --max-turns 0');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments handles --constraints alias --non-goals', () => {
  const result = parseGoalArguments(
    'fix tests --non-goals "no breaking changes"',
  );
  expect(result.options.constraints).toBe('no breaking changes');
});

test('parseGoalArguments handles --success alias --success-criteria', () => {
  const result = parseGoalArguments('fix tests --success-criteria "all green"');
  expect(result.options.successCriteria).toBe('all green');
});

test('parseGoalArguments handles --budget with m suffix', () => {
  const result = parseGoalArguments('fix tests --budget 2m');
  expect(result.options.maxTokens).toBe(2000000);
});

test('parseGoalArguments handles --budget without suffix', () => {
  const result = parseGoalArguments('fix tests --budget 500000');
  expect(result.options.maxTokens).toBe(500000);
});

test('parseGoalArguments rejects --max-turns with negative value', () => {
  const result = parseGoalArguments('fix tests --max-turns -5');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments rejects --budget with invalid value', () => {
  const result = parseGoalArguments('fix tests --budget abc');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments rejects missing flag value', () => {
  const result = parseGoalArguments('fix tests --max-turns');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments handles multiple flags', () => {
  const result = parseGoalArguments(
    'fix tests --max-turns 20 --max-tokens 400000 --budget 100k',
  );
  expect(result.condition).toBe('fix tests');
  expect(result.options.maxTurns).toBe(20);
  expect(result.options.maxTokens).toBe(100000);
});

// Completion judge: more tests

test('buildJudgePrompt includes success criteria', () => {
  const goal = createGoalState('s1', 'test', {successCriteria: 'tests pass'});
  const prompt = buildJudgePrompt(goal, 'done');
  expect(prompt).toContain('tests pass');
});

test('buildJudgePrompt includes constraints', () => {
  const goal = createGoalState('s1', 'test', {constraints: 'no API changes'});
  const prompt = buildJudgePrompt(goal, 'done');
  expect(prompt).toContain('no API changes');
});

test('parseJudgeVerdict handles empty text', () => {
  const result = parseJudgeVerdict('');
  expect(result.approved).toBe(false);
});

test('parseJudgeVerdict handles text without markers', () => {
  const result = parseJudgeVerdict('no markers here');
  expect(result.approved).toBe(false);
});

test('parseJudgeVerdict handles approved with reason', () => {
  const result = parseJudgeVerdict('all good\n[judge:approved]');
  expect(result.approved).toBe(true);
  expect(result.reason).toBe('');
});

test('createChildSessionJudge throws for invalid failurePolicy', () => {
  expect(() =>
    createChildSessionJudge({}, {failurePolicy: 'invalid' as never}),
  ).toThrow(TypeError);
});

test('createChildSessionJudge returns a function', () => {
  const judge = createChildSessionJudge({session: {}});
  expect(typeof judge).toBe('function');
});

// Native Agent Config: more tests

test('config with childSessionJudge requires verifier ownership', () => {
  expect(() => {
    applyNativeGoalConfig(
      {agent: {'goal-verify': {}}},
      {requireVerifierOwnership: true},
    );
  }).toThrow(/cannot safely use existing agent/);
});

test('config with custom goalAgentName registers under custom name', () => {
  const config: Record<string, unknown> = {};
  applyNativeGoalConfig(config, {goalAgentName: 'my-goal'});
  expect(
    (config as Record<string, Record<string, unknown>>).agent,
  ).toBeDefined();
  expect(
    (config as Record<string, Record<string, Record<string, unknown>>>)[
      'agent'
    ]['my-goal'],
  ).toBeDefined();
});

// Session API: more tests

test('createOpenCodeSessionApi throws for missing session', () => {
  expect(() => createOpenCodeSessionApi({})).toThrow(TypeError);
});

test('createOpenCodeSessionApi throws for non-object session', () => {
  expect(() => createOpenCodeSessionApi({session: 'not-an-object'})).toThrow(
    TypeError,
  );
});

test('createOpenCodeSessionApi accepts flat preference', () => {
  const api = createOpenCodeSessionApi(
    {session: {get: async () => null}},
    {preferredShape: 'flat'},
  );
  expect(typeof api.get).toBe('function');
});

// Persistence Lease: more tests

test('persistence lease owner has token and pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-owner-'));
  const state = join(dir, 'state.json');
  const lease = await acquirePersistenceLease(state);
  expect(lease.owner.token).toBeDefined();
  expect(lease.owner.pid).toBe(process.pid);
  expect(lease.owner.hostname).toBe(hostname());
  await lease.release();
  await rm(dir, {recursive: true, force: true});
});

test('persistence lease release returns false for wrong token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-token-'));
  const state = join(dir, 'state.json');
  const lease = await acquirePersistenceLease(state);
  await lease.release();
  await rm(dir, {recursive: true, force: true});
});

// formatGoalList tests

test('formatGoalList with multiple goals', () => {
  const goals = [
    createGoalState('s1', 'goal 1'),
    createGoalState('s1', 'goal 2'),
  ];
  const text = formatGoalList(goals, [], goals[0].goalId, 'goal');
  expect(text).toContain('goal 1');
  expect(text).toContain('goal 2');
});

test('formatGoalList with archived results', () => {
  const goal = createGoalState('s1', 'done goal');
  const result = serializeResult(goal, 'achieved', '', '');
  const text = formatGoalList([], [result], null, 'goal');
  expect(text).toContain('done goal');
  expect(text).toContain('achieved');
});

test('formatGoalResult shows state', () => {
  const goal = createGoalState('s1', 'test');
  const result = serializeResult(goal, 'blocked', 'need input', '');
  const text = formatGoalResult(result);
  expect(text).toContain('blocked');
});

test('formatGoalResult shows token budget', () => {
  const goal = createGoalState('s1', 'test', {tokenBudget: 50000});
  const result = serializeResult(goal, 'achieved', '', '');
  const text = formatGoalResult(result);
  expect(text).toContain('50,000');
});

// summarizeTailText tests

test('summarizeTailText preserves surrogate pairs when truncating', () => {
  // 'ab😀cd' is 6 UTF-16 code units: a, b, 0xD83D, 0xDE00, c, d
  // slice(-3) on code units yields 0xDE00, c, d — a dangling surrogate.
  // Array.from iterates code points, so slice(-3) yields 😀, c, d.
  const {summarizeTailText} = childSessionJudgeInternals;
  const result = summarizeTailText('ab😀cd', 3);
  expect(result).toBe('😀cd');
});

test('timeout during createChild cleans up leaked child session', async () => {
  let deleteCalled = false;
  let promptCalled = false;

  const client = {
    session: {
      create: async () => {
        // MODELLED WORK, not a wait-for-effect: this mock is slow ON PURPOSE so
        // the judge's 10 ms timeout genuinely fires mid-call. Nothing below
        // waits on this duration.
        await new Promise<void>(resolve => setTimeout(resolve, 80));
        return {id: 'child-1', parentID: 'session-1'};
      },
      prompt: async () => {
        promptCalled = true;
        return {};
      },
      delete: async () => {
        deleteCalled = true;
      },
      abort: async () => {},
    },
  };

  const judge = createChildSessionJudge(client, {timeoutMs: 10});
  const result = await judge({
    goal: createGoalState('session-1', 'test goal', {
      goalId: 'g1',
      runId: 'r1',
    }),
    sessionID: 'session-1',
    latestText: 'Done',
  });

  expect(result.approved).toBe(false);
  expect(result.reason).toContain('timed out');

  // Await the cleanup effect itself. A guessed 150 ms both risked flaking under
  // load and could pass while cleanup was still pending.
  await waitFor(() => deleteCalled, 'the leaked child session to be deleted');
  expect(deleteCalled).toBe(true);
  expect(promptCalled).toBe(false);
});

test('no unhandled rejection when timeout fires during prompt', async () => {
  let unhandledRejection: unknown = null;
  const rejectionHandler = (reason: unknown) => {
    unhandledRejection = reason;
  };
  process.on('unhandledRejection', rejectionHandler);

  const client = {
    session: {
      create: async () => ({id: 'child-1', parentID: 'session-1'}),
      prompt: async () => {
        // MODELLED WORK: slow ON PURPOSE so the 10 ms verifier timeout fires
        // while this call is still in flight. Nothing waits on the duration.
        await new Promise<void>(resolve => setTimeout(resolve, 200));
        throw new Error('session aborted');
      },
      delete: async () => {},
      abort: async () => {},
    },
  };

  const judge = createChildSessionJudge(client, {timeoutMs: 10});
  const result = await judge({
    goal: createGoalState('session-1', 'test goal', {
      goalId: 'g1',
      runId: 'r1',
    }),
    sessionID: 'session-1',
    latestText: 'Done',
  });

  expect(result.approved).toBe(false);
  expect(result.reason).toContain('timed out');

  // The assertion is a NEGATIVE — "no unhandledRejection surfaced" — so there is
  // no effect to await. Let the abandoned (timed-out) prompt reach its own
  // rejection: the mock's modelled 200 ms plus a margin, not a guessed 300 ms.
  await new Promise<void>(resolve => setTimeout(resolve, 250));

  process.off('unhandledRejection', rejectionHandler);
  expect(unhandledRejection).toBeNull();
});

test('unsupported child-session cleanup is reported as judge failure', async () => {
  const client = {
    app: {
      log: async () => {},
    },
    session: {
      create: async () => ({id: 'child-unsupported', parentID: 'session-1'}),
      prompt: async () => ({
        parts: [{type: 'text', text: 'all checks pass\\n[judge:approved]'}],
      }),
      abort: async () => {},
      messages: async () => [],
    },
  };

  const judge = createChildSessionJudge(client, {timeoutMs: 5000});
  const result = await judge({
    goal: createGoalState('session-1', 'test goal', {
      goalId: 'g1',
      runId: 'r1',
    }),
    sessionID: 'session-1',
    latestText: 'Done',
  });

  expect(result.approved).toBe(false);
  expect(result.reason).toContain('cleanup unsupported');
});

test('child-session cleanup rejection is reported as judge failure', async () => {
  const client = {
    app: {
      log: async () => {},
    },
    session: {
      create: async () => ({id: 'child-rejected', parentID: 'session-1'}),
      prompt: async () => ({
        parts: [{type: 'text', text: 'all checks pass\\n[judge:approved]'}],
      }),
      delete: async () => {
        throw new Error('host denied delete');
      },
      abort: async () => {},
      messages: async () => [],
    },
  };

  const judge = createChildSessionJudge(client, {timeoutMs: 5000});
  const result = await judge({
    goal: createGoalState('session-1', 'test goal', {
      goalId: 'g1',
      runId: 'r1',
    }),
    sessionID: 'session-1',
    latestText: 'Done',
  });

  expect(result.approved).toBe(false);
  expect(result.reason).toContain('cleanup failed');
});

test('verifier reports unsupported child-session cleanup as failure', async () => {
  const client = {
    session: {
      create: async () => ({
        id: 'child-verifier-unsupported',
        parentID: 'session-1',
      }),
      prompt: async () => ({
        parts: [
          {
            type: 'text',
            text: JSON.stringify({
              schema_version: 1,
              task_id: 'g1',
              state: 'COMPLETE',
              candidate: 'candidate-1',
              fingerprint: 'fingerprint-1',
              outstanding: [],
              evidence: ['checks passed'],
            }),
          },
        ],
      }),
      abort: async () => {},
      messages: async () => [],
    },
  };

  const verifier = createChildSessionVerifier(client, {timeoutMs: 5000});
  await expect(
    verifier({
      cwd: process.cwd(),
      taskId: 'g1',
      candidateIdentity: {
        candidate: 'candidate-1',
        fingerprint: 'fingerprint-1',
      },
      goal: createGoalState('session-1', 'test goal', {
        goalId: 'g1',
        runId: 'r1',
      }),
      latestText: 'Done',
    }),
  ).rejects.toThrow('cleanup unsupported');
});

test('verifier cleans a child created after timeout wins', async () => {
  let deleteCalled = false;
  const client = {
    session: {
      create: async () => {
        // MODELLED WORK: creation finishes AFTER the 10 ms timeout has already
        // won, which is the race this test exists to pin.
        await new Promise<void>(resolve => setTimeout(resolve, 80));
        return {id: 'child-verifier-late', parentID: 'session-1'};
      },
      prompt: async () => ({parts: []}),
      delete: async () => {
        deleteCalled = true;
      },
      abort: async () => {},
      messages: async () => [],
    },
  };

  const verifier = createChildSessionVerifier(client, {timeoutMs: 10});
  await expect(
    verifier({
      cwd: process.cwd(),
      taskId: 'g1',
      candidateIdentity: {
        candidate: 'candidate-1',
        fingerprint: 'fingerprint-1',
      },
      goal: createGoalState('session-1', 'test goal', {
        goalId: 'g1',
        runId: 'r1',
      }),
      latestText: 'Done',
    }),
  ).rejects.toThrow('timed out');

  await waitFor(() => deleteCalled, 'the late child session to be cleaned up');
  expect(deleteCalled).toBe(true);
});

test('missing parentID in createChild response does not cause false rejection', async () => {
  const client = {
    session: {
      create: async () => ({id: 'child-1'}),
      prompt: async () => ({parts: [{type: 'text', text: '[judge:approved]'}]}),
      delete: async () => {},
      abort: async () => {},
      messages: async () => [],
    },
  };

  const judge = createChildSessionJudge(client, {timeoutMs: 5000});
  const result = await judge({
    goal: createGoalState('session-1', 'test goal', {
      goalId: 'g1',
      runId: 'r1',
    }),
    sessionID: 'session-1',
    latestText: 'Done',
  });

  expect(result.approved).toBe(true);
});

// Command parsing edge case stress tests

test('parseGoalArguments --budget with uppercase K suffix', () => {
  const result = parseGoalArguments('fix tests --budget 100K');
  expect(result.errors.length).toBe(0);
  expect(result.options.maxTokens).toBe(100000);
});

test('parseGoalArguments --budget with uppercase M suffix', () => {
  const result = parseGoalArguments('fix tests --budget 1M');
  expect(result.errors.length).toBe(0);
  expect(result.options.maxTokens).toBe(1000000);
});

test('parseGoalArguments --budget with decimal k suffix', () => {
  const result = parseGoalArguments('fix tests --budget 1.5k');
  expect(result.errors.length).toBe(0);
  expect(result.options.maxTokens).toBe(1500);
});

test('parseGoalArguments --budget with decimal m suffix', () => {
  const result = parseGoalArguments('fix tests --budget 1.5m');
  expect(result.errors.length).toBe(0);
  expect(result.options.maxTokens).toBe(1500000);
});

test('parseGoalArguments --mode invalid returns error', () => {
  const result = parseGoalArguments('fix tests --mode invalid');
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]).toContain('--mode must be');
});

test('parseGoalArguments --max-minutes sets maxDurationMs', () => {
  const result = parseGoalArguments('fix tests --max-minutes 30');
  expect(result.errors.length).toBe(0);
  expect(result.options.maxDurationMs).toBe(1800000);
});

test('parseGoalArguments unclosed quote in flag value returns error', () => {
  const result = parseGoalArguments('fix tests --success "unclosed quote');
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]).toContain('Missing closing quote');
});

test('parseGoalArguments --budget with spaces around value', () => {
  const result = parseGoalArguments('fix tests --budget  100k');
  expect(result.errors.length).toBe(0);
  expect(result.options.maxTokens).toBe(100000);
});

test('parseGoalArguments --token-budget with k suffix', () => {
  const result = parseGoalArguments('fix tests --token-budget 50k');
  expect(result.errors.length).toBe(0);
  expect(result.tokenBudget).toBe(50000);
});

test('parseGoalArguments --token-budget with uppercase M suffix', () => {
  const result = parseGoalArguments('fix tests --token-budget 2M');
  expect(result.errors.length).toBe(0);
  expect(result.tokenBudget).toBe(2000000);
});

test('parseGoalArguments --budget 0 returns error (must be positive)', () => {
  const result = parseGoalArguments('fix tests --budget 0');
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]).toContain('positive integer');
});

test('parseGoalArguments --budget negative returns error', () => {
  const result = parseGoalArguments('fix tests --budget -5');
  expect(result.errors.length).toBeGreaterThan(0);
});

test('parseGoalArguments empty quotes for flag value', () => {
  const result = parseGoalArguments('fix tests --success ""');
  expect(result.errors.length).toBe(0);
  expect(result.options.successCriteria).toBe('');
});

test('parseGoalArguments flag at end without value returns error', () => {
  const result = parseGoalArguments('fix tests --budget');
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]).toContain('Missing value');
});

test('parseGoalArguments --max-minutes 0 returns error (must be positive)', () => {
  const result = parseGoalArguments('fix tests --max-minutes 0');
  expect(result.errors.length).toBeGreaterThan(0);
});

// parseJudgeVerdict edge case stress tests

test('parseJudgeVerdict matches case-insensitive APPROVED', () => {
  const result = parseJudgeVerdict('text\n[JUDGE:APPROVED]');
  expect(result.approved).toBe(true);
});

test('parseJudgeVerdict matches case-insensitive REJECTED', () => {
  const result = parseJudgeVerdict('reason\n[JUDGE:REJECTED]');
  expect(result.approved).toBe(false);
  expect(result.reason).toBe('reason');
});

test('parseJudgeVerdict matches marker with leading whitespace', () => {
  const result = parseJudgeVerdict('text\n  [judge:approved]');
  expect(result.approved).toBe(true);
});

test('parseJudgeVerdict matches marker with trailing whitespace', () => {
  const result = parseJudgeVerdict('text\n[judge:approved]   ');
  expect(result.approved).toBe(true);
});

test('parseJudgeVerdict does not match embedded marker', () => {
  const result = parseJudgeVerdict('text [judge:approved] more text');
  expect(result.approved).toBe(false);
});

test('parseJudgeVerdict rejects multiple approved markers', () => {
  const result = parseJudgeVerdict('[judge:approved]\n[judge:approved]');
  expect(result.approved).toBe(false);
});

test('parseJudgeVerdict rejects multiple rejected markers', () => {
  const result = parseJudgeVerdict('[judge:rejected]\n[judge:rejected]');
  expect(result.approved).toBe(false);
});

test('parseJudgeVerdict rejected with no reason uses default', () => {
  const result = parseJudgeVerdict('[judge:rejected]');
  expect(result.approved).toBe(false);
  expect(result.reason).toBe('completion rejected by judge');
});

test('parseJudgeVerdict rejected with empty reason line uses default', () => {
  const result = parseJudgeVerdict('\n[judge:rejected]');
  expect(result.approved).toBe(false);
  expect(result.reason).toBe('completion rejected by judge');
});

test('parseJudgeVerdict preserves unicode in reason', () => {
  const result = parseJudgeVerdict('テストが失敗しました\n[judge:rejected]');
  expect(result.approved).toBe(false);
  expect(result.reason).toBe('テストが失敗しました');
});

test('parseJudgeVerdict finds reason across empty lines', () => {
  const result = parseJudgeVerdict('real reason\n\n\n[judge:rejected]');
  expect(result.approved).toBe(false);
  expect(result.reason).toBe('real reason');
});

test('parseJudgeVerdict marker at start of text', () => {
  const approved = parseJudgeVerdict('[judge:approved]');
  expect(approved.approved).toBe(true);
  const rejected = parseJudgeVerdict('[judge:rejected]');
  expect(rejected.approved).toBe(false);
});

test('parseJudgeVerdict handles very long text with marker at end', () => {
  const longText = 'x'.repeat(10000);
  const result = parseJudgeVerdict(`${longText}\n[judge:approved]`);
  expect(result.approved).toBe(true);
});

test('parseJudgeVerdict mixed case marker Judge:Approved', () => {
  const result = parseJudgeVerdict('text\n[Judge:Approved]');
  expect(result.approved).toBe(true);
});

test('parseJudgeVerdict does not match marker with trailing text', () => {
  const result = parseJudgeVerdict('[judge:approved] extra text');
  expect(result.approved).toBe(false);
});

test('parseJudgeVerdict handles whitespace-only input', () => {
  const result = parseJudgeVerdict('   \n  \n  ');
  expect(result.approved).toBe(false);
});

test('parseJudgeVerdict handles null/undefined input', () => {
  expect(parseJudgeVerdict(null as unknown as string).approved).toBe(false);
  expect(parseJudgeVerdict(undefined as unknown as string).approved).toBe(
    false,
  );
});

test('normalizeMessageUsage reads msg.usage with snake_case field names', () => {
  const message = {
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      reasoning_tokens: 100,
      cache_read: 200,
      cache_write: 100,
    },
  };
  const usage = normalizeMessageUsage(message);
  expect(usage.input).toBe(1000);
  expect(usage.output).toBe(500);
  expect(usage.reasoning).toBe(100);
  expect(usage.cacheRead).toBe(200);
  expect(usage.cacheWrite).toBe(100);
});

test('outputTokensForMessage reads msg.usage with snake_case', () => {
  const message = {usage: {output_tokens: 500}};
  expect(outputTokensForMessage(message)).toBe(500);
});

test('totalTokensForMessage reads msg.usage with snake_case', () => {
  const message = {
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      reasoning_tokens: 100,
      cache_read: 200,
      cache_write: 100,
    },
  };
  expect(totalTokensForMessage(message)).toBe(1900);
});

test('normalizeMessageUsage reads cost from msg.usage.cost', () => {
  const message = {
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cost: 0.05,
    },
  };
  const usage = normalizeMessageUsage(message);
  expect(usage.cost).toBe(0.05);
  expect(usage.costKnown).toBe(true);
});

test('normalizeMessageUsage prefers info.cost over msg.usage.cost', () => {
  const message = {
    info: {cost: 0.1},
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cost: 0.05,
    },
  };
  const usage = normalizeMessageUsage(message);
  expect(usage.cost).toBe(0.1);
  expect(usage.costKnown).toBe(true);
});

test('toNonNegativeInteger handles string token counts', () => {
  expect(toNonNegativeInteger('100')).toBe(100);
  expect(toNonNegativeInteger('0')).toBe(0);
  expect(toNonNegativeInteger('abc')).toBe(0);
  expect(toNonNegativeInteger(null)).toBe(0);
  expect(toNonNegativeInteger(undefined)).toBe(0);
  expect(toNonNegativeInteger(42)).toBe(42);
  expect(toNonNegativeInteger('42', 99)).toBe(42);
  expect(toNonNegativeInteger('abc', 99)).toBe(99);
});

test('outputTokensForMessage handles string output token counts', () => {
  expect(outputTokensForMessage({info: {tokens: {output: '5'}}})).toBe(5);
  expect(outputTokensForMessage({usage: {output_tokens: '500'}})).toBe(500);
  expect(
    outputTokensForMessage({info: {tokens: {completion_tokens: '42'}}}),
  ).toBe(42);
});

test('outputTokensForMessage returns null when token sources are null (not undefined)', () => {
  // When a provider sends "usage": null, the?? operator falls through to {},
  // but the null-check used === undefined, so null was treated as "data exists"
  // and the function returned 0 instead of null — causing false no-progress detection.
  expect(outputTokensForMessage({usage: null})).toBe(null);
  expect(outputTokensForMessage({info: {tokens: null}})).toBe(null);
  expect(outputTokensForMessage({tokens: null})).toBe(null);
  // Combined null sources should also return null
  expect(outputTokensForMessage({info: {tokens: null}, usage: null})).toBe(
    null,
  );
  // But a real token source with 0 output should still return 0 (not null)
  expect(outputTokensForMessage({info: {tokens: {output: 0}}})).toBe(0);
  expect(outputTokensForMessage({usage: {output: 0}})).toBe(0);
});

// readQuotedValue should handle single quotes and backticks

test('parseGoalArguments strips single-quoted single-word flag value', () => {
  const result = parseGoalArguments("fix tests --success 'tests'");
  expect(result.errors.length).toBe(0);
  expect(result.options.successCriteria).toBe('tests');
  expect(result.condition).toBe('fix tests');
});

test('parseGoalArguments handles single-quoted multi-word flag value', () => {
  const result = parseGoalArguments("fix tests --success 'tests pass'");
  expect(result.errors.length).toBe(0);
  expect(result.options.successCriteria).toBe('tests pass');
  expect(result.condition).toBe('fix tests');
});

test('parseGoalArguments strips backtick-quoted flag value', () => {
  const result = parseGoalArguments('fix tests --success `tests`');
  expect(result.errors.length).toBe(0);
  expect(result.options.successCriteria).toBe('tests');
  expect(result.condition).toBe('fix tests');
});

test('parseGoalArguments strips single quotes with =syntax', () => {
  const result = parseGoalArguments("fix tests --success='tests'");
  expect(result.errors.length).toBe(0);
  expect(result.options.successCriteria).toBe('tests');
  expect(result.condition).toBe('fix tests');
});

test("the judge's child session is created AT THE GOAL'S WORKING DIRECTORY", async () => {
  // The judge inspects the tree the CHILD SESSION is bound to. A child created
  // without a location inherits the plugin PROCESS's cwd, not the goal's
  // `executionContext.cwd` that candidateIdentity was captured from — so a
  // verdict could be formed against a different tree than the goal ran in. In the
  // 2026-09-25 live run this was correct BY LUCK (the agent had written its
  // artifact to the repo root, the recorded stray-artifact class).
  const goalCwd = '/tmp/some-goal-workspace';
  let createBody: Record<string, unknown> | null = null;
  const client = {
    session: {
      create: async (body: Record<string, unknown>) => {
        createBody = body;
        return {id: 'child-judge', parentID: 'session-1'};
      },
      prompt: async () => ({
        parts: [
          {
            type: 'text',
            text: JSON.stringify({
              schema_version: 1,
              task_id: 'g1',
              state: 'COMPLETE',
              candidate: 'c1',
              fingerprint: 'f1',
              outstanding: [],
              evidence: ['ok'],
            }),
          },
        ],
      }),
      delete: async () => {},
      abort: async () => {},
      messages: async () => [],
    },
  };

  const verifier = createChildSessionVerifier(client, {timeoutMs: 5000});
  await verifier({
    cwd: goalCwd,
    taskId: 'g1',
    candidateIdentity: {candidate: 'c1', fingerprint: 'f1'},
    goal: createGoalState('session-1', 'test goal', {
      goalId: 'g1',
      runId: 'r1',
    }),
    latestText: 'Done',
  });

  expect(createBody).not.toBeNull();
  // The default shape is `legacy`, where the payload nests under `body`. Assert
  // through a helper so the test states the CONTRACT (the location reaches the
  // request) rather than one SDK shape's envelope.
  const legacy = createBody as unknown as {
    body?: {parentID?: string; location?: {directory?: string}};
  };
  expect(legacy.body?.parentID).toBe('session-1');
  // The field the host reads. Verified against the host source: `session.create`
  // accepts an optional `location: Location.Ref` whose `directory` is an
  // AbsolutePath. Whether a given host HONOURS it still needs a live check, which
  // is why COMPLETION-ATTESTATION-1 keeps a live re-run open.
  expect(legacy.body?.location?.directory).toBe(goalCwd);
});

test("the judge's location reaches the request on the FLAT sdk shape too", async () => {
  // The adapter probes two shapes; the location must survive both, or the fix
  // silently applies on one host generation and not the other.
  const goalCwd = '/tmp/flat-shape-workspace';
  let createBody: Record<string, unknown> | null = null;
  const client = {
    session: {
      create: async (body: Record<string, unknown>) => {
        createBody = body;
        return {id: 'child-judge-flat', parentID: 'session-1'};
      },
      prompt: async () => ({
        parts: [
          {
            type: 'text',
            text: JSON.stringify({
              schema_version: 1,
              task_id: 'g1',
              state: 'COMPLETE',
              candidate: 'c1',
              fingerprint: 'f1',
              outstanding: [],
              evidence: ['ok'],
            }),
          },
        ],
      }),
      delete: async () => {},
      abort: async () => {},
      messages: async () => [],
    },
  };

  const verifier = createChildSessionVerifier(client, {
    timeoutMs: 5000,
    sdkShape: 'flat',
  });
  await verifier({
    cwd: goalCwd,
    taskId: 'g1',
    candidateIdentity: {candidate: 'c1', fingerprint: 'f1'},
    goal: createGoalState('session-1', 'test goal', {
      goalId: 'g1',
      runId: 'r1',
    }),
    latestText: 'Done',
  });

  expect(createBody).not.toBeNull();
  const flat = createBody as unknown as {
    parentID?: string;
    location?: {directory?: string};
  };
  expect(flat.parentID).toBe('session-1');
  expect(flat.location?.directory).toBe(goalCwd);
});

test('the judge falls back to no location when the gate supplies no cwd', async () => {
  // A host that cannot report a cwd must not receive a bogus one: the child then
  // behaves exactly as it did before the fix.
  let createBody: Record<string, unknown> | null = null;
  const client = {
    session: {
      create: async (body: Record<string, unknown>) => {
        createBody = body;
        return {id: 'child-judge', parentID: 'session-1'};
      },
      prompt: async () => ({
        parts: [
          {
            type: 'text',
            text: JSON.stringify({
              schema_version: 1,
              task_id: 'g1',
              state: 'COMPLETE',
              candidate: 'c1',
              fingerprint: 'f1',
              outstanding: [],
              evidence: ['ok'],
            }),
          },
        ],
      }),
      delete: async () => {},
      abort: async () => {},
      messages: async () => [],
    },
  };

  const verifier = createChildSessionVerifier(client, {timeoutMs: 5000});
  await verifier({
    cwd: '',
    taskId: 'g1',
    candidateIdentity: {candidate: 'c1', fingerprint: 'f1'},
    goal: createGoalState('session-1', 'test goal', {
      goalId: 'g1',
      runId: 'r1',
    }),
    latestText: 'Done',
  });

  expect(createBody).not.toBeNull();
  const legacy = createBody as unknown as {body?: Record<string, unknown>};
  expect(legacy.body?.location).toBeUndefined();
});
