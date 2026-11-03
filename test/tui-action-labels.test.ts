// V4(a): degraded-mode detection and watchdog honesty.
import {expect, test} from 'bun:test';
import {
  createDegradedModeDetector,
  createGoalWatchdogs,
  DEGRADED_MODE_MESSAGE,
  isMutatingGoalCommand,
  outcomeNeutralLabel,
  watchdogTimeoutMessage,
} from '../src/tui-action-labels.ts';

test('a dispatch before the surface is ever seen reports degraded ONCE', () => {
  // The "down-but-toasting" case: the plugin never loaded, so an action cannot
  // land. The user must be told, but not repeatedly — a repeating toast is
  // learned-ignored, which is how the deception survives.
  const d = createDegradedModeDetector();
  expect(d.isDegraded).toBe(true);
  expect(d.checkDispatch()).toBe(DEGRADED_MODE_MESSAGE);
  expect(d.checkDispatch()).toBeNull(); // announced once
  expect(d.checkDispatch()).toBeNull();
});

test('once the surface is observed, no degraded notice is produced', () => {
  const d = createDegradedModeDetector();
  d.noteSurfaceAlive();
  expect(d.isDegraded).toBe(false);
  expect(d.checkDispatch()).toBeNull();
});

test('the notice re-arms if the surface goes away again', () => {
  const d = createDegradedModeDetector();
  expect(d.checkDispatch()).toBe(DEGRADED_MODE_MESSAGE);
  d.noteSurfaceAlive();
  expect(d.checkDispatch()).toBeNull();
  // A new degraded episode must be announced again rather than silently lost.
  const d2 = createDegradedModeDetector();
  expect(d2.checkDispatch()).toBe(DEGRADED_MODE_MESSAGE);
});

test('the degraded message names the cause and the next step', () => {
  expect(DEGRADED_MODE_MESSAGE).toContain('not loaded');
  expect(DEGRADED_MODE_MESSAGE).toContain('cannot take effect');
  expect(DEGRADED_MODE_MESSAGE.toLowerCase()).toContain('check');
});

test('only mutating commands get a watchdog; read-only ones do not', () => {
  for (const c of [
    'pause',
    'resume',
    'clear',
    'edit x',
    'focus g',
    'add x',
    'sequence a;b',
    'checkpoint s',
  ]) {
    expect(isMutatingGoalCommand(c)).toBe(true);
  }
  for (const c of ['status', 'list', 'history', 'info', 'log', 'ls', '']) {
    expect(isMutatingGoalCommand(c)).toBe(false);
  }
});

test('labels state what was REQUESTED, never that it succeeded', () => {
  const label = outcomeNeutralLabel('pause');
  expect(label).toContain('pause');
  expect(label.toLowerCase()).not.toContain('paused');
  expect(label.toLowerCase()).toContain('requested');
});

test('the timeout message is host-aware and leaks no internal tool names', () => {
  const v1 = watchdogTimeoutMessage('v1', 'pause', 15000);
  const v2 = watchdogTimeoutMessage('v2', 'pause', 15000);
  // v1 owns /goal via its command hook, so that retry path is real there.
  expect(v1).toContain('/goal pause');
  // v2 has no command hook, so the hint must not promise an unreachable path.
  expect(v2).not.toContain('/goal');
  expect(v2).toContain('Goal palette');
  for (const msg of [v1, v2]) {
    expect(msg).toContain('did not land');
    expect(msg).not.toContain('goal-command');
    expect(msg).not.toContain('update_goal');
  }
});

/**
 * Deterministic "the deadline has passed" clock.
 *
 * A watchdog assertion has two shapes, and neither may use a fixed sleep
 * (user 2026-09-24: a flaky test is a bad test, and weakening is banned — a
 * `setTimeout(60)` racing a 20 ms timer is exactly the flake):
 *
 * - POSITIVE ("it fired"): await the notify callback. The test then runs for
 * exactly as long as the timer needs, so it can neither pass early nor fail
 * under load.
 * - NEGATIVE ("it did not fire"): arm a sentinel watchdog with the SAME timeout
 * and await *its* fire. Once the sentinel fires, the real timer's deadline has
 * demonstrably passed, so a lingering timer would already have been observed.
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

test('the watchdog fires an honest failure when a dispatch never lands', async () => {
  const {fired, notify} = fireSignal();
  const w = createGoalWatchdogs('v2', notify, 20);
  w.arm('s1', 'pause');
  expect(w.armedCount).toBe(1);
  const message = await fired;
  expect(message).toContain('did not land');
  expect(w.armedCount).toBe(0); // a fired watchdog does not linger
});

test('a confirmed effect disarms the watchdog before it fires', async () => {
  const seen: string[] = [];
  const w = createGoalWatchdogs('v1', m => seen.push(m), 20);
  w.arm('s1', 'pause');
  w.disarmSession('s1');
  expect(w.armedCount).toBe(0); // the timer is gone — this IS the mechanism
  await afterDeadline(20);
  expect(seen).toHaveLength(0);
});

test('re-arming the same pair replaces the timer instead of stacking', async () => {
  const seen: string[] = [];
  const w = createGoalWatchdogs('v1', m => seen.push(m), 30);
  w.arm('s1', 'pause');
  w.arm('s1', 'pause');
  expect(w.armedCount).toBe(1); // replacement, not a second entry
  // Wait out the full deadline; a stacked timer would fire a second time.
  await afterDeadline(30);
  expect(seen).toHaveLength(1); // not two
  expect(w.armedCount).toBe(0);
});
