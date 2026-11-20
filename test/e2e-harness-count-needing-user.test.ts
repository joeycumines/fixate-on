// e2e-harness-count-needing-user.test.ts — the briefing-count instrument must
// tolerate session directories whose state.json has already been deleted.
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';

const RESOLVE_STATE = new URL(
  '../hack/e2e-harness/resolve-state.sh',
  import.meta.url,
).pathname;

test('count_needing_user skips unreadable state files', () => {
  const script = readFileSync(RESOLVE_STATE, 'utf8');
  expect(script).toContain('await Bun.file(f).text().catch');
  expect(script).toContain('continue');
});
