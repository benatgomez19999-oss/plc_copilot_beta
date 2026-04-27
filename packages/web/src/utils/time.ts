/**
 * Pure time-arithmetic helpers used by the validation cache layer
 * (sprint 35). No `Date.now()` inside any of these — callers thread
 * the current time as a parameter so the helpers stay deterministic
 * and unit-testable.
 */

/**
 * Parse an ISO-8601 timestamp into milliseconds-since-epoch. Returns
 * `null` for non-string input, empty string, or any value `Date.parse`
 * can't decode (`NaN`).
 */
export function parseIsoTimeMs(
  value: string | undefined | null,
): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Render a relative-age phrase like `"5 min ago"` for the validation
 * restore banner. Ranges follow the user spec exactly:
 *
 *   - `nowMs - thenMs < 60_000`    → `"just now"`
 *     (also covers future timestamps where `nowMs < thenMs` — they
 *     compare as < 60s and read as "just now", which is the most
 *     forgiving rendering).
 *   - `< 60 min`                   → `"N min ago"`
 *   - `< 24 h`                     → `"N h ago"`
 *   - else                         → `"N d ago"`
 *
 * Pluralisation is bare-numeric (`"1 min ago"`, `"2 min ago"`) — no
 * special-casing for singular vs plural English.
 */
export function formatRelativeAge(nowMs: number, thenMs: number): string {
  if (!Number.isFinite(nowMs) || !Number.isFinite(thenMs)) return 'just now';
  const diffMs = nowMs - thenMs;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(diffMs / (60 * 60_000));
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(diffMs / (24 * 60 * 60_000));
  return `${days} d ago`;
}

/**
 * Total-function age comparison for the validation cache expiry
 * gate. Returns `true` (== "treat as stale, drop it") in every
 * defensive corner so callers don't have to second-guess the inputs:
 *
 *   - non-finite `nowMs` / `thenMs` / `maxAgeMs`  → `true`
 *   - `maxAgeMs <= 0`                             → `true`
 *   - `nowMs < thenMs` (future timestamp)         → `false` (not stale)
 *   - otherwise                                   → `(nowMs - thenMs) > maxAgeMs`
 *
 * Future timestamps are tolerated rather than rejected because they're
 * usually just a clock skew between save and load — clearing them
 * on sight would lose user data unfairly.
 */
export function isOlderThanMs(
  nowMs: number,
  thenMs: number,
  maxAgeMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return true;
  if (!Number.isFinite(thenMs)) return true;
  if (!Number.isFinite(maxAgeMs)) return true;
  if (maxAgeMs <= 0) return true;
  if (nowMs < thenMs) return false;
  return nowMs - thenMs > maxAgeMs;
}
