// f-plain-language.test.ts — locks the law: status/history/dashboard
// surfaces speak plain language. A cold user understands state, verification
// story, and next duty WITHOUT internal vocabulary; raw enums survive only on
// the --verbose wall.
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import type {ClaimRecord} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {CommandSessionContext} from '../src/commands.ts';
import {
  claimSentence,
  formatStatus,
  formatStatusHeadline,
  handleCommand,
} from '../src/commands.ts';

function makeClaim(overrides?: Partial<ClaimRecord>): ClaimRecord {
  return {
    claimId: 'claim-1',
    timestamp: Date.now(),
    actor: 'agent',
    claimedStatus: 'complete',
    claimText: 'I am done',
    check: {path: 'judge', verdict: 'COMPLETE', timestamp: Date.now()},
    outcome: {status: 'verified-complete', detail: '', timestamp: Date.now()},
    ...overrides,
  };
}

describe('claim outcomes become plain sentences', () => {
  test('each outcome maps to its plain sentence', () => {
    expect(claimSentence(makeClaim())).toBe('Done — attested by the judge.');
    expect(
      claimSentence(
        makeClaim({
          check: {path: 'none', verdict: 'NONE', timestamp: 0},
          outcome: {status: 'unverifiable-claim', detail: '', timestamp: 0},
        }),
      ),
    ).toContain('no attestation could be obtained');
    expect(
      claimSentence(
        makeClaim({
          check: {path: 'judge', verdict: 'WORKING', timestamp: 0},
          outcome: {
            status: 'claim-refuted',
            detail: 'tests still failing',
            timestamp: 0,
          },
        }),
      ),
    ).toContain('Not done yet');
    expect(
      claimSentence(
        makeClaim({
          outcome: {status: 'blocked-acknowledged', detail: '', timestamp: 0},
        }),
      ),
    ).toContain('waiting for you');
  });

  test('raw enums never leak into the headline tier', () => {
    const goal = createGoalState('s-f8', 'Ship it', {goalId: 'g-f8'});
    goal.status = 'complete';
    goal.lastClaim = makeClaim({
      check: {path: 'none', verdict: 'NONE', timestamp: 0},
      outcome: {
        status: 'unverifiable-claim',
        detail: 'no verifier ran',
        timestamp: 0,
      },
    });
    const headline = formatStatusHeadline(goal, 'goal');
    expect(headline).toContain('no attestation could be obtained');
    expect(headline).not.toContain('[unverifiable-claim:');
    expect(headline).not.toContain('verified-complete');

    const verbose = formatStatus(goal, 'goal', {verbose: true});
    // The verbose wall keeps the LEDGER's exact token (machine vocabulary) and
    // leads with the shared word, so one screen never carries two vocabularies
    // for the same fact.
    expect(verbose).toContain('Last claim: [unattested]');
    expect(verbose).not.toContain('[unverifiable-claim:');
    expect(verbose).toContain('[unattested: no verifier ran]');
  });
});

describe('tiered /goal status', () => {
  test('headline is <=6 lines with state, brakes, and next duty', async () => {
    const machine = new GoalStateMachine(
      createGoalState('s-tier', 'Build the widget', {
        goalId: 'g-tier',
        maxTurns: 10,
      }),
    );
    const session: CommandSessionContext = {
      sessionID: 's-tier',
      getMachine: () => machine,
      listActiveGoals: () => [machine.snapshot()],
      listArchivedResults: () => [],
      createGoal: () => machine,
      replaceGoals: async () => machine,
      removeGoal: async () => {},
      clearSession: () => {},
      focusGoal: async () => ({ok: true as const, machine}),
      addOrderedSession: () => {},
      isOrdered: () => false,
      persist: async () => true,
    };
    const out = await handleCommand('status', session);
    const lines = out.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(out).toContain('Working: Build the widget');
    expect(out).toContain('Brakes:');
    expect(out).toContain('Next:');

    const wall = await handleCommand('status --verbose', session);
    expect(wall).toContain('Auto-continues sent:');
    expect(wall).toContain('Last progress:');
  });

  test("a refuted claim surfaces on an ACTIVE goal's headline (position truth)", async () => {
    const goal = createGoalState('s-refuted', 'Keep grinding', {
      goalId: 'g-refuted',
    });
    goal.status = 'active';
    goal.lastClaim = makeClaim({
      check: {path: 'judge', verdict: 'WORKING', timestamp: 0},
      outcome: {
        status: 'claim-refuted',
        detail: 'spec section 3 missing',
        timestamp: 0,
      },
    });
    const headline = formatStatusHeadline(goal, 'goal');
    expect(headline).toContain('Working.');
    expect(headline).toContain('Not done yet');
    expect(headline).toContain('spec section 3 missing');
  });
});

describe('relative times and marker legend', () => {
  test('/goal history uses relative timestamps (no bare ISO clock times)', () => {
    const s = readFileSync(
      new URL('../src/commands-format.ts', import.meta.url),
      'utf8',
    );
    expect(s.includes('toISOString().slice(11, 19)')).toBe(false);
    expect(s.includes('formatRelativeTime(entry.timestamp)')).toBe(true);
  });

  test('/goal list prints the plain-language marker legend', () => {
    const s = readFileSync(
      new URL('../src/commands-format.ts', import.meta.url),
      'utf8',
    );
    expect(s.includes('focused = driven now')).toBe(true);
    expect(s.includes('background = waiting')).toBe(true);
  });
});

describe('hydration diagnostic speaks one human sentence', () => {
  test('v2 dashboard empty-state text has no raw key=value evidence dump', () => {
    const s = readFileSync(
      new URL('../src/tui-v2.ts', import.meta.url),
      'utf8',
    );
    expect(s.includes('No goals found on disk for this workspace')).toBe(true);
    expect(
      s.includes('`dir=${lastHydration.dir ?? "unresolved"} snapshots='),
    ).toBe(false);
  });
});

describe('pressure-rung transitions recorded as visible history', () => {
  test("escalating recovery turns push a 'Pressure rung escalated' signal entry", async () => {
    const {GoalStateMachine, createGoalState} =
      await import('../src/state-machine.ts');
    const {determinePressureRung} = await import('../src/recovery-pressure.ts');
    const machine = new GoalStateMachine(
      createGoalState('s-f8b', 'Grind duties'),
      {
        onCommit: async () => {},
      },
    );

    const rung1 = determinePressureRung(1, 12);
    const rung3 = determinePressureRung(6, 12);
    expect(rung3).not.toBe(rung1);

    await machine.mutate(
      g => {
        g.pressureRung = rung1;
      },
      {source: 'update_goal', detail: `Pressure rung escalated to ${rung1}`},
    );
    await machine.mutate(
      g => {
        g.pressureRung = rung3;
      },
      {source: 'update_goal', detail: `Pressure rung escalated to ${rung3}`},
    );

    const history = machine.snapshot().history;
    const rungEntries = history.filter(h =>
      h.detail.startsWith('Pressure rung'),
    );
    expect(rungEntries.length).toBe(2);

    const {formatHistoryList} = await import('../src/tui-views.ts');
    const rendered = formatHistoryList(history);
    expect(rendered).toContain(`Pressure rung escalated to ${rung3}`);
  });
});
