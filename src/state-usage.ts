import {
  addUsageDelta,
  USAGE_TOKEN_FIELDS,
  type UsageSnapshot,
} from './accounting.ts';
import type {GoalState} from './goal-types.ts';
import {
  copyUsageReading,
  MAX_USAGE_RECEIPTS,
  type MessageUsageReading,
} from './usage-receipts.ts';

export interface MessageUsageUpdate {
  messageID: string;
  current: MessageUsageReading;
  assistant: boolean;
}

export interface MessageUsagePreparation extends MessageUsageUpdate {
  previous: MessageUsageReading;
  createdAt: number | null;
  goalIDs: string[];
}

export interface UsageLimits {
  history: number;
  notices: number;
  messages: number;
}

function recordUsageNotice(
  goal: GoalState,
  message: string,
  limits: UsageLimits,
) {
  const timestamp = Date.now();
  goal.pendingNotices.push({kind: 'usage-baseline', message, timestamp});
  if (goal.pendingNotices.length > limits.notices)
    goal.pendingNotices.splice(0, goal.pendingNotices.length - limits.notices);
  goal.history.push({type: 'usage-baseline', detail: message, timestamp});
  if (goal.history.length > limits.history)
    goal.history.splice(0, goal.history.length - limits.history);
}

/** Prepare every target's durable baseline before any charge or display await. */
export function prepareMessageUsage(
  goal: GoalState,
  input: MessageUsagePreparation,
  limits: UsageLimits,
): {changed: boolean; migrationNotice?: string} {
  if (goal.messageUsage?.has(input.messageID)) return {changed: false};
  let migrationNotice: string | undefined;
  if (!goal.messageUsage) {
    goal.messageUsage = new Map();
    goal.messageUsageBaselineAt ??= Date.now();
    migrationNotice = `Goal ${goal.goalId}: restored state has no message usage receipts. Previously recorded spend is preserved. Historical or undated messages are baselined on their first reading; usage accrued before that reading cannot be reconstructed. Later changes and newer dated messages are charged normally.`;
  }
  const boundary = goal.messageUsageBaselineAt;
  const historical =
    goal.messageIDs.has(input.messageID) ||
    (boundary !== undefined &&
      (input.createdAt === null || input.createdAt <= boundary));
  const baseline = copyUsageReading(
    historical ? input.current : input.previous,
  );
  if (historical) {
    baseline.usage.cost = Math.max(
      baseline.usage.cost,
      input.previous.usage.cost,
    );
    baseline.usage.costKnown ||= input.previous.usage.costKnown;
  }
  goal.messageUsage.set(input.messageID, {
    reading: baseline,
    admitted: historical,
    createdAt: input.createdAt,
    costBaselinePending: historical && !baseline.usage.costKnown,
    pending: {
      goalIDs: [...input.goalIDs],
      baseline: copyUsageReading(input.previous),
    },
  });
  if (historical) {
    goal.messageIDs.add(input.messageID);
    goal.totalTokens = Math.max(goal.totalTokens, input.current.tokens);
  }
  while (goal.messageUsage.size > MAX_USAGE_RECEIPTS) {
    const [id, receipt] = goal.messageUsage.entries().next().value!;
    goal.messageUsage.delete(id);
    goal.messageIDs.delete(id);
    // A timestamp boundary prevents an evicted replay from becoming fresh
    // spend. Undated first readings beyond the retained window are ambiguous;
    // baseline them and expose the loss of exact historical attribution.
    const cutoff = receipt.createdAt ?? Date.now();
    if (goal.messageUsageBaselineAt === undefined)
      migrationNotice = `Goal ${goal.goalId}: message usage replay protection retains ${MAX_USAGE_RECEIPTS} receipts. Older or undated first readings beyond that window are baselined; their earlier usage cannot be reconstructed. Recorded spend and later observed changes are preserved.`;
    goal.messageUsageBaselineAt = Math.max(
      goal.messageUsageBaselineAt ?? 0,
      cutoff,
    );
  }
  while (goal.messageIDs.size > limits.messages)
    goal.messageIDs.delete(goal.messageIDs.values().next().value!);
  if (migrationNotice) recordUsageNotice(goal, migrationNotice, limits);
  return {changed: true, ...(migrationNotice ? {migrationNotice} : {})};
}

/** Apply one message's charge and deduplication fields within the caller's lock. */
export function applyMessageUsage(
  goal: GoalState,
  {messageID, current: observed, assistant}: MessageUsageUpdate,
  historyLimit: number,
  messageLimit: number,
): boolean {
  const receipt = goal.messageUsage?.get(messageID);
  if (!receipt || (receipt.admitted && !goal.messageIDs.has(messageID)))
    return false;
  const previous = copyUsageReading(receipt.reading);
  const current = copyUsageReading(observed);
  // Host cost is cumulative within a message. Missing or lower readings must
  // not lower its watermark; token fields remain per-step and may decrease.
  current.usage.cost = Math.max(current.usage.cost, previous.usage.cost);
  current.usage.costKnown ||= previous.usage.costKnown;
  const costBaselined = receipt.costBaselinePending && current.usage.costKnown;
  if (costBaselined) {
    previous.usage.cost = current.usage.cost;
    previous.usage.costKnown = true;
  }
  const usageChanged =
    USAGE_TOKEN_FIELDS.some(
      field => current.usage[field] !== previous.usage[field],
    ) ||
    current.usage.cost !== previous.usage.cost ||
    current.usage.costKnown !== previous.usage.costKnown;
  const outputIncreased = current.outputTokens > previous.outputTokens;
  if (
    receipt.admitted &&
    !receipt.pending &&
    !costBaselined &&
    !usageChanged &&
    !outputIncreased &&
    current.tokens <= previous.tokens
  )
    return false;
  if (usageChanged)
    goal.usage = addUsageDelta(
      goal.usage,
      current.usage,
      previous.usage,
      !previous.observed,
    );
  goal.totalTokens = Math.max(goal.totalTokens, current.tokens);
  const now = Date.now();
  if (assistant && outputIncreased) goal.lastProgressAt = now;
  goal.messageIDs.add(messageID);
  receipt.reading = {
    ...current,
    tokens: Math.max(current.tokens, previous.tokens),
    outputTokens: Math.max(current.outputTokens, previous.outputTokens),
  };
  receipt.admitted = true;
  receipt.costBaselinePending &&= !current.usage.costKnown;
  delete receipt.pending;
  while (goal.messageIDs.size > messageLimit)
    goal.messageIDs.delete(goal.messageIDs.values().next().value!);
  goal.updatedAt = now;
  goal.history.push({
    type: 'tracking',
    detail: 'Updated message usage',
    timestamp: now,
  });
  if (goal.history.length > historyLimit)
    goal.history.splice(0, goal.history.length - historyLimit);
  return true;
}

/** Cumulative charge and watermark are changed together under the state lock. */
export function applyCumulativeUsage(
  goal: GoalState,
  observed: UsageSnapshot,
  previousSession: UsageSnapshot,
  limits: UsageLimits,
): {changed: boolean; migrationNotice?: string} {
  const legacy = goal.lastSessionUsage === undefined;
  const previous = legacy
    ? observed
    : (goal.lastSessionUsage ?? previousSession);
  const next = {...observed};
  const charged = {...goal.usage};
  for (const field of USAGE_TOKEN_FIELDS) {
    next[field] = Math.max(next[field], previous[field]);
    charged[field] += next[field] - previous[field];
  }
  next.cost = Math.max(next.cost, previous.cost);
  next.costKnown ||= previous.costKnown;
  charged.cost += next.cost - previous.cost;
  if (!legacy) charged.costKnown ||= next.costKnown;
  const total = USAGE_TOKEN_FIELDS.reduce((sum, field) => sum + next[field], 0);
  const changed =
    !goal.lastSessionUsage ||
    total > goal.totalTokens ||
    USAGE_TOKEN_FIELDS.some(field => charged[field] !== goal.usage[field]) ||
    charged.cost !== goal.usage.cost ||
    charged.costKnown !== goal.usage.costKnown;
  if (!changed) {
    const pending = goal.pendingSessionUsage !== undefined;
    delete goal.pendingSessionUsage;
    return {changed: pending};
  }
  goal.usage = charged;
  goal.totalTokens = Math.max(goal.totalTokens, total);
  goal.lastSessionUsage = next;
  delete goal.pendingSessionUsage;
  goal.updatedAt = Date.now();
  const migrationNotice = legacy
    ? `Goal ${goal.goalId}: restored state has no cumulative usage watermark. Previously recorded spend is preserved and accounting resumes from the current host reading. Usage accrued while the plugin was offline cannot be reconstructed; the context-token brake still uses the host's full cumulative total.`
    : undefined;
  if (migrationNotice) recordUsageNotice(goal, migrationNotice, limits);
  else {
    goal.history.push({
      type: 'tracking',
      detail: 'Updated cumulative session usage',
      timestamp: goal.updatedAt,
    });
    if (goal.history.length > limits.history)
      goal.history.splice(0, goal.history.length - limits.history);
  }
  return {changed: true, ...(migrationNotice ? {migrationNotice} : {})};
}
