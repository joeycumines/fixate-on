// e2e-harness-multisession-deterministic.test.ts — scenario A's own-session
// assertion must not depend on the free-tier model calling goal-command.
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';

const DRIVE = new URL('../hack/e2e-harness/drive-p43-v1.sh', import.meta.url)
  .pathname;

test('the multi-session own-session fixture is deterministic', () => {
  const script = readFileSync(DRIVE, 'utf8');
  expect(script).toContain('BETA_SESSION="ses_p43_second_host"');
  expect(script).not.toContain(
    'tmux send-keys -t "$WIN2.0" -l "/goal p43 session beta goal"',
  );
});
