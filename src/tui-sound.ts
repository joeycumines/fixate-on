/**
 * Maps goal lifecycle events to attention sound names.
 */

import type {TuiAttentionSoundName} from '@opencode-ai/plugin/tui';
import type {GoalTuiEventKind} from './tui-state.ts';
import type {GoalStatus} from './state-machine.ts';

/**
 * Maps a goal TUI event to an attention sound name, or `undefined` when the
 * event should stay silent (routine updates like usage ticks, removes, and
 * routine transitions).
 */
export function soundForEvent(
  kind: GoalTuiEventKind,
  status?: GoalStatus,
): TuiAttentionSoundName | undefined {
  switch (kind) {
    case 'create':
      return 'default';
    case 'transition':
      // Only emit sounds for user-actionable transitions; routine transitions remain silent.
      switch (status) {
        case 'complete':
          return 'done';
        case 'paused':
          return 'question';
        case 'blocked':
          return 'question';
        case 'budgetLimited':
          return 'error';
        case 'active':
          return 'default';
        case 'finalizing':
          return undefined;
        default:
          return undefined;
      }
    case 'usage':
      // High-frequency token updates remain silent to prevent noise.
      return undefined;
    case 'remove':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Returns `true` if the given event produces an attention sound.
 */
export function hasSound(kind: GoalTuiEventKind, status?: GoalStatus): boolean {
  return soundForEvent(kind, status) !== undefined;
}
