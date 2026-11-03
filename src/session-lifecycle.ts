import type {FocusResult, TransitionSource} from './state-machine.ts';
import {
  createGoalState,
  GoalStateMachine,
  resumeClockInPlace,
  TERMINAL_STATUSES,
} from './state-machine.ts';
import {serializeGoal, serializeResult} from './persistence.ts';
import {appendWalEntry, createCommittedEntry} from './persistence-wal.ts';
import {ensureSessionDir, sessionStatePaths} from './session-paths.ts';
import type {CreateGoalOptions} from './tools.ts';
import type {SessionLifecycleHost} from './session-lifecycle-types.ts';

/**
 * Replace the focused goal with a single new goal — the `/goal <text>`
 * command path's semantics. Only the focused goal is replaced; a bare
 * `/goal <text>` must not destroy unrelated running work in the session.
 * Removal goes through `removeGoalOwned`, so the archive and invalidation
 * fence stay durable.
 */
export async function replaceGoalsOwned(
  mgr: SessionLifecycleHost,
  sessionID: string,
  objective: string,
  options: CreateGoalOptions,
): Promise<GoalStateMachine> {
  return mgr.withSessionLifecycle(sessionID, async () => {
    mgr.clearingSessions.add(sessionID);
    try {
      const target = mgr.getMachine(sessionID);
      if (target && !TERMINAL_STATUSES.has(target.state.status)) {
        mgr.runtime.pendingIntents.delete(
          `${sessionID}:${target.state.goalId}`,
        );
        await removeGoalOwned(
          mgr,
          sessionID,
          target.state.goalId,
          'slash-command',
        );
      }
      const machine = createGoalOwned(mgr, sessionID, objective, options);
      await mgr.drainWalWrites();
      await mgr.persistFn(sessionID);
      return machine;
    } finally {
      mgr.clearingSessions.delete(sessionID);
    }
  });
}

export function createGoalOwned(
  mgr: SessionLifecycleHost,
  sessionID: string,
  objective: string,
  options: CreateGoalOptions,
): GoalStateMachine {
  const goal = createGoalState(sessionID, objective, {
    maxTokens: options.maxTokens ?? mgr.defaultOpts.maxTokens,
    maxTurns: options.maxTurns ?? mgr.defaultOpts.maxTurns,
    maxDurationMs: options.maxDurationMs ?? mgr.defaultOpts.maxDurationMs,
    minDelayMs: options.minDelayMs ?? mgr.defaultOpts.minDelayMs,
    noProgressTokenThreshold:
      options.noProgressTokenThreshold ??
      mgr.defaultOpts.noProgressTokenThreshold,
    noProgressTurnsBeforePause:
      options.noProgressTurnsBeforePause ??
      mgr.defaultOpts.noProgressTurnsBeforePause,
    noToolCallTurnsBeforePause:
      options.noToolCallTurnsBeforePause ??
      mgr.defaultOpts.noToolCallTurnsBeforePause,
    tokenBudget: options.tokenBudget ?? null,
    successCriteria: options.successCriteria,
    constraints: options.constraints,
    artifactPointers: options.artifactPointers,
    mode: options.mode,
    maxRecoveryTurns:
      options.maxRecoveryTurns ?? mgr.defaultOpts.maxRecoveryTurns,
    maxUnchangedResults:
      options.maxUnchangedResults ?? mgr.defaultOpts.maxUnchangedResults,
    maxBlockedTurns: options.maxBlockedTurns ?? mgr.defaultOpts.maxBlockedTurns,
    languageTriage: options.languageTriage ?? mgr.defaultOpts.languageTriage,
  });
  const machine = new GoalStateMachine(goal, {
    onCommit: mgr.createOnCommit(),
    onUsageUpdate: mgr.createOnUsageUpdate(),
  });

  // Chain WAL writes so multiple createGoal calls (e.g. /goal sequence)
  // execute in order. Without chaining, pendingWalWrite is overwritten
  // and removeGoal may await the wrong Promise, allowing the removal
  // entry to be written before the creation entry — causing goal
  // resurrection during recovery.
  const prevWalWrite = mgr.pendingWalWrite;
  mgr.pendingCreateIds.add(goal.goalId);
  mgr.pendingWalWrite = (prevWalWrite ?? Promise.resolve())
    .then(async () => {
      await mgr.writeWalEntry(goal, 'committed', {
        source: 'create_goal',
        from: 'active',
        to: 'active',
        detail: 'Goal created',
      });
      // Clear the pending marker on success. writeWalEntry returns early
      // when no ledger is configured, so the marker must be cleared explicitly here.
      mgr.pendingCreateIds.delete(goal.goalId);
    })
    .catch(async error => {
      // The creation is uncommitted and must not remain in pendingCreateIds,
      // which would permanently exclude the goal from intent projection.
      mgr.pendingCreateIds.delete(goal.goalId);

      const currentGoals = mgr.runtime.sessionGoals.get(sessionID);
      const index = currentGoals?.indexOf(machine) ?? -1;
      if (index >= 0 && currentGoals) {
        currentGoals.splice(index, 1);
        if (mgr.runtime.focusedGoalId.get(sessionID) === goal.goalId) {
          const replacement = currentGoals.at(-1);
          if (replacement) {
            mgr.runtime.focusedGoalId.set(sessionID, replacement.state.goalId);
          } else {
            mgr.runtime.focusedGoalId.delete(sessionID);
          }
        }
      }
      // Append a rollback tombstone regardless of whether the live machine is
      // still present, since appendWalEntry may have already committed the creation
      // before a subsequent rotation failed.
      mgr.addInvalidation(sessionID, goal.goalId);
      mgr.pendingInvalidationCheckpoints.add(goal.goalId);
      mgr.persistedState.goals = mgr.persistedState.goals.filter(
        item => item.goalId !== goal.goalId,
      );
      if (mgr.persistEnabled) {
        try {
          await ensureSessionDir(mgr.stateRoot, goal.sessionID);
          const rollbackLedger = sessionStatePaths(
            mgr.stateRoot,
            goal.sessionID,
          ).ledgerPath;
          await appendWalEntry(
            rollbackLedger,
            createCommittedEntry(
              goal,
              {
                source: 'create_goal',
                goalId: goal.goalId,
                fromStatus: 'active',
                toStatus: 'active',
                stopReason: goal.stopReason,
                blockedReason: goal.blockedReason,
                detail: 'Goal creation rolled back after WAL failure',
              },
              rollbackLedger,
              true,
            ),
          );
        } catch (tombstoneError) {
          await mgr.logError(
            'Failed to append goal creation rollback tombstone',
            tombstoneError,
          );
        }
      }
      await mgr.logError('Goal creation WAL write failed; goal removed', error);
      let rollbackPersisted = false;
      try {
        rollbackPersisted = await mgr.persistFn(sessionID);
        if (rollbackPersisted) {
          mgr.pendingInvalidationCheckpoints.delete(goal.goalId);
        }
        if (!rollbackPersisted) {
          await mgr.logError(
            'Goal creation rollback snapshot was not persisted',
          );
        }
      } catch (rollbackError) {
        await mgr.logError(
          'Goal creation rollback snapshot failed',
          rollbackError,
        );
      }
      if (!rollbackPersisted) {
        // Retain the invalidation fence if snapshot persistence fails, ensuring
        // stale on-disk snapshots do not resurrect the failed goal during recovery.
        await mgr.logError(
          'Goal creation rollback is not durable; invalidation fence remains required',
        );
      }
      throw error;
    });
  mgr.pendingWalWrite = mgr.pendingWalWrite.catch(() => {});
  void mgr.pendingWalWrite.catch(() => {});

  let goals = mgr.runtime.sessionGoals.get(sessionID);
  if (!goals) {
    goals = [];
    mgr.runtime.sessionGoals.set(sessionID, goals);
  }
  goals.push(machine);
  mgr.runtime.focusedGoalId.set(sessionID, goal.goalId);
  mgr.persistedState.goals.push(serializeGoal(goal));

  if (mgr.broadcaster) {
    void mgr.broadcaster.emitCreate(machine.snapshot());
  }
  return machine;
}

export async function removeGoalOwned(
  mgr: SessionLifecycleHost,
  sessionID: string,
  goalId: string,
  caller: TransitionSource,
): Promise<void> {
  const goals = mgr.runtime.sessionGoals.get(sessionID);
  if (!goals) return;
  const idx = goals.findIndex(m => m.state.goalId === goalId);
  if (idx < 0) return;
  const machine = goals[idx];
  const goal = machine.snapshot();

  // Fence immediately so queued transitions cannot append after removal while
  // the serialized tombstone is waiting behind another WAL write.
  mgr.addInvalidation(sessionID, goalId);
  mgr.pendingInvalidationCheckpoints.add(goalId);
  mgr.runtime.deferCounts.delete(`${sessionID}:${goalId}`);

  // Chain WAL removal through pendingWalWrite to serialize with createGoal
  // and prevent concurrent appends from interleaving. Record the caller source
  // for operational auditing.
  const walPromise = (mgr.pendingWalWrite ?? Promise.resolve()).then(() =>
    mgr.writeWalEntry(
      goal,
      'committed',
      {
        source: caller,
        from: goal.status,
        to: goal.status,
        detail: 'Goal removed',
      },
      true,
    ),
  );
  mgr.pendingWalWrite = walPromise;
  try {
    await walPromise;
  } catch (error) {
    // The invalidation fence remains authoritative even when the tombstone append
    // fails. Remove the goal locally as well to prevent blocked phantom goals from
    // being serialized by a later persist or displayed to the user.
    const currentGoals = mgr.runtime.sessionGoals.get(sessionID);
    const currentIdx =
      currentGoals?.findIndex(m => m.state.goalId === goalId) ?? -1;
    if (currentGoals && currentIdx >= 0) {
      currentGoals.splice(currentIdx, 1);
      if (currentGoals.length === 0) {
        mgr.runtime.sessionGoals.delete(sessionID);
        mgr.runtime.focusedGoalId.delete(sessionID);
        mgr.runtime.sessionOrdered.delete(sessionID);
        mgr.persistedState.sessionOrdered =
          mgr.persistedState.sessionOrdered.filter(s => s !== sessionID);
      } else if (mgr.runtime.focusedGoalId.get(sessionID) === goalId) {
        mgr.runtime.focusedGoalId.set(
          sessionID,
          currentGoals[currentGoals.length - 1].state.goalId,
        );
      }
    }
    mgr.persistedState.goals = mgr.persistedState.goals.filter(
      g => g.goalId !== goalId,
    );
    for (const messageID of goal.messageIDs) {
      mgr.runtime.seenTokens.delete(messageID);
      mgr.runtime.seenUsage.delete(messageID);
      mgr.runtime.seenOutputTokens.delete(messageID);
    }
    if (mgr.broadcaster) {
      void mgr.broadcaster.emitRemove(sessionID, goalId);
    }
    throw error;
  } finally {
    if (mgr.pendingWalWrite === walPromise) {
      mgr.pendingWalWrite = null;
    }
  }

  // Ensure invalidation checkpoint marker is held until snapshot persistence succeeds;
  // with ledger retention set to 0, this prevents unlinking tombstones before the snapshot is durable.
  mgr.addInvalidation(sessionID, goalId);
  mgr.pendingInvalidationCheckpoints.add(goalId);

  // Re-check index after await since concurrent operations may have shifted array elements.
  const currentIdx = goals.findIndex(m => m.state.goalId === goalId);
  if (currentIdx < 0) return;
  let archive = mgr.runtime.sessionArchive.get(sessionID);
  if (!archive) {
    archive = [];
    mgr.runtime.sessionArchive.set(sessionID, archive);
  }
  const archiveState = goal.status === 'complete' ? 'achieved' : 'cleared';
  const archiveEvidence =
    goal.lastClaim?.check.evidence?.slice(0, 20).join('\n').slice(0, 16_000) ??
    '';
  archive.push(
    serializeResult(goal, archiveState, goal.stopReason, archiveEvidence),
  );
  while (archive.length > mgr.maxArchived) archive.shift();
  goals.splice(currentIdx, 1);
  mgr.runtime.deferCounts.delete(`${sessionID}:${goalId}`);
  if (goals.length === 0) {
    mgr.runtime.sessionGoals.delete(sessionID);
    mgr.runtime.focusedGoalId.delete(sessionID);
    mgr.runtime.sessionOrdered.delete(sessionID);
    mgr.persistedState.sessionOrdered =
      mgr.persistedState.sessionOrdered.filter(s => s !== sessionID);
  } else if (mgr.runtime.focusedGoalId.get(sessionID) === goalId) {
    mgr.runtime.focusedGoalId.set(
      sessionID,
      goals[goals.length - 1].state.goalId,
    );
  }
  mgr.persistedState.goals = mgr.persistedState.goals.filter(
    g => g.goalId !== goalId,
  );

  // Prune token tracking maps for this goal's message IDs to prevent unbounded
  // growth across the lifetime of long-running sessions with many goals.
  for (const messageID of goal.messageIDs) {
    mgr.runtime.seenTokens.delete(messageID);
    mgr.runtime.seenUsage.delete(messageID);
    mgr.runtime.seenOutputTokens.delete(messageID);
  }

  if (mgr.broadcaster) {
    void mgr.broadcaster.emitRemove(sessionID, goalId);
  }

  // Persist the removal and invalidation fence to durable storage.
  // The checkpoint marker is only cleared after a successful snapshot write;
  // if persistence fails, the fence remains active to prevent resurrecting the goal from stale snapshots.
  const persisted = await mgr.persist(sessionID);
  if (persisted) {
    mgr.pendingInvalidationCheckpoints.delete(goalId);
  } else {
    await mgr.logError(
      'Removal invalidation snapshot was not persisted; the fence remains required for recovery',
    );
  }
}

export async function focusGoalOwned(
  mgr: SessionLifecycleHost,
  sessionID: string,
  goalId: string,
): Promise<FocusResult> {
  const goals = mgr.runtime.sessionGoals.get(sessionID);
  if (!goals) return {ok: false, reason: 'no-session'};
  const machine = goals.find(m => m.state.goalId === goalId);
  if (!machine) return {ok: false, reason: 'not-found'};
  if (machine.isTerminal()) return {ok: false, reason: 'terminal'};
  mgr.runtime.focusedGoalId.set(sessionID, goalId);
  await machine.mutate(
    g => {
      // Only update lastStatus to record the focus event for user visibility and auditing,
      // without modifying execution status, counters, or timers.
      g.lastStatus = 'Focused.';
    },
    {
      source: 'focus_goal',
      detail: 'Focused (no lifecycle change)',
      skipRevision: true,
    },
  );
  return {ok: true, machine};
}

export async function clearSessionOwned(
  mgr: SessionLifecycleHost,
  sessionID: string,
): Promise<void> {
  const goals = mgr.runtime.sessionGoals.get(sessionID) ?? [];
  const sessionFenceIds = new Set<string>();
  const writes: Promise<void>[] = [];
  for (const machine of goals) {
    const goal = machine.snapshot();
    mgr.addInvalidation(sessionID, goal.goalId);
    mgr.pendingInvalidationCheckpoints.add(goal.goalId);
    sessionFenceIds.add(goal.goalId);
    // A failed create WAL write must not reject the queued clear tombstone:
    // the create append may already be durable when rotation fails, so the
    // removal record still has to reach the ledger for crash recovery.
    const previous = (mgr.pendingWalWrite ?? Promise.resolve()).catch(() => {});
    const tombstone = previous.then(() =>
      mgr.writeWalEntry(
        goal,
        'committed',
        {
          source: 'create_goal-rollback',
          from: goal.status,
          to: goal.status,
          detail: 'Goal removed by session clear',
        },
        true,
      ),
    );
    mgr.pendingWalWrite = tombstone;
    writes.push(tombstone);
    for (const messageID of machine.state.messageIDs) {
      mgr.runtime.seenTokens.delete(messageID);
      mgr.runtime.seenUsage.delete(messageID);
      mgr.runtime.seenOutputTokens.delete(messageID);
    }
  }
  mgr.runtime.sessionGoals.delete(sessionID);
  mgr.runtime.focusedGoalId.delete(sessionID);
  mgr.runtime.sessionOrdered.delete(sessionID);
  mgr.runtime.compactionTimestamps.delete(sessionID);
  for (const key of [...mgr.runtime.deferCounts.keys()]) {
    if (key.startsWith(`${sessionID}:`)) mgr.runtime.deferCounts.delete(key);
  }
  mgr.persistedState.goals = mgr.persistedState.goals.filter(
    g => g.sessionID !== sessionID,
  );
  mgr.persistedState.sessionOrdered = mgr.persistedState.sessionOrdered.filter(
    s => s !== sessionID,
  );
  const writeResults = await Promise.allSettled(writes);
  let firstWriteError: unknown;
  for (const result of writeResults) {
    if (result.status === 'rejected') {
      firstWriteError ??= result.reason;
    }
  }
  // Persist the invalidation fence even when a tombstone append fails. The
  // runtime removal is otherwise able to resurrect on the next restart from
  // an older snapshot or retained create WAL entry.
  const persisted = await mgr.persistFn(sessionID);
  if (persisted) {
    for (const goalId of sessionFenceIds) {
      mgr.pendingInvalidationCheckpoints.delete(goalId);
    }
  }
  if (!persisted) {
    await mgr.logError('Session clear invalidation snapshot was not persisted');
    firstWriteError ??= new Error(
      'session clear invalidation snapshot was not persisted',
    );
  }
  if (mgr.pendingWalWrite && writes.includes(mgr.pendingWalWrite))
    mgr.pendingWalWrite = null;
  if (firstWriteError !== undefined) throw firstWriteError;
}

export async function autoPromoteOwned(
  mgr: SessionLifecycleHost,
  sessionID: string,
): Promise<GoalStateMachine | null> {
  const goals = mgr.runtime.sessionGoals.get(sessionID);
  if (!goals || goals.length === 0) return null;
  const focusedId = mgr.runtime.focusedGoalId.get(sessionID);
  // Promotion is only valid after the focused goal has settled. Idle and
  // recovery paths can race or be duplicated; without this guard a second
  // call promotes another background goal while the current focus is still
  // runnable, violating the one-active-goal invariant.
  const focused = focusedId
    ? goals.find(m => m.state.goalId === focusedId)
    : undefined;
  if (focused && !focused.isTerminal()) return null;
  for (const machine of goals) {
    if (machine.state.goalId === focusedId) continue;
    // Only goals with a 'queued' stopReason can be promoted. Other non-terminal
    // states (e.g. pauses, yields, or brakes) reflect intentional interventions and must be preserved.
    if (!machine.isTerminal() && machine.state.stopReason === 'queued') {
      mgr.runtime.focusedGoalId.set(sessionID, machine.state.goalId);
      await machine.mutate(
        g => {
          g.status = 'active';
          g.stopReason = '';
          g.blockedReason = '';
          g.finalizing = false;
          g.continuationClaim = null;
          g.noProgressTurns = 0;
          g.noToolCallTurns = 0;
          g.lastCountedProgressMessageID = '';
          g.lastNoToolCallMessageID = '';
          g.promptFailures = 0;
          g.recoveryTurns = 0;
          g.unchangedResults = 0;
          g.lastCandidate = null;
          g.lastFingerprint = null;
          g.blockedTurns = 0;
          g.blockedAssertedThisTurn = false;
          g.budgetWrapupSent = false;
          g.lastStatus = 'Auto-promoted from sequence.';
          // Auto-promotion starts execution for a queued goal, granting a fresh execution window.
          resumeClockInPlace(g);
        },
        {source: 'idle-handler', detail: 'Auto-promoted next goal in sequence'},
      );
      return machine;
    }
  }
  return null;
}
