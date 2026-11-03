// snapshot-read-ceiling.test.ts — a snapshot past the read ceiling is not an empty
// workspace, and must never be overwritten by one.
//
// `readBoundedText` bounds memory at 16 MiB. Past that it returned a PREFIX, the
// prefix failed `JSON.parse`, and the same catch that handles a corrupt file
// handled it — so `snapshot` stayed the empty default and the caller could not
// tell "this workspace has no goals" from "I declined to read this file".
//
// Measured on this tree before the fix, same fixture, only the size differing:
//
// under snapshotBytes=4,882,580 goalsRecovered=200
// OVER snapshotBytes=1,796,373,470 goalsRecovered=0 invalidatedGoalIds=["g-cleared"]
//
// The second line is the harm in one number. Two hundred goals recovered as zero,
// and — because only the snapshot carries them — so did the ordered flag, the focus
// pointer, the settlement receipts and every pending completion intent, with no
// error anywhere. The invalidation fence SURVIVED, and that is worth being precise
// about rather than alarming: the ledger carries a removal tombstone, and recovery
// replays it, so a cleared goal does not come back while its tombstone is inside
// the retention window. The defect is not resurrection. It is that the plugin
// silently replaces a megabyte-scale checkpoint it merely declined to read.
//
// Every case below has a control that must behave differently, because a gate
// whose control also fails is asserting the fixture rather than the rule.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverState, writeStateFile} from '../src/persistence-wal.ts';
import {GoalsPlugin} from '../src/plugin.ts';
import {createGoalState} from '../src/state-machine.ts';
import type {SerializedGoal} from '../src/persistence.ts';

const SESSION = 'ses_ceiling';
/** An ordinary second session, in the same workspace, with no file of its own yet. */
const OTHER = 'ses_ordinary';

/**
 * A snapshot over the ceiling, without building one for real.
 *
 * A genuine fixture needs hundreds of megabytes, which is slow and memory-hungry;
 * the property under test is the READER's reaction to `info.size > ceiling`, and
 * the byte count is what decides that. So the file is written once with real,
 * well-formed JSON of the right magnitude and the reader is exercised against it
 * for real — `recoverState` sees the actual size on disk.
 */
async function writeOverCeiling(
  statePath: string,
  bytes: number,
): Promise<void> {
  await mkdir(join(statePath, '..'), {recursive: true});
  const goals: SerializedGoal[] = [];
  // One goal carrying as much history as it takes to reach the requested size,
  // which is how a real session reaches it: MAX_PERSISTED_ENTRIES is 2000 for
  // both goals and history, and lastAssistantText is 16 000 characters.
  const filler = 'x'.repeat(16_000);
  let written = 0;
  while (written < bytes) {
    goals.push({
      goalId: `g${goals.length}`,
      runId: 'r',
      revision: 1,
      condition: filler,
      successCriteria: '',
      constraints: '',
      artifactPointers: [],
      pendingProposal: null,
      mode: 'normal',
      sessionID: SESSION,
      tokenBudget: null,
      maxTokens: 1000,
      maxTurns: 0,
      maxDurationMs: 0,
      minDelayMs: 0,
      noProgressTokenThreshold: 50,
      noProgressTurnsBeforePause: 3,
      noToolCallTurnsBeforePause: 3,
      turnCount: 0,
      totalTokens: 0,
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
      createdAt: 0,
      updatedAt: 0,
      startedAt: 0,
      pausedAt: 0,
      stoppedAt: 0,
      finishedAt: null,
      status: 'paused',
      stopReason: 'paused',
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
      attestationFaults: 0,
      maxUnchangedResults: 3,
      lastCandidate: null,
      lastFingerprint: null,
      blockedTurns: 0,
      maxBlockedTurns: 3,
      blockedAssertedThisTurn: false,
      languageTriage: true,
      lastStatus: '',
      lastAssistantText: filler,
      lastAssistantMessageID: '',
      lastCountedProgressMessageID: '',
      lastNoToolCallMessageID: '',
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
    } as unknown as SerializedGoal);
    written += filler.length * 2;
  }
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      goals,
      results: [],
      sessionOrdered: [SESSION],
      invalidatedGoalIds: [],
      pendingIntents: [],
      settlementReceipts: [],
      focusedGoalIds: [{sessionID: SESSION, goalId: 'g0'}],
    }),
  );
}

describe("a snapshot past the plugin's read ceiling", () => {
  test('is reported as unreadable rather than returned as an empty workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ceiling-'));
    try {
      const statePath = join(dir, 'sessions', SESSION, 'state.json');
      const ledgerPath = `${statePath}.ledger.jsonl`;
      await writeOverCeiling(statePath, 17 * 1024 * 1024);
      const size = (await stat(statePath)).size;
      expect(
        size,
        'the fixture did not cross the 16 MiB ceiling, so this case shows nothing',
      ).toBeGreaterThan(16 * 1024 * 1024);

      const recovered = await recoverState(statePath, ledgerPath);
      expect(
        recovered.snapshotOverCeiling,
        'a truncated read was reported as a whole snapshot',
      ).toBe(true);
      // And the ledger still speaks for what it can, because the point is to
      // protect the file rather than to refuse to work at all.
      expect(recovered.goals).toEqual([]);
      expect(
        recovered.sessionOrdered,
        'a field only the snapshot carried was reported as read',
      ).toEqual([]);

      // CONTROL: the same reader on a snapshot UNDER the ceiling reads it whole,
      // and says nothing went wrong. A guard that refused every large file would
      // satisfy the case above while breaking every real session.
      const small = join(dir, 'sessions', SESSION, 'small.json');
      await writeFile(
        small,
        JSON.stringify({
          version: 1,
          goals: [],
          results: [],
          sessionOrdered: [SESSION],
          invalidatedGoalIds: [],
          pendingIntents: [],
          settlementReceipts: [],
          focusedGoalIds: [],
        }),
      );
      const readSmall = await recoverState(small, ledgerPath);
      expect(readSmall.snapshotOverCeiling).toBe(false);
      expect(readSmall.sessionOrdered).toEqual([SESSION]);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }, 60_000);

  test('a CORRUPT snapshot is still recovered from the ledger and still writable', async () => {
    // The other half of the distinction, and the reason this is not simply "large
    // files are refused". A corrupt file has no recoverable content, so replacing
    // it with what the ledger says IS the repair — and a fix that fenced that too
    // would leave every workspace with one damaged file permanently unwritable.
    const dir = await mkdtemp(join(tmpdir(), 'ceiling-corrupt-'));
    try {
      const statePath = join(dir, 'sessions', SESSION, 'state.json');
      const ledgerPath = `${statePath}.ledger.jsonl`;
      const goal = createGoalState(
        SESSION,
        'a goal the ledger still knows about',
        {},
      );
      goal.revision = 1;
      goal.status = 'paused';
      goal.stopReason = 'paused';
      await mkdir(join(dir, 'sessions', SESSION), {recursive: true});
      await writeFile(statePath, '{ this is not json');
      await writeFile(
        ledgerPath,
        `${JSON.stringify({
          seq: 1,
          revision: 0,
          phase: 'committed',
          timestamp: 1,
          transition: {
            source: 'create_goal',
            goalId: goal.goalId,
            fromStatus: 'active',
            toStatus: 'paused',
            stopReason: 'paused',
            blockedReason: '',
            detail: '',
          },
          snapshot: goal,
        })}\n`,
      );
      const recovered = await recoverState(statePath, ledgerPath);
      expect(
        recovered.snapshotOverCeiling,
        'a corrupt file is not a file past the ceiling',
      ).toBe(false);
      expect(recovered.goals.map(g => g.goalId)).toEqual([goal.goalId]);
      // Writable, because the file it replaces holds nothing.
      expect(
        await writeStateFile(
          statePath,
          recovered.goals,
          [],
          [],
          [],
          [],
          [],
          [],
        ),
      ).toBe(true);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('the PLUGIN refuses to write over it, and says which file', async () => {
    // The end-to-end property, and the one that is not a comment: the ceiling is
    // only worth reporting if the consequence is that the file survives.
    const root = await mkdtemp(join(tmpdir(), 'ceiling-plugin-'));
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      const statePath = join(stateRoot, 'sessions', SESSION, 'state.json');
      await writeOverCeiling(statePath, 17 * 1024 * 1024);
      const before = (await stat(statePath)).size;

      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) =>
        void errors.push(args.map(String).join(' '));
      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        expect(
          errors.join('\n'),
          'the unreadable snapshot was not reported',
        ).toContain('read ceiling');
        expect(errors.join('\n')).toContain(SESSION);

        // A goal is still usable in memory — refusing to persist is not refusing
        // to work — and the file is untouched.
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: SESSION, arguments: 'objective'},
          output,
        );
        expect(output.parts.map(p => p.text).join('\n')).toContain('NOT SAVED');
        // …and it does NOT blame a process that does not exist. This is the claim
        // the line used to make unconditionally, and it is the reason the test
        // exists as well as the byte count.
        expect(output.parts.map(p => p.text).join('\n')).not.toContain(
          'another process owns it',
        );
      } finally {
        console.error = original;
        await hooks.dispose?.();
      }

      expect(
        (await stat(statePath)).size,
        'the plugin overwrote a file it had not read',
      ).toBe(before);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);

  test('the same holds for a snapshot that ARRIVES AFTER STARTUP', async () => {
    // The case above is the startup enumeration's, and it was the only one. A
    // session whose over-ceiling snapshot appears after the process loaded was
    // never fenced, and `writeStateFile` has no size check of its own — so the
    // first write replaced the one copy of that session's goals, results and
    // pending completion with a projection of live machines. Reproduced through
    // the real plugin at 18.1 MB: 18,058,703 bytes replaced by 3,135, the
    // pre-existing goal gone, "New active goal" reported, no ceiling line.
    const root = await mkdtemp(join(tmpdir(), 'ceiling-late-'));
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      const statePath = join(stateRoot, 'sessions', SESSION, 'state.json');
      const prompts: string[] = [];
      // EMPTY when the plugin loads — the ordinary shape for a session that has
      // not run a goal yet.
      const hooks = await GoalsPlugin(
        {
          directory: root,
          client: {
            app: {
              log: async () => {},
            },
            session: {
              messages: async () => ({
                data: [
                  {
                    id: 'm1',
                    info: {
                      role: 'assistant',
                      time: {completed: 1},
                      finish: 'stop',
                    },
                    parts: [],
                  },
                ],
              }),
              promptAsync: async (sid: string) => {
                prompts.push(sid);
                return {};
              },
            },
          },
        },
        {idlePoller: false, registerAgents: false},
      );
      const status = async (): Promise<string> => {
        const out: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: SESSION, arguments: 'status'},
          out,
        );
        return out.parts.map(p => p.text).join('\n');
      };
      try {
        await writeOverCeiling(statePath, 17 * 1024 * 1024);
        const before = await readFile(statePath, 'utf8');

        const errors: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) =>
          void errors.push(args.map(String).join(' '));
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        try {
          await hooks['command.execute.before']!(
            {command: 'goal', sessionID: SESSION, arguments: 'objective'},
            output,
          );
        } finally {
          console.error = original;
        }
        const said = output.parts.map(p => p.text).join('\n');
        expect(
          errors.join('\n'),
          'the unreadable snapshot was not reported',
        ).toContain('read ceiling');
        expect(said).toContain('NOT SAVED');
        expect(
          said,
          'a goal was reported created over a snapshot this host cannot read',
        ).not.toContain('New active goal');
        expect(
          await readFile(statePath, 'utf8'),
          'the plugin overwrote a file it had not read',
        ).toBe(before);

        // AND IT STOPS BEING DRIVEN, the second of a refusal's two obligations.
        // The refused goal is live in memory — the NOT SAVED line says so — so
        // without the drive gate the loop keeps prompting it and charging it
        // tokens that can never be persisted.
        const brakesBefore = (await status())
          .split('\n')
          .find(l => l.includes('Brakes:'));
        await hooks.event?.({
          type: 'message.updated',
          sessionID: SESSION,
          properties: {
            info: {
              role: 'assistant',
              id: 'm-usage',
              tokens: {total: 5000, input: 1000, output: 4000},
            },
          },
        } as never);
        // NO WAIT after the idle, and that is deliberate. `await hooks.event(...)` resolves
        // when the handler has finished, so a timer here would be a guess about scheduling
        // that also risked a FALSE PASS: a prompt arriving after the assertion would leave
        // the test green over the very defect it names. MEASURED — with this line removed
        // the test still fails on a fenced session that was prompted, so nothing was lost.
        await hooks.event?.({
          type: 'session.idle',
          sessionID: SESSION,
          id: 'fenced-idle',
        } as never);
        expect(
          prompts,
          'a fenced session was prompted a continuation it can never persist',
        ).toEqual([]);
        expect(
          (await status()).split('\n').find(l => l.includes('Brakes:')),
          'a fenced session kept being driven: turns advanced and tokens were charged',
        ).toBe(brakesBefore);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);

  test('the fence is PER SESSION: an unreadable file in one session does not deny another', async () => {
    // THE SCOPE OF THE FENCE, which is the half the case above does not reach. The
    // ceiling guard set a WORKSPACE-wide flag, so one oversized snapshot cost every
    // other session its writes: a session with no file of its own was told its goal
    // could not be saved, and nothing was written for it. That is the same defect
    // `cf0968f` had already fixed for a containment refusal, reintroduced three
    // commits later by the guard added for the ceiling.
    //
    // It matters because the sessions are independent in every other respect: they
    // hold different files, different leases and different counters, which is the
    // whole point of the layout. One unreadable file is a fact about one file.
    const root = await mkdtemp(join(tmpdir(), 'ceiling-scoped-'));
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      const statePath = join(stateRoot, 'sessions', SESSION, 'state.json');
      await writeOverCeiling(statePath, 17 * 1024 * 1024);
      const before = createHash('sha256')
        .update(await readFile(statePath))
        .digest('hex');

      const original = console.error;
      console.error = () => {};
      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: OTHER, arguments: 'an ordinary goal'},
          output,
        );
        const said = output.parts.map(p => p.text).join('\n');
        expect(
          said,
          "one session's unreadable file denied an unrelated session its writes",
        ).toContain('New active goal');
        expect(
          said,
          'a session with nothing wrong with it was told nothing was saved',
        ).not.toContain('NOT SAVED');

        // …and "saved" means on disk, which is the claim the message makes.
        const otherPath = join(stateRoot, 'sessions', OTHER, 'state.json');
        const written = await readFile(otherPath, 'utf8').catch(() => '');
        expect(written, "the other session's file was never written").toContain(
          'an ordinary goal',
        );

        // TWICE, because one successful write and a permanently-broken writer are
        // indistinguishable above. The fence is consulted on every persist, so a
        // session cleared once could still be denied the next time.
        const again: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {
            command: 'goal',
            sessionID: OTHER,
            arguments: 'a second ordinary goal',
          },
          again,
        );
        expect(
          again.parts.map(p => p.text).join('\n'),
          'the second write for a healthy session was refused',
        ).not.toContain('NOT SAVED');
        const grown = await readFile(otherPath, 'utf8').catch(() => '');
        expect(
          grown,
          'the second goal was not written, so the first write was a one-off',
        ).toContain('a second ordinary goal');

        // CONTROL, IN THE OTHER DIRECTION: the session whose file is past the
        // ceiling is STILL fenced. A fix that dropped the fence would satisfy
        // everything above, so the two properties are asserted together.
        const fenced: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: SESSION, arguments: 'objective'},
          fenced,
        );
        expect(
          fenced.parts.map(p => p.text).join('\n'),
          'the fence was dropped for the file it exists for',
        ).toContain('NOT SAVED');
      } finally {
        console.error = original;
        await hooks.dispose?.();
      }

      // By CONTENT, not only by length: a rewrite to the same byte count would
      // satisfy a size comparison, and the file is the only copy of its fields.
      const after = await readFile(statePath);
      expect(
        createHash('sha256').update(after).digest('hex'),
        'the plugin overwrote a file it had not read',
      ).toBe(before);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);
});
