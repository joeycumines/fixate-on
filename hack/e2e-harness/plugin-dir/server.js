// Server-side adapter for the OpenCode v2 host.
//
// OpenCode v2.2.7+ rejects file plugin targets ("configured plugin path must be
// a directory") on the server and silently skips file targets in the TUI
// PluginProvider. Pointing both cfg/opencode.json and cfg/cli.json at this
// plugin-dir directory lets Host.resolve({ directory }) resolve server.js and
// tui.js inside the directory boundary.
//
// This file re-exports the canonical server bundle, which itself falls
// back to src under Bun when the generated bundle is absent.
export { default } from "../../../plugin/fixate-on/plugin.js"
