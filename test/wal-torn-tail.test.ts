// wal-torn-tail.test.ts — a torn ledger tail must not eat the next entry.
//
// A process killed mid-append leaves a prefix with NO TRAILING NEWLINE. The next
// `O_APPEND` starts at EOF, so the torn fragment and the next committed entry
// become ONE line — and `readWalGeneration` splits on "\n" and skips anything that
// does not parse, so the merged line takes the torn entry AND the committed one
// with it.
//
// Measured against this tree before the fix:
//
// AFTER-3-GOOD seqs=1,2,3
// TORN-BYTES endsWithNewline=false
// APPEND-5 reported success
// READABLE-AFTER seqs=1,2,3 <- seq 5 invisible
// AFTER-SIXTH seqs=1,2,3,6 <- seq 5 lost for good
//
// The sixth append is what makes it permanent: its newline terminates the garbage,
// so the merged line is now unambiguously malformed and nothing recovers seq 5.
// And the entry lost is not always a transition — when the merged-away entry
// carries `removed: true`, the goal the user cleared comes back, because the
// stale snapshot is then the only record of it.
//
// The repair is one `write("\n")` when the file's last byte is not a newline, and
// every case below has a control that must behave differently: a gate whose
// control also fails cannot tell the rule from the fixture.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {
  appendWalEntry,
  createCommittedEntry,
  readWalEntries,
  recoverState,
  writeStateFile,
} from '../src/persistence-wal.ts';
import {sessionStatePaths} from '../src/session-paths.ts';
import type {GoalState} from '../src/state-machine.ts';
import {createGoalState} from '../src/state-machine.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';
import type {PersistedState} from '../src/persistence.ts';

const EMPTY_INVALIDATION: ReadonlyMap<string, readonly string[]> = new Map();
const managerOptions = {
  maxTokens: DEFAULT_GOAL_OPTIONS.maxTokens,
  maxTurns: DEFAULT_GOAL_OPTIONS.maxTurns,
  maxDurationMs: DEFAULT_GOAL_OPTIONS.maxDurationMs,
  noProgressTokenThreshold: DEFAULT_GOAL_OPTIONS.noProgressTokenThreshold,
  noProgressTurnsBeforePause: DEFAULT_GOAL_OPTIONS.noProgressTurnsBeforePause,
  noToolCallTurnsBeforePause: DEFAULT_GOAL_OPTIONS.noToolCallTurnsBeforePause,
  budgetWrapupRatio: DEFAULT_GOAL_OPTIONS.budgetWrapupRatio,
  minDelayMs: DEFAULT_GOAL_OPTIONS.minDelayMs,
  maxPromptFailures: DEFAULT_GOAL_OPTIONS.maxPromptFailures,
  maxRecentMessages: DEFAULT_GOAL_OPTIONS.maxRecentMessages,
  maxRecoveryTurns: DEFAULT_GOAL_OPTIONS.maxRecoveryTurns,
  maxUnchangedResults: DEFAULT_GOAL_OPTIONS.maxUnchangedResults,
  maxBlockedTurns: DEFAULT_GOAL_OPTIONS.maxBlockedTurns,
  languageTriage: DEFAULT_GOAL_OPTIONS.languageTriage,
};

function ledgerPathFor(stateRoot: string, sessionID: string): string {
  return join(stateRoot, 'sessions', sessionID, 'state.json.ledger.jsonl');
}

/** A manager whose session gate is caller-controlled (writeWalEntry's only
 * await before the entry is built and appended). */
function makeGatedManager(
  stateRoot: string,
  prepareSession: (sessionID: string) => Promise<boolean>,
) {
  const runtime = createRuntimeState();
  const initial: PersistedState = {
    version: 1,
    goals: [],
    results: [],
    sessionOrdered: [],
  };
  return new SessionStateManager(
    runtime,
    async () => true,
    stateRoot,
    initial,
    EMPTY_INVALIDATION,
    prepareSession,
    1024,
    3,
    10,
    86_400_000,
    managerOptions,
    async () => {},
  );
}

const SESSION = 'ses_torn_tail';

/** A real goal, written by the product's own factory rather than hand-shaped. */
function aGoal(revision: number, turnCount: number): GoalState {
  const goal = createGoalState(
    SESSION,
    'an objective whose removal is durable',
    {},
  );
  goal.revision = revision;
  goal.turnCount = turnCount;
  goal.updatedAt = 1000 + revision;
  return goal;
}

function committed(goal: GoalState, seq: number, removed = false) {
  return createCommittedEntry(
    goal,
    {
      source: 'chat-message',
      goalId: goal.goalId,
      fromStatus: 'active',
      toStatus: 'active',
      stopReason: '',
      blockedReason: '',
      detail: '',
    },
    'unused-by-this-fixture',
    removed,
  );
}

/** Write `count` whole entries, as a healthy ledger looks. */
async function seed(path: string, count: number): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const entry = committed(aGoal(i, i), i);
    lines.push(JSON.stringify({...entry, seq: i}));
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

/** A kill mid-append: a prefix of a valid entry, with no trailing newline. */
async function tear(path: string, goal: GoalState, seq: number): Promise<void> {
  const whole = await readFile(path, 'utf8');
  await writeFile(
    path,
    `${whole}${JSON.stringify({...committed(goal, seq), seq}).slice(0, 300)}`,
    'utf8',
  );
}

describe('a torn ledger tail', () => {
  test('does not swallow the next committed entry, and does not lose it later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'torn-'));
    try {
      const ledger = join(dir, 'sessions', SESSION, 'state.json.ledger.jsonl');
      await seed(ledger, 3);
      await tear(ledger, aGoal(4, 4), 4);

      // The precondition, asserted rather than assumed: a file a reader will
      // split into a whole entry and a fragment.
      expect((await readFile(ledger, 'utf8')).endsWith('\n')).toBe(false);

      // The next append, which is the one a real transition makes.
      await appendWalEntry(ledger, {
        ...committed(aGoal(5, 5), 5),
        seq: 5,
      } as never);
      const afterFifth = (await readWalEntries(ledger)).map(e => e.seq);
      expect(
        afterFifth,
        `seq 5 was merged into the torn line:\n${await readFile(ledger, 'utf8')}`,
      ).toContain(5);

      // AND IT STAYS READABLE. This is the half that matters: before the fix the
      // sixth append supplied the newline that terminated the garbage, so seq 5
      // was only invisible *until* the next write and then gone for good.
      await appendWalEntry(ledger, {
        ...committed(aGoal(6, 6), 6),
        seq: 6,
      } as never);
      const afterSixth = (await readWalEntries(ledger)).map(e => e.seq);
      expect(
        afterSixth,
        'seq 5 vanished once a later append supplied the newline',
      ).toContain(5);
      expect(afterSixth).toEqual([1, 2, 3, 5, 6]);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('does not resurrect a goal the user cleared', async () => {
    // The harm that is not an arithmetic detail. A removal tombstone is the ONLY
    // record that a cleared goal is gone when the snapshot has already been
    // rewritten, so an entry the reader cannot see leaves the stale snapshot
    // asserting a goal the user removed.
    const dir = await mkdtemp(join(tmpdir(), 'torn-tombstone-'));
    try {
      const ledger = join(dir, 'sessions', SESSION, 'state.json.ledger.jsonl');
      const snapshot = join(dir, 'sessions', SESSION, 'state.json');
      const goal = aGoal(1, 1);
      await mkdir(dirname(ledger), {recursive: true});
      await writeFile(
        ledger,
        `${JSON.stringify({...committed(goal, 1), seq: 1})}\n`,
        'utf8',
      );
      // The stale snapshot still names the goal — the shape a clear leaves when
      // the tombstone append is the write that gets lost.
      await writeStateFile(snapshot, [goal as never], [], []);

      await tear(ledger, aGoal(2, 2), 2);
      // The tombstone, appended after the tear. Before the fix it merged with the
      // fragment and the reader saw no removal at all.
      await appendWalEntry(ledger, {
        ...committed(goal, 3, true),
        seq: 3,
      } as never);

      const recovered = await recoverState(snapshot, ledger);
      expect(
        recovered.goals.map(g => g.goalId),
        'a cleared goal came back from the stale snapshot',
      ).toEqual([]);
      expect(recovered.invalidatedGoalIds).toContain(goal.goalId);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('removeGoal awaits the whole pending chain, not the latest write (46D)', async () => {
    // The chain at session-state-manager.ts:478 is load-bearing for the reason
    // its comment states: `removeGoal` awaits `pendingWalWrite`, and chaining
    // is what makes that promise cover EVERY queued write. Two creates are
    // required because a single create starts from a null chain, where the
    // mutant `(prevWalWrite?? Promise.resolve) -> Promise.resolve` is a
    // no-op.
    //
    // The gate makes the observation deterministic: the FIRST create's session
    // gate (the only await inside writeWalEntry before the append) blocks until
    // the test releases it, so the removal is issued while create#1's write is
    // still queued.
    //
    // CORRECT: pendingWalWrite = [w1 -> w2]; the removal chains AFTER w2, so
    // its tombstone write cannot settle before the gate releases. The settled
    // state at release time is the assertion — a settled removal shows it
    // ran ahead of the chain.
    //
    // MUTANT: create#2 overwrites pendingWalWrite with an UNCHAINED promise,
    // so the removal awaits [w2] only and settles while w1 is still gated.
    const dir = await mkdtemp(join(tmpdir(), 'fx-wal-chain-'));
    try {
      let release!: () => void;
      const gate = new Promise<void>(r => {
        release = r;
      });
      let prepCount = 0;
      const manager = makeGatedManager(dir, () => {
        prepCount += 1;
        return prepCount === 1 ? gate.then(() => true) : Promise.resolve(true);
      });

      const m1 = manager.createGoal('session-1', 'first goal', {});
      const m2 = manager.createGoal('session-1', 'second goal', {});
      expect(m1).not.toBeNull();
      expect(m2).not.toBeNull();

      // Remove goal #2 while create #1's WAL write is still gated.
      const removal = manager.removeGoal('session-1', m2!.state.goalId);

      // Macrotask flushes drain every runnable microtask chain. Correct code:
      // the removal's chain starts behind the gated w1, so it CANNOT settle.
      let settledBeforeRelease = false;
      void removal.then(() => {
        settledBeforeRelease = true;
      });
      for (let i = 0; i < 10; i += 1) await new Promise(r => setTimeout(r, 2));
      expect(
        settledBeforeRelease,
        "removeGoal settled while an earlier create's WAL write was still waiting on its session gate — it awaited the latest write, not the whole pending chain",
      ).toBe(false);

      // Release the gate; everything settles in causal order.
      release();
      await removal;
      await manager.drainWalWrites();

      // Ledger order on disk: create#1, create#2, removal tombstone.
      const entries = await readWalEntries(
        ledgerPathFor(dir, 'session-1'),
        100,
      );
      const kinds = entries.map(e => {
        if (e.removed) return 'removed';
        return e.snapshot.condition === 'first goal' ? 'create1' : 'create2';
      });
      expect(kinds, 'the ledger must hold writes in causal order').toEqual([
        'create1',
        'create2',
        'removed',
      ]);
      for (let i = 1; i < entries.length; i += 1) {
        expect(
          entries[i]!.seq,
          'WAL sequence numbers must be strictly increasing',
        ).toBeGreaterThan(entries[i - 1]!.seq);
      }

      // The harm the chain prevents: recovery replays by seq, and a tombstone
      // that landed before the create it removes resurrects the goal.
      const paths = sessionStatePaths(dir, 'session-1');
      const recovered = await recoverState(paths.statePath, paths.ledgerPath);
      expect(
        recovered.goals.map(g => g.goalId),
        'recovery must hold exactly the live goal',
      ).toEqual([m1!.state.goalId]);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('CONTROL: a healthy ledger is unchanged, and a whole line is never split', async () => {
    // The control for both cases above. A repair that terminated EVERY line, or
    // that inserted a newline in the middle of a complete entry, would satisfy
    // both assertions above and corrupt a healthy ledger — so this asserts the
    // ordinary case produces exactly the lines it was given.
    const dir = await mkdtemp(join(tmpdir(), 'torn-control-'));
    try {
      const ledger = join(dir, 'sessions', SESSION, 'state.json.ledger.jsonl');
      await seed(ledger, 3);
      await appendWalEntry(ledger, {
        ...committed(aGoal(4, 4), 4),
        seq: 4,
      } as never);

      const text = await readFile(ledger, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.split('\n').filter(l => l.trim())).toHaveLength(4);
      // NO BLANK LINE, and this is not decoration: the reader skips an empty line
      // by design, so an unconditional `write("\n")` is invisible to the product
      // and survived this file's first version. It is still wrong — it doubles the
      // write syscalls on every transition, and a line count in the file is not
      // the same as a line count in the ledger. Verified: that mutant passes every
      // assertion here until this one.
      expect(text.split('\n')).toHaveLength(5);
      expect((await readWalEntries(ledger)).map(e => e.seq)).toEqual([
        1, 2, 3, 4,
      ]);

      // And one more, to show the healthy path stays healthy rather than working
      // once by accident of the file's length.
      await appendWalEntry(ledger, {
        ...committed(aGoal(5, 5), 5),
        seq: 5,
      } as never);
      expect(text.split('\n').filter(l => l.trim())).toHaveLength(4);
      expect((await readWalEntries(ledger)).map(e => e.seq)).toEqual([
        1, 2, 3, 4, 5,
      ]);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
