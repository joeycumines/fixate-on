/**
 * Token accounting: maps OpenCode's normalized token fields to the charged-token
 * count used for budget enforcement.
 *
 * charged = input + cacheWrite + output + reasoning. This deliberately
 * includes reasoning tokens (stricter: trips budgets early, never late),
 * unlike some other runtimes which omit them. `output + reasoning`
 * reconstructs total outputTokens, so this is not a double-count.
 */

/** Normalized token usage. See module header for the OpenCode representation. */
export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown: boolean;
}

export const USAGE_TOKEN_FIELDS = [
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheWrite',
] as const;

/**
 * Token fields checked for step-boundary detection.
 *
 * cacheRead is excluded: it is a historical value (cached context tokens) that
 * can decrease via stat corrections or compaction without a new step occurring.
 * Only charged fields whose decrease reliably signals a per-step replacement are checked.
 */
const STEP_DETECTION_FIELDS = [
  'input',
  'output',
  'reasoning',
  'cacheWrite',
] as const;

/**
 * The charged-token count for a usage snapshot.
 * Formula: input + cacheWrite + output + reasoning.
 */
export function chargedTokens(usage: UsageSnapshot | null | undefined): number {
  if (!usage) return 0;
  return (
    toNonNegativeInteger(usage.input) +
    toNonNegativeInteger(usage.cacheWrite) +
    toNonNegativeInteger(usage.output) +
    toNonNegativeInteger(usage.reasoning)
  );
}

/** Create an empty usage snapshot. */
export function emptyUsage(): UsageSnapshot {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
}

/**
 * Normalize an arbitrary object into a valid UsageSnapshot. Invalid values are
 * clamped to 0 so diagnostics can never corrupt budget enforcement.
 */
export function normalizeUsage(value: unknown): UsageSnapshot {
  const source =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const usage = emptyUsage();
  for (const field of USAGE_TOKEN_FIELDS) {
    usage[field] = toNonNegativeInteger(source[field]);
  }
  const rawCost = source.cost;
  usage.cost =
    Number.isFinite(Number(rawCost)) && Number(rawCost) >= 0
      ? Number(rawCost)
      : 0;
  usage.costKnown = source.costKnown === true || usage.cost > 0;
  return usage;
}

/**
 * Normalize an OpenCode message into a UsageSnapshot. Reads from
 * message.info.tokens (the shape published by OpenCode's processor at
 * step-finish).
 */
export function normalizeMessageUsage(message: unknown): UsageSnapshot {
  const msg = message as Record<string, unknown> | null;
  const info = msg?.info as Record<string, unknown> | null;
  const tokens = (info?.tokens ?? msg?.tokens ?? msg?.usage ?? {}) as Record<
    string,
    unknown
  >;
  const cache =
    typeof tokens.cache === 'object' && tokens.cache !== null
      ? (tokens.cache as Record<string, unknown>)
      : {};
  const rawCost = info?.cost ?? msg?.cost ?? tokens.cost;

  return {
    input: toNonNegativeInteger(
      tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens,
    ),
    output: toNonNegativeInteger(
      tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens,
    ),
    reasoning: toNonNegativeInteger(
      tokens.reasoning ?? tokens.reasoning_tokens,
    ),
    cacheRead: toNonNegativeInteger(
      cache.read ?? tokens.cacheRead ?? tokens.cache_read,
    ),
    cacheWrite: toNonNegativeInteger(
      cache.write ?? tokens.cacheWrite ?? tokens.cache_write,
    ),
    cost:
      Number.isFinite(Number(rawCost)) && Number(rawCost) >= 0
        ? Number(rawCost)
        : 0,
    costKnown:
      rawCost != null &&
      Number.isFinite(Number(rawCost)) &&
      Number(rawCost) >= 0,
  };
}

/**
 * Add a delta to ONE usage field, returning a new UsageSnapshot. Used by the
 * cumulative-usage path (v2 `session.usage.updated` publishes session running
 * totals, so only the increase since the last reading is charged).
 */
export function addToUsageField(
  total: UsageSnapshot,
  field: keyof UsageSnapshot,
  delta: number,
): UsageSnapshot {
  const next = normalizeUsage(total);
  const current = next[field];
  if (typeof current === 'number') {
    (next as unknown as Record<string, number>)[field as string] =
      current + delta;
  }
  return next;
}

/**
 * Accumulate a usage delta. Token fields are per-step (replaced, not
 * cumulative) while cost accumulates, so cost alone misses zero-cost models.
 * A new step is cost-increased or any charged field decreased; cacheRead is
 * excluded (historical value, can decrease without a new step).
 */
export function addUsageDelta(
  total: UsageSnapshot,
  current: UsageSnapshot,
  previous: UsageSnapshot,
  isNewStep = false,
): UsageSnapshot {
  const next = normalizeUsage(total);
  const cur = normalizeUsage(current);
  const prev = normalizeUsage(previous);
  const costIncreased = prev.cost > 0 && cur.cost > prev.cost;
  const anyTokenFieldDecreased = STEP_DETECTION_FIELDS.some(
    field => cur[field] < prev[field],
  );
  const completedAnotherStep =
    isNewStep || costIncreased || anyTokenFieldDecreased;

  for (const field of USAGE_TOKEN_FIELDS) {
    next[field] += completedAnotherStep
      ? cur[field]
      : Math.max(0, cur[field] - prev[field]);
  }
  next.cost += Math.max(0, cur.cost - prev.cost);
  next.costKnown ||= cur.costKnown;
  return next;
}

/**
 * Extract token fields from an OpenCode message for context-window tracking.
 * Returns the per-step total (input + output + reasoning + cache read + cache write),
 * matching OpenCode's display.
 */
export function totalTokensForMessage(message: unknown): number {
  const msg = message as Record<string, unknown> | null;
  const info = msg?.info as Record<string, unknown> | null;
  const tokens = (info?.tokens ?? msg?.tokens ?? msg?.usage ?? {}) as Record<
    string,
    unknown
  >;
  const reportedTotal = toNonNegativeInteger(tokens.total);
  if (reportedTotal > 0) return reportedTotal;
  return (
    toNonNegativeInteger(
      tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens,
    ) +
    toNonNegativeInteger(
      tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens,
    ) +
    toNonNegativeInteger(tokens.reasoning ?? tokens.reasoning_tokens) +
    cacheTokensForMessage(tokens)
  );
}

/**
 * Extract the output token count from an OpenCode message. Used for
 * no-progress detection (stall = output below threshold).
 */
export function outputTokensForMessage(message: unknown): number | null {
  const msg = message as Record<string, unknown> | null;
  const info = msg?.info as Record<string, unknown> | null;
  const tokens = (info?.tokens ?? msg?.tokens ?? msg?.usage ?? {}) as Record<
    string,
    unknown
  >;
  const outputRaw =
    tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens;
  const output = toNonNegativeInteger(outputRaw);
  if (
    outputRaw === undefined &&
    (info?.tokens === undefined || info?.tokens === null) &&
    (msg?.tokens === undefined || msg?.tokens === null) &&
    (msg?.usage === undefined || msg?.usage === null)
  )
    return null;
  return output;
}

function cacheTokensForMessage(tokens: Record<string, unknown>): number {
  const cache =
    typeof tokens.cache === 'object' && tokens.cache !== null
      ? (tokens.cache as Record<string, unknown>)
      : {};
  return (
    toNonNegativeInteger(cache.read ?? tokens.cacheRead ?? tokens.cache_read) +
    toNonNegativeInteger(cache.write ?? tokens.cacheWrite ?? tokens.cache_write)
  );
}

export function toNonNegativeInteger(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
