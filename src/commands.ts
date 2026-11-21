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
  formatHistoryRaw,
  formatStatus,
} from './commands-format.ts';
import {
  parseGoalCommand,
  ATTACHMENT_ACTIVATION_ERROR,
  NO_ARG_SUBCOMMANDS,
  parseGoalArguments,
  resolveGoalRef,
  resolveOperandMachine,
  splitLeadingGoalId,
  splitObjectives,
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
  hasRetainedKickoff?: (goalId: string) => boolean;
  kickoffAdmissionInFlight?: (goalId: string) => boolean;
}

export interface CommandOutcome {
  ok: boolean;
  text: string;
  /**
   * The goal the command actually targeted, when deterministic (e.g. `add`
   * returns the newly created goal). Lets dispatchers pair kickoff
   * attachments with the correct goal under concurrent commands.
   */
  targetGoalId?: string;
}

const passOutcome = (text: string, targetGoalId?: string): CommandOutcome => ({
  ok: true,
  text,
  ...(targetGoalId ? {targetGoalId} : {}),
});
const failOutcome = (text: string): CommandOutcome => ({ok: false, text});

export async function handleCommand(
  args: string,
  session: CommandSessionContext,
  commandName = 'goal',
): Promise<string> {
  const outcome = await handleCommandOutcome(args, session, commandName);
  return outcome.text;
}

export async function handleCommandOutcome(
  args: string,
  session: CommandSessionContext,
  commandName = 'goal',
  options: {hasAttachments?: boolean; userCommandStartedAt?: number} = {},
): Promise<CommandOutcome> {
  const userCommandStartedAt = options.userCommandStartedAt ?? Date.now();
  if (args.length > MAX_COMMAND_ARGUMENT_LENGTH) {
    return failOutcome(
      `Goal command arguments must be ${MAX_COMMAND_ARGUMENT_LENGTH} characters or fewer.`,
    );
  }

  const trimmed = args.trim();
  const command = parseGoalCommand(trimmed);
  if (
    options.hasAttachments &&
    !['set', 'add', 'sequence', 'resume', 'edit'].includes(command.action)
  )
    return failOutcome(ATTACHMENT_ACTIVATION_ERROR);
  const verbose = command.verbose;
  if (command.action === 'status') {
    const machine = session.getMachine();
    if (machine) {
      return passOutcome(
        formatStatus(machine.snapshot(), commandName, {verbose}),
      );
    }
    const archived = session.listArchivedResults();
    if (archived.length > 0) {
      return passOutcome(formatGoalResult(archived[archived.length - 1]));
    }
    return passOutcome(
      `No active goal. Set one with \`/${commandName} <condition>\`.`,
    );
  }

  // `history [--verbose|--full]`: bare shows signal lifecycle entries; the flag
  // adds the raw trail (including bookkeeping mutations the bare view filters).
  if (command.action === 'history') {
    const historyVerbose = command.verbose;
    const machine = session.getMachine();
    if (machine) {
      const goal = machine.snapshot();
      return passOutcome(
        [
          `Goal history for: ${goal.condition}`,
          '',
          `Latest checkpoint: ${goal.lastCheckpoint?.summary || 'none yet'}`,
          '',
          historyVerbose
            ? formatHistoryRaw(goal.history)
            : formatHistory(goal.history),
        ].join('\n'),
      );
    }
    const archived = session.listArchivedResults();
    if (archived.length > 0) {
      const last = archived[archived.length - 1];
      return passOutcome(
        [
          `Last goal history for: ${last.condition}`,
          '',
          `Latest checkpoint: ${last.lastCheckpoint?.summary || 'none recorded'}`,
          '',
          historyVerbose
            ? formatHistoryRaw(last.history)
            : formatHistory(last.history),
        ].join('\n'),
      );
    }
    return passOutcome(
      `No goal history recorded yet. Set a goal with \`/${commandName} <condition>\`.`,
    );
  }

  // `list` (and `list all` / `ls all`, the documented explicit form of the same
  // listing: live goals plus the settled archive) share one body. Anything
  // else after `list` is rejected rather than treated as an objective.
  if (command.action === 'list') {
    const goals = session.listActiveGoals();
    const archived = session.listArchivedResults();
    const focusedMachine = session.getMachine();
    const focusedId = focusedMachine?.snapshot().goalId ?? null;
    return passOutcome(
      formatGoalList(
        goals,
        archived,
        focusedId,
        commandName,
        session.isOrdered(),
      ),
    );
  }

  // `clear <goalId>` clears a specific goal. The bare `clear` command wipes the
  // whole session and warns if multiple active goals exist to prevent accidental deletion.
  // Match verb case-insensitively while preserving the goal reference case verbatim.
  if (command.action === 'clear') {
    const requestedRef = command.operand;
    if (requestedRef) {
      const goals = session.listActiveGoals();
      const exact = goals.find(g => g.goalId === requestedRef);
      const matches = exact
        ? [exact]
        : goals.filter(g => g.goalId.startsWith(requestedRef));
      if (matches.length > 1)
        return failOutcome(
          `"${requestedRef}" matches ${matches.length} goals; use more of the id to clear one.`,
        );
      const target = matches[0];
      if (!target) {
        return failOutcome(
          `No active goal matching "${requestedRef}" to clear.`,
        );
      }
      await session.removeGoal(target.goalId);
      await session.persist();
      return passOutcome(`Goal cleared: ${target.condition}`);
    }
    const activeGoals = session.listActiveGoals();
    if (activeGoals.length === 0) {
      return passOutcome('No active goal to clear.');
    }
    if (activeGoals.length > 1) {
      return failOutcome(
        `This session holds ${activeGoals.length} goals; bare \`/${commandName} clear\` would discard all of them. Name one: \`/${commandName} clear <goalId>\`, or \`/${commandName} list\` to see them.`,
      );
    }
    for (const g of activeGoals) {
      await session.removeGoal(g.goalId);
    }
    await session.clearSession();
    await session.persist();
    return passOutcome('Goal cleared.');
  }

  // Bare form targets the focused goal; `pause <ref>` targets an explicit goal.
  if (command.action === 'pause') {
    const ref = command.operand;
    let machine = session.getMachine();
    if (ref) {
      const resolved = resolveGoalRef(session.listActiveGoals(), ref);
      if (!resolved.ok) {
        return failOutcome(
          resolved.reason === 'ambiguous'
            ? `"${ref}" matches ${resolved.matches} goals; use more of the id or the list number.`
            : `No goal found matching "${ref}". Run \`/${commandName} list\` to see available goals.`,
        );
      }
      machine = session.getMachineById?.(resolved.goal.goalId) ?? null;
      if (!machine) {
        return failOutcome(
          `Goal "${resolved.goal.goalId.substring(0, 8)}" is not addressable. Run \`/${commandName} list\`.`,
        );
      }
    }
    if (!machine) {
      return passOutcome(
        `No active goal. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    const goal = machine.snapshot();
    if (goal.status !== 'active') {
      // Render through the shared label so the internal ledger token is not exposed.
      return passOutcome(
        `Goal is already paused (${stopReasonLabel(goal.stopReason, goal.status, goal.stoppedAt, Date.now(), goal.updatedAt) || goal.status}).`,
      );
    }
    const pauseResult = await machine.transition('paused', {
      source: 'slash-command',
      stopReason: 'paused',
      detail: ref
        ? 'User paused this goal from its card.'
        : 'User paused the active goal.',
    });
    if (!pauseResult.ok) {
      return failOutcome(`Failed to pause goal: ${pauseResult.error}`);
    }
    await session.persist();
    return passOutcome(`Goal paused: ${goal.condition}`);
  }

  // Resume follows the same explicit-identifier contract as pause.
  if (command.action === 'resume') {
    const ref = command.operand;
    let machine = session.getMachine();
    if (ref) {
      const resolved = resolveGoalRef(session.listActiveGoals(), ref);
      if (!resolved.ok) {
        return failOutcome(
          resolved.reason === 'ambiguous'
            ? `"${ref}" matches ${resolved.matches} goals; use more of the id or the list number.`
            : `No goal found matching "${ref}". Run \`/${commandName} list\` to see available goals.`,
        );
      }
      machine = session.getMachineById?.(resolved.goal.goalId) ?? null;
      if (!machine) {
        return failOutcome(
          `Goal "${resolved.goal.goalId.substring(0, 8)}" is not addressable. Run \`/${commandName} list\`.`,
        );
      }
    }
    if (!machine) {
      return failOutcome(
        `No active goal. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    const goal = machine.snapshot();
    if (
      options.hasAttachments &&
      session.kickoffAdmissionInFlight?.(goal.goalId)
    ) {
      return failOutcome(
        'The previous kickoff admission is still in flight. Wait for it to finish before resuming with attachments.',
      );
    }
    if (
      (goal.kickoffAdmissionPending ||
        goal.stopReason === 'kickoff admission failed') &&
      !options.hasAttachments &&
      !session.hasRetainedKickoff?.(goal.goalId)
    ) {
      return failOutcome(
        `The original kickoff inputs are no longer available. Resubmit \`/${commandName} resume ${goal.goalId}\` with the original attachments, or explicitly edit the objective to start a new kickoff.`,
      );
    }
    if (goal.status === 'active') {
      if (
        options.hasAttachments &&
        !goal.kickoffAdmissionPending &&
        !session.hasRetainedKickoff?.(goal.goalId)
      ) {
        return failOutcome(ATTACHMENT_ACTIVATION_ERROR);
      }
      return passOutcome('Goal is already running.', goal.goalId);
    }
    if (TERMINAL_STATUSES.has(goal.status)) {
      return failOutcome(
        `Goal is ${goal.status} (terminal) and cannot be resumed. Run \`/${commandName} clear\` and create a new goal.`,
      );
    }
    const resumeResult = await machine.transition('active', {
      source: 'slash-command',
      stopReason: '',
      detail: 'User resumed the goal.',
      // The marker and budget reset belong to the accepted activation. A
      // competing resume that loses the transition cannot undo either field.
      restart: {kickoffAdmissionPending: options.hasAttachments},
    });
    if (!resumeResult.ok) {
      return failOutcome(`Failed to resume goal: ${resumeResult.error}`);
    }
    await session.persist();
    return passOutcome(
      `Goal resumed: ${goal.condition} (turn count restarted at 0 for a fresh budget window.)`,
      goal.goalId,
    );
  }

  if (command.action === 'accept') {
    const machine = session.getMachine();
    if (!machine) {
      return failOutcome(
        `No active goal. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    const goal = machine.snapshot();
    if (!goal.pendingProposal) {
      return failOutcome('No pending proposal to accept.');
    }
    const proposal = goal.pendingProposal;
    const rawArg = command.operand;
    if (rawArg && rawArg !== proposal.proposalId) {
      return failOutcome(
        `Proposal ID mismatch: pending proposal is "${proposal.proposalId}", but "${rawArg}" was requested.`,
      );
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
    return passOutcome(
      `Accepted proposal [${proposal.proposalId}]: terms updated.\nReason: ${proposal.reason}`,
    );
  }

  if (command.action === 'reject') {
    const machine = session.getMachine();
    if (!machine) {
      return failOutcome(
        `No active goal. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    const goal = machine.snapshot();
    if (!goal.pendingProposal) {
      return failOutcome('No pending proposal to reject.');
    }
    const proposal = goal.pendingProposal;
    const rawArg = command.operand;
    if (rawArg && rawArg !== proposal.proposalId) {
      return failOutcome(
        `Proposal ID mismatch: pending proposal is "${proposal.proposalId}", but "${rawArg}" was requested.`,
      );
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
    return passOutcome(`Rejected proposal [${proposal.proposalId}].`);
  }

  if (command.action === 'handback') {
    const machine = session.getMachine();
    if (!machine) {
      return failOutcome(
        `No active goal. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    const goal = machine.snapshot();
    const deliverable = await buildHandbackDeliverable(
      goal,
      session.workspaceDirectory,
    );
    return passOutcome(
      [
        `# Handback Deliverable for Goal [${deliverable.goalId}]`,
        `Objective: ${deliverable.condition}`,
        `Status: ${deliverable.status}`,
        `Claims: ${deliverable.claims.length} recorded`,
        '',
        deliverable.externalReviewPayload,
      ].join('\n'),
    );
  }

  if (command.action === 'review') {
    const machine = session.getMachine();
    if (!machine) {
      return failOutcome(
        `No active goal. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    const goal = machine.snapshot();
    const deliverable = await buildHandbackDeliverable(
      goal,
      session.workspaceDirectory,
    );
    return passOutcome(deliverable.externalReviewPayload);
  }

  // Edit objective: accepts either `edit <objective>` (focused goal) or
  // `edit <goalId> <objective>` (explicit goal).
  if (command.action === 'edit') {
    const {goalId: namedGoalId, rest: editOperand} = splitLeadingGoalId(
      session.listActiveGoals(),
      command.operand,
    );
    const resolvedEdit = resolveOperandMachine(session, namedGoalId);
    if (resolvedEdit.error) return failOutcome(resolvedEdit.error);
    const machine = resolvedEdit.machine;
    if (!machine) {
      return failOutcome(
        `No active goal to edit. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    const newObjective = stripWrappingQuotes(editOperand);
    if (!newObjective) {
      return failOutcome(
        `No new objective provided. Use \`/${commandName} edit <new objective>\`.`,
      );
    }
    if (newObjective.length > MAX_OBJECTIVE_LENGTH) {
      return failOutcome(
        `Goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`,
      );
    }
    const editGoal = machine.snapshot();
    if (session.kickoffAdmissionInFlight?.(editGoal.goalId)) {
      return failOutcome(
        'The previous kickoff admission is still in flight. Wait for it to finish before editing this goal.',
      );
    }
    if (
      options.hasAttachments &&
      editGoal.status === 'active' &&
      !(
        editGoal.kickoffAdmissionPending &&
        !session.hasRetainedKickoff?.(editGoal.goalId)
      )
    )
      return failOutcome(ATTACHMENT_ACTIVATION_ERROR);
    if (TERMINAL_STATUSES.has(editGoal.status)) {
      return failOutcome(
        `Goal is ${editGoal.status} (terminal) and cannot be edited. Run \`/${commandName} clear\` and create a new goal.`,
      );
    }
    const priorEditKickoffAdmissionPending = editGoal.kickoffAdmissionPending;
    if (options.hasAttachments) {
      await machine.mutate(
        goal => {
          goal.kickoffAdmissionPending = true;
        },
        {
          source: 'slash-command',
          detail: 'Require attached kickoff inputs before activation',
          skipPersist: true,
        },
      );
    }
    if (editGoal.status !== 'active') {
      const editTransitionResult = await machine.transition('active', {
        source: 'slash-command',
        stopReason: '',
        detail: 'User edited the goal objective',
      });
      if (!editTransitionResult.ok) {
        if (options.hasAttachments) {
          await machine.mutate(
            goal => {
              goal.kickoffAdmissionPending = priorEditKickoffAdmissionPending;
            },
            {
              source: 'slash-command',
              detail: 'Restore kickoff admission marker after failed edit',
              skipPersist: true,
            },
          );
        }
        return failOutcome(
          `Failed to edit goal: ${editTransitionResult.error}`,
        );
      }
    }
    await machine.mutate(
      goal => {
        goal.condition = newObjective;
        // An explicit replacement objective can waive inputs lost on restart.
        // Live retained inputs stay required until they are actually admitted.
        if (
          !options.hasAttachments &&
          !session.hasRetainedKickoff?.(goal.goalId)
        )
          goal.kickoffAdmissionPending = false;
        goal.objectiveUpdatedPending = true;
        goal.noProgressTurns = 0;
        goal.noToolCallTurns = 0;
        goal.lastCountedProgressMessageID = '';
        goal.stalledTurnCounted = false;
        goal.lastNoToolCallMessageID = '';
        goal.lastStatus = 'Goal objective updated.';
      },
      {source: 'slash-command', detail: 'User edited the goal objective'},
    );
    const priorStatus = editGoal.status;
    const reactivated = priorStatus !== 'active';
    await session.persist();
    return passOutcome(
      [
        `Goal objective updated: ${newObjective}`,
        ...(reactivated
          ? [`The goal was ${priorStatus} and is now active again.`]
          : []),
        '',
        `Budgets and history are preserved. Run \`/${commandName} resume\` for a fresh budget window, or \`/${commandName} status\` to review.`,
      ].join('\n'),
      editGoal.goalId,
    );
  }

  if (command.action === 'focus') {
    const ref = command.operand;
    const goals = session.listActiveGoals();
    if (goals.length === 0) {
      return failOutcome(
        `No goals to focus. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    if (!ref) {
      return failOutcome(
        `Specify which goal to focus:\n\n${formatGoalList(goals, [], session.getMachine()?.snapshot().goalId ?? null, commandName)}`,
      );
    }

    const resolved = resolveGoalRef(goals, ref);
    if (!resolved.ok) {
      return failOutcome(
        resolved.reason === 'ambiguous'
          ? `"${ref}" matches ${resolved.matches} goals; use more of the id or the list number.`
          : `No goal found matching "${ref}". Run \`/${commandName} list\` to see available goals.`,
      );
    }

    const focused = await session.focusGoal(resolved.goal.goalId);
    if (!focused.ok) {
      // Distinguish terminal goals from general resolution failures.
      return failOutcome(
        focused.reason === 'terminal'
          ? `Goal "${resolved.goal.goalId.substring(0, 8)}" is already finished and cannot be focused.`
          : `Failed to focus goal: ${resolved.goal.condition}`,
      );
    }
    await session.persist();
    return passOutcome(`Focused goal: ${resolved.goal.condition}`);
  }

  // Checkpoint: supports optional leading goal ID addressing, matching `edit`.
  if (command.action === 'checkpoint') {
    const {goalId: namedGoalId, rest: checkpointOperand} = splitLeadingGoalId(
      session.listActiveGoals(),
      command.operand,
    );
    const resolvedCheckpoint = resolveOperandMachine(session, namedGoalId);
    if (resolvedCheckpoint.error) return failOutcome(resolvedCheckpoint.error);
    const machine = resolvedCheckpoint.machine;
    if (!machine) {
      return failOutcome(
        `No active goal. Set one with \`/${commandName} <condition>\`.`,
      );
    }
    const summary = checkpointOperand;
    if (!summary) {
      return failOutcome(
        `Provide a checkpoint summary: \`/${commandName} checkpoint <summary>\``,
      );
    }
    const checkpointGoal = machine.snapshot();
    if (TERMINAL_STATUSES.has(checkpointGoal.status)) {
      return failOutcome(
        `Goal is ${checkpointGoal.status} (terminal) and cannot be checkpointed. Run \`/${commandName} clear\` and create a new goal.`,
      );
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
    return passOutcome(`Checkpoint saved: ${summary}`);
  }

  if (command.action === 'add') {
    const createArgs = command.operand;
    const parsed = parseGoalArguments(createArgs);
    if (parsed.errors.length > 0) {
      return failOutcome(parsed.errors.join('\n'));
    }
    if (!parsed.condition) {
      return failOutcome(
        `No objective provided. Use \`/${commandName} add <condition>\`.`,
      );
    }
    if (parsed.condition.length > MAX_OBJECTIVE_LENGTH) {
      return failOutcome(
        `Goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`,
      );
    }

    const activeGoals = session.listActiveGoals();
    const unfinishedGoals = activeGoals.filter(
      g => !TERMINAL_STATUSES.has(g.status),
    );
    if (unfinishedGoals.length >= MAX_LIVE_GOALS) {
      return failOutcome(
        `A session may contain at most ${MAX_LIVE_GOALS} live goals.`,
      );
    }

    // Adding a goal does not pause running work; all unfinished goals continue
    // running per idle event. The new goal becomes the focused target.
    const machine = session.createGoal(parsed.condition, {
      ...parsed.options,
      kickoffAdmissionPending: options.hasAttachments,
      userCommandStartedAt,
    });
    if (parsed.tokenBudget && parsed.tokenBudget > 0) {
      await machine.mutate(
        goal => {
          goal.tokenBudget = parsed.tokenBudget!;
        },
        {source: 'slash-command', detail: 'Set token budget'},
      );
    }
    const addedPersisted = await session.persist();
    const addedGoalId = machine.snapshot().goalId;
    if (!addedPersisted) {
      const cause = session.isOwnedElsewhere?.()
        ? "NOT SAVED — this host could not write this session's file, because another process owns it."
        : "NOT SAVED — this host would not write this session's file. No other process owns it; see the host log for the cause.";
      return {
        ok: true,
        text: [
          cause,
          'The goal is live in memory for this process only and will be gone on restart.',
          `Objective: ${parsed.condition}`,
        ].join('\n'),
        targetGoalId: addedGoalId,
      };
    }
    return {
      ok: true,
      text: `Added and focused new goal: ${parsed.condition}`,
      targetGoalId: addedGoalId,
    };
  }

  if (command.action === 'sequence') {
    const rest = command.operand;
    const objectives = splitObjectives(rest);

    if (!objectives.length) {
      return failOutcome(
        `No objectives provided. Use \`/${commandName} sequence <objective 1>; <objective 2>; …\` (separate with \`;\` or newlines).`,
      );
    }
    if (objectives.length > MAX_LIVE_GOALS) {
      return failOutcome(
        `An ordered sequence may contain at most ${MAX_LIVE_GOALS} goals.`,
      );
    }
    if (objectives.some(objective => objective.length > MAX_OBJECTIVE_LENGTH)) {
      return failOutcome(
        `Each goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`,
      );
    }

    const existingGoals = session.listActiveGoals();
    for (const goal of existingGoals) {
      await session.removeGoal(goal.goalId, 'sequence-replace');
    }

    let firstGoalId: string | null = null;
    for (let i = 0; i < objectives.length; i++) {
      const machine = session.createGoal(objectives[i], {
        mode: 'ordered',
        kickoffAdmissionPending: i === 0 && options.hasAttachments,
        userCommandStartedAt,
      });
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
    return passOutcome(lines.join('\n'), firstGoalId ?? undefined);
  }

  const firstWord = command.root;
  if (
    command.action === 'invalid' ||
    (firstWord !== null &&
      NO_ARG_SUBCOMMANDS.has(firstWord) &&
      typeof command.operand === 'string' &&
      command.operand.trim().length > 0)
  ) {
    return failOutcome(
      `\`/${commandName} ${firstWord}\` does not accept additional arguments. Run \`/${commandName} ${firstWord}\` without extra text.`,
    );
  }

  const parsed = parseGoalArguments(trimmed);
  if (parsed.errors.length > 0) {
    return failOutcome(parsed.errors.join('\n'));
  }
  if (!parsed.condition) {
    return failOutcome(
      `No objective provided. Use \`/${commandName} <condition>\` to set a goal.`,
    );
  }
  if (parsed.condition.length > MAX_OBJECTIVE_LENGTH) {
    return failOutcome(
      `Goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`,
    );
  }

  const machine = await session.replaceGoals(parsed.condition, {
    ...parsed.options,
    kickoffAdmissionPending: options.hasAttachments,
    userCommandStartedAt,
  });
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
  return passOutcome(lines.join('\n'), machine.snapshot().goalId);
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
  formatHistoryRaw,
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
