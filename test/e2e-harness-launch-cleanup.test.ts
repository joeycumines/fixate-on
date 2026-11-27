// e2e-harness-launch-cleanup.test.ts — a fresh launch must not leave the
// previous harness host holding a state lease.
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';

for (const name of ['launch.sh', 'launch-v1.sh']) {
  test(`${name} stops stale harness host processes before starting a new one`, () => {
    const script = readFileSync(
      new URL(`../hack/e2e-harness/${name}`, import.meta.url).pathname,
      'utf8',
    );
    expect(script).toContain('stop_stale_harness_hosts');
    expect(script).toContain('WORK="$WORK_DIR"');
  });
}

test('stale-host cleanup matches a work directory at the end of argv', () => {
  const script = readFileSync(
    new URL('../hack/e2e-harness/resolve-state.sh', import.meta.url).pathname,
    'utf8',
  );
  // A launcher passes the work dir as its final argument, so a trailing
  // slash/space-only anchor misses the host that keeps the state lease.
  expect(script).toContain('(work|work-v1)([/[:space:]]|$)');
});
