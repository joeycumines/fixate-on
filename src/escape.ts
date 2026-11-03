/**
 * Escapes characters with XML syntactic meaning (`&`, `<`, `>`).
 *
 * All user-provided and verifier-derived strings interpolated into XML-like
 * prompt structures must pass through this to prevent structural injection
 * (closing tags early, injecting fake elements).
 *
 * Note: Blocks structural injection only. Semantic injection (text crafted to
 * simulate model instructions) must be mitigated via advisory framing.
 */
export function escapeGoalText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
