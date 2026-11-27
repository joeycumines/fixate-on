import assert from 'node:assert/strict';
import {RGBA} from '@opentui/core';
import {testRender} from '@opentui/solid';
import {createSignal} from 'solid-js';
import type {JSX} from 'solid-js';
import type {HostTheme} from '../../src/tui-dashboard-route.tsx';
import {createGoalState} from '../../src/state-machine.ts';
import {
  serializeGoalForTui,
  type GoalTuiSnapshot,
} from '../../src/tui-state.ts';

const {DashboardRoute} = (await import(
  process.argv[2]
)) as typeof import('../../src/tui-dashboard-route.tsx');
const {showGoalCommandReceipt} = (await import(
  process.argv[3]
)) as typeof import('../../src/tui-v2-receipt-dialog.tsx');
const red = RGBA.fromHex('#ff0000');
const green = RGBA.fromHex('#00ff00');
const [color, setColor] = createSignal(red);
const theme = (): HostTheme => ({
  text: {base: color()},
  background: {
    base: RGBA.fromHex('#000000'),
    raised: {base: RGBA.fromHex('#111111')},
  },
  border: {base: RGBA.fromHex('#555555')},
  scrollbar: {base: RGBA.fromHex('#777777')},
  hue: {accent: {500: color()}},
});
const [detail, setDetail] = createSignal('BEFORE-UPDATE');
const [snapshots, setSnapshots] = createSignal<GoalTuiSnapshot[]>([]);
const dashboard = await testRender(
  () =>
    DashboardRoute({
      snapshots,
      focusedGoalId: () => null,
      activeSessionID: () => 'render-session',
      sections: () => [{key: 'state', title: 'Live state', text: detail()}],
      onSelectGoal: () => {},
      onPause: () => {},
      onResume: () => {},
      onClear: () => {},
      onFocus: () => {},
      onClose: () => {},
      theme,
      footer: 'Footer',
    }),
  {width: 80, height: 24},
);
try {
  await dashboard.flush();
  assert.ok(dashboard.captureCharFrame().includes('BEFORE-UPDATE'));
  const titleColor = () =>
    dashboard
      .captureSpans()
      .lines.flatMap(line => line.spans)
      .find(span => span.text.includes('Fixate'))
      ?.fg.toString();
  assert.equal(titleColor(), red.toString());
  setColor(green);
  setDetail('AFTER-UPDATE');
  setSnapshots([
    serializeGoalForTui(createGoalState('render-session', 'RENDERED-GOAL')),
  ]);
  await dashboard.flush();
  const updated = dashboard.captureCharFrame();
  assert.ok(updated.includes('AFTER-UPDATE'), updated);
  assert.ok(updated.includes('RENDERED-GOAL'), updated);
  assert.equal(titleColor(), green.toString());
  setSnapshots([]);
  await dashboard.flush();
  assert.ok(!dashboard.captureCharFrame().includes('RENDERED-GOAL'));
} finally {
  dashboard.renderer.destroy();
}

type ReceiptContext = Parameters<typeof showGoalCommandReceipt>[0];
type ReceiptLayer = ReturnType<
  Parameters<ReceiptContext['keymap']['layer']>[0]
>;
let render!: () => unknown;
let close: (() => void) | undefined;
let layer!: ReceiptLayer;
const dialogCalls: string[] = [];
const receiptContext: ReceiptContext = {
  get theme() {
    return theme();
  },
  keymap: {
    layer: factory => {
      layer = factory();
    },
  },
  ui: {
    dialog: {
      show: (input, onClose) => {
        close?.();
        render = input;
        close = onClose;
        dialogCalls.push('show');
      },
      set: () => {
        dialogCalls.push('set');
      },
      clear: () => {
        dialogCalls.push('clear');
        close?.();
        close = undefined;
      },
    },
  },
};
const closeFirstReceipt = showGoalCommandReceipt(
  receiptContext,
  Array.from(
    {length: 80},
    (_, i) => `RECEIPT-LINE-${String(i + 1).padStart(3, '0')}`,
  ).join('\n'),
);
assert.deepEqual(dialogCalls, ['show', 'set']);
const receipt = await testRender(() => render() as JSX.Element, {
  width: 80,
  height: 24,
});
try {
  await receipt.flush();
  assert.ok(receipt.captureCharFrame().includes('RECEIPT-LINE-001'));
  const receiptTitleColor = () =>
    receipt
      .captureSpans()
      .lines.flatMap(line => line.spans)
      .find(span => span.text.includes('Fixate'))
      ?.fg.toString();
  assert.equal(receiptTitleColor(), green.toString());
  setColor(red);
  await receipt.flush();
  assert.equal(receiptTitleColor(), red.toString());
  assert.equal(layer.mode, 'modal');
  assert.equal(layer.enabled(), true);
  const press = async (bind: string) => {
    const command = layer.commands.find(entry => entry.bind === bind);
    assert.ok(command);
    if (layer.enabled()) command.run();
    await receipt.flush();
  };
  await press('pagedown');
  assert.ok(!receipt.captureCharFrame().includes('RECEIPT-LINE-001'));
  await press('end');
  assert.ok(receipt.captureCharFrame().includes('RECEIPT-LINE-080'));
  receipt.resize(50, 12);
  await receipt.flush();
  await press('end');
  const resized = receipt.captureCharFrame();
  assert.ok(resized.includes('RECEIPT-LINE-080'), resized);
  assert.ok(resized.includes('close'), resized);
  await press('return');
  assert.equal(layer.enabled(), false);
} finally {
  receipt.renderer.destroy();
}

// Host show() replaces the prior dialog. Its closer must be inert after close
// or replacement, while a currently owned receipt must close on plugin unload.
const firstLayer = layer;
const closeReopenedReceipt = showGoalCommandReceipt(receiptContext, 'Reopened');
const reopened = await testRender(() => render() as JSX.Element, {
  width: 80,
  height: 24,
});
try {
  await reopened.flush();
  assert.ok(reopened.captureCharFrame().includes('Reopened'));
  assert.equal(firstLayer.enabled(), false);
  assert.equal(layer.enabled(), true);
  const beforeOldDisposal = dialogCalls.length;
  closeFirstReceipt();
  assert.equal(dialogCalls.length, beforeOldDisposal);
  assert.equal(layer.enabled(), true);
  receiptContext.ui.dialog.show(() => undefined);
  assert.equal(layer.enabled(), false);
  const beforeForeignDisposal = dialogCalls.length;
  closeReopenedReceipt();
  assert.equal(dialogCalls.length, beforeForeignDisposal);
} finally {
  reopened.renderer.destroy();
}
const closeOnUnload = showGoalCommandReceipt(receiptContext, 'Unload');
const beforeUnload = dialogCalls.length;
closeOnUnload();
closeOnUnload();
assert.deepEqual(dialogCalls.slice(beforeUnload), ['clear']);
console.log('compiled TUI rendering checks passed');
