/**
 * Interactive goal cockpit route.
 *
 * Rendered via router.register; live refresh is driven by SolidJS reactivity.
 * The caller passes a `sections` getter that reads from a signal updated by
 * store.subscribe, allowing the component to re-render without route re-navigation.
 *
 * Goal selection and keyboard actions (pause/resume/clear/focus) are handled inline.
 * Goal card text is generated via `goalCardLines` (tui-views.ts) so card display
 * rules (session ownership, disabled brake rendering) remain testable without
 * requiring the host terminal renderer.
 */
import type {DashboardSection} from './tui-views.ts';
import {goalCardLines} from './tui-views.ts';
import type {GoalTuiSnapshot} from './tui-state.ts';
import {PRODUCT_DISPLAY_NAME} from './tui-components.ts';
// Type-only import: erased at build time, and @opentui/core is external in the
// bundle anyway, so the host supplies the real RGBA class at runtime.
import type {RGBA} from '@opentui/core';

// TextAttributes.BOLD = 1 << 0. Inlined to avoid importing @opentui/core
// (its native loader double-registers environment variables in the test process).
const ATTR_BOLD = 1;

// The status line index within `goalCardLines`. This line is colored by state
// rather than role, followed conditionally by attribution and stop reason lines.
const STATUS_LINE = 1;

/**
 * Color token as handed by the v2 host: an RGBA object. Passed through to the
 * renderer unchanged — OpenTUI's `fg`/`backgroundColor` props accept RGBA
 * directly. (Stringifying via RGBA.toString() yields "rgba(1.00, 0.00, ...)"
 * floats, which the renderer's hex parser rejects and falls back to magenta.)
 */
type RgbaLike = RGBA;

/** Any color a host component prop accepts: an RGBA token or a CSS string. */
export type ColorToken = RGBA | string;

/**
 * Structural definition of the OpenCode 2.x host theme (`ResolvedTheme`), as
 * handed to a plugin via `context.theme` (`currentTokens()`). Colors are RGBA
 * objects passed through to the renderer, not strings. Declared structurally
 * because @opentui/core is not imported at build time. The dashboard renders on
 * the "dialog" surface, so the caller passes `theme.surface("dialog")`.
 */
export interface HostTheme {
  readonly text?: {
    readonly base?: RgbaLike;
    readonly muted?: RgbaLike;
    readonly faint?: RgbaLike;
    readonly feedback?: Readonly<
      Record<
        'error' | 'warning' | 'success' | 'info',
        {readonly base?: RgbaLike}
      >
    >;
  };
  readonly background?: {
    readonly base?: RgbaLike;
    readonly raised?: {readonly base?: RgbaLike; readonly high?: RgbaLike};
  };
  readonly border?: {readonly base?: RgbaLike};
  readonly scrollbar?: {readonly base?: RgbaLike};
  readonly hue?: {readonly accent?: Readonly<Record<number, RgbaLike>>};
  readonly surface?: (name: 'dialog' | 'dialog.footer') => HostTheme;
}

/** Resolved color roles the dashboard paints with, as renderer-native tokens. */
export interface DashboardPalette {
  readonly text: ColorToken | undefined;
  readonly muted: ColorToken | undefined;
  readonly panel: ColorToken | undefined;
  readonly background: ColorToken | undefined;
  readonly border: ColorToken | undefined;
  readonly accent: ColorToken | undefined;
  readonly scrollbar: ColorToken | undefined;
  readonly status: Readonly<Record<string, ColorToken | undefined>>;
}

/**
 * Maps the v2 dialog-surface theme to per-role color tokens. Tokens pass through
 * as RGBA objects; the renderer accepts them natively. Extracted so the mapping
 * is testable without a terminal renderer.
 */
export function resolveDashboardPalette(theme: HostTheme): DashboardPalette {
  const text = theme.text?.base;
  const muted = theme.text?.muted ?? theme.text?.faint ?? text;
  const fb = theme.text?.feedback;
  return {
    text,
    muted,
    panel: theme.background?.raised?.base ?? theme.background?.base,
    background: theme.background?.base,
    border: theme.border?.base,
    accent: theme.hue?.accent?.[500] ?? theme.text?.base,
    scrollbar: theme.scrollbar?.base ?? theme.border?.base,
    status: {
      active: fb?.success?.base ?? text,
      paused: fb?.warning?.base ?? text,
      blocked: fb?.error?.base ?? text,
      complete: muted,
      default: text,
    },
  };
}

/** Scroll handlers for the dashboard scrollbox, extracted for testability. */
export interface ScrollHandlers {
  up: () => void;
  down: () => void;
  pageUp: () => void;
  pageDown: () => void;
}

/**
 * Builds the keyboard-scroll handlers for a scrollbox element. `pageUp`/`pageDown`
 * move by half the viewport height (matching the host's diff-viewer paging).
 */
export function createScrollHandlers(
  getEl: () => {
    scrollBy: (n: number) => void;
    viewport?: {height: number};
  } | null,
): ScrollHandlers {
  const byLines = (n: number) => getEl()?.scrollBy(n);
  const page = (dir: 1 | -1) => {
    const h = getEl()?.viewport?.height ?? 10;
    getEl()?.scrollBy(dir * Math.max(1, Math.floor(h / 2)));
  };
  return {
    up: () => byLines(-1),
    down: () => byLines(1),
    pageUp: () => page(-1),
    pageDown: () => page(1),
  };
}

export interface DashboardRouteProps {
  sections: () => DashboardSection[];
  snapshots: () => GoalTuiSnapshot[];
  /**
   * The session this view belongs to, or null when the host has no session route.
   *
   * The card list uses a workspace-wide fallback so resumed sessions can be inspected
   * prior to attachment. Without this prop, a card could display another session's
   * active goal without attribution while that session's tools report no goal.
   */
  activeSessionID: () => string | null;
  focusedGoalId: () => string | null;
  onSelectGoal: (goalId: string) => void;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  onFocus: (goalId: string) => void;
  onClose: () => void;
  theme: HostTheme;
  footer: string;
  hydrationText?: string;
  /**
   * Optional hook for keyboard scrolling: the caller (the v2 companion) wires
   * these handlers to keymap commands so the dashboard scrolls with arrow /
   * page keys, not only the mouse wheel.
   */
  registerScrollCommands?: (handlers: {
    up: () => void;
    down: () => void;
    pageUp: () => void;
    pageDown: () => void;
  }) => void;
}

export function DashboardRoute(props: DashboardRouteProps) {
  const theme: HostTheme = props.theme ?? {};
  const palette = resolveDashboardPalette(theme);
  const snaps = props.snapshots;
  const focused = props.focusedGoalId;

  // Keyboard scrolling: the host scrollbox only moves on mouse wheel unless a
  // command drives its ref. The caller wires these to keymap commands.
  let scrollEl: {
    scrollBy: (n: number) => void;
    viewport?: {height: number};
  } | null = null;
  const handlers = createScrollHandlers(() => scrollEl);
  props.registerScrollCommands?.(handlers);

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={palette.background}
    >
      <box
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={palette.panel}
      >
        <text fg={palette.accent} attributes={ATTR_BOLD}>
          {PRODUCT_DISPLAY_NAME}
        </text>
      </box>
      <scrollbox
        ref={el => {
          scrollEl = el as typeof scrollEl;
        }}
        flexGrow={1}
        minHeight={0}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        verticalScrollbarOptions={{
          visible: true,
          trackOptions: {
            backgroundColor: palette.background,
            foregroundColor: palette.scrollbar,
          },
        }}
      >
        {snaps().length === 0 ? (
          <box paddingLeft={1} paddingRight={1} paddingTop={1}>
            <text fg={palette.muted}>
              {props.hydrationText ??
                'No active goals. Use /goal <condition> to set one.'}
            </text>
          </box>
        ) : (
          snaps().map(snap => {
            const isFocused = snap.goalId === focused();
            return (
              <box
                flexDirection="column"
                paddingBottom={1}
                backgroundColor={isFocused ? palette.panel : undefined}
                borderStyle={isFocused ? 'rounded' : undefined}
                borderColor={isFocused ? palette.accent : undefined}
                onMouseUp={() => props.onSelectGoal(snap.goalId)}
              >
                <box paddingLeft={1} paddingRight={1} flexDirection="row">
                  <text fg={palette.accent} attributes={ATTR_BOLD}>
                    {isFocused ? '▸ ' : '  '}
                    {'Goal: '}
                    {snap.goalId.substring(0, 8)}
                  </text>
                </box>
                <box paddingLeft={1} paddingRight={1} flexDirection="column">
                  {goalCardLines(snap, props.activeSessionID()).map(
                    (line, i) => (
                      <text fg={cardLineColor(line, i, snap.status, palette)}>
                        {line.text}
                      </text>
                    ),
                  )}
                </box>
              </box>
            );
          })
        )}
        {props.sections().map(section => (
          <box flexDirection="column" paddingBottom={1}>
            <box
              backgroundColor={palette.panel}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={palette.accent}>{section.title}</text>
            </box>
            <box paddingLeft={1} paddingRight={1} flexDirection="column">
              {section.text.split('\n').map(line => (
                <text fg={palette.text}>{line}</text>
              ))}
            </box>
          </box>
        ))}
      </scrollbox>
      <box
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={palette.panel}
        flexDirection="row"
      >
        <text fg={palette.muted}>{props.footer}</text>
      </box>
    </box>
  );
}

function cardLineColor(
  line: {readonly subdued?: boolean},
  index: number,
  status: string,
  palette: DashboardPalette,
): ColorToken | undefined {
  if (index === STATUS_LINE)
    return palette.status[status] ?? palette.status.default;
  return line.subdued ? palette.muted : palette.text;
}
