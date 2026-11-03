// handback-deliverables.test.ts — Contract tests for handback deliverables:
// - Reviewable diff generation with file statistics
// - Known-risk sites enumeration (db migrations, auth/security, env secrets, persistence)
// - External-review payload generation (byte-for-byte reproducible)
// - /goal handback and /goal review subcommand integration
// - Live workspace run touching files incl. a migration verifying end-to-end handback output

import {afterEach, beforeEach, describe, expect, it} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  buildExternalReviewPayload,
  buildHandbackDeliverable,
  generateReviewableDiff,
  parseDiffStat,
  type ReviewableDiff,
  scanRiskSites,
} from '../src/handback.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {type CommandSessionContext, handleCommand} from '../src/commands.ts';

describe('Handback Deliverables: Reviewable Diff + Risk Sites + External Review Payload', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'goal-handback-test-'));
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, {recursive: true, force: true});
    } catch {
      // ignore
    }
  });

  // 1. Known-Risk Sites Enumeration

  it('identifies DB migrations, auth/security, env secrets, and persistence schema risk sites', () => {
    const files = [
      'src/utils.ts',
      'db/migrations/001_create_users.sql',
      'prisma/schema.prisma',
      'src/auth/jwt.ts',
      'config/secrets.json',
      '.env.production',
      'src/state-machine.ts',
      'test/calc.test.ts',
    ];

    const riskSites = scanRiskSites(files);

    const dbMigrations = riskSites.filter(r => r.category === 'db-migration');
    expect(dbMigrations.length).toBe(2);
    expect(
      dbMigrations.some(r => r.file === 'db/migrations/001_create_users.sql'),
    ).toBe(true);
    expect(dbMigrations.some(r => r.file === 'prisma/schema.prisma')).toBe(
      true,
    );

    const authSites = riskSites.filter(r => r.category === 'auth-security');
    expect(authSites.length).toBe(1);
    expect(authSites[0].file).toBe('src/auth/jwt.ts');

    const envSites = riskSites.filter(r => r.category === 'env-secrets');
    expect(envSites.length).toBe(2);
    expect(envSites.some(r => r.file === 'config/secrets.json')).toBe(true);
    expect(envSites.some(r => r.file === '.env.production')).toBe(true);

    const persistenceSites = riskSites.filter(
      r => r.category === 'persistence-schema',
    );
    expect(persistenceSites.length).toBe(1);
    expect(persistenceSites[0].file).toBe('src/state-machine.ts');

    // Non-risk files must not be included
    expect(riskSites.some(r => r.file === 'src/utils.ts')).toBe(false);
    expect(riskSites.some(r => r.file === 'test/calc.test.ts')).toBe(false);
  });

  // 2. Diff Stat Parsing

  it('parses git diff --stat output into structured file lists and insertion/deletion counts', () => {
    const sampleStat = `
 src/handback.ts        | 150 +++++++++++++++++++++++++++++++++++++++++++
 db/migrations/001.sql  |  45 +++++++++++++
 src/utils.ts           |  12 ++--
 3 files changed, 201 insertions(+), 6 deletions(-)
`;
    const parsed = parseDiffStat(sampleStat);
    expect(parsed.files).toEqual([
      'src/handback.ts',
      'db/migrations/001.sql',
      'src/utils.ts',
    ]);
    expect(parsed.insertions).toBe(201);
    expect(parsed.deletions).toBe(6);
  });

  // 3. External Review Payload (Byte-for-Byte Reproducibility)

  it('generates paste-ready external review payload that is byte-for-byte reproducible on repeat calls', () => {
    const diff: ReviewableDiff = {
      files: ['db/migrations/001_users.sql', 'src/auth/jwt.ts'],
      insertions: 55,
      deletions: 10,
      stat: 'db/migrations/001_users.sql | 45 +++\nsrc/auth/jwt.ts | 20 ++--',
      patch:
        'diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts\n+export const verifyToken = () => true;',
      riskSites: scanRiskSites([
        'db/migrations/001_users.sql',
        'src/auth/jwt.ts',
      ]),
    };

    const payload1 = buildExternalReviewPayload({
      goalId: 'goal-auth-migration',
      objective: 'Add users table migration and JWT auth validation',
      status: 'complete',
      diff,
      totalTokens: 15400,
      turnCount: 5,
    });

    const payload2 = buildExternalReviewPayload({
      goalId: 'goal-auth-migration',
      objective: 'Add users table migration and JWT auth validation',
      status: 'complete',
      diff,
      totalTokens: 15400,
      turnCount: 5,
    });

    // Byte-for-byte equality check
    expect(payload1.rawPayload).toBe(payload2.rawPayload);

    // Structural checks
    expect(payload1.rawPayload).toContain('# External Code Review Request');
    expect(payload1.rawPayload).toContain('Goal ID:** `goal-auth-migration`');
    expect(payload1.rawPayload).toContain(
      'Add users table migration and JWT auth validation',
    );
    expect(payload1.rawPayload).toContain('db/migrations/001_users.sql');
    expect(payload1.rawPayload).toContain('src/auth/jwt.ts');
    expect(payload1.rawPayload).toContain(
      '+export const verifyToken = () => true;',
    );
    expect(payload1.rawPayload).toContain('Verification Checklist');
  });

  // 4. Complete Handback Deliverable Assembly

  it('builds a complete HandbackDeliverable containing goal state, claims, and review payload', async () => {
    const goal = createGoalState('session-1', 'Refactor core API', {
      goalId: 'goal-api-1',
    });
    goal.totalTokens = 8500;
    goal.turnCount = 3;
    goal.status = 'complete';

    const deliverable = await buildHandbackDeliverable(goal);

    expect(deliverable.goalId).toBe('goal-api-1');
    expect(deliverable.sessionID).toBe('session-1');
    expect(deliverable.condition).toBe('Refactor core API');
    expect(deliverable.status).toBe('complete');
    expect(deliverable.totalTokens).toBe(8500);
    expect(deliverable.turnCount).toBe(3);
    expect(deliverable.externalReviewPayload).toContain('Refactor core API');
  });

  // 5. Slash Command Integration (/goal handback and /goal review)

  it('handles /goal handback and /goal review subcommands correctly', async () => {
    const goal = createGoalState('session-cmd', 'Implement migration flow', {
      goalId: 'goal-mig',
    });
    const machine = new GoalStateMachine(goal);

    const session: CommandSessionContext = {
      sessionID: 'session-cmd',
      // Isolated, EMPTY workspace. Without this the command diffs process.cwd,
      // so the test's runtime scales with the developer's untracked file count:
      // measured 673-750 ms in a clean tree but >5 s (bun's default per-test
      // timeout) in a copy carrying 172 untracked files, which is the recorded
      // 5001 ms SUITE-FLAKE-1 signature.
      workspaceDirectory: tmpDir,
      getMachine: () => machine,
      listActiveGoals: () => [machine.snapshot()],
      listArchivedResults: () => [],
      createGoal: () => machine,
      replaceGoals: async () => machine,
      removeGoal: async () => {},
      clearSession: () => {},
      focusGoal: async () => ({ok: true as const, machine}),
      addOrderedSession: () => {},
      isOrdered: () => false,
      persist: async () => true,
    };

    // Test /goal handback
    const handbackOutput = await handleCommand('handback', session);
    expect(handbackOutput).toContain(
      '# Handback Deliverable for Goal [goal-mig]',
    );
    expect(handbackOutput).toContain('Objective: Implement migration flow');
    expect(handbackOutput).toContain('# External Code Review Request');

    // Test /goal review
    const reviewOutput = await handleCommand('review', session);
    expect(reviewOutput).toContain('# External Code Review Request');
    expect(reviewOutput).toContain('Goal ID:** `goal-mig`');

    // Test /goal review-payload
    const reviewPayloadOutput = await handleCommand('review-payload', session);
    expect(reviewPayloadOutput).toContain('# External Code Review Request');
  });

  it('diffs the SESSION workspace, not process.cwd()', async () => {
    // The goal's workspace is a git repo distinct from the process cwd, and it
    // has exactly ONE change: one untracked file. Handback and review must
    // describe the WORKSPACE. Reading process.cwd instead made the output
    // depend on where the plugin was launched from — measured, it reported the
    // host repository's own 53 changed files while the workspace had 1 — and
    // made the runtime scale with the developer's untracked file count, the
    // ambient-state dependence behind a >5 s suite timeout in a tree carrying
    // untracked files while the clean repo ran in ~700 ms.
    spawnSync('git', ['init'], {cwd: tmpDir});
    spawnSync('git', ['config', 'user.email', 'implementer@test.local'], {
      cwd: tmpDir,
    });
    spawnSync('git', ['config', 'user.name', 'Implementer'], {cwd: tmpDir});
    await writeFile(join(tmpDir, 'baseline.txt'), 'baseline\n', 'utf8');
    spawnSync('git', ['add', 'baseline.txt'], {cwd: tmpDir});
    spawnSync('git', ['commit', '-m', 'baseline'], {cwd: tmpDir});
    await writeFile(
      join(tmpDir, 'goal-touched.txt'),
      'work done by the goal\n',
      'utf8',
    );

    const goal = createGoalState(
      'session-ws',
      'work in the session workspace',
      {goalId: 'goal-ws'},
    );
    const machine = new GoalStateMachine(goal);
    const session: CommandSessionContext = {
      sessionID: 'session-ws',
      workspaceDirectory: tmpDir,
      getMachine: () => machine,
      listActiveGoals: () => [machine.snapshot()],
      listArchivedResults: () => [],
      createGoal: () => machine,
      replaceGoals: async () => machine,
      removeGoal: async () => {},
      clearSession: () => {},
      focusGoal: async () => ({ok: true as const, machine}),
      addOrderedSession: () => {},
      isOrdered: () => false,
      persist: async () => true,
    };

    // Assert ONLY inside the summary header, never against the whole output.
    // The payload embeds the diff text, and a process-cwd diff contains this
    // very test file (it is modified in the working tree), so any literal
    // expected value would be echoed back by the patch body and pass for the
    // wrong reason. Slicing at the first fenced block keeps the assertion on
    // the computed header alone.
    const summaryOf = (text: string): string => {
      const fence = text.indexOf('```');
      return fence === -1 ? text : text.slice(0, fence);
    };

    const handback = await handleCommand('handback', session);
    // The COUNT is the discriminator, and it is read from the header only.
    expect(summaryOf(handback)).toContain('Files changed: 1');
    expect(handback).toContain('goal-touched.txt');

    const review = await handleCommand('review', session);
    expect(summaryOf(review)).toContain('Files changed: 1');
    expect(review).toContain('goal-touched.txt');
  });

  // 6. Live Git Run with Migration File (Literal Acceptance Test)

  it('performs live run touching files including a DB migration and generates complete reviewable diff and risk sites', async () => {
    // 1. Initialize git repo in tmpDir
    spawnSync('git', ['init'], {cwd: tmpDir});
    spawnSync('git', ['config', 'user.email', 'implementer@test.local'], {
      cwd: tmpDir,
    });
    spawnSync('git', ['config', 'user.name', 'Implementer'], {cwd: tmpDir});

    // Create baseline file and initial commit
    await writeFile(join(tmpDir, 'README.md'), '# Initial Workspace\n', 'utf8');
    spawnSync('git', ['add', 'README.md'], {cwd: tmpDir});
    spawnSync('git', ['commit', '-m', 'Initial commit'], {cwd: tmpDir});

    // 2. Perform live run modifications touching files including a migration
    const migDir = join(tmpDir, 'db', 'migrations');
    await mkdir(migDir, {recursive: true});
    const migrationFile = join(migDir, '20260822_add_roles.sql');
    await writeFile(
      migrationFile,
      "ALTER TABLE users ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user';\nCREATE INDEX idx_users_role ON users(role);\n",
      'utf8',
    );

    const appFile = join(tmpDir, 'app.ts');
    await writeFile(
      appFile,
      'export const getRole = (user: { role: string }) => user.role;\n',
      'utf8',
    );

    // 3. Generate reviewable diff from workspace
    const diff = await generateReviewableDiff(tmpDir);

    expect(diff.files.length).toBe(2);
    expect(diff.files.some(f => f.includes('20260822_add_roles.sql'))).toBe(
      true,
    );
    expect(diff.files.some(f => f.includes('app.ts'))).toBe(true);
    expect(diff.insertions).toBeGreaterThan(0);

    // 4. Verify migration is enumerated under known-risk sites
    expect(diff.riskSites.length).toBe(1);
    expect(diff.riskSites[0].category).toBe('db-migration');
    expect(diff.riskSites[0].file).toContain('20260822_add_roles.sql');
    expect(diff.riskSites[0].description).toContain('Database migration');

    // 5. Assemble handback deliverable and verify external review payload
    const goal = createGoalState(
      'session-live',
      'Add role migration and user role accessor',
      {
        goalId: 'goal-live-migration',
      },
    );
    goal.totalTokens = 12000;
    goal.turnCount = 4;
    goal.status = 'complete';

    const deliverable = await buildHandbackDeliverable(goal, tmpDir);

    expect(deliverable.diff.files.length).toBe(2);
    expect(deliverable.diff.riskSites.length).toBe(1);
    expect(deliverable.externalReviewPayload).toContain(
      'Goal ID:** `goal-live-migration`',
    );
    expect(deliverable.externalReviewPayload).toContain(
      '20260822_add_roles.sql',
    );
    expect(deliverable.externalReviewPayload).toContain(
      'ALTER TABLE users ADD COLUMN role',
    );
    expect(deliverable.externalReviewPayload).toContain('[db-migration]');
    expect(deliverable.externalReviewPayload).toContain(
      'Verification Checklist',
    );

    // 6. Test byte-for-byte reproducibility
    const deliverable2 = await buildHandbackDeliverable(goal, tmpDir);
    expect(deliverable.externalReviewPayload).toBe(
      deliverable2.externalReviewPayload,
    );
  });
});
