// refused-host-mutation.test.ts — a refusal has TWO obligations.
//
// The first is do not DESTROY, and the tree already holds it: a lease-refused host
// declines every write, and `two-processes-one-worktree.test.ts` drives that with two
// real processes. The second is do not ACT, and it was wired for one arm of the event
// handler out of four. The idle gate existed; the arms that attribute usage, pause on a
// terminal event, reset tracking on compaction and count provider failures did not.
//
// The defect is not that the owner's file changed while the lock was held — it never
// did, which is exactly why a green suite passed over it. It is that the refused host's
// IN-MEMORY goal kept absorbing another process's events, and the refusal is
// deliberately not memoised, so the first write after the lock frees re-acquires the
// lease and projects that mutated runtime over the owner's own file.
//
// MEASURED through the real plugin, before the fix, one refused host against a live
// owner whose goal held 123,456 tokens. The owner's file was untouched while the lock
// was held, which is the property the write gate had already secured. Then the owner
// died and ONE `/goal checkpoint` from that same host wrote:
//
// totalTokens 0 (owner had 123,456)
// compactionBaselineTokens 123456
// lastAssistantMessageID ""
// messageIDs []
// lastAssistantText ""
//
// …and the goal resumed from that file. The control — the identical sequence with no
// compaction event delivered — kept every one of those values. The loss is the
// accounting every brake reads, and the double-counting it also causes makes usage
// attribution wrong in the other direction once the session is legitimately this
// host's again.
//
// ONE PROCESS FOR BOTH HALVES, and that is the whole difficulty. The mutation lives in
// that process's runtime: a second process would re-read the owner's file from disk and
// never see it, which is the mistake this file's first version made — it passed with the
// gate deleted. Two processes are still required to produce the refusal, because one
// process cannot hold and be refused the same lease.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnForeignOwner} from './lease-fixture.ts';

/** The worker program is a MODULE, not a string written to a temp dir, so `tsc` checks it. */
const WORKER_DIR = join(import.meta.dir, 'workers');

const REPO = join(import.meta.dir, '..');
const SESSION = 'ses_victim';

/**
 * The owner's goal, written by hand because a lease must be taken before the product
 * will write one, and the lease is the thing under test. The fields the compaction arm
 * resets are the ones that carry a value worth watching.
 */
function ownerGoal(sessionID: string) {
  return {
    goalId: 'g-owner',
    runId: 'r-owner',
    revision: 3,
    condition: "the owner's work",
    successCriteria: '',
    constraints: '',
    artifactPointers: [],
    pendingProposal: null,
    mode: 'normal',
    sessionID,
    tokenBudget: null,
    maxTokens: 1000,
    maxTurns: 25,
    maxDurationMs: 0,
    turnCount: 1,
    totalTokens: 123_456,
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
    stoppedAt: Date.now() - 10_000,
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
    messageIDs: ['m-owner-9'],
    lastAssistantMessageID: 'm-owner-9',
    lastAssistantText: 'the owner was working',
    checkpoints: [],
  };
}

/** Everything the compaction arm resets, in one comparable shape. */
function accountingOf(goal: Record<string, unknown>) {
  return {
    totalTokens: goal.totalTokens,
    compactionBaselineTokens: goal.compactionBaselineTokens,
    lastAssistantMessageID: goal.lastAssistantMessageID,
    lastAssistantText: goal.lastAssistantText,
    messageIDs: goal.messageIDs ?? [],
  };
}

async function waitForFile(path: string, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

describe("a lease-refused host does not ACT on the owner's goal, only decline to write it", () => {
  for (const [label, deliverCompaction] of [
    ['delivered session.compacted', 'yes'],
    ['delivered nothing (the control)', 'no'],
  ] as const) {
    test(`the owner's accounting survives this host's write, when it ${label}`, async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), 'fixate-on-refused-mutate-'),
      );
      const readyFile = join(workspace, 'ready');
      const goFile = join(workspace, 'go');
      const paths = join(workspace, '.opencode', 'goals', 'sessions', SESSION);
      const seeded = accountingOf(ownerGoal(SESSION));
      await mkdir(paths, {recursive: true});
      await writeFile(
        join(paths, 'state.json'),
        JSON.stringify({
          version: 1,
          goals: [ownerGoal(SESSION)],
          results: [],
          sessionOrdered: [],
          invalidatedGoalIds: [],
          pendingIntents: [],
          settlementReceipts: [],
          focusedGoalIds: [],
        }),
        'utf8',
      );

      const held = spawnForeignOwner();
      let heldKilled = false;
      try {
        const lockDir = `${join(paths, 'state.json')}.lock`;
        await mkdir(lockDir, {recursive: true});
        await writeFile(
          join(lockDir, 'owner.json'),
          JSON.stringify({
            token: 'other-process',
            pid: held.pid,
            hostname: hostname(),
            createdAt: Date.now(),
          }),
          'utf8',
        );

        const proc = Bun.spawn(
          [
            process.execPath,
            'run',
            join(WORKER_DIR, 'mutation-worker.ts'),
            workspace,
            SESSION,
            deliverCompaction,
            readyFile,
            goFile,
          ],
          {cwd: REPO, stdout: 'pipe', stderr: 'pipe'},
        );
        // Taken here rather than after the wait, so the pipe is drained while the
        // worker is still running: a worker that blocks on a full pipe would
        // otherwise deadlock against this file rather than fail.
        const stdout = new Response(proc.stdout).text();
        const stderr = new Response(proc.stderr).text();
        const ready = await waitForFile(readyFile);
        expect(
          ready,
          'the worker never reached the point where the refusal had been recorded',
        ).toBe(true);

        // The owner dies and its lock is released. This host becomes the writer —
        // legitimately, because the lease is free and the refusal is not memoised.
        try {
          process.kill(held.pid!, 'SIGKILL');
        } catch {
          /* already dead */
        }
        heldKilled = true;
        await rm(lockDir, {recursive: true, force: true});
        await writeFile(goFile, 'go', 'utf8');

        const [out, err] = await Promise.all([stdout, stderr]);
        await proc.exited;
        expect(
          out.trim(),
          `the worker produced no report. stderr=${err.slice(0, 2000)}`,
        ).not.toBe('');
        const report = JSON.parse(out) as {refusals: number; said: string};

        // The fixture, not the plugin, is what makes this a refusal. Assert it
        // HAPPENED, or a worker that failed to load would pass every assertion below
        // by never having been refused at all.
        expect(
          report.refusals,
          'the fixture did not produce a lease refusal, so this case is not the one it claims to be',
        ).toBeGreaterThan(0);

        const after = JSON.parse(
          await readFile(join(paths, 'state.json'), 'utf8'),
        ) as {
          goals: Array<Record<string, unknown>>;
        };
        const goal = after.goals.find(g => g.goalId === 'g-owner');
        expect(
          goal,
          "the owner's goal was removed by a host that held no right to write it",
        ).toBeDefined();

        // THE ASSERTION. The owner's ACCOUNTING, which is what the compaction arm
        // zeroed, and what every brake reads.
        expect(
          accountingOf(goal!),
          "a lease-refused host absorbed the owner's events and wrote the result over the owner's file the moment the lock freed",
        ).toEqual(seeded);
      } finally {
        await rm(readyFile, {force: true});
        await rm(goFile, {force: true});
        if (!heldKilled) {
          try {
            process.kill(held.pid!, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }
        await rm(workspace, {recursive: true, force: true});
      }
    }, 60_000);
  }
});

describe('the control case can fail', () => {
  // A control that cannot fail is a comment. These assert that the fixture is doing the
  // work: if the compaction arm had not reset those fields, or if the fixture never
  // carried them, both cases above would pass over the defect.
  test('the fields the compaction arm resets are present, populated and distinguishable', () => {
    const seeded = ownerGoal(SESSION);
    const afterCompaction = {
      ...seeded,
      totalTokens: 0,
      compactionBaselineTokens: seeded.totalTokens,
      lastAssistantMessageID: '',
      lastAssistantText: '',
      messageIDs: [],
    };
    expect(accountingOf(seeded)).not.toEqual(accountingOf(afterCompaction));
    expect(accountingOf(seeded).totalTokens).toBe(123_456);
    expect(accountingOf(afterCompaction).totalTokens).toBe(0);
  });
});
