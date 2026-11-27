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

/**
 * Escapes a value for interpolation into a double-quoted XML attribute.
 *
 * `escapeGoalText` covers the characters with meaning in text content, but
 * inside a delimited attribute value the delimiter itself is structural too:
 * an unescaped `"` closes the attribute early and lets crafted text inject
 * new attributes or break the tag (CodeQL
 * js/incomplete-html-attribute-sanitization). Every attribute this codebase
 * emits is double-quoted, so only the double quote needs escaping beyond
 * text content.
 */
export function escapeXmlAttribute(text: string): string {
  return escapeGoalText(text).replace(/"/g, '&quot;');
}
