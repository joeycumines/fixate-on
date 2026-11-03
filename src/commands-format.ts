/**
 * Output formatters for /goal commands: status headlines, detailed statuses,
 * usage metrics, history, list, and result views.
 */

import type {GoalLifecycleEvent, GoalState} from './state-machine.ts';
import type {GoalResult} from './persistence.ts';
import {
  claimQualityLabel,
  describeVerifier,
  unattestedReason,
} from './claim-vocabulary.ts';
import {chargedTokens} from './accounting.ts';
import {isSignalHistoryEntry} from './tui-views.ts';
import {formatRelativeTime} from './tui-components.ts';
import {brakeCeiling, brakeCeilingFormatted} from './brake-format.ts';
import {isSelfResolvingStop, stopReasonLabel} from './status-label.ts';

/**
 * Formats a mode-aware header for command output.
 */
export function formatCommandHeader(
  hasTui: boolean,
  subcommand: string,
): string {
  const prefix = hasTui ? TUI_MODE_HEADER : SERVER_MODE_HEADER;
  return `${prefix} /${subcommand}`;
}

type LastClaim = GoalState['lastClaim'];

/**
 * Generates a human-readable sentence summarizing the completion claim outcome.
 * Uses shared claim vocabulary definitions from `src/claim-vocabulary.ts`.
 */
export function claimSentence(claim: LastClaim): string {
  if (!claim) return '';
  switch (claim.outcome.status) {
    case 'verified-complete': {
      // Uses "attested" to match the formal claim vocabulary status.
      const by = describeVerifier(claim.check);
      return `Done — attested by ${by === 'no verifier' ? 'an unnamed verifier' : by}.`;
    }
    case 'unverifiable-claim':
      return `Done, but no attestation could be obtained (${unattestedReason(claim)}).`;
    case 'claim-refuted':
      return `Not done yet — the check disagreed${claim.outcome.detail ? `: ${claim.outcome.detail}` : ''}.`;
    case 'blocked-acknowledged':
      return 'Paused as blocked — waiting for you.';
    default:
      return '';
  }
}

const STATE_SENTENCES: Record<string, string> = {
  active: 'Working',
  finalizing: 'Wrapping up the current step',
  paused: 'Paused',
  blocked: 'Paused as blocked',
  budgetLimited: 'Stopped — token budget exhausted',
  complete: 'Complete',
};

/** One-line state description plus verification outcome. */
function stateSentence(goal: GoalState): string {
  const base = STATE_SENTENCES[goal.status] ?? `State: ${goal.status}`;
  const claim = goal.lastClaim;
  if (!claim) return base;
  // A refuted or unverifiable claim on an active goal is notable; an attested claim accompanies complete state.
  if (
    claim.outcome.status === 'verified-complete' &&
    goal.status !== 'complete'
  )
    return base;
  return `${base}. ${claimSentence(claim)}`;
}

function brakesLine(goal: GoalState): string {
  const turns = `${goal.turnCount}/${brakeCeiling(goal.maxTurns)} turns`;
  const tokens = `${goal.totalTokens.toLocaleString()}/${brakeCeilingFormatted(goal.maxTokens, n => n.toLocaleString())} ctx tokens`;
  return `Brakes: ${turns} | ${tokens}`;
}

/**
 * Formats a concise status summary for default display without internal jargon.
 */
export function formatStatusHeadline(
  goal: GoalState,
  commandName = 'goal',
): string {
  const lines: string[] = [`${stateSentence(goal)}: ${goal.condition}`];
  lines.push(brakesLine(goal));
  if (!goal.lastClaim && goal.status === 'complete') {
    lines.push('Done, but no attestation could be obtained.');
  }
  if (goal.pendingProposal) {
    lines.push(
      `Pending proposal awaiting your receipt: run /${commandName} accept or /${commandName} reject.`,
    );
  }
  if (goal.status === 'active' || goal.finalizing) {
    lines.push(
      `Next: keep working toward the objective; the loop continues on idle. Detail: /${commandName} status --verbose`,
    );
  } else if (
    isSelfResolvingStop(
      goal.status,
      goal.stopReason,
      goal.stoppedAt,
      Date.now(),
      goal.updatedAt,
    )
  ) {
    // Avoid prompting "resume" if the stop is self-resolving; calling resume resets turnCount mid-turn.
    lines.push(
      `Next: nothing — ${stopReasonLabel(goal.stopReason ?? '', goal.status, goal.stoppedAt, Date.now(), goal.updatedAt)}. Detail: /${commandName} status --verbose`,
    );
  } else {
    lines.push(
      `Next: run /${commandName} resume to continue, or /${commandName} clear to discard. Full wall: /${commandName} status --verbose`,
    );
  }
  return lines.join('\n');
}

export function formatStatus(
  goal: GoalState,
  commandName = 'goal',
  opts?: {verbose?: boolean},
): string {
  if (opts?.verbose === false) return formatStatusHeadline(goal, commandName);
  const now =
    goal.finishedAt ?? (goal.pausedAt > 0 ? goal.pausedAt : Date.now());
  const elapsed = Math.max(
    0,
    Math.round((now - (goal.startedAt || now)) / 1000),
  );
  let statusLabel =
    goal.status === 'active' ? 'Active goal' : `Goal (status: ${goal.status})`;
  if (goal.status === 'complete') {
    if (goal.lastClaim?.outcome.status === 'unverifiable-claim') {
      statusLabel = `Goal (status: complete [unattested: ${unattestedReason(goal.lastClaim)}])`;
    } else if (goal.lastClaim?.outcome.status === 'verified-complete') {
      const by = describeVerifier(goal.lastClaim.check);
      statusLabel =
        by === 'no verifier'
          ? 'Goal (status: complete [attested])'
          : `Goal (status: complete [attested by ${by}])`;
    }
  }
  const lines: string[] = [`${statusLabel}: ${goal.condition}`];

  if (goal.successCriteria)
    lines.push(`Success criteria: ${goal.successCriteria}`);
  if (goal.constraints) lines.push(`Constraints: ${goal.constraints}`);
  if (goal.artifactPointers && goal.artifactPointers.length > 0) {
    lines.push(`Artifact pointers: ${goal.artifactPointers.join(', ')}`);
  }
  if (goal.mode && goal.mode !== 'normal') lines.push(`Mode: ${goal.mode}`);

  lines.push(
    `Auto-continues sent: ${goal.turnCount}/${brakeCeiling(goal.maxTurns)}`,
    `Context tokens: ${goal.totalTokens.toLocaleString()}/${brakeCeilingFormatted(goal.maxTokens, n => n.toLocaleString())}`,
  );

  if (typeof goal.tokenBudget === 'number' && goal.tokenBudget > 0) {
    const used = chargedTokens(goal.usage);
    const remaining = Math.max(0, goal.tokenBudget - used);
    lines.push(
      `Token budget: ${used.toLocaleString()}/${goal.tokenBudget.toLocaleString()} charged (${remaining.toLocaleString()} remaining)`,
    );
  }

  lines.push(
    formatUsage(goal.usage),
    `Elapsed: ${elapsed}s/${brakeCeilingFormatted(goal.maxDurationMs, n => Math.round(n / 1000) + 's')}`,
  );

  if (goal.lastProgressAt > 0) {
    const progressAge = Math.max(
      0,
      Math.round((Date.now() - goal.lastProgressAt) / 1000),
    );
    lines.push(`Last progress: ${progressAge}s ago`);
  } else {
    lines.push('Last progress: none yet');
  }

  lines.push(`No-progress turns: ${goal.noProgressTurns}`);

  if (goal.recoveryTurns > 0) {
    lines.push(
      `Recovery turns: ${goal.recoveryTurns}/${goal.maxRecoveryTurns}`,
    );
  }
  if (goal.unchangedResults > 0) {
    lines.push(
      `Unchanged results: ${goal.unchangedResults}/${goal.maxUnchangedResults}`,
    );
  }
  if (goal.blockedTurns > 0) {
    lines.push(
      `Blocked attempts: ${goal.blockedTurns}/${goal.maxBlockedTurns}`,
    );
  }

  if (goal.lastClaim) {
    const c = goal.lastClaim;
    const checkTarget = c.check.target ? ` (${c.check.target})` : '';
    lines.push(claimSentence(c));
    const quality = claimQualityLabel(c.outcome.status);
    lines.push(
      `Last claim: [${quality}] check=${c.check.path}${checkTarget} verdict=${c.check.verdict} detail="${c.outcome.detail}"`,
    );
  }

  if (goal.lastCheckpoint) {
    lines.push(`Recent checkpoint: ${goal.lastCheckpoint.summary}`);
  } else {
    lines.push('Recent checkpoint: none yet');
  }

  if (goal.pendingProposal) {
    lines.push(
      `Pending proposal [${goal.pendingProposal.proposalId}]: ${goal.pendingProposal.reason}`,
      `  Run /${commandName} accept to apply or /${commandName} reject to discard`,
    );
  }

  lines.push(
    `Last status: ${goal.lastStatus || 'No assistant turn recorded yet.'}`,
  );

  if (goal.status !== 'active') {
    lines.push(
      `Stopped: ${stopReasonLabel(goal.stopReason || 'unknown', goal.status, goal.stoppedAt, Date.now(), goal.updatedAt)}`,
    );
    if (goal.blockedReason) lines.push(`Blocked reason: ${goal.blockedReason}`);
    if (goal.status === 'blocked') {
      lines.push(
        `Suggested action: address the blocker, then run /${commandName} resume`,
      );
    } else if (goal.status === 'budgetLimited') {
      lines.push(
        `Suggested action: run /${commandName} clear and create a new goal for a fresh budget`,
      );
    } else {
      lines.push(
        `Suggested action: run /${commandName} resume to continue, or /${commandName} clear to discard`,
      );
    }
  }

  return lines.join('\n');
}

function formatUsage(usage: GoalState['usage']): string {
  const parts: string[] = [];
  if (usage.input) parts.push(`input: ${usage.input.toLocaleString()}`);
  if (usage.output) parts.push(`output: ${usage.output.toLocaleString()}`);
  if (usage.reasoning)
    parts.push(`reasoning: ${usage.reasoning.toLocaleString()}`);
  if (usage.cacheRead)
    parts.push(`cacheRead: ${usage.cacheRead.toLocaleString()}`);
  if (usage.cacheWrite)
    parts.push(`cacheWrite: ${usage.cacheWrite.toLocaleString()}`);
  if (usage.costKnown && usage.cost > 0)
    parts.push(`cost: $${usage.cost.toFixed(4)}`);
  return `Usage: ${parts.join(', ') || 'none'}`;
}

export function formatHistory(history: GoalLifecycleEvent[]): string {
  const signals = history.filter(isSignalHistoryEntry);
  if (signals.length === 0) return 'No lifecycle events recorded.';
  const lines: string[] = [];
  for (const entry of signals) {
    lines.push(
      `[${formatRelativeTime(entry.timestamp)}] ${entry.type}: ${entry.detail}`,
    );
  }
  return lines.join('\n');
}

export function formatGoalList(
  goals: GoalState[],
  archived: GoalResult[],
  focusedId: string | null,
  commandName = 'goal',
  isOrdered = false,
): string {
  if (goals.length === 0 && archived.length === 0) {
    return `No goals yet. Set one with \`/${commandName} <condition>\`.`;
  }

  const lines: string[] = [];
  if (isOrdered) lines.push('(ordered sequence)');
  if (goals.length > 0) {
    lines.push(`Goals (${goals.length}):`);
    goals.forEach((goal, index) => {
      const marker =
        goal.goalId === focusedId
          ? 'focused'
          : goal.status !== 'active' || goal.stopReason
            ? 'background'
            : 'idle';
      const state =
        goal.status !== 'active' || goal.stopReason
          ? ` — ${goal.stopReason ? stopReasonLabel(goal.stopReason, goal.status, goal.stoppedAt, Date.now(), goal.updatedAt) : goal.status}`
          : '';
      lines.push(`${index + 1}. [${marker}] ${goal.condition}${state}`);
    });
    lines.push(
      'Markers: focused = driven now | idle = active between turns | background = waiting (paused or queued).',
    );
    lines.push(`Switch with \`/${commandName} focus <number>\`.`);
  } else {
    lines.push('No active goals.');
  }

  if (archived.length > 0) {
    lines.push('', `Archived (${archived.length}, newest last):`);
    for (const result of archived) {
      const isUnattested =
        result.lastClaim?.outcome?.status === 'unverifiable-claim';
      const stateLabel = isUnattested
        ? `${result.state} [unattested]`
        : result.state;
      lines.push(`- [${stateLabel}] ${result.condition}`);
    }
  }

  return lines.join('\n');
}

export function formatGoalResult(result: GoalResult): string {
  const isUnattested =
    result.lastClaim?.outcome?.status === 'unverifiable-claim';
  const stateLabel = isUnattested
    ? `${result.state} [unattested: ${unattestedReason(result.lastClaim)}]`
    : result.state;
  const lines = [`Last goal: ${result.condition}`, `State: ${stateLabel}`];
  if (result.tokenBudget) {
    const used = chargedTokens(result.usage);
    lines.push(
      `Token budget: ${used.toLocaleString()}/${result.tokenBudget.toLocaleString()}`,
    );
  }
  if (result.blockedReason) lines.push(`Blocked: ${result.blockedReason}`);
  return lines.join('\n');
}

/**
 * Header prefix for TUI mode output indicating dashboard availability.
 */
export const TUI_MODE_HEADER = '[TUI mode]';

/**
 * Header prefix for server mode output routed directly to the model as a chat turn.
 */
export const SERVER_MODE_HEADER =
  '[Server mode - output routed to model as chat turn]';
