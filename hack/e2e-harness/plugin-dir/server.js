// Server-side adapter for the OpenCode v2 host.
//
// The v2 host's plugin supervisor (packages/core/src/plugin/supervisor.ts)
// imports absolute-path targets directly under Bun with a `?mtime=` cache
// buster appended to the RAW path. A directory target therefore fails
// resolution (Bun does not probe <dir>/server.js through a query string),
// so opencode.json names this file explicitly. The TUI half is loaded
// independently via cli.json and points at plugin/fixate-on/tui-v2.js.
//
// This file re-exports the canonical server bundle, which itself falls
// back to src under Bun when the generated bundle is absent.
export { default } from "../../../plugin/fixate-on/plugin.js"
