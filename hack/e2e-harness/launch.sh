#!/bin/bash
# Fully isolated v2 full-TUI launcher for the E2E harness.
#
# ISOLATION CONTRACT: this harness uses its OWN
# dedicated XDG directories. ZERO inheritance from the user's real
# ~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode, or any
# shell aliases. opencode resolves these paths in packages/util/src/global.ts:
# data = XDG_DATA_HOME/opencode (credential DB, repos, logs)
# state = XDG_STATE_HOME/opencode (flocks, service configs)
# config = XDG_CONFIG_HOME/opencode (Global layer fallback; OPENCODE_CONFIG_DIR overrides)
# cache = XDG_CACHE_HOME/opencode (bin, cached artifacts)
# Overriding OPENCODE_CONFIG_DIR alone is NOT isolation: the TUI still reads
# last-used model/session from the shared data DB (that produced the
# 'Muse Spark 1.2 Free' leak).
#
# SECURITY CONTRACT: the harness stores, reads, and prints ZERO credentials.
# The provider key comes from the caller's environment or the local OpenCode
# credential store (resolved by provider-key.sh) and is passed into the tmux
# session environment only. No tracked file contains a secret; cfg/opencode.json
# declares the provider via `env: ["OPENROUTER_API_KEY"]` with no apiKey.
#
# --standalone is REQUIRED: without it the client joins the user's long-lived
# background service (keyed by channel, pristine config) and the overlay does
# nothing. With --standalone the client spawns its own `serve --stdio` child
# with extendEnv=true, inheriting ALL isolation vars below.
#
# Usage: bash hack/e2e-harness/launch.sh
# Produces: $OPENCODE2_BIN --standalone in the tmux session named by $SESSION, pane 0.
set -euo pipefail

SESSION="fixate-on"
# Host launcher override: installed opencode2 v2.0.27 loads the TUI plugin but
# never registers its palette entries; the fix lives in a local source checkout
# (hack/e2e-harness/opencode2-from-source.sh runs it).
OPENCODE2_BIN="${E2E_OPENCODE2_BIN:-opencode2}"
case "$OPENCODE2_BIN" in
 */*) [ -x "$OPENCODE2_BIN" ] || { echo "abort: E2E_OPENCODE2_BIN=$OPENCODE2_BIN is not executable" >&2; exit 1; };;
esac
BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_DIR="$BUNDLE_DIR/hack/e2e-harness"
CFG_DIR="$HARNESS_DIR/cfg"
WORK_DIR="$HARNESS_DIR/work"
ISOLATED_ROOT="$HARNESS_DIR/.isolated-v2"

[ -f "$CFG_DIR/opencode.json" ] || { echo "abort: $CFG_DIR/opencode.json missing" >&2; exit 1; }
[ -f "$CFG_DIR/cli.json" ]     || { echo "abort: $CFG_DIR/cli.json missing" >&2; exit 1; }
[ -f "$BUNDLE_DIR/plugin/fixate-on/plugin.js" ] || {
  echo "abort: generated bundle missing — run 'bun run bundle' in $BUNDLE_DIR first" >&2; exit 1
}

# Preflight: the plugin-dir adapters import generated bundles from plugin/.
# They live in plugin/ which is.gitignored — run 'bun run bundle' first.
# The CURRENT layout only, and the stale flat names are REFUSED rather than
# merely unused: a leftover pre-outdir build in plugin/ would otherwise satisfy
# a weaker check and the campaign would run against a month-old plugin.
for _stale in fixate-on.js fixate-on-tui.js fixate-on-tui-v2.js; do
  [ -e "$BUNDLE_DIR/plugin/$_stale" ] && { echo "abort: stale plugin/$_stale present — a pre-outdir build; delete it so it can never be loaded" >&2; exit 1; }
done
unset _stale

# Fresh dedicated XDG tree. rm -rf is scoped to THIS harness-owned directory only.
rm -rf "$ISOLATED_ROOT"
mkdir -p "$ISOLATED_ROOT/data" "$ISOLATED_ROOT/state" "$ISOLATED_ROOT/config" "$ISOLATED_ROOT/cache"

# Mirror config into the isolated config dir so the Global layer fallback
# (XDG_CONFIG_HOME/opencode) is consistent even if OPENCODE_CONFIG_DIR is bypassed.
sed -e "s|__BUNDLE_DIR__|$BUNDLE_DIR|g" -e "s|__WORK_DIR__|$WORK_DIR|g" "$CFG_DIR/opencode.json" > "$ISOLATED_ROOT/config/opencode.json"
sed -e "s|__BUNDLE_DIR__|$BUNDLE_DIR|g" -e "s|__WORK_DIR__|$WORK_DIR|g" "$CFG_DIR/cli.json" > "$ISOLATED_ROOT/config/cli.json"

# The TUI's NEW-SESSION model, pinned to the configured one. Measured 2026-10-22:
# the v2 TUI resolves the model for a new session from the FIRST agent in the
# server's list, and the built-in agents carry no model, so the TUI fell through
# to the first model in the provider catalogue — "Flint (free)" on one run and
# "Muse Wonder" on the next. The campaign's own session is created by the plugin,
# which resolves the CONFIGURED default agent and so the configured model, and
# the host DB confirms the campaign ran on the harness model; this pins the
# TUI's own default to the same one, so what the pane shows and what the
# campaign runs are the same model.
#
# The model is read from the config rather than written here: a second copy of
# the model string is a second thing to keep correct.
mkdir -p "$ISOLATED_ROOT/state/opencode"
MODEL_REF="$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model)' "$CFG_DIR/opencode.json")"
bun -e '
  const fs = require("fs")
  const [ref, out] = process.argv.slice(1)
  const slash = ref.indexOf("/")
  fs.writeFileSync(out, JSON.stringify({
    recent: [{ providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }],
    favorite: [],
    variant: {},
  }, null, 2) + "\n")
' "$MODEL_REF" "$ISOLATED_ROOT/state/opencode/model.json"
if [ -d "$CFG_DIR/agents" ]; then
  mkdir -p "$ISOLATED_ROOT/config/agents"
  cp "$CFG_DIR"/agents/*.md "$ISOLATED_ROOT/config/agents/" 2>/dev/null || true
fi

# Fresh work fixture state. Two kinds of drift accumulate across campaigns and
# both corrupt the NEXT one: goal locks/state from prior runs, and the agent's
# own edits (it is supposed to fix the fixture, so after a successful campaign
# the broken baseline is gone and a later run "discovers the work already
# done"). Reset BOTH so every campaign starts from the canonical fixture.
#
# KEEP_STATE=1 skips the state reset, and exists for exactly one thing: behaviour
# that can only be observed when the workspace ALREADY holds goal state when the
# host starts. The load briefing is the case in point — it summarises
# goals that are stopped and waiting, so a freshly wiped workspace has nothing to
# brief about, and the only setup that loads the v2 companion is this script.
# Without the escape hatch those two requirements are mutually exclusive and the
# behaviour is unobservable on that host.
#
# It is opt-in and loud, because a campaign run with state carried over is NOT
# the canonical fixture and its captures are not comparable with a clean run.
if [ "${KEEP_STATE:-0}" = "1" ]; then
  echo "launch: KEEP_STATE=1 — goal state in $WORK_DIR/.opencode is being PRESERVED; this run is not the canonical fixture"
else
  rm -rf "$WORK_DIR/.opencode"
fi
mkdir -p "$WORK_DIR"
git -C "$BUNDLE_DIR" checkout -- "${WORK_DIR#$BUNDLE_DIR/}" 2>/dev/null || true
git -C "$BUNDLE_DIR" clean -fdq "${WORK_DIR#$BUNDLE_DIR/}" 2>/dev/null || true

# Deterministic briefing seed.: "briefing passes without
# manual KEEP_STATE hack." The load briefing only renders when the workspace
# ALREADY holds a stopped-and-waiting goal at host boot. This writes one
# deterministically, replacing the non-deterministic KEEP_STATE=1 escape hatch.
bash "$HARNESS_DIR/seed-briefing.sh" "$WORK_DIR"

# Point at the SUBSTITUTED copies in the isolated tree — $CFG_DIR still holds
# the __BUNDLE_DIR__ placeholders, and the host dies parsing them as file URLs.
export OPENCODE_CONFIG="$ISOLATED_ROOT/config/opencode.json"
export OPENCODE_CONFIG_DIR="$ISOLATED_ROOT/config"

# A named tmux session we own; never attached to another's state (reversibility).
tmux kill-session -t "$SESSION" 2>/dev/null || true

# tmux panes are separate shells and do NOT inherit this script's exported
# vars — pass every isolation var with -e. Explicitly clear any inherited
# OpenCode config/credential overrides from the caller's environment so the
# dedicated XDG tree is the sole configuration source ("ZERO inheritance").
TMUX_ENV=(
  -e "OPENCODE_CONFIG=$ISOLATED_ROOT/config/opencode.json"
  -e "OPENCODE_CONFIG_DIR=$ISOLATED_ROOT/config"
  -e "XDG_DATA_HOME=$ISOLATED_ROOT/data"
  -e "XDG_STATE_HOME=$ISOLATED_ROOT/state"
  -e "XDG_CONFIG_HOME=$ISOLATED_ROOT/config"
  -e "XDG_CACHE_HOME=$ISOLATED_ROOT/cache"
  -e "OPENCODE_TUI_CONFIG="
  -e "OPENCODE_SERVER_PASSWORD="
  -e "SHAPER_PROVIDER_DIALAGRAM_API_KEY="
  -e "SHAPER_PROVIDER_YOLO_API_KEY="
  -e "SHAPER_PROVIDER_CAMEL_API_KEY="
  -e "SHAPER_PROVIDER_VERBOO_API_KEY="
  -e "SHAPER_PROVIDER_ELECTRONHUB_API_KEY="
  -e "SHAPER_PROVIDER_UMANS_API_KEY="
  -e "SHAPER_PROVIDER_OPENCODE_API_KEY="
)

# Optional instrumentation passthrough (event-delivery evidence).
if [ -n "${FIXATE_ON_EVENT_LOG:-}" ]; then
  TMUX_ENV+=(-e "FIXATE_ON_EVENT_LOG=$FIXATE_ON_EVENT_LOG")
fi

# Provider credential passthrough. The caller supplies the key in its own
# environment, or the local OpenCode credential store does; either way it is
# forwarded to the tmux session env and never written to a file or echoed.
# Absence is reported as a warning, not a failure — a campaign launched without
# it will fail loudly at the first model call.
. "$HARNESS_DIR/provider-key.sh" || true
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  TMUX_ENV+=(-e "OPENROUTER_API_KEY=$OPENROUTER_API_KEY")
else
  echo "warn: no provider key — export OPENROUTER_API_KEY or store an openrouter key in the local OpenCode credential store" >&2
fi

# -x 200 -y 50 matches launch-v1.sh. A default 80x24 detached session splits to a
# 40x24 pane, and with two goals on screen the active goal's live-updating fields
# (Status/Tokens/Turns) fall below the dashboard's visible fold — the 2026-10-09
# dashboard-live run polled 120 frames of a static visible region while the ledger
# showed the goal was active and spending tokens. The camera must be tall enough to
# see what it asserts on.
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORK_DIR" "${TMUX_ENV[@]}"
sleep 2  # shell must be ready before send-keys; without this the exec line is lost

# Pane 0 = FULL TUI with the plugin (server + v2 companion) against cfg/.
# Isolation enforcement: unset config overrides NOT explicitly set via -e above.
tmux send-keys -t "$SESSION:0" -l "unset OPENCODE_TUI_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_SERVER_PASSWORD; exec '$OPENCODE2_BIN' --standalone '$WORK_DIR'"
sleep 0.3
tmux send-keys -t "$SESSION:0" Enter

# Pane 1: helper shell for inspecting state.json / captures.
tmux split-window -t "$SESSION:0" -h
tmux send-keys -t "$SESSION:0.1" -l "cd '$HARNESS_DIR'"
tmux send-keys -t "$SESSION:0.1" Enter

echo "launch: tmux session '$SESSION' running $OPENCODE2_BIN --standalone (full TUI)"
echo "  isolated root: $ISOLATED_ROOT"
echo "  work: $WORK_DIR (state fresh)"
echo "monitor: tmux attach -t $SESSION"
echo "provider: $MODEL_REF (key passed through from the caller env, never stored)"
