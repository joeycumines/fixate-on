#!/usr/bin/env bash
# run-all.sh — orchestrator.
#
# WHAT THIS DOES. Runs every E2E campaign against HEAD from isolated projects,
# under a single-run lease, and records PASS lines + (date, commit) into a
# transcript directory. A concurrent second invocation SKIPs (exit 0) rather
# than FAILs when the lease is held.
#
# USAGE:
# export OPENROUTER_API_KEY="sk-or-v1-..."
# bash hack/e2e-harness/run-all.sh
#
# HOST LIFECYCLE. This script relaunches both hosts fresh under the lease.
# The load briefing is a BOOT-TIME toast (renders ~t+2.5s, gone by ~t+7s);
# a host launched minutes ago has already passed the briefing window, so
# campaigns cannot observe it. Relaunching ensures boot-time events are fresh.
#
# LEASE SEMANTICS. One lease per host type. A second run SKIPs campaigns whose
# host lease is held, rather than failing. This is the requirement:
# "a concurrent second run SKIP-not-FAILs on slot/lease."
#
# EVIDENCE. Each run produces:
# - A transcript under hack/e2e-harness/runs/<date>-<commit>/
# - PASS/FAIL/SKIP lines per campaign
# - State digests (SHA-256 of each work dir's newest session state.json)
# - A summary appended to runs/last-run.txt
#
# STALE-EVIDENCE AGING. Before running campaigns, this script checks whether
# the last recorded E2E run in runs/last-run.txt is for the current HEAD. If
# HEAD has advanced, the prior evidence is STALE and this is reported. The
# evidence becomes current again only when a run completes against the new
# HEAD.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$(cd "$HERE/../.." && pwd)"

# Import lease management
. "$HERE/slot.sh"

# The provider key: the caller's environment first, then the local OpenCode
# credential store. Resolved here so a campaign runs from a fresh shell without
# the caller having to know where the key lives.
. "$HERE/provider-key.sh"

# resolve-state.sh requires WORK to be set before sourcing. Set a default;
# the drive scripts each set their own WORK and re-source it.
WORK="$HERE/work-v1"
. "$HERE/resolve-state.sh"

COMMIT_SHA=$(cd "$BUNDLE_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
RUN_DATE=$(date -u "+%Y-%m-%dT%H:%M:%SZ")
RUN_DIR="$HERE/runs/${RUN_DATE}-${COMMIT_SHA}"
mkdir -p "$RUN_DIR"

TRANSCRIPT="$RUN_DIR/transcript.txt"

log() {
  echo "$@" | tee -a "$TRANSCRIPT"
}

log "============================================"
log "E2E CAMPAIGN RUN"
log "  commit: $COMMIT_SHA"
log "  date:   $RUN_DATE"
log "============================================"
log ""

# PREFLIGHT
# The harness must not run against a modified instrument or a stale bundle.
log "== preflight: harness must be unmodified =="
if ! assert_harness_unmodified 2>&1 | tee -a "$TRANSCRIPT"; then
  log "FAIL: harness tree is modified — aborting"
  exit 1
fi
log ""

log "== preflight: bundle freshness =="
if [ ! -d "$BUNDLE_DIR/plugin/fixate-on" ] || [ -z "$(ls -A "$BUNDLE_DIR/plugin/fixate-on" 2>/dev/null)" ]; then
  log "FAIL: no bundle — run 'bun run bundle' first, then retry."
  exit 1
fi
log ""

# STALE-EVIDENCE CHECK
# Read the last recorded E2E run from runs/last-run.txt and compare to HEAD.
# If HEAD has advanced past the recorded commit, the evidence is stale.
# The parser is last-evidence-commit.sh's alone — check-evidence-age.sh asks
# the same question, and two copies of the parser are two things to drift.
log "== preflight: stale-evidence aging =="
STALE_EVIDENCE=""
LAST_EVIDENCE_COMMIT=$(bash "$HERE/last-evidence-commit.sh")

if [ "$LAST_EVIDENCE_COMMIT" = "none" ]; then
  log "  no prior run recorded — first run"
elif [ "$LAST_EVIDENCE_COMMIT" != "$COMMIT_SHA" ]; then
  STALE_EVIDENCE="prior run at $LAST_EVIDENCE_COMMIT, current HEAD is $COMMIT_SHA"
  log "  STALE: $STALE_EVIDENCE"
  log "  (evidence ages red automatically; this run will refresh it if it passes)"
else
  log "  evidence is current (commit $COMMIT_SHA)"
fi
log ""

# API KEY CHECK
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  log "FAIL: no provider key — campaigns need model access"
  log "      Set OPENROUTER_API_KEY, or store an openrouter key in \${XDG_DATA_HOME:-\$HOME/.local/share}/opencode/auth.json"
  exit 1
fi

# CAMPAIGN RUNNER
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
RESULTS=""

run_campaign() {
  local name="$1"
  local script="$2"

  log "--- $name ---"

  local rc=0
  bash "$HERE/$script" >> "$TRANSCRIPT" 2>&1 || rc=$?

  if [ $rc -eq 0 ]; then
    log "PASS[$name]"
    TOTAL_PASS=$((TOTAL_PASS + 1))
    RESULTS="${RESULTS}PASS[$name] "
  else
    log "FAIL[$name]: exit $rc"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    RESULTS="${RESULTS}FAIL[$name:$rc] "
  fi
  log ""
}

# V1 CAMPAIGNS
# Relaunch the v1 host fresh under the lease so boot-time events (the load
# briefing) are observable. A host launched minutes ago has already passed
# the briefing window. The list is an array so the lease-SKIP count is the
# list's own length — a seventh campaign added here would have made a
# hand-written "+ 6" silently wrong.
V1_CAMPAIGNS=(
  "toast-live:drive-f2.sh"
  "cockpit:drive-cockpit-v1.sh"
  "targeting:drive-p40-v1.sh"
  "disk-loop:drive-p41-v1.sh"
  "goal-driving:drive-p42-v1.sh"
  "multi-session:drive-p43-v1.sh"
)
if acquire_lease "v1" "run-all"; then
  log "== relaunch v1 host (fresh boot for boot-time events) =="
  if ! bash "$HERE/launch-v1.sh" >> "$TRANSCRIPT" 2>&1; then
    log "FAIL[launch-v1]: could not relaunch v1 host"
    release_lease "v1"
    exit 1
  fi
  for spec in "${V1_CAMPAIGNS[@]}"; do
    run_campaign "${spec%%:*}" "${spec#*:}"
  done
  release_lease "v1"
else
  log "SKIP[v1 campaigns]: lease held by another process"
  TOTAL_SKIP=$((TOTAL_SKIP + ${#V1_CAMPAIGNS[@]}))
  RESULTS="${RESULTS}SKIP[v1:lease] "
fi

# V2 CAMPAIGNS
# Relaunch the v2 host fresh under the lease, same reason as v1.
# The installed opencode2 v2.0.27 release has TWO deficiencies proven by upstream
# source cross-reference (tag v2.0.27, commit 1f4d07a):
# (1) TUI plugin loading uses raw import which throws ERR_UNKNOWN_BUILTIN_MODULE
# for file:// URLs in the SEA binary (fixed in commit 0dfcb30d71, NOT in release)
# (2) Keymap layer registration deferred to cleanup + defaults to base mode
# (fixed in commit 359c501ceb, NOT in release)
# The from-source wrapper runs the fix/external-tui-plugin-loading branch which has
# both fixes. Without this override, launch.sh defaults to the installed release
# binary which also rejects file targets with WARN "configured plugin path must be
# a directory" (observed in logs).
if acquire_lease "v2" "run-all"; then
  log "== relaunch v2 host (fresh boot for boot-time events) =="
  export E2E_OPENCODE2_BIN="$HERE/opencode2-from-source.sh"
  if ! bash "$HERE/launch.sh" >> "$TRANSCRIPT" 2>&1; then
    log "FAIL[launch-v2]: could not relaunch v2 host"
    release_lease "v2"
    exit 1
  fi
  run_campaign "dashboard-live" "drive.sh"
  release_lease "v2"
else
  log "SKIP[v2 campaigns]: lease held by another process"
  TOTAL_SKIP=$((TOTAL_SKIP + 1))
  RESULTS="${RESULTS}SKIP[v2:lease] "
fi

# POST-RUN ATTESTATION
# The pre-flight attested the harness was clean BEFORE the campaigns ran.
# A mid-run edit — the agent editing the code it is scored by while the
# campaign is in flight — invalidates every result above. Attest again:
# if the harness changed during the run, the run is void.
log "== post-run: the harness must still be unmodified =="
if ! assert_harness_unmodified 2>&1 | tee -a "$TRANSCRIPT"; then
  log "FAIL: the harness was modified DURING this run — every result above is void"
  exit 1
fi
log ""

# STATE DIGESTS
# Record SHA-256 of each work dir's newest session state.json as evidence.
STATE_DIGESTS=""
for WORK_DIR in "$HERE/work-v1" "$HERE/work"; do
  WORK="$WORK_DIR"
  resolve_state
  if [ -n "${STATE:-}" ] && [ -f "$STATE" ]; then
    local_digest=$(shasum -a 256 "$STATE" | cut -d' ' -f1)
    STATE_DIGESTS="${STATE_DIGESTS}$(basename "$WORK_DIR"):${local_digest:0:12} "
    log "STATE DIGEST ($(basename "$WORK_DIR")): $local_digest"
  fi
done

# SUMMARY
log "============================================"
log "SUMMARY"
log "  PASS:  $TOTAL_PASS"
log "  FAIL:  $TOTAL_FAIL"
log "  SKIP:  $TOTAL_SKIP"
log "  commit: $COMMIT_SHA"
log "  date:   $RUN_DATE"
if [ -n "$STATE_DIGESTS" ]; then
  log "  state digests: $STATE_DIGESTS"
fi
if [ -n "$STALE_EVIDENCE" ]; then
  log "  stale evidence: $STALE_EVIDENCE"
fi
log "============================================"

# RECORD TO runs/last-run.txt
# Append a one-line summary to the harness's own evidence file.
EVIDENCE_LINE="run-all ${RUN_DATE} commit=${COMMIT_SHA} PASS=${TOTAL_PASS} FAIL=${TOTAL_FAIL} SKIP=${TOTAL_SKIP}"
if [ -n "$STATE_DIGESTS" ]; then
  EVIDENCE_LINE="$EVIDENCE_LINE digests=[$STATE_DIGESTS]"
fi

if [ "$TOTAL_FAIL" -eq 0 ] && [ "$TOTAL_PASS" -gt 0 ]; then
  printf '%s\n' "$EVIDENCE_LINE" >> "$HERE/runs/last-run.txt"
  log "last-run.txt updated: $EVIDENCE_LINE" | tee -a "$TRANSCRIPT"
else
  log "last-run.txt NOT updated (campaign had failures or no passes)"
fi

log "transcript: $TRANSCRIPT"

# Exit with failure if any campaign failed
if [ "$TOTAL_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
