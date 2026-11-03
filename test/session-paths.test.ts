// session-paths.test.ts — a host-supplied session id becomes a path component,
// so the guard is tested at the boundary rather than trusted.
//
// The plugin's central invariant is that a goal belongs to exactly one session
// and its state lives in that session's own file. That only works if the file
// really is the session's own, which means the id the HOST supplies has to be
// checked before it is used: a `../../etc` that became a directory name would
// put one session's goals where another could read them, and a silently
// "sanitised" id would write two sessions into one file — the exact defect the
// layout was introduced to end.
//
// These are the cases a fuzzer reaches first, so they are enumerated rather
// than sampled.

import {describe, expect, test} from 'bun:test';
import {existsSync} from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, sep} from 'node:path';
import {
  assertContainedInStateRoot,
  assertSafeSessionID,
  DEFAULT_STATE_ROOT,
  ensureSessionDir,
  listSessionIDs,
  sessionStatePaths,
} from '../src/session-paths.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';

describe('a session id is checked before it becomes a path', () => {
  test('the ids the host actually issues are accepted unchanged', () => {
    // The measured shape from opencode, not a guess.
    for (const id of ['ses_f13cccf38ffe6sc1WKFWyQ6LFu', 's1', 'a', 'A-1_2']) {
      expect(assertSafeSessionID(id)).toBe(id);
    }
  });

  test('anything that could traverse or escape is refused, naming the value', () => {
    const rejected = [
      '../etc',
      '../../etc/passwd',
      'a/b',
      'a\\b',
      '.',
      '..',
      '',
      '   ',
      '/absolute',
      '~/home',
      'sess\u0000ion',
      'ses ion',
      'ses:ion',
      'ses;ion',
      'sess\nion',
      'sess%2e%2e',
      // The length bound is not decoration: a 4000-character id is a plausible
      // fuzz input and becomes an ENAMETOOLONG deep inside a write otherwise.
      's'.repeat(4000),
      'é'.repeat(8),
    ];
    for (const id of rejected) {
      expect(
        () => assertSafeSessionID(id),
        `${JSON.stringify(id)} should be refused`,
      ).toThrow();
    }
  });

  test('the error names the offending value, truncated', () => {
    // This reaches a user through a log line. "session id rejected" alone does
    // not say which id, and a 4000-character id in a log line helps nobody.
    let message = '';
    try {
      assertSafeSessionID('s'.repeat(4000));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('session directory name');
    expect(message.length).toBeLessThan(200);
  });

  test('a non-string is refused rather than coerced', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(() => assertSafeSessionID(value as unknown as string)).toThrow();
    }
  });
});

describe('the layout', () => {
  test('one root gives two sessions two disjoint path pairs', () => {
    const a = sessionStatePaths('/state', 'ses-A');
    const b = sessionStatePaths('/state', 'ses-B');
    expect(a.statePath).toContain('ses-A');
    expect(b.statePath).toContain('ses-B');
    expect(a.statePath).not.toBe(b.statePath);
    expect(a.ledgerPath).not.toBe(b.ledgerPath);
    // The ledger is the snapshot's name plus a suffix, so rotation generations
    // land beside it rather than somewhere a rotation would not find.
    expect(a.ledgerPath.startsWith(a.statePath)).toBe(true);
    expect(a.sessionDir).toBe(join(join('/state', 'sessions'), 'ses-A'));
  });

  test("neither session's path contains the other's id", () => {
    const a = sessionStatePaths('/state', 'alpha');
    const b = sessionStatePaths('/state', 'beta');
    expect(a.statePath).not.toContain('beta');
    expect(b.ledgerPath).not.toContain('alpha');
  });

  test('the default root keeps the name that locates state already on disk', () => {
    // Renaming this would orphan every existing workspace's state, which is
    // exactly the "what breaks if it changes" test the preserve rule asks for.
    expect(DEFAULT_STATE_ROOT).toBe('.opencode/goals');
  });
});

describe('the guard at the production boundary', () => {
  test('sessionStatePaths refuses a traversal, not only assertSafeSessionID', async () => {
    // `assertSafeSessionID` is tested directly above, and the production path
    // that calls it was not: removing the call inside `sessionStatePaths` left
    // every test in this file green. A guard nobody drives through the thing
    // that uses it is a comment.
    const root = await mkdtemp(join(tmpdir(), 'session-boundary-'));
    try {
      for (const hostile of ['../../../../tmp/escaped', 'a/b', '..', '.']) {
        expect(
          () => sessionStatePaths(root, hostile),
          `${hostile} reached the filesystem`,
        ).toThrow();
      }
      // And a refused id creates no directory, so a refusal cannot itself
      // become a way to write somewhere.
      expect(() => sessionStatePaths(root, '../escape')).toThrow();
      expect(await readdir(root).catch(() => [] as string[])).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test('a hostile session id is refused by the PLUGIN, and the plugin still loads', async () => {
    // The same property at the boundary a user actually meets. The agent has to
    // be able to read the refusal, so it arrives as a command error naming the
    // id rather than a load failure.
    const {GoalsPlugin} = await import('../src/plugin.ts');
    const root = await mkdtemp(join(tmpdir(), 'session-plugin-'));
    try {
      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {
            command: 'goal',
            sessionID: '../../../../tmp/escaped',
            arguments: 'escape',
          },
          output,
        );
        expect(output.parts[0]?.text).toContain('session directory name');
        // A good session still works on the same host.
        const ok: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_ok', arguments: 'legitimate'},
          ok,
        );
        expect(ok.parts[0]?.text).toContain('legitimate');
        // And nothing was written outside the workspace.
        expect(
          await readdir(join(root, '.opencode', 'goals', 'sessions')).catch(
            () => [] as string[],
          ),
        ).toEqual(['ses_ok']);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);
});

describe('a write cannot leave the state root through a symlink', () => {
  // THE DEFECT. `resolveWorkspacePath` returns early for an absolute path, and
  // the state root and every file derived from it are absolute by the time they
  // reach it — so the symlink walk its own comment describes never ran, for any
  // call, in any configuration. Measured with `<root>/sessions/ses_target` a
  // symlink to a directory outside the root: a goal was created, both files landed
  // OUTSIDE the state root, nothing was printed, and a restart reported "No
  // active goal" while the state was still sitting there.
  //
  // Every case below has a CONTROL that must behave differently, because a guard
  // whose control also passes cannot fail: the real session beside the symlinked
  // one has to persist, or a test that refuses every write would satisfy all of
  // these assertions at once.

  test('a symlinked SESSION DIRECTORY is refused, and the neighbouring session still persists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-symlink-dir-'));
    const outside = await mkdtemp(join(tmpdir(), 'session-outside-'));
    try {
      await mkdir(join(root, 'sessions'), {recursive: true});
      await symlink(outside, join(root, 'sessions', 'ses_evil'), 'dir');

      // The refusal is loud, and names the segment, so a user who plants one can
      // see which path was refused rather than watching a goal disappear.
      let message = '';
      try {
        await ensureSessionDir(root, 'ses_evil');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('symlinked path segment');
      expect(message).toContain('ses_evil');

      // Nothing was created outside: not the directory the mkdir would have made,
      // and not a file in it.
      expect(await readdir(outside)).toEqual([]);

      // CONTROL — a real directory in the same root is created and is idempotent.
      const good = await ensureSessionDir(root, 'ses_good');
      expect((await lstat(good)).isDirectory()).toBe(true);
      expect(await ensureSessionDir(root, 'ses_good')).toBe(good);
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  });

  test('a symlinked LEDGER LEAF is refused, because a real directory can hold a symlinked file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-symlink-leaf-'));
    const outside = await mkdtemp(join(tmpdir(), 'session-outside-leaf-'));
    try {
      const evil = sessionStatePaths(root, 'ses_leaf');
      await mkdir(evil.sessionDir, {recursive: true});
      const victim = join(outside, 'stolen.jsonl');
      await symlink(victim, evil.ledgerPath);

      // The directory guard passes here — it is a real directory — so this is the
      // shape that shows the LEAF is checked and not only its parent.
      assertContainedInStateRoot(root, evil.sessionDir);
      expect(() => assertContainedInStateRoot(root, evil.ledgerPath)).toThrow(
        /symlinked path segment/,
      );

      // CONTROL: the snapshot leaf beside it is not a symlink, so it passes.
      expect(() =>
        assertContainedInStateRoot(root, evil.statePath),
      ).not.toThrow();
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  });

  test('a symlink anywhere ABOVE the session is refused too, not only at its own level', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-symlink-ancestor-'));
    const outside = await mkdtemp(join(tmpdir(), 'session-outside-ancestor-'));
    try {
      // The sessions DIRECTORY itself is the symlink, so every session id is
      // affected and a per-session check would catch nothing.
      await symlink(join(outside, 'inner'), join(root, 'sessions'), 'dir');
      expect(() =>
        assertContainedInStateRoot(
          root,
          sessionStatePaths(root, 'ses_any').statePath,
        ),
      ).toThrow(/symlinked path segment/);
      // CONTROL: a REAL state root passes, including for the root's own segment.
      // This is the assertion's whole purpose and the fixture has to make it — the
      // first version of this line said "the state root's own realpath is not a
      // symlink", which was a statement about a fixture that never made one.
      expect(() => assertContainedInStateRoot(root, root)).not.toThrow();
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  });

  test('THE BOUNDARY ITSELF: a state root that is a symlink is refused', async () => {
    // THE SEGMENT NOBODY OWNED. `resolveWorkspacePath` walks the segments ABOVE the
    // root and `assertContainedInStateRoot` used to start BELOW it, so `.opencode/
    // goals` pointing outside the workspace passed both. Measured by the final
    // gate's review, one segment after the same defect was fixed lower down: the
    // goal's snapshot and ledger were both created outside the workspace, `/goal`
    // reported "New active goal", and nothing was logged.
    const parent = await mkdtemp(join(tmpdir(), 'rootlink-parent-'));
    const outside = await mkdtemp(join(tmpdir(), 'rootlink-outside-'));
    try {
      const root = join(parent, 'goals');
      await symlink(outside, root, 'dir');
      // Every path derived from that root is refused, including the root itself —
      // and the message names the root, because "point stateRoot at a real
      // directory" is the remedy and a message without it is not actionable.
      let message = '';
      try {
        assertContainedInStateRoot(
          root,
          sessionStatePaths(root, 'ses_any').statePath,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('state root itself is a symlink');
      expect(message).toContain(root);
      expect(message).toContain('stateRoot');
      expect(() => assertContainedInStateRoot(root, root)).toThrow(
        /state root itself is a symlink/,
      );

      // …AND SPELLED WITH A TRAILING SEPARATOR, which is the spelling that made the
      // check above pass. `lstat("<root>/")` resolves THROUGH the final link and
      // reports the target directory, so a symlinked root read as a real one; and
      // `dirname("<root>/")` is the root's PARENT rather than the root, so the
      // boundary branch was entered and then defeated rather than skipped. The walk
      // was no help either — `join` normalised the separator away, so it started
      // from a path that was already outside. Measured through the real plugin, the
      // ONLY difference from the refused case being one `/` at the end of the
      // configured root: state.json and its ledger outside the workspace and the
      // command reporting `New active goal`.
      expect(() =>
        assertContainedInStateRoot(
          `${root}/`,
          sessionStatePaths(`${root}/`, 'ses_any').statePath,
        ),
      ).toThrow(/state root itself is a symlink/);
      expect(() => assertContainedInStateRoot(`${root}/`, `${root}/`)).toThrow(
        /state root itself is a symlink/,
      );

      // CONTROL: the same call against a REAL directory is fine, so the refusal is
      // about the symlink and not about the guard refusing everything.
      const real = join(parent, 'real-goals');
      await mkdir(real, {recursive: true});
      expect(() =>
        assertContainedInStateRoot(
          real,
          sessionStatePaths(real, 'ses_any').statePath,
        ),
      ).not.toThrow();
      expect(() => assertContainedInStateRoot(real, real)).not.toThrow();
      // …including spelled with a trailing separator, because a configuration that
      // ends its root in `/` is ordinary and refusing it would be a regression the
      // case above would not notice.
      expect(() =>
        assertContainedInStateRoot(
          `${real}/`,
          sessionStatePaths(`${real}/`, 'ses_any').statePath,
        ),
      ).not.toThrow();
      expect(() =>
        assertContainedInStateRoot(`${real}/`, `${real}/`),
      ).not.toThrow();
      // …and a root that does not exist yet is still allowed, separator or not.
      expect(() =>
        assertContainedInStateRoot(
          `${parent}/not-yet/`,
          sessionStatePaths(`${parent}/not-yet/`, 'ses_any').statePath,
        ),
      ).not.toThrow();
    } finally {
      await rm(parent, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  });

  test('a path that does not exist yet is allowed, and one that leaves the root is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-fresh-'));
    try {
      // The guard cannot refuse every write, or it refuses the first one: a new
      // session's directory does not exist at the moment it is checked.
      expect(() =>
        assertContainedInStateRoot(
          root,
          sessionStatePaths(root, 'ses_new').statePath,
        ),
      ).not.toThrow();
      expect(() => assertContainedInStateRoot(root, root)).not.toThrow();
      // And the escape check is independent of the filesystem — a target above
      // the root needs no file to exist to be refused.
      expect(() =>
        assertContainedInStateRoot(
          root,
          join(root, '..', 'elsewhere', 'state.json'),
        ),
      ).toThrow(/escapes the state root/);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test('a symlinked LEDGER LEAF is refused by the PLUGIN, through the append that writes it', async () => {
    // The session DIRECTORY is real here, so the directory guard passes and the
    // leaf is the only thing standing between an append and a file outside the
    // root. Measured: with the leaf check gone, the goal's create entry was
    // appended through the symlink while every directory-level assertion passed.
    const {GoalsPlugin} = await import('../src/plugin.ts');
    const root = await mkdtemp(join(tmpdir(), 'session-plugin-leaf-'));
    const outside = await mkdtemp(
      join(tmpdir(), 'session-plugin-leaf-outside-'),
    );
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      const sessionDir = join(stateRoot, 'sessions', 'ses_leaf');
      await mkdir(sessionDir, {recursive: true});
      const victim = join(outside, 'stolen.jsonl');
      await writeFile(victim, '', 'utf8');
      await symlink(victim, join(sessionDir, 'state.json.ledger.jsonl'));

      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_leaf', arguments: 'objective'},
          {parts: []},
        );
        // The victim's bytes are unchanged — an append through the symlink would
        // have put a committed create entry in it.
        expect(await Bun.file(victim).text()).toBe('');

        // The refusal is visible rather than silent — the goal works in memory
        // and the user is told its state will not survive a restart.
        const refused: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_leaf', arguments: 'objective'},
          refused,
        );
        expect(refused.parts.map(p => p.text).join('\n')).toContain(
          'symlinked path segment',
        );

        // CONTROL: a session beside it, with no symlink anywhere, persists. This
        // is also the regression gate for a workspace-wide fence — the refusal
        // above is per SESSION, so it must not cost this one its writes.
        const ok: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_ok', arguments: 'objective'},
          ok,
        );
        expect(ok.parts.map(p => p.text).join('\n')).toContain(
          'New active goal',
        );
        expect(
          await Bun.file(
            join(stateRoot, 'sessions', 'ses_ok', 'state.json'),
          ).exists(),
        ).toBe(true);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  }, 30_000);

  test('THE PLUGIN refuses a symlinked state root, keeps its tools, and writes nothing outside', async () => {
    // The end-to-end property for the boundary segment, and the one the finding was
    // measured through: all seven tools present, the refusal names the root, and no
    // file appears outside it. The tools assertion is the part that matters most —
    // refusing at LOAD would be a fix that costs a host every tool, which is the
    // reported bug this campaign opened with.
    const {GoalsPlugin} = await import('../src/plugin.ts');
    const root = await mkdtemp(join(tmpdir(), 'rootlink-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'rootlink-outside-'));
    try {
      await mkdir(join(root, '.opencode'), {recursive: true});
      await symlink(outside, join(root, '.opencode', 'goals'), 'dir');

      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        expect(
          Object.keys(hooks.tool ?? {}).length,
          'a refusal at load cost the host its tools',
        ).toBeGreaterThanOrEqual(7);
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_r', arguments: 'objective'},
          output,
        );
        const said = output.parts.map(p => p.text).join('\n');
        expect(
          said,
          'the refusal is silent, so the user cannot act on it',
        ).toContain('state root itself is a symlink');
        expect(said).not.toContain('New active goal');
      } finally {
        await hooks.dispose?.();
      }

      // Nothing outside — not even the session DIRECTORY, which the mkdir creates
      // before any file is written.
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  }, 30_000);

  test('THE PLUGIN refuses it SPELLED WITH A TRAILING SEPARATOR, which is a different string', async () => {
    // The same end-to-end property, reached by SPELLING rather than by construction,
    // because `resolveWorkspacePath` returns an absolute configured root verbatim and
    // a root configured as `/path/to/goals/` is ordinary. `lstatSync` on such a path
    // resolves THROUGH the final link, so the boundary check passed it, and the walk
    // then began from a `join`-normalised path that was already outside — state.json
    // and its ledger created outside the workspace, `/goal` reporting success and
    // nothing logged, and the goal resuming from the outside file after a restart.
    // Measured on the real plugin with one `/` the only difference from the case
    // beside it.
    const {GoalsPlugin} = await import('../src/plugin.ts');
    const root = await mkdtemp(join(tmpdir(), 'rootlink-trailing-'));
    const outside = await mkdtemp(join(tmpdir(), 'rootlink-trailing-outside-'));
    try {
      await mkdir(join(root, '.opencode'), {recursive: true});
      const configured = join(root, '.opencode', 'goals');
      await symlink(outside, configured, 'dir');

      const hooks = await GoalsPlugin(
        {directory: root},
        {stateRoot: `${configured}/`, idlePoller: false},
      );
      try {
        expect(
          Object.keys(hooks.tool ?? {}).length,
          'a refusal at load cost the host its tools',
        ).toBeGreaterThanOrEqual(7);
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_r', arguments: 'objective'},
          output,
        );
        const said = output.parts.map(p => p.text).join('\n');
        expect(
          said,
          'the spelling defeated the guard, so nothing was refused',
        ).toContain('state root itself is a symlink');
        expect(said).not.toContain('New active goal');
      } finally {
        await hooks.dispose?.();
      }

      expect(
        await readdir(outside),
        'goal state was written outside the workspace',
      ).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  }, 30_000);

  test('and a REAL root spelled with a trailing separator still saves, which is the control', async () => {
    // Without this, "refuse any root ending in `/`" would satisfy the case above. A
    // trailing separator is an ordinary way to write a directory, and the guard must
    // be right about the path rather than about its spelling.
    const {GoalsPlugin} = await import('../src/plugin.ts');
    const root = await mkdtemp(join(tmpdir(), 'rootlink-control-'));
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      await mkdir(stateRoot, {recursive: true});
      const hooks = await GoalsPlugin(
        {directory: root},
        {stateRoot: `${stateRoot}/`, idlePoller: false},
      );
      try {
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_r', arguments: 'objective'},
          output,
        );
        const said = output.parts.map(p => p.text).join('\n');
        expect(
          said,
          'a real root was refused over a trailing separator',
        ).toContain('New active goal');
        expect(said).not.toContain('NOT SAVED');
      } finally {
        await hooks.dispose?.();
      }
      expect(
        existsSync(join(stateRoot, 'sessions', 'ses_r', 'state.json')),
        'nothing was written',
      ).toBe(true);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);

  test('THE PLUGIN refuses the write and writes nothing outside the root', async () => {
    // The guard on its own is a comment. This drives it through the surface a
    // user meets: a host asks for a goal in a session whose directory is a
    // symlink, and nothing lands outside the state root.
    const {GoalsPlugin} = await import('../src/plugin.ts');
    const root = await mkdtemp(join(tmpdir(), 'session-plugin-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'session-plugin-outside-'));
    try {
      const stateRoot = join(root, '.opencode', 'goals');
      await mkdir(join(stateRoot, 'sessions'), {recursive: true});
      await symlink(outside, join(stateRoot, 'sessions', 'ses_evil'), 'dir');

      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        const output: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_evil', arguments: 'objective'},
          output,
        );
        expect(output.parts.map(p => p.text).join('\n')).toContain(
          'symlinked path segment',
        );

        // Nothing outside: no lock, no ledger, no snapshot, no directory.
        expect(await readdir(outside)).toEqual([]);

        // CONTROL: a legitimate session on the same host persists normally, so the
        // refusal above is about the symlink and not about this configuration.
        const ok: {parts: {type: string; text: string}[]} = {parts: []};
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: 'ses_ok', arguments: 'objective'},
          ok,
        );
        expect(
          await Bun.file(
            join(stateRoot, 'sessions', 'ses_ok', 'state.json'),
          ).exists(),
        ).toBe(true);
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  }, 30_000);
});

describe('creating a session directory', () => {
  test('it is idempotent, because several writers for one session race on it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-dir-'));
    try {
      const first = await ensureSessionDir(root, 'ses-1');
      const second = await ensureSessionDir(root, 'ses-1');
      expect(first).toBe(second);
      expect((await readdir(first)).length).toBe(0);
      // A goal's ledger is the FIRST file a session writes, so this directory
      // has to exist before any append — measured: without it, every goal
      // creation failed ENOENT and the goal was rolled back with no error.
      await writeFile(join(second, 'state.json.ledger.jsonl'), '{}\n', 'utf8');
      expect(
        await Bun.file(join(second, 'state.json.ledger.jsonl')).exists(),
      ).toBe(true);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

describe('enumerating the sessions at startup', () => {
  test('no sessions directory is an empty list, not an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-list-empty-'));
    try {
      expect(await listSessionIDs(root)).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test('every session directory is listed, sorted, and only directories count', async () => {
    // Sorted so startup is deterministic and a failure reproduces — the reason
    // recovery bugs are hard to chase is that they are not.
    const root = await mkdtemp(join(tmpdir(), 'session-list-'));
    try {
      for (const id of ['ses-c', 'ses-a', 'ses-b'])
        await mkdir(sessionStatePaths(root, id).sessionDir, {recursive: true});
      // Two different rejections, and the distinction matters: `ses_stray` is a
      // FILE whose name PASSES the charset, so only the directory check can
      // exclude it — a decoy like `stray.txt` would be excluded by the charset
      // and the filter would be unpinned. `has space` is a directory whose name
      // fails the charset, so only the guard can exclude it.
      await writeFile(join(root, 'sessions', 'ses_stray'), 'x', 'utf8');
      await mkdir(join(root, 'sessions', 'has space'), {recursive: true});
      await writeFile(join(root, 'sessions', 'not-a-state.txt'), 'x', 'utf8');
      expect(await listSessionIDs(root)).toEqual(['ses-a', 'ses-b', 'ses-c']);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  test("a session's id cannot make its own directory escape the root", async () => {
    // Belt to the guard's braces: every listed id came back through the same
    // check, and resolving it stays under the sessions directory.
    const root = await mkdtemp(join(tmpdir(), 'session-list-escape-'));
    try {
      await mkdir(sessionStatePaths(root, 'ses-safe').sessionDir, {
        recursive: true,
      });
      for (const id of await listSessionIDs(root)) {
        const {statePath} = sessionStatePaths(root, id);
        const rel = relative(join(root, 'sessions'), statePath);
        expect(rel.startsWith('..')).toBe(false);
        expect(rel.split(sep).length).toBe(2); // <sessionID>/state.json
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

describe('a symlinked session DIRECTORY is refused at every layer that can reach it', () => {
  // `appendWalEntry` already refuses a symlinked LEDGER LEAF atomically with
  // O_NOFOLLOW (`src/persistence.ts`), and `portableWriteFile` stages through a
  // temp sibling and renames, so a symlinked SNAPSHOT leaf cannot be written
  // through either. What none of those cover is a symlink on a path segment
  // ABOVE the leaf — and `mkdir -p` follows one, which is how a session directory
  // that is a symlink lands outside the root while every leaf-level guard reports
  // the file as safe.
  //
  // These cases drive the manager directly, because `plugin-runtime.ts` and
  // `ensureSessionDir` are two of the three gates and the third is the manager's
  // own caller — a test that only exercised the plugin would never reach it.
  const managerFor = (root: string): SessionStateManager => {
    const runtime = createRuntimeState();
    return new SessionStateManager(
      runtime,
      async () => true,
      root,
      undefined,
      new Map<string, readonly string[]>(),
      async () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      DEFAULT_GOAL_OPTIONS,
      async () => {},
    );
  };

  test("the manager's create writes nothing into a symlinked session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-dir-'));
    const outside = await mkdtemp(join(tmpdir(), 'manager-dir-outside-'));
    try {
      await mkdir(join(root, 'sessions'), {recursive: true});
      await symlink(outside, join(root, 'sessions', 'ses_evil'), 'dir');

      const manager = managerFor(root);
      manager.createGoal('ses_evil', 'objective', {});
      await manager.drainWalWrites();

      // Nothing outside: no lock, no ledger, no snapshot. This is the shape the
      // leaf-level guards cannot see, because every leaf they check is a regular
      // file — reached through a directory that is not.
      expect(await readdir(outside)).toEqual([]);

      // CONTROL: a real session on the same manager writes normally, so this is
      // about the symlinked directory and not about the manager refusing writes.
      manager.createGoal('ses_ok', 'objective', {});
      await manager.drainWalWrites();
      const ledger = await Bun.file(
        sessionStatePaths(root, 'ses_ok').ledgerPath,
      ).text();
      expect(ledger).toContain('"phase":"committed"');
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  });

  test('the LEAF symlinks are already refused, by a stronger guard than containment', async () => {
    // Recorded so the containment guard is not mistaken for the only thing holding
    // this line, and so a future reader does not re-add a weaker duplicate:
    // `appendWalEntry` refuses a symlinked ledger with O_NOFOLLOW (atomically, no
    // TOCTOU window) and `portableWriteFile` stages through a temp sibling and
    // renames, which replaces the directory entry rather than following a link.
    // Both were verified by mutation before this test existed: removing the
    // guards from `session-state-manager.ts` left the whole suite green, which is
    // what showed the leaf was already covered elsewhere.
    const root = await mkdtemp(join(tmpdir(), 'manager-leaf-'));
    const outside = await mkdtemp(join(tmpdir(), 'manager-leaf-outside-'));
    try {
      const evil = sessionStatePaths(root, 'ses_leaf');
      await mkdir(evil.sessionDir, {recursive: true});
      const ledgerVictim = join(outside, 'stolen.jsonl');
      await writeFile(ledgerVictim, '', 'utf8');
      await symlink(ledgerVictim, evil.ledgerPath);
      await symlink(join(outside, 'stolen.json'), evil.statePath);

      const manager = managerFor(root);
      manager.createGoal('ses_leaf', 'objective', {});
      await manager.drainWalWrites();
      await manager.persist('ses_leaf');

      expect(await Bun.file(ledgerVictim).text()).toBe('');
      expect(await Bun.file(join(outside, 'stolen.json')).exists()).toBe(false);
      expect(await readdir(outside)).toEqual(['stolen.jsonl']);
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  });
});
