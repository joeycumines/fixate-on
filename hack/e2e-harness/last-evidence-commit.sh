#!/usr/bin/env bash
# last-evidence-commit.sh — print the commit hash of the last recorded E2E
# run in runs/last-run.txt, or "none".
#
# THE PARSER LIVES HERE ALONE. run-all.sh's preflight and check-evidence-age.sh
# both ask this question; when each held its own bun one-liner they were two
# things to keep correct, and the stale-evidence gate is exactly the kind of
# rule a second copy drifts on (a shape change in the evidence line would age
# red in one and silently pass in the other).
#
# Usage: bash hack/e2e-harness/last-evidence-commit.sh (or print it from
# a shell that wants the value; exit status is always 0).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$(cd "$HERE/../.." && pwd)"

tail -n 1 "$HERE/runs/last-run.txt" 2>/dev/null | grep -o 'commit=[a-f0-9]*' | cut -d= -f2 || echo "none"
[ -s "$HERE/runs/last-run.txt" ] || echo "none"
