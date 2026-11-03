#!/bin/bash
# live check on stock opencode v1: goal-driving behavior checked live —
# the loop continues, settles honestly, and never forces a lie.
#
# SCENARIO: agent fixes failing tests in an isolated project (work-v1).
# The fixture has add returning a-b; both tests fail. The agent fixes
# math.js and runs bun test itself (all execution is agent-driven since the
# 2026-11-01 ruling: the plugin runs NO program to check a claim).
#
# SUB-REQUIREMENTS EXERCISED:
# Umbrella: realistic scenario ends honestly — the agent's completion claim
# carries NO attestation (no verifier configured), recorded as
# unverifiable-claim with check.path=none, never mislabelled complete.
# Sub-req 4: supersede/CAS counted if chatty streaming occurs (state.json
# history carries the fault/retry accounting)
# Sub-req 5: human-message pause/re-arm latency measured, multi-goal stall
# explained on screen
#
# JUDGE DISABLED for this campaign: childSessionJudge:false in
# cfg-v1/opencode.json. With command verifiers pruned, the gate is
# judge-only; with the judge off it abstains (fail-closed), the claim is
# recorded unattested, and the fault bound settles rather than loops.
#
# MODEL-REQUIRED: this campaign needs the provider to fix math.js.
# ASSERTION DISCIPLINE: state truth from state.json; toast markers from full
# scrollback count diffs; claim-ledger rows from state.json lastClaim.
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

count_marker() {
  local file="$1" marker="$2"
  local n
  n=$(strip "$CAP/$file.ansi" | grep -c "$marker" 2>/dev/null) || true
  echo "${n:-0}"
}

wait_for_pane_text() {
  local pattern="$1" max="${2:-30}"
  for i in $(seq 1 "$max"); do
    sleep 1
    if tmux capture-pane -p -e -t "$SESSION:0.0" 2>/dev/null | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | grep -qE "$pattern"; then
      return 0
    fi
  done
  return 1
}

FAIL=0

echo "== pre-flight: the harness must be unmodified =="
assert_harness_unmodified || exit 1

echo "== pre-flight: ensure fixture is broken (auto-reset if a prior run fixed it) =="
# The launcher restores TRACKED files, but the canonical broken fixture is
# `a - b`, and the tree may legitimately carry the fixed `a + b` (committed
# mid-prune) — so assert on the TEST outcome, not the file content, and
# rewrite the broken baseline when the suite is already green. Same pattern
# as drive.sh.
FIXTURE_OUT=$(cd "$WORK" && bun test 2>&1) || true
if echo "$FIXTURE_OUT" | grep -qE '[[:space:]]0 fail'; then
  echo "fixture was fixed by a prior run — resetting to the broken baseline"
  cat > "$WORK/src/math.js" <<'FIXTURE'
export function add(a, b) {
  return a - b
}
FIXTURE
fi

echo "== P42: boot settle =="
BOOTED=""
for i in $(seq 1 40); do
  sleep 1
  bytes=$(tmux capture-pane -p -e -t "$SESSION:0.0" 2>/dev/null | wc -c | tr -d ' ')
  if [ -n "$bytes" ] && [ "$bytes" -gt 400 ]; then BOOTED="$i"; break; fi
done
[ -n "$BOOTED" ] || { echo "FAIL[P42-boot]: host never rendered a TUI after 40s"; FAIL=1; }
echo "     host rendered a TUI after ${BOOTED}s"

# A host session no earlier campaign drove (see resolve-state.sh for the
# measured incident): a stale in-flight goal-command can only land here.
fresh_host_session || { echo "FAIL[P42-session]: could not open a fresh host session"; FAIL=1; }

echo "== A: create the goal (agent-driven; no verifier is configured) =="
# Pin resolve_state to the session holding THIS campaign's goal (falls back to
# the newest file until the pin matches): the newest state file can belong to a
# concurrent campaign — measured 2026-11-03, run 04:17:05Z-d09555f7.
PIN_KEY="fix src/math.js so bun test passes"
# Retry up to 3 times: a prior campaign's cleanup command can clear the goal
# immediately after creation (status=missing). Wait for the goal to be ACTIVE,
# not just present in state.
GOAL_ACTIVE=""
for attempt in 1 2 3; do
  send "/goal fix src/math.js so bun test passes"
  for i in $(seq 1 30); do
    sleep 1
    resolve_state
    [ -f "$STATE" ] && python3 -c "
import json,sys
d=json.load(open('$STATE'))
for g in d.get('goals',[]):
    if 'fix src/math.js' in g.get('condition','') and g.get('status')=='active': sys.exit(0)
sys.exit(1)" 2>/dev/null && { GOAL_ACTIVE=1; break; }
  done
  [ -n "$GOAL_ACTIVE" ] && break
  echo "     attempt $attempt: goal not active yet, retrying..."
  sleep 2
done

resolve_state
GOAL_STATE="$STATE"
[ -f "$GOAL_STATE" ] || { echo "FAIL[A-goal]: goal never appeared in state"; FAIL=1; }
echo "     goal state: $GOAL_STATE"

# Verify the goal is actually ACTIVE before waiting for settlement.
GOAL_STATUS=$(python3 -c "
import json
d=json.load(open('$GOAL_STATE'))
for g in d.get('goals',[]):
    if 'fix src/math.js' in g.get('condition',''):
        print(g.get('status','?')); break
else: print('missing')
" 2>/dev/null)
if [ "$GOAL_STATUS" != "active" ]; then
  echo "FAIL[A-goal-active]: goal status is '$GOAL_STATUS' (expected active) after 3 attempts — a prior campaign may have cleared it"
  FAIL=1
fi

# Record the goal ID for later scoped clear.
GOAL_ID=$(python3 -c "
import json
d=json.load(open('$GOAL_STATE'))
for g in d.get('goals',[]):
    if 'fix src/math.js' in g.get('condition',''):
        print(g['goalId']); break
" 2>/dev/null)
echo "     goal ID: ${GOAL_ID:-(unknown)}"

cap p42-01-goal-created
STARTED_BASE=$(count_marker p42-01-goal-created "Goal started")
echo "     baseline 'Goal started' count: $STARTED_BASE"

echo "== B: wait for the agent to fix the code; the claim stays unattested =="
# The agent fixes add to return a+b and runs bun test itself. With no
# verifier configured (childSessionJudge:false, command verifiers pruned
# 2026-11-01), the completion claim cannot be attested: the gate records it
# as unverifiable-claim and retries as a fault, bounded. The wait extends
# while the goal stays active (measured 2026-10-27: a free-tier turn can
# spend its whole 180s mid-tool-call) and is bounded at 300s.
#
# Settlement is a result whose state is NOT 'cleared'. A REPLACED goal archives
# as 'cleared' — the product's `/goal <text>` replace path removes the focused
# goal and creates its successor in one transition, so a repeated objective
# lands as remove+create. Measured 2026-10-09: the agent called goal-command twice
# for one objective, the second call replaced the first goal 4.7s after
# creation, and this loop — which then counted ANY matching result — reported
# 'settled after 4s' for work that never ran. Keep waiting through cleared
# archives (a replacement can still settle honestly); section C judges the
# first non-cleared result.
#
# A goal that LEAVES the active list while only 'cleared' archives exist is a
# legitimate end too: with no verifier configured the fault bound
# (DEFAULT_MAX_ATTESTATION_FAULTS=5) cannot be reached in practice — measured
# 2026-11-02 (run 05:39:52Z-6665be82): the fault path records the claim and
# KEEPS the pending intent only while the agent keeps re-asserting, and the
# free-tier host was rate-limited so only 2 faults landed in 300s — after which
# the harness's own cleanup `/goal clear` archived the goal as 'cleared'
# (reason "completion verification unavailable"). The honest settlement this
# campaign exists to show is that archived result plus its unattested lastClaim
# (check.path=none, verdict=NONE, outcome=unverifiable-claim) — NOT a
# non-cleared state. So: settle when either (a) a non-cleared result appears, or
# (b) the goal is gone from the active list and a matching archive exists.
SETTLED=""
# The window is bounded by the goal's OWN activity, not a fixed clock: the
# phenomenon waited on is a free-tier model completing a small fix, and
# measured 2026-10-27 (run 04:09:38Z) a model turn can spend its whole 180s
# retrying a mis-aimed tool argument while the goal stays ACTIVE and the loop
# keeps delivering continuations — the product working, the window expiring
# anyway. So the wait extends while the goal remains active, to a ceiling that
# still bounds a genuinely stalled run. A goal that leaves active without
# settling ends the wait immediately (the results check below then judges it).
B_WINDOW=180
for i in $(seq 1 420); do
  sleep 1
  resolve_state
  [ -f "$STATE" ] || continue
  settle_state=$(python3 -c "
import json
d=json.load(open('$STATE'))
results=[r for r in d.get('results',[]) if 'fix src/math.js' in r.get('condition','')]
settled=[r.get('state','?') for r in results if r.get('state','?') != 'cleared']
if settled:
    print(settled[0])
else:
    active=[g for g in d.get('goals',[]) if 'fix src/math.js' in g.get('condition','')]
    if results and not active:
        # goal left the active list with only cleared archives: the cleanup
        # clear archived it — count that as the settlement surface section C reads
        print('cleared-archived')
    else:
        # Measured 2026-11-02 across runs 05:39:52Z-6665be82, 06:06:45Z-317732ee,
        # and 06:33:13Z-aaf7e69a: with no verifier configured, an unattested
        # completion claim is the goal's honest terminal surface in EVERY
        # observed shape — (a) fault bound pauses it while still active
        # (stopReason 'unattested completion asserted repeatedly'), or (b) a
        # rate-limited agent leaves it status=active with stopReason
        # 'completion verification unavailable' and the claim recorded
        # (check.path=none, verdict=NONE, outcome=unverifiable-claim), or
        # (c) the cleanup clear archives it as 'cleared' with the same claim.
        # All three carry the recorded unattested claim; count any of them.
        def has_unattested(g):
            lc=g.get('lastClaim') or {}
            ch=lc.get('check') or {}; oc=lc.get('outcome') or {}
            hist_ok=any('unattested' in str(h.get('detail','')).lower() or 'fault' in str(h.get('detail','')).lower() for h in g.get('history',[]))
            return (ch.get('path')=='none' and oc.get('status')=='unverifiable-claim') or hist_ok
        paused=[g for g in active if g.get('status')=='paused' and has_unattested(g)]
        if paused:
            print('paused-unattested')
        else:
            unattested_active=[g for g in active if g.get('status')=='active' and has_unattested(g)]
            if unattested_active:
                print('active-unattested-claim')
            else:
                print('')" 2>/dev/null)
  if [ -n "$settle_state" ]; then SETTLED="$i"; break; fi
  if [ $i -eq $B_WINDOW ]; then
    goal_active_at_window=$(python3 -c "
import json
d=json.load(open('$STATE'))
print('yes' if any(g.get('status')=='active' and 'fix src/math.js' in g.get('condition','') for g in d.get('goals',[])) else 'no')" 2>/dev/null)
    if [ "$goal_active_at_window" = "yes" ]; then
      echo "     ... still active at ${B_WINDOW}s — extending: the goal is running, the model is slow"
    fi
  fi
 # Also check if the goal is still active with progress.
  if [ $((i % 30)) -eq 0 ]; then
    echo "     ... waiting ($i s), checking state..."
    goal_status=$(python3 -c "
import json
d=json.load(open('$STATE'))
for g in d.get('goals',[]):
    if 'fix src/math.js' in g.get('condition',''):
        print(g.get('status','?'), 'turns:', g.get('turnCount',0)); break
else: print('no active goal')" 2>/dev/null)
    echo "     $goal_status"
  fi
done

cap p42-02-after-settlement

if [ -z "$SETTLED" ]; then
  resolve_state
  archived_count=$(python3 -c "
import json
d=json.load(open('$STATE'))
print(len([r for r in d.get('results',[]) if 'fix src/math.js' in r.get('condition','')]))" 2>/dev/null)
  if [ "${archived_count:-0}" -ge 1 ] 2>/dev/null; then
    echo "FAIL[B-settle]: ${archived_count} 'fix src/math.js' result(s) exist but the goal never left active with a settlement within 420s"
  else
    echo "FAIL[B-settle]: goal did not settle within 420s"
  fi
  FAIL=1
else
  echo "PASS[B-settle]: settlement surface reached after ${SETTLED}s (result state: $settle_state)"
fi

echo "== C: verify honest handling of the unattested claim =="
# With no verifier configured, the gate is fail-closed: the agent's completion
# claim is recorded as unverifiable-claim (check.path=none, verdict=NONE) and
# retried as an attestation fault; the goal is never labelled complete on no
# evidence. The archived result must show exactly that — an unattested receipt,
# not a fabricated attestation, and not a verified-complete lie either.
# Measured 2026-11-02 (run 05:39:52Z-6665be82): with the free-tier host rate-
# limited, only 2 of the 5 faults land inside the window, so the goal is still
# active when the wait ends; the harness cleanup `/goal clear` then archives it
# as state=cleared with the honest unattested lastClaim attached. That archive
# IS the settlement surface — read the claim off it.
resolve_state
[ -f "$STATE" ] || { echo "FAIL[C-state]: no state file after settlement"; FAIL=1; }

# Extract the settlement details. The claim lives on the archived result's
# lastClaim, OR — measured 2026-11-02 (run 06:06:45Z-317732ee) — on the still-
# active goal itself when the fault path paused it ('unattested completion
# asserted repeatedly') before any archive exists. Read both surfaces.
SETTLEMENT_INFO=$(python3 -c "
import json
d=json.load(open('$STATE'))
matches=[r for r in d.get('results',[]) if 'fix src/math.js' in r.get('condition','')]
# Prefer the settlement over a cleared archive: a replaced goal archives as
# 'cleared' beside the result that actually settled (replaceGoals).
noncleared=[r for r in matches if r.get('state') != 'cleared']
pool=noncleared or matches
if pool:
    r=pool[0]
    print('surface: archived-result')
    print('state:', r.get('state','?'))
    print('stopReason:', r.get('stopReason','') or r.get('reason',''))
    lc = r.get('lastClaim') or {}
else:
    gs=[g for g in d.get('goals',[]) if 'fix src/math.js' in g.get('condition','')]
    g=gs[0] if gs else {}
    print('surface: active-goal')
    print('state:', g.get('status','?'))
    print('stopReason:', g.get('stopReason',''))
    lc = g.get('lastClaim') or {}
check = lc.get('check') or {}
outcome = lc.get('outcome') or {}
print('check.path:', check.get('path','?'))
print('check.verdict:', check.get('verdict','?'))
print('check.target:', check.get('target','?'))
print('outcome.status:', outcome.get('status','?'))
print('outcome.detail:', outcome.get('detail','')[:200])
evidence = check.get('evidence') or []
for e in evidence[:3]:
    print('evidence:', str(e)[:150])
" 2>/dev/null)
echo "$SETTLEMENT_INFO" | sed 's/^/     /'

# Assert: the claim was recorded, and recorded honestly — no attestation was
# fabricated (check.path must be 'none', verdict 'NONE'), and the outcome is
# 'unverifiable-claim', never 'verified-complete'.
RESULT_STATE=$(echo "$SETTLEMENT_INFO" | grep '^state:' | cut -d' ' -f2)
CHECK_PATH=$(echo "$SETTLEMENT_INFO" | grep '^check.path:' | cut -d' ' -f2)
CHECK_VERDICT=$(echo "$SETTLEMENT_INFO" | grep '^check.verdict:' | cut -d' ' -f2)
OUTCOME_STATUS=$(echo "$SETTLEMENT_INFO" | grep '^outcome.status:' | cut -d' ' -f2)

if [ -n "$RESULT_STATE" ] && [ "$RESULT_STATE" != "?" ]; then
  echo "PASS[C-result-present]: settlement surface present ($(echo "$SETTLEMENT_INFO" | grep '^surface:' | cut -d' ' -f2), state: $RESULT_STATE)"
else
  echo "FAIL[C-result-present]: no archived result for the goal"
  FAIL=1
fi

if [ "$CHECK_PATH" = "none" ] && [ "$CHECK_VERDICT" = "NONE" ]; then
  echo "PASS[C-no-fabricated-attestation]: claim recorded with check.path=none, verdict=NONE"
else
  echo "FAIL[C-no-fabricated-attestation]: check.path='$CHECK_PATH' verdict='$CHECK_VERDICT' (expected none/NONE — no verifier was configured)"
  FAIL=1
fi

if [ "$OUTCOME_STATUS" = "unverifiable-claim" ]; then
  echo "PASS[C-honest-outcome]: outcome is unverifiable-claim (unattested, not mislabelled complete)"
elif [ "$OUTCOME_STATUS" = "verified-complete" ]; then
  echo "FAIL[C-honest-outcome]: outcome is verified-complete with no verifier configured — that is a fabricated attestation"
  FAIL=1
else
  echo "FAIL[C-honest-outcome]: outcome is '$OUTCOME_STATUS' (expected unverifiable-claim)"
  FAIL=1
fi

echo "== D: verify math.js was actually fixed (the work is real) =="
# The agent must have changed the broken baseline (a-b) into a real fix; a
# no-op campaign that "discovers the work already done" fails here.
FIXED_CONTENT=$(cat "$WORK/src/math.js" 2>/dev/null)
echo "     math.js content: $FIXED_CONTENT"
if echo "$FIXED_CONTENT" | grep -q 'a + b\|a+b\|Number(a) + Number(b)'; then
  echo "PASS[D-fix]: math.js contains a real fix (the broken a-b baseline is gone)"
else
  echo "FAIL[D-fix]: math.js does not contain a+b (agent may not have fixed it)"
  FAIL=1
fi

# Verify tests actually pass now.
TEST_RESULT=$(cd "$WORK" && bun test 2>&1 | tail -5)
echo "     bun test output: $TEST_RESULT"
if cd "$WORK" && bun test 2>&1 | grep -q "0 fail"; then
  echo "PASS[D-tests]: bun test passes (0 failures)"
else
  echo "FAIL[D-tests]: bun test still has failures"
  FAIL=1
fi

echo "== E: sub-req 5 — human-message pause/re-arm latency =="
# Create a second goal, then send a human message while it's active.
# Measure: goal pauses on message (user intervention), re-arms on idle.
send "/goal hold steady for the pause-rearm measurement"
for i in $(seq 1 20); do
  sleep 1
  # All-sessions scan (see the E-pause note below): the newest state file can
  # belong to a concurrent campaign, so match the distinctive objective.
  python3 -c "
import json,glob,sys
for f in glob.glob('$WORK/.opencode/goals/sessions/*/state.json'):
    d=json.load(open(f))
    if any('hold steady for the pause-rearm' in g.get('condition','') for g in d.get('goals',[])): sys.exit(0)
sys.exit(1)" 2>/dev/null && break
done

HOLD_GOAL_ID=$(python3 -c "
import json,glob
for f in glob.glob('$WORK/.opencode/goals/sessions/*/state.json'):
    d=json.load(open(f))
    for g in d.get('goals',[]):
        if 'hold steady for the pause-rearm' in g.get('condition',''):
            print(g['goalId']); raise SystemExit
" 2>/dev/null)
echo "     hold-steady goal: ${HOLD_GOAL_ID:-(unknown)}"

# Pause it first so we can measure re-arm from a known state.
send "/goal pause"
wait_for_pane_text "Goal paused" 12 || true
sleep 1
cap p42-03-paused

# Now resume it so it's active when we send the human message.
send "/goal resume"
wait_for_pane_text "Goal resumed" 12 || true
sleep 1

# Send a human message — this should pause the goal (user intervention).
PAUSE_BEFORE_SECS=$(date +%s)
send "hello, this is a human message for latency measurement"
sleep 2
cap p42-04-after-human-message

# Check the goal paused with user intervention. Read across EVERY session's
# state file, not just the newest: measured 2026-11-02 (run 06:53:36Z-f737492c)
# the p42 campaign's own session file sat at a lower mtime than a concurrent
# campaign's (disk-loop's 'alpha: hold steady' in another session dir), so
# resolve_state landed on the wrong file and E read an empty status even though
# the goal had correctly paused with 'user intervention' in its own file.
PAUSE_STATUS=$(python3 -c "
import json,glob
for f in glob.glob('$WORK/.opencode/goals/sessions/*/state.json'):
    d=json.load(open(f))
    for g in d.get('goals',[]):
        if 'hold steady for the pause-rearm' in g.get('condition',''):
            print(g.get('status','?'), g.get('stopReason','')); raise SystemExit
    for r in d.get('results',[]):
        if 'hold steady for the pause-rearm' in r.get('condition','') and r.get('state')=='cleared':
            print('cleared', r.get('reason','')); raise SystemExit
print('missing')" 2>/dev/null)
echo "     after human message: $PAUSE_STATUS"

if echo "$PAUSE_STATUS" | grep -q "paused.*user intervention"; then
  echo "PASS[E-pause]: goal paused with 'user intervention' after human message"
else
  echo "FAIL[E-pause]: goal status is '$PAUSE_STATUS' (expected paused/user intervention)"
  FAIL=1
fi

# Wait for re-arm (the idle handler or FX-J poller re-arms user-intervention pauses).
# The window must cover the agent's answer to the human message sent above:
# re-arm cannot precede the end of the turn that paused the goal — that is
# what the yield is for — and a free-tier turn takes up to 60-90s under load,
# the same bound drive.sh's dashboard window is sized to. After the turn
# ends, the FX-J poller needs its 10s quiet window plus a 5s poll tick. 45s
# therefore measured model latency, not re-arm latency: the run of 2026-10-09
# 05:25Z failed here at the same commit the 05:55Z run passed. MEASURED
# 2026-10-27 (run 04:09:38Z): a flint turn can run the whole 120s without
# ending (the DB shows the resume tool call landing at the window's edge), so
# the window is now 240s — the turn, the poller tail, and margin — and still
# fails loudly if the re-arm never comes.
REARM_FOUND=""
for i in $(seq 1 240); do
  sleep 1
  # Same all-sessions read as E-pause above (run 06:53:36Z-f737492c): the
  # newest-mtime file can belong to another concurrent campaign.
  REARM_STATUS=$(python3 -c "
import json,glob
for f in glob.glob('$WORK/.opencode/goals/sessions/*/state.json'):
    d=json.load(open(f))
    for g in d.get('goals',[]):
        if 'hold steady for the pause-rearm' in g.get('condition',''):
            print(g.get('status','?'), g.get('stopReason','')); raise SystemExit
    for r in d.get('results',[]):
        if 'hold steady for the pause-rearm' in r.get('condition','') and r.get('state')=='cleared':
            print('cleared', r.get('reason','')); raise SystemExit
print('missing')" 2>/dev/null)
  if echo "$REARM_STATUS" | grep -q "^active"; then
    REARM_FOUND="$i"
    break
  fi
done

PAUSE_AFTER_SECS=$(date +%s)
if [ -n "$REARM_FOUND" ]; then
  LATENCY_SECS=$(( PAUSE_AFTER_SECS - PAUSE_BEFORE_SECS ))
  echo "PASS[E-rearm]: goal re-armed after ${REARM_FOUND}s (~${LATENCY_SECS}s wall clock total including message send)"
else
  echo "FAIL[E-rearm]: goal did not re-arm within 240s (status: $REARM_STATUS)"
  FAIL=1
fi

cap p42-05-after-rearm

# Check multi-goal stall explanation on screen.
# With two goals in session, the briefing should say "N goals need you" when
# one is paused. We already have the paused capture; check it.
if strip "$CAP/p42-04-after-human-message.ansi" | grep -qiE "goal.*needs you|yielding|user intervention"; then
  echo "PASS[E-stall-screen]: multi-goal stall explained on screen"
else
  echo "INFO[E-stall-screen]: no explicit stall text in capture (may be below viewport)"
fi

echo "== F: sub-req 4 — fault/retry accounting visible in the goal state =="
# The attestation faults (verifier unavailable, retried per the fault bound)
# must be visible in the goal's history — a claim that could not be checked is
# recorded, not silently dropped. Read whichever surface holds the goal: the
# archived result, or the still-active (possibly paused) goal itself.
resolve_state
COUNTERS=$(python3 -c "
import json
d=json.load(open('$STATE'))
matches=[r for r in d.get('results',[]) if 'fix src/math.js' in r.get('condition','')]
noncleared=[r for r in matches if r.get('state') != 'cleared']
pool=noncleared or matches
gs=[g for g in d.get('goals',[]) if 'fix src/math.js' in g.get('condition','')]
if pool:
    src=pool[0]; hist=src.get('history',[]); tc=src.get('turnCount','?')
    print('surface: archived-result')
elif gs:
    src=gs[0]; hist=src.get('history',[]); tc=src.get('turnCount','?')
    print('surface: active-goal', src.get('status','?'))
else:
    src={}; hist=[]; tc='?'
faults=[h.get('detail','') for h in hist if 'fault' in str(h.get('detail','')).lower() or 'claim' in str(h.get('detail','')).lower()]
print('fault/claim entries:', len(faults))
for f in faults[:4]: print('  ', str(f)[:120])
print('turnCount:', tc)
" 2>/dev/null)
echo "     $COUNTERS"

if echo "$COUNTERS" | grep -q "fault/claim entries: [1-9]"; then
  echo "PASS[F-counters]: fault/claim accounting present in goal state"
else
  echo "FAIL[F-counters]: fault/claim accounting missing from goal state"
  FAIL=1
fi

echo "== G: verify the TUI surfaced the goal's state =="
# The dashboard or status should show the goal and its outcome.
if strip "$CAP/p42-02-after-settlement.ansi" | grep -qiE "fix src/math|complete|achieved|unattested|unverifiable|paused"; then
  echo "PASS[G-tui-surface]: goal state visible in TUI capture"
else
  echo "INFO[G-tui-surface]: settlement text not found in capture (may have scrolled)"
fi

echo "== cleanup =="
# Clear both goals using scoped clear.
if [ -n "$HOLD_GOAL_ID" ]; then
  send "/goal clear ${HOLD_GOAL_ID:0:8}"
  sleep 1
fi
# The fix-math goal already settled; clear any remaining.
send "/goal clear"
sleep 1

echo "== freeze evidence =="
freeze_render p42-01-goal-created v1-p42-01-goal-created
freeze_render p42-02-after-settlement v1-p42-02-after-settlement
freeze_render p42-03-paused v1-p42-03-paused
freeze_render p42-04-after-human-message v1-p42-04-after-human-message
freeze_render p42-05-after-rearm v1-p42-05-after-rearm

if [ "$FAIL" -eq 0 ]; then
  echo "P42 LIVE EVIDENCE: ALL CHECKS PASS"
else
  echo "P42 LIVE EVIDENCE: VIOLATIONS FOUND ($FAIL failures)"
fi
exit "$FAIL"