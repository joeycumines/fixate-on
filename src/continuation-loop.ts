import type {GoalState, PendingIntent} from './state-machine.ts';
import {chargedTokens} from './accounting.ts';
import {USER_INTERVENTION_STOP_REASON} from './status-label.ts';

export type ContinuationDecision =
  | {type: 'continue'; budgetWrapup: boolean; budgetLimit: boolean}
  | {type: 'pause'; reason: string; stopReason: string}
  | {type: 'budget-limit'}
  | {type: 'apply-pending-intent'; intent: PendingIntent}
  | {type: 'stop'; reason: string};

export interface IdleContext {
  goal: GoalState;
  pendingIntent: PendingIntent | null;
  latestOutputTokens: number | null;
  latestHasToolCall: boolean;
  latestHasThinkingTokens: boolean;
  assistantChanged: boolean;
  assistantRepeated: boolean;
  userInterventionDetected: boolean;
  activationBoundary: boolean;
}

export interface LoopPolicyOptions {
  noProgressTokenThreshold?: number;
  noProgressTurnsBeforePause?: number;
  noToolCallTurnsBeforePause?: number;
  budgetWrapupRatio?: number;
}

export interface LoopPolicy {
  decideContinuation(ctx: IdleContext): ContinuationDecision;
}

/**
 * Default continuation loop policy options.
 *
 * Both no-progress thresholds default to 3 turns (kept in sync with
 * DEFAULT_GOAL_OPTIONS in session-state-manager.ts). Two consecutive low-output
 * turns can happen during a transient lull, so 3 is the minimum reliable stall signal.
 */
export const DEFAULT_POLICY_OPTIONS: Required<LoopPolicyOptions> = {
  noProgressTokenThreshold: 50,
  noProgressTurnsBeforePause: 3,
  noToolCallTurnsBeforePause: 3,
  budgetWrapupRatio: 0.8,
};

/**
 * Creates a loop policy with the given options, falling back to DEFAULT_POLICY_OPTIONS.
 */
export function createLoopPolicy(options?: LoopPolicyOptions): LoopPolicy {
  const opts = {...DEFAULT_POLICY_OPTIONS, ...options};
  return {
    decideContinuation(ctx: IdleContext): ContinuationDecision {
      return decideContinuation(ctx, opts);
    },
  };
}

/**
 * Checks if the explicit API-cost budget is exhausted.
 * Returns true only when tokenBudget is set and chargedTokens >= budget.
 */
export function budgetLimitNeeded(goal: GoalState): boolean {
  if (goal.budgetLimitReported) return false;
  const budget = goal.tokenBudget;
  if (typeof budget !== 'number' || budget <= 0) return false;
  return chargedTokens(goal.usage) >= budget;
}

/**
 * Checks if the context window is nearly full (>= 80% by default).
 * Advisory only: triggers a wrapup prompt without stopping the goal.
 *
 * Incorporates compactionBaselineTokens so tokens consumed prior to the last
 * compaction are preserved, ensuring compaction does not bypass the budget.
 */
export function budgetWrapupNeeded(
  goal: GoalState,
  wrapupRatio: number = DEFAULT_POLICY_OPTIONS.budgetWrapupRatio,
): boolean {
  if (goal.budgetWrapupSent) return false;
  if (goal.maxTokens <= 0) return false;
  const cumulativeTokens = goal.totalTokens + goal.compactionBaselineTokens;
  return cumulativeTokens >= Math.floor(goal.maxTokens * wrapupRatio);
}

export function turnLimitReached(goal: GoalState): boolean {
  if (goal.maxTurns <= 0) return false;
  return goal.turnCount >= goal.maxTurns;
}

/**
 * Returns true when the goal has stopped making progress longer than the duration limit allows.
 *
 * This acts as a stall brake rather than an absolute elapsed timer: time is measured
 * since the last evidence of progress so active work is not prematurely cut off.
 */
export function durationLimitReached(goal: GoalState): boolean {
  if (goal.maxDurationMs <= 0) return false;
  const since = goal.lastProgressAt > 0 ? goal.lastProgressAt : goal.startedAt;
  if (since <= 0) return false;
  const idle = Math.max(0, Date.now() - since);
  return idle >= goal.maxDurationMs;
}

/**
 * Returns the stop reason if any limit is reached, or null otherwise.
 * The context token limit includes compaction baselines to prevent compaction bypasses.
 */
export function stopReason(goal: GoalState): string | null {
  if (turnLimitReached(goal)) return 'max turns reached';
  if (durationLimitReached(goal)) return 'max stall reached';
  if (goal.maxTokens > 0) {
    const cumulativeTokens = goal.totalTokens + goal.compactionBaselineTokens;
    if (cumulativeTokens >= goal.maxTokens) return 'max context tokens reached';
  }
  return null;
}

/**
 * Determines whether the latest turn indicates a stall (low output tokens,
 * no tool calls, no thinking tokens, and repeated or unchanged assistant text).
 */
export function isLowProgressTurn(
  ctx: IdleContext,
  threshold: number,
): boolean {
  const {
    goal,
    latestOutputTokens,
    latestHasToolCall,
    latestHasThinkingTokens,
    assistantChanged,
    assistantRepeated,
    activationBoundary,
  } = ctx;

  const lowOutputTurn =
    goal.turnCount > 0 &&
    !activationBoundary &&
    latestOutputTokens !== null &&
    latestOutputTokens < threshold;

  return (
    lowOutputTurn &&
    !latestHasToolCall &&
    !latestHasThinkingTokens &&
    (assistantRepeated || !goal.lastAssistantText || !assistantChanged)
  );
}

/**
 * Core continuation decision function (pure, side-effect free).
 *
 * Decision priority:
 * 1. User intervention -> pause
 * 2. Pending intent -> apply terminal transition
 * 3. Budget limit (API cost) -> terminal budget-limit
 * 4. Turn/duration/context limits -> stop
 * 5. Low progress -> pause (after threshold)
 * 6. No tool calls -> pause (after threshold)
 * 7. Budget wrapup -> continue with wrapup advisory
 * 8. Otherwise -> continue
 */
export function decideContinuation(
  ctx: IdleContext,
  opts: Required<LoopPolicyOptions>,
): ContinuationDecision {
  const {goal} = ctx;

  // 1. User intervention: latest human instruction takes precedence.
  if (ctx.userInterventionDetected) {
    return {
      type: 'pause',
      reason:
        'Auto-continue paused because a new human message arrived; the latest instruction wins.',
      stopReason: USER_INTERVENTION_STOP_REASON,
    };
  }

  // 2. Pending intent: step barrier to apply terminal transitions.
  if (ctx.pendingIntent) {
    if (
      ctx.pendingIntent.goalId === goal.goalId &&
      ctx.pendingIntent.runId === goal.runId &&
      ctx.pendingIntent.revision === goal.revision
    ) {
      return {type: 'apply-pending-intent', intent: ctx.pendingIntent};
    }
  }

  // 3. Explicit API-cost budget exhaustion (terminal).
  const budgetLimit = budgetLimitNeeded(goal);
  if (budgetLimit) {
    return {type: 'budget-limit'};
  }

  // 4. Execution resource limits (turns, stall duration, context tokens).
  const limit = stopReason(goal);
  if (limit) {
    return {type: 'stop', reason: limit};
  }

  // 5. Low-progress detection (goal.noProgressTurns is pre-incremented by the caller).
  const progressThreshold =
    goal.noProgressTokenThreshold ?? opts.noProgressTokenThreshold;
  if (isLowProgressTurn(ctx, progressThreshold)) {
    const progressPauseThreshold =
      goal.noProgressTurnsBeforePause ?? opts.noProgressTurnsBeforePause;
    if (goal.noProgressTurns >= progressPauseThreshold) {
      return {
        type: 'pause',
        reason: `Goal auto-continue paused after ${goal.noProgressTurns} low-progress turn(s).`,
        stopReason: 'no progress',
      };
    }
  }

  // 6. Missing tool calls detection (threshold <= 0 disables check).
  if (goal.turnCount > 0 && !ctx.activationBoundary && !ctx.latestHasToolCall) {
    const toolCallPauseThreshold =
      goal.noToolCallTurnsBeforePause ?? opts.noToolCallTurnsBeforePause;
    if (
      toolCallPauseThreshold > 0 &&
      goal.noToolCallTurns >= toolCallPauseThreshold
    ) {
      return {
        type: 'pause',
        reason: `Goal auto-continue paused after ${goal.noToolCallTurns} turn(s) with no tool calls.`,
        stopReason: 'no tool calls',
      };
    }
  }

  // 7. Context window capacity wrapup (advisory prompt; budgetLimit is known false here).
  const budgetWrapup = budgetWrapupNeeded(goal, opts.budgetWrapupRatio);

  // 8. Default: proceed with next continuation turn.
  return {type: 'continue', budgetWrapup, budgetLimit};
}

/**
 * Validates whether a pending intent is safe to apply against the current goal state.
 * Verifies matching goal ID, run ID, and that the revision has not drifted.
 */
export function validatePendingIntent(
  intent: PendingIntent,
  goal: GoalState,
): {valid: boolean; reason: string} {
  if (intent.goalId !== goal.goalId) {
    return {
      valid: false,
      reason: 'pending intent goalId does not match current goal',
    };
  }
  if (intent.runId !== goal.runId) {
    return {
      valid: false,
      reason: 'pending intent runId does not match current goal',
    };
  }
  if (intent.revision !== goal.revision) {
    return {
      valid: false,
      reason: 'pending intent revision is stale (goal was modified)',
    };
  }
  return {valid: true, reason: ''};
}

/**
 * Dynamically loads a custom loop policy from a module path.
 * Supports modules exporting `createLoopPolicy`, a default object, or `decideContinuation`.
 * Falls back to the default policy if modulePath is null or fails to load.
 */
export async function loadLoopPolicy(
  modulePath: string | null,
  options?: LoopPolicyOptions,
): Promise<LoopPolicy> {
  if (!modulePath) {
    return createLoopPolicy(options);
  }
  try {
    const mod = await import(modulePath);
    if (typeof mod.createLoopPolicy === 'function') {
      const result = await mod.createLoopPolicy(options);
      if (result && typeof result.decideContinuation === 'function') {
        return result;
      }
    }
    if (mod.default && typeof mod.default.decideContinuation === 'function') {
      return mod.default;
    }
    if (
      mod.decideContinuation &&
      typeof mod.decideContinuation === 'function'
    ) {
      return mod as LoopPolicy;
    }
    return createLoopPolicy(options);
  } catch {
    return createLoopPolicy(options);
  }
}
