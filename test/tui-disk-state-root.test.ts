// tui-disk-state-root.test.ts — the companion must read where the plugin WRITES.
//
// `discoverStateFiles` joined `DEFAULT_STATE_ROOT` unconditionally, so the
// companion and the server plugin disagreed about where state lives for every
// workspace that configured a root: the plugin wrote to `stateRoot` /
// `FIXATE_ON_STATE_ROOT` and the companion read `<cwd>/.opencode/goals`, found
// nothing, and reported a workspace with goals as having none. It reported it
// CONFIDENTLY, which is the aggravating part — `stateDirMissing` is the flag that
// exists to make a quiet read loud.
//
// The second half is the same class from the other direction. `parseStateFileGoals`
// attributed a snapshot to whatever session the record named, with no comparison
// against the directory the file was read from — while the plugin makes exactly
// that comparison at startup. So the reader was the more trusting of the two, and
// with's cross-session attribution in place it would faithfully report a
// lie: a hand-edited record naming another session appeared in the store under
// that session's key and was rendered as that session's goal.
//
// The last test here is the one that matters most: it is the shape four separate
// companion fixtures were building, and they all passed while doing it.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTuiStateStore, type GoalTuiSnapshot} from '../src/tui-state.ts';
import {
  discoverStateFiles,
  hydrateStoreFromDisk,
  parseStateFileGoals,
  readDiskGoalSnapshots,
  resolveStateRoot,
} from '../src/tui-disk-state.ts';

function goalIn(sessionID: string, goalId: string): Record<string, unknown> {
  return {
    goalId,
    runId: 'r1',
    revision: 1,
    condition: `work owned by ${sessionID}`,
    status: 'paused',
    stopReason: 'paused',
    sessionID,
    turnCount: 1,
    totalTokens: 0,
    maxTokens: 0,
    maxTurns: 0,
    history: [],
  };
}

/** A per-session state file, written the way the plugin writes it. */
async function writeSession(
  directory: string,
  root: string[],
  sessionID: string,
  goals: Array<Record<string, unknown>>,
): Promise<void> {
  const dir = join(directory, ...root, 'sessions', sessionID);
  await mkdir(dir, {recursive: true});
  await writeFile(
    join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      goals,
      results: [],
      sessionOrdered: [],
      invalidatedGoalIds: [],
      pendingIntents: [],
      settlementReceipts: [],
      focusedGoalIds: [],
    }),
    'utf8',
  );
}

describe('the companion resolves the state root the way the plugin does', () => {
  test('the precedence is option, then FIXATE_ON_STATE_ROOT, then the default', async () => {
    const previous = process.env.FIXATE_ON_STATE_ROOT;
    try {
      delete process.env.FIXATE_ON_STATE_ROOT;
      // No option and no env: the default, under the workspace.
      expect(resolveStateRoot('/ws')).toBe('/ws/.opencode/goals');
      // The option wins over the default.
      expect(resolveStateRoot('/ws', 'custom/root')).toBe('/ws/custom/root');
      // An absolute option is absolute.
      expect(resolveStateRoot('/ws', '/elsewhere/state')).toBe(
        '/elsewhere/state',
      );
      // The env var applies when there is no option — this is the WORKSPACE-wide
      // mechanism both plugin entries can see, which is why it is the one a
      // consumer should reach for when they set a root.
      process.env.FIXATE_ON_STATE_ROOT = 'from/env';
      expect(resolveStateRoot('/ws')).toBe('/ws/from/env');
      // And the option still wins over the env var.
      expect(resolveStateRoot('/ws', 'custom/root')).toBe('/ws/custom/root');
    } finally {
      if (previous === undefined) delete process.env.FIXATE_ON_STATE_ROOT;
      else process.env.FIXATE_ON_STATE_ROOT = previous;
    }
  });

  test('a workspace whose goals live under a CONFIGURED root is discovered and hydrated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixate-on-root-opt-'));
    const previous = process.env.FIXATE_ON_STATE_ROOT;
    try {
      delete process.env.FIXATE_ON_STATE_ROOT;
      // A decoy in the DEFAULT root, so "found something" cannot be satisfied by
      // reading the wrong place.
      await writeSession(dir, ['.opencode', 'goals'], 'ses_decoy', [
        goalIn('ses_decoy', 'g-decoy'),
      ]);
      await writeSession(dir, ['configured', 'state'], 'ses_real', [
        goalIn('ses_real', 'g-real'),
      ]);

      // The option alone.
      const viaOption = await discoverStateFiles(
        dir,
        undefined,
        join('configured', 'state'),
      );
      expect(
        viaOption.map(p => p.split('/').slice(-2).join('/')),
        'the configured root, not the default',
      ).toEqual(['ses_real/state.json']);

      const store = createTuiStateStore();
      const hydrated = await hydrateStoreFromDisk(
        store,
        dir,
        undefined,
        join('configured', 'state'),
      );
      const ids = store
        .getAllSnapshots()
        .map((s: GoalTuiSnapshot) => s.goalId)
        .sort();
      console.log(
        `STATE-ROOT option ${JSON.stringify({hydrated: hydrated.hydratedCount, ids})}`,
      );
      expect(
        hydrated.hydratedCount,
        'the companion must hydrate the CONFIGURED root',
      ).toBe(1);
      expect(ids).toEqual(['g-real']);

      // And the environment variable, which is the other documented mechanism.
      process.env.FIXATE_ON_STATE_ROOT = join('configured', 'state');
      const viaEnv = await readDiskGoalSnapshots(dir);
      console.log(
        `STATE-ROOT env ${JSON.stringify({
          filesRead: viaEnv.filesRead,
          ids: viaEnv.snapshots.map(s => s.goalId),
        })}`,
      );
      expect(
        viaEnv.snapshots.map(s => s.goalId),
        'FIXATE_ON_STATE_ROOT must be honoured too',
      ).toEqual(['g-real']);
      expect(
        viaEnv.stateDirMissing,
        'and the root it resolved must not read as missing',
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.FIXATE_ON_STATE_ROOT;
      else process.env.FIXATE_ON_STATE_ROOT = previous;
      await rm(dir, {recursive: true, force: true});
    }
  }, 30_000);

  // `stateDirMissing` IS DECIDED AGAINST THE RESOLVED ROOT, and the assertion
  // above did not hold it. That test writes a DECOY into the default root, so the
  // flag came out false for the wrong reason — it was reporting the decoy's
  // directory, not the configured one. Deleting the decoy flips it, which is the
  // same fixture-primes-what-it-measures defect this file already records twice,
  // in a gate added to catch a different one.
  //
  // No default root exists here at all, so the only directory the flag can be
  // describing is the CONFIGURED one. Both callers read this as "this workspace
  // has no state at all": a companion whose first tick happened during the window
  // before a session's state file lands would baseline as empty, and the next
  // good tick would announce every running goal as a fresh "Goal started" — the
  // moment `tui-companion-refresh.ts` exists to prevent. The ledger-first write
  // order in `storageLayout` makes that window real rather than theoretical.
  test('stateDirMissing is decided against the CONFIGURED root, with no default root present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixate-on-root-flag-'));
    const previous = process.env.FIXATE_ON_STATE_ROOT;
    try {
      delete process.env.FIXATE_ON_STATE_ROOT;
      await writeSession(dir, ['configured', 'state'], 'ses_real', [
        goalIn('ses_real', 'g-real'),
      ]);

      // The control: the default root really is absent, so a flag derived from it
      // would be true here.
      await expect(
        stat(join(dir, '.opencode', 'goals', 'sessions')).then(
          () => true,
          () => false,
        ),
        'the fixture must have no default root at all, or this test measures nothing',
      ).resolves.toBe(false);

      const read = await readDiskGoalSnapshots(
        dir,
        undefined,
        join('configured', 'state'),
      );
      console.log(
        `STATE-DIR-FLAG ${JSON.stringify({
          filesRead: read.filesRead,
          ids: read.snapshots.map(s => s.goalId),
          stateDirMissing: read.stateDirMissing,
        })}`,
      );
      expect(
        read.stateDirMissing,
        'the configured root HAS a sessions directory',
      ).toBe(false);
      expect(read.filesRead).toBe(1);

      // And the converse, so the flag is not simply hard-wired false: a workspace
      // with no state anywhere must still report the directory missing, or every
      // torn read becomes indistinguishable from an empty workspace.
      const empty = await readDiskGoalSnapshots(
        dir,
        undefined,
        join('nowhere', 'at', 'all'),
      );
      expect(
        empty.stateDirMissing,
        'a root that does not exist IS missing',
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.FIXATE_ON_STATE_ROOT;
      else process.env.FIXATE_ON_STATE_ROOT = previous;
      await rm(dir, {recursive: true, force: true});
    }
  }, 30_000);
});

describe('a record naming a different session than its own directory is refused', () => {
  test("the reader drops it, and the plugin's own session's goals are unaffected", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixate-on-reader-trust-'));
    const previous = process.env.FIXATE_ON_STATE_ROOT;
    try {
      delete process.env.FIXATE_ON_STATE_ROOT;
      // The attacker's file holds a record naming the victim. The victim's file
      // holds the victim's own goal.
      await writeSession(dir, ['.opencode', 'goals'], 'ses_aaa_attacker', [
        goalIn('ses_zzz_victim', 'g-injected'),
      ]);
      await writeSession(dir, ['.opencode', 'goals'], 'ses_zzz_victim', [
        goalIn('ses_zzz_victim', 'g-own'),
      ]);

      const read = await readDiskGoalSnapshots(dir);
      const bySession = Object.fromEntries(
        read.snapshots.map(s => [s.sessionID, s.goalId]),
      );
      console.log(`READER-TRUST ${JSON.stringify(bySession)}`);
      expect(
        Object.values(bySession),
        'a record whose own session names another session must not be attributed to it',
      ).not.toContain('g-injected');
      expect(
        bySession['ses_zzz_victim'],
        "and the real owner's goal is still read",
      ).toBe('g-own');

      // Asserted directly on the parser too, because that is where the rule
      // lives and the callers pass the directory in.
      const content = JSON.stringify({goals: [goalIn('ses_other', 'g-x')]});
      expect(
        parseStateFileGoals(content, 'ses_owner'),
        'the parser refuses it when told the origin',
      ).toEqual([]);
      expect(
        parseStateFileGoals(content).length,
        'and with no origin to compare against it still parses — the guard needs the directory, not a guess',
      ).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.FIXATE_ON_STATE_ROOT;
      else process.env.FIXATE_ON_STATE_ROOT = previous;
      await rm(dir, {recursive: true, force: true});
    }
  }, 30_000);
});
