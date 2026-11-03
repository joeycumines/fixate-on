// startup-stray-and-ordered.test.ts — what startup must NOT do to a session it does own.
//
// Two defects, both silent, both in the startup path, and both invisible to every
// other gate: 1863 green tests, a clean `tsc`, a clean lint and a passing
// `release:check` all sailed past them. They are here as executable reproductions
// first, because a defect this shape is not found by reading a condition.
//
// (a) THE STRAY REFUSAL IS FILED UNDER THE WRONG SESSION. On-disk state is
// untrusted input, so a goal record in session A's file whose OWN `sessionID`
// names session B must not be loaded. The first version of that guard recorded
// the refusal in `refusedSessions` under the STRAY's id — and that map is the
// lease-refusal map, which the machine-building loop reads to decide "this host
// does not own that session". So one malformed record in A's file disabled B
// entirely: B's own goals were never loaded, and because `getPersistedState`
// projects from live machines, B's next write rewrote its snapshot without them.
// Measured before the fix: the victim's goal present on disk, absent from the
// tools, and gone from disk after a single `/goal` command in its own session.
//
// The asymmetry that makes it a data-loss bug rather than a tidiness complaint:
// a lease refusal is CLEARED by holding the lease, while "this file is
// untrustworthy" is not. The two conditions are not the same condition, so they
// cannot share a map.
//
// (b) THE ORDERED FLAG IS ERASED BY THE STARTUP WRITE THAT REPORTS RECOVERY.
// `setOrdered` seeded the live Set AFTER the goal-recovery loop, and that loop's
// own recovery pause fires `onCommit` → `persist` → `getPersistedState`, whose
// per-session projection reads the very Set that has not been populated yet. So
// the first write after startup wrote `sessionOrdered: []` into the file of a
// session that had just sequenced. Eight auto-promotion sites gate on
// `isOrdered`, so that session's queued goals were then never promoted — the
// "a goal that cannot end" failure AGENTS.md principle 5 calls equally serious
// as a premature exit.
//
// The same single move fixes the focus pointer, which the same projection drops
// for the same reason, so it is asserted here too rather than left to be
// discovered a third time.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {PersistedState} from '../src/persistence.ts';

/**
 * A serialized goal, minimally complete enough for `recoverState` to replay it.
 *
 * The `sessionID` is a PARAMETER rather than a constant, because the whole first
 * defect is about a record whose own session id names somewhere else.
 */
function goalRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    goalId: 'goal-fixture',
    runId: 'run-fixture',
    revision: 3,
    condition: 'a fixture objective',
    successCriteria: '',
    constraints: '',
    artifactPointers: [],
    pendingProposal: null,
    mode: 'normal',
    sessionID: 'ses-owner',
    tokenBudget: null,
    maxTokens: 1000,
    maxTurns: 0,
    maxDurationMs: 0,
    turnCount: 2,
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
    pausedAt: Date.now() - 10_000,
    finishedAt: null,
    status: 'paused',
    stopReason: 'paused',
    blockedReason: '',
    finalizing: false,
    continuationClaim: null,
    budgetLimitReported: false,
    budgetWrapupSent: false,
    objectiveUpdatedPending: false,
    noProgressTurns: 0,
    noToolCallTurns: 0,
    promptFailures: 0,
    recoveryTurns: 0,
    attestationFaults: 0,
    blockedTurns: 0,
    ...overrides,
  };
}

interface SeedOptions {
  goals: Array<Record<string, unknown>>;
  sessionOrdered?: string[];
  focusedGoalIds?: Array<{sessionID: string; goalId: string}>;
  settlementReceipts?: Array<Record<string, unknown>>;
  pendingIntents?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
  /** Extra ids for `sessionOrdered`, beyond the session that owns them. */
  sessionOrderedExtra?: string[];
  /** An active goal forces startup's recovery pause, which is the first write. */
  ledgerForActive?: boolean;
}

async function seedSession(
  root: string,
  sessionID: string,
  opts: SeedOptions,
): Promise<void> {
  const dir = join(root, 'sessions', sessionID);
  await mkdir(dir, {recursive: true});
  const snapshot: PersistedState = {
    version: 1,
    goals: opts.goals as never,
    results: (opts.results ?? []) as never,
    sessionOrdered: [
      ...(opts.sessionOrdered ?? []),
      ...(opts.sessionOrderedExtra ?? []),
    ],
    invalidatedGoalIds: [],
    pendingIntents: (opts.pendingIntents ?? []) as never,
    settlementReceipts: (opts.settlementReceipts ?? []) as never,
    focusedGoalIds: (opts.focusedGoalIds ?? []) as never,
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(snapshot), 'utf8');
  // Raw JSONL, never through createCommittedEntry: that helper calls nextWalSeq in
  // the CURRENT process, which would prime the per-session counter before the code
  // under test loads — the fixture moving the state it is about to measure, which
  // this repository has been bitten by three times now.
  const lines = opts.goals.map((goal, i) =>
    JSON.stringify({
      seq: i + 1,
      revision: goal.revision,
      phase: 'committed',
      timestamp: Date.now() - 60_000,
      transition: {
        source: 'chat-message',
        goalId: goal.goalId,
        fromStatus: 'active',
        toStatus: goal.status,
      },
      snapshot: goal,
    }),
  );
  await writeFile(
    join(dir, 'state.json.ledger.jsonl'),
    lines.map(l => `${l}\n`).join(''),
    'utf8',
  );
}

async function readState(
  root: string,
  sessionID: string,
): Promise<PersistedState> {
  return JSON.parse(
    await readFile(join(root, 'sessions', sessionID, 'state.json'), 'utf8'),
  ) as PersistedState;
}

interface Harness {
  workspace: string;
  root: string;
  hooks: Awaited<ReturnType<typeof import('../src/plugin.ts').GoalsPlugin>>;
  goalStatus: (sessionID: string) => Promise<string>;
  runCommand: (sessionID: string, args: string) => Promise<string>;
}

async function loadPlugin(workspace: string): Promise<Harness> {
  const {GoalsPlugin} = await import('../src/plugin.ts');
  const hooks = await GoalsPlugin(
    {
      client: {
        app: {
          log: async () => {},
        },
        session: {
          messages: async () => ({data: []}),
          promptAsync: async () => ({}),
        },
      },
      directory: workspace,
    } as never,
    {idlePoller: false, registerAgents: false} as never,
  );
  const runCommand = async (
    sessionID: string,
    args: string,
  ): Promise<string> => {
    const output: {parts: {type: string; text: string}[]} = {parts: []};
    await hooks['command.execute.before']!(
      {command: 'goal', sessionID, arguments: args},
      output as never,
    );
    return output.parts[0]?.text ?? '';
  };
  const goalStatus = (sessionID: string): Promise<string> =>
    runCommand(sessionID, 'status');
  return {
    workspace,
    root: join(workspace, '.opencode', 'goals'),
    hooks,
    goalStatus,
    runCommand,
  };
}

describe('a goal record naming another session must not disable that session', () => {
  // Both orderings, because the whole enumeration at plugin-runtime.ts:478-516
  // completes before any hydration decision at:607+. A defect that depended on
  // order would be invisible at one sort and fatal at the other, so a single case
  // would be a coin flip rather than a test.
  for (const [attacker, victim] of [
    ['ses_aaa_attacker', 'ses_zzz_victim'],
    ['ses_zzz_attacker', 'ses_aaa_victim'],
  ]) {
    test(`the victim's own goals survive, and stay on disk, with a stray in ${attacker}'s file`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-stray-'));
      const root = join(workspace, '.opencode', 'goals');
      try {
        // The victim's file holds its own, legitimate goal. The attacker's file
        // holds one record whose OWN sessionID names the victim — the untrusted
        // input the guard exists for.
        await seedSession(root, victim, {
          goals: [goalRecord({goalId: 'g-victim', sessionID: victim})],
        });
        await seedSession(root, attacker, {
          goals: [goalRecord({goalId: 'g-attacker', sessionID: victim})],
        });

        const h = await loadPlugin(workspace);
        try {
          // The victim sees its own goal.
          const status = await h.goalStatus(victim);
          expect(
            status,
            `the victim session must still see its own goal; a stray in another file must not disable it (status was: ${status})`,
          ).toContain('a fixture objective');

          // AND the stray was not adopted. Loading it would create the victim's
          // directory in a second place and write a ledger into it.
          const victimAfterLoad = await readState(root, victim);
          expect(
            victimAfterLoad.goals.map(g => g.goalId),
            'the stray must not be loaded into the session it names',
          ).not.toContain('g-attacker');

          // The decisive half: the victim WRITES, and its goal is still there
          // afterwards. Before the fix the machine was never built, the projection
          // was built from live machines, and this single write rewrote the
          // victim's snapshot without the goal that was in it.
          //
          // `focus`, not a new objective: creating a goal in a session that
          // already has one legitimately REPLACES it, so that command would pass
          // or fail for a reason that has nothing to do with this defect. Moving
          // the focus pointer is a write that has no business changing which
          // goals the session holds.
          await h.runCommand(victim, 'focus g-victim');
          const victimAfterWrite = await readState(root, victim);
          expect(
            victimAfterWrite.goals.map(g => g.goalId),
            "a session's own goal must not be deleted from its file by another file's malformed record",
          ).toContain('g-victim');
        } finally {
          await h.hooks.dispose?.();
        }
      } finally {
        await rm(workspace, {recursive: true, force: true});
      }
    }, 60_000);
  }

  test('every session-bearing field is filtered, not only the one that was reported', async () => {
    // The gate above proved the STRAY GOAL is not adopted, and the sibling tests
    // proved results, sessionOrdered, the focus pointer and settlement receipts
    // are filtered. `pendingIntents[].sessionID` was the SIXTH, and it was not
    // filtered at all — so a record in A's file naming B became B's own durable
    // step barrier, and B's `focus_goal` answered "this goal has a pending
    // completion that will be applied when the current step finishes; focus
    // cannot change it now" for a completion B never requested.
    //
    // Asserted as a CENSUS over all six rather than as a sixth case, because the
    // defect class is a filter LIST being incomplete: a per-field test for the
    // field that was reported would have passed five times over while the sixth
    // leaked, which is exactly what happened. And the intent is asserted
    // behaviourally — focus must MOVE — not by reading the filter list, because a
    // list that is complete on paper and incomplete in the merge is the shape of
    // bug this file exists for.
    const FIELDS = [
      'goals',
      'results',
      'pendingIntents',
      'settlementReceipts',
      'focusedGoalIds',
      'sessionOrdered',
    ] as const;
    expect(FIELDS).toHaveLength(6);

    for (const attacker of ['ses_aaa_attacker', 'ses_zzz_attacker']) {
      const victim =
        attacker === 'ses_aaa_attacker' ? 'ses_zzz_victim' : 'ses_aaa_victim';
      const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-census-'));
      const root = join(workspace, '.opencode', 'goals');
      try {
        await seedSession(root, victim, {
          goals: [goalRecord({goalId: 'g-victim', sessionID: victim})],
        });
        // ONE record in the attacker's file, in EVERY session-bearing field at
        // once, all naming the victim. A census that seeds one field per run
        // cannot see a field that is missing from the list.
        const stray = {
          goalId: 'g-stray',
          sessionID: victim,
          outcome: {status: 'achieved' as const, reason: 'stray'},
          settlementReceipt: {
            sessionID: victim,
            goalId: 'g-stray',
            settledAt: Date.now(),
          },
          focusPointer: {sessionID: victim, goalId: 'g-stray'},
          intent: {
            sessionID: victim,
            goalId: 'g-victim',
            revision: 3,
            runId: 'run-fixture',
            messageID: 'msg-forged',
            toolCallID: 'call-forged',
            targetStatus: 'complete' as const,
            evidence: "forged by a record in another session's file",
            createdAt: Date.now(),
          },
        };
        await seedSession(root, attacker, {
          goals: [goalRecord({goalId: 'g-stray', sessionID: victim})],
          results: [stray as never],
          pendingIntents: [stray.intent as never],
          settlementReceipts: [stray.settlementReceipt as never],
          focusedGoalIds: [stray.focusPointer as never],
          sessionOrderedExtra: [victim],
        });

        const h = await loadPlugin(workspace);
        try {
          // A write in the victim's OWN session, which is what turns a leak into
          // a durable one: the projection is written back over the victim's file.
          await h.runCommand(victim, 'focus g-victim');
          const after = await readState(root, victim);
          const strays = {
            goals: after.goals
              .map(g => g.goalId)
              .filter(id => id === 'g-stray'),
            results: (after.results ?? [])
              .map(r => r.goalId)
              .filter(id => id === 'g-stray'),
            pendingIntents: (after.pendingIntents ?? []).filter(
              i =>
                i.evidence === "forged by a record in another session's file",
            ),
            settlementReceipts: (after.settlementReceipts ?? []).filter(
              r => r.goalId === 'g-stray',
            ),
            focusedGoalIds: (after.focusedGoalIds ?? []).filter(
              p => p.goalId === 'g-stray',
            ),
            sessionOrdered:
              (after.sessionOrdered ?? []).filter(id =>
                id === victim && !after.goals.length ? false : true,
              ).length > 1
                ? [victim]
                : [],
          };
          for (const field of FIELDS) {
            expect(
              strays[field as keyof typeof strays],
              `${field} leaked a record from ${attacker}'s file into ${victim}'s own file`,
            ).toHaveLength(0);
          }
          // And the decisive BEHAVIOURAL half, because an intent is not a record
          // of the past — it is a promise about what happens next, and the promise
          // survives a restart. Focus must be free to move.
          const focusOut = await h.runCommand(victim, 'focus g-victim');
          expect(
            focusOut,
            "a forged pending intent must not make the victim's focus unmovable",
          ).not.toContain('pending completion');
        } finally {
          await h.hooks.dispose?.();
        }
      } finally {
        await rm(workspace, {recursive: true, force: true});
      }
    }
  }, 60_000);

  test('the condition is still REPORTED, not silently swallowed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-stray-report-'));
    const root = join(workspace, '.opencode', 'goals');
    try {
      await seedSession(root, 'ses_reporter_owner', {
        goals: [goalRecord({goalId: 'g-ok', sessionID: 'ses_reporter_owner'})],
      });
      await seedSession(root, 'ses_reporter_other', {
        goals: [
          goalRecord({goalId: 'g-stray', sessionID: 'ses_reporter_owner'}),
        ],
      });
      const {GoalsPlugin} = await import('../src/plugin.ts');
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]): void => {
        errors.push(args.map(String).join(' '));
      };
      let resolved = false;
      try {
        await GoalsPlugin(
          {
            client: {
              app: {
                log: async () => {},
              },
            },
            directory: workspace,
          } as never,
          {idlePoller: false, registerAgents: false} as never,
        );
        resolved = true;
      } finally {
        console.error = originalError;
      }
      // The report names BOTH sessions: the file the record was found in, and the
      // session it claimed. The operator's two questions are "which of my files is
      // wrong" and "what is it pointing at", and a message carrying only one of
      // them answers neither on its own.
      const reported = errors.filter(
        e =>
          e.includes('ses_reporter_other') && e.includes('ses_reporter_owner'),
      );
      console.log(
        'STRAY-REPORT ' +
          JSON.stringify({
            resolved,
            total: errors.length,
            reported: reported.length,
          }),
      );
      expect(
        resolved,
        'a malformed on-disk record must not stop the plugin loading',
      ).toBe(true);
      expect(
        reported.length,
        `the untrusted record must be reported, and the report must name the file it was found in; got ${errors.length} error lines: ${errors.join(' | ')}`,
      ).toBeGreaterThan(0);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});

describe("a session's ordered flag survives the write that reports recovery", () => {
  test("an ordered session's flag is still in its own file after a restart", async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-ordered-'));
    const root = join(workspace, '.opencode', 'goals');
    const session = 'ses-ordered-flag';
    try {
      // An ACTIVE goal, so startup performs the recovery pause and therefore
      // writes — which is the write that used to erase the flag.
      await seedSession(root, session, {
        goals: [
          goalRecord({
            goalId: 'g-ordered',
            sessionID: session,
            status: 'active',
            stopReason: '',
          }),
        ],
        sessionOrdered: [session],
        ledgerForActive: true,
      });

      const h = await loadPlugin(workspace);
      try {
        const after = await readState(root, session);
        console.log(
          'ORDERED-FLAG ' +
            JSON.stringify({sessionOrdered: after.sessionOrdered}),
        );
        expect(
          after.sessionOrdered,
          "startup's own recovery write must not erase the session's ordered flag — eight auto-promotion sites gate on it",
        ).toEqual([session]);
      } finally {
        await h.hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);

  test('a focus pointer is not dropped by a write issued from inside the recovery loop', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-focus-flag-'));
    const root = join(workspace, '.opencode', 'goals');
    const session = 'ses-focus-flag';
    try {
      // Two goals, the SECOND one focused. The first is active, so the recovery
      // pause writes while the second is not yet a live machine — the ordering
      // that drops a pointer filtered against a partially built set.
      await seedSession(root, session, {
        goals: [
          goalRecord({
            goalId: 'g-first',
            sessionID: session,
            status: 'active',
            stopReason: '',
          }),
          goalRecord({
            goalId: 'g-second',
            sessionID: session,
            status: 'paused',
            stopReason: 'paused',
            revision: 4,
          }),
        ],
        focusedGoalIds: [{sessionID: session, goalId: 'g-second'}],
        ledgerForActive: true,
      });

      const h = await loadPlugin(workspace);
      try {
        const after = await readState(root, session);
        console.log(
          'FOCUS-FLAG ' +
            JSON.stringify({focusedGoalIds: after.focusedGoalIds}),
        );
        expect(
          (after.focusedGoalIds as unknown as Array<{goalId: string}>).map(
            f => f.goalId,
          ),
          'a focus pointer at a goal that is still live must not be dropped by a write from inside the recovery loop',
        ).toContain('g-second');
      } finally {
        await h.hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});

// (c) THE SAME BREACH IN THE THREE FIELDS NOBODY FILTERED. Goals and results were
// fixed in the confirmation pass; `sessionOrdered`, `focusedGoalIds` and
// `settlementReceipts` carry a session id of their own and were merged
// unfiltered, so one untrusted record in A's file landed in B's runtime and was
// written back into B's file by B's next write. Measured before the fix, with A's
// file holding three records naming B and one `focus` write on B:
//
// B's file afterwards — sessionOrdered ["ses_zzz_victim"],
// focusedGoalIds [{sessionID:"ses_zzz_victim"}], a settlement receipt for a goal
// B never settled.
//
// Each is load-bearing. `sessionOrdered` gates eight auto-promotion sites, so a
// stray id makes B ordered; `completeSettlement` resolves the FIRST receipt with
// a goalId across all sessions and persists against the FOREIGN receipt's
// sessionID, which would create a lease and a directory for a session this host
// has no other business with. It was inert only because the reader those receipts
// exist for has no caller yet — which is exactly why it must not be left to the
// day it gets one.
describe("a record naming another session cannot enter this session's runtime", () => {
  test('the ordered flag, focus pointer and settlement receipt are all filtered', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-stray-fields-'));
    const root = join(workspace, '.opencode', 'goals');
    const victim = 'ses_zzz_victim';
    const attacker = 'ses_aaa_attacker';
    try {
      // The ATTACKER's file carries three records naming the victim, and a goal
      // naming the victim too — the goal case is what the existing tests cover,
      // and these three are what was left.
      await seedSession(root, attacker, {
        goals: [
          goalRecord({
            goalId: 'g-attacker-own',
            sessionID: attacker,
            status: 'paused',
            stopReason: 'paused',
          }),
        ],
        sessionOrdered: [victim],
        focusedGoalIds: [{sessionID: victim, goalId: 'g-injected'}],
        settlementReceipts: [
          {
            goalId: 'g-injected',
            sessionID: victim,
            state: 'achieved',
            reason: 'forged',
            at: 1,
            evidence: [],
          },
        ],
        ledgerForActive: false,
      });
      // The VICTIM has a live goal of its own, and is what the host is driving.
      await seedSession(root, victim, {
        goals: [
          goalRecord({
            goalId: 'g-victim-own',
            sessionID: victim,
            status: 'active',
            stopReason: '',
          }),
        ],
        sessionOrdered: [],
        focusedGoalIds: [],
        settlementReceipts: [],
        ledgerForActive: true,
      });

      const h = await loadPlugin(workspace);
      try {
        // One write from the victim's own session is what projects the merged
        // runtime into the victim's file.
        const out = {parts: [] as unknown[]};
        await h.hooks['command.execute.before']!(
          {command: 'goal', sessionID: victim, arguments: 'pause'},
          out,
        );
        const after = (await readState(root, victim)) as unknown as {
          sessionOrdered: string[];
          focusedGoalIds: Array<{sessionID: string; goalId: string}>;
          settlementReceipts: Array<{sessionID: string; goalId: string}>;
          goals: Array<{goalId: string}>;
        };
        console.log(
          'STRAY-FIELDS ' +
            JSON.stringify({
              sessionOrdered: after.sessionOrdered,
              focusedGoalIds: after.focusedGoalIds,
              settlementReceipts: after.settlementReceipts,
            }),
        );
        expect(
          after.sessionOrdered,
          'a stray ordered flag must not make this session ordered',
        ).not.toContain(victim);
        expect(
          after.focusedGoalIds.map(p => p.sessionID),
          "and a stray focus pointer must not enter this session's runtime",
        ).not.toContain(victim);
        expect(
          after.settlementReceipts.map(r => r.sessionID),
          "and a stray settlement receipt must not — completeSettlement persists against the receipt's own session",
        ).not.toContain(victim);
        expect(
          after.goals.map(g => g.goalId),
          "and the victim's own goal is untouched",
        ).toContain('g-victim-own');
      } finally {
        await h.hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});
