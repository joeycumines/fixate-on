// cross-session-attribution.test.ts — a goal that is not this session's SAYS SO.
//
// The defect, reported live on 2026-09-30: a session with no goal of its own
// opened the cockpit, and the cockpit showed another session's goal as
// `1. [active] Investigate and DEEPLY analyse…` while `get_goal` and
// `list_goals` both answered that no goal existed for this thread. Both were
// telling the truth, and NOTHING on screen said they were talking about
// different sessions — so the only reading available was that the goal state was
// broken.
//
// The cause is deliberate and stays: `getCockpitSnapshots` (src/tui.ts) falls
// back to every session's goals when the active session has none, because at
// plugin load no session exists yet and a resumed session's goal must be
// readable before it is attached. The fix is not to remove the fallback — that
// re-breaks auto-resume, which this repository has a scar for — but to make a
// fallback listing identify itself.
//
// One decision, one place: `isForeignGoal` / `foreignSessionLabel` /
// `fallbackNotice` / `goalListRow` in src/tui-views.ts. Both companions route
// through them, so the two cannot drift into disagreeing about whose goal is on
// screen, which is the failure this file exists to prevent.

import {describe, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
  dashboardGoalActions,
  fallbackNotice,
  foreignSessionLabel,
  formatGoalStatusDashboard,
  goalCardLines,
  goalListRow,
  isForeignGoal,
  resolveFocusedGoalId,
} from '../src/tui-views.ts';
import type {GoalTuiSnapshot} from '../src/tui-state.ts';
import {createTuiStateStore} from '../src/tui-state.ts';
import {
  USER_INTERVENTION_STOP_REASON,
  YIELD_PROMISE_MS,
} from '../src/status-label.ts';

function snap(overrides: Partial<GoalTuiSnapshot> = {}): GoalTuiSnapshot {
  return {
    goalId: 'g1',
    sessionID: 'ses_mine',
    condition: 'fix the failing tests',
    status: 'active',
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
    stopReason: '',
    blockedReason: '',
    pausedAt: 0,
    stoppedAt: 0,
    createdAt: 1,
    updatedAt: 2,
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
    origin: 'disk',
    ...overrides,
  };
}

const MINE = 'ses_mine';
const THEIRS = 'ses_f1090be92ffe9HNS1OIE0hjEEj';

describe('whose goal is on screen', () => {
  test('a goal owned by another session is labelled, in both renderings', () => {
    const foreign = snap({sessionID: THEIRS, goalId: 'g-foreign'});

    // The list row: the v1 cockpit's DialogSelect.
    const row = goalListRow(foreign, 0, MINE);
    expect(row.description).toContain('Another session');
    expect(row.description).toContain(foreignSessionLabel(foreign));
    expect(row.description).toContain('Tokens:');
    // The status is still rendered — the attribution is added, not substituted.
    expect(row.title).toContain('[active]');

    // The detail card: formatGoalStatusDashboard, which both companions use.
    const sections = formatGoalStatusDashboard([foreign], MINE);
    const detail = sections.map(x => x.text).join('\n');
    expect(detail).toContain('another session');
    expect(detail).toContain(foreignSessionLabel(foreign));
    expect(detail).toContain('Investigate'.slice(0, 0) + foreign.condition);
  });

  test("this session's own goal carries no attribution", () => {
    const mine = snap();
    expect(goalListRow(mine, 0, MINE).description).not.toContain(
      'Another session',
    );
    const detail = formatGoalStatusDashboard([mine], MINE)
      .map(x => x.text)
      .join('\n');
    expect(detail).not.toContain('another session');
    expect(detail).not.toContain('Session:');
    expect(fallbackNotice([mine], MINE)).toBeNull();
  });

  test("a listing that is entirely other sessions' says this session has no goals", () => {
    // The exact case the user hit: her session owned nothing, so the cockpit fell
    // back and showed one goal that belonged to a session that was still running.
    const foreign = snap({
      sessionID: THEIRS,
      goalId: 'g-foreign',
      status: 'active',
    });
    const notice = fallbackNotice([foreign], MINE);
    expect(notice).not.toBeNull();
    expect(notice).toContain('This session has no goals');
    expect(notice).toContain('other session');

    // And it is a section on the dashboard, not a comment nobody renders.
    const titles = formatGoalStatusDashboard([foreign], MINE).map(x => x.title);
    expect(titles.some(t => t.includes('Sessions shown'))).toBe(true);
  });

  test('a mixed listing counts both sides rather than implying all of it is mine', () => {
    const mine = snap({goalId: 'g-mine'});
    const foreign = snap({sessionID: THEIRS, goalId: 'g-foreign'});
    const notice = fallbackNotice([mine, foreign], MINE);
    expect(notice).toContain('alongside');
    expect(notice).toContain('other session');
  });

  test('with no session route yet, ownership is unknown and nothing is claimed', () => {
    // `activeSessionID` returns null on a cold TUI. Calling every row another
    // session's there would be its own kind of lie — the plugin would be
    // asserting a boundary it cannot see.
    const any = snap({sessionID: THEIRS});
    expect(isForeignGoal(any, null)).toBe(false);
    expect(fallbackNotice([any], null)).toBeNull();
    expect(goalListRow(any, 0, null).description).not.toContain(
      'Another session',
    );
  });

  test('two sessions that share a long prefix are still told apart', () => {
    // A 12-character prefix was the first cut and it was wrong: session ids
    // share their `ses_` head, so a prefix label collapses the very sessions it
    // exists to separate. The tail is where they differ.
    const a = foreignSessionLabel(snap({sessionID: 'ses_aaaaaaaaaaa1'}));
    const b = foreignSessionLabel(snap({sessionID: 'ses_aaaaaaaaaaa2'}));
    expect(a).not.toBe(b);
    expect(a).toBe('ses_aaaaaaaaaaa1');
    expect(foreignSessionLabel(snap({sessionID: THEIRS}))).toBe(THEIRS);
  });

  test('the yield tag still renders beside the attribution, not instead of it', () => {
    // Both features landed in the same week; neither may eat the other. A goal
    // that is BOTH yielding and foreign must say both.
    const foreignYielding = snap({
      sessionID: THEIRS,
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      // A LIVE yield. The row's tag is conditional on the promise still holding,
      // which is measured from the stop instant — and the fixture's sentinel
      // `updatedAt` is 1970, so a yield with no instant reads as long overdue.
      stoppedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const row = goalListRow(foreignYielding, 0, MINE);
    expect(row.title).toContain('[paused: yielding]');
    expect(row.description).toContain('Another session');
  });
});

// The focus pointer is what the dashboard's pause / resume / clear buttons act
// on, and every one of those commands is addressed to THIS session. Before
// resolveFocusedGoalId existed this behaviour lived in a closure inside the v2
// plugin registration: reverting it to "the last goal of any session" passed the
// ENTIRE suite, because nothing could reach it. That is this repository's own
// recorded dead-guard pattern, and the reason the rule lives in a function.
describe("the dashboard focus pointer never lands on another session's goal", () => {
  const storeWith = (snapshots: GoalTuiSnapshot[]) => {
    const store = createTuiStateStore();
    for (const s of snapshots)
      store.applyEvent({type: 'snapshot', snapshot: s} as never);
    return store;
  };

  test('a session owning no goal resolves to no focus, not to a foreign one', () => {
    const store = storeWith([
      snap({sessionID: THEIRS, goalId: 'g-foreign'}),
      snap({sessionID: 'ses_other', goalId: 'g-other'}),
    ]);
    expect(resolveFocusedGoalId(store, MINE)).toBeNull();
  });

  test('with no session route, nothing is claimed as focusable', () => {
    const store = storeWith([snap({sessionID: THEIRS, goalId: 'g-foreign'})]);
    expect(resolveFocusedGoalId(store, null)).toBeNull();
  });

  test("the session's own focus wins, and its own last goal is the fallback", () => {
    const store = storeWith([
      snap({sessionID: MINE, goalId: 'g-mine-1'}),
      snap({sessionID: MINE, goalId: 'g-mine-2'}),
      snap({sessionID: THEIRS, goalId: 'g-foreign'}),
    ]);
    // getFocused wins when the session has one.
    expect(resolveFocusedGoalId(store, MINE)).toBe('g-mine-2');
    // And a mixed listing still resolves to one of MINE, never the foreign one.
    const foreignLast = storeWith([
      snap({sessionID: MINE, goalId: 'g-mine'}),
      snap({sessionID: THEIRS, goalId: 'g-foreign'}),
    ]);
    expect(resolveFocusedGoalId(foreignLast, MINE)).toBe('g-mine');
  });
});

// THE CALL SITES, which is where the original file's coverage stopped and where
// both shipped defects lived. Every assertion above drives a FUNCTION; a function
// that is correct and never called with the session renders nothing useful, which
// is exactly what happened twice: the v1 detail card called
// `formatGoalStatusDashboard([snap])` with no session, and the v2 card built its
// own lines and mentioned no session at all. The header of this file claimed the
// two companions "cannot drift" — a stronger property than it tested, and a
// reader auditing either surface would have believed it.
//
// Rendering the v2 card itself needs the host's terminal renderer, so the card's
// TEXT was extracted into `goalCardLines` rather than the component being
// source-asserted. That is the recorded remedy for an unreachable rule: extract
// until it is reachable, then assert on the value.
describe("the surfaces that show a goal's status also show whose session it is", () => {
  // `.text`, because the card's lines carry a role alongside the string: the
  // route colours the status by state and the explanatory lines as subdued, and
  // a plain string[] cannot carry that.
  const cardText = (goal: GoalTuiSnapshot, session: string | null): string =>
    goalCardLines(goal, session)
      .map(line => line.text)
      .join('\n');

  test('the v2 card names the owning session for a foreign goal', () => {
    const foreign = snap({sessionID: THEIRS, goalId: 'g-foreign'});
    const text = cardText(foreign, MINE);
    expect(text).toContain('another session');
    expect(text).toContain(THEIRS);
    // And it still says what the goal is doing — the attribution is added, not
    // substituted for the status.
    expect(text).toContain('Status:     active');
  });

  test("the v2 card says nothing about ownership for this session's own goal", () => {
    const text = cardText(snap(), MINE);
    expect(text).not.toContain('another session');
    expect(text).not.toContain('Session:');
  });

  test('a dashboard action button addresses the goal on screen, and fires for no one when there is none', () => {
    // v1 sends `pause <goalId>` — the goal the card names — because a bare `pause`
    // resolves through the FOCUSED goal, so a card action could land on a goal
    // other than the one on screen. That is the user reported incongruence and the
    // reason the focus contract exists. The v2 route sent a BARE command, so the rule
    // was never generalised to the second companion: with foreign cards on screen
    // and no goal of this session's, the key still fired and steered the ACTIVE
    // session's goal.
    //
    // The rule lived only inside the ROUTE COMPONENT, which no test can execute —
    // the dialog fallback never renders the buttons, and a first attempt at this
    // test proved the route unreachable by failing with "No renderer found". It now
    // lives in `dashboardGoalActions` beside the `resolveFocusedGoalId` it composes,
    // which is the same fix as `goalCardLines` and the same lesson.
    const snap = (goalId: string, sessionID: string): GoalTuiSnapshot =>
      ({
        goalId,
        sessionID,
        condition: 'work',
        status: 'active',
        revision: 1,
        turnCount: 0,
        totalTokens: 0,
        maxTokens: 1,
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
        stopReason: '',
        blockedReason: '',
        pausedAt: 0,
        stoppedAt: 0,
        createdAt: 0,
        updatedAt: 0,
        finishedAt: null,
        lastCheckpoint: null,
        history: [],
      }) as unknown as GoalTuiSnapshot;
    // SESSION-SCOPED, because the real store is. A first version returned the
    // foreign goal from `getFocused` whatever id it was handed, and the button then
    // fired against a mock that cannot occur — the same "a fixture that does not
    // model the product" error this repository has now made three times.
    const scopedStore = (
      focused: Record<string, GoalTuiSnapshot>,
      all: GoalTuiSnapshot[],
    ) => ({
      getFocused: (id: string) => focused[id],
      getAllSnapshots: () => all,
    });
    const sent: string[] = [];
    const send = (c: string) => {
      sent.push(c);
    };

    // Only FOREIGN goals on screen: the keys must steer nothing.
    // The dashboard deliberately falls back to every session's goals so a session
    // about to be resumed is readable, so a foreign card can be visible while this
    // view's session owns nothing. Guessing a target would then steer a goal the
    // user is not looking at, in a session that may not be theirs.
    const foreignOnly = scopedStore({}, [snap('theirs', 'ses_other')]);
    const blind = dashboardGoalActions(foreignOnly, () => MINE, send);
    blind.onPause();
    blind.onResume();
    blind.onClear();
    expect(
      sent,
      "with no goal of this view's session, the keys must steer no goal at all",
    ).toHaveLength(0);

    // A goal of THIS session's: each key must NAME it.
    const withMine = scopedStore({}, [
      snap('g-mine', MINE),
      snap('theirs', 'ses_other'),
    ]);
    const mine = dashboardGoalActions(withMine, () => MINE, send);
    mine.onPause();
    expect(
      sent,
      'the key must drive something when the session owns a goal',
    ).toHaveLength(1);
    expect(
      sent[0],
      'the command must NAME the goal, or it resolves through the focus instead',
    ).toBe('pause g-mine');
    sent.length = 0;
    mine.onResume();
    mine.onClear();
    expect(sent).toEqual(['resume g-mine', 'clear g-mine']);

    // And never another session's goal, even when the focus points at it.
    sent.length = 0;
    dashboardGoalActions(
      scopedStore({[THEIRS]: snap('theirs', THEIRS)}, [snap('theirs', THEIRS)]),
      () => MINE,
      send,
    ).onPause();
    expect(
      sent,
      "a focus in another session must not become this session's button target",
    ).toHaveLength(0);

    // A null session route is UNKNOWN, not "everything is mine".
    sent.length = 0;
    dashboardGoalActions(foreignOnly, () => null, send).onPause();
    expect(
      sent,
      'with no session route, the button must not guess a target',
    ).toHaveLength(0);
  });

  test('an OVERDUE yield stops claiming it will re-arm, on the rendered card', () => {
    // THE FOUR SURFACES, ASSERTED ON THE RENDERED TEXT.'s own claim was
    // that the promise was made in four places and a fix that changed one leaves
    // the user believing the other three — and that claim was FALSE for one whole
    // commit, because every call site passed the ELAPSED clock and the promise
    // clock was written and read by nobody. A mutation on the writer passed the
    // whole suite: the field was stamped, renewed and serialised correctly, so the
    // plumbing was checked and the promise was not.
    //
    // So this asserts the OUTPUT of the real renderer, for both halves, and the
    // case differs from the live-yield test above in ONE variable: how long ago
    // the promise was last renewed. That is the whole rule.
    const MINE_S = 'ses_mine';
    const overdue = snap({
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      sessionID: MINE_S,
      stoppedAt: Date.now() - (YIELD_PROMISE_MS + 60_000),
      updatedAt: Date.now() - (YIELD_PROMISE_MS + 60_000),
    });
    const text = cardText(overdue, MINE_S);
    expect(
      text,
      'the card must stop promising a re-arm it cannot deliver',
    ).toContain('did not re-arm');
    expect(text, 'and must not claim it will re-arm').not.toContain(
      're-arms automatically',
    );

    // The control, and it is the half that actually distinguishes the two clocks.
    //
    // A first version set every instant to "now" and the card mutant SURVIVED it:
    // with `pausedAt` also fresh, both clocks agree and the test cannot tell them
    // apart. The shape that matters is the one a real conversation produces — the
    // goal was paused 16 minutes ago and the human has been talking since, so
    // `pausedAt` is old while `stoppedAt` is seconds old. THE ELAPSED CLOCK IS
    // OLD AND THE PROMISE IS FRESH, and only the promise decides what the card
    // says. This is the defect's own shape, at the surface was never wired
    // to.
    const live = snap({
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      sessionID: MINE_S,
      pausedAt: Date.now() - 16 * 60_000,
      stoppedAt: Date.now() - 2_000,
      updatedAt: Date.now() - 2_000,
    });
    const liveText = cardText(live, MINE_S);
    expect(
      liveText,
      'a promise renewed seconds ago must still report the re-arm',
    ).toContain('re-arms automatically');
    expect(liveText, 'and must not be announced as stuck').not.toContain(
      'did not re-arm',
    );
  });

  test('with no session route the v2 card claims no ownership either', () => {
    const text = cardText(snap({sessionID: THEIRS}), null);
    expect(text).not.toContain('another session');
  });

  test("the v2 card's stop reason is translated, and a yield still reads as one", () => {
    // `stoppedAt` explicitly, because a yield is only "live" while its promise
    // holds, and the promise is measured from the STOP instant. Without it this
    // fixture fell through to `updatedAt`, which in `snap` is the sentinel 2 —
    // 1970 as a timestamp — so the yield read as 56 years overdue and the card
    // correctly said "did not re-arm". The test was green for the wrong reason
    // before the promise clock was wired, and this is what that looked like.
    const yielding = snap({
      status: 'paused',
      stopReason: USER_INTERVENTION_STOP_REASON,
      sessionID: THEIRS,
      stoppedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const text = cardText(yielding, MINE);
    expect(text).toContain('yielding to your message; re-arms automatically');
    expect(text, 'the ledger token must never reach a reader').not.toContain(
      'user intervention',
    );
    // Attribution and translation coexist on one card.
    expect(text).toContain('another session');
  });

  test('the v2 card marks its explanatory lines subdued, and the status is not one of them', () => {
    // The extraction flattened the card's per-line colours, so the stop reason
    // and the attribution silently rendered in the default colour — a visual
    // regression with nothing watching it, because colour is not text and a
    // string[] cannot carry it. The route colours the status line by STATE at a
    // fixed index, so "is the status subdued" is the assertion that both the
    // fixed index and the role survive.
    const withBoth = goalCardLines(
      snap({
        sessionID: THEIRS,
        status: 'paused',
        stopReason: USER_INTERVENTION_STOP_REASON,
      }),
      MINE,
    );
    const status = withBoth.find(l => l.text.includes('Status:'));
    const stop = withBoth.find(l => l.text.includes('Stop:'));
    const attribution = withBoth.find(l => l.text.includes('Session:'));
    expect(status, 'the status line must be present').toBeDefined();
    expect(
      status!.subdued,
      'the status is coloured by state, so it must not claim to be subdued',
    ).toBeFalsy();
    expect(
      stop!.subdued,
      'the stop reason is explanatory and must render subdued',
    ).toBe(true);
    expect(
      attribution!.subdued,
      'the attribution is explanatory and must render subdued',
    ).toBe(true);
    // And the index the route depends on is asserted rather than assumed.
    expect(withBoth.indexOf(status!)).toBe(1);
  });

  // The v1 detail card is asserted through the function it calls, with the
  // session the call site passes. The call site itself is locked by the source
  // assertion below, because `formatGoalDetail` is a closure inside the v1
  // companion registration and nothing can execute it — the same limitation
  // that moved the row into goalListRow.
  test('the v1 detail card renders the attribution for a foreign goal', () => {
    const foreign = snap({sessionID: THEIRS, goalId: 'g-foreign'});
    const detail = formatGoalStatusDashboard([foreign], MINE)
      .map(x => x.text)
      .join('\n');
    expect(detail).toContain('another session');
    expect(detail).toContain(THEIRS);
  });

  test('the v1 companion passes its own session to the detail card', async () => {
    // A wiring assertion, and honestly labelled as one: `formatGoalDetail` lives
    // inside the v1 plugin registration and there is no way to call it from a
    // test. What IS asserted is that the call site passes the session, because a
    // detail card that drops it shows a foreign goal's objective, checkpoint and
    // history as though they were the reader's own.
    const source = await readFile(
      join(import.meta.dir, '..', 'src', 'tui.ts'),
      'utf8',
    );
    expect(
      source,
      'the v1 detail card must render with the active session',
    ).toContain('formatGoalStatusDashboard([snap], activeSessionID())');
  });

  test('the v2 route is handed the session, and its cards are built by the shared lines', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', 'src', 'tui-dashboard-route.tsx'),
      'utf8',
    );
    expect(
      source,
      'the v2 route must receive the session it is rendering for',
    ).toContain('activeSessionID: () => string | null');
    expect(
      source,
      "the v2 card's text must come from the shared, testable lines",
    ).toContain('goalCardLines(snap, props.activeSessionID())');
  });
});
