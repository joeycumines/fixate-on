#!/bin/bash
# live evidence on stock opencode v1: the disk loop never invents, hides,
# or forges goal truth — checked with TWO live sessions, per the acceptance:
# "garbage written into one session state.json for 2-3s while another session
# goal runs produces zero false Goal-cleared/started toasts and the dashboard
# never empties (per-file continuity, not total-filesRead heuristics)."
#
# MODEL-FREE: every dispatch goes through the host's command.execute.before
# hook into handleCommand (local machinery); the companion's disk loop is file
# polling. No model inference is required. Goals are paused immediately so no
# continuation loop fires against the provider.
#
# ASSERTION DISCIPLINE: lifecycle toasts are transient panels the host clears
# before they reach scrollback (measured 2026-10-09: scrollback held 0 markers
# across a full run). Assertions therefore count plugin-produced toast markers
# in dense per-second frame captures (panel_regions) unioned with the baseline
# scrollback, and DIFF against a pre-corruption baseline computed over the same
# corpus. State truth comes from each session's own state.json.
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
  if [ -z "$FREEZE_BIN" ]; then return 0; fi
  if [ ! -f "$CAP/$src.ansi" ]; then return 0; fi
  if "$FREEZE_BIN" < "$CAP/$src.ansi" -o "$CAP/freeze/$dest.png" --language ansi --theme dracula --window 2>/dev/null; then
    echo "freeze: rendered $dest.png ($(wc -c < "$CAP/freeze/$dest.png") bytes)"
  fi
}

# Full-scrollback capture: -S - starts at the top of history, so every toast
# the host ever rendered is counted — a toast that scrolled off-screen is
# still evidence.
cap() {
  tmux capture-pane -p -S - -e -t "$SESSION:0.0" > "$CAP/$1.ansi"
  echo "captured $1.ansi ($(wc -c < "$CAP/$1.ansi") bytes, full scrollback)"
}
send() { tmux send-keys -t "$SESSION:0.0" -l "$1"; sleep 0.3; tmux send-keys -t "$SESSION:0.0" Enter; }

strip() { python3 -c "
import re,sys
d=open(sys.argv[1],encoding='utf-8',errors='replace').read()
print(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',d))
" "$1"; }

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

# The state-file finder for a session whose goal condition matches a prefix.
# resolve_state returns the newest session; with two sessions we need both.
state_path_for() {
  local prefix="$1"
  local sessions_dir="$WORK/.opencode/goals/sessions"
  [ -d "$sessions_dir" ] || return 0
  for d in "$sessions_dir"/*/; do
    local f="$d/state.json"
    [ -f "$f" ] || continue
    if python3 -c "
import json,sys
d=json.load(open('$f'))
for g in d.get('goals',[]):
    if g.get('condition','').startswith('$prefix'): sys.exit(0)
sys.exit(1)" 2>/dev/null; then
      echo "$f"
      return 0
    fi
  done
  return 0
}
state_goal_count_at() {
  local f="$1"
  [ -f "$f" ] || { echo 0; return; }
  python3 -c "import json;print(len(json.load(open('$f')).get('goals',[])))" 2>/dev/null || echo 0
}

# 48A POSITIVE CONTROL SETUP
# The lifecycle toasts ("Goal started:", "Goal cleared:") are transient panels
# the host clears before they reach full scrollback. Measured 2026-10-09: the
# last real P41 run's captures held started=0 cleared=0 across every capture —
# the toast channel the 0==0 diff assertions count over was DEAD, so T1/T2
# passed vacuously. Dense per-second frame captures during T0 goal creation
# catch the panel while it is rendered; a positive control requires at least
# one real "Goal started:" panel before any diff assertion runs.
. "$(dirname "$0")/panel-excerpt.sh"
FRAMES="$CAP/p41-frames"
rm -rf "$FRAMES"
mkdir -p "$FRAMES"
FRAME_N=0
snap_frame() {
  FRAME_N=$((FRAME_N + 1))
  tmux capture-pane -p -e -t "$SESSION:0.0" > "$FRAMES/$(printf %03d $FRAME_N).ansi" 2>/dev/null || true
}
# 48A: marker counts over the SAME corpus at every checkpoint — the baseline
# scrollback capture plus every dense frame captured so far. Toasts are
# transient panels; scrollback alone held started=0 cleared=0 on the last real
# run, so it is not a counting channel on its own. Defined before FIRST use
# (the BASE computation) — a function called before it is defined expands to
# nothing, and an empty BASE makes every later diff pass vacuously.
#
# TWO counting disciplines, and the reason both exist:
#  - The marker is counted within the FIXATE PANEL REGION only (panel_regions),
#    so the agent transcript echoing the phrase cannot satisfy the count.
#  - Within a frame the marker contributes AT MOST 1, no matter how many lines
#    or how many seconds the panel persists: a toast that stays on screen
#    across consecutive 1s frames is ONE toast. Measured 2026-11-03
#    (run 07:32:22Z-156bbc83): a stale toast from the earlier cockpit campaign
#    sat in frames 018 AND 019 while p41's corpus ran, and a per-line count
#    grew 15 -> 17 between BASE and MID with no new toast emitted — a false
#    FAIL[T2-no-false-start]. grep -c counts lines; the frame is scanned once
#    and contributes 0 or 1.
count_marker_all() {
  local marker="$1"
  local total=0
  if [ -f "$CAP/p41-01-baseline.ansi" ]; then
    if panel_regions "$CAP/p41-01-baseline.ansi" 'Fixate' | grep -q "$marker" 2>/dev/null; then
      total=$((total + 1))
    fi
  fi
  local f
  for f in "$FRAMES"/*.ansi; do
    [ -f "$f" ] || continue
    if panel_regions "$f" 'Fixate' | grep -q "$marker" 2>/dev/null; then
      total=$((total + 1))
    fi
  done
  echo "$total"
}

echo "== pre-flight: the harness must be unmodified =="
assert_harness_unmodified || exit 1

echo "== P41: boot settle =="
BOOTED=""
for i in $(seq 1 40); do
  sleep 1
  bytes=$(tmux capture-pane -p -e -t "$SESSION:0.0" 2>/dev/null | wc -c | tr -d ' ')
  if [ -n "$bytes" ] && [ "$bytes" -gt 400 ]; then BOOTED="$i"; break; fi
done
[ -n "$BOOTED" ] || { echo "FAIL[P41-boot]: host never rendered a TUI after 40s"; FAIL=1; }
echo "     host rendered a TUI after ${BOOTED}s"

# BRIEFING-EXPIRY GUARD (drive-f2.sh precedent): the seeded load briefing is a
# 5000ms toast. On a fast boot it can still hold the host's single toast slot
# when T0's first /goal fires, swallowing the create toast the positive
# control needs. Waiting past the briefing's lifetime keeps the slot clean;
# harmless when boot-settle already outlasted the briefing.
sleep 6

# A host session no earlier campaign drove (see resolve-state.sh for the
# measured incident): a stale in-flight goal-command can only land here. T0's
# beta session is opened INSIDE this campaign by its own <leader>n, so this is
# the alpha session's fresh start.
fresh_host_session || { echo "FAIL[P41-session]: could not open a fresh host session"; FAIL=1; }

echo "== T0: create TWO goals in TWO sessions (alpha session, beta session) =="
# Session A (the session we will corrupt): goal alpha.
# Dense frame capture starts here — the toast panel is transient.
send "/goal alpha: hold steady for the torn-read test"
snap_frame
for i in $(seq 1 30); do
  sleep 1
  snap_frame
  [ "$(state_goal_count_at "$(state_path_for 'alpha:')")" -ge 1 ] 2>/dev/null && break
done
ALPHA_STATE=$(state_path_for 'alpha:')
[ -f "$ALPHA_STATE" ] || { echo "FAIL[T0-alpha]: alpha goal never appeared"; FAIL=1; }
# Toast window: the start toast is transient, and the pause toast that follows
# replaces it in the host's single toast slot — take fast frames NOW so the
# positive control has a frame that actually holds "Goal started:".
for _ in $(seq 1 6); do snap_frame; sleep 0.3; done
send "/goal pause"
wait_for_pane_text "Goal paused" 12 || true
sleep 1

# Session B (the session that must stay visible): create it via <leader>n,
# then goal beta. The chord is gated on the home route's marker for the same
# reason as fresh_host_session: a slow route transition with a bare sleep can
# drop the beta /goal into the ALPHA session, and the campaign would then
# assert its two-session precondition against one session.
tmux send-keys -t "$SESSION:0.0" C-x
sleep 0.5
tmux send-keys -t "$SESSION:0.0" n
BETA_ROUTE=""
for _ in $(seq 1 20); do
  sleep 1
 # The ellipsis is the home prompt's own rendered form (see
 # fresh_host_session) — plain "Ask anything" would match a transcript quote.
  if tmux capture-pane -p -t "$SESSION:0.0" 2>/dev/null | grep -q "Ask anything…"; then BETA_ROUTE=1; break; fi
done
[ -n "$BETA_ROUTE" ] || { echo "FAIL[T0-beta-route]: the home-route marker never appeared after <leader>n — beta's /goal would land in the alpha session"; FAIL=1; }
send "/goal beta: stay visible while alpha's file is torn"
snap_frame
for i in $(seq 1 30); do
  sleep 1
  snap_frame
  [ "$(state_goal_count_at "$(state_path_for 'beta:')")" -ge 1 ] 2>/dev/null && break
done
BETA_STATE=$(state_path_for 'beta:')
[ -f "$BETA_STATE" ] || { echo "FAIL[T0-beta]: beta goal never appeared (second session may not have been created)"; FAIL=1; }
# Same toast-window discipline as alpha.
for _ in $(seq 1 6); do snap_frame; sleep 0.3; done
send "/goal pause"
wait_for_pane_text "Goal paused" 12 || true
sleep 1

echo "     alpha state: ${ALPHA_STATE:-MISSING}"
echo "     beta  state: ${BETA_STATE:-MISSING}"
if [ -n "$ALPHA_STATE" ] && [ -n "$BETA_STATE" ] && [ "$ALPHA_STATE" = "$BETA_STATE" ]; then
  echo "FAIL[T0]: alpha and beta landed in the SAME session — the two-session precondition is not met"
  FAIL=1
fi

# Baseline counts over the full scrollback + all dense frames captured so far.
# This is the corpus that MID/HEAL will be compared against, so BASE must use
# the same counting function to avoid a false-positive diff. Per-frame boolean
# (one toast counted once even if its panel persists across frames — see
# count_marker_all), NOT per-line: measured 2026-11-03 (run 07:32:22Z) a
# stale toast from an earlier campaign sat in two consecutive frames and the
# per-line sum grew between checkpoints with no new toast emitted.
cap p41-01-baseline
CLEARED_BASE=$(count_marker_all "Goal cleared")
STARTED_BASE=$(count_marker_all "Goal started")
echo "     baseline markers: cleared=$CLEARED_BASE started=$STARTED_BASE"

# POSITIVE CONTROL: at least one dense frame captured during T0 must hold a
# real "Goal started:" panel. Two goals were created in T0 (alpha + beta), so
# the channel must have produced at least one such panel. If it did not, the
# toast channel is dead and every subsequent 0==0 diff is vacuous.
POSITIVE_SEEN=""
for f in "$FRAMES"/*.ansi; do
  [ -f "$f" ] || continue
  if panel_regions "$f" 'Fixate' | grep -aq "Goal started:"; then POSITIVE_SEEN=1; break; fi
done
if [ -z "$POSITIVE_SEEN" ]; then
 # Also check the baseline capture itself (full scrollback may still hold it)
  if panel_regions "$CAP/p41-01-baseline.ansi" 'Fixate' | grep -aq "Goal started:"; then
    POSITIVE_SEEN=1
  fi
fi
if [ -n "$POSITIVE_SEEN" ]; then
  echo "PASS[positive-control]: toast channel live — 'Goal started:' panel observed in dense frames"
else
  echo "FAIL[positive-control]: no 'Goal started:' panel in any dense frame or baseline — toast channel is dead, 0==0 diffs are vacuous"
  FAIL=1
fi

# Backup alpha's good state for healing.
cp "$ALPHA_STATE" "$ALPHA_STATE.p41-backup"

echo "== T1: corrupt ALPHA's state.json with garbage for 3 seconds (2+ poll ticks) =="
printf '{this is torn garbage that must never read as an empty workspace' > "$ALPHA_STATE"
# Dense frames during corruption: a false "Goal cleared" toast is transient and
# must be caught here, not in scrollback.
for _ in $(seq 1 3); do sleep 1; snap_frame; done

echo "== T1 mid-corruption: beta's goal must still be visible, no false moments =="
# Mid-corruption, open the dashboard: the store must NOT have emptied beta's goal.
tmux send-keys -t "$SESSION:0.0" C-p
sleep 1
tmux send-keys -t "$SESSION:0.0" -l "fixate: dashboard"
sleep 1
tmux send-keys -t "$SESSION:0.0" Enter
sleep 2
cap p41-02-mid-corruption
tmux send-keys -t "$SESSION:0.0" Escape
sleep 0.5

MID_CLEARED=$(count_marker_all "Goal cleared")
MID_STARTED=$(count_marker_all "Goal started")

echo "== T2: heal ALPHA's file and confirm no false create + beta still present =="
cp "$ALPHA_STATE.p41-backup" "$ALPHA_STATE"
# Dense frames during heal: a false "Goal started" re-create toast is transient.
for _ in $(seq 1 3); do sleep 1; snap_frame; done
tmux send-keys -t "$SESSION:0.0" C-p
sleep 1
tmux send-keys -t "$SESSION:0.0" -l "fixate: dashboard"
sleep 1
tmux send-keys -t "$SESSION:0.0" Enter
sleep 2
cap p41-03-after-heal
tmux send-keys -t "$SESSION:0.0" Escape
sleep 0.5

HEAL_CLEARED=$(count_marker_all "Goal cleared")
HEAL_STARTED=$(count_marker_all "Goal started")

echo "     marker counts (baseline+frames): cleared base=$CLEARED_BASE mid=$MID_CLEARED heal=$HEAL_CLEARED"
echo "     marker counts (baseline+frames): started base=$STARTED_BASE mid=$MID_STARTED heal=$HEAL_STARTED"

# The ONLY acceptable change in these counts is... none. A torn file must
# produce ZERO new cleared/started moments; a healed file must produce ZERO
# new started moments (carry-forward suppresses the false re-create).
if [ "$MID_CLEARED" -ne "$CLEARED_BASE" ]; then
  echo "FAIL[T1-no-false-clear]: 'Goal cleared' count went $CLEARED_BASE -> $MID_CLEARED during corruption"
  FAIL=1
else
  echo "PASS[T1-no-false-clear]: zero false 'Goal cleared' during corruption ($CLEARED_BASE -> $MID_CLEARED)"
fi
if [ "$HEAL_CLEARED" -ne "$CLEARED_BASE" ]; then
  echo "FAIL[T1-no-false-clear-heal]: 'Goal cleared' count went $CLEARED_BASE -> $HEAL_CLEARED after heal"
  FAIL=1
else
  echo "PASS[T1-no-false-clear-heal]: zero false 'Goal cleared' after heal ($CLEARED_BASE -> $HEAL_CLEARED)"
fi
if [ "$MID_STARTED" -ne "$STARTED_BASE" ]; then
  echo "FAIL[T2-no-false-start-mid]: 'Goal started' count went $STARTED_BASE -> $MID_STARTED during corruption"
  FAIL=1
else
  echo "PASS[T2-no-false-start-mid]: zero false 'Goal started' during corruption ($STARTED_BASE -> $MID_STARTED)"
fi
if [ "$HEAL_STARTED" -ne "$STARTED_BASE" ]; then
  echo "FAIL[T2-no-false-start-heal]: 'Goal started' count went $STARTED_BASE -> $HEAL_STARTED after heal (false re-create)"
  FAIL=1
else
  echo "PASS[T2-no-false-start-heal]: zero false 'Goal started' after heal — carry-forward suppressed the re-create ($STARTED_BASE -> $HEAL_STARTED)"
fi

# T3: the dashboard must still name BOTH goals — during corruption AND after.
# The dashboard reads the store, which the refresh loop must never have emptied.
if strip "$CAP/p41-02-mid-corruption.ansi" | grep -q "beta: stay visible"; then
  echo "PASS[T3-beta-visible-mid]: beta's goal visible in dashboard during alpha's corruption"
else
  echo "FAIL[T3-beta-visible-mid]: beta's goal NOT visible in dashboard during alpha's corruption — dashboard emptied"
  FAIL=1
fi
if strip "$CAP/p41-03-after-heal.ansi" | grep -q "beta: stay visible"; then
  echo "PASS[T3-beta-visible-heal]: beta's goal visible in dashboard after heal"
else
  echo "FAIL[T3-beta-visible-heal]: beta's goal NOT visible in dashboard after heal"
  FAIL=1
fi
# 48B INDEPENDENT T3-ALPHA-REAPPEARS
# The previous check read $ALPHA_STATE immediately after the script's own `cp`
# restore — it tested its own copy and could not fail. The independent check
# uses the product's own readDiskGoalSnapshots reader via bun, which parses
# the file through the same projection the companion refresh loop uses. This
# exercises the real code path (JSON parse → snapshot projection → sessionID
# extraction) independently of the shell-level cp.
REPO_ROOT="$HERE/../.."
ALPHA_AFTER_HEAL_INDEPENDENT=$(cd "$REPO_ROOT" && bun -e '
const { readDiskGoalSnapshots } = await import("./src/tui-disk-state.ts")
const read = await readDiskGoalSnapshots(process.argv[1])
const alpha = read.snapshots.filter(s => s.condition.startsWith("alpha:"))
console.log(alpha.length)
' "$WORK" 2>/dev/null || echo 0)
if [ "${ALPHA_AFTER_HEAL_INDEPENDENT:-0}" -ge 1 ] 2>/dev/null; then
  echo "PASS[T3-alpha-reappears]: alpha's goal readable via product reader after heal (count=$ALPHA_AFTER_HEAL_INDEPENDENT)"
else
  echo "FAIL[T3-alpha-reappears]: alpha's goal NOT readable via product reader after heal (count=$ALPHA_AFTER_HEAL_INDEPENDENT)"
  FAIL=1
fi

echo "== cleanup: clear both goals and tidy =="
send "/goal clear"
wait_for_pane_text "Goal cleared" 12 || true
sleep 1
tmux send-keys -t "$SESSION:0.0" C-x
sleep 0.5
tmux send-keys -t "$SESSION:0.0" l
sleep 1
tmux send-keys -t "$SESSION:0.0" Enter
sleep 2
send "/goal clear"
wait_for_pane_text "Goal cleared" 12 || true
sleep 1
rm -f "$ALPHA_STATE.p41-backup"

echo "== freeze evidence =="
freeze_render p41-01-baseline v1-p41-01-baseline
freeze_render p41-02-mid-corruption v1-p41-02-mid-corruption
freeze_render p41-03-after-heal v1-p41-03-after-heal

if [ "$FAIL" -eq 0 ]; then
  echo "P41 LIVE EVIDENCE: ALL CHECKS PASS"
else
  echo "P41 LIVE EVIDENCE: VIOLATIONS FOUND ($FAIL failures)"
fi
exit "$FAIL"
