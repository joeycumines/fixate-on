import {expect, test} from 'bun:test';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPluginBundles} from '../scripts/bundle.ts';

const require = createRequire(import.meta.url);

test('the patched glob supports the TUI compiler module resolver', async () => {
  // babel-plugin-module-resolver still requests glob 9. Exercise its actual
  // wildcard-root path when overriding glob to the patched modern version.
  const dir = await mkdtemp(join(tmpdir(), 'fixate-dependency-'));
  try {
    const root = join(dir, 'packages', 'fixture');
    await mkdir(root, {recursive: true});
    await writeFile(join(root, 'example.js'), 'export default 1;\n');
    const babel = require('@babel/core') as {
      transformSync(
        source: string,
        options: Record<string, unknown>,
      ): {code?: string} | null;
    };
    const result = babel.transformSync('import value from "example";', {
      filename: join(dir, 'consumer.js'),
      configFile: false,
      babelrc: false,
      plugins: [
        [
          require('babel-plugin-module-resolver'),
          {root: [join(dir, 'packages', '*')]},
        ],
      ],
    });
    expect(result?.code).toContain('./packages/fixture/example');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('patched modern minimatch leaves the ESLint legacy API available', () => {
  const eslintRequire = createRequire(require.resolve('eslint'));
  const legacy = eslintRequire('minimatch') as (
    path: string,
    pattern: string,
  ) => boolean;
  expect(legacy('src/plugin.ts', '**/*.ts')).toBe(true);
  expect(legacy('src/plugin.js', '**/*.ts')).toBe(false);

  const parserRequire = createRequire(
    require.resolve('@typescript-eslint/typescript-estree'),
  );
  const modern = parserRequire('minimatch') as {
    minimatch(path: string, pattern: string, options: {dot: boolean}): boolean;
  };
  expect(modern.minimatch('.config.ts', '*.ts', {dot: true})).toBe(true);
  expect(modern.minimatch('.config.js', '*.ts', {dot: true})).toBe(false);
});

test('bundled entrypoints need no runtime OpenCode SDK installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixate-bundle-peer-'));
  try {
    const result = await buildPluginBundles(dir);
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(3);
    const scanner = new Bun.Transpiler({loader: 'js', target: 'bun'});
    for (const output of result.outputs) {
      const imports = scanner.scanImports(await output.text());
      expect(
        imports.filter(item => item.path.startsWith('@opencode-ai/plugin')),
      ).toEqual([]);
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
