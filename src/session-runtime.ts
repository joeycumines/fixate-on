/**
 * Per-process runtime isolation state for goals.
 *
 * Encapsulates runtime options, state tracking, and AsyncLocalStorage context
 * without requiring the full session state manager.
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import type {GoalStateMachine, PendingIntent} from './state-machine.ts';
import type {GoalResult} from './persistence.ts';
import type {UsageSnapshot} from './accounting.ts';

export interface DefaultGoalOptions {
  maxTokens?: number;
  maxTurns?: number;
  maxDurationMs?: number;
  noProgressTokenThreshold?: number;
  noProgressTurnsBeforePause?: number;
  noToolCallTurnsBeforePause?: number;
  budgetWrapupRatio?: number;
  minDelayMs?: number;
  maxPromptFailures?: number;
  maxRecentMessages?: number;
  /** Completion-gate recovery turns limit propagated to new goals. */
  maxRecoveryTurns?: number;
  /** Completion-gate threshold for unchanged result verification. */
  maxUnchangedResults?: number;
  /** Threshold for consecutive turns marked as blocked (distinct from maxUnchangedResults). */
  maxBlockedTurns?: number;
  languageTriage?: boolean;
}

export const DEFAULT_GOAL_OPTIONS: Required<DefaultGoalOptions> = {
  // Cumulative context budget (totalTokens + compactionBaselineTokens).
  // Sized to allow long campaigns without prematurely halting progressing goals.
  maxTokens: 1000000,
  // Turn counts do not reliably differentiate productive from stuck sessions.
  // Disabled by default (0) in favor of stall and context brakes.
  maxTurns: 0,
  // Stall brake tracking elapsed time since last progress (assistant turn or token increase).
  // Outstanding tool calls do not reset this timer, ensuring hung tool calls are paused after 30m.
  maxDurationMs: 1800000,
  noProgressTokenThreshold: 50,
  // Requires 3 consecutive low-output turns to avoid false pauses during transient re-reading lulls.
  noProgressTurnsBeforePause: 3,
  noToolCallTurnsBeforePause: 3,
  budgetWrapupRatio: 0.8,
  minDelayMs: 1500,
  maxPromptFailures: 3,
  maxRecentMessages: 50,
  // Completion-gate recovery limits (12 turns / 3 unchanged results).
  maxRecoveryTurns: 12,
  maxUnchangedResults: 3,
  maxBlockedTurns: 3,
  languageTriage: true,
};

export interface RuntimeState {
  /** Active and backgrounded goals indexed by session ID. */
  sessionGoals: Map<string, GoalStateMachine[]>;
  /** Currently focused goal ID for each session. */
  focusedGoalId: Map<string, string>;
  /** Archived goal results per session. */
  sessionArchive: Map<string, GoalResult[]>;
  /** Sessions executing an ordered sequence of goals. */
  sessionOrdered: Set<string>;
  seenTokens: Map<string, number>;
  seenUsage: Map<string, UsageSnapshot>;
  seenOutputTokens: Map<string, number>;
  /**
   * Last published cumulative usage per session.
   * Host v2 events carry running totals rather than deltas; tracking cumulative values
   * ensures only incremental usage is billed per event.
   */
  seenSessionUsage: Map<string, UsageSnapshot>;
  activeContinues: Map<string, string>;
  continuationControllers: Map<string, AbortController>;
  promptInFlightSessions: Set<string>;
  /**
   * Sessions restored with an active goal awaiting the first genuine host idle
   * event before safely resuming.
   */
  recoveryPendingSessions: Set<string>;
  seenIdleEventIDs: Set<string>;
  /** Consecutive busy-deferral counter per `${sessionID}:${goalId}` (M1 brake). */
  deferCounts: Map<string, number>;
  /**
   * Sliding window of compaction completion timestamps per session.
   * Used by the compaction-loop brake to pause goals when compaction churns indefinitely.
   */
  compactionTimestamps: Map<string, number[]>;
  threadToolsRegistered: boolean;
  /**
   * Sessions where message.updated usage events have been seen.
   * v1 hosts omit these events (requiring usage extraction from messages),
   * while v2 hosts emit them (where message inspection would double-count).
   */
  usageEventsObserved: Set<string>;
  hasTuiCompanion: boolean;
  /**
   * Sessions actively observed from the host during this process lifetime.
   * Prevents synthesizing idles or re-arming goals for stale sessions from previous runs.
   */
  liveSessions: Set<string>;
  pendingIntents: Map<string, PendingIntent>;
  /**
   * Determines whether this process is permitted to drive a session's goals.
   * Prevents competing instances from dispatching actions on owned sessions.
   */
  canDriveSession?: (sessionID: string) => boolean;
  drainPersistence: (() => Promise<boolean>) | null;
  disposed: boolean;
}

export function createRuntimeState(): RuntimeState {
  return {
    sessionGoals: new Map(),
    focusedGoalId: new Map(),
    sessionArchive: new Map(),
    sessionOrdered: new Set(),
    seenTokens: new Map(),
    seenUsage: new Map(),
    seenOutputTokens: new Map(),
    seenSessionUsage: new Map(),
    activeContinues: new Map(),
    continuationControllers: new Map(),
    promptInFlightSessions: new Set(),
    recoveryPendingSessions: new Set(),
    seenIdleEventIDs: new Set(),
    deferCounts: new Map(),
    compactionTimestamps: new Map(),
    threadToolsRegistered: false,
    usageEventsObserved: new Set(),
    hasTuiCompanion: false,
    liveSessions: new Set(),
    pendingIntents: new Map(),
    drainPersistence: null,
    disposed: false,
  };
}

export const runtimeStorage = new AsyncLocalStorage<RuntimeState>();
