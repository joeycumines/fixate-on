// invariant-harness.test.ts — Contract tests for invariant harness:
// - L1 invariant harness across all writer paths
// - Single-writer exclusivity and WAL / snapshot consistency
// - Legal transitions only across tools, slash commands, TUI, and recovery
// - Deliberate invariant-violation probes (mutation-sensitivity checks):
// * Probe 1: Brake tiering rejects agent ceiling modifications
// * Probe 2: an un-cited pressure message construction throws
// * Probe 3: Unverifiable claims never render as verified complete
// * Probe 4: Truthful hydration and outcome neutrality
// - Standing directive and verification-pressure section present in steering templates

/** The session whose state file these fixtures write; a companion reads every
 * session, so one is enough, and naming it keeps the layout visible here. */

import {afterEach, beforeEach, describe, expect, it} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createGoalState,
  GoalStateMachine,
  type GoalStatus,
  TRANSITION_TABLE,
} from '../src/state-machine.ts';
import {type CommandSessionContext, handleCommand} from '../src/commands.ts';
import {buildPressureMessage} from '../src/recovery-pressure.ts';
import {buildContinueMessage, buildSystemBlock} from '../src/steering.ts';
import {createTuiStateStore} from '../src/tui-state.ts';
import {hydrateStoreFromDisk} from '../src/tui-disk-state.ts';
import {buildHandbackDeliverable} from '../src/handback.ts';

describe('Invariant harness: core invariants and the product prompt surface', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'goal-invariant-test-'));
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, {recursive: true, force: true});
    } catch {
      // ignore
    }
  });

  // 1. Legal State Machine Transitions Invariant

  it('strictly enforces legal transition DAG across all possible source transitions', async () => {
    const allStatuses: GoalStatus[] = [
      'active',
      'paused',
      'finalizing',
      'complete',
      'budgetLimited',
    ];

    for (const fromStatus of allStatuses) {
      for (const toStatus of allStatuses) {
        const goal = createGoalState(
          'session-trans',
          'Test transition matrix',
          {goalId: `goal-${fromStatus}-${toStatus}`},
        );
        goal.status = fromStatus;
        const machine = new GoalStateMachine(goal);

        const isAllowed =
          TRANSITION_TABLE.get(fromStatus)?.has(toStatus) ?? false;
        const result = await machine.transition(toStatus, {
          source: 'update_goal',
          detail: 'Matrix test',
        });

        if (isAllowed) {
          expect(result.ok).toBe(true);
          expect(machine.snapshot().status).toBe(toStatus);
        } else {
          expect(result.ok).toBe(false);
          expect(machine.snapshot().status).toBe(fromStatus);
        }
      }
    }
  });

  // 2. Deliberate Invariant Violation Probes (Mutation-Sensitivity Checks)

  it('PROBE 1: Brake tiering rejects agent ceiling modifications', async () => {
    const goal = createGoalState('session-brake', 'Brake test', {
      goalId: 'goal-brake',
      maxTurns: 10,
      tokenBudget: 50000,
    });
    const machine = new GoalStateMachine(goal);

    // Agent source attempting to mutate ceiling must be rejected
    const mutResult = await machine.mutate(
      g => {
        g.maxTurns = 100;
      },
      {source: 'update_goal', detail: 'Agent trying to expand turn ceiling'},
    );

    expect(mutResult.ok).toBe(false);
    expect(mutResult.error).toContain(
      'Brakes (turn/token/duration/blocked ceilings) are contract-tier',
    );
    expect(machine.snapshot().maxTurns).toBe(10);
  });

  it('PROBE 2: an un-cited pressure message construction throws', () => {
    expect(() => {
      buildPressureMessage({
        goalId: 'goal-uncited',
        recoveryTurns: 1,
        maxRecoveryTurns: 12,
        citation: {
          claimText: '',
          outstanding: [],
          evidence: [],
          stalledTurns: 0,
        },
      });
    }).toThrow(
      'A pressure message cannot be constructed without an evidence citation',
    );
  });

  it('PROBE 3: Unverifiable claims never render as verified-complete in displays or state', async () => {
    const goal = createGoalState('session-claim', 'Unverified claim test', {
      goalId: 'goal-unverified',
    });
    const machine = new GoalStateMachine(goal);

    // Record an unverified claim
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: 'I finished everything without running verifier',
      check: {
        path: 'none',
        verdict: 'NONE',
        timestamp: Date.now(),
      },
      outcome: {
        status: 'unverifiable-claim',
        detail: 'No verifier run executed',
        timestamp: Date.now(),
      },
    });

    const snapshot = machine.snapshot();
    expect(snapshot.lastClaim?.outcome.status).toBe('unverifiable-claim');

    const session: CommandSessionContext = {
      sessionID: 'session-claim',
      getMachine: () => machine,
      listActiveGoals: () => [snapshot],
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

    const statusOutput = await handleCommand('status', session);
    expect(statusOutput).not.toContain('Verified Complete');
    // F8a: the default surface carries the PLAIN sentence; the raw enum is
    // demoted to the verbose detail line. Neither may ever read as plain
    // verified completion.
    expect(statusOutput).toContain(
      'Done, but no attestation could be obtained',
    );
    // The invariant is that neither surface reads as plain verified completion,
    // and that the claim's QUALITY is stated. The literal ledger token is no
    // longer the display word: the authoritative vocabulary collapsed it, so the
    // verbose line names the quality ("unattested") and keeps the ledger's exact
    // status only where machines read it.
    const verboseOutput = await handleCommand('status --verbose', session);
    expect(verboseOutput).toContain('[unattested]');
    expect(verboseOutput).not.toContain('verified-complete');
  });

  it("PROBE 4: Truthful hydration prevents false-empty 'No active goals' displays", async () => {
    const goalsDir = join(
      tmpDir,
      '.opencode',
      'goals',
      'sessions',
      'session-truth',
    );
    await mkdir(goalsDir, {recursive: true});
    const stateFile = join(goalsDir, 'state.json');

    const persistedState = {
      version: 1,
      goals: [
        {
          goalId: 'goal-hydrated-true',
          sessionID: 'session-truth',
          condition: 'Port auth module',
          status: 'active',
          revision: 1,
          turnCount: 2,
          totalTokens: 5000,
          maxTokens: 200000,
          maxTurns: 10,
          tokenBudget: null,
          usage: {
            input: 4000,
            output: 1000,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            costKnown: false,
          },
          stopReason: '',
          blockedReason: '',
          createdAt: 1000,
          updatedAt: 2000,
          finishedAt: null,
          lastCheckpoint: null,
          history: [],
        },
      ],
      results: [],
      sessionOrdered: false,
    };

    await writeFile(stateFile, JSON.stringify(persistedState, null, 2), 'utf8');

    const store = createTuiStateStore();
    const {hydratedCount} = await hydrateStoreFromDisk(store, tmpDir);

    expect(hydratedCount).toBe(1);
    const snapshots = store.getSnapshots('session-truth');
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].condition).toBe('Port auth module');
  });

  // 3. Prompt surface verifications

  it('verifies steering templates carry NO standing directive and keep the verification-pressure section', () => {
    const goal = createGoalState(
      'session-steer',
      'Verify steering prompt surface',
      {goalId: 'goal-steer'},
    );
    const prompt = buildContinueMessage(goal);

    // The manipulative standing-directive quote was pruned 2026-11-01
    // (user ruling): neither the continuation message nor the system block
    // may carry it, in any spelling.
    expect(prompt).not.toContain('STANDING DIRECTIVE');
    expect(prompt).not.toContain('Standing Directive');
    expect(prompt).not.toContain('NUMEROUS and VARIED');

    // Must contain the verification-pressure section
    expect(prompt).toContain('Verification pressure:');
    expect(prompt).toContain(
      'Pressure is a prompt to pay deeper attention, inspect authoritative evidence directly, and sustain effort',
    );
    expect(prompt).toContain(
      'If evidence cited against a claim is shown inaccurate, a visible retraction is issued and recorded.',
    );

    // System block must not carry the standing directive either
    const sysBlock = buildSystemBlock(goal, 'goal');
    expect(sysBlock).not.toContain('Standing Directive');
    expect(sysBlock).not.toContain('NUMEROUS and VARIED');
  });

  // 4. Cross-Writer Interleaving Invariant

  it('maintains state consistency across interleaved human commands and agent tools', async () => {
    const goal = createGoalState(
      'session-interleave',
      'Cross-writer interleave test',
      {goalId: 'goal-int'},
    );
    const machine = new GoalStateMachine(goal);

    const session: CommandSessionContext = {
      sessionID: 'session-interleave',
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

    // 1. Human pauses via command
    const pauseMsg = await handleCommand('pause', session);
    expect(pauseMsg).toContain('Goal paused');
    expect(machine.snapshot().status).toBe('paused');

    // 2. Human resumes via command
    const resumeMsg = await handleCommand('resume', session);
    expect(resumeMsg).toContain('Goal resumed');
    expect(machine.snapshot().status).toBe('active');

    // 3. Agent cannot mutate brakes
    const agentMutateBrake = await machine.mutate(
      g => {
        g.maxTurns = 999;
      },
      {source: 'update_goal', detail: 'Agent trying to expand turn ceiling'},
    );
    expect(agentMutateBrake.ok).toBe(false);
    expect(machine.snapshot().maxTurns).toBe(goal.maxTurns);

    // 4. Agent proposes change through propose-and-receipt channel
    await machine.mutate(
      g => {
        g.pendingProposal = {
          proposalId: 'prop-1',
          proposedAt: Date.now(),
          objective: 'Updated interleave objective',
          reason: 'Need expanded scope',
        };
      },
      {source: 'propose_goal_change', detail: 'Propose objective expansion'},
    );
    expect(machine.snapshot().pendingProposal?.proposalId).toBe('prop-1');

    // 5. Human accepts proposal via command
    const acceptMsg = await handleCommand('accept prop-1', session);
    expect(acceptMsg).toContain('Accepted proposal [prop-1]');
    expect(machine.snapshot().condition).toBe('Updated interleave objective');
    expect(machine.snapshot().pendingProposal).toBeNull();

    // 6. Deliverables generated consistently
    const deliverable = await buildHandbackDeliverable(machine.snapshot());
    expect(deliverable.condition).toBe('Updated interleave objective');
    expect(deliverable.status).toBe('active');
  });
});
