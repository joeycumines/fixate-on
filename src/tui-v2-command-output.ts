/** Display server command receipts without placing work in the model inbox. */
import {
  GOAL_OUTPUT_RPC,
  parseGoalCommandOutput,
  type GoalCommandOutput,
} from './plugin-v2-command-output.ts';
import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';

export interface GoalOutputTuiContext {
  client: {
    rpc?: (definition: typeof GOAL_OUTPUT_RPC) => {
      latest?: (input: {sessionID: string}) => Promise<unknown>;
    };
  };
  data: {
    on(type: string, handler: (event: unknown) => void): () => void;
  };
  ui: {
    router: {current(): {type: string; sessionID?: string}};
    toast: {
      show(input: {
        title: string;
        message: string;
        variant: 'info';
        sessionID: string;
      }): void;
    };
  };
}

interface ReceiptRecovery {
  sessionID: string;
  displayedAt: number;
}

export function wireGoalCommandOutput(
  context: GoalOutputTuiContext,
  showReceipt: (text: string) => void,
): () => void {
  if (typeof context.data?.on !== 'function') return () => {};
  const seen = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  let disposed = false;
  let recovery: ReceiptRecovery | undefined;

  const display = (input: unknown): GoalCommandOutput | null => {
    if (disposed) return null;
    try {
      const output = parseGoalCommandOutput(input);
      if (!output || seen.has(output.id)) return null;
      const route = context.ui.router.current();
      if (
        output.kind === 'command' &&
        route.type === 'session' &&
        route.sessionID === output.sessionID
      ) {
        showReceipt(output.text);
      } else {
        context.ui.toast.show({
          title: PRODUCT_DISPLAY_NAME,
          message: output.text,
          variant: 'info',
          sessionID: output.sessionID,
        });
      }
      seen.add(output.id);
      if (seen.size > 256) seen.delete(seen.values().next().value!);
      return output;
    } catch {
      // Isolate UI errors so the host's event listener stays alive. Leave the
      // receipt unseen so a later replay can retry its display.
      return null;
    }
  };

  const recoverLatest = async () => {
    if (disposed || typeof context.client.rpc !== 'function') return;
    // Only one request owns recovery. A newer reconnect invalidates it even
    // when the user has since navigated away from a session.
    recovery = undefined;
    let request: ReceiptRecovery | undefined;
    try {
      const route = context.ui.router.current();
      if (route.type !== 'session' || !route.sessionID) return;
      const channel = context.client.rpc(GOAL_OUTPUT_RPC);
      if (typeof channel?.latest !== 'function') return;
      request = {
        sessionID: route.sessionID,
        displayedAt: Number.NEGATIVE_INFINITY,
      };
      recovery = request;
      const output = parseGoalCommandOutput(
        await channel.latest({sessionID: route.sessionID}),
      );
      // Only an equally recent or newer displayed receipt for this session can
      // supersede the result. An old SSE frame may arrive while a newer RPC
      // response is pending; other sessions also share the same host stream.
      if (
        !disposed &&
        request === recovery &&
        output?.sessionID === route.sessionID &&
        output.timestamp > request.displayedAt
      ) {
        display(output);
      }
    } catch {
      // Older hosts may not expose latest. The live data subscription remains
      // usable even if a replay request fails while the server reconnects.
    } finally {
      if (request === recovery) recovery = undefined;
    }
  };

  try {
    // data.on is owned by the TUI's reconnecting connection. A raw RPC events.on
    // iterator ends at disconnect and is not renewed by an unchanged plugin.
    unsubscribers.push(
      context.data.on(`rpc.${GOAL_OUTPUT_RPC.id}.output`, event => {
        if (disposed) return;
        const pending = recovery;
        const output = display((event as {data?: unknown} | null)?.data);
        // Invalid, duplicate or unsuccessfully displayed events do not replace
        // a receipt. Capture before display, which may itself trigger reconnect.
        if (
          output &&
          pending &&
          pending === recovery &&
          pending.sessionID === output.sessionID
        )
          pending.displayedAt = Math.max(pending.displayedAt, output.timestamp);
      }),
    );
    unsubscribers.push(
      context.data.on('server.connected', () => void recoverLatest()),
    );
    void recoverLatest();
  } catch {
    // Keep any listener already acquired, and release it with the companion.
  }

  return () => {
    if (disposed) return;
    disposed = true;
    recovery = undefined;
    seen.clear();
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* best-effort unsubscribe */
      }
    }
  };
}
