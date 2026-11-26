/** Validate a settled assistant response before treating its text as a verdict. */
import {getTextFromParts} from './message-helpers.ts';

type AssistantResponse = {
  parts?: unknown[];
  info?: {error?: unknown; finish?: unknown};
  error?: unknown;
  finish?: unknown;
};

export function extractChildVerdictText(response: unknown): string {
  // Older synchronous clients return only the completed text.
  if (typeof response === 'string') return response;
  const r = response as (AssistantResponse & {data?: AssistantResponse}) | null;
  for (const candidate of [r, r?.info, r?.data, r?.data?.info]) {
    const failure = candidate?.error;
    const finish = candidate?.finish;
    if (
      failure != null ||
      (finish !== undefined && finish !== null && finish !== 'stop')
    ) {
      const detail = (failure as {message?: unknown} | null)?.message;
      throw new Error(
        `Child assistant failed: ${typeof detail === 'string' ? detail : String(failure ?? finish)}`,
      );
    }
  }
  return getTextFromParts(r?.parts) || getTextFromParts(r?.data?.parts) || '';
}
