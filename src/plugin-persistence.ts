/**
 * Persistence wiring extracted from the GoalsPlugin composition root:
 * handles per-session lease acquisition (`prepareSession`), serialized state
 * persistence (`persistFn`), and startup recovery across all existing sessions.
 */

import {deserializeGoal, type PersistedState} from './persistence.ts';
import {
  initWalSeqFromLedger,
  recoverState,
  writeStateFile,
} from './persistence-wal.ts';
import {
  acquirePersistenceLease,
  type PersistenceLease,
} from './persistence-lease.ts';
import {
  assertContainedInStateRoot,
  listSessionIDs,
  sessionStatePaths,
} from './session-paths.ts';
import {MAX_STATE_FILE_BYTES, portableFileSize} from './fs-portable.ts';
import type {RuntimeState} from './session-runtime.ts';
import type {SessionStateManager} from './session-state-manager.ts';
import {mergeRecovered, type PluginOptions} from './plugin-options.ts';

export interface PersistenceWiring {
  prepareSession: (
    sessionID: string,
    opts?: {report?: boolean},
  ) => Promise<boolean>;
  persistFn: (sessionID?: string) => Promise<boolean>;
  unreadableSessions: Set<string>;
  refusedSessions: Map<string, string>;
  heldLeases: Map<string, PersistenceLease>;
  sessionOwnership: Map<string, Promise<boolean>>;
  initialState: PersistedState | undefined;
  initialStateError: unknown;
  invalidatedBySession: Map<string, string[]>;
  persistenceRecoveryFailed: boolean;
}

export async function createPersistenceWiring(args: {
  runtime: RuntimeState;
  persistState: boolean;
  stateRoot: string;
  pathsForSession: (sessionID: string) => {
    sessionDir: string;
    statePath: string;
    ledgerPath: string;
  };
  getStateManager: () => SessionStateManager;
  pluginOptions: PluginOptions;
  logError: (message: string, error?: unknown) => Promise<void>;
}): Promise<PersistenceWiring> {
  const {
    runtime,
    persistState,
    stateRoot,
    pathsForSession,
    getStateManager,
    pluginOptions,
  } = args;

  /**
   * Per-session lease acquisition promise, resolved lazily on first write.
   * Allows concurrent processes in the same worktree to read state; only a session
   * actively owned by a running process is declined. Same-PID reclaims avoid self-deadlock
   * when re-activating in-process.
   */
  const sessionOwnership = new Map<string, Promise<boolean>>();

  /**
   * Tracks the latest lease refusal reason per session. Refusals are not memoized,
   * allowing a session to become drivable if the previous owner releases or exits.
   */
  const refusedSessions = new Map<string, string>();

  /**
   * Prevents repeated error logging across consecutive write attempts for the same
   * refusal or ceiling condition.
   */
  const announcedRefusals = new Map<string, string>();

  // De-duplication keys for error reporting when file size ceilings are exceeded.
  const LEDGER_OVER_CEILING = 'ledger-over-ceiling';
  const SNAPSHOT_OVER_CEILING = 'snapshot-over-ceiling';

  /** Leases held by this process, released during disposal. */
  const heldLeases = new Map<string, PersistenceLease>();

  // State persistence writes are serialized via a promise chain to prevent race conditions.
  let persistChain = Promise.resolve(true);
  let persistenceRecoveryFailed = false;

  /**
   * Sessions whose state or ledger file exceeded size ceilings or failed to read.
   * Fenced individually so one oversized or unreadable session does not block others.
   */
  const unreadableSessions = new Set<string>();

  const persistFn = (sessionID?: string): Promise<boolean> => {
    if (runtime.disposed) return Promise.resolve(false);
    if (!persistState) return Promise.resolve(true);
    if (persistenceRecoveryFailed) return Promise.resolve(false);
    if (sessionID && unreadableSessions.has(sessionID))
      return Promise.resolve(false);
    if (!sessionID) return Promise.resolve(false);

    persistChain = persistChain
      .catch(() => false)
      .then(async () => {
        if (persistenceRecoveryFailed) return false;
        // Acquire lease and seed sequence counters on first write.
        if (persistState && !(await prepareSession(sessionID))) return false;
        const state = getStateManager().getPersistedState(sessionID);
        return writeStateFile(
          pathsForSession(sessionID).statePath,
          state.goals.map(g => deserializeGoal(g)),
          state.results,
          state.sessionOrdered,
          state.invalidatedGoalIds,
          state.pendingIntents,
          state.settlementReceipts,
          state.focusedGoalIds,
        );
      });
    return persistChain;
  };
  runtime.drainPersistence = () => persistChain.catch(() => false);

  /**
   * Prepares a session for writing by verifying size ceilings, seeding the WAL
   * sequence counter from the ledger, and acquiring a file lock lease.
   *
   * Refusals are not memoized so locks from terminated processes can be reclaimed.
   * Size ceiling violations are latched via `unreadableSessions` because ledgers
   * do not shrink at runtime without manual intervention.
   */
  const prepareSession = (
    sessionID: string,
    opts: {report?: boolean} = {},
  ): Promise<boolean> => {
    if (!persistState) return Promise.resolve(true);
    if (unreadableSessions.has(sessionID)) return Promise.resolve(false);

    const inFlight = sessionOwnership.get(sessionID);
    if (inFlight) return inFlight;

    const pending = (async (): Promise<boolean> => {
      // Validate paths and ensure containment before attempting I/O.
      const paths = pathsForSession(sessionID);
      try {
        // Enforce snapshot size ceiling to avoid truncating or overwriting valid large state.
        if ((await portableFileSize(paths.statePath)) > MAX_STATE_FILE_BYTES) {
          unreadableSessions.add(sessionID);
          sessionOwnership.delete(sessionID);
          if (
            opts.report !== false &&
            announcedRefusals.get(sessionID) !== SNAPSHOT_OVER_CEILING
          ) {
            announcedRefusals.set(sessionID, SNAPSHOT_OVER_CEILING);
            console.error(
              `[fixate-on] session ${sessionID}'s state file is larger than the plugin's read ceiling and was not ` +
                'read. Its goals, results and any pending completion were NOT recovered from it, and this host ' +
                'will not write over it — the file on disk is intact and is the only copy of those fields. ' +
                'No option raises this ceiling. Lower maxStoredResults to shrink what a session accumulates, or ' +
                `trim the file by hand (state root ${stateRoot}).`,
            );
          }
          return false;
        }

        // Initialize WAL sequence numbers from the ledger before acquiring lease to prevent seq collision.
        const partialView = await initWalSeqFromLedger(
          paths.ledgerPath,
          pluginOptions.ledgerRetentionFiles,
        );
        if (partialView) {
          unreadableSessions.add(sessionID);
          sessionOwnership.delete(sessionID);
          if (
            opts.report !== false &&
            announcedRefusals.get(sessionID) !== LEDGER_OVER_CEILING
          ) {
            announcedRefusals.set(sessionID, LEDGER_OVER_CEILING);
            console.error(
              `[fixate-on] session ${sessionID}'s goal ledger is larger than the plugin's read ceiling and was ` +
                'not read. Its history is incomplete — the newest entries, including any removal, were NOT ' +
                'recovered — and this host will not write to it, because the sequence numbers come from that ' +
                'history and a number issued from a partial view is one the ledger already holds. ' +
                'The ledger itself is intact. Nothing this plugin does will rotate a ledger it has declined to ' +
                'read, so it has to shrink by hand: delete the rotated generations beside it, or move it aside ' +
                `(state root ${stateRoot}).`,
            );
          }
          return false;
        }

        heldLeases.set(
          sessionID,
          await acquirePersistenceLease(paths.statePath),
        );
        refusedSessions.delete(sessionID);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        refusedSessions.set(sessionID, message);

        // Only log if reporting is enabled and the owner/message changed.
        if (
          opts.report !== false &&
          announcedRefusals.get(sessionID) !== message
        ) {
          announcedRefusals.set(sessionID, message);
          console.error(
            `[fixate-on] goal persistence for session ${sessionID} is already owned by another process; ` +
              "this host will not write that session's file, and goal state there will not advance. " +
              message,
          );
        }

        // Dead owner locks can be reclaimed on subsequent attempts; do not memoize failures.
        sessionOwnership.delete(sessionID);
        refusedSessions.set(sessionID, message);
        return false;
      }
    })();

    sessionOwnership.set(sessionID, pending);
    return pending;
  };

  let initialState: PersistedState | undefined;
  let initialStateError: unknown;

  // Tracks invalidated goal IDs per session so tombstones remain attributed to their origin session.
  const invalidatedBySession = new Map<string, string[]>();

  if (persistState) {
    try {
      // Scan all sessions in stateRoot to recover goals for sessions that may be resumed.
      for (const sessionID of await listSessionIDs(stateRoot)) {
        const paths = sessionStatePaths(stateRoot, sessionID);

        // Verify session paths stay strictly within stateRoot to prevent traversal attacks.
        try {
          assertContainedInStateRoot(stateRoot, paths.sessionDir);
          assertContainedInStateRoot(stateRoot, paths.statePath);
          assertContainedInStateRoot(stateRoot, paths.ledgerPath);
        } catch (error) {
          console.error(
            `[fixate-on] session ${sessionID}'s goal state is outside the state root and was not read or written: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        // Read snapshot and replay WAL entries without holding a lease (read-only phase).
        const recovered = await recoverState(
          paths.statePath,
          paths.ledgerPath,
          pluginOptions.ledgerRetentionFiles,
        );

        // If the state file exceeds read limits, fence this session to prevent overwriting
        // durable state with an incomplete snapshot. Other sessions remain unaffected.
        if (recovered.snapshotOverCeiling) {
          console.error(
            `[fixate-on] session ${sessionID}'s state file is larger than the plugin's read ceiling and was not read. ` +
              'Its goals, results and any pending completion were NOT recovered from it, and this host will not write ' +
              'over it — the file on disk is intact and is the only copy of those fields. ' +
              'No option raises this ceiling. Lower maxStoredResults to shrink what a session ' +
              `accumulates, or trim the file by hand (state root ${stateRoot}).`,
          );
          unreadableSessions.add(sessionID);
        }

        // If the ledger exceeds read limits, fence writes so a partial WAL view does not overwrite
        // or re-issue existing sequence numbers.
        if (recovered.ledgerOverCeiling) {
          console.error(
            `[fixate-on] session ${sessionID}'s ledger is larger than the plugin's read ceiling and was only partly ` +
              'read — the newest entries, including any removal, were NOT seen. This host will not append to it or ' +
              'write its state file, because doing so would make a half-read ledger the new durable truth. ' +
              `The ledger itself is intact. Reduce it (the state root is ${stateRoot}) by letting rotation run — ` +
              'check that no rotated generation has become undeletable — or lower ledgerMaxBytes.',
          );
          unreadableSessions.add(sessionID);
        }

        // Only report lease acquisition failures on startup if the session has active work to pause.
        const startupWillWrite = recovered.goals.some(
          g => g.status === 'active' || g.finalizing || g.continuationClaim,
        );
        await prepareSession(sessionID, {report: startupWillWrite});

        // Filter all recovered entities by sessionID. Discard foreign records in untrusted disk state
        // to prevent cross-session contamination or phantom directory creation.
        const owned = recovered.goals.filter(
          goal => goal.sessionID === sessionID,
        );
        const ownedResults = recovered.results.filter(
          result => result.sessionID === sessionID,
        );
        const ownedSessionOrdered = recovered.sessionOrdered.filter(
          id => id === sessionID,
        );
        const ownedFocus = recovered.focusedGoalIds.filter(
          p => p.sessionID === sessionID,
        );
        const ownedReceipts = recovered.settlementReceipts.filter(
          r => r.sessionID === sessionID,
        );
        const ownedIntents = recovered.pendingIntents.filter(
          intent => intent.sessionID === sessionID,
        );

        for (const stray of recovered.goals.filter(
          goal => goal.sessionID !== sessionID,
        )) {
          // Log discarded foreign goals without adding to `refusedSessions`, which is reserved
          // for active ownership lease contention.
          console.error(
            `[fixate-on] a goal in session ${sessionID}'s file names session ${stray.sessionID}; ` +
              "it was not loaded, because loading it would create that session's directory and write to it. " +
              'The rest of this file was loaded normally.',
          );
        }

        initialState = mergeRecovered(initialState, {
          ...recovered,
          goals: owned,
          results: ownedResults,
          sessionOrdered: ownedSessionOrdered,
          focusedGoalIds: ownedFocus,
          settlementReceipts: ownedReceipts,
          pendingIntents: ownedIntents,
        });
        invalidatedBySession.set(sessionID, recovered.invalidatedGoalIds);
      }
    } catch (error) {
      // If recovery fails catastrophically, fence all future writes to prevent
      // overwriting durable on-disk state with empty snapshots.
      initialStateError = error;
      persistenceRecoveryFailed = true;
    }
  }

  return {
    prepareSession,
    persistFn,
    unreadableSessions,
    refusedSessions,
    heldLeases,
    sessionOwnership,
    initialState,
    initialStateError,
    invalidatedBySession,
    persistenceRecoveryFailed,
  };
}
