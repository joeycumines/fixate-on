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

// TextAttributes.BOLD = 1 << 0. Inlined to avoid importing @opentui/core
// (its native loader double-registers environment variables in the test process).
const ATTR_BOLD = 1;

// The status line index within `goalCardLines`. This line is colored by state
// rather than role, followed conditionally by attribution and stop reason lines.
const STATUS_LINE = 1;

/**
 * Structural definition of the host theme subset read by this route.
 *
 * Declared structurally because @opentui/core is not imported at build time.
 * If the host drops or renames a token, styles fall back to `text.default`.
 */
export interface HostTheme {
  background?: {
    default?: string;
    panel?: string;
    surface?: {offset?: string};
  };
  border?: {default?: string; active?: string};
  text?: {
    default?: string;
    subdued?: string;
    success?: string;
    warning?: string;
    error?: string;
    accent?: {default?: string};
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
}

export function DashboardRoute(props: DashboardRouteProps) {
  const theme: HostTheme = props.theme ?? {};
  const snaps = props.snapshots;
  const focused = props.focusedGoalId;

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background?.default}
    >
      <box
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.background?.panel}
      >
        <text
          fg={theme.text?.accent?.default ?? theme.text?.default}
          attributes={ATTR_BOLD}
        >
          {PRODUCT_DISPLAY_NAME}
        </text>
      </box>
      <scrollbox
        flexGrow={1}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        verticalScrollbarOptions={{
          visible: true,
          trackOptions: {
            backgroundColor:
              theme.background?.surface?.offset ?? theme.background?.default,
            foregroundColor: theme.border?.default,
          },
        }}
      >
        {snaps().length === 0 ? (
          <box paddingLeft={1} paddingRight={1} paddingTop={1}>
            <text fg={theme.text?.subdued}>
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
                backgroundColor={
                  isFocused
                    ? (theme.background?.panel ?? theme.background?.default)
                    : undefined
                }
                borderStyle={isFocused ? 'rounded' : undefined}
                borderColor={
                  isFocused
                    ? (theme.border?.active ?? theme.border?.default)
                    : undefined
                }
                onMouseUp={() => props.onSelectGoal(snap.goalId)}
              >
                <box paddingLeft={1} paddingRight={1} flexDirection="row">
                  <text
                    fg={theme.text?.accent?.default ?? theme.text?.default}
                    attributes={ATTR_BOLD}
                  >
                    {isFocused ? '▸ ' : '  '}
                    {'Goal: '}
                    {snap.goalId.substring(0, 8)}
                  </text>
                </box>
                <box paddingLeft={1} paddingRight={1} flexDirection="column">
                  {goalCardLines(snap, props.activeSessionID()).map(
                    (line, i) => (
                      <text fg={cardLineColor(line, i, snap.status, theme)}>
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
              backgroundColor={
                theme.background?.panel ?? theme.background?.default
              }
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.text?.accent?.default ?? theme.text?.default}>
                {section.title}
              </text>
            </box>
            <box paddingLeft={1} paddingRight={1} flexDirection="column">
              {section.text.split('\n').map(line => (
                <text fg={theme.text?.default}>{line}</text>
              ))}
            </box>
          </box>
        ))}
      </scrollbox>
      <box
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.background?.panel}
        flexDirection="row"
      >
        <text fg={theme.text?.subdued}>{props.footer}</text>
      </box>
    </box>
  );
}

function statusColor(status: string, theme: HostTheme): string | undefined {
  switch (status) {
    case 'active':
      return theme.text?.success ?? theme.text?.default;
    case 'paused':
      return theme.text?.warning ?? theme.text?.default;
    case 'blocked':
      return theme.text?.error ?? theme.text?.default;
    case 'complete':
      return theme.text?.subdued ?? theme.text?.default;
    default:
      return theme.text?.default;
  }
}

function cardLineColor(
  line: {readonly subdued?: boolean},
  index: number,
  status: string,
  theme: HostTheme,
): string | undefined {
  if (index === STATUS_LINE) return statusColor(status, theme);
  return line.subdued
    ? (theme.text?.subdued ?? theme.text?.default)
    : theme.text?.default;
}
