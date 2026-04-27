import {
  ProjectSchema,
  type Project,
  type ValidationReport,
} from '@plccopilot/pir';
import { isOlderThanMs, parseIsoTimeMs } from './time.js';
import type { ValidationIssueFilter } from './validation-structure.js';

export const STORAGE_KEY = 'plccopilot:last-project';

export interface SavedProject {
  fileName: string;
  projectJson: unknown;
  loadedAt: string;
}

export type LoadResult =
  | { ok: true; project: Project; saved: SavedProject }
  | { ok: false; reason: string };

/**
 * Defensive localStorage access. Browsers throw on `localStorage` access in
 * a few cases (private mode in old Safari, security policies, denied
 * permissions); we never let those errors crash the app.
 */
function getStorage(): Storage | null {
  try {
    if (typeof globalThis === 'undefined') return null;
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    // Probe — Safari Private throws on setItem.
    const probe = '__plccopilot_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/**
 * Persist the most recently loaded PIR project. Saving is best-effort:
 * quota / security errors are swallowed so they cannot block the UI.
 *
 * NOTE — by design we do NOT persist generated artifacts or diagnostics.
 * They are cheap to recompute and bulky to store; the source of truth is
 * always the original PIR JSON.
 */
export function saveProject(fileName: string, project: Project): void {
  const ls = getStorage();
  if (!ls) return;
  const payload: SavedProject = {
    fileName,
    projectJson: project,
    loadedAt: new Date().toISOString(),
  };
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota / serialization errors — silently drop. Caller already has the
    // project in memory; persistence is a convenience, not a requirement.
  }
}

/**
 * Try to restore the most recently saved project. Failure modes:
 *   - storage unavailable
 *   - no saved entry
 *   - invalid JSON (cleared)
 *   - shape mismatch (cleared)
 *   - PIR schema drift (cleared)
 *
 * Each failure mode returns a discriminated `{ ok: false, reason }`. Stale
 * entries are deleted so the next load attempt returns "no saved project"
 * instead of looping on the same broken payload.
 */
export function loadSavedProject(): LoadResult {
  const ls = getStorage();
  if (!ls) return { ok: false, reason: 'browser storage is unavailable' };

  let raw: string | null;
  try {
    raw = ls.getItem(STORAGE_KEY);
  } catch {
    return { ok: false, reason: 'cannot read browser storage' };
  }
  if (raw === null) return { ok: false, reason: 'no saved project' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSavedProject();
    return { ok: false, reason: 'saved project: invalid JSON (cleared)' };
  }

  if (!isSavedShape(parsed)) {
    clearSavedProject();
    return { ok: false, reason: 'saved project: invalid shape (cleared)' };
  }

  const safe = ProjectSchema.safeParse(parsed.projectJson);
  if (!safe.success) {
    clearSavedProject();
    return {
      ok: false,
      reason: 'saved project no longer matches PIR schema (cleared)',
    };
  }

  return { ok: true, project: safe.data, saved: parsed };
}

export function clearSavedProject(): void {
  const ls = getStorage();
  if (!ls) return;
  try {
    ls.removeItem(STORAGE_KEY);
  } catch {
    // Swallow — there's nothing the UI can do.
  }
}

function isSavedShape(v: unknown): v is SavedProject {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.fileName === 'string' &&
    typeof o.loadedAt === 'string' &&
    typeof o.projectJson === 'object' &&
    o.projectJson !== null
  );
}

// =============================================================================
// Sprint 32 — persistent filter for the inline ValidationIssuesList panel
// =============================================================================

/**
 * Storage key for the user's currently-active validation issue filter
 * (`'all' | 'error' | 'warning' | 'info'`). Independent of the saved
 * project so filter preference survives across project loads.
 */
export const VALIDATION_FILTER_STORAGE_KEY =
  'plccopilot:validation-issue-filter';

/**
 * Best-effort persistence: never throws even if the storage backend
 * is unavailable, full, or denies writes (Safari Private, quota,
 * permissions). Caller treats save as fire-and-forget.
 */
export function saveValidationIssueFilter(
  filter: ValidationIssueFilter,
): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(VALIDATION_FILTER_STORAGE_KEY, filter);
  } catch {
    // Quota / privacy mode / disabled storage — swallowed by design.
  }
}

/**
 * Read the persisted filter, defaulting to `'all'` on:
 *   - storage unavailable / throws
 *   - no value previously written
 *   - stored value not in the known union (corrupted, downgraded)
 *
 * Strict union check so a future schema change can't surface a stray
 * unknown filter through TypeScript's `as` cast.
 */
export function loadValidationIssueFilter(): ValidationIssueFilter {
  const storage = getStorage();
  if (!storage) return 'all';
  try {
    const raw = storage.getItem(VALIDATION_FILTER_STORAGE_KEY);
    if (raw === null) return 'all';
    if (
      raw === 'all' ||
      raw === 'error' ||
      raw === 'warning' ||
      raw === 'info'
    ) {
      return raw;
    }
    return 'all';
  } catch {
    return 'all';
  }
}

// =============================================================================
// Sprint 33 / 34 — open ValidationIssuesList panel state
// =============================================================================

/**
 * @deprecated Sprint 34 introduced project-scoped persistence; the
 * single-key constant is kept exported only so external imports do
 * not break. New code uses `OPEN_VALIDATION_PANEL_STORAGE_KEY_PREFIX`.
 */
export const OPEN_VALIDATION_PANEL_STORAGE_KEY =
  'plccopilot:open-validation-panel';

/**
 * Sprint 34 — open-panel storage is now per-project. The full
 * storage key is `${PREFIX}${projectId}` so a saved panel for one
 * project never leaks into another.
 */
export const OPEN_VALIDATION_PANEL_STORAGE_KEY_PREFIX =
  'plccopilot:open-validation-panel:';

/**
 * Persisted shape of the open-panel marker. The `projectId` is
 * redundant with the storage key (the key already encodes it) but
 * carrying it inside the payload lets the loader cross-check on
 * mismatch — defense in depth for hand-poked entries.
 */
export interface SavedOpenValidationPanel {
  projectId: string;
  nodePath: string;
}

function openValidationPanelKey(projectId: string): string {
  return `${OPEN_VALIDATION_PANEL_STORAGE_KEY_PREFIX}${projectId}`;
}

/**
 * Persist (or clear) the open-panel marker for a specific project.
 * `null` / `''` removes that project's entry. Best-effort: never
 * throws. Empty `projectId` is a no-op so a transient null state
 * during project transitions can't poison the prefix namespace.
 */
export function saveOpenValidationPanel(
  projectId: string,
  nodePath: string | null,
): void {
  if (!projectId) return;
  const storage = getStorage();
  if (!storage) return;
  try {
    if (nodePath === null || nodePath === '') {
      storage.removeItem(openValidationPanelKey(projectId));
      return;
    }
    storage.setItem(
      openValidationPanelKey(projectId),
      JSON.stringify({ projectId, nodePath }),
    );
  } catch {
    // Quota / privacy mode / disabled storage — swallowed by design.
  }
}

/**
 * Read the persisted open-panel marker for a specific project.
 * Returns `null` on any defensive failure (storage unavailable,
 * missing key, invalid JSON, wrong shape, payload `projectId`
 * mismatch, empty `nodePath`). Mismatched / corrupt entries are
 * cleared in the same call so a known-bad value can't survive.
 */
export function loadOpenValidationPanel(
  projectId: string,
): SavedOpenValidationPanel | null {
  if (!projectId) return null;
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(openValidationPanelKey(projectId));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      clearOpenValidationPanel(projectId);
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      clearOpenValidationPanel(projectId);
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const savedProjectId = obj.projectId;
    const node = obj.nodePath;
    if (typeof savedProjectId !== 'string' || savedProjectId !== projectId) {
      clearOpenValidationPanel(projectId);
      return null;
    }
    if (typeof node !== 'string' || node === '') {
      clearOpenValidationPanel(projectId);
      return null;
    }
    return { projectId: savedProjectId, nodePath: node };
  } catch {
    return null;
  }
}

/**
 * Best-effort `removeItem` for one project's open-panel entry.
 * Never throws.
 */
export function clearOpenValidationPanel(projectId: string): void {
  if (!projectId) return;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(openValidationPanelKey(projectId));
  } catch {
    // Best-effort.
  }
}

// =============================================================================
// Sprint 34 — validation report persistence (per project)
// =============================================================================

/**
 * Storage key prefix for the validation report cache. Full key is
 * `${PREFIX}${projectId}`. The cache lets App restore the validation
 * panel immediately after a reload without forcing the user to
 * click Validate first.
 */
export const VALIDATION_REPORT_STORAGE_KEY_PREFIX =
  'plccopilot:validation-report:';

/**
 * Sprint 35 — default cache freshness window. Reports older than
 * this are dropped on read so the user is never shown stale data
 * from a session days / weeks ago. Tests can override via
 * `LoadValidationReportOptions.maxAgeMs`.
 */
export const VALIDATION_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Sprint 35 — option bag for `loadValidationReport`. Both fields are
 * dependency-injection points for tests:
 *
 *   - `nowMs`     — clock reading used to compare against `savedAt`.
 *                   Defaults to `Date.now()` at call time.
 *   - `maxAgeMs`  — freshness window. Defaults to
 *                   `VALIDATION_REPORT_MAX_AGE_MS` (24h).
 */
export interface LoadValidationReportOptions {
  nowMs?: number;
  maxAgeMs?: number;
}

/**
 * Persisted shape of a saved validation report. We carry the
 * `projectId` and `savedAt` alongside the report so the loader can
 * cross-check the binding (defense in depth — the storage key
 * already encodes the id). `report` is the raw `ValidationReport`
 * from `@plccopilot/pir.validate`.
 */
export interface SavedValidationReport {
  projectId: string;
  savedAt: string;
  report: ValidationReport;
}

function validationReportKey(projectId: string): string {
  return `${VALIDATION_REPORT_STORAGE_KEY_PREFIX}${projectId}`;
}

/**
 * Persist a validation report for one project. `null` clears the
 * entry. Best-effort: never throws on quota / privacy mode / disabled
 * storage. Empty `projectId` is a no-op.
 */
export function saveValidationReport(
  projectId: string,
  report: ValidationReport | null,
): void {
  if (!projectId) return;
  const storage = getStorage();
  if (!storage) return;
  try {
    if (report === null) {
      storage.removeItem(validationReportKey(projectId));
      return;
    }
    const payload: SavedValidationReport = {
      projectId,
      savedAt: new Date().toISOString(),
      report,
    };
    storage.setItem(validationReportKey(projectId), JSON.stringify(payload));
  } catch {
    // Quota / privacy mode / disabled storage — swallowed by design.
  }
}

/**
 * Load a previously saved validation report for one project. Returns
 * `null` on any defensive failure mode and **clears the storage entry**
 * for malformed / mismatched values so a known-bad cache cannot
 * survive a load attempt:
 *
 *   - storage unavailable / `getItem` throws → `null`
 *   - missing entry → `null`
 *   - JSON parse failure → clear + `null`
 *   - non-object payload → clear + `null`
 *   - missing / wrong-typed `projectId` / `savedAt` → clear + `null`
 *   - payload `projectId` !== requested `projectId` → clear + `null`
 *   - `report.ok` not a boolean OR `report.issues` not an array → clear + `null`
 *
 * Per-issue shape is NOT validated here (would duplicate
 * `@plccopilot/pir`'s schema knowledge into storage). The caller can
 * trust `ok` + `issues array` shape; if a bad entry slipped through
 * via DevTools, the worst case is the panel renders weird strings.
 */
export function loadValidationReport(
  projectId: string,
  options?: LoadValidationReportOptions,
): SavedValidationReport | null {
  if (!projectId) return null;
  const storage = getStorage();
  if (!storage) return null;
  // Sprint 35 — defaults are materialised at call time, not at module
  // load. `Date.now()` per call lets prod use the live clock; tests
  // override via `options.nowMs` for determinism.
  const nowMs = options?.nowMs ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? VALIDATION_REPORT_MAX_AGE_MS;
  try {
    const raw = storage.getItem(validationReportKey(projectId));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      clearValidationReport(projectId);
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      clearValidationReport(projectId);
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.projectId !== 'string' || obj.projectId !== projectId) {
      clearValidationReport(projectId);
      return null;
    }
    if (typeof obj.savedAt !== 'string') {
      clearValidationReport(projectId);
      return null;
    }
    // Sprint 35 — explicit ISO + freshness check. `parseIsoTimeMs`
    // returns null on bad input; `isOlderThanMs` is total-defensive
    // (treats invalid numbers as stale). Stale / invalid → clear so
    // the bad entry can't survive across reads.
    const savedMs = parseIsoTimeMs(obj.savedAt);
    if (savedMs === null) {
      clearValidationReport(projectId);
      return null;
    }
    if (isOlderThanMs(nowMs, savedMs, maxAgeMs)) {
      clearValidationReport(projectId);
      return null;
    }
    const report = obj.report;
    if (typeof report !== 'object' || report === null) {
      clearValidationReport(projectId);
      return null;
    }
    const r = report as Record<string, unknown>;
    if (typeof r.ok !== 'boolean' || !Array.isArray(r.issues)) {
      clearValidationReport(projectId);
      return null;
    }
    return {
      projectId: obj.projectId,
      savedAt: obj.savedAt,
      report: report as ValidationReport,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort `removeItem` for one project's validation report
 * cache. Never throws.
 */
export function clearValidationReport(projectId: string): void {
  if (!projectId) return;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(validationReportKey(projectId));
  } catch {
    // Best-effort.
  }
}
