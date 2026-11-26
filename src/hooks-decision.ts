/**
 * Continuation decision executor (`executeDecision`) and recovery prompt sender (`sendRecoveryPrompt`).
 *
 * Both functions are placed in this module to maintain a directed acyclic dependency graph:
 * `executeDecision` calls `sendRecoveryPrompt`, and idle lifecycle handlers import this module.
 */

import {acquirePromptInFlight} from './session-runtime.ts';
import type {GoalStateMachine} from './state-machine.ts';
import type {ContinuationDecision, IdleContext} from './continuation-loop.ts';
import {validatePendingIntent} from './continuation-loop.ts';
import type {HookDeps, SessionContext} from './hooks-types.ts';
import {executeContinuation} from './hooks-continuation.ts';
import {createGoalWorkScope} from './hooks-work-scope.ts';
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
  const scope = createGoalWorkScope(sessionID, session, machine, deps);

  switch (decision.type) {
    case 'continue':
      await executeContinuation(
        decision,
        sessionID,
        session,
        machine,
        deps,
        opts,
      );
      return;

    case 'pause': {
      if (
        !(await scope.transition('paused', {
          source: 'idle-handler',
          stopReason: decision.stopReason,
          detail: decision.reason,
        })) ||
        !(await scope.persist())
      )
        return;
      // Auto-promote next goal in ordered sequences so execution does not stall silently.
      if (session.autoPromote && session.isOrdered()) {
        await session.autoPromote();
      }
      break;
    }

    case 'budget-limit': {
      // The transition itself sets budgetLimitReported. A terminal goal does
      // not accept the redundant field mutation that used to follow it.
      if (
        !(await scope.transition('budgetLimited', {
          source: 'idle-handler',
          stopReason: 'budget exhausted',
          detail: 'API-cost budget exhausted',
        })) ||
        !(await scope.persist())
      )
        return;

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
      const releasePrompt = acquirePromptInFlight(deps.runtime, sessionID);
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
        releasePrompt();
      }
      // Retain focus on the terminating goal until its synthetic prompt completes.
      if (scope.current() && session.autoPromote && session.isOrdered()) {
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
      if (
        !(await scope.transition('paused', {
          source: 'idle-handler',
          stopReason: decision.reason,
          detail: `Goal stopped: ${decision.reason}`,
        })) ||
        !(await scope.persist())
      )
        return;

      // Send a final wrap-up prompt to notify the session rather than stopping silently.
      const stopGoal = machine.snapshot();
      const stopMessage = renderStopLimit(stopGoal, decision.reason);
      const releasePrompt = acquirePromptInFlight(deps.runtime, sessionID);
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
        releasePrompt();
      }
      // Retain focus on the stopped goal until its synthetic wrap-up prompt completes.
      if (scope.current() && session.autoPromote && session.isOrdered()) {
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
  const scope = createGoalWorkScope(sessionID, session, machine, deps);
  const goal = machine.snapshot();
  if (goal.status !== 'active' && !goal.finalizing) return;
  // Persist updated recovery state on the goal for crash resilience.
  if (
    !(await scope.mutate(
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
    ))
  )
    return;

  // Record pressure-ladder rung transitions to make escalation visible in goal history and UI.
  const rung = determinePressureRung(
    recovery.recoveryTurns,
    recovery.maxRecoveryTurns,
  );
  if (machine.snapshot().pressureRung !== rung) {
    if (
      !(await scope.mutate(
        g => {
          g.pressureRung = rung;
        },
        {source: 'update_goal', detail: `Pressure rung escalated to ${rung}`},
      ))
    )
      return;
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
  await machine.addNotice('premature-exit', message, {guard: scope.current});
  if (!(await scope.persist())) return;

  if (deps.announceGoalDecision) {
    await deps.announceGoalDecision(
      sessionID,
      `Recovery ${recovery.recoveryTurns}/${recovery.maxRecoveryTurns}: ${verdict.outstanding.join('; ')}`,
    );
  }
  if (!scope.current()) return;

  // Send recovery prompt as a synthetic continuation, inheriting the active agent name when set.
  const releasePrompt = acquirePromptInFlight(deps.runtime, sessionID);
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
    releasePrompt();
  }
}
