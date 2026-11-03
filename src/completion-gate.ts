/**
 * Judge-driven completion gate: parse a verdict, evaluate recovery, and fail closed.
 *
 * All execution is agent-driven (the agent runs its own checks with its own tools);
 * the judge attests the claim. hooks.ts decides what the host does with the answer;
 * this module decides whether a goal may become terminal. Failure or exhausted recovery
 * never fabricates COMPLETE.
 *
 * The judge arrives as a caller-supplied function, so this module depends only on
 * recovery-pressure.ts and candidate-identity.ts, not on process execution.
 */

import {buildPressureMessage} from './recovery-pressure.ts';
import {
  type CandidateIdentity,
  isFreshnessUnknownFingerprint,
} from './candidate-identity.ts';

/**
 * Terminal states a verifier may report. Matches the reference implementation's
 * completion-verdict.schema.json's `state` enum.
 *
 * - COMPLETE: the agreed scope holds on the identified candidate.
 * - WORKING: the goal is not yet complete; outstanding lists what remains.
 * - BLOCKED: progress needs authority or an environment change the agent lacks.
 * - NEEDS_INPUT: progress needs a material user decision.
 * - CANCELLED: an authorized actor ended the task.
 */
export type TerminalState =
  'COMPLETE' | 'WORKING' | 'BLOCKED' | 'NEEDS_INPUT' | 'CANCELLED';

/**
 * The completion verdict consumed by the gate. Adopted verbatim from
 * completion-verdict.schema.json ($id: urn:fixate-on:completion-verdict:v1).
 *
 * This is a versioned projection of the full task ledger — it carries only
 * the terminal state, candidate, canonical fingerprint, unmet gates, and
 * evidence needed at the lifecycle boundary.
 */
export interface CompletionVerdict {
  schema_version: 1;
  task_id: string;
  state: TerminalState;
  candidate: string;
  fingerprint: string;
  outstanding: string[];
  evidence: string[];
}

const VERDICT_FIELD_MAX = {
  task_id: 256,
  candidate: 256,
  fingerprint: 256,
  outstanding_items: 32,
  outstanding_item: 500,
  evidence_items: 64,
  evidence_item: 500,
} as const;

function boundedString(value: unknown, max: number): value is string {
  if (typeof value !== 'string') return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= max;
}

function boundedStrings(
  value: unknown,
  limit: number,
  itemMax: number,
): string[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error('invalid verdict array');
  }
  return value.map(item => {
    if (!boundedString(item, itemMax)) {
      throw new Error('invalid verdict item');
    }
    return item;
  });
}

/**
 * Parse and validate a completion verdict from verifier stdout.
 *
 * Enforces stricter rules than the schema alone:
 * - Rejects unknown fields (whitelist of 7 keys).
 * - COMPLETE/CANCELLED require outstanding.length === 0.
 * - WORKING/BLOCKED/NEEDS_INPUT require outstanding.length >= 1.
 * - All states require evidence.length >= 1.
 * - Bounds: task_id/candidate/fingerprint ≤256, outstanding ≤32×500,
 * evidence ≤64×500.
 *
 * Throws on any violation. The caller treats a throw as a verifier
 * failure (fail-closed → bounded recovery or escalate).
 */
export function parseVerdict(stdout: string): CompletionVerdict {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('verdict must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'schema_version',
    'task_id',
    'state',
    'candidate',
    'fingerprint',
    'outstanding',
    'evidence',
  ]);
  if (Object.keys(record).some(key => !allowed.has(key))) {
    throw new Error('verdict has unsupported fields');
  }
  const state = record.state;
  if (
    record.schema_version !== 1 ||
    !boundedString(record.task_id, VERDICT_FIELD_MAX.task_id) ||
    (state !== 'COMPLETE' &&
      state !== 'WORKING' &&
      state !== 'BLOCKED' &&
      state !== 'NEEDS_INPUT' &&
      state !== 'CANCELLED')
  ) {
    throw new Error('invalid verdict fields');
  }
  // `candidate` and `fingerprint` are optional here (COMPLETION-IDENTITY-1).
  // A judge cannot compute them, so requiring them would convert a formatting
  // slip into a lost verdict; the host stamps its own capture onto a judge's
  // verdict, and the post-run re-capture serves as the authoritative mutation fence.
  // Missing values default to empty strings, which will be rejected downstream
  // if an explicit identity match against host capture is required.
  const verdictCandidate = boundedString(
    record.candidate,
    VERDICT_FIELD_MAX.candidate,
  )
    ? (record.candidate as string)
    : '';
  const verdictFingerprint = boundedString(
    record.fingerprint,
    VERDICT_FIELD_MAX.fingerprint,
  )
    ? (record.fingerprint as string)
    : '';
  const outstanding = boundedStrings(
    record.outstanding,
    VERDICT_FIELD_MAX.outstanding_items,
    VERDICT_FIELD_MAX.outstanding_item,
  );
  const evidence = boundedStrings(
    record.evidence,
    VERDICT_FIELD_MAX.evidence_items,
    VERDICT_FIELD_MAX.evidence_item,
  );
  if (
    evidence.length === 0 ||
    ((state === 'COMPLETE' || state === 'CANCELLED') &&
      outstanding.length !== 0) ||
    (state !== 'COMPLETE' && state !== 'CANCELLED' && outstanding.length === 0)
  ) {
    throw new Error('terminal state contradicts its evidence');
  }
  return {
    schema_version: 1,
    task_id: record.task_id as string,
    state: state as TerminalState,
    candidate: verdictCandidate,
    fingerprint: verdictFingerprint,
    outstanding,
    evidence,
  };
}

/**
 * Re-exported for backward compatibility. Candidate identity logic lives in a
 * dedicated module to avoid circular dependencies among callers.
 */
export {
  captureCandidateIdentity,
  isFreshnessUnknownFingerprint,
} from './candidate-identity.ts';
export type {CandidateIdentity} from './candidate-identity.ts';

/**
 * The judge function (injected by hooks.ts from child-session-verifier.ts).
 * Returns a verdict or throws on operational failure.
 *
 * The goal is passed so the judge can inject the objective, success
 * criteria, and constraints into its prompt.
 */
export type VerifierJudgeFn = (ctx: {
  cwd: string;
  taskId: string;
  candidateIdentity: CandidateIdentity;
  goal: import('./state-machine.ts').GoalState;
  latestText: string;
}) => Promise<CompletionVerdict>;

/** Resolution result: the gate consults only the judge, or abstains. */
export type VerifierResolution =
  {kind: 'judge'; judge: VerifierJudgeFn} | {kind: 'unavailable'};

export interface VerifierResolutionOptions {
  /** CWD for candidate capture. */
  cwd: string;
  /** Judge fallback (the repurposed child-session-verifier.ts). */
  judge: VerifierJudgeFn | null;
  /** AbortSignal for the dry-run check. */
  signal?: AbortSignal;
}

/**
 * Resolve which verifier the gate consults: the judge, or nothing.
 *
 * All execution is agent-driven by policy (user ruling 2026-11-01): the
 * plugin never runs a program to check a claim — not an explicit
 * verifierCommand, not a workspace Makefile target, not an auto-detected
 * test command. The agent runs its own checks with its own tools; the
 * judge (a model asked to falsify the claim) is the only attestation the
 * gate accepts. When no judge is available the gate abstains (fail-closed:
 * the claim is recorded as unverifiable, never as complete).
 */
export async function resolveVerifier(
  opts: VerifierResolutionOptions,
): Promise<VerifierResolution> {
  if (opts.judge) {
    return {kind: 'judge', judge: opts.judge};
  }
  return {kind: 'unavailable'};
}

export interface RecoveryState {
  taskID: string;
  recoveryTurns: number;
  unchangedResults: number;
  lastCandidate: string | null;
  lastFingerprint: string | null;
}

export interface RecoveryConfig {
  /** Maximum total recovery turns allowed before escalating (default: 12). */
  maxRecoveryTurns: number;
  /** Maximum consecutive unchanged results allowed before escalating (default: 3). */
  maxUnchangedResults: number;
}

/**
 * The gate's evaluation of a verdict. The caller (hooks.ts) maps each kind
 * to a host action:
 * - settle-*: allow the terminal transition; reset recovery state.
 * - recover: send a bounded recovery prompt; increment counters.
 * - escalate: pause (ESCALATED); never fabricate COMPLETE.
 * - abstain: no verifier exists, so the gate cannot produce an authoritative
 * verdict. The caller records the claim as unverifiable and keeps the goal
 * non-terminal. This is NOT a fabricated COMPLETE — no verifier was consulted.
 * (AGENTS.md Principle 4: zero-config must work; Principle 5: never fabricate
 * COMPLETE.)
 */
export type GateEvaluation =
  | {kind: 'settle-complete'; verdict: CompletionVerdict}
  | {kind: 'settle-blocked'; verdict: CompletionVerdict}
  | {kind: 'settle-needs-input'; verdict: CompletionVerdict}
  | {kind: 'settle-cancelled'; verdict: CompletionVerdict}
  | {
      kind: 'recover';
      verdict: CompletionVerdict;
      state: RecoveryState;
      recoveryN: number;
      maxRecovery: number;
    }
  | {kind: 'escalate'; verdict: CompletionVerdict | null; reason: string}
  /**
   * An operational fault: no attestation could be obtained, so there is no
   * finding about the goal. The caller waits `backoffMs` and re-asks. The
   * consecutive-fault counter MUST be reset after any successful attestation.
   */
  | {
      kind: 'retry-fault';
      attempt: number;
      maxAttempts: number;
      backoffMs: number;
      reason: string;
    }
  /**
   * The fault bound is exhausted. The goal SETTLES with an explicit receipt
   * naming the fault and the attempt count: fail-open WITH a receipt. The
   * alternative — refusing to settle — is the loop this exists to end.
   */
  | {kind: 'settle-unattestable'; attempts: number; reason: string}
  | {kind: 'abstain'; reason: string};

/**
 * Evaluate a verdict against the prior recovery state.
 *
 * Pure function.
 *
 * - COMPLETE or CANCELLED → settle, reset recovery state.
 * - BLOCKED or NEEDS_INPUT → settle, reset recovery state (logged, not
 * reprompted).
 * - WORKING → increment recoveryTurns; unchangedResults increments iff
 * candidate AND fingerprint both match prior (else 0). If budget
 * exhausted → escalate. Else recover.
 *
 * Task-change reset: if the verdict's task_id differs from prior.taskID,
 * start a fresh recovery state with both counters at 0.
 *
 * Candidate-change reset: only unchangedResults resets to 0, NOT recoveryTurns.
 * "Candidate change resets consecutive-unchanged but NOT total budget."
 */
export function evaluateRecovery(
  verdict: CompletionVerdict,
  prior: RecoveryState | null,
  config: RecoveryConfig,
): {result: GateEvaluation; next: RecoveryState} {
  if (verdict.state === 'COMPLETE') {
    return {
      result: {kind: 'settle-complete', verdict},
      next: freshRecoveryState(verdict.task_id),
    };
  }
  if (verdict.state === 'CANCELLED') {
    return {
      result: {kind: 'settle-cancelled', verdict},
      next: freshRecoveryState(verdict.task_id),
    };
  }
  if (verdict.state === 'BLOCKED') {
    return {
      result: {kind: 'settle-blocked', verdict},
      next: freshRecoveryState(verdict.task_id),
    };
  }
  if (verdict.state === 'NEEDS_INPUT') {
    return {
      result: {kind: 'settle-needs-input', verdict},
      next: freshRecoveryState(verdict.task_id),
    };
  }

  const previous =
    prior && prior.taskID === verdict.task_id
      ? prior
      : freshRecoveryState(verdict.task_id);

  const recoveryTurns = previous.recoveryTurns + 1;
  // The unchanged axis is evidence ONLY when both fingerprints are real content
  // hashes. A freshness-unknown marker (or a missing one) is a constant that
  // compares equal to itself regardless of what the agent did, so counting it
  // escalated healthy goals after maxUnchangedResults turns while files were
  // changing every turn. With no usable fingerprint the axis abstains and the
  // total recovery budget remains the bound.
  const fingerprintsComparable =
    !isFreshnessUnknownFingerprint(previous.lastFingerprint) &&
    !isFreshnessUnknownFingerprint(verdict.fingerprint);
  const unchanged =
    fingerprintsComparable &&
    previous.lastCandidate === verdict.candidate &&
    previous.lastFingerprint === verdict.fingerprint
      ? previous.unchangedResults + 1
      : 0;

  const next: RecoveryState = {
    taskID: verdict.task_id,
    recoveryTurns,
    unchangedResults: unchanged,
    lastCandidate: verdict.candidate,
    lastFingerprint: verdict.fingerprint,
  };

  // Both axes use strict >: the threshold is the maximum allowed count.
  // maxRecoveryTurns=12 allows 12 recovery turns (13th escalates);
  // maxUnchangedResults=3 allows 3 unchanged turns (4th escalates).
  if (
    recoveryTurns > config.maxRecoveryTurns ||
    unchanged > config.maxUnchangedResults
  ) {
    return {
      result: {
        kind: 'escalate',
        verdict,
        reason:
          `recovery exhausted for task ${verdict.task_id}: ` +
          `${recoveryTurns}/${config.maxRecoveryTurns} turns, ` +
          `${unchanged}/${config.maxUnchangedResults} unchanged`,
      },
      next,
    };
  }

  return {
    result: {
      kind: 'recover',
      verdict,
      state: next,
      recoveryN: recoveryTurns,
      maxRecovery: config.maxRecoveryTurns,
    },
    next,
  };
}

function freshRecoveryState(taskID: string): RecoveryState {
  return {
    taskID,
    recoveryTurns: 0,
    unchangedResults: 0,
    lastCandidate: null,
    lastFingerprint: null,
  };
}

/** Consecutive attestation faults tolerated before the goal settles. */
export const DEFAULT_MAX_ATTESTATION_FAULTS = 5;

/** Backoff bounds. Short by design: this sits on top of transport retry. */
const FAULT_BACKOFF_BASE_MS = 250;
const FAULT_BACKOFF_MAX_MS = 4_000;

/**
 * Exponential backoff with full jitter for a retried attestation fault.
 * `attempt` is 1-based. Full jitter (uniform in [0, exp]) avoids synchronized
 * retries when several goals fault simultaneously.
 */
export function faultBackoffCapMs(
  attempt: number,
  baseMs: number = FAULT_BACKOFF_BASE_MS,
  maxMs: number = FAULT_BACKOFF_MAX_MS,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/**
 * Uniform random wait in [0, cap). Exported separately from `faultBackoffCapMs`
 * to allow deterministic testing of the backoff curve without random jitter.
 */
export function faultBackoffMs(
  attempt: number,
  baseMs: number = FAULT_BACKOFF_BASE_MS,
  maxMs: number = FAULT_BACKOFF_MAX_MS,
): number {
  return Math.floor(Math.random() * faultBackoffCapMs(attempt, baseMs, maxMs));
}

/**
 * Determine whether a failure represents an operational fault (no attestation
 * obtained; should retry) rather than an attestation rejection.
 */
export function isAttestationFault(failure: VerifierFailure): boolean {
  switch (failure.kind) {
    case 'unavailable':
    case 'judge-error':
      return true;
    case 'identity-mismatch':
      return false;
  }
}

export type AttestationFaultEvaluation =
  | {
      kind: 'retry';
      attempt: number;
      maxAttempts: number;
      backoffMs: number;
      reason: string;
    }
  | {
      kind: 'settle-unattestable';
      attempts: number;
      reason: string;
    };

/**
 * Evaluate an attestation fault against the consecutive-fault count.
 *
 * - Within the bound → `retry` with backoff.
 * - Past the bound → `settle-unattestable`: the caller settles the goal with a
 * receipt naming the fault and attempt count, preventing infinite retry loops.
 *
 * Pure function. The caller owns the counter and MUST reset it to 0 after any
 * successful attestation.
 */
export function evaluateAttestationFault(
  priorAttempts: number,
  failure: VerifierFailure,
  maxAttempts: number = DEFAULT_MAX_ATTESTATION_FAULTS,
): AttestationFaultEvaluation {
  const attempt = Math.max(0, priorAttempts) + 1;
  const describe = describeFailure(failure);
  if (attempt > maxAttempts) {
    return {
      kind: 'settle-unattestable',
      attempts: attempt,
      reason:
        `no attestation could be obtained after ${attempt} consecutive attempts (${describe}) — ` +
        'settling with an unattested receipt rather than looping',
    };
  }
  return {
    kind: 'retry',
    attempt,
    maxAttempts,
    backoffMs: faultBackoffMs(attempt),
    reason: `attestation unavailable (${describe}); retry ${attempt}/${maxAttempts}`,
  };
}

/**
 * Failure to obtain a judge attestation. With command verifiers pruned,
 * the judge's operational failure is treated as a retryable fault, whereas
 * candidate identity mismatch is treated as a rejection.
 */
export type VerifierFailure =
  | {kind: 'unavailable'}
  | {kind: 'judge-error'; error: string}
  | {kind: 'identity-mismatch'; detail: string};

/**
 * Evaluate a verifier failure.
 *
 * Operational failures are retried via `evaluateAttestationFault`.
 * Rejections (such as identity mismatch) advance recoveryTurns without
 * altering unchangedResults, escalating when the budget is exceeded.
 */
export function evaluateVerifierFailure(
  prior: RecoveryState | null,
  config: RecoveryConfig,
  failure: VerifierFailure,
  taskID: string,
  attestationFaultAttempts = 0,
  maxAttestationFaults: number = DEFAULT_MAX_ATTESTATION_FAULTS,
): {result: GateEvaluation; next: RecoveryState} {
  if (isAttestationFault(failure)) {
    const fault = evaluateAttestationFault(
      attestationFaultAttempts,
      failure,
      maxAttestationFaults,
    );
    if (fault.kind === 'retry') {
      return {
        result: {
          kind: 'retry-fault',
          attempt: fault.attempt,
          maxAttempts: fault.maxAttempts,
          backoffMs: fault.backoffMs,
          reason: fault.reason,
        },
        next:
          prior && prior.taskID === taskID ? prior : freshRecoveryState(taskID),
      };
    }
    return {
      result: {
        kind: 'settle-unattestable',
        attempts: fault.attempts,
        reason: fault.reason,
      },
      next: freshRecoveryState(taskID),
    };
  }

  const previous =
    prior && prior.taskID === taskID ? prior : freshRecoveryState(taskID);

  // Identity mismatches mean the judge evaluated a different candidate;
  // handle via normal bounded recovery.
  const recoveryTurns = previous.recoveryTurns + 1;
  // unchangedResults is not incremented on verifier failure because there is
  // no valid candidate/fingerprint comparison.
  const next: RecoveryState = {
    taskID,
    recoveryTurns,
    unchangedResults: previous.unchangedResults,
    lastCandidate: previous.lastCandidate,
    lastFingerprint: previous.lastFingerprint,
  };

  if (recoveryTurns > config.maxRecoveryTurns) {
    return {
      result: {
        kind: 'escalate',
        verdict: null,
        reason: `verifier ${failure.kind}: recovery exhausted (${recoveryTurns}/${config.maxRecoveryTurns} turns)`,
      },
      next,
    };
  }

  // Synthesize a WORKING verdict so the caller can build a recovery prompt.
  const syntheticVerdict: CompletionVerdict = {
    schema_version: 1,
    task_id: taskID,
    state: 'WORKING',
    candidate: previous.lastCandidate ?? 'unknown',
    fingerprint: previous.lastFingerprint ?? 'unknown',
    outstanding: [`verifier unavailable: ${failure.kind}`],
    evidence: [`verifier failure: ${describeFailure(failure)}`],
  };

  return {
    result: {
      kind: 'recover',
      verdict: syntheticVerdict,
      state: next,
      recoveryN: recoveryTurns,
      maxRecovery: config.maxRecoveryTurns,
    },
    next,
  };
}

export interface SupersededClaimAccounting {
  unchangedResults: number;
  recoveryTurns: number;
  /** Which bound this assertion crossed, or null while both are satisfied. */
  stoppedBecause: 'unchanged' | 'recovery-exhausted' | null;
  detail: string;
}

/**
 * Account for a completion assertion superseded by a new assistant message
 * before a verdict could be applied.
 *
 * Advances both unchanged and total recovery turns so unverified loops cannot
 * consume context indefinitely without triggering a pause or escalation.
 */
export function accountSupersededClaim(
  goal: {
    unchangedResults: number;
    recoveryTurns: number;
    maxUnchangedResults: number;
    maxRecoveryTurns: number;
    lastCandidate?: string | null;
    lastFingerprint?: string | null;
  },
  identity:
    {candidate?: string | null; fingerprint?: string | null} | undefined,
  fresh: (fingerprint: string | null | undefined) => boolean,
): SupersededClaimAccounting {
  const unchanged =
    identity !== undefined &&
    fresh(goal.lastFingerprint) &&
    fresh(identity.fingerprint) &&
    goal.lastCandidate === identity.candidate &&
    goal.lastFingerprint === identity.fingerprint
      ? goal.unchangedResults + 1
      : 0;
  const recoveryTurns = goal.recoveryTurns + 1;
  if (unchanged > goal.maxUnchangedResults) {
    return {
      unchangedResults: unchanged,
      recoveryTurns,
      stoppedBecause: 'unchanged',
      detail:
        `The agent asserted completion ${unchanged} times with no change to the workspace and no verifier ` +
        'to check it. Paused rather than looping; resume once the work changes.',
    };
  }
  if (recoveryTurns > goal.maxRecoveryTurns) {
    return {
      unchangedResults: unchanged,
      recoveryTurns,
      stoppedBecause: 'recovery-exhausted',
      detail:
        `The goal asserted completion ${recoveryTurns} times and every assertion was superseded before a ` +
        'verdict could be applied. Paused rather than looping; the work needs another turn before completion ' +
        'can be checked.',
    };
  }
  return {
    unchangedResults: unchanged,
    recoveryTurns,
    stoppedBecause: null,
    detail: '',
  };
}

/**
 * Verify whether the verdict attests to the candidate captured by the gate.
 * Disagreements represent rejections rather than operational faults.
 */
export function classifyVerdictIdentity(
  before: {candidate: string; fingerprint: string; freshnessUnknown?: boolean},
  verdict: {candidate?: string; fingerprint?: string},
): VerifierFailure | null {
  if (verdict.candidate !== before.candidate) {
    return {
      kind: 'identity-mismatch',
      detail: 'verdict does not attest to the captured candidate identity',
    };
  }
  return null;
}

function describeFailure(f: VerifierFailure): string {
  switch (f.kind) {
    case 'identity-mismatch':
      return `verdict does not attest to this candidate (${f.detail})`;
    case 'unavailable':
      return 'no judge available';
    case 'judge-error':
      return `judge error: ${f.error}`;
  }
}

/**
 * Build the recovery prompt for a WORKING verdict using the pressure ladder.
 */
export function buildRecoveryPrompt(
  verdict: CompletionVerdict,
  recoveryN: number,
  maxRecovery: number,
  phraseReason: string | null,
  claimText?: string,
): string {
  return buildPressureMessage({
    goalId: verdict.task_id,
    candidate: verdict.candidate,
    recoveryTurns: recoveryN,
    maxRecoveryTurns: maxRecovery,
    citation: {
      claimText: claimText || undefined,
      outstanding: verdict.outstanding,
      evidence: verdict.evidence,
      timestamp: Date.now(),
    },
    phraseReason,
  });
}
