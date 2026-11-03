#!/bin/bash
# F2 live evidence on STOCK opencode v1: the toast-storm is dead.
#
# Checks (launch-v1.sh must already be running — server plugin + TUI companion):
# L1 ZERO JSON TOASTS: driving goal lifecycle transitions renders NO JSON blob.
# L2 CURATED MOMENT: goal creation surfaces ONE short human-readable toast.
# L3 SCREEN NEVER COVERED: after rapid churn, visible toast lines are few/short.
#
# FREEZE EVIDENCE: if the `freeze` command (charmbracelet/freeze) is available,
# key ANSI captures are rendered to PNG under captures/freeze/ as visual evidence.
# Freeze absence degrades gracefully (warn, never fails the campaign).
#
# Output: captures/f2-v1-*.ansi + captures/freeze/*.png + PASS/FAIL verdict lines; exit 0 only if all hold.
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
# Full-scrollback capture: -S - starts at the top of history, so every toast
# that rendered is present even if the visible screen scrolled past it.
cap_scrollback() { tmux capture-pane -p -S - -e -t "$SESSION:0.0" > "$CAP/$1.ansi"; echo "captured $1.ansi ($(wc -c < "$CAP/$1.ansi") bytes, full scrollback)"; }
send() { tmux send-keys -t "$SESSION:0.0" -l "$1"; sleep 0.3; tmux send-keys -t "$SESSION:0.0" Enter; }

strip() { python3 -c "
import re,sys
d=open(sys.argv[1],encoding='utf-8',errors='replace').read()
print(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',d))
" "$1"; }

# BRIEFING MATCH, made column-aware. The v1 TUI renders the briefing inside a
# toast panel whose box-drawing columns can split the message:
# "1 goal needs you: │ paused" — the count+phrase in one column, the reason
# in the next. A regex anchored on `goals? need` followed by non-pipe text
# (the shape drive.sh used for v2) therefore misses a briefing that DID render,
# and the campaign reports a product failure for a rendering choice. Matching
# on `goals? need` alone is still discriminating: the fixture seed's condition
# text deliberately avoids the phrase, and the count prefix keeps a transcript
# echo from matching. The excerpt extraction strips non-alphanumerics so the
# recorded line survives the same split.
. "$(dirname "$0")/panel-excerpt.sh"
# Region-bound: the phrase must appear inside the toast panel, not anywhere on
# the pane (the agent's transcript can echo it). panel-excerpt.sh extracts the
# panel by its title line and right-border column.
briefing_present() { panel_regions "$1" 'Fixate' | grep -aqE "goals? need"; }
briefing_excerpt() { panel_excerpt "$1" 'Fixate' 'needs you' | grep -m1 -E "goals? need" | cut -c1-70; }

FAIL=0
check_no_json_toast() {
  local n; n=$(strip "$CAP/$1.ansi" | grep -cE '\{"(kind|type|sessionID)"|"sessionID":"(ses|ses_)' || true)
  if [ "$n" -ne 0 ]; then echo "FAIL[$2]: $n raw-JSON toast(s) visible in $1"; FAIL=1; else echo "PASS[$2]: zero JSON toasts in $1"; fi
}

# Wait for the host to be USABLE, not for a guessed number of seconds.
#
# A fixed settle is a race, and this campaign is the repository's mandatory gate
# for live product claims — a gate that fails at random trains you to re-run it
# instead of reading it. Measured: with a 4 s settle the first three captures
# came back 69 bytes (an empty screen), the `/goal` never reached the plugin, no
# state file was written, and the campaign reported a violation that had nothing
# to do with the product. The same host, given longer, passed two consecutive
# runs. The predicate is the TUI's own output: an empty pane is not a booted
# host, and no capture taken of one can show anything.
echo "== pre-flight: the harness must be unmodified (a campaign can edit the code it is scored by) =="
assert_harness_unmodified || exit 1

# THE LOAD BRIEFING is a BOOT-TIME toast: measured on v2 at ~t+2.5s to t+6.5s,
# gone by ~t+7s. On v1 the companion hydrates and briefs during/after boot.
# A single capture taken after boot-settle can miss it entirely if the briefing
# rendered and faded while the TUI was still rendering, or between 1-second
# captures.
#
# FIX: during boot-settle, accumulate ALL captures into a combined file. The
# briefing is transient (~4s), so any single capture may miss it — but the
# union of all captures during the boot window will contain it if it rendered.
echo "== F2: boot settle (wait for the TUI, not for a guess) =="
BOOT_FRAMES="$CAP/f2-v1-boot-frames.ansi"
: > "$BOOT_FRAMES"
BOOTED=""
for i in $(seq 1 90); do
  sleep 1
  cap f2-v1-00-boot >/dev/null 2>&1 || true
  cat "$CAP/f2-v1-00-boot.ansi" >> "$BOOT_FRAMES" 2>/dev/null || true
  size=$(wc -c < "$CAP/f2-v1-00-boot.ansi" 2>/dev/null | tr -d ' ')
  if [ -n "$size" ] && [ "$size" -gt 400 ]; then BOOTED="$i"; break; fi
done
if [ -z "$BOOTED" ]; then
  echo "FAIL: the host never rendered a TUI after 90s — the campaign cannot observe a toast on a blank screen"
  FAIL=1
else
  echo "     host rendered a TUI after ${BOOTED}s (capture $(wc -c < "$CAP/f2-v1-00-boot.ansi" | tr -d ' ') bytes)"
fi
# One more capture after settle, also accumulated.
cap f2-v1-00-boot >/dev/null
cat "$CAP/f2-v1-00-boot.ansi" >> "$BOOT_FRAMES" 2>/dev/null || true

# THE LOAD BRIEFING, asserted from the ACCUMULATED boot frames.
# acceptance: "briefing passes without manual KEEP_STATE hack" and "briefing
# checked on BOTH hosts." The seed-briefing.sh writes a deterministic stopped
# goal at launch, so this check exercises the real path by default.
#
# DERIVED, NOT RESTATED — see resolve-state.sh for the count logic. This
# mirrors drive.sh's briefing check for the v1 host.
echo "== check the load briefing, when the workspace has something to brief about =="
resolve_state
BRIEF_WAITING=0
if [ -n "$STATE" ] && [ -f "$STATE" ]; then
  BRIEF_WAITING=$(count_needing_user)
fi
# The count distinguishes "no goals waiting" (0, a real SKIP) from "could not
# count" (?, an instrument failure). Only the first may SKIP the check; the
# second fails loudly so a broken import is never read as "nothing to brief".
case "$BRIEF_WAITING" in
  ''|*[!0-9]*)
    echo "FAIL[L2-brief-v1]: count_needing_user returned '${BRIEF_WAITING}' — the instrument cannot count, which is not the same as no goals waiting"
    FAIL=1
    ;;
esac
if [ "${BRIEF_WAITING:-0}" -gt 0 ]; then
 # Check the accumulated boot frames first (catches transient briefing that
 # appeared and faded during boot-settle). If not found there, do a bounded
 # live wait with re-capture (catches briefing that appears after boot-settle,
 # e.g. companion loads late). Same wait discipline as drive.sh.
  BRIEF_SEEN=""
  if briefing_present "$BOOT_FRAMES"; then
    BRIEF_SEEN=1
  else
    for _ in $(seq 1 15); do
      if briefing_present "$CAP/f2-v1-00-boot.ansi"; then BRIEF_SEEN=1; break; fi
      sleep 1
      cap f2-v1-00-boot >/dev/null 2>&1 || true
      cat "$CAP/f2-v1-00-boot.ansi" >> "$BOOT_FRAMES" 2>/dev/null || true
    done
  fi
  if [ -n "$BRIEF_SEEN" ]; then
    echo "PASS[L2-brief-v1]: load briefing rendered for ${BRIEF_WAITING} stopped goal(s)"
    briefing_excerpt "$BOOT_FRAMES"
  else
    echo "FAIL[L2-brief-v1]: the workspace held ${BRIEF_WAITING} stopped goal(s) and the companion briefed none of them."
    FAIL=1
  fi
else
  echo "SKIP[L2-brief-v1]: the workspace held no stopped goals at boot, so there was nothing to brief about."
fi

# BRIEFING-EXPIRY GUARD. The load briefing is a 5000ms toast emitted by the
# companion during boot. If `/goal` is sent while the briefing is still showing,
# the create toast that fires ~1-2s later collides with the briefing at the host's
# single-toast slot. Measured 2026-10-08: frames 001-003 show the briefing still
# visible when `/goal` is sent; the create toast never appears in any of 17 dense
# frames. The p42 campaign avoids this naturally (it runs 5th, long after the
# briefing expires). This 6s delay ensures the briefing's 5s duration has fully
# expired before the create toast fires, so the host's toast slot is clean.
# The delay is AFTER the briefing assertion (which already passed) and BEFORE the
# create section, so it does not weaken any assertion.
sleep 6

# A host session no earlier campaign drove (see resolve-state.sh for the
# measured incident). AFTER the briefing check — the briefing is a launch-time
# event and its frames are already captured — and BEFORE the first goal command.
fresh_host_session || { echo "FAIL[F2-session]: could not open a fresh host session"; FAIL=1; }

# Create the goal, then WAIT for it. The previous version sent `/goal` once and
# captured three seconds later, so a slow boot silently produced an empty
# capture and a false violation. drive.sh already polls the same predicate for
# the same purpose; this is that loop, not a new mechanism.
#
# DENSE CAPTURE WINDOW: the curated start toast is transient and gets cleared
# when agent output starts. Measured in the last failed run: the free-tier model
# responded so fast that the goal hit disk 1s after the send and agent output had
# already replaced the toast by the first capture — so a capture-per-second loop
# that starts at detection always arrived late. Fix: capture into per-second
# frames starting immediately after the /goal send (the send's own 0.3s settle
# covers the earliest toast instant), then append frames during the disk wait,
# then a bounded search phase. Every frame also goes to the evidence file. The
# assertion still requires the literal toast; if none of the dense frames captured
# it, that is real absence.
echo "== F2: create goal via /goal, then wait for it to exist =="
FRAMES="$CAP/f2-v1-toast-frames"
mkdir -p "$FRAMES"
FRAME_N=0
snap_frame() {
  FRAME_N=$((FRAME_N + 1))
  tmux capture-pane -p -e -t "$SESSION:0.0" > "$FRAMES/$(printf %03d $FRAME_N).ansi" 2>/dev/null || true
}
send "/goal write and verify the F2 storm report"
# Pin resolve_state to the session holding THIS campaign's goal: the newest
# state file across all sessions can belong to a concurrent campaign (measured
# 2026-11-03, run 04:17:05Z-d09555f7), and until the pin matches, reads fall
# back to the newest file.
PIN_KEY="write and verify the F2 storm report"
# Immediately start dense captures — the toast can appear before the goal hits disk.
snap_frame
CREATED=""
for i in $(seq 1 30); do
  sleep 1
  snap_frame
  resolve_state
  if [ -n "$STATE" ] && [ -f "$STATE" ]; then
    n=$(python3 -c "import json;print(len(json.load(open('$STATE')).get('goals',[])))" 2>/dev/null || echo 0)
    if [ "${n:-0}" -ge 1 ]; then CREATED="$i"; break; fi
  fi
done
if [ -z "$CREATED" ]; then
  echo "FAIL: the goal was never created — the command did not reach the plugin, so nothing downstream is evidence"
  FAIL=1
else
  echo "     goal on disk after ${CREATED}s"
fi
# Bounded search phase: the toast may still be rendering or queued behind the
# load briefing. Take fast captures (0.3s) for up to 15 iterations.
# Check ONLY the frames directory — the evidence file is not assembled until
# after this loop, so checking it here would read the previous run's file.
for _ in $(seq 1 15); do
  SEEN_TOAST=""
  for f in "$FRAMES"/*.ansi; do
    if panel_regions "$f" 'Fixate' | grep -aq "Goal started:"; then SEEN_TOAST=1; break; fi
  done
  [ -n "$SEEN_TOAST" ] && break
  sleep 0.3
  snap_frame
done
# Also capture full scrollback as additional evidence — a toast that rendered
# and scrolled off the visible pane is still in the scrollback.
cap_scrollback f2-v1-01-scrollback
# Assemble evidence file from all frames (for check_no_json_toast + assertion)
cat "$FRAMES"/*.ansi "$CAP/f2-v1-01-scrollback.ansi" > "$CAP/f2-v1-01-after-create.ansi" 2>/dev/null || true
check_no_json_toast f2-v1-01-after-create "L1-create"

if panel_regions "$CAP/f2-v1-01-after-create.ansi" 'Fixate' | grep -aq "Goal started:"; then
  echo "PASS[L2]: curated 'Goal started:' toast rendered (toast panel region)"
  MSG=$(panel_excerpt "$CAP/f2-v1-01-after-create.ansi" 'Fixate' 'Goal started:' | grep "Goal started:" | head -1 | sed 's/^[[:space:]]*//')
  LEN=${#MSG}
  echo "     toast line (${LEN} chars): $MSG"
  if [ "$LEN" -gt 200 ]; then echo "FAIL[L2]: toast line suspiciously long ($LEN)"; FAIL=1; fi
else
 # A MISSING OBSERVATION IS A FAILURE, not a warning. This campaign's own
 # summary read "ALL LAWS HOLD" while the curated moment it exists to show had
 # not rendered: the moment is the product claim, and a gate that reports
 # success because a required observation was absent is the failure mode this
 # repository keeps paying for.
  echo "FAIL[L2]: curated 'Goal started:' toast NOT observed — the moment the campaign exists to show did not render"
  FAIL=1
fi
resolve_state
if [ -f "$STATE" ]; then
python3 -c "
import json
d=json.load(open('$STATE'))
gs=d.get('goals',[])
print('     disk goals:', [(g.get('goalId','?')[:8], g.get('status','?')) for g in gs[:3]])
if not gs:
    rs=d.get('results',[])
    print('     disk results:', [(r.get('goalId','?')[:8], r.get('state','?')) for r in rs[:3]])
"
else
  echo "     NO STATE FILE"
fi

echo "== F2: pause -> resume -> pause churn =="
send "/goal pause";  sleep 1.2
cap f2-v1-02a-midchurn
check_no_json_toast f2-v1-02a-midchurn "L1-churn-a"
send "/goal resume"; sleep 1.2
send "/goal pause";  sleep 2.5
cap f2-v1-02-after-churn
check_no_json_toast f2-v1-02-after-churn "L1-churn"

echo "== F2: screen coverage audit (L3) =="
python3 - "$CAP/f2-v1-02-after-churn.ansi" <<'PY' || FAIL=1
import re, sys
data = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', open(sys.argv[1], encoding='utf-8', errors='replace').read())
lines = [l.strip() for l in data.split('\n') if l.strip()]
long_blob = [l for l in lines if len(l) > 200]
print(f"     nonempty lines={len(lines)} >200-char lines={len(long_blob)}")
if len(long_blob) > 0:
    print("FAIL[L3]: wall-of-text lines present (old storm signature)")
    raise SystemExit(1)
print("PASS[L3]: no screen-covering blobs")
PY

echo "== F2: clear & final =="
send "/goal clear"; sleep 2
cap f2-v1-03-after-clear
check_no_json_toast f2-v1-03-after-clear "L1-clear"

echo "== freeze evidence: render key ANSI captures to PNG =="
freeze_render f2-v1-00-boot v1-00-boot
freeze_render f2-v1-01-after-create v1-01-after-create
freeze_render f2-v1-02-after-churn v1-02-after-churn
freeze_render f2-v1-03-after-clear v1-03-after-clear

if [ "$FAIL" -eq 0 ]; then echo "F2 LIVE EVIDENCE: ALL LAWS HOLD"; else echo "F2 LIVE EVIDENCE: VIOLATIONS FOUND"; fi
exit "$FAIL"
