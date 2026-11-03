/**
 * Goal-tool wire format definitions and response serializers.
 * Pure mapping functions with no session mutation.
 */

import type {
  FocusResult,
  GoalMode,
  GoalProposal,
  GoalState,
  GoalStateMachine,
  PendingIntent,
} from './state-machine.ts';
import type {GoalResult} from './persistence.ts';
import {chargedTokens} from './accounting.ts';

export type ThreadGoalStatus =
  'active' | 'paused' | 'blocked' | 'budgetLimited' | 'complete';

export interface ThreadGoal {
  threadId: string;
  goalId: string;
  objective: string;
  artifactPointers?: string[];
  pendingProposal?: GoalProposal | null;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalToolResponse {
  goal: ThreadGoal | null;
  remainingTokens: number | null;
  completionBudgetReport: string | null;
  pendingCompletion: boolean;
  pendingProposal?: GoalProposal | null;
  message?: string;
  error?: string;
}

export interface CreateGoalOptions {
  tokenBudget?: number | null;
  maxTokens?: number;
  maxTurns?: number;
  maxDurationMs?: number;
  minDelayMs?: number;
  noProgressTokenThreshold?: number;
  noProgressTurnsBeforePause?: number;
  noToolCallTurnsBeforePause?: number;
  successCriteria?: string;
  constraints?: string;
  artifactPointers?: string[];
  mode?: GoalMode;
  /** Completion-gate recovery bounds. */
  maxRecoveryTurns?: number;
  maxUnchangedResults?: number;
  /** Threshold for consecutive blocked turns before action (distinct from maxUnchangedResults). */
  maxBlockedTurns?: number;
  languageTriage?: boolean;
}

export interface ToolSessionContext {
  sessionID: string;
  getMachine: () => GoalStateMachine | null;
  listActiveGoals: () => GoalState[];
  listArchivedResults: () => GoalResult[];
  createGoal: (
    objective: string,
    options: CreateGoalOptions,
  ) => GoalStateMachine;
  removeGoal: (
    goalId: string,
    caller?: import('./state-machine.ts').TransitionSource,
  ) => Promise<void>;
  focusGoal: (goalId: string) => Promise<FocusResult>;
  /** Pending intents are tracked per goal (keyed by goalId) in multi-goal sessions. */
  setPendingIntent: (goalId: string, intent: PendingIntent | null) => void;
  getPendingIntent: (goalId: string) => PendingIntent | null;
  /** Returns all pending intents across the session's goals for step-barrier checks. */
  getAllPendingIntents: () => PendingIntent[];
  persist: () => Promise<boolean>;
  /**
   * Checks whether another live process holds the session lock.
   * `persist` can fail for multiple reasons; this distinguishes lease refusal
   * from other persistence errors.
   */
  isOwnedElsewhere?: () => boolean;
}

export function threadStatusFor(goal: GoalState): ThreadGoalStatus {
  switch (goal.status) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'blocked':
      return 'blocked';
    case 'complete':
      return 'complete';
    case 'budgetLimited':
      return 'budgetLimited';
    case 'finalizing':
      return 'active';
    default:
      return 'active';
  }
}

export function remainingTokens(goal: GoalState): number | null {
  const budget = goal.tokenBudget;
  if (typeof budget !== 'number' || budget <= 0) return null;
  return Math.max(0, budget - chargedTokens(goal.usage));
}

export function toThreadGoal(goal: GoalState, sessionID: string): ThreadGoal {
  const endTs =
    goal.finishedAt ??
    (goal.status !== 'active' ? goal.pausedAt || Date.now() : Date.now());
  const startedAt = goal.startedAt || endTs;
  const timeUsedSeconds = Math.max(0, Math.round((endTs - startedAt) / 1000));

  return {
    threadId: sessionID,
    goalId: goal.goalId,
    objective: String(goal.condition || ''),
    artifactPointers: goal.artifactPointers ? [...goal.artifactPointers] : [],
    pendingProposal: goal.pendingProposal ? {...goal.pendingProposal} : null,
    status: threadStatusFor(goal),
    tokenBudget:
      typeof goal.tokenBudget === 'number' && goal.tokenBudget > 0
        ? goal.tokenBudget
        : null,
    tokensUsed: chargedTokens(goal.usage),
    timeUsedSeconds,
    createdAt: Math.floor((goal.createdAt || startedAt) / 1000),
    updatedAt: Math.floor((goal.updatedAt || endTs) / 1000),
  };
}

export function toThreadGoalFromResult(
  result: GoalResult,
  sessionID: string,
): ThreadGoal {
  const startedAt = result.startedAt || result.finishedAt || Date.now();
  const finishedAt = result.finishedAt || Date.now();
  const status: ThreadGoalStatus =
    result.state === 'achieved'
      ? 'complete'
      : result.state === 'blocked'
        ? 'blocked'
        : 'paused';

  return {
    threadId: sessionID,
    goalId: result.goalId,
    objective: String(result.condition || ''),
    status,
    tokenBudget:
      typeof result.tokenBudget === 'number' && result.tokenBudget > 0
        ? result.tokenBudget
        : null,
    tokensUsed: chargedTokens(result.usage),
    timeUsedSeconds: Math.max(0, Math.round((finishedAt - startedAt) / 1000)),
    createdAt: Math.floor((result.createdAt || startedAt) / 1000),
    updatedAt: Math.floor(finishedAt / 1000),
  };
}

export function serializeToolResponse(response: GoalToolResponse): string {
  return JSON.stringify(response);
}

export function noGoalResponse(): GoalToolResponse {
  return {
    goal: null,
    remainingTokens: null,
    completionBudgetReport: null,
    pendingCompletion: false,
  };
}

/**
 * Determines whether an active completion claim is on record for the goal.
 *
 * An intent is considered live if `intent.revision >= goal.revision`.
 * Equality represents the settled state. An intent revision ahead of the goal (`>`)
 * occurs during restart recovery, where startup restores an intent at
 * `snapshotRevision + 2` to anticipate recovery pause and re-arm before the idle handler
 * catches up. Only an intent with an older revision (`<`) is considered stale.
 */
export function hasPendingCompletion(
  session: ToolSessionContext,
  goal: GoalState,
): boolean {
  const intent = session.getPendingIntent(goal.goalId);
  if (!intent) return false;
  if (intent.goalId !== goal.goalId || intent.runId !== goal.runId)
    return false;
  if (intent.targetStatus !== 'complete') return false;

  return intent.revision >= goal.revision;
}
