/**
 * plugin-runtime.ts — the fixate-on composition root (host-agnostic runtime).
 *
 * Provides the factory and shared machinery: multi-goal session state manager,
 * AsyncLocalStorage isolation, persistence wiring, session API adapter,
 * and config/dispose hooks. Builds a `PluginHooks` object from host-supplied
 * options.
 *
 * Key invariants:
 * - One focused goal per session drives auto-continue; background goals stay
 *   paused until focused, with auto-promotion upon completion.
 * - Persistence is fail-closed for terminal states.
 * - The disposed flag prevents hook execution after cleanup.
 */

import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {lstatSync} from 'node:fs';
import type {GoalState, PendingIntent} from './state-machine.ts';
import {GoalStateMachine} from './state-machine.ts';
import {
  deserializeGoal,
  type PersistedState,
  type SerializedPendingIntent,
} from './persistence.ts';
import {
  createHooks,
  type PluginHooks,
  type SessionApi,
  type SessionContext,
} from './hooks.ts';
import type {CompletionGateDeps} from './completion-gate-run.ts';
import {consumeCommandDispatch} from './command-dispatch.ts';
import {type CreateGoalOptions, createGoalToolDefinitions} from './tools.ts';
import {loadLoopPolicy, type LoopPolicyOptions} from './continuation-loop.ts';
import {
  applyNativeGoalConfig,
  type NativeGoalConfigOptions,
  type OpenCodeConfig,
} from './native-agent-config.ts';
import {
  createOpenCodeSessionApi,
  type OpenCodeSessionApi,
} from './session-api.ts';
import {
  assertContainedInStateRoot,
  DEFAULT_STATE_ROOT,
  sessionStatePaths,
} from './session-paths.ts';
import {
  createChildSessionJudge,
  createChildSessionVerifier,
  defaultGoalMessenger,
  type Judge,
} from './child-session-verifier.ts';
import {createGoalBroadcaster} from './tui-state.ts';
import {resolveVerifier} from './completion-gate.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  type DefaultGoalOptions,
  runtimeStorage,
  SessionStateManager,
} from './session-state-manager.ts';
import type {PluginOptions} from './plugin-options.ts';
import {createPersistenceWiring} from './plugin-persistence.ts';
import {createKickoffWiring} from './plugin-kickoff.ts';

export type {DefaultGoalOptions} from './session-state-manager.ts';
export {DEFAULT_GOAL_OPTIONS} from './session-state-manager.ts';

// Re-exported so callers of plugin-runtime can resolve plugin options from one module.
export type {PluginOptions} from './plugin-options.ts';
export {mergeRecovered} from './plugin-options.ts';

export async function GoalsPlugin(
  context: {client?: unknown; directory?: string} = {},
  pluginOptions: PluginOptions = {},
): Promise<PluginHooks & {tool?: Record<string, unknown>}> {
  const runtime = createRuntimeState();

  return runtimeStorage.run(runtime, async () => {
    const commandName =
      (pluginOptions.commandName ?? 'goal').trim().replace(/^\/+/, '').trim() ||
      'goal';
    const registerTools = pluginOptions.registerTools !== false;
    const registerCommand = pluginOptions.registerCommand !== false;
    const registerAgents = pluginOptions.registerAgents !== false;

    const defaultOpts: Required<DefaultGoalOptions> = {
      ...DEFAULT_GOAL_OPTIONS,
      ...pluginOptions.defaultGoalOptions,
      ...(pluginOptions.minDelayMs !== undefined
        ? {minDelayMs: pluginOptions.minDelayMs}
        : {}),
      ...(pluginOptions.maxPromptFailures !== undefined
        ? {maxPromptFailures: pluginOptions.maxPromptFailures}
        : {}),
      ...(pluginOptions.noToolCallTurnsBeforePause !== undefined
        ? {noToolCallTurnsBeforePause: pluginOptions.noToolCallTurnsBeforePause}
        : {}),
      ...(pluginOptions.maxRecentMessages !== undefined
        ? {maxRecentMessages: pluginOptions.maxRecentMessages}
        : {}),
      ...(pluginOptions.maxTokens !== undefined
        ? {maxTokens: pluginOptions.maxTokens}
        : {}),
      ...(pluginOptions.maxTurns !== undefined
        ? {maxTurns: pluginOptions.maxTurns}
        : {}),
      ...(pluginOptions.maxDurationMs !== undefined
        ? {maxDurationMs: pluginOptions.maxDurationMs}
        : {}),
      ...(pluginOptions.noProgressTokenThreshold !== undefined
        ? {noProgressTokenThreshold: pluginOptions.noProgressTokenThreshold}
        : {}),
      ...(pluginOptions.noProgressTurnsBeforePause !== undefined
        ? {noProgressTurnsBeforePause: pluginOptions.noProgressTurnsBeforePause}
        : {}),
      ...(pluginOptions.budgetWrapupRatio !== undefined
        ? {budgetWrapupRatio: pluginOptions.budgetWrapupRatio}
        : {}),
      // Completion-gate recovery overrides from opencode.json must be explicitly passed
      // to avoid falling back to DEFAULT_GOAL_OPTIONS defaults.
      ...(pluginOptions.maxRecoveryTurns !== undefined
        ? {maxRecoveryTurns: pluginOptions.maxRecoveryTurns}
        : {}),
      ...(pluginOptions.maxUnchangedResults !== undefined
        ? {maxUnchangedResults: pluginOptions.maxUnchangedResults}
        : {}),
      ...(pluginOptions.maxBlockedTurns !== undefined
        ? {maxBlockedTurns: pluginOptions.maxBlockedTurns}
        : {}),
      ...(pluginOptions.languageTriage !== undefined
        ? {languageTriage: pluginOptions.languageTriage}
        : {}),
    };

    const persistState = pluginOptions.persistState ?? true;
    const workspaceDirectory = context.directory?.trim() || process.cwd();
    const resolveWorkspacePath = (path: string): string => {
      // Allow explicit absolute overrides, but prevent relative paths from escaping the workspace.
      if (isAbsolute(path)) return path;
      const workspace = resolve(workspaceDirectory);
      const resolved = resolve(workspace, path);
      const rel = relative(workspace, resolved);
      if (rel.startsWith('..')) {
        throw new Error(
          `state/ledger path escapes the workspace and is refused: ${path}`,
        );
      }
      // Reject symlinked directory segments between workspace root and resolved path.
      // writeStateFile creates directories via node:fs which follows symlinks; without
      // this check, a symlink could redirect persisted state to an arbitrary location.
      //
      // This walk guards segments strictly ABOVE the state root; `assertContainedInStateRoot`
      // validates the root segment and everything below it during per-session writes.
      let dir = dirname(resolved);
      while (dir.length > workspace.length) {
        try {
          const info = lstatSync(dir);
          if (info.isSymbolicLink()) {
            throw new Error(
              `refusing goal persistence through symlinked directory: ${dir}`,
            );
          }
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith('refusing goal persistence')
          )
            throw error;
          // Non-existent intermediate directories are permissible (created later).
        }
        dir = dirname(dir);
      }
      return resolved;
    };
    const explicitStateRoot =
      pluginOptions.stateRoot ?? process.env.FIXATE_ON_STATE_ROOT;
    const stateRoot = resolveWorkspacePath(
      explicitStateRoot ?? DEFAULT_STATE_ROOT,
    );
    /**
     * Validates that all derived paths for a session (directory, state snapshot,
     * and WAL ledger) stay contained within the state root.
     */
    const pathsForSession = (
      sessionID: string,
    ): {sessionDir: string; statePath: string; ledgerPath: string} => {
      const paths = sessionStatePaths(stateRoot, sessionID);
      assertContainedInStateRoot(stateRoot, paths.sessionDir);
      assertContainedInStateRoot(stateRoot, paths.statePath);
      assertContainedInStateRoot(stateRoot, paths.ledgerPath);
      return paths;
    };

    const logError = async (message: string, error?: unknown) => {
      try {
        const client = context.client as
          | {
              app?: {
                log?: (input: {
                  service?: string;
                  level?: string;
                  message?: string;
                  extra?: unknown;
                }) => Promise<void>;
              };
            }
          | undefined;
        if (client?.app?.log) {
          await client.app.log({
            service: 'fixate-on',
            level: 'error',
            message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } catch {
        // Logging is best-effort.
      }
    };

    // Initialize persistence wiring before SessionStateManager; stateManager is passed
    // as a lazy reference to resolve circular initialization dependencies.
    const stateManagerRef: {current?: SessionStateManager} = {};
    const persistence = await createPersistenceWiring({
      runtime,
      persistState,
      stateRoot,
      pathsForSession,
      getStateManager: () => {
        const sm = stateManagerRef.current;
        if (!sm)
          throw new Error(
            'persistFn invoked before SessionStateManager was constructed',
          );
        return sm;
      },
      pluginOptions,
      logError,
    });
    const {
      prepareSession,
      persistFn,
      unreadableSessions,
      refusedSessions,
      heldLeases,
      sessionOwnership,
      initialState,
      initialStateError,
      invalidatedBySession,
    } = persistence;
    if (initialStateError) {
      await logError(
        'failed to recover persisted goal state; starting with empty state',
        initialStateError,
      );
    }

    // Sessions with unreadable state are permanently latched as undrivable.
    // Lease refusals are dynamic and clear once the lock is released.
    runtime.canDriveSession = (sessionID: string): boolean =>
      !refusedSessions.has(sessionID) && !unreadableSessions.has(sessionID);

    const stateManager = new SessionStateManager(
      // An empty root disables state and WAL ledger persistence.
      runtime,
      persistFn,
      persistState ? stateRoot : '',
      initialState,
      invalidatedBySession,
      // prepareSession seeds the sequence counter and acquires the lock prior to writes.
      prepareSession,
      pluginOptions.ledgerMaxBytes,
      pluginOptions.ledgerRetentionFiles,
      pluginOptions.maxStoredResults,
      pluginOptions.resultRetentionMs,
      defaultOpts,
      logError,
    );
    stateManagerRef.current = stateManager;

    // Transport contract: only `pluginOptions.tuiTransport` (metadata channel) is used
    // for server-to-companion updates. The v1 `client.tui.publish` renders on-screen toasts,
    // so it is kept silent to prevent flooding users with state JSON blobs.
    {
      if (pluginOptions.tuiTransport) {
        stateManager.setBroadcaster(
          createGoalBroadcaster({publish: pluginOptions.tuiTransport}),
        );
        runtime.hasTuiCompanion = true;
      } else {
        const tuiClient = context.client as
          | {
              tui?: {publish?: (input: unknown) => Promise<unknown>};
            }
          | undefined;
        if (tuiClient?.tui?.publish) {
          runtime.hasTuiCompanion = true;
        }
      }
    }

    if (initialState) {
      // Seed ordered flags prior to recovery pause mutations; otherwise, intermediate
      // writes would project an empty sequence set and lose ordering state.
      stateManager.setOrdered(initialState.sessionOrdered);

      // Pass 1: instantiate all state machines first so that any subsequent persistence
      // calls have visibility into the complete session graph.
      const recoveredGoals: Array<{
        goal: import('./state-machine.ts').GoalState;
        serialized: PersistedState['goals'][number];
      }> = [];
      for (const serialized of initialState.goals) {
        const goal = deserializeGoal(serialized);
        const machine = new GoalStateMachine(goal, {
          onCommit: stateManager.createOnCommit(),
          onUsageUpdate: stateManager.createOnUsageUpdate(),
        });
        let goals = runtime.sessionGoals.get(goal.sessionID);
        if (!goals) {
          goals = [];
          runtime.sessionGoals.set(goal.sessionID, goals);
        }
        goals.push(machine);
        recoveredGoals.push({goal, serialized});
      }
      if (initialState.results) {
        const now = Date.now();
        const retentionMs = pluginOptions.resultRetentionMs ?? 604800000;
        for (const result of initialState.results) {
          if (now - result.finishedAt < retentionMs) {
            let archive = runtime.sessionArchive.get(result.sessionID);
            if (!archive) {
              archive = [];
              runtime.sessionArchive.set(result.sessionID, archive);
            }
            archive.push(result);
          }
        }
      }
      // Hydrate pending intents across restarts. Only restore intents for active, non-terminal
      // goals whose run ID matches. Revision check validates against pre-recovery snapshot.
      const snapshotRevisionByGoalId = new Map<string, number>();
      for (const g of initialState.goals as unknown as Array<
        Record<string, unknown>
      >) {
        const gid = String((g as {goalId?: unknown}).goalId ?? '');
        if (gid)
          snapshotRevisionByGoalId.set(
            gid,
            typeof (g as {revision?: unknown}).revision === 'number'
              ? (
                  g as {
                    revision: number;
                  }
                ).revision
              : 0,
          );
      }
      const pendingById = new Map<
        string,
        {machine: GoalStateMachine; sessionID: string}
      >();
      for (const [sid, machines] of runtime.sessionGoals) {
        for (const m of machines)
          pendingById.set(m.state.goalId, {machine: m, sessionID: sid});
      }
      const recovered =
        (
          initialState as PersistedState & {
            pendingIntents?: SerializedPendingIntent[];
          }
        ).pendingIntents ?? [];
      for (const raw of recovered) {
        const goalId = String((raw as {goalId?: unknown}).goalId ?? '');
        const sessionID = String(
          (raw as {sessionID?: unknown}).sessionID ?? '',
        );
        const targetStatus = String(
          (raw as {targetStatus?: unknown}).targetStatus ?? '',
        );
        if (targetStatus !== 'complete' && targetStatus !== 'blocked') continue;
        if (!goalId || !sessionID) continue;
        const entry = pendingById.get(goalId);
        if (!entry) continue;
        if (entry.sessionID !== sessionID) continue;
        const live = entry.machine.snapshot();
        if (live.sessionID !== sessionID) continue;
        if (live.goalId !== goalId) continue;
        if (entry.machine.isTerminal()) continue;
        const storedRevision =
          typeof (raw as {revision?: unknown}).revision === 'number'
            ? (
                raw as {
                  revision: number;
                }
              ).revision
            : -1;
        const storedRunId = String((raw as {runId?: unknown}).runId ?? '');
        if (live.runId !== storedRunId) continue;
        const snapshotRevision = snapshotRevisionByGoalId.get(goalId);
        const isValidPreRecovery =
          snapshotRevision === undefined
            ? storedRevision === live.revision
            : storedRevision === snapshotRevision;
        if (!isValidPreRecovery) {
          // Stale intent: retain stale revision so the validator drops it upon idle re-check.
          const staleIntent: PendingIntent = {
            goalId,
            revision: storedRevision,
            runId: storedRunId,
            messageID: String((raw as {messageID?: unknown}).messageID ?? ''),
            toolCallID: String(
              (raw as {toolCallID?: unknown}).toolCallID ?? '',
            ),
            targetStatus: targetStatus as PendingIntent['targetStatus'],
            evidence: String((raw as {evidence?: unknown}).evidence ?? ''),
            createdAt:
              typeof (raw as {createdAt?: unknown}).createdAt === 'number'
                ? (
                    raw as {
                      createdAt: number;
                    }
                  ).createdAt!
                : Date.now(),
          };
          runtime.pendingIntents.set(`${sessionID}:${goalId}`, staleIntent);
          continue;
        }
        // Account for expected revision increments: +1 from recovery pause, +1 from authentic-idle re-arm.
        const willBeRecoveryPaused =
          live.status === 'active' ||
          live.finalizing === true ||
          live.continuationClaim !== null;
        const targetRevision = willBeRecoveryPaused
          ? snapshotRevisionByGoalId.get(goalId)! + 2
          : live.revision;
        const intent: PendingIntent = {
          goalId,
          revision: targetRevision,
          runId: live.runId,
          messageID: String((raw as {messageID?: unknown}).messageID ?? ''),
          toolCallID: String((raw as {toolCallID?: unknown}).toolCallID ?? ''),
          targetStatus: targetStatus as PendingIntent['targetStatus'],
          evidence: String((raw as {evidence?: unknown}).evidence ?? ''),
          createdAt:
            typeof (raw as {createdAt?: unknown}).createdAt === 'number'
              ? (
                  raw as {
                    createdAt: number;
                  }
                ).createdAt!
              : Date.now(),
        };
        runtime.pendingIntents.set(`${sessionID}:${goalId}`, intent);
      }
      for (const {goal} of recoveredGoals) {
        // Active goals are paused on recovery; transient execution claims are reset.
        if (
          goal.status === 'active' ||
          goal.finalizing ||
          goal.continuationClaim
        ) {
          const session = runtime.sessionGoals
            .get(goal.sessionID)
            ?.find(m => m.state.goalId === goal.goalId);
          if (!session) continue;
          await session.mutate(
            g => {
              if (g.status === 'active') {
                g.status = 'paused' as import('./state-machine.ts').GoalStatus;
                g.pausedAt = Date.now();
                g.stopReason = 'recovery';
                g.lastStatus = 'Recovered after restart (paused).';
              }
              g.finalizing = false;
              g.continuationClaim = null;
            },
            {source: 'recovery', detail: 'Loaded from persisted state'},
          );
          runtime.recoveryPendingSessions.add(goal.sessionID);
        }
      }
    }

    // Session API adapter setup (defensive stub for headless/test environments).
    let sessionApi: OpenCodeSessionApi;
    const clientWithSession = context.client as {session?: unknown} | undefined;
    if (
      clientWithSession?.session &&
      typeof clientWithSession.session === 'object'
    ) {
      sessionApi = createOpenCodeSessionApi(context.client, {
        preferredShape: pluginOptions.sdkShape === 'flat' ? 'flat' : 'legacy',
      });
    } else {
      sessionApi = {
        messages: async () => [],
        promptAsync: async () => ({}),
        createChild: async () => ({}),
        prompt: async () => ({}),
        update: async () => ({}),
        get: async () => ({}),
        delete: async () => ({}),
        abort: async () => ({}),
      };
    }

    const loopPolicyOptions: LoopPolicyOptions = {
      noProgressTokenThreshold: defaultOpts.noProgressTokenThreshold,
      noProgressTurnsBeforePause: defaultOpts.noProgressTurnsBeforePause,
      noToolCallTurnsBeforePause: defaultOpts.noToolCallTurnsBeforePause,
      budgetWrapupRatio: defaultOpts.budgetWrapupRatio,
    };
    const loopPolicy = await loadLoopPolicy(
      pluginOptions.loopPolicyPath ?? null,
      loopPolicyOptions,
    );

    // Completion claims require verifier attestation. A judge model is enabled by default
    // unless explicitly disabled with `childSessionJudge: false`.
    const judgeEnabled = pluginOptions.childSessionJudge !== false;
    let verifierRegistrationReady = !judgeEnabled || registerAgents;
    const builtInJudge = judgeEnabled
      ? createChildSessionJudge(context.client, {
          ...(pluginOptions.judgeOptions ?? {}),
          agent: pluginOptions.verifierAgentName ?? 'goal-verify',
        })
      : null;
    const completionJudge: Judge | null =
      typeof pluginOptions.judge === 'function'
        ? pluginOptions.judge
        : builtInJudge
          ? ctx =>
              verifierRegistrationReady
                ? builtInJudge(ctx)
                : Promise.resolve({
                    approved: false,
                    reason:
                      'owned verifier agent registration was not confirmed',
                  })
          : null;

    const childSessionVerifier = judgeEnabled
      ? createChildSessionVerifier(context.client, {
          agent: pluginOptions.verifierAgentName ?? 'goal-verify',
          ...(pluginOptions.judgeOptions ?? {}),
        })
      : null;
    const configuredVerifier =
      typeof pluginOptions.judge === 'function'
        ? async (
            ctx: Parameters<NonNullable<typeof childSessionVerifier>>[0],
          ) => {
            const result = await pluginOptions.judge!({
              goal: ctx.goal,
              sessionID: ctx.goal.sessionID,
              latestText: ctx.latestText,
            });
            return {
              schema_version: 1 as const,
              task_id: ctx.taskId,
              state: result.approved
                ? ('COMPLETE' as const)
                : ('WORKING' as const),
              candidate: ctx.candidateIdentity.candidate,
              fingerprint: ctx.candidateIdentity.fingerprint,
              outstanding: result.approved
                ? []
                : [
                    result.reason ||
                      'the configured verifier rejected completion',
                  ],
              evidence: [
                result.approved
                  ? 'the configured verifier approved completion'
                  : result.reason ||
                    'the configured verifier rejected completion',
              ],
            };
          }
        : childSessionVerifier;

    // Fallback contract bounds for CompletionGateDeps; individual goals maintain authoritative bounds.
    const recoveryConfig = {
      maxRecoveryTurns: defaultOpts.maxRecoveryTurns,
      maxUnchangedResults: defaultOpts.maxUnchangedResults,
    };

    // All execution verification is agent-driven via the judge; no shell or process commands are run.
    const runVerifier: CompletionGateDeps['runVerifier'] = async ctx => {
      const resolution = await resolveVerifier({
        cwd: ctx.cwd,
        judge: configuredVerifier,
      });

      if (resolution.kind === 'judge') {
        try {
          const verdict = await resolution.judge({
            cwd: ctx.cwd,
            taskId: ctx.goal.goalId,
            candidateIdentity: ctx.candidateIdentity,
            goal: ctx.goal,
            latestText: ctx.latestText,
          });
          return {verdict, checkPath: 'judge'};
        } catch (err) {
          return {
            failure: {
              kind: 'judge-error',
              error: err instanceof Error ? err.message : String(err),
            },
            checkPath: 'judge',
          };
        }
      }

      return {failure: {kind: 'unavailable'}, checkPath: 'none'};
    };

    const completionGate: CompletionGateDeps = {runVerifier, recoveryConfig};

    const goalMessagesEnabled = pluginOptions.goalMessages !== false;
    const goalMessenger = pluginOptions.goalMessenger
      ? pluginOptions.goalMessenger
      : (sessionID: string, text: string) =>
          defaultGoalMessenger(context.client, sessionID, text);
    const announceGoalDecision = async (
      sessionID: string,
      text: string,
    ): Promise<void> => {
      if (!goalMessagesEnabled) return;
      try {
        await goalMessenger(sessionID, text);
      } catch {
        // Notification delivery is best-effort.
      }
    };

    const getSessionContext = (
      sessionID: string,
    ): SessionContext | undefined => {
      if (!sessionID || typeof sessionID !== 'string' || !sessionID.trim())
        return undefined;
      // Enforce strict session isolation: contexts are immutable bounds to their specific sessionID.
      const ownedSessionID = sessionID.trim();
      return {
        sessionID: ownedSessionID,
        workspaceDirectory,
        getMachine: () => stateManager.getMachine(ownedSessionID),
        listMachines: () => stateManager.listMachines(ownedSessionID),
        listActiveGoals: () => stateManager.listActiveGoals(ownedSessionID),
        listArchivedResults: () =>
          stateManager.listArchivedResults(ownedSessionID),
        createGoal: (objective: string, options: CreateGoalOptions) => {
          return stateManager.createGoal(ownedSessionID, objective, {
            ...options,
            maxTokens: options.maxTokens ?? defaultOpts.maxTokens,
            maxTurns: options.maxTurns ?? defaultOpts.maxTurns,
            maxDurationMs: options.maxDurationMs ?? defaultOpts.maxDurationMs,
          });
        },
        replaceGoals: (objective: string, options: CreateGoalOptions) => {
          return stateManager.replaceGoals(ownedSessionID, objective, {
            ...options,
            maxTokens: options.maxTokens ?? defaultOpts.maxTokens,
            maxTurns: options.maxTurns ?? defaultOpts.maxTurns,
            maxDurationMs: options.maxDurationMs ?? defaultOpts.maxDurationMs,
          });
        },
        removeGoal: (
          goalId: string,
          caller?: import('./state-machine.ts').TransitionSource,
        ) => {
          runtime.pendingIntents.delete(`${ownedSessionID}:${goalId}`);
          return stateManager.removeGoal(ownedSessionID, goalId, caller);
        },
        clearSession: async () => {
          runtime.continuationControllers.get(ownedSessionID)?.abort();
          runtime.continuationControllers.delete(ownedSessionID);
          runtime.activeContinues.delete(ownedSessionID);
          runtime.promptInFlightSessions.delete(ownedSessionID);
          runtime.recoveryPendingSessions.delete(ownedSessionID);
          for (const key of [...runtime.pendingIntents.keys()]) {
            if (key.startsWith(`${ownedSessionID}:`))
              runtime.pendingIntents.delete(key);
          }
          await stateManager.clearSession(ownedSessionID);
        },
        getMachineById: (goalId: string) =>
          stateManager
            .listMachines(ownedSessionID)
            .find(m => m.state.goalId === goalId) ?? null,
        focusGoal: (goalId: string) =>
          stateManager.focusGoal(ownedSessionID, goalId),
        addOrderedSession: () => stateManager.addOrderedSession(ownedSessionID),
        isOrdered: () => stateManager.isOrdered(ownedSessionID),
        autoPromote: async () => {
          await stateManager.autoPromote(ownedSessionID);
        },
        beginSettlement: receipt => stateManager.beginSettlement(receipt),
        completeSettlement: goalId => stateManager.completeSettlement(goalId),
        setPendingIntent: (goalId: string, intent: PendingIntent | null) => {
          const key = `${ownedSessionID}:${goalId}`;
          if (intent) {
            runtime.pendingIntents.set(key, intent);
          } else {
            runtime.pendingIntents.delete(key);
          }
        },
        getPendingIntent: (goalId: string) =>
          runtime.pendingIntents.get(`${ownedSessionID}:${goalId}`) ?? null,
        getAllPendingIntents: () =>
          [...runtime.pendingIntents.entries()]
            .filter(([key]) => key.startsWith(`${ownedSessionID}:`))
            .map(([, intent]) => intent),
        persist: async () => stateManager.persist(ownedSessionID),
        isOwnedElsewhere: () => refusedSessions.has(ownedSessionID),
      };
    };

    const transitionReceipt = async (
      sessionID: string,
      before: GoalState | null,
      after: GoalState | null,
      source: 'user-command' | 'goal-command',
    ): Promise<{receipt: string; changed: boolean}> => {
      const changed =
        before === null
          ? after !== null
          : after === null ||
            before.goalId !== after.goalId ||
            before.runId !== after.runId ||
            before.revision !== after.revision ||
            before.status !== after.status ||
            before.condition !== after.condition;
      if (!changed || !after) return {receipt: '', changed};
      const receipt = [
        `[Goal transition receipt] source=${source}`,
        `session=${sessionID}`,
        `goal=${after.goalId}`,
        `run=${after.runId}`,
        `revision=${after.revision}`,
        `status=${after.status}`,
        `objective=${after.condition}`,
        'Authoritative state already changed. Do not call a lifecycle tool to repeat this transition; continue from this state or use a goal tool only for a deliberate, constrained action.',
      ].join(' ');
      const machine = stateManager.getMachine(sessionID);
      if (machine) {
        await machine.addNotice('user-intervention', receipt);
        await stateManager.persist(sessionID);
      }
      return {receipt, changed};
    };

    const kickoff = createKickoffWiring({
      runtime,
      stateManager,
      sessionApi: sessionApi as unknown as OpenCodeSessionApi,
      getSessionContext,
      transitionReceipt,
      commandName,
      registerCommand,
      kickoffDelayMs: pluginOptions.kickoffDelayMs,
    });
    const {kickoffTimers, scheduleKickoff} = kickoff;

    const hooks = createHooks({
      getSessionContext,
      getLoopPolicy: () => loopPolicy,
      commandName,
      sessionApi: sessionApi as unknown as SessionApi,
      logError,
      runtime,
      defaultOpts,
      announceGoalDecision,
      completionJudge,
      completionGate,
      verifierAvailability:
        Boolean(pluginOptions.judge) || Boolean(judgeEnabled && registerAgents)
          ? 'configured'
          : 'unavailable',
      workspaceDirectory,
      idlePoller: pluginOptions.idlePoller,
      idlePollerIntervalMs: pluginOptions.idlePollerIntervalMs,
      idleQuietMs: pluginOptions.idleQuietMs,
      idleGraceMs: pluginOptions.idleGraceMs,
      warnTurnsRemaining: pluginOptions.warnTurnsRemaining,
      warnDurationMsRemaining: pluginOptions.warnDurationMsRemaining,
      warnTokensRemaining: pluginOptions.warnTokensRemaining,
    });

    hooks['command.execute.before'] = kickoff.commandExecuteBefore;

    hooks.config = async (config: unknown) => {
      const configOptions: NativeGoalConfigOptions = {
        registerAgents,
        registerCommand,
        goalAgentName: pluginOptions.goalAgentName ?? 'goal',
        verifierAgentName: pluginOptions.verifierAgentName ?? 'goal-verify',
        requireVerifierOwnership: judgeEnabled,
        // When judge is enabled, verifier agent must be verified read-only even
        // if registerAgents is false, preventing inadvertent write permissions.
        verifierAgentAddressed: judgeEnabled,
        commandName,
      };
      applyNativeGoalConfig(config as OpenCodeConfig, configOptions);
      if (judgeEnabled && registerAgents) verifierRegistrationReady = true;
    };

    hooks['experimental.compaction.autocontinue'] = async (
      input: {sessionID?: string},
      output: {
        enabled?: boolean;
      },
    ) => {
      if (!input?.sessionID || !output) return;
      if (runtime.disposed) return;
      const machine = stateManager.getMachine(input.sessionID);
      if (!machine) return;
      const goal = machine.snapshot();
      if (goal.status === 'active' || goal.finalizing) {
        output.enabled = false;
      }
    };

    if (!registerCommand) {
      delete hooks['command.execute.before'];
    }

    if (registerTools) {
      const toolDefs = await createGoalToolDefinitions(getSessionContext);
      if (toolDefs) {
        hooks.tool = toolDefs as Record<string, unknown>;

        // Subcommand dispatch tunnel for OpenCode v2 compatibility. In v2, the
        // `command.execute.before` hook was dropped, so routing commands via a tool
        // provides deterministic control for both the agent and the TUI companion.
        let z: typeof import('zod') | null = null;
        try {
          z = await import('zod');
        } catch {
          /* Zod unavailable — proceed with permissive schema */
        }
        (hooks.tool as Record<string, unknown>)['goal-command'] = {
          description:
            'Execute a goal workflow subcommand: `status`, `list`, `history`, `clear`, `pause`, ' +
            '`resume`, `edit <objective>`, `checkpoint <summary>`, `focus <goal_id>`, `add <objective>`, ' +
            'or `sequence <objective-a; objective-b>`. Prefer the dedicated goal tools (create_goal, ' +
            'update_goal, focus_goal, list_goals, get_goal) when the operation has one; use this tool ' +
            'for the lifecycle operations that do not (pause/resume/clear/edit/checkpoint/sequence).',
          args: z
            ? {
                subcommand: z
                  .string()
                  .describe(
                    'The goal subcommand line, e.g. `add fix the tests`.',
                  ),
              }
            : {},
          execute: async (
            args: Record<string, unknown>,
            ctx: {sessionID: string},
          ) => {
            const sessionID = ctx?.sessionID ?? '';
            if (!sessionID)
              return 'Goal command requires an active session (no sessionID in the tool context).';
            if (typeof sessionID === 'string' && sessionID.trim()) {
              runtime.liveSessions.add(sessionID);
            }
            const session = getSessionContext(sessionID);
            if (!session) return 'No active goal session.';
            const sub =
              typeof args?.subcommand === 'string'
                ? args.subcommand.trim()
                : '';
            // Deduplicate executions when hosts invoke both the command hook and the tool.
            const duplicate = consumeCommandDispatch(sessionID, sub);
            if (duplicate) {
              return duplicate.receipt
                ? `${duplicate.result}\n\n${duplicate.receipt}`
                : duplicate.result;
            }
            const before = session.getMachine()?.snapshot() ?? null;
            const {handleCommand} = await import('./commands.ts');
            const result = await handleCommand(sub, session, commandName);
            const after = session.getMachine()?.snapshot() ?? null;
            const {receipt} = await transitionReceipt(
              sessionID,
              before,
              after,
              'goal-command',
            );
            const enteredActive =
              after !== null &&
              after.status === 'active' &&
              (before === null ||
                before.goalId !== after.goalId ||
                before.runId !== after.runId ||
                before.status !== 'active');
            if (enteredActive) {
              scheduleKickoff(sessionID, after.goalId, after.runId);
            }
            return receipt ? `${result}\n\n${receipt}` : result;
          },
        };
        runtime.threadToolsRegistered = true;
      }
    }

    (hooks as PluginHooks & {dispose?: () => Promise<void>}).dispose =
      async () => {
        if (runtime.disposed) return;
        runtime.disposed = true;
        runtime.recoveryPendingSessions.clear();
        for (const controller of runtime.continuationControllers.values())
          controller.abort();
        for (const timer of kickoffTimers.values()) clearTimeout(timer);
        kickoffTimers.clear();
        try {
          await stateManager.drainWalWrites();
        } catch {
          // Best-effort flush
        }
        try {
          await runtime.drainPersistence?.();
        } catch {
          // Best-effort flush
        }
        // Release session file locks to permit reacquisition upon reload.
        for (const lease of heldLeases.values()) {
          try {
            await lease.release();
          } catch {
            // Best-effort release
          }
        }
        heldLeases.clear();
        sessionOwnership.clear();
      };

    return hooks;
  });
}
