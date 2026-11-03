#!/usr/bin/env bash
# check-evidence-age.sh — report whether the last recorded E2E evidence is stale.
#
#: "stale evidence ages red automatically." This script
# makes the stale state OBSERVABLE without running the full campaign suite.
# Run it any time to see whether the last live campaign run is for the
# current HEAD.
#
# Exit codes:
# 0 — evidence is current (last recorded commit == HEAD)
# 1 — evidence is STALE (HEAD has advanced past the last recorded run)
# 2 — no run recorded yet (first run hasn't happened)
#
# Usage: bash hack/e2e-harness/check-evidence-age.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$(cd "$HERE/../.." && pwd)"

COMMIT_SHA=$(cd "$BUNDLE_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# The parser is last-evidence-commit.sh's alone — run-all.sh asks the same
# question, and two copies of the parser are two things to drift.
LAST_EVIDENCE_COMMIT=$(bash "$HERE/last-evidence-commit.sh")

if [ "$LAST_EVIDENCE_COMMIT" = "none" ]; then
  echo "NO-EVIDENCE: no E2E run recorded yet (first run hasn't happened)"
  echo "  current HEAD: $COMMIT_SHA"
  exit 2
elif [ "$LAST_EVIDENCE_COMMIT" != "$COMMIT_SHA" ]; then
  echo "STALE: last run at $LAST_EVIDENCE_COMMIT, current HEAD is $COMMIT_SHA"
  echo "  The evidence ages red automatically. Run 'bash hack/e2e-harness/run-all.sh'"
  echo "  with both hosts launched to refresh it."
  exit 1
else
  echo "CURRENT: last run at $COMMIT_SHA matches HEAD"
  exit 0
fi
