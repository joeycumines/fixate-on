#!/bin/bash
# live evidence on stock opencode v1: every TUI verb acts on the
# goal the surface names, or refuses with a reason.
#
# STATE ASSERTIONS ARE MODEL-FREE: every dispatch below goes through the
# host's `command.execute.before` hook → `handleCommand` in src/commands.ts,
# which is local machinery — the STATE assertions hold even when the provider
# is out of credits. Goals are paused immediately after creation so no
# continuation loop can fire against a dead provider.
#
# THE REPLY WORDING IS NOT MODEL-FREE. On stock v1 the command text is routed
# to the model as a chat turn, and the reply line is rendered only when the
# model's `goal-command` round-trip completes. MEASURED 2026-10-10 over four
# consecutive runs at the same commit: the wording assertions failed at
# RANDOM (P5 and P6 alternating), each pane log showing
# 'Provider returned error [retrying in Ns attempt #M]' in the window of the
# dropped reply, while every state assertion passed. A gate that fails at
# random trains you to re-run it instead of reading it. The wording contracts
# therefore move to their deterministic unit pins in test/commands.test.ts
# ('holds 2 goals', 'The goal was paused and is now active again',
# 'turn count restarted at 0') — the same documented-route
# precedent drive-p42-v1.sh uses for its sub-requirements. The campaign keeps
# the state assertions live, logs the wording when it renders, and never
# gates on it.
#
# Checks (launch-v1.sh must already be running):
# P1 TWO GOALS CREATED: alpha and beta exist in the session's state.json.
# P2 PALETTE PAUSE IS SCOPED: with beta focused (via checkpoint recency),
# palette Pause pauses beta and alpha stays paused (state diff shows
# which goalId moved).
# P3 BARE CLEAR REFUSES: with 2 goals, `/goal clear` removes nothing (both
# goals survive; the refusal wording is a unit-pinned contract, logged
# when rendered).
# P4 SCOPED CLEAR WORKS: `/goal clear <alphaId>` removes only alpha.
# P5 EDIT REACTIVATES: `/goal edit <betaId>...` transitions beta to active
# and updates its objective (the prior-status naming is a unit-pinned
# contract, logged when rendered).
# P6 RESUME: `/goal resume <betaId>` transitions beta to active (the
# turn-count naming is a unit-pinned contract, logged when rendered).
# P7 EMPTY-SESSION REFUSAL: palette Pause in a new session with no goals
# refuses with "This session has no goals."
#
# ASSERTION DISCIPLINE: state diffs read the session's state.json directly
# via resolve-state.sh; UI assertions use markers that appear only in the
# plugin's own output, never patterns the agent transcript could echo.
#
# STATE READS ARE PINNED TO THIS CAMPAIGN'S OWN SESSION, not to the newest
# file: measured 2026-11-03 (run 04:17:05Z-d09555f7) a late duplicate
# goal-command from the cockpit campaign landed in the COCKPIT session at
# 04:18:50, making that session's state.json the newest, so resolve_state —
# newest-mtime across all sessions — handed P2 a focusedGoalIds array from the
# wrong session and P2-focus failed on a focus the product had landed
# correctly (pane capture: "Focused goal: beta: hold the seco..."). The pin is
# by CONTENT (a goal whose id or condition prefix this campaign created), the
# same rule drive-p41-v1.sh's state_path_for already uses, so no other
# session's writes can move it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="fixate-on"
CAP="$HERE/captures"
WORK="$HERE/work-v1"
. "$(dirname "$0")/resolve-state.sh"
mkdir -p "$CAP"

FREEZE_BIN=""
if command -v freeze >/dev/null 2>&1; then FREEZE_BIN="freeze"; fi

freeze_render() {
  local src="$1" dest="$2"
  if [ -z "$FREEZE_BIN" ]; then
    echo "WARN: freeze not installed — skipping PNG render for $src"
    return 0
  fi
  if [ ! -f "$CAP/$src.ansi" ]; then
    echo "WARN: $CAP/$src.ansi missing — skipping freeze render"
    return 0
  fi
  if "$FREEZE_BIN" < "$CAP/$src.ansi" -o "$CAP/freeze/$dest.png" --language ansi --theme dracula --window 2>/dev/null; then
    echo "freeze: rendered $dest.png ($(wc -c < "$CAP/freeze/$dest.png") bytes)"
  else
    echo "WARN: freeze failed for $src (exit $?) — ANSI evidence unaffected"
  fi
}

cap() { tmux capture-pane -p -e -t "$SESSION:0.0" > "$CAP/$1.ansi"; echo "captured $1.ansi ($(wc -c < "$CAP/$1.ansi") bytes)"; }
# Full-scrollback capture: -S - starts at the top of history, so command
# responses that scrolled off the visible screen are still present.
cap_scrollback() { tmux capture-pane -p -S - -e -t "$SESSION:0.0" > "$CAP/$1.ansi"; echo "captured $1.ansi ($(wc -c < "$CAP/$1.ansi") bytes, full scrollback)"; }
send() { tmux send-keys -t "$SESSION:0.0" -l "$1"; sleep 0.3; tmux send-keys -t "$SESSION:0.0" Enter; }

strip() { python3 -c "
import re,sys
d=open(sys.argv[1],encoding='utf-8',errors='replace').read()
print(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',d))
" "$1"; }

# Wait for a pattern to appear in the pane, polling every second.
# Usage: wait_for_pane_text "pattern" max_seconds
# Returns 0 if found, 1 if timed out.
wait_for_pane_text() {
  local pattern="$1" max="${2:-15}"
  for i in $(seq 1 "$max"); do
    sleep 1
    if tmux capture-pane -p -e -t "$SESSION:0.0" 2>/dev/null | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | grep -qE "$pattern"; then
      return 0
    fi
  done
  return 1
}

FAIL=0
# Record every byte the terminal draws. The v1 TUI redraws in place and tmux
# history holds none of the conversation, so a line that a streaming
# continuation pushes off the pane exists afterwards only in this log. Wording
# assertions below check it, so 'drawn then scrolled' is distinguishable from
# 'never drawn'.
: > "$CAP/p40-pane.log"
tmux pipe-pane -t "$SESSION:0.0" "cat >> '$CAP/p40-pane.log'" 2>/dev/null || true
check_contains() {
  local label="$1" file="$2" pattern="$3"
  if strip "$CAP/$file.ansi" | grep -qE "$pattern"; then
    echo "PASS[$label]: found '$pattern' in $file"
  else
    echo "FAIL[$label]: '$pattern' NOT found in $file"
    FAIL=1
  fi
}
check_absent() {
  local label="$1" file="$2" pattern="$3"
  if strip "$CAP/$file.ansi" | grep -qE "$pattern"; then
    echo "FAIL[$label]: '$pattern' still present in $file (expected absent)"
    FAIL=1
  else
    echo "PASS[$label]: '$pattern' absent from $file, as expected"
  fi
}
# State-file helpers: read the session's state.json and extract goal facts.
# All reads go through resolve_state, which is PIN-AWARE (resolve-state.sh):
# once PIN_KEY is set in P1, resolve_state returns the session file that holds
# this campaign's own goal — not the newest file across all sessions.
state_goal_status() {
  local gid="$1"
  resolve_state
  [ -f "$STATE" ] || { echo "NO_STATE"; return; }
  python3 -c "
import json,sys
d=json.load(open('$STATE'))
for g in d.get('goals',[]):
    if g.get('goalId','').startswith('$gid'):
        print(g.get('status','?')); sys.exit(0)
print('ABSENT')
" 2>/dev/null || echo "PARSE_ERR"
}
state_goal_count() {
  resolve_state
  [ -f "$STATE" ] || { echo 0; return; }
  python3 -c "import json;print(len(json.load(open('$STATE')).get('goals',[])))" 2>/dev/null || echo 0
}
state_goal_ids() {
  resolve_state
  [ -f "$STATE" ] || return 0
  python3 -c "
import json
d=json.load(open('$STATE'))
for g in d.get('goals',[]):
    print(g.get('goalId',''))
" 2>/dev/null
}
# Read a goal's objective (condition) from state.json.
state_goal_condition() {
  local gid="$1"
  resolve_state
  [ -f "$STATE" ] || return 0
  python3 -c "
import json,sys
d=json.load(open('$STATE'))
for g in d.get('goals',[]):
    if g.get('goalId','').startswith('$gid'):
        print(g.get('condition','')); sys.exit(0)
" 2>/dev/null
}
# Read the focused goal id from the focusedGoalIds array (not a scalar).
state_focused_id() {
  resolve_state
  [ -f "$STATE" ] || return 0
  python3 -c "
import json
d=json.load(open('$STATE'))
fids=d.get('focusedGoalIds',[])
if fids:
    print(fids[0].get('goalId',''))
else:
    print('')
" 2>/dev/null
}

echo "== pre-flight: the harness must be unmodified =="
assert_harness_unmodified || exit 1

echo "== P40: boot settle (wait for the TUI, not for a guess) =="
BOOTED=""
for i in $(seq 1 90); do
  sleep 1
  bytes=$(tmux capture-pane -p -e -t "$SESSION:0.0" 2>/dev/null | wc -c | tr -d ' ')
  if [ -n "$bytes" ] && [ "$bytes" -gt 400 ]; then BOOTED="$i"; break; fi
done
if [ -z "$BOOTED" ]; then
  echo "FAIL[P40-boot]: the host never rendered a TUI after 90s"
  FAIL=1
else
  echo "     host rendered a TUI after ${BOOTED}s"
fi
cap p40-00-boot >/dev/null

# A host session no earlier campaign drove (see resolve-state.sh for the
# measured incident): a stale in-flight goal-command can only land here.
fresh_host_session || { echo "FAIL[P40-session]: could not open a fresh host session"; FAIL=1; }

echo "== P1: create two goals (alpha, beta) and pause both immediately =="
# Pin the state reads to the session holding THIS campaign's alpha goal from
# the first send on (PIN_KEY is read by resolve_state in resolve-state.sh;
# before the pin matches anything the reads fall back to the newest file,
# which is the race measured 2026-11-03 — a concurrent campaign's state write
# moved resolve_state off this session mid-campaign).
PIN_KEY="alpha: hold the first position"
send "/goal alpha: hold the first position"
for i in $(seq 1 30); do
  sleep 1
  [ "$(state_goal_count)" -ge 1 ] && break
done
[ "$(state_goal_count)" -ge 1 ] || { echo "FAIL[P1-alpha]: alpha goal never appeared in state.json"; FAIL=1; }
send "/goal pause"
# Wait for the command reply to render before proceeding.
wait_for_pane_text "Goal paused" 12 || true
sleep 1

send "/goal add beta: hold the second position"
for i in $(seq 1 30); do
  sleep 1
  [ "$(state_goal_count)" -ge 2 ] && break
done
[ "$(state_goal_count)" -ge 2 ] || { echo "FAIL[P1-beta]: beta goal never appeared in state.json"; FAIL=1; }
send "/goal pause"
wait_for_pane_text "Goal paused" 12 || true
sleep 1

ALPHA_ID=""
BETA_ID=""
for gid in $(state_goal_ids); do
  resolve_state
  cond=$(python3 -c "
import json
d=json.load(open('$STATE'))
for g in d.get('goals',[]):
    if g.get('goalId')=='$gid': print(g.get('condition',''))" 2>/dev/null)
  case "$cond" in
    alpha:*) ALPHA_ID="$gid" ;;
    beta:*)  BETA_ID="$gid" ;;
  esac
done
if [ -z "$ALPHA_ID" ] || [ -z "$BETA_ID" ]; then
  echo "FAIL[P1-ids]: could not resolve both goal ids (alpha=${ALPHA_ID:-missing}, beta=${BETA_ID:-missing})"
  FAIL=1
else
  echo "PASS[P1]: two goals created — alpha=${ALPHA_ID:0:8}, beta=${BETA_ID:0:8}"
fi
cap p40-01-two-goals

echo "== P2: palette Pause is scoped to the focused goal (beta) =="
# Focus beta explicitly so the palette's scoped verb has a non-default target.
send "/goal focus $BETA_ID"
wait_for_pane_text "Focused goal" 12 || true
sleep 1
FOCUSED_NOW=$(state_focused_id)
resolve_state
echo "     focused goal after focus command: ${FOCUSED_NOW:0:8} (pin: ${PINNED:-fallback})"
if [ -z "$PINNED" ]; then
  echo "FAIL[P2-pin]: state read was not pinned to this campaign's session (PIN_KEY='${PIN_KEY}') — the newest-mtime race is open again"
  FAIL=1
fi
if [ "${FOCUSED_NOW:0:8}" != "${BETA_ID:0:8}" ]; then
  echo "FAIL[P2-focus]: focus did not land on beta (got ${FOCUSED_NOW:0:8}, expected ${BETA_ID:0:8})"
  FAIL=1
fi

# Resume beta so it is active (not already paused) before the palette pause.
# This makes the state diff meaningful: beta active→paused, alpha paused→paused.
send "/goal resume $BETA_ID"
wait_for_pane_text "Goal resumed" 12 || true
sleep 1
ALPHA_BEFORE=$(state_goal_status "$ALPHA_ID")
BETA_BEFORE=$(state_goal_status "$BETA_ID")
echo "     before palette pause: alpha=$ALPHA_BEFORE beta=$BETA_BEFORE"
if [ "$BETA_BEFORE" != "active" ]; then
  echo "FAIL[P2-precondition]: beta is '$BETA_BEFORE' before palette pause — expected active"
  FAIL=1
fi

# Open palette, select Fixate: Pause Goal
tmux send-keys -t "$SESSION:0.0" C-p
sleep 1
tmux send-keys -t "$SESSION:0.0" -l "fixate: pause"
sleep 1
tmux send-keys -t "$SESSION:0.0" Enter
# The palette dispatch goes TUI companion -> session.command -> the host's
# command.execute.before hook; the reply wording renders only when the model's
# goal-command round-trip completes, so it is NOT a reliable clock. Poll the
# STATE fact instead: the hook is local machinery and lands the transition
# within a second of the dispatch.
for i in $(seq 1 15); do
  sleep 1
  [ "$(state_goal_status "$BETA_ID")" = "paused" ] && break
done
cap p40-02-after-palette-pause
ALPHA_AFTER=$(state_goal_status "$ALPHA_ID")
BETA_AFTER=$(state_goal_status "$BETA_ID")
echo "     after palette pause:  alpha=$ALPHA_AFTER beta=$BETA_AFTER"
if [ "$BETA_AFTER" = "paused" ] && [ "$ALPHA_AFTER" = "paused" ]; then
  echo "PASS[P2-scoped]: palette Pause paused the focused goal (beta), alpha unchanged"
else
  echo "FAIL[P2-scoped]: beta='$BETA_AFTER' alpha='$ALPHA_AFTER' after palette Pause — expected both paused"
  FAIL=1
fi

echo "== P3: bare /goal clear refuses when 2 goals exist =="
send "/goal clear"
# The refusal wording renders through the model's goal-command round-trip and
# drops under provider instability (see the header measurement). The refusal
# contract is unit-pinned in test/commands.test.ts ('holds 2 goals') and
# test/multi-goal-execution.test.ts; here it is logged when rendered, and the
# HARD assertion is the state fact: nothing was removed.
wait_for_pane_text "holds 2 goals" 15 || true
sleep 1
cap p40-03-bare-clear-refusal
if strip "$CAP/p40-03-bare-clear-refusal.ansi" | grep -q "holds 2 goals"; then
  echo "INFO[P3-wording]: refusal wording rendered (evidence; unit-pinned in test/commands.test.ts)"
fi
COUNT_AFTER_REFUSAL=$(state_goal_count)
if [ "$COUNT_AFTER_REFUSAL" -eq 2 ]; then
  echo "PASS[P3-survived]: both goals survived the refused bare clear"
else
  echo "FAIL[P3-survived]: goal count is $COUNT_AFTER_REFUSAL after refused bare clear — expected 2"
  FAIL=1
fi

echo "== P4: scoped /goal clear <alphaId> removes only alpha =="
send "/goal clear $ALPHA_ID"
wait_for_pane_text "Goal cleared" 12 || true
sleep 1
cap p40-04-scoped-clear
ALPHA_GONE=$(state_goal_status "$ALPHA_ID")
BETA_STAYS=$(state_goal_status "$BETA_ID")
if [ "$ALPHA_GONE" = "ABSENT" ]; then
  echo "PASS[P4-alpha-gone]: alpha was removed by the scoped clear"
else
  echo "FAIL[P4-alpha-gone]: alpha status is '$ALPHA_GONE' after scoped clear — expected ABSENT"
  FAIL=1
fi
if [ "$BETA_STAYS" != "ABSENT" ]; then
  echo "PASS[P4-beta-stays]: beta survived the scoped clear of alpha (status=$BETA_STAYS)"
else
  echo "FAIL[P4-beta-stays]: beta was also removed by the scoped clear of alpha"
  FAIL=1
fi
cap p40-04b-after-scoped-clear

echo "== P5: edit a paused goal reactivates it =="
send "/goal edit $BETA_ID beta revised: still holding the second position"
# The edit reactivates beta and its continuation starts immediately. Poll the
# pane text and the state in one loop, capturing at sighting, and EXIT ON THE
# STATE FACT ALONE: beta active with the revised objective. MEASURED 2026-10-10
# (runall64): the earlier loop waited for the reply wording AFTER the state
# fact landed, holding beta ACTIVE while the reactivated continuation ran;
# that turn was killed mid-thought and archived beta as cleared ~7.5s after
# reactivation, so the final state read saw ABSENT. Pause immediately after
# the sighting so the resumed goal cannot be settled while the script waits.
# The reply wording renders through the model's goal-command round-trip and
# drops under provider instability (see the header measurement); the
# prior-status naming is unit-pinned in test/commands.test.ts, so here it is
# logged when rendered.
P5_SEEN=""
P5_WAS_ACTIVE=""
P5_COND_AT_SIGHT=""
for i in $(seq 1 120); do
  sleep 0.5
  if [ -z "$P5_SEEN" ] && tmux capture-pane -p -t "$SESSION:0.0" 2>/dev/null | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | grep -q "was paused and is now active"; then
    cap_scrollback p40-05-edit-reactivate
    P5_SEEN=1
  fi
  if [ "$(state_goal_status "$BETA_ID")" = "active" ]; then
    P5_WAS_ACTIVE=1
    P5_COND_AT_SIGHT=$(state_goal_condition "$BETA_ID")
    break
  fi
done
cap_scrollback p40-05-edit-reactivate
# Pause immediately: an active goal's continuation can be settled or killed
# while the script waits (measured above). This pause also sets up P6's
# precondition (beta paused).
send "/goal pause $BETA_ID"
for i in $(seq 1 24); do
  sleep 0.5
  [ "$(state_goal_status "$BETA_ID")" = "paused" ] && break
done
[ "$(state_goal_status "$BETA_ID")" = "paused" ] || { echo "FAIL[P5-pause]: beta did not reach paused after the edit (status='$(state_goal_status "$BETA_ID")')"; FAIL=1; }
sleep 1
if [ -n "$P5_SEEN" ]; then
  echo "INFO[P5-wording]: reactivation wording rendered (evidence; unit-pinned in test/commands.test.ts)"
fi
if [ "$P5_WAS_ACTIVE" = "1" ] && [ "$P5_COND_AT_SIGHT" = "beta revised: still holding the second position" ]; then
  echo "PASS[P5-state]: edit reactivated beta (observed active) with the revised objective"
else
  echo "FAIL[P5-state]: beta observed-active='$P5_WAS_ACTIVE' condition-at-sighting='$P5_COND_AT_SIGHT' — expected active + revised objective"
  FAIL=1
fi

echo "== P6: resume reactivates the paused goal =="
send "/goal resume $BETA_ID"
# Same race as P5, same fix: exit on the state fact alone (beta active), then
# pause immediately so the resumed continuation cannot be settled or killed
# while the script waits for the reply wording. The turn-count naming renders
# through the model's goal-command round-trip and drops under provider
# instability (see the header measurement); it is unit-pinned in
# test/commands.test.ts, so here it is logged when rendered.
P6_SEEN=""
P6_WAS_ACTIVE=""
for i in $(seq 1 120); do
  sleep 0.5
  if [ -z "$P6_SEEN" ] && tmux capture-pane -p -t "$SESSION:0.0" 2>/dev/null | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | grep -q "turn count restarted at 0"; then
    cap_scrollback p40-06-resume-count
    P6_SEEN=1
  fi
  if [ "$(state_goal_status "$BETA_ID")" = "active" ]; then
    P6_WAS_ACTIVE=1
    break
  fi
done
cap_scrollback p40-06-resume-count
# Pause immediately (same reason as P5); leaves beta paused for P7's clear.
send "/goal pause $BETA_ID"
for i in $(seq 1 24); do
  sleep 0.5
  [ "$(state_goal_status "$BETA_ID")" = "paused" ] && break
done
[ "$(state_goal_status "$BETA_ID")" = "paused" ] || { echo "FAIL[P6-pause]: beta did not reach paused after resume (status='$(state_goal_status "$BETA_ID")')"; FAIL=1; }
sleep 1
if [ -n "$P6_SEEN" ]; then
  echo "INFO[P6-wording]: turn-count naming rendered (evidence; unit-pinned in test/commands.test.ts)"
fi
if [ "$P6_WAS_ACTIVE" = "1" ]; then
  echo "PASS[P6-state]: resume reactivated beta (observed active)"
else
  echo "FAIL[P6-state]: beta was never observed active after resume"
  FAIL=1
fi

echo "== P7: palette Pause in an empty session refuses with a reason =="
# Clear remaining goals in this session first, then test refusal.
# With only beta remaining (alpha cleared in P4), clear it.
send "/goal clear $BETA_ID"
wait_for_pane_text "Goal cleared" 12 || true
sleep 1
# Now the session has 0 goals. Palette Pause should refuse.
tmux send-keys -t "$SESSION:0.0" C-p
sleep 1
tmux send-keys -t "$SESSION:0.0" -l "fixate: pause"
sleep 1
tmux send-keys -t "$SESSION:0.0" Enter
# Wait for the refusal toast to appear.
wait_for_pane_text "This session has no goals|No active goal" 12 || true
sleep 1
cap p40-08-empty-refusal
# Accept either the exact wording or the alternative refusal path.
if strip "$CAP/p40-08-empty-refusal.ansi" | grep -qE "This session has no goals|No active goal"; then
  echo "PASS[P7-refusal]: empty-session refusal rendered"
else
  echo "FAIL[P7-refusal]: refusal text not found in capture"
  FAIL=1
fi

tmux pipe-pane -t "$SESSION:0.0" 2>/dev/null || true

echo "== freeze evidence =="
freeze_render p40-01-two-goals v1-p40-01-two-goals
freeze_render p40-03-bare-clear-refusal v1-p40-03-bare-clear-refusal
freeze_render p40-05-edit-reactivate v1-p40-05-edit-reactivate
freeze_render p40-08-empty-refusal v1-p40-08-empty-refusal

if [ "$FAIL" -eq 0 ]; then
  echo "P40 LIVE EVIDENCE: ALL CHECKS PASS"
else
  echo "P40 LIVE EVIDENCE: VIOLATIONS FOUND ($FAIL failures)"
fi
exit "$FAIL"
