/**
 * Command-dispatch seam for v1 hosts.
 *
 * Manages the delayed kickoff probe (`scheduleKickoff` and timer registry) and
 * the `command.execute.before` hook that processes commands and schedules
 * continuation prompts when goals become active.
 */

import {markCommandDispatch, markSlashDispatch} from './command-dispatch.ts';
import {buildContinueMessage} from './steering.ts';
import {
  normalizeInheritedAgentForPrompt,
  stripAgentListSortPrefix,
} from './agent-resolve.ts';
import {findLatestAssistantMessage, getMessageID} from './message-helpers.ts';
import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';
import type {SessionContext} from './hooks-types.ts';
import type {RuntimeState} from './session-runtime.ts';
import type {SessionStateManager} from './session-state-manager.ts';
import type {OpenCodeSessionApi} from './session-api.ts';
import type {GoalState} from './state-machine.ts';

export interface KickoffWiring {
  kickoffTimers: Map<string, ReturnType<typeof setTimeout>>;
  clearKickoffTimer: (sessionID: string) => void;
  scheduleKickoff: (sessionID: string, goalId: string, runId: string) => void;
  commandExecuteBefore: (
    input: {sessionID?: string; command?: string; arguments?: string},
    output: {parts: unknown[]},
  ) => Promise<void>;
}

export function createKickoffWiring(args: {
  runtime: RuntimeState;
  stateManager: SessionStateManager;
  sessionApi: OpenCodeSessionApi;
  getSessionContext: (sessionID: string) => SessionContext | undefined;
  transitionReceipt: (
    sessionID: string,
    before: GoalState | null,
    after: GoalState | null,
    source: 'user-command' | 'goal-command',
  ) => Promise<{receipt: string; changed: boolean}>;
  commandName: string;
  registerCommand: boolean;
  kickoffDelayMs?: number;
}): KickoffWiring {
  const {
    runtime,
    stateManager,
    sessionApi,
    getSessionContext,
    transitionReceipt,
    commandName,
    registerCommand,
    kickoffDelayMs,
  } = args;

  // On v1 hosts, `command.execute.before` intercepts execution before command
  // templates run, and /goal is registered without an agent to keep output user-visible.
  // Because no model turn is launched, `session.idle` does not fire and the continuation
  // loop would not wake automatically.
  //
  // To ensure continuation parity, schedule a delayed kickoff probe when a goal enters
  // active status. The kickoff sends an initial continuation prompt unless an agent turn
  // materialized in the interim. (v2 routes commands via templates and does not use this hook.)
  const kickoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearKickoffTimer = (sessionID: string): void => {
    const t = kickoffTimers.get(sessionID);
    if (t !== undefined) {
      clearTimeout(t);
      kickoffTimers.delete(sessionID);
    }
  };
  const scheduleKickoff = (
    sessionID: string,
    goalId: string,
    runId: string,
  ): void => {
    if (!sessionID) return;
    clearKickoffTimer(sessionID);
    const delayMs = kickoffDelayMs ?? 2500;
    // Capture the baseline assistant message ID at scheduling time.
    // The kickoff should only proceed if no new assistant message appeared
    // (indicating an active agent turn whose idle event will drive the loop).
    const lastAssistantIdOf = (messages: unknown[]): string | null => {
      if (!Array.isArray(messages)) return null;
      // Use latest assistant message regardless of array ordering (v1 returns messages
      // ascending, whereas v2 returns them descending).
      const latest = findLatestAssistantMessage(messages);
      return latest ? getMessageID(latest) : '';
    };
    const baselinePromise: Promise<string | null> = sessionApi
      .messages(sessionID, {limit: 5})
      .then(r => lastAssistantIdOf(Array.isArray(r) ? r : []))
      .catch(() => null);
    const timer = setTimeout(
      () => {
        kickoffTimers.delete(sessionID);
        if (runtime.disposed) return;
        // Ensure the session is still eligible to be driven. A fenced session (e.g. read ceiling
        // reached or leased by another process) must not be prompted or execute work.
        if (!runtime.canDriveSession?.(sessionID)) return;
        if (runtime.promptInFlightSessions.has(sessionID)) return;
        const machineNow = stateManager.getMachine(sessionID);
        if (!machineNow) return;
        const snap = machineNow.snapshot();
        if (
          snap.goalId !== goalId ||
          snap.runId !== runId ||
          snap.status !== 'active'
        )
          return;
        void (async () => {
          try {
            const [baseline, recent] = await Promise.all([
              baselinePromise,
              sessionApi.messages(sessionID, {limit: 5}).catch(() => null),
            ]);
            const freshId = lastAssistantIdOf(
              Array.isArray(recent) ? recent : [],
            );
            // Skip if a new assistant message appeared since dispatch, meaning an agent turn
            // materialized and its idle event will take over driving continuation.
            if (
              freshId !== null &&
              baseline !== null &&
              freshId !== '' &&
              freshId !== baseline
            )
              return;
          } catch {
            // If fetching messages fails, proceed with kickoff; continuation claims and
            // in-flight guards provide fallback deduplication.
          }
          const machineAtFire = stateManager.getMachine(sessionID);
          if (!machineAtFire || runtime.disposed) return;
          // Re-check after async calls in case the session fence was established during message retrieval.
          if (!runtime.canDriveSession?.(sessionID)) return;
          const fireSnap = machineAtFire.snapshot();
          if (
            fireSnap.goalId !== goalId ||
            fireSnap.runId !== runId ||
            fireSnap.status !== 'active'
          )
            return;
          let message: string = buildContinueMessage(fireSnap, {});
          if (typeof message !== 'string') message = String(message ?? '');
          const resolvedAgent = normalizeInheritedAgentForPrompt(
            fireSnap.executionContext?.agent,
          );
          const promptInput: Record<string, unknown> = {
            parts: [
              {
                type: 'text',
                text: message,
                metadata: {[GOAL_TUI_METADATA_KEY]: {kind: 'kickoff'}},
                synthetic: true,
              },
            ],
          };
          if (resolvedAgent)
            promptInput.agent = stripAgentListSortPrefix(resolvedAgent);
          runtime.promptInFlightSessions.add(sessionID);
          try {
            await sessionApi.promptAsync(
              sessionID,
              promptInput as unknown as {
                parts: unknown[];
              } & Record<string, unknown>,
            );
          } catch {
            // If the prompt fails, subsequent idle events or explicit resumes can retry.
          } finally {
            runtime.promptInFlightSessions.delete(sessionID);
          }
        })();
      },
      Math.max(0, delayMs),
    );
    kickoffTimers.set(sessionID, timer);
    // Avoid holding the Node.js event loop open for delayed kickoff probes.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as {unref: () => void}).unref();
    }
  };

  const commandExecuteBefore = async (
    input: {sessionID?: string; command?: string; arguments?: string},
    output: {parts: unknown[]},
  ): Promise<void> => {
    if (!input || !input.command || !output) return;
    if (runtime.disposed) return;
    if (
      typeof input.arguments !== 'string' &&
      input.arguments !== undefined &&
      input.arguments !== null
    ) {
      output.parts = [
        {type: 'text', text: 'Goal command arguments must be text.'},
      ];
      return;
    }
    const cmd = input.command.trim();
    let commandArgs = '';
    if (cmd === commandName) {
      commandArgs =
        typeof input.arguments === 'string' ? input.arguments.trim() : '';
    } else if (cmd.startsWith(`${commandName} `)) {
      const sub = cmd.slice(commandName.length + 1).trim();
      const extra =
        typeof input.arguments === 'string' ? input.arguments.trim() : '';
      commandArgs = extra ? `${sub} ${extra}` : sub;
    } else {
      return;
    }
    const args = commandArgs.trim();
    const sessionID = input.sessionID ?? '';
    if (typeof sessionID === 'string' && sessionID.trim()) {
      runtime.liveSessions.add(sessionID);
    }

    const session = getSessionContext(sessionID);
    if (!session) {
      output.parts = [
        {
          type: 'text',
          text:
            'No active goal. Set one with `/' + commandName + ' <condition>`.',
        },
      ];
      return;
    }

    const beforeMachine = session.getMachine();
    const before = beforeMachine?.snapshot() ?? null;
    // Mark slash dispatch so that v1 replaying the command as a chat message can be suppressed.
    markSlashDispatch(sessionID, args);

    const subcmd = args.toLowerCase().split(/\s+/)[0];
    const {handleCommand, formatCommandHeader} = await import('./commands.ts');
    try {
      const text = await handleCommand(args, session, commandName);
      const afterCommand = session.getMachine()?.snapshot() ?? null;
      const {receipt, changed: dispatchChanged} = await transitionReceipt(
        sessionID,
        before,
        afterCommand,
        'user-command',
      );
      // Record dispatch to prevent duplicate mutations if the host also invokes the command template.
      markCommandDispatch(sessionID, args, text, receipt, dispatchChanged);
      const header = formatCommandHeader(runtime.hasTuiCompanion, subcmd);
      output.parts = [
        {
          type: 'text',
          text: `${header}\n${text}${receipt ? `\n\n${receipt}` : ''}`,
        },
      ];
      // Trigger kickoff if this command transitioned the goal into an active status.
      const afterMachine = session.getMachine();
      const after = afterMachine?.snapshot() ?? null;
      const enteredActive =
        after !== null &&
        after.status === 'active' &&
        (before === null ||
          before.goalId !== after.goalId ||
          before.runId !== after.runId ||
          before.status !== 'active');
      if (enteredActive && registerCommand) {
        scheduleKickoff(sessionID, after!.goalId, after!.runId);
      }
    } catch (err) {
      output.parts = [
        {
          type: 'text',
          text:
            'Goal command error: ' +
            (err instanceof Error ? err.message : String(err)),
        },
      ];
    }
  };

  return {
    kickoffTimers,
    clearKickoffTimer,
    scheduleKickoff,
    commandExecuteBefore,
  };
}
