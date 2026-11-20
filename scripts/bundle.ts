import {createSolidTransformPlugin} from '@opentui/solid/bun-plugin';
import {join} from 'node:path';

const root = join(import.meta.dir, '..');

/** Compile JSX with Solid before bundling; ordinary JSX freezes reactive props. */
export function buildPluginBundles(
  outdir = join(root, 'plugin', 'fixate-on'),
  entrypoints = ['plugin.ts', 'tui.ts', 'tui-v2.ts'].map(file =>
    join(root, 'src', file),
  ),
): Promise<Bun.BuildOutput> {
  return Bun.build({
    entrypoints,
    outdir,
    naming: '[name].js',
    target: 'bun',
    external: ['zod', '@opentui/solid', '@opentui/core', 'solid-js'],
    plugins: [createSolidTransformPlugin()],
  });
}

if (import.meta.main) {
  const result = await buildPluginBundles();
  if (!result.success) throw new AggregateError(result.logs, 'Bundle failed');
  for (const output of result.outputs) console.log(output.path);
}
