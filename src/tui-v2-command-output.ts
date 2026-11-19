/** Display server command receipts without placing work in the model inbox. */
import {
  GOAL_OUTPUT_RPC,
  parseGoalCommandOutput,
} from './plugin-v2-command-output.ts';
import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';

export interface GoalOutputTuiContext {
  client: {
    rpc?: (definition: typeof GOAL_OUTPUT_RPC) => {
      events: {
        on(
          name: 'output',
          handler: (event: {data: unknown}) => void,
        ): () => void;
      };
    };
  };
  ui: {
    router: {current(): {type: string; sessionID?: string}};
    dialog: {alert(input: {title: string; message: string}): Promise<void>};
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
): () => void {
  if (typeof context.client?.rpc !== 'function') return () => {};
  const seen = new Set<string>();
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  try {
    const channel = context.client.rpc(GOAL_OUTPUT_RPC);
    if (typeof channel?.events?.on !== 'function') return () => {};
    unsubscribe = channel.events.on('output', event => {
      if (disposed) return;
      try {
        const output = parseGoalCommandOutput(event?.data);
        if (!output || seen.has(output.id)) return;
        seen.add(output.id);
        if (seen.size > 256) seen.delete(seen.values().next().value!);
        const route = context.ui.router.current();
        if (
          output.kind === 'command' &&
          route.type === 'session' &&
          route.sessionID === output.sessionID
        ) {
          void context.ui.dialog
            .alert({title: PRODUCT_DISPLAY_NAME, message: output.text})
            .catch(() => {});
        } else {
          context.ui.toast.show({
            title: PRODUCT_DISPLAY_NAME,
            message: output.text,
            variant: 'info',
            sessionID: output.sessionID,
          });
        }
      } catch {
        // Isolate UI errors so the host RPC event listener stays alive.
      }
    });
  } catch {
    return () => {};
  }
  return () => {
    if (disposed) return;
    disposed = true;
    seen.clear();
    try {
      unsubscribe?.();
    } catch {
      /* best-effort unsubscribe */
    }
  };
}
