/** A bounded, scrollable viewer for complete native command receipts. */
import {useTerminalDimensions} from '@opentui/solid';
import {createMemo, onCleanup} from 'solid-js';
import {
  createScrollHandlers,
  resolveDashboardPalette,
  type HostTheme,
} from './tui-dashboard-route.tsx';
import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';

interface ReceiptDialogContext {
  theme?: unknown;
  keymap: {
    layer(
      factory: () => {
        mode: string;
        enabled: () => boolean;
        commands: Array<{bind: string; title: string; run: () => void}>;
      },
    ): void;
  };
  ui: {
    dialog: {
      show(render: () => unknown, onClose?: () => void): void;
      set(options: {size: string; centered: boolean}): void;
      clear(): void;
    };
  };
}

function ReceiptDialog(props: {
  context: ReceiptDialogContext;
  text: string;
  active: () => boolean;
}) {
  const dimensions = useTerminalDimensions();
  const palette = createMemo(() => {
    const raw = (props.context.theme ?? {}) as HostTheme;
    return resolveDashboardPalette(raw.surface?.('dialog') ?? raw);
  });
  let mounted = true;
  let scroll: {
    scrollBy(n: number): void;
    scrollTo(n: number): void;
    readonly scrollHeight: number;
    readonly viewport: {height: number};
  } | null = null;
  const handlers = createScrollHandlers(() => scroll);
  const moveTo = (end: boolean) => {
    try {
      scroll?.scrollTo(end ? scroll.scrollHeight : 0);
    } catch {
      // The dialog may already be detached when a queued key is dispatched.
    }
  };
  onCleanup(() => {
    mounted = false;
    scroll = null;
  });
  props.context.keymap.layer(() => ({
    mode: 'modal',
    enabled: () => mounted && props.active(),
    commands: [
      {bind: 'up', title: 'Scroll receipt up', run: handlers.up},
      {bind: 'down', title: 'Scroll receipt down', run: handlers.down},
      {bind: 'pageup', title: 'Page receipt up', run: handlers.pageUp},
      {bind: 'pagedown', title: 'Page receipt down', run: handlers.pageDown},
      {bind: 'home', title: 'Start of receipt', run: () => moveTo(false)},
      {bind: 'end', title: 'End of receipt', run: () => moveTo(true)},
      {
        bind: 'return',
        title: 'Close receipt',
        run: () => props.context.ui.dialog.clear(),
      },
    ],
  }));

  return (
    <box
      flexDirection="column"
      height={Math.max(1, dimensions().height - 4)}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
    >
      <text fg={palette().accent} flexShrink={0} attributes={1}>
        {PRODUCT_DISPLAY_NAME}
      </text>
      <scrollbox
        ref={el => {
          scroll = el;
        }}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={{visible: true}}
      >
        <text fg={palette().text} wrapMode="word">
          {props.text}
        </text>
      </scrollbox>
      <text fg={palette().muted} flexShrink={0}>
        ↑↓ scroll · PgUp/PgDn page · Home/End · Esc/Enter close
      </text>
    </box>
  );
}

export function showGoalCommandReceipt(
  context: ReceiptDialogContext,
  text: string,
): () => void {
  let active = true;
  context.ui.dialog.show(
    () => ReceiptDialog({context, text, active: () => active}),
    () => {
      active = false;
    },
  );
  // show() resets both options on OpenCode 2.2.7; size after replacing the
  // dialog so the bounded viewer can use the available terminal height.
  context.ui.dialog.set({size: 'xlarge', centered: true});
  return () => {
    // Every replacement/close calls onClose. A disposer for an older receipt
    // must not clear the newer receipt or an unrelated host dialog.
    if (!active) return;
    active = false;
    try {
      context.ui.dialog.clear();
    } catch {
      // Host UI teardown may already have disposed the dialog service.
    }
  };
}
