import type { Issue } from '@plccopilot/pir';
import {
  isDiffUnderNodePath,
  structureAncestorsForJsonPath,
} from './structure-diff.js';

/**
 * Per-node breakdown of `validate(project)` issues by severity. Drives
 * the colour of the `⚠ N` badge (red if any errors, amber if only
 * warnings, blue if only info) and the breakdown shown in the tooltip
 * / aria-label.
 */
export interface ValidationSeverityBreakdown {
  errors: number;
  warnings: number;
  info: number;
}

// =============================================================================
// Path lifting
// =============================================================================

/**
 * Flat list of issue paths in original report order. Empty / nullish
 * paths are normalized to the project-root sentinel `$` so root-level
 * issues are still surfaced on the project node.
 */
export function validationIssuePathsFromReport(
  issues: readonly Issue[],
): string[] {
  const out: string[] = [];
  for (const issue of issues) out.push(normalizeIssuePath(issue.path));
  return out;
}

/**
 * Lift each issue's path to its structure-tree ancestors and accumulate
 * a count per ancestor. The walker (`structureAncestorsForJsonPath`)
 * is shared with the diff helpers so "which structure node owns this
 * path" is defined in exactly one place — both badges agree on
 * ancestry by construction.
 *
 * Order of iteration matches `issues`. Determinism comes from the
 * caller's `validate(project)` result, which is itself deterministic.
 */
export function validationIssueCountsFromReport(
  issues: readonly Issue[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (issues.length === 0) return out;

  for (const issue of issues) {
    const path = normalizeIssuePath(issue.path);
    for (const ancestor of structureAncestorsForJsonPath(path)) {
      out.set(ancestor, (out.get(ancestor) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Per-node breakdown by severity. Same lifting as
 * `validationIssueCountsFromReport`, but the bump goes to the
 * appropriate bucket. Sum of `errors + warnings + info` across all
 * issues at a node equals the count returned by the count helper.
 *
 * Defensive default: if a future PIR `Issue` ever ships an
 * unrecognised severity, it counts as `errors` (most attention-grabbing
 * — better to over-warn than to silently drop).
 */
export function validationIssueBreakdownsFromReport(
  issues: readonly Issue[],
): Map<string, ValidationSeverityBreakdown> {
  const out = new Map<string, ValidationSeverityBreakdown>();
  if (issues.length === 0) return out;

  for (const issue of issues) {
    const bucket: keyof ValidationSeverityBreakdown =
      issue.severity === 'warning'
        ? 'warnings'
        : issue.severity === 'info'
          ? 'info'
          : 'errors';
    const path = normalizeIssuePath(issue.path);
    for (const ancestor of structureAncestorsForJsonPath(path)) {
      let b = out.get(ancestor);
      if (!b) {
        b = { errors: 0, warnings: 0, info: 0 };
        out.set(ancestor, b);
      }
      b[bucket]++;
    }
  }
  return out;
}

// =============================================================================
// Cycling helpers
// =============================================================================

/**
 * Cycle target — both the JSONPath to focus and the severity that
 * caused the issue. The validation-badge cycle (sprint 29) uses
 * `severity` to colour the transient line / value highlight in
 * Monaco so the user can see at a glance *why* we jumped here.
 */
export interface ValidationIssueFocusTarget {
  path: string;
  severity: Issue['severity'];
}

/**
 * Like `validationIssueDescendantPaths` but carrying severity, in
 * original report order, with **duplicates preserved**. The cycle
 * consumer indexes into the array modulo its length, so two issues at
 * the same path (e.g. `R-ID-01` shape + `R-ID-05` uniqueness) become
 * two distinct cycle stops with their respective severities.
 *
 * `nodePath` empty / `issues` empty → `[]`. Substring-trap protection
 * delegated to `isDiffUnderNodePath` (sprint 22), so `stations[1]`
 * won't match `stations[10]`.
 */
export function validationIssueDescendants(
  nodePath: string,
  issues: readonly Issue[],
): ValidationIssueFocusTarget[] {
  if (!nodePath || issues.length === 0) return [];
  const out: ValidationIssueFocusTarget[] = [];
  for (const issue of issues) {
    const path = normalizeIssuePath(issue.path);
    if (isDiffUnderNodePath(path, nodePath)) {
      out.push({ path, severity: issue.severity });
    }
  }
  return out;
}

/**
 * List the issue paths that fall under `nodePath`, in original report
 * order. Implemented as `validationIssueDescendants(...).map(t => t.path)`
 * so the path-only and severity-aware helpers share one filtering
 * predicate and one ordering — they can never disagree about which
 * issues are descendants.
 */
export function validationIssueDescendantPaths(
  nodePath: string,
  issues: readonly Issue[],
): string[] {
  return validationIssueDescendants(nodePath, issues).map((t) => t.path);
}

/**
 * First descendant path under `nodePath`, or `null`. Implemented as
 * `[0] ?? null` over `validationIssueDescendantPaths` so the
 * "what counts as a descendant" predicate is shared.
 */
export function firstValidationIssueDescendantPath(
  nodePath: string,
  issues: readonly Issue[],
): string | null {
  return validationIssueDescendantPaths(nodePath, issues)[0] ?? null;
}

// =============================================================================
// Sprint 30 — issue list per node (display-oriented, not cycle-oriented)
// =============================================================================

/**
 * One row in the per-node `ValidationIssuesList` panel. Carries
 * everything the renderer needs without forcing it back into the raw
 * `Issue` shape:
 *   - `path` — already normalised (`''` issues fold to `'$'`).
 *   - `severity` — drives the tone pill and the Jump's tinted focus pulse.
 *   - `rule` — short code shown in a monospace cell.
 *   - `message` — human-readable phrase from `validate(project)`.
 *   - `index` — the entry's position in the **full** issues array, so
 *     duplicates at the same path stay distinguishable and the sort
 *     comparator has a stable tie-breaker.
 */
export interface ValidationIssueListItem {
  path: string;
  severity: Issue['severity'];
  rule: string;
  message: string;
  index: number;
}

/**
 * Collect every issue under `nodePath` with the metadata the list
 * panel needs. Same descendant predicate as
 * `validationIssueDescendants` (sprint 29) — substring-trap protected,
 * preserves duplicates, preserves report order. The `index` field
 * tracks the position in the **input** array (not the filtered output)
 * so callers can correlate list rows back to the original report.
 *
 * No sorting here — display order is the caller's choice. Use
 * `sortValidationIssueListItems` for the canonical "errors first,
 * then by path / rule / index" ordering.
 */
export function validationIssuesForNode(
  nodePath: string,
  issues: readonly Issue[],
): ValidationIssueListItem[] {
  if (!nodePath || issues.length === 0) return [];
  const out: ValidationIssueListItem[] = [];
  for (let index = 0; index < issues.length; index++) {
    const issue = issues[index]!;
    const path = normalizeIssuePath(issue.path);
    if (!isDiffUnderNodePath(path, nodePath)) continue;
    out.push({
      path,
      severity: issue.severity,
      rule: issue.rule,
      message: issue.message,
      index,
    });
  }
  return out;
}

/**
 * Severity rank for the list-panel sort. Lower number = higher in the
 * list. Errors dominate warnings dominate info — matches the apply
 * banner phrasing and the `formatValidationSeverityBreakdown` order.
 */
const SEVERITY_RANK: Record<Issue['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Sort issue-list items in display order without mutating the input.
 *
 * Comparator (lexicographic chain):
 *   1. severity rank   — error < warning < info
 *   2. path string     — lexicographic, groups same-field issues
 *   3. rule string     — lexicographic, e.g. `R-ID-01` before `R-ID-05`
 *   4. index           — final tie-breaker; preserves report order on
 *                        full-key matches, making the sort stable
 *                        across runs.
 *
 * Returns a fresh array; the caller's input is untouched.
 */
export function sortValidationIssueListItems(
  items: readonly ValidationIssueListItem[],
): ValidationIssueListItem[] {
  return [...items].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity];
    const sb = SEVERITY_RANK[b.severity];
    if (sa !== sb) return sa - sb;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.index - b.index;
  });
}

// =============================================================================
// Sprint 31 — filter chips for the per-node issues panel
// =============================================================================

/**
 * Active filter inside the inline `ValidationIssuesList`.
 *   - `'all'`     — show every item (still navigable / sortable).
 *   - `'error'` / `'warning'` / `'info'` — restrict to that severity.
 *
 * The component keeps the active filter in local state so panel close
 * / reopen on a different node naturally resets to `'all'`.
 */
export type ValidationIssueFilter = 'all' | 'error' | 'warning' | 'info';

/**
 * Per-severity counts plus total. Drives the chip labels (`Errors 2`,
 * `Warnings 1`, …) and lets the component tell the empty-filter
 * branch from the empty-list branch in one cheap call.
 */
export interface ValidationIssueSeverityCounts {
  total: number;
  errors: number;
  warnings: number;
  info: number;
}

/**
 * Fold a list into severity counts. Defensive: any unrecognised
 * `severity` falls into `errors` so the loudest-tone bucket never
 * silently drops items if `Issue['severity']` ever widens upstream.
 */
export function countValidationIssueListItems(
  items: readonly ValidationIssueListItem[],
): ValidationIssueSeverityCounts {
  const out: ValidationIssueSeverityCounts = {
    total: items.length,
    errors: 0,
    warnings: 0,
    info: 0,
  };
  for (const item of items) {
    if (item.severity === 'warning') out.warnings++;
    else if (item.severity === 'info') out.info++;
    else out.errors++;
  }
  return out;
}

/**
 * Filter items by severity. Returns a **new array** — `'all'` clones
 * via `slice()`, severity values use `Array.prototype.filter`. Input
 * is never mutated; original order is preserved.
 */
export function filterValidationIssueListItems(
  items: readonly ValidationIssueListItem[],
  filter: ValidationIssueFilter,
): ValidationIssueListItem[] {
  if (filter === 'all') return items.slice();
  return items.filter((i) => i.severity === filter);
}

/**
 * Tiny readability wrapper — `true` iff at least one item matches
 * `filter`. Useful when the caller only needs the boolean and would
 * otherwise discard a freshly-allocated filter result.
 */
export function hasValidationIssueFilterResults(
  items: readonly ValidationIssueListItem[],
  filter: ValidationIssueFilter,
): boolean {
  return filterValidationIssueListItems(items, filter).length > 0;
}

// =============================================================================
// Display formatting
// =============================================================================

/**
 * Format a severity breakdown for tooltips and aria-labels. Total-
 * function: returns `No validation issues` for the empty bucket so
 * callers can use the result unconditionally.
 *
 * Order: errors → warnings → info. Zero buckets are omitted so the
 * string never contains `0 errors`. Pluralization uses simple `s`
 * suffixes (`1 error` / `2 errors`); `info` is treated as a mass noun
 * and stays singular.
 */
export function formatValidationSeverityBreakdown(
  b: ValidationSeverityBreakdown,
): string {
  if (b.errors === 0 && b.warnings === 0 && b.info === 0) {
    return 'No validation issues';
  }
  const parts: string[] = [];
  if (b.errors > 0) parts.push(`${b.errors} error${b.errors === 1 ? '' : 's'}`);
  if (b.warnings > 0)
    parts.push(`${b.warnings} warning${b.warnings === 1 ? '' : 's'}`);
  if (b.info > 0) parts.push(`${b.info} info`);
  return parts.join(' · ');
}

// =============================================================================
// Internal
// =============================================================================

/**
 * Coerce an issue path into a canonical `$`-prefixed JSONPath. Empty /
 * nullish / unprefixed paths are tolerated — they all fold into the
 * project root sentinel so root-level rules surface on the project
 * node. PIR validators emit paths like `$.machines[0].stations[0]`,
 * so most calls are pass-through.
 */
function normalizeIssuePath(rawPath: string | null | undefined): string {
  if (typeof rawPath !== 'string') return '$';
  const trimmed = rawPath.trim();
  if (trimmed === '') return '$';
  if (trimmed === '$') return trimmed;
  if (trimmed.startsWith('$.') || trimmed.startsWith('$[')) return trimmed;
  if (trimmed.startsWith('.') || trimmed.startsWith('[')) return `$${trimmed}`;
  return `$.${trimmed}`;
}
