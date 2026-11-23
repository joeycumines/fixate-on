/**
 * Bridge 4 command/kickoff dispatch helpers for the OpenCode v2 plugin adapter.
 *
 * Kept as a leaf module (depends only on node:fs) so `plugin-v2.ts` and
 * `plugin-v2-helpers.ts` stay focused and cohesive without circular imports.
 */

import {appendFileSync} from 'node:fs';
import {
  classifyGoalCommandOperation,
  parseGoalCommand,
  ATTACHMENT_ACTIVATION_ERROR,
  splitLeadingGoalId,
} from './commands-args.ts';
import type {GoalState} from './state-machine.ts';

export interface V2CommandExecutionInput {
  readonly sessionID: string;
  readonly prompt?: {
    readonly text?: unknown;
    readonly files?: unknown[];
    readonly agents?: unknown[];
    readonly skills?: unknown[];
  };
  readonly delivery?: unknown;
}

/** Validates and extracts command input passed by v2 `CommandEditor.add` `execute`. */
export function validateV2CommandExecutionInput(input: unknown): {
  sessionID: string;
  rawArgs: string;
  prompt?: Record<string, unknown>;
  hasAttachments: boolean;
  delivery?: string;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Goal command input is required.');
  }
  const obj = input as V2CommandExecutionInput;
  const sessionID =
    typeof obj.sessionID === 'string' ? obj.sessionID.trim() : '';
  if (!sessionID) {
    throw new Error('Goal command requires an active session.');
  }
  let promptObj: Record<string, unknown> | undefined;
  if (obj.prompt !== undefined && obj.prompt !== null) {
    if (typeof obj.prompt !== 'object' || Array.isArray(obj.prompt)) {
      throw new Error('Goal command prompt must be an object.');
    }
    promptObj = obj.prompt as Record<string, unknown>;
  }
  const rawText = promptObj?.text;
  if (
    rawText !== undefined &&
    rawText !== null &&
    typeof rawText !== 'string'
  ) {
    throw new Error('Goal command arguments must be text.');
  }
  const rawArgs = typeof rawText === 'string' ? rawText.trim() : '';
  let hasAttachments = false;
  if (promptObj) {
    for (const key of ['files', 'agents', 'skills'] as const) {
      const items = promptObj[key];
      if (items === undefined || items === null) continue;
      if (!Array.isArray(items)) {
        throw new Error(`Goal command prompt.${key} must be an array.`);
      }
      if (items.length > 0) hasAttachments = true;
    }
  }
  const delivery =
    typeof obj.delivery === 'string' && obj.delivery.length > 0
      ? obj.delivery
      : undefined;
  return {sessionID, rawArgs, prompt: promptObj, hasAttachments, delivery};
}

/**
 * Validate attachment eligibility using only the parsed command line, BEFORE the
 * state-mutating runner executes. The post-runner fence cannot undo a `clear`
 * or `edit` that already committed; this preflight can.
 *
 * A bare objective (no subcommand root) starts a goal, and `resume`/`edit`/
 * `add`/`sequence` may start or resume one. Every other named subcommand is
 * read-only or lifecycle/control output and must not carry attachments.
 */
export function assertV2AttachmentsBeforeRun(args: {
  rawArgs: string;
  hasAttachments: boolean;
  activeGoalStatus?: (goalId: string | null) => string | undefined;
  canRecoverAttachedEdit?: (goalId: string | null) => boolean;
  goalIds?: () => string[];
}): void {
  if (!args.hasAttachments) return;
  const operation = classifyGoalCommandOperation(args.rawArgs);
  if (
    operation === 'set' ||
    operation === 'resume' ||
    operation === 'add' ||
    operation === 'sequence'
  )
    return;
  if (operation === 'edit') {
    const operand = parseGoalCommand(args.rawArgs).operand;
    const goalIds = args.goalIds?.() ?? [];
    // Resolve the named goal against the session's real goal list so non-UUID
    // ids (test fixtures, legacy ids) match too; splitLeadingGoalId falls back
    // to a UUID-shape guess when the operand's first token is not a known id.
    const {goalId} = splitLeadingGoalId(
      goalIds.map(id => ({goalId: id}) as GoalState),
      operand,
    );
    const status = args.activeGoalStatus?.(goalId);
    // An attachment-bearing edit may proceed when the command transitions a
    // paused/blocked goal to active, or recovers an active goal whose original
    // kickoff inputs were lost across a restart (kickoffAdmissionPending with
    // no retained dispatch).
    if (status === 'paused' || status === 'blocked') return;
    if (status === 'active' && args.canRecoverAttachedEdit?.(goalId)) return;
    if (status === undefined && !goalId) return;
  }
  throw new Error(ATTACHMENT_ACTIVATION_ERROR);
}

/** Command names rewritten by the legacy `CommandEditor.update` fallback. */
export function buildV2CommandLegacyNames(commandName: string): string[] {
  return [
    commandName,
    `${commandName} status`,
    `${commandName} history`,
    `${commandName} pause`,
    `${commandName} resume`,
    `${commandName} clear`,
    `${commandName} list`,
    `${commandName} focus`,
    `${commandName} edit`,
    `${commandName} checkpoint`,
    `${commandName} add`,
    `${commandName} sequence`,
  ];
}

/** Appends a diagnostic line to `FIXATE_ON_EVENT_LOG` when configured. */
export function logV2DiagnosticEvent(line: string): void {
  const eventLogPath = process.env.FIXATE_ON_EVENT_LOG;
  if (!eventLogPath) return;
  try {
    appendFileSync(eventLogPath, `${Date.now()} ${line}\n`);
  } catch {
    /* diagnostics must never throw */
  }
}

/**
 * Builds the `session.prompt` or `session.synthetic` dispatch payload for an
 * activating `/goal` command run via v2 `CommandEditor.add`.
 */
export function buildV2CommandKickoffDispatch(args: {
  sessionID: string;
  goalID: string;
  condition: string;
  kickoffText: string;
  tuiMetadataKey: string;
  prompt?: Record<string, unknown>;
  hasAttachments: boolean;
  delivery?: string;
  resolvedAgent?: string;
}): {
  method: 'prompt' | 'synthetic';
  payload: Record<string, unknown>;
} {
  const kickoffMetadata = {
    [args.tuiMetadataKey]: {kind: 'kickoff', goalID: args.goalID},
    source: 'goal',
    goalID: args.goalID,
  };
  const deliveryOpt = args.delivery ? {delivery: args.delivery} : {};
  const agentOpt = args.resolvedAgent ? {agent: args.resolvedAgent} : {};
  if (args.hasAttachments) {
    const filesOpt =
      Array.isArray(args.prompt?.files) && args.prompt.files.length > 0
        ? {files: args.prompt.files}
        : {};
    const agentsOpt =
      Array.isArray(args.prompt?.agents) && args.prompt.agents.length > 0
        ? {agents: args.prompt.agents}
        : {};
    const skillsOpt =
      Array.isArray(args.prompt?.skills) && args.prompt.skills.length > 0
        ? {skills: args.prompt.skills}
        : {};
    return {
      method: 'prompt',
      payload: {
        ...filesOpt,
        ...agentsOpt,
        ...skillsOpt,
        sessionID: args.sessionID,
        text: args.kickoffText,
        metadata: kickoffMetadata,
        ...deliveryOpt,
        ...agentOpt,
      },
    };
  }
  const summary = args.condition.replace(/\s+/g, ' ').trim();
  const description =
    summary.length > 119
      ? `Goal: ${summary.slice(0, 118)}…`
      : `Goal: ${summary}`;
  return {
    method: 'synthetic',
    payload: {
      sessionID: args.sessionID,
      text: args.kickoffText,
      description,
      metadata: kickoffMetadata,
      ...deliveryOpt,
      ...agentOpt,
    },
  };
}

/**
 * Reject a resolved host error envelope. A fulfilled transport promise does
 * not establish that the operation succeeded; without this check a rejected
 * kickoff would be recorded as admitted and its retained inputs dropped.
 */
function assertV2KickoffResponse(response: unknown, operation: string): void {
  if (
    response &&
    typeof response === 'object' &&
    'error' in response &&
    (response as {error?: unknown}).error !== undefined &&
    (response as {error?: unknown}).error !== null
  ) {
    const error = (response as {error: unknown}).error;
    throw error instanceof Error
      ? error
      : new Error(
          `${operation} failed: ${JSON.stringify(error) ?? String(error)}`,
        );
  }
}

/**
 * Re-dispatch a retained native command kickoff. Used by both the initial
 * admission path and its delayed retry so agent selection and error handling
 * cannot drift between them.
 */
export async function dispatchV2Kickoff(args: {
  session: {
    prompt(payload: Record<string, unknown>): Promise<unknown>;
    synthetic(payload: Record<string, unknown>): Promise<unknown>;
  };
  selectAgent?: (sessionID: string, agent: string) => Promise<void>;
  recordKickoffText?: (sessionID: string, text: string) => void;
  sessionID: string;
  dispatch: {method: 'prompt' | 'synthetic'; payload: Record<string, unknown>};
}): Promise<void> {
  const {sessionID, dispatch} = args;
  const agent = dispatch.payload.agent;
  if (typeof agent === 'string' && agent.length > 0) {
    if (!args.selectAgent)
      throw new Error(
        `cannot dispatch kickoff with agent ${JSON.stringify(agent)}: host has no switchAgent operation`,
      );
    await args.selectAgent(sessionID, agent);
  }
  if (dispatch.method === 'prompt') {
    args.recordKickoffText?.(sessionID, String(dispatch.payload.text ?? ''));
  }
  const result =
    dispatch.method === 'prompt'
      ? await args.session.prompt(dispatch.payload)
      : await args.session.synthetic(dispatch.payload);
  assertV2KickoffResponse(result, dispatch.method);
}

export interface RecentKickoffTextTracker {
  record(sessionID: string, text: string, now?: number): void;
  matches(sessionID: string, text: string, now?: number): boolean;
  clear(): void;
}

/**
 * Tracks exact kickoff prompt texts recently dispatched via `session.prompt`
 * so a stripped host that drops `metadata` on `session.input.admitted` cannot
 * misclassify the plugin's own attachment kickoff as human intervention.
 */
export function createRecentKickoffTextTracker(
  ttlMs = 60_000,
): RecentKickoffTextTracker {
  const bySession = new Map<string, Map<string, number>>();
  const prune = (entries: Map<string, number>, now: number): void => {
    for (const [k, exp] of entries) {
      if (exp <= now) entries.delete(k);
    }
    while (entries.size > 16) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return {
    record(sessionID, text, now = Date.now()) {
      const trimmed = text.trim();
      if (!sessionID || !trimmed) return;
      let entries = bySession.get(sessionID);
      if (!entries) {
        entries = new Map();
        bySession.set(sessionID, entries);
      }
      // Delete before set so a re-recorded (still-live) kickoff moves to the
      // end of insertion order; pruning the oldest must not evict the entry
      // that was just refreshed for a retry.
      entries.delete(trimmed);
      entries.set(trimmed, now + ttlMs);
      prune(entries, now);
    },
    matches(sessionID, text, now = Date.now()) {
      const trimmed = text.trim();
      if (!sessionID || !trimmed) return false;
      const entries = bySession.get(sessionID);
      if (!entries) return false;
      prune(entries, now);
      return (entries.get(trimmed) ?? 0) > now;
    },
    clear() {
      bySession.clear();
    },
  };
}

/**
 * Ensures pre-runner attachment and post-runner activation/fence invariants hold
 * for v2 `CommandEditor.add` executions without silently dropping inputs or
 * prompting fenced sessions.
 */
export function assertV2CommandCanDispatch(args: {
  sessionID: string;
  rawArgs: string;
  hasAttachments: boolean;
  commandName: string;
  cancelledByHuman?: boolean;
  res: {
    handled: boolean;
    ok: boolean;
    text: string;
    rendered: string;
    error?: string;
    enteredActive: boolean;
    after: unknown;
  };
  canDriveSession?: boolean;
}): void {
  const {res} = args;
  if (!res.handled) throw new Error('Goal command unavailable.');
  if (!res.ok) {
    throw new Error(res.error || res.rendered || 'Goal command failed.');
  }
  if (!res.enteredActive || !res.after) {
    if (args.hasAttachments && !args.cancelledByHuman) {
      throw new Error(ATTACHMENT_ACTIVATION_ERROR);
    }
    return;
  }
  if (args.canDriveSession === false) {
    logV2DiagnosticEvent(
      `command.transform ${args.sessionID} kickoff refused: session fenced`,
    );
    throw new Error(
      res.text ||
        `Cannot drive goal in session ${args.sessionID}: session state is locked or unreadable.`,
    );
  }
}

/** Marks normalized user messages matching a recently dispatched kickoff prompt as synthetic. */
export function markRecentKickoffMessages(
  messages: unknown[],
  sessionID: string,
  tuiMetadataKey: string,
  tracker?: RecentKickoffTextTracker,
): unknown[] {
  if (!tracker) return messages;
  return messages.map(raw => {
    if (!raw || typeof raw !== 'object') return raw;
    const msg = raw as {
      info?: {
        role?: string;
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      };
      parts?: unknown[];
    };
    if (msg.info?.role !== 'user' || msg.info?.synthetic === true) return raw;
    if (msg.info?.metadata?.[tuiMetadataKey]) return raw;
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const alreadyInjected = parts.some(p => {
      const part = p as {
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      } | null;
      return (
        part?.synthetic === true || Boolean(part?.metadata?.[tuiMetadataKey])
      );
    });
    if (alreadyInjected) return raw;
    const text = parts
      .map(p =>
        p &&
        typeof p === 'object' &&
        (p as {type?: string}).type === 'text' &&
        typeof (p as {text?: unknown}).text === 'string'
          ? (p as {text: string}).text
          : '',
      )
      .filter(Boolean)
      .join('\n\n');
    if (!text || !tracker.matches(sessionID, text)) return raw;
    return {
      ...msg,
      info: {...msg.info, synthetic: true},
      parts: parts.map(p =>
        p && typeof p === 'object'
          ? {...(p as Record<string, unknown>), synthetic: true}
          : p,
      ),
    };
  });
}

/** Rewrites legacy update-only `CommandEditor` entries onto `goal-command`. */
export function applyV2LegacyCommandUpdates(
  draft: {
    update: (
      name: string,
      edit: (command: Record<string, unknown>) => void,
    ) => void;
  },
  commandName: string,
  templatePrefix: string,
): void {
  for (const name of buildV2CommandLegacyNames(commandName)) {
    draft.update(name, command => {
      const argument =
        name === commandName
          ? '$ARGUMENTS'
          : `${name.slice(commandName.length + 1)} $ARGUMENTS`.trim();
      command.template =
        `${templatePrefix} ${argument}\n` +
        'Do not summarize, do not ask for confirmation, and do not perform any other work. Reply with only the tool output.';
      delete command.agent;
    });
  }
}
