// wal-read-ceiling.test.ts — an over-ceiling LEDGER generation is a PARTIAL READ,
// and the part that goes missing is the newest one.
//
// The snapshot's identical bound is detected, reported and fenced. The ledger's
// was not: `readWalGeneration` destructured `({ text } =...)` and threw away the
// `truncated` flag its sibling caller keeps, so a generation past 16 MiB came
// back as a silent prefix. A prefix of an append-only ledger is its OLDEST
// entries, and replay is last-wins — so the entries recovery needs most are
// exactly the ones that were dropped.
//
// Measured on the tree before this fix, 1201 entries in 19.6 MiB:
//
// entries on disk 1201
// entries the reader saw 946
// max seq seen 946 (true max on disk: 1201)
// removal tombstone invisible
// counter after seeding 946 next allocation 947 — already on disk
// recovered goals ["g_victim"] invalidatedGoalIds []
//
// Two harms, and both are recorded in the project as invariants this design rests
// on. A CLEARED GOAL RESURRECTS, because its tombstone is the entry at the end. And
// the per-ledger sequence counter — the whole defence against two processes
// writing one ledger — is seeded from a view that is missing its maximum.
//
// Every case has a control that must behave differently, because a gate whose
// control also fails is asserting the fixture rather than the rule.

import {describe, expect, test} from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  initWalSeqFromLedger,
  peekWalSeq,
  readWalEntries,
  recoverState,
} from '../src/persistence-wal.ts';
import {GoalsPlugin} from '../src/plugin.ts';
import {createGoalState} from '../src/state-machine.ts';
import type {SerializedGoal} from '../src/persistence.ts';

const SESSION = 'ses_walceiling';
/** An ordinary second session in the same workspace, with nothing wrong with it. */
const OTHER = 'ses_walother';
const VICTIM = 'g_victim';

/**
 * A ledger over the ceiling, with the REMOVAL last.
 *
 * Written as raw JSONL rather than through `appendWalEntry`, deliberately: the
 * property under test is the reader's reaction to `info.size > ceiling`, and
 * seeding through the product would advance the very counter this test is about.
 * Every entry is a real committed entry with a real snapshot, and the tombstone is
 * genuinely the last line — which is where a prefix stops.
 */
async function writeOverCeilingLedger(
  ledgerPath: string,
  bytes: number,
  options: {leadingEntries?: number; removalLast?: boolean} = {},
): Promise<{entries: number; lastSeq: number}> {
  await mkdir(join(ledgerPath, '..'), {recursive: true});
  const goal = createGoalState(SESSION, 'a goal the ledger knows about', {});
  goal.revision = 1;
  goal.status = 'paused';
  goal.stopReason = 'paused';
  const filler = 'x'.repeat(16_000);
  const snapshot = {
    ...goal,
    goalId: VICTIM,
    lastAssistantText: filler,
    condition: filler,
  } as unknown as SerializedGoal;
  const lines: string[] = [];
  let written = 0;
  let seq = 0;
  const emit = (
    transition: Record<string, unknown>,
    snap: SerializedGoal | null,
    removed?: boolean,
  ) => {
    seq += 1;
    lines.push(
      `${JSON.stringify({
        seq,
        revision: 1,
        phase: 'committed',
        timestamp: seq,
        transition,
        ...(snap ? {snapshot: snap} : {}),
        ...(removed ? {removed: true} : {}),
      })}\n`,
    );
  };
  // Filler entries that carry no goal of their own, purely to reach the ceiling the
  // way a long-lived session does. `create_goal` on a throwaway id is the shape a
  // real history has.
  // Every filler entry addresses the SAME goal, so the recovered state holds one
  // goal rather than five hundred: the property under test is which entries the
  // reader can SEE, and distinct filler ids would bury the victim in noise.
  while (written < bytes) {
    emit(
      {
        source: 'chat-message',
        goalId: VICTIM,
        fromStatus: 'paused',
        toStatus: 'paused',
        stopReason: 'paused',
        blockedReason: '',
        detail: '',
      },
      snapshot,
    );
    written += filler.length + 400;
  }
  if (options.removalLast !== false) {
    emit(
      {
        source: 'remove_goal',
        goalId: VICTIM,
        fromStatus: 'paused',
        toStatus: 'removed',
        stopReason: '',
        blockedReason: '',
        detail: '',
      },
      null,
      true,
    );
  }
  await writeFile(ledgerPath, lines.join(''));
  return {entries: lines.length, lastSeq: seq};
}

/** A ledger of the same SHAPE but under the ceiling, so the control differs only in size. */
async function writeSmallLedger(
  ledgerPath: string,
  fillerEntries: number,
): Promise<{
  entries: number;
  lastSeq: number;
}> {
  return writeOverCeilingLedger(ledgerPath, fillerEntries * 1000, {
    removalLast: true,
  });
}

describe('a ledger generation past the read ceiling', () => {
  test('is REPORTED as partly read, and the part it drops is the newest one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'walceiling-'));
    try {
      const statePath = join(dir, 'sessions', SESSION, 'state.json');
      const ledgerPath = `${statePath}.ledger.jsonl`;
      const onDisk = await writeOverCeilingLedger(ledgerPath, 17 * 1024 * 1024);
      expect(
        (await stat(ledgerPath)).size,
        'the fixture did not cross the 16 MiB ceiling, so this case shows nothing',
      ).toBeGreaterThan(16 * 1024 * 1024);
      // The snapshot still names the victim live, which is what a tombstone has to
      // beat — so a reader that cannot see the tombstone reports it as live.
      await writeFile(
        statePath,
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

      const entries = await readWalEntries(ledgerPath);
      const maxSeen = entries.reduce((m, e) => Math.max(m, e.seq), 0);
      expect(
        entries.length,
        'the whole ledger was read, so there is nothing to report',
      ).toBeLessThan(onDisk.entries);
      expect(
        maxSeen,
        'a prefix of an append-only ledger should keep the OLDEST entries',
      ).toBeLessThan(onDisk.lastSeq);

      const recovered = await recoverState(statePath, ledgerPath);
      expect(
        recovered.ledgerOverCeiling,
        'a partial read was reported as a whole ledger',
      ).toBe(true);
      expect(
        recovered.snapshotOverCeiling,
        'this case is about the ledger',
      ).toBe(false);
      // THE HARM, stated as the property rather than as the mechanism: the removal
      // is beyond the prefix, so the recovered state says the goal is live.
      expect(
        recovered.goals.map(g => g.goalId),
        'a cleared goal came back',
      ).toContain(VICTIM);
      expect(
        recovered.invalidatedGoalIds,
        'the removal was read after all',
      ).not.toContain(VICTIM);

      // CONTROL: the same shape UNDER the ceiling reads whole, says nothing went
      // wrong, and does see the removal. A reader that refused every large ledger
      // would satisfy the case above while breaking every real session.
      const small = `${statePath}.small.ledger.jsonl`;
      const smallOnDisk = await writeSmallLedger(small, 5);
      const smallRecovered = await recoverState(statePath, small);
      expect(
        smallRecovered.ledgerOverCeiling,
        'a small ledger was called over the ceiling',
      ).toBe(false);
      expect(
        smallRecovered.goals.map(g => g.goalId),
        'the whole ledger was read and the removal still applies',
      ).not.toContain(VICTIM);
      expect((await readWalEntries(small)).length).toBe(smallOnDisk.entries);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }, 120_000);

  test('does not SEED the sequence counter, because a prefix is not a maximum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'walceiling-seq-'));
    try {
      const overLedger = join(dir, 'over', 'state.json.ledger.jsonl');
      const onDisk = await writeOverCeilingLedger(overLedger, 17 * 1024 * 1024);
      await initWalSeqFromLedger(overLedger);
      // Nothing is seeded, so the counter cannot be below the ledger's true maximum
      // AND above it at the same time. Asserted against the number the ledger holds,
      // not against a constant, because a constant would survive a fix that seeds a
      // different wrong value.
      expect(
        peekWalSeq(overLedger),
        'a partial view of a ledger seeded its counter',
      ).toBe(0);
      expect(
        onDisk.entries,
        'the fixture needs enough entries that some fall beyond the prefix',
      ).toBeGreaterThan(400);

      // CONTROL: the same call on a whole ledger DOES seed, to exactly its maximum.
      // Without this the case above would also pass if seeding were simply deleted.
      const wholeLedger = join(dir, 'whole', 'state.json.ledger.jsonl');
      const whole = await writeSmallLedger(wholeLedger, 5);
      await initWalSeqFromLedger(wholeLedger);
      expect(
        peekWalSeq(wholeLedger),
        'seeding a whole ledger stopped working',
      ).toBe(whole.lastSeq);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  }, 120_000);

  // THE FENCE AT THE WRITE, which the startup enumeration cannot install: a session
  // that appears after the process loaded was never enumerated, so the counter
  // refused to seed with nothing telling anyone. The 17.8 MiB / 6749-entry
  // reproduction below is through the real plugin with a ledger built entry by
  // entry; the fixture this test builds is 17 MiB of larger entries, and it
  // crosses the same 16 MiB ceiling.
  test('a session that ARRIVES AFTER STARTUP with an over-ceiling ledger is fenced, not just unseeded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'walceiling-late-'));
    try {
      const stateRoot = join(dir, 'goals');
      const paths = join(stateRoot, 'sessions', SESSION);
      const prompts: string[] = [];
      // The workspace is EMPTY when the plugin loads — the ordinary shape for a session
      // that has not run a goal yet — and the over-ceiling ledger appears afterwards.
      const hooks = await GoalsPlugin(
        {
          directory: dir,
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
              // A host that ANSWERS. A refused host that never got an answer would stop
              // after one attempt and look healthy — the shape the drive worker exists for.
              promptAsync: async (sid: string) => {
                prompts.push(sid);
                return {};
              },
            },
          },
        },
        {stateRoot, idlePoller: false, registerAgents: false},
      );
      const ledgerPath = `${paths}/state.json.ledger.jsonl`;
      const status = async (): Promise<string> => {
        const out: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: SESSION, arguments: 'status'},
          out,
        );
        return out.parts.map(p => p.text).join('\n');
      };
      try {
        await mkdir(paths, {recursive: true});
        const onDisk = await writeOverCeilingLedger(
          ledgerPath,
          17 * 1024 * 1024,
        );
        expect(
          (await stat(ledgerPath)).size,
          'the fixture did not cross the ceiling',
        ).toBeGreaterThan(16 * 1024 * 1024);

        const errors: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) =>
          void errors.push(args.join(' '));
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        try {
          await hooks['command.execute.before']!(
            {
              command: 'goal',
              sessionID: SESSION,
              arguments: 'a goal in a late session',
            },
            output,
          );
        } finally {
          console.error = original;
        }
        const said = output.parts.map(p => p.text).join('\n');

        // The counter must not be seeded from a partial view…
        expect(
          peekWalSeq(ledgerPath),
          'a partial view seeded the counter for a session that arrived after startup',
        ).toBe(0);
        // …and, because an unseeded counter with nothing fencing it is how a LOW number
        // gets issued, the write must be refused and REPORTED rather than silently skipped.
        expect(
          said,
          'a goal was reported created in a session whose ledger could not be read',
        ).toContain('NOT SAVED');
        expect(
          errors.join('\n'),
          'the refusal reached nobody: the log is the only channel that names the cause',
        ).toContain("ledger is larger than the plugin's read ceiling");
        // The ledger's own history is untouched: a fence that repaired or truncated would
        // be a different and much worse answer than declining.
        const after = (await readFile(ledgerPath, 'utf8'))
          .split('\n')
          .filter(l => l.trim()).length;
        expect(after, "the fenced session's ledger was rewritten anyway").toBe(
          onDisk.entries,
        );

        // AND IT STOPS BEING DRIVEN. Refusing to WRITE is one of a refusal's two
        // obligations; the other is to stop ACTING on a session whose every write is
        // declined. The refused goal is live in memory — the NOT SAVED line says so —
        // so without the drive gate the loop kept prompting it and charging it tokens
        // that went nowhere. Measured on this tree without `unreadableSessions.add`:
        // one continuation prompt and 5,000 charged tokens on a goal whose turn count
        // and token total were both unreachable from disk.
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
      await rm(dir, {recursive: true, force: true});
    }
  }, 180_000);

  test('the PLUGIN does not let a half-read ledger become the new durable truth', async () => {
    // End to end, through the surface a user meets. A session whose ledger is only
    // partly read must not have its state file rewritten from that partial view —
    // which is what turns a transient blind spot into a cleared goal that is
    // permanently, silently back — and must not have a sequence number issued from
    // it either.
    const root = await mkdtemp(join(tmpdir(), 'walceiling-plugin-'));
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      const statePath = join(stateRoot, 'sessions', SESSION, 'state.json');
      const ledgerPath = `${statePath}.ledger.jsonl`;
      await writeOverCeilingLedger(ledgerPath, 17 * 1024 * 1024);
      await writeFile(
        statePath,
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
      const snapshotBefore = await readFile(statePath, 'utf8');
      const ledgerBefore = (await stat(ledgerPath)).size;

      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) =>
        void errors.push(args.map(String).join(' '));
      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        expect(
          errors.join('\n'),
          'the partly-read ledger was not reported',
        ).toContain('ledger is larger than');
        expect(errors.join('\n')).toContain(SESSION);

        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: SESSION, arguments: 'objective'},
          output,
        );
        const said = output.parts.map(p => p.text).join('\n');
        expect(
          said,
          'a goal was reported as created over a ledger this host cannot read',
        ).toContain('NOT SAVED');
        // …and it does not blame a process that does not exist, which is the same
        // claim the snapshot's line was corrected for.
        expect(said).not.toContain('another process owns it');

        // CONTROL, IN THE OTHER DIRECTION: an unrelated, perfectly healthy session in
        // the same workspace still saves. A per-session fact must stay per-session,
        // which `cf0968f` fixed for a containment refusal and for the
        // snapshot fence; this is the third instance of the shape.
        const other: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {
            command: 'goal',
            sessionID: OTHER,
            arguments: 'an ordinary goal',
          },
          other,
        );
        const otherSaid = other.parts.map(p => p.text).join('\n');
        expect(
          otherSaid,
          "one session's unreadable ledger denied an unrelated session its writes",
        ).toContain('New active goal');
        expect(otherSaid).not.toContain('NOT SAVED');
        expect(
          await readFile(
            join(stateRoot, 'sessions', OTHER, 'state.json'),
            'utf8',
          ).catch(() => ''),
        ).toContain('an ordinary goal');
      } finally {
        console.error = original;
        await hooks.dispose?.();
      }

      // Nothing was written over either file. A rewrite here is the permanent harm:
      // the partial view becomes the truth and the real history is unreachable.
      expect(
        await readFile(statePath, 'utf8'),
        'the snapshot was rewritten from a half-read ledger',
      ).toBe(snapshotBefore);
      expect(
        (await stat(ledgerPath)).size,
        'an entry was appended to a ledger this host cannot read',
      ).toBe(ledgerBefore);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 180_000);

  test('REACHABLE UNDER THE DEFAULTS: rotation cannot shrink a ledger it cannot unlink, and the appends continue', async () => {
    // The comment that called this a backstop said rotation keeps the default
    // ledger at 2 MiB x 3 generations. That holds only while rotation SUCCEEDS.
    // Two halves, both asserted here because both are needed:
    //
    // 1. `rotateLedgerIfNeeded` does not shrink the active generation when a
    // rotated one cannot be deleted — it REJECTS, and the caller logs and
    // carries on (src/session-state-manager.ts), because the entry is already
    // durable. So the ledger keeps every entry and nothing bounds it.
    // 2. Nothing in that path is surfaced to the user; it is a log line on a
    // channel nobody is reading, which is why this went unnoticed.
    //
    // The reviewer's measurement of the assembled shape — default 2 MiB x 3, a
    // rotated generation that cannot be deleted, 120 appends — reached 23.1 MiB.
    // Asserting a byte count here would be a claim about filler sizes that drifts
    // with the shape of a goal, so the two mechanisms are asserted instead and the
    // size is left to follow from them.
    const {SessionStateManager, createRuntimeState, DEFAULT_GOAL_OPTIONS} =
      await import('../src/session-state-manager.ts');
    const {rotateLedgerIfNeeded} = await import('../src/persistence-wal.ts');
    const root = await mkdtemp(join(tmpdir(), 'walceiling-rotate-'));
    try {
      const stateRoot = join(root, 'goals');
      const ledgerPath = join(
        stateRoot,
        'sessions',
        SESSION,
        'state.json.ledger.jsonl',
      );
      await mkdir(join(stateRoot, 'sessions', SESSION), {recursive: true});
      // The blocker: rotation must delete the oldest generation first, and a
      // directory where a file belongs cannot be unlinked.
      await mkdir(`${ledgerPath}.3`);
      await writeFile(ledgerPath, '{"seq":1}\n');

      let rejected = false;
      try {
        await rotateLedgerIfNeeded(ledgerPath, 1, 3);
      } catch {
        rejected = true;
      }
      expect(
        rejected,
        'rotation reported success while unable to delete a generation',
      ).toBe(true);
      expect(
        (await stat(ledgerPath)).size,
        'the blocked rotation truncated the active generation anyway',
      ).toBeGreaterThan(0);

      // …and the appends go on regardless, which is what makes the growth unbounded
      // rather than a failed write the user would notice.
      const logged: string[] = [];
      const runtime = createRuntimeState();
      const manager = new SessionStateManager(
        runtime,
        async () => true,
        stateRoot,
        undefined,
        new Map(),
        async () => true,
        1,
        3,
        undefined,
        undefined,
        DEFAULT_GOAL_OPTIONS,
        async (message: string) => void logged.push(message),
      );
      const initial = (await readFile(ledgerPath, 'utf8'))
        .split('\n')
        .filter(l => l.trim()).length;
      const machine = manager.createGoal(
        SESSION,
        'a goal that outlives its ledger',
        {},
      );
      await manager.removeGoal(SESSION, machine.state.goalId, 'update_goal');
      const after = (await readFile(ledgerPath, 'utf8'))
        .split('\n')
        .filter(l => l.trim()).length;
      expect(
        after,
        'nothing was appended, so the growth premise is unproven',
      ).toBeGreaterThan(initial);
      // …and the failure that made the growth unbounded is a LOG LINE, on the channel
      // nothing reads. Measured: `WAL rotation failed after durable append: EPERM …
      // unlink …state.json.ledger.jsonl.3`, while the entry it followed stayed durable.
      expect(
        logged.join('\n'),
        'the blocked rotation was not reported at all',
      ).toContain('rotation failed');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);

  // THE SECOND ROUTE, and the simpler one. `rotateLedgerIfNeeded` returns immediately when
  // `maxBytes <= 0`, so `ledgerMaxBytes: 0` disables rotation outright: no filesystem
  // blocker, no swallowed error, no log line to notice — the ledger simply grows forever,
  // and a workspace left on one session crosses the 16 MiB read ceiling without anyone
  // configuring anything unusual or anything failing at all.
  //
  // It is here because the acceptance named BOTH routes, and asserting only the awkward
  // one would have left the easy one unproven. The consequence is the same and is asserted
  // identically: the reader reports the partial read rather than treating the prefix as
  // the whole history.
  test('REACHABLE BY CONFIGURATION ALONE: `ledgerMaxBytes: 0` disables rotation, and nothing else bounds the ledger', async () => {
    const {rotateLedgerIfNeeded} = await import('../src/persistence-wal.ts');
    const root = await mkdtemp(join(tmpdir(), 'walceiling-norotate-'));
    try {
      const stateRoot = join(root, 'goals');
      const ledgerPath = join(
        stateRoot,
        'sessions',
        SESSION,
        'state.json.ledger.jsonl',
      );
      const statePath = join(stateRoot, 'sessions', SESSION, 'state.json');
      await mkdir(join(stateRoot, 'sessions', SESSION), {recursive: true});
      await writeFile(ledgerPath, '{"seq":1}\n');

      // Rotation is inert at 0 — asserted directly, because "nothing bounds the ledger" is
      // only true if this returns without acting, and a future change that treated 0 as
      // "unlimited, use the default" would still leave every assertion below passing.
      const before = await stat(ledgerPath);
      await rotateLedgerIfNeeded(ledgerPath, 0, 3);
      const afterZero = await stat(ledgerPath);
      expect(
        afterZero.size,
        '`ledgerMaxBytes: 0` rotated the ledger instead of disabling rotation, so the growth premise is unproven',
      ).toBe(before.size);
      expect(
        await readdir(join(stateRoot, 'sessions', SESSION)),
        '`ledgerMaxBytes: 0` produced a rotated generation',
      ).toEqual(['state.json.ledger.jsonl']);

      // Now let it actually grow past the ceiling, with no blocker and no failure.
      await writeOverCeilingLedger(ledgerPath, 17 * 1024 * 1024);
      expect((await stat(ledgerPath)).size).toBeGreaterThan(16 * 1024 * 1024);

      const recovered = await recoverState(statePath, ledgerPath);
      expect(
        recovered.ledgerOverCeiling,
        'a ledger that grew past the ceiling with nothing failing was read as a whole history',
      ).toBe(true);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);
});
