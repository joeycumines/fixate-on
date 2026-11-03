#!/bin/bash
# V1 cockpit live evidence: drives the Fixate on stock brew opencode v1.
#
# Checks (launch-v1.sh must already be running):
# C1 DASHBOARD OPENS: the palette opens the Fixate as a DialogSelect.
# C2 GOAL LIST RENDERS: a numbered goal row with its status appears.
# C3 DETAIL CARD: selecting a goal shows Objective/Status/Tokens/Turns/Analytics/History.
# C4 ACTION MENU: dismissing the detail opens the action menu (Pause/Resume/Focus/
# Edit/Checkpoint/Clear/<- Back to Goals).
# C5 BACK NAVIGATION: "<- Back to Goals" returns to the goal list.
# C5b LIST USABILITY: the returned list RECEIVES KEYS (selecting a row opens the
# detail card). Visibility alone is not the requirement — a focus-lost
# dialog renders but is inert, and only a key shows the difference.
# C6 CLOSE: Escape clears the dialog and no dialog marker remains on screen.
#
# WHY THE PALETTE AND NOT THE CHORD: the plugin binds the cockpit to the
# "ctrl+shift+g <key>" chord, but that chord is NOT representable by terminals —
# a terminal delivers ctrl+shift+letter as the same byte as plain ctrl+letter
# (verified: `cat -v` shows C-S-g and C-g both arrive as ^G / 0x07), so tmux
# cannot send the chord at all and a literal "d" lands in the prompt instead.
# This is a terminal limitation, not a plugin defect. The command palette
# (ctrl+p) is the universal, byte-representable path and is what this script
# drives. Do not "fix" this back to a chord send: it will type into the prompt.
#
# ASSERTION DISCIPLINE: every pattern below is a marker that appears ONLY in the
# dialog (e.g. "Fixate", "Actions: <id>", "Tokens:"). Patterns that also
# occur in the agent transcript (the echoed command template, the "ctrl+p
# commands" footer) are deliberately NOT used, because they pass whether or not
# the dialog is open — that is how this harness reports false greens.
#
# FREEZE EVIDENCE: if freeze is available, key captures render to PNG.
# Freeze absence degrades gracefully (warn, never fails the campaign).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="fixate-on"
CAP="$HERE/captures"
WORK="$HERE/work-v1"
# Resolved from the LAYOUT, not restated: goal state is one file per
# session. See resolve-state.sh for why the old single-file path is
# gone and what happens if this is wrong again.
. "$(dirname "$0")/resolve-state.sh"
mkdir -p "$CAP"
FREEZE_DIR="$CAP/freeze"
mkdir -p "$FREEZE_DIR"

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
  if "$FREEZE_BIN" < "$CAP/$src.ansi" -o "$FREEZE_DIR/$dest.png" --language ansi --theme dracula --window 2>/dev/null; then
    echo "freeze: rendered $dest.png ($(wc -c < "$FREEZE_DIR/$dest.png") bytes)"
  else
    echo "WARN: freeze failed for $src (exit $?) — ANSI evidence unaffected"
  fi
}

cap() { tmux capture-pane -p -e -t "$SESSION:0.0" > "$CAP/$1.ansi"; echo "captured $1.ansi ($(wc -c < "$CAP/$1.ansi") bytes)"; }
send() { tmux send-keys -t "$SESSION:0.0" -l "$1"; sleep 0.3; tmux send-keys -t "$SESSION:0.0" Enter; }

# Open the Fixate through the command palette (the path every live campaign takes).
# The query must be a substring of the palette entry it targets. The entry is
# `Fixate: Dashboard` (src/tui.ts), so this must track the brand — it did not,
# once, and the harness could not reach its own C1 assertion.
open_dashboard() {
  tmux send-keys -t "$SESSION:0.0" C-p
  sleep 1
  tmux send-keys -t "$SESSION:0.0" -l "fixate: dashboard"
  sleep 1
  tmux send-keys -t "$SESSION:0.0" Enter
  sleep 2
}

strip() { python3 -c "
import re,sys
d=open(sys.argv[1],encoding='utf-8',errors='replace').read()
print(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',d))
" "$1"; }

FAIL=0
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

# Wait for the host to be USABLE. Measured on this machine, a v1 host needs
# 13-16s to render its TUI; the poll below waits 10s. A campaign that drives a
# host which has not booted observes nothing and reports it as a product
# failure — and because the host is sometimes faster, those failures arrive at
# random and read as flakiness in the thing under test. Same wait as
# drive-f2.sh, for the same reason.
echo "== pre-flight: the harness must be unmodified (a campaign can edit the code it is scored by) =="
assert_harness_unmodified || exit 1

echo "== boot settle: wait for the TUI, not for a guess =="
C_BOOTED=""
for i in $(seq 1 40); do
  sleep 1
  bytes=$(tmux capture-pane -p -e -t "$SESSION:0.0" 2>/dev/null | wc -c | tr -d ' ')
  if [ -n "$bytes" ] && [ "$bytes" -gt 400 ]; then C_BOOTED="$i"; break; fi
done
if [ -z "$C_BOOTED" ]; then
  echo "FAIL[C-boot]: the host never rendered a TUI after 40s — the campaign cannot observe a cockpit on a blank screen"
  FAIL=1
else
  echo "     host rendered a TUI after ${C_BOOTED}s"
fi

# A host session no earlier campaign drove (see resolve-state.sh for the
# measured incident): a stale in-flight goal-command can only land here.
fresh_host_session || { echo "FAIL[C-session]: could not open a fresh host session"; FAIL=1; }
# Pin resolve_state to the session holding this campaign's own goal (falls back
# to the newest file until the pin matches): the newest state file can belong
# to a concurrent campaign — measured 2026-11-03, run 04:17:05Z-d09555f7, where
# a late duplicate goal-command from this very campaign made its session the
# newest while a later campaign read it.
PIN_KEY="fix the broken add function in src/math.js"

echo "== C0: ensure a NON-TERMINAL goal exists for the cockpit to display =="
# A paused goal is chosen deliberately: an active goal on the harness fixture can
# run to completion in seconds, which would empty the list mid-campaign and make C2
# flaky for reasons that have nothing to do with the cockpit. Pausing freezes a
# stable row (rendered as "[paused]") for the duration of the drive.
live_goal_count() {
  resolve_state
  [ -f "$STATE" ] || { echo 0; return; }
  python3 -c "
import json
d=json.load(open('$STATE'))
print(len([g for g in d.get('goals',[]) if g.get('status') in ('active','paused','working')]))
" 2>/dev/null || echo 0
}
if [ "$(live_goal_count)" -eq 0 ]; then
  echo "No non-terminal goal — creating one via /goal for the cockpit campaign"
  send "/goal fix the broken add function in src/math.js --max-turns 20"
 # 30 x 1s, not 10: the /goal has to reach a host that has only just
 # finished booting, and a poll that gives up early turns a slow boot into
 # "the cockpit could not display a goal".
  for i in $(seq 1 30); do
    sleep 1
    [ "$(live_goal_count)" -gt 0 ] && break
  done
  [ "$(live_goal_count)" -gt 0 ] || { echo "FAIL[C0]: the goal was never created — the command did not reach the plugin"; FAIL=1; }
fi
# Freeze it so it cannot complete while the cockpit is being driven.
send "/goal pause"
sleep 2
if [ "$(live_goal_count)" -eq 0 ]; then
  echo "FAIL[C0]: no non-terminal goal in state.json — cockpit list could not be demonstrated"
  FAIL=1
else
  echo "PASS[C0]: $(live_goal_count) non-terminal goal(s) available for the cockpit"
fi
cap cockpit-v1-00-ready

echo "== C1: open dashboard via command palette =="
open_dashboard
cap cockpit-v1-01-dashboard-open
check_contains "C1-dialog" "cockpit-v1-01-dashboard-open" "Fixate"

echo "== C2: goal list renders a numbered row with status =="
check_contains "C2-row" "cockpit-v1-01-dashboard-open" "[0-9]+\. \[(active|paused|complete)\]"

echo "== C3: select first goal (Enter) -> detail card =="
tmux send-keys -t "$SESSION:0.0" Enter
sleep 2
cap cockpit-v1-02-detail
check_contains "C3-title" "cockpit-v1-02-detail" "Goal: [0-9a-f]{8}"
check_contains "C3-objective" "cockpit-v1-02-detail" "Objective:"
check_contains "C3-status" "cockpit-v1-02-detail" "Status:"
check_contains "C3-tokens" "cockpit-v1-02-detail" "Tokens:"
check_contains "C3-turns" "cockpit-v1-02-detail" "Turns:"

echo "== C4: dismiss detail (Enter) -> action menu =="
tmux send-keys -t "$SESSION:0.0" Enter
sleep 1.5
cap cockpit-v1-03-actions
check_contains "C4-title" "cockpit-v1-03-actions" "Actions: [0-9a-f]{8}"
check_contains "C4-pause" "cockpit-v1-03-actions" "Pause"
check_contains "C4-resume" "cockpit-v1-03-actions" "Resume"
check_contains "C4-back" "cockpit-v1-03-actions" "Back to Goals"

echo "== C5: navigate to 'Back to Goals' -> goal list =="
# UP x1, NOT Down xN. The action menu wraps: N Downs on an N-item menu returns
# to item 0. This script sent Down x7 for a 7-item menu, so it selected "Pause"
# and NEVER REACHED "Back to Goals" — which is why every campaign reported C5 as
# a product failure with the same signature. Up from the first item lands on the
# LAST item, which is "Back to Goals", and stays correct if the menu grows.
tmux send-keys -t "$SESSION:0.0" Up
sleep 0.4
tmux send-keys -t "$SESSION:0.0" Enter
sleep 2
cap cockpit-v1-04-back-to-list
check_contains "C5-back-to-list" "cockpit-v1-04-back-to-list" "Fixate"
check_absent "C5-left-actions" "cockpit-v1-04-back-to-list" "Actions: [0-9a-f]{8}"

echo "== C5b: the returned list must be KEYBOARD-USABLE, not merely visible =="
# Displaying the list is not the requirement; RECEIVING KEYS is. A dialog
# replaced from inside another dialog's callback renders but loses keyboard
# focus on stock v1, and a check that only looks for "Fixate" cannot
# tell the two apart. Selecting a row shows the list has focus: the detail card
# can only appear if the key reached it.
tmux send-keys -t "$SESSION:0.0" Enter
sleep 2
cap cockpit-v1-04b-list-focused
check_contains "C5b-list-accepts-keys" "cockpit-v1-04b-list-focused" "Goal: [0-9a-f]{8}"
# Leave the detail card so C6 starts from a known state.
tmux send-keys -t "$SESSION:0.0" Escape
sleep 1.5

echo "== C6: close cockpit (Escape) =="
tmux send-keys -t "$SESSION:0.0" Escape
sleep 1.5
cap cockpit-v1-05-closed
# The dialog overlay is gone: none of the dialog-only markers remain. Checking
# for the always-present footer ("ctrl+p commands") would pass with the dialog
# open, so it is deliberately not used here.
check_absent "C6-no-dashboard" "cockpit-v1-05-closed" "Fixate"
check_absent "C6-no-actions" "cockpit-v1-05-closed" "Actions: [0-9a-f]{8}"
check_absent "C6-no-detail" "cockpit-v1-05-closed" "Goal: [0-9a-f]{8}"

echo "== freeze evidence: render key cockpit captures to PNG =="
freeze_render cockpit-v1-01-dashboard-open v1-cockpit-01-dashboard
freeze_render cockpit-v1-02-detail v1-cockpit-02-detail
freeze_render cockpit-v1-03-actions v1-cockpit-03-actions
freeze_render cockpit-v1-05-closed v1-cockpit-05-closed

if [ "$FAIL" -eq 0 ]; then
  echo "V1 COCKPIT LIVE EVIDENCE: ALL CHECKS PASS"
else
  echo "V1 COCKPIT LIVE EVIDENCE: VIOLATIONS FOUND ($FAIL failures)"
fi
exit "$FAIL"
