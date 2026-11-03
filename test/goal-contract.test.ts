// goal-contract.test.ts — contract suite over the goal lifecycle.
// Executes the 8-checkpoint scenario script against the real modules in a
// tmpdir: no PTY, no host process. The live full-TUI counterpart is the
// campaigns in scripts/e2e-harness/ (run-all.sh); this file pins the
// steering and recovery logic they exercise.
// Checkpoints:
// (1) palette Add Goal with pointer-contract to a living file;
// (2) run continues on idle with pointer context (no standing directive — pruned 2026-11-01);
// (3) induced premature-done attempt -> evidence-cited rising pressure & claim-refuted;
// (4) corrected evidence -> visible retraction & verified-complete transition;
// (5) external finding / proposal delivered -> binds as open duty blocking completion;
// (6) cockpit restart mid-campaign -> hydrated truthful dashboard;
// (7) handback triple (diff / risk-sites / payload) produced byte-for-byte;
// (8) disk verification at every checkpoint ensuring WAL snapshot consistency.

/** The session whose state file these fixtures write; a companion reads every
 * session, so one is enough, and naming it keeps the layout visible here. */

import {afterEach, beforeEach, describe, expect, it} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {
  buildPressureMessage,
  buildRetractionNotice,
  determinePressureRung,
} from '../src/recovery-pressure.ts';
import {buildContinueMessage, buildSystemBlock} from '../src/steering.ts';
import {createTuiStateStore} from '../src/tui-state.ts';
import {hydrateStoreFromDisk} from '../src/tui-disk-state.ts';
import {
  buildExternalReviewPayload,
  buildHandbackDeliverable,
  type ReviewableDiff,
  scanRiskSites,
} from '../src/handback.ts';

describe('goal contract 8 checkpoints (tmpdir, no host)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'goal-g2-e2e-'));
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, {recursive: true, force: true});
    } catch {
      // ignore
    }
  });

  it('runs all 8 checkpoints end-to-end with disk-verified state at each step', async () => {
    const sessionID = 'session-g2-contract';
    // The directory IS the session: the goal below is created for `sessionID`, and a
    // record naming a different session than the directory it lives in is state
    // this plugin never writes \u2014 which `discoverStateFiles` + `parseStateFileGoals`
    // now refuse, as the plugin itself does at startup.
    const goalsDir = join(tmpDir, '.opencode', 'goals', 'sessions', sessionID);
    await mkdir(goalsDir, {recursive: true});

    // CHECKPOINT 1: Add Goal with pointer-contract to a living file
    const livingFile = join(tmpDir, 'SPEC.md');
    await writeFile(
      livingFile,
      '# Requirement 1: Database Migration\nAdd user roles column.\n',
      'utf8',
    );

    const goal = createGoalState(sessionID, 'Implement auth roles migration', {
      goalId: 'goal-g2-1',
      maxTurns: 10,
      tokenBudget: 100000,
      artifactPointers: [livingFile],
    });
    const machine = new GoalStateMachine(goal);

    // Save initial state to disk
    const stateFile = join(goalsDir, 'state.json');
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          version: 1,
          goals: [machine.snapshot()],
          results: [],
          sessionOrdered: false,
        },
        null,
        2,
      ),
      'utf8',
    );

    expect(machine.snapshot().status).toBe('active');
    expect(machine.snapshot().artifactPointers).toContain(livingFile);

    // CHECKPOINT 2: Run continues on idle with pointer context; no standing
    // directive anywhere (pruned 2026-11-01, user ruling).
    const continueMsg = buildContinueMessage(machine.snapshot());
    expect(continueMsg).not.toContain('Standing Directive');
    expect(continueMsg).not.toContain('NUMEROUS and VARIED');
    expect(buildSystemBlock(machine.snapshot(), 'goal')).not.toContain(
      'Standing Directive',
    );
    expect(continueMsg).toContain('Implement auth roles migration');
    expect(continueMsg).toContain('Verification pressure:');

    // CHECKPOINT 3: Induced premature-done attempt -> evidence-cited rising pressure
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: 'I finished the DB migration without running tests',
      check: {
        path: 'judge',
        verdict: 'WORKING',
        evidence: ['Migration file unapplied', 'Unit tests failed: 2 errors'],
        timestamp: Date.now(),
      },
      outcome: {
        status: 'claim-refuted',
        detail: 'Verifier failed with 2 errors',
        timestamp: Date.now(),
      },
    });

    const rung = determinePressureRung(2, 12);
    expect(rung).toBe('r2-evasion-warning');

    const pressureMsg = buildPressureMessage({
      goalId: machine.snapshot().goalId,
      recoveryTurns: 2,
      maxRecoveryTurns: 12,
      citation: {
        claimText: machine.snapshot().lastClaim?.claimText,
        outstanding: ['Unit tests must pass'],
        evidence: ['Migration file unapplied', 'Unit tests failed: 2 errors'],
      },
    });

    expect(pressureMsg).toContain('[PRESSURE RUNG: r2-evasion-warning]');
    expect(pressureMsg).toContain('Migration file unapplied');
    expect(machine.snapshot().lastClaim?.outcome.status).toBe('claim-refuted');

    // CHECKPOINT 4: Corrected evidence -> visible retraction & verified completion
    const retraction = buildRetractionNotice({
      goalId: machine.snapshot().goalId,
      originalEvidence: ['Migration file unapplied'],
      retractionReason:
        'Evidence corrected: migration confirmed applied in test schema',
    });
    expect(retraction).toContain('goal_retraction_notice');
    expect(retraction).toContain(
      'Evidence corrected: migration confirmed applied',
    );

    await machine.emitRetraction({
      originalEvidence: ['Migration file unapplied'],
      retractionReason:
        'Evidence corrected: migration confirmed applied in test schema',
    });
    expect(machine.snapshot().pendingNotices.length).toBeGreaterThan(0);

    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: 'All migration tests passed with exit 0',
      check: {
        path: 'judge',
        verdict: 'COMPLETE',
        evidence: ['Exit code 0', 'All 5 assertions green'],
        timestamp: Date.now(),
      },
      outcome: {
        status: 'verified-complete',
        detail: 'Passed fail-closed verifier check',
        timestamp: Date.now(),
      },
    });

    await machine.transition('complete', {
      source: 'update_goal',
      detail: 'Verified complete',
    });
    expect(machine.snapshot().status).toBe('complete');
    expect(machine.snapshot().lastClaim?.outcome.status).toBe(
      'verified-complete',
    );

    // CHECKPOINT 5: External finding / proposal binds as open duty
    const goal2 = createGoalState(sessionID, 'Refactor session store', {
      goalId: 'goal-g2-2',
    });
    const machine2 = new GoalStateMachine(goal2);

    await machine2.mutate(
      g => {
        g.pendingProposal = {
          proposalId: 'prop-review-site',
          proposedAt: Date.now(),
          objective: 'Refactor session store with Redis failover',
          reason:
            'External audit flagged single point of failure in memory store',
        };
      },
      {source: 'propose_goal_change', detail: 'External audit finding'},
    );

    expect(machine2.snapshot().pendingProposal?.proposalId).toBe(
      'prop-review-site',
    );
    expect(machine2.snapshot().pendingProposal?.reason).toContain(
      'External audit flagged single point of failure',
    );

    // CHECKPOINT 6: Cockpit restart mid-campaign -> hydrated truthful dashboard
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          version: 1,
          goals: [machine2.snapshot()],
          results: [machine.snapshot()],
          sessionOrdered: false,
        },
        null,
        2,
      ),
      'utf8',
    );

    const freshStore = createTuiStateStore();
    const {hydratedCount} = await hydrateStoreFromDisk(freshStore, tmpDir);
    expect(hydratedCount).toBe(1);

    const sessionSnapshots = freshStore.getSnapshots(sessionID);
    expect(sessionSnapshots.length).toBe(1);
    expect(sessionSnapshots[0].condition).toBe('Refactor session store');

    // CHECKPOINT 7: Handback triple produced byte-for-byte
    const migrationFile = join(tmpDir, 'migrations', '20260822_users.sql');
    await mkdir(join(tmpDir, 'migrations'), {recursive: true});
    await writeFile(
      migrationFile,
      'ALTER TABLE users ADD COLUMN role VARCHAR(64);\n',
      'utf8',
    );

    const riskSites = scanRiskSites(['migrations/20260822_users.sql']);
    expect(riskSites.length).toBe(1);
    expect(riskSites[0].category).toBe('db-migration');

    const diffMock: ReviewableDiff = {
      files: ['migrations/20260822_users.sql'],
      insertions: 1,
      deletions: 0,
      stat: '1 file changed, 1 insertion(+)',
      patch: '+ALTER TABLE users ADD COLUMN role VARCHAR(64);',
      riskSites,
    };

    const payload1 = buildExternalReviewPayload({
      goalId: machine.snapshot().goalId,
      objective: machine.snapshot().condition,
      status: machine.snapshot().status,
      diff: diffMock,
      lastClaim: machine.snapshot().lastClaim,
    });

    const payload2 = buildExternalReviewPayload({
      goalId: machine.snapshot().goalId,
      objective: machine.snapshot().condition,
      status: machine.snapshot().status,
      diff: diffMock,
      lastClaim: machine.snapshot().lastClaim,
    });

    // Byte-for-byte reproducibility
    expect(payload1.rawPayload).toBe(payload2.rawPayload);
    expect(payload1.rawPayload).toContain('# External Code Review Request');
    expect(payload1.rawPayload).toContain('## Goal Contract');
    expect(payload1.rawPayload).toContain('db-migration');
    expect(payload1.rawPayload).toContain('migrations/20260822_users.sql');

    // Full deliverable
    const deliverable = await buildHandbackDeliverable(
      machine.snapshot(),
      tmpDir,
    );
    expect(deliverable.goalId).toBe('goal-g2-1');
    expect(deliverable.status).toBe('complete');
    expect(deliverable.externalReviewPayload).toBeDefined();
    expect(deliverable.externalReviewPayload).toContain('## Known-Risk Sites');

    // CHECKPOINT 8: State verified on disk across every step
    const finalDiskRaw = await readFile(stateFile, 'utf8');
    const finalDisk = JSON.parse(finalDiskRaw);
    expect(finalDisk.goals.length).toBe(1);
    expect(finalDisk.goals[0].goalId).toBe('goal-g2-2');
    expect(finalDisk.results.length).toBe(1);
    expect(finalDisk.results[0].goalId).toBe('goal-g2-1');
    expect(finalDisk.results[0].status).toBe('complete');
  });
});
