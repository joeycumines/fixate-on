// f-companion-parity.test.ts — locks the companion-parity contract:
// outcome-neutral labels from ONE shared module, host-aware watchdog hints
// (v2 must NEVER advise /goal — unreachable there; neither host leaks
// internal tool names), and effective-or-visibly-failed watchdog semantics.
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {
  createGoalWatchdogs,
  isMutatingGoalCommand,
  outcomeNeutralLabel,
  watchdogTimeoutMessage,
} from '../src/tui-action-labels.ts';

describe('outcome-neutral labels (single source)', () => {
  test('labels state a REQUEST, never an outcome', () => {
    for (const cmd of [
      'pause',
      'resume',
      'clear',
      'add fix the bug',
      'sequence a; b',
    ]) {
      const label = outcomeNeutralLabel(cmd);
      expect(label.startsWith('Goal requested: ')).toBe(true);
    }
    expect(outcomeNeutralLabel('pause')).toBe('Goal requested: pause');
    // Root-only extraction: no user objective leaked into the toast.
    expect(outcomeNeutralLabel('add my secret objective text')).toBe(
      'Goal requested: add',
    );
  });

  test('mutating vs read-only command classification', () => {
    for (const cmd of [
      'pause',
      'resume',
      'clear',
      'edit x',
      'checkpoint note',
      'focus g1',
      'add obj',
      'sequence a;b',
      'handback',
      'review-payload',
    ]) {
      expect(isMutatingGoalCommand(cmd)).toBe(true);
    }
    for (const cmd of ['list', 'history', 'status', 'dashboard', '']) {
      expect(isMutatingGoalCommand(cmd)).toBe(false);
    }
  });
});

describe('host-aware watchdog hints', () => {
  test('v2 hint NEVER advises the /goal slash entry and NEVER names internal tools', () => {
    const msg = watchdogTimeoutMessage('v2', 'pause', 15000);
    expect(msg).not.toContain('/goal');
    expect(msg).not.toContain('goal-command');
    expect(msg).toContain('Goal palette');
    expect(msg).toContain('pause');
  });

  test('v1 hint MAY advise /goal (works there) but still never names internal tools', () => {
    const msg = watchdogTimeoutMessage('v1', 'resume', 15000);
    expect(msg).toContain('/goal resume');
    expect(msg).not.toContain('goal-command');
    expect(msg).toContain('Goal palette');
  });

  test('both hints carry the command ROOT, not full arguments', () => {
    const v2 = watchdogTimeoutMessage(
      'v2',
      'add super secret objective details',
      15000,
    );
    expect(v2).toContain('"add"');
    expect(v2).not.toContain('super secret');
  });
});

/**
 * Deterministic watchdog waits. A fixed `setTimeout(60)` racing a 30 ms timer is
 * a flake, and the user 2026-09-24 banned weakening flakes away rather than fixing
 * them — so:
 * - POSITIVE ("it fired"): await the notify callback, so the test runs for
 * exactly as long as the timer needs and can neither pass early nor fail late.
 * - NEGATIVE ("it did not fire"): arm a sentinel watchdog with the SAME timeout
 * and await its fire. When the sentinel fires, the real timer's deadline has
 * demonstrably passed, so a surviving timer would already have been seen.
 */
function fireSignal(): {fired: Promise<string>; notify: (m: string) => void} {
  let resolve!: (m: string) => void;
  const fired = new Promise<string>(r => {
    resolve = r;
  });
  return {fired, notify: (m: string) => resolve(m)};
}

function afterDeadline(timeoutMs: number): Promise<void> {
  const sentinel = fireSignal();
  const w = createGoalWatchdogs('v1', sentinel.notify, timeoutMs);
  w.arm('__sentinel__', 'pause');
  return sentinel.fired.then(() => undefined);
}

describe('shared watchdog semantics (effective-or-visibly-failed)', () => {
  test('timeout fires exactly one honest notification with the host hint', async () => {
    const seen: string[] = [];
    const {fired, notify} = fireSignal();
    const w = createGoalWatchdogs(
      'v1',
      m => {
        seen.push(m);
        notify(m);
      },
      30,
    );
    w.arm('s1', 'pause');
    const message = await fired;
    // POL-5: sub-second timeouts render "<1s" honestly, never "0s".
    expect(message).toContain('did not land within <1s');
    await afterDeadline(30); // a lingering second timer would notify again here
    expect(seen.length).toBe(1);
    expect(w.armedCount).toBe(0);
  });

  test('disarmSession before timeout suppresses the failure notice (confirmed effect)', async () => {
    const seen: string[] = [];
    const w = createGoalWatchdogs('v1', m => seen.push(m), 40);
    w.arm('s1', 'pause');
    w.disarmSession('s1');
    expect(w.armedCount).toBe(0); // the timer is gone — this IS the mechanism
    await afterDeadline(40);
    expect(seen.length).toBe(0);
  });

  test('disarm is session-scoped; re-arm dedupes the same session+root pair', async () => {
    const seen: string[] = [];
    const w = createGoalWatchdogs('v2', m => seen.push(m), 40);
    w.arm('s1', 'pause');
    w.arm('s2', 'pause');
    expect(w.armedCount).toBe(2);
    w.disarmSession('s1');
    expect(w.armedCount).toBe(1);

    w.arm('s2', 'pause'); // re-arm resets the timer instead of stacking
    w.arm('s2', 'pause');
    expect(w.armedCount).toBe(1);
    w.disarmSession('s2');
    expect(w.armedCount).toBe(0);
    await afterDeadline(40);
    expect(seen.length).toBe(0);
  });
});

describe('source-level parity grep-locks', () => {
  const v1 = readFileSync(new URL('../src/tui.ts', import.meta.url), 'utf8');
  const v2 = readFileSync(new URL('../src/tui-v2.ts', import.meta.url), 'utf8');

  test('no pre-emptive success-flavored action toasts survive in either companion', () => {
    for (const banned of [
      '"Pausing active goal…"',
      '"Resuming goal…"',
      '"Clearing goal(s)…"',
      '"Adding new goal…"',
    ]) {
      expect(v1.includes(banned)).toBe(false);
      expect(v2.includes(banned)).toBe(false);
    }
  });

  test('no internal tool names in user-visible watchdog/label strings', () => {
    expect(v1.includes('did not execute goal-command')).toBe(false);
    expect(v2.includes('did not execute goal-command')).toBe(false);
  });

  test('both companions consume the single shared label module', () => {
    expect(v1.includes("from './tui-action-labels.ts'")).toBe(true);
    expect(v2.includes("from './tui-action-labels.ts'")).toBe(true);
  });
});
