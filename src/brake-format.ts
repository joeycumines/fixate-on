/**
 * Formatting helpers for brake ceilings.
 * Non-positive limits indicate the brake is disabled, displaying "unlimited"
 * instead of a zero denominator.
 */

/** Representation of a disabled brake limit. */
export const UNLIMITED = 'unlimited';

export function brakeCeiling(limit: number): string | number {
  return limit > 0 ? limit : UNLIMITED;
}

export function brakeCeilingFormatted(
  limit: number,
  format: (value: number) => string,
): string {
  return limit > 0 ? format(limit) : UNLIMITED;
}
