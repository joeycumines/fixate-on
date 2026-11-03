#!/bin/bash
# E2E harness verifier: runs bun test in the current working directory.
# Returns COMPLETE when tests pass, WORKING when they fail.
# Reads the active goal's task_id from the work directory's goal state to avoid
# hardcoded mismatches with dynamically generated goal IDs.
#
# THE STATE PATH IS RESOLVED FROM THE LAYOUT, not restated. This script used to
# hardcode `${CWD}/.opencode/goals/state.json` — the workspace-wide file this
# repository deleted — so its `[ -f ]` guard never fired, `TASK_ID` stayed the
# literal "unknown", and every verdict it emitted carried `"task_id":"unknown"`
# into `buildRecoveryPrompt` as the goal id. The COMPLETE/WORKING determination
# was unaffected, which is exactly why nothing caught it: a campaign's verdict was
# still passing, just about a goal nobody could name.
#
# It is wired to a real host — `cfg/opencode.json` configures it as the
# `verifierCommand` — so this is not dead code.
#
# It is a SEPARATE process from the drive scripts, so it cannot source their
# helper (which requires `WORK` to be set by the caller and resolves lazily). The
# resolution is therefore done here, from the same LAYOUT, and a harness contract
# asserts that no script under hack/e2e-harness/ hardcodes a state path — the
# gate that was missing entirely, matched over the directory rather than over a
# list of files.

set -euo pipefail

CWD="${PWD}"
STATE_ROOT="${FIXATE_ON_STATE_ROOT:-${CWD}/.opencode/goals}"

# The newest session's state file, which is the live one: a campaign drives one
# session and a reused work directory can hold more. A missing directory is not an
# error here — it means no goal has been created yet, and the verdict below still
# has to be emitted.
STATE_FILE=""
if [ -d "$STATE_ROOT/sessions" ]; then
  for candidate in $(ls -tA "$STATE_ROOT/sessions" 2>/dev/null); do
    if [ -f "$STATE_ROOT/sessions/$candidate/state.json" ]; then
      STATE_FILE="$STATE_ROOT/sessions/$candidate/state.json"
      break
    fi
  done
  unset candidate
fi

# Extract the first active goal's ID from state.json
TASK_ID="unknown"
if [ -f "$STATE_FILE" ]; then
  EXTRACTED=$(bun -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('${STATE_FILE}','utf8'));
      const g = (s.goals||[]).find(g=>g.status==='active');
      console.log(g ? g.goalId : 'unknown');
    } catch { console.log('unknown'); }
  " 2>/dev/null || echo "unknown")
  if [ -n "$EXTRACTED" ] && [ "$EXTRACTED" != "undefined" ]; then
    TASK_ID="$EXTRACTED"
  fi
fi

# Run bun test ONCE, keeping both the output (evidence the verdict can cite)
# and the exit status. The previous shape ran it twice — once for output that
# nothing read, once for the status — doubling the verifier's latency inside a
# live goal loop.
TEST_EXIT=0
TEST_OUTPUT=$(cd "$CWD" && bun test 2>&1) || TEST_EXIT=$?

# Capture candidate identity from the working tree's git HEAD, matching the
# plugin's captureCandidateIdentity (src/candidate-identity.ts). The candidate
# is the git HEAD short-sha; the fingerprint is sha256 of `git diff HEAD` output
# truncated to 32 hex chars — the same computation the plugin performs when the
# tree has a tracked diff and no untracked files. A clean tree (no diff, no
# untracked) falls through to the plugin's directoryDigest (mtime-based), which
# cannot be replicated in bash; that case should not arise during a campaign
# because the verifier runs only after the agent has made changes.
CANDIDATE=$(cd "$CWD" && git rev-parse --short HEAD 2>/dev/null || echo "no-head")
FINGERPRINT=$(cd "$CWD" && git diff HEAD 2>/dev/null | shasum -a 256 | cut -c1-32)
[ -n "$FINGERPRINT" ] || FINGERPRINT="unknown"

if [ "$TEST_EXIT" -eq 0 ]; then
  cat <<VERDICT
{"schema_version":1,"task_id":"${TASK_ID}","state":"COMPLETE","candidate":"${CANDIDATE}","fingerprint":"${FINGERPRINT}","outstanding":[],"evidence":["bun test passed"]}
VERDICT
else
  cat <<VERDICT
{"schema_version":1,"task_id":"${TASK_ID}","state":"WORKING","candidate":"${CANDIDATE}","fingerprint":"${FINGERPRINT}","outstanding":["tests must pass"],"evidence":["bun test failed"]}
VERDICT
fi
