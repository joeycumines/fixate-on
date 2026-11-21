import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPluginBundles} from '../scripts/bundle.ts';

test('the shipped JSX compilation updates rendered state, theme and receipt viewport', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-tui-compiled-'));
  const root = join(import.meta.dir, '..');
  try {
    const built = await buildPluginBundles(directory, [
      join(root, 'src', 'tui-dashboard-route.tsx'),
      join(root, 'src', 'tui-v2-receipt-dialog.tsx'),
    ]);
    expect(built.success, built.logs.map(String).join('\n')).toBe(true);
    symlinkSync(
      join(root, 'node_modules'),
      join(directory, 'node_modules'),
      'junction',
    );
    // Isolate OpenTUI's native renderer and load the browser Solid runtime used
    // by the host. The ordinary unit-test process uses Solid's server entry.
    const child = Bun.spawn(
      [
        process.execPath,
        '--conditions=browser',
        join(import.meta.dir, 'fixtures', 'tui-compiled-renderer.ts'),
        join(directory, 'tui-dashboard-route.js'),
        join(directory, 'tui-v2-receipt-dialog.js'),
      ],
      {stdout: 'pipe', stderr: 'pipe'},
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('compiled TUI rendering checks passed');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}, 20_000);
