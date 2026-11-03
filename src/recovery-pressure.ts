/**
 * Builds recovery pressure prompts on a four-rung ladder (r1 -> r4)
 * that escalates with recovery turn progression.
 *
 * Every pressure message requires verifiable evidence citations (quoted claims,
 * unmet gates, failure logs, or stall metrics). Prompt framing relies strictly
 * on cited evidence and clear procedural options rather than punitive directives.
 */

export type PressureRung =
  | 'r1-precise-demand'
  | 'r2-evasion-warning'
  | 'r3-structural-force'
  | 'r4-escalation';

export interface PressureCitation {
  /** Quoted claim text asserted by the agent or command. */
  claimText?: string;
  /** Unmet requirements or gate failures. */
  outstanding: string[];
  /** Concrete failure evidence (e.g. failing test excerpts, verifier logs). */
  evidence: string[];
  /** Number of stalled turns (if stall-triggered). */
  stalledTurns?: number;
  /** Actor who originated the claim or check. */
  actor?: string;
  /** Timestamp of the cited event. */
  timestamp?: number;
}

export interface PressureMessageOptions {
  goalId: string;
  candidate?: string;
  recoveryTurns: number;
  maxRecoveryTurns: number;
  citation: PressureCitation;
  phraseReason?: string | null;
  focalGate?: string;
}

export interface RetractionNotice {
  goalId: string;
  originalEvidence: string[];
  retractionReason: string;
  timestamp?: number;
}

/**
 * Determines the pressure ladder rung based on the recovery turn progression.
 */
export function determinePressureRung(
  recoveryTurns: number,
  maxRecoveryTurns: number,
): PressureRung {
  if (recoveryTurns >= maxRecoveryTurns) {
    return 'r4-escalation';
  }
  if (recoveryTurns >= 4) {
    return 'r3-structural-force';
  }
  if (recoveryTurns >= 2) {
    return 'r2-evasion-warning';
  }
  return 'r1-precise-demand';
}

/**
 * Builds an evidence-cited pressure prompt for the recovery loop.
 *
 * @throws {Error} If no evidence citation (claim, unmet gates, failure evidence, or stall count) is provided.
 */
export function buildPressureMessage(opts: PressureMessageOptions): string {
  const {citation} = opts;
  const hasEvidence = citation.evidence && citation.evidence.length > 0;
  const hasOutstanding =
    citation.outstanding && citation.outstanding.length > 0;
  const hasClaim = Boolean(citation.claimText && citation.claimText.trim());
  const hasStall =
    typeof citation.stalledTurns === 'number' && citation.stalledTurns > 0;

  if (!hasEvidence && !hasOutstanding && !hasClaim && !hasStall) {
    throw new Error(
      'A pressure message cannot be constructed without an evidence citation (quoted claim, outstanding gates, failure evidence, or stall metrics).',
    );
  }

  const rung = determinePressureRung(opts.recoveryTurns, opts.maxRecoveryTurns);
  const lines: string[] = [];

  lines.push(
    `[PRESSURE RUNG: ${rung}] Task: ${opts.goalId}${opts.candidate ? ` (candidate ${opts.candidate})` : ''}`,
  );

  lines.push('', '### Cited Evidence Record:');
  if (hasClaim) {
    lines.push(`- Asserted claim text: "${citation.claimText}"`);
  }
  if (hasOutstanding) {
    lines.push('- Unsatisfied requirements / gates:');
    for (const item of citation.outstanding) {
      lines.push(`  * ${item}`);
    }
  }
  if (hasEvidence) {
    lines.push('- Verifier / check failure evidence:');
    for (const item of citation.evidence) {
      lines.push(`  * ${item}`);
    }
  }
  if (hasStall) {
    lines.push(`- Stalled turns without progress: ${citation.stalledTurns}`);
  }

  if (opts.phraseReason) {
    lines.push('', `Advisory: ${opts.phraseReason}`);
  }

  lines.push('');
  switch (rung) {
    case 'r1-precise-demand':
      lines.push(
        'Direct Action Required: Address the cited unmet requirements above before re-asserting completion.',
        'If progress requires external authority or a material decision, return BLOCKED or NEEDS_INPUT with evidence.',
        'If an authorized actor ended the task, relay CANCELLED with that authorization.',
      );
      break;

    case 'r2-evasion-warning':
      lines.push(
        'Warning: repeated premature completion or evasive claims without addressing the cited failures above will advance the pressure ladder toward structural restriction and human escalation.',
        'Continued unattested claims are not accepted; address the cited evidence or settle with BLOCKED / NEEDS_INPUT.',
      );
      break;

    case 'r3-structural-force':
      lines.push(
        'STRUCTURAL CONSTRAINT:',
        opts.focalGate
          ? `Focus strictly on resolving: ${opts.focalGate}`
          : 'Focus strictly on the single first failing item in the cited evidence above.',
        'You must execute local verification (e.g. run tests or diff checks) and confirm passing evidence BEFORE calling update_goal.',
        'Do not broad-scan or jump to unrelated files.',
      );
      break;

    case 'r4-escalation':
      lines.push(
        'RECOVERY BUDGET EXHAUSTED:',
        'The goal cannot proceed autonomously without human intervention.',
        'Note: Test-weirdness or friction is never a quit-license, but bounded recovery has reached its limit.',
        'This run is paused for human review with the cited evidence above preserved.',
      );
      break;
  }

  lines.push('', `Recovery ${opts.recoveryTurns} of ${opts.maxRecoveryTurns}.`);

  return lines.join('\n');
}

/**
 * Builds a structured, evidence-cited retraction notice when prior pressure
 * or verifier findings are refuted or superseded.
 */
export function buildRetractionNotice(notice: RetractionNotice): string {
  const lines: string[] = [
    `<goal_retraction_notice id="${notice.goalId}">`,
    'RETRACTION: Prior pressure signal or failure assertion has been retracted.',
    `Superseded evidence: ${notice.originalEvidence.length > 0 ? notice.originalEvidence.join('; ') : 'N/A'}`,
    `Reason: ${notice.retractionReason}`,
    'Proceed with the current objective.',
    '</goal_retraction_notice>',
  ];
  return lines.join('\n');
}

/**
 * Formats an escalation reason, distinguishing between strict infeasibility
 * and recovery budget exhaustion.
 */
export function buildEscalationReason(opts: {
  infeasible?: boolean;
  reason?: string;
  recoveryTurns?: number;
  maxRecoveryTurns?: number;
}): string {
  if (opts.infeasible) {
    return `strictly-infeasible: ${opts.reason || 'task requires missing capabilities or impossible constraints'}`;
  }
  return `recovery exhausted (${opts.recoveryTurns ?? 0}/${opts.maxRecoveryTurns ?? 0}): ${opts.reason || 'repeated bounded recovery attempts failed to satisfy verifier'}`;
}
