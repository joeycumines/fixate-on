/**
 * Type declarations for the TUI companion entrypoint (`fixate-on/tui`).
 *
 * The TUI companion is a separate `TuiPluginModule` (has `tui`, no `server`),
 * mutually exclusive with the server `PluginModule` in `index.d.ts`. Register
 * both as separate plugin entries in `opencode.json`:
 *
 * ```json
 * "plugin": [
 *   "fixate-on",
 *   ["fixate-on/tui", { "logLevel": "info" }]
 * ]
 * ```
 */

/**
 * Options for the TUI companion plugin. All fields are optional — the TUI
 * works with zero configuration.
 */
export interface GoalTuiPluginOptions {
  /**
   * Log verbosity for the TUI companion. `"error"` logs only failures;
   * `"info"` logs initialization and event subscription; `"debug"` logs every
   * applied event. @default "info"
   */
  logLevel?: 'error' | 'info' | 'debug';

  /**
   * Workspace directory to scan for persisted goal state. Defaults to the
   * process working directory.
   */
  directory?: string;
}

/**
 * The TUI companion plugin function. Called by OpenCode's TUI plugin loader
 * when `fixate-on/tui` is registered. Subscribes to host events,
 * feeds them into the shared TuiStateStore, and exposes the store for view
 * components and keymap handlers.
 */
export declare function GoalTuiPlugin(
  api: unknown,
  options?: GoalTuiPluginOptions,
  meta?: unknown,
): Promise<void>;

/**
 * Default export consumed by OpenCode's TUI plugin loader:
 * `{ "fixate-on/tui": { ... } }` in `opencode.json` resolves `id`
 * and calls `tui` to initialize the TUI companion.
 */
declare const goalTuiPluginModule: {
  id: 'fixate-on-tui';
  tui: typeof GoalTuiPlugin;
};

export default goalTuiPluginModule;
