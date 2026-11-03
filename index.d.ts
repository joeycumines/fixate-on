/** Type declarations for fixate-on.
 * They describe the options object a user passes in `opencode.json` under
 * `plugin: [["fixate-on", {... }]]`, together with the shape of the exports
 * this module offers. */
/** Verdict returned by a completion judge (built-in or custom). See
 * {@link GoalsPluginOptions.judge} and {@link GoalsPluginOptions.childSessionJudge}. */
export interface JudgeVerdict {
  /** `true` archives the goal as achieved; `false` rejects the completion. */
  approved: boolean;
  /** Reason for the verdict, shown in the goal's status when the completion is rejected. */
  reason?: string;
} // JudgeVerdict
/** A timestamped lifecycle event kept with a goal, whether it is active or archived. */
export interface GoalLifecycleEvent {
  type: string;
  detail: string;
  timestamp: number;
} // GoalLifecycleEvent
/** A size-limited progress checkpoint kept with a goal. */
export interface GoalProgressNote {
  summary: string;
  timestamp: number;
} // GoalProgressNote
/** Token and cost usage for the current run of a goal, normalised across hosts. */
export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown: boolean;
} // UsageSnapshot
// TUI transport types
//
// Published because {@link GoalsPluginOptions.tuiTransport} takes one, and because
// a structural approximation of it does not work: a function parameter is
// contravariant, so a hand-written approximation that omits a required field of
// GoalTuiEvent makes the only correct implementation fail to compile. These
// mirror src/tui-state.ts, which imports them from src/state-machine.ts; the
// shapes are pinned by test/published-docs-accuracy.test.ts.
/** Goal lifecycle status, as the TUI sees it. */
export type GoalStatus =
  'active' | 'paused' | 'blocked' | 'budgetLimited' | 'finalizing' | 'complete';
/** What checked a claim, as an identifier. */
export type ClaimCheckPath = 'judge' | 'none';
export type ClaimCheckVerdict =
  | 'COMPLETE'
  | 'WORKING'
  | 'BLOCKED'
  | 'NEEDS_INPUT'
  | 'CANCELLED'
  | 'JUDGE_APPROVED'
  | 'JUDGE_REJECTED'
  | 'JUDGE_FAILURE'
  | 'VERIFIER_FAILURE'
  | 'NONE';
export type ClaimOutcomeStatus =
  | 'verified-complete'
  | 'claim-refuted'
  | 'unverifiable-claim'
  | 'blocked-acknowledged';
export type ClaimActor = 'agent' | 'human' | 'slash-command';
export interface ClaimCheck {
  path: ClaimCheckPath;
  target?: string;
  verdict: ClaimCheckVerdict;
  evidence?: string[];
  timestamp: number;
} // ClaimCheck
export interface ClaimOutcome {
  status: ClaimOutcomeStatus;
  detail: string;
  timestamp: number;
} // ClaimOutcome
export interface ClaimRecord {
  claimId: string;
  timestamp: number;
  actor: ClaimActor;
  claimedStatus: 'complete' | 'blocked';
  claimText: string;
  check: ClaimCheck;
  outcome: ClaimOutcome;
} // ClaimRecord
export interface GoalProposal {
  proposalId: string;
  proposedAt: number;
  objective?: string;
  successCriteria?: string;
  constraints?: string;
  artifactPointers?: string[];
  reason: string;
} // GoalProposal
export type TransitionSource =
  | 'create_goal'
  | 'update_goal'
  | 'propose_goal_change'
  | 'list_goals'
  | 'focus_goal'
  | 'slash-command'
  | 'idle-handler'
  | 'chat-message'
  | 'system-transform'
  | 'recovery'
  | 'retraction'
  | 'completion-gate'
  | 'sequence-replace'
  | 'create_goal-rollback'
  /** A re-arm driven by the POLLER's synthetic idle rather than by one the host
   * delivered — the two write different ledger entries so the record can say which
   * one brought a goal back. */
  | 'poll-idle';
export interface CommitTransition {
  source: TransitionSource;
  from: GoalStatus;
  to: GoalStatus;
  detail: string;
} // CommitTransition
/** A frozen, serializable projection of goal state for the TUI layer. This is
 * the data contract between the server plugin and the TUI companion. */
export interface GoalTuiSnapshot {
  readonly goalId: string;
  readonly sessionID: string;
  readonly condition: string;
  readonly artifactPointers?: ReadonlyArray<string>;
  readonly pendingProposal?: Readonly<GoalProposal> | null;
  readonly claims?: ReadonlyArray<Readonly<ClaimRecord>>;
  readonly lastClaim?: Readonly<ClaimRecord> | null;
  readonly status: GoalStatus;
  readonly revision: number;
  readonly turnCount: number;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly maxTurns: number;
  readonly tokenBudget: number | null;
  readonly usage: Readonly<UsageSnapshot>;
  readonly stopReason: string;
  readonly blockedReason: string;
  /** When the goal was last paused; `0` when it is not paused.
   *
   * Carried on the snapshot because a display surface cannot answer "is this
   * yield still holding its promise" without knowing how long the goal has been
   * parked. A yield (`stopReason: "user intervention"`) is applied on every human
   * message and re-armed on the next idle; where the host delivers no idle, the
   * poller may be unable to deliver one, and the goal then sits still while every
   * surface still promises it will move. A surface reading only `stopReason` has
   * to either promise forever or never promise at all. */
  readonly pausedAt: number;
  /** When this stop was applied; `0` when the goal is not stopped. Renewed on
   * every stop, unlike `pausedAt`, which the elapsed-time clock stamps once.
   *
   * Read by the yield-promise bound: a goal yielded to a human message is
   * due to re-arm, and on a host that delivers no idle events the poller is
   * the only thing that can keep that promise. Past the bound the goal stops
   * being reported as self-resolving, so it briefs and `/goal status` offers a
   * resume instead of claiming the plugin will restart it. */
  readonly stoppedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
  readonly lastCheckpoint: Readonly<{
    summary: string;
    timestamp: number;
  }> | null;
  readonly history: ReadonlyArray<
    Readonly<{type: string; detail: string; timestamp: number}>
  >;
  /** Where this snapshot came from. `"live"` = a real event for the goal's own
   * session. `"disk"` = rehydrated from persisted state, whose goals may belong
   * to pre-restart session IDs, so a dashboard may surface these
   * workspace-wide when the current session has none. */
  readonly origin?: 'live' | 'disk';
} // GoalTuiSnapshot
export type GoalTuiEventKind = 'create' | 'transition' | 'usage' | 'remove';
/** The event payload published by the server broadcaster. */
export interface GoalTuiEvent {
  readonly kind: GoalTuiEventKind;
  readonly sessionID: string;
  readonly timestamp: number;
  /** Present for create/transition/usage events. Absent for remove. */
  readonly snapshot?: GoalTuiSnapshot;
  /** Present only for transition events. */
  readonly transition?: Readonly<CommitTransition>;
  /** The status the goal held immediately BEFORE this transition, when the
   * producer knows it. Present so a receiver can tell an ENTRY into a status
   * from churn within one: a running goal emits a transition on every
   * continuation, so the status alone cannot distinguish "it started working"
   * from "it is still working". Absent means "the producer did not say" — a
   * receiver may still rely on a snapshot that states its own outcome
   * (`complete`, `blocked`, or a limit-class stop), but must not infer a
   * boundary from an `active` snapshot alone. */
  readonly previousStatus?: GoalStatus;
  /** Present only for remove events. */
  readonly goalId?: string;
} // GoalTuiEvent
/** A host-supplied channel for goal lifecycle events. Errors thrown here are
 * swallowed: a TUI disconnect must not break the state machine. */
export type GoalTuiPublishFn = (
  sessionID: string,
  event: GoalTuiEvent,
) => Promise<void> | void;
/** Read-only goal snapshot passed to custom completion judges. */
export interface GoalJudgeSnapshot {
  goalId: string;
  runId: string;
  condition: string;
  successCriteria: string;
  constraints: string;
  mode: 'normal' | 'ordered';
  sessionID: string;
  tokenBudget: number | null;
  maxTokens: number;
  maxTurns: number;
  maxDurationMs: number;
  turnCount: number;
  totalTokens: number;
  usage: Readonly<UsageSnapshot>;
  createdAt: number;
  startedAt: number;
  pausedAt: number;
  status: string;
  stopReason: string;
  blockedReason: string;
  lastStatus: string;
  history: readonly Readonly<GoalLifecycleEvent>[];
  checkpoints: readonly Readonly<GoalProgressNote>[];
  lastCheckpoint: Readonly<GoalProgressNote> | null;
} // GoalJudgeSnapshot
/** Arguments passed to a custom {@link GoalsPluginOptions.judge} function. */
export interface JudgeContext {
  /** The goal under judgement: its objective, budget use and checkpoints. */
  goal: Readonly<GoalJudgeSnapshot>;
  /** The OpenCode session that owns the goal. */
  sessionID: string;
  /** The assistant's most recent response, which carries the completion claim. */
  latestText: string;
} // JudgeContext
/** Options for the built-in child-session judge, used when `childSessionJudge` is `true`. */
export interface JudgeOptions {
  /** How long, in milliseconds, the built-in judge waits for a verdict from its
   * child OpenCode session. On timeout the claim is rejected and the goal is
   * paused. Operational failures follow {@link failurePolicy}.
   * @default 120000 */
  timeoutMs?: number;
  /** The result used when the child-session API is unavailable, returns a
   * malformed response, throws, or times out. A rejected claim or an invalid
   * verdict is always rejected. `"approve"` exists for compatibility only.
   * @default "reject" */
  failurePolicy?: 'reject' | 'approve';
} // JudgeOptions
/** Options for fixate-on. Every field is optional; an unset field takes the
 * built-in default. The budget and behaviour fields set the limits for every
 * goal in a session, and most of them can be overridden for one goal with a
 * `/goal` flag (for example `--max-turns`, `--success` or `--mode`). */
export interface GoalsPluginOptions {
  /** Per-goal defaults for every brake and threshold below, applied to every
   * goal the plugin creates. A `/goal` flag overrides the value for that goal
   * only; this object changes the floor every goal starts from.
   *
   * Omit it to use the documented defaults on each option below. */
  defaultGoalOptions?: Partial<{
    maxTokens: number;
    maxTurns: number;
    maxDurationMs: number;
    minDelayMs: number;
    maxPromptFailures: number;
    maxRecentMessages: number;
    noProgressTokenThreshold: number;
    noProgressTurnsBeforePause: number;
    noToolCallTurnsBeforePause: number;
    budgetWrapupRatio: number;
    maxRecoveryTurns: number;
    maxUnchangedResults: number;
    maxBlockedTurns: number;
    languageTriage: boolean;
  }>;
  /** Path to a loop-policy file. When set, the policy document at this path is
   * read on each continuation and its directives override the plugin's own
   * steering for that goal. Omit it to use the built-in policy. */
  loopPolicyPath?: string;
  /** The OpenCode session SDK argument shape. The plugin input supplies the
   * generated client, which uses the `"legacy"` shape. Set `"flat"` when the
   * plugin is embedded with the v2 SDK. The adapter records the shape that worked
   * for each operation.
   * @default "legacy" */
  sdkShape?: 'legacy' | 'flat';
  /** The maximum number of auto-continue turns sent for a goal before the goal is
   * stopped for exceeding a limit. Set it for one goal with `--max-turns`.
   *
   * **Disabled by default (`0` = no turn brake).** A turn count cannot tell a
   * productive goal from a stuck one, and real work would then fail unless the
   * user remembered `--max-turns`. The goal is still bounded by the stall brake
   * and the cumulative context brake, which fire on observed signals.
   * @default 0 */
  maxTurns?: number;
  /** The maximum time, in milliseconds, a goal may go without progress before it is
   * stopped for exceeding a limit. Set it for one goal with `--max-duration-ms` or
   * `--max-minutes`.
   *
   * This is a stall brake: the clock measures time since the last evidence of
   * progress, not total run time. Progress is recorded on a new assistant turn or
   * an increase in output tokens. An outstanding tool call does not count as
   * progress, so a hung tool call cannot hold the goal open.
   * @default 1800000 */
  maxDurationMs?: number;
  /** The maximum context-token budget a goal may use before it is stopped for
   * exceeding a limit. Set it for one goal with `--max-tokens`, or with the
   * `--budget` shorthand, which takes a `k` or `m` suffix such as `100k` or `1.5m`.
   *
   * The count is cumulative over the whole goal (`totalTokens + compactionBaselineTokens`),
   * so compaction does not reduce it. It is a ceiling, not a target.
   * @default 1000000 */
  maxTokens?: number;
  /** The minimum delay, in milliseconds, between two auto-continue prompts. Set it
   * for one goal with `--cooldown-ms`.
   * @default 1500 */
  minDelayMs?: number;
  /** The number of recent session messages scanned for the latest assistant turn
   * before auto-continuing. A higher value keeps long, tool-heavy sessions from
   * losing the most recent response.
   * @default 50 */
  maxRecentMessages?: number;
  /** The output-token floor below which a turn counts as low-output for no-progress
   * detection. Set it for one goal with `--no-progress-threshold`.
   * @default 50 */
  noProgressTokenThreshold?: number;
  /** The number of consecutive stalled low-output turns allowed before the goal is
   * paused. The goal is not paused on the first one. Set it for one goal with
   * `--no-progress-turns`.
   * @default 3 */
  noProgressTurnsBeforePause?: number;
  /** The number of consecutive tool-free continuation turns ("talk only" turns)
   * allowed before the goal is paused. This complements the no-progress check by
   * catching loops that produce output without using tools. Set it for one goal
   * with `--no-tool-turns`. Set the plugin option to `0` to disable the check.
   * @default 3 */
  noToolCallTurnsBeforePause?: number;
  /** The fraction, strictly between 0 and 1, of a budget (turns, duration or
   * tokens) at which the plugin sends one "wrap up" prompt. The prompt asks the
   * model to finish before the hard limit is reached.
   * @default 0.8 */
  budgetWrapupRatio?: number;
  /** The number of remaining auto-continue turns at which a limit warning is added
   * to the continuation prompt.
   *
   * The warning goes in the prompt, not in `/goal status`, so the model receives it
   * while it can still act on it. The three warning options use the same mechanism
   * with different measures. None of them appears on a status surface.
   * @default 3 */
  warnTurnsRemaining?: number;
  /** The remaining duration, in milliseconds, at which a limit warning is added to
   * the continuation prompt. See {@link GoalsPluginOptions.warnTurnsRemaining}.
   *
   * The clock starts at the last evidence of progress, or at the goal's start if
   * there is none. The duration brake uses the same clock, so the warning and the
   * brake agree.
   * @default 60000 */
  warnDurationMsRemaining?: number;
  /** The remaining context tokens at which a limit warning is added to the
   * continuation prompt. See {@link GoalsPluginOptions.warnTurnsRemaining}.
   * @default 25000 */
  warnTokensRemaining?: number;
  /** How many consecutive prompt failures the goal absorbs before it is
   * stopped: a transport error while sending the auto-continue prompt, or a
   * reply that keeps missing the evidence or blocker the format requires.
   * @default 3 */
  maxPromptFailures?: number;
  /** Whether active and background goals, and recent results, are written to disk
   * so they survive a restart. A goal recovered on restart loads paused. Set this
   * to `false` to keep everything in memory. That also disables the lifecycle
   * ledger.
   * @default true */
  persistState?: boolean;
  /** The directory that holds persisted goal state when `persistState` is on. Each
   * session has its own file at `sessions/<sessionID>/state.json`, so two OpenCode
   * processes can share one worktree. This overrides the project-local default and
   * the `FIXATE_ON_STATE_ROOT` environment variable.
   * @default '<cwd>/.opencode/goals' */
  stateRoot?: string;
  /** The workspace directory used to resolve `stateRoot` and other relative paths.
   * The v2 Context does not expose the host's workspace location to plugins. A v2
   * host whose `process.cwd` differs from the project, for example a from-source
   * checkout that changes directory before it starts the CLI, must pass the
   * workspace path here. When the option is absent the plugin uses
   * `process.cwd`, which is correct for v1 hosts and for installed v2 binaries
   * that set their own working directory.
   * @default process.cwd */
  workspaceDirectory?: string;
  /** The maximum size, in bytes, of one lifecycle-ledger generation. Each session has
   * its own ledger at `<sessions>/<sessionID>/state.json.ledger.jsonl`.
   * @default 2097152 */
  ledgerMaxBytes?: number;
  /** The number of rotated lifecycle-ledger generations kept, from 0 to 10. @default 3 */
  ledgerRetentionFiles?: number;
  /** How long, in milliseconds, a finished goal's summary stays available through
   * `/goal status` after the goal leaves active memory.
   * @default 604800000 */
  resultRetentionMs?: number;
  /** The maximum number of finished-goal summaries kept in memory. The oldest are
   * evicted first.
   * @default 10 */
  maxStoredResults?: number;
  /** The slash command the plugin handles. Set it to, for example, `"objective"` to
   * use `/objective` instead of `/goal`. A leading slash is accepted and removed.
   * The same name must also be registered in your OpenCode `command` config.
   * @default "goal" */
  commandName?: string;
  /** The delay, in milliseconds, before the kickoff probe runs after a command that
   * creates a goal. The probe sends the first continuation prompt only when the host
   * started no agent turn for the command. On stock v1, `/goal` runs without an
   * agent, so nothing else drives the new goal and no `session.idle` arrives.
   * @default 2500 */
  kickoffDelayMs?: number;
  /** Whether the synthetic-idle fallback poller runs. On hosts that send no idle
   * events, such as stock v1, the poller is the only way to wake the loop, so it is
   * enabled by default. A host that sends idle events correctly, or a test that
   * drives events directly, should set this to `false`.
   * @default true */
  idlePoller?: boolean;
  /** The poll interval of the synthetic-idle fallback, in milliseconds.
   * @default 5000 */
  idlePollerIntervalMs?: number;
  /** The quiet window, in milliseconds, that must pass before a synthetic idle can
   * fire. It stops the fallback from firing while the host is still working.
   * @default 10000 */
  idleQuietMs?: number;
  /** The grace period, in milliseconds, after a real idle event during which the
   * synthetic poller stays silent. It stops the fallback from driving a turn the
   * host has already ended.
   * @default 30000 */
  idleGraceMs?: number;
  /** A custom transport for goal lifecycle events to the TUI. The v2 adapter uses
   * its own buffer, which passes events through tool `Result.metadata` and never
   * shows them to the user.
   *
   * Supply a transport to bridge a host with a different event surface. If it is
   * unset, the companion takes its state from the persisted state file instead.
   * No host-visible channel is used, because the v1 `client.tui.publish` endpoint
   * shows every envelope as a toast. */
  tuiTransport?: GoalTuiPublishFn;
  /** Whether the plugin installs its `command.execute.before` hook. Set it to
   * `false` if you only want auto-continue and persistence, driven through
   * {@link registerTools}, and do not want the plugin to own a slash command.
   * @default true */
  registerCommand?: boolean;
  /** Whether the plugin registers the agent-facing goal tools
   * (canonical `get_goal`, `create_goal`, `update_goal`,
   * `list_goals`, `focus_goal`, `propose_goal_change`) and, on an
   * OpenCode v2 host, the `goal-command` bridge that makes `/goal`
   * reach goal state at all. The bridge is registered inside this same
   * block, so `false` removes it too.
   *
   * The tools define their parameters with `zod` when it is installed. Without it,
   * each tool registers with a permissive schema. The peer dependency on the host
   * is a version floor, not an import.
   * @default true */
  registerTools?: boolean;
  /** Register the `goal` and `goal-verify` agents through OpenCode's config hook.
   * An existing agent with either name is left unchanged.
   * @default true */
  registerAgents?: boolean;
  /** The name of the goal agent the plugin registers. @default "goal" */
  goalAgentName?: string;
  /** The name of the read-only verifier subagent the plugin registers. @default "goal-verify" */
  verifierAgentName?: string;
  /** Enables the built-in child-session completion judge. It is on unless this is
   * `false`. When it is on, a completion claim is checked by the judge before the
   * goal can become terminal. On WORKING the goal enters bounded recovery. On a
   * judge failure, or when recovery is exhausted, the goal escalates: it is
   * paused, and COMPLETE is never fabricated. Set this to `false` to turn the
   * child-session judge off; the gate then abstains on every claim (recorded as
   * an unverifiable claim, never as complete). Tune the judge with
   * {@link judgeOptions}.
   *
   * All execution is agent-driven: the plugin never runs a program to check a
   * claim — no explicit verifier command, no Makefile target, no auto-detected
   * test command. The agent runs its own checks (tests, builds, diffs) with its
   * own tools and cites the evidence; the judge attests the claim. The judge's
   * verdict object is shaped by `completion-verdict.schema.json`, which ships
   * with the package.
   *
   * @default true */
  childSessionJudge?: boolean;
  /** The maximum number of bounded recovery turns before the goal escalates. It is
   * paused with the stop reason "recovery exhausted". A recovery turn is a forced
   * continuation after the verifier reports WORKING.
   * @default 12 */
  maxRecoveryTurns?: number;
  /** The maximum number of consecutive identical verifier results (same candidate
   * and same fingerprint) before the goal escalates. It catches loops in which the
   * agent makes no progress. A change of candidate resets this counter, but it does
   * not reset the total recovery budget.
   * @default 3 */
  maxUnchangedResults?: number;
  /** The number of consecutive `update_goal(blocked)` calls needed before the goal
   * may move to `blocked`. This is separate from `maxUnchangedResults`, which bounds
   * completion recovery, so raising one budget does not raise the other. The streak
   * carries across the idle boundary while the agent keeps asserting blocked. It is
   * reset by a resume or by a turn that is not blocked.
   * @default 3 */
  maxBlockedTurns?: number;
  /** Enable advisory phrase triage for premature-exit language. When
   * true, the agent's final message is scanned for unfinished-work,
   * deferral, permission-seeking, and session-length signals. A match
   * adds the triage reason to the recovery prompt but CANNOT block a
   * verifier-OK COMPLETE. The triage is advisory and abstaining (:
   * patterns.md:340-371, adoption step 9 of 9).
   * @default true */
  languageTriage?: boolean;
  /** Supply a custom completion judge instead of the built-in
   * child-session one. Takes precedence over `childSessionJudge: true`.
   * A verdict of `{ approved: false }` pauses the goal — the stop reason is
   * `"judge rejected"` — rather than archiving it. A thrown error counts
   * as a rejection, so the gate fails closed.
   *
   * The judge is the only verifier the gate consults: the plugin never runs a
   * command to check a claim. */
  judge?: (context: JudgeContext) => Promise<JudgeVerdict>;
  /** Tuning options for the built-in child-session judge. Ignored when
   * a custom {@link judge} is supplied. */
  judgeOptions?: JudgeOptions;
  /** Whether the plugin announces its decisions about the goal instead of
   * running silently: a verdict, an attestation fault, a pause, a recovery
   * turn, or a goal settled without an attestation.
   * @default true */
  goalMessages?: boolean;
  /** Custom sink for those announcements. Defaults to routing through
   * OpenCode's structured log (`client.app.log`) and the TUI toast, whenever
   * those host APIs are available. Provide this to route them elsewhere. */
  goalMessenger?: (sessionID: string, text: string) => Promise<void> | void;
} // GoalsPluginOptions
/** OpenCode plugin hook map returned by the plugin's `server` factory.
 * It matches OpenCode's plugin hook contract, and its input and output stay
 * loose (`unknown`) because OpenCode itself defines those payload shapes,
 * not this package. A member is optional only when the plugin
 * genuinely may omit it — every other hook is registered on every
 * construction. */
export interface GoalsPluginHooks {
  /** Registers the native goal and verifier agents, leaving any agent of the
   * same name that already exists untouched. */
  config: (config: unknown) => Promise<void>;
  /** Captures the run's execution context (agent, model, working directory) at
   * the moment the directory becomes known, so the handback diff reports only
   * what this goal changed. */
  'chat.params': (input: unknown) => Promise<void>;
  /** Detects user intervention and pauses the active goal immediately, so a
   * person answering the assistant stops the continuation loop rather than
   * racing it. */
  'chat.message': (input: unknown, output: unknown) => Promise<void>;
  /** Omitted entirely when {@link GoalsPluginOptions.registerCommand} is `false`. */
  'command.execute.before'?: (input: unknown, output: unknown) => Promise<void>;
  event: (input: unknown) => Promise<void>;
  'experimental.chat.system.transform': (
    input: unknown,
    output: unknown,
  ) => Promise<void>;
  'experimental.compaction.autocontinue': (
    input: unknown,
    output: unknown,
  ) => Promise<void>;
  /** Carries the goal objective, status, budget usage, elapsed time and latest
   * checkpoint into a compaction context, so a context compaction does not drop
   * the goal thread mid-run. */
  'experimental.session.compacting': (
    input: unknown,
    output: unknown,
  ) => Promise<void>;
  /** Agent-facing tool definitions, present only when
   * {@link GoalsPluginOptions.registerTools} is enabled (default) and `zod`
   * resolves. On an OpenCode v2 host the `goal-command` bridge is registered
   * inside the same block, so `registerTools: false` removes it too. */
  tool?: Record<string, unknown>;
  /** Cancels the pending continuation work and releases this plugin instance. */
  dispose: () => Promise<void>;
} // GoalsPluginHooks
/** The plugin's `server` factory. OpenCode calls this with a client bound
 * to the running session, and with the plugin options it resolved from
 * `opencode.json`. */
export function GoalsPlugin(
  /**
   * The host context.
   *
   * `client` is optional because the runtime defaults the whole
   * context: `GoalsPlugin` and `GoalsPlugin({})` are both valid
   * and are what the tests drive, so a declaration that made it
   * required would reject correct callers. `directory` is
   * OpenCode's resolved project directory for this plugin instance.
   */
  context: {client?: unknown; directory?: string},
  options?: GoalsPluginOptions,
): Promise<GoalsPluginHooks>;
/** The default export. One object satisfies both host loaders.
 *
 * OpenCode 1.x reads `server` and calls it to obtain the plugin's hooks.
 * OpenCode v2 reads `id` and calls `setup`, which wraps the v2 context and
 * bridges each hook to the same runtime; its loader validates `default`
 * against a schema that requires `effect` or `setup`, so a v2 host cannot
 * load this package without it. */
declare const goalsPlugin: {
  id: 'fixate-on';
  server: typeof GoalsPlugin;
  /** The OpenCode v2 entry point. See above. Returns the teardown the host
   * calls to release the plugin instance. */
  setup: (context: unknown) => Promise<() => Promise<void>>;
}; // goalsPlugin
export default goalsPlugin;
