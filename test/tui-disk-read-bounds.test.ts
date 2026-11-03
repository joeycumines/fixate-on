// tui-disk-read-bounds.test.ts — the companions read state under the same ceiling the
// plugin writes it under, and parse each file once.
//
// `src/tui-disk-state.ts` is the companions' only reader of persisted goal state, and it
// was the one state-file reader in the tree with no ceiling at all. Three defects, all in
// the same function:
//
// 1. UNBOUNDED. `readFile(p, "utf8")` on every path, on every refresh tick
// (`tui-companion-refresh.ts:144` calls this each tick, so the cost recurs
// indefinitely). Measured against a 35.8 MB state file: `filesRead: 1`, 40,000
// snapshots returned, 161 ms, +85 MB RSS — and `persistence.ts` records 1.8 GB as a
// size this tree has actually produced, which would be roughly 4 GB read per tick.
// 2. A PREFIX TREATED AS THE WHOLE FILE. Past the plugin's 16 MiB ceiling the plugin
// REPORTS the snapshot and refuses to write over it. The companion had no ceiling,
// so it read all of it — and if it is ever given one naively, the prefix is a
// snapshot whose goals are silently absent, which is the state
// `threeStatesAReaderMustNotConfuse` exists to keep distinct from empty.
// 3. PARSED TWICE. `JSON.parse(content)` as a validity gate, result discarded, then the
// same string parsed again by `parseStateFileGoals`. Waste, and worse: the validity
// gate was a SEPARATE decision from the projection.
//
// A fourth, found in the same pass and fixed here because it is the same read: the reader
// FOLLOWED a symlinked `state.json` leaf. Every writer refuses one — `portableWriteFile`
// refuses to replace one, `appendWalEntry` opens with `O_NOFOLLOW`,
// `assertContainedInStateRoot` walks every segment — and `discoverStateFiles` already
// skips a symlinked session DIRECTORY via the dirent. Only the leaf was exposed:
// reproduced by symlinking `<root>/sessions/ses_victim/state.json` at an outside file,
// after which the companion rendered that file's goal as `ses_victim`'s. A reader more
// trusting than its writer is how a file stops being evidence.
//
// The ceiling now comes from `MAX_STATE_FILE_BYTES` in `fs-portable.ts`, which is where
// the plugin's own reader gets it too, and both sides go through one `portableReadBounded`.
// One number, one implementation, one refusal.

import {describe, expect, test} from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  hydrateStoreFromDisk,
  readDiskGoalSnapshots,
} from '../src/tui-disk-state.ts';
import {createTuiStateStore} from '../src/tui-state.ts';
import {MAX_STATE_FILE_BYTES} from '../src/fs-portable.ts';

const CEILING = MAX_STATE_FILE_BYTES;
const SESSION = 'ses_ceiling';

/** A state file past the ceiling, built the way a real session reaches one. */
async function writeOverCeiling(
  statePath: string,
  bytes: number,
): Promise<number> {
  await mkdir(join(statePath, '..'), {recursive: true});
  const filler = 'x'.repeat(16_000);
  const goals: unknown[] = [];
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
      maxTokens: 0,
      maxTurns: 0,
      maxDurationMs: 0,
      turnCount: 1,
      totalTokens: 10,
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
      updatedAt: 1,
      startedAt: 1,
      pausedAt: 0,
      stoppedAt: 0,
      finishedAt: null,
      status: 'active',
      stopReason: '',
      blockedReason: '',
      finalizing: false,
      continuationClaim: null,
      history: [],
      messageIDs: [],
    });
    written += filler.length;
  }
  await writeFile(statePath, JSON.stringify({version: 1, goals}), 'utf8');
  return (await readFile(statePath)).byteLength;
}

async function writeSmallState(
  statePath: string,
  sessionID: string,
  goalId: string,
  condition: string,
): Promise<void> {
  await mkdir(join(statePath, '..'), {recursive: true});
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      goals: [
        {
          goalId,
          runId: 'r',
          revision: 1,
          condition,
          successCriteria: '',
          constraints: '',
          artifactPointers: [],
          pendingProposal: null,
          mode: 'normal',
          sessionID,
          tokenBudget: null,
          maxTokens: 0,
          maxTurns: 0,
          maxDurationMs: 0,
          turnCount: 1,
          totalTokens: 10,
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
          updatedAt: 1,
          startedAt: 1,
          pausedAt: 0,
          stoppedAt: 0,
          finishedAt: null,
          status: 'active',
          stopReason: '',
          blockedReason: '',
          finalizing: false,
          continuationClaim: null,
          history: [],
          messageIDs: [],
        },
      ],
    }),
    'utf8',
  );
}

describe("the companions read state under the plugin's own ceiling", () => {
  test('a snapshot past the ceiling is NOT read as a prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tui-ceiling-'));
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      const statePath = join(stateRoot, 'sessions', SESSION, 'state.json');
      const size = await writeOverCeiling(statePath, CEILING + 1024 * 1024);
      expect(
        size,
        'the fixture did not cross the ceiling, so this case shows nothing',
      ).toBeGreaterThan(CEILING);

      const read = await readDiskGoalSnapshots(root);

      // THE ASSERTION. `filesRead` counts files whose contents were SUCCESSFULLY read,
      // and a file past the ceiling was not read. Reporting it as read — with the goals
      // its prefix happens to contain — is what turns a workspace into a lie.
      expect(
        read.filesRead,
        'a snapshot past the ceiling was reported as read',
      ).toBe(0);
      expect(
        read.snapshots,
        'a prefix of an over-ceiling snapshot was rendered as the workspace',
      ).toEqual([]);

      // WHAT THIS CASE DOES AND DOES NOT PIN, recorded because the honest answer is not
      // the convenient one. Deleting the reader's explicit `if (truncated) continue` does
      // NOT turn this test red: a 16 MiB prefix of a JSON document does not parse, so the
      // pre-existing validity gate rejects it anyway. MEASURED, not assumed — the prefix
      // of a 17.9 MB fixture at the 16 MiB ceiling fails `JSON.parse`.
      //
      // So the explicit check is not what protects the workspace TODAY. It is kept
      // because it removes a dependency on a format invariant that nothing states
      // anywhere: "a truncated snapshot cannot be valid JSON". That holds while the
      // snapshot is one JSON document, and the plugin already uses a line-delimited
      // format for its ledger — where every prefix IS valid. A format change would turn
      // this from redundant to silently wrong, and nothing else would notice. One line,
      // no test manufactured to justify it, and the limitation stated where the next
      // reader will find it.
      // …and the directory EXISTS, which is the distinction that stops a refresh loop
      // baselining this workspace as empty and announcing every running goal as new.
      expect(
        read.stateDirMissing,
        'a workspace with an unreadable file reported no state directory at all',
      ).toBe(false);

      // CONTROL, IN THE OTHER DIRECTION: a file UNDER the ceiling still reads, and still
      // projects. A ceiling that refused everything would satisfy the half above.
      const small = join(stateRoot, 'sessions', 'ses_small', 'state.json');
      await writeSmallState(small, 'ses_small', 'g-small', 'an ordinary goal');
      const both = await readDiskGoalSnapshots(root);
      expect(
        both.filesRead,
        'the healthy session was not read alongside the over-ceiling one',
      ).toBe(1);
      expect(both.snapshots.map(s => s.condition)).toEqual([
        'an ordinary goal',
      ]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);

  test('hydration refuses an over-ceiling snapshot too', async () => {
    // The other read path. A fix to one and not the other is the shape this repository
    // has paid for repeatedly — the same rule applied to one surface and not the second.
    const root = await mkdtemp(join(tmpdir(), 'tui-ceiling-hydrate-'));
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      await writeOverCeiling(
        join(stateRoot, 'sessions', SESSION, 'state.json'),
        CEILING + 1024 * 1024,
      );
      const store = createTuiStateStore();
      const result = await hydrateStoreFromDisk(store, root);
      expect(
        result.hydratedCount,
        'an over-ceiling snapshot was hydrated from its prefix',
      ).toBe(0);
      expect(
        store.getAllSnapshots(),
        'an over-ceiling prefix reached the store',
      ).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);

  test('a SYMLINKED state.json leaf is not read', async () => {
    // Read-only in effect, and that is the point: the companion rendered another file's
    // goal under this session's name. `discoverStateFiles` already skipped a symlinked
    // session DIRECTORY via the dirent, so only the leaf was exposed.
    const root = await mkdtemp(join(tmpdir(), 'tui-leaf-link-'));
    try {
      const outside = await mkdtemp(join(tmpdir(), 'tui-leaf-outside-'));
      try {
        await writeSmallState(
          join(outside, 'stolen.json'),
          SESSION,
          'g-stolen',
          "someone else's objective",
        );
        const stateRoot = join(root, '.opencode', 'goals');
        const victim = join(stateRoot, 'sessions', 'ses_victim');
        await mkdir(victim, {recursive: true});
        await symlink(join(outside, 'stolen.json'), join(victim, 'state.json'));

        const read = await readDiskGoalSnapshots(root);
        expect(
          read.snapshots,
          'a symlinked state.json was followed and its contents attributed to this session',
        ).toEqual([]);
        expect(
          read.filesRead,
          'a symlinked state.json counted as a file this host read',
        ).toBe(0);

        // CONTROL: the same tree with a REAL file reads normally, so the refusal above is
        // about the link and not about the reader refusing everything.
        const honest = join(stateRoot, 'sessions', 'ses_honest', 'state.json');
        await writeSmallState(
          honest,
          'ses_honest',
          'g-honest',
          'an honest objective',
        );
        const control = await readDiskGoalSnapshots(root);
        expect(control.snapshots.map(s => s.condition)).toEqual([
          'an honest objective',
        ]);
      } finally {
        await rm(outside, {recursive: true, force: true});
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);

  test('the file is parsed ONCE per read', async () => {
    // The double parse was `JSON.parse(content)` as a validity gate with the result
    // discarded, then the same string parsed again. Counting the calls is the only way
    // to assert it, and it is what makes this a gate rather than a claim: a reader that
    // parses once and a reader that parses twice are otherwise indistinguishable by
    // their output.
    const root = await mkdtemp(join(tmpdir(), 'tui-parse-once-'));
    try {
      // A marker unique to this fixture's bytes, so the counter below counts THIS
      // file's parses and nothing else.
      const MARKER = 'counted-once-fixture-marker';
      await writeSmallState(
        join(root, '.opencode', 'goals', 'sessions', 'ses_once', 'state.json'),
        'ses_once',
        'g-1',
        MARKER,
      );
      const original = JSON.parse;
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JSON as any).parse = (text: unknown, ...rest: unknown[]) => {
        // ONLY parses of this fixture count. The hook is PROCESS-GLOBAL, and `bun test`
        // runs test files in one worker, so an unrelated `JSON.parse` anywhere in the
        // worker was landing in this counter — measured at 5 on a reader that parses
        // once. The assertion is about this reader's double parse, not about how much
        // JSON the rest of the suite happened to decode while the hook was installed.
        if (typeof text === 'string' && text.includes(MARKER)) calls += 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any)(text, ...rest);
      };
      try {
        const read = await readDiskGoalSnapshots(root);
        expect(read.filesRead).toBe(1);
      } finally {
        JSON.parse = original;
      }
      expect(
        calls,
        `the file was parsed ${calls} times on a single read; the validity gate and the projection must not both parse`,
      ).toBe(1);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 120_000);
});
