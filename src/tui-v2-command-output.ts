/** Display server command receipts without placing work in the model inbox. */
import {
  GOAL_OUTPUT_RPC,
  parseGoalCommandOutput,
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

export function wireGoalCommandOutput(
  context: GoalOutputTuiContext,
  showReceipt: (text: string) => void,
): () => void {
  if (typeof context.data?.on !== 'function') return () => {};
  const seen = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  let disposed = false;
  let received = 0;
  let recovery = 0;

  const display = (input: unknown) => {
    if (disposed) return;
    try {
      const output = parseGoalCommandOutput(input);
      if (!output || seen.has(output.id)) return;
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
    } catch {
      // Isolate UI errors so the host's event listener stays alive. Leave the
      // receipt unseen so a later replay can retry its display.
    }
  };

  const recoverLatest = async () => {
    if (disposed || typeof context.client.rpc !== 'function') return;
    const attempt = ++recovery;
    const before = received;
    try {
      const route = context.ui.router.current();
      if (route.type !== 'session' || !route.sessionID) return;
      const channel = context.client.rpc(GOAL_OUTPUT_RPC);
      if (typeof channel?.latest !== 'function') return;
      const output = parseGoalCommandOutput(
        await channel.latest({sessionID: route.sessionID}),
      );
      // A live receipt or newer reconnect supersedes this request. An older
      // cached response must never replace a receipt received in the meantime.
      if (
        !disposed &&
        attempt === recovery &&
        before === received &&
        output?.sessionID === route.sessionID
      ) {
        display(output);
      }
    } catch {
      // Older hosts may not expose latest. The live data subscription remains
      // usable even if a replay request fails while the server reconnects.
    }
  };

  try {
    // data.on is owned by the TUI's reconnecting connection. A raw RPC events.on
    // iterator ends at disconnect and is not renewed by an unchanged plugin.
    unsubscribers.push(
      context.data.on(`rpc.${GOAL_OUTPUT_RPC.id}.output`, event => {
        if (disposed) return;
        received++;
        display((event as {data?: unknown} | null)?.data);
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
