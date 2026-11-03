/**
 * Toast notification manager and display formatting utilities.
 */

export interface ToastInput {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: string;
  duration?: number;
}

export type ToastFn = (input: ToastInput) => void;

/**
 * On-screen product identity name.
 * Distinct from wire protocol identifiers (e.g., GOAL_TUI_EVENT_TITLE).
 */
export const PRODUCT_DISPLAY_NAME = 'Fixate';

const MAX_TOAST_MESSAGE_LENGTH = 500;
const DEFAULT_TOAST_DURATION = 6000;

export interface ToastManager {
  /** Low-level toast emitter. Prefer dedicated semantic helpers. */
  toast(input: ToastInput): void;

  toastGoalCreated(condition: string): void;
  toastGoalComplete(condition: string): void;
  toastGoalBlocked(reason: string): void;
  toastBudgetLimited(reason: string): void;
  toastJudgeRejected(reason: string): void;
  toastRecovery(detail: string): void;
}

/**
 * Wraps the host UI toast function with default titles, durations, and truncation.
 */
export function createToastManager(config: {showToast: ToastFn}): ToastManager {
  const {showToast} = config;

  function toast(input: ToastInput): void {
    showToast({
      title: input.title ?? PRODUCT_DISPLAY_NAME,
      variant: input.variant ?? 'info',
      message: truncate(input.message, MAX_TOAST_MESSAGE_LENGTH),
      duration: input.duration ?? DEFAULT_TOAST_DURATION,
    });
  }

  return {
    toast,
    toastGoalCreated: condition => {
      toast({variant: 'info', message: `Goal set: ${condition}`});
    },
    toastGoalComplete: condition => {
      toast({variant: 'success', message: `Goal complete: ${condition}`});
    },
    toastGoalBlocked: reason => {
      toast({variant: 'warning', message: `Goal blocked: ${reason}`});
    },
    toastBudgetLimited: reason => {
      toast({variant: 'error', message: `Budget limit reached: ${reason}`});
    },
    toastJudgeRejected: reason => {
      toast({variant: 'warning', message: `Completion rejected: ${reason}`});
    },
    toastRecovery: detail => {
      toast({variant: 'info', message: `Recovery: ${detail}`});
    },
  };
}

/**
 * Truncates a string to a maximum number of Unicode code points to avoid splitting
 * surrogate pairs in multi-byte characters like emojis.
 */
function truncate(str: string, maxLength: number): string {
  const chars = Array.from(str);
  if (chars.length <= maxLength) return str;
  return chars.slice(0, maxLength - 1).join('') + '…';
}

/** Formats a number with thousands separators (e.g. 1234567 → "1,234,567"). */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** Formats a timestamp into a relative string (e.g. "2m ago" or "just now"). */
export function formatRelativeTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  const diff = now - timestamp;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
