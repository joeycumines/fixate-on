#!/usr/bin/env bash
# seed-briefing.sh — write a DETERMINISTIC stopped-goal fixture so the load
# briefing is provable without leftover state.
#
# WHY THIS EXISTS. The load briefing ("N goals need you") only renders when the
# workspace ALREADY holds a stopped-and-waiting goal at host boot. Both launchers
# wipe `.opencode` to give every campaign the canonical fixture, so a fresh
# workspace has nothing to brief about. The old escape hatch was KEEP_STATE=1,
# which preserved WHATEVER the previous run left behind — non-deterministic, and
# a manual flag the campaign operator had to remember.:
# "briefing passes without manual KEEP_STATE hack."
#
# This script is the replacement: it writes ONE known stopped goal into a fresh
# session directory. Deterministic bytes, no dependence on prior runs. The
# launchers call it after the wipe when SEED_BRIEFING=1.
#
# THE FIXTURE SHAPE is chosen so `goalNeedsTheUser` (src/tui-toast-policy.ts)
# returns true: status "paused" with stopReason "paused" is NOT in
# SELF_RESOLVING_STOP_REASONS (recovery / user intervention / queued), so it is
# briefed. The goal's `sessionID` matches the directory name, which
# `parseStateFileGoals` (src/tui-disk-state.ts) requires or it drops the record.
# The condition text deliberately does NOT contain the briefing phrase, so a
# capture matching "goal needs you" is the companion's briefing and not the
# fixture's own words echoed back — the confound the v2 observation already
# recorded.
#
# Usage: bash seed-briefing.sh <WORK_DIR>
set -euo pipefail

WORK_DIR="${1:?seed-briefing.sh: pass the work directory}"
SESSION_ID="ses_seedbrief00ffe000000000001"
GOAL_ID="00000000-0000-4000-8000-seedbrief00001"
NOW_MS=$(date +%s)000

STATE_DIR="$WORK_DIR/.opencode/goals/sessions/$SESSION_ID"
mkdir -p "$STATE_DIR"

cat > "$STATE_DIR/state.json" <<JSON
{
  "version": 1,
  "goals": [
    {
      "goalId": "$GOAL_ID",
      "runId": "00000000-0000-4000-8000-seedbrief00002",
      "sessionID": "$SESSION_ID",
      "revision": 2,
      "condition": "a seeded goal that is stopped and waiting",
      "successCriteria": "",
      "constraints": "",
      "artifactPointers": [],
      "pendingProposal": null,
      "mode": "normal",
      "status": "paused",
      "stopReason": "paused",
      "blockedReason": "",
      "finalizing": false,
      "turnCount": 0,
      "totalTokens": 0,
      "compactionBaselineTokens": 0,
      "usage": { "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0, "costKnown": false },
      "tokenBudget": null,
      "maxTokens": 1000000,
      "maxTurns": 0,
      "createdAt": $NOW_MS,
      "updatedAt": $NOW_MS,
      "startedAt": $NOW_MS,
      "pausedAt": $NOW_MS,
      "stoppedAt": $NOW_MS,
      "finishedAt": null,
      "lastCheckpoint": null,
      "history": []
    }
  ],
  "results": [],
  "sessionOrdered": false,
  "invalidatedGoalIds": [],
  "pendingIntents": [],
  "settlementReceipts": [],
  "focusedGoalIds": []
}
JSON

echo "seed-briefing: wrote stopped goal $GOAL_ID into session $SESSION_ID under $WORK_DIR"