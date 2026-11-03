// Agent-name resolution and the internal-agent guard.
//
// Invariant: Continuation prompts must NEVER inherit hidden internal agents
// (such as "compaction", "title", or "summary"). After auto-compaction, the host
// appends its own summary as a user-role message marked with agent: "compaction".
// If inherited, continuations run under a toolless agent that only emits text,
// goes idle, and repeatedly triggers itself in a self-reinforcing loop.
// Measured in ses_ef1c986d (26 cycles in 24 minutes).

import {describe, expect, test} from 'bun:test';
import {
  GOAL_AGENT_NAME,
  INTERNAL_AGENT_NAMES,
  isInternalAgent,
  isKnownGoalAgent,
  normalizeAgentForPromptKey,
  normalizeInheritedAgentForPrompt,
  normalizeVerifierName,
  pickInheritableAgent,
  resolveAgentForContinuation,
  resolveRegisteredAgentName,
  stripAgentListSortPrefix,
  VERIFIER_AGENT_NAME,
} from '../src/agent-resolve.ts';

describe('isInternalAgent', () => {
  test("names the host's hidden internal agents", () => {
    expect(isInternalAgent('compaction')).toBe(true);
    expect(isInternalAgent('title')).toBe(true);
    expect(isInternalAgent('summary')).toBe(true);
  });

  test('refuses real agents and non-strings', () => {
    expect(isInternalAgent('Implementer')).toBe(false);
    expect(isInternalAgent('build')).toBe(false);
    expect(isInternalAgent(GOAL_AGENT_NAME)).toBe(false);
    expect(isInternalAgent(undefined)).toBe(false);
    expect(isInternalAgent('')).toBe(false);
  });

  test('trims before checking, so padded names are still caught', () => {
    expect(isInternalAgent('  compaction  ')).toBe(true);
  });

  test('the set is exactly the three measured internal agents', () => {
    expect([...INTERNAL_AGENT_NAMES].sort()).toEqual([
      'compaction',
      'summary',
      'title',
    ]);
  });
});

describe('pickInheritableAgent', () => {
  test('returns the newest user-role agent when it is a real agent', () => {
    const messages = [
      {role: 'user', agent: 'Implementer'},
      {role: 'assistant', agent: 'Implementer'},
      {role: 'user', agent: 'build'},
      {role: 'assistant', agent: 'build'},
    ];
    expect(pickInheritableAgent(messages)).toBe('build');
  });

  test('THE DB-OBSERVED SHAPE: compaction-agent messages are skipped, the last REAL agent wins', () => {
    // Replicates session ses_ef1c986d after auto-compaction: the newest user-role
    // message has agent: "compaction" (host summary), preceded by valid Implementer
    // turns. Internal agents must be bypassed in favor of the last legitimate agent.
    const messages = [
      {role: 'user', agent: 'Implementer'},
      {role: 'assistant', agent: 'Implementer'},
      {role: 'user', agent: 'compaction'},
      {role: 'assistant', agent: 'compaction'},
      {role: 'user', agent: 'compaction'},
    ];
    expect(pickInheritableAgent(messages)).toBe('Implementer');
  });

  test('skips ALL internal agents, not just compaction', () => {
    const messages = [
      {role: 'user', agent: 'Implementer'},
      {role: 'user', agent: 'title'},
      {role: 'user', agent: 'summary'},
      {role: 'user', agent: 'compaction'},
    ];
    expect(pickInheritableAgent(messages)).toBe('Implementer');
  });

  test('returns undefined when every user message is an internal agent', () => {
    const messages = [
      {role: 'user', agent: 'compaction'},
      {role: 'user', agent: 'title'},
    ];
    expect(pickInheritableAgent(messages)).toBeUndefined();
  });

  test('returns undefined for an empty window', () => {
    expect(pickInheritableAgent([])).toBeUndefined();
  });

  test('reads the info-wrapped shape the v2 host delivers', () => {
    const messages = [
      {info: {role: 'user', agent: 'Implementer'}},
      {info: {role: 'assistant', agent: 'Implementer'}},
      {info: {role: 'user', agent: 'compaction'}},
    ];
    expect(pickInheritableAgent(messages)).toBe('Implementer');
  });

  test('ignores assistant-role messages entirely', () => {
    const messages = [
      {role: 'user', agent: 'Implementer'},
      {role: 'assistant', agent: 'build'},
    ];
    expect(pickInheritableAgent(messages)).toBe('Implementer');
  });

  test('does not mutate the input array', () => {
    const messages = [
      {role: 'user', agent: 'compaction'},
      {role: 'user', agent: 'Implementer'},
    ];
    const snapshot = JSON.stringify(messages);
    pickInheritableAgent(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe('normalizeInheritedAgentForPrompt', () => {
  test('REFUSES internal agents — the second line of the guard', () => {
    // Defense-in-depth: Even if a caller passes a raw candidate without
    // using pickInheritableAgent, internal agents must still be rejected.
    expect(normalizeInheritedAgentForPrompt('compaction')).toBeUndefined();
    expect(normalizeInheritedAgentForPrompt('title')).toBeUndefined();
    expect(normalizeInheritedAgentForPrompt('summary')).toBeUndefined();
  });

  test('refuses internal agents even after list-prefix stripping', () => {
    expect(normalizeInheritedAgentForPrompt('1. compaction')).toBeUndefined();
  });

  test('refuses non-strings and empty strings', () => {
    expect(normalizeInheritedAgentForPrompt(undefined)).toBeUndefined();
    expect(normalizeInheritedAgentForPrompt('')).toBeUndefined();
    expect(normalizeInheritedAgentForPrompt('   ')).toBeUndefined();
  });

  test("strips the host's list-sort prefix", () => {
    expect(normalizeInheritedAgentForPrompt('2. build')).toBe('build');
  });
});

describe('stripAgentListSortPrefix', () => {
  test('strips a numeric sort prefix', () => {
    expect(stripAgentListSortPrefix('1. build')).toBe('build');
    expect(stripAgentListSortPrefix('12. plan')).toBe('plan');
  });

  test('leaves a plain name alone', () => {
    expect(stripAgentListSortPrefix('Implementer')).toBe('Implementer');
  });

  test('trims whitespace', () => {
    expect(stripAgentListSortPrefix('  build  ')).toBe('build');
  });
});

describe('normalizeVerifierName', () => {
  test('normalises a list-rendered verifier name', () => {
    expect(normalizeVerifierName('1. goal-verify')).toBe('goal-verify');
  });

  test('refuses non-strings', () => {
    expect(normalizeVerifierName(undefined)).toBeUndefined();
    expect(normalizeVerifierName(42)).toBeUndefined();
  });
});

describe('isKnownGoalAgent', () => {
  test("recognises the plugin's own agents", () => {
    expect(isKnownGoalAgent(GOAL_AGENT_NAME)).toBe(true);
    expect(isKnownGoalAgent(VERIFIER_AGENT_NAME)).toBe(true);
    expect(isKnownGoalAgent('build')).toBe(false);
    expect(isKnownGoalAgent(undefined)).toBe(false);
  });
});

describe('display-name resolution', () => {
  test("the plugin's own agent resolves to its registered display name", () => {
    expect(resolveRegisteredAgentName('goal-verify')).toBe('goal-verify');
    expect(resolveRegisteredAgentName('GOAL-VERIFY')).toBe('goal-verify');
    expect(resolveRegisteredAgentName('unknown-agent')).toBeUndefined();
    expect(resolveRegisteredAgentName(undefined)).toBeUndefined();
  });

  test('resolveRegisteredAgentName strips a sort prefix before lookup', () => {
    expect(resolveRegisteredAgentName('1. goal-verify')).toBe('goal-verify');
  });

  test('normalizeAgentForPromptKey lowercases a display name to its key', () => {
    expect(normalizeAgentForPromptKey('goal-verify')).toBe('goal-verify');
    expect(normalizeAgentForPromptKey(undefined)).toBeUndefined();
  });

  test('an agent name the plugin does not register passes through unchanged', () => {
    expect(normalizeInheritedAgentForPrompt('Implementer')).toBe('Implementer');
    expect(normalizeInheritedAgentForPrompt('implementer')).toBe('implementer');
  });
});

describe('resolveAgentForContinuation', () => {
  test('prefers inherited then fallback', () => {
    expect(resolveAgentForContinuation('implementer', 'build')).toBe(
      'implementer',
    );
    expect(resolveAgentForContinuation(undefined, 'build')).toBe('build');
    expect(resolveAgentForContinuation(undefined, undefined)).toBeUndefined();
    expect(resolveAgentForContinuation('  ', 'build')).toBe('build');
  });

  test('an internal inherited agent falls through to the fallback', () => {
    expect(resolveAgentForContinuation('compaction', 'Implementer')).toBe(
      'Implementer',
    );
    expect(
      resolveAgentForContinuation('compaction', 'summary'),
    ).toBeUndefined();
    expect(
      resolveAgentForContinuation('compaction', undefined),
    ).toBeUndefined();
  });

  test("an inherited agent repeating the session's own agent is dropped", () => {
    expect(
      resolveAgentForContinuation('Implementer', 'Implementer'),
    ).toBeUndefined();
    expect(resolveAgentForContinuation('Build', 'build')).toBeUndefined();
  });
});
