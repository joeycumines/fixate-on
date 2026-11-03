import {describe, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseVerdict, TerminalState} from '../src/completion-gate.ts';

// The surface a HOST sees
//
// `test/published-unions.test.ts` compares the closed sets a consumer writes
// config against. This file compares the surface the host itself reads at
// runtime: the hook map it dispatches into, the default export it loads, and
// the verdict contract a verifier program has to satisfy.
//
// Every one of these was wrong at HEAD while the whole suite, `tsc`, lint and
// `bun run release:check` were green: the published hook map omitted two hooks
// the plugin registers on every construction, the default export omitted the
// `setup` entry a v2 host cannot load without, `childSessionJudge` was described
// as opt-in when the code enables it unless explicitly `false`, and
// `completion-verdict.schema.json` was cited by three documents and the type
// surface while not existing anywhere in the repository. A wrong member in a
// hand-written `.d.ts` is not a compile error; it is a narrower contract than
// the runtime honours, and it surfaces in someone else's session.

const ROOT = join(import.meta.dir, '..');
const SCHEMA = 'completion-verdict.schema.json';

/**
 * The doc comment immediately preceding an option's declaration, together with
 * the declaration line. Options in `GoalsPluginOptions` are documented ABOVE the
 * member, so the block is taken from the opening `/**` to the next member
 * declaration — a doc line is indented three spaces and starts with `*`, so it
 * cannot be mistaken for the next member's two-space indent.
 */
function optionDoc(source: string, name: string): string {
  const decl = new RegExp(`\\n {2}${name}\\?: ([^\\n]+)`).exec(source);
  if (!decl) return '';
  const next = /\n {2}[a-zA-Z][\w]*\??:/g;
  next.lastIndex = decl.index + decl[0].length;
  const end = next.exec(source)?.index ?? source.length;
  const start = source.lastIndexOf('/**', decl.index);
  return source.slice(start === -1 ? decl.index : start, end);
}

async function read(file: string): Promise<string> {
  return readFile(join(ROOT, file), 'utf8');
}

/** Members of an interface declaration, each with its optionality. */
function members(source: string, name: string): [string, boolean][] {
  const declaration = new RegExp(
    `(?:export )?interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!declaration) return [];
  return (
    declaration[1]
      .split('\n')
      // Only the FIRST line of a member is the member line: a member whose type
      // is an inline object or function spans several lines, and its continuation
      // lines are deeper-indented, so the exactly-two-space anchor admits the
      // member line and nothing else.
      .map(line => /^ {2}('?[A-Za-z][\w.]*'?|"[\w.]+")\s*(\??):/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => [m[1], m[2] === '?'] as [string, boolean])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}

describe('published host surface matches the source', () => {
  test('the published hook map has exactly the hooks the plugin registers', async () => {
    // PluginHooks lives in hooks-types.ts (the hooks layer's shared type
    // module); hooks.ts re-exports it for existing callers.
    const source = await read('src/hooks-types.ts');
    const types = await read('index.d.ts');
    const fromSource = members(source, 'PluginHooks');
    const fromTypes = members(types, 'GoalsPluginHooks');
    // The floor is what makes the comparison non-vacuous: without it, a
    // mistyped interface name yields [] on both sides and the test passes for
    // the wrong reason. 10 is the count at HEAD; it is a floor, not a pin.
    expect(fromSource.length).toBeGreaterThanOrEqual(10);
    expect(fromTypes.length).toBe(fromSource.length);
    expect(fromTypes.map(([name]) => name)).toEqual(
      fromSource.map(([name]) => name),
    );
  });

  test("the published map's optionality matches the runtime's, in both directions", async () => {
    // Optionality in the published map is a CLAIM about the runtime, in both
    // directions, and both matter:
    //
    // - Published optional, runtime unconditional: a consumer must null-check a
    // hook that is always there. Harmless, but it hides a real guarantee.
    // - Published required, runtime omittable: a correct consumer's code fails
    // to compile, because the hook the host may not have registered is typed
    // as guaranteed. Only this direction was checked at first, and publishing
    // the genuinely-conditional `command.execute.before` as required passed
    // green — the defect narrowed a consumer's type and the gate missed it.
    //
    // A hook is OMITTABLE at runtime if the runtime deletes it, or assigns it
    // inside a branch. That is derived by reading the assignment site, not from
    // a list.
    const types = await read('index.d.ts');
    // The file label is kept beside the line rather than prefixed onto it: a
    // prefix would defeat the indentation measurement the back-scan depends on.
    const runtimeLines: {file: string; text: string}[] = [];
    for (const file of ['src/hooks.ts', 'src/plugin-runtime.ts']) {
      for (const text of (await read(file)).split('\n'))
        runtimeLines.push({file, text});
    }
    const indentOf = (text: string): number =>
      text.length - text.trimStart().length;

    const published = members(types, 'GoalsPluginHooks');
    expect(
      published.length,
      'the published hook map is empty or unparsed',
    ).toBeGreaterThanOrEqual(9);
    expect(
      published.filter(([, optional]) => optional).length,
      'every hook is optional — the map claims nothing',
    ).toBeGreaterThan(0);
    expect(
      published.filter(([, optional]) => optional).length,
      'every hook is required — the map claims everything',
    ).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const [name, publishedOptional] of published) {
      const bare = name.replace(/"/g, '');
      // Three ways a hook reaches the returned map, and all three are matched
      // BY NAME rather than by a generic pattern — a generic key matcher is how
      // this check was briefly matching unrelated object literals. The third is
      // a property assignment on any receiver, because `dispose` is registered
      // through a cast (`(hooks as …).dispose = …`) and a `hooks.` prefix would
      // miss it.
      const registration = new RegExp(
        `^\\s{2,4}"?${bare}"?\\s*:|\\.\\s*${bare}\\s*=|hooks\\[(?:"${bare}"|${bare})\\]`,
      );
      const assignedAt = runtimeLines.findIndex(({text}) =>
        registration.test(text),
      );
      if (assignedAt === -1) {
        problems.push(
          `${name} is published but neither src/hooks.ts nor src/plugin-runtime.ts ever registers it`,
        );
        continue;
      }

      const deleted = runtimeLines.some(({text}) =>
        new RegExp(`delete hooks\\[(?:"${bare}"|${bare})\\]`).test(text),
      );
      // Conditionality is a property of the STATEMENT that registers the hook,
      // not of the line the property sits on. A member of an object literal is
      // registered by the literal, and the first version of this check scanned
      // back from the member itself — landing on the `if (!input?.sessionID)
      // return` guards INSIDE the literal, and concluding that every hook in it
      // was conditional. So the scan starts from the line that opens the literal.
      const isObjectMember = /^\s{2,4}"?[A-Za-z.]+"?\s*:/.test(
        runtimeLines[assignedAt].text,
      );
      let statementAt = assignedAt;
      if (isObjectMember) {
        const memberIndent = indentOf(runtimeLines[assignedAt].text);
        for (let i = assignedAt - 1; i >= 0; i--) {
          const {text} = runtimeLines[i];
          if (indentOf(text) < memberIndent && text.trim().endsWith('{')) {
            statementAt = i;
            break;
          }
        }
      }
      let conditional = false;
      for (let i = statementAt - 1; i >= 0; i--) {
        const {text} = runtimeLines[i];
        if (!text.trim()) continue;
        if (indentOf(text) >= indentOf(runtimeLines[statementAt].text))
          continue;
        conditional = /^(if|for|while|\?|switch)/.test(text.trim());
        break;
      }

      const omittable = deleted || conditional;
      if (publishedOptional !== omittable) {
        problems.push(
          omittable
            ? `${name} is omittable at runtime (${deleted ? 'deleted' : 'assigned conditionally'}) ` +
                "but the published map declares it required — a correct consumer's code would not compile"
            : `${name} is published as optional, but the runtime registers it unconditionally`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  test('the default export declares what both host loaders read', async () => {
    const types = await read('index.d.ts');
    const entry = await read('src/plugin.ts');
    const v2 = await read('src/plugin-v2.ts');
    // The runtime composition: a spread of the v2 entry plus `server`.
    expect(entry).toMatch(
      /const entry = \{\s*\.\.\.GoalsPluginV2Default,\s*server: GoalsPlugin,?\s*\}/,
    );
    // The v2 entry is `{ id, setup }` — `setup` is what opencode2's loader
    // validates against, so omitting it from the published type makes the entry
    // a v2 host calls invisible to anyone typing against this package.
    expect(v2).toMatch(
      /export const GoalsPluginV2 = \{\s*id: 'fixate-on',\s*setup,?\s*\}/,
    );
    expect(members(types, 'GoalsPluginOptions').length).toBeGreaterThan(20);

    const declared = /declare const goalsPlugin:?\s*\{([\s\S]*?)\n\}/.exec(
      types,
    );
    expect(
      declared,
      'index.d.ts no longer declares the default export',
    ).toBeTruthy();
    const keys = [...declared![1].matchAll(/^ {2}([a-zA-Z]+)[?]?:/gm)]
      .map(m => m[1])
      .sort();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(['id', 'server', 'setup']);
  });

  test('an option enabled by default is documented as enabled by default', async () => {
    // The false claim was prose ("Opt-in: when unset (the default)") and had no
    // `@default` tag at all, which is why the scalar-default gate could not see
    // it. Both the tag and the source expression that sets the default are now
    // checked, so moving one without the other fails.
    const types = await read('index.d.ts');
    const runtime = await read('src/plugin-runtime.ts');
    const defaultsInCode = new Set(
      [...runtime.matchAll(/pluginOptions\.([A-Za-z]+) !== false/g)].map(
        m => m[1],
      ),
    );
    expect(
      defaultsInCode.size,
      'the `!== false` default idiom vanished from the runtime',
    ).toBeGreaterThan(0);

    for (const option of defaultsInCode) {
      const doc = optionDoc(types, option);
      expect(
        doc,
        `${option} is not published as a boolean option in index.d.ts`,
      ).not.toBe('');
      const tag = /@default\s+(\S+)/.exec(doc);
      expect(tag, `${option} has no @default tag in index.d.ts`).toBeTruthy();
      // `x!== false` is true unless the caller says otherwise, so the default
      // is `true`. Anything else in the declaration is a stale claim.
      expect(
        tag![1],
        `${option} defaults to \`x !== false\` in the code but is documented as ${tag![1]}`,
      ).toBe('true');
    }
  });
});

describe('the completion-verdict schema is a real, accurate contract', async () => {
  const schema = JSON.parse(await read(SCHEMA));

  test('the file the documentation cites exists and declares the id the code quotes', async () => {
    const gate = await read('src/completion-gate.ts');
    const quoted =
      /completion-verdict\.schema\.json[^\n]*\(\$id:\s*(urn:[^)]+)\)/.exec(
        gate,
      );
    expect(quoted, 'the gate no longer quotes a schema id').toBeTruthy();
    expect(schema.$id).toBe(quoted![1]);
    expect(schema.$schema).toMatch(/draft\/2020-12/);
  });

  test('the state enum is the TerminalState union', async () => {
    const gate = await read('src/completion-gate.ts');
    const declaration =
      /export type TerminalState\s*=\s*([\s\S]*?)(?=\n\n)/.exec(gate);
    expect(declaration).toBeTruthy();
    const members = [...declaration![1].matchAll(/'([A-Z_]+)'/g)]
      .map(m => m[1])
      .sort();
    expect(members.length).toBeGreaterThanOrEqual(5);
    expect([...schema.properties.state.enum].sort()).toEqual(members);
  });

  test('the required set is the one the parser enforces, decided by running it', async () => {
    // Not a hand-written list: each field is removed from a valid verdict and
    // the parser is asked. A field the parser accepts when absent is optional in
    // the schema, and one it rejects is required — so the schema cannot drift
    // from the parser without this failing.
    const valid = {
      schema_version: 1 as const,
      task_id: 'goal-1',
      state: 'COMPLETE' as TerminalState,
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['bun test: 1714 pass'],
    };
    expect(parseVerdict(JSON.stringify(valid)).state).toBe('COMPLETE');
    expect([
      ...(schema.properties ? Object.keys(schema.properties).sort() : []),
    ]).toEqual(Object.keys(valid).sort());

    for (const field of Object.keys(valid)) {
      const partial: Record<string, unknown> = {...valid};
      delete partial[field];
      let rejected = false;
      try {
        parseVerdict(JSON.stringify(partial));
      } catch {
        rejected = true;
      }
      const declared = (schema.required as string[]).includes(field);
      expect(
        rejected,
        `${field} is ${declared ? 'required' : 'optional'} in the schema, but the parser ` +
          `${rejected ? 'rejects' : 'accepts'} a verdict without it`,
      ).toBe(declared);
    }
  });

  test('the schema forbids unknown fields because the parser does', () => {
    expect(schema.additionalProperties).toBe(false);
    let rejected = false;
    try {
      parseVerdict(
        JSON.stringify({
          schema_version: 1,
          task_id: 'goal-1',
          state: 'COMPLETE',
          outstanding: [],
          evidence: ['ok'],
          somethingElse: true,
        }),
      );
    } catch {
      rejected = true;
    }
    expect(rejected, 'the parser accepted an unsupported field').toBe(true);
  });

  test('the schema ships, and the published surface points at it', async () => {
    const manifest = JSON.parse(await read('package.json'));
    const types = await read('index.d.ts');
    expect(manifest.files, `${SCHEMA} is not in package.json files`).toContain(
      SCHEMA,
    );
    // A contract nobody is told about is not published. Both the type surface
    // and the README must name the file by name.
    expect(types).toContain(SCHEMA);
    expect(await read('README.md')).toContain(SCHEMA);
  });
});
