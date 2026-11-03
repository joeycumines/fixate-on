import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// Task #40: hooks.ts must not redeclare canonical types (DRY / divergence trap)
//
// hooks.ts declared its own `RuntimeState` (8-field subset) and
// `DefaultGoalOptionsRef` (10-field required subset) while the canonical
// 16-field `RuntimeState` and 14-field `DefaultGoalOptions` live in
// session-state-manager.ts (where createRuntimeState / DEFAULT_GOAL_OPTIONS
// are defined). Structural typing satisfied both subsets silently, so the
// local declarations could drift from the canonical ones without any type
// error — a divergence trap. The factory passes the canonical superset, so
// hooks consumes it through the canonical type.
//
// These tests lock the dedup. They are RED until the local declarations are
// removed and the canonical types imported.

const SRC = join(import.meta.dir, '..', 'src');

async function read(file: string): Promise<string> {
  return readFile(join(SRC, `${file}.ts`), 'utf8');
}

test('#40: hooks.ts no longer declares a local RuntimeState interface', async () => {
  const source = await read('hooks');
  // The local 8-field subset declaration must be gone.
  expect(source).not.toMatch(/export interface RuntimeState\b/);
  expect(source).not.toMatch(/^\s*interface RuntimeState\b/m);
});

test('#40: hooks.ts no longer declares a local DefaultGoalOptionsRef interface', async () => {
  const source = await read('hooks');
  expect(source).not.toMatch(/DefaultGoalOptionsRef/);
});

test('#40: hooks.ts imports the canonical RuntimeState from session-state-manager.ts', async () => {
  const source = await read('hooks');
  // The canonical type is now consumed, not redeclared.
  expect(source).toMatch(/from\s+["']\.\/session-state-manager\.ts["']/);
  // RuntimeState must appear in a type position tied to that import.
  expect(source).toMatch(/RuntimeState\b/);
});

test('#40: the canonical RuntimeState in session-runtime.ts still owns the full shape', async () => {
  const source = await read('session-runtime');
  expect(source).toMatch(/export interface RuntimeState\b/);
  // Every field hooks reads (seenTokens, seenUsage, seenOutputTokens,
  // continuationControllers, promptInFlightSessions, threadToolsRegistered)
  // must remain present on the canonical type.
  for (const field of [
    'seenTokens',
    'seenUsage',
    'seenOutputTokens',
    'continuationControllers',
    'promptInFlightSessions',
    'threadToolsRegistered',
  ]) {
    expect(source).toMatch(new RegExp(`\\b${field}\\b`));
  }
});
