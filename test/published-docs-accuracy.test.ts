import {describe, expect, test} from 'bun:test';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DEFAULT_GOAL_OPTIONS} from '../src/session-state-manager.ts';

// Published-documentation accuracy
//
// `index.d.ts` is hand-written and is the ONLY type surface a consumer gets.
// Its `@default` annotations are documentation a user sets an option against,
// and they had drifted: five of them contradicted
// `DEFAULT_GOAL_OPTIONS` (maxTurns 10 vs 0, maxDurationMs 900000 vs 1800000,
// maxTokens 200000 vs 1000000, and two stall brakes at 2 vs 3). `maxTurns: 10`
// also contradicted the README's own "the turn brake is disabled by default".
//
// `index.d.ts` type checking cannot catch this: it compiles a consumer, and a doc
// comment that is wrong still compiles. So the comparison has to be made here.
//
// The table below is the point. Each row names a documented option and the
// authoritative source of its default; a new option added to the code without a
// documented default (or a changed default without a doc change) fails here.

const ROOT = join(import.meta.dir, '..');

async function readIndexTypes(): Promise<string> {
  return readFile(join(ROOT, 'index.d.ts'), 'utf8');
}

/**
 * Reads the `@default` annotation from the doc comment immediately above a
 * given option in index.d.ts. Returns the raw annotation text (e.g. `"0"`,
 * `"true"`, `"<cwd>/.opencode/goals/state.json"`) or null when there is none.
 *
 * Scoped tightly, because a loose version credits a neighbour: the comment must
 * start with `/**` (not `*` continuation of an earlier block) and must contain
 * only that member's documentation — no intervening code. A review showed that
 * "last `/**` before the member, reject only on a blank line" returns a
 * NEIGHBOUR's value for an undocumented member sitting directly above a
 * documented one.
 */
function documentedDefault(source: string, option: string): string | null {
  const member = new RegExp(`^  ${option}\\?:`, 'm').exec(source);
  if (!member) return null;
  const before = source.slice(0, member.index);
  const open = before.lastIndexOf('/**');
  const close = before.lastIndexOf('*/');
  if (open < 0 || close < open) return null;
  // The comment must belong to THIS member: between its `*/` and the member
  // there may be nothing but whitespace. An undocumented member sitting
  // directly above a documented one therefore yields null rather than
  // borrowing the neighbour's value.
  if (before.slice(close + 2).trim() !== '') return null;
  const defaults = [
    ...before.slice(open).matchAll(/@default\s+([^\n*]+)/g),
  ].map(m => m[1].trim());
  return defaults.length > 0 ? defaults[defaults.length - 1] : null;
}

describe('published type surface matches the code', () => {
  // option -> the live value, read from the module that owns it.
  const GOAL_BRAKES = {
    maxTokens: DEFAULT_GOAL_OPTIONS.maxTokens,
    maxTurns: DEFAULT_GOAL_OPTIONS.maxTurns,
    maxDurationMs: DEFAULT_GOAL_OPTIONS.maxDurationMs,
    minDelayMs: DEFAULT_GOAL_OPTIONS.minDelayMs,
    maxPromptFailures: DEFAULT_GOAL_OPTIONS.maxPromptFailures,
    maxRecentMessages: DEFAULT_GOAL_OPTIONS.maxRecentMessages,
    noProgressTokenThreshold: DEFAULT_GOAL_OPTIONS.noProgressTokenThreshold,
    noProgressTurnsBeforePause: DEFAULT_GOAL_OPTIONS.noProgressTurnsBeforePause,
    noToolCallTurnsBeforePause: DEFAULT_GOAL_OPTIONS.noToolCallTurnsBeforePause,
    budgetWrapupRatio: DEFAULT_GOAL_OPTIONS.budgetWrapupRatio,
    maxRecoveryTurns: DEFAULT_GOAL_OPTIONS.maxRecoveryTurns,
    maxUnchangedResults: DEFAULT_GOAL_OPTIONS.maxUnchangedResults,
    maxBlockedTurns: DEFAULT_GOAL_OPTIONS.maxBlockedTurns,
    languageTriage: DEFAULT_GOAL_OPTIONS.languageTriage,
  };

  test("every documented goal-brake default equals the code's", async () => {
    const source = await readIndexTypes();
    const mismatches: string[] = [];
    for (const [option, actual] of Object.entries(GOAL_BRAKES)) {
      const documented = documentedDefault(source, option);
      expect(
        documented,
        `${option} has no @default annotation in index.d.ts`,
      ).not.toBeNull();
      if (String(actual) !== documented) {
        mismatches.push(
          `${option}: index.d.ts says ${documented}, code has ${actual}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('the turn brake is documented as disabled, matching the code', async () => {
    // The most consequential single value in the file: a user reading
    // "maxTurns: 10" would believe the loop stops on its own, which is exactly
    // the assumption AGENTS.md Principle 4 forbids relying on.
    const source = await readIndexTypes();
    expect(documentedDefault(source, 'maxTurns')).toBe('0');
    expect(DEFAULT_GOAL_OPTIONS.maxTurns).toBe(0);
  });

  /**
   * The value the CODE uses for an option, read out of the module that owns it.
   *
   * The non-brake table this replaces named its owning module in a comment and
   * then never read it: `expected` held a LITERAL, so the assertion was
   * `index.d.ts == a constant in this file` and the modules were decoration. Two
   * mutations proved it — changing `resultRetentionMs ?? 604800000` to `?? 1`
   * in plugin-runtime.ts, and the idle-poller default in hooks.ts, each left this
   * file entirely green while the document and the code disagreed.
   *
   * So the value is DERIVED: find the option's `?? <default>` in the module named,
   * then compute it. The right-hand side is not always a literal
   * (`2 * 1024 * 1024`, `MAX_ARCHIVED_PER_SESSION`), so a bare numeric match would
   * miss half the table; a named constant is resolved by reading its declaration.
   * Evaluation is restricted to digits and arithmetic operators, so this cannot
   * execute anything from the tree.
   *
   * Returns `null` when the option has no such fallback in that module, which
   * FAILS the test rather than passing it — a default that moved to a different
   * form must be noticed, not skipped.
   */
  async function codeDefault(
    moduleFile: string,
    option: string,
  ): Promise<number | null> {
    // COMMENTS STRIPPED FIRST. `test/no-circular-deps.test.ts` strips them in this
    // same change set, precisely so a code-like string inside a comment cannot be
    // misread as code — and its extractor and this one had OPPOSITE policies,
    // which is the same error twice. The live vector is narrow: a comment above
    // the real line duplicating the documented value (`// warnTurnsRemaining?? 3`)
    // would be read instead of the code, and the gate would report the documented
    // number while the code used something else.
    const raw = await readFile(join(ROOT, 'src', moduleFile), 'utf8');
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => {
        const at = line.search(/(?:^|[\s{;(])\/\/(?![^\s]*:\/\/)/);
        return at < 0 ? line : line.slice(0, at);
      })
      .join('\n');
    const re = new RegExp(`\\b${option}\\s*\\?\\?\\s*([^\\n,;)]+)`);
    const m = re.exec(source);
    if (!m) return null;
    let rhs = m[1].trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rhs)) {
      // A named constant: find its declaration anywhere in src/.
      for (const entry of await readdir(join(ROOT, 'src'))) {
        if (!/\.tsx?$/.test(entry)) continue;
        const other = await readFile(join(ROOT, 'src', entry), 'utf8');
        const decl = new RegExp(
          `(?:export\\s+)?const\\s+${rhs}\\s*(?::[^=]+)?=\\s*([^\\n;]+)`,
        ).exec(other);
        if (decl) {
          rhs = decl[1].trim();
          break;
        }
      }
    }
    if (!/^[\d\s*+\-()._]+$/.test(rhs)) return null;
    // Digit separators are stripped rather than evaluated: `30_000` is thirty
    // thousand to a reader and a syntax error to `Number`, and normalising here
    // keeps the whitelist to digits and arithmetic.
    // No `no-new-func` suppression: this repo's rule set does not enable the
    // rule, so the directive was an unused directive — a warning lint reports.
    // The whitelist on the line above is the actual guarantee, and it is
    // checked immediately before this call.
    return Number(new Function(`return (${rhs.replace(/_/g, '')})`)());
  }

  test('the non-brake defaults are the ones the CODE uses, not the ones this file remembers', async () => {
    const source = await readIndexTypes();
    // The module that owns each option, which the previous version wrote in a
    // comment and then ignored. Now it is what the value is read from.
    const owners: Record<string, string> = {
      resultRetentionMs: 'plugin-runtime.ts',
      kickoffDelayMs: 'plugin-kickoff.ts',
      warnTurnsRemaining: 'steering.ts',
      warnDurationMsRemaining: 'steering.ts',
      warnTokensRemaining: 'steering.ts',
      idlePollerIntervalMs: 'hooks.ts',
      idleQuietMs: 'hooks.ts',
      idleGraceMs: 'hooks.ts',
      ledgerMaxBytes: 'session-state-manager.ts',
      ledgerRetentionFiles: 'session-state-manager.ts',
      maxStoredResults: 'session-state-manager.ts',
    };
    const mismatches: string[] = [];
    for (const [option, moduleFile] of Object.entries(owners)) {
      const documented = documentedDefault(source, option);
      const actual = await codeDefault(moduleFile, option);
      if (actual === null) {
        mismatches.push(
          `${option}: no \`?? <default>\` fallback found in src/${moduleFile}, so the documented ` +
            `value (${documented ?? 'none'}) is unchecked`,
        );
        continue;
      }
      if (documented === null || String(actual) !== documented) {
        mismatches.push(
          `${option}: index.d.ts says ${documented ?? '(undocumented)'}, ` +
            `src/${moduleFile} uses ${actual}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('the default state ROOT is the one the code resolves', async () => {
    const source = await readIndexTypes();
    expect(documentedDefault(source, 'stateRoot')).toBe(
      "'<cwd>/.opencode/goals'",
    );
    // And the code really does fall back to exactly that.
    const runtime = await readFile(
      join(ROOT, 'src', 'plugin-runtime.ts'),
      'utf8',
    );
    expect(runtime).toContain('explicitStateRoot ?? DEFAULT_STATE_ROOT');
    // The default is a DIRECTORY, and the module that owns the layout says so
    // in the value rather than in a comment — so a reader of either one cannot
    // be misled into treating it as a file.
    const paths = await readFile(join(ROOT, 'src', 'session-paths.ts'), 'utf8');
    expect(paths).toContain(
      "export const DEFAULT_STATE_ROOT = '.opencode/goals'",
    );
  });

  /**
   * The three `warn*` options are documented as a warning "included in status
   * output", which was wrong about the code: `src/steering.ts` appends
   * `Approaching limits: …` to the line the continuation loop already sends the
   * model, and no status surface prints it at all. A reader who set
   * `warnTurnsRemaining` expecting to see a warning in `/goal status` would see
   * nothing, and would have no way to know the threshold had fired.
   *
   * Derived from the CODE rather than restated: the assertion is that the
   * documented surface is the module that actually emits the string, found by
   * searching src/ for it. Restating "the docstring must say continuation
   * prompt" would be the same defect as the original — a comparison against a
   * literal in this file.
   */
  test('the warn* options are documented against the surface that emits the warning', async () => {
    const source = await readIndexTypes();

    // Where the warning is actually written, discovered rather than named.
    const emitters: string[] = [];
    for (const entry of await readdir(join(ROOT, 'src'))) {
      if (!/\.tsx?$/.test(entry)) continue;
      if (
        (await readFile(join(ROOT, 'src', entry), 'utf8')).includes(
          'Approaching limits',
        )
      ) {
        emitters.push(entry);
      }
    }
    // A liveness floor: if the string were renamed in the code, an empty list
    // would make this test vacuously true — the exact failure the module-map
    // and defaults tables above guard against for themselves.
    expect(
      emitters.length,
      'no src/ module emits the limit-approaching warning any more — update this test',
    ).toBeGreaterThan(0);
    expect(
      emitters,
      'the warning must be emitted by exactly one module',
    ).toHaveLength(1);
    expect(emitters[0]).toBe('steering.ts');

    for (const option of [
      'warnTurnsRemaining',
      'warnDurationMsRemaining',
      'warnTokensRemaining',
    ]) {
      const member = source.indexOf(`  ${option}?:`);
      expect(member, `${option} is not declared in index.d.ts`).toBeGreaterThan(
        -1,
      );
      const doc = source.slice(source.lastIndexOf('/**', member), member);
      expect(
        doc.toLowerCase(),
        `${option} must name the CONTINUATION PROMPT, which is where steering.ts writes it`,
      ).toContain('continuation prompt');
      expect(
        doc.toLowerCase(),
        `${option} must not claim the warning appears in status output — no status surface prints it`,
      ).not.toContain('included in status output');
    }
  });

  test('the published option set has no member the code dropped', async () => {
    // The direction that catches a HALF-finished rename: `stateFilePath` was
    // removed from the code in this change, and had it stayed in the type
    // surface a user would configure it, get no error, and silently get the
    // default layout.
    const source = await readIndexTypes();
    expect(source).not.toContain('stateFilePath');
    expect(source).not.toContain('ledgerFilePath');
    const runtime = await readFile(
      join(ROOT, 'src', 'plugin-runtime.ts'),
      'utf8',
    );
    expect(runtime).not.toContain('stateFilePath');
    expect(runtime).not.toContain('ledgerFilePath');
  });

  test('every option the code accepts is documented', async () => {
    // The direction that matters: a user who finds an option in the README must
    // be able to find it in the types, or `tsc` rejects their config. Both
    // halves of this have been wrong before — the type surface omitted eight
    // options the code consumes, one of which (`kickoffDelayMs`) is documented
    // in prose.
    //
    // The floor below is not decoration. A review renamed the source interface
    // and this test still passed: the regex found nothing, the accepted set was
    // empty, and "every accepted option is documented" is trivially true of an
    // empty set. An extraction that finds fewer than 40 members has broken, not
    // been satisfied.
    const source = await readIndexTypes();
    const documented = new Set(
      [...source.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\?:/gm)].map(m => m[1]),
    );
    // PluginOptions moved to plugin-options.ts (re-exported from plugin-runtime.ts).
    const runtime = await readFile(
      join(ROOT, 'src', 'plugin-options.ts'),
      'utf8',
    );
    const interfaceBody =
      /export interface PluginOptions \{([\s\S]*?)\n\}/.exec(runtime)?.[1];
    expect(
      interfaceBody,
      'PluginOptions was not found in src/plugin-options.ts',
    ).toBeTruthy();
    const accepted = new Set(
      [
        ...(interfaceBody as string).matchAll(
          /^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm,
        ),
      ].map(m => m[1]),
    );
    expect(accepted.size).toBeGreaterThan(40);
    const undocumented = [...accepted].filter(o => !documented.has(o)).sort();
    expect(undocumented).toEqual([]);
  });
});
