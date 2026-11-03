// goal-lifecycle-toasts.test.ts — R3 and R4, the moments the user is told about.
//
// WHY THIS FILE EXISTS. For its whole life the plugin told the user about a goal
// it had just created, a goal it had cleared, a goal that had completed or
// blocked, and four brake classes — and said NOTHING when a goal started or
// stopped on its own. The three ways a goal begins working (the session-resume
// re-arm, the ordered-sequence auto-promote, the re-arm after a user
// intervention) were all silent, so a goal that was active when you quit
// resumed in total silence. Meanwhile a workspace full of goals sitting stopped
// and waiting on the user produced no notice at all, because hydration was
// deliberately silent.
//
// The storm law that produced that silence was right about MOMENTS and wrong
// about FACTS. Both halves are locked here, because the failure mode of fixing
// this is the opposite one: a toast on every continuation.
//
// THE STRUCTURAL CLAIM, and the defect under it. `ToastCoalescer.accept` took a
// session key, ignored it, and its only caller passed the constant "tui", so
// the 2 s interval and the 500 ms duplicate window were global across every
// session in a workspace. "A single toast" was therefore not merely missing —
// it was wrong. The partitioning tests below are the ones that fail if the key
// is ignored again.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import GoalTuiPluginDefault from '../src/tui.ts';
import {
  createGoalBroadcaster,
  createTuiStateStore,
  type GoalTuiEvent,
  type GoalTuiSnapshot,
} from '../src/tui-state.ts';
import {createDiskRefreshLoop} from '../src/tui-companion-refresh.ts';
import {YIELD_PROMISE_MS} from '../src/status-label.ts';
import {
  BRIEFING_SESSION_KEY,
  goalNeedsTheUser,
  isLimitOrEscalationPause,
  needsYouReason,
  previousStatusOf,
  shouldToast,
  summarizeGoalsNeedingYou,
  TOAST_MESSAGE_MAX,
  TOAST_MIN_INTERVAL_MS,
  ToastCoalescer,
} from '../src/tui-toast-policy.ts';
import {assertClean} from './vocabulary-lock.ts';

const initTui = GoalTuiPluginDefault.tui as (
  api: unknown,
  options?: unknown,
) => Promise<void>;

function snap(overrides: Partial<GoalTuiSnapshot> = {}): GoalTuiSnapshot {
  return {
    goalId: 'g1',
    sessionID: 'ses-1',
    condition: 'ship the release',
    status: 'active',
    revision: 1,
    turnCount: 0,
    totalTokens: 0,
    maxTokens: 1000000,
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
    // 0 = "not paused", which every `snap` that does not override it means.
    // A fixture that left this undefined would be read as an overdue yield
    // whenever it also set stopReason "user intervention" — the same class of
    // fixture bug this file's header warns about, one field over.
    pausedAt: 0,
    stoppedAt: 0,
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

function transition(
  previousStatus: GoalTuiEvent['previousStatus'],
  overrides: Partial<GoalTuiSnapshot> = {},
): GoalTuiEvent {
  return ev('transition', {previousStatus, snapshot: snap(overrides)});
}

// R3a: crossing the `active` boundary toasts; churn inside it does not

describe('a goal is announced when it starts or stops working', () => {
  test('the session-resume re-arm toasts — the case that was silent for months', () => {
    // A goal that was active when the process exited is recovered paused with
    // stopReason 'recovery' (plugin-runtime.ts), then re-armed on the first
    // idle (hooks.ts). Before this change that transition produced no toast.
    expect(
      shouldToast(transition('paused', {status: 'active', stopReason: ''})),
    ).toBe(true);
  });

  test('the ordered-sequence auto-promote toasts', () => {
    // A queued step is promoted to active by the idle handler.
    expect(
      shouldToast(
        transition('paused', {status: 'active', stopReason: 'queued'}),
      ),
    ).toBe(true);
  });

  test('the post-intervention re-arm toasts', () => {
    expect(
      shouldToast(
        transition('paused', {
          status: 'active',
          stopReason: 'user intervention',
        }),
      ),
    ).toBe(true);
  });

  test('leaving active toasts for every brake class, not only the narrow one', () => {
    // These four were the reported gap: the goal stopped and said nothing.
    for (const stopReason of [
      'no progress',
      'no tool calls',
      'deferred too many times',
      'execution failure',
      'paused',
      'tool surface unavailable',
    ]) {
      expect(
        shouldToast(transition('active', {status: 'paused', stopReason})),
        `${stopReason} stops silently`,
      ).toBe(true);
    }
  });

  test('leaving active to budgetLimited and blocked still toasts', () => {
    expect(
      shouldToast(
        transition('active', {
          status: 'budgetLimited',
          stopReason: 'token budget exhausted',
        }),
      ),
    ).toBe(true);
    expect(
      shouldToast(
        transition('active', {status: 'blocked', blockedReason: 'needs creds'}),
      ),
    ).toBe(true);
  });

  test('churn inside `active` never toasts — the storm law survives the fix', () => {
    // A running goal emits a transition on every continuation. If this ever
    // returns true the companion becomes unusable, so it is asserted directly
    // rather than inferred.
    expect(
      shouldToast(
        transition('active', {
          status: 'active',
          revision: 42,
          totalTokens: 99_999,
        }),
      ),
    ).toBe(false);
    expect(shouldToast(transition('active', {status: 'finalizing'}))).toBe(
      false,
    );
  });

  test('an event that does not say what came before is treated as churn, not as a boundary', () => {
    // No previousStatus and no transition: the receiver genuinely does not know
    // whether this is an entry or a continuation, and guessing 'entry' is what
    // a toast storm looks like.
    expect(
      shouldToast(
        ev('transition', {snapshot: snap({status: 'active', revision: 7})}),
      ),
    ).toBe(false);
    // A terminal snapshot states its own outcome, so it still announces.
    expect(
      shouldToast(ev('transition', {snapshot: snap({status: 'complete'})})),
    ).toBe(true);
  });

  test('previousStatusOf reads one field, whichever producer filled it', () => {
    expect(previousStatusOf(ev('transition', {previousStatus: 'paused'}))).toBe(
      'paused',
    );
    expect(
      previousStatusOf(
        ev('transition', {
          transition: {
            source: 'recovery',
            from: 'blocked',
            to: 'active',
            detail: '',
          },
        }),
      ),
    ).toBe('blocked');
    expect(previousStatusOf(ev('transition'))).toBeUndefined();
  });
});

// R3b: the wording, in the repository's own vocabulary

describe('what the moment says', () => {
  test('a goal is announced as started the first time, then as running again', () => {
    // The companion has not said anything about this goal yet, so the first
    // time it is seen working the honest sentence is "started" — not "again",
    // which would refer to something the user was never told.
    const out: string[] = [];
    const c = new ToastCoalescer(t => out.push(t.message));
    c.accept(
      transition('paused', {status: 'active', stopReason: 'recovery'}),
      'ses-1',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Goal started');
    expect(out[0]).not.toContain('Goal running again');
  });

  test('a goal is announced as running once, then as running again', () => {
    // create -> work -> stop -> start. The create announced the goal; the stop
    // is real news; the resume that follows a real brake is the plugin picking
    // it back up, which is the R3 case worth one sentence.
    const out: string[] = [];
    let now = 200_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('create', {snapshot: snap({condition: 'ship the release'})}),
      'ses-1',
    );
    out.length = 0;
    c.accept(
      transition('active', {status: 'paused', stopReason: 'no progress'}),
      'ses-1',
    );
    now += TOAST_MIN_INTERVAL_MS + 1;
    c.flush();
    c.accept(transition('paused', {status: 'active'}), 'ses-1');
    now += TOAST_MIN_INTERVAL_MS + 1;
    c.flush();
    expect(out.filter(m => m.includes('Goal stopped'))).toHaveLength(1);
    expect(out.filter(m => m.includes('Goal started'))).toHaveLength(0);
    expect(out.filter(m => m.includes('running again'))).toHaveLength(1);
  });

  test('each real brake and each real resume is announced; a yield cycle is not', () => {
    // The distinction that matters: a brake the plugin applied and the user
    // undid later is two real transitions, each worth one sentence. A pause the
    // plugin made and undid inside its own turn is neither.
    const out: string[] = [];
    let now = 210_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('create', {snapshot: snap({condition: 'ship the release'})}),
      'ses-1',
    );
    out.length = 0;
    for (let i = 0; i < 3; i++) {
      c.accept(
        transition('active', {
          status: 'paused',
          stopReason: 'user intervention',
        }),
        'ses-1',
      );
      c.accept(transition('paused', {status: 'active'}), 'ses-1');
      now += TOAST_MIN_INTERVAL_MS + 1;
      c.flush();
    }
    expect(out).toHaveLength(0); // three user messages, no storm
    c.accept(
      transition('active', {status: 'paused', stopReason: 'no progress'}),
      'ses-1',
    );
    now += TOAST_MIN_INTERVAL_MS + 1;
    c.flush();
    c.accept(transition('paused', {status: 'active'}), 'ses-1');
    now += TOAST_MIN_INTERVAL_MS + 1;
    c.flush();
    expect(out.filter(m => m.includes('Goal stopped'))).toHaveLength(1);
    expect(out.filter(m => m.includes('running again'))).toHaveLength(1);
  });

  test('a user-intervention cycle produces no toast at all', () => {
    // THE regression this policy would otherwise ship. hooks.ts pauses every
    // active goal on every human message and re-arms it on the next idle, so
    // treating that pair as two boundaries gave two toasts per goal per message
    // the user sent. Reproduced by driving the real coalescer: zero.
    const out: string[] = [];
    let now = 300_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('create', {snapshot: snap({condition: 'ship the release'})}),
      'ses-1',
    );
    out.length = 0;
    for (let i = 0; i < 10; i++) {
      c.accept(
        transition('active', {
          status: 'paused',
          stopReason: 'user intervention',
        }),
        'ses-1',
      );
      now += 500;
      c.accept(transition('paused', {status: 'active'}), 'ses-1');
      now += 500;
      c.flush();
    }
    expect(out).toHaveLength(0);
  });

  test("a yield is remembered per goal, so another goal's re-arm is still announced", () => {
    const out: string[] = [];
    const now = 310_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    // Goal g1 yields for a user message; goal g2 is promoted from a sequence.
    c.accept(
      transition('active', {
        goalId: 'g1',
        status: 'paused',
        stopReason: 'user intervention',
      }),
      'ses-1',
    );
    c.accept(
      transition('paused', {
        goalId: 'g2',
        status: 'paused',
        stopReason: 'queued',
      }),
      'ses-1',
    );
    c.accept(transition('paused', {goalId: 'g1', status: 'active'}), 'ses-1');
    expect(out).toHaveLength(0);
    c.accept(transition('paused', {goalId: 'g2', status: 'active'}), 'ses-1');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Goal started');
  });

  test('a user-intervention cycle produces no toast even without a create event', () => {
    // Same regression as above, driven without the create event: hooks.ts
    // pauses every active goal on every human message and re-arms it on the
    // next idle, so treating that pair as two boundaries gave two toasts per
    // goal per message the user sent. Reproduced by driving the real loop,
    // this asserts the count: zero.
    const out: string[] = [];
    const now = 300_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    for (let i = 0; i < 10; i++) {
      c.accept(
        transition('active', {
          status: 'paused',
          stopReason: 'user intervention',
        }),
        'ses-1',
      );
      c.accept(transition('paused', {status: 'active'}), 'ses-1');
    }
    c.flush();
    expect(out).toHaveLength(0);
  });

  test('an explicit /goal pause still announces — it is not a self-cancelling stop', () => {
    const out: string[] = [];
    const c = new ToastCoalescer(t => out.push(t.message));
    c.accept(
      transition('active', {status: 'paused', stopReason: 'explicit pause'}),
      'ses-1',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Goal stopped');
  });

  test('a queued step promoted to running is announced; queueing it is not', () => {
    const out: string[] = [];
    const c = new ToastCoalescer(t => out.push(t.message));
    c.accept(
      transition('active', {
        goalId: 'g2',
        status: 'paused',
        stopReason: 'queued',
      }),
      'ses-1',
    );
    expect(out).toHaveLength(0);
    c.accept(transition('paused', {goalId: 'g2', status: 'active'}), 'ses-1');
    expect(out).toHaveLength(1);
  });

  test("a recovery pause is the plugin's own bookkeeping and stays silent", () => {
    // plugin-runtime.ts pauses a recovered goal with stopReason 'recovery'
    // during hydration. Announcing that is a false alarm about the plugin's
    // internals; the re-arm that follows it is the moment worth reporting.
    const out: string[] = [];
    const c = new ToastCoalescer(t => out.push(t.message));
    c.accept(
      transition('active', {status: 'paused', stopReason: 'recovery'}),
      'ses-1',
    );
    expect(out).toHaveLength(0);
    c.accept(transition('paused', {status: 'active'}), 'ses-1');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Goal started');
  });

  test('a stop names the reason in plain language', () => {
    const out: string[] = [];
    const c = new ToastCoalescer(t => out.push(t.message));
    c.accept(
      transition('active', {status: 'paused', stopReason: 'no progress'}),
      'ses-1',
    );
    expect(out[0]).toContain('Goal stopped');
    expect(out[0]).toContain('no progress');
  });

  test("'tool surface unavailable' reuses the plugin's own name for it", () => {
    // hooks.ts:1063 already calls this "the tool surface went away". A second
    // wording for the same class of failure is how a user ends up unsure which
    // of two messages means the thing that happened.
    expect(needsYouReason('tool surface unavailable')).toBe(
      'the goal tools are gone',
    );
  });

  test('every reason phrase is plain language, and none leaks an internal token', () => {
    for (const reason of [
      'no progress',
      'no tool calls',
      'deferred too many times',
      'execution failure',
      'message aborted',
      'permission rejected',
      'session error',
      'tool surface unavailable',
      'judge rejected',
      'unattested completion asserted repeatedly',
      'paused',
      'explicit pause',
      'queued',
    ]) {
      const phrase = needsYouReason(reason);
      expect(phrase.length).toBeGreaterThan(0);
      assertClean(`the reason for "${reason}"`, phrase);
      // The plugin's own names are the vocabulary, so some phrases are
      // deliberately unchanged; what must never appear is an internal token's
      // shape (snake_case, camelCase, a `field:` label).
      expect(phrase).not.toMatch(/[a-z][A-Z]/);
      expect(phrase).not.toMatch(/_/);
      expect(phrase).not.toMatch(/\w+:/);
    }
  });

  test("the plugin's mechanical names are replaced with human ones", () => {
    // These three are the ones a user would otherwise read as an internal
    // code: a hyphen-joined token, a plural of a token, and a field name.
    expect(needsYouReason('tool surface unavailable')).not.toBe(
      'tool surface unavailable',
    );
    expect(needsYouReason('no tool calls')).toBe('no tool calls');
    expect(needsYouReason('deferred too many times')).toBe(
      'deferred too many times',
    );
    expect(needsYouReason('unattested completion asserted repeatedly')).toBe(
      'the claim could not be attested',
    );
  });

  test('an unrecognised stopReason is passed through when it is a sentence, and refused when it is a field value', () => {
    expect(needsYouReason('some reason nobody enumerated yet')).toBe(
      'some reason nobody enumerated yet',
    );
    expect(needsYouReason('')).toBe(
      'stopped for a reason the plugin did not name',
    );
    // What the producers actually write when a verifier ends a goal.
    expect(
      needsYouReason('cancelled (verifier: CANCELLED): outstanding claims'),
    ).toBe('a verifier stopped it');
    expect(
      needsYouReason(
        'needs input (verifier: NEEDS_INPUT): blocked on a decision',
      ),
    ).toBe('a verifier stopped it');
    // A field value that no pattern enumerates must not reach the user raw.
    expect(needsYouReason('some_undocumented_state: detail')).toBe(
      'stopped for a reason the plugin did not name',
    );
  });

  test('the limit/escalation class keeps its own error wording', () => {
    // Pinned by the pre-existing suite too; asserted here so the new
    // "stopped" branch cannot have swallowed it.
    const out: string[] = [];
    const c = new ToastCoalescer(t => out.push(t.message));
    c.accept(
      transition('active', {
        status: 'paused',
        stopReason: 'recovery exhausted (escalated)',
      }),
      'ses-1',
    );
    expect(out[0]).toContain('repeated failures');
    expect(isLimitOrEscalationPause('escalated')).toBe(true);
  });

  test('no rendered moment contains a banned word', () => {
    const out: string[] = [];
    const c = new ToastCoalescer(t => out.push(t.message));
    c.accept(transition('paused', {status: 'active'}), 'ses-1');
    c.accept(
      transition('active', {
        status: 'paused',
        stopReason: 'unattested completion asserted repeatedly',
      }),
      'ses-2',
    );
    c.accept(transition('active', {status: 'complete'}), 'ses-3');
    expect(out.length).toBeGreaterThan(0);
    for (const message of out) assertClean('a lifecycle toast', message);
  });
});

// The latent defect: the session key must actually partition the limiter

describe("one session's traffic cannot silence another's", () => {
  test('two sessions each get their toast inside the same min-interval window', () => {
    // THE regression this whole class exists for. With the key ignored (the
    // constant "tui"), the second accept lands inside the first's 2 s window
    // and is queued instead of shown — which is the bug, reproduced as a test
    // rather than described in a comment.
    const out: string[] = [];
    const now = 1_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('create', {
        sessionID: 'ses-A',
        snapshot: snap({
          goalId: 'a',
          sessionID: 'ses-A',
          condition: 'objective A',
        }),
      }),
      'ses-A',
    );
    c.accept(
      ev('create', {
        sessionID: 'ses-B',
        snapshot: snap({
          goalId: 'b',
          sessionID: 'ses-B',
          condition: 'objective B',
        }),
      }),
      'ses-B',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('objective A');
    expect(out[1]).toContain('objective B');
    expect(c.queuedCount).toBe(0);
  });

  test("a busy session's QUEUE does not consume another session's moment", () => {
    const out: string[] = [];
    const now = 5_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('create', {
        sessionID: 'ses-A',
        snapshot: snap({goalId: 'a0', sessionID: 'ses-A', condition: 'A0'}),
      }),
      'ses-A',
    );
    for (let i = 1; i <= 5; i++) {
      c.accept(
        ev('create', {
          sessionID: 'ses-A',
          snapshot: snap({
            goalId: `a${i}`,
            sessionID: 'ses-A',
            condition: `A${i}`,
          }),
        }),
        'ses-A',
      );
    }
    expect(c.queuedCount).toBe(3); // session A's own drop-oldest cap
    // Session B is untouched by that backlog: its own interval is fresh.
    c.accept(
      ev('create', {
        sessionID: 'ses-B',
        snapshot: snap({goalId: 'b', sessionID: 'ses-B', condition: 'B'}),
      }),
      'ses-B',
    );
    expect(out.some(m => m.includes('B'))).toBe(true);
  });

  test("duplicate suppression is per session, so session B may repeat session A's sentence", () => {
    const out: string[] = [];
    let now = 20_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    const blocked = (sid: string) =>
      ev('transition', {
        sessionID: sid,
        previousStatus: 'active',
        snapshot: snap({
          goalId: `g-${sid}`,
          sessionID: sid,
          status: 'blocked',
          blockedReason: 'needs creds',
        }),
      });
    c.accept(blocked('ses-A'), 'ses-A');
    now += 100; // inside the 500 ms duplicate window
    c.accept(blocked('ses-A'), 'ses-A');
    expect(out).toHaveLength(1);
    // Identical message, different session: NOT a duplicate.
    now += 10_000; // clear ses-A's interval
    c.accept(blocked('ses-B'), 'ses-B');
    expect(out).toHaveLength(2);
  });

  test('a goal whose state changes twice in one window leaves ONE pending message — the newest', () => {
    // "A single toast" has to mean it. Two queued messages about one goal
    // inside one window is the failure the requirement names. Reachable when a
    // goal stops, is re-armed, and stops again inside the min-interval.
    const out: string[] = [];
    let now = 30_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    c.accept(
      ev('create', {
        snapshot: snap({goalId: 'g1', condition: 'ship the release'}),
      }),
      'ses-1',
    );
    out.length = 0;
    now += TOAST_MIN_INTERVAL_MS + 1; // clear the create's interval
    c.accept(
      transition('active', {
        goalId: 'g1',
        status: 'paused',
        stopReason: 'no progress',
      }),
      'ses-1',
    );
    expect(out).toHaveLength(1); // so the stop is shown rather than queued
    c.accept(transition('paused', {goalId: 'g1', status: 'active'}), 'ses-1');
    expect(c.queuedCount).toBe(1);
    c.accept(
      transition('active', {
        goalId: 'g1',
        status: 'paused',
        stopReason: 'recovery exhausted (escalated)',
      }),
      'ses-1',
    );
    // The re-arm is stale — this goal stopped again — so only the newest stands.
    expect(c.queuedCount).toBe(1);
    now += TOAST_MIN_INTERVAL_MS + 1;
    c.flush();
    const aboutG1 = out.filter(m => m.includes('ship the release'));
    expect(aboutG1.length).toBe(2); // the emitted stop, then the one collapsed moment
    expect(aboutG1[aboutG1.length - 1]).toContain('review needed');
  });
});

// R4: the load briefing

describe('goals that are defined but not running', () => {
  test("self-resolving stops are excluded — R3's active-side toast already covers them", () => {
    for (const stopReason of ['recovery', 'user intervention', 'queued']) {
      expect(
        goalNeedsTheUser(snap({status: 'paused', stopReason})),
        `${stopReason} resumes on its own`,
      ).toBe(false);
    }
  });

  test('a running or finished goal never counts as needing the user', () => {
    expect(goalNeedsTheUser(snap({status: 'active'}))).toBe(false);
    expect(goalNeedsTheUser(snap({status: 'finalizing'}))).toBe(false);
    expect(goalNeedsTheUser(snap({status: 'complete'}))).toBe(false);
  });

  test('every stop that waits on the user counts', () => {
    for (const stopReason of [
      'paused',
      'explicit pause',
      'no progress',
      'no tool calls',
      'deferred too many times',
      'budget exhausted',
      'max turns',
      'recovery exhausted',
      'escalated',
      'execution failure',
      'execution interrupted',
      'message aborted',
      'permission rejected',
      'session error',
      'tool surface unavailable',
      'judge rejected',
      'unattested completion asserted repeatedly',
    ]) {
      expect(
        goalNeedsTheUser(snap({status: 'paused', stopReason})),
        `${stopReason} waits on the user`,
      ).toBe(true);
    }
  });

  test('an ACTIVE goal in another session is never reported as needing the user', () => {
    // The requirement's own intent: a sibling session's running work must not
    // be announced as if it were stuck. The briefing filters on state, which
    // is what makes that true — and the state filter is asserted here against
    // a mixed snapshot set rather than a filtered input, so the guarantee is
    // the summariser's own.
    const briefing = summarizeGoalsNeedingYou([
      snap({goalId: 'running', sessionID: 'ses-A', status: 'active'}),
      snap({
        goalId: 'resuming',
        sessionID: 'ses-A',
        status: 'paused',
        stopReason: 'recovery',
      }),
      snap({
        goalId: 'stuck',
        sessionID: 'ses-B',
        status: 'paused',
        stopReason: 'no progress',
      }),
    ]);
    expect(briefing).not.toBeNull();
    expect(briefing!.message).toContain('1 goal needs you');
  });

  test('nothing to say is null, not an empty toast', () => {
    expect(summarizeGoalsNeedingYou([])).toBeNull();
    expect(summarizeGoalsNeedingYou([snap({status: 'active'})])).toBeNull();
    expect(
      summarizeGoalsNeedingYou([
        snap({status: 'paused', stopReason: 'recovery'}),
      ]),
    ).toBeNull();
  });

  test("the summary is a COUNT that fits the host's message bound", () => {
    // A per-goal list would be silently truncated AND would hit TOAST_QUEUE_MAX
    // — a drop-oldest queue turns a wall of goals into a few hidden ones.
    const many = Array.from({length: 40}, (_, i) =>
      snap({goalId: `g${i}`, status: 'paused', stopReason: 'no progress'}),
    );
    const briefing = summarizeGoalsNeedingYou(many);
    expect(briefing).not.toBeNull();
    expect(briefing!.message).toContain('40 goals need you');
    expect(briefing!.message.length).toBeLessThanOrEqual(TOAST_MESSAGE_MAX);
  });

  test('reasons are counted, most common first, and a blocked goal names what it needs', () => {
    const briefing = summarizeGoalsNeedingYou([
      snap({goalId: 'a', status: 'paused', stopReason: 'no progress'}),
      snap({goalId: 'b', status: 'paused', stopReason: 'no progress'}),
      snap({
        goalId: 'c',
        status: 'paused',
        stopReason: 'tool surface unavailable',
      }),
      snap({
        goalId: 'd',
        status: 'blocked',
        blockedReason: 'needs API credentials',
        stopReason: '',
      }),
    ]);
    // The blocked goal's own reason, not the anonymous "stopped" its empty
    // stopReason would otherwise produce.
    expect(briefing!.message).toBe(
      '4 goals need you: 2 no progress, needs API credentials, the goal tools are gone',
    );
  });

  test('over-long reasons are dropped as a COUNT, never truncated mid-word', () => {
    // 40 goals each blocked on a long distinct reason cannot fit in one
    // sentence. What must not happen is a message that ends mid-syllable and
    // loses the fact that 30 more goals are waiting.
    const briefing = summarizeGoalsNeedingYou(
      Array.from({length: 40}, (_, i) =>
        snap({
          goalId: `g${i}`,
          status: 'blocked',
          blockedReason: `reason number ${i} which is fairly long indeed`,
        }),
      ),
    );
    expect(briefing!.message).toContain('40 goals need you');
    expect(briefing!.message).toMatch(/\+\d+ more$/);
    expect(briefing!.message.length).toBeLessThanOrEqual(TOAST_MESSAGE_MAX);
    expect(briefing!.message.endsWith('…')).toBe(false);
  });

  test('the briefing uses no banned word', () => {
    const briefing = summarizeGoalsNeedingYou([
      snap({
        goalId: 'a',
        status: 'paused',
        stopReason: 'unattested completion asserted repeatedly',
      }),
      snap({
        goalId: 'b',
        status: 'paused',
        stopReason: 'tool surface unavailable',
      }),
    ]);
    assertClean('the load briefing', briefing!.message);
  });

  test("the briefing is throttled under its own key, not a session's", () => {
    // A workspace-wide summary cannot borrow a session id, and borrowing one
    // would let a session's first real toast queue behind a briefing it has
    // nothing to do with.
    const out: string[] = [];
    const now = 40_000;
    const c = new ToastCoalescer(
      t => out.push(t.message),
      () => now,
    );
    const briefing = summarizeGoalsNeedingYou([
      snap({status: 'paused', stopReason: 'no progress'}),
    ])!;
    c.brief(BRIEFING_SESSION_KEY, briefing);
    c.accept(
      ev('create', {
        sessionID: 'ses-1',
        snapshot: snap({condition: 'new work'}),
      }),
      'ses-1',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('needs you');
    expect(out[1]).toContain('new work');
  });
});

// The producers: both must say what came before

describe('producers carry the previous status', () => {
  test('the broadcaster sends it on every transition', async () => {
    const seen: GoalTuiEvent[] = [];
    const broadcaster = createGoalBroadcaster({
      publish: async (_s, e) => {
        seen.push(e);
      },
    });
    // A GoalState complete enough for serializeGoalForTui; the assertion is
    // about the event's edge metadata, not about projection.
    const state = {
      goalId: 'g1',
      sessionID: 'ses-1',
      condition: 'ship it',
      status: 'active',
      revision: 2,
      turnCount: 1,
      totalTokens: 0,
      maxTokens: 1000,
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
      startedAt: 0,
      pausedAt: 0,
      finishedAt: null,
      lastStatus: '',
      history: [],
      claims: [],
      lastClaim: null,
      messageIDs: new Set<string>(),
    };
    await broadcaster.onCommit(state as never, {
      source: 'recovery',
      from: 'paused',
      to: 'active',
      detail: 'resumed',
    });
    expect(seen[0]!.previousStatus).toBe('paused');
  });

  test('an unreadable state file at boot does not announce pre-existing goals as new', async () => {
    // A companion whose first read is torn — a state file mid-replace, which is
    // a real window because the server writes it with mkdir+writeFile — used to
    // baseline on the empty result, and the next tick then synthesised a
    // `create` for every goal the user had been running. The policy renders
    // that as "Goal started", so the claim was about goals that were not new at
    // all. This is the hole the shipped sentence claimed was closed, so it is
    // asserted rather than described.
    const dir = await mkdtemp(join(tmpdir(), 'toast-torn-'));
    const goalsDir = join(dir, '.opencode', 'goals', 'sessions', 'ses-1');
    await mkdir(goalsDir, {recursive: true});
    const statePath = join(goalsDir, 'state.json');
    const write = async (body: string): Promise<void> =>
      writeFile(statePath, body, 'utf8');
    const valid = JSON.stringify({
      version: 1,
      goals: [
        {
          goalId: 'g1',
          sessionID: 'ses-1',
          condition: 'ship it',
          status: 'active',
          revision: 3,
          turnCount: 3,
          totalTokens: 30,
          maxTokens: 1000,
          maxTurns: 0,
          tokenBudget: null,
          usage: {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            costKnown: false,
          },
          artifactPointers: [],
          pendingProposal: null,
          claims: [],
          lastClaim: null,
          stopReason: '',
          blockedReason: '',
          history: [],
        },
      ],
      results: [],
      sessionOrdered: [],
    });

    const store = createTuiStateStore();
    const seen: GoalTuiEvent[] = [];
    const loop = createDiskRefreshLoop({
      directory: dir,
      store,
      onEvent: e => {
        seen.push(e);
      },
    });

    await write('{ this is not json'); // torn: the file exists, the content does not parse
    await loop.tick();
    await write(valid);
    await loop.tick();
    expect(seen.filter(e => e.kind === 'create')).toHaveLength(0);
    loop.stop();

    // An EMPTY workspace is different and must still baseline, or the very
    // first goal a user ever creates would never be announced. Here the create
    // IS genuine: the goal did not exist a moment ago.
    const empty = await mkdtemp(join(tmpdir(), 'toast-empty-'));
    const seen2: GoalTuiEvent[] = [];
    const store2 = createTuiStateStore();
    const loop2 = createDiskRefreshLoop({
      directory: empty,
      store: store2,
      onEvent: e => {
        seen2.push(e);
      },
    });
    await loop2.tick();
    await mkdir(join(empty, '.opencode', 'goals', 'sessions', 'ses-1'), {
      recursive: true,
    });
    await writeFile(
      join(empty, '.opencode', 'goals', 'sessions', 'ses-1', 'state.json'),
      valid,
      'utf8',
    );
    await loop2.tick();
    expect(seen2.filter(e => e.kind === 'create')).toHaveLength(1);
    loop2.stop();
  });

  test('the disk-refresh loop sends it on every diff', async () => {
    // The loop is what a v1 or v2 companion actually runs: without a previous
    // status it cannot tell "started working" from "still working", and the
    // whole policy above would be unreachable in production.
    const dir = await mkdtemp(join(tmpdir(), 'toast-loop-'));
    const goalsDir = join(dir, '.opencode', 'goals', 'sessions', 'ses-1');
    await mkdir(goalsDir, {recursive: true});
    const statePath = join(goalsDir, 'state.json');
    const write = async (status: string, revision: number): Promise<void> => {
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          goals: [
            {
              goalId: 'g1',
              sessionID: 'ses-1',
              condition: 'ship it',
              status,
              revision,
              turnCount: revision,
              totalTokens: revision * 10,
              maxTokens: 1000,
              maxTurns: 0,
              tokenBudget: null,
              usage: {
                input: 0,
                output: 0,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                costKnown: false,
              },
              artifactPointers: [],
              pendingProposal: null,
              claims: [],
              lastClaim: null,
              stopReason: status === 'paused' ? 'no progress' : '',
              blockedReason: '',
              history: [],
            },
          ],
          results: [],
          sessionOrdered: [],
        }),
        'utf8',
      );
    };
    const store = createTuiStateStore();
    const seen: GoalTuiEvent[] = [];
    const loop = createDiskRefreshLoop({
      directory: dir,
      store,
      onEvent: e => {
        seen.push(e);
      },
    });
    await write('paused', 1);
    await loop.tick(); // silent baseline
    await write('active', 2); // the session-resume re-arm, as the disk shows it
    await loop.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.previousStatus).toBe('paused');
    expect(seen[0]!.snapshot?.status).toBe('active');
    // And the policy now recognises it as the moment it is.
    expect(shouldToast(seen[0]!)).toBe(true);
    loop.stop();
  });
});

// The wiring, driven through the real v1 companion

interface RecordedToast {
  variant: string;
  title: string;
  message: string;
}

function createMockApi(toasts: RecordedToast[]): unknown {
  return {
    client: {session: {command: async () => ({data: {}})}},
    route: {
      get current() {
        return {name: 'home', params: {}};
      },
      register: () => () => {},
      navigate: () => {},
    },
    keymap: {
      registerLayer: () => () => {},
    },
    ui: {
      toast: (input: RecordedToast) => {
        toasts.push(input);
      },
      dialog: {
        replace: () => {},
        clear: () => {},
        setSize: () => {},
        size: 'medium',
        depth: 0,
        open: false,
      },
      DialogAlert: (p: unknown) => p,
      DialogPrompt: (p: unknown) => p,
      DialogSelect: (p: unknown) => p,
    },
    event: {
      on: () => () => {},
    },
    attention: {notify: () => ({ok: true})},
    lifecycle: {
      onDispose: () => {},
    },
  };
}

/**
 * Write goal state at the path a companion actually reads. The fixtures used to
 * write `<root>/state.json`, which was the only file there was; leaving them
 * there would make every companion assertion below a test that passes for the
 * wrong reason, since the companion would find nothing and assert on an empty
 * store.
 */
async function makeStateDir(
  goals: Array<Record<string, unknown>>,
  sessionID = 'ses-1',
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'toast-companion-'));
  const goalsDir = join(dir, '.opencode', 'goals', 'sessions', sessionID);
  await mkdir(goalsDir, {recursive: true});
  await writeFile(
    join(goalsDir, 'state.json'),
    JSON.stringify({
      version: 1,
      goals,
      results: [],
      sessionOrdered: [],
    }),
    'utf8',
  );
  return dir;
}

function diskGoal(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    goalId: 'g1',
    sessionID: 'ses-1',
    condition: 'ship the release',
    status: 'active',
    revision: 1,
    turnCount: 1,
    totalTokens: 0,
    maxTokens: 1000000,
    maxTurns: 0,
    tokenBudget: null,
    usage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costKnown: false,
    },
    artifactPointers: [],
    pendingProposal: null,
    claims: [],
    lastClaim: null,
    stopReason: '',
    blockedReason: '',
    pausedAt: 0,
    history: [],
    ...overrides,
  };
}

describe('the v1 companion tells the user', () => {
  test('one briefing on load for goals that are waiting, and no toast storm around it', async () => {
    const toasts: RecordedToast[] = [];
    const dir = await makeStateDir([
      diskGoal({goalId: 'stuck', status: 'paused', stopReason: 'no progress'}),
      diskGoal({
        goalId: 'held',
        status: 'blocked',
        blockedReason: 'needs creds',
      }),
      // Self-resolving and running: neither belongs in a briefing.
      diskGoal({goalId: 'resuming', status: 'paused', stopReason: 'recovery'}),
      diskGoal({goalId: 'working', status: 'active', revision: 2}),
    ]);
    await initTui(createMockApi(toasts), {directory: dir});
    const briefings = toasts.filter(t => t.message.includes('need you'));
    expect(briefings).toHaveLength(1);
    expect(briefings[0]!.message).toContain('2 goals need you');
    // Hydration is silent about what it found: no "Goal started" for goals the
    // user never asked about in this window.
    expect(toasts.filter(t => t.message.includes('Goal started'))).toHaveLength(
      0,
    );
  });

  test('a yield the plugin can no longer re-arm IS in the briefing', async () => {
    // The user-visible consequence of. Before the bound, this goal was
    // paused with stopReason "user intervention", so the briefing EXCLUDED it as
    // self-resolving and returned null — while every surface rendered "re-arms
    // automatically". A goal that had stopped and would not restart, and not one
    // word about it. Asserted on the briefing's OWN return value rather than on
    // the predicate, because the predicate is the thing that was wrong.
    const toasts: RecordedToast[] = [];
    const dir = await makeStateDir([
      diskGoal({
        goalId: 'stuck-yield',
        status: 'paused',
        stopReason: 'user intervention',
        // The PROMISE instant, which is what the bound reads. A disk fixture that
        // set only `pausedAt` briefed for the wrong reason: the elapsed clock was
        // being measured, so the test passed while the promise went unread.
        stoppedAt: Date.now() - (YIELD_PROMISE_MS + 60_000),
      }),
    ]);
    await initTui(createMockApi(toasts), {directory: dir});
    // Asserted synchronously, and the delivery IS synchronous: the coalescer
    // emits on the spot when nothing has been emitted under the briefing key
    // yet, which is the case in a fresh companion. Measured, after this test had
    // spent three revisions blaming the 2s rate limit and the 500ms auto-flush
    // for a failure that was this line's own substring: the message reads
    // "1 goal needs you", so `.includes("need you")` never matched anything and
    // the test asserted on an empty array for a goal that had briefed correctly
    // all along. Two lessons, both already in this file: a failing assertion is
    // evidence about the ASSERTION before it is evidence about the code, and a
    // theory about scheduling is a claim until it is measured.
    const briefings = toasts.filter(t => t.message.includes('needs you'));
    expect(briefings).toHaveLength(1);
    expect(briefings[0]!.message).toContain('1 goal needs you');
  });

  test('a yield the plugin CAN still re-arm is NOT in the briefing', async () => {
    // The control, and the half of the fix that protects the feature. A change
    // that briefed every yield would pass the test above and stop the plugin
    // telling the user anything about goals that are about to resume on their
    // own — the exact thing SELF_RESOLVING_STOP_REASONS exists to avoid.
    const toasts: RecordedToast[] = [];
    const dir = await makeStateDir([
      diskGoal({
        goalId: 'brief-yield',
        status: 'paused',
        stopReason: 'user intervention',
        stoppedAt: Date.now() - 20_000,
      }),
    ]);
    await initTui(createMockApi(toasts), {directory: dir});
    // Wait out the coalescer's flush window before asserting ABSENCE, or this
    // passes for the wrong reason: a toast not yet delivered is
    // indistinguishable from a toast that will never be delivered.
    expect(toasts.filter(t => t.message.includes('needs you'))).toHaveLength(0);
  });

  test('a workspace with nothing waiting produces no briefing at all', async () => {
    const toasts: RecordedToast[] = [];
    const dir = await makeStateDir([
      diskGoal({status: 'active'}),
      diskGoal({
        goalId: 'g2',
        status: 'paused',
        stopReason: 'queued',
      }),
    ]);
    await initTui(createMockApi(toasts), {directory: dir});
    expect(toasts.filter(t => t.message.includes('need you'))).toHaveLength(0);
  });
});
