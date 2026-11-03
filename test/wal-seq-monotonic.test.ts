// wal-seq-monotonic.test.ts — a counter belongs to a LEDGER, and may only RISE.
//
// The counter exists for one reason: `readWalEntries` sorts on `seq`
// alone, so a number this process has already handed out is a number replay can
// order wrongly. Two separate mistakes let that happen, and fixing only the first
// left the second standing.
//
// 1. THE KEY WAS THE SESSION ID, which is not a unique name for a ledger inside
// one process. The configuration that reaches this is not exotic — it is the
// one the lease error message itself recommends: two plugin instances in one
// process pointed at different state roots. Measured before the fix: 50 from
// root A, then 3 from root B, and root A's next entry at 4. One counter, two
// ledgers, and the shorter ledger decided where both continued.
// 2. THE SEEDING OVERWROTE UNCONDITIONALLY, so a seeding could also LOWER a
// counter this process had already advanced — which the ledger key does not
// prevent, because re-preparing a session re-seeds its own ledger.
//
// The counter is now keyed by the ledger path and a seeding may only raise it.
//
// The later tests in this file are the ones that matter for the CONSEQUENCE.
// Asserting the counter's value is arithmetic; asserting that a REUSED number
// restores the WRONG STATE is the defect. The first version of this file only did
// the former.
//
// `walSeqByLedger` is module state that survives between tests in one file, so
// every case here uses its own ledger AND its own root.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  appendWalEntry,
  createCommittedEntry,
  initWalSeqFromLedger,
  nextWalSeq,
  peekWalSeq,
  recoverState,
} from '../src/persistence-wal.ts';
import type {GoalState} from '../src/state-machine.ts';
import {createGoalState} from '../src/state-machine.ts';
import {sessionStatePaths} from '../src/session-paths.ts';

/** Write a ledger holding `count` committed entries at the given revisions. */
async function writeLedger(
  path: string,
  sessionID: string,
  revisions: number[],
): Promise<void> {
  await mkdir(join(path, '..'), {recursive: true});
  const lines = revisions.map((revision, i) =>
    JSON.stringify({
      seq: i + 1,
      revision,
      phase: 'committed',
      timestamp: 1000 + i,
      transition: {
        source: 'chat-message',
        goalId: 'g1',
        fromStatus: i === 0 ? 'active' : 'paused',
        toStatus: 'paused',
        stopReason: '',
        blockedReason: '',
        detail: `entry ${i + 1}`,
      },
      snapshot: {
        goalId: 'g1',
        runId: 'r1',
        revision,
        condition: 'a goal whose revision carries the state',
        status: 'paused',
        stopReason: 'paused',
        sessionID,
        turnCount: revision,
        totalTokens: 0,
        history: [],
      },
    }),
  );
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

describe('a sequence counter belongs to a LEDGER, and may only rise', () => {
  // THE IDENTITY, and it is the half that keyed on the session id got wrong. A
  // session id is not a unique name for a ledger inside one process: two plugin
  // instances pointed at two state roots — the configuration persistence.ts's
  // own lease error message recommends — hold the SAME session id in two
  // unrelated ledgers. Keyed by id they shared one counter, so whichever ledger
  // was seeded or written second decided where BOTH continued.
  test('the same session id in TWO roots is two independent counters', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'seq-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'seq-b-'));
    const session = 'ses_seq_two_roots';
    try {
      await writeLedger(
        sessionStatePaths(rootA, session).ledgerPath,
        session,
        [1, 2, 3, 4, 5],
      );
      await writeLedger(
        sessionStatePaths(rootB, session).ledgerPath,
        session,
        [1, 2, 3],
      );
      const ledgerA = sessionStatePaths(rootA, session).ledgerPath;
      const ledgerB = sessionStatePaths(rootB, session).ledgerPath;

      await initWalSeqFromLedger(ledgerA, 3);
      await initWalSeqFromLedger(ledgerB, 3);

      console.log(
        `SEQ-INDEPENDENT ${JSON.stringify({a: peekWalSeq(ledgerA), b: peekWalSeq(ledgerB)})}`,
      );
      // Each counter reflects ITS OWN ledger, and neither was moved by the other.
      // Keyed on the session id these would be one number, and the shorter
      // ledger is exactly the one that would have dragged it down.
      expect(peekWalSeq(ledgerA), "root A's ledger holds five entries").toBe(5);
      expect(
        peekWalSeq(ledgerB),
        "root B's ledger holds three, and is not root A's business",
      ).toBe(3);
      expect(nextWalSeq(ledgerA), "A continues A's stream").toBe(6);
      expect(nextWalSeq(ledgerB), "B continues B's stream").toBe(4);
    } finally {
      await rm(rootA, {recursive: true, force: true});
      await rm(rootB, {recursive: true, force: true});
    }
  }, 30_000);

  // THE RAISE, which the ledger key does not remove. Re-preparing a session is
  // ordinary (startup seeds, a later prepare seeds again), and a seeding must
  // never lower a counter this process has already advanced — or the next entry
  // takes a number the ledger itself already holds.
  test('a seeding that reads a LOWER maximum does not lower the counter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seq-raise-'));
    const session = 'ses_seq_raise_floor';
    try {
      const ledger = sessionStatePaths(root, session).ledgerPath;
      await writeLedger(ledger, session, [1, 2, 3, 4, 5, 6, 7]);
      await initWalSeqFromLedger(ledger, 3);
      expect(peekWalSeq(ledger), 'seeded from seven entries').toBe(7);
      // This process has already handed out 8.
      expect(nextWalSeq(ledger)).toBe(8);

      // The ledger is REPLACED by a shorter one — a truncated file, a restored
      // backup, a fixture rebuilt from a subset. Reading it must not rewind.
      await writeLedger(ledger, session, [1, 2]);
      await initWalSeqFromLedger(ledger, 3);
      console.log(
        `SEQ-RAISE-FLOOR after re-seed from two entries: ${peekWalSeq(ledger)}`,
      );
      expect(
        peekWalSeq(ledger),
        'a seeding may only RAISE the number; it cannot be a request for one this ledger has passed',
      ).toBe(8);
      expect(
        nextWalSeq(ledger),
        'and no number this process already handed out comes round again',
      ).toBe(9);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);

  test('a re-seed from the SAME ledger is idempotent', async () => {
    // The ordinary case: startup seeds, and something re-seeds. Idempotence is
    // what makes the raise safe to apply on every preparation.
    const root = await mkdtemp(join(tmpdir(), 'seq-idem-'));
    const session = 'ses_seq_idempotent';
    try {
      const ledger = sessionStatePaths(root, session).ledgerPath;
      await writeLedger(ledger, session, [1, 2, 3]);
      await initWalSeqFromLedger(ledger, 3);
      const first = peekWalSeq(ledger);
      await initWalSeqFromLedger(ledger, 3);
      expect(
        peekWalSeq(ledger),
        're-seeding from the same ledger must not move the counter',
      ).toBe(first);
      expect(nextWalSeq(ledger)).toBe(first + 1);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);
});

// THE CONSEQUENCE, and the reason the first test is not the whole story. A reused
// sequence number is not a duplicate to be deduplicated: replay orders on `seq`
// alone, so a tie is resolved by whatever else the reader happens to do — and the
// reviewer's measurement was a goal with 5 turns recovered with 3.
//
// Two DIFFERENT revisions at the same `seq` turn out to be survivable, and the
// test below measures that first rather than asserting the interesting case: the
// replay loop skips an entry whose revision is BELOW the one it already holds, so
// a higher revision that sorts first wins. That protection does NOT extend to two
// entries at the SAME revision carrying different content — which is what a
// `skipRevision` transition produces, and `focusGoalOwned` uses one. So the second
// case is the real hazard, and the assertion documents which way it currently
// falls rather than pretending the reader is safe.
/**
 * A goal the real serializer accepts.
 *
 * `createCommittedEntry` calls `serializeGoal`, which spreads the goal's array
 * fields — so a hand-written literal with `artifactPointers: null` throws inside
 * the code under test and the test measures nothing. Built from the same
 * constructor the rest of this file uses, so the fixture cannot drift from the
 * shape the product actually writes.
 */
function freshGoal(sessionID: string, turnCount: number): GoalState {
  const goal = createGoalState(sessionID, 'the goal');
  goal.revision = 5;
  goal.status = 'paused';
  goal.stopReason = 'paused';
  goal.turnCount = turnCount;
  goal.goalId = 'g1';
  goal.runId = 'r1';
  return goal;
}

describe('a reused sequence number can restore the wrong state, which is why the counter only rises', () => {
  test('differing revisions at the same sequence number: the higher revision wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seq-tie-rev-'));
    const session = 'ses_seq_tie_rev';
    try {
      const paths = sessionStatePaths(root, session);
      const entry = (revision: number, turnCount: number, at: number) =>
        JSON.stringify({
          seq: 9,
          revision,
          phase: 'committed',
          timestamp: at,
          transition: {
            source: 'chat-message',
            goalId: 'g1',
            fromStatus: 'active',
            toStatus: 'paused',
            stopReason: '',
            blockedReason: '',
            detail: `r${revision}`,
          },
          snapshot: {
            goalId: 'g1',
            runId: 'r1',
            revision,
            condition: 'c',
            status: 'paused',
            stopReason: 'paused',
            sessionID: session,
            turnCount,
            totalTokens: 0,
            history: [],
          },
        });
      await mkdir(join(paths.statePath, '..'), {recursive: true});
      await writeFile(
        `${paths.ledgerPath}.1`,
        `${entry(5, 5, 3000)}\n`,
        'utf8',
      );
      await writeFile(paths.ledgerPath, `${entry(3, 3, 2000)}\n`, 'utf8');

      const goal = (await recoverState(paths.statePath, paths.ledgerPath, 3))
        .goals[0];
      console.log(`SEQ-TIE-REV recovered revision ${goal?.revision}`);
      expect(
        goal!.revision,
        'a differing revision is survivable: the higher one wins',
      ).toBe(5);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);

  test('EQUAL revisions at the same sequence number: the last entry in sort order wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seq-tie-equal-'));
    const session = 'ses_seq_tie_equal';
    try {
      const paths = sessionStatePaths(root, session);
      // Same `seq`, same revision, different turn counts — the shape a
      // `skipRevision` transition produces, which `focusGoalOwned` uses. The
      // `revision <` guards do not fire on equality, so both entries apply and the
      // last in `walEntries` order wins.
      const entry = (turnCount: number, at: number) =>
        JSON.stringify({
          seq: 9,
          revision: 5,
          phase: 'committed',
          timestamp: at,
          transition: {
            source: 'chat-message',
            goalId: 'g1',
            fromStatus: 'active',
            toStatus: 'paused',
            stopReason: '',
            blockedReason: '',
            detail: `t${turnCount}`,
          },
          snapshot: {
            goalId: 'g1',
            runId: 'r1',
            revision: 5,
            condition: 'c',
            status: 'paused',
            stopReason: 'paused',
            sessionID: session,
            turnCount,
            totalTokens: 0,
            history: [],
          },
        });
      await mkdir(join(paths.statePath, '..'), {recursive: true});
      // Generation 0 first, then the rotation — so the rotated entry is applied
      // last and its turn count is the one that survives.
      await writeFile(`${paths.ledgerPath}.1`, `${entry(3, 3000)}\n`, 'utf8');
      await writeFile(paths.ledgerPath, `${entry(9, 2000)}\n`, 'utf8');

      const goal = (await recoverState(paths.statePath, paths.ledgerPath, 3))
        .goals[0];
      console.log(`SEQ-TIE-EQUAL recovered turnCount ${goal?.turnCount}`);
      // Measured, not asserted-to-be-safe. The value is load-bearing documentation
      // of the reader's tie-break, and it changes loudly if that tie-break does.
      expect(
        goal!.turnCount,
        'on equal seq AND equal revision the last entry in sort order wins — documented so a change is visible',
      ).toBe(3);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);

  // A RETRACTION, recorded because the review that prompted this file asserted
  // the stronger claim and I could not reproduce it. The reviewer reported that a
  // reused sequence number made recovery return a 3-turn goal where the history
  // held 9, and treated that as showing the collision restores the wrong state.
  //
  // What is established, measured here: the collision causes NUMBER REUSE, which
  // is the defecta fixes, and that is serious on its own — replay's
  // ordering rests on `seq`. What I could NOT establish: an input where the reader
  // restores measurably OLDER state. Revision ordering covers the differing case
  // (the test above), and a lowered counter writes a LOWER `seq` that sorts first
  // and is then overwritten by the real entries. So the reader needed no change,
  // and a speculative tie-break in the recovery loop would have been a cost paid
  // on every replay for a benefit nothing demonstrates. The claim is narrowed to
  // what the measurement supports.
  test('a reused sequence number does NOT demonstrably restore older state, and this is why', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seq-reuse-shape-'));
    const session = 'ses_seq_reuse_shape';
    try {
      const paths = sessionStatePaths(root, session);
      const entry = (
        seq: number,
        revision: number,
        turnCount: number,
        at: number,
      ) =>
        JSON.stringify({
          seq,
          revision,
          phase: 'committed',
          timestamp: at,
          transition: {
            source: 'chat-message',
            goalId: 'g1',
            fromStatus: 'active',
            toStatus: 'paused',
            stopReason: '',
            blockedReason: '',
            detail: `s${seq}`,
          },
          snapshot: {
            goalId: 'g1',
            runId: 'r1',
            revision,
            condition: 'c',
            status: 'paused',
            stopReason: 'paused',
            sessionID: session,
            turnCount,
            totalTokens: 0,
            history: [],
          },
        });
      await mkdir(join(paths.statePath, '..'), {recursive: true});
      // The SHAPE a lowered counter produces: the ledger already holds 1..3 at
      // revision 5, and the process's next entry takes seq 2 again — lower than
      // the history, so it sorts FIRST.
      await writeFile(
        paths.ledgerPath,
        [
          entry(2, 5, 99, 9000),
          entry(1, 5, 1, 1000),
          entry(3, 5, 3, 3000),
        ].join('\n') + '\n',
        'utf8',
      );

      const goal = (await recoverState(paths.statePath, paths.ledgerPath, 3))
        .goals[0];
      console.log(
        `SEQ-REUSE-SHAPE recovered revision ${goal?.revision} turnCount ${goal?.turnCount}`,
      );
      // The real history's LAST entry wins, not the reused one: revision ordering
      // plus sort order together already prevent the stale recovery. This is the
      // evidence for the retraction above, and it is a test so the claim stays
      // checked rather than remembered.
      expect(
        goal!.turnCount,
        'the reused low-seq entry sorts first and is overwritten by the real history',
      ).toBe(3);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);
});

// THE CONSEQUENCE, GATED END TO END — and it is this test thata's
// acceptance asks for, which the three above do NOT provide.
//
// Their criticism is right and it is recorded here rather than argued away: those
// tests HAND-WRITE a colliding ledger and read it. They never call
// `initWalSeqFromLedger` or `nextWalSeq`, so no mutation of the counter can
// reach them, and the acceptance's "a future regression that reintroduces the
// tie fails on restored state rather than on an arithmetic detail" was
// unimplemented: every assertion that went red under those mutations read a
// counter value or a `seq` value — the arithmetic, exactly what the clause says
// must not be the gate.
//
// So this test PRODUCES the tie with the counter itself, the way production
// would, and then reads the restored state.
//
// The shape is chosen so the wrong answer is unambiguous. `readWalEntries`
// concatenates generation 0 first and then the rotations, and on a tie the LAST
// entry in that order wins — so a colliding entry in a ROTATED generation beats
// the fresh one written to generation 0. The stale rotated entry carries a
// turnCount no honest history would have; if the counter regressed to being
// keyed by session id, root A's next entry would take seq 4, collide with that
// rotated entry, and recovery would restore 9999 turns of work that never
// happened. Under the fix the same entry takes seq 51 and recovery returns the
// real count.
describe("the consequence is gated through recoverState, not through the counter's value", () => {
  test('a counter that reuses a number restores state that never happened', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'seq-cons-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'seq-cons-b-'));
    // The SAME session id in two roots — the configuration the ledger key exists
    // for. Root B is seeded too, because the regression this gates is precisely
    // "root B's seeding moves root A's counter".
    const session = 'ses_seq_consequence';
    try {
      const ledgerA = sessionStatePaths(rootA, session).ledgerPath;
      const ledgerB = sessionStatePaths(rootB, session).ledgerPath;
      const entry = (seq: number, turnCount: number, at: number) =>
        JSON.stringify({
          seq,
          revision: 5,
          phase: 'committed',
          timestamp: at,
          transition: {
            source: 'chat-message',
            goalId: 'g1',
            fromStatus: 'active',
            toStatus: 'paused',
            stopReason: '',
            blockedReason: '',
            detail: `t${turnCount}`,
          },
          snapshot: {
            goalId: 'g1',
            runId: 'r1',
            revision: 5,
            condition: 'the goal',
            status: 'paused',
            stopReason: 'paused',
            sessionID: session,
            turnCount,
            totalTokens: 0,
            history: [],
          },
        });
      await mkdir(join(sessionStatePaths(rootA, session).statePath, '..'), {
        recursive: true,
      });
      // Generation 0: a long honest history, seq 1..50.
      await writeFile(
        ledgerA,
        `${[...Array(50)].map((_, i) => entry(i + 1, i + 1, 1000 + i)).join('\n')}\n`,
        'utf8',
      );
      // The ROTATION: one entry at seq 4 carrying a turnCount that never
      // happened. It is older in time and younger in file order.
      await writeFile(`${ledgerA}.1`, `${entry(4, 9999, 500)}\n`, 'utf8');
      // Root B, short: three entries, which is what would drag a shared counter down.
      await mkdir(join(sessionStatePaths(rootB, session).statePath, '..'), {
        recursive: true,
      });
      await writeFile(
        ledgerB,
        `${[1, 2, 3].map(s => entry(s, s, 100 * s)).join('\n')}\n`,
        'utf8',
      );

      // Production's own order: seed both roots, then write root A's next entry.
      await initWalSeqFromLedger(ledgerA, 3);
      await initWalSeqFromLedger(ledgerB, 3);
      const fresh = createCommittedEntry(
        freshGoal(session, 51) as unknown as Parameters<
          typeof createCommittedEntry
        >[0],
        {
          source: 'chat-message',
          goalId: 'g1',
          fromStatus: 'paused',
          toStatus: 'paused',
          stopReason: '',
          blockedReason: '',
          detail: 'the real next entry',
        },
        ledgerA,
      );
      console.log(`SEQ-CONSEQUENCE appended at seq ${fresh.seq}`);
      await appendWalEntry(ledgerA, fresh);

      // The ASSERTION IS ON RESTORED STATE. Under the regression the fresh entry
      // takes seq 4, ties with the rotated entry, and the rotation is read last.
      const goal = (
        await recoverState(
          sessionStatePaths(rootA, session).statePath,
          ledgerA,
          3,
        )
      ).goals[0];
      console.log(`SEQ-CONSEQUENCE recovered turnCount ${goal?.turnCount}`);
      expect(
        goal!.turnCount,
        'recovery restored a state that never happened — a reused sequence number let an older rotated ' +
          'entry win. This is the consequence, gated on what recovery returns rather than on arithmetic.',
      ).toBe(51);
    } finally {
      await rm(rootA, {recursive: true, force: true});
      await rm(rootB, {recursive: true, force: true});
    }
  }, 30_000);
});
