// Sprint 78B — defensive localStorage layer for the electrical-review
// session snapshot. Mirrors the long-standing pattern in
// `storage.ts`: every storage call is best-effort, swallows quota /
// privacy / disabled errors, and clears malformed entries on read.
//
// Storage layout:
//
//   plccopilot:electricalReview:latest
//       — most recently autosaved session snapshot (single slot v0)
//
//   plccopilot:electricalReview:session:<id>
//       — reserved for future per-source slots; not used in v0 but
//         the prefix is exported so future sprints can layer onto
//         the same namespace without a migration.
//
// The "latest" slot is intentionally a single key — Sprint 78B v0
// supports one in-flight review at a time. Multi-session storage is
// a future sprint.
import {
  REVIEW_SESSION_SCHEMA_VERSION,
  restoreReviewSessionSnapshot,
  type ElectricalReviewSessionSnapshot,
} from './electrical-review-session.js';

export const ELECTRICAL_REVIEW_STORAGE_KEY =
  'plccopilot:electricalReview:latest';

export const ELECTRICAL_REVIEW_SESSION_KEY_PREFIX =
  'plccopilot:electricalReview:session:';

export type LoadElectricalReviewSessionResult =
  | { ok: true; snapshot: ElectricalReviewSessionSnapshot }
  | { ok: false; reason: string };

/**
 * Defensive localStorage access. Same probe pattern as `storage.ts`
 * — never throws on Safari Private / disabled / quota.
 */
function getStorage(): Storage | null {
  try {
    if (typeof globalThis === 'undefined') return null;
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    const probe = '__plccopilot_review_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/**
 * Persist the latest review session snapshot. Best-effort:
 *   - storage unavailable → no-op
 *   - quota / privacy / setItem throws → swallowed
 *
 * Sanity-checks the snapshot's `schemaVersion` before writing — a
 * caller passing a v0 / v2 / hand-crafted shape is silently ignored
 * so a malformed write can never poison the slot.
 */
export function saveElectricalReviewSession(
  snapshot: ElectricalReviewSessionSnapshot,
): void {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    snapshot.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION
  ) {
    return;
  }
  const ls = getStorage();
  if (!ls) return;
  try {
    ls.setItem(ELECTRICAL_REVIEW_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota / privacy / serialisation — silently dropped.
  }
}

/**
 * Read the most recently saved session snapshot. Failure modes:
 *
 *   - storage unavailable
 *   - no saved entry
 *   - JSON.parse fails        → cleared + 'invalid JSON'
 *   - shape mismatch          → cleared + reason from validator
 *   - getItem throws          → 'cannot read browser storage'
 *
 * On any non-throwing failure with a stored entry, the entry is
 * **cleared** so a known-bad value cannot survive across reads.
 */
export function loadLatestElectricalReviewSession(): LoadElectricalReviewSessionResult {
  const ls = getStorage();
  if (!ls) return { ok: false, reason: 'browser storage is unavailable' };
  let raw: string | null;
  try {
    raw = ls.getItem(ELECTRICAL_REVIEW_STORAGE_KEY);
  } catch {
    return { ok: false, reason: 'cannot read browser storage' };
  }
  if (raw === null) return { ok: false, reason: 'no saved review session' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearLatestElectricalReviewSession();
    return { ok: false, reason: 'saved review session: invalid JSON (cleared)' };
  }
  const restored = restoreReviewSessionSnapshot(parsed);
  if (!restored.ok) {
    clearLatestElectricalReviewSession();
    return {
      ok: false,
      reason: `saved review session: ${restored.reason} (cleared)`,
    };
  }
  return { ok: true, snapshot: restored.snapshot };
}

/**
 * Best-effort `removeItem` for the latest-session slot. Never
 * throws.
 */
export function clearLatestElectricalReviewSession(): void {
  const ls = getStorage();
  if (!ls) return;
  try {
    ls.removeItem(ELECTRICAL_REVIEW_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}
