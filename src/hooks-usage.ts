/**
 * Per-message token accounting and host terminal event detection.
 */

import type {GoalStateMachine} from './state-machine.ts';
import type {RuntimeState} from './session-state-manager.ts';
import type {SessionContext, TerminalEventInfo} from './hooks-types.ts';
import {getMessageID, messageCreatedAt} from './message-helpers.ts';
import type {MessageUsageReading} from './usage-receipts.ts';
import {
  emptyUsage,
  normalizeMessageUsage,
  outputTokensForMessage,
  totalTokensForMessage,
  USAGE_TOKEN_FIELDS,
  type UsageSnapshot,
} from './accounting.ts';

export function detectTerminalEvent(event: unknown): TerminalEventInfo | null {
  const e = event as {
    type?: string;
    sessionID?: string;
    properties?: Record<string, unknown>;
    data?: Record<string, unknown>;
  } | null;
  if (!e?.type) return null;

  const sessionID = (e.sessionID ??
    e.properties?.sessionID ??
    e.data?.sessionID) as string | undefined;
  if (!sessionID) return null;

  if (e.type === 'permission.rejected') {
    return {
      sessionID,
      stopReason: 'permission rejected',
      detail: 'Permission was rejected by the user.',
    };
  }
  if (e.type === 'session.error') {
    return {
      sessionID,
      stopReason: 'session error',
      detail: 'A session error occurred.',
    };
  }
  if (e.type === 'session.execution.interrupted') {
    return {
      sessionID,
      stopReason: 'execution interrupted',
      detail: 'The execution was interrupted.',
    };
  }
  if (e.type === 'message.aborted' || e.type === 'MessageAbortedError') {
    return {
      sessionID,
      stopReason: 'message aborted',
      detail: 'The message was aborted.',
    };
  }
  return null;
}

export function messageRole(message: unknown): string {
  const msg = message as {role?: string} | null;
  return String(msg?.role ?? '');
}

export function messageInfoFromEvent(
  event: unknown,
): Record<string, unknown> | null {
  const e = event as {
    properties?: {info?: unknown};
    data?: {info?: unknown};
  } | null;
  const info = e?.properties?.info ?? e?.data?.info;
  if (info && typeof info === 'object') return info as Record<string, unknown>;
  const data = (event as {data?: unknown})?.data;
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  return null;
}

/**
 * Validate a fresh host session read before trusting its cumulative totals.
 * A malformed/failed lookup must stop this idle attempt, not look like zero use.
 */
export function cumulativeSessionUsageMessage(
  sessionID: string,
  value: unknown,
): Record<string, unknown> {
  const info = value as {
    id?: unknown;
    tokens?: {
      input?: unknown;
      output?: unknown;
      reasoning?: unknown;
      cache?: {read?: unknown; write?: unknown};
    };
    cost?: unknown;
  } | null;
  const tokens = info?.tokens;
  const values = [
    tokens?.input,
    tokens?.output,
    tokens?.reasoning,
    tokens?.cache?.read,
    tokens?.cache?.write,
    info?.cost,
  ];
  if (
    info?.id !== sessionID ||
    values.some(
      value =>
        typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error(
      'Host cumulative session usage is unavailable or malformed',
    );
  }
  return {
    id: `${sessionID}#usage`,
    role: 'assistant',
    info: {tokens, cost: info.cost},
  };
}

interface UsageUpdate {
  changed: boolean;
  notices: Array<{machine: GoalStateMachine; message: string}>;
}

const usageUpdates = new WeakMap<
  RuntimeState,
  Map<string, Promise<UsageUpdate>>
>();

function canAccount(runtime: RuntimeState, sessionID: string): boolean {
  return !runtime.disposed && runtime.canDriveSession?.(sessionID) !== false;
}

function containsUsageTarget(
  runtime: RuntimeState,
  sessionID: string,
  session: SessionContext | undefined,
  machine: GoalStateMachine,
): boolean {
  if (session?.listMachines) return session.listMachines().includes(machine);
  const live = runtime.sessionGoals.get(sessionID);
  if (live) return live.includes(machine);
  return !session || session.getMachine() === machine;
}

export async function trackTokenUsage(
  sessionID: string,
  message: Record<string, unknown>,
  machines: GoalStateMachine[],
  runtime: RuntimeState | undefined,
  session?: SessionContext,
  sessionScopedUsage = false,
  announceMigration?: (message: string) => Promise<void>,
  readingIsCurrent: () => boolean = () => true,
): Promise<void> {
  if (!runtime || machines.length === 0 || !canAccount(runtime, sessionID))
    return;
  const contains = (machine: GoalStateMachine) =>
    containsUsageTarget(runtime, sessionID, session, machine);
  const owns = (machine: GoalStateMachine) =>
    canAccount(runtime, sessionID) && contains(machine);
  const accepts = (machine: GoalStateMachine) =>
    readingIsCurrent() && owns(machine);

  // Serialize both sources: native cumulative updates, message events, and the
  // idle fallback may arrive together. Each goal applies its charge and replay
  // markers atomically, checking current ownership inside its own state lock.
  let sessions = usageUpdates.get(runtime);
  if (!sessions) {
    sessions = new Map();
    usageUpdates.set(runtime, sessions);
  }
  const previous = sessions.get(sessionID) ?? Promise.resolve();
  const update = previous
    .catch(() => {})
    .then(() =>
      sessionScopedUsage
        ? trackCumulativeUsage(
            sessionID,
            message,
            machines,
            runtime,
            accepts,
            contains,
          )
        : trackMessageUsage(
            sessionID,
            message,
            machines,
            runtime,
            accepts,
            contains,
          ),
    );
  sessions.set(sessionID, update);
  let result: UsageUpdate;
  try {
    result = await update;
  } finally {
    if (sessions.get(sessionID) === update) sessions.delete(sessionID);
  }
  // An accounting commit that preceded ownership loss remains valid, but an
  // obsolete process must neither persist it nor announce a migration afterward.
  if (result.changed && session && machines.some(owns)) await session.persist();
  for (const notice of result.notices) {
    if (owns(notice.machine)) await announceMigration?.(notice.message);
  }
}

function mergeCumulativeUsage(
  target: UsageSnapshot,
  source: UsageSnapshot,
): void {
  for (const field of USAGE_TOKEN_FIELDS)
    target[field] = Math.max(target[field], source[field]);
  target.cost = Math.max(target.cost, source.cost);
  target.costKnown ||= source.costKnown;
}

function sameUsage(a: UsageSnapshot, b: UsageSnapshot): boolean {
  return (
    USAGE_TOKEN_FIELDS.every(field => a[field] === b[field]) &&
    a.cost === b.cost &&
    a.costKnown === b.costKnown
  );
}

function sameReading(a: MessageUsageReading, b: MessageUsageReading): boolean {
  return (
    sameUsage(a.usage, b.usage) &&
    a.tokens === b.tokens &&
    a.outputTokens === b.outputTokens &&
    a.observed === b.observed
  );
}

async function trackCumulativeUsage(
  sessionID: string,
  message: Record<string, unknown>,
  machines: GoalStateMachine[],
  runtime: RuntimeState,
  owns: (machine: GoalStateMachine) => boolean,
  contains: (machine: GoalStateMachine) => boolean,
): Promise<UsageUpdate> {
  const targets = machines.filter(owns);
  if (targets.length === 0) return {changed: false, notices: []};
  const previous = {
    ...(runtime.seenSessionUsage.get(sessionID) ?? emptyUsage()),
  };
  const pendingBaselines = new Map<string, UsageSnapshot>();
  for (const machine of targets) {
    const saved = machine.state.lastSessionUsage;
    if (saved) mergeCumulativeUsage(previous, saved);
    const pending = machine.state.pendingSessionUsage;
    if (pending) {
      mergeCumulativeUsage(previous, pending.observed);
      for (const id of pending.goalIDs)
        pendingBaselines.set(id, pending.baseline);
    }
  }
  const current = normalizeMessageUsage(message);
  mergeCumulativeUsage(current, previous);
  const baselines = new Map(
    targets.map(machine => [
      machine.state.goalId,
      machine.state.lastSessionUsage ??
        pendingBaselines.get(machine.state.goalId) ??
        previous,
    ]),
  );
  let changed = false;
  const preparedTargets: GoalStateMachine[] = [];
  // A concurrent command may persist the entire session during the first
  // charge's display await. Prepare every fresh baseline first so even that
  // partial snapshot contains the uncharged peers' original starting points.
  for (const machine of targets) {
    const baseline = baselines.get(machine.state.goalId)!;
    const prepared = await machine.prepareCumulativeUsage(
      {
        observed: current,
        baseline,
        goalIDs: targets
          .filter(target =>
            sameUsage(baseline, baselines.get(target.state.goalId)!),
          )
          .map(target => target.state.goalId),
      },
      {guard: () => owns(machine)},
    );
    changed ||= prepared.changed;
    if (prepared.ready) preparedTargets.push(machine);
    else if (contains(machine) && !machine.isTerminal())
      return {changed, notices: []};
  }
  const notices: UsageUpdate['notices'] = [];
  for (const machine of preparedTargets) {
    const result = await machine.updateCumulativeUsage(current, previous, {
      guard: () => owns(machine),
    });
    changed ||= result.changed;
    if (result.migrationNotice)
      notices.push({machine, message: result.migrationNotice});
  }
  if (changed || targets.some(owns)) {
    const id = `${sessionID}#usage`;
    runtime.seenSessionUsage.set(sessionID, current);
    runtime.seenUsage.set(id, current);
    runtime.seenTokens.set(
      id,
      USAGE_TOKEN_FIELDS.reduce((total, field) => total + current[field], 0),
    );
    runtime.seenOutputTokens.set(id, current.output);
  }
  return {changed, notices};
}

async function trackMessageUsage(
  sessionID: string,
  message: Record<string, unknown>,
  machines: GoalStateMachine[],
  runtime: RuntimeState,
  owns: (machine: GoalStateMachine) => boolean,
  contains: (machine: GoalStateMachine) => boolean,
): Promise<UsageUpdate> {
  const id = getMessageID(message);
  if (!id) return {changed: false, notices: []};
  const previous: MessageUsageReading = {
    usage: {...(runtime.seenUsage.get(id) ?? emptyUsage())},
    tokens: runtime.seenTokens.get(id) ?? 0,
    outputTokens: runtime.seenOutputTokens.get(id) ?? 0,
    // Older/event-specific callers may have only one cache populated. Any
    // prior observation still establishes that this message predates a new
    // goal; missing cost detail cannot turn its whole usage into fresh spend.
    observed:
      runtime.seenUsage.has(id) ||
      runtime.seenTokens.has(id) ||
      runtime.seenOutputTokens.has(id),
  };
  const preparedBaselines = new Map<string, MessageUsageReading>();
  // Restored receipts also establish that a message predates a newly created
  // goal. Pending peers retain their own earlier baseline and remain eligible.
  for (const machine of runtime.sessionGoals.get(sessionID) ?? machines) {
    const receipt = machine.state.messageUsage?.get(id);
    if (!receipt) continue;
    for (const goalID of receipt.pending?.goalIDs ?? [])
      preparedBaselines.set(goalID, receipt.pending!.baseline);
    previous.observed = true;
    previous.usage.cost = Math.max(
      previous.usage.cost,
      receipt.reading.usage.cost,
    );
    previous.usage.costKnown ||= receipt.reading.usage.costKnown;
  }
  const current: MessageUsageReading = {
    usage: normalizeMessageUsage(message),
    tokens: totalTokensForMessage(message),
    outputTokens: outputTokensForMessage(message) ?? 0,
    observed: true,
  };
  const createdAt = messageCreatedAt(message);
  const targets = machines.filter(machine => {
    if (!owns(machine)) return false;
    const receipt = machine.state.messageUsage?.get(id);
    if (receipt?.admitted && !machine.state.messageIDs.has(id)) return false;
    const boundary = machine.state.messageUsageBaselineAt;
    const historical =
      boundary !== undefined && (createdAt === null || createdAt <= boundary);
    return (
      receipt !== undefined ||
      preparedBaselines.has(machine.state.goalId) ||
      machine.state.messageIDs.has(id) ||
      historical ||
      !previous.observed
    );
  });
  const role = messageRole(message);
  const baselines = new Map(
    targets.map(machine => [
      machine.state.goalId,
      preparedBaselines.get(machine.state.goalId) ?? previous,
    ]),
  );
  const input = {
    messageID: id,
    current,
    assistant: role === 'assistant' || role === 'agent',
  };
  let changed = false;
  let admitted = false;
  const notices: UsageUpdate['notices'] = [];
  const preparedTargets: GoalStateMachine[] = [];
  for (const machine of targets) {
    const baseline = baselines.get(machine.state.goalId)!;
    const prepared = await machine.prepareMessageUsage(
      {
        ...input,
        previous: baseline,
        createdAt,
        goalIDs: targets
          .filter(target =>
            sameReading(baseline, baselines.get(target.state.goalId)!),
          )
          .map(target => target.state.goalId),
      },
      {guard: () => owns(machine)},
    );
    changed ||= prepared.changed;
    if (prepared.migrationNotice)
      notices.push({machine, message: prepared.migrationNotice});
    if (prepared.ready) {
      preparedTargets.push(machine);
      admitted ||=
        prepared.changed && machine.state.messageUsage!.get(id)!.admitted;
    } else if (contains(machine) && !machine.isTerminal())
      return {changed, notices};
  }
  for (const machine of preparedTargets) {
    const applied = await machine.updateMessageUsage(input, {
      guard: () => owns(machine),
    });
    changed ||= applied;
    admitted ||= applied;
  }
  if (admitted) {
    // These are advisory runtime caches. The durable per-goal receipt is the
    // charge authority, including when ownership was lost after an accepted
    // write but before the next target or a display callback completed.
    current.usage.cost = Math.max(current.usage.cost, previous.usage.cost);
    current.usage.costKnown ||= previous.usage.costKnown;
    runtime.seenUsage.set(id, current.usage);
    runtime.seenTokens.set(id, Math.max(current.tokens, previous.tokens));
    runtime.seenOutputTokens.set(
      id,
      Math.max(current.outputTokens, previous.outputTokens),
    );
  }
  return {changed, notices};
}
