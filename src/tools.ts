/**
 * Canonical goal management tools, response serialization, and dispatch handlers.
 *
 * Completion and blocked transitions use a pending-intent step barrier to keep
 * model claims durable and checked before terminal states are applied.
 */

import type {
  FocusResult,
  GoalProposal,
  PendingIntent,
} from './state-machine.ts';
import {MAX_LIVE_GOALS, TERMINAL_STATUSES} from './state-machine.ts';
import {
  hasPendingCompletion,
  noGoalResponse,
  remainingTokens,
  serializeToolResponse,
  type ThreadGoal,
  type ToolSessionContext,
  toThreadGoal,
  toThreadGoalFromResult,
} from './tools-serialize.ts';

const MAX_OBJECTIVE_LENGTH = 4000;

export async function handleGetGoal(
  session: ToolSessionContext,
): Promise<string> {
  const machine = session.getMachine();
  if (!machine) {
    return serializeToolResponse(noGoalResponse());
  }
  const goal = machine.snapshot();
  return serializeToolResponse({
    goal: toThreadGoal(goal, session.sessionID),
    remainingTokens: remainingTokens(goal),
    completionBudgetReport: null,
    pendingCompletion: hasPendingCompletion(session, goal),
  });
}

/**
 * Creates a new goal. Fails if an unfinished goal already exists.
 */
export async function handleCreateGoal(
  session: ToolSessionContext,
  args: {
    objective: string;
    token_budget?: number;
    artifact_pointers?: string[];
    pointers?: string[];
  },
): Promise<string> {
  const objective =
    typeof args.objective === 'string' ? args.objective.trim() : '';
  if (!objective) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error: 'objective is required and must be a non-empty string',
    });
  }
  if (objective.length > MAX_OBJECTIVE_LENGTH) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error: `objective must be at most ${MAX_OBJECTIVE_LENGTH} characters`,
    });
  }

  let tokenBudget: number | null = null;
  if (args.token_budget !== undefined && args.token_budget !== null) {
    const parsed =
      typeof args.token_budget === 'number'
        ? args.token_budget
        : Number(args.token_budget);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return serializeToolResponse({
        ...noGoalResponse(),
        error: 'token_budget must be a positive integer',
      });
    }
    tokenBudget = parsed;
  }

  const rawPointers = args.artifact_pointers ?? args.pointers;
  const artifactPointers = Array.isArray(rawPointers)
    ? rawPointers.map(p => String(p).trim()).filter(Boolean)
    : undefined;

  // Terminal goals (such as complete or budgetLimited) do not block creation of a new goal.
  const activeGoals = session.listActiveGoals();
  const unfinishedGoals = activeGoals.filter(
    g => !TERMINAL_STATUSES.has(g.status),
  );
  if (unfinishedGoals.length > 0) {
    const existing = unfinishedGoals[unfinishedGoals.length - 1];
    return serializeToolResponse({
      goal: toThreadGoal(existing, session.sessionID),
      remainingTokens: remainingTokens(existing),
      completionBudgetReport: null,
      pendingCompletion: false,
      error:
        'cannot create a new goal because this thread has an unfinished goal; complete the existing goal first',
    });
  }

  if (activeGoals.length >= MAX_LIVE_GOALS) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error: `the plugin already tracks ${MAX_LIVE_GOALS} live goals; clear or complete one before creating another`,
    });
  }

  const machine = session.createGoal(objective, {
    tokenBudget,
    artifactPointers,
  });
  const goal = machine.snapshot();
  const persisted = await session.persist();
  if (!persisted) {
    try {
      await session.removeGoal(goal.goalId, 'create_goal-rollback');
      const rollbackPersisted = await session.persist();
      if (!rollbackPersisted) {
        return serializeToolResponse({
          ...noGoalResponse(),
          error:
            'goal creation failed and rollback could not be persisted; the in-memory goal was rolled back; check storage before retrying.',
        });
      }
    } catch {
      // Keep the original persistence error user-visible; the manager's WAL
      // rollback path remains authoritative when remove/persist also fails.
    }
    return serializeToolResponse({
      ...noGoalResponse(),
      error:
        'goal creation could not be persisted; the in-memory goal was rolled back. Retry create_goal or check storage.',
    });
  }

  return serializeToolResponse({
    goal: toThreadGoal(goal, session.sessionID),
    remainingTokens: remainingTokens(goal),
    completionBudgetReport: null,
    pendingCompletion: false,
  });
}

export interface ProposeGoalChangeArgs {
  objective?: string;
  success_criteria?: string;
  successCriteria?: string;
  constraints?: string;
  artifact_pointers?: string[];
  artifactPointers?: string[];
  reason: string;
  token_budget?: unknown;
  tokenBudget?: unknown;
  max_turns?: unknown;
  maxTurns?: unknown;
  max_tokens?: unknown;
  maxTokens?: unknown;
  max_duration_ms?: unknown;
  maxDurationMs?: unknown;
}

/**
 * Proposes term changes to the active goal.
 * Proposals do not self-execute; they land in pendingProposal and require human receipt.
 */
export async function handleProposeGoalChange(
  session: ToolSessionContext,
  args: ProposeGoalChangeArgs,
): Promise<string> {
  // Safety tiering check: agents cannot mutate or propose modifying contract-tier safety brakes mid-run.
  if (
    args.token_budget !== undefined ||
    args.tokenBudget !== undefined ||
    args.max_turns !== undefined ||
    args.maxTurns !== undefined ||
    args.max_tokens !== undefined ||
    args.maxTokens !== undefined ||
    args.max_duration_ms !== undefined ||
    args.maxDurationMs !== undefined
  ) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error:
        'Brakes (turn/token/duration/blocked ceilings) are contract-tier and cannot be modified by agent mid-run.',
    });
  }

  const machine = session.getMachine();
  if (!machine) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error:
        'no active goal exists for this thread; cannot propose term changes',
    });
  }

  const goal = machine.snapshot();
  if (TERMINAL_STATUSES.has(goal.status)) {
    return serializeToolResponse({
      goal: toThreadGoal(goal, session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: false,
      error: `goal is ${goal.status} (terminal); terms cannot be proposed`,
    });
  }

  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason) {
    return serializeToolResponse({
      goal: toThreadGoal(goal, session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: false,
      error:
        'reason is required and must be a non-empty string explaining why the terms should change',
    });
  }

  const objective =
    typeof args.objective === 'string' && args.objective.trim()
      ? args.objective.trim()
      : undefined;
  const successCriteria =
    typeof (args.success_criteria ?? args.successCriteria) === 'string'
      ? (args.success_criteria ?? args.successCriteria)!.trim()
      : undefined;
  const constraints =
    typeof args.constraints === 'string' ? args.constraints.trim() : undefined;
  const rawPointers = args.artifact_pointers ?? args.artifactPointers;
  const artifactPointers = Array.isArray(rawPointers)
    ? rawPointers.map(p => String(p).trim()).filter(Boolean)
    : undefined;

  if (
    !objective &&
    successCriteria === undefined &&
    constraints === undefined &&
    artifactPointers === undefined
  ) {
    return serializeToolResponse({
      goal: toThreadGoal(goal, session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: false,
      error:
        'At least one proposed term (objective, success_criteria, constraints, or artifact_pointers) must be specified.',
    });
  }

  const proposal: GoalProposal = {
    proposalId: crypto.randomUUID().slice(0, 8),
    proposedAt: Date.now(),
    objective,
    successCriteria,
    constraints,
    artifactPointers,
    reason,
  };

  const mutateResult = await machine.mutate(
    g => {
      g.pendingProposal = proposal;
      g.lastStatus = `Proposal pending [${proposal.proposalId}]: ${proposal.reason}`;
    },
    {
      source: 'propose_goal_change',
      detail: `Proposed term changes [${proposal.proposalId}]: ${proposal.reason}`,
    },
  );

  if (!mutateResult.ok) {
    return serializeToolResponse({
      goal: toThreadGoal(machine.snapshot(), session.sessionID),
      remainingTokens: remainingTokens(machine.snapshot()),
      completionBudgetReport: null,
      pendingCompletion: false,
      error: mutateResult.error || 'failed to record proposal',
    });
  }

  const proposalPersisted = await session.persist();

  return serializeToolResponse({
    goal: toThreadGoal(machine.snapshot(), session.sessionID),
    remainingTokens: remainingTokens(machine.snapshot()),
    completionBudgetReport: null,
    pendingCompletion: false,
    pendingProposal: proposal,
    // Inform the caller if durability failed (e.g. state file locked or over read ceiling),
    // since an unpersisted proposal exists only in memory and cannot be reviewed after restart.
    error: proposalPersisted
      ? undefined
      : session.isOwnedElsewhere?.()
        ? "the proposal was recorded in memory but could not be persisted; another process owns this session's file, so it may not survive a restart."
        : 'the proposal was recorded in memory but could not be persisted; the host log names the cause (the state file may be over the read ceiling or unreadable), so it may not survive a restart.',
    message: proposalPersisted
      ? `Proposal [${proposal.proposalId}] recorded and queued for human review. Run continues under existing terms until human receipt via /goal accept.`
      : `Proposal [${proposal.proposalId}] was NOT persisted — ${session.isOwnedElsewhere?.() ? "another process owns this session's file" : "this host could not write this session's file (see the host log for the cause)"}, so this proposal will not survive a restart and there is nothing for /goal accept to review.`,
  });
}

/**
 * Normalizes blocker text for token overlap comparison.
 */
function normalizeBlockedText(text: string | undefined): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

/**
 * Function words filtered out so comparison focuses on the actual obstacle.
 */
const BLOCKER_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'but',
  'not',
  'you',
  'all',
  'any',
  'can',
  'was',
  'one',
  'our',
  'out',
  'are',
  'has',
  'had',
  'that',
  'this',
  'with',
  'from',
  'they',
  'will',
  'would',
  'there',
  'their',
  'what',
  'been',
  'were',
  'its',
  'into',
  'then',
  'than',
  'now',
  'still',
  'again',
  'just',
  'only',
  'also',
  'very',
  'too',
  'does',
  'did',
  'done',
  'being',
  'cannot',
  'could',
  'should',
  'must',
  'may',
  'might',
  'shall',
  'have',
  'need',
  'needs',
  'get',
  'got',
  'without',
]);

/** Extracts significant words from a blocker statement. */
function blockerTokens(text: string): Set<string> {
  return new Set(
    normalizeBlockedText(text)
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2 && !BLOCKER_STOPWORDS.has(w)),
  );
}

/**
 * Determines whether two blocker statements refer to the same obstacle.
 * Uses a token overlap threshold of 0.4.
 *
 * Known limitation: different obstacles that share substantial phrasing
 * (e.g. "TEST environment has no network" vs "PRODUCTION environment has no network")
 * may score above the threshold. This errs on the safe side, terminating earlier rather
 * than hanging indefinitely.
 */
function isSameBlocker(previousText: string, currentText: string): boolean {
  const a = blockerTokens(previousText);
  const b = blockerTokens(currentText);
  if (a.size === 0 || b.size === 0) {
    return a.size === 0 && b.size === 0;
  }
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return shared / union >= 0.4;
}

/**
 * Marks a goal complete or blocked.
 *
 * - complete: Uses a step barrier — records a PendingIntent and returns
 *   "completion pending". The continuation loop applies the terminal state
 *   after step-finish, preventing premature completion claims before work is verified.
 * - blocked: Applies immediately once the consecutive-blocked threshold is met.
 */
export async function handleUpdateGoal(
  session: ToolSessionContext,
  args: {status: 'complete' | 'blocked'},
): Promise<string> {
  const status = String(args.status || '')
    .trim()
    .toLowerCase() as 'complete' | 'blocked';
  if (status !== 'complete' && status !== 'blocked') {
    return serializeToolResponse({
      ...noGoalResponse(),
      error:
        'update_goal can only mark the existing goal complete or blocked; ' +
        'pause/resume are driven through the goal-command tool, and the token budget/usage limit is ' +
        'fixed at goal creation and cannot be changed afterward',
    });
  }

  const machine = session.getMachine();
  if (!machine) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error: 'no active goal exists for this thread',
    });
  }

  const goal = machine.snapshot();

  if (TERMINAL_STATUSES.has(goal.status)) {
    return serializeToolResponse({
      goal: toThreadGoal(goal, session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: false,
      error: `goal is ${goal.status} (terminal); it cannot be marked complete or blocked`,
    });
  }

  if (status === 'complete') {
    if (
      goal.status !== 'active' &&
      goal.status !== 'blocked' &&
      goal.status !== 'paused' &&
      !goal.finalizing
    ) {
      return serializeToolResponse({
        goal: toThreadGoal(goal, session.sessionID),
        remainingTokens: remainingTokens(goal),
        completionBudgetReport: null,
        pendingCompletion: false,
        error: `goal is ${goal.status}; complete can only be called on an active, paused, or blocked goal.`,
      });
    }
    const existingIntent = session.getPendingIntent(goal.goalId);
    if (
      existingIntent &&
      existingIntent.goalId === goal.goalId &&
      existingIntent.runId === goal.runId &&
      existingIntent.revision >= goal.revision &&
      existingIntent.targetStatus !== 'complete'
    ) {
      return serializeToolResponse({
        goal: toThreadGoal(goal, session.sessionID),
        remainingTokens: remainingTokens(goal),
        completionBudgetReport: null,
        pendingCompletion: false,
        error: `conflicting ${existingIntent.targetStatus} intent is already pending for this goal; it must be resolved before requesting completion`,
      });
    }
    if (
      existingIntent &&
      existingIntent.goalId === goal.goalId &&
      existingIntent.runId === goal.runId &&
      existingIntent.revision >= goal.revision &&
      existingIntent.targetStatus === 'complete'
    ) {
      return serializeToolResponse({
        goal: toThreadGoal(goal, session.sessionID),
        remainingTokens: remainingTokens(goal),
        completionBudgetReport: null,
        pendingCompletion: true,
        error:
          'a completion is already pending for this goal; it will be applied when the current step finishes',
      });
    }

    const intent: PendingIntent = {
      goalId: goal.goalId,
      revision: goal.revision,
      runId: goal.runId,
      messageID: '',
      toolCallID: '',
      targetStatus: 'complete',
      evidence: '',
      createdAt: Date.now(),
    };
    session.setPendingIntent(goal.goalId, intent);
    // Persist the intent before returning so the completion claim survives crashes before step settlement.
    const intentPersisted = await session.persist();

    return serializeToolResponse({
      goal: toThreadGoal(goal, session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: true,
      error: intentPersisted
        ? undefined
        : session.isOwnedElsewhere?.()
          ? "the completion claim was recorded in memory but could not be persisted; another process owns this session's file, so it may not survive a restart."
          : 'the completion claim was recorded in memory but could not be persisted; the host log names the cause (the state file may be over the read ceiling or unreadable), so it may not survive a restart.',
    });
  }

  // Prioritize and report any live completion intent over an incoming blocked request.
  if (goal.status === 'blocked') {
    const liveIntent = session.getPendingIntent(goal.goalId);
    const completionPending =
      liveIntent !== null &&
      liveIntent.goalId === goal.goalId &&
      liveIntent.runId === goal.runId &&
      liveIntent.targetStatus === 'complete';
    return serializeToolResponse({
      goal: toThreadGoal(goal, session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: completionPending,
      ...(completionPending
        ? {
            error:
              'a completion is already pending for this goal; it will be applied when the current step finishes, and the blocked request is ignored while it stands',
          }
        : {}),
    });
  }
  if (goal.status === 'finalizing') {
    return serializeToolResponse({
      goal: toThreadGoal(goal, session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: false,
      error:
        'goal is finalizing; it cannot be marked blocked until the current step finishes',
    });
  }

  // Block transition cannot supersede a live completion intent on the current run.
  const existingCompletionIntent = session.getPendingIntent(goal.goalId);
  if (
    existingCompletionIntent &&
    existingCompletionIntent.goalId === goal.goalId &&
    existingCompletionIntent.runId === goal.runId &&
    existingCompletionIntent.targetStatus === 'complete' &&
    existingCompletionIntent.revision >= goal.revision
  ) {
    return serializeToolResponse({
      goal: toThreadGoal(goal, session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: true,
      error:
        'a completion intent is already pending for this goal; it must be resolved before requesting a blocked transition',
    });
  }

  // Enforce the consecutive-blocked rule: the identical blocker statement must recur
  // `maxBlockedTurns` times. Changing blockers resets the streak counter.
  const blockerText = normalizeBlockedText(goal.lastAssistantText);
  const priorText = goal.lastBlockedAttemptText ?? '';
  const sameBlocker =
    goal.blockedTurns > 0 && isSameBlocker(priorText, blockerText);
  const streak = sameBlocker ? goal.blockedTurns + 1 : 1;
  const nextBlockedTurns = streak;
  if (nextBlockedTurns < goal.maxBlockedTurns) {
    await machine.mutate(
      g => {
        g.blockedTurns = nextBlockedTurns;
        g.blockedAssertedThisTurn = true;
        g.lastBlockedAttemptText = blockerText;
      },
      {
        source: 'update_goal',
        detail: `blocked attempt ${nextBlockedTurns}/${goal.maxBlockedTurns}; continuing`,
        skipPersist: true,
      },
    );
    return serializeToolResponse({
      goal: toThreadGoal(machine.snapshot(), session.sessionID),
      remainingTokens: remainingTokens(goal),
      completionBudgetReport: null,
      pendingCompletion: false,
      error:
        `The same blocker must recur ${goal.maxBlockedTurns} consecutive times ` +
        `before this goal can be marked blocked (attempt ${nextBlockedTurns}/${goal.maxBlockedTurns}). ` +
        'Continue working on the next admissible action. If you are genuinely blocked, ' +
        're-state the blocker and call update_goal(blocked) again on your next turn.',
    });
  }
  // Threshold reached: reset streak and queue blocked transition intent.
  await machine.mutate(
    g => {
      g.blockedTurns = 0;
      g.lastBlockedAttemptText = '';
    },
    {
      source: 'update_goal',
      detail: 'blocked threshold met; accepting blocked intent',
      skipPersist: true,
    },
  );
  const blockedGoal = machine.snapshot();
  const blockIntent: PendingIntent = {
    goalId: blockedGoal.goalId,
    runId: blockedGoal.runId,
    revision: blockedGoal.revision,
    messageID: '',
    toolCallID: '',
    targetStatus: 'blocked',
    evidence: '',
    createdAt: Date.now(),
  };
  session.setPendingIntent(machine.snapshot().goalId, blockIntent);
  const blockedPersisted = await session.persist();

  return serializeToolResponse({
    goal: toThreadGoal(blockedGoal, session.sessionID),
    remainingTokens: remainingTokens(blockedGoal),
    completionBudgetReport: null,
    pendingCompletion: true,
    error: blockedPersisted
      ? undefined
      : session.isOwnedElsewhere?.()
        ? "the blocked claim was recorded in memory but could not be persisted; another process owns this session's file, so it may not survive a restart."
        : 'the blocked claim was recorded in memory but could not be persisted; the host log names the cause (the state file may be over the read ceiling or unreadable), so it may not survive a restart.',
  });
}

/**
 * Lists all goals (active and archived) for the current session.
 */
export async function handleListGoals(
  session: ToolSessionContext,
): Promise<string> {
  const activeGoals = session.listActiveGoals();
  const archived = session.listArchivedResults();
  const focusedMachine = session.getMachine();
  const focusedId = focusedMachine?.snapshot().goalId ?? null;

  if (activeGoals.length === 0 && archived.length === 0) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error: 'no goals exist for this thread; create one with create_goal',
    });
  }

  const goals: ThreadGoal[] = activeGoals.map(g =>
    toThreadGoal(g, session.sessionID),
  );

  const archivedGoals: ThreadGoal[] = archived.map(r =>
    toThreadGoalFromResult(r, session.sessionID),
  );

  return JSON.stringify({
    goals,
    archived: archivedGoals,
    focusedGoalId: focusedId,
    pendingCompletion: focusedMachine
      ? hasPendingCompletion(session, focusedMachine.snapshot())
      : false,
  });
}

/**
 * Switches focus to a different active goal by its goal ID.
 */
export async function handleFocusGoal(
  session: ToolSessionContext,
  args: {goal_id: string},
): Promise<string> {
  const goalId = typeof args.goal_id === 'string' ? args.goal_id.trim() : '';
  if (!goalId) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error: 'goal_id is required and must be a non-empty string',
    });
  }

  const archived = session.listArchivedResults();
  if (archived.some(r => r.goalId === goalId)) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error:
        'cannot focus an archived (completed/blocked) goal; create a new goal instead',
    });
  }

  // Guard against focusing terminal goals still listed under active (e.g. budgetLimited).
  const activeGoals = session.listActiveGoals();
  const terminalGoal = activeGoals.find(g => g.goalId === goalId);
  if (terminalGoal && TERMINAL_STATUSES.has(terminalGoal.status)) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error: `goal is ${terminalGoal.status} (terminal) and cannot be focused; create a new goal instead`,
    });
  }

  // Pending-intent barrier: focus cannot switch while a completion or blocked transition is settling.
  const allIntents = session.getAllPendingIntents();
  const pendingIntent = allIntents.length > 0 ? allIntents[0]! : null;
  if (pendingIntent) {
    const intentGoalId = pendingIntent.goalId;
    const sameGoal = intentGoalId === goalId;
    const kind =
      pendingIntent.targetStatus === 'blocked'
        ? 'blocked transition'
        : 'completion';
    return serializeToolResponse({
      ...noGoalResponse(),
      error: sameGoal
        ? `this goal has a pending ${kind} that will be applied when the current step finishes; focus cannot change it now`
        : `a different goal (${intentGoalId}) has a pending ${kind} that will be applied when the current step finishes; focusing away from it would discard that ${kind}. Wait for the current step to finish before switching focus.`,
    });
  }

  let focused: FocusResult;
  try {
    focused = await session.focusGoal(goalId);
  } catch (err) {
    return serializeToolResponse({
      ...noGoalResponse(),
      error: `failed to focus goal: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!focused.ok) {
    const detail =
      focused.reason === 'not-found'
        ? `no goal with id "${goalId}" exists for this thread`
        : focused.reason === 'terminal'
          ? `goal "${goalId}" is already finished, so it cannot be focused; it is visible in the archived list`
          : 'no active goal session for this thread';
    return serializeToolResponse({...noGoalResponse(), error: detail});
  }
  const machine = focused.machine;

  const goal = machine.snapshot();
  const focusPersisted = await session.persist();

  return serializeToolResponse({
    goal: toThreadGoal(goal, session.sessionID),
    remainingTokens: remainingTokens(goal),
    completionBudgetReport: null,
    pendingCompletion: hasPendingCompletion(session, goal),
    error: focusPersisted
      ? undefined
      : 'focus could not be persisted; the in-memory state was updated but may not survive a restart.',
  });
}

export interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: {sessionID: string},
  ) => Promise<string>;
}

/**
 * Creates definitions for the six canonical goal tools.
 * Schemas are dynamically loaded via zod; if zod is unavailable, registration is skipped.
 */
export async function createGoalToolDefinitions(
  getSessionContext: (sessionID: string) => ToolSessionContext | undefined,
): Promise<Record<string, ToolDefinition> | null> {
  const z = await loadZod();
  if (!z) return null;

  const getGoalTool: ToolDefinition = {
    description:
      'Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.',
    args: {},
    execute: async (_args, ctx) => {
      const session = getSessionContext(ctx.sessionID);
      if (!session)
        return serializeToolResponse({
          ...noGoalResponse(),
          error: 'no session context available',
        });
      return handleGetGoal(session);
    },
  };

  const createGoalTool: ToolDefinition = {
    description:
      'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\n' +
      'Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.',
    args: {
      objective: z
        .string()
        .describe(
          'Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.',
        ),
      token_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Positive token budget for the new goal. Omit unless explicitly requested.',
        ),
    },
    execute: async (args, ctx) => {
      const session = getSessionContext(ctx.sessionID);
      if (!session)
        return serializeToolResponse({
          ...noGoalResponse(),
          error: 'no session context available',
        });
      return handleCreateGoal(
        session,
        args as {objective: string; token_budget?: number},
      );
    },
  };

  const updateGoalTool: ToolDefinition = {
    description:
      'Update the existing goal.\n' +
      'Use this tool only to mark the goal achieved or genuinely blocked.\n' +
      'Set status to `complete` only when the objective has actually been achieved and no required work remains.\n' +
      'Set status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, ' +
      'counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.\n' +
      'If the user resumes a goal that was previously marked `blocked`, the blocked threshold starts again from zero. ' +
      'If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.\n' +
      'Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.\n' +
      'Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\n' +
      'Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\n' +
      'You cannot use this tool to pause or resume a goal; those lifecycle changes are driven through ' +
      'the `goal-command` tool (user-invoked from the TUI palette), not through update_goal. ' +
      'The token budget / usage limit is fixed at goal creation and cannot be changed afterward.\n' +
      'When marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.',
    args: {
      status: z
        .enum(['complete', 'blocked'])
        .describe(
          'Required. Set to `complete` only when the objective is achieved and no required work remains. ' +
            'Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. ' +
            'After a previously blocked goal is resumed, the blocked threshold starts again from zero.',
        ),
    },
    execute: async (args, ctx) => {
      const session = getSessionContext(ctx.sessionID);
      if (!session)
        return serializeToolResponse({
          ...noGoalResponse(),
          error: 'no session context available',
        });
      return handleUpdateGoal(
        session,
        args as {status: 'complete' | 'blocked'},
      );
    },
  };

  const listGoalsTool: ToolDefinition = {
    description:
      'List all goals for this thread, including active goals and archived (completed/blocked) results. ' +
      'Use this to see what goals exist and which is currently focused.',
    args: {},
    execute: async (_args, ctx) => {
      const session = getSessionContext(ctx.sessionID);
      if (!session)
        return serializeToolResponse({
          ...noGoalResponse(),
          error: 'no session context available',
        });
      return handleListGoals(session);
    },
  };

  const focusGoalTool: ToolDefinition = {
    description:
      'Switch focus to a different active goal by its goal_id. ' +
      'Use this to work on a different goal when multiple goals exist. ' +
      'Cannot focus archived (completed/blocked) goals.',
    args: {
      goal_id: z
        .string()
        .describe(
          'The goal_id of the goal to focus, as returned by list_goals or get_goal.',
        ),
    },
    execute: async (args, ctx) => {
      const session = getSessionContext(ctx.sessionID);
      if (!session)
        return serializeToolResponse({
          ...noGoalResponse(),
          error: 'no session context available',
        });
      return handleFocusGoal(session, args as {goal_id: string});
    },
  };

  const proposeGoalChangeTool: ToolDefinition = {
    description:
      'Propose term changes (objective, success criteria, constraints, or artifact pointers) to the active goal.\n' +
      'Proposals do NOT self-execute; they are queued in a pending state and take effect ONLY upon human receipt/approval.\n' +
      'Brakes (token budget, turn/token/duration ceilings) cannot be modified mid-run.\n' +
      'The run continues under existing terms until the user accepts the proposal via /goal accept.',
    args: {
      reason: z
        .string()
        .describe('Required. Explanation of why the terms should be updated.'),
      objective: z.string().optional().describe('Proposed new objective text.'),
      success_criteria: z
        .string()
        .optional()
        .describe('Proposed new success criteria.'),
      constraints: z.string().optional().describe('Proposed new constraints.'),
      artifact_pointers: z
        .array(z.string())
        .optional()
        .describe('Proposed new artifact pointers to living files.'),
    },
    execute: async (args, ctx) => {
      const session = getSessionContext(ctx.sessionID);
      if (!session)
        return serializeToolResponse({
          ...noGoalResponse(),
          error: 'no session context available',
        });
      return handleProposeGoalChange(
        session,
        args as unknown as ProposeGoalChangeArgs,
      );
    },
  };

  return {
    get_goal: getGoalTool,
    create_goal: createGoalTool,
    update_goal: updateGoalTool,
    propose_goal_change: proposeGoalChangeTool,
    list_goals: listGoalsTool,
    focus_goal: focusGoalTool,
  };
}

async function loadZod(): Promise<typeof import('zod') | null> {
  try {
    return await import('zod');
  } catch {
    return null;
  }
}

// Re-export wire formats and serialization helpers for external callers.
export {
  noGoalResponse,
  hasPendingCompletion,
  threadStatusFor,
  remainingTokens,
  toThreadGoal,
  toThreadGoalFromResult,
  serializeToolResponse,
} from './tools-serialize.ts';
export type {
  ThreadGoalStatus,
  ThreadGoal,
  GoalToolResponse,
  CreateGoalOptions,
  ToolSessionContext,
} from './tools-serialize.ts';
