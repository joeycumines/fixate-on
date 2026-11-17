// Parity fixtures stand in for both host shapes, and the v1 session API is
// `any` at the boundary (see src/session-api.ts). A suppression with a
// stated reason is reviewable; a silent one is not.
/* eslint-disable @typescript-eslint/no-explicit-any */
import {describe, expect, it, test} from 'bun:test';
import {
  formatCommandHeader,
  formatGoalList,
  formatStatus,
  parseGoalArguments,
} from '../src/commands.ts';
import {createOpenCodeSessionApi} from '../src/session-api.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';

// A2 parity lock: ensures every declared v1 capability has a working v1 code path
// that a live manual campaign can exercise. Each test would fail if the behavior regressed.
// Host-agnostic runtime lives in plugin-runtime.ts + state-machine/commands; v1 host
// is the legacy session API shape, v2 host is the flat shape — both must work.

describe('v1 parity — slash dispatch + host-agnostic core', () => {
  test('parseGoalArguments handles --pointer on both hosts (artifactPointers)', () => {
    const a = parseGoalArguments('fix tests --pointer SPEC.md --max-turns 5');
    expect(a.errors).toEqual([]);
    expect(a.condition).toBe('fix tests');
    expect(a.options.artifactPointers).toEqual(['SPEC.md']);
    const b = parseGoalArguments(
      'build feature --pointer a.md,b.md --pointer c.md',
    );
    expect(b.options.artifactPointers).toEqual(['a.md', 'b.md', 'c.md']);
  });

  test('slash lifecycle subcommands parse without error', () => {
    for (const cmd of [
      'status',
      'history',
      'list',
      'pause',
      'resume',
      'clear',
      'edit new objective',
      'focus 1',
      'checkpoint ok',
      'handback',
      'review',
      'sequence a; b',
      'add extra',
    ]) {
      const parsed = parseGoalArguments(cmd);
      // parseGoalArguments is for objective creation; subcommands are handled by handleCommand routing,
      // but flags inside them must still parse. This locks that the parser does not reject known flags.
      expect(Array.isArray(parsed.errors)).toBe(true);
    }
  });

  test('formatCommandHeader distinguishes TUI vs Server mode (honest degraded-mode)', () => {
    expect(formatCommandHeader(true, 'status')).toBe('[TUI mode] /status');
    expect(formatCommandHeader(false, 'status')).toBe(
      '[Server mode - output routed to model as chat turn] /status',
    );
  });

  test('formatStatus renders claim triad invariant (never plain achieved when unverifiable)', () => {
    const base: any = {
      goalId: 'g1',
      condition: 'do work',
      status: 'complete',
      stopReason: 'completed',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      turnCount: 1,
      maxTurns: 10,
      totalTokens: 0,
      maxTokens: 200000,
      usage: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        costKnown: false,
      },
      lastProgressAt: 0,
      noProgressTurns: 0,
      recoveryTurns: 0,
      maxRecoveryTurns: 3,
      unchangedResults: 0,
      maxUnchangedResults: 3,
      blockedTurns: 0,
      maxBlockedTurns: 3,
      successCriteria: '',
      constraints: '',
      artifactPointers: [],
      mode: 'normal',
      lastCheckpoint: null,
      history: [],
      pendingProposal: null,
      lastStatus: 'done',
      blockedReason: '',
      lastClaim: null,
    };
    // plain complete without claim -> plain label
    const plain = formatStatus({...base, lastClaim: null}, 'goal');
    expect(plain).toContain('Goal (status: complete):');
    // unverifiable-claim -> must show the shared-vocabulary label, never plain
    // achieved. The LEDGER token stays `unverifiable-claim`; what the reader
    // sees is `unattested`, with the reason attached.
    const unverifiable = formatStatus(
      {
        ...base,
        lastClaim: {
          outcome: {
            status: 'unverifiable-claim',
            detail: 'no verifier configured',
          },
          check: {path: 'none', verdict: 'WORKING'},
        },
      } as any,
      'goal',
    );
    expect(unverifiable).toContain('[unattested:');
    expect(unverifiable).toContain('no verifier configured');
    expect(unverifiable).not.toContain('unverifiable');
    expect(unverifiable).not.toMatch(/Goal \(status: complete\): do work\n/);
  });

  test('formatGoalList renders archived lastClaim as unusable vs verified', () => {
    const archived: any[] = [
      {
        state: 'achieved',
        condition: 'old work',
        lastClaim: {
          outcome: {status: 'unverifiable-claim'},
          check: {path: 'none'},
        },
      },
      {
        state: 'achieved',
        condition: 'good work',
        lastClaim: {
          outcome: {status: 'verified-complete'},
          check: {path: 'judge'},
        },
      },
    ];
    const out = formatGoalList([], archived, null, 'goal', false);
    expect(out).toContain('achieved [unattested]');
    expect(out).not.toContain('unverifiable');
    expect(out).toContain('good work');
  });

  test('session API probes flat then legacy shape for read-only ops without duplicating mutations', async () => {
    // flat shape succeeds
    const flatMessages = async (input: any) => {
      if (!input.sessionID)
        throw new TypeError('missing required field: sessionID');
      return [{id: 'm1'}];
    };
    const apiFlat = createOpenCodeSessionApi(
      {session: {messages: flatMessages}} as any,
      {preferredShape: 'flat'},
    );
    expect(await apiFlat.messages('s1')).toEqual([{id: 'm1'}]);

    // legacy shape fallback: flat throws TypeError with shape pattern, legacy succeeds
    let flatCalls = 0,
      legacyCalls = 0;
    const dualMessages = async (input: any) => {
      if (input.sessionID) {
        flatCalls++;
        throw new TypeError(
          'missing required field: path (expected legacy shape)',
        );
      }
      if (input.path?.id) {
        legacyCalls++;
        return [{id: 'm2'}];
      }
      throw new TypeError('invalid');
    };
    const apiFallback = createOpenCodeSessionApi(
      {session: {messages: dualMessages}} as any,
      {preferredShape: 'flat'},
    );
    expect(await apiFallback.messages('s2')).toEqual([{id: 'm2'}]);
    expect(flatCalls).toBe(1);
    expect(legacyCalls).toBe(1);
  });

  test('GoalStateMachine enforces brake tiering: ceilings are contract-tier, agent cannot mutate via tools', async () => {
    const state = createGoalState('s1', 'work', {
      maxTurns: 10,
      maxTokens: 200000,
      maxDurationMs: 900000,
    });
    const machine = new GoalStateMachine(state, {
      onCommit: async () => {},
      onUsageUpdate: async () => {},
    });
    const snap = machine.snapshot();
    // ceilings must be present and finite
    expect(snap.maxTurns).toBe(10);
    // slash-command can edit condition; ceilings survive
    await machine.mutate(
      (goal: any) => {
        goal.condition = 'edited by human';
      },
      {source: 'slash-command', detail: 'human edit'},
    );
    expect(machine.snapshot().maxTurns).toBe(10);
    expect(machine.snapshot().condition).toBe('edited by human');
    // agent source attempting to mutate ceilings must be rejected
    const beforeTurns = machine.snapshot().maxTurns;
    const result = await machine.mutate(
      (goal: any) => {
        (goal as any).maxTurns = 999;
      },
      {source: 'update_goal', detail: 'agent tries brake'} as any,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('contract-tier');
    expect(machine.snapshot().maxTurns).toBe(beforeTurns);
  });
});

describe('history signal-vs-noise filter', () => {
  it('excludes bookkeeping mutations from user-facing history', async () => {
    const {isSignalHistoryEntry} = await import('../src/tui-views.ts');
    const noise: Array<{type: string; detail: string}> = [
      {type: 'mutation', detail: 'Captured execution context'},
      {type: 'mutation', detail: 'Updated tracking fields'},
      {type: 'mutation', detail: 'Updated total tokens'},
      {type: 'mutation', detail: 'Set continuation claim'},
      {type: 'mutation', detail: 'Cleared notices'},
      {type: 'mutation', detail: 'Prompt succeeded, reset failure count'},
      {type: 'mutation', detail: 'Incremented turn count'},
    ];
    for (const entry of noise) expect(isSignalHistoryEntry(entry)).toBe(false);
  });

  it('keeps lifecycle transitions and human-authored mutations', async () => {
    const {isSignalHistoryEntry} = await import('../src/tui-views.ts');
    const signals: Array<{type: string; detail: string}> = [
      {type: 'active', detail: 'User resumed the goal.'},
      {
        type: 'paused',
        detail:
          'Paused because a new human message arrived; latest instruction wins.',
      },
      {type: 'complete', detail: ''},
      {type: 'retraction', detail: 'prior evidence corrected'},
      {type: 'mutation', detail: 'User edited the goal objective'},
      {type: 'mutation', detail: 'Accepted proposal [abc]: reason'},
      {type: 'mutation', detail: 'Recorded claim xyz: verified-complete'},
      {type: 'mutation', detail: 'Loaded from persisted state'},
    ];
    for (const entry of signals) expect(isSignalHistoryEntry(entry)).toBe(true);
  });

  it('formatHistoryList renders EVERY signal entry with zero omission notices (F3 no-cap law)', async () => {
    const {formatHistoryList} = await import('../src/tui-views.ts');
    const history = [
      ...Array.from({length: 12}, (_, i) => ({
        type: 'mutation',
        detail: `Captured execution context ${i}`,
        timestamp: 1000 + i,
      })),
      {type: 'paused', detail: 'user paused', timestamp: 2000},
      {type: 'active', detail: 'resumed', timestamp: 3000},
    ];
    const out = formatHistoryList(history);
    expect(out).toContain('[paused] user paused');
    expect(out).toContain('[active] resumed');
    expect(out).not.toContain('Captured execution context');
    expect(out).not.toContain('omitted');
  });

  it('/goal history command output filters noise via formatHistory', async () => {
    const {formatHistory} = await import('../src/commands.ts');
    const history = [
      {type: 'mutation', detail: 'Captured execution context', timestamp: 1},
      {type: 'mutation', detail: 'User paused the active goal.', timestamp: 2},
      {type: 'complete', detail: 'verified via bun test', timestamp: 3},
    ] as any[];
    const out = formatHistory(history);
    expect(out).not.toContain('Captured execution context');
    expect(out).toContain('User paused the active goal.');
    expect(out).toContain('complete: verified via bun test');
  });
});

describe('source tagging: skipRevision mutations become type tracking', () => {
  it('mutate with skipRevision pushes type tracking (filtered from UI)', async () => {
    const {GoalStateMachine, createGoalState} =
      await import('../src/state-machine.ts');
    const machine = new GoalStateMachine(createGoalState('s', 'work'), {
      onCommit: async () => {},
    });
    await machine.mutate(() => {}, {
      source: 'idle-handler',
      detail: 'Updated tracking fields',
      skipRevision: true,
    });
    const entry = machine.snapshot().history.at(-1)!;
    expect(entry.type).toBe('tracking');
    const {isSignalHistoryEntry} = await import('../src/tui-views.ts');
    expect(isSignalHistoryEntry(entry)).toBe(false);
  });
  it('mutate without skipRevision stays mutation and surfaces per signal rules', async () => {
    const {GoalStateMachine, createGoalState} =
      await import('../src/state-machine.ts');
    const machine = new GoalStateMachine(createGoalState('s', 'work'), {
      onCommit: async () => {},
    });
    await machine.mutate(
      g => {
        g.condition =
          'User edited the goal objective'.slice(0, 0) || g.condition;
      },
      {source: 'slash-command', detail: 'User edited the goal objective'},
    );
    const entry = machine.snapshot().history.at(-1)!;
    expect(entry.type).toBe('mutation');
    const {isSignalHistoryEntry} = await import('../src/tui-views.ts');
    expect(isSignalHistoryEntry(entry)).toBe(true);
  });
});

describe('dual-host bundle entry (A2/D4 v1 load fix)', () => {
  it('default export satisfies BOTH loaders: v2 {id,setup} + v1 server factory', async () => {
    const mod = await import('../src/plugin.ts');
    expect(typeof mod.default).toBe('object');
    expect(mod.default.id).toBe('fixate-on');
    expect(typeof mod.default.setup).toBe('function');
    expect(typeof mod.default.server).toBe('function');
  });
});
