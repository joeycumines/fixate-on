/**
 * completion-gate-run.ts — runs the verifier for a goal and applies the verdict.
 *
 * Extracted from hooks.ts's `executeDecision`. The gate's policy evaluation lives in
 * completion-gate.ts; this module connects to the verifier and drives state machine transitions.
 *
 * Dependencies: completion-gate.ts, stop-guard.ts, state-machine.ts.
 *
 * Note: Host interfaces are declared structurally to avoid circular dependencies.
 * `removeGoal`'s second parameter is typed as `TransitionSource` rather than `string`
 * because the caller is recorded as the removal provenance in the transition log.
 */
import {
  accountSupersededClaim,
  type CandidateIdentity,
  captureCandidateIdentity,
  type CompletionVerdict,
  evaluateRecovery,
  evaluateVerifierFailure,
  type GateEvaluation,
  isFreshnessUnknownFingerprint,
  type RecoveryConfig,
  type RecoveryState,
  type VerifierFailure,
} from './completion-gate.ts';
import {scanPrematureExit} from './stop-guard.ts';
import type {
  ClaimCheckPath,
  GoalState,
  GoalStateMachine,
  TransitionSource,
} from './state-machine.ts';

/**
 * Host dependencies required by the completion gate: verifier execution
 * and per-goal recovery bounds.
 */
export interface CompletionGateDeps {
  /** Resolve and consult the judge. Returns a verdict or a failure. */
  runVerifier: (ctx: {
    goal: GoalState;
    sessionID: string;
    cwd: string;
    latestText: string;
    candidateIdentity: CandidateIdentity;
  }) => Promise<
    | {
        verdict: CompletionVerdict;
        checkPath?: ClaimCheckPath;
        checkTarget?: string;
      }
    | {
        failure: VerifierFailure;
        checkPath?: ClaimCheckPath;
        checkTarget?: string;
      }
  >;
  /** Recovery configuration defining per-goal bounds. */
  recoveryConfig: RecoveryConfig;
  /**
   * Captures the candidate identity for the goal's workspace.
   * Injected alongside `runVerifier` to allow tests to avoid ambient git state.
   */
  captureIdentity?: (cwd: string) => Promise<CandidateIdentity>;
}

/**
 * Structural definition of the session methods required by the gate runner.
 */
export interface GateRunSession {
  autoPromote?: () => Promise<void>;
  beginSettlement?: (receipt: {
    goalId: string;
    sessionID: string;
    targetStatus: string;
    kind: string;
    revision: number;
    startedAt: number;
  }) => Promise<void>;
  completeSettlement?: (goalId: string) => Promise<void>;

  persist(): Promise<boolean>;

  setPendingIntent(goalId: string, intent: null): void;

  isOrdered(): boolean;

  removeGoal(goalId: string, caller?: TransitionSource): Promise<void>;
}

/**
 * Capability interface for sending bounded recovery prompts back to the session.
 * Declared structurally to avoid circular dependency cycles with hooks.ts.
 */
export type SendRecoveryPrompt = (args: {
  sessionID: string;
  machine: GoalStateMachine;
  verdict: CompletionVerdict;
  recovery: {recoveryTurns: number; maxRecoveryTurns: number};
  nextState: RecoveryState;
  phraseReason: string | null;
  claimText?: string;
}) => Promise<void>;

/** Host surface dependencies including gate configuration, logging, and notifications. */
export interface GateRunDeps {
  completionGate: CompletionGateDeps;
  logError: (message: string, error?: unknown) => Promise<void>;
  workspaceDirectory?: string;
  announceGoalDecision?: (sessionID: string, text: string) => Promise<void>;
}

export interface GateRunArgs {
  goal: GoalState;
  machine: GoalStateMachine;
  session: GateRunSession;
  sessionID: string;
  deps: GateRunDeps;
  triageReason: string | null;
  preRunAssistantID: string;
  sendRecoveryPrompt: SendRecoveryPrompt;
}

export async function runCompletionGate(args: GateRunArgs): Promise<void> {
  const {
    goal,
    machine,
    session,
    sessionID,
    deps,
    preRunAssistantID,
    sendRecoveryPrompt,
  } = args;
  let triageReason = args.triageReason;
  const gate = deps.completionGate;

  // Prefer the goal's recorded cwd, then the host session workspace, and only then
  // process.cwd. Using process.cwd directly risks running git commands over an
  // arbitrary launch directory rather than the target session workspace.
  const cwd =
    goal.executionContext?.cwd ?? deps.workspaceDirectory ?? process.cwd();

  // Capture candidate identity for verification and unchanged-state detection.
  // This executes git commands, so it is injected for test isolation.
  const captureIdentity =
    deps.completionGate?.captureIdentity ?? captureCandidateIdentity;
  let candidateIdentity: CandidateIdentity;
  try {
    candidateIdentity = await captureIdentity(cwd);
  } catch {
    candidateIdentity = {
      candidate: 'no-head',
      fingerprint: 'unknown',
      freshnessUnknown: true,
    };
  }

  const preRunRevision = machine.currentRevision;

  // Infer the return type directly from runVerifier to avoid type drift where
  // checkPath or checkTarget could be dropped.
  let verifierResult: Awaited<ReturnType<CompletionGateDeps['runVerifier']>>;
  try {
    verifierResult = await gate.runVerifier({
      goal: machine.snapshot(),
      sessionID,
      cwd,
      latestText: goal.lastAssistantText || '',
      candidateIdentity,
    });
  } catch (err) {
    verifierResult = {
      failure: {
        kind: 'judge-error',
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Post-await recheck: the verifier may take significant time. Ensure the goal
  // was not mutated or cancelled while verification was in flight.
  if (!machine.validateRevision(preRunRevision)) {
    session.setPendingIntent(machine.snapshot().goalId, null);
    await session.persist();
    return;
  }

  // Stale-idle recheck: if a new assistant message arrived during verification
  // (using skipRevision:true), do not apply a verdict produced from stale text.
  // Account for the superseded assertion to bound potential summary loops.
  const postTriageGoal = machine.snapshot();
  if (postTriageGoal.lastAssistantMessageID !== preRunAssistantID) {
    // An agent can loop by repeatedly asserting completion and immediately superseding
    // the claim before evaluation finishes. Counting consecutive assertions against
    // an unchanged candidate identity ensures the loop bounds and pauses rather than
    // continuing indefinitely.
    const superseded = accountSupersededClaim(
      postTriageGoal,
      candidateIdentity,
      isFreshnessUnknownFingerprint,
    );
    await machine.mutate(
      g => {
        g.lastCandidate = candidateIdentity?.candidate ?? null;
        g.lastFingerprint = candidateIdentity?.fingerprint ?? null;
        g.unchangedResults = superseded.unchangedResults;
        g.recoveryTurns = superseded.recoveryTurns;
      },
      {
        source: 'update_goal',
        detail: 'Tracked superseded completion assertion',
        skipPersist: true,
      },
    );
    if (superseded.stoppedBecause === 'unchanged') {
      await machine.transition('paused', {
        source: 'update_goal',
        stopReason: 'unattested completion asserted repeatedly',
        detail: superseded.detail,
      });
    } else if (superseded.stoppedBecause === 'recovery-exhausted') {
      await machine.transition('paused', {
        source: 'update_goal',
        stopReason: 'recovery exhausted',
        detail: superseded.detail,
      });
    }
    session.setPendingIntent(machine.snapshot().goalId, null);
    await session.persist();
    return;
  }
  if (postTriageGoal.lastAssistantText) {
    const retriage =
      postTriageGoal.languageTriage !== false
        ? scanPrematureExit(postTriageGoal.lastAssistantText)
        : {tier: 'none' as const, reason: ''};
    triageReason = retriage.tier === 'phrase' ? retriage.reason : null;
  }

  // Stamp the judge's verdict with the host's captured candidate identity.
  // The verifier model cannot independently calculate SHA/fingerprints accurately;
  // directory isolation at child session creation ensures the judge operated on the correct tree.
  if (!('failure' in verifierResult)) {
    const verdict = verifierResult.verdict;
    verifierResult = {
      ...verifierResult,
      verdict: {
        ...verdict,
        candidate: candidateIdentity.candidate,
        fingerprint: candidateIdentity.fingerprint,
      },
    };
  }

  const postRunGoal = machine.snapshot();
  if (postRunGoal.status !== 'active') {
    session.setPendingIntent(machine.snapshot().goalId, null);
    await session.persist();
    return;
  }

  const prior: RecoveryState | null = {
    taskID: postRunGoal.goalId,
    recoveryTurns: postRunGoal.recoveryTurns,
    unchangedResults: postRunGoal.unchangedResults,
    lastCandidate: postRunGoal.lastCandidate,
    lastFingerprint: postRunGoal.lastFingerprint,
  };

  // Per-goal configuration overrides take precedence over global plugin defaults.
  const perGoalConfig: RecoveryConfig = {
    maxRecoveryTurns: postRunGoal.maxRecoveryTurns,
    maxUnchangedResults: postRunGoal.maxUnchangedResults,
  };

  let evaluation: {result: GateEvaluation; next: RecoveryState};

  // A substantive response or an identity mismatch indicates the verifier responded,
  // ending consecutive infrastructure fault runs.
  const attestationObtained =
    'verdict' in verifierResult ||
    verifierResult.failure.kind === 'identity-mismatch';
  if (attestationObtained) {
    if (
      (machine.snapshot().attestationFaults ?? 0) !== 0 ||
      (machine.snapshot().attestationRetryAt ?? 0) !== 0
    ) {
      await machine.mutate(
        g => {
          g.attestationFaults = 0;
          g.attestationRetryAt = 0;
        },
        {
          source: 'update_goal',
          detail: 'Attestation obtained; consecutive fault run reset',
          skipPersist: true,
        },
      );
    }
  }
  if ('verdict' in verifierResult) {
    evaluation = evaluateRecovery(verifierResult.verdict, prior, perGoalConfig);
  } else {
    evaluation = evaluateVerifierFailure(
      prior,
      perGoalConfig,
      verifierResult.failure,
      postRunGoal.goalId,
      postRunGoal.attestationFaults ?? 0,
    );
  }

  const result = evaluation.result;
  if (result.kind === 'retry-fault') {
    // When no verifier responds, retry with backoff. `recordClaim` advances the goal's
    // revision, so the pending intent is cleared upon the next idle and only evaluated
    // when the agent re-asserts. `attestationRetryAt` is recorded for observability;
    // full backoff throttling is governed naturally by agent turn latency.
    const faultCount = (postRunGoal.attestationFaults ?? 0) + 1;
    const retryAt = Date.now() + result.backoffMs;

    // Distinguish infrastructure faults from looping/stuck agents:
    // Repeated assertions without workspace changes indicate a stuck agent loop
    // and must pause rather than fail-open via the fault threshold.
    const unchangedOnFault =
      !isFreshnessUnknownFingerprint(postRunGoal.lastFingerprint) &&
      !isFreshnessUnknownFingerprint(candidateIdentity?.fingerprint) &&
      postRunGoal.lastCandidate === candidateIdentity?.candidate &&
      postRunGoal.lastFingerprint === candidateIdentity?.fingerprint
        ? postRunGoal.unchangedResults + 1
        : 0;

    if (unchangedOnFault > postRunGoal.maxUnchangedResults) {
      await machine.transition('paused', {
        source: 'update_goal',
        stopReason: 'unattested completion asserted repeatedly',
        detail:
          `The agent asserted completion ${unchangedOnFault} times with no change to the workspace ` +
          'and no attestation obtainable. Paused rather than looping; resume once the work changes.',
      });
      session.setPendingIntent(machine.snapshot().goalId, null);
      await session.persist();
      if (deps.announceGoalDecision) {
        await deps.announceGoalDecision(
          sessionID,
          `Paused: the goal asserted completion ${unchangedOnFault} times with no change and no way to check it.`,
        );
      }
      return;
    }

    // Durably record the claim as unverifiable to maintain an accurate audit log.
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: goal.lastAssistantText || 'update_goal { status: complete }',
      check: {
        path: 'none',
        verdict: 'NONE',
        evidence: [],
        timestamp: Date.now(),
      },
      outcome: {
        status: 'unverifiable-claim',
        detail: `${result.reason} (attempt ${result.attempt}/${result.maxAttempts})`,
        timestamp: Date.now(),
      },
    });
    await machine.mutate(
      g => {
        g.attestationFaults = faultCount;
        g.attestationRetryAt = retryAt;
        g.lastCandidate = candidateIdentity?.candidate ?? null;
        g.lastFingerprint = candidateIdentity?.fingerprint ?? null;
        g.unchangedResults = unchangedOnFault;
        // Retain the evidentiary label while active so unattested claims are visible.
        g.stopReason = 'completion verification unavailable';
        g.lastStatus =
          `Attestation could not be obtained: ${result.reason}. ` +
          `Retrying (attempt ${result.attempt}/${result.maxAttempts}).`;
      },
      {
        source: 'update_goal',
        detail: `Attestation fault ${result.attempt}/${result.maxAttempts}`,
        skipPersist: true,
      },
    );

    await session.persist();
    if (deps.announceGoalDecision) {
      await deps.announceGoalDecision(
        sessionID,
        `Attestation could not be obtained (${result.reason}). ` +
          `The goal is unchanged and will be retried; attempt ${result.attempt} of ${result.maxAttempts}.`,
      );
    }
    return;
  }

  if (result.kind === 'settle-unattestable') {
    // When the fault threshold is exhausted, settle with an explicit unverifiable receipt
    // rather than looping indefinitely or stalling queue execution.
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: goal.lastAssistantText || 'update_goal { status: complete }',
      check: {
        path: 'none',
        verdict: 'NONE',
        evidence: [],
        timestamp: Date.now(),
      },
      outcome: {
        status: 'unverifiable-claim',
        detail: result.reason,
        timestamp: Date.now(),
      },
    });
    const settled = await machine.transition('complete', {
      source: 'update_goal',
      stopReason: 'completed (no attestation could be obtained)',
      detail:
        'The agent claimed completion and no attestation could be obtained after ' +
        `${result.attempts} attempts (${result.reason}). Settled with this receipt rather than looping.`,
    });
    await machine.mutate(
      g => {
        g.attestationRetryAt = 0;
      },
      {source: 'update_goal', detail: 'Fault bound reached', skipPersist: true},
    );
    if (!settled.ok) {
      await deps.logError('Failed to settle unattestable goal', settled.error);
    }
    session.setPendingIntent(machine.snapshot().goalId, null);
    await session.persist();

    // Archive goal so active listings clear and ordered queues can progress.
    await session.removeGoal(goal.goalId, 'update_goal');
    await session.persist();
    if (session.autoPromote && session.isOrdered()) {
      await session.autoPromote();
    }
    if (deps.announceGoalDecision) {
      await deps.announceGoalDecision(
        sessionID,
        `Goal settled without an attestation: ${result.reason}. ` +
          'The completion is recorded as unattested — no verifier could confirm it.',
      );
    }
    return;
  }

  if (result.kind === 'abstain') {
    // Retained for backward compatibility. Keep goal active and record status.
    await machine.mutate(
      g => {
        g.lastStatus = `Completion verification unavailable: ${result.reason}`;
      },
      {
        source: 'update_goal',
        detail: 'Completion gate abstained',
        skipPersist: true,
      },
    );
    await session.persist();
    return;
  } else if (result.kind === 'settle-complete') {
    const vCheckPath: ClaimCheckPath =
      (verifierResult as {checkPath?: ClaimCheckPath}).checkPath ?? 'judge';
    const vCheckTarget = (verifierResult as {checkTarget?: string}).checkTarget;
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: goal.lastAssistantText || 'update_goal { status: complete }',
      check: {
        path: vCheckPath,
        target: vCheckTarget,
        verdict: 'COMPLETE',
        evidence: result.verdict.evidence,
        timestamp: Date.now(),
      },
      outcome: {
        status: 'verified-complete',
        detail: `Attested by the verifier (candidate ${result.verdict.candidate})`,
        timestamp: Date.now(),
      },
    });
    const completeResult = await machine.transition('complete', {
      source: 'update_goal',
      stopReason: 'completed (verifier: COMPLETE)',
      detail: `Goal marked complete via update_goal (verifier verdict: COMPLETE, candidate ${result.verdict.candidate})`,
    });
    if (!completeResult.ok) {
      await deps.logError(
        'Failed to transition to complete after verifier COMPLETE',
        completeResult.error,
      );
      session.setPendingIntent(machine.snapshot().goalId, null);
      await session.persist();
      return;
    }
  } else if (result.kind === 'settle-blocked') {
    const vCheckPath: ClaimCheckPath =
      (verifierResult as {checkPath?: ClaimCheckPath}).checkPath ?? 'judge';
    const vCheckTarget = (verifierResult as {checkTarget?: string}).checkTarget;
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: goal.lastAssistantText || 'update_goal { status: complete }',
      check: {
        path: vCheckPath,
        target: vCheckTarget,
        verdict: 'BLOCKED',
        evidence: result.verdict.evidence,
        timestamp: Date.now(),
      },
      outcome: {
        status: 'blocked-acknowledged',
        detail: result.verdict.outstanding.join('; '),
        timestamp: Date.now(),
      },
    });
    const blockedReason = result.verdict.outstanding.join('; ');
    const blockedResult = await machine.transition('blocked', {
      source: 'update_goal',
      stopReason: 'blocked (verifier: BLOCKED)',
      blockedReason,
      detail: `Verifier reported BLOCKED: ${blockedReason}`,
    });
    if (!blockedResult.ok) {
      await deps.logError(
        'Failed to transition to blocked after verifier BLOCKED',
        blockedResult.error,
      );
    }
  } else if (result.kind === 'settle-needs-input') {
    const vCheckPath: ClaimCheckPath =
      (verifierResult as {checkPath?: ClaimCheckPath}).checkPath ?? 'judge';
    const vCheckTarget = (verifierResult as {checkTarget?: string}).checkTarget;
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: goal.lastAssistantText || 'update_goal { status: complete }',
      check: {
        path: vCheckPath,
        target: vCheckTarget,
        verdict: 'NEEDS_INPUT',
        evidence: result.verdict.evidence,
        timestamp: Date.now(),
      },
      outcome: {
        status: 'claim-refuted',
        detail: result.verdict.outstanding.join('; '),
        timestamp: Date.now(),
      },
    });
    const pauseReason = result.verdict.outstanding.join('; ');
    const pauseResult = await machine.transition('paused', {
      source: 'update_goal',
      stopReason: `needs input (verifier: NEEDS_INPUT): ${pauseReason}`,
      detail: `Verifier reported NEEDS_INPUT: ${pauseReason}`,
    });
    if (!pauseResult.ok) {
      await deps.logError(
        'Failed to transition to paused after verifier NEEDS_INPUT',
        pauseResult.error,
      );
    }
  } else if (result.kind === 'settle-cancelled') {
    const vCheckPath: ClaimCheckPath =
      (verifierResult as {checkPath?: ClaimCheckPath}).checkPath ?? 'judge';
    const vCheckTarget = (verifierResult as {checkTarget?: string}).checkTarget;
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: goal.lastAssistantText || 'update_goal { status: complete }',
      check: {
        path: vCheckPath,
        target: vCheckTarget,
        verdict: 'CANCELLED',
        evidence: result.verdict.evidence,
        timestamp: Date.now(),
      },
      outcome: {
        status: 'claim-refuted',
        detail: 'Verifier relayed authorized CANCELLED; work state preserved',
        timestamp: Date.now(),
      },
    });
    // CANCELLED preserves work in a resumable paused state rather than marking complete.
    const cancelResult = await machine.transition('paused', {
      source: 'update_goal',
      stopReason: `cancelled (verifier: CANCELLED): ${result.verdict.outstanding.join('; ')}`,
      detail: 'Verifier relayed authorized CANCELLED; goal remains resumable',
    });
    if (!cancelResult.ok) {
      await deps.logError(
        'Failed to transition to paused after verifier CANCELLED',
        cancelResult.error,
      );
      session.setPendingIntent(machine.snapshot().goalId, null);
      await session.persist();
      return;
    }
  } else if (result.kind === 'escalate') {
    const vCheckPath: ClaimCheckPath =
      (verifierResult as {checkPath?: ClaimCheckPath}).checkPath ?? 'judge';
    const vCheckTarget = (verifierResult as {checkTarget?: string}).checkTarget;
    const verdictState =
      'verdict' in verifierResult
        ? verifierResult.verdict.state
        : 'VERIFIER_FAILURE';
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: goal.lastAssistantText || 'update_goal { status: complete }',
      check: {
        path: vCheckPath,
        target: vCheckTarget,
        verdict:
          verdictState === 'COMPLETE'
            ? 'COMPLETE'
            : verdictState === 'BLOCKED'
              ? 'BLOCKED'
              : verdictState === 'NEEDS_INPUT'
                ? 'NEEDS_INPUT'
                : verdictState === 'WORKING'
                  ? 'WORKING'
                  : 'VERIFIER_FAILURE',
        evidence:
          'verdict' in verifierResult
            ? verifierResult.verdict.evidence
            : undefined,
        timestamp: Date.now(),
      },
      outcome: {
        status: 'claim-refuted',
        detail: result.reason,
        timestamp: Date.now(),
      },
    });
    const escalateResult = await machine.transition('paused', {
      source: 'update_goal',
      stopReason: 'recovery exhausted (escalated)',
      detail: result.reason,
    });
    if (!escalateResult.ok) {
      await deps.logError(
        'Failed to transition to paused after escalation',
        escalateResult.error,
      );
    }
    await machine.mutate(
      g => {
        g.lastStatus = `Escalated: ${result.reason}`;
      },
      {
        source: 'update_goal',
        detail: 'Set last status to escalation reason',
        skipPersist: true,
      },
    );
    if (deps.announceGoalDecision) {
      await deps.announceGoalDecision(
        sessionID,
        `Recovery exhausted: ${result.reason}. Goal paused (escalated).`,
      );
    }
    if (session.autoPromote && session.isOrdered()) {
      await session.autoPromote();
    }
  } else if (result.kind === 'recover') {
    const vCheckPath: ClaimCheckPath =
      (verifierResult as {checkPath?: ClaimCheckPath}).checkPath ?? 'judge';
    const vCheckTarget = (verifierResult as {checkTarget?: string}).checkTarget;
    await machine.recordClaim({
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: goal.lastAssistantText || 'update_goal { status: complete }',
      check: {
        path: vCheckPath,
        target: vCheckTarget,
        verdict: 'WORKING',
        evidence: result.verdict.evidence,
        timestamp: Date.now(),
      },
      outcome: {
        status: 'claim-refuted',
        detail:
          result.verdict.outstanding.join('; ') || 'Claim refuted by verifier',
        timestamp: Date.now(),
      },
    });
    // Prompt the agent for bounded continuation; returns early without archiving.
    await sendRecoveryPrompt({
      sessionID,
      machine,
      verdict: result.verdict,
      recovery: {
        recoveryTurns: result.recoveryN,
        maxRecoveryTurns: result.maxRecovery,
      },
      nextState: evaluation.next,
      phraseReason: triageReason,
      claimText: goal.lastAssistantText || undefined,
    });
    return;
  }

  // Record the intended terminal transition receipt before clearing state and archiving,
  // making interrupted settlements recoverable across crashes.
  if (result.kind === 'settle-complete') {
    await session.beginSettlement?.({
      goalId: goal.goalId,
      sessionID,
      targetStatus: 'complete',
      kind: result.kind,
      revision: machine.snapshot().revision,
      startedAt: Date.now(),
    });
  }

  session.setPendingIntent(machine.snapshot().goalId, null);
  await session.persist();

  if (result.kind === 'settle-complete') {
    if (session.autoPromote && session.isOrdered()) {
      await session.autoPromote();
    }
    await session.removeGoal(goal.goalId, 'completion-gate');
    await session.persist();
    await session.completeSettlement?.(goal.goalId);
  } else if (
    result.kind === 'settle-blocked' ||
    result.kind === 'settle-needs-input'
  ) {
    // Non-archived terminal state: promote the next queued goal in an ordered sequence.
    if (session.autoPromote && session.isOrdered()) {
      await session.autoPromote();
    }
  }
}
