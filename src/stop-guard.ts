/**
 * @file Advisory phrase triage for premature-exit language.
 *
 * This module provides heuristic phrase matching for early stopping signals.
 * It is purely advisory and does not act as an authoritative gate: the completion
 * gate (completion-gate.ts) is authoritative. This module only provides additional
 * context for recovery prompts when the verifier reports WORKING, and never blocks
 * a verified COMPLETE state.
 */

/**
 * Advisory verdict from phrase triage. `tier: "phrase"` indicates an
 * unfinished-work or deferral signal was matched; `tier: "none"` indicates no match.
 */
export interface PhraseTriageVerdict {
  tier: 'phrase' | 'none';
  reason: string;
}

/**
 * Fixed local correction returned on any phrase match.
 *
 * Prompts the agent to check the live completion contract and report
 * its terminal state with evidence rather than returning model-supplied prose.
 */
export const PHRASE_REASON =
  'Language triage found an explicit unfinished-work or deferral signal. ' +
  'Check the live completion contract now. Continue if required state or ' +
  'verification is missing; otherwise report COMPLETE, BLOCKED, ' +
  'NEEDS_INPUT, or authorized CANCELLED with evidence.';

/**
 * Maximum input size for triage scanning in characters to bound pathological inputs.
 */
const MAX_TRIAGE_BYTES = 16384;

/**
 * Phrase patterns detecting unfinished work, deferral, permission-seeking,
 * and premature session quitting.
 *
 * Patterns are anchored with `(^|[^a-z0-9_])` prefix and `(?=$|[^a-z0-9_])` suffix
 * to avoid matching substrings within larger identifiers (e.g., "eventually" inside
 * "eventuallyConsistent"). First match wins.
 */
const PATTERNS: readonly RegExp[] = [
  // Explicit unfinished-work
  /(^|[^a-z0-9_])remaining\s+(tasks?|work|items?|steps?|todos?)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])next\s+steps?(\s*(are|would\s+be|include|:))/i,
  /(^|[^a-z0-9_])still\s+(need\s+to|left\s+to|to\s+do|remain|have\s+to)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])to\s+be\s+(done|completed|implemented|handled)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])outstanding\s+(tasks?|items?|work)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])left\s+to\s+(do|implement|handle|complete)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])tests?\s+(were|was|have|has)?\s*not\s+(run|executed)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])(feature|task|work)\s+is\s+not\s+(done|complete|finished)(?=$|[^a-z0-9_])/i,

  // Deferral / future session
  /(^|[^a-z0-9_])next\s+session(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])in\s+a\s+(future|later|subsequent)\s+(session|pr|commit|change)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])come\s+back\s+to\s+(this|it|that)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])pick\s+(this|it)\s+up\s+(later|next|afterwards)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])save\s+it\s+for\s+(later|next|a\s+follow)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])defer(red|ring)?\s+(this|that|the)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])follow[- ]up\s+(session|pr|commit|change|task)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])(at\s+some\s+point|down\s+the\s+road|in\s+due\s+(course|time))(?=$|[^a-z0-9_])/i,

  // Permission-seeking
  /(^|[^a-z0-9_])should\s+i\s+(continue|proceed|keep\s+going)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])shall\s+i\s+(continue|proceed)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])would\s+you\s+like\s+me\s+to\s+(continue|keep\s+going|proceed)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])want\s+me\s+to\s+(continue|keep\s+going|proceed)(?=$|[^a-z0-9_])/i,

  // Session-length quitting
  /(^|[^a-z0-9_])(good|natural)\s+(stopping\s+point|place\s+to\s+stop|checkpoint)(?=$|[^a-z0-9_])/i,
  /(^|[^a-z0-9_])given\s+the\s+(length|size)\s+of\s+(this|the)\s+session(?=$|[^a-z0-9_])/i,
];

if (PATTERNS.length !== 22) {
  throw new Error(`stop-guard: expected 22 patterns, got ${PATTERNS.length}`);
}

/**
 * Scans an agent's final message for premature-exit language.
 *
 * Returns `{tier: "phrase", reason: PHRASE_REASON}` on the first pattern match,
 * or `{tier: "none", reason: ""}` if no patterns match or the input is empty.
 *
 * @param message The agent's final message text.
 */
export function scanPrematureExit(message: string): PhraseTriageVerdict {
  if (!message || typeof message !== 'string') {
    return {tier: 'none', reason: ''};
  }

  // Pre-slice raw characters to avoid large array allocations on multi-megabyte inputs,
  // then slice unicode code points to correctly bound character count.
  const truncated = message.slice(0, MAX_TRIAGE_BYTES * 2);
  const bounded = Array.from(truncated).slice(0, MAX_TRIAGE_BYTES).join('');

  for (const pattern of PATTERNS) {
    if (pattern.test(bounded)) {
      return {tier: 'phrase', reason: PHRASE_REASON};
    }
  }
  return {tier: 'none', reason: ''};
}
