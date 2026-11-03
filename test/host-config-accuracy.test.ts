// host-config-accuracy.test.ts — every option a CONFIG names must be an option
// the plugin still accepts.
//
// WHY THIS EXISTS. `stateFilePath` was replaced by `stateRoot` in this change
// set, and TWO `opencode.json` files under `scripts/e2e-harness/` kept naming
// it. Nothing went red. Not the suite, not `tsc` (JSON is not type-checked
// against the option bag), not the harness contract — it ran and passed. The
// configs had become decorative: they configured nothing, and a harness whose
// state isolation is written in a file that no longer says anything is a test
// that passes for the wrong reason.
//
// This is the same defect the project has paid for three times, in a different
// medium. A shipped document that describes something the code does not do is
// this repository's own recorded central failure mode; an `opencode.json` in
// the repository that configures an option the plugin dropped is that same lie
// in a form no gate could see.
//
// The check is derived, not restated: the accepted option keys come from the
// PUBLISHED `GoalsPluginOptions` in index.d.ts, which `test/published-unions`
// and `test/published-host-surface` already pin to the source. A config naming
// a key that is not in that bag is this test failing.

import {describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** Every `opencode.json` the repository tracks. */
function trackedConfigs(): string[] {
  return execFileSync('git', ['ls-files', '*opencode.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(p => p !== '');
}

/** The option keys `index.d.ts` publishes, read from the interface body. */
function publishedOptionKeys(): Set<string> {
  const source = readFileSync(join(ROOT, 'index.d.ts'), 'utf8');
  const body = source.slice(
    source.indexOf('export interface GoalsPluginOptions'),
    source.indexOf(
      '\n}',
      source.indexOf('export interface GoalsPluginOptions'),
    ),
  );
  expect(
    body.length,
    'GoalsPluginOptions was not found in index.d.ts',
  ).toBeGreaterThan(200);
  return new Set(
    [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map(m => m[1]!),
  );
}

/**
 * The `options` of every PLUGIN entry in a config, and nothing else.
 *
 * Scoped to the plugin array on purpose. A first version walked every `options`
 * object in the document and reported `provider.openrouter.options.baseURL` as
 * an unknown plugin option — the host's provider configuration is not the
 * plugin's, and a gate that cannot tell the two would cry wolf on the first
 * config it met. The plugin entry is the object carrying `package`.
 */
function pluginOptionKeys(
  config: unknown,
  path = '',
): {key: string; at: string}[] {
  const found: {key: string; at: string}[] = [];
  const root = (config ?? {}) as Record<string, unknown>;
  // OpenCode accepts `plugin` and `plugin` as an array; the harness configs use
  // the plural spelling, which is what actually ships, so both are read.
  const entries: unknown[] = [];
  for (const key of ['plugin', 'plugins']) {
    const value = root[key];
    if (Array.isArray(value)) entries.push(...value);
    else if (value) entries.push(value);
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    // TWO SHAPES, both real. The object form is `{"package": "…", "options":
    // {…}}`; the TUPLE form is `["file://…/fixate-on.js", {…}]`. The first
    // version of this gate read only the object form, so `cfg-v1` — one of the
    // two configs this gate exists to check — was skipped entirely, and adding
    // an option that does not exist to it left the suite green. A gate that
    // silently covers half the corpus is worse than none: it reports clean.
    const record = Array.isArray(entry)
      ? {package: entry[0], options: entry[1]}
      : (entry as Record<string, unknown>);
    if (typeof record['package'] !== 'string') continue;
    const options = record['options'];
    if (!options || typeof options !== 'object' || Array.isArray(options))
      continue;
    for (const option of Object.keys(options as Record<string, unknown>)) {
      found.push({key: option, at: `${path} (${option})`});
    }
  }
  return found;
}

describe('every option a tracked config names is an option the plugin accepts', () => {
  test('the published option bag is not empty', () => {
    // A floor on the extraction, or a parser that silently found nothing makes
    // every assertion below vacuously true.
    expect(publishedOptionKeys().size).toBeGreaterThan(40);
  });

  test('no tracked opencode.json names an option that no longer exists', () => {
    const published = publishedOptionKeys();
    const problems: string[] = [];
    let seen = 0;
    for (const relative of trackedConfigs()) {
      const absolute = join(ROOT, relative);
      if (!existsSync(absolute)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(absolute, 'utf8'));
      } catch {
        // A config that does not parse is a different defect, and something
        // else reports it. Skipping keeps this test about option names.
        continue;
      }
      for (const {key, at} of pluginOptionKeys(parsed, relative)) {
        seen += 1;
        if (!published.has(key))
          problems.push(
            `${relative}: ${at} names "${key}", which the plugin no longer accepts`,
          );
      }
    }
    // At least one config must actually configure something, or this test
    // passes on a corpus of empty objects — which is exactly what a wrong key
    // name would produce, since a misspelt array key reads as "no entries".
    expect(
      seen,
      'no tracked config declared a plugin option at all',
    ).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  test('options nested inside another option are checked too', () => {
    // `defaultGoalOptions` and `judgeOptions` are objects whose keys are also
    // validated by the published type surface — but only in a fixture the
    // consumer writes. A tracked config that misspells a key inside one of
    // them is a real mistake, and the extraction only sees two-space indents,
    // so the nested bag is checked against the published bag explicitly.
    const published = publishedOptionKeys();
    const nestedBags = ['defaultGoalOptions', 'judgeOptions'];
    const source = readFileSync(join(ROOT, 'index.d.ts'), 'utf8');
    const problems: string[] = [];
    for (const bag of nestedBags) {
      const at = source.indexOf(`${bag}?:`);
      expect(at, `${bag} is not in the published options`).toBeGreaterThan(0);
      const body = source.slice(
        at,
        source.indexOf('\n', source.indexOf(';', at)) + 1,
      );
      for (const key of [
        ...body.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*)\??:/gm),
      ].map(m => m[1]!)) {
        // Every key of a nested bag is a member of the flat bag too, which is
        // what makes this check meaningful rather than a restatement.
        if (!published.has(key) && !nestedBags.includes(key))
          problems.push(`${bag}.${key}`);
      }
    }
    expect(problems).toEqual([]);
    // And the bags are real, so the loop above ran.
    expect(source).toContain('defaultGoalOptions?:');
  });

  test('and the configs that existed before the rename name the NEW option', () => {
    // The direction the count above cannot give. A config that deleted its
    // options entirely would satisfy "names nothing that no longer exists" and
    // isolate nothing.
    const harnessConfigs = trackedConfigs().filter(p =>
      p.startsWith('hack/e2e-harness/'),
    );
    expect(
      harnessConfigs.length,
      'the e2e harness configs went missing',
    ).toBeGreaterThan(0);
    for (const relative of harnessConfigs) {
      const source = readFileSync(join(ROOT, relative), 'utf8');
      expect(source, `${relative} no longer configures a state root`).toContain(
        '"stateRoot"',
      );
    }
  });
});

describe('the retired root-level state file stays unnamed', () => {
  test('no module in src/ names a root-level state file', () => {
    // The layout invariant the retired one-shot conversion used to document,
    // kept as a direct check: no module in src/ may name a root-level state
    // file.
    const files = execFileSync('git', ['ls-files', 'src'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(f => f !== '');
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      if (
        /".opencode",\s*"goals"/.test(source) ||
        /"state\.json"\s*\)/.test(source)
      ) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `these modules still reference a root-level state file: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  test('and NO TRACKED DOCUMENT tells a reader to look at one', () => {
    // The same claim, in the medium it is most likely to be believed: prose.
    // a walkthrough said "the persisted state at
    // `.opencode/goals/state.json`" — a path the plugin stopped writing, in the
    // one document a user is guaranteed to read before anything else, and in a
    // file with a documented history of quietly being wrong.
    //
    // No exclusion: a live document that mentions a retired path is making a
    // claim about today.
    const documents = execFileSync('git', ['ls-files', '*.md'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(f => f !== '');
    expect(
      documents.length,
      'no tracked document was found at all',
    ).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of documents) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      if (
        /goals\/state\.json|"\.opencode",\s*"goals",\s*"state\.json"/.test(
          source,
        )
      ) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `these documents name a state path the plugin no longer writes: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
