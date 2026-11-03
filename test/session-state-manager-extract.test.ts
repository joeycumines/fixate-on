import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// Task #39: SessionStateManager cohesion extraction (contract test)
//
// plugin-runtime.ts exceeded CLAUDE.md's ~900-line target (1311 lines).
// SessionStateManager (multi-goal session tracking: focused/backgrounded/archive/
// ordered-sequences/WAL-write coordination) is a distinct concern consumed only
// by the GoalsPlugin factory. The fix extracts it — together with the runtime
// isolation machinery it owns (RuntimeState interface, createRuntimeState,
// runtimeStorage, MAX_ARCHIVED_PER_SESSION) — into a new cohesive module
// src/session-state-manager.ts.
//
// Acyclicity forces the shape: the shared runtime-state machinery moves DOWN
// with the manager (to the lower module). plugin-runtime.ts imports FROM the new
// module; the new module imports only leaf types. One direction → DAG.
//
// These tests lock the contract. They are RED until the extraction lands.

const SRC = join(import.meta.dir, '..', 'src');
const NEW_MODULE = 'session-state-manager';
const EXTRACTED_FROM = 'plugin-runtime';

/** Strip comments then extract local import/export targets (mirrors no-circular-deps.test.ts). */
async function localImports(file: string): Promise<string[]> {
  const source = await readFile(join(SRC, `${file}.ts`), 'utf8');
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = noBlocks.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    let inS = false,
      inD = false,
      inB = false,
      cut = line.length;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (!inD && !inB && ch === "'") inS = !inS;
      else if (!inS && !inB && ch === '"') inD = !inD;
      else if (!inS && !inD && ch === '`') inB = !inB;
      else if (!inS && !inD && !inB && ch === '/' && line[i + 1] === '/') {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  const clean = out.join('\n');
  const re = /(?:import|export)\s[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g;
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    targets.push(m[1].replace(/^.*\//, '').replace(/\.ts$/, ''));
  }
  return targets;
}

test('#39: SessionStateManager lives in its own cohesive module (session-state-manager.ts)', async () => {
  // The extraction exists. This fails (ENOENT) before the split.
  const source = await readFile(join(SRC, 'session-state-manager.ts'), 'utf8');
  // The class and the runtime isolation machinery it owns moved here.
  expect(source).toMatch(/class SessionStateManager\b/);
  // RuntimeState/createRuntimeState/runtimeStorage moved to session-runtime.ts
  // (re-exported from this module); assert the re-export, not the definition.
  expect(source).toMatch(
    /export \{[^}]*createRuntimeState[^}]*runtimeStorage[^}]*\} from '\.\/session-runtime\.ts'/,
  );
  expect(source).toMatch(/MAX_ARCHIVED_PER_SESSION/);
});

test('#39: session-state-manager.ts imports only leaf modules (no back-edge to plugin-runtime/plugin/plugin-v2)', async () => {
  // The acyclic contract: the new module must NOT import back into the wiring
  // entries (plugin-runtime/plugin/plugin-v2). If it did, the extraction would
  // re-introduce a cycle. Leaf types only.
  const targets = await localImports(NEW_MODULE);
  const backEdges = ['plugin-runtime', 'plugin', 'plugin-v2'].filter(t =>
    targets.includes(t),
  );
  if (backEdges.length > 0) {
    expect(
      `session-state-manager.ts imports ${backEdges.join(', ')} (re-introduces a cycle)`,
    ).toBe('session-state-manager.ts must import only leaf modules');
  }
  expect(backEdges).toEqual([]);
});

test('#39: plugin-runtime.ts imports session-state-manager.ts (the extracted symbols are consumed one-directionally)', async () => {
  // The factory consumes the manager. Confirm the forward edge exists (the split
  // is wired, not orphaned) AND that the moved symbols no longer linger as
  // duplicate declarations in plugin-runtime.ts.
  const targets = await localImports(EXTRACTED_FROM);
  expect(targets).toContain(NEW_MODULE);

  // The class definition must have LEFT plugin-runtime.ts (moved, not copied).
  const runtimeSource = await readFile(join(SRC, 'plugin-runtime.ts'), 'utf8');
  expect(runtimeSource).not.toMatch(/^class SessionStateManager\b/m);
});
