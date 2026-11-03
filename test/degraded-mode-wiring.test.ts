// V4(a): the degraded-mode detector must be WIRED into both companions.
//
// The companions are host-coupled (they call api.ui.toast / context.ui.toast)
// and are not unit-testable in isolation, so this locks the wiring at the
// source level. Without it, deleting the two lines that consult the detector
// would leave every test green while restoring the "down-but-toasting"
// deception — the companion would report a vague timeout instead of telling the
// user the plugin is not loaded.
import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
const read = (f: string) => readFile(join(SRC, f), 'utf8');

test('both companions import and construct the degraded-mode detector', async () => {
  // The v2 companion's detector lives in tui-v2-events.ts (the metadata
  // channel the v2 companion reads), so that module is checked alongside the
  // two entrypoints.
  for (const file of ['tui.ts', 'tui-v2.ts', 'tui-v2-events.ts']) {
    const s = await read(file);
    if (file === 'tui-v2.ts') {
      expect(s).toContain('tui-v2-events.ts');
      continue;
    }
    expect(s).toContain('createDegradedModeDetector');
    expect(s).toContain('const degraded = createDegradedModeDetector()');
  }
});

test('the watchdog timeout consults the detector before showing the message', async () => {
  for (const file of ['tui.ts', 'tui-v2.ts']) {
    const s = await read(file);
    // The degraded notice must take precedence over the generic timeout text.
    expect(s).toMatch(/degraded\.checkDispatch\(\)\s*\?\?/);
  }
});

test('both companions record surface liveness from observed goal state', async () => {
  const v1 = await read('tui.ts');
  // v1 shows the plugin is alive when a store event arrives (state moved).
  expect(v1).toContain('degraded.noteSurfaceAlive()');
  const v2 = await read('tui-v2-events.ts');
  // v2 shows it when a goal event is decoded from the tool metadata channel.
  expect(v2).toContain('degraded.noteSurfaceAlive()');
});

test('the detector is only ever satisfied by real evidence, never assumed', async () => {
  // A blanket `noteSurfaceAlive` at startup would defeat the whole purpose:
  // the companion would always believe the plugin was up.
  for (const file of ['tui.ts', 'tui-v2-events.ts']) {
    const s = await read(file);
    const calls = s.split('noteSurfaceAlive()').length - 1;
    expect(calls).toBe(1);
  }
});
