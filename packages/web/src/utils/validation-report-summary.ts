import type { ValidationReport } from '@plccopilot/pir';
import type { SavedValidationReport } from './storage.js';
import { formatRelativeAge, parseIsoTimeMs } from './time.js';

export interface ValidationReportCounts {
  errors: number;
  warnings: number;
  info: number;
}

export type ValidationReportTone = 'error' | 'warning' | 'info';

/**
 * Fold a `ValidationReport` into severity counts. Defensive default
 * lifts unknown severities into `errors` so loud failures never
 * silently disappear (matches sprint 31's structure-tree breakdown).
 */
export function countValidationReportIssues(
  report: ValidationReport,
): ValidationReportCounts {
  const out: ValidationReportCounts = { errors: 0, warnings: 0, info: 0 };
  for (const issue of report.issues) {
    if (issue.severity === 'warning') out.warnings++;
    else if (issue.severity === 'info') out.info++;
    else out.errors++;
  }
  return out;
}

/**
 * Format the counts as the trailing phrase in the restore banner.
 *
 *   - all-zero      → `"passed"`
 *   - otherwise     → `"N error(s), M warning(s), K info"`
 *
 * Pluralization on `error` / `warning`; `info` stays mass noun.
 * Zero-buckets are kept inline (per spec example
 * `"2 errors, 1 warning, 0 info"`) so the phrase shape is stable
 * across reports.
 */
export function formatValidationReportCounts(
  counts: ValidationReportCounts,
): string {
  if (counts.errors === 0 && counts.warnings === 0 && counts.info === 0) {
    return 'passed';
  }
  const errors = `${counts.errors} error${counts.errors === 1 ? '' : 's'}`;
  const warnings = `${counts.warnings} warning${
    counts.warnings === 1 ? '' : 's'
  }`;
  const info = `${counts.info} info`;
  return `${errors}, ${warnings}, ${info}`;
}

/**
 * Pick the dominant tone for the restore banner.
 *
 *   - any errors    → `'error'`
 *   - any warnings  → `'warning'`
 *   - else          → `'info'` (passes / info-only)
 */
export function validationReportTone(
  counts: ValidationReportCounts,
): ValidationReportTone {
  if (counts.errors > 0) return 'error';
  if (counts.warnings > 0) return 'warning';
  return 'info';
}

/**
 * Compose the full restore-banner message:
 *
 *   "Restored validation report from local browser storage (5 min ago).
 *    Last result: 2 errors, 1 warning, 0 info."
 *
 * `nowMs` is threaded in so tests can be deterministic. When
 * `saved.savedAt` can't be parsed the age fragment falls back to
 * `"unknown time ago"` — the rest of the message still renders so
 * the user knows where the data came from.
 */
export function restoredValidationReportMessage(
  saved: SavedValidationReport,
  nowMs: number,
): string {
  const counts = countValidationReportIssues(saved.report);
  const savedMs = parseIsoTimeMs(saved.savedAt);
  const age =
    savedMs === null ? 'unknown time ago' : formatRelativeAge(nowMs, savedMs);
  return `Restored validation report from local browser storage (${age}). Last result: ${formatValidationReportCounts(counts)}.`;
}
