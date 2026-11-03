/**
 * Contract tests for the claim/check/outcome triad:
 * - Claim/Check/Outcome triad under Source-of-Check law
 * - Cold-reader classification without transcripts
 * - Evidentiary labeling across status, state file, and TUI snapshot
 * - Invariant: unverifiable-claim never displays as plain complete
 * - Exact mapping from every gate branch to exactly one triad outcome
 * - Round-trip persistence and recovery
 */

import {afterEach, beforeEach, describe, expect, it} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  type ClaimRecord,
  createGoalState,
  type GoalState,
  GoalStateMachine,
  type PendingIntent,
} from '../src/state-machine.ts';
import {deserializeGoal, serializeGoal} from '../src/persistence.ts';
import {recoverState, writeStateFile} from '../src/persistence-wal.ts';
import {formatStatus} from '../src/commands.ts';
import {serializeGoalForTui} from '../src/tui-state.ts';
import {
  createHooks,
  type HookDeps,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import type {CompletionGateDeps} from '../src/completion-gate-run.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {STUB_IDENTITY_DEP} from './identity-stub.ts';
import type {CreateGoalOptions} from '../src/tools.ts';

function makeUsage(partial: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    input: 1000,
    output: 500,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
    ...partial,
  };
}

/**
 * Isolated working directory for test goals. Candidate-identity capture invokes
 * git commands; without an explicit hermetic cwd, it runs across the root
 * repository, causing high latency under load and test flakes dependent on repo size.
 */
let hermeticCwd = process.cwd();

function setHermeticCwd(dir: string): void {
  hermeticCwd = dir;
}

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  const goal = createGoalState('session-1', 'Build the feature', {
    goalId: 'goal-1',
    runId: 'run-1',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
    // Set delay to 0 to prevent artificial sleep during continuation paths,
    // ensuring fast and deterministic test runs.
    minDelayMs: 0,
  });
  return {
    ...goal,
    usage: makeUsage(),
    executionContext: {
      agent: 'test',
      model: 'test',
      provider: 'test',
      cwd: hermeticCwd,
    },
    ...overrides,
  };
}

function makeMockSessionApi(opts: {messages?: unknown[]} = {}): SessionApi & {
  promptsSent: string[];
} {
  const promptsSent: string[] = [];
  return {
    promptsSent,
    messages: async () => opts.messages ?? [],
    promptAsync: async (_id, input) => {
      const parts = (input as {parts?: Array<{text?: string}>}).parts;
      if (parts && parts[0]?.text) {
        promptsSent.push(parts[0].text);
      }
      return {};
    },
    abort: async () => ({}),
  };
}

function makeSessionContext(
  opts: {
    machine?: GoalStateMachine | null;
    activeGoals?: GoalState[];
    removedGoalIds?: string[];
    pendingIntent?: PendingIntent | null;
    persistResult?: boolean;
  } = {},
): SessionContext {
  const machine = opts.machine ?? null;
  const activeGoals = opts.activeGoals ?? (machine ? [machine.snapshot()] : []);
  const removedGoalIds = opts.removedGoalIds ?? [];
  const pendingIntents = new Map<string, PendingIntent>();
  if (opts.pendingIntent && opts.machine) {
    pendingIntents.set(opts.machine.snapshot().goalId, opts.pendingIntent);
  }

  return {
    sessionID: 'session-1',
    getMachine: () => machine,
    listActiveGoals: () => activeGoals,
    listArchivedResults: () => [],
    createGoal: (_objective: string, _options: CreateGoalOptions) =>
      new GoalStateMachine(makeGoal(), {
        onCommit: async () => {},
      }),
    replaceGoals: async (_objective: string, _options: CreateGoalOptions) =>
      new GoalStateMachine(makeGoal(), {
        onCommit: async () => {},
      }),
    removeGoal: async (goalId: string) => {
      removedGoalIds.push(goalId);
    },
    clearSession: () => {},
    focusGoal: async () => ({ok: false as const, reason: 'not-found' as const}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    setPendingIntent: (goalId: string, intent: PendingIntent | null) => {
      if (intent) pendingIntents.set(goalId, intent);
      else pendingIntents.delete(goalId);
    },
    getPendingIntent: (goalId: string) => pendingIntents.get(goalId) ?? null,
    getAllPendingIntents: () => Object.values(pendingIntents),
    persist: async () => opts.persistResult ?? true,
  };
}

function makeDeps(
  overrides: {
    session?: SessionContext;
    sessionApi?: SessionApi;
    completionGate?: CompletionGateDeps | null;
    completionJudge?: HookDeps['completionJudge'];
  } = {},
): HookDeps {
  const session = overrides.session ?? makeSessionContext();
  const sessionApi = overrides.sessionApi ?? makeMockSessionApi();
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    idlePoller: false,
    sessionApi,
    logError: async () => {},
    // Use stubbed identity capture to avoid spawning git processes during test runs.
    completionGate:
      overrides.completionGate !== undefined &&
      overrides.completionGate !== null
        ? {...STUB_IDENTITY_DEP, ...overrides.completionGate}
        : (overrides.completionGate ?? null),
    completionJudge: overrides.completionJudge ?? null,
  };
}

describe('Claim Ledger: Claim/Check/Outcome Triad under Source-of-Check Law', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'v2-test-'));
    setHermeticCwd(testDir);
  });

  afterEach(() => {
    try {
      rmSync(testDir, {recursive: true, force: true});
    } catch {
      // Ignored: temporary test directory may already be cleaned up
    }
  });

  // 1. Cold-Reader Classification: 3 Distinct Ways an Agent Claims Done

  it('records distinguishable claim records that a cold reader can classify from state alone without transcripts', async () => {
    // Simulate three distinct claim outcomes on a single state machine over time:
    // 1. Verifier refutes (state: WORKING) -> outcome: claim-refuted
    // 2. Verifier passes (state: COMPLETE) -> outcome: verified-complete
    // 3. No verifier exists (abstain)      -> outcome: unverifiable-claim

    const machine = new GoalStateMachine(makeGoal({goalId: 'goal-triad'}), {
      onCommit: async () => {},
    });

    // Step 1: Agent claims complete, verifier refutes
    const session1 = makeSessionContext({machine});
    const mockApi1 = makeMockSessionApi({
      messages: [
        {
          role: 'assistant',
          id: 'msg-1',
          parts: [{type: 'text', text: 'I finished implementing the tests.'}],
        },
      ],
    });
    const gateRefute: CompletionGateDeps = {
      runVerifier: async ({candidateIdentity}) => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-triad',
          state: 'WORKING',
          candidate: candidateIdentity.candidate,
          fingerprint: candidateIdentity.fingerprint,
          outstanding: ['3 tests failing in test/math.test.ts'],
          evidence: ['bun test failed with exit code 1'],
        },
        checkPath: 'judge',
        checkTarget: 'bun test',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const deps1 = makeDeps({
      session: session1,
      sessionApi: mockApi1,
      completionGate: gateRefute,
    });
    const hooks1 = createHooks(deps1);

    session1.setPendingIntent('goal-triad', {
      goalId: 'goal-triad',
      revision: machine.currentRevision,
      runId: 'run-1',
      messageID: 'msg-1',
      toolCallID: 'call-1',
      targetStatus: 'complete',
      evidence: 'all tests pass',
      createdAt: Date.now(),
    });
    await hooks1.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-1',
    });

    // Step 2: Agent attempts completion again, verifier passes
    const gatePass: CompletionGateDeps = {
      runVerifier: async ({candidateIdentity}) => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-triad',
          state: 'COMPLETE',
          candidate: candidateIdentity.candidate,
          fingerprint: candidateIdentity.fingerprint,
          outstanding: [],
          evidence: ['bun test passed (42 tests pass)'],
        },
        checkPath: 'judge',
        checkTarget: 'bun test',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const deps2 = makeDeps({
      session: session1,
      sessionApi: mockApi1,
      completionGate: gatePass,
    });
    const hooks2 = createHooks(deps2);

    session1.setPendingIntent('goal-triad', {
      goalId: 'goal-triad',
      revision: machine.currentRevision,
      runId: 'run-1',
      messageID: 'msg-2',
      toolCallID: 'call-2',
      targetStatus: 'complete',
      evidence: 'fixed the 3 tests',
      createdAt: Date.now(),
    });
    await hooks2.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-2',
    });

    const snap = machine.snapshot();
    expect(snap.claims.length).toBe(2);

    // Verify refuted claim record
    const c0 = snap.claims[0];
    expect(c0.claimedStatus).toBe('complete');
    expect(c0.check.path).toBe('judge');
    expect(c0.check.target).toBe('bun test');
    expect(c0.check.verdict).toBe('WORKING');
    expect(c0.outcome.status).toBe('claim-refuted');
    expect(c0.outcome.detail).toContain('3 tests failing');

    // Verify accepted claim record
    const c1 = snap.claims[1];
    expect(c1.claimedStatus).toBe('complete');
    expect(c1.check.path).toBe('judge');
    expect(c1.check.target).toBe('bun test');
    expect(c1.check.verdict).toBe('COMPLETE');
    expect(c1.outcome.status).toBe('verified-complete');
    expect(snap.lastClaim).toEqual(c1);

    // Step 3: Run goal with no verifier available (abstain)
    const machineAbstain = new GoalStateMachine(
      makeGoal({goalId: 'goal-no-verifier'}),
      {
        onCommit: async () => {},
      },
    );
    const sessionAbstain = makeSessionContext({machine: machineAbstain});
    const gateAbstain: CompletionGateDeps = {
      runVerifier: async () => ({
        failure: {kind: 'unavailable'},
        checkPath: 'none',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const depsAbstain = makeDeps({
      session: sessionAbstain,
      completionGate: gateAbstain,
      completionJudge: null,
    });
    const hooksAbstain = createHooks(depsAbstain);

    sessionAbstain.setPendingIntent('goal-no-verifier', {
      goalId: 'goal-no-verifier',
      revision: machineAbstain.currentRevision,
      runId: 'run-1',
      messageID: 'msg-3',
      toolCallID: 'call-3',
      targetStatus: 'complete',
      evidence: 'done with task',
      createdAt: Date.now(),
    });
    await hooksAbstain.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-3',
    });

    const snapAbstain = machineAbstain.snapshot();
    expect(snapAbstain.claims.length).toBe(1);
    const cAbstain = snapAbstain.claims[0];
    expect(cAbstain.claimedStatus).toBe('complete');
    expect(cAbstain.check.path).toBe('none');
    expect(cAbstain.check.verdict).toBe('NONE');
    expect(cAbstain.outcome.status).toBe('unverifiable-claim');
    expect(snapAbstain.lastClaim).toEqual(cAbstain);

    // Ensure all 3 records across the goals yield mutually distinct, deterministic outcomes
    const allRecords: ClaimRecord[] = [...snap.claims, ...snapAbstain.claims];
    const outcomes = allRecords.map(r => r.outcome.status);
    expect(outcomes).toEqual([
      'claim-refuted',
      'verified-complete',
      'unverifiable-claim',
    ]);
  });

  // 2. Display Invariant: Unverifiable-Claim NEVER Displays as Plain Complete

  it('never displays unverifiable-claim as plain complete in state file, /goal status, and TUI snapshot', async () => {
    const machine = new GoalStateMachine(
      makeGoal({goalId: 'goal-unverified'}),
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext({machine});
    const gateAbstain: CompletionGateDeps = {
      runVerifier: async () => ({
        failure: {kind: 'unavailable'},
        checkPath: 'none',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const deps = makeDeps({session, completionGate: gateAbstain});
    const hooks = createHooks(deps);

    session.setPendingIntent('goal-unverified', {
      goalId: 'goal-unverified',
      revision: machine.currentRevision,
      runId: 'run-1',
      messageID: 'msg-1',
      toolCallID: 'call-1',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'idle-u1',
    });

    const snapshot = machine.snapshot();

    // The ledger retains the precise machine status, while user-facing layers
    // use qualified terminology ("unattested") instead of bare completion.
    expect(snapshot.stopReason).toContain(
      'completion verification unavailable',
    );
    expect(snapshot.lastClaim?.outcome.status).toBe('unverifiable-claim');

    // Verify /goal status output explicitly qualifies the unverified claim
    const statusOutput = formatStatus(snapshot, 'goal');
    expect(statusOutput).not.toBe('Goal (status: complete): Build the feature');
    expect(statusOutput).toContain('Last claim: [unattested]');
    expect(statusOutput).toContain('no attestation could be obtained');

    // Verify TUI snapshot preserves the exact evidentiary label and stop reason
    const tuiSnapshot = serializeGoalForTui(snapshot);
    expect(tuiSnapshot.claims?.length).toBe(1);
    expect(tuiSnapshot.lastClaim?.outcome.status).toBe('unverifiable-claim');
    expect(tuiSnapshot.stopReason).toContain(
      'completion verification unavailable',
    );
  });

  // 3. Contract Mapping: Every Gate Branch to Exactly One Triad Outcome

  it('maps settle-complete to verified-complete', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const session = makeSessionContext({machine});
    const gate: CompletionGateDeps = {
      runVerifier: async ({candidateIdentity}) => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'COMPLETE',
          candidate: candidateIdentity.candidate,
          fingerprint: candidateIdentity.fingerprint,
          outstanding: [],
          evidence: ['gmake completion-gate-json passed'],
        },
        checkPath: 'judge',
        checkTarget: 'gmake completion-gate-json',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const hooks = createHooks(makeDeps({session, completionGate: gate}));
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: 0,
      runId: 'run-1',
      messageID: 'm1',
      toolCallID: 'c1',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'i1',
    });

    const last = machine.snapshot().lastClaim!;
    expect(last.outcome.status).toBe('verified-complete');
    expect(last.check.path).toBe('judge');
    expect(last.check.verdict).toBe('COMPLETE');
  });

  it('maps recover (verifier WORKING) to claim-refuted', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const session = makeSessionContext({machine});
    const gate: CompletionGateDeps = {
      runVerifier: async ({candidateIdentity}) => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'WORKING',
          candidate: candidateIdentity.candidate,
          fingerprint: candidateIdentity.fingerprint,
          outstanding: ['unit tests failed'],
          evidence: ['assertion error in foo.test.ts'],
        },
        checkPath: 'judge',
        checkTarget: 'bun test',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const hooks = createHooks(makeDeps({session, completionGate: gate}));
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: 0,
      runId: 'run-1',
      messageID: 'm1',
      toolCallID: 'c1',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'i2',
    });

    const last = machine.snapshot().lastClaim!;
    expect(last.outcome.status).toBe('claim-refuted');
    expect(last.check.verdict).toBe('WORKING');
  });

  it('maps escalate (recovery exhausted) to claim-refuted', async () => {
    const machine = new GoalStateMachine(
      makeGoal({recoveryTurns: 12, maxRecoveryTurns: 12}),
      {
        onCommit: async () => {},
      },
    );
    const session = makeSessionContext({machine});
    const gate: CompletionGateDeps = {
      runVerifier: async ({candidateIdentity}) => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'WORKING',
          candidate: candidateIdentity.candidate,
          fingerprint: candidateIdentity.fingerprint,
          outstanding: ['still failing'],
          evidence: ['error'],
        },
        checkPath: 'judge',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const hooks = createHooks(makeDeps({session, completionGate: gate}));
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: 0,
      runId: 'run-1',
      messageID: 'm1',
      toolCallID: 'c1',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'i3',
    });

    const last = machine.snapshot().lastClaim!;
    expect(last.outcome.status).toBe('claim-refuted');
    expect(machine.snapshot().status).toBe('paused');
    expect(machine.snapshot().stopReason).toBe(
      'recovery exhausted (escalated)',
    );
  });

  it('maps settle-blocked to blocked-acknowledged', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const session = makeSessionContext({machine});
    const gate: CompletionGateDeps = {
      runVerifier: async ({candidateIdentity}) => ({
        verdict: {
          schema_version: 1,
          task_id: 'goal-1',
          state: 'BLOCKED',
          candidate: candidateIdentity.candidate,
          fingerprint: candidateIdentity.fingerprint,
          outstanding: ['missing database credentials'],
          evidence: ['DB connection refused'],
        },
        checkPath: 'judge',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const hooks = createHooks(makeDeps({session, completionGate: gate}));
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: 0,
      runId: 'run-1',
      messageID: 'm1',
      toolCallID: 'c1',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'i4',
    });

    const last = machine.snapshot().lastClaim!;
    expect(last.outcome.status).toBe('blocked-acknowledged');
    expect(last.check.verdict).toBe('BLOCKED');
    expect(machine.snapshot().status).toBe('blocked');
  });

  it('maps direct update_goal(blocked) to blocked-acknowledged', async () => {
    const machine = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const session = makeSessionContext({machine});
    const hooks = createHooks(makeDeps({session}));
    session.setPendingIntent('goal-1', {
      goalId: 'goal-1',
      revision: 0,
      runId: 'run-1',
      messageID: 'm1',
      toolCallID: 'c1',
      targetStatus: 'blocked',
      evidence: 'need API key',
      createdAt: Date.now(),
    });
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'i5',
    });

    const last = machine.snapshot().lastClaim!;
    expect(last.claimedStatus).toBe('blocked');
    expect(last.outcome.status).toBe('blocked-acknowledged');
    expect(machine.snapshot().status).toBe('blocked');
  });

  it('maps legacy judge approved to verified-complete and rejected to claim-refuted', async () => {
    // 1. Rejected outcome
    const machine1 = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const session1 = makeSessionContext({machine: machine1});
    const hooks1 = createHooks(
      makeDeps({
        session: session1,
        completionJudge: async () => ({
          approved: false,
          reason: 'needs better docs',
        }),
      }),
    );
    session1.setPendingIntent('goal-1', {
      revision: 0,
      runId: 'run-1',
      goalId: 'goal-1',
      messageID: 'm1',
      toolCallID: 'c1',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks1.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'i6a',
    });
    expect(machine1.snapshot().lastClaim?.outcome.status).toBe('claim-refuted');
    expect(machine1.snapshot().lastClaim?.check.path).toBe('judge');
    expect(machine1.snapshot().lastClaim?.check.verdict).toBe('JUDGE_REJECTED');

    // 2. Approved outcome
    const machine2 = new GoalStateMachine(makeGoal(), {
      onCommit: async () => {},
    });
    const session2 = makeSessionContext({machine: machine2});
    const hooks2 = createHooks(
      makeDeps({
        session: session2,
        completionJudge: async () => ({approved: true, reason: 'all good'}),
      }),
    );
    session2.setPendingIntent('goal-1', {
      revision: 0,
      runId: 'run-1',
      goalId: 'goal-1',
      messageID: 'm2',
      toolCallID: 'c2',
      targetStatus: 'complete',
      evidence: 'done',
      createdAt: Date.now(),
    });
    await hooks2.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'i6b',
    });
    expect(machine2.snapshot().lastClaim?.outcome.status).toBe(
      'verified-complete',
    );
    expect(machine2.snapshot().lastClaim?.check.path).toBe('judge');
    expect(machine2.snapshot().lastClaim?.check.verdict).toBe('JUDGE_APPROVED');
  });

  // 4. Round-Trip Persistence & WAL Recovery

  it('serializes, deserializes, and recovers claim ledger records without loss', async () => {
    const claim1: ClaimRecord = {
      claimId: 'claim-1',
      timestamp: 1000,
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: 'I completed the task',
      check: {
        path: 'judge',
        target: 'bun test',
        verdict: 'WORKING',
        evidence: ['1 failing test'],
        timestamp: 1050,
      },
      outcome: {
        status: 'claim-refuted',
        detail: '1 failing test',
        timestamp: 1060,
      },
    };

    const claim2: ClaimRecord = {
      claimId: 'claim-2',
      timestamp: 2000,
      actor: 'agent',
      claimedStatus: 'complete',
      claimText: 'Fixed the failing test',
      check: {
        path: 'judge',
        target: 'bun test',
        verdict: 'COMPLETE',
        evidence: ['all tests pass'],
        timestamp: 2050,
      },
      outcome: {
        status: 'verified-complete',
        detail: 'Verified complete by test suite',
        timestamp: 2060,
      },
    };

    const state = makeGoal({
      claims: [claim1, claim2],
      lastClaim: claim2,
    });

    const serialized = serializeGoal(state);
    const deserialized = deserializeGoal(serialized);

    expect(deserialized.claims.length).toBe(2);
    expect(deserialized.claims[0]).toEqual(claim1);
    expect(deserialized.claims[1]).toEqual(claim2);
    expect(deserialized.lastClaim).toEqual(claim2);

    const statePath = join(testDir, 'state.json');
    const ledgerPath = join(testDir, 'state.json.ledger.jsonl');
    await writeStateFile(statePath, [deserialized], [], []);

    const recovered = await recoverState(statePath, ledgerPath);
    expect(recovered.goals.length).toBe(1);
    const recGoal = recovered.goals[0];
    expect(recGoal.claims.length).toBe(2);
    expect(recGoal.claims[0]).toEqual(claim1);
    expect(recGoal.claims[1]).toEqual(claim2);
    expect(recGoal.lastClaim).toEqual(claim2);
  });
});

/**
 * Loop Bounds: Repeated Unverifiable Assertions Without Change.
 *
 * Prevents an agent from looping indefinitely by continually asserting completion
 * when no verifier is available and the workspace identity remains unchanged.
 * The bound pauses the goal without falsely settling it as complete.
 */
describe('repeated unverifiable completion is bounded', () => {
  it('pauses after maxUnchangedResults assertions with an unchanged workspace', async () => {
    const machine = new GoalStateMachine(
      makeGoal({goalId: 'goal-loop', maxUnchangedResults: 3}),
      {
        onCommit: async () => {},
      },
    );
    const intents = new Map<string, unknown>();
    const session = makeSessionContext({machine});
    (
      session as {setPendingIntent: (g: string, i: unknown) => void}
    ).setPendingIntent = (g, i) => {
      if (i) intents.set(g, i);
      else intents.delete(g);
    };
    (session as {getPendingIntent: (g: string) => unknown}).getPendingIntent =
      g => intents.get(g) ?? null;

    const gateAbstain: CompletionGateDeps = {
      runVerifier: async () => ({
        failure: {kind: 'unavailable'},
        checkPath: 'none',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const hooks = createHooks(makeDeps({session, completionGate: gateAbstain}));

    let paused = false;
    for (let n = 1; n <= 8 && !paused; n++) {
      session.setPendingIntent('goal-loop', {
        goalId: 'goal-loop',
        revision: machine.currentRevision,
        runId: 'run-1',
        messageID: `msg-${n}`,
        toolCallID: `call-${n}`,
        targetStatus: 'complete',
        evidence: 'done',
        createdAt: Date.now(),
      });
      await hooks.event!({
        type: 'session.idle',
        sessionID: 'session-1',
        id: `loop-${n}`,
      });
      paused = machine.snapshot().status === 'paused';
    }

    const snap = machine.snapshot();
    expect(snap.status).toBe('paused');
    expect(snap.stopReason).toBe('unattested completion asserted repeatedly');
    // Ensure the goal pauses rather than falsely settling as complete
    expect(snap.status).not.toBe('complete');
  });

  it('does NOT pause a goal whose workspace is changing', async () => {
    // When workspace state changes between completion assertions, the unchanged
    // streak resets and the goal should remain active.
    const machine = new GoalStateMachine(
      makeGoal({goalId: 'goal-moving', maxUnchangedResults: 3}),
      {
        onCommit: async () => {},
      },
    );
    const intents = new Map<string, unknown>();
    const session = makeSessionContext({machine});
    (
      session as {setPendingIntent: (g: string, i: unknown) => void}
    ).setPendingIntent = (g, i) => {
      if (i) intents.set(g, i);
      else intents.delete(g);
    };
    (session as {getPendingIntent: (g: string) => unknown}).getPendingIntent =
      g => intents.get(g) ?? null;

    let fingerprintN = 0;
    const gateMoving: CompletionGateDeps = {
      runVerifier: async () => ({
        failure: {kind: 'unavailable'},
        checkPath: 'none',
      }),
      recoveryConfig: {maxRecoveryTurns: 12, maxUnchangedResults: 3},
    };
    const hooks = createHooks(makeDeps({session, completionGate: gateMoving}));

    for (let n = 1; n <= 6; n++) {
      await machine.mutate(
        g => {
          g.lastCandidate = `cand-${++fingerprintN}`;
          g.lastFingerprint = `fp-${fingerprintN}`;
        },
        {source: 'update_goal', detail: 'simulate work', skipPersist: true},
      );
      session.setPendingIntent('goal-moving', {
        goalId: 'goal-moving',
        revision: machine.currentRevision,
        runId: 'run-1',
        messageID: `msg-${n}`,
        toolCallID: `call-${n}`,
        targetStatus: 'complete',
        evidence: 'done',
        createdAt: Date.now(),
      });
      await hooks.event!({
        type: 'session.idle',
        sessionID: 'session-1',
        id: `move-${n}`,
      });
    }

    expect(machine.snapshot().status).not.toBe('paused');
  });
});
