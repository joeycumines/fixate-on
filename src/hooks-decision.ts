/**
 * Continuation decision executor (`executeDecision`) and recovery prompt sender (`sendRecoveryPrompt`).
 *
 * Both functions are placed in this module to maintain a directed acyclic dependency graph:
 * `executeDecision` calls `sendRecoveryPrompt`, and idle lifecycle handlers import this module.
 */

import type {GoalStateMachine} from './state-machine.ts';
import type {ContinuationDecision, IdleContext} from './continuation-loop.ts';
import {validatePendingIntent} from './continuation-loop.ts';
import type {HookDeps, SessionContext} from './hooks-types.ts';
import {isDeferError, isSessionGoneError} from './hooks-errors.ts';
import {scanPrematureExit} from './stop-guard.ts';
import {runCompletionGate} from './completion-gate-run.ts';
import {buildContinueMessage, renderStopLimit} from './steering.ts';
import {
  normalizeInheritedAgentForPrompt,
  stripAgentListSortPrefix,
} from './agent-resolve.ts';
import {summarizeText} from './child-session-verifier.ts';
import {
  buildRecoveryPrompt,
  type CompletionVerdict,
  type RecoveryState,
} from './completion-gate.ts';
import {determinePressureRung} from './recovery-pressure.ts';
import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';

export async function executeDecision(
  decision: ContinuationDecision,
  sessionID: string,
  session: SessionContext,
  machine: GoalStateMachine,
  deps: HookDeps,
  opts: {repetitionWarning?: boolean; inheritedAgent?: string} = {},
): Promise<void> {
  const {sessionApi} = deps;

  switch (decision.type) {
    case 'continue': {
      const goal = machine.snapshot();
      const runtime = deps.runtime;

      if (runtime) {
        const sourceAssistantMessageID =
          goal.lastAssistantMessageID || '<no-assistant>';
        if (
          goal.continuationClaim?.runId === goal.runId &&
          goal.continuationClaim?.sourceAssistantMessageID ===
            sourceAssistantMessageID
        ) {
          return;
        }
        await machine.mutate(
          g => {
            g.continuationClaim = {runId: g.runId, sourceAssistantMessageID};
          },
          {
            source: 'idle-handler',
            detail: 'Set continuation claim',
            skipPersist: true,
          },
        );
      }

      await machine.mutate(
        g => {
          g.turnCount += 1;
          g.lastContinueAt = Date.now();
          // Preserve the blocked streak if the agent asserted blocked this turn;
          // otherwise a normal continuation resets it. Without this guard, the
          // consecutive-blocked count cannot accrue across idle boundaries when
          // below the transition threshold.
          if (!g.blockedAssertedThisTurn) {
            g.blockedTurns = 0;
          }
          g.blockedAssertedThisTurn = false;
          if (!decision.budgetWrapup && !decision.budgetLimit) {
            g.lastStatus = `Continuing after assistant turn ${g.turnCount}.`;
          }
        },
        {source: 'idle-handler', detail: 'Incremented turn count'},
      );

      if (decision.budgetLimit || decision.budgetWrapup) {
        await machine.mutate(
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
        );
      }

      let message: string = buildContinueMessage(machine.snapshot(), {
        budgetLimit: decision.budgetLimit,
        budgetWrapup: decision.budgetWrapup,
        repetitionWarning: opts.repetitionWarning,
        warnTurnsRemaining: deps.warnTurnsRemaining,
        warnDurationMsRemaining: deps.warnDurationMsRemaining,
        warnTokensRemaining: deps.warnTokensRemaining,
      });
      await machine.clearNotices();
      if (machine.snapshot().objectiveUpdatedPending) {
        await machine.mutate(
          g => {
            g.objectiveUpdatedPending = false;
          },
          {source: 'idle-handler', detail: 'Cleared objective updated pending'},
        );
      }

      if (machine.state.status !== 'active' && !machine.state.finalizing) {
        await machine.mutate(
          g => {
            g.continuationClaim = null;
            g.finalizing = false;
          },
          {
            source: 'idle-handler',
            detail: 'Goal paused during continuation prep',
            skipPersist: true,
          },
        );
        await session.persist();
        return;
      }

      if (runtime) runtime.promptInFlightSessions.add(sessionID);
      // Ensure message is a string to satisfy the host's Effect Schema validation.
      if (typeof message !== 'string') {
        message = String(message ?? '');
      }
      let response: {error?: {name?: string; message?: string}};
      let promptFailed = false;
      let promptDeferred = false;
      try {
        const promptInput: Record<string, unknown> = {
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
          (await sessionApi.promptAsync(
            sessionID,
            promptInput as unknown as {
              parts: unknown[];
            } & Record<string, unknown>,
          )) ?? {};
        if (
          response.error &&
          isDeferError(response.error as {name?: string; message?: string})
        ) {
          promptDeferred = true;
        }
      } catch (error) {
        const errObj = {
          name: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        };
        if (isDeferError(errObj)) {
          promptDeferred = true;
          response = {};
        } else {
          promptFailed = true;
          response = {error: errObj};
        }
      } finally {
        runtime?.promptInFlightSessions.delete(sessionID);
        await machine.mutate(
          g => {
            g.finalizing = false;
            // If the budget wrap-up prompt failed to reach the host, roll back
            // budgetWrapupSent so the advisory prompt can be retried on a subsequent idle.
            // In contrast, budgetLimit is terminal and is intentionally left reported.
            if (promptFailed && decision.budgetWrapup) {
              g.budgetWrapupSent = false;
              if (g.stopReason === 'budget wrap-up requested')
                g.stopReason = '';
            }
          },
          {
            source: 'idle-handler',
            detail: 'Cleared finalizing',
            skipPersist: true,
          },
        );
      }

      if (promptDeferred) {
        // When the session is busy, defer execution and keep the goal active.
        // Deferrals are bounded by maxPromptFailures to prevent infinite loops,
        // do not consume turn budget, and are reported in lastStatus.
        const deferKey = `${sessionID}:${machine.snapshot().goalId}`;
        const deferrals = (runtime?.deferCounts.get(deferKey) ?? 0) + 1;
        const maxFailures = deps.defaultOpts?.maxPromptFailures ?? 3;
        if (deferrals >= maxFailures) {
          runtime?.deferCounts.delete(deferKey);
          await machine.mutate(
            g => {
              g.continuationClaim = null;
              g.turnCount = Math.max(0, g.turnCount - 1);
              g.promptFailures = maxFailures;
              g.lastStatus = `Deferred ${deferrals}x (host busy); paused.`;
            },
            {
              source: 'idle-handler',
              detail: 'Continuation deferred past bound',
              skipPersist: true,
            },
          );
          await machine.transition('paused', {
            source: 'idle-handler',
            stopReason: 'deferred too many times',
            detail: `Paused after ${deferrals} consecutive busy-deferrals.`,
          });
          await session.persist();
        } else {
          runtime?.deferCounts.set(deferKey, deferrals);
          await machine.mutate(
            g => {
              g.continuationClaim = null;
              g.turnCount = Math.max(0, g.turnCount - 1);
              g.lastStatus = `Deferred (${deferrals}): host busy; will retry next idle.`;
            },
            {
              source: 'idle-handler',
              detail: 'Continuation deferred (session busy)',
              skipPersist: true,
            },
          );
          await session.persist();
        }
      } else if (response.error) {
        // Continuations target the goal's owning session. If the session has been
        // deleted, surface the specific "not found" state rather than a generic prompt
        // failure while retaining standard retry bounds in case of transient host restarts.
        const sessionGone = isSessionGoneError(
          response.error as {name?: string; message?: string},
        );
        await machine.mutate(
          g => {
            g.continuationClaim = null;
            g.promptFailures += 1;
            const errName =
              (response.error as {name?: string})?.name || 'unknown error';
            const errMsg = (response.error as {message?: string})?.message;
            g.lastStatus = sessionGone
              ? "Auto-continue failed: the goal's session no longer exists (session not found)."
              : errMsg
                ? `Auto-continue failed: ${errName}: ${String(errMsg).slice(0, 300)}`
                : `Auto-continue failed: ${errName}`;
            const maxFailures = deps.defaultOpts?.maxPromptFailures ?? 3;
            if (g.promptFailures >= maxFailures) {
              g.lastStatus = sessionGone
                ? `The goal's session no longer exists; paused after ${g.promptFailures} failure(s).`
                : `Auto-continue failed; paused after ${g.promptFailures} failure(s).`;
              // g.finalizing was cleared in finally block, inspect decision in scope.
              if (
                g.status === 'active' ||
                decision.budgetWrapup ||
                decision.budgetLimit ||
                sessionGone
              ) {
                g.stopReason = sessionGone
                  ? 'session not found'
                  : 'auto-continue failures';
              }
            }
          },
          {source: 'idle-handler', detail: 'Prompt failure'},
        );

        const maxFailures = deps.defaultOpts?.maxPromptFailures ?? 3;
        const afterFailure = machine.snapshot();
        if (afterFailure.promptFailures >= maxFailures) {
          await machine.transition('paused', {
            source: 'idle-handler',
            stopReason: sessionGone
              ? 'session not found'
              : 'auto-continue failures',
            detail: sessionGone
              ? `Paused after ${afterFailure.promptFailures} consecutive prompt failures: the goal's owning session no longer exists.`
              : `Paused after ${afterFailure.promptFailures} consecutive prompt failures.`,
          });
        }
        await session.persist();
      } else {
        runtime?.deferCounts.delete(
          `${sessionID}:${machine.snapshot().goalId}`,
        );
        await machine.mutate(
          g => {
            g.promptFailures = 0;
          },
          {
            source: 'idle-handler',
            detail: 'Prompt succeeded, reset failure count',
            skipPersist: true,
          },
        );
        await session.persist();
      }
      break;
    }

    case 'pause': {
      await machine.transition('paused', {
        source: 'idle-handler',
        stopReason: decision.stopReason,
        detail: decision.reason,
      });
      await session.persist();
      // Auto-promote next goal in ordered sequences so execution does not stall silently.
      if (session.autoPromote && session.isOrdered()) {
        await session.autoPromote();
      }
      break;
    }

    case 'budget-limit': {
      const budgetResult = await machine.transition('budgetLimited', {
        source: 'idle-handler',
        stopReason: 'budget exhausted',
        detail: 'API-cost budget exhausted',
      });
      if (!budgetResult.ok) {
        await session.persist();
        return;
      }
      await machine.mutate(
        g => {
          g.budgetLimitReported = true;
        },
        {
          source: 'idle-handler',
          detail: 'Marked budget limit reported',
          skipRevision: true,
        },
      );
      await session.persist();

      const goal = machine.snapshot();
      let message: string = buildContinueMessage(goal, {
        budgetLimit: true,
        warnTurnsRemaining: deps.warnTurnsRemaining,
        warnDurationMsRemaining: deps.warnDurationMsRemaining,
        warnTokensRemaining: deps.warnTokensRemaining,
      });
      if (typeof message !== 'string') {
        message = String(message ?? '');
      }
      if (deps.runtime) deps.runtime.promptInFlightSessions.add(sessionID);
      try {
        const promptInput: Record<string, unknown> = {
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
        else {
          const fallback = machine.snapshot().executionContext?.agent;
          const resolved = normalizeInheritedAgentForPrompt(fallback);
          if (resolved) promptInput.agent = stripAgentListSortPrefix(resolved);
        }
        await sessionApi.promptAsync(
          sessionID,
          promptInput as unknown as {
            parts: unknown[];
          } & Record<string, unknown>,
        );
      } catch (error) {
        await deps.logError('Failed to send budget limit prompt', error);
      } finally {
        deps.runtime?.promptInFlightSessions.delete(sessionID);
      }
      // Retain focus on the terminating goal until its synthetic prompt completes.
      if (session.autoPromote && session.isOrdered()) {
        await session.autoPromote();
      }
      break;
    }

    case 'apply-pending-intent': {
      const goal = machine.snapshot();
      const validation = validatePendingIntent(decision.intent, goal);
      if (!validation.valid) {
        // Discard stale intent and re-evaluate continuation policy.
        session.setPendingIntent(machine.snapshot().goalId, null);
        const policy = deps.getLoopPolicy();
        const idleCtx: IdleContext = {
          goal: machine.snapshot(),
          pendingIntent: null,
          latestOutputTokens: null,
          latestHasToolCall: false,
          latestHasThinkingTokens: false,
          assistantChanged: false,
          assistantRepeated: false,
          userInterventionDetected: false,
          activationBoundary: false,
        };
        const newDecision = policy.decideContinuation(idleCtx);
        await executeDecision(newDecision, sessionID, session, machine, deps);
        return;
      }

      const targetStatus = decision.intent.targetStatus;
      if (targetStatus === 'complete') {
        // Verification pipeline:
        // 1. Advisory phrase triage (captures context for potential recovery prompts).
        // 2. Candidate identity capture (git HEAD + diff digest).
        // 3. Resolve and run verifier (gmake target -> judge -> unavailable).
        // 4. Evaluate verdict (fail-closed).
        // 5. Settle, recover, or escalate.
        // The verifier is authoritative; phrase triage cannot override it.
        const triage =
          goal.languageTriage !== false
            ? scanPrematureExit(goal.lastAssistantText || '')
            : {tier: 'none' as const, reason: ''};
        const triageReason = triage.tier === 'phrase' ? triage.reason : null;
        // Track the message ID to detect if a new assistant message arrived during
        // verifier execution, bypassing revision CAS checks.
        const preRunAssistantID = goal.lastAssistantMessageID;

        if (deps.completionGate) {
          await runCompletionGate({
            goal,
            machine,
            session,
            sessionID,
            deps: {...deps, completionGate: deps.completionGate},
            triageReason,
            preRunAssistantID,
            sendRecoveryPrompt: a =>
              sendRecoveryPrompt(
                a.sessionID,
                session,
                a.machine,
                deps,
                a.verdict,
                a.recovery,
                a.nextState,
                a.phraseReason,
                a.claimText,
              ),
          });
          break;
        }

        // Backward compatibility fallback for custom completionJudge implementations.
        if (deps.completionJudge) {
          let judgeResult;
          try {
            judgeResult = await deps.completionJudge({
              goal: machine.snapshot(),
              sessionID,
              latestText: goal.lastAssistantText || '',
            });
          } catch (err) {
            judgeResult = {
              approved: false,
              reason: `judge error: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          if (!judgeResult.approved) {
            await machine.recordClaim({
              actor: 'agent',
              claimedStatus: 'complete',
              claimText:
                goal.lastAssistantText || 'update_goal { status: complete }',
              check: {
                path: 'judge',
                verdict: 'JUDGE_REJECTED',
                evidence: [
                  judgeResult.reason || 'the judge rejected the claim',
                ],
                timestamp: Date.now(),
              },
              outcome: {
                status: 'claim-refuted',
                detail: judgeResult.reason || 'the judge rejected the claim',
                timestamp: Date.now(),
              },
            });
            const currentStatus = machine.snapshot().status;
            if (currentStatus === 'paused' || currentStatus === 'blocked') {
              await machine.mutate(
                g => {
                  g.stopReason = 'judge rejected';
                  g.lastStatus = `The judge rejected the claim: ${judgeResult.reason || 'the judge rejected the claim'}`;
                },
                {
                  source: 'update_goal',
                  detail: `The judge rejected the claim: ${judgeResult.reason || 'the judge rejected the claim'}`,
                },
              );
              session.setPendingIntent(machine.snapshot().goalId, null);
              await session.persist();
              return;
            }

            const rejectResult = await machine.transition('paused', {
              source: 'update_goal',
              stopReason: 'judge rejected',
              detail: judgeResult.reason || 'the judge rejected the claim',
            });
            if (!rejectResult.ok) {
              await deps.logError(
                'Failed to transition to paused after the judge rejected the claim',
                rejectResult.error,
              );
            }
            await machine.mutate(
              g => {
                g.lastStatus = `The judge rejected the claim: ${judgeResult.reason || 'the judge rejected the claim'}`;
              },
              {
                source: 'update_goal',
                detail: "Set last status to the judge's rejection reason",
                skipPersist: true,
              },
            );
            session.setPendingIntent(machine.snapshot().goalId, null);
            await session.persist();
            return;
          }
          await machine.recordClaim({
            actor: 'agent',
            claimedStatus: 'complete',
            claimText:
              goal.lastAssistantText || 'update_goal { status: complete }',
            check: {
              path: 'judge',
              verdict: 'JUDGE_APPROVED',
              evidence: ['The judge approved completion.'],
              timestamp: Date.now(),
            },
            outcome: {
              status: 'verified-complete',
              detail: 'The judge approved completion.',
              timestamp: Date.now(),
            },
          });
          const postJudgeStatus = machine.snapshot().status;
          if (postJudgeStatus !== 'active') {
            session.setPendingIntent(machine.snapshot().goalId, null);
            await session.persist();
            return;
          }
        } else {
          await machine.recordClaim({
            actor: 'agent',
            claimedStatus: 'complete',
            claimText:
              goal.lastAssistantText || 'update_goal { status: complete }',
            check: {
              path: 'none',
              verdict: 'NONE',
              evidence: [],
              timestamp: Date.now(),
            },
            outcome: {
              status: 'unverifiable-claim',
              detail: 'No verifier configured',
              timestamp: Date.now(),
            },
          });
          await machine.mutate(
            g => {
              g.stopReason = 'completion verification unavailable';
              g.lastStatus =
                'Completion verification unavailable: no verifier configured';
            },
            {
              source: 'update_goal',
              detail: 'Completion check abstained without a verifier',
            },
          );
          session.setPendingIntent(machine.snapshot().goalId, null);
          await session.persist();
          if (deps.announceGoalDecision) {
            await deps.announceGoalDecision(
              sessionID,
              'Completion verification unavailable: no verifier configured. Goal remains active; no completion was recorded.',
            );
          }
          return;
        }

        const completeResult = await machine.transition('complete', {
          source: 'update_goal',
          stopReason: 'completed (judge approved)',
          detail:
            'Goal marked complete via update_goal tool (pending intent applied)',
        });
        if (!completeResult.ok) {
          await deps.logError(
            'Failed to transition to complete (pending intent)',
            completeResult.error,
          );
          session.setPendingIntent(machine.snapshot().goalId, null);
          await session.persist();
          return;
        }
      } else if (targetStatus === 'blocked') {
        const blockedReason = goal.lastAssistantText
          ? summarizeText(goal.lastAssistantText, 200)
          : 'Marked blocked via update_goal tool';
        await machine.recordClaim({
          actor: 'agent',
          claimedStatus: 'blocked',
          claimText:
            goal.lastAssistantText || 'update_goal { status: blocked }',
          check: {
            path: 'none',
            verdict: 'BLOCKED',
            evidence: [],
            timestamp: Date.now(),
          },
          outcome: {
            status: 'blocked-acknowledged',
            detail: blockedReason,
            timestamp: Date.now(),
          },
        });
        const blockedResult = await machine.transition('blocked', {
          source: 'update_goal',
          stopReason: 'blocked',
          blockedReason,
          detail:
            'Goal marked blocked via update_goal tool (pending intent applied)',
        });
        if (!blockedResult.ok) {
          await deps.logError(
            'Failed to transition to blocked (pending intent)',
            blockedResult.error,
          );
          session.setPendingIntent(machine.snapshot().goalId, null);
          await session.persist();
          return;
        }
      }

      session.setPendingIntent(machine.snapshot().goalId, null);
      await session.persist();

      // Auto-promote on terminal status to prevent ordered sequences from stalling.
      if (
        session.autoPromote &&
        session.isOrdered() &&
        (targetStatus === 'complete' || targetStatus === 'blocked')
      ) {
        await session.autoPromote();
      }
      if (targetStatus === 'complete') {
        await session.removeGoal(goal.goalId, 'update_goal');
        await session.persist();
      }
      break;
    }

    case 'stop': {
      const stopResult = await machine.transition('paused', {
        source: 'idle-handler',
        stopReason: decision.reason,
        detail: `Goal stopped: ${decision.reason}`,
      });
      if (!stopResult.ok) {
        await session.persist();
        return;
      }
      await session.persist();

      // Send a final wrap-up prompt to notify the session rather than stopping silently.
      const stopGoal = machine.snapshot();
      const stopMessage = renderStopLimit(stopGoal, decision.reason);
      if (deps.runtime) deps.runtime.promptInFlightSessions.add(sessionID);
      try {
        await sessionApi.promptAsync(sessionID, {
          parts: [
            {
              type: 'text',
              text: stopMessage,
              metadata: {[GOAL_TUI_METADATA_KEY]: {kind: 'continuation'}},
              synthetic: true,
            },
          ],
        });
      } catch (error) {
        await deps.logError('Failed to send stop wrap-up prompt', error);
      } finally {
        deps.runtime?.promptInFlightSessions.delete(sessionID);
      }
      // Retain focus on the stopped goal until its synthetic wrap-up prompt completes.
      if (session.autoPromote && session.isOrdered()) {
        await session.autoPromote();
      }
      break;
    }
  }
}

export async function sendRecoveryPrompt(
  sessionID: string,
  session: SessionContext,
  machine: GoalStateMachine,
  deps: HookDeps,
  verdict: CompletionVerdict,
  recovery: {recoveryTurns: number; maxRecoveryTurns: number},
  nextState: RecoveryState,
  phraseReason: string | null,
  claimText?: string,
): Promise<void> {
  // Persist updated recovery state on the goal for crash resilience.
  await machine.mutate(
    g => {
      g.recoveryTurns = nextState.recoveryTurns;
      g.unchangedResults = nextState.unchangedResults;
      g.lastCandidate = nextState.lastCandidate;
      g.lastFingerprint = nextState.lastFingerprint;
      g.continuationClaim = null;
      g.lastStatus = `Recovery ${recovery.recoveryTurns}/${recovery.maxRecoveryTurns}: ${verdict.outstanding.join('; ')}`;
    },
    {
      source: 'update_goal',
      detail: `Verifier WORKING — recovery ${recovery.recoveryTurns}/${recovery.maxRecoveryTurns}`,
    },
  );

  // Record pressure-ladder rung transitions to make escalation visible in goal history and UI.
  const rung = determinePressureRung(
    recovery.recoveryTurns,
    recovery.maxRecoveryTurns,
  );
  if (machine.snapshot().pressureRung !== rung) {
    await machine.mutate(
      g => {
        g.pressureRung = rung;
      },
      {source: 'update_goal', detail: `Pressure rung escalated to ${rung}`},
    );
  }

  const message = buildRecoveryPrompt(
    verdict,
    recovery.recoveryTurns,
    recovery.maxRecoveryTurns,
    phraseReason,
    claimText,
  );

  // Clear pending intent to grant the agent a recovery turn to address outstanding verification gates.
  session.setPendingIntent(machine.snapshot().goalId, null);
  await machine.addNotice('premature-exit', message);
  await session.persist();

  if (deps.announceGoalDecision) {
    await deps.announceGoalDecision(
      sessionID,
      `Recovery ${recovery.recoveryTurns}/${recovery.maxRecoveryTurns}: ${verdict.outstanding.join('; ')}`,
    );
  }

  // Send recovery prompt as a synthetic continuation, inheriting the active agent name when set.
  if (deps.runtime) deps.runtime.promptInFlightSessions.add(sessionID);
  try {
    const promptInput: Record<string, unknown> = {
      parts: [
        {
          type: 'text',
          text: message,
          metadata: {[GOAL_TUI_METADATA_KEY]: {kind: 'recovery'}},
          synthetic: true,
        },
      ],
    };
    const fallbackAgent = machine.snapshot().executionContext?.agent;
    const resolved = normalizeInheritedAgentForPrompt(fallbackAgent);
    if (resolved) promptInput.agent = stripAgentListSortPrefix(resolved);
    await deps.sessionApi.promptAsync(
      sessionID,
      promptInput as unknown as {
        parts: unknown[];
      } & Record<string, unknown>,
    );
  } catch (error) {
    await deps.logError('Failed to send recovery prompt', error);
  } finally {
    deps.runtime?.promptInFlightSessions.delete(sessionID);
  }
}
