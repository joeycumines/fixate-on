import {describe, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
  isSelfResolvingStop,
  isYieldingPause,
  isYieldPastPromise,
  statusTag,
  stopReasonLabel,
  USER_INTERVENTION_STOP_REASON,
  YIELD_PROMISE_MS,
} from '../src/status-label.ts';
import {formatStatusHeadline} from '../src/commands.ts';
import {goalNeedsTheUser, reasonForGoal} from '../src/tui-toast-policy.ts';
import type {GoalTuiSnapshot} from '../src/tui-state.ts';
import {serializeGoalForTui} from '../src/tui-state.ts';
import {parseStateFileGoals} from '../src/tui-disk-state.ts';
import {createGoalState, type GoalState} from '../src/state-machine.ts';
import {formatGoalStatusDashboard, goalListRow} from '../src/tui-views.ts';

// PAUSED-VISIBILITY-1
//
// the user: "goals seem to be indicated in the dashboard as 'paused' a lot more than
// I expected, even while the model is still working on the goal."
//
// Measured live on stock v1: one human message paused a working goal at 17:21:22
// and it re-armed at 17:21:43. During that 21-second window the goal IS working
// on the user's instruction, but the list row read a bare `[paused]` and the v2
// card read `Status: paused` with no reason line at all — indistinguishable from
// a brake or stall halt that waits for `/goal resume`.
//
// The pause is the deliberate behaviour. The DISPLAY was the defect.

const SRC = join(import.meta.dir, '..', 'src');

describe('a yield to the human is distinguishable from a halt', () => {
  test('isYieldingPause recognises exactly the user-intervention pause', () => {
    expect(isYieldingPause('paused', USER_INTERVENTION_STOP_REASON)).toBe(true);
    // Every other paused flavour is a halt, not a yield.
    expect(isYieldingPause('paused', 'no tool calls')).toBe(false);
    expect(isYieldingPause('paused', 'no progress')).toBe(false);
    expect(isYieldingPause('paused', 'paused')).toBe(false);
    expect(isYieldingPause('paused', 'budget exhausted')).toBe(false);
    // And an ACTIVE goal is never yielding, whatever reason is left behind.
    expect(isYieldingPause('active', USER_INTERVENTION_STOP_REASON)).toBe(
      false,
    );
  });

  test('the list-row tag distinguishes a yield from a plain pause', () => {
    expect(statusTag('paused', USER_INTERVENTION_STOP_REASON)).toBe(
      'paused: yielding',
    );
    expect(statusTag('paused', 'no tool calls')).toBe('paused');
    expect(statusTag('active', '')).toBe('active');
    expect(statusTag('blocked', 'blocked (verifier: BLOCKED)')).toBe('blocked');
  });

  test('the detail label says what is true AND what happens next', () => {
    expect(stopReasonLabel(USER_INTERVENTION_STOP_REASON)).toBe(
      'yielding to your message; re-arms automatically',
    );
  });

  test('every OTHER stopReason passes through unchanged', () => {
    // These are already accurate. Inventing wording for them would be a claim
    // about behaviour that was never measured.
    for (const reason of [
      'no tool calls',
      'no progress',
      'paused',
      'budget exhausted',
      'explicit pause',
    ]) {
      expect(stopReasonLabel(reason)).toBe(reason);
    }
  });
});

// The standardisation lock

describe('every status surface routes through status-label.ts', () => {
  // `tui.ts` was on this list until 2026-09-30, when the v1 list row moved into
  // `goalListRow` in tui-views.ts so the row's cross-session attribution could
  // be asserted against a returned value instead of a source string. The row
  // still routes through statusTag — via tui-views.ts, which is below — and
  // `the v1 LIST ROW renders the tag` in this file now drives goalListRow
  // directly. Removing a file from a sweep is only honest when something else
  // still holds the line, so both facts are asserted.
  //
  // `tui-dashboard-route.tsx` left this list on the same reasoning, the same day:
  // the v2 card's lines now come from `goalCardLines` in tui-views.ts, because
  // rendering the host component needs the host's terminal renderer and a rule no
  // test can execute is a comment. The card's `Stop:` line is built there through
  // `stopReasonLabel`, tui-views.ts is still on this list, and the v2 card's
  // rendered text — including the stop reason and the yield wording — is asserted
  // directly in cross-session-attribution.test.ts. What the route still owns is
  // the layout, and layout is not a place a ledger token can leak.
  const SURFACES = [
    'tui-views.ts', // v1 detail card, the v1 cockpit list row, AND the v2 card
    'commands.ts', // /goal status + the goal list
  ];

  for (const file of SURFACES) {
    test(`${file} imports the shared status label`, async () => {
      const source = await readFile(join(SRC, file), 'utf8');
      expect(source).toMatch(/from\s+["']\.\/status-label\.ts["']/);
    });
  }

  test("no RENDER surface emits the raw 'user intervention' token to a user", async () => {
    // The literal is the LEDGER's token. It must reach a reader only through the
    // translation above, never printed raw.
    //
    // SCOPE MATCHES THE CLAIM. A first revision swept all of src/ and flagged
    // hooks.ts and continuation-loop.ts — but every hit there is the PRODUCER
    // (`stopReason: "user intervention"`) or a LOGIC comparison
    // (`g.stopReason === "user intervention"`), which must contain the token.
    // The verifiable claim is about the surfaces that RENDER, so the sweep is
    // scoped to exactly those. This is the recorded lesson applied: the claim's
    // scope must equal the search's scope.
    for (const file of SURFACES) {
      const source = await readFile(join(SRC, file), 'utf8');
      expect(
        source,
        `${file} must translate the ledger token before rendering it`,
      ).not.toContain('"user intervention"');
    }
  });

  test('no RENDER surface interpolates a stopReason without translating it', async () => {
    // SCOPE MATCHES THE CLAIM, which is the whole point of this test. A literal
    // sweep for the string `"user intervention"` is NON-VACUOUS but INCOMPLETE:
    // it caught nothing in `commands.ts`, yet `Goal is already paused
    // (${goal.stopReason || goal.status})` rendered the raw ledger token to a
    // user through a VARIABLE. The first version of this test therefore passed
    // over a live leak — the exact "the claim's scope must equal the search's
    // scope" failure recorded in the audit-method entry.
    //
    // So this asserts the CLASS: in a render surface, a `stopReason` value may
    // only reach an interpolated string or a JSX text child by passing through
    // the translation (`stopReasonLabel`/`statusTag`).
    // TWO SHAPES, EACH SCOPED TO WHERE IT CAN ACTUALLY BE A RENDER.
    //
    // 1. Template-literal interpolation, in ANY surface: this is the shape that
    // leaked (`Goal is already paused (${goal.stopReason || goal.status})`).
    // 2. A JSX expression child, in.tsx ONLY. A bare `{...}` is ambiguous in a
    //.ts file — `{ source: "slash-command", stopReason: "paused" }` is an
    // OBJECT literal and `=> {... }` is a function body, neither of which
    // renders anything. Flagging those made an earlier revision of this test
    // cry wolf twice; the class check is only meaningful where JSX can exist.
    //
    // The JSX arm must accept `}` as well as `>` as the preceding character,
    // or it misses the shape this very codebase uses: the v2 card renders
    // `{" Stop: "}{stopReasonLabel(snap.stopReason)}`, whose
    // interpolation follows the CLOSING BRACE of the previous child. An
    // earlier `/>\s*\{/`-anchored version matched only a FIRST child, so a
    // regression that dropped the translation from the second child would
    // have left the suite green — and `tui-dashboard-route.tsx` has no unit
    // test, so this lock is that surface's only guard. Verified by probe: the
    // `(?:>|})` form flags direct children, second children and translated
    // calls, and still does not flag a plain object literal.
    const templateInterpolation = /\$\{[^}]*\bstopReason\b[^}]*\}/g;
    const jsxExpressionChild = /(?:>|\})\s*\{[^{}]*\bstopReason\b[^{}]*\}/g;
    for (const file of SURFACES) {
      const source = await readFile(join(SRC, file), 'utf8');
      const patterns = file.endsWith('.tsx')
        ? [templateInterpolation, jsxExpressionChild]
        : [templateInterpolation];
      for (const pattern of patterns) {
        for (const hit of source.match(pattern) ?? []) {
          expect(
            /stopReasonLabel\(|statusTag\(/.test(hit),
            `${file}: "${hit.trim()}" renders stopReason without stopReasonLabel()/statusTag()`,
          ).toBe(true);
        }
      }
    }
  });

  test('the sweep CAN fail — it catches a raw interpolation (self-check)', () => {
    // A lock that cannot fail is worthless. Show the pattern rejects the shape
    // that leaked, and accepts the shape that is correct.
    const bad =
      'return `Goal is already paused (${goal.stopReason || goal.status}).`';
    const good =
      "lines.push(`Stopped: ${stopReasonLabel(goal.stopReason || 'unknown')}`)";
    const goodTag =
      'title: `${idx}. [${statusTag(s.status, s.stopReason)}] ${s.condition}`';
    const pattern = /\$\{[^}]*\bstopReason\b[^}]*\}/g;
    const check = (src: string): boolean =>
      (src.match(pattern) ?? []).every(hit =>
        /stopReasonLabel\(|statusTag\(/.test(hit),
      );
    expect(check(bad)).toBe(false);
    expect(check(good)).toBe(true);
    expect(check(goodTag)).toBe(true);
  });

  test('the v1 LIST ROW renders the tag, not a bare status (the sweep cannot see this)', async () => {
    // The sweep above keys on the presence of `stopReason` in an interpolation,
    // which is exactly what a REGRESSION removes: reverting the row to a bare
    // status leaves no `stopReason` to match, so the sweep stays green and the
    // yield silently reads as a plain pause again. Measured: that revert passes
    // the whole suite.
    //
    // This used to be a SOURCE-TEXT assertion on `tui.ts`, with a comment saying
    // the row lives inside `renderGoalList`, needs a renderer, and therefore
    // "cannot be unit-tested". That reason no longer holds: the 2026-09-30
    // cross-session attribution work extracted the row into `goalListRow` in
    // tui-views.ts precisely so the labelling would be a function with a return
    // value. The lock is therefore BEHAVIOURAL — it reads the text the product
    // builds — and the source assertion survives only for the WIRING, which is
    // still a fact about tui.ts rather than about a value.
    const tui = await readFile(join(SRC, 'tui.ts'), 'utf8');
    expect(
      tui,
      'the v1 list must still be built by the one shared row builder',
    ).toContain('goalListRow(');

    const yielding = yieldingSnapshot();
    const row = goalListRow(yielding, 0, yielding.sessionID);
    expect(row.title).toContain('[paused: yielding]');
    expect(row.title).not.toMatch(/\[paused\]/);

    // And a genuine halt must still read as a halt, or "yielding" has swallowed
    // the distinction the whole tag exists to keep.
    const halted = yieldingSnapshot({stopReason: 'paused'});
    expect(goalListRow(halted, 0, halted.sessionID).title).toContain(
      '[paused]',
    );
    expect(goalListRow(halted, 0, halted.sessionID).title).not.toContain(
      'yielding',
    );
  });

  test('the token still has exactly one PRODUCER in the chat.message handler and the logic that reads it', async () => {
    // Guard against the sweep above being satisfied by deleting the token
    // everywhere: the producer and the re-arm comparison must still exist, or
    // the yield would never be created or cleared. single-homed the
    // token onto USER_INTERVENTION_STOP_REASON, so both are asserted in that
    // form — a bare literal producer here would be the duplication the
    // single-homing exists to remove. The producer lives in the chat.message
    // handler (hooks-handlers.ts) since the handler factories were extracted.
    const handlers = await readFile(join(SRC, 'hooks-handlers.ts'), 'utf8');
    expect(handlers).toMatch(
      /import \{[^}]*USER_INTERVENTION_STOP_REASON[^}]*\} from '\.\/status-label\.ts'/,
    );
    expect(handlers).toMatch(
      /stopReason: explicitStop\s*\?\s*'explicit pause'\s*:\s*USER_INTERVENTION_STOP_REASON/,
    );
    expect(handlers).toContain(
      'g.stopReason === USER_INTERVENTION_STOP_REASON',
    );
  });
});

// The render itself, not just the helper
//
// The lock above shows the surfaces IMPORT the translation. This drives the
// real v1 detail-card formatter, so the assertion reads text the product
// actually produced rather than a string the fixture hardcoded.

function yieldingSnapshot(
  overrides: Partial<GoalTuiSnapshot> = {},
): GoalTuiSnapshot {
  return {
    goalId: 'g1',
    sessionID: 's1',
    condition: 'fix the failing tests',
    status: 'paused',
    revision: 1,
    turnCount: 3,
    totalTokens: 12400,
    maxTokens: 200000,
    maxTurns: 10,
    tokenBudget: null,
    usage: {
      input: 100,
      output: 50,
      reasoning: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.02,
      costKnown: true,
    },
    stopReason: USER_INTERVENTION_STOP_REASON,
    blockedReason: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
    ...overrides,
  } as GoalTuiSnapshot;
}

describe('the v1 detail card explains a yield instead of leaving it bare', () => {
  test('a yielding pause reads as yielding and says it re-arms', () => {
    const text = formatGoalStatusDashboard([yieldingSnapshot()])
      .map(s => s.text ?? '')
      .join('\n');
    expect(text).toContain('yielding to your message; re-arms automatically');
    // The ledger token must NOT reach the reader.
    expect(text).not.toContain('user intervention');
  });

  test('a brake/stall halt still reads as its own reason, unchanged', () => {
    const text = formatGoalStatusDashboard([
      yieldingSnapshot({stopReason: 'no tool calls'}),
    ])
      .map(s => s.text ?? '')
      .join('\n');
    expect(text).toContain('no tool calls');
    expect(text).not.toContain('yielding to your message');
  });
});

// The default `/goal status` instruction
//
// `formatStatusHeadline` is the DEFAULT surface (README.md:188) and its last line
// is an instruction. For every non-active goal it read "run /goal resume", without
// consulting stopReason — so a goal paused mid-yield, which is what the plugin
// does to every active goal on every human message and undoes on the next idle,
// read exactly like a brake stop.
//
// The consequence is not cosmetic. `resume` sets `turnCount = 0` (commands.ts), so
// a user who polls status during a yield and follows the printed advice silently
// wipes the goal's turn accounting. This is the only instruction on this surface
// that can destroy state, and the verbose wall next to it was already correct,
// which is why the existing assertions here never saw it: test/status-label.test.ts
// covered the surface that was right.
describe('the default status instruction matches what will actually happen', () => {
  const goal = (overrides: Partial<GoalState>): GoalState =>
    ({
      goalId: 'g1',
      runId: 'r1',
      revision: 3,
      condition: 'fix the failing tests',
      successCriteria: '',
      constraints: '',
      artifactPointers: [],
      pendingProposal: null,
      mode: 'normal',
      sessionID: 's1',
      tokenBudget: null,
      maxTokens: 200000,
      maxTurns: 10,
      maxDurationMs: 0,
      turnCount: 3,
      totalTokens: 12400,
      compactionBaselineTokens: 0,
      usage: {
        input: 100,
        output: 50,
        reasoning: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.02,
        costKnown: true,
      },
      status: 'paused',
      stopReason: 'paused',
      blockedReason: '',
      finalizing: false,
      continuationClaim: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      pausedAt: Date.now(),
      finishedAt: null,
      history: [],
      ...overrides,
    }) as GoalState;

  // A table rather than two assertions, because the change must not be
  // satisfiable by DELETING the instruction: a headline that says nothing about
  // what to do next would pass a "does not say resume" check and be a worse
  // surface than the one it replaced.
  test('a self-resolving stop names the re-arm; every other stop still offers resume', () => {
    const cases: Array<[string, string, string | undefined, boolean]> = [
      ['yielding', 'paused', USER_INTERVENTION_STOP_REASON, false],
      ['recovered, awaiting the first idle', 'paused', 'recovery', false],
      ['queued behind an ordered sequence', 'paused', 'queued', false],
      ['user paused it', 'paused', 'paused', true],
      ['explicit pause', 'paused', 'explicit pause', true],
      ['stalled on progress', 'paused', 'no progress', true],
      ['no tool calls', 'paused', 'no tool calls', true],
      ['max turns', 'paused', 'max turns', true],
      ['blocked', 'blocked', 'blocked', true],
      // TERMINAL, carrying a stop reason that is otherwise self-resolving. It has
      // no transitions out, so it can never re-arm — and claiming it will is the
      // one instruction on this surface that would then be a lie. The first
      // version of `isSelfResolvingStop` admitted this status, which was
      // unreachable in a live host and therefore untested; this row is what makes
      // the admission a failure rather than a dormant clause.
      [
        'budget-exhausted (TERMINAL, never re-arms)',
        'budgetLimited',
        'recovery',
        true,
      ],
      ['complete (TERMINAL)', 'complete', 'recovery', true],
    ];
    const actual = cases.map(([name, status, stopReason]) => {
      const text = formatStatusHeadline(
        goal({status: status as GoalState['status'], stopReason}),
      );
      return [
        name,
        text.includes('resume') ? 'offers resume' : 'names the re-arm',
      ] as [string, string];
    });
    console.log('STATUS-INSTRUCTION ' + JSON.stringify(actual));
    expect(actual).toEqual(
      cases.map(([name, , , offersResume]) => [
        name,
        offersResume ? 'offers resume' : 'names the re-arm',
      ]),
    );
  });

  test('no TERMINAL status is ever reported as self-resolving, whatever its stop reason', () => {
    // The predicate and the toast policy's sibling must agree on the input, or one
    // of them is answering a different question than its name says. This is the
    // direct form of that agreement, and it is what makes the table row above
    // redundant double-check rather than merely descriptive: re-admitting `budgetLimited`
    // turns THIS red as well as the row.
    for (const status of [
      'budgetLimited',
      'complete',
      'blocked',
      'active',
    ] as const) {
      for (const reason of [
        'recovery',
        USER_INTERVENTION_STOP_REASON,
        'queued',
        'paused',
        '',
      ]) {
        expect(
          isSelfResolvingStop(status, reason),
          `${status}/${reason || '(empty)'} must not be reported as resuming by itself`,
        ).toBe(false);
      }
    }
    // And the one that IS self-resolving, so the assertion above is not vacuous.
    expect(isSelfResolvingStop('paused', USER_INTERVENTION_STOP_REASON)).toBe(
      true,
    );
  });

  test("the headline's next-duty line branches on the PROMISE, not the elapsed clock", () => {
    // `/goal status` is the surface that decides whether to tell a user to run a
    // resume which ZEROES turnCount, so a wrong promise here does the most damage
    // of the four surfaces — and it is the one's claim of "four surfaces"
    // left unwired for a whole commit.
    //
    // The shape is the one a real conversation produces: paused 16 minutes ago,
    // promise renewed 2 seconds ago because the human has been talking. With both
    // clocks set to "now" the two are indistinguishable and a mutation survives the
    // test, so the ELAPSED clock is deliberately OLD and the PROMISE deliberately
    // FRESH. Exactly one variable, and it is the variable under test.
    const freshPromise = goal({
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      pausedAt: Date.now() - 16 * 60_000,
      stoppedAt: Date.now() - 2_000,
      updatedAt: Date.now() - 2_000,
    });
    const freshPromiseText = formatStatusHeadline(freshPromise);
    expect(
      freshPromiseText,
      'a promise renewed seconds ago still resolves itself',
    ).toContain('re-arms automatically');
    expect(
      freshPromiseText,
      'and must not offer a resume, which would zero the turn count',
    ).not.toContain('run /goal resume');

    // The overdue half, through the same surface. Before the fix this printed
    // "nothing — … did not re-arm" beside a briefing that said the goal needed
    // the user: two surfaces contradicting each other in the same view.
    const overdue = goal({
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      pausedAt: Date.now() - (YIELD_PROMISE_MS + 60_000),
      stoppedAt: Date.now() - (YIELD_PROMISE_MS + 60_000),
      updatedAt: Date.now() - (YIELD_PROMISE_MS + 60_000),
    });
    const overdueText = formatStatusHeadline(overdue);
    // The load-bearing distinction on THIS surface, and the one that matters most:
    // whether the plugin still believes it will resume by itself. The headline does
    // not print the stop reason — it prints the next duty — so the promise shows up
    // here as the PRESENCE or ABSENCE of a resume instruction.
    //
    // (A first version of this assertion expected the words "did not re-arm" here
    // and failed, because those are the DETAIL CARD's wording. The headline's
    // contract is the instruction, and the instruction is the thing that can
    // destroy a goal: `resume` zeroes turnCount, so printing it for a yield the
    // plugin will undo itself is the harm, and withholding it when the plugin will
    // NOT is the silence.)
    expect(
      overdueText,
      'an overdue promise must stop withholding the resume instruction',
    ).toContain('run /goal resume');
    expect(
      overdueText,
      'and must not claim there is nothing to do',
    ).not.toContain('Next: nothing');
  });

  test("a yielding goal's headline says what is happening, in plain words", () => {
    const text = formatStatusHeadline(
      goal({stopReason: USER_INTERVENTION_STOP_REASON}),
    );
    expect(text).toContain('re-arms automatically');
    // The ledger token must not reach the reader, the same rule the detail card
    // and the list row already hold.
    expect(text).not.toContain('user intervention');
    expect(text, 'the brake line is still part of the headline').toContain(
      'Brakes:',
    );
  });
});

// The yield's PROMISE is bounded, D2)
//
// A yield is applied on EVERY human message and re-armed on the next idle. Where
// the host delivers no authentic idle, the poller is the only thing that can
// deliver that, and it refuses in three shapes for good reasons — each
// indefinitely. Measured with a control against 8a9f657:
//
// RE-ARMS the human turn completed, the assistant replied and settled
// STUCK the human's turn is abandoned and no reply ever arrives
// STUCK the assistant reply carries no message id
// STUCK the assistant turn never reports settled
//
// The goal is INERT in every stuck shape — revision 1, no tokens, no turns, so
// nothing is burning. What it costs is that the plugin LIES: the card said
// "re-arms automatically", and the load briefing returned null, because the
// briefing excludes self-resolving stops. A user was told nothing about a goal
// that had stopped and would not restart.
//
// So the bound is on the PLEDGE, not on the poller's gates. The gates are what
// stop a continuation being injected into a live turn, which is a worse harm than
// a goal that waits, and they are untouched.

describe("a yield's promise is bounded, and a stuck yield stops promising", () => {
  const MINUTE = 60_000;
  const now = 10 * 60 * MINUTE;

  test('a yield the poller CAN re-arm keeps every promise it makes', () => {
    // THE CONTROL. A fix that made every yield brief would satisfy the headline
    // clause while destroying the feature the promise exists for. Measured
    // re-arm: first tick, status active, one prompt sent.
    const justYielded = now - 20_000;
    expect(
      isSelfResolvingStop(
        'paused',
        USER_INTERVENTION_STOP_REASON,
        justYielded,
        now,
      ),
    ).toBe(true);
    expect(
      statusTag('paused', USER_INTERVENTION_STOP_REASON, justYielded, now),
    ).toBe('paused: yielding');
    expect(
      stopReasonLabel(
        USER_INTERVENTION_STOP_REASON,
        'paused',
        justYielded,
        now,
      ),
    ).toBe('yielding to your message; re-arms automatically');
  });

  test('a yield past the bound stops being self-resolving, so the briefing can reach it', () => {
    const stuck = now - (YIELD_PROMISE_MS + 1);
    // The predicate the briefing asks is the SAME predicate, not a copy of it —
    // two predicates answering one question is how they come to disagree.
    expect(
      isSelfResolvingStop('paused', USER_INTERVENTION_STOP_REASON, stuck, now),
    ).toBe(false);
    // And the surfaces stop claiming it will move.
    expect(statusTag('paused', USER_INTERVENTION_STOP_REASON, stuck, now)).toBe(
      'paused',
    );
    expect(
      stopReasonLabel(USER_INTERVENTION_STOP_REASON, 'paused', stuck, now),
    ).toBe('yielding to your message; did not re-arm');
  });

  test('the bound is on the YIELD only — recovery and queued keep their promises', () => {
    // `recovery` re-arms on the first idle and `queued` on auto-promote. Neither
    // has a shape the poller refuses, so a bound on them would make a HEALTHY
    // recovered goal brief itself, which is a new false alarm.
    const ancient = now - YIELD_PROMISE_MS * 10;
    expect(isSelfResolvingStop('paused', 'recovery', ancient, now)).toBe(true);
    expect(isSelfResolvingStop('paused', 'queued', ancient, now)).toBe(true);
  });

  test('a yield with no pausedAt is not yet overdue, however old the session is', () => {
    // No evidence it has been waiting is not evidence it has waited. A goal that
    // was never paused reads pausedAt 0, and treating that as "waiting since the
    // epoch" would brief every yield on a freshly started host.
    for (const pausedAt of [0, undefined]) {
      expect(isYieldPastPromise(pausedAt, now)).toBe(false);
      expect(
        isSelfResolvingStop(
          'paused',
          USER_INTERVENTION_STOP_REASON,
          pausedAt,
          now,
        ),
      ).toBe(true);
    }
  });

  test("the bound is read from the goal's own clock, so a restart cannot forgive it", () => {
    // A counter in the poller's closure would reset with the process and
    // silently forgive exactly the case a crash makes likely. `pausedAt` is
    // persisted, so a goal that was already waiting before the restart is
    // judged on how long it has ACTUALLY waited.
    const beforeRestart = now - (YIELD_PROMISE_MS + 60_000);
    // "Now" is the reader's clock, a full bound AFTER the pause — the case a
    // restart produces, because the pause happened in the previous process.
    expect(
      isYieldPastPromise(
        beforeRestart,
        beforeRestart + YIELD_PROMISE_MS + 1_000,
      ),
    ).toBe(true);
    expect(
      isSelfResolvingStop(
        'paused',
        USER_INTERVENTION_STOP_REASON,
        beforeRestart,
        beforeRestart + YIELD_PROMISE_MS + 1_000,
      ),
    ).toBe(false);
  });

  test('the bound is generous enough never to fire on a slow human turn', () => {
    // Its job is to catch a promise the plugin cannot keep, not to time a
    // person out. A human thinking, typing a long message, or a host slow to
    // answer must not be reported as a stuck goal.
    expect(YIELD_PROMISE_MS).toBeGreaterThan(10 * MINUTE);
    const tenMinutesIn = now - 10 * MINUTE;
    expect(
      isSelfResolvingStop(
        'paused',
        USER_INTERVENTION_STOP_REASON,
        tenMinutesIn,
        now,
      ),
    ).toBe(true);
  });

  test('pausedAt survives the trip from state to snapshot, or the bound is blind', () => {
    // M6: the whole bound reads `pausedAt` off the SNAPSHOT, because the
    // surfaces that render a goal never see a GoalState. A snapshot that drops
    // the field therefore does not fail a test — it silently makes every yield
    // read as "never paused", which is exactly the promise the fix withdrew.
    // So the propagation itself is asserted, through the real serializer, rather
    // than assumed because the predicates take it as a parameter.
    const paused = {
      ...createGoalState('ses-1', 'ship', {goalId: 'g1', runId: 'r1'}),
      status: 'paused' as const,
      stopReason: USER_INTERVENTION_STOP_REASON,
      pausedAt: 1_700_000_000_000,
    };
    const snapshot = serializeGoalForTui(paused);
    expect(snapshot.pausedAt).toBe(1_700_000_000_000);
    // And the reader that rebuilds snapshots from persisted bytes must keep it,
    // since a companion reading from disk is the surface the briefing uses.
    const [parsed] = parseStateFileGoals(
      JSON.stringify({version: 1, goals: [paused], results: []}),
      'ses-1',
    );
    expect(parsed).toBeDefined();
    expect(parsed!.pausedAt).toBe(1_700_000_000_000);
  });

  test('goalNeedsTheUser counts a yield past its promise, and only that one', () => {
    // The briefing's own criterion, asserted directly. `summarizeGoalsNeedingYou`
    // is gated elsewhere, but the predicate is where the bound is READ, and a
    // mutant that swapped it back to "is the stopReason in the set" has to die
    // here — which it did not, until this test existed. The control matters as
    // much: a mutant that briefed EVERY yield would satisfy the overdue clause
    // while destroying the reason SELF_RESOLVING_STOP_REASONS exists.
    const overdue = {
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      stoppedAt: now - (YIELD_PROMISE_MS + 1),
    };
    const live = {
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      stoppedAt: now - 20_000,
    };
    expect(goalNeedsTheUser(overdue as never, now)).toBe(true);
    expect(goalNeedsTheUser(live as never, now)).toBe(false);
    // The other self-resolving stops keep their promises, so a mutant that
    // dropped the whole concept fails here too.
    expect(
      goalNeedsTheUser(
        {
          status: 'paused',
          stopReason: 'recovery',
          pausedAt: now - YIELD_PROMISE_MS,
        } as never,
        now,
      ),
    ).toBe(false);
  });

  test("an UNKNOWN stop instant is overdue, not 'not parked'", () => {
    //, and the worse half of the review's finding. A state file written
    // before `stoppedAt` existed has no promise instant, and reading that as "the
    // goal is not stopped" holds the promise FOREVER — which is the original
    // defect, still fully live for exactly the population the fix was written
    // for: a user carrying a stuck yield into the upgrade. Measured through the
    // real disk reader before this rule existed: an overdue yield briefed, a file
    // with no stoppedAt produced no toast at all.
    const stoppedFor = now - (YIELD_PROMISE_MS + 1);
    // No promise instant, but a goal whose last update was long ago: the update
    // is the stop instant or later, so the promise is overdue.
    expect(isYieldPastPromise(0, now, YIELD_PROMISE_MS, stoppedFor)).toBe(true);
    expect(
      isSelfResolvingStop(
        'paused',
        USER_INTERVENTION_STOP_REASON,
        0,
        now,
        stoppedFor,
      ),
    ).toBe(false);
    // And the control: a goal that was never stopped has no update to fall back
    // to either, so 0 keeps meaning only that.
    expect(isYieldPastPromise(0, now, YIELD_PROMISE_MS, undefined)).toBe(false);
    // A stop instant in the FUTURE means the reader's clock is behind the
    // writer's, and `now - since` would be negative and hold the promise open
    // indefinitely. One NTP step back must not pin a stuck goal's promise shut.
    expect(isYieldPastPromise(now + 3 * 86_400_000, now)).toBe(true);
  });

  test('the briefing never renders the ledger token for an overdue yield', () => {
    // M5: reintroducing the raw token as the briefing reason must go red. It is
    // reachable, and it is worse than being silent — "1 goal needs you: user
    // intervention" sits in a list beside "needs creds" and "no progress" and
    // tells the reader nothing about a goal that has stopped for good.
    const overdue = {
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      stoppedAt: now - (YIELD_PROMISE_MS + 1),
    };
    expect(reasonForGoal(overdue as never, now)).toBe(
      'it did not pick your message back up',
    );
    expect(reasonForGoal(overdue as never, now)).not.toContain(
      'user intervention',
    );
    // And the control: a yield still inside its promise is not briefed at all,
    // so it must not acquire this wording either.
    const live = {
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      stoppedAt: now - 20_000,
    };
    expect(reasonForGoal(live as never, now)).toBe(
      USER_INTERVENTION_STOP_REASON,
    );
  });

  test('a non-paused goal is never self-resolving, whatever it is waiting on', () => {
    expect(
      isSelfResolvingStop(
        'active',
        USER_INTERVENTION_STOP_REASON,
        now - YIELD_PROMISE_MS,
        now,
      ),
    ).toBe(false);
    expect(
      isSelfResolvingStop(
        'budgetLimited',
        USER_INTERVENTION_STOP_REASON,
        now - YIELD_PROMISE_MS,
        now,
      ),
    ).toBe(false);
  });
});
