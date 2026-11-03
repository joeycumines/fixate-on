/**
 * Fork-copy semantics: a forked session receives its own copy of each parent goal.
 * The copy inherits the user objective and completion contract, while execution
 * counters and recovery state are reset. Deliberately halted goals (e.g. paused by
 * the user) remain halted in the fork.
 */

/** The subset of a goal describing user intent, inherited during a fork. */
export interface InheritableGoal {
  condition: string;
  successCriteria: string;
  constraints: string;
  artifactPointers: string[];
  mode: 'normal' | 'ordered';
  tokenBudget: number | null;
  maxTokens: number;
  maxTurns: number;
  maxDurationMs: number;
  minDelayMs: number;
  noProgressTokenThreshold: number;
  noProgressTurnsBeforePause: number;
  noToolCallTurnsBeforePause: number;
  maxRecoveryTurns: number;
  maxUnchangedResults: number;
  maxBlockedTurns: number;
  languageTriage: boolean;
}

/** Options accepted when creating an inherited goal copy. */
export interface InheritOptions {
  successCriteria?: string;
  constraints?: string;
  artifactPointers?: string[];
  mode?: 'normal' | 'ordered';
  tokenBudget?: number | null;
  maxTokens?: number;
  maxTurns?: number;
  maxDurationMs?: number;
  minDelayMs?: number;
  noProgressTokenThreshold?: number;
  noProgressTurnsBeforePause?: number;
  noToolCallTurnsBeforePause?: number;
  maxRecoveryTurns?: number;
  maxUnchangedResults?: number;
  maxBlockedTurns?: number;
  languageTriage?: boolean;
}

/**
 * Minimal session surface required for goal copying.
 *
 * Declared with method syntax intentionally: TypeScript evaluates method
 * parameters bivariantly, allowing `SessionContext` with its stricter mutation
 * types to remain assignable without requiring casts that could mask signature drift.
 */
export interface ForkTargetSession {
  createGoal(
    objective: string,
    options: InheritOptions,
  ): {
    readonly state: {readonly goalId: string};
    mutate(
      fn: (goal: unknown) => void,
      opts: {source: 'create_goal'; detail: string},
    ): Promise<unknown>;
  };

  focusGoal?(goalId: string): Promise<unknown>;
  addOrderedSession?(): void;
}

export interface ForkSourceGoal extends InheritableGoal {
  goalId: string;
  status: string;
  stopReason: string;
}

/**
 * Reasons indicating a human or sequencing logic explicitly halted the goal:
 * - "paused": explicit `/goal pause` command
 * - "explicit pause": whole-message stop directive
 * - "queued": pending position in an ordered sequence
 *
 * Brake pauses ("max turns", "no progress", etc.) reflect parent execution state
 * and do not carry over to the fork.
 */
const DELIBERATE_HALT_REASONS: ReadonlySet<string> = new Set([
  'paused',
  'explicit pause',
  'queued',
]);

function deliberateHaltReason(goal: ForkSourceGoal): string | undefined {
  if (goal.status !== 'paused') return undefined;
  return DELIBERATE_HALT_REASONS.has(goal.stopReason)
    ? goal.stopReason
    : undefined;
}

/**
 * Extracts configuration representing user intent, omitting ephemeral execution metrics.
 */
export function inheritOptionsFrom(goal: InheritableGoal): InheritOptions {
  return {
    successCriteria: goal.successCriteria,
    constraints: goal.constraints,
    artifactPointers: [...goal.artifactPointers],
    mode: goal.mode,
    tokenBudget: goal.tokenBudget,
    maxTokens: goal.maxTokens,
    maxTurns: goal.maxTurns,
    maxDurationMs: goal.maxDurationMs,
    minDelayMs: goal.minDelayMs,
    noProgressTokenThreshold: goal.noProgressTokenThreshold,
    noProgressTurnsBeforePause: goal.noProgressTurnsBeforePause,
    noToolCallTurnsBeforePause: goal.noToolCallTurnsBeforePause,
    maxRecoveryTurns: goal.maxRecoveryTurns,
    maxUnchangedResults: goal.maxUnchangedResults,
    maxBlockedTurns: goal.maxBlockedTurns,
    languageTriage: goal.languageTriage,
  };
}

/**
 * Returns the objective text for the copy unchanged. Provenance is preserved
 * in the goal's history ledger rather than prepended to the prompt text.
 */
export function forkObjective(goal: InheritableGoal): string {
  return goal.condition;
}

/**
 * Extracts the source parent session ID from a `session.forked` event payload.
 * Returns undefined if missing or malformed to prevent attaching goals to an incorrect session.
 */
export function extractForkParentID(properties: unknown): string | undefined {
  if (!properties || typeof properties !== 'object') return undefined;
  const record = properties as Record<string, unknown>;
  const candidates = [
    record.parentID,
    (record.info as Record<string, unknown> | undefined)?.parentID,
    (record.session as Record<string, unknown> | undefined)?.parentID,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim())
      return candidate.trim();
  }
  return undefined;
}

/**
 * Copies all active goals from the parent session into the target forked session.
 *
 * Note: Non-idempotent on its own; caller must verify the target session has not
 * already imported parent goals.
 *
 * @returns List of copied goal conditions.
 */
export async function copyGoalsToForkedSession(args: {
  sourceGoals: readonly ForkSourceGoal[];
  target: ForkTargetSession;
  parentSessionID: string;
  createdAt: number;
  focusedGoalId?: string;
}): Promise<string[]> {
  const copied: string[] = [];
  const copyIDBySourceID = new Map<string, string>();
  let ordered = false;

  for (const goal of args.sourceGoals) {
    const created = args.target.createGoal(
      forkObjective(goal),
      inheritOptionsFrom(goal),
    );
    if (goal.mode === 'ordered') ordered = true;
    const halt = deliberateHaltReason(goal);

    await created.mutate(
      state => {
        const copy = state as {
          status: string;
          stopReason: string;
          pausedAt: number;
          history: Array<{type: string; detail: string; timestamp: number}>;
        };
        copy.history.push({
          type: 'forked',
          detail: `Copied from forked session ${args.parentSessionID} (source goal ${goal.goalId})`,
          timestamp: args.createdAt,
        });
        if (halt) {
          copy.status = 'paused';
          copy.stopReason = halt;
          if (!copy.pausedAt) copy.pausedAt = args.createdAt;
        }
      },
      {
        source: 'create_goal',
        detail: 'Goal copied from parent session by fork',
      },
    );

    copyIDBySourceID.set(goal.goalId, created.state.goalId);
    copied.push(goal.condition);
  }

  // Register ordered session if any copied goal uses ordered mode,
  // ensuring the session coordinator recognizes sequence constraints.
  if (ordered) args.target.addOrderedSession?.();

  // Retain focus on the corresponding goal from the parent session
  // rather than defaulting to whichever goal was created last.
  if (args.focusedGoalId) {
    const focusedCopyID = copyIDBySourceID.get(args.focusedGoalId);
    if (focusedCopyID) await args.target.focusGoal?.(focusedCopyID);
  }

  return copied;
}
