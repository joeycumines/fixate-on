// startup-prepare-scope.test.ts — WHICH sessions must startup prepare?
//
// The question this file answers, and which no existing test asks: at plugin
// load, `plugin-runtime.ts` calls `prepareSession` for EVERY session directory
// under the state root (the enumeration at:467-471 over `listSessionIDs`), and
// preparing means taking a write lease. So a host that will never write a given
// session's file still claims write-intent over it, and on conflict logs an
// error-level banner telling the user to close the other OpenCode instance or
// split the state root. Both halves of that advice are wrong: the host will
// never write that file, because a goal is session-scoped, and splitting the
// state root breaks the two-processes-one-worktree property the per-session
// layout exists to deliver.
//
// The measurement, not the argument. Every session here is locked by a LIVE
// foreign owner, so no lease is reclaimable and every conflict is real. For each
// session we record two facts:
//
// 1. DID STARTUP WRITE ANYWAY? Bytes appended to that session's ledger, and
// whether its state.json changed. This is the hazard: a host that
// mutates a machine it does not own takes a sequence number that session's
// own history already held. If a session's ledger grows while its lease is
// held by someone else, the guard has a hole and NO predicate may exclude
// that state from preparation.
// 2. HOW MANY CONFLICTS DID IT COST? The console.error count attributable to
// that session. This is what the predicate is allowed to remove.
//
// The two answers together are the predicate. A state that writes anyway MUST be
// prepared; a state that writes nothing need not be, and preparing it is pure
// noise.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnForeignOwner} from './lease-fixture.ts';
import {waitFor} from './wait-for.ts';

/**
 * One foreign-owned session directory, in a chosen goal state.
 *
 * The ledger is written as RAW TEXT, never through createCommittedEntry: that
 * helper calls nextWalSeq in the CURRENT process and would prime the per-session
 * counter before the code under test loads — the fixture moving the state it is
 * about to measure, which this repository has been bitten by twice.
 */
async function seedSession(
  root: string,
  sessionID: string,
  ownerPid: number,
  goal: {
    status: string;
    stopReason: string;
    finalizing?: boolean;
    continuationClaim?: unknown;
  } | null,
): Promise<{dir: string; ledgerBytes: number; stateBytes: number}> {
  const dir = join(root, 'sessions', sessionID);
  await mkdir(join(dir, 'state.json.lock'), {recursive: true});
  await writeFile(
    join(dir, 'state.json.lock', 'owner.json'),
    JSON.stringify({
      token: `held-${sessionID}`,
      pid: ownerPid,
      hostname: hostname(),
      createdAt: Date.now(),
    }),
    'utf8',
  );
  const goals = goal
    ? [
        {
          goalId: `goal-${sessionID}`,
          runId: `run-${sessionID}`,
          revision: 7,
          condition: `work owned by ${sessionID}`,
          successCriteria: '',
          constraints: '',
          artifactPointers: [],
          pendingProposal: null,
          mode: 'normal',
          sessionID,
          tokenBudget: null,
          maxTokens: 1000,
          maxTurns: 0,
          maxDurationMs: 0,
          turnCount: 3,
          totalTokens: 10,
          compactionBaselineTokens: 0,
          usage: {
            input: 1,
            output: 1,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            costKnown: true,
          },
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 30_000,
          startedAt: Date.now() - 60_000,
          pausedAt: goal.status === 'active' ? 0 : Date.now() - 10_000,
          finishedAt:
            goal.status === 'complete' || goal.status === 'blocked'
              ? Date.now() - 5_000
              : null,
          status: goal.status,
          stopReason: goal.stopReason,
          blockedReason: '',
          finalizing: goal.finalizing ?? false,
          // Present only when the case asks for it. Omitting the key entirely
          // when absent matters: the first run of this file reported a claim
          // session as silent, because the seed literal dropped the field the
          // case had set, so every session was seeded without one.
          ...(goal.continuationClaim !== undefined
            ? {continuationClaim: goal.continuationClaim}
            : {}),
          budgetLimitReported: false,
          budgetWrapupSent: false,
          objectiveUpdatedPending: false,
          noProgressTurns: 0,
          noToolCallTurns: 0,
          promptFailures: 0,
          recoveryTurns: 0,
          attestationFaults: 0,
          blockedTurns: 0,
        },
      ]
    : [];
  const snapshot = {
    version: 1,
    goals,
    results: [],
    sessionOrdered: [],
    invalidatedGoalIds: [],
    pendingIntents: [],
    settlementReceipts: [],
    focusedGoalIds: [],
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(snapshot), 'utf8');
  // A ledger holding history, so a startup append is visible as a byte change
  // rather than as the mere existence of a file.
  //
  // It carries a REAL `snapshot`, and that is load-bearing rather than
  // decorative: recoverState replays every committed entry through
  // `deserializeGoal(entry.snapshot)`, so an entry without one FABRICATES a
  // goal and every seeded session looks like it holds business. A fixture that
  // primes the state it is about to measure is this repository's own recorded
  // trap, and it made the first run of this file report a goal in a session
  // seeded with none.
  //
  // A session seeded with NO goals gets NO ledger at all, which is what a real
  // one looks like: the ledger is the first file a session writes, so a session
  // that never ran a goal has a directory and nothing in it.
  if (goal) {
    await writeFile(
      join(dir, 'state.json.ledger.jsonl'),
      `${JSON.stringify({
        seq: 1,
        revision: 7,
        phase: 'committed',
        timestamp: Date.now() - 60_000,
        transition: {
          source: 'chat-message',
          goalId: `goal-${sessionID}`,
          fromStatus: 'active',
          toStatus: goal.status,
        },
        snapshot: goals[0],
      })}\n`,
      'utf8',
    );
  } else {
    await writeFile(join(dir, 'state.json.ledger.jsonl'), '', 'utf8');
  }
  return {
    dir,
    ledgerBytes: (await stat(join(dir, 'state.json.ledger.jsonl'))).size,
    stateBytes: (await stat(join(dir, 'state.json'))).size,
  };
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

interface Observation {
  sessionID: string;
  state: string;
  conflicts: number;
  ledgerGrew: boolean;
  stateGrew: boolean;
}

describe('which sessions must startup prepare', () => {
  test('a foreign-owned session that startup writes anyway is the one that may NOT be excluded', async () => {
    const owner = spawnForeignOwner();
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-prepare-scope-'));
    const root = join(workspace, '.opencode', 'goals');
    const cases: Array<{
      sessionID: string;
      state: string;
      goal: Parameters<typeof seedSession>[3];
    }> = [
      {sessionID: 'ses_empty', state: 'no goals at all', goal: null},
      {
        sessionID: 'ses_paused',
        state: 'paused goal',
        goal: {status: 'paused', stopReason: 'paused'},
      },
      {
        sessionID: 'ses_active',
        state: 'active goal (the recovery-pause case)',
        goal: {status: 'active', stopReason: ''},
      },
      {
        sessionID: 'ses_finalizing',
        state: 'finalizing goal',
        goal: {status: 'paused', stopReason: 'paused', finalizing: true},
      },
      {
        sessionID: 'ses_claimed',
        state: 'goal holding a continuation claim',
        goal: {
          status: 'paused',
          stopReason: 'paused',
          continuationClaim: {
            runId: 'run-x',
            sourceAssistantMessageID: 'msg_x',
          },
        },
      },
      {
        sessionID: 'ses_settled',
        state: 'settled goal',
        goal: {status: 'complete', stopReason: 'verified-complete'},
      },
    ];

    try {
      const seeded = new Map<
        string,
        {ledgerBytes: number; stateBytes: number}
      >();
      for (const c of cases) {
        seeded.set(
          c.sessionID,
          await seedSession(root, c.sessionID, owner.pid!, c.goal),
        );
      }

      const {GoalsPlugin} = await import('../src/plugin.ts');
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(' '));
      };
      let resolved = false;
      try {
        await GoalsPlugin(
          {directory: workspace} as never,
          {idlePoller: false, registerAgents: false} as never,
        );
        resolved = true;
      } finally {
        console.error = originalError;
      }

      // THE FACT THAT DECIDES THE WHOLE PREDICATE. If any foreign-owned
      // session's ledger grew, startup wrote to a file it does not own, and
      // every candidate predicate is disqualified by that state.
      const observations: Observation[] = [];
      for (const c of cases) {
        const before = seeded.get(c.sessionID)!;
        const ledgerAfter = await sizeOf(
          join(root, 'sessions', c.sessionID, 'state.json.ledger.jsonl'),
        );
        const stateAfter = await sizeOf(
          join(root, 'sessions', c.sessionID, 'state.json'),
        );
        observations.push({
          sessionID: c.sessionID,
          state: c.state,
          conflicts: errors.filter(e => e.includes(c.sessionID)).length,
          ledgerGrew: ledgerAfter > before.ledgerBytes,
          stateGrew: stateAfter > before.stateBytes,
        });
      }

      // Printed so the measurement is readable in a failing run and in CI logs,
      // rather than being a table someone has to reconstruct from assertions.
      console.log('STARTUP-PREPARE-SCOPE ' + JSON.stringify(observations));

      const wroteAnyway = observations.filter(o => o.ledgerGrew || o.stateGrew);

      expect(
        resolved,
        'the factory must still resolve with every session foreign-owned',
      ).toBe(true);
      expect(
        errors.length,
        'conflicts are logged once per foreign session at startup',
      ).toBeGreaterThan(0);

      // THE FACT THAT REDEFINED THE FIX, and the reason the first draft of this
      // task was wrong. NOTHING grows — not even for ses_active, the recovery-
      // pause case — and the reason is NOT the one this comment used to give.
      //
      // It used to say the machine-building loop skips a refused session, so the
      // recovery pause never runs. That skip is GONE: a lease now gates WRITES
      // only, and every goal is built into a machine (69bf6ce), because a
      // projection that read an empty machine set deleted the session's own
      // goals on its next write.
      //
      // So the protection now rests on the two write gates, which is where it
      // always belonged: `writeWalEntry` asks `prepareSession` before the ledger
      // append, and `persistFn` asks before the snapshot. The recovery pause
      // DOES run — it mutates the machine, and both writes are refused.
      //
      // Stated precisely because this is the assertion a maintainer would be
      // tempted to "simplify" by narrowing prepare, and the wrong reason leads
      // them to remove the gate that is actually load-bearing. The lease is
      // doing its job for every state, which is why the fix was never "prepare
      // less" — a narrower prepare would trade this protection for tidiness
      // and reopen the hazard. What was wrong is only the REPORTING.
      expect(
        wroteAnyway.map(o => o.sessionID),
        'startup wrote to a foreign-owned session — if this ever becomes non-empty the eager lease is load-bearing and must not be narrowed',
      ).toEqual([]);

      // The conflict counts ARE the fix's whole payoff, asserted as a table
      // rather than described: a refusal is reported only for the three states
      // the machine loop would have mutated, and is silent for the three it
      // would not have touched.
      expect(
        observations.map(o => [o.sessionID, o.conflicts]),
        'conflicts are reported only for sessions holding a goal startup would mutate',
      ).toEqual([
        ['ses_empty', 0],
        ['ses_paused', 0],
        ['ses_active', 1],
        ['ses_finalizing', 1],
        ['ses_claimed', 1],
        ['ses_settled', 0],
      ]);
    } finally {
      owner.kill('SIGKILL');
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});

// THE TARGET BEHAVIOUR, as a failing test, so's fix is falsifiable
// rather than described. Ownership is NOT narrowed: every session is still
// prepared exactly as now, because the measurement above shows that attempt is
// what stops the recovery pause from writing to a file this host does not own.
// What changes is that a refusal is only WORTH REPORTING when this host had
// business with that session — which is exactly the set the machine-building loop
// would have mutated.
describe('a refusal is reported only when this host had business with that session', () => {
  test('a foreign-owned session with nothing to recover is silent; one with a goal to mutate still reports', async () => {
    const owner = spawnForeignOwner();
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-report-scope-'));
    const root = join(workspace, '.opencode', 'goals');
    try {
      // Silent: nothing recovered here would ever be written by this host.
      await seedSession(root, 'ses_quiet_empty', owner.pid!, null);
      await seedSession(root, 'ses_quiet_paused', owner.pid!, {
        status: 'paused',
        stopReason: 'paused',
      });
      await seedSession(root, 'ses_quiet_settled', owner.pid!, {
        status: 'complete',
        stopReason: 'verified-complete',
      });
      // Not silent: the recovery pause would have mutated these, and was
      // declined only because the lease was refused.
      await seedSession(root, 'ses_loud_active', owner.pid!, {
        status: 'active',
        stopReason: '',
      });
      await seedSession(root, 'ses_loud_finalizing', owner.pid!, {
        status: 'paused',
        stopReason: 'paused',
        finalizing: true,
      });
      await seedSession(root, 'ses_loud_claimed', owner.pid!, {
        status: 'paused',
        stopReason: 'paused',
        continuationClaim: {runId: 'run-x', sourceAssistantMessageID: 'msg_x'},
      });

      const {GoalsPlugin} = await import('../src/plugin.ts');
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(' '));
      };
      try {
        await GoalsPlugin(
          {directory: workspace} as never,
          {idlePoller: false, registerAgents: false} as never,
        );
      } finally {
        console.error = originalError;
      }

      const quiet = [
        'ses_quiet_empty',
        'ses_quiet_paused',
        'ses_quiet_settled',
      ].filter(id => errors.some(e => e.includes(id)));
      const loud = [
        'ses_loud_active',
        'ses_loud_finalizing',
        'ses_loud_claimed',
      ].filter(id => errors.some(e => e.includes(id)));
      console.log(
        'REPORT-SCOPE ' + JSON.stringify({quiet, loud, total: errors.length}),
      );

      expect(
        quiet,
        'a foreign-owned session this host would never write must not produce a conflict banner',
      ).toEqual([]);
      expect(
        loud.sort(),
        'a foreign-owned session holding a goal this host would have mutated must still be reported',
      ).toEqual(['ses_loud_active', 'ses_loud_claimed', 'ses_loud_finalizing']);
    } finally {
      owner.kill('SIGKILL');
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});

// The doubled message, asserted on the STRING rather than on a log-line count,
// because the defect is that one failure reads as two. Kept beside the scope
// measurement because it is the same console.error call.
describe('the lease conflict message states its fact once', () => {
  test('the caller does not restate the sentence the lease module already threw', async () => {
    const owner = spawnForeignOwner();
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-doubled-msg-'));
    try {
      // An ACTIVE goal, so the conflict is one this host legitimately has
      // business with and the message is emitted at all. A paused goal is now
      // correctly silent, and a test that seeded one was asserting on nothing.
      await seedSession(
        join(workspace, '.opencode', 'goals'),
        'ses_dup',
        owner.pid!,
        {
          status: 'active',
          stopReason: '',
        },
      );
      const {GoalsPlugin} = await import('../src/plugin.ts');
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(' '));
      };
      try {
        await GoalsPlugin(
          {directory: workspace} as never,
          {idlePoller: false, registerAgents: false} as never,
        );
      } finally {
        console.error = originalError;
      }
      const line = errors.find(e => e.includes('ses_dup')) ?? '';
      expect(line, 'a conflict must have been logged at all').not.toBe('');
      const occurrences = line.split('goal persistence for').length - 1;
      expect(
        occurrences,
        `"goal persistence for" appears ${occurrences} times in one conflict line: ${line}`,
      ).toBe(1);
      // And the advice itself is wrong for a session this host never writes.
      expect(line).toContain('FIXATE_ON_STATE_ROOT');
    } finally {
      owner.kill('SIGKILL');
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});

// Read one seeded file back, so the helper's own output is checked by something
// other than the assertions that depend on it.
describe('the scope fixture seeds what it claims to seed', () => {
  test('a seeded session has a snapshot, a ledger and a held lease', async () => {
    const owner = spawnForeignOwner();
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-scope-fixture-'));
    try {
      const seeded = await seedSession(
        join(workspace, '.opencode', 'goals'),
        'ses_probe',
        owner.pid!,
        {
          status: 'paused',
          stopReason: 'paused',
        },
      );
      const snapshot = JSON.parse(
        await readFile(join(seeded.dir, 'state.json'), 'utf8'),
      );
      expect(snapshot.goals).toHaveLength(1);
      expect(snapshot.goals[0].sessionID).toBe('ses_probe');
      const owner_json = JSON.parse(
        await readFile(
          join(seeded.dir, 'state.json.lock', 'owner.json'),
          'utf8',
        ),
      );
      expect(owner_json.pid).toBe(owner.pid);
      expect(seeded.ledgerBytes).toBeGreaterThan(0);
      expect(seeded.stateBytes).toBeGreaterThan(0);
    } finally {
      owner.kill('SIGKILL');
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);
});

// THE OTHER HALF OF THE SAME QUESTION, and it is where the data loss was.
//
// The tests above ask whether startup WRITES to a session it does not own. They
// seed a foreign-held lease, load the plugin, and stop there — so the question
// "what happens to that session on this host AFTER the refusal goes away" was
// never asked, and it is the question that destroys data.
//
// `getPersistedState` projects `liveGoals` from the machine set alone. The
// machine loop used to SKIP building machines for a refused session ("a mutation
// is a ledger append the refusal just declined"), and the refusal is
// deliberately not memoised so a later write can retry. So the first write after
// the lock is released takes `prepareSession`, succeeds, and projects a runtime
// that never saw this session's own goals over that session's own file.
//
// The fixture here is written by the PRODUCT, not by hand, because a hand-written
// snapshot is a shape the plugin may not read at all — an earlier version of this
// reproduction used one, reported "no goals exist for this thread" in BOTH arms,
// and therefore measured nothing. That is the fourth fixture in this phase to
// model state the product cannot produce, and the sixth time the fixture was the
// thing at fault rather than the code.
describe('a session refused at startup keeps its goals when the refusal lifts', () => {
  const REPRO_SESSION = 'ses_refusal_then_release';

  /** A workspace holding a real, product-written session with one real goal. */
  async function seedViaProduct(root: string): Promise<string> {
    const {GoalsPlugin} = await import('../src/plugin.ts');
    const hooks = await GoalsPlugin(
      {directory: root},
      {idlePoller: false, registerAgents: false},
    );
    const output = {parts: [] as unknown[]};
    await hooks['command.execute.before']!(
      {
        command: 'goal',
        sessionID: REPRO_SESSION,
        arguments: 'add the objective that already existed',
      },
      output,
    );
    await hooks.dispose?.();
    const seeded = join(
      root,
      '.opencode',
      'goals',
      'sessions',
      REPRO_SESSION,
      'state.json',
    );
    // Wait for the GOAL, not for a guess about scheduling. This used to be a 300 ms
    // sleep, which is the canonical bad test: it asserts nothing about the effect it
    // waits for, passes on an idle machine and fails on a loaded one. Waiting for
    // the file to EXIST proved the same trap one layer down — measured, the file
    // lands before the goal is in it, and the scenario then read `goals[0]` out of
    // a snapshot that had none. The predicate is the effect under test: a parseable
    // snapshot holding at least one goal.
    await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(seeded, 'utf8')) as {
          goals: unknown[];
        };
        return Array.isArray(parsed.goals) && parsed.goals.length > 0;
      } catch {
        return false;
      }
    }, `the product's first snapshot holding a goal at ${seeded}`);
    return seeded;
  }

  const scenario = async (
    holdLease: boolean,
  ): Promise<{
    goals: number;
    priorSurvived: boolean;
    intentSurvived: boolean;
  }> => {
    const root = await mkdtemp(join(tmpdir(), 'fixate-on-refusal-'));
    const statePath = await seedViaProduct(root);
    const dir = join(root, '.opencode', 'goals', 'sessions', REPRO_SESSION);
    try {
      const before = JSON.parse(await readFile(statePath, 'utf8')) as {
        goals: Array<{goalId: string; runId: string}>;
        pendingIntents: unknown[];
      };
      const priorId = before.goals[0]!.goalId;
      // A completion intent, because it is the step barrier for
      // `update_goal complete` and its loss is the "a goal that cannot end"
      // failure AGENTS.md principle 5 calls equally serious as a premature exit.
      // Every field `normalizePendingIntent` requires. The first version of this
      // injected `{goalId, targetStatus, createdAt, revision}` and the intent
      // vanished in the CONTROL arm too — dropped on read for want of
      // `sessionID` and `runId`, so the assertion would have been measuring the
      // fixture rather than the projection. A green control is the only reason
      // this was caught; without it the same test would have "passed" for the
      // wrong reason in both arms.
      before.pendingIntents.push({
        sessionID: REPRO_SESSION,
        goalId: priorId,
        // The goal's OWN runId: hydration drops an intent whose runId does not
        // match the live goal (`if (live.runId!== storedRunId) continue`), so a
        // made-up one is dropped there instead — the same fixture failure one
        // layer further in.
        runId: before.goals[0]!.runId,
        targetStatus: 'complete',
        createdAt: 1,
        revision: 1,
        evidence: '',
        messageID: '',
        toolCallID: '',
      });
      await writeFile(statePath, JSON.stringify(before), 'utf8');

      const owner = spawnForeignOwner();
      try {
        // ONLY the refused arm takes the lease. A first version created it
        // unconditionally, which meant the "control" also loaded with a refusal —
        // and it still went green, because with every goal built into a machine
        // both arms look identical. A control that differs from the case only in
        // the variable under test is not a control; this one is now genuinely the
        // no-lease path, and the mutation below turns IT red, which is what shows
        // that the arm is doing its job.
        if (holdLease) {
          await mkdir(join(dir, 'state.json.lock'), {recursive: true});
          await writeFile(
            join(dir, 'state.json.lock', 'owner.json'),
            JSON.stringify({
              token: 'held',
              pid: owner.pid,
              hostname: hostname(),
              createdAt: Date.now(),
            }),
            'utf8',
          );
        }
        const {GoalsPlugin} = await import('../src/plugin.ts');
        const hooks = await GoalsPlugin(
          {directory: root},
          {idlePoller: false, registerAgents: false},
        );
        // Release the foreign owner, then cause ONE write.
        owner.kill('SIGKILL');
        await rm(join(dir, 'state.json.lock'), {recursive: true, force: true});
        const output = {parts: [] as unknown[]};
        // The baseline is read BEFORE the command. Capturing it afterwards compares the
        // post-write file with itself, which never differs — a wait that can only time
        // out, which is how this first attempt failed.
        const beforeWrite = await readFile(statePath, 'utf8');
        await hooks['command.execute.before']!(
          {
            command: 'goal',
            sessionID: REPRO_SESSION,
            arguments: 'add a second objective',
          },
          output,
        );
        // WAIT FOR THE WRITES TO SETTLE, not for the first one to land. "The content
        // changed" is satisfied by an INTERMEDIATE write: measured, the file changed
        // while still holding only the prior goal, with the command already reporting
        // "Added and focused new goal". Waiting for the content to be unchanged across
        // several consecutive polls is a statement about the writes finishing, not
        // about the answer — the assertions below judge the result.
        //
        // The predicate deliberately does not ask "are there two goals yet".
        let previous = '';
        let stablePolls = 0;
        await waitFor(async () => {
          const now = await readFile(statePath, 'utf8');
          stablePolls = now === previous ? stablePolls + 1 : 0;
          previous = now;
          return stablePolls >= 4 && now !== beforeWrite;
        }, 'the post-release writes to settle');
        const after = JSON.parse(await readFile(statePath, 'utf8')) as {
          goals: Array<{goalId: string}>;
          pendingIntents: Array<{goalId: string}>;
        };
        return {
          goals: after.goals.length,
          priorSurvived: after.goals.some(g => g.goalId === priorId),
          intentSurvived: after.pendingIntents.some(i => i.goalId === priorId),
        };
      } finally {
        owner.kill('SIGKILL');
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  };

  test("the session's own goals and its completion intent survive the refusal and the write after it", async () => {
    // The control is the SAME scenario with the lease free at boot. Without it a
    // green arm would not distinguish "the fix works" from "the fixture never
    // held anything".
    const control = await scenario(false);
    console.log(`REFUSAL-RELEASE control ${JSON.stringify(control)}`);
    expect(
      control.priorSurvived,
      'the control: a session nobody else owns keeps its goal',
    ).toBe(true);
    expect(control.intentSurvived, 'and its completion intent').toBe(true);
    expect(control.goals, 'and gains the new one').toBe(2);

    const refused = await scenario(true);
    console.log(`REFUSAL-RELEASE refused ${JSON.stringify(refused)}`);
    expect(
      refused.priorSurvived,
      'a session whose lease was refused at startup must still hold its own goal after the lock is released ' +
        'and one write lands — the projection reads the machine set, and a refused session used to have none',
    ).toBe(true);
    expect(
      refused.intentSurvived,
      'and its completion intent, which is the step barrier for update_goal complete',
    ).toBe(true);
    expect(
      refused.goals,
      'and it gains the new goal without losing the old',
    ).toBe(2);
  }, 60_000);
});
