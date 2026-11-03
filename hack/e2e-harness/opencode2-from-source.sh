#!/bin/bash
# Run the opencode2 v2 host from a local source checkout.
#
# The installed opencode2 release loads the external TUI plugin but never
# registers its palette entries; the fix lives on the checkout's
# fix/external-tui-plugin-loading branch. bun resolves the host's workspace
# packages only from inside the checkout, so this script cds there and execs.
# The v2 CLI takes the start directory as a positional argument, which is how
# the launcher keeps the host rooted at the campaign workspace despite the cd.
set -euo pipefail
HOST_REPO="${OPENCODE2_SRC:-$HOME/dev/opencode-2}"
[ -f "$HOST_REPO/packages/cli/package.json" ] || {
  echo "opencode2-from-source: no CLI package at $HOST_REPO (set OPENCODE2_SRC)" >&2
  exit 1
}
cd "$HOST_REPO"
exec bun run dev "$@"
