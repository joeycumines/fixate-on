import {buildContinueMessage} from './steering.ts';
import type {ContinuationDecision} from './continuation-loop.ts';
import type {HookDeps, SessionContext} from './hooks-types.ts';
import type {
  GoalState,
  GoalStateMachine,
  MutationOptions,
} from './state-machine.ts';
import {createGoalWorkScope} from './hooks-work-scope.ts';
import {isDeferError, isSessionGoneError} from './hooks-errors.ts';
import {acquirePromptInFlight} from './session-runtime.ts';
import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';

// Snapshot spread preserves this private token across mutation rollback;
// JSON persistence omits it. A restarted process cannot own an old prompt.
const PROMPT_OWNER = Symbol('continuation prompt owner');
const PROMPT_EPOCH = Symbol('continuation control epoch');
const deferralEpochs = new WeakMap<GoalStateMachine, number>();

/** Prepare and account for one continuation without crossing a newer command. */
export async function executeContinuation(
  decision: Extract<ContinuationDecision, {type: 'continue'}>,
  sessionID: string,
  session: SessionContext,
  machine: GoalStateMachine,
  deps: HookDeps,
  opts: {repetitionWarning?: boolean; inheritedAgent?: string},
): Promise<void> {
  const goal = machine.snapshot();
  if (goal.status !== 'active' && !goal.finalizing) return;
  const scope = createGoalWorkScope(sessionID, session, machine, deps);
  const controlEpoch = machine.currentControlEpoch;
  const runtime = deps.runtime;
  const sourceAssistantMessageID =
    goal.lastAssistantMessageID || '<no-assistant>';
  if (
    runtime &&
    goal.continuationClaim?.runId === goal.runId &&
    goal.continuationClaim.sourceAssistantMessageID ===
      sourceAssistantMessageID &&
    ((goal.continuationClaim as {[PROMPT_EPOCH]?: number})[PROMPT_EPOCH] ??
      0) === controlEpoch
  )
    return;

  // The private token owns only this prompt's finalizing flag. A transition
  // clears the claim; another continuation gets a distinct token even if the
  // host reuses its last assistant ID. Semantic agent bookkeeping and rejected
  // mutations may copy the claim without transferring ownership of the flag.
  const owner = Symbol();
  const claim = {
    runId: goal.runId,
    sourceAssistantMessageID,
    [PROMPT_OWNER]: owner,
    [PROMPT_EPOCH]: controlEpoch,
  };
  const ownsPrompt = (current: Readonly<GoalState> = machine.snapshot()) =>
    scope.ownsMachine() &&
    machine.currentControlEpoch === controlEpoch &&
    current.runId === goal.runId &&
    current.status === goal.status &&
    (current.continuationClaim as typeof claim | null)?.[PROMPT_OWNER] ===
      owner;
  const installed = await machine.mutate(
    g => {
      g.continuationClaim = claim;
    },
    {
      source: 'idle-handler',
      detail: 'Set continuation claim',
      skipPersist: true,
      guard: scope.current,
    },
  );
  if (!installed.ok || !ownsPrompt()) return;

  // Agent bookkeeping may settle while persistence is awaited. It neither
  // transfers this attempt's owner nor changes the user's control boundary.
  // A revision-only recheck here could strand an undispatched claim forever.
  const prepare = async (
    fn: (goal: GoalState) => void,
    options: MutationOptions,
  ): Promise<boolean> => {
    const result = await machine.mutate(fn, {
      ...options,
      guard: current =>
        ownsPrompt(current) && (options.guard?.(current) ?? true),
    });
    return result.ok && ownsPrompt();
  };

  if (
    !(await prepare(
      g => {
        g.turnCount += 1;
        g.lastContinueAt = Date.now();
        if (!g.blockedAssertedThisTurn) g.blockedTurns = 0;
        g.blockedAssertedThisTurn = false;
        if (!decision.budgetWrapup && !decision.budgetLimit)
          g.lastStatus = `Continuing after assistant turn ${g.turnCount}.`;
      },
      {source: 'idle-handler', detail: 'Incremented turn count'},
    ))
  )
    return;

  if (decision.budgetLimit || decision.budgetWrapup) {
    if (
      !(await prepare(
        g => {
          g.finalizing = true;
          if (decision.budgetLimit) {
            g.budgetLimitReported = true;
            g.stopReason = 'budget exhausted';
          } else {
            g.budgetWrapupSent = true;
            g.stopReason = 'budget wrap-up requested';
          }
        },
        {source: 'idle-handler', detail: 'Set finalizing state'},
      ))
    )
      return;
  }

  const message = buildContinueMessage(machine.snapshot(), {
    budgetLimit: decision.budgetLimit,
    budgetWrapup: decision.budgetWrapup,
    repetitionWarning: opts.repetitionWarning,
    warnTurnsRemaining: deps.warnTurnsRemaining,
    warnDurationMsRemaining: deps.warnDurationMsRemaining,
    warnTokensRemaining: deps.warnTokensRemaining,
  });
  if (
    !(await prepare(
      g => {
        g.pendingNotices = [];
        g.objectiveUpdatedPending = false;
      },
      {
        source: 'idle-handler',
        detail: 'Prepared continuation notices and objective update',
        skipRevision: true,
        skipPersist: true,
      },
    ))
  )
    return;

  let response: {error?: {name?: string; message?: string}} = {};
  let promptDeferred = false;
  const releasePrompt = acquirePromptInFlight(runtime, sessionID);
  try {
    const promptInput: {parts: unknown[]} & Record<string, unknown> = {
      parts: [
        {
          type: 'text',
          text: message,
          metadata: {[GOAL_TUI_METADATA_KEY]: {kind: 'continuation'}},
          synthetic: true,
        },
      ],
    };
    if (opts.inheritedAgent) promptInput.agent = opts.inheritedAgent;
    response =
      (await deps.sessionApi.promptAsync(sessionID, promptInput)) ?? {};
    promptDeferred = isDeferError(response.error);
  } catch (error) {
    const detail = {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    };
    promptDeferred = isDeferError(detail);
    response = {error: detail};
  } finally {
    releasePrompt();
    if (machine.state.finalizing) {
      await machine.mutate(
        g => {
          g.finalizing = false;
          // Failed envelopes and busy deferrals did not admit the advisory
          // wrap-up either. Leave it eligible for the next bounded attempt.
          if (response.error && decision.budgetWrapup) {
            g.budgetWrapupSent = false;
            if (g.stopReason === 'budget wrap-up requested') g.stopReason = '';
          }
        },
        {
          source: 'idle-handler',
          detail: 'Cleared finalizing',
          guard: current =>
            scope.ownsMachine() &&
            current.runId === goal.runId &&
            (current.continuationClaim as typeof claim | null)?.[
              PROMPT_OWNER
            ] === owner &&
            current.finalizing,
          // Prompt settlement is bookkeeping. A completion intent created by
          // that prompt must keep the revision it captured while executing.
          skipRevision: true,
          skipPersist: true,
        },
      );
    }
  }
  if (!ownsPrompt()) return;

  const deferKey = `${sessionID}:${goal.goalId}`;
  const maxFailures = deps.defaultOpts?.maxPromptFailures ?? 3;
  let lastRevision: number | undefined;
  let pauseReason: string | undefined;
  let pauseDetail: string | undefined;
  if (promptDeferred) {
    const deferrals =
      (deferralEpochs.get(machine) === controlEpoch
        ? (runtime?.deferCounts.get(deferKey) ?? 0)
        : 0) + 1;
    const exhausted = deferrals >= maxFailures;
    const recorded = await machine.mutate(
      g => {
        g.turnCount = Math.max(0, g.turnCount - 1);
        deferralEpochs.set(machine, controlEpoch);
        if (exhausted) {
          runtime?.deferCounts.delete(deferKey);
          g.promptFailures = maxFailures;
          g.lastStatus = `Deferred ${deferrals}x (host busy); paused.`;
        } else {
          runtime?.deferCounts.set(deferKey, deferrals);
          g.lastStatus = `Deferred (${deferrals}): host busy; will retry next idle.`;
        }
      },
      {
        source: 'idle-handler',
        detail: exhausted
          ? 'Continuation deferred past bound'
          : 'Continuation deferred (session busy)',
        skipRevision: true,
        skipPersist: true,
        guard: ownsPrompt,
      },
    );
    if (!recorded.ok) return;
    lastRevision = recorded.revision;
    if (exhausted) {
      pauseReason = 'deferred too many times';
      pauseDetail = `Paused after ${deferrals} consecutive busy-deferrals.`;
    }
  } else if (response.error) {
    const sessionGone = isSessionGoneError(response.error);
    let failures = 0;
    const recorded = await machine.mutate(
      g => {
        runtime?.deferCounts.delete(deferKey);
        deferralEpochs.delete(machine);
        failures = ++g.promptFailures;
        const name = response.error?.name || 'unknown error';
        const message = response.error?.message;
        g.lastStatus = sessionGone
          ? "Auto-continue failed: the goal's session no longer exists (session not found)."
          : message
            ? `Auto-continue failed: ${name}: ${String(message).slice(0, 300)}`
            : `Auto-continue failed: ${name}`;
        if (g.promptFailures >= maxFailures) {
          g.lastStatus = sessionGone
            ? `The goal's session no longer exists; paused after ${g.promptFailures} failure(s).`
            : `Auto-continue failed; paused after ${g.promptFailures} failure(s).`;
        }
      },
      {
        source: 'idle-handler',
        detail: 'Prompt failure',
        skipRevision: true,
        skipPersist: true,
        guard: ownsPrompt,
      },
    );
    if (!recorded.ok) return;
    lastRevision = recorded.revision;
    if (failures >= maxFailures) {
      pauseReason = sessionGone
        ? 'session not found'
        : 'auto-continue failures';
      pauseDetail = sessionGone
        ? `Paused after ${failures} consecutive prompt failures: the goal's owning session no longer exists.`
        : `Paused after ${failures} consecutive prompt failures.`;
    }
  } else {
    const recorded = await machine.mutate(
      g => {
        runtime?.deferCounts.delete(deferKey);
        deferralEpochs.delete(machine);
        g.promptFailures = 0;
      },
      {
        source: 'idle-handler',
        detail: 'Prompt succeeded, reset failure count',
        skipRevision: true,
        skipPersist: true,
        guard: ownsPrompt,
      },
    );
    if (!recorded.ok) return;
    lastRevision = recorded.revision;
  }
  // Keep the private owner until the terminal decision is committed. An agent
  // proposal may update the revision, but cannot evade this attempt's failure
  // bound; a newer user command, transition, or prompt supersedes its owner.
  if (pauseReason) {
    const paused = await machine.transition('paused', {
      source: 'idle-handler',
      stopReason: pauseReason,
      detail: pauseDetail,
      guard: ownsPrompt,
    });
    if (!paused.ok) return;
    lastRevision = paused.revision;
  } else if (response.error) {
    const cleared = await machine.mutate(
      g => {
        g.continuationClaim = null;
      },
      {
        source: 'idle-handler',
        detail: 'Released failed continuation for a bounded retry',
        skipRevision: true,
        skipPersist: true,
        guard: ownsPrompt,
      },
    );
    if (!cleared.ok) return;
    lastRevision = cleared.revision;
  }
  if (scope.ownsMachine() && machine.currentRevision === lastRevision)
    await session.persist();
}
