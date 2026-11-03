/**
 * Public plugin configuration options and recovered state merge utilities.
 */

import {type PersistedState, serializeGoal} from './persistence.ts';
import type {RecoveredState} from './persistence-wal.ts';
import type {DefaultGoalOptions} from './session-runtime.ts';
import type {SdkShape} from './session-api.ts';
import type {Judge} from './child-session-verifier.ts';
import type {GoalTuiPublishFn} from './tui-state.ts';

export interface PluginOptions {
  commandName?: string;
  registerTools?: boolean;
  registerCommand?: boolean;
  registerAgents?: boolean;
  persistState?: boolean;
  /**
   * Directory holding this project's goal state. Each session's goals live in
   * its own file beneath it (`sessions/<sessionID>/state.json`), which is what
   * lets two OpenCode processes share a worktree. Default:
   * `<cwd>/.opencode/goals`.
   */
  stateRoot?: string;
  /**
   * Workspace directory for resolving stateRoot and other relative paths.
   * The v2 Context interface does not expose the host's workspace location
   * to plugins, so a v2 host whose process.cwd differs from the campaign
   * workspace (e.g. a from-source checkout that cds to the host repo before
   * exec-ing the CLI) must pass the workspace path explicitly. When absent,
   * falls back to process.cwd (correct for v1 hosts and installed v2).
   */
  workspaceDirectory?: string;
  ledgerMaxBytes?: number;
  ledgerRetentionFiles?: number;
  loopPolicyPath?: string;
  sdkShape?: SdkShape;
  defaultGoalOptions?: DefaultGoalOptions;
  goalAgentName?: string;
  verifierAgentName?: string;
  childSessionJudge?: boolean;
  judge?: Judge;
  judgeOptions?: {
    timeoutMs?: number;
    failurePolicy?: 'reject' | 'approve';
    sdkShape?: SdkShape;
  };
  goalMessages?: boolean;
  goalMessenger?: (sessionID: string, text: string) => Promise<void>;
  resultRetentionMs?: number;
  maxStoredResults?: number;
  minDelayMs?: number;
  maxPromptFailures?: number;
  noToolCallTurnsBeforePause?: number;
  warnTurnsRemaining?: number;
  warnDurationMsRemaining?: number;
  warnTokensRemaining?: number;
  maxRecentMessages?: number;
  maxTokens?: number;
  maxTurns?: number;
  maxDurationMs?: number;
  noProgressTokenThreshold?: number;
  noProgressTurnsBeforePause?: number;
  budgetWrapupRatio?: number;
  maxRecoveryTurns?: number;
  maxUnchangedResults?: number;
  /** Threshold for consecutive blocked turns before intervention (distinct from maxUnchangedResults). */
  maxBlockedTurns?: number;
  languageTriage?: boolean;
  /**
   * Delay (ms) before the v1 no-agent-turn kickoff probe fires after a
   * goal-creating slash command. Default 2500. The kickoff sends the first
   * continuation prompt ONLY when the host launched no agent turn for the
   * command (stock v1 registers /goal without an agent, so nothing else
   * drives the new active goal and no session.idle ever fires).
   */
  kickoffDelayMs?: number;
  /**
   * Whether the FX-J idle-poll fallback runs. It is the ONLY wake path on
   * hosts that deliver no idle events (stock v1), so it defaults to enabled —
   * but it is a 5 s timer, so a host that already delivers idles correctly
   * (or a test that drives events directly) must be able to switch it off.
   * Before this option existed the flag was unreachable from the plugin entry
   * point: `HookDeps.idlePoller` was declared and honoured, but never
   * forwarded, so every `GoalsPlugin(...)` instance ran the timer regardless.
   */
  idlePoller?: boolean;
  /** Poll interval for the idle-poll fallback. Default 5000 ms. */
  idlePollerIntervalMs?: number;
  /** Quiet window before a synthetic idle may fire. Default 10000 ms. */
  idleQuietMs?: number;
  /** Grace period after an authentic idle, during which the poller stays silent. Default 30000 ms. */
  idleGraceMs?: number;
  /**
   * A custom TUI event transport. When set, the broadcaster publishes goal
   * lifecycle events through it UNWRAPPED. This is the v2 adapter's invisible
   * metadata channel (events surface via tool Result.metadata — never rendered
   * to the user). Since the v2 transport uses the metadata channel exclusively,
   * NO host-visible channel is ever used: client.tui.publish renders every
   * envelope as an on-screen toast on stock v1 and is contractually silent; v1
   * companions derive truth from persisted state files instead.
   */
  tuiTransport?: GoalTuiPublishFn;
}

/**
 * Merges recovered state from a single session file into the process-wide startup state.
 *
 * Aggregates goals, results, session ordering, receipts, pending intents,
 * focused goals, and deduplicates invalidated goal IDs across sessions.
 */
export function mergeRecovered(
  into: PersistedState | undefined,
  recovered: RecoveredState,
): PersistedState {
  const base: PersistedState = into ?? {
    version: 1,
    goals: [],
    results: [],
    sessionOrdered: [],
    invalidatedGoalIds: [],
    pendingIntents: [],
    settlementReceipts: [],
    focusedGoalIds: [],
  };
  base.goals.push(...recovered.goals.map(serializeGoal));
  base.results.push(...recovered.results);
  base.sessionOrdered.push(...recovered.sessionOrdered);
  base.invalidatedGoalIds!.push(...recovered.invalidatedGoalIds);
  base.pendingIntents!.push(...recovered.pendingIntents);
  base.settlementReceipts!.push(...recovered.settlementReceipts);
  base.focusedGoalIds!.push(...recovered.focusedGoalIds);
  // Deduplicate invalidated goal IDs across sessions to avoid redundant fences.
  base.invalidatedGoalIds = [...new Set(base.invalidatedGoalIds)];
  return base;
}
