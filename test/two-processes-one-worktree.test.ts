// two-processes-one-worktree.test.ts — the reported bug, driven as a reproduction.
//
// The failure the user reported was not describable from inside one process: "a
// second OpenCode process in the same worktree has no goal tools". Two plugin
// INSTANCES in one test process do not reproduce it — the in-process
// re-entrancy path masks it, and the same-pid lease reclaim makes a second
// acquire in the same pid succeed by design. The bug needed two PROCESSES, and
// so does its test.
//
// Each worker is a real `bun` subprocess that loads the real plugin from
// `src/`, creates a goal in its own session, and prints what it got. The parent
// then checks three things a single-process test cannot: both processes
// LOADED, both wrote, and neither file mentions the other's goal.

import {describe, expect, test} from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnForeignOwner} from './lease-fixture.ts';

/** The worker programs are MODULES, not strings written to a temp dir, so `tsc` checks them. */
const WORKER_DIR = join(import.meta.dir, 'workers');

const REPO = join(import.meta.dir, '..');

interface WorkerReport {
  sessionID: string;
  loaded: boolean;
  tools: string[];
  /** Present when the worker failed to load the plugin. */
  error?: string;
  goalId?: string;
}

/** Where the worker scripts are written, so the workspace holds only state. */
async function runWorker(
  workspace: string,
  sessionID: string,
  opts: {
    expectGoals?: boolean;
  } = {},
): Promise<WorkerReport> {
  const verb = opts.expectGoals === false ? 'probe' : 'work';
  const proc = Bun.spawn(
    [
      process.execPath,
      'run',
      join(WORKER_DIR, 'goal-worker.ts'),
      workspace,
      sessionID,
      verb,
    ],
    {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (!stdout.trim()) {
    throw new Error(
      `worker ${sessionID} produced no report. exit=${proc.exitCode} stderr=${stderr.slice(0, 2000)}`,
    );
  }
  return JSON.parse(stdout) as WorkerReport;
}

describe('a refusal is not memoised for the life of the process', () => {
  // The subprocess test above cannot reach this: a second attempt there is a
  // SECOND PROCESS, which has a fresh memo, so it passed whether or not the
  // first attempt's refusal was ever cleared. This one is in a single process
  // for exactly that reason.
  test('a session whose owner dies becomes writable again, without a restart', async () => {
    const {GoalsPlugin} = await import('../src/plugin.ts');
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-retry-inproc-'));
    const held = spawnForeignOwner();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const paths = join(
        workspace,
        '.opencode',
        'goals',
        'sessions',
        'ses_retry',
      );
      await mkdir(paths, {recursive: true});
      const lockDir = `${join(paths, 'state.json')}.lock`;
      await mkdir(lockDir, {recursive: true});
      await writeFile(
        join(lockDir, 'owner.json'),
        JSON.stringify({
          token: 'other',
          pid: held.pid,
          hostname: hostname(),
          createdAt: Date.now(),
        }),
        'utf8',
      );

      const hooks = await GoalsPlugin(
        {directory: workspace},
        {idlePoller: false, registerAgents: false},
      );
      try {
        const run = async (args: string): Promise<string> => {
          const output: {parts: {type: string; text: string}[]} = {parts: []};
          await hooks['command.execute.before']!(
            {command: 'goal', sessionID: 'ses_retry', arguments: args},
            output,
          );
          return output.parts[0]?.text ?? '';
        };
        await run('first attempt');
        expect(
          await Bun.file(join(paths, 'state.json')).exists(),
          "a live owner's session must not be written",
        ).toBe(false);
        expect(errors.join('\n')).toContain('already owned');

        // The other process is gone. Its lock is stale, and the lease module
        // knows how to reclaim one — but only if this host ASKS again.
        try {
          process.kill(held.pid!, 'SIGKILL');
        } catch {
          /* already dead */
        }
        await new Promise(r => setTimeout(r, 50));
        await run('second attempt');

        expect(
          await Bun.file(join(paths, 'state.json')).exists(),
          'a session whose owner died must become writable without a restart',
        ).toBe(true);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      console.error = originalError;
      try {
        process.kill(held.pid!, 'SIGKILL');
      } catch {
        /* already dead */
      }
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);
});

describe("a process refused a session's lease does not DRIVE that session's goal", () => {
  // Two REAL processes, because one process cannot produce a refusal at all. The
  // audit records that a test using two plugin instances in one process cannot
  // reproduce a cross-process hazard, and stayed green while this one was live.
  test("it neither prompts the owner's session nor writes what it accumulated", async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-refused-drive-'));
    const sessionID = 'ses_victim';
    const paths = join(workspace, '.opencode', 'goals', 'sessions', sessionID);
    const held = spawnForeignOwner();
    try {
      await mkdir(paths, {recursive: true});
      // The owner holds the lease, and the session holds an ACTIVE goal so
      // hydration recovery-pauses it — which is the state the poller re-arms.
      await writeFile(
        join(paths, 'state.json'),
        JSON.stringify({
          version: 1,
          goals: [
            {
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
            },
          ],
          results: [],
          sessionOrdered: [],
          invalidatedGoalIds: [],
          pendingIntents: [],
          settlementReceipts: [],
          focusedGoalIds: [],
        }),
        'utf8',
      );
      const lockDir = `${join(paths, 'state.json')}.lock`;
      await mkdir(lockDir, {recursive: true});
      await writeFile(
        join(lockDir, 'owner.json'),
        JSON.stringify({
          token: 'other',
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
          join(WORKER_DIR, 'drive-worker.ts'),
          workspace,
          sessionID,
        ],
        {
          cwd: REPO,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      expect(
        stdout.trim(),
        `drive worker produced no report. stderr=${stderr.slice(0, 1500)}`,
      ).not.toBe('');
      const report = JSON.parse(stdout) as {prompts: string[]; state: string};
      const seeded = await readFile(join(paths, 'state.json'), 'utf8');

      // THE ASSERTION. Not "the file is unchanged" — the file WAS always correct,
      // which is why the original gate missed the whole defect. The claim is that a
      // process told it does not own a session must not ACT on that session's goal.
      expect(
        report.prompts,
        'a lease-refused process must not send continuation prompts into a session another process owns',
      ).toHaveLength(0);
      expect(
        report.state,
        "a lease-refused process must not rewrite the owner's session — it accumulated turns and tokens while holding no right to write, and writes them the moment the lock frees",
      ).toBe(seeded);

      // And the owner's own goal is intact and readable, because a refusal gates a
      // WRITE and must not gate KNOWLEDGE — the decision this file's own header
      // records, and the one 69bf6ce made for the right reason.
      const after = JSON.parse(
        await readFile(join(paths, 'state.json'), 'utf8'),
      ) as {
        goals: Array<{goalId: string}>;
      };
      expect(after.goals.map(g => g.goalId)).toContain('g-owner');
    } finally {
      try {
        process.kill(held.pid!, 'SIGKILL');
      } catch {
        /* already dead */
      }
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});

describe('a write that was refused is REPORTED, on every surface that claims it', () => {
  // `session.persist` returns whether it was durable. Two of six call sites in
  // src/tools.ts honoured that and FOUR discarded it — including the two that
  // report a CLAIM about the future (`pendingCompletion: true`) and the one whose
  // message told a human to go and review a proposal that was never written. So
  // under a live lease the tools answered with no error at all: the agent's
  // completion claim was "recorded", the proposal was "queued for human review",
  // and neither existed on disk.
  //
  // Asserted on the RESPONSES, not on the file. The file was correct throughout —
  // nothing was written, which is the right behaviour — so a test that checked
  // storage would have passed over the whole defect. This is the shape
  // knowledgeStore.ownershipComputedButNeverConsulted names from the other side:
  // the guard worked, and its RESULT was thrown away.
  test('no tool reports a claim it could not persist', async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'fixate-on-report-refusal-'),
    );
    const sessionID = 'ses_reported';
    const paths = join(workspace, '.opencode', 'goals', 'sessions', sessionID);
    const held = spawnForeignOwner();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args.map(String).join(' '));
    };
    try {
      await mkdir(paths, {recursive: true});
      const lockDir = `${join(paths, 'state.json')}.lock`;
      await mkdir(lockDir, {recursive: true});
      await writeFile(
        join(lockDir, 'owner.json'),
        JSON.stringify({
          token: 'other',
          pid: held.pid,
          hostname: hostname(),
          createdAt: Date.now(),
        }),
        'utf8',
      );

      const {GoalsPlugin} = await import('../src/plugin.ts');
      const hooks = await GoalsPlugin(
        {directory: workspace},
        {idlePoller: false, registerAgents: false},
      );
      try {
        const run = async (args: string): Promise<string> => {
          const output: {parts: {type: string; text: string}[]} = {parts: []};
          await hooks['command.execute.before']!(
            {command: 'goal', sessionID, arguments: args},
            output,
          );
          return output.parts[0]?.text ?? '';
        };
        const callTool = async (
          name: string,
          input: Record<string, unknown>,
        ): Promise<{
          error?: string;
          text: string;
        }> => {
          // A ctx is REQUIRED, not optional: `execute` dereferences `ctx.sessionID`
          // unguarded, which is worth knowing (a tool invoked with no context throws
          // a TypeError instead of returning the error shape its siblings use) and is
          // recorded as a follow-up rather than fixed here, since it is not the defect
          // under test and the host always supplies a ctx.
          const tool = (
            hooks.tool as
              | Record<
                  string,
                  {
                    execute?: (i: unknown, c: unknown) => unknown;
                  }
                >
              | undefined
          )?.[name];
          const raw = await tool?.execute?.(
            input as never,
            {sessionID} as never,
          );
          const text =
            typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
          let error: string | undefined;
          try {
            const parsed = JSON.parse(text) as {error?: string};
            error = parsed.error;
          } catch {
            /* the tool's own shape is asserted elsewhere */
          }
          return {error, text};
        };

        // 1. THE PRIMARY SURFACE. Before the fix this printed "New active goal:
        // …" for a goal that was never written.
        const created = await run('the objective under test');
        expect(
          created,
          '/goal <objective> must not report a new active goal for a goal it could not save',
        ).not.toContain('New active goal');
        expect(created, 'the surface must say the goal was not saved').toMatch(
          /NOT SAVED/,
        );

        // 2. THE COMPLETION CLAIM. A `pendingCompletion: true` with no error is a
        // claim the agent will rely on, and the intent is the step barrier for
        // the settle, so an unpersisted one is a claim that cannot be honoured.
        const completed = await callTool('update_goal', {status: 'complete'});
        expect(
          completed.error,
          'a completion claim that could not be persisted must be reported as an error, not as pendingCompletion',
        ).toBeTruthy();

        // 3. THE PROPOSAL. Its message told a human to run /goal accept, so the
        // word "recorded" was a claim about disk.
        const proposed = await callTool('propose_goal_change', {
          reason: 'a test',
          objective: 'a different objective',
        });
        expect(
          proposed.text,
          'a proposal that was never written must not be reported as queued for human review',
        ).not.toContain('queued for human review');

        // 4. AND THE STORAGE FACT IS STILL TRUE, which is the half that was
        // already correct and must not regress while the reporting is fixed.
        expect(
          await Bun.file(join(paths, 'state.json')).exists(),
          'a refused session must still not be written — reporting it honestly is not a licence to write it',
        ).toBe(false);
        expect(
          errors.join('\n'),
          'the lease conflict must still be reported to the user',
        ).toContain('already owned');
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      console.error = originalError;
      try {
        process.kill(held.pid!, 'SIGKILL');
      } catch {
        /* already dead */
      }
      await rm(workspace, {recursive: true, force: true});
    }
  }, 60_000);
});

describe('two OpenCode processes, one worktree', () => {
  test("both load, both own their session, and neither file names the other's goal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-two-processes-'));
    try {
      // Started at the same moment, the way two windows are.
      const [alpha, beta] = await Promise.all([
        runWorker(workspace, 'ses_alpha'),
        runWorker(workspace, 'ses_beta'),
      ]);

      // 1. BOTH LOADED. This is the bug. The worker that failed reported the
      // error the log recorded — "goal persistence is already owned by pid …
      // on …" — and the user got a truthful agent saying it had no such tool.
      expect(alpha.error).toBeUndefined();
      expect(beta.error).toBeUndefined();
      expect(alpha.loaded).toBe(true);
      expect(beta.loaded).toBe(true);

      // 2. BOTH HAVE THE TOOL SURFACE, and it is the whole one.
      const expected = [
        'create_goal',
        'focus_goal',
        'get_goal',
        'goal-command',
        'list_goals',
        'propose_goal_change',
        'update_goal',
      ];
      expect(alpha.tools).toEqual(expected);
      expect(beta.tools).toEqual(expected);

      // 3. BOTH WROTE, and the files are disjoint.
      const alphaPath = join(
        workspace,
        '.opencode',
        'goals',
        'sessions',
        'ses_alpha',
        'state.json',
      );
      const betaPath = join(
        workspace,
        '.opencode',
        'goals',
        'sessions',
        'ses_beta',
        'state.json',
      );
      expect(await Bun.file(alphaPath).exists()).toBe(true);
      expect(await Bun.file(betaPath).exists()).toBe(true);
      const alphaRaw = await readFile(alphaPath, 'utf8');
      const betaRaw = await readFile(betaPath, 'utf8');
      expect(alphaRaw).toContain('work owned by ses_alpha');
      expect(alphaRaw).not.toContain('ses_beta');
      expect(betaRaw).toContain('work owned by ses_beta');
      expect(betaRaw).not.toContain('ses_alpha');
      expect(alpha.goalId).toBeDefined();
      expect(beta.goalId).toBeDefined();
      expect(alpha.goalId).not.toBe(beta.goalId);

      // 4. AND each process has its own ledger, each with its own numbering.
      // One shared ledger is what made the two processes allocate identical
      // sequences (measured ALPHA [1,2,3] / BETA [1,2,3]) and replay them in
      // an arbitrary order.
      const sessions = await readdir(
        join(workspace, '.opencode', 'goals', 'sessions'),
      );
      expect(sessions.sort()).toEqual(['ses_alpha', 'ses_beta']);
      for (const sessionID of sessions) {
        const ledger = await readFile(
          join(
            workspace,
            '.opencode',
            'goals',
            'sessions',
            sessionID,
            'state.json.ledger.jsonl',
          ),
          'utf8',
        );
        const seqs = ledger
          .split('\n')
          .filter(line => line.trim())
          .map(line => (JSON.parse(line) as {seq: number}).seq);
        expect(seqs.length, `${sessionID} wrote a ledger`).toBeGreaterThan(0);
        expect(
          new Set(seqs).size,
          `${sessionID} reused a sequence number`,
        ).toBe(seqs.length);
        for (let i = 1; i < seqs.length; i++) {
          expect(
            seqs[i]!,
            `${sessionID} is not strictly increasing`,
          ).toBeGreaterThan(seqs[i - 1]!);
        }
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);

  test('a session that appears AFTER this host loaded is not a free-for-all', async () => {
    // The hole the confirmation review found, and the reason this file exists.
    //
    // The sequence counter was seeded inside the STARTUP enumeration and the
    // lease inside the first write — two mechanisms at two moments — so a
    // session that appeared after load fell between them. Its counter was never
    // seeded, so `nextWalSeq` answered 1 over a ledger that already held 1, 2,
    // 3; and its lease was never attempted, so "we have not been told this
    // session exists" was being read as "we may write it".
    //
    // Measured, before the fix: FINAL LEDGER SEQS [1,2,3,1] and the foreign
    // goal's snapshot destroyed. The same shape as the 1,2,3,4,4 the layout was
    // built to remove, reached through goal creation rather than recovery.
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-late-session-'));
    try {
      // The host loads on an EMPTY workspace: it learns of no sessions at all.
      const host = await runWorker(workspace, 'ses_probe', {
        expectGoals: false,
      });
      expect(host.loaded).toBe(true);
      expect(host.error, `the host reported: ${host.error}`).toBeUndefined();

      // A session appears afterwards, with a history and an owner.
      const paths = join(
        workspace,
        '.opencode',
        'goals',
        'sessions',
        'ses_late',
      );
      await mkdir(paths, {recursive: true});
      const foreign = JSON.stringify({
        goalId: 'g-foreign',
        sessionID: 'ses_late',
        condition: 'foreign work',
      });
      await writeFile(
        join(paths, 'state.json'),
        JSON.stringify({
          version: 1,
          goals: [{...JSON.parse(foreign)}],
          results: [],
          sessionOrdered: [],
        }),
        'utf8',
      );
      const history = [1, 2, 3]
        .map(
          seq =>
            `${JSON.stringify({
              seq,
              revision: 1,
              phase: 'committed',
              timestamp: seq,
              transition: {
                source: 'idle-handler',
                goalId: 'g-foreign',
                fromStatus: 'active',
                toStatus: 'active',
                stopReason: '',
                blockedReason: '',
                detail: `entry ${seq}`,
              },
              snapshot: {...JSON.parse(foreign), status: 'active'},
            })}\n`,
        )
        .join('');
      await writeFile(join(paths, 'state.json.ledger.jsonl'), history, 'utf8');
      const held = spawnForeignOwner();
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

        // The host now works in that session, for the first time ever.
        const report = await runWorker(workspace, 'ses_late', {
          expectGoals: false,
        });
        expect(
          report.loaded,
          'a lease conflict must not stop the plugin loading',
        ).toBe(true);

        // The ledger is untouched: no sequence number reused, and no entry.
        const ledger = await readFile(
          join(paths, 'state.json.ledger.jsonl'),
          'utf8',
        );
        const seqs = ledger
          .split('\n')
          .filter(l => l.trim())
          .map(l => (JSON.parse(l) as {seq: number}).seq);
        expect(
          seqs,
          "a late session's ledger was written by a host that does not own it",
        ).toEqual([1, 2, 3]);
        // And the other process's goal is still there.
        const snapshot = JSON.parse(
          await readFile(join(paths, 'state.json'), 'utf8'),
        ) as {
          goals: {condition: string}[];
        };
        expect(snapshot.goals.map(g => g.condition)).toEqual(['foreign work']);
      } finally {
        try {
          process.kill(held.pid!, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);

  test('a late session with NO lock still gets its counter seeded', async () => {
    // The counter half of the same hazard, isolated from the lease.
    //
    // The previous test always installs a foreign lock, so it can only show
    // the LEASE was consulted — and it stayed green when the counter seeding
    // was deleted from preparation, because the lease alone was doing the work.
    // The reviewer's second scenario is the one that matters: with no lock at
    // all, the late host's first entry took seq 1 over a ledger already holding
    // 1, 2, 3, AND overwrote the other session's snapshot. Nothing there was a
    // lease conflict, so only the counter seeding could have prevented it.
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-late-counter-'));
    try {
      const host = await runWorker(workspace, 'ses_probe', {
        expectGoals: false,
      });
      expect(host.loaded).toBe(true);

      const paths = join(
        workspace,
        '.opencode',
        'goals',
        'sessions',
        'ses_late',
      );
      await mkdir(paths, {recursive: true});
      const foreign = {
        goalId: 'g-foreign',
        sessionID: 'ses_late',
        condition: 'foreign work',
        status: 'active',
      };
      await writeFile(
        join(paths, 'state.json'),
        JSON.stringify({
          version: 1,
          goals: [foreign],
          results: [],
          sessionOrdered: [],
        }),
        'utf8',
      );
      await writeFile(
        join(paths, 'state.json.ledger.jsonl'),
        [1, 2, 3]
          .map(
            seq =>
              `${JSON.stringify({
                seq,
                revision: 1,
                phase: 'committed',
                timestamp: seq,
                transition: {
                  source: 'idle-handler',
                  goalId: 'g-foreign',
                  fromStatus: 'active',
                  toStatus: 'active',
                  stopReason: '',
                  blockedReason: '',
                  detail: `entry ${seq}`,
                },
                snapshot: foreign,
              })}\n`,
          )
          .join(''),
        'utf8',
      );
      // No lock anywhere: this session is unowned, and this host is about to
      // become its writer. Its numbering has to come from the ledger it is
      // inheriting, not from zero.
      await runWorker(workspace, 'ses_late');

      const ledger = await readFile(
        join(paths, 'state.json.ledger.jsonl'),
        'utf8',
      );
      const seqs = ledger
        .split('\n')
        .filter(l => l.trim())
        .map(l => (JSON.parse(l) as {seq: number}).seq);
      const unique = new Set(seqs);
      expect(
        unique.size,
        `a late session reused a sequence: ${seqs.join(',')}`,
      ).toBe(seqs.length);
      expect(Math.min(...seqs.filter(s => s > 3))).toBe(4);
      // The snapshot now holds the late host's goal. The foreign one is gone
      // because `/goal <text>` REPLACES the focused goal, and after recovery
      // the only goal in the session is the foreign one — which is the
      // documented behaviour, not a loss. The point of this test is the
      // ledger, and it is asserted above.
      const snapshot = JSON.parse(
        await readFile(join(paths, 'state.json'), 'utf8'),
      ) as {
        goals: {condition: string}[];
      };
      expect(snapshot.goals.map(g => g.condition)).toEqual([
        'work owned by ses_late',
      ]);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);

  test('a session refused once becomes writable again once the other process is gone', async () => {
    // A REFUSAL MUST NOT BE MEMOISED. The lease module can reclaim a lock whose
    // owner has died, so a session that goes free while this host is running
    // should become writable without a restart — otherwise closing the other
    // OpenCode window leaves this one permanently unable to save anything, and
    // the user's only remedy is to restart a process they were told to keep.
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-retry-'));
    const held = spawnForeignOwner();
    try {
      const paths = join(
        workspace,
        '.opencode',
        'goals',
        'sessions',
        'ses_retry',
      );
      await mkdir(paths, {recursive: true});
      const lockDir = `${join(paths, 'state.json')}.lock`;
      await mkdir(lockDir, {recursive: true});
      await writeFile(
        join(lockDir, 'owner.json'),
        JSON.stringify({
          token: 'other',
          pid: held.pid,
          hostname: hostname(),
          createdAt: Date.now(),
        }),
        'utf8',
      );

      const run = async (): Promise<{wrote: boolean; error: string}> => {
        const proc = Bun.spawn(
          [
            process.execPath,
            'run',
            join(WORKER_DIR, 'retry-worker.ts'),
            workspace,
          ],
          {
            cwd: REPO,
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        return {wrote: out.includes('WROTE'), error: err};
      };

      const first = await run();
      expect(
        first.wrote,
        'a session owned by a live process must be refused',
      ).toBe(false);
      expect(first.error).toContain('already owned');

      // The other process exits. Its lock is now stale, and the lease module
      // knows how to reclaim one — but only if this host asks again.
      try {
        process.kill(held.pid!, 'SIGKILL');
      } catch {
        /* already dead */
      }
      await new Promise(r => setTimeout(r, 50));
      const second = await run();
      expect(
        second.wrote,
        'a session whose owner is gone must become writable',
      ).toBe(true);
    } finally {
      try {
        process.kill(held.pid!, 'SIGKILL');
      } catch {
        /* already dead */
      }
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);

  test("a process that is refused a session's lease does not write to its LEDGER either", async () => {
    // THE one the first test cannot reach, and it is the reason this test is
    // here. Both workers start on a fresh workspace, so neither hydrates
    // anything and neither appends to the other's ledger — which is exactly
    // why the first test stayed green while this hazard was live.
    //
    // Seeded: session ses_a has a goal that was ACTIVE when its process went
    // away, and a live owner holds its lease. The second process recovers it,
    // which is a real transition, and a transition is a ledger append. If the
    // refusal gates only the snapshot, that append takes a sequence number the
    // session's own history already holds — measured 1,2,3,4,4 — and replay
    // sorts on `seq` alone, so which of the two lands last is arbitrary. That
    // is the silent, non-deterministic goal loss this change set exists to
    // remove, arriving through the side door.
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-ledger-'));
    const held = spawnForeignOwner();
    try {
      const paths = join(workspace, '.opencode', 'goals', 'sessions', 'ses_a');
      await mkdir(paths, {recursive: true});
      const goal = JSON.stringify({
        goalId: 'g-a',
        runId: 'r-a',
        revision: 1,
        condition: 'a goal that was running',
        successCriteria: '',
        constraints: '',
        artifactPointers: [],
        pendingProposal: null,
        mode: 'normal',
        sessionID: 'ses_a',
        tokenBudget: null,
        maxTokens: 1000,
        maxTurns: 0,
        maxDurationMs: 1800000,
        minDelayMs: 1500,
        noProgressTokenThreshold: 50,
        noProgressTurnsBeforePause: 3,
        noToolCallTurnsBeforePause: 3,
        turnCount: 2,
        totalTokens: 20,
        compactionBaselineTokens: 0,
        usage: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          costKnown: false,
        },
        createdAt: 1,
        updatedAt: 2,
        startedAt: 1,
        pausedAt: 0,
        finishedAt: null,
        status: 'active',
        stopReason: '',
        blockedReason: '',
        finalizing: false,
        budgetLimitReported: false,
        budgetWrapupSent: false,
        objectiveUpdatedPending: false,
        noProgressTurns: 0,
        noToolCallTurns: 0,
        promptFailures: 0,
        recoveryTurns: 0,
        maxRecoveryTurns: 12,
        unchangedResults: 0,
        maxUnchangedResults: 3,
        lastCandidate: null,
        lastFingerprint: null,
        blockedTurns: 0,
        maxBlockedTurns: 3,
        blockedAssertedThisTurn: false,
        languageTriage: true,
        lastStatus: '',
        lastAssistantText: '',
        lastAssistantMessageID: '',
        lastCountedProgressMessageID: '',
        lastNoToolCallMessageID: '',
        baseline: null,
        lastContinueAt: 0,
        lastProgressAt: 0,
        continuationClaim: null,
        pendingNotices: [],
        history: [],
        lastCheckpoint: null,
        checkpoints: [],
        claims: [],
        lastClaim: null,
        messageIDs: [],
        executionContext: null,
      });
      await writeFile(
        join(paths, 'state.json'),
        JSON.stringify({
          version: 1,
          goals: [JSON.parse(goal)],
          results: [],
          sessionOrdered: [],
        }),
        'utf8',
      );
      // Three entries, seq 1..3, so a fourth must not reuse one of them.
      const lines = [1, 2, 3]
        .map(seq =>
          JSON.stringify({
            seq,
            revision: 1,
            phase: 'committed',
            timestamp: seq,
            transition: {
              source: 'idle-handler',
              goalId: 'g-a',
              fromStatus: 'active',
              toStatus: 'active',
              stopReason: '',
              blockedReason: '',
              detail: `entry ${seq}`,
            },
            snapshot: JSON.parse(goal),
          }),
        )
        .join('\n');
      await writeFile(
        join(paths, 'state.json.ledger.jsonl'),
        `${lines}\n`,
        'utf8',
      );
      // A live owner holds the lease on this session.
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

      const report = await runWorker(workspace, 'ses_a');
      expect(
        report.error,
        `the refused worker reported: ${report.error}`,
      ).toBeUndefined();
      expect(
        report.loaded,
        'a lease conflict must not stop the plugin loading',
      ).toBe(true);

      const ledger = await readFile(
        join(paths, 'state.json.ledger.jsonl'),
        'utf8',
      );
      const seqs = ledger
        .split('\n')
        .filter(l => l.trim())
        .map(l => (JSON.parse(l) as {seq: number}).seq);
      expect(seqs, "a refused process appended to a session's ledger").toEqual([
        1, 2, 3,
      ]);
    } finally {
      try {
        process.kill(held.pid!, 'SIGKILL');
      } catch {
        /* already dead */
      }
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);
});
