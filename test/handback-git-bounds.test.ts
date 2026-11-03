// handback-git-bounds.test.ts — the plugin runs `git` under bounds, everywhere.
//
// `src/bounded-spawn.ts` states the invariant in its own header: "a process boundary
// wants exactly one implementation: one timeout, one output cap, one teardown". It was
// false. `handback.ts` had its own `spawn("git", …)` with no timeout, no abort signal, no
// process-group teardown and an uncapped stderr accumulator, and it was the only other
// `node:child_process` user in `src/`.
//
// The harm is not theoretical and it is on the host's critical path:
// `captureRunBaseline` is awaited inside the SYNCHRONOUS `chat.params` hook, and
// `needsBaseline` stays true forever in a non-git workspace, so it runs every turn. A
// `git` blocked on a lock file, a credential prompt, or a multi-gigabyte diff therefore
// stalls the model's turn with nothing to show for it — while `captureCandidateIdentity`
// caps the same class of probe at 5 s.
//
// The instrument is a `git` SHIM on PATH that never answers. It is a shim rather than a
// real repository because the property under test is what happens when git does not
// RETURN, and a real repository cannot be made to hang on demand.

import {describe, expect, test} from 'bun:test';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {captureRunBaseline, generateReviewableDiff} from '../src/handback.ts';

/**
 * A directory whose `git` never returns.
 *
 * `bun` resolves `execFile("git", …)` through PATH, so prepending this directory is
 * enough — no wrapper script, no shell, and nothing to clean up but the directory.
 */
async function hangingGitDir(sleepSeconds: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hanging-git-'));
  const shim = join(dir, 'git');
  await writeFile(shim, `#!/bin/sh\nsleep ${sleepSeconds}\nexit 0\n`, 'utf8');
  await chmod(shim, 0o755);
  return dir;
}

const REAL_PATH = process.env.PATH ?? '';

function withPath(dir: string): () => void {
  process.env.PATH = `${dir}${delimiter}${REAL_PATH}`;
  return () => {
    process.env.PATH = REAL_PATH;
  };
}

/**
 * The bound must be comfortably longer than a real `git` and shorter than the test's own
 * patience, or the assertion measures the harness rather than the plugin. 25 s of sleep
 * against a 10 s bound leaves a wide margin in both directions.
 */
const SHIM_SLEEP_SECONDS = 25;

/**
 * The ceiling on a call that makes several git invocations.
 *
 * The bound is PER INVOCATION, so it multiplies: `generateReviewableDiff` runs three
 * (`ls-files`, `diff --stat`, `diff`) and `captureRunBaseline` runs four plus one per
 * untracked file. That is stated in the constant's own comment rather than hidden,
 * because a single number cannot bound a whole capture and pretending otherwise would
 * be a brake that does not brake.
 *
 * It has to sit BELOW the shim's sleep, or the assertion measures the shim: with a 5 s
 * bound and three calls the worst case is ~15 s against a 25 s sleep, and this leaves a
 * wide margin in both directions.
 */
const MAX_TOTAL_MS = 20_000;

describe("the handback's git is bounded", () => {
  test('captureRunBaseline gives up on a git that never answers', async () => {
    const shim = await hangingGitDir(SHIM_SLEEP_SECONDS);
    const restore = withPath(shim);
    const started = Date.now();
    try {
      // A workspace that is not a git repository, so the only thing that can return is
      // the bound. The caller's hook AWAITS this, which is the whole problem.
      const baseline = await captureRunBaseline(
        await mkdtemp(join(tmpdir(), 'not-a-repo-')),
      );
      const elapsed = Date.now() - started;

      expect(
        baseline,
        'a git that never answered still produced a baseline',
      ).toBeNull();
      expect(
        elapsed,
        `the call took ${elapsed}ms, so it waited for git rather than for its own bound — ` +
          "an unbounded git in a synchronous hook stalls the model's turn",
      ).toBeLessThan(MAX_TOTAL_MS);
    } finally {
      restore();
      await rm(shim, {recursive: true, force: true});
    }
  }, 120_000);

  test('generateReviewableDiff gives up on a git that never answers', async () => {
    const shim = await hangingGitDir(SHIM_SLEEP_SECONDS);
    const restore = withPath(shim);
    const started = Date.now();
    try {
      const diff = await generateReviewableDiff(
        await mkdtemp(join(tmpdir(), 'not-a-repo-')),
      );
      const elapsed = Date.now() - started;

      // The deliverable still renders — the point is that it renders as EMPTY rather
      // than that it fails. A git that cannot answer is a workspace with no observable
      // change set, which is the same answer a failed git already produced.
      expect(
        Array.isArray(diff.files),
        'the deliverable did not render at all',
      ).toBe(true);
      expect(diff.files, 'a git that never answered produced files').toEqual(
        [],
      );
      expect(
        elapsed,
        `the call took ${elapsed}ms, so it waited for git rather than for its own bound`,
      ).toBeLessThan(MAX_TOTAL_MS);
    } finally {
      restore();
      await rm(shim, {recursive: true, force: true});
    }
  }, 120_000);
});

describe('the bound does not change what a working git produces', () => {
  // The control. Without it, "git that hangs returns nothing" would be satisfied by a
  // `runGit` that always returns nothing — which is a gate that cannot fail, and is the
  // shape this repository has been bitten by repeatedly.
  test('a real repository still produces its diff', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'handback-real-git-'));
    try {
      // Plain `git` rather than a shell wrapper: a fixture that sets up its own subject
      // with a different mechanism is one more thing that can be wrong, and the first
      // version of this test built the repository through `bun -e` with Bun's `$`, which
      // silently left no `.git` behind — so the control passed a repo git could not see.
      const git = async (...args: string[]): Promise<string> => {
        const proc = Bun.spawn(['git', ...args], {
          cwd: repo,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        if (proc.exitCode !== 0) {
          throw new Error(
            `git ${args.join(' ')} exited ${proc.exitCode}: ${err.slice(0, 400)}`,
          );
        }
        return out;
      };
      await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf8');
      await git('init', '-q');
      await git('add', 'tracked.txt');
      await git(
        '-c',
        'user.email=a@b',
        '-c',
        'user.name=t',
        'commit',
        '-qm',
        'base',
      );
      await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n', 'utf8');

      const diff = await generateReviewableDiff(repo);

      expect(
        diff.files,
        'a real git produced no files through the bounded runner',
      ).toContain('tracked.txt');
      expect(
        diff.insertions,
        'the real diff lost its insertions',
      ).toBeGreaterThan(0);
      expect(diff.patch, 'the real diff produced no patch').toContain('two');
    } finally {
      await rm(repo, {recursive: true, force: true});
    }
  }, 120_000);
});
