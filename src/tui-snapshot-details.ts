/** Validation and independent copies of optional TUI claim and proposal details. */
import type {ClaimRecord, GoalProposal} from './goal-types.ts';

export interface TuiSnapshotDetails {
  artifactPointers?: string[];
  pendingProposal?: GoalProposal | null;
  claims?: ClaimRecord[];
  lastClaim?: ClaimRecord | null;
  origin?: 'live' | 'disk';
}

export function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    strings.push(item);
  }
  return strings;
}

export function copyGoalProposal(
  proposal: Readonly<GoalProposal>,
): GoalProposal {
  return {
    proposalId: proposal.proposalId,
    proposedAt: proposal.proposedAt,
    reason: proposal.reason,
    ...(proposal.objective !== undefined
      ? {objective: proposal.objective}
      : {}),
    ...(proposal.successCriteria !== undefined
      ? {successCriteria: proposal.successCriteria}
      : {}),
    ...(proposal.constraints !== undefined
      ? {constraints: proposal.constraints}
      : {}),
    ...(proposal.artifactPointers !== undefined
      ? {artifactPointers: [...proposal.artifactPointers]}
      : {}),
  };
}

export function copyClaimRecord(claim: Readonly<ClaimRecord>): ClaimRecord {
  return {
    claimId: claim.claimId,
    timestamp: claim.timestamp,
    actor: claim.actor,
    claimedStatus: claim.claimedStatus,
    claimText: claim.claimText,
    check: {
      path: claim.check.path,
      verdict: claim.check.verdict,
      timestamp: claim.check.timestamp,
      ...(claim.check.target !== undefined ? {target: claim.check.target} : {}),
      ...(claim.check.evidence !== undefined
        ? {evidence: [...claim.check.evidence]}
        : {}),
    },
    outcome: {
      status: claim.outcome.status,
      detail: claim.outcome.detail,
      timestamp: claim.outcome.timestamp,
    },
  };
}

const CLAIM_ACTORS = new Set(['agent', 'human', 'slash-command']);
const CLAIM_VERDICTS = new Set([
  'COMPLETE',
  'WORKING',
  'BLOCKED',
  'NEEDS_INPUT',
  'CANCELLED',
  'JUDGE_APPROVED',
  'JUDGE_REJECTED',
  'JUDGE_FAILURE',
  'VERIFIER_FAILURE',
  'NONE',
]);
const CLAIM_OUTCOMES = new Set([
  'verified-complete',
  'claim-refuted',
  'unverifiable-claim',
  'blocked-acknowledged',
]);

function parseClaim(value: unknown): ClaimRecord | null {
  const claim = asRecord(value);
  const check = asRecord(claim?.check);
  const outcome = asRecord(claim?.outcome);
  if (
    !claim ||
    !check ||
    !outcome ||
    typeof claim.claimId !== 'string' ||
    claim.claimId.length === 0 ||
    !isNonNegativeFinite(claim.timestamp) ||
    typeof claim.actor !== 'string' ||
    !CLAIM_ACTORS.has(claim.actor) ||
    (claim.claimedStatus !== 'complete' && claim.claimedStatus !== 'blocked') ||
    typeof claim.claimText !== 'string' ||
    (check.path !== 'judge' && check.path !== 'none') ||
    typeof check.verdict !== 'string' ||
    !CLAIM_VERDICTS.has(check.verdict) ||
    !isNonNegativeFinite(check.timestamp) ||
    (check.target !== undefined && typeof check.target !== 'string') ||
    (check.evidence !== undefined && stringArray(check.evidence) === null) ||
    typeof outcome.status !== 'string' ||
    !CLAIM_OUTCOMES.has(outcome.status) ||
    typeof outcome.detail !== 'string' ||
    !isNonNegativeFinite(outcome.timestamp)
  )
    return null;
  return copyClaimRecord(claim as unknown as ClaimRecord);
}

function parseProposal(value: unknown): GoalProposal | null {
  const proposal = asRecord(value);
  if (
    !proposal ||
    typeof proposal.proposalId !== 'string' ||
    proposal.proposalId.length === 0 ||
    !isNonNegativeFinite(proposal.proposedAt) ||
    typeof proposal.reason !== 'string' ||
    ['objective', 'successCriteria', 'constraints'].some(
      field =>
        proposal[field] !== undefined && typeof proposal[field] !== 'string',
    ) ||
    (proposal.artifactPointers !== undefined &&
      stringArray(proposal.artifactPointers) === null)
  )
    return null;
  return copyGoalProposal(proposal as unknown as GoalProposal);
}

/** Missing fields support older companions; malformed present details reject the event. */
export function parseTuiSnapshotDetails(
  snapshot: Record<string, unknown>,
): TuiSnapshotDetails | null {
  const result: TuiSnapshotDetails = {};
  if (snapshot.artifactPointers !== undefined) {
    const pointers = stringArray(snapshot.artifactPointers);
    if (pointers === null) return null;
    result.artifactPointers = pointers;
  }
  if (snapshot.pendingProposal !== undefined) {
    const proposal =
      snapshot.pendingProposal === null
        ? null
        : parseProposal(snapshot.pendingProposal);
    if (snapshot.pendingProposal !== null && proposal === null) return null;
    result.pendingProposal = proposal;
  }
  if (snapshot.claims !== undefined) {
    if (!Array.isArray(snapshot.claims)) return null;
    const claims: ClaimRecord[] = [];
    for (const raw of snapshot.claims) {
      const claim = parseClaim(raw);
      if (!claim) return null;
      claims.push(claim);
    }
    result.claims = claims;
  }
  if (snapshot.lastClaim !== undefined) {
    const claim =
      snapshot.lastClaim === null ? null : parseClaim(snapshot.lastClaim);
    if (snapshot.lastClaim !== null && claim === null) return null;
    result.lastClaim = claim;
  }
  if (snapshot.origin !== undefined) {
    if (snapshot.origin !== 'live' && snapshot.origin !== 'disk') return null;
    result.origin = snapshot.origin;
  }
  return result;
}
