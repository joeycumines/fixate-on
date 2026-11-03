#!/bin/bash
# Live-dashboard PTY probe driver for the E2E harness.
#
# Flow (deterministic, palette-driven — robust under tmux):
# 1. open the command palette (ctrl+p), type "fixate:", select Fixate: Add Goal, Enter
# 2. in the prompt dialog, type an objective, Enter (goal loop begins)
# 3. poll state.json until status=active
# 4. open Fixate: Dashboard via palette (ctrl+p -> type -> Enter)
# 5. poll capture-pane; consecutive differing bodies while same dialog stays
# open = LIVE update evidence
# 6. genuine close (Escape) — dialog closes
#
# SECURITY: the harness stores, reads, and prints no key material. The provider
# key is passed through from the caller's environment (export OPENROUTER_API_KEY
# before launching) into the tmux session env; no tracked file contains a secret.
#
# FREEZE EVIDENCE: if the `freeze` command (charmbracelet/freeze) is available,
# key ANSI captures are rendered to PNG under captures/freeze/ as visual evidence.
# Freeze absence degrades gracefully (warn, never fails the campaign) because
# the ANSI body-diff remains the authoritative live-update gate.
#
# Usage: bash hack/e2e-harness/drive.sh (launch.sh must already be running)
# Output: captures/*.ansi + captures/freeze/*.png + snapshots of state.json under work/
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="fixate-on"
CAP="$HERE/captures"
WORK="$HERE/work"
# Resolved from the LAYOUT, not restated: goal state is one file per
# session. See resolve-state.sh for why the old single-file path is
# gone and what happens if this is wrong again.
. "$(dirname "$0")/resolve-state.sh"
mkdir -p "$CAP" "$WORK"
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
snap() { resolve_state
  if [ -f "$STATE" ]; then cp "$STATE" "$CAP/$1.json"; echo "snap $1.json"; else echo "no state ($STATE)"; fi; }

# SAMPLED FRAMES, as a sequence. The lifecycle toast is transient — it is on
# screen for a few seconds and then gone — so the assertion about it has to read
# the frames captured WHILE the goal is being created. A frame taken after the
# wait can show nothing at all, and reading it would report a toast that
# rendered as one that never rendered.
FRAME_SEQ=0
capture_frame() {
  FRAME_SEQ=$((FRAME_SEQ + 1))
  tmux capture-pane -p -e -t "$SESSION:0.0" > "$CAP/04-after-add.ansi"
  cp "$CAP/04-after-add.ansi" "$CAP/04-after-add-$(printf %02d "$FRAME_SEQ").ansi"
}

# Body-of-dashboard = ANSI-stripped text from the dashboard header onward.
# Requires either a distinctive dashboard marker or a correlated pair of
# generic section headers to avoid false positives from palette/search content.
. "$(dirname "$0")/panel-excerpt.sh"
dash_body() { python3 - "$1" <<'PY'
import re, sys
data = open(sys.argv[1], encoding='utf-8', errors='replace').read()
data = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', data)
lines = [l.rstrip('\n') for l in data.split('\n')]
text = '\n'.join(lines)
distinctive = ['Fixate', 'No active goals', 'No goals found']
generic_pairs = [('Status:', 'Tokens:'), ('Status:', 'Turns:'), ('Tokens:', 'Turns:')]
found_distinctive = any(m in text for m in distinctive)
found_pair = any(a in text and b in text for a, b in generic_pairs)
if not (found_distinctive or found_pair):
    sys.exit(1)
try:
    i = next(i for i, l in enumerate(lines)
             if any(m in l for m in distinctive) or
                any(a in l for a, b in generic_pairs) or
                any(b in l for a, b in generic_pairs))
except StopIteration:
    sys.exit(1)
print('\n'.join(l for l in lines[i:] if l.strip())[:2000])
PY
}

echo "== pre-flight: the harness must be unmodified (a campaign can edit the code it is scored by) =="
assert_harness_unmodified || exit 1

echo "== pre-flight: ensure fixture is broken (auto-reset if a prior campaign fixed it) =="
FIXTURE_OUT=$(cd "$WORK" && bun test 2>&1) || true
if echo "$FIXTURE_OUT" | grep -qE '[[:space:]]0 fail'; then
  echo "fixture was fixed by a prior campaign — resetting to the broken baseline"
  cat > "$WORK/src/math.js" <<'FIXTURE'
export function add(a, b) {
  return a - b
}

export function multiply(a, b) {
  return a + b
}

export function subtract(a, b) {
  return a + b
}

export function divide(a, b) {
  return a * b
}

export function modulo(a, b) {
  return a + b
}

export function power(base, exp) {
  return base + exp
}

export function clamp(value, min, max) {
  return value
}
FIXTURE
  cat > "$WORK/test/math.test.js" <<'FIXTURE'
import { test, expect } from "bun:test"
import { add, multiply, subtract, divide, modulo, power, clamp } from "../src/math.js"

test("add returns sum of two positive numbers", () => { expect(add(2, 3)).toBe(5) })
test("add handles negative numbers", () => { expect(add(-1, -1)).toBe(-2) })
test("add handles zero", () => { expect(add(0, 0)).toBe(0) })
test("multiply returns product", () => { expect(multiply(3, 4)).toBe(12) })
test("multiply handles zero", () => { expect(multiply(5, 0)).toBe(0) })
test("multiply handles negatives", () => { expect(multiply(-2, 3)).toBe(-6) })
test("subtract returns difference", () => { expect(subtract(10, 3)).toBe(7) })
test("subtract negative result", () => { expect(subtract(3, 10)).toBe(-7) })
test("subtract zeros", () => { expect(subtract(0, 0)).toBe(0) })
test("divide returns quotient", () => { expect(divide(10, 2)).toBe(5) })
test("divide throws on zero", () => { expect(() => divide(1, 0)).toThrow("division by zero") })
test("divide handles negatives", () => { expect(divide(-6, 3)).toBe(-2) })
test("modulo returns remainder", () => { expect(modulo(10, 3)).toBe(1) })
test("modulo throws on zero", () => { expect(() => modulo(1, 0)).toThrow("division by zero") })
test("modulo handles negatives", () => { expect(modulo(-7, 3)).toBe(-1) })
test("power returns exponentiation", () => { expect(power(2, 3)).toBe(8) })
test("power handles negative exponent", () => { expect(power(2, -1)).toBe(0.5) })
test("power handles zero exponent", () => { expect(power(5, 0)).toBe(1) })
test("clamp within range", () => { expect(clamp(5, 1, 10)).toBe(5) })
test("clamp below min", () => { expect(clamp(-5, 0, 10)).toBe(0) })
test("clamp throws when min exceeds max", () => { expect(() => clamp(5, 10, 1)).toThrow("min exceeds max") })
FIXTURE
  FIXTURE_OUT=$(cd "$WORK" && bun test 2>&1) || true
fi
if ! echo "$FIXTURE_OUT" | grep -qE '[[:space:]][1-9][0-9]* fail'; then
  echo "ABORT: fixture test runner did not produce a recognized failure summary"
  echo "output: $FIXTURE_OUT"
  exit 1
fi
cd "$HERE"

# Wait for the host to be USABLE, not for a guessed number of seconds.
#
# MEASURED on this machine: the v2 host renders its TUI in 3s, so the 4s this
# used to sleep was adequate — by a 1s margin, on a boot time that depends on
# the machine. That margin is the same assumption the v1 campaigns were making
# with 4s against a measured 13-16s, and a 1s margin fails the same way: the
# palette keystrokes that create the goal are sent once and never retried, so a
# slow boot means no goal, and the 40-poll below cannot help because it runs
# after the interaction that would have created it.
#
# The wait costs nothing when the host is already up, and it FAILS LOUDLY when
# the host never renders rather than driving a blank screen into assertions.
#
# FOR THE TUI'S OWN FOOTER, not for a byte count. The count was a proxy: any
# pane with 400 bytes in it passed, and before the TUI renders the pane holds
# the shell's echo of the command that starts it, which is text and not a TUI.
# The palette keystrokes are sent once and never retried, so a wait that
# passes on the echo loses them and the campaign drives a host that has not
# booted. The footer is the v2 TUI's own status line.
#
# The footer is drawn in several colours, so the raw capture holds the phrase
# in pieces. The colour codes come off before the match.
tui_rendered() {
  tmux capture-pane -p -e -t "$SESSION:0.0" 2>/dev/null | python3 -c '
import re, sys
text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", sys.stdin.read())
sys.exit(0 if "ctrl+p commands" in text else 1)
'
}
echo "== boot: wait for TUI + plugin init =="
BOOTED=""
for i in $(seq 1 60); do
  sleep 1
  if tui_rendered; then BOOTED="$i"; break; fi
done
if [ -z "$BOOTED" ]; then
  echo "FAIL: the host never rendered a TUI after 60s — the campaign cannot drive a blank screen"
  exit 1
fi
echo "     host rendered a TUI after ${BOOTED}s"
cap 01-boot

# THE BOOT CAPTURE IS TAKEN TWICE, and the reason is measured rather than guessed.
# The companion hydrates and briefs from the DISK LOOP, which starts after the
# workspace directory resolves — measured on a KEEP_STATE relaunch holding one
# paused goal: nothing at t+1s, "1 goal needs you: paused" in every capture from
# t+2.5s to t+6.5s, gone by t+7s. A capture taken the moment the TUI has bytes is
# therefore a capture of a window that is over before the briefing opens, and the
# briefing check below then reports a workspace that briefed as one that did not.
#
# So when the workspace HAS something to brief about, wait for the briefing rather
# than for the clock — the recorded rule, a fixed settle is a race wearing a
# duration. It is a bounded wait that fails LOUDLY rather than asserting against
# nothing, and it never overwrites a capture that already shows it.
resolve_state
BRIEF_WAIT=0
if [ -n "$STATE" ] && [ -f "$STATE" ]; then
  BRIEF_WAIT=$(count_needing_user)
fi
# "could not count" is an instrument failure, not "no goals waiting" — the
# count's fallback distinguishes the two so this check cannot SKIP on a
# broken import and read the breakage as the case not applying.
case "$BRIEF_WAIT" in
  ''|*[!0-9]*)
    echo "FAIL[L2-brief]: count_needing_user returned '${BRIEF_WAIT}' — the instrument cannot count, which is not the same as no goals waiting"
    FAIL=1
    ;;
esac
if [ "${BRIEF_WAIT:-0}" -gt 0 ] && ! grep -aqE "goals? need" "$CAP/01-boot.ansi"; then
  for _ in $(seq 1 20); do
    sleep 1
    tmux capture-pane -p -e -t "$SESSION:0.0" > "$CAP/01-boot.ansi"
    if grep -aqE "goals? need" "$CAP/01-boot.ansi"; then break; fi
  done
  echo "     boot capture waited for the briefing (workspace held ${BRIEF_WAIT} goal(s) needing you)"
fi
echo "== open palette & select Fixate: Add Goal =="
tmux send-keys -t "$SESSION:0.0" C-p
sleep 1
tmux send-keys -t "$SESSION:0.0" -l "fixate: add"
sleep 1
cap 02-palette-add
tmux send-keys -t "$SESSION:0.0" Enter
sleep 2

# prompt dialog -> objective
tmux send-keys -t "$SESSION:0.0" -l "execute SPEC.md exactly --pointer SPEC.md --max-turns 15 --max-tokens 5000000"
tmux send-keys -t "$SESSION:0.0" Enter
# Pin resolve_state to the session holding THIS campaign's goal (falls back to
# the newest file until the pin matches): the newest state file across all
# sessions can belong to a concurrent campaign — measured 2026-11-03,
# run 04:17:05Z-d09555f7 on the v1 host.
PIN_KEY="execute SPEC.md exactly"
echo "== waiting for goal creation (state.json active) =="
GOAL_SEEN=""
for i in $(seq 1 40); do
  sleep 2
  capture_frame
  resolve_state
  if [ -f "$STATE" ]; then
    st=$(bun -e 'const s=require(process.argv[1]);const gs=Array.isArray(s.goals)?s.goals:[];const g=gs[0];console.log(g?g.status||"":"no-goals")' "$STATE" 2>/dev/null || true)
    echo "poll $i status=$st"
    if [ "$st" = "active" ] || [ "$st" = "working" ] || [ "$st" = "running" ]; then GOAL_SEEN="$st"; break; fi
  fi
done
if [ -z "$GOAL_SEEN" ]; then
 # SAY WHICH. "No active goal observed" is what a broken product looks like,
 # and it is also what a session legitimately held by a LIVE process looks
 # like: the per-session lease declines the write rather than corrupting a
 # history someone else is still using. Observed on a real host — a second
 # campaign run against a workspace whose first host was still alive reported
 # exactly this, and the honest reading was the lease working.
  _live_owner=""
  for _lock in "$WORK"/.opencode/goals/sessions/*/state.json.lock/owner.json; do
    [ -f "$_lock" ] || continue
    _pid=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pid',''))" "$_lock" 2>/dev/null || true)
    [ -n "$_pid" ] || continue
    if kill -0 "$_pid" 2>/dev/null; then _live_owner="$_pid"; break; fi
  done
  if [ -n "$_live_owner" ]; then
    echo "FAIL: session state is held by LIVE process pid $_live_owner, so this host was declined the lease and wrote nothing."
    echo "      That is the intended behaviour — one writer per session. Relaunch the harness (it owns and kills its own"
    echo "      host) before running the campaign again; running drive.sh twice against one workspace is not a product failure."
  else
    echo "FAIL: no active goal observed in state.json after 40 polls, and no live process holds the session lease"
  fi
  snap 03-created
  exit 1
fi
snap 03-created
capture_frame

# NOTE: a toast is expected here — goal creation surfaces a
# "Goal started:" toast (L2 law, same as drive-f2.sh). One of the SAMPLED
# frames must contain "Goal started:".
#
# NOTE: a second goal, for a fresh toast — when a second goal
# is created while the first is still active, a NEW "Goal
# started:" toast surfaces for the second goal (not a repeat
# of the first). The ToastCoalescer keys per session|goalId
# so each goal gets its own start announcement.
# The v2 companion's CURATED TOAST. drive-f2.sh asserts the same moment on the
# v1 host (its L2), and the evidence that this works on v2 is the campaign's own
# capture — `04-after-add.ansi` carries a rendered toast panel reading
# `Fixate` / `Goal started: execute SPEC.`. But nothing ASSERTED it, so a
# regression in the v2 coalescer wiring would pass every campaign: the dashboard
# comes from the same companion and would keep working, and the toast would
# simply stop. That is precisely the class of gap this project keeps paying for.
#
# A missing observation is a FAILURE, not a warning — same rule as drive-f2.sh's
# L2, for the same reason: a gate that reports success because it did not see
# the thing is not a gate.
# The LOAD BRIEFING, asserted when the workspace can produce one. It summarises
# goals that are stopped and waiting, so it can only fire on a workspace that
# ALREADY holds such a goal when the host starts — and `launch.sh` wipes the
# workspace, which is why this was unobservable on the v2 host for as long as
# it was. `KEEP_STATE=1 bash launch.sh` now relaunches without the wipe, so a
# briefing run is possible; this check detects the situation rather than
# requiring a flag, because the honest thing when the workspace is empty is to
# say the case did not apply — not to pass, and not to fail.
#
# `filesRead`/goal count is read from the state the host has already loaded, so
# by the time the boot capture is taken the briefing has either rendered or not.
echo "== check the load briefing, when the workspace has something to brief about =="
resolve_state
WAITING=0
if [ -n "$STATE" ] && [ -f "$STATE" ]; then
 # DERIVED, NOT RESTATED — see resolve-state.sh, which is where the rule and its
 # measured history live. This check has now been wrong twice in two directions:
 # it once held a Python copy of the product's own predicate, and when that was
 # fixed it still asked the right question of the wrong SET (one session rather
 # than the workspace). Both reasons the count lives in one place rather than
 # here.
  WAITING=$(count_needing_user)
fi
if [ "${WAITING:-0}" -gt 0 ]; then
  if panel_regions "$CAP/01-boot.ansi" 'Fixate' | grep -aqE "goals? need"; then
    echo "PASS[L2-brief]: load briefing rendered for ${WAITING} stopped goal(s) (toast panel region)"
    panel_excerpt "$CAP/01-boot.ansi" 'Fixate' 'needs you' | grep -m1 -E "goals? need" | sed 's/^[[:space:]]*//' | cut -c1-70
  else
    echo "FAIL[L2-brief]: the workspace held ${WAITING} stopped goal(s) and the companion briefed none of them."
    echo "        The briefing is the one moment a user learns a goal is waiting on THEM; a silent regression is invisible."
    exit 1
  fi
elif [ "${WAITING:-}" = "?" ]; then
  echo "FAIL[L2-brief]: count_needing_user could not count — an instrument failure is not the case not applying."
  exit 1
else
  echo "SKIP[L2-brief]: the workspace held no stopped goals at boot, so there was nothing to brief about."
  echo "        To exercise it: KEEP_STATE=1 bash hack/e2e-harness/launch.sh  (after a run that leaves a goal paused)"
fi

echo "== check the curated lifecycle toast rendered =="
# READ THE SAMPLED FRAMES, not one frame taken at a moment of the campaign's
# choosing. Measured 2026-10-13: the companion's curated toast renders at about
# t+4s after the goal is created and is gone five seconds later, while the poll
# loop above only learns the goal is active two seconds after that. So the
# frame taken when the wait ended could already be past the toast, and the gate
# reported a toast that rendered as one that never rendered. The frames captured
# DURING the wait are the window in which the toast can appear; this reads all
# of them.
#
# Bounded, and it fails LOUDLY: the loop gives up and says so rather than
# asserting against a capture of nothing.
TOAST_FRAME=""
for _ in $(seq 1 20); do
  TOAST_FRAME="$(panel_first_frame "$CAP" "04-after-add-" 'Fixate' "Goal started:" || true)"
  [ -n "$TOAST_FRAME" ] && break
  sleep 1
  capture_frame
done
if [ -n "$TOAST_FRAME" ]; then
  echo "PASS[L2-v2]: curated 'Goal started:' toast rendered on the v2 companion (toast panel region)"
  panel_excerpt "$TOAST_FRAME" 'Fixate' 'Goal started:' | grep -a "Goal started:" | head -1 | sed 's/^[[:space:]]*//' | cut -c1-90
else
  echo "FAIL[L2-v2]: the v2 companion rendered no curated 'Goal started:' toast. The dashboard can keep"
  echo "        working while the toast silently dies, which is what this assertion exists to catch."
 # `exit 1`, not a FAIL flag: this script has no FAIL variable, and a flag
 # nothing reads is a gate that reports success while printing FAIL. That is the
 # exact defect this assertion was added to catch, so it must not commit it.
  exit 1
fi

echo "== open Fixate: Dashboard via palette =="
tmux send-keys -t "$SESSION:0.0" C-p
sleep 1
tmux send-keys -t "$SESSION:0.0" -l "fixate: dashboard"
sleep 1
cap 05-palette-dashboard
tmux send-keys -t "$SESSION:0.0" Enter
sleep 2
cap 06-dashboard-open

echo "== watch the DASHBOARD while the goal loop works =="
# 120 polls × 2s = 240s observation window. The free-tier model can take
# 60-90s per turn, so 60 polls (120s) only catches ~1 body change. Doubling
# the window gives slow models enough time to produce ≥2 observable updates.
PREV=""
LIVE=0
for i in $(seq 1 120); do
  sleep 2
  f="07-live-$(printf %02d $i)"
  cap "$f"
  if ! dash_body "$CAP/$f.ansi" > "$CAP/$f.body" 2>/dev/null; then
    echo "poll $i: dashboard not visible yet"; sleep 1; continue
  fi
  if [ -n "$PREV" ] && ! cmp -s "$CAP/$PREV.body" "$CAP/$f.body"; then
    LIVE=$((LIVE+1)); echo "LIVE: dashboard body changed at poll $i ($LIVE changes)"
  fi
  PREV="$f"
  if rg -qi 'progress|step|turn|token' "$CAP/$f.body" 2>/dev/null; then echo "poll $i: progress text visible in dashboard body"; fi
  if [ "$LIVE" -ge 2 ]; then echo "LIVE: two body changes observed while SAME dialog open -> live update demonstrated"; break; fi
done
snap 08-live-end

# The dashboard IS live if its body changed at least once while the dialog
# was open. The initial render is captured separately (06-dashboard-open), so
# any change in the 07-live sequence shows the dashboard updates in response
# to goal state changes. The free-tier model may produce few visible updates
# in a 240s window (slow responses, long thinking pauses), so >= 1 is the
# realistic threshold for live-update evidence.
if [ "$LIVE" -lt 1 ]; then
  echo "FAIL: no dashboard body change observed (need >= 1 for live-update evidence)"
  exit 1
fi
echo "LIVE: $LIVE dashboard body change(s) observed while dialog open -> live update demonstrated"

echo "== genuine close (Escape) =="
tmux send-keys -t "$SESSION:0.0" Escape
sleep 1
cap 09-closed

echo "== freeze evidence: render key ANSI captures to PNG =="
freeze_render 01-boot v2-01-boot
freeze_render 04-after-add v2-04-after-add
if [ -n "${TOAST_FRAME:-}" ] && [ -f "$TOAST_FRAME" ]; then
  freeze_render "$(basename "$TOAST_FRAME" .ansi)" v2-04-after-add-toast
fi
freeze_render 06-dashboard-open v2-06-dashboard-open
if [ -n "${PREV:-}" ] && [ -f "$CAP/$PREV.ansi" ]; then
  freeze_render "$PREV" v2-07-live-last
fi
freeze_render 09-closed v2-09-closed

echo "== done. captures in $CAP, freeze PNGs in $FREEZE_DIR =="
# sed, not head: this script runs under `set -euo pipefail`, and head exits
# the moment it has its 40 lines. The captures dir grows across runs (old
# numbered frames stay when a later run ends early), so ls output eventually
# overflows the pipe buffer, ls dies on SIGPIPE, and pipefail turns exit 141
# into a campaign FAILURE AFTER EVERY ASSERTION PASSED — measured 2026-10-09
# (runall4, 290 entries). sed reads the whole stream, and a real ls failure
# still surfaces through pipefail.
ls -la "$CAP" | sed -n '1,40p'
echo "--- freeze ---"
ls -la "$FREEZE_DIR" 2>/dev/null || echo "(no freeze output)"
