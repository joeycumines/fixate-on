// HANDBACK-SCOPE-1: the handback diff must be RUN-SCOPED, not worktree-wide.
//
// Acceptance: after a goal run that modifies 2 files in a project carrying 50
// other uncommitted changes, the deliverable's diff contains ONLY those 2 files,
// risk sites are scanned over the scoped set, and the external-review payload
// carries the scoped summary.
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  buildHandbackDeliverable,
  captureRunBaseline,
  generateReviewableDiff,
} from '../src/handback.ts';
import {createGoalState} from '../src/state-machine.ts';

let dir = '';
const git = (...args: string[]) =>
  spawnSync('git', args, {cwd: dir, encoding: 'utf8'});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goal-handback-scope-'));
  git('init', '-q', '.');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  await mkdir(join(dir, 'src'), {recursive: true});
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1\n');
  await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 1\n');
  await writeFile(join(dir, 'unrelated.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  // 50 pre-existing uncommitted changes the goal is NOT responsible for.
  let dirty = '';
  for (let i = 0; i < 50; i++) dirty += `dirty line ${i}\n`;
  await writeFile(join(dir, 'unrelated.txt'), 'base\n' + dirty);

  // A pre-existing untracked file the goal will never touch.
  await writeFile(join(dir, 'already-here.tmp'), "user's own scratch\n");
});

afterAll(async () => {
  if (dir) await rm(dir, {recursive: true, force: true});
});

test('the baseline is captured without mutating the worktree', async () => {
  const before = spawnSync('git', ['status', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout;
  const baseline = await captureRunBaseline(dir);
  const after = spawnSync('git', ['status', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout;
  expect(baseline).not.toBeNull();
  expect(baseline!.ref).not.toBe('');
  expect(after).toBe(before); // capture is read-only
});

test("only the goal's 2 files appear, despite 50 unrelated changes", async () => {
  const baseline = await captureRunBaseline(dir);

  // The "goal run": modify 2 tracked files and create 1 new file.
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 2\n');
  await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2\n');
  await writeFile(join(dir, 'src', 'new.ts'), 'export const n = 1\n');

  const goal = createGoalState('s1', 'change a and b', {
    goalId: 'g1',
    runId: 'r1',
    maxTokens: 1,
    maxTurns: 1,
    maxDurationMs: 1,
  });
  const deliverable = await buildHandbackDeliverable({...goal, baseline}, dir);

  const files = [...deliverable.diff.files].sort();
  expect(files).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts']);
  // The unrelated dirty file and the user's pre-existing untracked file are absent.
  expect(files).not.toContain('unrelated.txt');
  expect(files).not.toContain('already-here.tmp');
  // The patch mentions only the scoped paths.
  expect(deliverable.diff.patch).toContain('src/a.ts');
  expect(deliverable.diff.patch).not.toContain('unrelated.txt');
  expect(deliverable.externalReviewPayload).toContain('src/a.ts');
  expect(deliverable.externalReviewPayload).not.toContain('unrelated.txt');
});

test('a file the goal CREATES has its CONTENT in the patch, not just its name', async () => {
  // `git diff <base>` cannot render an untracked file: it is not in the index, so
  // no hunk names it. The scoped set therefore listed created files with NO
  // content, and a reviewer received a path with no diff — the opposite of a
  // "complete reviewable diff". Measured on the real harness workspace: a goal
  // that created one file produced `files: ["goal-artifact-a.txt"]` with
  // `patch: ""`.
  const baseline = await captureRunBaseline(dir);
  await writeFile(join(dir, 'src', 'created.ts'), 'export const created = 1\n');
  const goal = createGoalState('s1', 'create a file', {
    goalId: 'g3',
    runId: 'r3',
    maxTokens: 1,
    maxTurns: 1,
    maxDurationMs: 1,
  });
  const deliverable = await buildHandbackDeliverable({...goal, baseline}, dir);

  expect(deliverable.diff.files).toContain('src/created.ts');
  // The CONTENT is what makes it reviewable.
  expect(deliverable.diff.patch).toContain('src/created.ts');
  expect(deliverable.diff.patch).toContain('export const created = 1');
  // And the external-review payload carries it too.
  expect(deliverable.externalReviewPayload).toContain('src/created.ts');
  // The unrelated pre-existing file is still excluded.
  expect(deliverable.diff.patch).not.toContain('unrelated.txt');
});

test('risk sites are scanned over the SCOPED set only', async () => {
  const baseline = await captureRunBaseline(dir);
  // A migration-shaped file the goal creates, plus a dirty non-risk file.
  await mkdir(join(dir, 'db', 'migrations'), {recursive: true});
  await writeFile(
    join(dir, 'db', 'migrations', '001_x.sql'),
    'ALTER TABLE t ADD COLUMN c int;\n',
  );
  const goal = createGoalState('s1', 'add a migration', {
    goalId: 'g2',
    runId: 'r2',
    maxTokens: 1,
    maxTurns: 1,
    maxDurationMs: 1,
  });
  const deliverable = await buildHandbackDeliverable({...goal, baseline}, dir);
  const paths = deliverable.diff.riskSites.map(r => r.file);
  expect(paths).toContain('db/migrations/001_x.sql');
  expect(paths.every(p => deliverable.diff.files.includes(p))).toBe(true);
});

test('a pre-existing untracked file the goal MODIFIES does appear', async () => {
  const baseline = await captureRunBaseline(dir);
  await writeFile(
    join(dir, 'already-here.tmp'),
    "user's own scratch\n+ goal appended\n",
  );
  const goal = createGoalState('s1', 'touch the scratch file', {
    goalId: 'g3',
    runId: 'r3',
    maxTokens: 1,
    maxTurns: 1,
    maxDurationMs: 1,
  });
  const deliverable = await buildHandbackDeliverable({...goal, baseline}, dir);
  expect(deliverable.diff.files).toContain('already-here.tmp');
});

test('without a baseline the previous whole-worktree behaviour is retained', async () => {
  const diff = await generateReviewableDiff(dir, [], null);
  // Legacy callers must keep seeing the full picture rather than an empty diff.
  expect(diff.files).toContain('unrelated.txt');
});
