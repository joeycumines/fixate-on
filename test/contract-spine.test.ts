// contract-spine.test.ts — Contract tests for artifact pointers, brake tiering, propose-and-receipt:
// - Artifact pointer living context injection (mid-run file edit flow-through without contract edits)
// - Brake tiering mechanical enforcement (agent cannot modify brakes mid-run)
// - Propose-and-receipt channel (proposals pending until human acceptance)
// - Schema backward/forward compatibility and round-tripping

import {afterEach, beforeEach, describe, expect, it} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import {deserializeGoal, serializeGoal} from '../src/persistence.ts';
import {
  buildContinueMessage,
  buildSystemBlock,
  renderArtifactPointers,
} from '../src/steering.ts';
import {
  handleProposeGoalChange,
  type ToolSessionContext,
} from '../src/tools.ts';
import {formatStatus, handleCommand} from '../src/commands.ts';

describe('Contract Pointer Spine + Brake Tiering + Propose-and-Receipt', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'v1-test-'));
  });

  afterEach(() => {
    try {
      rmSync(testDir, {recursive: true, force: true});
    } catch {
      /* the directory may already be gone */
    }
  });

  // (a) Artifact Pointers: Living context injected on continuation turns

  it('injects pointer file content into continuation prompt and reflects mid-run edits with no contract edit', () => {
    const filePath = join(testDir, 'living-spec.md');
    writeFileSync(
      filePath,
      'Version 1: Implement feature X with constraints Y.',
      'utf8',
    );

    const state = createGoalState('session-1', 'Deliver feature per spec', {
      artifactPointers: [filePath],
    });
    const machine = new GoalStateMachine(state);
    const initialRev = machine.currentRevision;

    // 1. Initial continuation message contains file content
    const msg1 = buildContinueMessage(machine.snapshot(), {cwd: testDir});
    expect(msg1).toContain('Artifact pointers (living context):');
    expect(msg1).toContain(filePath);
    expect(msg1).toContain(
      'Version 1: Implement feature X with constraints Y.',
    );
    expect(machine.currentRevision).toBe(initialRev);

    // 2. Mid-run edit to the living file on disk
    writeFileSync(
      filePath,
      'Version 2: Requirements expanded to include constraint Z.',
      'utf8',
    );

    // 3. Next continuation message immediately reflects the new content
    const msg2 = buildContinueMessage(machine.snapshot(), {cwd: testDir});
    expect(msg2).toContain(
      'Version 2: Requirements expanded to include constraint Z.',
    );
    expect(msg2).not.toContain(
      'Version 1: Implement feature X with constraints Y.',
    );

    // Contract was NOT edited: condition and revision are pristine
    expect(machine.snapshot().condition).toBe('Deliver feature per spec');
    expect(machine.currentRevision).toBe(initialRev);
  });

  it('buildSystemBlock includes goal_artifact_pointers for active goals', () => {
    const ptr = 'plan.md';
    const state = createGoalState('session-1', 'Follow the plan', {
      artifactPointers: [ptr],
    });
    const block = buildSystemBlock(state, 'goal', true);
    expect(block).toContain('<goal_artifact_pointers>');
    expect(block).toContain('<pointer>plan.md</pointer>');
  });

  it('handles missing or unreadable pointer files gracefully without throwing', () => {
    const nonExistent = join(testDir, 'does-not-exist.md');
    const state = createGoalState('session-1', 'Do work', {
      artifactPointers: [nonExistent],
    });
    const rendered = renderArtifactPointers(state, testDir);
    expect(rendered).toContain('error="true"');
    expect(rendered).toContain('File not readable');
    expect(rendered).toContain(nonExistent);
  });

  // (b) Brake Tiering: ceilings are contract-tier and agent cannot modify mid-run

  it('rejects agent tool calls attempting to modify safety brakes mid-run', async () => {
    const state = createGoalState('session-1', 'Test goal', {
      tokenBudget: 50000,
      maxTurns: 10,
      maxTokens: 200000,
      maxDurationMs: 600000,
    });
    const machine = new GoalStateMachine(state);
    const mockSession: ToolSessionContext = {
      sessionID: 'session-1',
      getMachine: () => machine,
      listActiveGoals: () => [machine.snapshot()],
      listArchivedResults: () => [],
      createGoal: () => machine,
      removeGoal: async () => {},
      focusGoal: async () => ({ok: true as const, machine}),
      setPendingIntent: () => {},
      getPendingIntent: (_goalId: string) => null,
      getAllPendingIntents: () => [],
      persist: async () => true,
    };

    // Agent attempts to raise token_budget mid-run via propose_goal_change
    const resultJson = await handleProposeGoalChange(mockSession, {
      reason: 'Need more budget',
      token_budget: 100000,
    });
    const res = JSON.parse(resultJson);
    expect(res.error).toContain(
      'Brakes (turn/token/duration/blocked ceilings) are contract-tier',
    );

    // Verify machine brakes are untouched
    expect(machine.snapshot().tokenBudget).toBe(50000);
    expect(machine.snapshot().maxTurns).toBe(10);
  });

  it('mechanically reverts and rejects agent-sourced mutations attempting to change brakes', async () => {
    const state = createGoalState('session-1', 'Test goal', {
      tokenBudget: 25000,
      maxTurns: 5,
    });
    const machine = new GoalStateMachine(state);

    // Agent source 'update_goal' trying to alter maxTurns or tokenBudget
    const mutResult = await machine.mutate(
      g => {
        g.maxTurns = 999;
        g.tokenBudget = 999999;
      },
      {
        source: 'update_goal',
        detail: 'Agent sneaking higher limits',
      },
    );

    expect(mutResult.ok).toBe(false);
    expect(mutResult.error).toContain(
      'Brakes (turn/token/duration/blocked ceilings) are contract-tier',
    );
    expect(machine.snapshot().maxTurns).toBe(5);
    expect(machine.snapshot().tokenBudget).toBe(25000);
  });

  // (c) Propose-and-Receipt: proposals pending until human accept/reject

  it('records agent proposals in pending state and applies them ONLY upon human receipt', async () => {
    const state = createGoalState('session-1', 'Original Objective', {
      constraints: 'Original Constraints',
    });
    const machine = new GoalStateMachine(state);
    const mockSession = {
      sessionID: 'session-1',
      getMachine: () => machine,
      listActiveGoals: () => [machine.snapshot()],
      listArchivedResults: () => [],
      createGoal: () => machine,
      replaceGoals: async () => machine,
      removeGoal: async () => {},
      focusGoal: async () => ({ok: true as const, machine}),
      setPendingIntent: () => {},
      getPendingIntent: (_goalId: string) => null,
      getAllPendingIntents: () => [],
      persist: async () => true,
      isOrdered: () => false,
      clearSession: () => {},
      addOrderedSession: () => {},
    };

    // 1. Agent calls propose tool
    const proposeRes = JSON.parse(
      await handleProposeGoalChange(mockSession, {
        objective: 'New Proposed Objective',
        constraints: 'New Proposed Constraints',
        reason: 'Discovered edge case requirement in schema',
      }),
    );

    expect(proposeRes.pendingProposal).toBeDefined();
    expect(proposeRes.pendingProposal.reason).toBe(
      'Discovered edge case requirement in schema',
    );
    expect(proposeRes.message).toContain(
      'recorded and queued for human review',
    );

    // 2. Goal contract remains OLD before human receipt
    const snapshot1 = machine.snapshot();
    expect(snapshot1.condition).toBe('Original Objective');
    expect(snapshot1.constraints).toBe('Original Constraints');
    expect(snapshot1.pendingProposal?.proposalId).toBe(
      proposeRes.pendingProposal.proposalId,
    );

    // 3. Status surfaces the pending proposal
    const statusText = formatStatus(snapshot1, 'goal');
    expect(statusText).toContain('Pending proposal');
    expect(statusText).toContain('Discovered edge case requirement in schema');
    expect(statusText).toContain(
      '/goal accept to apply or /goal reject to discard',
    );

    // 4. Continuation prompt surfaces pending proposal banner
    const continuePrompt = buildContinueMessage(snapshot1);
    expect(continuePrompt).toContain('Pending proposal');
    expect(continuePrompt).toContain(
      'awaiting human receipt via /goal accept; run continues under existing terms',
    );

    // 5. Human accepts proposal via slash command `/goal accept`
    const acceptOutput = await handleCommand('accept', mockSession);
    expect(acceptOutput).toContain('terms updated');

    // 6. NEW terms now apply and pendingProposal is cleared
    const snapshot2 = machine.snapshot();
    expect(snapshot2.condition).toBe('New Proposed Objective');
    expect(snapshot2.constraints).toBe('New Proposed Constraints');
    expect(snapshot2.pendingProposal).toBeNull();
    expect(snapshot2.objectiveUpdatedPending).toBe(true);

    // 7. Receipt is recorded in goal history
    const historyReceipt = snapshot2.history.find(h =>
      h.detail.includes('Human accepted proposal'),
    );
    expect(historyReceipt).toBeDefined();
  });

  it('handles human rejection of a proposal cleanly', async () => {
    const state = createGoalState('session-1', 'Original Objective');
    const machine = new GoalStateMachine(state);
    const mockSession = {
      sessionID: 'session-1',
      getMachine: () => machine,
      listActiveGoals: () => [machine.snapshot()],
      listArchivedResults: () => [],
      createGoal: () => machine,
      replaceGoals: async () => machine,
      removeGoal: async () => {},
      focusGoal: async () => ({ok: true as const, machine}),
      setPendingIntent: () => {},
      getPendingIntent: (_goalId: string) => null,
      getAllPendingIntents: () => [],
      persist: async () => true,
      isOrdered: () => false,
      clearSession: () => {},
      addOrderedSession: () => {},
    };

    await handleProposeGoalChange(mockSession, {
      objective: 'Unwanted Objective',
      reason: 'Bad idea',
    });

    expect(machine.snapshot().pendingProposal).not.toBeNull();

    const rejectOutput = await handleCommand('reject', mockSession);
    expect(rejectOutput).toContain('Rejected proposal');

    const snapshot = machine.snapshot();
    expect(snapshot.condition).toBe('Original Objective');
    expect(snapshot.pendingProposal).toBeNull();
    const historyEntry = snapshot.history.find(h =>
      h.detail.includes('Human rejected proposal'),
    );
    expect(historyEntry).toBeDefined();
  });

  // (d) Schema Round-Trip: old->new->old compatibility without loss

  it('round-trips old and new schema without loss', () => {
    // Old schema object missing artifactPointers and pendingProposal
    const oldRaw = {
      goalId: 'g-123',
      runId: 'r-456',
      revision: 3,
      condition: 'Old format goal',
      successCriteria: 'Legacy criteria',
      constraints: 'Legacy constraints',
      mode: 'normal',
      sessionID: 's-789',
      tokenBudget: 50000,
      maxTokens: 200000,
      maxTurns: 10,
      maxDurationMs: 900000,
      status: 'active',
      messageIDs: ['m-1', 'm-2'],
    };

    const deserialized = deserializeGoal(oldRaw);
    expect(deserialized.goalId).toBe('g-123');
    expect(deserialized.artifactPointers).toEqual([]);
    expect(deserialized.pendingProposal).toBeNull();

    // Add new fields and serialize
    deserialized.artifactPointers = ['./plan.md', './DIRECTIVE.txt'];
    deserialized.pendingProposal = {
      proposalId: 'prop-99',
      proposedAt: 12345678,
      objective: 'Refined objective',
      reason: 'Clarified scope',
    };

    const serialized = serializeGoal(deserialized);
    expect(serialized.artifactPointers).toEqual([
      './plan.md',
      './DIRECTIVE.txt',
    ]);
    expect(serialized.pendingProposal?.proposalId).toBe('prop-99');

    // Re-deserialize
    const roundTripped = deserializeGoal(serialized);
    expect(roundTripped.artifactPointers).toEqual([
      './plan.md',
      './DIRECTIVE.txt',
    ]);
    expect(roundTripped.pendingProposal?.proposalId).toBe('prop-99');
    expect(roundTripped.pendingProposal?.reason).toBe('Clarified scope');
  });
});
