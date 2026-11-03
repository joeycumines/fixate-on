/**
 * Type declarations for the OpenCode v2 TUI companion entrypoint
 * (`fixate-on/tui-v2`).
 *
 * The v2 host supplies its Context implementation. The plugin deliberately
 * accepts an opaque context here so this package remains compatible with host
 * SDK releases whose v2 context types are not yet published.
 */

/** The v2 TUI plugin context supplied by the OpenCode host. */
export type GoalTuiPluginV2Context = unknown;

/** The v2 TUI plugin module's setup function. */
export type GoalTuiPluginV2Setup = (
  context: GoalTuiPluginV2Context,
) => Promise<void | (() => void)>;

/** Named v2 plugin export consumed by integrations. */
export declare const GoalTuiPluginV2: {
  id: 'fixate-on-tui';
  setup: GoalTuiPluginV2Setup;
};

/** Default export consumed by the OpenCode v2 TUI plugin loader. */
declare const goalTuiPluginV2Module: typeof GoalTuiPluginV2;

export default goalTuiPluginV2Module;
