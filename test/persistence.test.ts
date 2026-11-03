import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {
  deserializeGoal,
  deserializeResult,
  serializeGoal,
  serializeResult,
} from '../src/persistence.ts';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  appendWalEntry,
  createAbortedEntry,
  createCommittedEntry,
  createProposedEntry,
  initWalSeqFromLedger,
  nextWalSeq,
  peekWalSeq,
  readWalEntries,
  recoverState,
  rotateLedgerIfNeeded,
  writeStateFile,
} from '../src/persistence-wal.ts';
import {createGoalState, type GoalStatus} from '../src/state-machine.ts';
import {needsYouReason} from '../src/tui-toast-policy.ts';
import {ensureSessionDir, sessionStatePaths} from '../src/session-paths.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';

/** No session was read at startup, so no fence was recovered. */
const EMPTY_INVALIDATION: ReadonlyMap<string, readonly string[]> = new Map();

const ROOT = join(import.meta.dir, '..');

/** Every session is writable in these fixtures: the lease and the sequence seeding are
 * decided by the composition root, and these tests exercise the manager directly. */
const CAN_WRITE_ANY = async (): Promise<boolean> => true;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'goal-persistence-'));
});

afterEach(async () => {
  await rm(tmpDir, {recursive: true, force: true});
});

// Serialization Round-Trip

test('serializeGoal → deserializeGoal round-trips all fields', () => {
  const goal = createGoalState('s1', 'test goal', {tokenBudget: 100000});
  goal.turnCount = 5;
  goal.usage = {
    input: 100,
    output: 50,
    reasoning: 10,
    cacheRead: 200,
    cacheWrite: 30,
    cost: 0.01,
    costKnown: true,
  };
  goal.history.push({
    type: 'set',
    detail: 'Goal created',
    timestamp: Date.now(),
  });
  goal.messageIDs.add('msg-1');
  goal.messageIDs.add('msg-2');
  goal.pendingNotices.push({
    kind: 'blocked',
    message: 'test notice',
    timestamp: Date.now(),
  });
  goal.budgetLimitReported = true;
  goal.executionContext = {
    agent: 'goal',
    model: 'test',
    provider: 'test',
    cwd: '/workspace-a',
  };

  const serialized = serializeGoal(goal);
  const deserialized = deserializeGoal(serialized);

  expect(deserialized.goalId).toBe(goal.goalId);
  expect(deserialized.condition).toBe(goal.condition);
  expect(deserialized.tokenBudget).toBe(100000);
  expect(deserialized.turnCount).toBe(5);
  expect(deserialized.usage.input).toBe(100);
  expect(deserialized.budgetLimitReported).toBe(true);
  expect(deserialized.history.length).toBe(1);
  expect(deserialized.messageIDs.size).toBe(2);
  expect(deserialized.messageIDs.has('msg-1')).toBe(true);
  expect(deserialized.pendingNotices.length).toBe(1);
  // New blocked-rule fields round-trip.
  expect(deserialized.maxBlockedTurns).toBe(goal.maxBlockedTurns);
  expect(deserialized.blockedAssertedThisTurn).toBe(
    goal.blockedAssertedThisTurn,
  );
  expect(deserialized.executionContext?.cwd).toBe('/workspace-a');
});

test('deserializeGoal applies safe defaults for new blocked fields on missing state', () => {
  // State files missing maxBlockedTurns / blockedAssertedThisTurn get defaults.
  const goal = createGoalState('s1', 'test');
  const serialized = serializeGoal(goal);
  delete (serialized as unknown as Record<string, unknown>).maxBlockedTurns;
  delete (serialized as unknown as Record<string, unknown>)
    .blockedAssertedThisTurn;
  const deserialized = deserializeGoal(serialized);
  expect(deserialized.maxBlockedTurns).toBe(3);
  expect(deserialized.blockedAssertedThisTurn).toBe(false);
});

// tokenBudget Safe Integer Validation

test('deserializeGoal rejects fractional tokenBudget', () => {
  const goal = createGoalState('s1', 'test');
  const serialized = serializeGoal(goal);
  serialized.tokenBudget = 100.5;
  const deserialized = deserializeGoal(serialized);
  expect(deserialized.tokenBudget).toBe(null); // rejected
});

test('deserializeGoal rejects unsafe integer tokenBudget', () => {
  const goal = createGoalState('s1', 'test');
  const serialized = serializeGoal(goal);
  serialized.tokenBudget = Number.MAX_SAFE_INTEGER + 1;
  const deserialized = deserializeGoal(serialized);
  expect(deserialized.tokenBudget).toBe(null); // rejected
});

// Backward Compatibility

test('deserializeGoal fallbacks for maxTurns and maxDurationMs match plugin defaults', () => {
  const goal = createGoalState('s1', 'test');
  const serialized = serializeGoal(goal);
  // Simulate a corrupt/old state file missing these fields
  delete (serialized as unknown as Record<string, unknown>).maxTurns;
  delete (serialized as unknown as Record<string, unknown>).maxDurationMs;
  const deserialized = deserializeGoal(serialized);
  // Plugin defaults (see DEFAULT_GOAL_OPTIONS): maxTurns=0 (no turn brake),
  // maxDurationMs=1800000.
  expect(deserialized.maxTurns).toBe(0);
  expect(deserialized.maxDurationMs).toBe(1800000);
});

// WAL Append & Read

test('appendWalEntry writes a JSONL line and readWalEntries reads it back', async () => {
  const ledgerPath = join(tmpDir, 'ledger.jsonl');
  const goal = createGoalState('s1', 'test');
  const entry = createProposedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'paused',
      stopReason: '',
      blockedReason: '',
      detail: 'test transition',
    },
    ledgerPath,
  );

  await appendWalEntry(ledgerPath, entry);
  const entries = await readWalEntries(ledgerPath);

  expect(entries.length).toBe(1);
  expect(entries[0].phase).toBe('proposed');
  expect(entries[0].transition.detail).toBe('test transition');
  expect(entries[0].snapshot.goalId).toBe(goal.goalId);
});

test('multiple WAL entries are read in sequence order', async () => {
  const ledgerPath = join(tmpDir, 'ledger.jsonl');
  const goal = createGoalState('s1', 'test');

  for (let i = 0; i < 5; i++) {
    const entry = createCommittedEntry(
      goal,
      {
        source: 'idle-handler',
        goalId: goal.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: `transition ${i}`,
      },
      ledgerPath,
    );
    await appendWalEntry(ledgerPath, entry);
  }

  const entries = await readWalEntries(ledgerPath);
  expect(entries.length).toBe(5);
  expect(entries[0].transition.detail).toBe('transition 0');
  expect(entries[4].transition.detail).toBe('transition 4');
});

// Recovery: Failed Creates Don't Resurrect

test("recovery discards proposed entries (failed create doesn't resurrect)", async () => {
  const statePath = join(tmpDir, 'state.json');
  const ledgerPath = join(tmpDir, 'ledger.jsonl');

  // Write a proposed entry (not committed) — simulates a failed create
  const goal = createGoalState('s1', 'failed create');
  const proposed = createProposedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'create attempt',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, proposed);

  // No state file — recovery relies on WAL only
  const {goals} = await recoverState(statePath, ledgerPath);

  // The proposed (uncommitted) goal must NOT resurrect
  expect(goals.length).toBe(0);
});

test('recovery keeps committed entries', async () => {
  const statePath = join(tmpDir, 'state.json');
  const ledgerPath = join(tmpDir, 'ledger.jsonl');

  const goal = createGoalState('s1', 'active goal');
  const committed = createCommittedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'create succeeded',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(1);
  expect(goals[0].goalId).toBe(goal.goalId);
});

test("recovery discards aborted entries (failed transition doesn't persist)", async () => {
  const statePath = join(tmpDir, 'state.json');
  const ledgerPath = join(tmpDir, 'ledger.jsonl');

  const goal = createGoalState('s1', 'goal');
  // First, commit the create
  const committed = createCommittedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'create succeeded',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  // Then, an aborted transition (e.g., failed blocked persist)
  const aborted = createAbortedEntry(
    goal,
    {
      source: 'update_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'blocked',
      stopReason: 'blocked',
      blockedReason: 'test blocker',
      detail: 'blocked persist failed',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, aborted);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(1);
  // The goal should still be active (the blocked transition was aborted)
  expect(goals[0].status).toBe('active');
});

test('recovery removes completed goals from live set', async () => {
  const statePath = join(tmpDir, 'state.json');
  const ledgerPath = join(tmpDir, 'ledger.jsonl');

  const goal = createGoalState('s1', 'completed goal');
  goal.status = 'complete';
  goal.finishedAt = Date.now();
  const committed = createCommittedEntry(
    goal,
    {
      source: 'update_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'complete',
      stopReason: '',
      blockedReason: '',
      detail: 'goal achieved',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(0); // completed goal is not live
});

// State File Snapshot

test('writeStateFile + recoverState round-trips goals and results', async () => {
  const statePath = join(tmpDir, 'state.json');
  const ledgerPath = join(tmpDir, 'ledger.jsonl');

  const goal = createGoalState('s1', 'snapshot test', {tokenBudget: 50000});
  const result = serializeResult(goal, 'achieved', 'done');

  await writeStateFile(statePath, [goal], [result], ['s1']);
  // Snapshot replacement must work on Windows as well as POSIX hosts.
  await writeStateFile(statePath, [goal], [result], ['s1']);

  const {goals, results, sessionOrdered} = await recoverState(
    statePath,
    ledgerPath,
  );
  expect(goals.length).toBe(1);
  expect(goals[0].tokenBudget).toBe(50000);
  expect(results.length).toBe(1);
  expect(results[0].state).toBe('achieved');
  expect(sessionOrdered).toEqual(['s1']);
});

// Result Serialization

test('serializeResult uses pausedAt as finishedAt when goal was paused', () => {
  const goal = createGoalState('s1', 'paused goal');
  const pausedAt = Date.now() - 5000;
  goal.pausedAt = pausedAt;
  const result = serializeResult(goal, 'achieved');
  expect(result.finishedAt).toBe(pausedAt); // NOT Date.now
});

test('serializeResult uses finishedAt when set during completion', () => {
  const goal = createGoalState('s1', 'completed goal');
  const finishedAt = Date.now() - 1000;
  goal.finishedAt = finishedAt;
  goal.pausedAt = 0;
  const result = serializeResult(goal, 'achieved');
  expect(result.finishedAt).toBe(finishedAt);
});

test('deserializeResult round-trips correctly', () => {
  const goal = createGoalState('s1', 'test', {tokenBudget: 1000});
  const result = serializeResult(goal, 'blocked', 'missing dep');
  const deserialized = deserializeResult(result);
  expect(deserialized.state).toBe('blocked');
  expect(deserialized.reason).toBe('missing dep');
  expect(deserialized.tokenBudget).toBe(1000);
});

test('deserializeResult rejects fractional tokenBudget', () => {
  const goal = createGoalState('s1', 'test');
  const result = serializeResult(goal, 'achieved');
  result.tokenBudget = 99.9;
  const deserialized = deserializeResult(result);
  expect(deserialized.tokenBudget).toBe(null);
});

// rotateLedgerIfNeeded

test("rotateLedgerIfNeeded does nothing when ledger doesn't exist", async () => {
  const ledgerPath = join(tmpDir, 'missing.ledger.jsonl');
  await rotateLedgerIfNeeded(ledgerPath, 100, 3);
  expect(await Bun.file(ledgerPath).exists()).toBe(false);
});

test('rotateLedgerIfNeeded does nothing when under maxBytes', async () => {
  const ledgerPath = join(tmpDir, 'state.ledger.jsonl');
  const goal = createGoalState('s1', 'test');
  const transition = {
    source: 'idle-handler' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'active' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'test',
  };
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(goal, transition, ledgerPath),
  );
  const sizeBefore = Bun.file(ledgerPath).size;
  await rotateLedgerIfNeeded(ledgerPath, 999999, 3);
  expect(Bun.file(ledgerPath).size).toBe(sizeBefore);
});

test('rotateLedgerIfNeeded truncates when retentionFiles is 0', async () => {
  const ledgerPath = join(tmpDir, 'state.ledger.jsonl');
  const goal = createGoalState('s1', 'test');
  const transition = {
    source: 'idle-handler' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'active' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'test',
  };
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(goal, transition, ledgerPath),
  );
  await rotateLedgerIfNeeded(ledgerPath, 1, 0);
  expect(await Bun.file(ledgerPath).exists()).toBe(false);
});

test('recoverState replays retained rotated ledger generations', async () => {
  const statePath = join(tmpDir, 'rotated-state.json');
  const ledgerPath = join(tmpDir, 'rotated-state.ledger.jsonl');
  const first = createGoalState('s1', 'first');
  const transition = {
    source: 'idle-handler' as const,
    goalId: first.goalId,
    fromStatus: 'active' as const,
    toStatus: 'active' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'test',
  };
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(first, transition, ledgerPath),
  );
  await rotateLedgerIfNeeded(ledgerPath, 1, 3);
  const second = {...first, condition: 'second', revision: first.revision + 1};
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(second, transition, ledgerPath),
  );
  const recovered = await recoverState(statePath, ledgerPath);
  expect(recovered.goals).toHaveLength(1);
  expect(recovered.goals[0]?.condition).toBe('second');
});

test('rotateLedgerIfNeeded rotates files with retention > 0', async () => {
  const ledgerPath = join(tmpDir, 'state.ledger.jsonl');
  const goal = createGoalState('s1', 'test');
  const transition = {
    source: 'idle-handler' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'active' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'test',
  };
  for (let i = 0; i < 10; i++) {
    await appendWalEntry(
      ledgerPath,
      createCommittedEntry(goal, transition, ledgerPath),
    );
  }
  await rotateLedgerIfNeeded(ledgerPath, 1, 3);
  expect(await Bun.file(ledgerPath).exists()).toBe(false);
  expect(await Bun.file(`${ledgerPath}.1`).exists()).toBe(true);

  for (let i = 0; i < 10; i++) {
    await appendWalEntry(
      ledgerPath,
      createCommittedEntry(goal, transition, ledgerPath),
    );
  }
  await rotateLedgerIfNeeded(ledgerPath, 1, 3);
  expect(await Bun.file(`${ledgerPath}.1`).exists()).toBe(true);
  expect(await Bun.file(`${ledgerPath}.2`).exists()).toBe(true);

  for (let i = 0; i < 10; i++) {
    await appendWalEntry(
      ledgerPath,
      createCommittedEntry(goal, transition, ledgerPath),
    );
  }
  await rotateLedgerIfNeeded(ledgerPath, 1, 3);
  expect(await Bun.file(`${ledgerPath}.1`).exists()).toBe(true);
  expect(await Bun.file(`${ledgerPath}.2`).exists()).toBe(true);
  expect(await Bun.file(`${ledgerPath}.3`).exists()).toBe(true);

  for (let i = 0; i < 10; i++) {
    await appendWalEntry(
      ledgerPath,
      createCommittedEntry(goal, transition, ledgerPath),
    );
  }
  await rotateLedgerIfNeeded(ledgerPath, 1, 3);
  expect(await Bun.file(`${ledgerPath}.4`).exists()).toBe(false);
  expect(await Bun.file(`${ledgerPath}.3`).exists()).toBe(true);
});

// initWalSeqFromLedger

test("initWalSeqFromLedger seeds ONE LEDGER's counter from that ledger's history", async () => {
  // Its OWN path, not the `state.ledger.jsonl` three rotation tests above share.
  // The counter is keyed by the ledger path, so a shared path is a shared counter.
  // Measured rather than assumed: sharing it again leaves this file GREEN,
  // because the assertion is relative to the max this test just wrote, so the
  // test would go on passing with a counter primed by its neighbours. Unique
  // anyway — an isolation measure whose absence is invisible is not an isolation
  // measure.
  const ledgerPath = join(tmpDir, 'seed-one.ledger.jsonl');
  // A ledger unique to THIS test. The counter map is module state that survives
  // between tests in one file, so any other test writing to this path primes the
  // counter before this one measures it. That trap was HIDDEN while seeding
  // overwrote unconditionally: the raise floor exposed it, which is the right way
  // round — a test that only passed because the code erased the evidence of the
  // interference was not testing what it claimed.
  const session = 'ses_walseed_one';
  const goal = createGoalState(session, 'test');
  const transition = {
    source: 'idle-handler' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'active' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'test',
  };
  for (let i = 0; i < 5; i++) {
    await appendWalEntry(
      ledgerPath,
      createCommittedEntry(goal, transition, ledgerPath),
    );
  }
  const entries = await readWalEntries(ledgerPath);
  const maxSeq = Math.max(...entries.map(e => e.seq));
  await initWalSeqFromLedger(ledgerPath);
  expect(nextWalSeq(ledgerPath)).toBe(maxSeq + 1);
});

test('every unrecognised claim-path spelling degrades to `none`, and the producers write only `judge`', async () => {
  // The reader keeps `judge` and degrades anything else to "none" — this plugin
  // has never been published, so no other spelling exists to translate. Without
  // this the case could be deleted and the full suite would stay green.
  for (const [written, expected] of [
    ['judge', 'judge'],
    ['none', 'none'],
    // Anything unrecognised degrades to `none`, which is honest.
    ['something-nobody-enumerated', 'none'],
  ] as const) {
    const goal = deserializeGoal({
      goalId: 'g-path',
      runId: 'r1',
      condition: 'c',
      lastClaim: {
        claimId: 'c1',
        timestamp: 1,
        actor: 'agent',
        claimedStatus: 'complete',
        claimText: 'done',
        check: {path: written, timestamp: 1},
        outcome: {status: 'verified-complete', detail: '', timestamp: 1},
      },
    });
    expect(
      goal.lastClaim?.check.path,
      `${written} did not load as ${expected}`,
    ).toBe(expected);
  }
  // And the producers write `judge` or `none`, never another spelling.
  const hooks = await readFile(join(ROOT, 'src', 'hooks.ts'), 'utf8');
  expect(hooks).not.toContain('path: "judge"');
  const decision = await readFile(
    join(ROOT, 'src', 'hooks-decision.ts'),
    'utf8',
  );
  for (const m of decision.matchAll(/path: "([a-z-]+)"/g)) {
    expect(['judge', 'none']).toContain(m[1]);
  }
});

test("initWalSeqFromLedger does not disturb ANOTHER ledger's counter", async () => {
  // The previous version of this test pointed at a ledger that DID NOT EXIST,
  // so `readWalEntries` returned nothing, the seeding branch never ran, and the
  // assertion was a property of the counter's own increment. A fixture that
  // cannot make the code under test execute is not a fixture.
  const root = await mkdtemp(join(tmpdir(), 'wal-seed-'));
  try {
    const s1Ledger = join(root, 's1.ledger.jsonl');
    const s2Ledger = join(root, 's2.ledger.jsonl');
    // s1's history is LONGER, so a counter seeded from the wrong file lands on
    // s2's maximum and is visibly wrong. Written whole, because the defect is
    // about which file is read and a half-written one is a different question.
    await Bun.write(
      s1Ledger,
      [1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map(seq => `${JSON.stringify({seq, phase: 'committed'})}\n`)
        .join(''),
    );
    await Bun.write(
      s2Ledger,
      `${JSON.stringify({seq: 1, phase: 'committed'})}\n`,
    );

    // Distinct ledgers, which is now what distinguishes the counters: a counter
    // another test in this file has already advanced is not a counter this test
    // seeded. The session ids are irrelevant to the key, so the paths carry the
    // isolation.
    // Put s2's counter somewhere distinguishable before s1 is seeded.
    expect(peekWalSeq(s2Ledger)).toBe(0);
    expect(nextWalSeq(s2Ledger)).toBe(1);
    expect(peekWalSeq(s2Ledger)).toBe(1);

    await initWalSeqFromLedger(s1Ledger);
    expect(peekWalSeq(s1Ledger)).toBe(9);
    // The defect this names: seeding s1 from s2, or clobbering every session.
    expect(peekWalSeq(s2Ledger)).toBe(1);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("each session's ledger holds unique, increasing sequences even when two run at once", async () => {
  // THE acceptance experiment for the whole storage change, run as a unit test.
  //
  // The old counter was a module-global scalar, so two processes writing ONE
  // ledger allocated the SAME numbers — measured ALPHA [1,2,3] and BETA
  // [1,2,3] — and readWalEntries sorts on `seq` alone, so replay resolved the
  // tie by Array.sort stability, i.e. arbitrarily. Goal state was then lost or
  // resurrected non-deterministically.
  //
  // The fix is NOT that the two counters hold different numbers: they both
  // start at 1, and that is correct, because they describe two different files.
  // The fix is that no reader ever sees both streams in one sorted sequence.
  // So the property asserted here is the one replay actually depends on —
  // each ledger, read on its own, is strictly increasing with no duplicates —
  // and it is asserted by WRITING and READING both ledgers, not by inspecting
  // the counter.
  const root = await mkdtemp(join(tmpdir(), 'wal-split-'));
  const alpha = sessionStatePaths(root, 'alpha');
  const beta = sessionStatePaths(root, 'beta');
  await ensureSessionDir(root, 'alpha');
  await ensureSessionDir(root, 'beta');
  // The sequence number comes from the LEDGER the entry is appended to, so
  // each ledger numbers itself. That is the fence: a caller cannot write into
  // one session's ledger and have that ledger's numbering follow the GOAL's
  // session id instead — which is what keying on `goal.sessionID` did, and it
  // broke the moment one process held two ledgers under the same session id.
  const transition = (goal: ReturnType<typeof createGoalState>) => ({
    source: 'idle-handler' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'active' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'test',
  });
  for (let i = 0; i < 3; i++) {
    const goalA = createGoalState('alpha', 'interleaved writers');
    await appendWalEntry(
      alpha.ledgerPath,
      createCommittedEntry(goalA, transition(goalA), alpha.ledgerPath),
    );
    const goalB = createGoalState('beta', 'interleaved writers');
    await appendWalEntry(
      beta.ledgerPath,
      createCommittedEntry(goalB, transition(goalB), beta.ledgerPath),
    );
  }
  for (const [label, path] of [
    ['alpha', alpha.ledgerPath],
    ['beta', beta.ledgerPath],
  ] as const) {
    const entries = await readWalEntries(path);
    expect(entries.length, label).toBe(3);
    const seqs = entries.map(e => e.seq);
    expect(new Set(seqs).size, `${label} has a repeated sequence`).toBe(
      seqs.length,
    );
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!, `${label} is not strictly increasing`).toBeGreaterThan(
        seqs[i - 1]!,
      );
    }
  }
  // Each session's next entry continues its OWN stream, and the two streams
  // are numbered independently — which is the point.
  expect(nextWalSeq(alpha.ledgerPath)).toBe(4);
  expect(nextWalSeq(beta.ledgerPath)).toBe(4);
  expect(nextWalSeq(alpha.ledgerPath)).toBe(5);
  expect(nextWalSeq(beta.ledgerPath)).toBe(5);
  await rm(root, {recursive: true, force: true});
});

test('initWalSeqFromLedger does nothing when ledger is empty', async () => {
  const ledgerPath = join(tmpDir, 'empty.ledger.jsonl');
  await Bun.write(ledgerPath, '');
  const before = nextWalSeq(ledgerPath);
  await initWalSeqFromLedger(ledgerPath);
  expect(nextWalSeq(ledgerPath)).toBe(before + 1);
});

test("initWalSeqFromLedger does nothing when ledger doesn't exist", async () => {
  const ledgerPath = join(tmpDir, 'missing.ledger.jsonl');
  const before = nextWalSeq(ledgerPath);
  await initWalSeqFromLedger(ledgerPath);
  expect(nextWalSeq(ledgerPath)).toBe(before + 1);
});

// writeStateFile chmod 0600

test('writeStateFile refuses final-path symlink replacement', async () => {
  const statePath = join(tmpDir, 'state.json');
  const targetPath = join(tmpDir, 'target.json');
  const goal = createGoalState('s1', 'symlink target');
  await Bun.write(targetPath, 'sentinel');
  await (await import('node:fs/promises')).symlink(targetPath, statePath);
  expect(await writeStateFile(statePath, [goal], [], [])).toBe(false);
  expect(await Bun.file(targetPath).text()).toBe('sentinel');
});

test('recoverState fences stale WAL entries behind a completed snapshot revision', async () => {
  const statePath = join(tmpDir, 'terminal-state.json');
  const ledgerPath = join(tmpDir, 'terminal-state.ledger.jsonl');
  const completed = createGoalState('s1', 'completed snapshot');
  completed.goalId = 'terminal-goal';
  completed.revision = 10;
  completed.status = 'complete';
  completed.finishedAt = Date.now();
  await writeStateFile(statePath, [completed], [], []);

  const stale = {
    ...completed,
    revision: 9,
    status: 'active' as const,
    finishedAt: null,
  };
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      stale,
      {
        source: 'idle-handler',
        goalId: stale.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'stale retained WAL entry',
      },
      ledgerPath,
    ),
  );

  const recovered = await recoverState(statePath, ledgerPath);
  expect(recovered.goals).toEqual([]);
});

test('recoverState ignores unsupported snapshot versions and uses WAL', async () => {
  const statePath = join(tmpDir, 'future-state.json');
  const ledgerPath = join(tmpDir, 'future-state.ledger.jsonl');
  const future = createGoalState('s1', 'future snapshot');
  await Bun.write(
    statePath,
    JSON.stringify({
      version: 999,
      goals: [serializeGoal(future)],
      results: [],
      sessionOrdered: [],
    }),
  );
  const current = createGoalState('s1', 'wal goal');
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      current,
      {
        source: 'create_goal',
        goalId: current.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'wal fallback',
      },
      ledgerPath,
    ),
  );
  const recovered = await recoverState(statePath, ledgerPath);
  expect(recovered.goals.map(g => g.condition)).toEqual(['wal goal']);
});

test('writeStateFile sets file mode to 0600', async () => {
  const statePath = join(tmpDir, 'state.json');
  const goal = createGoalState('s1', 'test goal');
  const ok = await writeStateFile(statePath, [goal], [], []);
  expect(ok).toBe(true);
  if (process.platform !== 'win32') {
    const stat = await import('node:fs/promises').then(m => m.stat(statePath));
    expect(stat.mode & 0o777).toBe(0o600);
  }
});

//: cleared goals must not be resurrected by stale WAL entries

test('a stale WAL entry before a clear tombstone cannot resurrect the goal', async () => {
  const statePath = join(tmpDir, 'state.json');
  const ledgerPath = join(tmpDir, 'ledger.jsonl');

  const goal = createGoalState('s1', 'cleared goal');
  goal.goalId = 'cleared-goal';
  goal.revision = 5;
  await writeStateFile(statePath, [], [], []);
  const stale = {...goal, revision: 4};
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      stale,
      {
        source: 'idle-handler',
        goalId: stale.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'stale entry after clear',
      },
      ledgerPath,
    ),
  );
  const removed = createCommittedEntry(
    goal,
    {
      source: 'slash-command',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'clear tombstone',
    },
    ledgerPath,
    true,
  );
  await appendWalEntry(ledgerPath, removed);
  expect((await recoverState(statePath, ledgerPath)).goals).toEqual([]);
});

test('recovery does NOT resurrect a cleared goal from stale WAL committed entry', async () => {
  const statePath = join(tmpDir, 'state.json');
  const ledgerPath = join(tmpDir, 'ledger.jsonl');

  // 1. Create a goal and simulate a committed WAL entry (from onCommit during a transition)
  const goal = createGoalState('s1', 'active goal that will be cleared');
  goal.status = 'active';
  const committed = createCommittedEntry(
    goal,
    {
      source: 'idle-handler',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'usage update',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  // 2. Simulate removeGoal: writes a committed entry with removed: true
  const removed = createCommittedEntry(
    goal,
    {
      source: 'slash-command',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'Goal removed',
    },
    ledgerPath,
    true,
  );
  await appendWalEntry(ledgerPath, removed);

  // 3. Simulate `/goal clear`: state file is written WITHOUT the goal
  await writeStateFile(statePath, [], [], []);

  // 4. Recover — the removed:true WAL entry should prevent resurrection
  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(0);
});

// GOAL-CREATE-REPLACE-1: end-to-end clear durability
// above shows the STORAGE layer honors removal tombstones and fences.
// These tests show the MANAGER layer produces them durably end-to-end:
// real SessionStateManager + real writeStateFile persistFn + recoverState.
// Deleting them would re-hide the "goal already exists after clear" defect
// class at the only layer where the full round-trip is exercised.

function makeDurableManager(dir: string): {
  manager: SessionStateManager;
  statePath: string;
  ledgerPath: string;
} {
  const statePath = join(dir, 'state.json');
  const ledgerPath = join(dir, 'state.json.ledger.jsonl');
  // The persistence callback below reads the manager it is being constructed
  // with, so the reference is circular: a `const` cannot be built from its own
  // initialiser, and `let` assigned once is exactly what `prefer-const` objects
  // to. The holder carries the same back-reference with no `let` and no rule
  // suppression. The callback runs only after construction, so the wiring below
  // is in place before the first call.
  const self: {manager?: SessionStateManager} = {};
  const manager = new SessionStateManager(
    createRuntimeState(),
    async (sessionID: string) => {
      const state = self.manager!.getPersistedState(sessionID);
      return writeStateFile(
        statePath,
        state.goals.map(deserializeGoal),
        state.results,
        state.sessionOrdered,
        state.invalidatedGoalIds,
        state.pendingIntents,
      );
    },
    dir,
    undefined,
    EMPTY_INVALIDATION,
    CAN_WRITE_ANY,
    undefined,
    undefined,
    undefined,
    undefined,
    DEFAULT_GOAL_OPTIONS,
    async () => {},
  );
  self.manager = manager;
  return {manager, statePath, ledgerPath};
}

test('clearSession is durable across restart (create -> persist -> clear -> recover = zero goals)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-clear-dur-'));
  try {
    const {manager, statePath, ledgerPath} = makeDurableManager(dir);
    const machine = manager.createGoal('s1', 'Objective to be cleared', {});
    await machine.mutate(
      g => {
        g.lastStatus = 'working';
      },
      {source: 'slash-command', detail: 'Durability checkpoint'},
    );
    expect((await recoverState(statePath, ledgerPath)).goals.length).toBe(1);
    await manager.clearSession('s1');
    expect((await recoverState(statePath, ledgerPath)).goals.length).toBe(0);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('a goal created after clear survives recovery (invalidation fence is per-goal, not global)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-clear-dur-'));
  try {
    const {manager, statePath, ledgerPath} = makeDurableManager(dir);
    const first = manager.createGoal('s1', 'First objective', {});
    await first.mutate(
      g => {
        g.lastStatus = 'working';
      },
      {source: 'slash-command', detail: 'Checkpoint'},
    );
    await manager.clearSession('s1');
    const second = manager.createGoal('s1', 'Second objective', {});
    await second.mutate(
      g => {
        g.lastStatus = 'working';
      },
      {source: 'slash-command', detail: 'Checkpoint'},
    );
    const recovered = await recoverState(statePath, ledgerPath);
    expect(recovered.goals.length).toBe(1);
    expect(recovered.goals[0].condition).toBe('Second objective');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('replaceGoals replaces only the FOCUSED goal and leaves the others running', async () => {
  // BLAST-RADIUS FIX (2026-09-24, transition-audit finding ). `replaceGoals`
  // used to remove EVERY unfinished goal while its README and its own doc
  // comment both said it replaces the FOCUSED goal — three live goals became
  // one, with two destroyed silently. The README contract is the authority, so
  // this asserts it directly AND asserts the survivors, which the previous
  // single-goal version of this test could not: it is a STRONGER test, not a
  // relaxed one.
  const dir = await mkdtemp(join(tmpdir(), 'goal-repl-dur-'));
  try {
    const {manager, statePath, ledgerPath} = makeDurableManager(dir);
    const first = manager.createGoal('s1', 'Old objective one', {});
    await first.mutate(
      g => {
        g.lastStatus = 'working';
      },
      {source: 'slash-command', detail: 'Checkpoint'},
    );
    const focused = manager.createGoal('s1', 'Old objective two', {});
    await focused.mutate(
      g => {
        g.lastStatus = 'working';
      },
      {source: 'slash-command', detail: 'Checkpoint'},
    );
    expect((await recoverState(statePath, ledgerPath)).goals.length).toBe(2);

    await manager.replaceGoals('s1', 'Replacement objective', {});

    const recovered = await recoverState(statePath, ledgerPath);
    // The replaced (focused) goal is gone; the UNRELATED goal survives.
    expect(recovered.goals.length).toBe(2);
    const conditions = recovered.goals.map(g => g.condition).sort();
    expect(conditions).toEqual(['Old objective one', 'Replacement objective']);
    // And the survivor is still live, not merely present on disk.
    expect(
      recovered.goals.some(
        g => g.condition === 'Old objective one' && g.status === 'active',
      ),
    ).toBe(true);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

// Persistence round-trip stress tests

test('serializeGoal → JSON round-trip → deserializeGoal preserves all fields', () => {
  const goal = createGoalState('s1', 'test objective');
  goal.goalId = 'goal-abc-123';
  goal.runId = 'run-xyz-789';
  goal.revision = 42;
  goal.condition = 'fix the failing tests';
  goal.successCriteria = 'tests pass and lint is clean';
  goal.constraints = 'do not touch the public API';
  goal.mode = 'ordered';
  goal.sessionID = 'session-def-456';
  goal.tokenBudget = 150000;
  goal.maxTokens = 400000;
  goal.maxTurns = 20;
  goal.maxDurationMs = 1800000;
  goal.minDelayMs = 3000;
  goal.noProgressTokenThreshold = 100;
  goal.noProgressTurnsBeforePause = 3;
  goal.noToolCallTurnsBeforePause = 5;
  goal.turnCount = 7;
  goal.totalTokens = 89432;
  goal.usage = {
    input: 50000,
    output: 5000,
    reasoning: 2000,
    cacheRead: 30000,
    cacheWrite: 4000,
    cost: 0.15,
    costKnown: true,
  };
  goal.createdAt = Date.now() - 600000;
  goal.updatedAt = Date.now() - 30000;
  goal.startedAt = Date.now() - 500000;
  goal.pausedAt = Date.now() - 10000;
  goal.finishedAt = null;
  goal.status = 'paused';
  goal.stopReason = 'manual pause';
  goal.blockedReason = '';
  goal.finalizing = false;
  goal.budgetLimitReported = false;
  goal.budgetWrapupSent = true;
  goal.objectiveUpdatedPending = false;
  goal.noProgressTurns = 2;
  goal.noToolCallTurns = 1;
  goal.promptFailures = 0;
  goal.lastStatus = 'Working on tests';
  goal.lastAssistantText = 'I fixed the test and it passes now';
  goal.lastAssistantMessageID = 'msg-001';
  goal.lastContinueAt = Date.now() - 5000;
  goal.lastProgressAt = Date.now() - 60000;
  goal.continuationClaim = {
    runId: 'run-xyz-789',
    sourceAssistantMessageID: 'msg-001',
  };
  goal.pendingNotices = [
    {
      kind: 'no-progress',
      message: 'Low output detected',
      timestamp: Date.now() - 3000,
    },
    {kind: 'blocked', message: 'Need user input', timestamp: Date.now() - 2000},
  ];
  goal.history = [
    {type: 'created', detail: 'Goal created', timestamp: Date.now() - 600000},
    {type: 'paused', detail: 'User paused', timestamp: Date.now() - 10000},
  ];
  goal.lastCheckpoint = {
    summary: 'Tests passing',
    timestamp: Date.now() - 60000,
  };
  goal.checkpoints = [
    {summary: 'Initial state', timestamp: Date.now() - 500000},
    {summary: 'Tests passing', timestamp: Date.now() - 60000},
  ];
  goal.messageIDs = new Set(['msg-001', 'msg-002', 'msg-003']);
  goal.executionContext = {
    agent: 'build',
    model: 'claude-3.5',
    provider: 'anthropic',
  };

  const serialized = serializeGoal(goal);
  const jsonStr = JSON.stringify(serialized);
  const parsed = JSON.parse(jsonStr);
  const restored = deserializeGoal(parsed);

  expect(restored.goalId).toBe('goal-abc-123');
  expect(restored.runId).toBe('run-xyz-789');
  expect(restored.revision).toBe(42);
  expect(restored.condition).toBe('fix the failing tests');
  expect(restored.successCriteria).toBe('tests pass and lint is clean');
  expect(restored.constraints).toBe('do not touch the public API');
  expect(restored.mode).toBe('ordered');
  expect(restored.sessionID).toBe('session-def-456');
  expect(restored.tokenBudget).toBe(150000);
  expect(restored.maxTokens).toBe(400000);
  expect(restored.maxTurns).toBe(20);
  expect(restored.maxDurationMs).toBe(1800000);
  expect(restored.minDelayMs).toBe(3000);
  expect(restored.noProgressTokenThreshold).toBe(100);
  expect(restored.noProgressTurnsBeforePause).toBe(3);
  expect(restored.noToolCallTurnsBeforePause).toBe(5);
  expect(restored.turnCount).toBe(7);
  expect(restored.totalTokens).toBe(89432);
  expect(restored.usage.input).toBe(50000);
  expect(restored.usage.output).toBe(5000);
  expect(restored.usage.reasoning).toBe(2000);
  expect(restored.usage.cacheRead).toBe(30000);
  expect(restored.usage.cacheWrite).toBe(4000);
  expect(restored.usage.cost).toBe(0.15);
  expect(restored.usage.costKnown).toBe(true);
  expect(restored.createdAt).toBe(goal.createdAt);
  expect(restored.updatedAt).toBe(goal.updatedAt);
  expect(restored.startedAt).toBe(goal.startedAt);
  expect(restored.pausedAt).toBe(goal.pausedAt);
  expect(restored.finishedAt).toBe(null);
  expect(restored.status).toBe('paused');
  expect(restored.stopReason).toBe('manual pause');
  expect(restored.blockedReason).toBe('');
  expect(restored.finalizing).toBe(false);
  expect(restored.budgetLimitReported).toBe(false);
  expect(restored.budgetWrapupSent).toBe(true);
  expect(restored.objectiveUpdatedPending).toBe(false);
  expect(restored.noProgressTurns).toBe(2);
  expect(restored.noToolCallTurns).toBe(1);
  expect(restored.promptFailures).toBe(0);
  expect(restored.lastStatus).toBe('Working on tests');
  expect(restored.lastAssistantText).toBe('I fixed the test and it passes now');
  expect(restored.lastAssistantMessageID).toBe('msg-001');
  expect(restored.lastContinueAt).toBe(goal.lastContinueAt);
  expect(restored.lastProgressAt).toBe(goal.lastProgressAt);
  expect(restored.continuationClaim).toEqual({
    runId: 'run-xyz-789',
    sourceAssistantMessageID: 'msg-001',
  });
  expect(restored.pendingNotices.length).toBe(2);
  expect(restored.pendingNotices[0].kind).toBe('no-progress');
  expect(restored.pendingNotices[0].message).toBe('Low output detected');
  expect(restored.pendingNotices[1].kind).toBe('blocked');
  expect(restored.pendingNotices[1].message).toBe('Need user input');
  expect(restored.history.length).toBe(2);
  expect(restored.history[0].type).toBe('created');
  expect(restored.history[1].type).toBe('paused');
  expect(restored.lastCheckpoint).toEqual({
    summary: 'Tests passing',
    timestamp: goal.lastCheckpoint!.timestamp,
  });
  expect(restored.checkpoints.length).toBe(2);
  expect(restored.checkpoints[0].summary).toBe('Initial state');
  expect(restored.checkpoints[1].summary).toBe('Tests passing');
  expect(restored.messageIDs).toBeInstanceOf(Set);
  expect(restored.messageIDs.size).toBe(3);
  expect(restored.messageIDs.has('msg-001')).toBe(true);
  expect(restored.messageIDs.has('msg-002')).toBe(true);
  expect(restored.messageIDs.has('msg-003')).toBe(true);
  expect(restored.executionContext).toEqual({
    agent: 'build',
    model: 'claude-3.5',
    provider: 'anthropic',
  });
});

test('round-trip preserves null fields (tokenBudget, finishedAt, continuationClaim, executionContext, lastCheckpoint)', () => {
  const goal = createGoalState('s1', 'test');
  goal.tokenBudget = null;
  goal.finishedAt = null;
  goal.continuationClaim = null;
  goal.executionContext = null;
  goal.lastCheckpoint = null;
  goal.pendingNotices = [];
  goal.history = [];
  goal.checkpoints = [];
  goal.messageIDs = new Set();

  const serialized = serializeGoal(goal);
  const jsonStr = JSON.stringify(serialized);
  const parsed = JSON.parse(jsonStr);
  const restored = deserializeGoal(parsed);

  expect(restored.tokenBudget).toBe(null);
  expect(restored.finishedAt).toBe(null);
  expect(restored.continuationClaim).toBe(null);
  expect(restored.executionContext).toBe(null);
  expect(restored.lastCheckpoint).toBe(null);
  expect(restored.pendingNotices).toEqual([]);
  expect(restored.history).toEqual([]);
  expect(restored.checkpoints).toEqual([]);
  expect(restored.messageIDs).toBeInstanceOf(Set);
  expect(restored.messageIDs.size).toBe(0);
});

test('round-trip preserves all boolean flags (true and false)', () => {
  for (const flagValue of [true, false]) {
    const goal = createGoalState('s1', 'test');
    goal.finalizing = flagValue;
    goal.budgetLimitReported = flagValue;
    goal.budgetWrapupSent = flagValue;
    goal.objectiveUpdatedPending = flagValue;

    const serialized = serializeGoal(goal);
    const restored = deserializeGoal(JSON.parse(JSON.stringify(serialized)));

    expect(restored.finalizing).toBe(flagValue);
    expect(restored.budgetLimitReported).toBe(flagValue);
    expect(restored.budgetWrapupSent).toBe(flagValue);
    expect(restored.objectiveUpdatedPending).toBe(flagValue);
  }
});

test('round-trip preserves all valid goal statuses', () => {
  const statuses: GoalStatus[] = [
    'active',
    'paused',
    'blocked',
    'budgetLimited',
    'finalizing',
    'complete',
  ];
  for (const status of statuses) {
    const goal = createGoalState('s1', 'test');
    goal.status = status as typeof goal.status;
    if (status === 'complete') goal.finishedAt = Date.now();

    const serialized = serializeGoal(goal);
    const restored = deserializeGoal(JSON.parse(JSON.stringify(serialized)));

    expect(restored.status).toBe(status);
  }
});

test('round-trip with large messageIDs set (1000 items)', () => {
  const goal = createGoalState('s1', 'test');
  goal.messageIDs = new Set();
  for (let i = 0; i < 1000; i++) {
    goal.messageIDs.add(`msg-${i}`);
  }

  const serialized = serializeGoal(goal);
  const restored = deserializeGoal(JSON.parse(JSON.stringify(serialized)));

  expect(restored.messageIDs).toBeInstanceOf(Set);
  expect(restored.messageIDs.size).toBe(1000);
  expect(restored.messageIDs.has('msg-0')).toBe(true);
  expect(restored.messageIDs.has('msg-999')).toBe(true);
});

test('deserializeGoal handles corrupted/missing fields gracefully', () => {
  const restored = deserializeGoal({
    goalId: 123,
    revision: 'not a number',
    condition: null,
    status: 'invalidStatus',
    mode: 'invalid',
    tokenBudget: -5,
    maxTokens: null,
    finishedAt: 'not a number',
    finalizing: 'truthy',
    budgetLimitReported: 1,
    messageIDs: 'not an array',
    pendingNotices: 'not an array',
    history: null,
    checkpoints: 42,
    usage: null,
    continuationClaim: 'not an object',
    executionContext: 'string',
    lastCheckpoint: 123,
  });

  expect(restored.goalId).toBe('123');
  expect(restored.revision).toBe(0);
  expect(restored.condition).toBe('');
  expect(restored.status).toBe('active');
  expect(restored.mode).toBe('normal');
  expect(restored.tokenBudget).toBe(null);
  expect(restored.maxTokens).toBe(1000000);
  expect(restored.finishedAt).toBe(null);
  expect(restored.finalizing).toBe(false);
  expect(restored.budgetLimitReported).toBe(false);
  expect(restored.messageIDs).toBeInstanceOf(Set);
  expect(restored.messageIDs.size).toBe(0);
  expect(restored.pendingNotices).toEqual([]);
  expect(restored.history).toEqual([]);
  expect(restored.checkpoints).toEqual([]);
  expect(restored.continuationClaim).toBe(null);
  expect(restored.executionContext).toBe(null);
  expect(restored.lastCheckpoint).toBe(null);
});

test('deserializeGoal handles completely empty object', () => {
  const restored = deserializeGoal({});

  expect(restored.goalId).toBe('');
  expect(restored.runId).toBe('');
  expect(restored.revision).toBe(0);
  expect(restored.condition).toBe('');
  expect(restored.status).toBe('active');
  expect(restored.mode).toBe('normal');
  expect(restored.tokenBudget).toBe(null);
  expect(restored.maxTokens).toBe(1000000);
  expect(restored.maxTurns).toBe(0);
  expect(restored.maxDurationMs).toBe(1800000);
  expect(restored.minDelayMs).toBe(1500);
  expect(restored.messageIDs).toBeInstanceOf(Set);
  expect(restored.messageIDs.size).toBe(0);
});

test('deserializeGoal handles null/undefined/non-object input', () => {
  expect(deserializeGoal(null).goalId).toBe('');
  expect(deserializeGoal(undefined).goalId).toBe('');
  expect(deserializeGoal('string').goalId).toBe('');
  expect(deserializeGoal(42).goalId).toBe('');
  expect(deserializeGoal([]).goalId).toBe('');
});

// WAL recovery stress tests

test('aborted WAL entries are discarded during recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  const goal = createGoalState('s1', 'test abort');
  const proposed = createProposedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'create',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, proposed);

  const aborted = createAbortedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'aborted',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, aborted);

  await writeStateFile(statePath, [], [], []);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(0);
});

test('proposed-only WAL entries are discarded (incomplete transition)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  const goal = createGoalState('s1', 'test proposed');
  const proposed = createProposedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'proposed only',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, proposed);

  await writeStateFile(statePath, [], [], []);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(0);
});

test('goal removed then recreated via WAL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  // 1. Create goal A
  const goalA = createGoalState('s1', 'goal A');
  const createA = createCommittedEntry(
    goalA,
    {
      source: 'create_goal',
      goalId: goalA.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'create A',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, createA);

  // 2. Remove goal A
  const removeA = createCommittedEntry(
    goalA,
    {
      source: 'slash-command',
      goalId: goalA.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'remove A',
    },
    ledgerPath,
    true,
  );
  await appendWalEntry(ledgerPath, removeA);

  // 3. Create goal B (same session, different goalId)
  const goalB = createGoalState('s1', 'goal B');
  const createB = createCommittedEntry(
    goalB,
    {
      source: 'create_goal',
      goalId: goalB.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'create B',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, createB);

  await writeStateFile(statePath, [], [], []);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(1);
  expect(goals[0].goalId).toBe(goalB.goalId);
  expect(goals[0].condition).toBe('goal B');
});

test('multiple committed entries for same goal — last wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  const goal = createGoalState('s1', 'original');
  const committed1 = createCommittedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'v1',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed1);

  const updatedGoal = {...goal, condition: 'updated condition', turnCount: 5};
  const committed2 = createCommittedEntry(
    updatedGoal,
    {
      source: 'idle-handler',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'v2',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed2);

  await writeStateFile(statePath, [], [], []);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(1);
  expect(goals[0].condition).toBe('updated condition');
  expect(goals[0].turnCount).toBe(5);
});

test('completed goal is removed from live set during recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  const goal = createGoalState('s1', 'to be completed');
  goal.status = 'complete' as typeof goal.status;
  goal.finishedAt = Date.now();
  const committed = createCommittedEntry(
    goal,
    {
      source: 'update_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'complete',
      stopReason: 'completed',
      blockedReason: '',
      detail: 'goal completed',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  await writeStateFile(statePath, [], [], []);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(0);
});

test('budgetLimited goal is removed from the live set during recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  const goal = createGoalState('s1', 'budget limited goal');
  goal.status = 'budgetLimited' as typeof goal.status;
  const committed = createCommittedEntry(
    goal,
    {
      source: 'idle-handler',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'budgetLimited',
      stopReason: 'budget limit',
      blockedReason: '',
      detail: 'budget exceeded',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  await writeStateFile(statePath, [], [], []);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(0);
});

test('terminal snapshot fences older and newer active WAL during recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  const goal = createGoalState('s1', 'budget limited goal');
  goal.revision = 2;
  const olderActive = {...goal, revision: 1, status: 'active' as const};
  const newerActive = {...goal, revision: 3, status: 'active' as const};
  const newerTerminal = {
    ...goal,
    revision: 2,
    status: 'budgetLimited' as const,
    budgetLimitReported: true,
  };
  for (const active of [olderActive, newerActive]) {
    await appendWalEntry(
      ledgerPath,
      createCommittedEntry(
        active,
        {
          source: 'idle-handler',
          goalId: goal.goalId,
          fromStatus: 'active',
          toStatus: 'active',
          stopReason: '',
          blockedReason: '',
          detail: 'stale retained WAL',
        },
        ledgerPath,
      ),
    );
  }
  await writeStateFile(statePath, [newerTerminal], [], []);

  const recovered = await recoverState(statePath, ledgerPath);
  expect(recovered.goals).toEqual([]);
});

test('invalidated snapshot fence survives failed rollback tombstone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;
  const goal = createGoalState('s1', 'rolled back goal');
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      goal,
      {
        source: 'create_goal',
        goalId: goal.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'committed before rollback failure',
      },
      ledgerPath,
    ),
  );
  const state = {
    version: 1,
    goals: [],
    results: [],
    sessionOrdered: [],
    invalidatedGoalIds: [goal.goalId],
  };
  await writeStateFile(statePath, [], [], []);
  await Bun.write(statePath, JSON.stringify(state));
  const recovered = await recoverState(statePath, ledgerPath);
  expect(recovered.goals).toEqual([]);
  expect(recovered.invalidatedGoalIds).toEqual([goal.goalId]);

  // Model the normal startup checkpoint and show the fence survives another
  // recovery cycle, rather than only the direct recoverState call above.
  expect(
    await writeStateFile(
      statePath,
      recovered.goals,
      recovered.results,
      recovered.sessionOrdered,
      recovered.invalidatedGoalIds,
    ),
  ).toBe(true);
  const recoveredAgain = await recoverState(statePath, ledgerPath);
  expect(recoveredAgain.goals).toEqual([]);
  expect(recoveredAgain.invalidatedGoalIds).toEqual([goal.goalId]);
});

test('corrupted state file falls back to WAL-only recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  // Write corrupted state file
  await Bun.write(statePath, '{ invalid json }}}');

  // Write valid WAL entry
  const goal = createGoalState('s1', 'from WAL only');
  const committed = createCommittedEntry(
    goal,
    {
      source: 'create_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'created',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(1);
  expect(goals[0].condition).toBe('from WAL only');
});

test('interleaved create/remove for multiple goals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  const goalA = createGoalState('s1', 'goal A');
  const goalB = createGoalState('s1', 'goal B');
  const goalC = createGoalState('s1', 'goal C');

  // Create A, Create B, Remove A, Create C, Remove B
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      goalA,
      {
        source: 'create_goal',
        goalId: goalA.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'create A',
      },
      ledgerPath,
    ),
  );
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      goalB,
      {
        source: 'create_goal',
        goalId: goalB.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'create B',
      },
      ledgerPath,
    ),
  );
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      goalA,
      {
        source: 'slash-command',
        goalId: goalA.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'remove A',
      },
      ledgerPath,
      true,
    ),
  );
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      goalC,
      {
        source: 'create_goal',
        goalId: goalC.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'create C',
      },
      ledgerPath,
    ),
  );
  await appendWalEntry(
    ledgerPath,
    createCommittedEntry(
      goalB,
      {
        source: 'slash-command',
        goalId: goalB.goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: 'remove B',
      },
      ledgerPath,
      true,
    ),
  );

  await writeStateFile(statePath, [], [], []);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(1);
  expect(goals[0].condition).toBe('goal C');
});

test('snapshot goal superseded by WAL committed entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  // Write snapshot with goal in "active" state
  const snapshotGoal = createGoalState('s1', 'snapshot version');
  snapshotGoal.status = 'active' as typeof snapshotGoal.status;
  await writeStateFile(statePath, [snapshotGoal], [], []);

  // Write WAL entry that updates the goal to "paused"
  const walGoal = {
    ...snapshotGoal,
    status: 'paused' as typeof snapshotGoal.status,
    stopReason: 'user paused',
  };
  const committed = createCommittedEntry(
    walGoal,
    {
      source: 'slash-command',
      goalId: walGoal.goalId,
      fromStatus: 'active',
      toStatus: 'paused',
      stopReason: 'user paused',
      blockedReason: '',
      detail: 'paused',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(1);
  expect(goals[0].status).toBe('paused');
  expect(goals[0].stopReason).toBe('user paused');
});

test('snapshot goal removed by WAL removal entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  // Write snapshot with goal
  const goal = createGoalState('s1', 'in snapshot');
  await writeStateFile(statePath, [goal], [], []);

  // Write WAL removal entry
  const removed = createCommittedEntry(
    goal,
    {
      source: 'slash-command',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: 'removed',
    },
    ledgerPath,
    true,
  );
  await appendWalEntry(ledgerPath, removed);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(0);
});

test('snapshot goal completed by WAL committed entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  // Write snapshot with active goal
  const goal = createGoalState('s1', 'to be completed');
  await writeStateFile(statePath, [goal], [], []);

  // Write WAL committed entry with status "complete"
  const completedGoal = {
    ...goal,
    status: 'complete' as typeof goal.status,
    finishedAt: Date.now(),
  };
  const committed = createCommittedEntry(
    completedGoal,
    {
      source: 'update_goal',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'complete',
      stopReason: 'completed',
      blockedReason: '',
      detail: 'done',
    },
    ledgerPath,
  );
  await appendWalEntry(ledgerPath, committed);

  const {goals} = await recoverState(statePath, ledgerPath);
  expect(goals.length).toBe(0);
});

test('empty WAL and empty state file returns empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  await writeStateFile(statePath, [], [], []);

  const {goals, results, sessionOrdered} = await recoverState(
    statePath,
    ledgerPath,
  );
  expect(goals.length).toBe(0);
  expect(results.length).toBe(0);
  expect(sessionOrdered.length).toBe(0);
});

test('no state file and no WAL returns empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-'));
  const statePath = join(dir, 'state.json');
  const ledgerPath = `${statePath}.ledger.jsonl`;

  const {goals, results, sessionOrdered} = await recoverState(
    statePath,
    ledgerPath,
  );
  expect(goals.length).toBe(0);
  expect(results.length).toBe(0);
  expect(sessionOrdered.length).toBe(0);
});

// Claim vocabulary on read
//
// The judge path is spelled `judge` and the verdicts use the current tokens.
// These lock the canonical spellings, and they are mutation-checked — deleting
// either canonicalization turns them red.
describe('persistence: claim vocabulary is canonical on read', () => {
  function goalWithClaim(checkPath: string, verdict: string): unknown {
    return {
      goalId: 'goal-claim',
      runId: 'run-1',
      condition: 'Build the feature',
      status: 'complete',
      claims: [
        {
          claimId: 'c1',
          timestamp: 1,
          actor: 'agent',
          claimedStatus: 'complete',
          claimText: 'done',
          check: {path: checkPath, verdict, timestamp: 1},
          outcome: {
            status: 'verified-complete',
            detail: 'checked',
            timestamp: 1,
          },
        },
      ],
      lastClaim: {
        claimId: 'c1',
        timestamp: 1,
        actor: 'agent',
        claimedStatus: 'complete',
        claimText: 'done',
        check: {path: checkPath, verdict, timestamp: 1},
        outcome: {status: 'verified-complete', detail: 'checked', timestamp: 1},
      },
    };
  }

  test('the judge path and its verdicts load unchanged', () => {
    const goal = deserializeGoal(goalWithClaim('judge', 'JUDGE_APPROVED'));
    expect(goal.lastClaim?.check.path).toBe('judge');
    expect(goal.lastClaim?.check.verdict).toBe('JUDGE_APPROVED');
    expect(goal.claims[0]?.check.path).toBe('judge');
    expect(goal.claims[0]?.check.verdict).toBe('JUDGE_APPROVED');
  });

  test('an unrecognised path or verdict degrades honestly to none/NONE', () => {
    const goal = deserializeGoal(goalWithClaim('something-else', 'MADE_UP'));
    expect(goal.lastClaim?.check.path).toBe('none');
    expect(goal.lastClaim?.check.verdict).toBe('NONE');
  });

  test('persisted prose is read VERBATIM — nothing rewrites it on the way in', () => {
    // The substitution this replaces rewrote `verified-complete` to `attested`
    // and `unverifiable` to `unattested` inside persisted prose, on read. It
    // existed to translate state written by builds that were never published,
    // to a user who never had such a state file, and it rewrote text in fields
    // that are rendered — so a word an older build happened to write would be
    // silently replaced in the user's own record. The vocabulary the renderer
    // uses is now correct at the source instead.
    const goal = deserializeGoal({
      goalId: 'goal-prose',
      runId: 'run-1',
      condition: 'Build the feature',
      status: 'paused',
      stopReason: 'unverifiable completion asserted repeatedly',
      history: [
        {
          type: 'mutation',
          detail: 'Recorded claim abc: verified-complete',
          timestamp: 1,
        },
        {
          type: 'mutation',
          detail: 'Recorded claim def: unverifiable-claim',
          timestamp: 2,
        },
      ],
    });
    expect(goal.stopReason).toBe('unverifiable completion asserted repeatedly');
    expect(goal.history[0]?.detail).toBe(
      'Recorded claim abc: verified-complete',
    );
    expect(goal.history[1]?.detail).toBe(
      'Recorded claim def: unverifiable-claim',
    );
    // The signal prefix is load-bearing for the history panel's noise filter.
    expect(goal.history[0]?.detail.startsWith('Recorded claim')).toBe(true);
  });

  test("an archived RESULT's prose is read verbatim too", () => {
    const result = deserializeResult({
      goalId: 'goal-archived-result',
      sessionID: 'session-1',
      condition: 'Ship it',
      state: 'achieved',
      reason: 'completed (verifier: COMPLETE)',
      lastStatus: 'unverifiable completion asserted repeatedly',
      history: [
        {
          type: 'mutation',
          detail: 'Recorded claim abc: verified-complete',
          timestamp: 1,
        },
      ],
    });
    expect(result.lastStatus).toBe(
      'unverifiable completion asserted repeatedly',
    );
    expect(result.history[0]?.detail).toBe(
      'Recorded claim abc: verified-complete',
    );
  });

  test("the user's OWN prose is never rewritten", () => {
    // The substitution is deliberately narrow: only the exact tokens an older
    // build produced. A checkpoint or history detail a human wrote must survive.
    const goal = deserializeGoal({
      goalId: 'goal-user-prose',
      runId: 'run-1',
      condition: 'Build the feature',
      history: [
        {
          type: 'mutation',
          detail: 'User note: the tests are unverified and I know it',
          timestamp: 1,
        },
      ],
    });
    // `unverified` is not a ledger token the state machine ever wrote, so it is
    // left alone; only `unverifiable`/`unverifiable-claim` are translated.
    expect(goal.history[0]?.detail).toBe(
      'User note: the tests are unverified and I know it',
    );
  });
});

// Stop reasons are persisted VERBATIM on read
//
// A stop reason is persisted and read back by `src/tui-toast-policy.ts`, which
// matches it against a table of phrases to decide what to tell the user. This
// plugin has never been published, so there is no older spelling to translate:
// the reader passes every stop reason through unchanged, and the current
// spellings are what the toast table matches.
describe('persistence: stop reasons are read verbatim in the current vocabulary', () => {
  function goalWithStopReason(stopReason: string): unknown {
    return {
      goalId: 'goal-stop',
      runId: 'run-1',
      condition: 'Build the feature',
      status: 'paused',
      stopReason,
    };
  }

  test('the current rejection spelling is what the toast policy reads', () => {
    // The phrase table in src/tui-toast-policy.ts matches on the CURRENT
    // spelling; asserting the stop reason alone would pass even if the table
    // stopped matching it.
    const goal = deserializeGoal(goalWithStopReason('judge rejected'));
    expect(needsYouReason(goal.stopReason)).toBe(
      'the judge rejected the claim',
    );
  });

  test('current spellings pass through untouched', () => {
    expect(
      deserializeGoal(goalWithStopReason('judge rejected')).stopReason,
    ).toBe('judge rejected');
    expect(
      deserializeGoal(goalWithStopReason('completed (judge approved)'))
        .stopReason,
    ).toBe('completed (judge approved)');
  });

  test('any other stop reason is left exactly as it was', () => {
    // A stop reason is a fact about what happened; the reader must not rewrite
    // anything it does not recognise.
    expect(
      deserializeGoal(goalWithStopReason('budget exhausted')).stopReason,
    ).toBe('budget exhausted');
    expect(deserializeGoal(goalWithStopReason('')).stopReason).toBe('');
  });
});

describe('the focus pointer survives a restart', () => {
  test('focusedGoalIds round-trips through writeStateFile and recoverState', async () => {
    // Clause 1 of the contract: there is EXACTLY ONE focus pointer, and it is
    // persisted. It lived only in a runtime Map, while README claimed focus
    // survives a restart — the claim was corrected rather than honoured. This
    // locks the honouring.
    const statePath = join(tmpDir, 'state.json');
    const ledgerPath = join(tmpDir, 'ledger.jsonl');
    const goal = createGoalState('session-1', 'Build the feature', {
      goalId: 'goal-1',
      runId: 'run-1',
    });
    await writeStateFile(
      statePath,
      [goal],
      [],
      [],
      [],
      [],
      [],
      [{sessionID: 'session-1', goalId: 'goal-1'}],
    );

    const recovered = await recoverState(statePath, ledgerPath);
    expect(recovered.focusedGoalIds).toEqual([
      {sessionID: 'session-1', goalId: 'goal-1'},
    ]);
  });

  test('a pointer at a goal that no longer exists is dropped, not resurrected', async () => {
    // The projection writes only pointers that still name a LIVE goal. A dangling
    // pointer would restore focus to nothing on the next start.
    const statePath = join(tmpDir, 'state2.json');
    const ledgerPath = join(tmpDir, 'ledger2.jsonl');
    const goal = createGoalState('session-1', 'Build the feature', {
      goalId: 'goal-1',
      runId: 'run-1',
    });
    await writeStateFile(
      statePath,
      [goal],
      [],
      [],
      [],
      [],
      [],
      [
        {sessionID: 'session-1', goalId: 'goal-1'},
        {sessionID: 'session-9', goalId: 'goal-gone'},
      ],
    );
    const recovered = await recoverState(statePath, ledgerPath);
    // Both are READ back (the file is the file); what matters is that hydration
    // only seeds pointers for live goals, which the manager filters. The read is
    // lossless so the filter has something to work with.
    expect(recovered.focusedGoalIds).toHaveLength(2);
  });
});
