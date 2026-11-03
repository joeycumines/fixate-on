// Local-directory TUI adapter for the merged OpenCode v2 host.
// Host.resolve({directory}).tui resolves <dir>/tui; the full-TUI PluginProvider
// imports this entrypoint for plugins whose source is a local directory.
export { default } from "../../../plugin/fixate-on/tui-v2.js"
