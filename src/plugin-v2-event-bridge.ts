/**
 * Bridge 2 for the OpenCode v2 plugin adapter: subscribes to the host's v2
 * event stream and maps events onto the v1 plugin event handlers (input
 * delivery, inbox enqueue/promotion, execution-start bookkeeping, and the
 * trailing-idle suppression gate).
 *
 * Extracted from plugin-v2.ts to keep that module within the ~900-line
 * single-concern budget. Depends only on leaf helper modules, the event-leaf
 * payload helpers, and shared session-runtime recorders — no import back
 * into plugin-v2.ts.
 */

import {GOAL_TUI_METADATA_KEY} from './tui-state.ts';
import type {PluginHooks} from './hooks.ts';
import type {RuntimeState} from './session-runtime.ts';
import {
  consumeInboxPayload,
  recordInboxPayload,
  resolveInputDeliveryFields,
} from './session-runtime.ts';
import {
  extractInboxMessage,
  isSameWorkspaceLocation,
  shouldSuppressTrailingIdle,
  type IdleHandledRecord,
} from './plugin-v2-helpers.ts';
import {
  extractV2InputText,
  getV2EventSessionID,
  recordV2InputDelivery,
  synthesizeChatMessageFromAdmitted,
  synthesizeChatMessageFromText,
} from './plugin-v2-event-leaf.ts';
import type {RecentKickoffTextTracker} from './plugin-v2-command.ts';

/** Minimal shape of a v2 host event consumed by the bridge. */
export interface V2EventLike {
  id?: string;
  type: string;
  location?: {directory?: string; workspaceID?: string} | null;
  data?: Record<string, unknown>;
}

export interface V2EventBridgeDeps {
  ctx: {
    event?: {subscribe?: () => AsyncIterable<V2EventLike>};
  };
  hooks: PluginHooks & {runtime?: RuntimeState};
  /** Per-session idle turn state shared with the experimental.idle hook. */
  idleStateBySession: Map<string, IdleHandledRecord>;
  /** Last observed turn signature per session (trailing-idle dedup). */
  lastObservedTurnBySession: Map<string, string>;
  recentKickoffTexts: RecentKickoffTextTracker;
  locationDirectory: string | undefined;
  /** Called with the live iterator so dispose can call .return(). */
  setEventIterator?: (it: AsyncIterator<V2EventLike> | undefined) => void;
  isStopped: () => boolean;
  stopSignal: Promise<void>;
  /** Opt-in FIXATE_ON_EVENT_LOG diagnostics path. */
  eventLogPath?: string;
}

/**
 * Maps one v2 event onto the v1 handlers. Returns 'suppressed' when the
 * event was deliberately consumed (foreign location / trailing idle),
 * otherwise 'handled'.
 */
export async function mapV2EventToHandlers(
  ev: V2EventLike,
  deps: V2EventBridgeDeps,
): Promise<'handled' | 'suppressed'> {
  const {hooks} = deps;
  if (!ev || typeof ev.type !== 'string') return 'suppressed';
  if (!isSameWorkspaceLocation(ev.location, deps.locationDirectory))
    return 'suppressed';
  const data = ev.data ?? {};
  const sessionID = getV2EventSessionID(data) ?? '';
  if (deps.eventLogPath) {
    try {
      const {appendFileSync} = await import('node:fs');
      const msgID = (data?.info as {id?: unknown} | undefined)?.id ?? '';
      appendFileSync(
        deps.eventLogPath,
        `${Date.now()} ${ev.type} ${sessionID} ${String(msgID)}\n`,
      );
    } catch {
      /* diagnostics must never break the loop */
    }
  }

  // v2 hosts do not trigger the v1 `chat.message` hook. Synthesize the hook
  // call from `session.input.admitted` so user steering commands (e.g.
  // pause/stop) are respected. Queued input (delivery "queue") is NOT
  // synthesized: it waits for the turn boundary by definition and is
  // surfaced as a notice by the idle path.
  if (ev.type === 'session.input.admitted' && sessionID) {
    const {delivery, id: inputID} = resolveInputDeliveryFields(
      data,
      ev.type,
      sessionID,
    );
    recordV2InputDelivery(hooks.runtime, data, ev.type, sessionID);
    if (delivery === 'queue') {
      // Retain the payload so a later queue→steer promotion (which carries no
      // text) can synthesize the original instruction, as with the 2.2.5 inbox
      // path below.
      const payload = extractV2InputText(data);
      if (payload.text)
        recordInboxPayload(hooks.runtime, sessionID, inputID, {
          text: payload.text,
          synthetic:
            payload.synthetic ||
            deps.recentKickoffTexts.matches(sessionID, payload.text),
        });
    } else {
      try {
        await synthesizeChatMessageFromAdmitted(
          hooks['chat.message'],
          data,
          deps.recentKickoffTexts,
        );
      } catch {
        /* steering failures must not break the event loop */
      }
    }
  }

  // Newer hosts emit mode-implied variants instead of `input.delivery`. Route a
  // steered input straight to the steering hook; retain a queued payload and
  // consume it when it is later promoted to steered.
  if (
    (ev.type === 'session.input.steered' ||
      ev.type === 'session.input.queued') &&
    sessionID
  ) {
    const {id: inputID} = resolveInputDeliveryFields(data, ev.type, sessionID);
    recordV2InputDelivery(hooks.runtime, data, ev.type, sessionID);
    const payload = extractV2InputText(data);
    if (ev.type === 'session.input.queued') {
      if (payload.text)
        recordInboxPayload(hooks.runtime, sessionID, inputID, {
          text: payload.text,
          synthetic:
            payload.synthetic ||
            deps.recentKickoffTexts.matches(sessionID, payload.text),
        });
    } else {
      const retained = consumeInboxPayload(hooks.runtime, sessionID, inputID);
      const message =
        retained ??
        (payload.text
          ? {
              text: payload.text,
              synthetic:
                payload.synthetic ||
                deps.recentKickoffTexts.matches(sessionID, payload.text),
            }
          : undefined);
      if (
        message &&
        !message.synthetic &&
        !deps.recentKickoffTexts.matches(sessionID, message.text)
      ) {
        try {
          await synthesizeChatMessageFromText(
            hooks['chat.message'],
            sessionID,
            message.text,
            {inputID, delivery: 'steer'},
          );
        } catch {
          /* steering failures must not break the event loop */
        }
      }
    }
  }
  // Execution/step start is NOT an authoritative background observation:
  // control-only work (e.g. manual compaction) does not invoke
  // experimental.idle, so clearing the deferral here would let the
  // execution.succeeded fallback drive over still-running background
  // jobs. Only a native idle with an empty background clears it, or the
  // bounded escalation in the poller.
  if (
    (ev.type === 'session.step.started' ||
      ev.type === 'session.execution.started') &&
    sessionID
  ) {
    deps.idleStateBySession.delete(sessionID);
  }
  if (
    ev.type === 'session.execution.succeeded' &&
    sessionID &&
    shouldSuppressTrailingIdle(
      deps.idleStateBySession,
      sessionID,
      deps.lastObservedTurnBySession.get(sessionID) ?? '',
      Date.now(),
      id =>
        (hooks.runtime?.backgroundDeferrals?.has(id) ?? false) ||
        (hooks.runtime?.backgroundBlockedUntil.get(id) ?? 0) > Date.now(),
    )
  ) {
    return 'suppressed';
  }

  // Record inbox delivery mode on released 2.x (through v2.2.5), which emits
  // session.inbox.enqueued / delivery.changed instead of session.input.*.
  if (
    (ev.type === 'session.inbox.enqueued' ||
      ev.type === 'session.inbox.delivery.changed') &&
    sessionID
  ) {
    recordV2InputDelivery(hooks.runtime, data, ev.type, sessionID);
    const {id: inboxID, delivery} = resolveInputDeliveryFields(
      data,
      ev.type,
      sessionID,
    );
    if (ev.type === 'session.inbox.enqueued') {
      const message = extractInboxMessage(data.item, GOAL_TUI_METADATA_KEY);
      const routable =
        message &&
        !message.synthetic &&
        !deps.recentKickoffTexts.matches(sessionID, message.text);
      if (delivery === 'queue') {
        // Retain the text: delivery.changed carries only an id, so a
        // later queue→steer promotion needs the original payload. Items
        // matching a recently dispatched kickoff are retained as
        // synthetic so a promotion after the text-match TTL expires
        // cannot be misread as human steering.
        if (message)
          recordInboxPayload(hooks.runtime, sessionID, inboxID, {
            text: message.text,
            synthetic:
              message.synthetic ||
              deps.recentKickoffTexts.matches(sessionID, message.text),
          });
      } else if (routable && message) {
        // Initially-steered items synthesize immediately as before.
        try {
          await synthesizeChatMessageFromText(
            hooks['chat.message'],
            sessionID,
            message.text,
            {
              inputID: inboxID,
              ...((data.item as {delivery?: unknown})?.delivery
                ? {delivery: (data.item as {delivery: unknown}).delivery}
                : {}),
            },
          );
        } catch {
          /* steering failures must not break the event loop */
        }
      }
    } else if (
      ev.type === 'session.inbox.delivery.changed' &&
      delivery === 'steer'
    ) {
      // Genuine queue→steer promotion: the host sends no text, so use
      // the payload retained at enqueue time. Synthesize at most once.
      const retained = consumeInboxPayload(hooks.runtime, sessionID, inboxID);
      if (
        retained &&
        !retained.synthetic &&
        !deps.recentKickoffTexts.matches(sessionID, retained.text)
      ) {
        try {
          await synthesizeChatMessageFromText(
            hooks['chat.message'],
            sessionID,
            retained.text,
            {inputID: inboxID, delivery: 'steer'},
          );
        } catch {
          /* steering failures must not break the event loop */
        }
      }
    }
  }

  // Forward the event to the v1 event hook (idle, usage, delivery, ...).
  try {
    await hooks.event?.({
      type: ev.type,
      sessionID,
      id: ev.id,
      properties: data,
    } as never);
  } catch {
    /* best-effort event dispatch */
  }
  return 'handled';
}

/**
 * Drives the v2 event stream until stopped or the stream ends, mapping each
 * event through mapV2EventToHandlers. Mirrors the original in-loop
 * Promise.race against the stop signal so dispose unblocks immediately.
 */
export async function runV2EventLoop(deps: V2EventBridgeDeps): Promise<void> {
  if (typeof deps.ctx.event?.subscribe !== 'function') return;
  try {
    const stream = deps.ctx.event.subscribe();
    const iterator = stream[Symbol.asyncIterator]();
    deps.setEventIterator?.(iterator);
    while (!deps.isStopped()) {
      const result = await Promise.race([
        iterator.next(),
        deps.stopSignal.then(
          () => ({done: true, value: undefined}) as IteratorResult<V2EventLike>,
        ),
      ]);
      if (result.done) break;
      const ev = result.value;
      if (deps.isStopped()) break;
      await mapV2EventToHandlers(ev, deps);
    }
  } catch {
    /* stream closed or errored */
  }
}
