// toast-discipline contract tests — the storm law, locked.
//
// Laws under test (the user 2026-08-24 field report):
// 1. usage events NEVER produce toasts; routine transitions never do either.
// 2. Only curated lifecycle moments toast: create, remove, complete,
// blocked, escalated/budget-limited pauses.
// 3. Rendered messages are plain language: never JSON, bounded length.
// 4. Coalescing: transitions inside the window merge into one summary;
// min-interval enforced; queue bounded with drop-oldest.

import {describe, expect, test} from 'bun:test';
import {waitFor} from './wait-for.ts';
import type {GoalTuiEvent, GoalTuiSnapshot} from '../src/tui-state.ts';
import {
  formatCuratedToast,
  shouldToast,
  TOAST_COALESCE_WINDOW_MS,
  TOAST_MESSAGE_MAX,
  TOAST_MIN_INTERVAL_MS,
  ToastCoalescer,
} from '../src/tui-toast-policy.ts';

function snap(overrides: Partial<GoalTuiSnapshot> = {}): GoalTuiSnapshot {
  return {
    goalId: 'g1',
    sessionID: 'ses-1',
    condition: 'fix the integration flake in the exporter pipeline',
    status: 'active',
    revision: 1,
    turnCount: 1,
    totalTokens: 0,
    maxTokens: 0,
    maxTurns: 0,
    tokenBudget: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    stopReason: '',
    blockedReason: '',
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
    ...overrides,
  } as GoalTuiSnapshot;
}

function ev(
  kind: GoalTuiEvent['kind'],
  extra: Partial<GoalTuiEvent> = {},
): GoalTuiEvent {
  return {
    kind,
    sessionID: 'ses-1',
    timestamp: 1_700_000_000_000,
    ...extra,
  } as GoalTuiEvent;
}

describe('shouldToast — the storm law', () => {
  test('usage events never toast', () => {
    expect(shouldToast(ev('usage', {snapshot: snap()}))).toBe(false);
  });

  test('routine active transitions never toast', () => {
    expect(
      shouldToast(
        ev('transition', {snapshot: snap({status: 'active', revision: 7})}),
      ),
    ).toBe(false);
    expect(
      shouldToast(ev('transition', {snapshot: snap({status: 'finalizing'})})),
    ).toBe(false);
  });

  test('terminal and blocking moments toast', () => {
    expect(
      shouldToast(ev('transition', {snapshot: snap({status: 'complete'})})),
    ).toBe(true);
    expect(
      shouldToast(
        ev('transition', {
          snapshot: snap({status: 'blocked', blockedReason: 'needs creds'}),
        }),
      ),
    ).toBe(true);
  });

  test('limit/escalation pauses toast via stopReason', () => {
    expect(
      shouldToast(
        ev('transition', {
          snapshot: snap({
            status: 'paused',
            stopReason: 'max turns reached (2/2)',
          }),
        }),
      ),
    ).toBe(true);
    expect(
      shouldToast(
        ev('transition', {
          snapshot: snap({
            status: 'paused',
            stopReason: 'recovery exhausted (escalated)',
          }),
        }),
      ),
    ).toBe(true);
    expect(
      shouldToast(
        ev('transition', {
          snapshot: snap({
            status: 'budgetLimited',
            stopReason: 'token budget exhausted',
          }),
        }),
      ),
    ).toBe(true);
  });

  test('escalated pause renders the review-needed sentence with error variant (gate run-2 pin)', () => {
    const t = formatCuratedToast(
      ev('transition', {
        snapshot: snap({
          status: 'paused',
          stopReason: 'recovery exhausted (escalated)',
          condition: 'ship the release',
        }),
      }),
    );
    expect(t.variant).toBe('error');
    // "recovery exhausted" is the one member of the limit/escalation class that IS a
    // repeated failure, so this sentence is the correct rendering of this stopReason —
    // and it is the member a user is LEAST likely to meet. The three brakes a user is
    // most likely to hit each name themselves; see the cases below.
    expect(t.message).toContain('repeated failures');
    expect(t.message).toContain('review needed');
    expect(t.message.startsWith('{')).toBe(false);
  });

  test('budget-limited pause names the BUDGET, not a repeated failure (gate run-2 pin)', () => {
    const t = formatCuratedToast(
      ev('transition', {
        snapshot: snap({
          status: 'budgetLimited',
          stopReason: 'token budget exhausted (120000/100000)',
        }),
      }),
    );
    expect(t.variant).toBe('error');
    // This assertion USED to require "repeated failures" — that is, it PINNED the false
    // claim. A token budget running out is not a repeated failure, and a user who hit it
    // was told to go looking for one that had not happened. The gate was protecting the
    // defect rather than the rule, which is the only way a gate can be worse than none.
    expect(t.message).toContain('token budget ran out');
    expect(
      t.message,
      'a token brake is still reported as a repeated failure',
    ).not.toContain('repeated failures');
    expect(t.message.length).toBeLessThanOrEqual(TOAST_MESSAGE_MAX);
  });

  test('EACH brake names ITSELF, so no two read alike', () => {
    // The whole point: the class used to be one sentence, so three different brakes
    // produced three identical toasts and a user could not tell which limit they hit.
    const seen: string[] = [];
    for (const stopReason of [
      'max turns reached',
      'max stall reached',
      'max context tokens reached',
      'token budget exhausted',
    ]) {
      const t = formatCuratedToast(
        ev('transition', {snapshot: snap({status: 'paused', stopReason})}),
      );
      expect(t.variant).toBe('error');
      expect(
        t.message.length,
        `${stopReason} produced an unbounded message`,
      ).toBeLessThanOrEqual(TOAST_MESSAGE_MAX);
      expect(
        seen,
        `"${stopReason}" rendered identically to an earlier brake, so a user cannot tell which limit they hit`,
      ).not.toContain(t.message);
      seen.push(t.message);
    }
    // And none of them claims a failure that did not happen.
    for (const message of seen) {
      expect(message, 'a brake claimed a repeated failure').not.toContain(
        'repeated failures',
      );
    }
  });

  test('create and remove toast; remove needs no snapshot', () => {
    expect(shouldToast(ev('create', {snapshot: snap()}))).toBe(true);
    expect(shouldToast(ev('remove', {goalId: 'dead-goal'}))).toBe(true);
  });
});

describe('formatCuratedToast — plain language, no JSON', () => {
  test('create renders a started sentence with truncated condition', () => {
    const t = formatCuratedToast(
      ev('create', {
        snapshot: snap({
          condition: 'execute the very long plan ' + 'word '.repeat(40),
        }),
      }),
    );
    expect(t.message.startsWith('{')).toBe(false);
    expect(
      t.message.startsWith('Goal started: execute the very long plan'),
    ).toBe(true);
    expect(t.message.length).toBeLessThanOrEqual(TOAST_MESSAGE_MAX);
  });

  test('complete renders claim-plain suffix for unverifiable claims', () => {
    const t = formatCuratedToast({
      ...ev('transition', {
        snapshot: snap({
          status: 'complete',
          lastClaim: {
            claimId: 'c1',
            timestamp: 1,
            actor: 'agent' as never,
            claimedStatus: 'complete',
            claimText: 'done',
            check: {path: 'none'} as never,
            outcome: {
              status: 'unverifiable-claim',
              detail: 'no verifier',
              timestamp: 2,
            },
          },
        }),
      }),
    });
    expect(t.message).toContain(
      'completed, but no attestation could be obtained',
    );
    expect(t.message).not.toContain('unverifiable-claim');
  });

  test('blocked renders the human reason, not field names', () => {
    const t = formatCuratedToast(
      ev('transition', {
        snapshot: snap({
          status: 'blocked',
          blockedReason: 'waiting on API credentials from user',
        }),
      }),
    );
    expect(t.variant).toBe('warning');
    expect(t.message).toContain('waiting on API credentials');
    expect(t.message).not.toContain('blockedReason');
  });

  test('remove renders without a snapshot and never emits JSON', () => {
    const t = formatCuratedToast(ev('remove', {goalId: 'abc123'}));
    expect(t.message.startsWith('{')).toBe(false);
    expect(t.message).toBe('Goal cleared: abc123');
  });
});

describe('ToastCoalescer — rate law', () => {
  test('usage is dropped before the queue even in isolation', () => {
    const out: string[] = [];
    const now = 1000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(ev('usage', {snapshot: snap()}), 's');
    expect(out).toHaveLength(0);
    c.flush();
    expect(out).toHaveLength(0);
  });

  test('first curated moment emits immediately; burst queues with drop-oldest beyond 3', () => {
    const out: string[] = [];
    let now = 10_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );

    const completes = [1, 2, 3, 4, 5].map(i =>
      ev('transition', {
        snapshot: snap({
          status: 'complete',
          goalId: `g${i}`,
          condition: `distinct objective ${i}`,
        }),
      }),
    );
    c.accept(completes[0]!, 's');
    expect(out).toHaveLength(1); // interval satisfied on a quiet session
    for (const e of completes.slice(1)) c.accept(e, 's'); // same instant -> queue
    expect(c.queuedCount).toBe(3); // cap enforced, oldest dropped
    // Distinct moments survive: latest wins, nothing summarized away.
    expect(out[0]).toContain('distinct objective 1');
    c.flush();
    expect(out.length).toBe(1); // still inside min-interval -> lazy hold
    // Each min-interval step releases exactly one queued toast.
    for (let i = 0; i < 3; i++) {
      now += TOAST_MIN_INTERVAL_MS + 1;
      c.flush();
    }
    expect(out.length).toBe(4); // 1 + 3 queued
    expect(out[3]).toContain('distinct objective 5'); // newest survived drop-oldest
  });

  test('consecutive duplicate messages within the window are suppressed', () => {
    const out: string[] = [];
    let now = 50_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    const blockedTwice = [
      snap({status: 'blocked', blockedReason: 'waiting on credentials'}),
      snap({
        status: 'blocked',
        blockedReason: 'waiting on credentials',
        revision: 9,
      }),
    ];
    c.accept(ev('transition', {snapshot: blockedTwice[0]}), 's');
    now += 100; // inside 500ms window
    c.accept(ev('transition', {snapshot: blockedTwice[1]}), 's');
    expect(out).toHaveLength(1);
    now += 600; // coalesce window passed -> identical message allowed again
    c.accept(
      ev('transition', {
        snapshot: snap({
          status: 'blocked',
          blockedReason: 'waiting on credentials',
        }),
      }),
      's',
    );
    expect(out).toHaveLength(1); // but min-interval holds it in the queue
    expect(c.queuedCount).toBe(1);
    now += TOAST_MIN_INTERVAL_MS + 1;
    c.flush();
    expect(out).toHaveLength(2);
  });

  test('messages are hard-capped at TOAST_MESSAGE_MAX even for pathological conditions', () => {
    const out: string[] = [];
    const now = 99_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('create', {snapshot: snap({condition: 'x'.repeat(5000)})}),
      's',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBeLessThanOrEqual(TOAST_MESSAGE_MAX);
    expect(out[0]!.startsWith('{')).toBe(false);
  });

  test('accept() itself drains matured queued toasts (gate fix B1)', () => {
    const out: string[] = [];
    let now = 100_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('create', {snapshot: snap({condition: 'first objective'})}),
      's',
    );
    expect(out).toHaveLength(1);
    // Queued during the min-interval...
    c.accept(
      ev('transition', {
        snapshot: snap({
          status: 'blocked',
          blockedReason: 'needs creds',
          condition: 'second objective',
        }),
      }),
      's',
    );
    expect(out).toHaveLength(1);
    //...and a LATER accept — not a manual flush — releases it.
    now += TOAST_MIN_INTERVAL_MS + 1;
    c.accept(ev('usage', {snapshot: snap()}), 's'); // silent event still drains
    expect(out).toHaveLength(2);
    expect(out[1]).toContain('needs creds');
  });

  test('autoFlush pump delivers queued toasts with no further events arriving', async () => {
    const out: string[] = [];
    const c = new ToastCoalescer(t => out.push(t.message), Date.now, 40);
    c.startAutoFlush();
    try {
      c.accept(
        ev('transition', {
          snapshot: snap({status: 'complete', condition: 'quiet completion'}),
        }),
        's',
      );
      expect(out).toHaveLength(1); // immediate
      c.accept(
        ev('transition', {
          snapshot: snap({
            goalId: 'g9',
            status: 'blocked',
            blockedReason: 'stalled hard',
            condition: 'other objective',
          }),
        }),
        's',
      );
      expect(out).toHaveLength(1); // held inside the min-interval
      // No further events, NO manual flush — the pump must deliver it. Awaiting
      // the condition runs for exactly as long as the pump needs, instead of
      // sleeping a guessed TOAST_MIN_INTERVAL_MS + 150 and hoping.
      // Ceiling must exceed TOAST_MIN_INTERVAL_MS (2000): the pump legitimately
      // needs that long, so a tighter ceiling would race the interval rather
      // than detect a hang.
      await waitFor(
        () => out.length === 2,
        'the autoFlush pump to deliver the queued toast',
        TOAST_MIN_INTERVAL_MS + 3000,
      );
      expect(out[1]).toContain('stalled hard');
    } finally {
      c.stopAutoFlush();
    }
  });

  test('min-interval boundary is inclusive at exactly TOAST_MIN_INTERVAL_MS', () => {
    const out: string[] = [];
    let now = 1_000_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(ev('create', {snapshot: snap({condition: 'a one'})}), 's');
    c.accept(
      ev('create', {snapshot: snap({goalId: 'g2', condition: 'a two'})}),
      's',
    );
    expect(c.queuedCount).toBe(1);
    now += TOAST_MIN_INTERVAL_MS; // EXACT boundary, no +1
    c.flush();
    expect(out).toHaveLength(2); // >= comparison lets it through
  });

  test('dedupe window boundary is exclusive: repeat at exactly window width is allowed', () => {
    const out: string[] = [];
    let now = 2_000_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('transition', {
        snapshot: snap({status: 'blocked', blockedReason: 'same reason'}),
      }),
      's',
    );
    now += TOAST_COALESCE_WINDOW_MS; // EXACT boundary
    c.accept(
      ev('transition', {
        snapshot: snap({
          status: 'blocked',
          blockedReason: 'same reason',
          revision: 5,
        }),
      }),
      's',
    );
    // Strict < means exactly-at-window is NOT suppressed by dedupe...
    expect(out).toHaveLength(1);
    expect(c.queuedCount).toBe(1); //...but the min-interval still queues it
    now += TOAST_MIN_INTERVAL_MS;
    c.flush();
    expect(out).toHaveLength(2);
  });
});

describe('ToastCoalescer — remembered memory bound', () => {
  // REMEMBERED_LIMIT, inlined as a tripwire: if the bound moves, this
  // assertion goes red and the test gets updated rather than drifting.
  const LIMIT = 4096;

  /** The coalescer's private memory, read through a cast — the bound is an
   * invariant of internal sets, and the only honest assertion is on them. */
  function memoryOf(coalescer: ToastCoalescer): {
    announced: Set<string>;
    yielding: Set<string>;
  } {
    return coalescer as unknown as {
      announced: Set<string>;
      yielding: Set<string>;
    };
  }

  test('announced overflow is pruned back to the bound', () => {
    const c = new ToastCoalescer(() => {});
    const memory = memoryOf(c);
    for (let i = 0; i <= LIMIT + 10; i++) {
      c.accept(ev('create', {snapshot: snap({goalId: `g-${i}`})}), 's1');
    }
    expect(memory.announced.size + memory.yielding.size).toBeLessThanOrEqual(
      LIMIT,
    );
  });

  test('yield-only overflow is pruned — a yield that never re-arms cannot outgrow the bound', () => {
    const c = new ToastCoalescer(() => {});
    const memory = memoryOf(c);
    // Fill yielding past the limit with announced empty — the defect case:
    // pruneRemembered only evicted from announced and returned when exhausted,
    // so a yield-only overflow was never pruned.
    for (let i = 0; i < LIMIT + 100; i++) memory.yielding.add(`s1|g-${i}`);
    // Trigger prune via accept(create), which calls claimStartAnnouncement → pruneRemembered
    c.accept(ev('create', {snapshot: snap({goalId: 'trigger'})}), 's1');
    expect(memory.announced.size + memory.yielding.size).toBeLessThanOrEqual(
      LIMIT,
    );
  });
});
