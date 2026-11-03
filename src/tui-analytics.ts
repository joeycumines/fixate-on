/**
 * Token cost analytics and budget projection for goals.
 *
 * Derives consumption rates, remaining turns, and projected cost from snapshots.
 * Note: computeAnalytics reads Date.now() directly to compute burn rate.
 */

import type {GoalTuiSnapshot} from './tui-state.ts';
import {formatNumber} from './tui-components.ts';
import {chargedTokens} from './accounting.ts';

/**
 * Token cost analytics for a goal derived from usage metrics and budget configuration.
 */
export interface GoalAnalytics {
  readonly chargedTokens: number;
  readonly tokenBudget: number | null;
  readonly budgetPercentage: number | null;
  readonly tokensPerTurn: number;
  readonly projectedTotalTokens: number | null;
  readonly turnsRemaining: number | null;
  readonly costPerTurn: number;
  readonly projectedTotalCost: number | null;
  readonly burnRate: number;
}

/**
 * Derives usage analytics and budget projections from a goal snapshot.
 */
export function computeAnalytics(goal: GoalTuiSnapshot): GoalAnalytics {
  // Use canonical charged tokens from accounting.ts for both enforcement and
  // turn forecasts so that calculations operate on the exact same unit.
  const charged = chargedTokens(goal.usage);
  const tokenBudget = goal.tokenBudget ?? null;
  const budgetPercentage =
    tokenBudget !== null && tokenBudget > 0
      ? Math.round((charged / tokenBudget) * 100)
      : null;

  const tokensPerTurn =
    goal.turnCount > 0 ? Math.round(charged / goal.turnCount) : 0;

  // A projection requires a positive turn horizon. A maxTurns of 0 indicates "no turn brake";
  // multiplying by 0 would produce an invalid zero projection that suppresses budget alerts.
  const projectedTotalTokens =
    goal.turnCount > 0 && goal.maxTurns > 0
      ? tokensPerTurn * goal.maxTurns
      : null;

  const turnsRemaining =
    tokenBudget !== null && tokensPerTurn > 0
      ? Math.max(0, Math.floor((tokenBudget - charged) / tokensPerTurn))
      : null;

  const costPerTurn =
    goal.usage.costKnown && goal.turnCount > 0
      ? goal.usage.cost / goal.turnCount
      : 0;

  const projectedTotalCost =
    goal.usage.costKnown && goal.turnCount > 0
      ? costPerTurn * goal.maxTurns
      : null;

  const elapsedMs = Date.now() - goal.createdAt;
  const burnRate =
    elapsedMs >= 1000 ? Math.round(charged / (elapsedMs / 1000)) : 0;

  return {
    chargedTokens: charged,
    tokenBudget,
    budgetPercentage,
    tokensPerTurn,
    projectedTotalTokens,
    turnsRemaining,
    costPerTurn,
    projectedTotalCost,
    burnRate,
  };
}

/**
 * Formats a compact analytics summary string for dashboard display.
 */
export function formatAnalyticsSummary(analytics: GoalAnalytics): string {
  const parts: string[] = [];

  parts.push(`Charged: ${formatNumber(analytics.chargedTokens)}`);

  if (analytics.budgetPercentage !== null) {
    parts.push(`Budget: ${analytics.budgetPercentage}%`);
  }

  if (analytics.tokensPerTurn > 0) {
    parts.push(`${formatNumber(analytics.tokensPerTurn)}/turn`);
  }

  if (analytics.turnsRemaining !== null) {
    parts.push(`${analytics.turnsRemaining} turns left`);
  }

  if (analytics.costPerTurn > 0) {
    parts.push(`$${analytics.costPerTurn.toFixed(4)}/turn`);
  }

  if (analytics.burnRate > 0) {
    parts.push(`${formatNumber(analytics.burnRate)} tok/s`);
  }

  return parts.join(' | ');
}

/**
 * Formats a budget advisory warning when a goal is close to or exceeding budget.
 * Returns null if no warning is needed.
 */
export function formatBudgetWarning(analytics: GoalAnalytics): string | null {
  if (analytics.budgetPercentage === null) return null;
  if (analytics.budgetPercentage < 80) return null;

  if (analytics.budgetPercentage >= 100) {
    return `Budget ${analytics.budgetPercentage}% consumed - limit reached`;
  }

  if (
    analytics.projectedTotalTokens !== null &&
    analytics.tokenBudget !== null &&
    analytics.projectedTotalTokens > analytics.tokenBudget
  ) {
    return `Projected to exceed budget at current rate (${analytics.budgetPercentage}% used, ${analytics.turnsRemaining} turns left)`;
  }

  return `Budget at ${analytics.budgetPercentage}% - approaching limit`;
}
