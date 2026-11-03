#!/usr/bin/env bash
# provider-key.sh — the campaign's provider key, resolved without being stored
# or printed.
#
# SOURCED, never executed: the key has to reach the host's environment, and a
# subprocess cannot set its parent's environment. Sourcing also keeps the key
# out of stdout, which is where a campaign transcript would find it.
#
# WHERE THE KEY COMES FROM, in order. The caller's environment first: an
# explicit key wins, so a campaign can be run against a key the caller chose.
# Then the local OpenCode credential store — $XDG_DATA_HOME/opencode/auth.json,
# or ~/.local/share/opencode/auth.json — which is where the host itself keeps
# provider keys and where a developer on this machine already has one.
#
# NOTHING HERE PRINTS THE KEY. A key that is nowhere to be found is reported by
# naming the two places it was looked for.
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  __auth_file="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"
  if [ -f "$__auth_file" ]; then
    OPENROUTER_API_KEY="$(bun -e '
      const fs = require("fs")
      try {
        const auth = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        const key = auth?.openrouter?.key
        if (typeof key === "string" && key.length > 0) process.stdout.write(key)
      } catch {}
    ' "$__auth_file")"
  fi
  unset __auth_file
fi
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "provider key not found: set OPENROUTER_API_KEY, or store an openrouter key in ${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" >&2
  return 1 2>/dev/null || exit 1
fi

# write_auth_json <home-dir> — write the openrouter credential entry into an
# isolated home's auth.json, JSON-escaping the key. The stock v1 host resolves
# its key from auth.json at boot and never renders command replies without
# one. Four call sites held four copies of a raw printf '%s' insert — a key
# carrying a quote or backslash would produce an auth.json the host rejects at
# boot (loud, but confusingly attributed). Real OpenRouter keys are JSON-safe
# alphanumerics; this removes the class anyway. The file is gitignored and
# harness-owned; the key never reaches stdout or a tracked file.
write_auth_json() {
  local home_dir="$1"
  [ -n "${OPENROUTER_API_KEY:-}" ] || return 0
  mkdir -p "$home_dir/.local/share/opencode"
  bun -e '
const key = process.argv[2]
const escaped = key.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
process.stdout.write("{\n  \"openrouter\": {\n    \"key\": \"" + escaped + "\",\n    \"type\": \"api\"\n  }\n}\n")
' "" "${OPENROUTER_API_KEY}" > "$home_dir/.local/share/opencode/auth.json"
}
export -f write_auth_json 2>/dev/null || true
