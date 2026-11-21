#!/usr/bin/env bash
# drive-v2-goal-loop.sh — deterministic OpenCode v2 protocol & continuation campaign.
#
# Tests the real installed opencode2 binary end-to-end against an isolated local
# mock OpenAI-compatible HTTP server (zero external API keys required):
# 1. Directory plugin loading (hack/e2e-harness/plugin-dir) without file-target warnings
# 2. Zero-config /goal command override via ctx.command.transform (+ /goal status no-op)
# 3. <fixate_on> system prompt injection & ctx.session.context message/tool observation
# 4. experimental.idle continuation in both `serve` and `--standalone run`
# 5. Child-session verifier judge honest settlement (`status: "complete"`)
# 6. Coexistence with explicit `commands.goal`, `noToolCallTurns` brake, workspaceDirectory
#    scoping, and `session.hook('compaction')` `<goal_context>` preservation.
#
# Usage: bash hack/e2e-harness/drive-v2-goal-loop.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$(cd "$HERE/../.." && pwd)"
WORK="$HERE/.isolated-v2-loop/work"

. "$HERE/resolve-state.sh"

echo "== pre-flight: harness tree must be unmodified =="
assert_harness_unmodified || exit 1

[ -f "$BUNDLE_DIR/plugin/fixate-on/plugin.js" ] || {
  echo "FAIL: generated bundle missing — run 'bun run bundle' first" >&2
  exit 1
}

OPENCODE2_BIN="${E2E_OPENCODE2_BIN:-opencode2}"
case "$OPENCODE2_BIN" in
  */*) [ -x "$OPENCODE2_BIN" ] || { echo "FAIL: E2E_OPENCODE2_BIN=$OPENCODE2_BIN not executable" >&2; exit 1; } ;;
  *) command -v "$OPENCODE2_BIN" >/dev/null 2>&1 || { echo "FAIL: $OPENCODE2_BIN not found on PATH" >&2; exit 1; } ;;
esac

echo "== running deterministic v2 goal-loop campaign =="
E2E_OPENCODE2_BIN="$OPENCODE2_BIN" bun run "$HERE/verify-v2-goal-loop.ts"
