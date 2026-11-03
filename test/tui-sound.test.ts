// tui-sound.test.ts — Contract tests for the sound UX mapping.
//
// Verifies: the correct sound name is returned for each goal lifecycle event
// (kind + status combination), routine events produce no sound, and the
// mapping is exhaustive for all known event kinds and statuses.

import {describe, expect, test} from 'bun:test';
import {hasSound, soundForEvent} from '../src/tui-sound.ts';
import type {GoalTuiEventKind} from '../src/tui-state.ts';
import type {GoalStatus} from '../src/state-machine.ts';

// soundForEvent: create events

describe('soundForEvent — create events', () => {
  test("returns 'default' for create (any status)", () => {
    expect(soundForEvent('create', 'active')).toBe('default');
    // create always starts as active, but the sound is neutral regardless
    expect(soundForEvent('create')).toBe('default');
  });
});

// soundForEvent: transition events

describe('soundForEvent — transition events', () => {
  test("returns 'done' for transition to complete", () => {
    expect(soundForEvent('transition', 'complete')).toBe('done');
  });

  test("returns 'question' for transition to paused", () => {
    expect(soundForEvent('transition', 'paused')).toBe('question');
  });

  test("returns 'question' for transition to blocked", () => {
    expect(soundForEvent('transition', 'blocked')).toBe('question');
  });

  test("returns 'error' for transition to budgetLimited", () => {
    expect(soundForEvent('transition', 'budgetLimited')).toBe('error');
  });

  test("returns 'default' for transition to active (resume)", () => {
    expect(soundForEvent('transition', 'active')).toBe('default');
  });

  test('returns undefined for transition to finalizing', () => {
    expect(soundForEvent('transition', 'finalizing')).toBeUndefined();
  });

  test('returns undefined for transition with unknown status', () => {
    expect(
      soundForEvent('transition', 'unknown' as GoalStatus),
    ).toBeUndefined();
  });

  test('returns undefined for transition with no status', () => {
    expect(soundForEvent('transition')).toBeUndefined();
  });
});

// soundForEvent: silent events

describe('soundForEvent — silent events', () => {
  test('usage events produce no sound', () => {
    expect(soundForEvent('usage', 'active')).toBeUndefined();
    expect(soundForEvent('usage')).toBeUndefined();
  });

  test('remove events produce no sound', () => {
    expect(soundForEvent('remove')).toBeUndefined();
    expect(soundForEvent('remove', 'complete')).toBeUndefined();
  });

  test('unknown event kinds produce no sound', () => {
    expect(soundForEvent('unknown' as GoalTuiEventKind)).toBeUndefined();
    expect(soundForEvent('' as GoalTuiEventKind)).toBeUndefined();
  });
});

// hasSound

describe('hasSound', () => {
  test('returns true for sound-producing events', () => {
    expect(hasSound('create')).toBe(true);
    expect(hasSound('transition', 'complete')).toBe(true);
    expect(hasSound('transition', 'paused')).toBe(true);
    expect(hasSound('transition', 'blocked')).toBe(true);
    expect(hasSound('transition', 'budgetLimited')).toBe(true);
    expect(hasSound('transition', 'active')).toBe(true);
  });

  test('returns false for silent events', () => {
    expect(hasSound('usage')).toBe(false);
    expect(hasSound('remove')).toBe(false);
    expect(hasSound('transition', 'finalizing')).toBe(false);
    expect(hasSound('transition')).toBe(false);
  });
});

// Sound name validity

describe('sound name validity', () => {
  // All returned sound names must be valid TuiAttentionSoundName values.
  const validSoundNames = [
    'default',
    'question',
    'permission',
    'error',
    'done',
    'subagent_done',
  ];

  test('all sound-producing events return valid sound names', () => {
    const soundCases: Array<[GoalTuiEventKind, GoalStatus?]> = [
      ['create'],
      ['transition', 'complete'],
      ['transition', 'paused'],
      ['transition', 'blocked'],
      ['transition', 'budgetLimited'],
      ['transition', 'active'],
    ];
    for (const [kind, status] of soundCases) {
      const sound = soundForEvent(kind, status);
      expect(sound).toBeDefined();
      expect(validSoundNames).toContain(sound!);
    }
  });
});
