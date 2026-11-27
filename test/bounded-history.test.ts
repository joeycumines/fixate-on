// f-uncapped-history.test.ts — locks the law: history completeness is
// delivered by scrolling host surfaces, NEVER truncation (user 2026-08-24:
// "TUIs MUST cater to screens of any size"). A goal with >100 signal entries
// round-trips byte-complete through BOTH formatters; noise exclusion stays;
// caps and omission notices are grep-locked out of history paths.
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {formatHistoryList} from '../src/tui-views.ts';
import {formatHistory} from '../src/commands.ts';
import type {GoalLifecycleEvent} from '../src/state-machine.ts';

function bigSignalHistory(count: number): GoalLifecycleEvent[] {
  const entries: GoalLifecycleEvent[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      timestamp: 1_700_000_000_000 + i * 1000,
      type: 'paused',
      detail: `lifecycle event number ${i}`,
    } as GoalLifecycleEvent);
  }
  return entries;
}

describe('history without caps', () => {
  test('>100 signal entries render byte-complete in the dashboard list', () => {
    const history = bigSignalHistory(120);
    const out = formatHistoryList(history);
    for (let i = 0; i < 120; i++) {
      expect(out).toContain(`lifecycle event number ${i}`);
    }
    expect(out).not.toContain('omitted');
  });

  test('>100 signal entries render byte-complete in /goal history output', () => {
    const history = bigSignalHistory(120);
    const out = formatHistory(history);
    for (let i = 0; i < 120; i++) {
      expect(out).toContain(`lifecycle event number ${i}`);
    }
    expect(out).not.toContain('omitted');
  });

  test('noise exclusion still applies at scale (orthogonal to completeness)', () => {
    const history = [
      ...bigSignalHistory(30),
      ...Array.from(
        {length: 90},
        (_, i) =>
          ({
            timestamp: 1_700_000_500_000 + i,
            type: 'mutation',
            detail: 'Captured execution context',
          }) as GoalLifecycleEvent,
      ),
    ];
    const out = formatHistoryList(history);
    expect(out).toContain('lifecycle event number 29');
    expect(out).not.toContain('Captured execution context');
    // All 30 signal entries survive, all 90 noise entries excluded.
    const rendered = out.split('\n').length - 1; // minus the "History:" header
    expect(rendered).toBe(30);
  });
});

describe('grep-locks: no cap constants may return on history paths', () => {
  const views = readFileSync(
    new URL('../src/tui-views.ts', import.meta.url),
    'utf8',
  );
  const commands = readFileSync(
    new URL('../src/commands.ts', import.meta.url),
    'utf8',
  );

  test('no omission notice templates exist in either formatter source', () => {
    expect(views.includes('earlier event')).toBe(false);
    expect(commands.includes('earlier event')).toBe(false);
  });

  test('no display-cap constants exist in either formatter source', () => {
    expect(views.includes('HISTORY_DISPLAY_CAP')).toBe(false);
    expect(commands.includes('HISTORY_COMMAND_CAP')).toBe(false);
  });
});
