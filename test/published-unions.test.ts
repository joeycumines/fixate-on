import {describe, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// Published-union fidelity
//
// `index.d.ts` is hand-written, and hand-written unions drift silently. Two were
// already wrong the day they were transcribed: `ClaimCheckPath` lost a member and
// invented another, `ClaimCheckVerdict` shipped 5 of its 10. Nothing caught
// either, because a wrong union member in a `.d.ts` is not a compile error — it
// is a narrower or wider type than the runtime actually produces, which surfaces
// as a confusing assignment error in someone else's config.
//
// The unions are compared member for member against the module that owns them.
// `test/published-docs-accuracy.test.ts` covers the scalar `@default` values;
// this covers the closed sets, which is where a hand transcription is most
// likely to be wrong and least likely to be noticed.

const ROOT = join(import.meta.dir, '..');

/** String-literal members of a `export type X = | "a" | "b"` declaration. */
function unionMembers(source: string, name: string): string[] {
  // COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidy. The
  // declaration terminator below stops at a blank line or a block comment, so a
  // DOCUMENTED member — `| "poll-idle"` with a doc comment above it — was cut off
  // at the comment and the gate measured a union one member short of the real one.
  // It reported 15 against a source of 16 and the only honest reading was that the
  // gate was wrong, which is the conclusion this file exists to avoid reaching for.
  // A union whose members carry documentation is the NORMAL case, not an edge, so
  // the extractor has to read past comments rather than around them.
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const declaration = new RegExp(
    `export type ${name}\\s*=([\\s\\S]*?)(?=\\nexport |\\n\\n|\\n\\/\\*)`,
  ).exec(clean);
  if (!declaration) return [];
  return [...declaration[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
}

/**
 * Required (present, non-optional) property names of an interface. `readonly` is
 * a mutability modifier, not an optionality one — `readonly goalId: string` is
 * required — so both spellings are collected and only `?` is excluded.
 */
function requiredFields(source: string, name: string): string[] {
  const declaration = new RegExp(
    `export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!declaration) return [];
  return (
    declaration[1]
      .split('\n')
      .map(line => /^ {2}(?:readonly )?([a-zA-Z][a-zA-Z0-9]*)\??:/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => m[1])
      // The `m` flag is load-bearing and was missing. The captured interface body
      // BEGINS WITH A NEWLINE, so `^` without `m` anchors at offset 0 — that
      // newline — and the pattern can never match anything. Every optional member
      // was therefore counted as required: five of them on GoalTuiSnapshot alone
      // (artifactPointers, pendingProposal, claims, lastClaim, origin). Two-sided
      // weakness followed from it: weakening a field to optional in the published
      // type went unnoticed, and weakening one on BOTH sides cancelled out. Found
      // by re-introducing each and watching the test stay green.
      .filter(
        field =>
          !new RegExp(`^\\s{2}(?:readonly )?${field}\\?:`, 'm').test(
            declaration[1],
          ),
      )
      .sort()
  );
}

async function read(file: string): Promise<string> {
  return readFile(join(ROOT, file), 'utf8');
}

describe('published unions and required fields match the source', () => {
  // The unions and interfaces compared here live in goal-types.ts (the type
  // module extracted from state-machine.ts); state-machine.ts re-exports them.
  const MACHINE = 'src/goal-types.ts';
  const TUI_STATE = 'src/tui-state.ts';

  test('each compared union is found on BOTH sides, and its members match exactly', async () => {
    // A union that is missing from index.d.ts would otherwise make `dts` an empty
    // array and the comparison trivially pass on an empty-vs-empty basis — so
    // both sides must be non-empty, which is what the `length` floor enforces.
    const unions: [string, string][] = [
      [MACHINE, 'ClaimCheckPath'],
      [MACHINE, 'ClaimCheckVerdict'],
      [MACHINE, 'ClaimOutcomeStatus'],
      [MACHINE, 'ClaimActor'],
      [MACHINE, 'TransitionSource'],
      [MACHINE, 'GoalStatus'],
      [TUI_STATE, 'GoalTuiEventKind'],
    ];
    const types = await read('index.d.ts');
    for (const [file, name] of unions) {
      const source = await read(file);
      const fromSource = unionMembers(source, name);
      const fromTypes = unionMembers(types, name);
      expect(fromSource.length, `${name} not found in ${file}`).toBeGreaterThan(
        0,
      );
      expect(fromTypes.length, `${name} not exported from index.d.ts`).toBe(
        fromSource.length,
      );
      expect(
        fromTypes,
        `${name} drifted between ${file} and index.d.ts`,
      ).toEqual(fromSource);
    }
  });

  test("GoalTuiEvent's required fields match, so a transport implementation compiles", async () => {
    // This is the shape `tuiTransport` receives. It is compared as a required-field
    // set rather than field-for-field: a missing REQUIRED field is what makes the
    // only correct implementation fail to compile, and optional-field mismatches
    // are what make it silently wrong.
    const source = await read(TUI_STATE);
    const types = await read('index.d.ts');
    const fromSource = requiredFields(source, 'GoalTuiEvent');
    const fromTypes = requiredFields(types, 'GoalTuiEvent');
    expect(fromSource.length).toBeGreaterThan(0);
    expect(fromTypes).toEqual(fromSource);
  });

  test("GoalTuiSnapshot's required fields match", async () => {
    const source = await read(TUI_STATE);
    const types = await read('index.d.ts');
    const fromSource = requiredFields(source, 'GoalTuiSnapshot');
    const fromTypes = requiredFields(types, 'GoalTuiSnapshot');
    expect(fromSource.length).toBeGreaterThan(10);
    expect(fromTypes).toEqual(fromSource);
  });

  test('CommitTransition, ClaimRecord, ClaimCheck and ClaimOutcome required fields match', async () => {
    const source = await read(MACHINE);
    const types = await read('index.d.ts');
    for (const name of [
      'CommitTransition',
      'ClaimRecord',
      'ClaimCheck',
      'ClaimOutcome',
      'GoalProposal',
    ]) {
      const fromSource = requiredFields(source, name);
      const fromTypes = requiredFields(types, name);
      expect(
        fromSource.length,
        `${name} not found in ${MACHINE}`,
      ).toBeGreaterThan(0);
      expect(fromTypes, `${name} drifted`).toEqual(fromSource);
    }
  });

  test('the published tuiTransport signature is the real one', async () => {
    // Not a regex over the.d.ts for tidiness: this is the assertion that would
    // have caught the original defect, which was a hand-written approximation
    // that omitted two required fields of GoalTuiEvent.
    const source = await read(TUI_STATE);
    const types = await read('index.d.ts');
    // The real publish fn, from the module that owns it. Whitespace-flexible:
    // the declaration is one line in the source and multi-line in the.d.ts.
    expect(source).toMatch(
      /export type GoalTuiPublishFn\s*=\s*\(\s*sessionID:\s*string,\s*event:\s*GoalTuiEvent,?\s*\)\s*=>\s*Promise<void>\s*\|\s*void/,
    );
    // The published option must reference that type, not restate it.
    const option = /\n {2}tuiTransport\?: ([^;\n]+)/.exec(types)?.[1];
    expect(option, 'tuiTransport is not declared in index.d.ts').toBeTruthy();
    expect(option).toBe('GoalTuiPublishFn');
  });
});
