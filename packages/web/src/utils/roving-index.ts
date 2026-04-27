/**
 * Generic helpers for roving-tabindex / arrow-key list navigation.
 *
 * The roving-tabindex pattern keeps a single list-internal element in
 * the document tab order (`tabIndex={0}`) while every other peer is
 * `tabIndex={-1}`. Arrow keys move the active index, programmatic
 * `.focus()` moves the actual focus. This module owns the pure
 * arithmetic so React components can use it without re-implementing
 * wrap-around / clamp logic.
 *
 * Sprint 32's `nextIssueRowIndex` is now a thin wrapper over
 * `nextRovingIndex` so existing tests and callers keep working
 * unchanged.
 */

export type RovingDirection = 'next' | 'prev' | 'first' | 'last';

/**
 * Compute the next roving index for arrow-key navigation, with
 * wrap-around for `next` / `prev`.
 *
 *   - `count <= 0`                       → `null`
 *   - direction `'first'`                → `0`
 *   - direction `'last'`                 → `count - 1`
 *   - `current < 0` (no item active):
 *       - direction `'next'`             → `0`
 *       - direction `'prev'`             → `count - 1`
 *   - direction `'next'`                 → wraps last → first
 *   - direction `'prev'`                 → wraps first → last
 *   - tolerates `current >= count`       → modular fallback so a stale
 *                                          index from a shrunk list
 *                                          can't crash.
 */
export function nextRovingIndex(
  current: number,
  count: number,
  direction: RovingDirection,
): number | null {
  if (count <= 0) return null;
  if (direction === 'first') return 0;
  if (direction === 'last') return count - 1;
  if (current < 0) {
    return direction === 'next' ? 0 : count - 1;
  }
  if (direction === 'next') return (current + 1) % count;
  return ((current - 1) % count + count) % count;
}

/**
 * Pin `current` into `[0, count - 1]`. Used after a list shrinks (e.g.
 * a filter chip change) so the previously-active index stays in
 * range. `count <= 0` → `0`. Negative / non-finite / fractional inputs
 * all collapse to a defensive value.
 *
 *   - count <= 0                       → 0
 *   - non-finite current (NaN / ±∞)    → 0
 *   - current < 0                      → 0
 *   - current >= count                 → count - 1
 *   - otherwise                        → Math.floor(current)
 */
export function clampRovingIndex(current: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(current)) return 0;
  const floored = Math.floor(current);
  if (floored < 0) return 0;
  if (floored >= count) return count - 1;
  return floored;
}
