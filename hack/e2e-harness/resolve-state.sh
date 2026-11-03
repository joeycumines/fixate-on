#!/usr/bin/env bash
# resolve-state.sh — locate a work directory's goal state, wherever it lives.
#
# Sourced by the drive scripts, which define `WORK` before sourcing. Defines
# `STATE` as the path of the newest session's state file, or an empty string when
# the workspace has no state at all.
#
# WHY THIS EXISTS. Goal state is one file per SESSION now:
#
# $WORK/.opencode/goals/sessions/<sessionID>/state.json
#
# The drive scripts each hardcoded `$WORK/.opencode/goals/state.json` — a single
# workspace-wide file, which is exactly the file whose existence made an
# exclusive lock necessary and stopped a second OpenCode process from loading.
# With that path gone, every campaign in this harness failed on "no active goal
# observed" for a reason that had nothing to do with the product, and the
# repository's MANDATORY gate for product claims was blind. The path is resolved
# from the LAYOUT rather than restated, so the next layout change breaks here,
# loudly and in one place, instead of in three drive scripts.
#
# NEWEST BY mtime, not first-found: a campaign creates a goal in the session it
# is driving, and a work directory reused across campaigns can hold more than
# one session's state. The most recently written file is the live one.
#
# PIN_KEY OVERRIDE. Set PIN_KEY to a goalId or condition prefix BEFORE the
# campaign's state reads and resolve_state returns the session file that holds
# that goal, in goals OR in archived results (retention is 7 days, so a cleared
# goal keeps the pin). Measured 2026-11-03 (run 04:17:05Z-d09555f7): a late
# duplicate goal-command from an earlier campaign landed in THAT campaign's
# session while a later one ran, made its state.json the newest, and the
# newest-mtime rule handed the later campaign another session's
# focusedGoalIds — P2-focus failed on a focus the product had landed correctly.
# PINNED is set to 1 when the pin matched, so a campaign can assert its reads
# were pinned rather than falling back to the racy newest file.
set -u

if [ -z "${WORK:-}" ]; then
  echo "resolve-state.sh: source this AFTER setting WORK" >&2
  return 1 2>/dev/null || exit 1
fi
# The repository root, for the one call that reads the product's own code. Derived
# from this file's own location rather than passed, because a campaign step that
# has to configure it is a campaign step that can get it wrong.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A FUNCTION, not a one-shot assignment, and the first live run of this harness
# is why. The launcher wipes the work directory's `.opencode`, so at the moment
# this file is sourced there is no state to find; every campaign step then read
# an empty path and reported "NO STATE FILE" for a workspace whose goal was on
# disk the whole time. The path is resolved at each point of use, and a campaign
# step that runs after the goal is created sees it.
PIN_KEY=""
PINNED=""
resolve_state() {
  local sessions_dir="$WORK/.opencode/goals/sessions"
  STATE=""
  PINNED=""
  [ -d "$sessions_dir" ] || return 0
  if [ -n "$PIN_KEY" ]; then
    local d f
    for d in "$sessions_dir"/*/; do
      f="$d/state.json"
      [ -f "$f" ] || continue
      if python3 -c "
import json,sys
d=json.load(open('$f'))
for g in d.get('goals',[]) + d.get('results',[]):
    if g.get('goalId','').startswith('$PIN_KEY') or g.get('condition','').startswith('$PIN_KEY'): sys.exit(0)
sys.exit(1)" 2>/dev/null; then
        STATE="$f"
        PINNED=1
        return 0
      fi
    done
    # The pin matched nothing (goal not landed yet, or archived past
    # retention): fall through to the newest file rather than reading nothing.
  fi
 # `ls -t` puts the most recently modified entry first. `-A` keeps dot-entries
 # visible so a stray one cannot hide a real session — and the loop SKIPS
 # anything without a state file rather than taking the newest name and giving
 # up, because a lock or a temporary file sitting in that directory is exactly
 # when a campaign most needs its state found. Taking the first entry and
 # testing it only afterwards was the first version, and it resolved to nothing
 # at all whenever anything newer than a session was present.
  local candidate
  for candidate in $(ls -tA "$sessions_dir" 2>/dev/null); do
    if [ -f "$sessions_dir/$candidate/state.json" ]; then
      STATE="$sessions_dir/$candidate/state.json"
      return 0
    fi
  done
  unset candidate
  return 0
}

# Resolve once at source time so a script that only reads STATE still works,
# and export the function so the campaign steps can re-resolve.
resolve_state
export -f resolve_state 2>/dev/null || true
export STATE

# count_needing_user — how many goals in THIS WORKSPACE are stopped and waiting on
# the user, which is the load briefing's criterion.
#
# It is here, beside `resolve_state`, because both answers are about the workspace
# and a campaign step that needs one of them must not be holding its own copy of
# the other. It also exists because `drive.sh` grew two copies of this count within
# one commit, which is the shape of defect this harness keeps paying for.
#
# DERIVED FROM THE PRODUCT'S OWN PREDICATE. It was a Python reimplementation of
# `goalNeedsTheUser` — the self-resolving stop set and nothing else — so when
# 5526f4a made an OVERDUE yield briefable the copy had no notion of the promise
# clock, excluded every `user intervention` stop, and the campaign SKIPPED on
# exactly the goal class that commit had just made briefable. Measured on the tree
# before the change: 0 for a yield the companion briefs as "1 goal needs you: it
# did not pick your message back up".
#
# EVERY SESSION, not just the newest. `resolve_state` answers "which file is the
# live one", and the briefing is over the whole workspace, because a companion
# attaches to a workspace rather than to a conversation. Measured 2026-10-01: the
# newest session held a goal stopped `recovery` — correctly self-resolving, so
# `goalNeedsTheUser` false — while an older one held a goal stopped `paused`, and
# the companion rendered "1 goal needs you: paused" from the pair. A count over
# `$STATE` alone read 0 and SKIPped a workspace that had just briefed. Right rule,
# wrong inputs, which is the restatement's twin.
count_needing_user() {
  local repo="$HERE/../.."
  [ -d "$WORK" ] || { echo 0; return 0; }
  ( cd "$repo" && bun -e '
const { discoverStateFiles, parseStateFileGoals } = await import("./src/tui-disk-state.ts")
const { goalNeedsTheUser } = await import("./src/tui-toast-policy.ts")
const files = await discoverStateFiles(process.argv[1])
let n = 0
for (const f of files) {
  const sessionID = f.split("/sessions/")[1]?.split("/")[0]
  for (const g of parseStateFileGoals(await Bun.file(f).text(), sessionID)) {
    if (goalNeedsTheUser(g)) n += 1
  }
}
console.log(n)
' "$WORK" 2>/dev/null || echo "?" )
}
export -f count_needing_user 2>/dev/null || true

# fresh_host_session — put the campaign in a host session no earlier campaign used.
#
# MEASURED 2026-10-24 (run 23:04:34Z, the v1 host's own DB): all six v1 campaigns
# shared ONE host session, and the model's agent-channel goal-command duplicates
# can land minutes after the template that requested them — one clear dispatched
# by the hook at 23:05:27 executed at 23:07:59, past the dispatch guard's 60s
# window, and removed the NEXT campaign's 25-second-old goal; another, a no-op
# at the hook, executed ten seconds later after a goal had been created in
# between. A stale in-flight tool call is bound to the session whose context
# holds it, so a fresh session per campaign makes every late or replayed
# dispatch land in the campaign that issued it.
#
# The chord is the HOST'S OWN new-session key (<leader>n = ctrl+x then n;
# keybind.ts session_new -> the home route). The wait is for the HOME ROUTE'S
# OWN MARKER, measured live on the v1 host 2026-10-25: the home screen's empty
# prompt renders "Ask anything" and a session with message history does not.
# The placeholder text after it ROTATES (three entries cycle), so it is not
# the marker. A byte count cannot make the home/history distinction — both
# render >400 bytes — and a pane-hash diff is defeated by the footer's own
# animation. This gate fails loudly when the chord was lost, rather than
# letting the campaign drive the previous session's context.
fresh_host_session() {
  local session="${SESSION:-fixate-on}"
  tmux send-keys -t "$session:0.0" C-x
  sleep 0.5
  tmux send-keys -t "$session:0.0" n
  for _ in $(seq 1 20); do
    sleep 1
 # The marker is the home prompt's own "Ask anything…" — with the unicode
 # ellipsis the TUI renders. Plain "Ask anything" would also match an agent
 # transcript quoting the phrase; the ellipsis is the rendered form.
    if tmux capture-pane -p -t "$session:0.0" 2>/dev/null | grep -q "Ask anything…"; then
      return 0
    fi
  done
  echo "fresh_host_session: the home-route marker never appeared after <leader>n (waited 20s) — the campaign would drive a stale session" >&2
  return 1
}
export -f fresh_host_session 2>/dev/null || true

# assert_harness_unmodified — the harness must be able to tell when the thing it
# is scoring has rewritten it.
#
# MEASURED 2026-10-01, twice (`c0a62dd` is the first). The campaign's agent edited
# `verifier-working.sh` — this harness's OWN `verifierCommand`, the program the host
# then ran to decide COMPLETE or WORKING — while the campaign was asserting on the
# product. Nothing tripped, and the edit sat in a working tree one `git add -A`
# from a commit that would have shipped it as reviewed work. (The `verifierCommand`
# option itself was pruned on 2026-11-01: the plugin no longer runs any program to
# check a claim; the script is kept as the historical record of the incident.)
#
# A SELF-MODIFYING INSTRUMENT CANNOT TESTIFY ABOUT ITSELF. So the harness checks
# itself, before anything else runs, and fails loudly rather than proceeding: a
# campaign whose assertions were produced by an instrument the campaign edited has
# not tested anything.
#
# DERIVED FROM GIT rather than from a list of files, and deliberately: a
# hand-written list of harness files is the same defect as a hand-written list of
# things not to check, which this harness has already paid for once. `git status`
# also catches a NEW file, which a list cannot.
assert_harness_unmodified() {
  local repo="$HERE/../.."
  local dirty
 # Git itself missing is the check not running, not the check passing: a
 # campaign that attests its own integrity without git would report clean
 # against anything. Fail loudly instead (unreachable in practice — the
 # contract preflight needs the repo too — but the guard must not pass vacuously).
  command -v git >/dev/null 2>&1 || {
    echo "FAIL: assert_harness_unmodified cannot run — git is unavailable"
    return 1
  }
  dirty=$(cd "$repo" && git status --porcelain -- hack/e2e-harness 2>/dev/null \
    | grep -v '^.. hack/e2e-harness/\(work\|work-v1\|captures\|slots\|runs\|\.isolated-[^/]*\)/' || true)
  [ -n "$dirty" ] || return 0
  echo "FAIL: the harness tree is modified. The campaign's agent edits the code it is scored by —"
  echo "      measured 2026-10-01 on verifier-working.sh, the harness's own then-configured verifierCommand — and an"
  echo "      instrument that can be rewritten by its subject cannot testify about the subject."
  echo "$dirty" | sed 's/^/        /'
  echo "      Restore it (git checkout -- hack/e2e-harness) or commit the change deliberately"
  echo "      BEFORE running a campaign; an unreviewed edit here is a review finding, not evidence."
  return 1
}
export -f assert_harness_unmodified 2>/dev/null || true

# The campaign's key handling lives in one library: the drivers get
# write_auth_json (and OPENROUTER_API_KEY, when the caller set it) by sourcing
# provider-key.sh through this file.
. "$(dirname "${BASH_SOURCE[0]}")/provider-key.sh" 2>/dev/null || true
