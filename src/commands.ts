import type {
  FocusResult,
  GoalProgressNote,
  GoalState,
  GoalStateMachine,
  GoalStatus,
} from './state-machine.ts';
import {MAX_LIVE_GOALS, TERMINAL_STATUSES} from './state-machine.ts';
import type {GoalResult} from './persistence.ts';
import {
  formatGoalList,
  formatGoalResult,
  formatHistory,
  formatStatus,
} from './commands-format.ts';
import {
  CLEAR_COMMANDS,
  HISTORY_COMMANDS,
  LIST_COMMANDS,
  NO_ARG_SUBCOMMANDS,
  parseGoalArguments,
  splitObjectives,
  STATUS_COMMANDS,
  stripWrappingQuotes,
} from './commands-args.ts';
import type {CreateGoalOptions} from './tools.ts';
import {buildHandbackDeliverable} from './handback.ts';
import {stopReasonLabel} from './status-label.ts';

const MAX_OBJECTIVE_LENGTH = 4000;
const MAX_COMMAND_ARGUMENT_LENGTH = 10000;
const MAX_CHECKPOINTS = 20;

export interface CommandSessionContext {
  sessionID: string;
  /**
   * Workspace the goal's work happens in. Handback and review must diff THIS
   * directory, not `process.cwd`: the host's session directory is the
   * authority for what the goal touched, and reading the process cwd made the
   * diff — and its runtime — depend on wherever the plugin was launched from.
   */
  workspaceDirectory?: string;
  getMachine: () => GoalStateMachine | null;
  /**
   * Resolve a specific goal's machine (FOCUS-CONTRACT-1 clause 4). Every
   * action that names a goal needs this: resolving through `getMachine`
   * targets whatever is FOCUSED, which is how a card action aimed at one goal
   * landed on another. Optional so existing fixtures keep compiling.
   */
  getMachineById?: (goalId: string) => GoalStateMachine | null;
  listActiveGoals: () => GoalState[];
  listArchivedResults: () => GoalResult[];
  createGoal: (
    objective: string,
    options: CreateGoalOptions,
  ) => GoalStateMachine;
  replaceGoals: (
    objective: string,
    options: CreateGoalOptions,
  ) => Promise<GoalStateMachine>;
  removeGoal: (
    goalId: string,
    caller?: import('./state-machine.ts').TransitionSource,
  ) => Promise<void>;
  clearSession: () => Promise<void> | void;
  focusGoal: (goalId: string) => Promise<FocusResult>;
  addOrderedSession: () => void;
  isOrdered: () => boolean;
  persist: () => Promise<boolean>;
  /**
   * Whether another live process holds this session's file. `persist`
   * returning false has several causes; only a lease refusal is somebody
   * else's process, so the `NOT SAVED` line asks rather than assumes.
   */
  isOwnedElsewhere?: () => boolean;
}

/**
 * Resolve a goal reference to exactly one goal: 1-based index, full id, or
 * unique prefix. An ambiguous prefix is an error, never a silent fallback to
 * the first match or the focused goal.
 */
type GoalRefResolution =
  | {ok: true; goal: GoalState}
  | {ok: false; reason: 'none' | 'ambiguous'; matches: number};

function resolveGoalRef(goals: GoalState[], ref: string): GoalRefResolution {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    const goal =
      index >= 1 && index <= goals.length ? goals[index - 1] : undefined;
    return goal ? {ok: true, goal} : {ok: false, reason: 'none', matches: 0};
  }
  const exact = goals.find(g => g.goalId === trimmed);
  if (exact) return {ok: true, goal: exact};
  const prefixed = goals.filter(g => g.goalId.startsWith(trimmed));
  if (prefixed.length === 1) return {ok: true, goal: prefixed[0]!};
  if (prefixed.length > 1)
    return {ok: false, reason: 'ambiguous', matches: prefixed.length};
  return {ok: false, reason: 'none', matches: 0};
}

/**
 * Split an optional leading goal ID off a free-text operand (`edit`, `checkpoint`).
 * A leading token counts as a reference when it looks like a goal ID (full UUID),
 * whether or not a goal with that ID is still active.
 *
 * An active ID resolves; a stale or mistyped ID is reported by `resolveOperandMachine`,
 * never folded into the objective text to avoid rewriting the wrong goal with UUID
 * text. Non-UUID tokens remain part of the objective.
 */
const GOAL_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function splitLeadingGoalId(
  goals: GoalState[],
  operand: string,
): {goalId: string | null; rest: string} {
  const space = operand.indexOf(' ');
  if (space <= 0) return {goalId: null, rest: operand};
  const candidate = operand.slice(0, space);
  if (goals.some(g => g.goalId === candidate))
    return {goalId: candidate, rest: operand.slice(space + 1)};
  if (GOAL_ID_SHAPE.test(candidate))
    return {goalId: candidate, rest: operand.slice(space + 1)};
  return {goalId: null, rest: operand};
}

/**
 * Resolves the state machine targeted by a free-text verb: either the named goal
 * or the currently focused goal if none was named.
 *
 * Non-UUID tokens remain part of the objective prose. If an explicit goal ID cannot
 * be resolved, an error is reported rather than falling back to the focused goal.
 */
function resolveOperandMachine(
  session: CommandSessionContext,
  named: string | null,
): {machine: GoalStateMachine | null; error?: string} {
  if (named === null) return {machine: session.getMachine()};
  const machine = session.getMachineById?.(named) ?? null;
  return machine
    ? {machine}
    : {
        machine: null,
        error: `Goal ${named} could not be resolved in this session.`,
      };
}

export async function handleCommand(
  args: string,
  session: CommandSessionContext,
  commandName = 'goal',
): Promise<string> {
  if (args.length > MAX_COMMAND_ARGUMENT_LENGTH) {
    return `Goal command arguments must be ${MAX_COMMAND_ARGUMENT_LENGTH} characters or fewer.`;
  }

  const trimmed = args.trim();
  // Status defaults to a concise headline; --verbose opts into the full status output.
  let verbose = false;
  let statusKey = trimmed;
  if (/--verbose$/i.test(statusKey)) {
    const candidate = statusKey.replace(/\s*--verbose$/i, '').trim();
    if (!candidate || STATUS_COMMANDS.has(candidate.toLowerCase())) {
      verbose = true;
      statusKey = candidate;
    }
  }

  if (!statusKey || STATUS_COMMANDS.has(statusKey.toLowerCase())) {
    const machine = session.getMachine();
    if (machine) {
      return formatStatus(machine.snapshot(), commandName, {verbose});
    }
    const archived = session.listArchivedResults();
    if (archived.length > 0) {
      return formatGoalResult(archived[archived.length - 1]);
    }
    return `No active goal. Set one with \`/${commandName} <condition>\`.`;
  }

  if (HISTORY_COMMANDS.has(trimmed.toLowerCase())) {
    const machine = session.getMachine();
    if (machine) {
      const goal = machine.snapshot();
      return [
        `Goal history for: ${goal.condition}`,
        '',
        `Latest checkpoint: ${goal.lastCheckpoint?.summary || 'none yet'}`,
        '',
        formatHistory(goal.history),
      ].join('\n');
    }
    const archived = session.listArchivedResults();
    if (archived.length > 0) {
      const last = archived[archived.length - 1];
      return [
        `Last goal history for: ${last.condition}`,
        '',
        `Latest checkpoint: ${last.lastCheckpoint?.summary || 'none recorded'}`,
        '',
        formatHistory(last.history),
      ].join('\n');
    }
    return `No goal history recorded yet. Set a goal with \`/${commandName} <condition>\`.`;
  }

  if (LIST_COMMANDS.has(trimmed.toLowerCase())) {
    const goals = session.listActiveGoals();
    const archived = session.listArchivedResults();
    const focusedMachine = session.getMachine();
    const focusedId = focusedMachine?.snapshot().goalId ?? null;
    return formatGoalList(
      goals,
      archived,
      focusedId,
      commandName,
      session.isOrdered(),
    );
  }

  // `clear <goalId>` clears a specific goal. The bare `clear` command wipes the
  // whole session and warns if multiple active goals exist to prevent accidental deletion.
  // Match verb case-insensitively while preserving the goal reference case verbatim.
  const clearMatch = /^([A-Za-z]+)(?:\s+(\S+))?$/.exec(trimmed);
  if (clearMatch && CLEAR_COMMANDS.has(clearMatch[1].toLowerCase())) {
    const requestedRef = clearMatch[2];
    if (requestedRef) {
      const target = session
        .listActiveGoals()
        .find(
          g => g.goalId === requestedRef || g.goalId.startsWith(requestedRef),
        );
      if (!target) {
        return `No active goal matching "${requestedRef}" to clear.`;
      }
      await session.removeGoal(target.goalId);
      await session.persist();
      return `Goal cleared: ${target.condition}`;
    }
    const activeGoals = session.listActiveGoals();
    if (activeGoals.length === 0) {
      return 'No active goal to clear.';
    }
    if (activeGoals.length > 1) {
      return `This session holds ${activeGoals.length} goals; bare \`/${commandName} clear\` would discard all of them. Name one: \`/${commandName} clear <goalId>\`, or \`/${commandName} list\` to see them.`;
    }
    for (const g of activeGoals) {
      await session.removeGoal(g.goalId);
    }
    await session.clearSession();
    await session.persist();
    return 'Goal cleared.';
  }

  // Bare form targets the focused goal; `pause <ref>` targets an explicit goal.
  if (
    trimmed.toLowerCase() === 'pause' ||
    trimmed.toLowerCase().startsWith('pause ')
  ) {
    const ref = trimmed.slice('pause'.length).trim();
    let machine = session.getMachine();
    if (ref) {
      const resolved = resolveGoalRef(session.listActiveGoals(), ref);
      if (!resolved.ok) {
        return resolved.reason === 'ambiguous'
          ? `"${ref}" matches ${resolved.matches} goals; use more of the id or the list number.`
          : `No goal found matching "${ref}". Run \`/${commandName} list\` to see available goals.`;
      }
      machine = session.getMachineById?.(resolved.goal.goalId) ?? null;
      if (!machine) {
        return `Goal "${resolved.goal.goalId.substring(0, 8)}" is not addressable. Run \`/${commandName} list\`.`;
      }
    }
    if (!machine) {
      return `No active goal. Set one with \`/${commandName} <condition>\`.`;
    }
    const goal = machine.snapshot();
    if (goal.status !== 'active') {
      // Render through the shared label so the internal ledger token is not exposed.
      return `Goal is already paused (${stopReasonLabel(goal.stopReason, goal.status, goal.stoppedAt, Date.now(), goal.updatedAt) || goal.status}).`;
    }
    const pauseResult = await machine.transition('paused', {
      source: 'slash-command',
      stopReason: 'paused',
      detail: ref
        ? 'User paused this goal from its card.'
        : 'User paused the active goal.',
    });
    if (!pauseResult.ok) {
      return `Failed to pause goal: ${pauseResult.error}`;
    }
    await session.persist();
    return `Goal paused: ${goal.condition}`;
  }

  // Resume follows the same explicit-identifier contract as pause.
  if (
    trimmed.toLowerCase() === 'resume' ||
    trimmed.toLowerCase().startsWith('resume ')
  ) {
    const ref = trimmed.slice('resume'.length).trim();
    let machine = session.getMachine();
    if (ref) {
      const resolved = resolveGoalRef(session.listActiveGoals(), ref);
      if (!resolved.ok) {
        return resolved.reason === 'ambiguous'
          ? `"${ref}" matches ${resolved.matches} goals; use more of the id or the list number.`
          : `No goal found matching "${ref}". Run \`/${commandName} list\` to see available goals.`;
      }
      machine = session.getMachineById?.(resolved.goal.goalId) ?? null;
      if (!machine) {
        return `Goal "${resolved.goal.goalId.substring(0, 8)}" is not addressable. Run \`/${commandName} list\`.`;
      }
    }
    if (!machine) {
      return `No active goal. Set one with \`/${commandName} <condition>\`.`;
    }
    const goal = machine.snapshot();
    if (goal.status === 'active') {
      return 'Goal is already running.';
    }
    if (TERMINAL_STATUSES.has(goal.status)) {
      return `Goal is ${goal.status} (terminal) and cannot be resumed. Run \`/${commandName} clear\` and create a new goal.`;
    }
    await machine.mutate(
      g => {
        g.turnCount = 0;
        // A fresh window restarts the pressure ladder from r1.
        g.pressureRung = undefined;
        // Turn count is reset here; recoveryTurns, unchangedResults, blockedTurns,
        // and blockedAssertedThisTurn are reset by the transition("active") side effects.
      },
      {
        source: 'slash-command',
        detail: 'Reset turn count before resume',
        skipPersist: true,
      },
    );
    const resumeResult = await machine.transition('active', {
      source: 'slash-command',
      stopReason: '',
      detail: 'User resumed the goal.',
    });
    if (!resumeResult.ok) {
      return `Failed to resume goal: ${resumeResult.error}`;
    }
    await session.persist();
    return `Goal resumed: ${goal.condition} (turn count restarted at 0 for a fresh budget window.)`;
  }

  if (
    trimmed.toLowerCase() === 'accept' ||
    trimmed.toLowerCase().startsWith('accept ') ||
    trimmed.toLowerCase() === 'accept-proposal' ||
    trimmed.toLowerCase().startsWith('accept-proposal ')
  ) {
    const machine = session.getMachine();
    if (!machine) {
      return `No active goal. Set one with \`/${commandName} <condition>\`.`;
    }
    const goal = machine.snapshot();
    if (!goal.pendingProposal) {
      return 'No pending proposal to accept.';
    }
    const proposal = goal.pendingProposal;
    const rawArg = trimmed.replace(/^accept(-proposal)?\s*/i, '').trim();
    if (rawArg && rawArg !== proposal.proposalId) {
      return `Proposal ID mismatch: pending proposal is "${proposal.proposalId}", but "${rawArg}" was requested.`;
    }
    await machine.mutate(
      g => {
        if (proposal.objective) g.condition = proposal.objective;
        if (proposal.successCriteria !== undefined)
          g.successCriteria = proposal.successCriteria;
        if (proposal.constraints !== undefined)
          g.constraints = proposal.constraints;
        if (proposal.artifactPointers !== undefined)
          g.artifactPointers = proposal.artifactPointers;
        g.pendingProposal = null;
        g.objectiveUpdatedPending = true;
        g.lastStatus = `Accepted proposal [${proposal.proposalId}]: ${proposal.reason}`;
      },
      {
        source: 'slash-command',
        detail: `Human accepted proposal [${proposal.proposalId}]: ${proposal.reason}`,
      },
    );
    await session.persist();
    return `Accepted proposal [${proposal.proposalId}]: terms updated.\nReason: ${proposal.reason}`;
  }

  if (
    trimmed.toLowerCase() === 'reject' ||
    trimmed.toLowerCase().startsWith('reject ') ||
    trimmed.toLowerCase() === 'reject-proposal' ||
    trimmed.toLowerCase().startsWith('reject-proposal ')
  ) {
    const machine = session.getMachine();
    if (!machine) {
      return `No active goal. Set one with \`/${commandName} <condition>\`.`;
    }
    const goal = machine.snapshot();
    if (!goal.pendingProposal) {
      return 'No pending proposal to reject.';
    }
    const proposal = goal.pendingProposal;
    const rawArg = trimmed.replace(/^reject(-proposal)?\s*/i, '').trim();
    if (rawArg && rawArg !== proposal.proposalId) {
      return `Proposal ID mismatch: pending proposal is "${proposal.proposalId}", but "${rawArg}" was requested.`;
    }
    await machine.mutate(
      g => {
        g.pendingProposal = null;
        g.lastStatus = `Rejected proposal [${proposal.proposalId}]: ${proposal.reason}`;
      },
      {
        source: 'slash-command',
        detail: `Human rejected proposal [${proposal.proposalId}]: ${proposal.reason}`,
      },
    );
    await session.persist();
    return `Rejected proposal [${proposal.proposalId}].`;
  }

  if (
    trimmed.toLowerCase() === 'handback' ||
    trimmed.toLowerCase().startsWith('handback ')
  ) {
    const machine = session.getMachine();
    if (!machine) {
      return `No active goal. Set one with \`/${commandName} <condition>\`.`;
    }
    const goal = machine.snapshot();
    const deliverable = await buildHandbackDeliverable(
      goal,
      session.workspaceDirectory,
    );
    return [
      `# Handback Deliverable for Goal [${deliverable.goalId}]`,
      `Objective: ${deliverable.condition}`,
      `Status: ${deliverable.status}`,
      `Claims: ${deliverable.claims.length} recorded`,
      '',
      deliverable.externalReviewPayload,
    ].join('\n');
  }

  if (
    trimmed.toLowerCase() === 'review' ||
    trimmed.toLowerCase().startsWith('review ') ||
    trimmed.toLowerCase() === 'review-payload' ||
    trimmed.toLowerCase().startsWith('review-payload ')
  ) {
    const machine = session.getMachine();
    if (!machine) {
      return `No active goal. Set one with \`/${commandName} <condition>\`.`;
    }
    const goal = machine.snapshot();
    const deliverable = await buildHandbackDeliverable(
      goal,
      session.workspaceDirectory,
    );
    return deliverable.externalReviewPayload;
  }

  // Edit objective: accepts either `edit <objective>` (focused goal) or
  // `edit <goalId> <objective>` (explicit goal).
  if (
    trimmed.toLowerCase() === 'edit' ||
    trimmed.toLowerCase().startsWith('edit ')
  ) {
    const {goalId: namedGoalId, rest: editOperand} = splitLeadingGoalId(
      session.listActiveGoals(),
      trimmed.slice('edit'.length).trim(),
    );
    const resolvedEdit = resolveOperandMachine(session, namedGoalId);
    if (resolvedEdit.error) return resolvedEdit.error;
    const machine = resolvedEdit.machine;
    if (!machine) {
      return `No active goal to edit. Set one with \`/${commandName} <condition>\`.`;
    }
    const newObjective = stripWrappingQuotes(editOperand);
    if (!newObjective) {
      return `No new objective provided. Use \`/${commandName} edit <new objective>\`.`;
    }
    if (newObjective.length > MAX_OBJECTIVE_LENGTH) {
      return `Goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`;
    }
    const editGoal = machine.snapshot();
    if (TERMINAL_STATUSES.has(editGoal.status)) {
      return `Goal is ${editGoal.status} (terminal) and cannot be edited. Run \`/${commandName} clear\` and create a new goal.`;
    }
    if (editGoal.status !== 'active') {
      const editTransitionResult = await machine.transition('active', {
        source: 'slash-command',
        stopReason: '',
        detail: 'User edited the goal objective',
      });
      if (!editTransitionResult.ok) {
        return `Failed to edit goal: ${editTransitionResult.error}`;
      }
    }
    await machine.mutate(
      goal => {
        goal.condition = newObjective;
        goal.objectiveUpdatedPending = true;
        goal.noProgressTurns = 0;
        goal.noToolCallTurns = 0;
        goal.lastCountedProgressMessageID = '';
        goal.lastNoToolCallMessageID = '';
        goal.lastStatus = 'Goal objective updated.';
      },
      {source: 'slash-command', detail: 'User edited the goal objective'},
    );
    const priorStatus = editGoal.status;
    const reactivated = priorStatus !== 'active';
    await session.persist();
    return [
      `Goal objective updated: ${newObjective}`,
      ...(reactivated
        ? [`The goal was ${priorStatus} and is now active again.`]
        : []),
      '',
      `Budgets and history are preserved. Run \`/${commandName} resume\` for a fresh budget window, or \`/${commandName} status\` to review.`,
    ].join('\n');
  }

  if (
    trimmed.toLowerCase() === 'focus' ||
    trimmed.toLowerCase().startsWith('focus ')
  ) {
    const ref = trimmed.slice('focus'.length).trim();
    const goals = session.listActiveGoals();
    if (goals.length === 0) {
      return `No goals to focus. Set one with \`/${commandName} <condition>\`.`;
    }
    if (!ref) {
      return `Specify which goal to focus:\n\n${formatGoalList(goals, [], session.getMachine()?.snapshot().goalId ?? null, commandName)}`;
    }

    const resolved = resolveGoalRef(goals, ref);
    if (!resolved.ok) {
      return resolved.reason === 'ambiguous'
        ? `"${ref}" matches ${resolved.matches} goals; use more of the id or the list number.`
        : `No goal found matching "${ref}". Run \`/${commandName} list\` to see available goals.`;
    }

    const focused = await session.focusGoal(resolved.goal.goalId);
    if (!focused.ok) {
      // Distinguish terminal goals from general resolution failures.
      return focused.reason === 'terminal'
        ? `Goal "${resolved.goal.goalId.substring(0, 8)}" is already finished and cannot be focused.`
        : `Failed to focus goal: ${resolved.goal.condition}`;
    }
    await session.persist();
    return `Focused goal: ${resolved.goal.condition}`;
  }

  // Checkpoint: supports optional leading goal ID addressing, matching `edit`.
  if (
    trimmed.toLowerCase() === 'checkpoint' ||
    trimmed.toLowerCase().startsWith('checkpoint ')
  ) {
    const {goalId: namedGoalId, rest: checkpointOperand} = splitLeadingGoalId(
      session.listActiveGoals(),
      trimmed.slice('checkpoint'.length).trim(),
    );
    const resolvedCheckpoint = resolveOperandMachine(session, namedGoalId);
    if (resolvedCheckpoint.error) return resolvedCheckpoint.error;
    const machine = resolvedCheckpoint.machine;
    if (!machine) {
      return `No active goal. Set one with \`/${commandName} <condition>\`.`;
    }
    const summary = checkpointOperand;
    if (!summary) {
      return `Provide a checkpoint summary: \`/${commandName} checkpoint <summary>\``;
    }
    const checkpointGoal = machine.snapshot();
    if (TERMINAL_STATUSES.has(checkpointGoal.status)) {
      return `Goal is ${checkpointGoal.status} (terminal) and cannot be checkpointed. Run \`/${commandName} clear\` and create a new goal.`;
    }
    await machine.mutate(
      goal => {
        const checkpoint: GoalProgressNote = {
          timestamp: Date.now(),
          summary,
        };
        goal.lastCheckpoint = checkpoint;
        goal.checkpoints.push(checkpoint);
        if (goal.checkpoints.length > MAX_CHECKPOINTS) {
          goal.checkpoints.splice(0, goal.checkpoints.length - MAX_CHECKPOINTS);
        }
        goal.lastProgressAt = Date.now();
      },
      {source: 'slash-command', detail: 'User saved a checkpoint'},
    );
    await session.persist();
    return `Checkpoint saved: ${summary}`;
  }

  if (
    trimmed.toLowerCase() === 'add' ||
    trimmed.toLowerCase().startsWith('add ')
  ) {
    const createArgs = trimmed.slice('add'.length).trim();
    const parsed = parseGoalArguments(createArgs);
    if (parsed.errors.length > 0) {
      return parsed.errors.join('\n');
    }
    if (!parsed.condition) {
      return `No objective provided. Use \`/${commandName} add <condition>\`.`;
    }
    if (parsed.condition.length > MAX_OBJECTIVE_LENGTH) {
      return `Goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`;
    }

    const activeGoals = session.listActiveGoals();
    const unfinishedGoals = activeGoals.filter(
      g => !TERMINAL_STATUSES.has(g.status),
    );
    if (unfinishedGoals.length >= MAX_LIVE_GOALS) {
      return `A session may contain at most ${MAX_LIVE_GOALS} live goals.`;
    }

    // Adding a goal does not pause running work; all unfinished goals continue
    // running per idle event. The new goal becomes the focused target.
    const machine = session.createGoal(parsed.condition, parsed.options);
    if (parsed.tokenBudget && parsed.tokenBudget > 0) {
      await machine.mutate(
        goal => {
          goal.tokenBudget = parsed.tokenBudget!;
        },
        {source: 'slash-command', detail: 'Set token budget'},
      );
    }
    const addedPersisted = await session.persist();
    if (!addedPersisted) {
      const cause = session.isOwnedElsewhere?.()
        ? "NOT SAVED — this host could not write this session's file, because another process owns it."
        : "NOT SAVED — this host would not write this session's file. No other process owns it; see the host log for the cause.";
      return [
        cause,
        'The goal is live in memory for this process only and will be gone on restart.',
        `Objective: ${parsed.condition}`,
      ].join('\n');
    }
    return `Added and focused new goal: ${parsed.condition}`;
  }

  if (
    trimmed.toLowerCase() === 'sequence' ||
    trimmed.toLowerCase().startsWith('sequence ')
  ) {
    const rest = trimmed.slice('sequence'.length).trim();
    const objectives = splitObjectives(rest);

    if (!objectives.length) {
      return `No objectives provided. Use \`/${commandName} sequence <objective 1>; <objective 2>; …\` (separate with \`;\` or newlines).`;
    }
    if (objectives.length > MAX_LIVE_GOALS) {
      return `An ordered sequence may contain at most ${MAX_LIVE_GOALS} goals.`;
    }
    if (objectives.some(objective => objective.length > MAX_OBJECTIVE_LENGTH)) {
      return `Each goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`;
    }

    const existingGoals = session.listActiveGoals();
    for (const goal of existingGoals) {
      await session.removeGoal(goal.goalId, 'sequence-replace');
    }

    let firstGoalId: string | null = null;
    for (let i = 0; i < objectives.length; i++) {
      const machine = session.createGoal(objectives[i], {mode: 'ordered'});
      if (i === 0) {
        firstGoalId = machine.state.goalId;
      } else {
        await machine.mutate(
          goal => {
            goal.status = 'paused' as GoalStatus;
            goal.stopReason = 'queued';
            if (!goal.pausedAt) goal.pausedAt = Date.now();
          },
          {
            source: 'slash-command',
            detail: `Queued goal ${i + 1}/${objectives.length}`,
          },
        );
      }
    }
    // createGoal sets the newly created goal as focused; re-focus the first goal in the sequence.
    if (firstGoalId) {
      await session.focusGoal(firstGoalId);
    }
    session.addOrderedSession();
    await session.persist();
    const lines = [
      `Started an ordered sequence of ${objectives.length} goal(s):`,
      ...objectives.map((objective, index) => `${index + 1}. ${objective}`),
      '',
      `Focused goal 1: ${objectives[0]}`,
    ];
    return lines.join('\n');
  }

  const firstWord = trimmed.toLowerCase().split(/\s+/)[0];
  if (NO_ARG_SUBCOMMANDS.has(firstWord)) {
    return `\`/${commandName} ${firstWord}\` does not accept additional arguments. Run \`/${commandName} ${firstWord}\` without extra text.`;
  }

  const parsed = parseGoalArguments(trimmed);
  if (parsed.errors.length > 0) {
    return parsed.errors.join('\n');
  }
  if (!parsed.condition) {
    return `No objective provided. Use \`/${commandName} <condition>\` to set a goal.`;
  }
  if (parsed.condition.length > MAX_OBJECTIVE_LENGTH) {
    return `Goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`;
  }

  const machine = await session.replaceGoals(parsed.condition, parsed.options);
  if (parsed.tokenBudget && parsed.tokenBudget > 0) {
    await machine.mutate(
      goal => {
        goal.tokenBudget = parsed.tokenBudget!;
      },
      {source: 'slash-command', detail: 'Set token budget'},
    );
  }
  const createdPersisted = await session.persist();

  const lines = createdPersisted
    ? [`New active goal: ${parsed.condition}`]
    : [
        // Differentiate known lease conflicts from other persistence failures.
        session.isOwnedElsewhere?.()
          ? "NOT SAVED — this host could not write this session's file, because another process owns it."
          : "NOT SAVED — this host would not write this session's file. No other process owns it; see the host log for the cause.",
        'The goal is live in memory for this process only and will be gone on restart.',
        `Objective: ${parsed.condition}`,
      ];
  if (parsed.options.successCriteria) {
    lines.push(`Success criteria: ${parsed.options.successCriteria}`);
    lines.push(
      'Completion will be checked: update_goal {status: "complete"} is gated until a verifier attests the success criteria.',
    );
  }
  if (parsed.options.constraints)
    lines.push(`Constraints / non-goals: ${parsed.options.constraints}`);
  if (
    parsed.options.artifactPointers &&
    parsed.options.artifactPointers.length > 0
  ) {
    lines.push(
      `Artifact pointers: ${parsed.options.artifactPointers.join(', ')}`,
    );
  }
  if (parsed.options.mode && parsed.options.mode !== 'normal')
    lines.push(`Mode: ${parsed.options.mode}`);
  lines.push('', 'Start working toward this goal now.');
  lines.push(
    'When the goal is fully satisfied, call update_goal with status "complete". If you are truly blocked and need the user, call update_goal with status "blocked".',
  );
  return lines.join('\n');
}

// Re-export formatters and parsers for backwards compatibility with existing consumers.
export {
  TUI_MODE_HEADER,
  SERVER_MODE_HEADER,
  formatCommandHeader,
  claimSentence,
  formatStatusHeadline,
  formatStatus,
  formatHistory,
  formatGoalList,
  formatGoalResult,
} from './commands-format.ts';
export {
  CLEAR_COMMANDS,
  STATUS_COMMANDS,
  HISTORY_COMMANDS,
  LIST_COMMANDS,
  NO_ARG_SUBCOMMANDS,
  SUBCOMMAND_ROOTS,
  stripWrappingQuotes,
  parsePositiveInt,
  parseNonNegativeInt,
  splitObjectives,
  parseBudgetShorthand,
  parseGoalArguments,
  isBareGoalObjective,
  canonicalGoalDispatch,
  normalizeObjectiveText,
  readQuotedValue,
} from './commands-args.ts';
