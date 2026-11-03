/**
 * Status dashboard formatters: goal lists, token gauges, and history timelines.
 *
 * All formatting functions are pure transformations from snapshots to text/sections,
 * with relative timestamps rendered against the active system clock.
 */

import type {GoalTuiSnapshot} from './tui-state.ts';
import {
  formatNumber,
  formatRelativeTime,
  PRODUCT_DISPLAY_NAME,
} from './tui-components.ts';
import {
  computeAnalytics,
  formatAnalyticsSummary,
  formatBudgetWarning,
} from './tui-analytics.ts';
import {brakeCeiling, brakeCeilingFormatted} from './brake-format.ts';
import {statusTag, stopReasonLabel} from './status-label.ts';

/**
 * A section of the dashboard. Each section has a title (header) and text
 * (body). The TUI renders these as titled panels in a modal dialog.
 */
export interface DashboardSection {
  title: string;
  text: string;
}

/** Greedy word-wrap for cockpit text; never splits words, keeps indent on continuation lines. */
export function wrapText(
  text: string,
  width: number,
  continuationIndent = '',
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [text];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > width) {
      lines.push(current);
      current = continuationIndent + word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Checks whether a goal belongs to a session other than the active one.
 * When `activeSessionID` is null (ownership unknown), returns false.
 */
export function isForeignGoal(
  goal: GoalTuiSnapshot,
  activeSessionID: string | null,
): boolean {
  return activeSessionID !== null && goal.sessionID !== activeSessionID;
}

/** The owning session id, in full: truncated labels cannot tell two sessions apart. */
export function foreignSessionLabel(goal: GoalTuiSnapshot): string {
  return goal.sessionID;
}

/**
 * Generates an informational message when displaying goals belonging to other sessions.
 * Returns null if the goal list only contains goals from the active session.
 */
export function fallbackNotice(
  goals: GoalTuiSnapshot[],
  activeSessionID: string | null,
): string | null {
  if (activeSessionID === null) return null;
  const foreign = goals.filter(g => isForeignGoal(g, activeSessionID));
  if (foreign.length === 0) return null;
  const mine = goals.length - foreign.length;
  return mine === 0
    ? `This session has no goals. Showing ${foreign.length} from other sessions.`
    : `Showing ${foreign.length} from other sessions alongside this session's ${mine}.`;
}

/** Formats a goal item into title and description lines for list rendering. */
export function goalListRow(
  goal: GoalTuiSnapshot,
  index: number,
  activeSessionID: string | null,
): {title: string; description: string} {
  const foreign = isForeignGoal(goal, activeSessionID);
  return {
    title: `${index + 1}. [${statusTag(goal.status, goal.stopReason, goal.stoppedAt, undefined, goal.updatedAt)}] ${goal.condition.substring(0, 60)}`,
    description:
      (foreign ? `Another session (${foreignSessionLabel(goal)}) | ` : '') +
      `Tokens: ${goal.totalTokens}/${brakeCeiling(goal.maxTokens)} Turns: ${goal.turnCount}/${brakeCeiling(goal.maxTurns)}`,
  };
}

/**
 * The dashboard's goal-steering buttons, as a pure function over a store.
 * With no goal of this view's session on screen the buttons do nothing
 * rather than steering a goal the user is not looking at.
 *
 * @param targetSessionID the session the rows are drawn for.
 */
export function dashboardGoalActions(
  store: {
    getFocused: (id: string) => GoalTuiSnapshot | undefined;
    getAllSnapshots: () => GoalTuiSnapshot[];
  },
  targetSessionID: () => string | null,
  send: (command: string) => void,
): {onPause: () => void; onResume: () => void; onClear: () => void} {
  const withTarget = (verb: string) => () => {
    const id = resolveFocusedGoalId(store, targetSessionID());
    if (id) send(`${verb} ${id}`);
  };
  return {
    onPause: withTarget('pause'),
    onResume: withTarget('resume'),
    onClear: withTarget('clear'),
  };
}

/**
 * The dashboard footer's text: what the keys will do, and what they will do it to.
 *
 * `targetGoalId` is `resolveFocusedGoalId`'s answer for the session the rows
 * are drawn for. `null` means nothing of that session is on screen, and the
 * footer is navigation alone: an advertised key that does nothing is worse
 * than an absent one.
 */
export function dashboardFooterText(
  targetGoalId: string | null,
  dashboardChord: string,
  pauseChord: string,
  resumeChord: string,
  clearChord: string,
  escLabel: string,
): string {
  const nav = `${dashboardChord} dashboard | ${escLabel} home`;
  if (!targetGoalId) return nav;
  return `${pauseChord} pause | ${resumeChord} resume | ${clearChord} clear | ${nav}`;
}

/**
 * Determines which goal the focus pointer should target for a given session.
 * Never targets a goal owned by another session.
 */
export function resolveFocusedGoalId(
  store: {
    getFocused: (id: string) => GoalTuiSnapshot | undefined;
    getAllSnapshots: () => GoalTuiSnapshot[];
  },
  sessionID: string | null,
): string | null {
  if (sessionID === null) return null;
  const focused = store.getFocused(sessionID);
  if (focused) return focused.goalId;
  const mine = store
    .getAllSnapshots()
    .filter(g => !isForeignGoal(g, sessionID));
  return mine.length > 0 ? mine[mine.length - 1].goalId : null;
}

/**
 * The lines the v2 dashboard renders on one goal's card.
 */
export interface GoalCardLine {
  text: string;
  /** Rendered in the theme's subdued colour: explanatory, not the status itself. */
  subdued?: boolean;
}

export function goalCardLines(
  goal: GoalTuiSnapshot,
  activeSessionID: string | null,
): GoalCardLine[] {
  const lines: GoalCardLine[] = [];
  lines.push({text: `Objective: ${goal.condition}`});
  // The status line index is fixed at 1 so consumers can reliably apply status-based styling.
  lines.push({text: `  Status:     ${goal.status}`});
  if (isForeignGoal(goal, activeSessionID)) {
    lines.push({
      subdued: true,
      text: `  Session:    ${foreignSessionLabel(goal)} (another session)`,
    });
  }
  if (goal.stopReason) {
    lines.push({
      subdued: true,
      text: `  Stop:       ${stopReasonLabel(goal.stopReason, goal.status, goal.stoppedAt, undefined, goal.updatedAt)}`,
    });
  }
  lines.push({text: `  ${tokenGauge(goal.totalTokens, goal.maxTokens)}`});
  lines.push({
    text: `  Turns:      ${goal.turnCount}/${brakeCeiling(goal.maxTurns)}`,
  });
  return lines;
}

/**
 * The token bar, with its denominator from brake-format.
 */
function tokenGauge(used: number, max: number): string {
  const pct = max > 0 ? Math.round((used / max) * 100) : 0;
  const compact = (n: number): string =>
    n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  return `Tokens: ${pct}%  ${compact(used)} / ${brakeCeilingFormatted(max, compact)}`;
}

/**
 * Formats a complete goal status dashboard from a list of goal snapshots.
 * Returns an array of DashboardSection objects for structured rendering.
 */
export function formatGoalStatusDashboard(
  goals: GoalTuiSnapshot[],
  activeSessionID: string | null = null,
): DashboardSection[] {
  if (goals.length === 0) {
    return [
      {
        title: PRODUCT_DISPLAY_NAME,
        text: 'No active goals. Use /goal <condition> to set one.',
      },
    ];
  }

  const sections: DashboardSection[] = [];

  const notice = fallbackNotice(goals, activeSessionID);
  if (notice) {
    sections.push({title: 'Sessions shown', text: notice});
  }

  for (const goal of goals) {
    const lines: string[] = [];
    lines.push(
      ...wrapText(`  Objective:  ${goal.condition}`, 96, '              '),
    );
    lines.push(`  Status:     ${goal.status}`);

    if (isForeignGoal(goal, activeSessionID)) {
      lines.push(
        `  Session:    ${foreignSessionLabel(goal)} (another session)`,
      );
    }

    if (goal.stopReason) {
      lines.push(
        `  Stop:       ${stopReasonLabel(goal.stopReason, goal.status, goal.stoppedAt, undefined, goal.updatedAt)}`,
      );
    }
    if (goal.blockedReason) {
      lines.push(`  Blocked:    ${goal.blockedReason}`);
    }

    lines.push('');
    lines.push(formatTokenGauge(goal.totalTokens, goal.maxTokens));
    // A non-positive limit indicates that braking limits are disabled.
    lines.push(
      `  Turns:      ${goal.turnCount} / ${brakeCeiling(goal.maxTurns)}`,
    );

    if (goal.usage.costKnown && goal.usage.cost > 0) {
      lines.push(`  Cost:       $${goal.usage.cost.toFixed(4)}`);
    }

    const analytics = computeAnalytics(goal);
    const analyticsLine = formatAnalyticsSummary(analytics);
    if (analyticsLine) {
      lines.push(`  Analytics: ${analyticsLine}`);
    }
    const warning = formatBudgetWarning(analytics);
    if (warning) {
      lines.push(`  ${warning}`);
    }

    if (goal.lastCheckpoint) {
      lines.push('');
      lines.push(`  Checkpoint: ${goal.lastCheckpoint.summary}`);
      lines.push(
        `             ${formatRelativeTime(goal.lastCheckpoint.timestamp)}`,
      );
    }

    if (goal.history.length > 0) {
      lines.push('');
      lines.push(formatHistoryList(goal.history));
    }

    sections.push({
      title: `Goal: ${goal.goalId.substring(0, 8)}`,
      text: lines.join('\n'),
    });
  }

  return sections;
}

/**
 * Formats a visual token usage gauge.
 *
 * Example: "  Tokens: 50%  100,000 / 200,000"
 */
export function formatTokenGauge(used: number, max: number): string {
  const percentage = max > 0 ? (used / max) * 100 : 0;
  const maxLabel = max > 0 ? formatNumber(max) : 'unlimited';
  return `  Tokens: ${Math.round(percentage)}%  ${formatNumber(used)} / ${maxLabel}`;
}

// History entries whose type is not "mutation" are state-machine transitions
// (active/paused/blocked/complete/budgetLimited/finalizing) or named events
// (retraction) — always user-meaningful. "mutation" entries are bookkeeping by
// default and only surface when their detail matches a human-authored or
// lifecycle-critical action. This keeps internal per-turn tracking (execution
// context captures, usage/claim updates) out of user-facing views while
// preserving complete state in the persistence ledger.
const MUTATION_SIGNAL_PREFIXES: ReadonlyArray<string> = [
  'User ',
  'Human ',
  'Accepted proposal',
  'Rejected proposal',
  'Proposed term changes',
  'Recorded claim',
  'Loaded from persisted state',
  'Paused because',
  'Backgrounded',
  'Queued goal',
  'Started an ordered sequence',
  'Pressure rung',
];

export function isSignalHistoryEntry(
  entry: Readonly<{type: string; detail: string}>,
): boolean {
  if (entry.type === 'tracking') return false;
  if (entry.type !== 'mutation') return true;
  return MUTATION_SIGNAL_PREFIXES.some(prefix =>
    entry.detail.startsWith(prefix),
  );
}

/**
 * Formats lifecycle and human-authored history events, excluding noisy bookkeeping mutations.
 * Events are ordered chronologically with the most recent last. Full history is rendered
 * without truncation, relying on the host terminal's scroll buffer.
 */
export function formatHistoryList(
  history: ReadonlyArray<
    Readonly<{type: string; detail: string; timestamp: number}>
  >,
): string {
  const signals = history.filter(isSignalHistoryEntry);
  if (signals.length === 0) {
    return '  History: (no lifecycle events)';
  }
  const lines: string[] = ['  History:'];
  for (const entry of signals) {
    const time = formatRelativeTime(entry.timestamp);
    lines.push(`    [${entry.type}] ${entry.detail} (${time})`);
  }
  return lines.join('\n');
}
