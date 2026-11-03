/**
 * Translates the ledger's internal claim tokens into human-readable text.
 * Internal tokens (`verified-complete`, `unverifiable-claim`, check paths)
 * stay exact in the ledger; they must not reach a reader untranslated.
 */

/** The ledger's internal outcome tokens, as persisted. */
export type LedgerOutcomeStatus =
  | 'verified-complete'
  | 'unverifiable-claim'
  | 'claim-refuted'
  | 'blocked-acknowledged';

/** The ledger's internal check-path tokens, as persisted. */
export type LedgerCheckPath = 'judge' | 'none';

/**
 * The shared word for a claim's QUALITY: `attested` vs `unattested` is the
 * distinction a reader needs. The other two terminal outcomes are
 * already plain English.
 */
export function claimQualityLabel(status: string): string {
  switch (status) {
    case 'verified-complete':
      return 'attested';
    case 'unverifiable-claim':
      return 'unattested';
    case 'claim-refuted':
      return 'refuted';
    case 'blocked-acknowledged':
      return 'blocked';
    default:
      return status;
  }
}

/**
 * The shared words for what checked a claim. The judge is called "the judge"
 * (project conventions ban the retired spelling `auditor` as a synonym for a verifier).
 */
export function describeVerifier(check: {
  path: string;
  target?: string;
}): string {
  switch (check.path) {
    case 'judge':
      return 'the judge';
    case 'none':
      return 'no verifier';
    default:
      // Defensive fallback if a new verification path is added without updating this mapping.
      return check.target || 'an unrecognised verifier';
  }
}

/** The parts of a claim these labels need. */
export interface ClaimLike {
  check: {path: string; target?: string};
  outcome: {status: string; detail?: string};
}

/**
 * Explains why a claim carries no attestation in the shared vocabulary.
 * Returns the outcome detail when present, or identifies the verifier status.
 */
export function unattestedReason(claim: ClaimLike | null | undefined): string {
  const detail = claim?.outcome?.detail?.trim();
  if (detail) return detail;
  const path = claim?.check?.path;
  if (!path || path === 'none') return 'no verifier answered';
  return `${describeVerifier(claim.check)} did not attest it`;
}
