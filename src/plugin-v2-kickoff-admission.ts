/**
 * Native command admission across the host's asynchronous prompt preparation.
 * v2.2.7's Promise adapter cannot cancel file/skill materialization and exposes
 * no inbox removal method. Persist unconfirmed input IDs before invoking it;
 * model hooks prevent a late, cancelled input reaching a model.
 */

import {createHmac, randomBytes, randomInt} from 'node:crypto';
import type {RuntimeState, KickoffInputHistory} from './session-runtime.ts';
import type {
  V2SessionContext,
  V2SessionDomain,
  V2SessionTitleContext,
} from './plugin-v2-helpers.ts';
import {
  dispatchV2Kickoff,
  KickoffConfirmationError,
} from './plugin-v2-command.ts';

/** Refuse another admission rather than evict a guard that may still matter. */
export const MAX_UNCONFIRMED_KICKOFF_INPUTS = 1024;

let lastInputTimestamp = 0;
let inputCounter = 0;

/**
 * Rejection-sampled uniform characters from a cryptographically secure
 * source. `randomInt` consumes a rejection-sampled, uniformly distributed
 * integer rather than a biased `byte % alphabet.length` reduction, so every
 * alphabet symbol is equiprobable (CodeQL js/biased-cryptographic-random).
 */
function createUnbiasedEntropy(alphabet: string, length: number): string {
  let entropy = '';
  for (let index = 0; index < length; index++)
    entropy += alphabet[randomInt(alphabet.length)];
  return entropy;
}

/** Same prefix layout as v2.2.7 schema/identifier.ts for host-ID ordering. */
export function createV2KickoffInputID(timestamp = Date.now()): string {
  if (timestamp !== lastInputTimestamp) {
    lastInputTimestamp = timestamp;
    inputCounter = 0;
  }
  const packed =
    (BigInt(timestamp) * 0x1000n + BigInt(++inputCounter)) & 0xffffffffffffn;
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const entropy = createUnbiasedEntropy(alphabet, 14);
  return `msg_${packed.toString(16).padStart(12, '0')}${entropy}`;
}

export type V2KickoffDispatch = Parameters<
  typeof dispatchV2Kickoff
>[0]['dispatch'];
export type GuardedV2KickoffDispatch = (
  sessionID: string,
  dispatch: V2KickoffDispatch,
  assertActive: () => void,
) => Promise<void>;

export async function registerV2KickoffAdmission(args: {
  session: V2SessionDomain;
  runtime: RuntimeState;
  selectAgent?: (sessionID: string, agent: string) => Promise<void>;
  recordKickoffText?: (sessionID: string, text: string) => void;
}): Promise<{
  dispatch: GuardedV2KickoffDispatch;
  dispose: () => Promise<void>;
}> {
  const {session, runtime} = args;
  const unsupported = () =>
    new Error(
      'This host does not expose every hook required for native goal kickoff admission. Use a supported host before starting or resuming a goal through this command.',
    );
  if (
    typeof session.hook !== 'function' ||
    typeof session.context !== 'function'
  ) {
    // No protected input can be introduced through this adapter. In particular,
    // do not install an unusable history-reading hook on older hosts and thereby
    // break their ordinary, unrelated user prompts.
    return {
      dispatch: async () => {
        throw unsupported();
      },
      dispose: async () => {},
    };
  }
  const authorizations = new Map<
    string,
    {
      sessionID: string;
      assertActive: () => void;
      ready: Promise<void>;
      confirmed: boolean;
    }
  >();
  let disposed = false;
  // The host converts thrown hook errors to {type: 'unknown', message}. Bind
  // that surviving message to this instance and session, without suppressing
  // unrelated provider failures or retaining an unbounded set of error IDs.
  const cancellationKey = randomBytes(32);
  const cancellationMessage = (sessionID: string) =>
    `Cancelled goal kickoff cannot start a model request. [fixate-on:${createHmac(
      'sha256',
      cancellationKey,
    )
      .update(sessionID)
      .digest('hex')}]`;
  const compactionMessage = (sessionID: string) =>
    `Goal history cannot be compacted or replayed while kickoff admission history is unresolved. Restore the original admission state, or start a new session and resubmit the required inputs. [fixate-on:${createHmac(
      'sha256',
      cancellationKey,
    )
      .update(`${sessionID}\u0000compaction`)
      .digest('hex')}]`;
  const compactionNotices = new Set<string>();
  const rejectCompactionHistory = async (sessionID: string): Promise<never> => {
    const message = compactionMessage(sessionID);
    if (!compactionNotices.has(sessionID)) {
      compactionNotices.add(sessionID);
      while (compactionNotices.size > 256)
        compactionNotices.delete(compactionNotices.values().next().value!);
      await runtime
        .announceKickoffFailure?.(
          sessionID,
          message.slice(0, message.indexOf(' [fixate-on:')),
        )
        .catch(() => {});
    }
    throw new Error(message);
  };
  runtime.isKickoffCancellationError = (sessionID, error) => {
    if (!error || typeof error !== 'object') return false;
    const failure = error as {type?: unknown; message?: unknown};
    return (
      failure.type === 'unknown' &&
      (failure.message === cancellationMessage(sessionID) ||
        failure.message === compactionMessage(sessionID))
    );
  };
  const readHistory = async (sessionID: string): Promise<unknown[]> => {
    if (typeof session.context !== 'function')
      throw new Error(
        'Host history is unavailable for checking unconfirmed goal inputs.',
      );
    const raw = await session.context({sessionID});
    const data =
      raw && typeof raw === 'object' && 'data' in raw
        ? (raw as {data: unknown}).data
        : raw;
    if (!Array.isArray(data))
      throw new Error(
        'Host history did not return messages for kickoff admission.',
      );
    return data;
  };
  const isUnconfirmed = (id: string): boolean =>
    [...runtime.unconfirmedKickoffInputs.values()].some(ids => ids.has(id));
  const authorized = (sessionID: string, id: string): boolean => {
    const permission = authorizations.get(id);
    if (disposed || !permission || permission.sessionID !== sessionID)
      return false;
    if (permission.confirmed) return true;
    try {
      permission.assertActive();
      return true;
    } catch {
      return false;
    }
  };
  const admissionHistory = async (
    sessionID: string,
  ): Promise<KickoffInputHistory> => {
    if (runtime.ownsKickoffInputHistory?.(sessionID) === true)
      return {
        known: runtime.kickoffInputHistoryKnownSessions.has(sessionID),
        unconfirmed:
          runtime.unconfirmedKickoffInputs.get(sessionID) ?? new Set(),
      };
    try {
      const history = await runtime.readKickoffInputHistory?.(sessionID);
      if (history) return history;
    } catch {
      // Missing or unreadable admission records cannot authorize a checkpoint.
    }
    return {known: false, unconfirmed: new Set()};
  };
  const assertCheckpointHistory = async (
    sessionID: string,
    history: unknown[],
  ): Promise<void> => {
    const checkpoints = history.filter(
      value =>
        value &&
        typeof value === 'object' &&
        (value as {type?: unknown}).type === 'compaction' &&
        (value as {status?: unknown}).status === 'completed',
    );
    if (checkpoints.length === 0) return;
    // v2.2.7 fork projector copies rows as fromEvent(event.id) + '_' + seq.
    // A copied checkpoint can use its parent's durable history before the new
    // fork has saved its own state. Locally created or unknown shapes cannot.
    const copied = checkpoints.every(value =>
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}_\d+$/.test(
        String((value as {id?: unknown}).id ?? ''),
      ),
    );
    const visited = new Set<string>();
    let source = sessionID;
    for (;;) {
      if (visited.has(source) || visited.size >= 128)
        return rejectCompactionHistory(sessionID);
      visited.add(source);
      let parent: string | undefined;
      try {
        const response = await session.get({sessionID: source});
        const info = (
          response && typeof response === 'object' && 'data' in response
            ? (response as {data: unknown}).data
            : response
        ) as {id?: unknown; fork?: {sessionID?: unknown}} | null;
        if (info?.id !== source) return rejectCompactionHistory(sessionID);
        if (info.fork !== undefined) {
          if (typeof info.fork?.sessionID !== 'string' || !info.fork.sessionID)
            return rejectCompactionHistory(sessionID);
          parent = info.fork.sessionID;
        }
      } catch {
        return rejectCompactionHistory(sessionID);
      }
      const state = await admissionHistory(source);
      if (
        state.unconfirmed.size > 0 ||
        (!state.known && !(source === sessionID && copied && parent))
      )
        return rejectCompactionHistory(sessionID);
      if (!parent) return;
      source = parent;
    }
  };
  const guardContext = async (
    input: Pick<V2SessionContext, 'sessionID' | 'messages'>,
    history?: unknown[],
    compacting = false,
  ): Promise<void> => {
    const originals = new Map<string, {inputID: string; sessionID: string}>();
    const data = history ?? (await readHistory(input.sessionID));
    {
      // Forks mint fresh message IDs but preserve the message metadata. Resolve
      // their immutable admission provenance from raw history, which the host
      // strips when lowering messages for model context.
      for (const value of data) {
        if (!value || typeof value !== 'object') continue;
        const row = value as {id?: unknown; metadata?: Record<string, unknown>};
        const provenance = row.metadata?.fixateOnKickoffInput as
          {inputID?: unknown; sessionID?: unknown} | undefined;
        if (
          typeof row.id === 'string' &&
          typeof provenance?.inputID === 'string' &&
          typeof provenance.sessionID === 'string'
        )
          originals.set(row.id, {
            inputID: provenance.inputID,
            sessionID: provenance.sessionID,
          });
      }
    }
    // v2 prompt/synthetic return admission receipts after waking a separate
    // execution fiber. Its context hook can therefore await this receipt without
    // blocking admission. No model consumes the inputs before local durability.
    for (const message of input.messages) {
      if (!message || typeof message !== 'object') continue;
      const id = (message as {id?: unknown}).id;
      if (typeof id !== 'string') continue;
      const original = originals.get(id)?.inputID ?? id;
      const permission = authorizations.get(original);
      if (
        permission?.sessionID === input.sessionID &&
        authorized(input.sessionID, original)
      )
        await permission.ready;
    }
    // A valid input following a clean checkpoint is temporarily unconfirmed
    // while its receipt is written. Let its own barrier settle before deciding
    // whether the checkpoint's source has any unresolved admissions.
    await assertCheckpointHistory(input.sessionID, data);
    const foreign = new Map<string, KickoffInputHistory>();
    for (const origin of new Set(
      [...originals.values()].map(p => p.sessionID),
    )) {
      if (runtime.ownsKickoffInputHistory?.(origin) === true) continue;
      // A foreign input may become confirmed while the current input awaits
      // its own receipt. Read after those barriers, so accepted parent context
      // is not silently discarded using an earlier unconfirmed snapshot.
      foreign.set(origin, await admissionHistory(origin));
    }
    const lastAssistant = input.messages.findLastIndex(
      message =>
        message &&
        typeof message === 'object' &&
        (message as {role?: unknown}).role === 'assistant',
    );
    let suppressedInput = false;
    let acceptedInput = false;
    let suppressedHistory = false;
    input.messages = input.messages.filter((message, index) => {
      if (!message || typeof message !== 'object') return true;
      const row = message as {id?: unknown; role?: unknown};
      const provenance =
        typeof row.id === 'string' ? originals.get(row.id) : undefined;
      const id =
        provenance?.inputID ?? (typeof row.id === 'string' ? row.id : '');
      const refreshed = provenance
        ? foreign.get(provenance.sessionID)
        : undefined;
      const guarded =
        (refreshed ? refreshed.unconfirmed.has(id) : isUnconfirmed(id)) ||
        authorizations.has(id);
      const unknownHistory =
        provenance &&
        !(refreshed
          ? refreshed.known
          : runtime.kickoffInputHistoryKnownSessions.has(provenance.sessionID));
      const suppressed = Boolean(
        unknownHistory || (guarded && !authorized(input.sessionID, id)),
      );
      suppressedHistory ||= suppressed;
      if (row.role === 'user' && index > lastAssistant) {
        if (suppressed) suppressedInput = true;
        else acceptedInput = true;
      }
      return !suppressed;
    });
    if (compacting) {
      // The host builds keepID/recent text from raw rows after this hook, and
      // cached summaries may be applied without invoking it again. A filtered
      // model request alone cannot sanitize those durable checkpoints.
      if (
        suppressedHistory ||
        [...originals.values()].some(provenance => {
          const state = foreign.get(provenance.sessionID);
          return (
            !(state
              ? state.known
              : runtime.kickoffInputHistoryKnownSessions.has(
                  provenance.sessionID,
                )) ||
            (state
              ? state.unconfirmed.has(provenance.inputID)
              : isUnconfirmed(provenance.inputID))
          );
        })
      )
        return rejectCompactionHistory(input.sessionID);
      const state = await admissionHistory(input.sessionID);
      if (!state.known) {
        // A fully observed clean transcript establishes a new ordinary session's
        // history. A copied checkpoint also needs the parent validation above;
        // an unknown local checkpoint has already been refused.
        if (!(await runtime.persistKickoffInputHistory?.(input.sessionID)))
          return rejectCompactionHistory(input.sessionID);
      }
    }
    // Other input in the current model cycle still runs, whether it arrived
    // before or after the cancelled kickoff. Historical input before the last
    // assistant cannot independently restart a cancelled request.
    if (suppressedInput && !acceptedInput)
      throw new Error(cancellationMessage(input.sessionID));
  };
  const guardTitle = async (input: V2SessionTitleContext): Promise<void> => {
    const history = await readHistory(input.sessionID);
    const safe = {
      sessionID: input.sessionID,
      messages: history.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const row = value as {
          id?: unknown;
          type?: unknown;
          text?: unknown;
          content?: Array<{type?: unknown; text?: unknown}>;
        };
        const role = row.type === 'assistant' ? 'assistant' : 'user';
        const text =
          row.type === 'assistant'
            ? (row.content ?? [])
                .flatMap(part =>
                  part.type === 'text' && typeof part.text === 'string'
                    ? [part.text]
                    : [],
                )
                .join('\n')
            : (row.type === 'user' || row.type === 'synthetic') &&
                typeof row.text === 'string'
              ? row.text
              : '';
        return text ? [{id: row.id, role, text}] : [];
      }),
    };
    try {
      await guardContext(safe, history);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === cancellationMessage(input.sessionID) ||
          error.message === compactionMessage(input.sessionID))
      ) {
        input.result = 'Goal';
        return;
      }
      throw error;
    }
    const text = safe.messages
      .map(message => `${message.role}: ${message.text}`)
      .join('\n\n')
      .slice(-8000);
    if (!text.trim()) {
      input.result = 'Goal';
      return;
    }
    // v2 title prompts have no source IDs, and their first-user query reaches
    // behind compaction. Rebuild from admissible current history instead of
    // trusting that opaque concatenation or removing text by substring.
    input.messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Here is the conversation to name:\n\n${text}\n\nReply with only the title.`,
          },
        ],
      },
    ];
  };
  const registrations: Array<{dispose: () => Promise<void>}> = [];
  let unavailable = false;
  {
    // Older hosts reject some hook names. Keep the hooks they support and the
    // ordinary plugin surfaces available, but never introduce new native inputs
    // unless every model path can enforce their admission requirement.
    for (const name of ['context', 'compaction', 'generate'] as const) {
      try {
        registrations.push(
          await session.hook(name, input =>
            guardContext(input, undefined, name === 'compaction'),
          ),
        );
      } catch {
        unavailable = true;
      }
    }
    try {
      registrations.push(await session.hook('title', guardTitle));
    } catch {
      unavailable = true;
    }
    try {
      registrations.push(
        await session.hook('prompt', input => {
          if (
            isUnconfirmed(input.messageID) &&
            !authorized(input.sessionID, input.messageID)
          )
            throw new Error(
              'Goal changed before the host prepared its kickoff.',
            );
        }),
      );
    } catch {
      unavailable = true;
    }
  }

  const dispatch: GuardedV2KickoffDispatch = async (
    sessionID,
    original,
    assertActive,
  ) => {
    if (unavailable) throw unsupported();
    const invoke = async (
      method: 'prompt' | 'synthetic',
      payload: Record<string, unknown>,
    ) => {
      assertActive();
      if (disposed)
        throw new Error('Goal plugin was disposed before kickoff admission.');
      if (
        (runtime.unconfirmedKickoffInputs.get(sessionID)?.size ?? 0) >=
        MAX_UNCONFIRMED_KICKOFF_INPUTS
      )
        throw new Error(
          'This session has too many unconfirmed goal inputs. Start a new session before submitting another goal; retained input guards cannot be discarded safely.',
        );
      if (!runtime.persistKickoffInput || !runtime.confirmKickoffInput)
        throw new Error('Kickoff input persistence is unavailable.');
      const id = createV2KickoffInputID();
      let release!: () => void;
      const permission = {
        sessionID,
        assertActive,
        confirmed: false,
        ready: new Promise<void>(resolve => {
          release = resolve;
        }),
      };
      authorizations.set(id, permission);
      let hostInvoked = false;
      let guardPrepared = false;
      try {
        // A new local state file is not evidence that earlier host inputs were
        // accepted. In particular, removing the state directory must not let a
        // later command turn unknown admission history into known-clean history.
        const history = await readHistory(sessionID);
        await assertCheckpointHistory(sessionID, history);
        if (!runtime.kickoffInputHistoryKnownSessions.has(sessionID)) {
          if (
            history.some(
              value =>
                value &&
                typeof value === 'object' &&
                (((value as {type?: unknown}).type === 'compaction' &&
                  (value as {status?: unknown}).status !== 'completed') ||
                  (
                    value as {
                      metadata?: {
                        fixateOnKickoffInput?: {sessionID?: unknown};
                      };
                    }
                  ).metadata?.fixateOnKickoffInput?.sessionID === sessionID),
            )
          )
            throw new Error(
              'Previous kickoff admission history is unavailable. Restore the original state files or start a new session before submitting another goal.',
            );
        }
        guardPrepared = true;
        if (!(await runtime.persistKickoffInput(sessionID, id, true)))
          throw new Error(
            'NOT SAVED — kickoff input guard could not be saved; no prompt was sent.',
          );
        assertActive();
        hostInvoked = true;
        const result = await session[method]({
          ...payload,
          id,
          metadata: {
            ...(payload.metadata && typeof payload.metadata === 'object'
              ? payload.metadata
              : {}),
            fixateOnKickoffInput: {sessionID, inputID: id},
          },
        });
        // Apply the same error-envelope check as the regular dispatch helper.
        // Do not acknowledge an SDK response that merely resolved its promise.
        if (
          result &&
          typeof result === 'object' &&
          (result as {error?: unknown}).error != null
        )
          throw (result as {error: unknown}).error;
        assertActive();
        try {
          await runtime.confirmKickoffInput(sessionID, {
            inputID: id,
            assertActive,
            accepted: () => {
              // This callback runs with the successful atomic rename, before
              // any await. A later pause cannot retroactively cancel accepted
              // history, so no compensating write is ever necessary.
              permission.confirmed = true;
              release();
            },
          });
          if (!permission.confirmed)
            throw new Error('session persistence did not confirm admission');
        } catch (error) {
          // Once replacement won, later cleanup/transport failures cannot turn
          // it into an uncertain receipt or cause an automatic duplicate.
          if (!permission.confirmed) {
            assertActive();
            throw new KickoffConfirmationError(
              'The host accepted the kickoff, but its admission receipt could not be saved. It will not be retried automatically; resubmit the original inputs explicitly.',
              {cause: error},
            );
          }
        }
        return result;
      } catch (error) {
        if (!hostInvoked && guardPrepared) {
          // No host operation saw this ID, so keeping it cannot prevent a replay.
          await runtime.persistKickoffInput(sessionID, id, false);
        }
        throw error;
      } finally {
        release();
        authorizations.delete(id);
      }
    };
    await dispatchV2Kickoff({
      session: {
        prompt: payload => invoke('prompt', payload),
        synthetic: payload => invoke('synthetic', payload),
      },
      sessionID,
      dispatch: original,
      selectAgent: args.selectAgent,
      recordKickoffText: args.recordKickoffText,
      assertActive,
    });
  };
  return {
    dispatch,
    dispose: async () => {
      disposed = true;
      for (const registration of registrations.reverse())
        await registration.dispose();
    },
  };
}
