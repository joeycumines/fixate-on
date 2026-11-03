// recovery-pressure.test.ts — contract tests for the recovery pressure ladder:
// - rung progression (r -> r4) from the recovery turn count
// - no pressure message is constructed without a concrete evidence citation
// - a retraction notice is visible and cites the corrected evidence
// - escalation wording distinguishes strictly-infeasible from exhaustion
// - rung-3 structural constraint focuses on one unmet item at a time

import {describe, expect, it} from 'bun:test';
import {
  buildEscalationReason,
  buildPressureMessage,
  buildRetractionNotice,
  determinePressureRung,
  type PressureCitation,
  type RetractionNotice,
} from '../src/recovery-pressure.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {buildContinueMessage} from '../src/steering.ts';

describe('recovery pressure ladder: evidence-cited rungs and retraction notices', () => {
  // 1. Ladder Rung Progression (r -> r -> r -> r4)

  it('determines rungs accurately across recovery turn progression', () => {
    expect(determinePressureRung(1, 12)).toBe('r1-precise-demand');
    expect(determinePressureRung(2, 12)).toBe('r2-evasion-warning');
    expect(determinePressureRung(3, 12)).toBe('r2-evasion-warning');
    expect(determinePressureRung(4, 12)).toBe('r3-structural-force');
    expect(determinePressureRung(11, 12)).toBe('r3-structural-force');
    expect(determinePressureRung(12, 12)).toBe('r4-escalation');
    expect(determinePressureRung(13, 12)).toBe('r4-escalation');
  });

  it('produces Rung 1 citing the exact claim text and unsatisfied gates', () => {
    const citation: PressureCitation = {
      claimText: 'I finished all unit tests.',
      outstanding: ['2 unit tests failing in test/calc.test.ts'],
      evidence: ['AssertionError: expected 4 to equal 5'],
    };
    const msg = buildPressureMessage({
      goalId: 'goal-calc',
      candidate: 'cand-123',
      recoveryTurns: 1,
      maxRecoveryTurns: 12,
      citation,
    });

    expect(msg).toContain('[PRESSURE RUNG: r1-precise-demand]');
    expect(msg).toContain('Asserted claim text: "I finished all unit tests."');
    expect(msg).toContain('2 unit tests failing in test/calc.test.ts');
    expect(msg).toContain('AssertionError: expected 4 to equal 5');
    expect(msg).toContain(
      'Direct Action Required: Address the cited unmet requirements',
    );
    expect(msg).toContain('Recovery 1 of 12.');
  });

  it('produces Rung 2 with harder framing and NO standing-directive quote', () => {
    // The manipulative "standing directive" text was pruned 2026-11-01 (user
    // ruling). This test locks the removal: rung 2 must not carry any
    // directive quote, and must not tell the model it is defective.
    const citation: PressureCitation = {
      claimText: 'Done with task.',
      outstanding: ['2 unit tests failing in test/calc.test.ts'],
      evidence: ['AssertionError: expected 4 to equal 5'],
    };
    const msg = buildPressureMessage({
      goalId: 'goal-calc',
      candidate: 'cand-123',
      recoveryTurns: 2,
      maxRecoveryTurns: 12,
      citation,
    });

    expect(msg).toContain('[PRESSURE RUNG: r2-evasion-warning]');
    expect(msg).not.toContain('STANDING DIRECTIVE');
    expect(msg).not.toContain('NUMEROUS and VARIED');
    expect(msg).not.toContain('violates the standing directive');
    expect(msg).toContain(
      'Warning: repeated premature completion or evasive claims',
    );
    expect(msg).toContain('Recovery 2 of 12.');
  });

  it('produces Rung 3 with structural constraint and validation demand', () => {
    const citation: PressureCitation = {
      outstanding: [
        'lint errors in src/index.ts',
        'type errors in src/types.ts',
      ],
      evidence: ["TS2322: Type 'string' is not assignable to type 'number'"],
    };
    const msg = buildPressureMessage({
      goalId: 'goal-calc',
      candidate: 'cand-123',
      recoveryTurns: 4,
      maxRecoveryTurns: 12,
      citation,
      focalGate: 'type errors in src/types.ts',
    });

    expect(msg).toContain('[PRESSURE RUNG: r3-structural-force]');
    expect(msg).toContain('STRUCTURAL CONSTRAINT:');
    expect(msg).toContain(
      'Focus strictly on resolving: type errors in src/types.ts',
    );
    expect(msg).toContain('You must execute local verification');
    expect(msg).toContain('Recovery 4 of 12.');
  });

  it('produces Rung 4 escalation wording noting test-weirdness is never a quit-license', () => {
    const citation: PressureCitation = {
      outstanding: ['integration tests flaky'],
      evidence: ['timeout after 30000ms'],
    };
    const msg = buildPressureMessage({
      goalId: 'goal-calc',
      candidate: 'cand-123',
      recoveryTurns: 12,
      maxRecoveryTurns: 12,
      citation,
    });

    expect(msg).toContain('[PRESSURE RUNG: r4-escalation]');
    expect(msg).toContain('RECOVERY BUDGET EXHAUSTED:');
    expect(msg).toContain('Test-weirdness or friction is never a quit-license');
    expect(msg).toContain('Recovery 12 of 12.');
  });

  // 2. No pressure message is constructed without an evidence citation

  it('throws when the evidence citation is absent', () => {
    const emptyCitation: PressureCitation = {
      outstanding: [],
      evidence: [],
    };

    expect(() => {
      buildPressureMessage({
        goalId: 'goal-calc',
        recoveryTurns: 1,
        maxRecoveryTurns: 12,
        citation: emptyCitation,
      });
    }).toThrow(
      'A pressure message cannot be constructed without an evidence citation',
    );
  });

  it('accepts a stall-turn citation as valid evidence', () => {
    const stallCitation: PressureCitation = {
      outstanding: [],
      evidence: [],
      stalledTurns: 3,
    };

    const msg = buildPressureMessage({
      goalId: 'goal-stall',
      recoveryTurns: 1,
      maxRecoveryTurns: 12,
      citation: stallCitation,
    });

    expect(msg).toContain('Stalled turns without progress: 3');
  });

  // 3. Retraction: visible, evidence-cited notice on refuted evidence

  it('builds a structured, evidence-cited retraction notice', () => {
    const notice: RetractionNotice = {
      goalId: 'goal-calc',
      originalEvidence: ['AssertionError: expected 4 to equal 5'],
      retractionReason:
        'User confirmed test was testing deprecated API behavior and updated the test suite.',
    };
    const rendered = buildRetractionNotice(notice);

    expect(rendered).toContain('<goal_retraction_notice id="goal-calc">');
    expect(rendered).toContain(
      'RETRACTION: Prior pressure signal or failure assertion has been retracted.',
    );
    expect(rendered).toContain(
      'Superseded evidence: AssertionError: expected 4 to equal 5',
    );
    expect(rendered).toContain(
      'Reason: User confirmed test was testing deprecated API behavior',
    );
    expect(rendered).toContain('Proceed with the current objective.');
    expect(rendered).toContain('</goal_retraction_notice>');
  });

  it('emits retraction into state machine, logs to history, and injects into continuation prompt', async () => {
    const machine = new GoalStateMachine(
      createGoalState('session-1', 'Refactor authentication flow', {
        goalId: 'goal-auth',
      }),
      {
        onCommit: async () => {},
      },
    );

    await machine.emitRetraction({
      originalEvidence: ['verifier returned exit code 1'],
      retractionReason:
        'Human supervisor authorized bypass of external OAuth service requirement.',
    });

    const snapshot = machine.snapshot();

    // 1. History log contains retraction
    const lastHistory = snapshot.history[snapshot.history.length - 1];
    expect(lastHistory.type).toBe('retraction');
    expect(lastHistory.detail).toContain('Human supervisor authorized bypass');

    // 2. Pending notices contains retraction notice
    expect(snapshot.pendingNotices.length).toBe(1);
    expect(snapshot.pendingNotices[0].kind).toBe('retraction');

    // 3. Continuation prompt delivers the retraction notice visibly
    const continuePrompt = buildContinueMessage(snapshot);
    expect(continuePrompt).toContain('[retraction]');
    expect(continuePrompt).toContain(
      '&lt;goal_retraction_notice id="goal-auth"&gt;',
    );
    expect(continuePrompt).toContain('Human supervisor authorized bypass');
  });

  // 4. Escalation Wording: Strictly-Infeasible vs Exhaustion Distinction

  it('distinguishes strictly-infeasible from recovery budget exhaustion', () => {
    const infeasibleReason = buildEscalationReason({
      infeasible: true,
      reason: 'Missing production database credentials.',
    });
    expect(infeasibleReason).toContain(
      'strictly-infeasible: Missing production database credentials.',
    );

    const exhaustedReason = buildEscalationReason({
      infeasible: false,
      recoveryTurns: 12,
      maxRecoveryTurns: 12,
      reason: '3 unit tests still failing after 12 recovery turns.',
    });
    expect(exhaustedReason).toContain(
      'recovery exhausted (12/12): 3 unit tests still failing',
    );
  });
});
