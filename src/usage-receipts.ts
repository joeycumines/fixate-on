import {USAGE_TOKEN_FIELDS, type UsageSnapshot} from './accounting.ts';

/** Bound durable replay memory per goal, including compacted-message tombstones. */
export const MAX_USAGE_RECEIPTS = 1000;

export interface MessageUsageReading {
  usage: UsageSnapshot;
  tokens: number;
  outputTokens: number;
  observed: boolean;
}

export interface MessageUsageReceipt {
  reading: MessageUsageReading;
  admitted: boolean;
  createdAt: number | null;
  /** A historical baseline did not include cost; its first known cost is also a baseline. */
  costBaselinePending: boolean;
  /** Removed after admission; lets a snapshot taken during preparation recover its peers. */
  pending?: {goalIDs: string[]; baseline: MessageUsageReading};
}

export type SerializedUsageReceipts = Array<[string, MessageUsageReceipt]>;

export interface PendingSessionUsage {
  observed: UsageSnapshot;
  baseline: UsageSnapshot;
  goalIDs: string[];
}

export function copyPendingSessionUsage(
  value: PendingSessionUsage | undefined,
): PendingSessionUsage | undefined {
  return value
    ? {
        observed: {...value.observed},
        baseline: {...value.baseline},
        goalIDs: [...value.goalIDs],
      }
    : undefined;
}

export function deserializePendingSessionUsage(
  value: unknown,
): PendingSessionUsage | undefined {
  const batch = value as PendingSessionUsage | null;
  if (
    !batch ||
    !Array.isArray(batch.goalIDs) ||
    batch.goalIDs.length > 200 ||
    batch.goalIDs.some(id => typeof id !== 'string' || !id || id.length > 2000)
  )
    return undefined;
  for (const usage of [batch.observed, batch.baseline]) {
    if (
      !usage ||
      !USAGE_TOKEN_FIELDS.every(
        field => Number.isSafeInteger(usage[field]) && usage[field] >= 0,
      ) ||
      typeof usage.cost !== 'number' ||
      !Number.isFinite(usage.cost) ||
      usage.cost < 0 ||
      typeof usage.costKnown !== 'boolean'
    )
      return undefined;
  }
  return copyPendingSessionUsage(batch);
}

export function copyUsageReading(
  reading: MessageUsageReading,
): MessageUsageReading {
  return {...reading, usage: {...reading.usage}};
}

function copyReceipt(receipt: MessageUsageReceipt): MessageUsageReceipt {
  return {
    ...receipt,
    reading: copyUsageReading(receipt.reading),
    ...(receipt.pending
      ? {
          pending: {
            goalIDs: [...receipt.pending.goalIDs],
            baseline: copyUsageReading(receipt.pending.baseline),
          },
        }
      : {}),
  };
}

export function serializeUsageReceipts(
  receipts: Map<string, MessageUsageReceipt> | undefined,
): SerializedUsageReceipts | undefined {
  return receipts
    ? [...receipts].map(([id, receipt]) => [id, copyReceipt(receipt)])
    : undefined;
}

export function copyUsageReceipts(
  receipts: Map<string, MessageUsageReceipt> | undefined,
): Map<string, MessageUsageReceipt> | undefined {
  const serialized = serializeUsageReceipts(receipts);
  return serialized ? new Map(serialized) : undefined;
}

/** Invalid receipts take the explicit legacy-baseline path; never invent zero use. */
export function deserializeUsageReceipts(
  value: unknown,
): Map<string, MessageUsageReceipt> | undefined {
  if (!Array.isArray(value) || value.length > MAX_USAGE_RECEIPTS)
    return undefined;
  const receipts = new Map<string, MessageUsageReceipt>();
  const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const validReading = (reading: MessageUsageReading | undefined) => {
    const usage = reading?.usage;
    return (
      count(reading?.tokens) &&
      count(reading?.outputTokens) &&
      typeof reading?.observed === 'boolean' &&
      usage &&
      USAGE_TOKEN_FIELDS.every(field => count(usage[field])) &&
      typeof usage.cost === 'number' &&
      Number.isFinite(usage.cost) &&
      usage.cost >= 0 &&
      typeof usage.costKnown === 'boolean'
    );
  };
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [id, receipt] = entry as [unknown, MessageUsageReceipt | null];
    const reading = receipt?.reading;
    const pending = receipt?.pending;
    if (
      typeof id !== 'string' ||
      !id ||
      id.length > 2000 ||
      receipts.has(id) ||
      typeof receipt?.admitted !== 'boolean' ||
      typeof receipt.costBaselinePending !== 'boolean' ||
      (receipt.createdAt !== null && !count(receipt.createdAt)) ||
      !validReading(reading) ||
      (pending !== undefined &&
        (!Array.isArray(pending?.goalIDs) ||
          pending.goalIDs.length > 200 ||
          pending.goalIDs.some(
            id => typeof id !== 'string' || !id || id.length > 2000,
          ) ||
          !validReading(pending.baseline)))
    )
      return undefined;
    receipts.set(id, copyReceipt(receipt));
  }
  return receipts;
}
