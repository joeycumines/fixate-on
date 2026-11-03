/**
 * Bundle entry point and v1 compatibility shim.
 *
 * Re-exports the v2 default plugin shape alongside the v1 factory and types.
 * `default` must remain the v2 shape because external loaders and scripts
 * hardcode this export path.
 */

import GoalsPluginV2Default from './plugin-v2.ts';
import {GoalsPlugin} from './plugin-runtime.ts';

// Dual-host bundle entry: satisfies opencode2 ({ id, setup }) and OpenCode 1.x (default.server).
const entry = {
  ...GoalsPluginV2Default,
  server: GoalsPlugin,
};
export default entry;

// Re-export v1 factory and types for backwards compatibility.
export {GoalsPlugin} from './plugin-runtime.ts';
export {DEFAULT_GOAL_OPTIONS} from './plugin-runtime.ts';
export type {PluginOptions, DefaultGoalOptions} from './plugin-runtime.ts';
