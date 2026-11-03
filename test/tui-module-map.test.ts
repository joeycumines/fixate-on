import {describe, expect, test} from 'bun:test';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

// The TUI module map
//
// docs/tui-integration.md carries a table of every TUI module and what it
// imports. That table was hand-maintained and had rotted: four modules had no
// row at all, five rows omitted dependencies the module really has, and one
// row said "None" for a module that imports two others. Nothing checked it, so
// a reader could not tell a row that was true from one that had drifted.
//
// The single source of truth is each module's actual import graph, derived by
// this file, and the document's table is asserted against that same
// derivation. A row that drifts from the code fails; a module missing from the
// table fails.
//
// Both assertions have floors, because a gate that finds nothing has proved
// nothing.

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
const DOC = join(ROOT, 'docs/tui-integration.md');

async function tuiModules(): Promise<string[]> {
  const entries = await readdir(SRC);
  return entries.filter(name => /^tui.*\.tsx?$/.test(name)).sort();
}

/**
 * Local (in-repo) modules a file imports, by basename without extension.
 *
 * THREE FORMS, and only the first was seen before. `from "./x"` is the static
 * form; a SIDE-EFFECT import (`import "./x"`) has no bindings and no `from`, and
 * a DYNAMIC one (`await import("./x")`) has neither — so a TUI module gaining
 * either produced an incomplete set, and since BOTH directions of the table are
 * computed from it, such a module's row could omit a real dependency and its
 * `// Depends on:` header could too, with the gate green. That is the same hole
 *c closed in `test/no-circular-deps.test.ts` in this very change set,
 * left open in the sibling extractor.
 *
 * Single quotes are included because nothing in `src/` uses them today, and a
 * second copy of a rule is a second thing to keep correct.
 */
async function localImports(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  const found = new Set<string>();
  const add = (match: string | undefined): void => {
    if (match) found.add(match);
  };
  for (const m of source.matchAll(
    /(?:import|export)[^;'"]*?\bfrom\s+["']\.\/([A-Za-z0-9_.-]+?)(?:\.ts|\.tsx)?["']/g,
  ))
    add(m[1]);
  for (const m of source.matchAll(
    /(?:^|[\s;{(])(?:import|export)\s+["']\.\/([A-Za-z0-9_.-]+?)(?:\.ts|\.tsx)?["']/g,
  )) {
    add(m[1]);
  }
  for (const m of source.matchAll(
    /\bimport\s*\(\s*["']\.\/([A-Za-z0-9_.-]+?)(?:\.ts|\.tsx)?["']\s*\)/g,
  )) {
    add(m[1]);
  }
  return [...found].sort();
}

/**
 * The dependency names a module's row in docs/tui-integration.md claims, as
 * backticked bare module names in the deps cell.
 */
async function documentedDeps(name: string): Promise<string[]> {
  const doc = await readFile(DOC, 'utf8');
  const row = new RegExp(
    `^\\|\\s*\`src/${name.replace(/[.]/g, '\\.')}\`\\s*\\|[^|]*\\|([^|]*)\\|`,
    'm',
  ).exec(doc);
  if (!row) return [];
  return [...row[1].matchAll(/`([a-z0-9-]+)(?:\.tsx?)?`/g)]
    .map(m => m[1])
    .filter(bare => bare !== name.replace(/\.tsx?$/, ''));
}

/**
 * Every SCREAMING_SNAKE name exported from a module under src/. Built once,
 * because the check that uses it is about the documents naming symbols that
 * exist — a name in a table that no module exports is a name a reader cannot
 * follow, and a rename is the ordinary way that happens.
 */
const exportedSymbols = new Set<string>();
for (const file of await readdir(SRC)) {
  if (!/\.tsx?$/.test(file)) continue;
  const text = await readFile(join(SRC, file), 'utf8');
  for (const m of text.matchAll(
    /^export (?:const|function|class|type) ([A-Z][A-Z0-9_]{2,})/gm,
  )) {
    exportedSymbols.add(m[1]);
  }
}

describe('the TUI module map is derived, not remembered', () => {
  test('every TUI module is covered by the table check below', async () => {
    const modules = await tuiModules();
    expect(modules.length).toBeGreaterThanOrEqual(12);
  });

  test("the documented module table matches each module's real imports in both directions", async () => {
    const modules = await tuiModules();
    expect(modules.length).toBeGreaterThanOrEqual(12);
    const problems: string[] = [];
    let checked = 0;

    for (const name of modules) {
      const real = await localImports(join(SRC, name));
      checked++;
      const documented = await documentedDeps(name);
      const missing = real.filter(dep => !documented.includes(dep));
      const phantom = documented.filter(dep => !real.includes(dep));
      if (missing.length || phantom.length) {
        problems.push(
          `src/${name}: imports [${real.join(', ')}] but the table says [${documented.join(', ')}]` +
            (missing.length
              ? ` — missing from the table: ${missing.join(', ')}`
              : '') +
            (phantom.length
              ? ` — in the table but not imported: ${phantom.join(', ')}`
              : ''),
        );
      }
    }
    // Liveness: the assertion above is only meaningful if it compared a real
    // number of modules, not an empty set.
    expect(checked).toBeGreaterThanOrEqual(12);
    expect(problems).toEqual([]);
  });

  test('the documented module table lists every module with the imports it really has', async () => {
    const doc = await readFile(DOC, 'utf8');
    // BOTH prose columns are captured, not just the dependency column. The Role
    // column names identifiers, and a renamed identifier is exactly what rots
    // there: a commit in this change set renamed GOAL_DISPLAY_NAME to
    // PRODUCT_DISPLAY_NAME and this table went on naming the old one, in a
    // shipped document, with the gate below green throughout — because the gate
    // matched the Role column and threw it away.
    const rows = new Map<string, {role: string; deps: string}>();
    for (const line of doc.split('\n')) {
      const row = /^\|\s*`(src\/[A-Za-z0-9_.-]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(
        line,
      );
      if (row) rows.set(row[1], {role: row[2], deps: row[3]});
    }
    expect(
      rows.size,
      'the module table in docs/tui-integration.md was not found',
    ).toBeGreaterThanOrEqual(12);

    const modules = await tuiModules();
    const problems: string[] = [];
    for (const name of modules) {
      const path = `src/${name}`;
      const cell = rows.get(path);
      if (cell === undefined) {
        problems.push(`${path} has no row in the module table`);
        continue;
      }
      const real = await localImports(join(SRC, name));
      // The cell names modules by bare name; a row that omits one of the
      // module's real imports is the rot this file exists to stop.
      for (const dep of real) {
        if (dep === name.replace(/\.tsx?$/, '')) continue;
        if (!cell.deps.includes(dep))
          problems.push(`${path} imports ${dep} but its row does not say so`);
      }

      // Every CONSTANT the Role column names must be exported by something in
      // src/. A renamed or deleted symbol is otherwise invisible here, and this
      // table ships: a host author follows the name and finds nothing.
      for (const [, symbol] of cell.role.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
        if (!exportedSymbols.has(symbol)) {
          problems.push(
            `${path} names ${symbol} in its role, but no module under src/ exports that name`,
          );
        }
      }
    }
    // THE REVERSE DIRECTION, which was the missing half and let a stale row ship.
    // Everything above iterates over REAL imports and asks whether the row names
    // them; nothing asked whether everything the row names is a real import. So a
    // PHANTOM entry is invisible — and `docs/tui-integration.md`'s row for
    // `src/tui.ts` had exactly that, naming `brake-format.ts` and
    // `status-label.ts` after the list row moved into `goalListRow` and neither
    // became a direct import again. Verified by inserting a fabricated dependency
    // into that row and watching this file stay green.
    //
    // Reading the reverse is fiddly because the cell is prose, not a list: it
    // contains dependency names, a `plus` clause for non-module imports, and
    // parenthetical explanations. So a name counts as a claimed dependency only
    // when it is backticked, names a real module, and is not one of the module
    // itself — and anything backticked that LOOKS like a module but is not one is
    // the phantom this direction is here to catch.
    const knownExternals = new Set([
      '@opencode-ai/plugin',
      '@opencode-ai/plugin/tui',
    ]);
    // EVERY module under src/, not `tuiModules` — a row legitimately names
    // non-TUI modules (state-machine.ts, accounting.ts), and checking the reverse
    // direction against a TUI-only list flags every one of them. The first version
    // of this check reported nine such findings, all of them correct rows.
    const allModules = new Set(
      (await readdir(SRC))
        .filter(f => /\.tsx?$/.test(f))
        .map(f => f.replace(/\.tsx?$/, '')),
    );
    for (const [path, cell] of rows) {
      const name = path.replace('src/', '');
      const real = new Set(await localImports(join(SRC, name)));
      for (const [, token] of cell.deps.matchAll(/`([^`]+)`/g)) {
        if (
          knownExternals.has(token) ||
          token === 'GoalStatus' ||
          token === 'PluginOptions'
        )
          continue;
        const bare = token.replace(/\.tsx?$/, '');
        if (!/^[a-z0-9-]+$/.test(bare)) continue;
        // A module that exists but is not imported by this one.
        if (allModules.has(bare)) {
          if (!real.has(bare)) {
            problems.push(
              `${path}'s row claims a dependency on ${bare}, which it does not import — a phantom ` +
                'entry in a table a host author reads as a description of the code',
            );
          }
        } else if (!token.includes(' ')) {
          // A backticked bare word that names no module at all: either a symbol or
          // a stale module name. Symbols are caught by the role check above; a
          // name in dependency position is the phantom.
          problems.push(
            `${path}'s row claims a dependency on ${token}, which is not a module under src/`,
          );
        }
      }
    }

    // And no row for a module that no longer exists.
    for (const path of rows.keys()) {
      if (!modules.includes(path.replace('src/', '')))
        problems.push(`${path} is documented but does not exist`);
    }
    expect(problems).toEqual([]);
  });
});
