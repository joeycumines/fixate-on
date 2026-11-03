import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// Dependency-graph invariant: no circular imports (task #38)
//
// CLAUDE.md mandates "No circular dependencies": if A imports from B and B
// imports from A, the graph is not a DAG and module-eval order becomes a
// latent, environment-dependent failure. The v2 port (commit e016272)
// introduced a value-cycle: plugin.ts re-exported `default` from plugin-v2.ts,
// while plugin-v2.ts imported the `GoalsPlugin` value from plugin.ts. It worked
// only by module-eval-order luck.
//
// The fix (task #38) extracts the GoalsPlugin composition root into
// plugin-runtime.ts, so both plugin.ts and plugin-v2.ts import FROM it
// (one-directional), and the cycle is gone. These tests lock that invariant.
//
// NOTE on the plugin.ts → plugin-v2.ts edge: it is REQUIRED and legitimate.
// The bundle entry is src/plugin.ts (the committed shim
// plugin/fixate-on.js re-exports./fixate-on/plugin.js,
// and opencode_dev hardcodes that path), so plugin.ts's `default` export MUST
// be the v2 shape `{ id, setup }`, which it re-exports from plugin-v2.ts. The
// cycle was never that edge — it was the REVERSE edge (plugin-v2 → plugin).
// These tests guard the reverse edge, not the required one.

const SRC = join(import.meta.dir, '..', 'src');

/**
 * Strip comments from TS source so a code-like string inside a comment can never
 * be misread as an import (the cycle detector must never fabricate an edge from
 * prose). Block comments `/* … *\/` are removed first (naive: this codebase does
 * not put `/*` inside string/regex literals); then line comments `//…` are
 * removed with string-literal awareness (so a URL like `"http://x"` in a real
 * import is preserved and its `//` is not mistaken for a comment).
 */
function stripComments(source: string): string {
  // 1. Block comments (multiline, non-greedy). Applied before string scanning.
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // 2. Line comments, string-aware.
  const lines = noBlocks.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    let inSingle = false,
      inDouble = false,
      inBack = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\') {
        i++;
        continue;
      } // skip the escaped char
      if (!inDouble && !inBack && ch === "'") inSingle = !inSingle;
      else if (!inSingle && !inBack && ch === '"') inDouble = !inDouble;
      else if (!inSingle && !inDouble && ch === '`') inBack = !inBack;
      else if (
        !inSingle &&
        !inDouble &&
        !inBack &&
        ch === '/' &&
        line[i + 1] === '/'
      ) {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join('\n');
}

/**
 * Extract every relative import edge from a source file.
 *
 * THREE forms, and the first two were invisible until a reviewer added them:
 *
 * 1. `import... from "./foo"` and `export... from "../foo"` — the static form,
 * which the original regex required because it looked for ` from `.
 * 2. `import "./foo"` — a SIDE-EFFECT import. No bindings and no `from`, so the
 * static regex did not match it. It is a real ES-module edge and a real
 * cycle: the reviewer added one above `plugin-runtime.ts` and this gate
 * stayed green through a clean `tsc`.
 * 3. `await import("./foo")` / `import("./foo")` — a DYNAMIC import. Same
 * argument, and `plugin-v2.ts` is loaded this way in production.
 *
 * The invariant AGENTS.md states is over imports, not over `from` clauses, so a
 * checker that only sees clauses is checking a narrower thing than the rule.
 */
function extractLocalImports(source: string): string[] {
  const targets: string[] = [];
  const clean = stripComments(source);
  // Normalize: strip a trailing.ts; strip a trailing /index (barrel — forbidden anyway).
  const push = (raw: string): void => {
    targets.push(raw.replace(/\.ts$/, '').replace(/\/index$/, ''));
  };
  // 1. static, with bindings
  const reStatic =
    /(?:import|export)\s[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = reStatic.exec(clean)) !== null) push(m[1]);
  // 2. side-effect only: `import "./foo"` — no `from`, so it cannot match above
  const reSideEffect =
    /(?:^|[\s;{(])(?:import|export)\s+["'](\.{1,2}\/[^"']+)["']/g;
  while ((m = reSideEffect.exec(clean)) !== null) push(m[1]);
  // 3. dynamic: `import("./foo")`
  const reDynamic = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  while ((m = reDynamic.exec(clean)) !== null) push(m[1]);
  return targets;
}

/** Basename of a relative import target: "./plugin-runtime" -> "plugin-runtime". */
function basename(target: string): string {
  return target.replace(/^.*\//, '');
}

async function buildLocalImportGraph(): Promise<Map<string, Set<string>>> {
  const {readdir} = await import('node:fs/promises');
  const files = (await readdir(SRC)).filter(f => f.endsWith('.ts'));
  const graph = new Map<string, Set<string>>();
  for (const f of files) {
    const name = f.replace(/\.ts$/, '');
    const source = await readFile(join(SRC, f), 'utf8');
    graph.set(name, new Set(extractLocalImports(source).map(basename)));
  }
  return graph;
}

/** Tarjan-style cycle detection: returns the first cycle found (as a node list), or null if acyclic. */
function findCycle(graph: Map<string, Set<string>>): string[] | null {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.keys()) color.set(n, WHITE);
  const stack: string[] = [];
  let result: string[] | null = null;

  function visit(u: string): boolean {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of graph.get(u) ?? []) {
      if (!graph.has(v)) continue; // external / non-local target
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        // Found a back-edge u→v; extract the cycle from the stack.
        const start = stack.indexOf(v);
        result = stack.slice(start).concat(v);
        return true;
      }
      if (c === WHITE && visit(v)) return true;
    }
    color.set(u, BLACK);
    stack.pop();
    return false;
  }

  for (const n of graph.keys()) {
    if (color.get(n) === WHITE && visit(n)) break;
  }
  return result;
}

test('#38: the src/ module import graph has no circular dependencies', async () => {
  const graph = await buildLocalImportGraph();
  // LIVENESS FIRST. `findCycle` over an empty graph returns null and
  // `expect(cycle).toBeNull` passes, so a corpus that failed to enumerate would
  // report "no cycles" and mean "no data". Every sibling corpus gate in this
  // repository carries an explicit floor for exactly this — doc-integrity,
  // file-size-rule, host-config-accuracy, identity-constants, tui-module-map — and
  // this one did not, which makes the assertion below the only gate here that
  // could pass vacuously.
  expect(
    graph.size,
    'the import graph is empty, so the cycle check below compared nothing — SRC did not enumerate',
  ).toBeGreaterThanOrEqual(30);
  const cycle = findCycle(graph);
  if (cycle) {
    // Fail with a clear message naming the cycle.
    expect(cycle.join(' → ')).toBe('no cycle (found the cycle above)');
  }
  expect(cycle).toBeNull();
});

test('#38: plugin-v2.ts does not statically import from plugin.ts (the removed cycle edge)', async () => {
  // The cycle was: plugin.ts re-exports `default` from plugin-v2.ts (REQUIRED —
  // the bundle entry is src/plugin.ts, whose default export must be the v2
  // shape), AND plugin-v2.ts imported the `GoalsPlugin` value back from
  // plugin.ts. The fix redirects plugin-v2's import to plugin-runtime.ts.
  // This test guards the precise regression: if anyone re-adds an import of
  // plugin.ts into plugin-v2.ts, the cycle returns. (plugin.ts → plugin-v2 is
  // the legitimate, required direction and is NOT asserted against here.)
  const source = await readFile(join(SRC, 'plugin-v2.ts'), 'utf8');
  const targets = extractLocalImports(source).map(basename);
  const importsPlugin = targets.includes('plugin');
  if (importsPlugin) {
    expect('plugin-v2.ts imports plugin.ts (re-introduces the cycle)').toBe(
      'plugin-v2.ts must import its runtime deps from plugin-runtime.ts, not plugin.ts',
    );
  }
  expect(importsPlugin).toBe(false);
});

test('#38: plugin-runtime.ts (the extracted composition root) does not import plugin.ts or plugin-v2.ts', async () => {
  // plugin-runtime.ts is the sink of the v1/v2 wiring layer: both plugin.ts
  // and plugin-v2.ts import FROM it. If it imported either back, a cycle would
  // return. This locks the one-directional property of the extraction.
  const source = await readFile(join(SRC, 'plugin-runtime.ts'), 'utf8');
  const targets = new Set(extractLocalImports(source).map(basename));
  const backEdges = ['plugin', 'plugin-v2'].filter(t => targets.has(t));
  if (backEdges.length > 0) {
    expect(
      `plugin-runtime.ts imports ${backEdges.join(', ')} (re-introduces a cycle)`,
    ).toBe('plugin-runtime.ts must not import plugin.ts or plugin-v2.ts');
  }
  expect(backEdges).toEqual([]);
});

// The extractor's own coverage, and it exists because a mutation of the
// side-effect branch SURVIVED: `src/` contains no side-effect import, so disabling
// that branch changed nothing observable and the gate reported nothing. The rule
// was enforced and unexercised at the same time — which is what a liveness floor
// is for, applied here to the EXTRACTOR rather than to the graph.
//
// A synthetic source is the honest fixture: the alternative is inventing a
// side-effect import in the product to give the gate something to bite, which is
// the "write a test that forces the defect into existence" shape rather than a
// test of the rule.
test('#38a: the import extractor sees all three import forms', () => {
  const cases: Array<[string, string, string[]]> = [
    ['static with bindings', 'import { a } from "./alpha.ts"\n', ['alpha']],
    ['static re-export', 'export { b } from "./beta.ts"\n', ['beta']],
    ['side effect, no bindings', 'import "./gamma.ts"\n', ['gamma']],
    [
      'side effect after a statement',
      'const x = 1;\nimport "./delta.ts"\n',
      ['delta'],
    ],
    ['dynamic', 'const m = await import("./epsilon.ts")\n', ['epsilon']],
    ['bare dynamic', 'import("./zeta.ts")\n', ['zeta']],
    [
      'parent directory',
      'import type { T } from "../shared/types.ts"\n',
      ['types'],
    ],
  ];
  for (const [label, source, expected] of cases) {
    const found = extractLocalImports(source).map(basename);
    expect(
      found,
      `${label}: ${JSON.stringify(source)} -> ${JSON.stringify(found)}`,
    ).toEqual(expected);
  }
  // And the things it must NOT see, or the graph would be full of phantom edges.
  for (const [label, source] of [
    ['a bare specifier', 'import x from "zod"\n'],
    ['a node builtin', 'import { readFile } from "node:fs/promises"\n'],
    ['a commented-out import', '// import "./commented.ts"\n'],
    ['a block-commented import', '/* import "./blocked.ts" */\n'],
  ] as Array<[string, string]>) {
    expect(extractLocalImports(source), label).toEqual([]);
  }
});
