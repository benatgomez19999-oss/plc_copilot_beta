/**
 * Sprint 32 introduced `nextIssueRowIndex` for the in-list arrow-key
 * navigation inside `ValidationIssuesList`. Sprint 33 generalised the
 * arithmetic into `roving-index.ts` so the same helper can drive any
 * roving-tabindex list. This file now re-exports those helpers under
 * the original names so existing callers / tests stay green.
 */

import {
  nextRovingIndex,
  type RovingDirection,
} from './roving-index.js';

export type IssueRowDirection = RovingDirection;

/**
 * Back-compat wrapper. Identical behaviour to `nextRovingIndex` —
 * see that helper's JSDoc for the wrap / fallback rules.
 */
export function nextIssueRowIndex(
  current: number,
  count: number,
  direction: IssueRowDirection,
): number | null {
  return nextRovingIndex(current, count, direction);
}
