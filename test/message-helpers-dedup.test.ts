import {describe, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
  assistantTurnKey,
  findLatestAssistantMessage,
  findNewestMessage,
  getMessageID,
  getTextFromParts,
  getThinkingTokens,
  hostReportsCompletion,
  messageHasToolCall,
  messageIsSettled,
  windowHasToolCallNewerThan,
} from '../src/message-helpers.ts';

// Task #41: dedup the OpenCode message-parsing helpers (DRY / divergence trap)
//
// getTextFromParts + findLatestAssistantMessage were duplicated across
// hooks.ts (1362, 1376) AND child-session-verifier.ts (308, 328) with
// near-identical bodies whose casts had already drifted
// (`Record<string,unknown>` vs `MessageLike`). Structural typing satisfied
// both copies silently, so a fix in one copy would not propagate to the
// other — the same divergence-trap class as the stale local type subsets
// fixed in task #40. getMessageID / getThinkingTokens / messageHasToolCall
// were hooks-local but cohesive with the deduped pair (all parse the same
// OpenCode message/part shape).
//
// The single source of truth is now src/message-helpers.ts (a leaf module
// importing only accounting.ts). hooks.ts + child-session-verifier.ts import from
// it. This mirrors the escape.ts / steering.ts extraction precedent.
//
// These tests lock the dedup. They are RED until the helpers relocate.

const SRC = join(import.meta.dir, '..', 'src');

async function read(file: string): Promise<string> {
  return readFile(join(SRC, `${file}.ts`), 'utf8');
}

// Source-of-truth structural tests (RED first)

test('#41: hooks.ts no longer declares a local getTextFromParts', async () => {
  const source = await read('hooks');
  expect(source).not.toMatch(/\bfunction getTextFromParts\b/);
});

test('#41: hooks.ts no longer declares a local findLatestAssistantMessage', async () => {
  const source = await read('hooks');
  expect(source).not.toMatch(/\bfunction findLatestAssistantMessage\b/);
});

test('#41: child-session-verifier.ts no longer declares a local getTextFromParts', async () => {
  const source = await read('child-session-verifier');
  expect(source).not.toMatch(/\bfunction getTextFromParts\b/);
});

test('#41: child-session-verifier.ts no longer declares a local findLatestAssistantMessage', async () => {
  const source = await read('child-session-verifier');
  expect(source).not.toMatch(/\bfunction findLatestAssistantMessage\b/);
});

test('#41: hooks.ts imports the helpers from message-helpers.ts', async () => {
  const source = await read('hooks');
  expect(source).toMatch(/from\s+["']\.\/message-helpers\.ts["']/);
});

test('#41: child-session-verifier.ts imports the helpers from message-helpers.ts', async () => {
  const source = await read('child-session-verifier');
  expect(source).toMatch(/from\s+["']\.\/message-helpers\.ts["']/);
});

test('#41: message-helpers.ts owns the canonical helpers + is a leaf (imports only accounting)', async () => {
  const source = await read('message-helpers');
  // The canonical owners.
  expect(source).toMatch(/export function getTextFromParts\b/);
  expect(source).toMatch(/export function findLatestAssistantMessage\b/);
  expect(source).toMatch(/export function getMessageID\b/);
  expect(source).toMatch(/export function getThinkingTokens\b/);
  expect(source).toMatch(/export function messageHasToolCall\b/);
  // Leaf invariant: the ONLY source import is accounting.ts (for
  // toNonNegativeInteger used by getThinkingTokens). No back-edges.
  const imports = source.match(/^import\s+.*$/gm) ?? [];
  const sourceImports = imports.filter(l => /from\s+["']\.\//.test(l));
  expect(sourceImports.length).toBe(1);
  expect(sourceImports[0]).toMatch(/["']\.\/accounting\.ts["']/);
});

// Behavioral parity (the general valid-input contract, not test shapes)

test('#41 parity: getTextFromParts joins text parts and ignores non-text', () => {
  expect(getTextFromParts(undefined)).toBe('');
  expect(getTextFromParts('not-an-array')).toBe('');
  expect(getTextFromParts([])).toBe('');
  expect(
    getTextFromParts([
      {type: 'text', text: 'hello '},
      {type: 'tool', text: 'ignored'},
      {type: 'text', text: 'world'},
      {type: 'text'}, // text part with no string text -> ignored
      {type: 'text', text: 42}, // non-string text -> ignored
    ]),
  ).toBe('hello world');
});

test('#41 parity: findLatestAssistantMessage resolves SDK + flat shapes', () => {
  expect(findLatestAssistantMessage([])).toBeNull();
  expect(findLatestAssistantMessage([{role: 'user'}])).toBeNull();
  // Flat shape (role at top level) — legacy/non-SDK host.
  const flat = {id: 'a', role: 'assistant'};
  expect(findLatestAssistantMessage([{role: 'user'}, flat])).toBe(flat);
  // SDK shape (role at info.role) — what OpenCode actually publishes.
  const sdk = {
    id: 'b',
    info: {role: 'agent'},
    parts: [{type: 'text', text: 'x'}],
  };
  expect(findLatestAssistantMessage([{role: 'user'}, sdk])).toBe(sdk);
  // Latest wins (reverse scan).
  const first = {id: 'c', info: {role: 'assistant'}};
  const later = {id: 'd', info: {role: 'assistant'}};
  expect(findLatestAssistantMessage([first, later])).toBe(later);
});

test('#41 parity: getMessageID stringifies the id (missing -> empty)', () => {
  expect(getMessageID(null)).toBe('');
  expect(getMessageID(undefined)).toBe('');
  expect(getMessageID('x')).toBe('');
  expect(getMessageID({})).toBe('');
  expect(getMessageID({id: 42})).toBe('42');
  expect(getMessageID({id: 'msg-7'})).toBe('msg-7');
});

test('#41 parity: getThinkingTokens reads usage + nested tokens, numeric-string tolerant', () => {
  expect(getThinkingTokens(null)).toBe(0);
  expect(getThinkingTokens({})).toBe(0);
  // Flat usage.reasoning.
  expect(getThinkingTokens({usage: {reasoning: 50}})).toBe(50);
  // usage.reasoning_tokens alias.
  expect(getThinkingTokens({usage: {reasoning_tokens: 30}})).toBe(30);
  // Nested info.tokens reasoning (SDK shape).
  expect(getThinkingTokens({info: {tokens: {reasoning: 17}}})).toBe(17);
  // Numeric-string tolerance (the regression this helper protects against).
  expect(getThinkingTokens({usage: {reasoning: '100'}})).toBe(100);
  // Negatives/non-numeric clamp to 0.
  expect(getThinkingTokens({usage: {reasoning: -5}})).toBe(0);
  expect(getThinkingTokens({usage: {reasoning: 'nonsense'}})).toBe(0);
  // usage takes precedence over nested tokens.
  expect(
    getThinkingTokens({usage: {reasoning: 9}, info: {tokens: {reasoning: 99}}}),
  ).toBe(9);
});

test('#41 parity: messageHasToolCall detects the full tool-part type vocabulary', () => {
  expect(messageHasToolCall(null)).toBe(false);
  expect(messageHasToolCall({})).toBe(false);
  expect(messageHasToolCall({parts: 'nope'})).toBe(false);
  expect(messageHasToolCall({parts: [{type: 'text', text: 'hi'}]})).toBe(false);
  for (const type of [
    'tool',
    'tool-invocation',
    'subtask',
    'tool_use',
    'function_call',
    'tool-call',
    'tool_call',
  ]) {
    expect(messageHasToolCall({parts: [{type}]})).toBe(true);
  }
});

// findNewestMessage: the host generations return messages in OPPOSITE orders
//
// Measured live 2026-09-24 against stock v1 1.18.32 through the harness: the
// FX-J idle poller read `messages[0]` under the comment "OpenCode's
// session.messages endpoint defaults to descending order; the first record is
// therefore the newest message" — but v1 returned the ORIGINAL USER TURN at
// index 0. The assistant-role check therefore failed on every tick, the poller
// never synthesized an idle, `processIdleEvent` never ran, and the goal sat at
// `turnCount 0 / totalTokens 0` with a permanently false cockpit gauge. The v2
// store does default to "desc" (`packages/core/src/session/store.ts`,
// `input.order?? "desc"`), so the comment was true for one host and false for
// the other. Selection is now order-agnostic.

describe('findNewestMessage — order-agnostic newest selection', () => {
  test('ascending host (stock v1): the LAST record is newest', () => {
    const messages = [
      {id: 'm1', role: 'user', time: {created: 1000}},
      {id: 'm2', role: 'assistant', time: {created: 2000}},
      {id: 'm3', role: 'user', time: {created: 3000}},
    ];
    expect((findNewestMessage(messages) as {id: string}).id).toBe('m3');
  });

  test('descending host (v2): the FIRST record is newest', () => {
    const messages = [
      {id: 'm3', role: 'user', time: {created: 3000}},
      {id: 'm2', role: 'assistant', time: {created: 2000}},
      {id: 'm1', role: 'user', time: {created: 1000}},
    ];
    expect((findNewestMessage(messages) as {id: string}).id).toBe('m3');
  });

  test('SDK envelope shape: reads info.time.created', () => {
    const messages = [
      {info: {id: 'a', role: 'user', time: {created: 500}}, parts: []},
      {info: {id: 'b', role: 'assistant', time: {created: 900}}, parts: []},
    ];
    expect(getMessageID(findNewestMessage(messages))).toBe('b');
  });

  test('untimestamped descending list: id ordering picks the newer record', () => {
    const messages = [
      {id: 'msg_0000000002', role: 'assistant'},
      {id: 'msg_0000000001', role: 'user'},
    ];
    expect(getMessageID(findNewestMessage(messages))).toBe('msg_0000000002');
  });

  test('DUPLICATE timestamp on a descending (v2) host picks the NEWER id, not the later index', () => {
    // The tie must not be broken by array position: the later index is newer on
    // an ascending host but OLDER on a descending one. Ids are monotone within
    // a millisecond, so the greater id is the newer message on both hosts.
    const newer = {
      info: {id: 'msg_0ce733a4f002', role: 'assistant', time: {created: 1000}},
      parts: [],
    };
    const older = {
      info: {id: 'msg_0ce733a4f001', role: 'assistant', time: {created: 1000}},
      parts: [],
    };
    expect(getMessageID(findNewestMessage([newer, older]))).toBe(
      'msg_0ce733a4f002',
    );
  });

  test('DUPLICATE timestamp on an ascending (v1) host picks the NEWER id', () => {
    const older = {
      info: {id: 'msg_0ce733a4f001', role: 'assistant', time: {created: 1000}},
      parts: [],
    };
    const newer = {
      info: {id: 'msg_0ce733a4f002', role: 'assistant', time: {created: 1000}},
      parts: [],
    };
    expect(getMessageID(findNewestMessage([older, newer]))).toBe(
      'msg_0ce733a4f002',
    );
  });

  test('a tie with NO ids is unresolvable and keeps the earlier index (never throws)', () => {
    const a = {role: 'assistant', time: {created: 1000}};
    const b = {role: 'assistant', time: {created: 1000}};
    expect(findNewestMessage([a, b])).toBe(a);
  });

  test('a PARTIALLY timestamped list does not invert order (falls to the id path)', () => {
    // Mixing modes is the failure the design forbids: one untimed record must
    // not let a timestamp comparison decide against a known array order.
    const timedOld = {
      id: 'msg_0000000001',
      role: 'assistant',
      time: {created: 1000},
    };
    const untimedNew = {id: 'msg_0000000002', role: 'assistant'};
    expect(getMessageID(findNewestMessage([timedOld, untimedNew]))).toBe(
      'msg_0000000002',
    );
    expect(getMessageID(findNewestMessage([untimedNew, timedOld]))).toBe(
      'msg_0000000002',
    );
  });

  test('variable-width ids are not compared (the fixed-width invariant is explicit)', () => {
    // Order matters for this test to discriminate. A lexicographic compare of
    // "msg_10" vs "msg_9" says the FORMER is greater, which would return `a`;
    // the width guard declines the comparison and keeps array order, returning
    // `b`. So the assertion below fails if the guard is removed — with the
    // fixture written the other way round both paths agree and the test would
    // pass for the wrong reason (verified by deleting the guard).
    const a = {id: 'msg_9', role: 'assistant'};
    const b = {id: 'msg_10', role: 'assistant'};
    expect(findNewestMessage([a, b])).toBe(b);
  });

  test('empty and non-array inputs return null', () => {
    expect(findNewestMessage([])).toBeNull();
    expect(findNewestMessage(null as unknown as unknown[])).toBeNull();
  });

  test('findLatestAssistantMessage ignores trailing user turns on an ascending host', () => {
    // The exact v1 failure: index 0 is the user turn, the assistant turn is at
    // the end. A position-based reader returns the user turn (or null) and the
    // idle poller never fires.
    const messages = [
      {id: 'u1', role: 'user', time: {created: 1000}},
      {id: 'a1', role: 'assistant', time: {created: 2000}},
      {id: 'u2', role: 'user', time: {created: 3000}},
    ];
    expect(getMessageID(findLatestAssistantMessage(messages))).toBe('a1');
  });

  test('findLatestAssistantMessage returns null when no assistant turn exists', () => {
    expect(
      findLatestAssistantMessage([
        {id: 'u1', role: 'user', time: {created: 1000}},
      ]),
    ).toBeNull();
  });
});

// Settled-turn detection: the gate that stops the v1 poller firing mid-turn
//
// On stock v1 no authentic idle is ever delivered, so the poller's grace window
// never applies and only the 10 s quiet window governs. A slow turn whose
// in-progress assistant message shows no token delta for 10 s would then draw a
// synthetic idle MID-TURN. Both hosts mark a finished turn (`info.time.completed`
// / `info.finish`; measured live: 55 of 56 assistant messages carried both, the
// exception being the streaming turn), so an unsettled newest turn is refused.

describe('settled-turn detection', () => {
  test('v1 settled shape: info.time.completed + info.finish', () => {
    const settled = {
      info: {
        role: 'assistant',
        time: {created: 1, completed: 2},
        finish: 'stop',
      },
      parts: [],
    };
    expect(messageIsSettled(settled)).toBe(true);
  });

  test('v1 in-progress shape: created but no completed and no finish', () => {
    const streaming = {
      info: {role: 'assistant', time: {created: 1}},
      parts: [],
    };
    expect(messageIsSettled(streaming)).toBe(false);
  });

  test('finish alone is enough (tool-calls turn with no completed stamp)', () => {
    expect(
      messageIsSettled({info: {role: 'assistant', finish: 'tool-calls'}}),
    ).toBe(true);
  });

  test('flat/legacy shape is tolerated', () => {
    expect(
      messageIsSettled({role: 'assistant', time: {created: 1, completed: 2}}),
    ).toBe(true);
    expect(messageIsSettled({role: 'assistant', time: {created: 1}})).toBe(
      false,
    );
  });

  test('non-object and empty input are not settled', () => {
    expect(messageIsSettled(null)).toBe(false);
    expect(messageIsSettled({})).toBe(false);
  });

  test('hostReportsCompletion is true when ANY message is settled', () => {
    // The newest turn is still streaming, but an earlier one settled — so this
    // IS a completion-reporting host and the gate must apply.
    const list = [
      {
        info: {
          role: 'assistant',
          time: {created: 1, completed: 2},
          finish: 'stop',
        },
        parts: [],
      },
      {info: {role: 'assistant', time: {created: 3}}, parts: []},
    ];
    expect(hostReportsCompletion(list)).toBe(true);
  });

  test('hostReportsCompletion is FALSE for a host that never reports it (no stall regression)', () => {
    // A host with no completion metadata anywhere must not be gated, or the
    // poller would never fire — exactly the stall this poller exists to fix.
    const list = [
      {info: {role: 'assistant', time: {created: 1}}, parts: []},
      {info: {role: 'assistant', time: {created: 2}}, parts: []},
    ];
    expect(hostReportsCompletion(list)).toBe(false);
  });

  test('hostReportsCompletion tolerates non-array input', () => {
    expect(hostReportsCompletion(null as unknown as unknown[])).toBe(false);
  });
});

// PER-TURN-GUARD-1: the TURN KEY, and the reference it is safe to pass
//
// The per-turn brakes must count TURNS on both host shapes. An id-less host
// still stamps `time.created`, so that is the fallback key; `#` keeps the two
// key spaces disjoint so a persisted key stays readable if a host starts (or
// stops) reporting ids.

describe('assistantTurnKey', () => {
  test('prefers the message id when the host reports one', () => {
    expect(
      assistantTurnKey({
        info: {id: 'msg_abc', role: 'assistant', time: {created: 1000}},
        parts: [],
      }),
    ).toBe('msg_abc');
  });

  test('falls back to the creation timestamp when the host reports no id', () => {
    expect(
      assistantTurnKey({
        info: {role: 'assistant', time: {created: 1000}},
        parts: [],
      }),
    ).toBe('#1000');
  });

  test("reads a flat/legacy host's top-level `time` too", () => {
    expect(
      assistantTurnKey({role: 'assistant', time: {created: 42}, parts: []}),
    ).toBe('#42');
  });

  test('returns empty when the message carries neither signal (uncountable)', () => {
    // Neither id nor timestamp: the caller must NOT count it, because counting
    // an unkeyable message once per tick is the defect this replaces.
    expect(assistantTurnKey({info: {role: 'assistant'}, parts: []})).toBe('');
    expect(assistantTurnKey(null)).toBe('');
    expect(assistantTurnKey(undefined)).toBe('');
  });

  test('a `#` timestamp key never collides with a real message id', () => {
    const real = assistantTurnKey({
      info: {
        id: 'msg_ffffffffffffffffffffffff',
        role: 'assistant',
        time: {created: 1},
      },
      parts: [],
    });
    const synthetic = assistantTurnKey({
      info: {role: 'assistant', time: {created: 1}},
      parts: [],
    });
    expect(real.startsWith('#')).toBe(false);
    expect(synthetic.startsWith('#')).toBe(true);
    expect(real).not.toBe(synthetic);
  });
});

describe('windowHasToolCallNewerThan tolerates a `#` turn key as the reference', () => {
  // An id-less host stores `#<created>` in lastNoToolCallMessageID, which cannot
  // be ordered against real ids. The helper accepts the tool call whenever
  // either side is unusable, and a `#` key is lexicographically below every
  // `msg_` id — so the two reference forms must agree on EVERY window. This is
  // the measurement behind hooks.ts's comment; if the helper's contract ever
  // changes, this test fails rather than the comment going quietly stale.
  const toolTurn = (id: string | undefined, created: number) => ({
    info: {
      ...(id ? {id} : {}),
      role: 'assistant',
      time: {created},
      finish: 'tool-calls',
    },
    parts: [{type: 'tool', tool: 'bash'}],
  });
  const prose = {
    info: {role: 'assistant', time: {created: 5000}, finish: 'stop'},
    parts: [{type: 'text', text: 'x'}],
  };

  const windows: Array<[string, unknown[]]> = [
    [
      'an id-bearing tool call in the window',
      [toolTurn('msg_zzz', 3000), prose],
    ],
    ['an ID-LESS tool call in the window', [toolTurn(undefined, 3000), prose]],
    ['no tool call in the window', [prose]],
  ];

  for (const [label, messages] of windows) {
    test(`agrees for ${label}`, () => {
      expect(windowHasToolCallNewerThan(messages, '#2000')).toBe(
        windowHasToolCallNewerThan(messages, ''),
      );
    });
  }
});
