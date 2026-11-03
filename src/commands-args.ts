/**
 * Argument parsers for /goal commands: quote stripping, flag parsers,
 * objective splitting, budget shorthand, and dispatch detectors.
 * Pure parsing with no session context.
 */

import type {GoalMode} from './state-machine.ts';
import type {CreateGoalOptions} from './tools.ts';

export const CLEAR_COMMANDS = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
]);
export const STATUS_COMMANDS = new Set(['status', 'info']);
export const HISTORY_COMMANDS = new Set(['history', 'log']);
export const LIST_COMMANDS = new Set(['list', 'ls']);
export const NO_ARG_SUBCOMMANDS = new Set([
  'status',
  'info',
  'history',
  'log',
  'list',
  'ls',
  'pause',
  'resume',
  'handback',
  'review',
  'review-payload',
]);

/**
 * Every first token that introduces a goal subcommand. A first token that is
 * not one of these makes the whole line a bare objective — the zero-flag
 * `/goal <objective>` form. Kept in sync with the dispatch chain in
 * handleCommand and used solely for dispatch identity.
 */
export const SUBCOMMAND_ROOTS = new Set([
  'status',
  'info',
  'history',
  'log',
  'list',
  'ls',
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
  'pause',
  'resume',
  'accept',
  'accept-proposal',
  'reject',
  'reject-proposal',
  'handback',
  'review',
  'review-payload',
  'edit',
  'focus',
  'checkpoint',
  'add',
  'sequence',
]);

export function stripWrappingQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '`' && last === '`')
    ) {
      return text.slice(1, -1);
    }
  }
  return text;
}

interface ParsedGoalArgs {
  condition: string;
  options: CreateGoalOptions;
  tokenBudget: number | null;
  errors: string[];
}

const FLAG_PARSERS: Record<string, (value: string) => number> = {
  '--max-turns': v => parsePositiveInt(v, 'max-turns'),
  '--max-duration-ms': v => parsePositiveInt(v, 'max-duration-ms'),
  '--max-minutes': v => parsePositiveInt(v, 'max-minutes') * 60 * 1000,
  '--max-tokens': v => parsePositiveInt(v, 'max-tokens'),
  '--cooldown-ms': v => parseNonNegativeInt(v, 'cooldown-ms'),
  '--no-progress-threshold': v =>
    parseNonNegativeInt(v, 'no-progress-threshold'),
  '--no-progress-turns': v => parseNonNegativeInt(v, 'no-progress-turns'),
  '--no-tool-turns': v => parseNonNegativeInt(v, 'no-tool-turns'),
  '--max-recovery-turns': v => parseNonNegativeInt(v, 'max-recovery-turns'),
  '--max-unchanged-results': v =>
    parseNonNegativeInt(v, 'max-unchanged-results'),
  '--max-blocked-turns': v => parseNonNegativeInt(v, 'max-blocked-turns'),
};

export function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${flag} must be a positive integer (got "${value}")`);
  }
  return parsed;
}

export function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `--${flag} must be a non-negative integer (got "${value}")`,
    );
  }
  return parsed;
}

export function splitObjectives(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoteChar: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const isQuote = char === '"' || char === "'" || char === '`';
    if (isQuote && (quoteChar === null || quoteChar === char)) {
      quoteChar = quoteChar === null ? char : null;
      current += char;
    } else if (quoteChar === null && char === ';') {
      parts.push(current);
      current = '';
    } else if (quoteChar === null && char === '\n') {
      parts.push(current);
      current = '';
    } else if (quoteChar === null && char === '\r' && input[i + 1] === '\n') {
      parts.push(current);
      current = '';
      i++;
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map(p => stripWrappingQuotes(p.trim())).filter(Boolean);
}

export function parseBudgetShorthand(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value.trim());
  if (!match)
    throw new Error(
      `--budget must be a number with optional k/m suffix (got "${value}")`,
    );
  const num = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  const result =
    suffix === 'k' ? num * 1000 : suffix === 'm' ? num * 1_000_000 : num;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(
      `--budget must resolve to a positive integer (got "${value}")`,
    );
  }
  return result;
}

function parseGoalArguments(input: string): ParsedGoalArgs {
  const tokens: string[] = [];
  for (const raw of input.trim().split(/\s+/)) {
    const eqMatch = /^(--[a-z][-a-z]*=)(.+)$/i.exec(raw);
    if (eqMatch) {
      tokens.push(eqMatch[1].slice(0, -1));
      tokens.push(eqMatch[2]);
    } else {
      tokens.push(raw);
    }
  }
  const conditionParts: string[] = [];
  const options: CreateGoalOptions = {};
  let tokenBudget: number | null = null;
  const errors: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const flagMatch = /^--([a-z][-a-z]*)$/i.exec(token);

    if (!flagMatch) {
      conditionParts.push(token);
      i++;
      continue;
    }

    const flag = `--${flagMatch[1].toLowerCase()}`;

    if (flag === '--success' || flag === '--success-criteria') {
      const value = readQuotedValue(tokens, ++i);
      if (value.error) {
        errors.push(value.error);
        break;
      }
      options.successCriteria = value.text;
      i = value.nextIndex;
    } else if (flag === '--constraints' || flag === '--non-goals') {
      const value = readQuotedValue(tokens, ++i);
      if (value.error) {
        errors.push(value.error);
        break;
      }
      options.constraints = value.text;
      i = value.nextIndex;
    } else if (
      flag === '--pointer' ||
      flag === '--pointers' ||
      flag === '--artifact-pointer' ||
      flag === '--artifact-pointers'
    ) {
      const value = readQuotedValue(tokens, ++i);
      if (value.error) {
        errors.push(value.error);
        break;
      }
      const newPointers = value.text
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      options.artifactPointers = [
        ...(options.artifactPointers ?? []),
        ...newPointers,
      ];
      i = value.nextIndex;
    } else if (flag === '--mode') {
      const value = readQuotedValue(tokens, ++i);
      if (value.error) {
        errors.push(value.error);
        break;
      }
      const mode = value.text.toLowerCase();
      if (mode !== 'normal' && mode !== 'ordered') {
        errors.push(
          `--mode must be "normal" or "ordered" (got "${value.text}")`,
        );
        break;
      }
      options.mode = mode as GoalMode;
      i = value.nextIndex;
    } else if (flag === '--budget') {
      const value = readQuotedValue(tokens, ++i);
      if (value.error) {
        errors.push(value.error);
        break;
      }
      try {
        options.maxTokens = parseBudgetShorthand(value.text);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
      i = value.nextIndex;
    } else if (flag === '--token-budget') {
      const value = readQuotedValue(tokens, ++i);
      if (value.error) {
        errors.push(value.error);
        break;
      }
      try {
        tokenBudget = parseBudgetShorthand(value.text);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
      i = value.nextIndex;
    } else {
      const parser = FLAG_PARSERS[flag];
      if (parser) {
        const value = readQuotedValue(tokens, ++i);
        if (value.error) {
          errors.push(value.error);
          break;
        }
        try {
          const parsed = parser(value.text);
          if (flag === '--max-turns') options.maxTurns = parsed;
          else if (flag === '--max-duration-ms') options.maxDurationMs = parsed;
          else if (flag === '--max-minutes') options.maxDurationMs = parsed;
          else if (flag === '--max-tokens') options.maxTokens = parsed;
          else if (flag === '--cooldown-ms') options.minDelayMs = parsed;
          else if (flag === '--no-progress-threshold')
            options.noProgressTokenThreshold = parsed;
          else if (flag === '--no-progress-turns')
            options.noProgressTurnsBeforePause = parsed;
          else if (flag === '--no-tool-turns')
            options.noToolCallTurnsBeforePause = parsed;
          else if (flag === '--max-recovery-turns')
            options.maxRecoveryTurns = parsed;
          else if (flag === '--max-unchanged-results')
            options.maxUnchangedResults = parsed;
          else if (flag === '--max-blocked-turns')
            options.maxBlockedTurns = parsed;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
        i = value.nextIndex;
      } else {
        errors.push(`Unknown flag: ${flag}`);
        break;
      }
    }
  }

  const condition = stripWrappingQuotes(conditionParts.join(' ').trim());
  return {condition, options, tokenBudget, errors};
}

/**
 * Subcommands whose handler takes the rest of the line verbatim as its operand
 * and does not parse flags. For these, `--something` is part of the operand, so
 * canonicalization must not strip it: `focus a --max-turns 20` targets a
 * different goal reference than `focus a`, and `checkpoint x --max-turns 20`
 * saves a different summary.
 */
const RAW_OPERAND_ROOTS = new Set(['edit', 'focus', 'checkpoint']);

/**
 * Evaluates whether a `/goal` line is a bare objective (i.e. not prefixed by
 * a subcommand root, causing the handler to treat it as `set` via `replaceGoals`).
 *
 * This distinction is critical for duplicate-dispatch detection: while the canonical
 * key intentionally folds `add` and `set` together (both create goals), a missed
 * duplicate on `add` merely adds an extra goal, whereas a missed duplicate on a bare
 * objective triggers `replaceGoals`, wiping unfinished goals and rewriting the objective.
 */
export function isBareGoalObjective(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  for (const candidate of SUBCOMMAND_ROOTS) {
    if (lower === candidate || lower.startsWith(`${candidate} `)) return false;
  }
  return true;
}

/**
 * Canonical identity of a goal subcommand line, used for duplicate-dispatch detection.
 *
 * Resolves non-semantic differences introduced when models reproduce submission
 * text (whitespace, quoting, casing, diacritics, and flag order/omissions).
 *
 * The canonicalization strictly mirrors handler behavior:
 * - `add` and bare objectives strip flags via `parseGoalArguments`.
 * - `edit`, `focus`, and `checkpoint` preserve operands verbatim.
 * - `sequence` splits on `;` and newlines into an ordered list of objectives.
 */
export function canonicalGoalDispatch(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';

  // Mirror the handler's dispatch rule: a root introduces a subcommand only
  // as a whole token (`root` or `root <rest>`). Splitting on arbitrary whitespace
  // would misclassify lines like `sequence\na`, which the handler treats as a bare objective.
  const lower = trimmed.toLowerCase();
  let root: string | null = null;
  for (const candidate of SUBCOMMAND_ROOTS) {
    if (lower === candidate || lower.startsWith(`${candidate} `)) {
      root = candidate;
      break;
    }
  }
  const subcommand = root === null ? 'set' : root === 'add' ? 'set' : root;

  // Preserve internal whitespace and newlines in the remainder, as `splitObjectives`
  // treats newlines as delimiters and handlers rely on verbatim slicing.
  const rest = root === null ? trimmed : trimmed.slice(root.length).trim();
  if (subcommand === 'sequence') {
    // Sequences match on parsed objective lists rather than raw text.
    // Duplicate misses on sequences are destructive (replacing all active goals),
    // so objectives are normalized across casing, quoting, whitespace, and trailing punctuation.
    const parts = splitObjectives(rest).map(part =>
      normalizeObjectiveText(part),
    );
    return `${subcommand}\u0000${parts.join('\u0001')}`;
  }
  if (RAW_OPERAND_ROOTS.has(subcommand)) {
    // Exact operand matching: only `edit` strips quotes; `focus` and `checkpoint` take
    // the raw slice to avoid false matches across distinct references or summaries.
    const operand = subcommand === 'edit' ? stripWrappingQuotes(rest) : rest;
    return `${subcommand}\u0000${operand}`;
  }

  // Parse `add` and bare objectives using the standard argument parser so flags are
  // extracted and the objective text is normalized.
  const condition = parseGoalArguments(rest).condition;
  return `${subcommand}\u0000${normalizeObjectiveText(condition)}`;
}

/**
 * Normalizes text variations commonly introduced by language models:
 * casing, diacritics, quotes, repeated whitespace, and trailing punctuation.
 * Structural internal punctuation (`;`, `,`, `:`) is preserved.
 */
export function normalizeObjectiveText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/["'`]/g, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function readQuotedValue(
  tokens: string[],
  startIndex: number,
): {text: string; nextIndex: number; error?: string} {
  if (startIndex >= tokens.length) {
    return {text: '', nextIndex: startIndex, error: 'Missing value for flag'};
  }
  const first = tokens[startIndex];
  if (first === '=') {
    return readQuotedValue(tokens, startIndex + 1);
  }
  const quoteChar = first[0];
  const isQuote = quoteChar === '"' || quoteChar === "'" || quoteChar === '`';
  if (isQuote && (first.length === 1 || !first.endsWith(quoteChar))) {
    const parts: string[] = [first];
    let idx = startIndex + 1;
    while (idx < tokens.length && !tokens[idx].endsWith(quoteChar)) {
      parts.push(tokens[idx]);
      idx++;
    }
    if (idx < tokens.length) {
      parts.push(tokens[idx]);
      idx++;
      const combined = parts.join(' ').slice(1, -1);
      return {text: combined, nextIndex: idx};
    }
    return {
      text: '',
      nextIndex: idx,
      error: 'Missing closing quote in flag value',
    };
  }
  if (isQuote && first.endsWith(quoteChar) && first.length > 1) {
    return {text: first.slice(1, -1), nextIndex: startIndex + 1};
  }
  if (/^--([a-z][-a-z]*)$/i.test(first)) {
    return {text: '', nextIndex: startIndex, error: 'Missing value for flag'};
  }
  return {text: first, nextIndex: startIndex + 1};
}

export {parseGoalArguments};
