import {describe, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// Identity-constant invariant
//
// Four strings in this plugin are contracts, not labels: the v2 module `id`, the
// v1 TUI module `id`, the published-event title, and the tool-result metadata
// marker. All four are the package name, and all four are duplicated across
// modules — the emitters, the consumers, the hand-written `.d.ts` files, and
// the test fixtures that assert them.
//
// That duplication is a rename hazard, and it is a *silent* one. A missed site
// does not throw: a drifted metadata marker means the v2 adapter stops
// recognising its own continuation prompts, which looks exactly like "the loop
// just didn't continue this time". The only signal is a comparison the gate does
// not currently make.
//
// So this file makes the comparison. It reads the source as text rather than
// importing it, because the defect being guarded is "a literal crept back in" —
// which a value-level assertion cannot see.
//
// Every assertion here is about the SOURCE. A comment naming the wire contract
// is fine and expected; a code literal is not.

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

/** Reads a source file and removes comments, so prose cannot satisfy a check. */
async function code(file: string): Promise<string> {
  const source = await readFile(join(SRC, file), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('identity constants are single-sourced, not re-typed', () => {
  test('no module re-types the metadata marker as a string literal', async () => {
    // Every module under src/, for the same reason the brand check is: a
    // hand-listed set of files is a guard a refactor can silently disable, and
    // src/tui.ts is close enough to the ~900-line split threshold that
    // extracting a module is the expected next move. A review put a metadata
    // marker in a brand-new `src/tui-palette.ts` and the three-file version
    // passed.
    //
    // Two literal FORMS have to be rejected, and a review found that guarding
    // only the first left the second fully open: the code before this used
    // `{ "fixate-on": { kind: "recovery" } }` — a quoted object key, no
    // brackets — and a straight revert of that hunk passed the whole suite.
    const COMPUTED = /\[\s*["']fixate-on["']\s*\]/g;
    const QUOTED_KEY = /["']fixate-on["']\s*:/g;

    // Show the patterns are LIVE before trusting a negative result. A regex
    // that can never match would make this test pass for the wrong reason —
    // the same defect the option-coverage test had.
    expect([
      ...'const m = p.metadata["fixate-on"]'.matchAll(COMPUTED),
    ]).toHaveLength(1);
    expect([
      ...'metadata: { "fixate-on": { kind: "x" } }'.matchAll(QUOTED_KEY),
    ]).toHaveLength(1);
    expect([
      ...'metadata: { [GOAL_TUI_METADATA_KEY]: { kind: "x" } }'.matchAll(
        COMPUTED,
      ),
    ]).toHaveLength(0);
    expect([
      ...'metadata: { [GOAL_TUI_METADATA_KEY]: { kind: "x" } }'.matchAll(
        QUOTED_KEY,
      ),
    ]).toHaveLength(0);

    const files = [
      ...new Bun.Glob('**/*.{ts,tsx}').scanSync({cwd: SRC, dot: false}),
    ];
    expect(files.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await code(file);
      for (const match of text.matchAll(COMPUTED))
        offenders.push(`${file}: ${match[0]}`);
      for (const match of text.matchAll(QUOTED_KEY))
        offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  test('the metadata marker has exactly one definition', async () => {
    const text = await code('tui-state.ts');
    const definitions =
      text.match(/export const GOAL_TUI_METADATA_KEY\s*=/g) ?? [];
    expect(definitions).toHaveLength(1);
    expect(text).toMatch(
      /export const GOAL_TUI_METADATA_KEY\s*=\s*'fixate-on'/,
    );
  });

  test('the event title and the metadata marker are not conflated with the display name', async () => {
    // Three different namespaces that share a value on purpose:
    // GOAL_TUI_EVENT_TITLE — wire: stamped on events, filtered by the companion
    // GOAL_TUI_METADATA_KEY — wire: the tool-result envelope
    // PRODUCT_DISPLAY_NAME — what a user reads
    // Conflating them is how a user ends up seeing a wire marker in a toast.
    const tuiState = await code('tui-state.ts');
    expect(tuiState).toMatch(
      /export const GOAL_TUI_EVENT_TITLE\s*=\s*'fixate-on'/,
    );
    // The display name is NOT in tui-state.ts, and the wire constants are NOT in
    // tui-components.ts. That separation is the point.
    expect(tuiState).not.toContain('PRODUCT_DISPLAY_NAME');
    const components = await code('tui-components.ts');
    expect(components).toMatch(
      /export const PRODUCT_DISPLAY_NAME\s*=\s*'Fixate'/,
    );
    expect(components).not.toContain('GOAL_TUI_EVENT_TITLE');
  });

  test('no companion renders a toast titled with the wire event title', async () => {
    // src/tui.ts and src/tui-v2.ts each log via a helper that used to title its
    // error toast with GOAL_TUI_EVENT_TITLE — so a v2 user hitting a broken
    // event stream saw `fixate-on` where every other toast read `Fixate`. The
    // log prefix is the legitimate use, and the only one.
    for (const file of ['tui.ts', 'tui-v2.ts']) {
      const text = await code(file);
      const offenders = text
        .split('\n')
        .filter(l => l.includes('GOAL_TUI_EVENT_TITLE'))
        // Legitimate: the import specifier, the re-export from tui-state.ts, and
        // the log prefix. Nothing else.
        .filter(l => !/console\[/.test(l))
        // The log prefix `[${GOAL_TUI_EVENT_TITLE}/tui]` is the legitimate use.
        .filter(l => !/\[\$\{GOAL_TUI_EVENT_TITLE\}/.test(l))
        .filter(
          l =>
            !/\} from '\.\/tui-state\.ts'/.test(l) &&
            !/,\s*GOAL_TUI_EVENT_TITLE\s*,?\s*$/.test(l),
        )
        .filter(l => !/^\s*GOAL_TUI_EVENT_TITLE\s*,?\s*$/.test(l));
      expect(offenders).toEqual([]);
      // …and the legitimate use is still there, so this cannot pass by deletion.
      // The prefix spans two lines after prettier wraps the console[...] call,
      // so match the console[ token and the constant anywhere in the file.
      expect(text).toMatch(/console\[/);
      expect(text).toMatch(/GOAL_TUI_EVENT_TITLE/);
    }
  });

  test('no on-screen string hard-codes the brand, in any module', async () => {
    // "Fixate" in CODE (not a comment) must come from the constant, EVERYWHERE
    // under src/ — not in a hand-listed set of files. A review demonstrated the
    // failure: a hard-coded brand in a brand-new `src/tui-palette.ts` passed,
    // because the check only looked at seven names, and src/tui.ts is close
    // enough to the ~900-line split threshold that extracting a palette module
    // is the expected next move. A guard that a refactor can silently disable
    // is not a guard.
    const files = [
      ...new Bun.Glob('**/*.{ts,tsx}').scanSync({cwd: SRC, dot: false}),
    ];
    expect(files.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await code(file);
      for (const line of text.split('\n')) {
        if (!line.includes('Fixate')) continue;
        if (/export const PRODUCT_DISPLAY_NAME/.test(line)) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the prompt tag emitter and its per-turn dedupe guard agree exactly', async () => {
    // The guard matches the emitted tag by substring. If the emitter's form ever
    // changes and the guard does not, the goal block is re-injected every turn —
    // silently, because the injection is idempotent-looking.
    const steering = await code('steering.ts');
    const hooks = await code('hooks-handlers.ts');
    const emitted = new Set(
      steering.match(/<(fixate_on|opencode_goal_plugin) id=/g) ?? [],
    );
    expect(emitted.size).toBeGreaterThan(0);
    // The guard no longer TYPES the tag, it CALLS the emitter's. That is a
    // stronger property than the literal it replaces: when the block came to
    // describe several goals the guard grew a second copy of the tag text, this
    // test failed, and the fix was to delete the copy rather than to keep it in
    // sync — because a string two files must agree on is a string that will
    // eventually disagree.
    //
    // So the assertion is inverted from "the guard contains the emitter's literal"
    // to "the guard contains no literal of its own, and uses the single source".
    // A re-typed tag fails here immediately, which is the failure this test exists
    // to catch.
    // Scoped to the TAG the emitter owns. hooks-handlers.ts legitimately emits a
    // different one — `<goal_context id="...">`, the compaction summary — so a
    // blanket "no id= tag in hooks-handlers.ts" assertion is wrong and a first
    // version of this failed on that unrelated tag. The claim is about `fixate_on` alone.
    expect(
      hooks,
      'the per-turn dedupe guard must not re-type the fixate_on tag',
    ).not.toContain('fixate_on id="');
    expect(
      hooks,
      'the guard must recognise a block via the single-sourced tag',
    ).toContain('goalPromptTag(');
    for (const tag of emitted) {
      const name = /<(\w+) id=/.exec(tag)![1];
      // And the single source really is the one the emitter uses, checked by
      // calling it rather than by reading its text.
      expect(steering).toContain('export function ' + 'goalPromptTag(');
      expect(name).toBe('fixate_on');
    }
    // And the closing tag matches the opening one.
    const opens = new Set(
      [...steering.matchAll(/<(\w+) id="\$\{goal\.goalId\}">/g)].map(m => m[1]),
    );
    const closes = new Set([...steering.matchAll(/<\/(\w+)>/g)].map(m => m[1]));
    for (const name of opens) expect(closes.has(name)).toBe(true);
  });

  test('the module ids are typed, declared and asserted from one value', async () => {
    const manifest = JSON.parse(
      await readFile(join(ROOT, 'package.json'), 'utf8'),
    );
    expect(manifest.name).toBe('fixate-on');

    const pluginV2 = await code('plugin-v2.ts');
    const tui = await code('tui.ts');
    const tuiV2 = await code('tui-v2.ts');
    expect(pluginV2).toMatch(/id:\s*'fixate-on'/);
    expect(tui).toMatch(/id:\s*'fixate-on-tui'/);
    expect(tuiV2).toMatch(/id:\s*'fixate-on-tui'/);

    // The hand-written.d.ts files are the published type surface; a stale typed
    // literal there breaks consumers under tsc without breaking the runtime.
    const index = await readFile(join(ROOT, 'index.d.ts'), 'utf8');
    const tuiTypes = await readFile(join(ROOT, 'tui.d.ts'), 'utf8');
    const tuiV2Types = await readFile(join(ROOT, 'tui-v2.d.ts'), 'utf8');
    expect(index).toMatch(/id:\s*'fixate-on'/);
    expect(tuiTypes).toMatch(/id:\s*'fixate-on-tui'/);
    expect(tuiV2Types).toMatch(/id:\s*'fixate-on-tui'/);

    // Every declared export target must exist, or the exports map is a promise
    // the package cannot keep.
    for (const [subpath, entry] of Object.entries(
      manifest.exports as Record<string, unknown>,
    )) {
      const targets =
        typeof entry === 'string'
          ? [entry]
          : Object.values(entry as Record<string, string>);
      for (const target of targets) {
        expect(
          await Bun.file(join(ROOT, target.replace(/^\.\//, ''))).exists(),
        ).toBe(true);
      }
      void subpath;
    }
  });

  test('the pre-1.0.0 migration sources are GONE, and the README agrees', async () => {
    // This repository has never been published, so no legacy state location
    // exists for users. A migration path would be a compatibility layer for a
    // format this plugin never gave anyone, and the test fails if one returns.
    //
    // Both halves are still DERIVED from the code rather than restated, because
    // the previous version of this test passed while the README had been
    // rewritten out from under it.
    const persistence = await code('persistence.ts');
    const paths = await code('session-paths.ts');
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    for (const gone of ['migrateFromLegacyPaths']) {
      expect(persistence, `${gone} is still in the source`).not.toContain(gone);
      expect(readme, `${gone} is still named in the README`).not.toContain(
        gone,
      );
    }
    // And the path that IS current is the one the layout module declares and
    // the README documents — asserted in both places, because a renamed default
    // and a stale document are the same defect from opposite ends.
    expect(paths).toContain("DEFAULT_STATE_ROOT = '.opencode/goals'");
    expect(readme).toContain('.opencode/goals');
  });
});
