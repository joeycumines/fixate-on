/**
 * Command dispatch handling: distinguishes host command replays from human input.
 *
 * Covers:
 * - Slash-echo suppression (host template arriving as a chat turn)
 * - Command-dispatch deduplication (same submission reaching hook and agent tool call)
 * - Explicit-stop detection (whole-message stop directive halting auto-resume)
 */

import {GOAL_COMMAND_TEMPLATE_PREFIX} from './native-agent-config.ts';
import {
  canonicalGoalDispatch,
  isBareGoalObjective,
  parseGoalCommand,
} from './commands-args.ts';

/**
 * True when `text` is the host's own replay of our config command template.
 * The host leads with the prefix, so the test is a trimmed `startsWith`; an
 * `includes` test would swallow a human quoting the sentence mid-message.
 */
export function isCommandTemplateEcho(text: string): boolean {
  return text.trimStart().startsWith(GOAL_COMMAND_TEMPLATE_PREFIX);
}

// Stock v1 replays a slash submission back through chat.message in two shapes:
// our formatted hook output and the bare-arguments line. This map fingerprints
// each dispatch so the pause path can tell that echo from genuine steering:
// only an exact in-window text match counts.
const recentSlashEcho = new Map<string, Array<{at: number; args: string}>>();
const SLASH_ECHO_WINDOW_MS = 5000;
const MAX_SLASH_ECHO_SESSIONS = 256;
const MAX_SLASH_ECHO_PER_SESSION = 16;

/** Record the arguments of a slash-command dispatch for this session. */
export function markSlashDispatch(sessionID: string, args: string): void {
  if (!sessionID) return;
  if (
    !recentSlashEcho.has(sessionID) &&
    recentSlashEcho.size >= MAX_SLASH_ECHO_SESSIONS
  ) {
    const oldest = recentSlashEcho.keys().next().value;
    if (oldest !== undefined) recentSlashEcho.delete(oldest);
  }
  const now = Date.now();
  const queue = (recentSlashEcho.get(sessionID) ?? []).filter(
    e => now - e.at < SLASH_ECHO_WINDOW_MS,
  );
  queue.push({at: now, args});
  while (queue.length > MAX_SLASH_ECHO_PER_SESSION) queue.shift();
  recentSlashEcho.set(sessionID, queue);
}

// The idle hook is the fallback when chat.message is dropped. It must suppress
// a replayed slash echo WITHOUT swallowing a later genuine message that happens
// to use the same text. Record the replay's message id when chat.message matches
// the fingerprint, then skip only that id in the idle history scans.
const echoedMessageIDs = new Map<
  string,
  Array<{at: number; messageID: string}>
>();
const MAX_ECHOED_MESSAGE_IDS = MAX_SLASH_ECHO_PER_SESSION;

/** Remember that a host chat replay matched a slash dispatch fingerprint. */
export function recordSlashEchoMessage(
  sessionID: string,
  messageID: string | undefined,
): void {
  if (!sessionID || !messageID) return;
  const now = Date.now();
  const queue = (echoedMessageIDs.get(sessionID) ?? []).filter(
    e => now - e.at < SLASH_ECHO_WINDOW_MS,
  );
  queue.push({at: now, messageID});
  while (queue.length > MAX_ECHOED_MESSAGE_IDS) queue.shift();
  echoedMessageIDs.set(sessionID, queue);
}

/** True only for the specific message that chat.message matched as an echo. */
export function isSlashEchoMessage(
  sessionID: string,
  messageID: string | undefined,
): boolean {
  if (!sessionID || !messageID) return false;
  const queue = echoedMessageIDs.get(sessionID);
  if (!queue || queue.length === 0) return false;
  const now = Date.now();
  return queue.some(
    e => e.messageID === messageID && now - e.at < SLASH_ECHO_WINDOW_MS,
  );
}

/** Consume a matching in-window echo fingerprint for this session, if any. */
export function matchSlashEcho(sessionID: string, text: string): boolean {
  const queue = recentSlashEcho.get(sessionID);
  if (!queue || queue.length === 0) return false;
  const now = Date.now();
  const matchIndex = queue.findIndex(
    e => now - e.at < SLASH_ECHO_WINDOW_MS && text === e.args,
  );
  if (matchIndex < 0) return false;
  queue.splice(matchIndex, 1);
  if (queue.length === 0) recentSlashEcho.delete(sessionID);
  return true;
}

// Stock v1 1.18.32 runs BOTH command channels for a single `/goal` submission:
// the `command.execute.before` hook dispatches the subcommand while the host
// discards the hook's rendered parts, and the config command template ALSO
// reaches the agent, whose `goal-command` tool call dispatches the SAME
// subcommand a second time. One `/goal <objective>` created two goals and
// removed the first: the bare-objective form routes through `replaceGoals`.
//
// A dispatch that changed nothing is safe to repeat only when its subcommand
// is READ-ONLY (status/history/list); those are never recorded, so they keep
// reporting fresh state. A MUTATING dispatch that found nothing to change
// (clear with no goal) IS recorded, because the duplicate channel exists to
// answer a second dispatch that can arrive after the world has changed — see
// isMutatingCommand.
//
// The remaining scoping is deliberately narrow: exact canonical-identity match,
// consumed once, per session. A genuine repeat invocation runs the hook again
// and records a fresh entry.
const recentCommandDispatch = new Map<
  string,
  Array<{
    at: number;
    key: string;
    result: string;
    receipt: string;
    bare: boolean;
  }>
>();

// Bounded so a stale entry cannot outlive its submission by long: the duplicate
// arrives one agent round trip after the hook (observed ~2s), so a minute is
// generous while keeping the window during which a never-replayed entry could
// answer a later identical command as small as practical.
const COMMAND_DISPATCH_WINDOW_MS = 60_000;
const MAX_COMMAND_DISPATCH_SESSIONS = 256;
const MAX_COMMAND_DISPATCH_PER_SESSION = 16;

/**
 * Commands that can mutate goal state need replay protection even when a
 * particular dispatch found nothing to change. Use the execution parser so
 * tabs, aliases and multiline objectives have exactly the same meaning here.
 *
 * MEASURED 2026-10-24 (run 2026-10-24T23:04:34Z, the v1 host's own DB): a
 * `clear` dispatched by the command hook with no goal present (changed=false,
 * unrecorded) had its agent-channel duplicate execute ten seconds later — by
 * which time a goal HAD been created — and destroy it. "Repeating a no-op is
 * harmless" is false for a mutating root: the repeat is only a no-op if the
 * world did not change in between, and the duplicate channel exists precisely
 * because the world changes between the two dispatches.
 */
function isMutatingCommand(line: string): boolean {
  const command = parseGoalCommand(line);
  return !command.readOnly && command.action !== 'invalid';
}

/**
 * Record a dispatch that moved goal state, so the duplicate channel replays its
 * outcome instead of applying the same mutation twice. A dispatch that altered
 * nothing is recorded only when its subcommand is a mutating root: a read-only
 * dispatch (status, list, history) keeps reporting fresh state on repeat, while
 * a mutating no-op (clear with no goal) is recorded so its late duplicate
 * replays the no-op's receipt instead of destroying whatever appeared between
 * the two dispatches.
 */
export function markCommandDispatch(
  sessionID: string,
  subcommand: string,
  result: string,
  receipt: string,
  changed: boolean,
): void {
  if (!sessionID || !subcommand.trim()) return;
  if (!changed && !isMutatingCommand(subcommand)) return;
  const key = canonicalGoalDispatch(subcommand);
  if (!key) return;
  // The bare form is load-bearing for the duplicate rule and is NOT recoverable
  // from the key, which folds `add` into `set`. See dispatchIdentitiesMatch.
  const bare = isBareGoalObjective(subcommand);
  if (
    !recentCommandDispatch.has(sessionID) &&
    recentCommandDispatch.size >= MAX_COMMAND_DISPATCH_SESSIONS
  ) {
    const oldest = recentCommandDispatch.keys().next().value;
    if (oldest !== undefined) recentCommandDispatch.delete(oldest);
  }
  const now = Date.now();
  const queue = (recentCommandDispatch.get(sessionID) ?? []).filter(
    e => now - e.at < COMMAND_DISPATCH_WINDOW_MS,
  );
  queue.push({at: now, key, result, receipt, bare});
  while (queue.length > MAX_COMMAND_DISPATCH_PER_SESSION) queue.shift();
  recentCommandDispatch.set(sessionID, queue);
}

/**
 * Words a model may add or drop while paraphrasing our template without
 * changing what is being asked. Deliberately tiny and closed.
 */
const INSIGNIFICANT_TOKENS = new Set(['a', 'an', 'the', 'please']);

/**
 * True when two canonical dispatch identities refer to the same submission.
 * Exact equality is the base case. A model reproducing our template may add
 * or drop one semantically empty function word, so one insertion/deletion
 * from the closed set below is tolerated.
 *
 * The tolerance stays that narrow because a general one-token rule matched
 * commands whose meaning inverts on one dropped word (`add do not delete the
 * files` vs `add do delete the files`). Dropping a content word is a
 * different command: a missed duplicate re-runs a mutation (visible,
 * recoverable), a false match reports success for work never done.
 */
function dispatchIdentitiesMatch(
  a: string,
  b: string,
  opts: {recordedBare: boolean; incomingBare: boolean},
): boolean {
  if (a === b) return true;
  const sep = a.indexOf('\u0000');
  const aSub = a.slice(0, sep);
  const bSub = b.slice(0, b.indexOf('\u0000'));
  if (aSub !== bSub) return false;
  const aCond = a.slice(sep + 1);
  const bCond = b.slice(b.indexOf('\u0000') + 1);
  const at = aCond.split(' ');
  const bt = bCond.split(' ');
  if (at.length < 2 || bt.length < 2) return false;
  const [shorter, longer] = at.length <= bt.length ? [at, bt] : [bt, at];

  // Truncation is tolerated for the bare objective form only. For `set` (the
  // form `/goal <objective>` produces), a missed duplicate destroys goals via
  // replaceGoals: a false match replays a receipt (harmless), but a miss
  // overwrites the user's objective.
  //
  // Only an echo that lost trailing text is treated as a duplicate. An incoming
  // command that is longer is considered a new command.
  // `a` is the recorded dispatch and `b` is the incoming one.
  if (opts.recordedBare && opts.incomingBare && bt.length < at.length) {
    const strip = (token: string): string =>
      token.replace(/^[.,;:!?"'`]+|[.,;:!?"'`]+$/g, '');
    if (bt.every((token, index) => strip(token) === strip(at[index] ?? '')))
      return true;
  }

  // Walk the longer sequence, allowing at most one unmatched insignificant word.
  // The final length check ensures substitutions aren't misread as insertions.
  let i = 0;
  let extra: string | null = null;
  for (const token of longer) {
    if (i < shorter.length && shorter[i] === token) {
      i++;
      continue;
    }
    if (extra === null) {
      extra = token;
      continue;
    }
    return false;
  }
  if (i !== shorter.length) return false;
  return extra !== null && INSIGNIFICANT_TOKENS.has(extra);
}

/**
 * Consume the recorded outcome of a state-moving dispatch that this call
 * duplicates, if one is still pending for this session. Returns null when this
 * dispatch is the only one and must execute normally.
 *
 * Matching is by canonical dispatch identity — the subcommand plus the
 * objective parsed by the same parser the command handler uses, with
 * whitespace, quoting, case, diacritics, and flags collapsed away.
 */
export function consumeCommandDispatch(
  sessionID: string,
  subcommand: string,
): {result: string; receipt: string} | null {
  if (!sessionID || !subcommand.trim()) return null;
  const queue = recentCommandDispatch.get(sessionID);
  if (!queue || queue.length === 0) return null;
  const incomingKey = canonicalGoalDispatch(subcommand);
  if (!incomingKey) return null;
  const now = Date.now();
  // Scan from the end so the duplicate resolves against the most recent match.
  const incomingBare = isBareGoalObjective(subcommand);
  const matchIndex = queue.findLastIndex(
    e =>
      now - e.at < COMMAND_DISPATCH_WINDOW_MS &&
      dispatchIdentitiesMatch(e.key, incomingKey, {
        recordedBare: e.bare,
        incomingBare,
      }),
  );
  if (matchIndex < 0) return null;
  const [entry] = queue.splice(matchIndex, 1);
  if (queue.length === 0) recentCommandDispatch.delete(sessionID);
  return {result: entry.result, receipt: entry.receipt};
}

// A whole-message stop imperative halts auto-resume. Longer or mixed
// messages stay re-armable. Conservative and fails open: an unrecognized
// phrasing keeps re-arm semantics; `/goal resume` revives an explicit pause.
const EXPLICIT_STOP_PHRASES = new Set([
  'stop',
  'stop it',
  'stop now',
  'stop working',
  'stop the goal',
  'stop the work',
  'halt',
  'cease',
  'stand down',
  'pause',
  'pause the goal',
  'hold',
  'hold off',
  'wait',
]);

export function isExplicitStopMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:…]+$/u, '');
  return EXPLICIT_STOP_PHRASES.has(normalized);
}
