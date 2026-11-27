/**
 * Resolve an asynchronous v2 prompt to the assistant that actually completed it.
 * OpenCode 2.2.7's wait acknowledges idle even when execution failed. The durable
 * idle row and session outcome, rather than parsable assistant text, attest that
 * the current admitted input reached a successful execution boundary.
 */
import {
  normalizeV2Message,
  unwrapV2Data,
  type V2SessionDomain,
} from './plugin-v2-helpers.ts';
import {extractChildVerdictText} from './child-session-response.ts';

type Row = {
  id?: unknown;
  type?: unknown;
  sessionID?: unknown;
  agent?: unknown;
  finish?: unknown;
  outcome?: unknown;
  error?: {message?: unknown};
  time?: {
    created?: unknown;
    completed?: unknown;
    busy?: unknown;
    idle?: unknown;
  };
};

function milliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Reject cancellation promptly without cancelling observation of host errors. */
export async function waitForV2Session(
  session: V2SessionDomain,
  sessionID: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!sessionID || typeof session.wait !== 'function')
    throw new Error(
      'Session completion wait is unavailable for asynchronous prompt admission.',
    );
  signal?.throwIfAborted();
  const waiting = Promise.resolve(session.wait({sessionID}));
  if (!signal) {
    await waiting;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, {once: true});
    waiting.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
  signal.throwIfAborted();
}

export async function readV2SettledAssistant(
  session: V2SessionDomain,
  sessionID: string,
  admission: unknown,
  agent?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const admitted = unwrapV2Data(admission) as Row | null;
  if (
    !admitted ||
    typeof admitted.id !== 'string' ||
    !admitted.id ||
    admitted.type !== 'user' ||
    admitted.sessionID !== sessionID
  )
    throw new Error('Current prompt admission identity is unavailable.');
  signal?.throwIfAborted();
  if (typeof session.context !== 'function')
    throw new Error('Fresh session context is unavailable on this host.');
  const context = unwrapV2Data(await session.context({sessionID}));
  signal?.throwIfAborted();
  if (!Array.isArray(context))
    throw new Error('Fresh session context did not contain messages.');
  const rows = context as Array<Row | null>;
  let projectedIdle: number | undefined;
  for (const row of rows) {
    if (row?.type !== 'idle') continue;
    if (!milliseconds(row.time?.created))
      throw new Error('Child execution idle timestamp is unavailable.');
    // The v2.2.7 projector advances time.idle by at least one millisecond per
    // terminal, even when several terminals share an event timestamp. Rebuild
    // that stamp so a newer success cannot bless an older context read.
    projectedIdle = Math.max(
      row.time.created,
      projectedIdle === undefined ? row.time.created : projectedIdle + 1,
    );
  }
  const admittedIndex = rows.findIndex(row => row?.id === admitted.id);
  if (admittedIndex < 0 || rows[admittedIndex]?.type !== 'user')
    throw new Error(
      'Fresh session context does not contain the admitted input.',
    );

  let final: Row | undefined;
  let terminal: Row | undefined;
  for (const row of rows.slice(admittedIndex + 1)) {
    if (!row || typeof row !== 'object') continue;
    if (row.type === 'user')
      throw new Error('Child execution was superseded by another user input.');
    if (row.type === 'assistant') {
      final = row;
      terminal = undefined;
    } else if (row.type === 'idle') {
      // An idle without a new assistant cannot settle a previous failed turn.
      if (terminal) final = undefined;
      terminal = row;
    } else if (row.type === 'synthetic' && terminal) {
      final = undefined;
      terminal = undefined;
    }
  }
  if (!terminal)
    throw new Error('Child execution has no completed idle boundary.');
  if (terminal.outcome !== 'succeeded' || terminal.error != null) {
    const detail = terminal.error?.message;
    throw new Error(
      `Child execution ${String(terminal.outcome ?? 'unsettled')}: ${typeof detail === 'string' ? detail : 'no successful attestation'}`,
    );
  }
  if (!final)
    throw new Error('Child execution has no final assistant for this input.');
  // Validate explicit errors even if a contradictory host idle row says success.
  const response = normalizeV2Message(final);
  const text = extractChildVerdictText(response);
  if (
    final.finish !== 'stop' ||
    !milliseconds(final.time?.created) ||
    !milliseconds(final.time?.completed) ||
    !milliseconds(terminal.time?.created) ||
    final.time.completed < final.time.created ||
    terminal.time.created < final.time.completed
  )
    throw new Error('Child assistant did not finish before execution settled.');
  if (agent && final.agent !== agent)
    throw new Error(
      `Child assistant ran under agent ${String(final.agent ?? 'unset')}, not ${agent}.`,
    );
  if (!text.trim())
    throw new Error('Child final assistant contains no verdict.');

  // Read after context: a newer failure or still-running execution must not
  // inherit a stale successful idle row from the preceding turn.
  if (typeof session.get !== 'function')
    throw new Error('Child execution outcome is unavailable on this host.');
  const current = unwrapV2Data(await session.get({sessionID})) as Row | null;
  signal?.throwIfAborted();
  if (
    current?.id !== sessionID ||
    current.outcome !== 'succeeded' ||
    !milliseconds(current.time?.busy) ||
    !milliseconds(current.time?.idle) ||
    current.time.busy > final.time.created ||
    current.time.idle < current.time.busy ||
    current.time.idle !== projectedIdle
  )
    throw new Error(
      `Child execution has no current successful settlement (outcome: ${String(current?.outcome ?? 'unavailable')}).`,
    );
  return response;
}
