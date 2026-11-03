import {afterEach, beforeEach, describe, expect, it} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTuiStateStore} from '../src/tui-state.ts';
import {
  discoverStateFiles,
  hydrateStoreFromDisk,
  readDiskGoalSnapshots,
} from '../src/tui-disk-state.ts';

// A TUI companion reads `<stateRoot>/sessions/<sessionID>/state.json`, one file
// per session, and ENUMERATES them rather than probing a list of candidate
// paths and taking the first that exists.
//
// That shape replaced a candidate probe that had two defects this file used to
// guard the ABSENCE of, and both are now worth pinning:
//
// 1. `break` on the first match. A stale file in the workspace root shadowed
// every session's real state, and the companion showed the stale one.
// 2. A flat glob over the goals directory, which cannot see into a
// subdirectory — so with state moved per session it found nothing at all,
// and a custom-named file anywhere in the root counted as goal state.
//
// The third test below asserts a stale root-level `state.json` is not read at
// all: reading it would be reading a format this plugin no longer writes, and
// it would contradict live state if it did.

async function writeSession(
  dir: string,
  sessionID: string,
  goals: unknown[],
): Promise<string> {
  const sessionDir = join(dir, '.opencode', 'goals', 'sessions', sessionID);
  await mkdir(sessionDir, {recursive: true});
  const path = join(sessionDir, 'state.json');
  await writeFile(
    path,
    JSON.stringify({version: 1, goals, results: [], sessionOrdered: []}),
    'utf8',
  );
  return path;
}

function goal(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    revision: 1,
    turnCount: 1,
    maxTurns: 10,
    maxTokens: 200000,
    status: 'active',
    ...overrides,
  };
}

describe("a companion reads every session's file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'goal-hydrate-'));
  });
  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('hydrates goals from three sessions, and the store keeps them apart', async () => {
    await writeSession(dir, 'ses-one', [
      goal({goalId: 'g-1', sessionID: 'ses-one', condition: 'first'}),
    ]);
    await writeSession(dir, 'ses-two', [
      goal({goalId: 'g-2', sessionID: 'ses-two', condition: 'second'}),
    ]);
    await writeSession(dir, 'ses-three', [
      goal({goalId: 'g-3', sessionID: 'ses-three', condition: 'third'}),
      goal({goalId: 'g-4', sessionID: 'ses-three', condition: 'fourth'}),
    ]);
    const store = createTuiStateStore();
    const res = await hydrateStoreFromDisk(store, dir);
    expect(res.hydratedCount).toBe(4);
    expect(
      store
        .getAllSnapshots()
        .map(s => s.goalId)
        .sort(),
    ).toEqual(['g-1', 'g-2', 'g-3', 'g-4']);
    // Session separation is the point of the layout, and the store is the
    // thing the dashboard filters by.
    expect(store.getSnapshots('ses-one')[0]?.condition).toBe('first');
    expect(
      store
        .getSnapshots('ses-three')
        .map(s => s.condition)
        .sort(),
    ).toEqual(['fourth', 'third']);
  });

  it('a stale file in the state ROOT is not read, and does not shadow the sessions', async () => {
    // The old reader took the first candidate that existed and stopped. A
    // leftover `state.json` at the root — a format this plugin no longer
    // writes — would have been read in preference to every session's real
    // state. It is not read now, and the break-on-first-match is gone.
    const goalsDir = join(dir, '.opencode', 'goals');
    await mkdir(goalsDir, {recursive: true});
    await writeFile(
      join(goalsDir, 'state.json'),
      JSON.stringify({
        version: 1,
        goals: [
          goal({goalId: 'g-stale', sessionID: 'ses-one', condition: 'stale'}),
        ],
        results: [],
      }),
      'utf8',
    );
    await writeSession(dir, 'ses-one', [
      goal({goalId: 'g-live', sessionID: 'ses-one', condition: 'live'}),
    ]);
    const store = createTuiStateStore();
    const res = await hydrateStoreFromDisk(store, dir);
    expect(res.hydratedCount).toBe(1);
    expect(store.getAllSnapshots().map(s => s.goalId)).toEqual(['g-live']);
  });

  it('a FILE whose name passes the session-id charset is not read as a session', async () => {
    // `discoverStateFiles` filters on `isDirectory` AND the charset. A decoy
    // that fails the charset shows only the charset; this one is named
    // `ses_stray` and passes it, so nothing but the directory check can
    // exclude it. Asserted through the exported resolver rather than through
    // `hydrateStoreFromDisk`, whose try/catch absorbs the resulting ENOTDIR and
    // would report the same hydratedCount either way — which is why the earlier
    // version of this test was decorative.
    const dir = await mkdtemp(join(tmpdir(), 'goal-discover-'));
    try {
      await mkdir(join(dir, '.opencode', 'goals', 'sessions'), {
        recursive: true,
      });
      await writeFile(
        join(dir, '.opencode', 'goals', 'sessions', 'ses_stray'),
        'x',
        'utf8',
      );
      await mkdir(join(dir, '.opencode', 'goals', 'sessions', 'ses_real'), {
        recursive: true,
      });
      const found = await discoverStateFiles(dir);
      expect(found.map(p => p.split('/').at(-2))).toEqual(['ses_real']);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('non-session entries in the sessions directory are skipped, not read', async () => {
    const sessionsDir = join(dir, '.opencode', 'goals', 'sessions');
    await mkdir(sessionsDir, {recursive: true});
    // A ledger, a lock and a stray text file at the wrong level, plus a
    // directory whose name would not survive the session-id guard.
    // A FILE whose name passes the session-id charset: only a directory check
    // can exclude it. A decoy named `notes.txt` would be excluded by the
    // charset and the filter would go unpinned.
    await writeFile(join(sessionsDir, 'ses_stray'), 'x', 'utf8');
    await writeFile(
      join(sessionsDir, 'state.json.ledger.jsonl'),
      '{"seq":1}\n',
      'utf8',
    );
    await mkdir(join(sessionsDir, 'has space'), {recursive: true});
    await writeFile(
      join(sessionsDir, 'has space', 'state.json'),
      JSON.stringify({
        version: 1,
        goals: [goal({goalId: 'g-x', sessionID: 'bad'})],
      }),
      'utf8',
    );
    const store = createTuiStateStore();
    const res = await hydrateStoreFromDisk(store, dir);
    expect(res.hydratedCount).toBe(0);
    expect(store.getAllSnapshots()).toEqual([]);
  });

  it('an explicit path is read when given, and nothing else is', async () => {
    await writeSession(dir, 'ses-one', [
      goal({goalId: 'g-live', sessionID: 'ses-one'}),
    ]);
    const explicit = await writeSession(dir, 'ses-explicit', [
      goal({goalId: 'g-explicit', sessionID: 'ses-explicit'}),
    ]);
    const store = createTuiStateStore();
    const res = await hydrateStoreFromDisk(store, dir, explicit);
    expect(res.hydratedCount).toBe(1);
    expect(store.getAllSnapshots().map(s => s.goalId)).toEqual(['g-explicit']);
  });

  it('readDiskGoalSnapshots reports how many files it actually read', async () => {
    // The refresh loop depends on the difference between "nothing to see" and
    // "could not see": a `filesRead` of 0 with files present means the state
    // is unverifiable, and treating that as an empty workspace is what turns
    // every running goal into a fresh "Goal started" after one torn read.
    await writeSession(dir, 'ses-one', [
      goal({goalId: 'g-1', sessionID: 'ses-one'}),
    ]);
    const read = await readDiskGoalSnapshots(dir);
    expect(read.filesRead).toBe(1);
    expect(read.stateDirMissing).toBe(false);
    expect(read.snapshots).toHaveLength(1);

    // A workspace that has never run a goal: a real, safe observation.
    const empty = await mkdtemp(join(tmpdir(), 'goal-hydrate-empty-'));
    try {
      const blank = await readDiskGoalSnapshots(empty);
      expect(blank.snapshots).toEqual([]);
      expect(blank.filesRead).toBe(0);
      expect(blank.stateDirMissing).toBe(true);
    } finally {
      await rm(empty, {recursive: true, force: true});
    }
  });
});
