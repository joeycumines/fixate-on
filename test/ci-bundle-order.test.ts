// ci-bundle-order.test.ts — CI must build the gitignored bundles before tests.
//
// Measured 2026-11-21 (PR #3): identity-constants.test.ts asserts that every
// package.json export target exists, including plugin/fixate-on/*.js. Those
// bundles are gitignored, so a clean checkout has none. CI ran the test suite
// before `bun run bundle`, and failed deterministically while the same suite
// passed locally where a prior bundle existed. This pins the workflow order so
// CI and release:check build the artifact the export-map test inspects.
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';

const CI = new URL('../.github/workflows/ci.yml', import.meta.url).pathname;

test('CI builds the bundles before running tests that inspect export targets', () => {
  const workflow = readFileSync(CI, 'utf8');
  const bundleAt = workflow.indexOf('run: bun run bundle');
  const testsAt = workflow.indexOf('run: bun test test/*.test.ts');
  expect(bundleAt).toBeGreaterThan(-1);
  expect(testsAt).toBeGreaterThan(-1);
  expect(bundleAt).toBeLessThan(testsAt);
});
