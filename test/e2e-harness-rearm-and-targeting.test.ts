// e2e-harness-rearm-and-targeting.test.ts — the harness must exit reactivation
// waits on the STATE FACT, not on model wording, and pause the goal immediately.
//
// Measured 2026-11-20 (run 02:44:47Z): the targeting campaign observed beta
// active with the revised objective, then reported ABSENT when its pause landed
// — the reactivated continuation had settled and archived beta in the gap while
// the script waited for reply wording. The same run's goal-driving campaign
// left a re-arm wait on a single state file and a 45s window, so a concurrent
// campaign or a long free-tier turn made the goal look stuck. Both mitigations
// are deterministic harness rules; this test pins them so the live campaigns
// cannot quietly regress to wording-based or single-file waits.
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';

const TARGETING = new URL(
  '../hack/e2e-harness/drive-p40-v1.sh',
  import.meta.url,
).pathname;
const GOAL_DRIVING = new URL(
  '../hack/e2e-harness/drive-p42-v1.sh',
  import.meta.url,
).pathname;

test('P5/P6 targeting exits on the state fact and pauses immediately', () => {
  const script = readFileSync(TARGETING, 'utf8');
  // Both reactivation waits must break on `state_goal_status == active`, which
  // is the authoritative state fact; wording is evidence only.
  expect(
    script.match(/\$\(state_goal_status "\$BETA_ID"\)" = "active"/g),
  ).toHaveLength(2);
  // The pause must follow the sighting immediately, before the continuation can
  // settle the goal into the archive (where state_goal_status reports ABSENT).
  expect(script).toContain('P5_WAS_ACTIVE=1');
  expect(script).toContain('P6_WAS_ACTIVE=1');
  expect(script.match(/send "\/goal pause \$BETA_ID"/g)).toHaveLength(2);
  expect(script).not.toContain(
    'grep -q "was paused and is now active" && break',
  );
  expect(script).not.toContain('grep -q "turn count restarted at 0" && break');
});

test('E-rearm waits on all sessions over a model-latency-sized window', () => {
  const script = readFileSync(GOAL_DRIVING, 'utf8');
  expect(script).toContain('for i in $(seq 1 240)');
  expect(script).toContain(
    "glob.glob('$WORK/.opencode/goals/sessions/*/state.json')",
  );
  expect(script).toContain('did not re-arm within 240s');
  expect(script).toContain('re-armed after ${REARM_FOUND}s');
});
