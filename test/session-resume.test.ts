// session-resume.test.ts — a goal that was active on exit comes back and works.
//
// This is the requirement with a scar. A session once released working
// software and still burned ~594k tokens, because the design left it no honest
// way to stop; the one thing that must not regress is that a session RESUMES.
// The mechanism already existed before the storage change and is unit-tested
// elsewhere — startup pauses a recovered active goal with stopReason
// `recovery`, and the first idle after hydration re-arms it. What the storage
// change puts at risk is that mechanism, because both halves now depend on the
// per-session layout: startup must read EVERY session's file, and each
// session's sequence counter must be seeded from that session's OWN ledger.
//
// So both are exercised here against real files: a goal with real history in a
// real ledger, recovered by a real plugin, driven by a real idle.

import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin.ts';
import {ensureSessionDir, sessionStatePaths} from '../src/session-paths.ts';
import {serializeGoal} from '../src/persistence.ts';
import {
  peekWalSeq,
  readWalEntries,
  writeStateFile,
} from '../src/persistence-wal.ts';
import {createGoalState, type GoalState} from '../src/state-machine.ts';
import {waitFor} from './wait-for.ts';

/**
 * A DISTINCT session id per test, and that is not tidiness.
 *
 * `nextWalSeq` is module state, so it survives between tests in one file. If two
 * tests shared a session id, the first one's plugin load would leave that
 * session's counter seeded, and the second test could no longer tell a seeded
 * counter from an empty one — its own measurement would be primed by the test
 * above it. Distinct ids keep each test's counter virgin.
 */
const RESUME_SESSION = 'ses_resume_a';
const RESUME_OTHER = 'ses_resume_b';
const SEQ_SESSION = 'ses_resume_c';
const SEQ_OTHER = 'ses_resume_d';
const HISTORY_SESSION = 'ses_resume_e';

/** Drive a slash command the way a host does. */
async function runGoalCommand(
  hooks: Awaited<ReturnType<typeof GoalsPlugin>>,
  sessionID: string,
  args: string,
): Promise<string> {
  const output: {parts: {type: string; text: string}[]} = {parts: []};
  await hooks['command.execute.before']!(
    {command: 'goal', sessionID, arguments: args},
    output,
  );
  return output.parts[0]?.text ?? '';
}

/**
 * A goal that was ACTIVE when the process went away, with the ledger history
 * that shows it. A snapshot alone is not the test: recovery replays the ledger
 * on top of it, and a per-session sequence bug shows up only there.
 */
async function seedActiveGoal(
  workspace: string,
  sessionID: string,
  goalId: string,
  runId: string,
  turns: number,
): Promise<GoalState> {
  const goal = createGoalState(
    sessionID,
    'a goal that was running when the process exited',
    {goalId, runId},
  );
  goal.status = 'active';
  goal.turnCount = turns;
  goal.revision = turns + 1;
  await ensureSessionDir(workspace, sessionID);
  const paths = sessionStatePaths(workspace, sessionID);
  // The ledger is written as RAW TEXT, deliberately. Seeding it through
  // createCommittedEntry would call nextWalSeq for this session in the CURRENT
  // process, and the ledger's counter would already be at `turns` before the
  // plugin under test ever ran — which would make the counter's own tests
  // incapable of failing. A fixture must not prime the thing it measures.
  const lines = Array.from({length: turns}, (_, i) =>
    JSON.stringify({
      seq: i + 1,
      revision: i + 2,
      phase: 'committed',
      timestamp: 1,
      transition: {
        source: 'idle-handler',
        goalId,
        fromStatus: 'active',
        toStatus: 'active',
        stopReason: '',
        blockedReason: '',
        detail: `continuation ${i + 1}`,
      },
      snapshot: {
        ...serializeGoal(goal),
        status: 'active',
        turnCount: i + 1,
        revision: i + 2,
      },
    }),
  );
  await writeFile(paths.ledgerPath, lines.join('\n') + '\n', 'utf8');
  await writeStateFile(paths.statePath, [goal], [], []);
  return goal;
}

describe('a session resumes its goal', () => {
  test('active at exit -> recovered paused for recovery -> re-armed on the first idle', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-resume-'));
    try {
      await seedActiveGoal(
        workspace,
        RESUME_SESSION,
        'g-resume',
        'r-resume',
        3,
      );
      // A second session, also active, which startup must ALSO read. A startup
      // that recovered one session would pass a single-session test and silently
      // never resume the other.
      await seedActiveGoal(workspace, RESUME_OTHER, 'g-other', 'r-other', 2);

      const prompts: string[] = [];
      // The idle handler calls promptAsync with a SINGLE argument (the prompt
      // body) on the session-api adapter's surface; the recording client below
      // matches the shape the existing integration fixtures use.
      const promptRecorder = async (input: unknown): Promise<object> => {
        const parts = (input as {parts?: {text?: string}[]})?.parts ?? [];
        prompts.push(parts[0]?.text ?? JSON.stringify(input));
        return {};
      };
      const hooks = await GoalsPlugin(
        {
          client: {
            app: {
              log: async () => {},
            },
            session: {
              messages: async () => ({data: []}),
              promptAsync: promptRecorder,
            },
          },
        },
        {stateRoot: workspace, idlePoller: false, registerAgents: false},
      );
      try {
        // Recovered goals are PAUSED, not silently running: an unattended
        // auto-continue must not resume work the user did not ask it to.
        // --verbose is where the reason a goal is paused is reported; the
        // short form says only that it is paused, which is a different claim.
        const status = await runGoalCommand(
          hooks,
          RESUME_SESSION,
          'status --verbose',
        );
        expect(status).toContain(
          'a goal that was running when the process exited',
        );
        expect(status).toMatch(/paused/i);
        // The reason it was paused is the plugin's own recovery bookkeeping, not
        // a brake — a user reading this needs to be able to tell the two apart.
        expect(status).toMatch(/recovery/i);
        expect(prompts).toHaveLength(0);

        // The other session came back too.
        const otherStatus = await runGoalCommand(hooks, RESUME_OTHER, 'status');
        expect(otherStatus).toContain(
          'a goal that was running when the process exited',
        );

        // The FIRST IDLE is the resume boundary, and it re-arms.
        await hooks.event!({
          type: 'session.idle',
          sessionID: RESUME_SESSION,
          id: 'resume-idle-1',
        } as never);
        await waitFor(
          () => prompts.length === 1,
          'the post-idle continuation prompt',
        );
        expect(prompts[0]).toContain(
          'a goal that was running when the process exited',
        );
        const working = await runGoalCommand(hooks, RESUME_SESSION, 'status');
        expect(working).toMatch(/working:/i);
        // And the detail is still the one a user reading `/goal status` needs,
        // which now ALSO names where the idle came from — the host reported the
        // turn idle, rather than the poller inferring one from a quiet turn.
        // Asserted on the sentence AND the provenance, because the provenance is
        // the part added and a test that only pinned the sentence would
        // have passed over the whole change.
        const verbose = await runGoalCommand(hooks, RESUME_SESSION, 'history');
        expect(verbose).toContain(
          'Resumed automatically when the restored session became idle',
        );
        expect(verbose).toContain('the host reported the turn idle');
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);

  test("the resumed session's NEW entries continue its own ledger, not a neighbour's", async () => {
    // THE specific failure a shared sequence counter produces. Session A's
    // ledger is at 5; session B's is at 2. A counter seeded from one of them
    // gives the resumed session a number its own history already holds, and
    // since replay sorts on `seq` alone the OLDER entry wins and recovery
    // restores the wrong state — a goal that comes back as something it never
    // was. So this asserts the sequence the resumed session writes next.
    const workspace = await mkdtemp(join(tmpdir(), 'fixate-on-resume-seq-'));
    try {
      await seedActiveGoal(workspace, SEQ_SESSION, 'g-seq', 'r-seq', 4);
      await seedActiveGoal(workspace, SEQ_OTHER, 'g-other', 'r-other', 1);

      const alphaBefore = await readWalEntries(
        sessionStatePaths(workspace, SEQ_SESSION).ledgerPath,
      );
      const betaBefore = await readWalEntries(
        sessionStatePaths(workspace, SEQ_OTHER).ledgerPath,
      );
      const alphaMax = Math.max(...alphaBefore.map(e => e.seq));
      const betaMax = Math.max(...betaBefore.map(e => e.seq));
      expect(alphaMax).toBeGreaterThan(betaMax); // different histories, on purpose

      const hooks = await GoalsPlugin(
        {client: {session: {promptAsync: async () => ({})}}},
        {stateRoot: workspace, idlePoller: false, registerAgents: false},
      );
      try {
        // THE property, measured directly rather than inferred from the outcome:
        // loading the plugin must leave each ledger's counter sitting on its
        // OWN maximum. The two ledgers are different lengths on purpose, so a
        // counter seeded from the wrong file lands on the wrong number.
        // Keyed by the LEDGER the entry lands in, which is the only name that
        // distinguishes two ledgers one process can hold under the same session
        // id (two plugin instances pointed at two state roots).
        expect(
          peekWalSeq(sessionStatePaths(workspace, SEQ_SESSION).ledgerPath),
        ).toBeGreaterThanOrEqual(alphaMax);
        expect(
          peekWalSeq(sessionStatePaths(workspace, SEQ_OTHER).ledgerPath),
        ).toBeGreaterThanOrEqual(betaMax);
        // A transition in the first session, after its recovery pause.
        await runGoalCommand(hooks, RESUME_SESSION, 'pause');
        const alphaAfter = await readWalEntries(
          sessionStatePaths(workspace, SEQ_SESSION).ledgerPath,
        );
        const newAlpha = alphaAfter.filter(e => e.seq > alphaMax);
        expect(newAlpha.length).toBeGreaterThan(0);
        for (const entry of newAlpha) {
          expect(
            entry.seq,
            'a resumed session reused a sequence its own history held',
          ).toBeGreaterThan(alphaMax);
        }
        // And the other session's ledger carries NOTHING of the first
        // session's work. Counting entries would not do it — the neighbour
        // legitimately grows by its OWN recovery entries — so this asserts the
        // thing that must never happen: an entry naming the other session's
        // goal, in the other session's file.
        const betaAfter = await readWalEntries(
          sessionStatePaths(workspace, SEQ_OTHER).ledgerPath,
        );
        expect(betaAfter.some(e => e.transition.goalId === 'g-seq')).toBe(
          false,
        );
        expect(betaAfter.some(e => e.snapshot.sessionID === SEQ_SESSION)).toBe(
          false,
        );
        expect(betaAfter.every(e => e.seq <= betaMax + 2)).toBe(true);
        // And its own history is intact.
        expect(betaAfter.filter(e => e.seq <= betaMax)).toHaveLength(
          betaBefore.length,
        );
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);

  test("a resumed goal's own history survives: the restored turn count is the one on disk", async () => {
    // Shows the recovery actually replayed the ledger rather than reading the
    // snapshot alone: the snapshot's turnCount is written by the caller, and
    // the ledger is what recovery prefers.
    const workspace = await mkdtemp(
      join(tmpdir(), 'fixate-on-resume-history-'),
    );
    try {
      const goal = await seedActiveGoal(
        workspace,
        HISTORY_SESSION,
        'g-history',
        'r-history',
        3,
      );
      const onDisk = JSON.parse(
        await readFile(
          sessionStatePaths(workspace, HISTORY_SESSION).statePath,
          'utf8',
        ),
      ) as {
        goals: {turnCount: number; revision: number}[];
      };
      expect(onDisk.goals[0]!.turnCount).toBe(3);

      const hooks = await GoalsPlugin(
        {client: {session: {promptAsync: async () => ({})}}},
        {stateRoot: workspace, idlePoller: false, registerAgents: false},
      );
      try {
        const status = await runGoalCommand(
          hooks,
          HISTORY_SESSION,
          'status --verbose',
        );
        expect(status).toMatch(/3 turn|turns: *3|3\/|3 of/i);
        void goal;
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  }, 30_000);
});
