// double-dispatch.test.ts — LOCKS the double-dispatch guard for stock v1.
//
// Stock v1 1.18.32 runs BOTH command channels for one `/goal` submission: the
// `command.execute.before` hook dispatches the subcommand, and the config
// command template ALSO reaches the agent, whose `goal-command` tool call
// dispatches the SAME subcommand again. Live-observed 2026-09-23 in the
// e2e-harness: a single `/goal <objective>` created two goals and removed the
// first (the bare-objective form routes through replaceGoals, so the second
// dispatch deletes what the first created).
//
// Contract-Over-Green: these tests fail if either half of the guard regresses —
// the mutation dedup (one goal, not two) or the echo guard (the template text
// must not count as human steering). The bare-objective case below is the one
// that a name-based "is this a mutating subcommand?" rule silently misses.
import {describe, expect, test} from 'bun:test';
import {GoalsPlugin} from '../src/plugin-runtime.ts';
import {consumeCommandDispatch, markCommandDispatch} from '../src/hooks.ts';
import {GOAL_COMMAND_TEMPLATE_PREFIX} from '../src/native-agent-config.ts';
import {canonicalGoalDispatch} from '../src/commands.ts';

const NO_PERSIST = {persistState: false};

type Hooks = Awaited<ReturnType<typeof GoalsPlugin>>;

async function makePlugin() {
  const hooks = (await GoalsPlugin({client: {}}, NO_PERSIST)) as Hooks;
  return hooks;
}

/** Dispatch a `/goal` submission through the host's command hook. */
async function viaCommandHook(
  hooks: Hooks,
  sessionID: string,
  args: string,
): Promise<string> {
  const output: {parts: {type: string; text: string}[]} = {parts: []};
  await hooks['command.execute.before']!(
    {command: 'goal', sessionID, arguments: args},
    output,
  );
  return output.parts[0]?.text ?? '';
}

/** Dispatch the same subcommand through the goal-command tool. */
async function viaGoalCommandTool(
  hooks: Hooks,
  sessionID: string,
  subcommand: string,
): Promise<string> {
  const tool = hooks.tool!['goal-command'] as {
    execute: (
      a: Record<string, unknown>,
      c: {sessionID: string},
    ) => Promise<string>;
  };
  return tool.execute({subcommand}, {sessionID});
}

async function activeGoalCount(
  hooks: Hooks,
  sessionID: string,
): Promise<number> {
  const list = hooks.tool!['list_goals'] as {
    execute: (
      a: Record<string, unknown>,
      c: {sessionID: string},
    ) => Promise<string>;
  };
  const parsed = JSON.parse(await list.execute({}, {sessionID})) as {
    goals?: unknown[];
  };
  return Array.isArray(parsed.goals) ? parsed.goals.length : 0;
}

async function goalStatus(
  hooks: Hooks,
  sessionID: string,
): Promise<string | undefined> {
  const getGoal = hooks.tool!['get_goal'] as {
    execute: (
      a: Record<string, unknown>,
      c: {sessionID: string},
    ) => Promise<string>;
  };
  const parsed = JSON.parse(await getGoal.execute({}, {sessionID})) as {
    goal?: {status?: string};
  };
  return parsed.goal?.status;
}

async function focusedGoalId(
  hooks: Hooks,
  sessionID: string,
): Promise<string | undefined> {
  const getGoal = hooks.tool!['get_goal'] as {
    execute: (
      a: Record<string, unknown>,
      c: {sessionID: string},
    ) => Promise<string>;
  };
  const parsed = JSON.parse(await getGoal.execute({}, {sessionID})) as {
    goal?: {goalId?: string};
  };
  return parsed.goal?.goalId;
}

describe('v1 double-dispatch guard (hook + command template)', () => {
  test('a BARE objective through both channels creates exactly ONE goal', async () => {
    // The primary interface: `/goal fix the tests`. Its first token is prose,
    // so it must not depend on any subcommand-name classification.
    const hooks = await makePlugin();
    const sessionID = 'dd-bare-one-goal';

    const hookText = await viaCommandHook(
      hooks,
      sessionID,
      'fix the broken add function',
    );
    expect(hookText).toContain('New active goal: fix the broken add function');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    const firstId = await focusedGoalId(hooks, sessionID);

    // The host's template path now reaches the tool with the identical line.
    const toolText = await viaGoalCommandTool(
      hooks,
      sessionID,
      'fix the broken add function',
    );

    // The duplicate replays the first outcome instead of replacing the goal.
    expect(toolText).toContain('New active goal: fix the broken add function');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    // replaceGoals would have removed the first goal and created a second one.
    expect(await focusedGoalId(hooks, sessionID)).toBe(firstId);
  });

  test('the same add through both channels creates exactly ONE goal', async () => {
    const hooks = await makePlugin();
    const sessionID = 'dd-one-goal';

    const hookText = await viaCommandHook(
      hooks,
      sessionID,
      'add fix the broken add function',
    );
    expect(hookText).toContain('Added and focused new goal');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    // The host's template path now reaches the tool with the identical line.
    const toolText = await viaGoalCommandTool(
      hooks,
      sessionID,
      'add fix the broken add function',
    );

    // The duplicate replays the first outcome instead of mutating again.
    expect(toolText).toContain('Added and focused new goal');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
  });

  test('a different add through the tool is NOT swallowed', async () => {
    const hooks = await makePlugin();
    const sessionID = 'dd-different';

    await viaCommandHook(hooks, sessionID, 'add first objective');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    await viaGoalCommandTool(hooks, sessionID, 'add second objective');
    expect(await activeGoalCount(hooks, sessionID)).toBe(2);
  });

  test('a repeated identical invocation AFTER the duplicate is still executed', async () => {
    // The ledger is one-shot: a genuine second `/goal add x` from the user must
    // create a second goal, not replay the first outcome forever.
    const hooks = await makePlugin();
    const sessionID = 'dd-repeat-after-consume';

    await viaCommandHook(hooks, sessionID, 'add repeatable objective');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    // Consume the duplicate (the host's template replay).
    await viaGoalCommandTool(hooks, sessionID, 'add repeatable objective');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    // A genuine repeat runs the hook again and records a fresh entry.
    await viaCommandHook(hooks, sessionID, 'add repeatable objective');
    expect(await activeGoalCount(hooks, sessionID)).toBe(2);
  });

  test('a read-only dispatch is never recorded, so it always reports fresh state', async () => {
    // `status` moves no state; recording it would replay stale text on a
    // genuine repeat.
    const hooks = await makePlugin();
    const sessionID = 'dd-readonly';

    await viaCommandHook(hooks, sessionID, 'add readonly probe');
    const statusText = await viaCommandHook(hooks, sessionID, 'status');
    expect(statusText).toContain('readonly probe');
    // The tool path re-runs status (fresh) rather than replaying the hook text.
    const toolStatus = await viaGoalCommandTool(hooks, sessionID, 'status');
    expect(toolStatus).toContain('readonly probe');
  });

  test('the template echo does not pause the goal the same submission created', async () => {
    // The host replays the config template as a user message. That is the
    // host's own dispatch, not human steering.
    const hooks = await makePlugin();
    const sessionID = 'dd-echo-no-pause';

    await viaCommandHook(hooks, sessionID, 'add keep running');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    const chatMessage = hooks['chat.message'] as unknown as (
      i: {sessionID: string},
      o: {parts: unknown[]},
    ) => Promise<void>;
    await chatMessage(
      {sessionID},
      {
        parts: [
          {
            type: 'text',
            text: `${GOAL_COMMAND_TEMPLATE_PREFIX} add keep running\nDo not summarize, do not ask for confirmation, and do not perform any other work. Reply with only the tool output.`,
          },
        ],
      },
    );

    expect(await goalStatus(hooks, sessionID)).toBe('active');
  });

  test('a human who merely QUOTES the template prefix is still steering', async () => {
    // The echo fingerprint is a trimmed `startsWith`, not an `includes`. The
    // host always leads with the prefix; a human discussing it mid-message is
    // real steering and must not be swallowed by the guard.
    const hooks = await makePlugin();
    const sessionID = 'dd-quoted-prefix';

    await viaCommandHook(hooks, sessionID, 'add quoted prefix probe');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    const chatMessage = hooks['chat.message'] as unknown as (
      i: {sessionID: string},
      o: {parts: unknown[]},
    ) => Promise<void>;
    await chatMessage(
      {sessionID},
      {
        parts: [
          {
            type: 'text',
            text: `Wait, stop. Note that the host sends "${GOAL_COMMAND_TEMPLATE_PREFIX} ..." as its own replay, but I am typing this by hand.`,
          },
        ],
      },
    );

    // The goal was paused: the message is human steering, not the host's echo.
    expect(await goalStatus(hooks, sessionID)).toBe('paused');
  });

  test('a duplicate whose echo is NOT byte-identical still creates only one goal', async () => {
    // The real host flow: the hook applies the mutation, then the config
    // template routes the SAME line through a model to the goal-command tool.
    // A model may normalize whitespace, add punctuation, or drop a trailing
    // flag — each of which reproduced the original two-goals defect when the
    // ledger matched on byte equality.
    const hooks = await makePlugin();
    const sessionID = 'dd-nonverbatim';

    await viaCommandHook(
      hooks,
      sessionID,
      'add  fix   the tests --max-turns 20',
    );
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    const firstId = await focusedGoalId(hooks, sessionID);

    // The model echoes a normalized, flag-dropped version of the same line.
    const toolText = await viaGoalCommandTool(
      hooks,
      sessionID,
      'Add fix the tests.',
    );

    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    expect(await focusedGoalId(hooks, sessionID)).toBe(firstId);
    expect(toolText).toContain('Added and focused new goal');
  });

  test('a bare objective with a dropped flag still replaces exactly once', async () => {
    const hooks = await makePlugin();
    const sessionID = 'dd-bare-nonverbatim';

    await viaCommandHook(
      hooks,
      sessionID,
      'fix the broken add function --max-turns 20',
    );
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    const firstId = await focusedGoalId(hooks, sessionID);

    const toolText = await viaGoalCommandTool(
      hooks,
      sessionID,
      'fix the broken add function',
    );

    // replaceGoals must NOT run a second time and delete the goal the hook made.
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    expect(await focusedGoalId(hooks, sessionID)).toBe(firstId);
    // The recorded outcome was replayed (the hook text carries a mode header the
    // tool path does not, so compare the payload, not the whole string).
    expect(toolText).toContain('New active goal: fix the broken add function');
  });
});

describe('command dispatch ledger semantics', () => {
  test('state-moving dispatches are consumed once, then no longer match', () => {
    markCommandDispatch(
      'ledger-once',
      'add alpha',
      'Added and focused new goal: alpha',
      'receipt-a',
      true,
    );
    expect(consumeCommandDispatch('ledger-once', 'add alpha')).toEqual({
      result: 'Added and focused new goal: alpha',
      receipt: 'receipt-a',
    });
    expect(consumeCommandDispatch('ledger-once', 'add alpha')).toBeNull();
  });

  test('dispatches that moved no state are never recorded', () => {
    markCommandDispatch(
      'ledger-readonly',
      'status',
      'Status output',
      '',
      false,
    );
    expect(consumeCommandDispatch('ledger-readonly', 'status')).toBeNull();
  });

  test('a mutating no-op is recorded, so its late duplicate cannot destroy what appeared in between', async () => {
    // MEASURED 2026-10-24 (run 2026-10-24T23:04:34Z, the v1 host's own DB): a
    // hook `clear` with no goal present (changed=false) was never recorded, and
    // its agent-channel duplicate executed ten seconds later — after a goal had
    // been created — and destroyed it. The duplicate channel exists precisely
    // because the world can change between the two dispatches, so a mutating
    // root's no-op must be recorded with the outcome it actually produced.
    const hooks = await makePlugin();
    const sessionID = 'dd-late-noop-clear';

    // The hook dispatch: clear with nothing to clear. Old rule: unrecorded.
    const noOpText = await viaCommandHook(hooks, sessionID, 'clear');
    expect(noOpText).toContain('No active goal');

    // The world changes: a goal appears.
    await viaCommandHook(hooks, sessionID, 'add late-duplicate probe');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    // The duplicate channel replays the no-op instead of executing it.
    const duplicateText = await viaGoalCommandTool(hooks, sessionID, 'clear');
    expect(duplicateText).toContain('No active goal');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    // Ledger-level pin of the same rule: a mutating no-op is recorded even
    // with changed=false, and is consumed once like any other entry.
    markCommandDispatch(
      'ledger-mutating-noop',
      'clear',
      'No active goal to clear.',
      'receipt-x',
      false,
    );
    expect(consumeCommandDispatch('ledger-mutating-noop', 'clear')).toEqual({
      result: 'No active goal to clear.',
      receipt: 'receipt-x',
    });
    expect(consumeCommandDispatch('ledger-mutating-noop', 'clear')).toBeNull();
  });

  test('a non-matching line is never consumed by another line', () => {
    markCommandDispatch('ledger-mismatch', 'pause', 'Paused', '', true);
    expect(consumeCommandDispatch('ledger-mismatch', 'resume')).toBeNull();
    expect(consumeCommandDispatch('ledger-mismatch', 'pause')).toEqual({
      result: 'Paused',
      receipt: '',
    });
  });

  test('ledger entries are session-scoped', () => {
    markCommandDispatch('ledger-session-a', 'clear', 'Cleared', '', true);
    expect(consumeCommandDispatch('ledger-session-b', 'clear')).toBeNull();
    expect(consumeCommandDispatch('ledger-session-a', 'clear')).toEqual({
      result: 'Cleared',
      receipt: '',
    });
  });

  test('an empty subcommand is never recorded or consumed', () => {
    markCommandDispatch('ledger-empty', '', 'No objective provided', '', true);
    expect(consumeCommandDispatch('ledger-empty', '')).toBeNull();
  });

  // The duplicate key must not depend on the model echoing byte-for-byte
  // The tool's subcommand is produced by a model reading the config template.
  // Measured against the frozen candidate, EVERY divergence below reproduced
  // the original defect (two goals, or replaceGoals deleting the goal the hook
  // had just created). Matching is therefore structural, not byte equality.
  test('a duplicate that collapsed whitespace still matches', () => {
    markCommandDispatch('ledger-ws', 'add  fix   the tests', 'Added', '', true);
    expect(consumeCommandDispatch('ledger-ws', 'add fix the tests')).toEqual({
      result: 'Added',
      receipt: '',
    });
  });

  test('a duplicate with a trailing period still matches', () => {
    markCommandDispatch(
      'ledger-dot',
      'fix the tests',
      'New active goal',
      '',
      true,
    );
    expect(consumeCommandDispatch('ledger-dot', 'fix the tests.')).toEqual({
      result: 'New active goal',
      receipt: '',
    });
  });

  test('a duplicate that dropped a trailing flag still matches', () => {
    markCommandDispatch(
      'ledger-flag',
      'add fix the tests --max-turns 20',
      'Added',
      '',
      true,
    );
    expect(consumeCommandDispatch('ledger-flag', 'add fix the tests')).toEqual({
      result: 'Added',
      receipt: '',
    });
  });

  test('a bare objective whose flag was dropped still matches', () => {
    markCommandDispatch(
      'ledger-bare-flag',
      'fix the tests --max-turns 20',
      'New active goal',
      '',
      true,
    );
    expect(consumeCommandDispatch('ledger-bare-flag', 'fix the tests')).toEqual(
      {
        result: 'New active goal',
        receipt: '',
      },
    );
  });

  test('case-only differences still match', () => {
    markCommandDispatch('ledger-case', 'add fix the tests', 'Added', '', true);
    expect(consumeCommandDispatch('ledger-case', 'Add Fix The Tests')).toEqual({
      result: 'Added',
      receipt: '',
    });
  });

  test('a DIFFERENT command that merely shares a prefix token is NOT swallowed', () => {
    // `add first` vs `add second` diverge at a token boundary, so they are
    // different commands. This is what keeps the structural rule safe.
    markCommandDispatch(
      'ledger-prefix-safe',
      'add first objective',
      'Added first',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-prefix-safe', 'add second objective'),
    ).toBeNull();
    //...and the genuine duplicate still matches afterwards.
    expect(
      consumeCommandDispatch('ledger-prefix-safe', 'add first objective'),
    ).toEqual({
      result: 'Added first',
      receipt: '',
    });
  });

  test('a different leading token is never a prefix match', () => {
    markCommandDispatch('ledger-token0', 'pause', 'Paused', '', true);
    expect(consumeCommandDispatch('ledger-token0', 'paused thing')).toBeNull();
    expect(consumeCommandDispatch('ledger-token0', 'resume')).toBeNull();
  });

  // Run-3 divergences: the model may paraphrase beyond truncation
  test('bare objective and the explicit add form share an identity', () => {
    markCommandDispatch(
      'ledger-bare-add',
      'fix the broken add function',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch(
        'ledger-bare-add',
        'add fix the broken add function',
      ),
    ).toEqual({
      result: 'R',
      receipt: '',
    });
  });

  test('a reordered flag still matches (flags carry no identity)', () => {
    markCommandDispatch(
      'ledger-reorder',
      'add fix the tests --max-turns 20',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch(
        'ledger-reorder',
        'add --max-turns 20 fix the tests',
      ),
    ).toEqual({
      result: 'R',
      receipt: '',
    });
  });

  test('a single inserted FUNCTION word still matches', () => {
    // The tolerance is restricted to semantically empty words. `the` carries no
    // meaning, so a model that adds it is still reproducing the same submission.
    markCommandDispatch('ledger-insert-fn', 'add fix tests', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-insert-fn', 'add fix the tests'),
    ).toEqual({result: 'R', receipt: ''});
  });

  test('a single inserted CONTENT word does NOT match (dropping one can invert meaning)', () => {
    // A general one-token rule was measured to swallow commands whose meaning
    // reverses when one word is dropped — `add do not delete the files` vs
    // `add do delete the files`, `add only modify src/a.ts` vs
    // `add modify src/a.ts`. A missed duplicate re-runs a mutation (recoverable);
    // a false match reports success for work never done. So content words are
    // treated as a different command.
    markCommandDispatch(
      'ledger-insert-content',
      'add fix the tests',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch(
        'ledger-insert-content',
        'add fix the flaky tests',
      ),
    ).toBeNull();
    expect(
      consumeCommandDispatch('ledger-insert-content', 'add fix the tests now'),
    ).toBeNull();
  });

  test('a dropped FUNCTION word still matches', () => {
    markCommandDispatch('ledger-drop-fn', 'add fix the tests', 'R', '', true);
    expect(consumeCommandDispatch('ledger-drop-fn', 'add fix tests')).toEqual({
      result: 'R',
      receipt: '',
    });
  });

  test('a dropped CONTENT word does NOT match', () => {
    // `flaky` carries meaning, so dropping it is a different command.
    markCommandDispatch(
      'ledger-drop-content',
      'add fix the flaky tests',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-drop-content', 'add fix the tests'),
    ).toBeNull();
  });

  test('diacritics are folded', () => {
    markCommandDispatch('ledger-uni', 'add fix the naïve bug', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-uni', 'add fix the naive bug'),
    ).toEqual({result: 'R', receipt: ''});
  });

  // The one-sided safety property: a SUBSTITUTION is never a duplicate
  test('a token SUBSTITUTION is never swallowed (false success is worse)', () => {
    markCommandDispatch('ledger-subst', 'add fix the tests', 'OLD', '', true);
    // Replacing a word changes the objective: this is a different command.
    expect(
      consumeCommandDispatch('ledger-subst', 'add fix the linter'),
    ).toBeNull();
    expect(
      consumeCommandDispatch('ledger-subst', 'add break the tests'),
    ).toBeNull();
    // The genuine duplicate is still available.
    expect(consumeCommandDispatch('ledger-subst', 'add fix the tests')).toEqual(
      {result: 'OLD', receipt: ''},
    );
  });

  test('a LONGER, genuinely different command is not answered from a recording', () => {
    // Run-3 BLK-3.2: a token-prefix rule swallowed this and returned the old
    // success text without creating the goal. Exact/one-word identity prevents it.
    markCommandDispatch('ledger-swallow', 'add fix the tests', 'OLD', '', true);
    expect(
      consumeCommandDispatch(
        'ledger-swallow',
        'add fix the tests and the linter',
      ),
    ).toBeNull();
    expect(
      consumeCommandDispatch('ledger-swallow', 'edit alpha objective'),
    ).toBeNull();
  });

  test('a SHORTENED add is not swallowed — only a bare objective tolerates truncation', () => {
    // The truncation rule is gated on the BARE objective form, and this is the
    // case that shows the gate is load-bearing. `add` and the bare form both
    // canonicalize to `set`, so the gate cannot be recovered from the key — but
    // their failure costs are opposite. A missed duplicate for `add` creates a
    // second goal (harmless); for a bare objective it runs replaceGoals and
    // rewrites the user's objective. So a truncated `add` must still execute.
    // Mutation-verified: removing the gate leaves every other test green.
    markCommandDispatch(
      'ledger-shorten-add',
      'add fix the tests now',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-shorten-add', 'add fix the tests'),
    ).toBeNull();
  });

  test('short commands never near-match on one word', () => {
    markCommandDispatch('ledger-short', 'add alpha', 'R', '', true);
    expect(consumeCommandDispatch('ledger-short', 'add beta')).toBeNull();
    markCommandDispatch('ledger-short2', 'focus aaa', 'R', '', true);
    expect(consumeCommandDispatch('ledger-short2', 'focus bbb')).toBeNull();
  });

  test('a ONE-WORD objective never near-matches a longer one', () => {
    // Isolates the >=2-token guard: with it removed, `add refactor` would be a
    // subsequence of `add refactor now` (one-token diff) and swallow it.
    markCommandDispatch('ledger-oneword', 'add refactor', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-oneword', 'add refactor now'),
    ).toBeNull();
    expect(consumeCommandDispatch('ledger-oneword', 'add refactor')).toEqual({
      result: 'R',
      receipt: '',
    });
  });

  test('the same objective under a DIFFERENT subcommand never matches', () => {
    // Isolates the subcommand comparison: both objectives are two tokens, so
    // only the subcommand distinguishes them. `edit` and `focus` are different
    // operations on the same target.
    markCommandDispatch('ledger-subcmd', 'edit alpha beta', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-subcmd', 'focus alpha beta'),
    ).toBeNull();
    expect(
      consumeCommandDispatch('ledger-subcmd', 'checkpoint alpha beta'),
    ).toBeNull();
    expect(consumeCommandDispatch('ledger-subcmd', 'edit alpha beta')).toEqual({
      result: 'R',
      receipt: '',
    });
  });

  test('a stale earlier entry is not consumed by a later command sharing its identity', () => {
    // Isolates the back-to-front scan. BOTH recorded entries match the incoming
    // line — each is one insignificant (`the`) word from it — so a forward scan
    // would replay the OLDER one. The duplicate must always be the most recent.
    markCommandDispatch(
      'ledger-order',
      'add fix tests',
      'OLD-RESULT',
      '',
      true,
    );
    markCommandDispatch(
      'ledger-order',
      'add fix the tests',
      'NEW-RESULT',
      '',
      true,
    );
    expect(consumeCommandDispatch('ledger-order', 'add fix the tests')).toEqual(
      {
        result: 'NEW-RESULT',
        receipt: '',
      },
    );
  });

  test('a DIFFERENT subcommand is rejected even when one insignificant word differs', () => {
    // Isolates the subcommand comparison: the conditions are one `the` apart, so
    // only the subcommand distinguishes them. `edit` and `focus` are different
    // operations on the same target.
    markCommandDispatch('ledger-subcmd2', 'edit alpha beta', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-subcmd2', 'focus alpha beta the'),
    ).toBeNull();
  });

  test('a ONE-token objective never tolerates an added word', () => {
    // Isolates the >=2-token guard: without it, `add alpha` would tolerate
    // `add alpha the` and answer a longer command from the recording.
    markCommandDispatch('ledger-onetok', 'add alpha', 'R', '', true);
    expect(consumeCommandDispatch('ledger-onetok', 'add alpha the')).toBeNull();
  });

  test('a same-length SUBSTITUTION never matches (isolates the length guard)', () => {
    // `add fix the flaky tests` -> `add fix the basic tests` is a one-token
    // substitution at equal length. Without the exact-length check the added
    // word would be treated as an insertion and the different command would be
    // answered from the recording.
    markCommandDispatch(
      'ledger-substlen',
      'add fix the flaky tests',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-substlen', 'add fix the basic tests'),
    ).toBeNull();
  });

  // The tolerance must never extend to words that carry meaning
  // Each of these INVERTS or RESTRICTS the objective when dropped. A false
  // match would report success for work never done (the Run-3 BLK-3.2 class).
  test('dropping a NEGATION never matches (meaning inverts)', () => {
    markCommandDispatch(
      'ledger-neg1',
      'add do not delete the files',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-neg1', 'add do delete the files'),
    ).toBeNull();
    markCommandDispatch(
      'ledger-neg2',
      'add never remove production data',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-neg2', 'add remove production data'),
    ).toBeNull();
  });

  test('dropping a RESTRICTOR never matches (scope widens)', () => {
    markCommandDispatch(
      'ledger-restrict',
      'add only modify src/a.ts',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-restrict', 'add modify src/a.ts'),
    ).toBeNull();
  });

  test('TWO token differences never match, even when both are insignificant words', () => {
    // Isolates the single-divergence rule: `the` and `please` are both
    // tolerated one at a time, but adding both is two differences, not one.
    markCommandDispatch('ledger-twodiff', 'add run tests', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-twodiff', 'add run the tests please'),
    ).toBeNull();
  });

  // The identity must mirror what each HANDLER does with the line
  test('a flag-bearing operand is NOT stripped for edit/focus/checkpoint', () => {
    // Those handlers store the rest of the line VERBATIM (no flag parsing), so
    // `focus a --max-turns 20` targets a different reference than `focus a`.
    // Stripping the flag produced a false success.
    for (const sub of ['edit', 'focus', 'checkpoint']) {
      markCommandDispatch(
        `ledger-raw-${sub}`,
        `${sub} foo --max-turns 20`,
        'R',
        '',
        true,
      );
      expect(
        consumeCommandDispatch(`ledger-raw-${sub}`, `${sub} foo`),
      ).toBeNull();
      // The exact duplicate still matches.
      expect(
        consumeCommandDispatch(
          `ledger-raw-${sub}`,
          `${sub} foo --max-turns 20`,
        ),
      ).toEqual({
        result: 'R',
        receipt: '',
      });
    }
  });

  test('a flag-bearing sequence objective is NOT stripped', () => {
    // The sequence handler splits the rest verbatim; it never parses flags, so
    // the flag belongs to the objective text.
    markCommandDispatch(
      'ledger-seqflag',
      'sequence a --max-turns 20',
      'R',
      '',
      true,
    );
    expect(consumeCommandDispatch('ledger-seqflag', 'sequence a')).toBeNull();
  });

  test('the sequence separator form does not change identity', () => {
    // Re-mark between assertions: the ledger is one-shot by design.
    markCommandDispatch('ledger-seqsep', 'sequence aaa; bbb', 'R', '', true);
    expect(consumeCommandDispatch('ledger-seqsep', 'sequence aaa;bbb')).toEqual(
      {result: 'R', receipt: ''},
    );
    markCommandDispatch('ledger-seqsep', 'sequence aaa; bbb', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-seqsep', 'sequence aaa ; bbb'),
    ).toEqual({result: 'R', receipt: ''});
  });

  test('an empty or whitespace-only line has no identity', () => {
    // Directly covers the public guard in canonicalGoalDispatch (the callers
    // pre-trim, so this is otherwise unreachable and untestable).
    expect(canonicalGoalDispatch('')).toBe('');
    expect(canonicalGoalDispatch('   ')).toBe('');
    expect(canonicalGoalDispatch('\n\t ')).toBe('');
  });

  test('a SUBSTITUTION of an insignificant word never matches (isolates the consumed-length guard)', () => {
    // `a` and `the` are both tolerated one at a time, so swapping one for the
    // other is a substitution, not an insertion. Without the consumed-length
    // check this was answered from the recording (measured: the whole suite
    // stayed green when the check was deleted).
    markCommandDispatch('ledger-subst-insig', 'add a a', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-subst-insig', 'add a the'),
    ).toBeNull();
    markCommandDispatch('ledger-subst-insig2', 'add the a', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-subst-insig2', 'add a the'),
    ).toBeNull();
  });

  test('a sequence arity change never matches, even when a part normalizes to empty', () => {
    // The handler creates one goal per `splitObjectives` part. `a;.; b` yields
    // THREE parts (the `.` is a part), so it must not collide with the
    // two-objective `a; b` — that would report success for a sequence the
    // handler never built, on the one subcommand whose duplicate is destructive.
    markCommandDispatch('ledger-seqarity', 'sequence a; b', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-seqarity', 'sequence a; .; b'),
    ).toBeNull();
    markCommandDispatch('ledger-seqarity2', 'sequence a; b', 'R', '', true);
    expect(consumeCommandDispatch('ledger-seqarity2', 'sequence a; b')).toEqual(
      {result: 'R', receipt: ''},
    );
  });

  // Sequence separators: `;` and NEWLINES are equivalent to the handler
  test('a sequence matches across semicolon AND newline separators (a miss is DESTRUCTIVE)', () => {
    // The handler splits on `;`, `\n`, and `\r\n`. Canonicalization that
    // collapsed whitespace first made the newline form MISS its own semicolon
    // form, re-running the handler — which removes every existing goal.
    for (const form of [
      'sequence alpha; beta',
      'sequence alpha\nbeta',
      'sequence alpha\r\nbeta',
    ]) {
      markCommandDispatch(
        'ledger-seqnl',
        'sequence alpha; beta',
        'R',
        '',
        true,
      );
      expect(consumeCommandDispatch('ledger-seqnl', form)).toEqual({
        result: 'R',
        receipt: '',
      });
    }
  });

  test("a sequence's ARITY is never conflated across separator forms", () => {
    // `sequence a b` is ONE objective ("a b"); `sequence a\nb` is TWO ("a", "b").
    // Sharing a key would report success for a sequence the handler never built.
    markCommandDispatch('ledger-seqarity2', 'sequence a b', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-seqarity2', 'sequence a\nb'),
    ).toBeNull();
  });

  test('a newline after the root is a BARE objective, as the handler decides', () => {
    // The handler's guard is `startsWith("sequence ")`, so `sequence\na` is NOT
    // a sequence — it routes to replaceGoals as a bare objective. A key that
    // called it a sequence described a different operation than the handler.
    markCommandDispatch('ledger-seqnlroot', 'sequence\na', 'R', '', true);
    expect(consumeCommandDispatch('ledger-seqnlroot', 'sequence a')).toBeNull();
  });

  test('a case-only paraphrase of a sequence still matches (locks the normalization fold)', () => {
    // Deleting the `.map(normalizeObjectiveText)` in the sequence branch leaves
    // the rest of the suite green, so this test exists specifically to kill that
    // sub-expression: without the fold, a case-only paraphrase becomes a
    // duplicate-miss and re-runs destructively.
    markCommandDispatch(
      'ledger-seqcase',
      'sequence Fix The Tests',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-seqcase', 'sequence fix the tests'),
    ).toEqual({result: 'R', receipt: ''});
  });

  test('only `edit` unwraps quotes; focus and checkpoint take the raw slice', () => {
    // Mirrors each handler's own extraction. A false match here reports success
    // for an operand the handler would have rejected.
    markCommandDispatch('ledger-editquote', 'edit "obj"', 'R', '', true);
    expect(consumeCommandDispatch('ledger-editquote', 'edit obj')).toEqual({
      result: 'R',
      receipt: '',
    });

    markCommandDispatch('ledger-focusquote', 'focus "1"', 'R', '', true);
    expect(consumeCommandDispatch('ledger-focusquote', 'focus 1')).toBeNull();

    markCommandDispatch('ledger-cpquote', 'checkpoint "x"', 'R', '', true);
    expect(consumeCommandDispatch('ledger-cpquote', 'checkpoint x')).toBeNull();
  });

  test('a raw operand keeps its internal whitespace', () => {
    markCommandDispatch('ledger-cptab', 'checkpoint a\tb', 'R', '', true);
    expect(consumeCommandDispatch('ledger-cptab', 'checkpoint a b')).toBeNull();
  });

  test('a raw operand is compared case-sensitively, as the handler stores it', () => {
    // edit/focus/checkpoint keep the operand verbatim, so a case difference is
    // a different operand. A missed duplicate there is idempotent, whereas a
    // false match would apply the wrong objective or save the wrong summary.
    markCommandDispatch(
      'ledger-rawcase',
      'checkpoint Fix The Bug',
      'R',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-rawcase', 'checkpoint fix the bug'),
    ).toBeNull();
    markCommandDispatch('ledger-rawcase2', 'edit Fix The Bug', 'R', '', true);
    expect(
      consumeCommandDispatch('ledger-rawcase2', 'edit fix the bug'),
    ).toBeNull();
  });

  test('a sequence matches across semicolon spacing (a miss here is DESTRUCTIVE)', () => {
    // The sequence handler REMOVES every existing goal before creating the new
    // ones, so a missed duplicate is a destructive replace rather than a
    // recoverable re-run. Spacing around `;` must not change identity.
    markCommandDispatch('ledger-seq', 'sequence aaa; bbb', 'R', '', true);
    expect(consumeCommandDispatch('ledger-seq', 'sequence aaa;bbb')).toEqual({
      result: 'R',
      receipt: '',
    });
  });

  test('an entry older than the window is never consumed', () => {
    // Isolates the window check. Without it, a dispatch whose duplicate never
    // arrived would answer an identical command arbitrarily far in the future.
    const realNow = Date.now;
    try {
      markCommandDispatch('ledger-expired', 'add expired probe', 'R', '', true);
      Date.now = () => realNow() + 61_000;
      expect(
        consumeCommandDispatch('ledger-expired', 'add expired probe'),
      ).toBeNull();
      Date.now = () => realNow() + 30_000;
      expect(
        consumeCommandDispatch('ledger-expired', 'add expired probe'),
      ).toEqual({result: 'R', receipt: ''});
    } finally {
      Date.now = realNow;
    }
  });
});

describe('v1 double-dispatch: a TRUNCATED echo must not replace the goal', () => {
  // LIVE DEFECT, stock v1, 2026-09-26 (evidence:
  // scratch/attestation-live-2026-09-26/). The user typed one `/goal` whose
  // objective had two sentences. The hook applied the FULL text and created the
  // goal; the host then ran the config template, and the model re-submitted the
  // objective TRUNCATED AT THE FIRST PERIOD. The guard tolerated only a
  // one-insignificant-token difference, so it missed a nine-token truncation,
  // the handler called replaceGoals, and the goal was recreated carrying the
  // truncated objective — the user's stated objective silently altered, and the
  // goal the hook created destroyed. The guard's own doc calls a false match
  // "recoverable" and a miss the safe direction, but that reasoning assumed a
  // missed duplicate only RE-RUNS a mutation; for the bare-objective form it
  // CORRUPTS the objective, which is worse.
  const FULL =
    'Write a file named DONE.txt containing the word shipped. Then call update_goal with status complete.';
  const TRUNCATED = 'Write a file named DONE.txt containing the word shipped.';

  test("the objective the USER stated survives the model's truncated echo", async () => {
    const hooks = await makePlugin();
    const sessionID = 'dd-truncated-echo';

    const hookText = await viaCommandHook(hooks, sessionID, FULL);
    expect(hookText).toContain('New active goal');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    const firstId = await focusedGoalId(hooks, sessionID);

    // The model's lossy copy of our own objective.
    await viaGoalCommandTool(hooks, sessionID, TRUNCATED);

    // ONE goal, the SAME goal, and the FULL objective — not the model's edit.
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
    expect(await focusedGoalId(hooks, sessionID)).toBe(firstId);
    const goals = (
      (await hooks.tool!.list_goals) as {
        execute: (a: unknown, c: unknown) => Promise<unknown>;
      }
    ).execute({}, {sessionID});
    expect(JSON.stringify(await goals)).toContain(
      'Then call update_goal with status complete',
    );
  });

  test('a LONGER incoming objective is NOT swallowed — it is a genuine new command', async () => {
    // The direction is deliberately strict. A model that APPENDS text is not
    // reproducing our template, it is issuing a different objective, and
    // swallowing that would be the Run-3 BLK-3.2 defect this project already
    // measured (`add fix the tests` -> `add fix the tests and the linter`). Only
    // an echo that LOST TRAILING TEXT is a duplicate.
    const hooks = await makePlugin();
    const sessionID = 'dd-truncated-reverse';

    await viaCommandHook(hooks, sessionID, TRUNCATED);
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    await viaGoalCommandTool(hooks, sessionID, FULL);
    // A bare objective REPLACES, so the count stays 1 — but the objective must
    // now be the longer one, i.e. the command actually ran.
    const goals = (
      (await hooks.tool!.list_goals) as {
        execute: (a: unknown, c: unknown) => Promise<unknown>;
      }
    ).execute({}, {sessionID});
    expect(JSON.stringify(await goals)).toContain(
      'Then call update_goal with status complete',
    );
  });

  test('a genuinely DIFFERENT objective is still applied', async () => {
    // The prefix rule must not swallow a real second goal. This is the case the
    // narrow tolerance was protecting, and it must still hold.
    const hooks = await makePlugin();
    const sessionID = 'dd-truncated-different';

    await viaCommandHook(hooks, sessionID, 'fix the broken add function');
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);

    // Shares NO prefix beyond the first two words.
    await viaGoalCommandTool(
      hooks,
      sessionID,
      'fix the broken multiply function',
    );
    expect(await activeGoalCount(hooks, sessionID)).toBe(1);
  });
});

describe("v1 double-dispatch: the truncation tolerance's ACCEPTED false-positive", () => {
  // The truncation rule is a deliberate trade, and this suite pins BOTH sides of
  // it so the trade cannot drift silently.
  //
  // A miss is destructive: for a bare objective the handler runs `replaceGoals`,
  // which removes every unfinished goal (the / blast-radius class), and the
  // live 2026-09-26 defect showed it also rewrites the user's stated objective
  // from the model's truncated copy. A false match merely replays a receipt.
  //
  // So a shorter token-PREFIX of a bare objective is treated as an echo. That
  // means a genuinely different, SHORTER objective can be answered from the
  // recording instead of running. The reachability is narrow — end-to-end on
  // stock v1 the second submission's own hook recording shadows the older entry,
  // and a bare objective is the only form affected — but the behaviour is real,
  // so it is asserted rather than left unguarded.

  test('a shorter token-prefix of a bare objective IS treated as the same submission', () => {
    markCommandDispatch(
      'ledger-prefix-swallow',
      'refactor the parser and the lexer',
      'RECORDED',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-prefix-swallow', 'refactor the parser'),
    ).toEqual({
      result: 'RECORDED',
      receipt: '',
    });
  });

  test("the intended case — the live defect's truncation echo — is still caught", () => {
    markCommandDispatch(
      'ledger-live-truncation',
      'Write a file named DONE.txt containing the word shipped. Then call update_goal with status complete.',
      'RECORDED',
      '',
      true,
    );
    expect(
      consumeCommandDispatch(
        'ledger-live-truncation',
        'Write a file named DONE.txt containing the word shipped.',
      ),
    ).toEqual({result: 'RECORDED', receipt: ''});
  });

  test('a SUBSTITUTION of the same length is NOT swallowed', () => {
    // The prefix rule requires a token-wise prefix; a different word anywhere
    // before the end is a different objective.
    markCommandDispatch(
      'ledger-substitution',
      'fix the broken add function',
      'RECORDED',
      '',
      true,
    );
    expect(
      consumeCommandDispatch(
        'ledger-substitution',
        'fix the broken multiply function',
      ),
    ).toBeNull();
  });

  test('an UNRELATED objective is not swallowed', () => {
    markCommandDispatch(
      'ledger-unrelated',
      'fix the parser',
      'RECORDED',
      '',
      true,
    );
    expect(
      consumeCommandDispatch('ledger-unrelated', 'deploy the release'),
    ).toBeNull();
  });
});
