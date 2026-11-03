// vocabulary-lock.ts — the shared vocabulary rule, in one place.
//
// AGENTS.md names one set of terms and BANS a second set, because the banned
// words assert a certainty that does not exist: a command check can be edited by
// the model, a test rewritten, a command's meaning changed underneath it. There
// is no ranking between verifiers, so there is no word for one.
//
// This lives in its own module rather than inside a single test file because the
// rule has to be applied WHERE THE PATH IS DRIVEN. A vocabulary assertion whose
// fixture hardcodes the expected string shows nothing: it passes whether or not
// the product produces that string. The lesson is recorded in the audit —
// **a lock is only as strong as the fixtures it drives.** So the suites that
// exercise a real code path import `assertClean` and run it on the REAL output,
// and this file holds only the rule.

import {expect} from 'bun:test';

/** Words that assert a certainty this product does not have. */
export const BANNED = [
  'oracle',
  'classifier',
  'promised',
  'proven',
  'safety stop',
  'load flake',
  'verified-complete', // internal ledger vocabulary, never a user-facing label
  'auditor', // AGENTS.md bans it as a synonym of verifier
  'unverifiable', // the ledger token; the shared word is "unattested"
] as const;

/**
 * Banned words that need a WORD-BOUNDARY test rather than a substring test.
 *
 * `prove` cannot go in `BANNED`, because "approve"/"approved" contain it as a
 * substring — the ban list says `proven` for exactly that reason. But that left a
 * hole: a mutation that put "must prove completion" back into the continuation
 * steering turned NOTHING red, because `prove` itself was never matched.
 *
 * A vocabulary rule with a silent hole is worse than no rule, because it reads as
 * enforced. So the prove-family is matched on word boundaries.
 */
const BANNED_WORDS: readonly RegExp[] = [
  /\bprove\b/,
  /\bproof\b/,
  /\bproves\b/,
  /\bproving\b/,
];

/**
 * Assert that `text` contains no banned word.
 *
 * `label` names the surface so a failure says WHICH one drifted.
 */
export function assertClean(label: string, text: string): void {
  const lowered = text.toLowerCase();
  for (const word of BANNED) {
    expect(
      lowered,
      `${label} must not say "${word}"; it asserts a certainty that does not exist`,
    ).not.toContain(word);
  }
  for (const pattern of BANNED_WORDS) {
    expect(
      lowered,
      `${label} must not say "${pattern.source}"; it asserts a certainty that does not exist`,
    ).not.toMatch(pattern);
  }
}

// The AGENTS.md banned list, parsed — never restated
//
// A restated list is a second source of truth, and a second source of truth
// drifts: AGENTS.md can gain a banned word and a gate that restates the list
// keeps passing. AGENTS.md's format supports parsing — one paragraph introduced
// by a fixed phrase, holding a run of `*word*` — so the two cannot come apart.
// Both the prose gate (vocabulary.test.ts) and the source gate
// (source-vocabulary.test.ts) read through these, so the rule lives once.

/** The phrase AGENTS.md introduces its banned list with. Parsed, never restated. */
export const BANNED_LIST_INTRO =
  'Banned, because they assert a certainty that does not exist:';

/**
 * Read the banned words out of an AGENTS.md-shaped document.
 *
 * A paren gloss sits outside the emphasis (`*auditor* (as synonyms of
 * verifier)`), so only the emphasised runs are captured — which is exactly the
 * list, not the sentence around it.
 */
export function parseBannedList(agents: string): string[] {
  const at = agents.indexOf(BANNED_LIST_INTRO);
  if (at === -1)
    throw new Error(`AGENTS.md no longer contains "${BANNED_LIST_INTRO}"`);
  const paragraph = agents
    .slice(at + BANNED_LIST_INTRO.length)
    .split(/\n\s*\n/, 1)[0];
  return [...paragraph.matchAll(/\*([^*]+)\*/g)]
    .map(m => m[1].trim())
    .filter(w => w !== '');
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One banned word, as a pattern.
 *
 * WORD BOUNDARIES, not substring. `proven` is a substring of "provenance" and
 * `promised` of "compromised", and a matcher that flags those is a matcher
 * somebody turns off — which is worse than no matcher at all, because it reads
 * as enforced. `BANNED_WORDS` above already applies boundaries to the
 * prove-family for the same reason; this generalises that to every entry.
 *
 * THE OPTIONAL PLURAL on the last word is not leniency: `safety stop` is the
 * banned concept and `safety stops` is the same concept inflected, so the
 * pattern has to reach it.
 */
export const bannedPattern = (word: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(word)}s?(?![\\p{L}\\p{N}])`,
    'gu',
  );

/**
 * The prove-family, matched on word boundaries.
 *
 * `prove` cannot go in `BANNED` as a substring, because "approve"/"approved"
 * contain it — the ban list says `proven` for exactly that reason. Exposed so
 * the source gate can apply the same family to src/ and index.d.ts that
 * `assertClean` applies to rendered strings.
 */
export const PROVE_FAMILY: readonly RegExp[] = BANNED_WORDS;
