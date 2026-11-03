// startup-hydration-order.test.ts — what the startup recovery write must NOT erase.
//
// `8711060` fixed one instance of a shape and the confirmation pass found two
// more. The shape: `getPersistedState` projects a session's durable state from
// RUNTIME fields, and startup hydrates those fields in a sequence. Any write that
// fires before a field is hydrated rewrites the session's file with that field
// empty — and the value is not recovered later, because the next startup reads a
// file that no longer holds it.
//
// Measured on the two instances below, with a control that isolates the cause by
// using a PAUSED goal (so no recovery write fires at all):
//
// CONTROL paused goal -> results=1 intents=1
// ACTIVE goal -> results=0 intents=0 <- the recovery write
//
// So a session that quits with an active goal, an archived result and a pending
// completion intent loses the latter two, permanently, at every startup. The
// pending intent is the STEP BARRIER for `update_goal complete` — losing it is the
// "a goal that cannot end" failure AGENTS.md principle 5 names as equally serious
// as a premature exit.
//
// The second instance is not about ordering at all: `results` were merged into
// runtime state unfiltered, keyed by the RESULT's own sessionID, while `goals`
// were filtered by the directory they were read from. So one untrusted record in
// session A's file could write itself into session B's file — the exact invariant
// the per-session layout exists to enforce, breached from the data rather than
// from the code.

import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function goalRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    goalId: 'g-live',
    runId: 'r-live',
    revision: 4,
    condition: 'an objective that is still running',
    successCriteria: '',
    constraints: '',
    artifactPointers: [],
    pendingProposal: null,
    mode: 'normal',
    sessionID: 'ses_owner',
    tokenBudget: null,
    maxTokens: 0,
    maxTurns: 0,
    maxDurationMs: 0,
    turnCount: 2,
    totalTokens: 0,
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
    pausedAt: 0,
    finishedAt: null,
    status: 'active',
    stopReason: '',
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

function resultRecord(
  goalId: string,
  sessionID: string,
): Record<string, unknown> {
  return {
    goalId,
    sessionID,
    condition: 'an earlier, settled goal',
    state: 'achieved',
    reason: 'completed (verifier: COMPLETE)',
    evidence: 'read the two files',
    blockedReason: '',
    turnCount: 1,
    totalTokens: 0,
    tokenBudget: null,
    createdAt: Date.now() - 120_000,
    usage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costKnown: false,
    },
    startedAt: Date.now() - 120_000,
    finishedAt: Date.now() - 60_000,
    lastStatus: '',
    lastCheckpoint: null,
    checkpoints: [],
    history: [],
    lastClaim: null,
  };
}

async function seedSession(
  root: string,
  sessionID: string,
  opts: {
    goals: Array<Record<string, unknown>>;
    results?: Array<Record<string, unknown>>;
    pendingIntents?: Array<Record<string, unknown>>;
  },
): Promise<void> {
  const dir = join(root, 'sessions', sessionID);
  const {mkdir, writeFile} = await import('node:fs/promises');
  await mkdir(dir, {recursive: true});
  const snapshot = {
    version: 1,
    goals: opts.goals,
    results: opts.results ?? [],
    sessionOrdered: [],
    invalidatedGoalIds: [],
    pendingIntents: opts.pendingIntents ?? [],
    settlementReceipts: [],
    focusedGoalIds: [],
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(snapshot), 'utf8');
  // Raw JSONL: seeding through createCommittedEntry calls nextWalSeq in THIS
  // process and would prime the counter before the code under test loads.
  const lines = opts.goals.map((g, i) =>
    JSON.stringify({
      seq: i + 1,
      revision: g.revision,
      phase: 'committed',
      timestamp: Date.now() - 60_000,
      transition: {
        source: 'chat-message',
        goalId: g.goalId,
        fromStatus: 'active',
        toStatus: g.status,
      },
      snapshot: g,
    }),
  );
  await writeFile(
    join(dir, 'state.json.ledger.jsonl'),
    lines.map(l => `${l}\n`).join(''),
    'utf8',
  );
}

async function loadPlugin(
  workspace: string,
): Promise<Awaited<ReturnType<typeof import('../src/plugin.ts').GoalsPlugin>>> {
  const {GoalsPlugin} = await import('../src/plugin.ts');
  return GoalsPlugin(
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
}

const readState = async (
  root: string,
  sessionID: string,
): Promise<Record<string, unknown[]>> =>
  JSON.parse(
    await readFile(join(root, 'sessions', sessionID, 'state.json'), 'utf8'),
  ) as Record<string, unknown[]>;

describe("the startup recovery write must not erase a session's other durable state", () => {
  // Both orders of the same fixture, because the defect is invisible on a goal
  // that does not trigger a write — a test that only used the ACTIVE case would
  // pass on a fix that broke nothing and proved nothing.
  for (const [label, status] of [
    ['active', 'active'],
    ['paused (no recovery write)', 'paused'],
  ] as const) {
    test(`archived results survive a ${label} goal's recovery write`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-archive-'));
      const root = join(workspace, '.opencode', 'goals');
      const session = `ses_archive_${status}`;
      try {
        await seedSession(root, session, {
          goals: [
            goalRecord({
              sessionID: session,
              status,
              stopReason: status === 'paused' ? 'paused' : '',
            }),
          ],
          results: [resultRecord('g-archived', session)],
        });
        const hooks = await loadPlugin(workspace);
        try {
          const after = await readState(root, session);
          console.log(
            `ARCHIVE ${status} ${JSON.stringify({results: after.results!.length, goals: after.goals!.length})}`,
          );
          expect(
            after.results!.map(r => (r as {goalId: string}).goalId),
            `a startup write must not drop a session's archived results (${label})`,
          ).toEqual(['g-archived']);
        } finally {
          await hooks.dispose?.();
        }
      } finally {
        await rm(workspace, {recursive: true, force: true});
      }
    }, 60_000);
  }

  test('a pending completion intent survives the recovery write that follows it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-intent-'));
    const root = join(workspace, '.opencode', 'goals');
    const session = 'ses_intent_active';
    try {
      // The intent's stored revision is the SNAPSHOT's revision, which is what
      // the validator checks — so this is a VALID intent, not a stale one, and a
      // fix cannot make it survive by discarding it as stale.
      await seedSession(root, session, {
        goals: [goalRecord({sessionID: session})],
        pendingIntents: [
          {
            sessionID: session,
            goalId: 'g-live',
            revision: 4,
            runId: 'r-live',
            messageID: 'msg-1',
            toolCallID: 'tc-1',
            targetStatus: 'complete',
            evidence: 'the two file reads',
            createdAt: Date.now() - 1_000,
          },
        ],
      });
      const hooks = await loadPlugin(workspace);
      try {
        const after = await readState(root, session);
        console.log(
          `INTENT ${JSON.stringify({intents: after.pendingIntents!.length, goals: after.goals!.length})}`,
        );
        expect(
          after.pendingIntents!.map(i => (i as {goalId: string}).goalId),
          'the step barrier for a completion must survive the write that reports recovery — losing it is a goal that cannot end',
        ).toEqual(['g-live']);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);

  // The revision the intent carries is now COMPUTED from the snapshot before the
  // pause rather than read from the machine after it. The two expressions are
  // arithmetically the same number, and arithmetic equivalence is a claim, not a
  // result: this drives the whole chain and checks the pairing the loop actually
  // tests. `validatePendingIntent` requires `intent.revision === goal.revision`,
  // so a wrong number here is a pending completion that never converges — a goal
  // that cannot end, which is the failure this whole area is about.
  test("the recovered intent's revision is the one the goal will carry after the re-arm", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'fixate-on-intent-converge-'),
    );
    const root = join(workspace, '.opencode', 'goals');
    const session = 'ses_intent_converge';
    try {
      await seedSession(root, session, {
        goals: [goalRecord({sessionID: session})],
        pendingIntents: [
          {
            sessionID: session,
            goalId: 'g-live',
            revision: 4,
            runId: 'r-live',
            messageID: 'msg-1',
            toolCallID: 'tc-1',
            targetStatus: 'complete',
            evidence: 'the two file reads',
            createdAt: Date.now() - 1_000,
          },
        ],
      });
      const hooks = await loadPlugin(workspace);
      try {
        // The arithmetic, observed where it is directly readable: the intent in
        // the file, before anything has had a chance to move the goal on. The
        // snapshot's revision is 4; the recovery pause and the re-arm each bump
        // it, so the intent must carry 6 — which is what the OLD code computed by
        // reading the machine after the pause, and what the new code states.
        const afterRecovery = await readState(root, session);
        const snapshotRevision = 4;
        const intentAfterRecovery = afterRecovery.pendingIntents![0] as
          {revision: number} | undefined;
        expect(
          intentAfterRecovery,
          'the recovery write must leave the step barrier in the file for the re-arm to pick up',
        ).toBeDefined();
        expect(
          intentAfterRecovery!.revision,
          'the intent must carry the revision the goal WILL have after the pause (+1) and the re-arm (+1)',
        ).toBe(snapshotRevision + 2);

        // And then the whole chain, because the pairing is only worth anything if
        // the loop consumes it. `validatePendingIntent` compares the two revisions
        // for EQUALITY, so a one-off number is a pending completion that never
        // converges.
        //
        // The observable is not the revision after the idle — the goal moves on
        // once the intent fires, which is the point — it is that the completion
        // path engaged at all. With the intent erased by the recovery write it
        // could not, and that is the whole defect.
        await hooks.event!({type: 'session.idle', sessionID: session} as never);

        const after = await readState(root, session);
        const goal = after.goals![0] as {
          revision: number;
          status: string;
          stopReason: string;
        };
        console.log(
          `INTENT-PAIRING ${JSON.stringify({
            goalStatus: goal.status,
            goalStopReason: goal.stopReason,
            goalRevision: goal.revision,
            intentAfterRecovery: intentAfterRecovery!.revision,
            intentsRemaining: after.pendingIntents!.length,
          })}`,
        );

        expect(
          goal.status,
          'the recovered goal must have re-armed on the first idle',
        ).toBe('active');
        expect(
          goal.revision,
          'the pause and the re-arm must both have bumped the goal past the revision the intent names',
        ).toBeGreaterThanOrEqual(snapshotRevision + 2);
        expect(
          goal.stopReason,
          'the recovered intent must have driven the completion path — with it erased, this is unreachable',
        ).toBe('completion verification unavailable');
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});

describe("one session's results cannot be written into another session's file", () => {
  test("a result in A's file naming B is not adopted by B", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'fixate-on-result-foreign-'),
    );
    const root = join(workspace, '.opencode', 'goals');
    const A = 'ses_aaa_attacker';
    const B = 'ses_zzz_victim';
    try {
      // A's file is a plausible-looking state file holding ONE result whose own
      // sessionID names B — untrusted input from wherever it came from.
      await seedSession(root, A, {
        goals: [],
        results: [resultRecord('g-injected', B)],
      });
      // B's own file holds B's own result and a live goal.
      await seedSession(root, B, {
        goals: [
          goalRecord({sessionID: B, status: 'paused', stopReason: 'paused'}),
        ],
        results: [resultRecord('g-own', B)],
      });

      const hooks = await loadPlugin(workspace);
      try {
        // Drive B: any write projects B's state.
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {
            command: 'goal',
            sessionID: B,
            arguments: 'focus g-live',
          },
          output as never,
        );
        const after = await readState(root, B);
        console.log(
          `RESULT-FOREIGN ${JSON.stringify(after.results!.map(r => (r as {goalId: string}).goalId))}`,
        );
        expect(
          after.results!.map(r => (r as {goalId: string}).goalId),
          "another session's file must not be able to write a result into this one",
        ).toEqual(['g-own']);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});
