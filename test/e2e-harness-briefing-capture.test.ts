// e2e-harness-briefing-capture.test.ts — the live briefing assertion must read
// sampled boot frames, not a capture overwritten by later campaign steps.
//
// Measured 2026-11-20: the v2 dashboard campaign's boot pane showed
// "1 goal needs you: paused", but the assertion read a later `01-boot.ansi`
// after the goal-creation poll had already replaced it, and reported that no
// briefing rendered. This pin locks the harness's sampled-frame contract so a
// transient toast cannot be erased by a later capture before it is checked.
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';

const DRIVE = new URL(
  '../hack/e2e-harness/drive.sh',
  import.meta.url,
).pathname;

test('the v2 briefing assertion samples boot frames instead of one mutable capture', () => {
  const script = readFileSync(DRIVE, 'utf8');
  expect(script).toContain('01-boot-*.ansi');
  expect(script).toContain('boot_frame_has_briefing');
  expect(script).not.toContain('grep -aqE "goals? need" "$CAP/01-boot.ansi"');
});
