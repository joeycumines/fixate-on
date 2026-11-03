import {describe, expect, test} from 'bun:test';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
  brakeCeiling,
  brakeCeilingFormatted,
  UNLIMITED,
} from '../src/brake-format.ts';
import type {GoalTuiSnapshot} from '../src/tui-state.ts';

/**
 * A disabled brake must never render as a zero denominator (e.g. "Turns: 3 / 0").
 * A non-positive limit indicates the brake is off and should display as "unlimited".
 * These tests ensure all current and future surfaces route through the central
 * brake-format helper rather than reimplementing ceiling logic inline.
 */

const SRC = join(import.meta.dir, '..', 'src');

describe('brakeCeiling', () => {
  test('a POSITIVE limit renders as itself', () => {
    expect(brakeCeiling(25)).toBe(25);
    expect(brakeCeiling(1)).toBe(1);
  });

  test("a non-positive limit renders as 'unlimited', never a denominator", () => {
    // maxTurns defaults to 0 (brake disabled). Manually edited state files could
    // also contain negative values, which must not render as negative denominators.
    expect(brakeCeiling(0)).toBe(UNLIMITED);
    expect(brakeCeiling(-1)).toBe(UNLIMITED);
  });
});

describe('brakeCeilingFormatted', () => {
  test('applies the formatter only when the limit is positive', () => {
    expect(brakeCeilingFormatted(200000, n => n.toLocaleString())).toBe(
      '200,000',
    );
    expect(brakeCeilingFormatted(1800000, n => `${n / 1000}s`)).toBe('1800s');
  });

  test("a disabled limit is NOT formatted — it reads 'unlimited'", () => {
    let called = false;
    const result = brakeCeilingFormatted(0, n => {
      called = true;
      return String(n);
    });
    expect(result).toBe(UNLIMITED);
    expect(called).toBe(false);
  });
});

describe('every brake-ceiling render routes through brake-format.ts', () => {
  // Surfaces that render brake ceilings and must import brake-format.ts:
  // - tui-views.ts: renders v1 list rows, detail cards, and v2 cockpit cards.
  // - hooks-handlers.ts: renders compaction summaries.
  // - commands-format.ts: renders /goal status and brake headlines.
  const SURFACES = ['tui-views.ts', 'hooks-handlers.ts', 'commands-format.ts'];

  for (const file of SURFACES) {
    test(`${file} imports the shared ceiling helper`, async () => {
      const source = await readFile(join(SRC, file), 'utf8');
      expect(source).toMatch(/from\s+["']\.\/brake-format\.ts["']/);
    });
  }

  test('no source file renders a brake ceiling with an INLINE ternary', async () => {
    // Matches two patterns where ceilings are formatted inline:
    // 1. Labelled false branch: `<field> > 0 ? <...field...> : "unlimited"`
    // 2. Self-rendering false branch: `<field> >= 1000 ? <...field...>k : String(field)`,
    //    which outputs "0" for a disabled brake instead of "unlimited".
    //
    // Deliberate exclusions that do NOT represent ceilings:
    // - steering.ts: `goal.maxTurns > 0 ? remainingTurns : "unlimited"` (remaining turns, not ceiling)
    // - tui-analytics.ts: `goal.maxTurns > 0 ? tokensPerTurn * goal.maxTurns : null` (numeric projection guard)
    const inlineCeiling =
      /\b(maxTurns|maxTokens|maxDurationMs)\s*>\s*0\s*\?[^:]*?\b\1\b[^:]*?:\s*(?:["'](?:unlimited|∞)["']|[^;,]*?\b\1\b)/;
    const offenders: string[] = [];
    for (const entry of await readdir(SRC)) {
      if (!/\.tsx?$/.test(entry)) continue;
      if (entry === 'brake-format.ts') continue;
      const source = await readFile(join(SRC, entry), 'utf8');
      if (inlineCeiling.test(source)) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });

  // Behavioural check: static analysis cannot detect local aliases (e.g. naming
  // the parameter `max` inside a component). Rendering the lines directly confirms
  // disabled limits are never displayed as "/ 0".
  test('the v2 card never renders a zero denominator, on either ceiling', async () => {
    const {goalCardLines} = await import('../src/tui-views.ts');
    const snapshot = (overrides: Record<string, unknown>): GoalTuiSnapshot =>
      ({
        goalId: 'g1',
        sessionID: 'ses_mine',
        condition: 'fix the failing tests',
        status: 'active',
        revision: 1,
        turnCount: 3,
        totalTokens: 12400,
        maxTokens: 200000,
        maxTurns: 10,
        tokenBudget: null,
        usage: {
          input: 100,
          output: 50,
          reasoning: 10,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          costKnown: true,
        },
        stopReason: '',
        blockedReason: '',
        pausedAt: 0,
        stoppedAt: 0,
        createdAt: 1,
        updatedAt: 2,
        finishedAt: null,
        lastCheckpoint: null,
        history: [],
        origin: 'disk',
        ...overrides,
      }) as GoalTuiSnapshot;

    for (const [label, overrides] of [
      ['both disabled', {maxTokens: 0, maxTurns: 0}],
      ['tokens disabled', {maxTokens: 0}],
      ['turns disabled', {maxTurns: 0}],
    ] as Array<[string, Record<string, unknown>]>) {
      const text = goalCardLines(snapshot(overrides), 'ses_mine')
        .map(l => l.text)
        .join('\n');
      console.log(
        `CARD-BRAKE ${label} ${JSON.stringify(text.split('\n').slice(-2))}`,
      );
      expect(
        text,
        `${label}: a brake that is off is not a zero budget`,
      ).not.toMatch(/\/\s*0\b/);
      expect(text, `${label}: a disabled brake says so in words`).toContain(
        'unlimited',
      );
    }
  });
});
