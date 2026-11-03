#!/bin/bash
# Fully isolated v1 full-TUI launcher for stock stock brew opencode.
#
# ISOLATION CONTRACT: this harness uses its OWN
# dedicated HOME + XDG directories. ZERO inheritance from the user's real
# ~/.config/opencode, ~/.local/share/opencode, or any shell aliases. Stock v1
# discovers config via HOME/XDG (does NOT read OPENCODE_CONFIG), so overriding
# HOME gives complete isolation: config, credentials, model history, session
# state, and logs all resolve inside the harness-owned tree.
#
# SECURITY CONTRACT: the harness stores, reads, and prints ZERO credentials.
# The provider key comes from the caller's environment or the local OpenCode
# credential store (resolved by provider-key.sh) and is passed into the tmux
# session environment only. No tracked file contains a secret; cfg-v1/opencode.json
# declares the provider via `env: ["OPENROUTER_API_KEY"]` with no apiKey.
#
# TUI plugins load EXCLUSIVELY via tui.json on stock v1 (TuiConfig.loadState
# scans global config-dir 'tui' files / $OPENCODE_TUI_CONFIG; opencode.json's
# plugin array is SERVER-only there). The companion hydrates goal truth from
# persisted state files.
set -euo pipefail

SESSION="fixate-on"
BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_DIR="$BUNDLE_DIR/hack/e2e-harness"
CFG_DIR="$HARNESS_DIR/cfg-v1"
WORK_DIR="$HARNESS_DIR/work-v1"
ISOLATED_HOME="$HARNESS_DIR/.isolated-v1-home"

[ -f "$CFG_DIR/opencode.json" ] || { echo "abort: $CFG_DIR/opencode.json missing" >&2; exit 1; }

# Preflight: the v1 TUI companion and server plugin are generated bundles.
# They live in plugin/ which is.gitignored — run 'bun run bundle' first.
# The CURRENT layout only. `bun run bundle` writes plugin/fixate-on/*.js; the
# flat plugin/*.js names belong to a build that no longer exists, and a stale
# artifact sitting there would otherwise satisfy this check and run a month-old
# plugin while the campaign reported success. Refusing the old names is the
# point: a gate that passes on the wrong file checks nothing.
[ -f "$BUNDLE_DIR/plugin/fixate-on/plugin.js" ] || { echo "abort: plugin/fixate-on/plugin.js missing — run 'bun run bundle' first" >&2; exit 1; }
[ -f "$BUNDLE_DIR/plugin/fixate-on/tui.js" ] || { echo "abort: plugin/fixate-on/tui.js missing — run 'bun run bundle' first" >&2; exit 1; }
for _stale in fixate-on.js fixate-on-tui.js fixate-on-tui-v2.js; do
  [ -e "$BUNDLE_DIR/plugin/$_stale" ] && { echo "abort: stale plugin/$_stale present — a pre-outdir build; delete it so it can never be loaded" >&2; exit 1; }
done
unset _stale

# Completely fresh HOME tree. rm -rf scoped to THIS harness-owned dir only.
rm -rf "$ISOLATED_HOME"
mkdir -p "$ISOLATED_HOME/.config/opencode"
mkdir -p "$ISOLATED_HOME/.local/share/opencode"
mkdir -p "$ISOLATED_HOME/.local/state/opencode"
mkdir -p "$ISOLATED_HOME/.cache"

sed "s|__BUNDLE_DIR__|$BUNDLE_DIR|g" "$CFG_DIR/opencode.json" > "$ISOLATED_HOME/.config/opencode/opencode.json"

# The model the campaign runs on, read from the config rather than written here:
# a second copy of the model string is a second thing to keep correct.
MODEL_REF="$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model)' "$CFG_DIR/opencode.json")"

# Provider credential store. Stock v1 resolves the openrouter key from
# share/opencode/auth.json at startup — the `env: [OPENROUTER_API_KEY]` form in
# opencode.json alone is not sufficient on 1.18.34 (the host reports "No cookie
# auth credentials found" and never renders command replies, so a campaign
# observes the welcome screen instead of a live session). Write ONLY the
# openrouter entry, from the caller env, into this gitignored isolated home.
#
# The key is resolved BEFORE this write: the caller's environment first, then
# the local OpenCode credential store (see provider-key.sh), which also owns
# write_auth_json — the single writer, with the key JSON-escaped.
. "$HARNESS_DIR/provider-key.sh" || true
write_auth_json "$ISOLATED_HOME"

# TUI companion loaded via tui.json (v1 mechanism). Path derived dynamically
# from BUNDLE_DIR so the harness works from any checkout location.
cat > "$ISOLATED_HOME/.config/opencode/tui.json" <<JSON
{
  "plugin": [
    "file://$BUNDLE_DIR/plugin/fixate-on/tui.js"
  ]
}
JSON

# Carry agents/ into the isolated HOME: cfg-v1 sets default_agent=Implementer, and
# without the agent file every session.command dies with 'default agent not found'.
if [ -d "$CFG_DIR/agents" ]; then
  mkdir -p "$ISOLATED_HOME/.config/opencode/agents"
  cp "$CFG_DIR"/agents/*.md "$ISOLATED_HOME/.config/opencode/agents/" 2>/dev/null || true
fi

# Fresh work fixture state. Two kinds of drift accumulate across campaigns and
# both corrupt the NEXT one: goal locks/state from prior runs, and the agent's
# own edits (it is supposed to fix the fixture, so after a successful campaign
# the broken baseline is gone and a later run "discovers the work already
# done"). Reset BOTH so every campaign starts from the canonical fixture.
rm -rf "$WORK_DIR/.opencode"
mkdir -p "$WORK_DIR"
# Restore tracked fixture files and drop files the agent created. Scoped to
# this harness-owned directory; ignored files (captures/,.opencode/) are
# untouched by plain `git clean` and are handled above.
git -C "$BUNDLE_DIR" checkout -- "${WORK_DIR#$BUNDLE_DIR/}" 2>/dev/null || true
git -C "$BUNDLE_DIR" clean -fdq "${WORK_DIR#$BUNDLE_DIR/}" 2>/dev/null || true

# Deterministic briefing seed.: "briefing passes without
# manual KEEP_STATE hack." The load briefing only renders when the workspace
# ALREADY holds a stopped-and-waiting goal at host boot. This writes one
# deterministically, replacing the non-deterministic KEEP_STATE=1 escape hatch.
bash "$HARNESS_DIR/seed-briefing.sh" "$WORK_DIR"

tmux kill-session -t "$SESSION" 2>/dev/null || true

# Provider credential passthrough (see SECURITY CONTRACT above). The key is
# forwarded into the tmux session env; it is never written to a file or echoed.
TMUX_ENV=()
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  TMUX_ENV+=(-e "OPENROUTER_API_KEY=$OPENROUTER_API_KEY")
else
  echo "warn: no provider key — export OPENROUTER_API_KEY or store an openrouter key in the local OpenCode credential store" >&2
fi

tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORK_DIR" \
  ${TMUX_ENV[@]+"${TMUX_ENV[@]}"} \
  -e "HOME=$ISOLATED_HOME" \
  -e "XDG_CONFIG_HOME=$ISOLATED_HOME/.config" \
  -e "XDG_DATA_HOME=$ISOLATED_HOME/.local/share" \
  -e "XDG_STATE_HOME=$ISOLATED_HOME/.local/state" \
  -e "XDG_CACHE_HOME=$ISOLATED_HOME/.cache" \
  -e "OPENCODE_CONFIG=" \
  -e "OPENCODE_CONFIG_DIR=" \
  -e "OPENCODE_TUI_CONFIG=$ISOLATED_HOME/.config/opencode/tui.json" \
  -e "OPENCODE_SERVER_PASSWORD="
sleep 2  # shell must be ready before send-keys; without this the exec line is lost

# Pane 0 = opencode v1 TUI (full) on an EXPLICIT project path. With isolated
# HOME, v1 resolves its start dir from $HOME rather than the pane cwd, so we
# cd explicitly and insure brew PATH before exec.
tmux send-keys -t "$SESSION:0" -l "export PATH=\"/opt/homebrew/bin:\$PATH\"; cd '$WORK_DIR' && exec opencode '$WORK_DIR'"
sleep 0.3
tmux send-keys -t "$SESSION:0" Enter

# Pane 1: helper shell.
tmux split-window -t "$SESSION:0" -h
tmux send-keys -t "$SESSION:0.1" -l "cd '$HARNESS_DIR'"
tmux send-keys -t "$SESSION:0.1" Enter

echo "launch-v1: tmux session '$SESSION' running stock opencode in $WORK_DIR"
echo "  isolated home: $ISOLATED_HOME"
echo "monitor: tmux attach -t $SESSION"
echo "provider: $MODEL_REF (key passed through from the caller env, never stored)"
