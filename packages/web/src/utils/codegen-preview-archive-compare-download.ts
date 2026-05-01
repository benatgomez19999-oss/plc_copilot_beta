// Sprint 95 — Download bundle for the Sprint 94 archived-vs-
// current-preview comparison. Pure / DOM-free / total. The helper
// serialises an `ArchivedPreviewComparisonView` already living in
// React state into a small auditable JSON the operator saves
// locally — no codegen re-run, no localStorage, no canonical
// session export, no raw source bytes, no full artifact content.
//
// Hard rules:
//   - Pure: no DOM, no I/O, no clock, no random. The browser
//     download is a one-line adapter that reuses `downloadText`
//     on top of this helper.
//   - The bundle is built from the comparison snapshot that
//     Sprint 94 already computed. The vendor pipeline is NEVER
//     re-run, the comparison is NEVER recomputed.
//   - Privacy by construction. The helper rebuilds a fresh
//     bundle from a v1 whitelist of fields; any extra payload
//     (a stray `content`, raw source markers, PIR fields) that
//     somehow snuck into the comparison view is dropped on the
//     floor. Tests pin this with `not.toContain` assertions.
//   - Deterministic when `createdAt` is supplied. The helper
//     does not call `Date.now()` itself; the panel layer passes
//     `new Date().toISOString()` at click time.
//   - Gate function returns false for null / stale / non-archivable
//     comparisons (`no-archived-diff` / `no-current-preview`)
//     so the renderer never offers to archive a non-answer.

import type {
  ArchivedArtifactComparison,
  ArchivedDiagnosticComparison,
  ArchivedPreviewComparisonState,
  ArchivedPreviewComparisonTarget,
  ArchivedPreviewComparisonView,
  ArchivedTargetComparisonStatus,
  ArchivedTargetCounts,
} from './codegen-preview-archive-compare.js';

// ---------------------------------------------------------------------------
// Bundle shape (frozen by tests)
// ---------------------------------------------------------------------------

export const CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND =
  'plc-copilot.codegen-preview-archive-compare' as const;
export const CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION = 1 as const;

export interface CodegenPreviewArchiveCompareBundleSelectionBlock {
  /** Backend the archived diff was created against (if known). */
  archivedBackend?: ArchivedPreviewComparisonView['archivedBackend'];
  /** Backend selected when the comparison was captured (if known). */
  currentBackend?: ArchivedPreviewComparisonView['currentBackend'];
  /** True iff `archivedBackend === currentBackend`. */
  selectionMatch: boolean;
}

export interface CodegenPreviewArchiveCompareBundleCounts {
  targetsCompared: number;
  targetsChanged: number;
  artifactsSame: number;
  artifactsChanged: number;
  artifactsMissingCurrent: number;
  artifactsNewCurrent: number;
  diagnosticsStillPresent: number;
  diagnosticsResolved: number;
  diagnosticsNewCurrent: number;
}

export interface CodegenPreviewArchiveCompareBundleArtifactRow {
  path: string;
  status: ArchivedArtifactComparison['status'];
  archivedStatus?: ArchivedArtifactComparison['archivedStatus'];
  archivedHash?: string;
  currentHash?: string;
  archivedSizeBytes?: number;
  currentSizeBytes?: number;
}

export interface CodegenPreviewArchiveCompareBundleDiagnosticRow {
  status: ArchivedDiagnosticComparison['status'];
  severity: ArchivedDiagnosticComparison['diagnostic']['severity'];
  code: string;
  message: string;
  path?: string;
  hint?: string;
  archivedStatus?: ArchivedDiagnosticComparison['archivedStatus'];
}

export interface CodegenPreviewArchiveCompareBundleTarget {
  target: ArchivedPreviewComparisonTarget['target'];
  status: ArchivedTargetComparisonStatus;
  summary: string;
  archivedTargetStatus?: ArchivedPreviewComparisonTarget['archivedTargetStatus'];
  archivedRecordedCurrentStatus?: string;
  currentStatus?: string;
  counts: ArchivedTargetCounts;
  artifactComparisons: ReadonlyArray<CodegenPreviewArchiveCompareBundleArtifactRow>;
  diagnosticComparisons: ReadonlyArray<CodegenPreviewArchiveCompareBundleDiagnosticRow>;
}

export interface CodegenPreviewArchiveCompareBundle {
  kind: typeof CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND;
  version: typeof CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION;
  /** ISO 8601 timestamp the panel records at click time. */
  createdAt: string;
  /** Operator-friendly label, sanitised to `[a-z0-9-]+`. */
  snapshotName: string;
  selection: CodegenPreviewArchiveCompareBundleSelectionBlock;
  state: ArchivedPreviewComparisonState;
  summary: string;
  counts: CodegenPreviewArchiveCompareBundleCounts;
  targets: ReadonlyArray<CodegenPreviewArchiveCompareBundleTarget>;
}

// ---------------------------------------------------------------------------
// Public — gate
// ---------------------------------------------------------------------------

export interface IsArchiveCompareDownloadableArgs {
  comparison: ArchivedPreviewComparisonView | null | undefined;
  /** Optional flag the panel sets when the snapshot's inputs moved. */
  stale?: boolean;
}

/**
 * True iff the operator can meaningfully archive the current
 * comparison snapshot:
 *   - the comparison is not null,
 *   - the comparison is not stale,
 *   - the state has actual audit value (not the no-archived-diff
 *     / no-current-preview placeholders).
 *
 * `selection-mismatch` *is* archivable because it records an
 * honest "you compared apples to oranges" answer.
 */
export function isArchiveCompareDownloadable(
  args: IsArchiveCompareDownloadableArgs,
): boolean {
  if (args.stale === true) return false;
  const c = args.comparison;
  if (!c) return false;
  if (c.state === 'no-archived-diff' || c.state === 'no-current-preview') {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public — builder
// ---------------------------------------------------------------------------

export interface BuildCodegenPreviewArchiveCompareBundleArgs {
  comparison: ArchivedPreviewComparisonView;
  /**
   * ISO timestamp the renderer captures at click time. Optional;
   * defaults to a deterministic placeholder so test fixtures stay
   * pinable. Production callers should pass
   * `new Date().toISOString()`.
   */
  createdAt?: string;
  /**
   * Optional operator-supplied label. Sanitised through
   * `sanitizeArchiveCompareSnapshotName`. Falls back to
   * `'compare'`.
   */
  snapshotName?: string;
}

const DEFAULT_CREATED_AT = '1970-01-01T00:00:00.000Z';
const DEFAULT_SNAPSHOT_NAME = 'compare';

/**
 * Build the deterministic comparison bundle. Whitelist rebuild:
 * extras (a stray `content`, raw payloads, PIR fields) the
 * renderer never reads but that may still appear on the
 * structurally-typed input are dropped here.
 */
export function buildCodegenPreviewArchiveCompareBundle(
  args: BuildCodegenPreviewArchiveCompareBundleArgs,
): CodegenPreviewArchiveCompareBundle {
  const createdAt = readIsoString(args.createdAt) ?? DEFAULT_CREATED_AT;
  const snapshotName =
    sanitizeArchiveCompareSnapshotName(args.snapshotName) ||
    DEFAULT_SNAPSHOT_NAME;
  const c = args.comparison;

  return {
    kind: CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND,
    version: CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION,
    createdAt,
    snapshotName,
    selection: {
      archivedBackend: c.archivedBackend,
      currentBackend: c.currentBackend,
      selectionMatch: !!c.selectionMatch,
    },
    state: c.state,
    summary: c.summary,
    counts: copyCounts(c.counts),
    targets: c.targets.map(bundleTarget),
  };
}

/**
 * Pretty-printed, two-space indent JSON. Mirrors Sprint 90A / 91
 * for visual parity with the other download bundles.
 */
export function serializeCodegenPreviewArchiveCompareBundle(
  bundle: CodegenPreviewArchiveCompareBundle,
): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Operator-friendly filename. Deterministic — derived only from
 * the optional snapshot name (no timestamp in the filename; the
 * timestamp lives in the bundle's `createdAt` field).
 *
 *   plc-copilot-codegen-preview-archive-compare.json           // default
 *   plc-copilot-codegen-preview-archive-compare-${slug}.json   // with name
 */
export function codegenPreviewArchiveCompareFilename(args: {
  snapshotName?: string;
}): string {
  const slug = sanitizeArchiveCompareSnapshotName(args.snapshotName);
  if (!slug || slug === DEFAULT_SNAPSHOT_NAME) {
    return 'plc-copilot-codegen-preview-archive-compare.json';
  }
  return `plc-copilot-codegen-preview-archive-compare-${slug}.json`;
}

/**
 * Reduce a free-form snapshot name to a `[a-z0-9-]+` slug.
 * Mirrors Sprint 91's `sanitizePreviewDiffSnapshotName`. Empty /
 * whitespace-only / all-punctuation collapses to `''` so the
 * caller can fall back to the default `'compare'`.
 */
export function sanitizeArchiveCompareSnapshotName(
  name: string | undefined | null,
): string {
  if (typeof name !== 'string') return '';
  const lower = name.toLowerCase();
  const slug = lower
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Internal — whitelist rebuild
// ---------------------------------------------------------------------------

function copyCounts(
  counts: ArchivedPreviewComparisonView['counts'],
): CodegenPreviewArchiveCompareBundleCounts {
  return {
    targetsCompared: numberOrZero(counts.targetsCompared),
    targetsChanged: numberOrZero(counts.targetsChanged),
    artifactsSame: numberOrZero(counts.artifactsSame),
    artifactsChanged: numberOrZero(counts.artifactsChanged),
    artifactsMissingCurrent: numberOrZero(counts.artifactsMissingCurrent),
    artifactsNewCurrent: numberOrZero(counts.artifactsNewCurrent),
    diagnosticsStillPresent: numberOrZero(counts.diagnosticsStillPresent),
    diagnosticsResolved: numberOrZero(counts.diagnosticsResolved),
    diagnosticsNewCurrent: numberOrZero(counts.diagnosticsNewCurrent),
  };
}

function copyTargetCounts(c: ArchivedTargetCounts): ArchivedTargetCounts {
  return {
    artifactsSame: numberOrZero(c.artifactsSame),
    artifactsChanged: numberOrZero(c.artifactsChanged),
    artifactsMissingCurrent: numberOrZero(c.artifactsMissingCurrent),
    artifactsNewCurrent: numberOrZero(c.artifactsNewCurrent),
    artifactsNotComparable: numberOrZero(c.artifactsNotComparable),
    diagnosticsStillPresent: numberOrZero(c.diagnosticsStillPresent),
    diagnosticsResolved: numberOrZero(c.diagnosticsResolved),
    diagnosticsNewCurrent: numberOrZero(c.diagnosticsNewCurrent),
  };
}

function bundleTarget(
  t: ArchivedPreviewComparisonTarget,
): CodegenPreviewArchiveCompareBundleTarget {
  return {
    target: t.target,
    status: t.status,
    summary: t.summary,
    archivedTargetStatus: t.archivedTargetStatus,
    archivedRecordedCurrentStatus: t.archivedRecordedCurrentStatus,
    currentStatus: t.currentStatus,
    counts: copyTargetCounts(t.counts),
    artifactComparisons: t.artifactComparisons
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(bundleArtifactRow),
    diagnosticComparisons: t.diagnosticComparisons.map(bundleDiagnosticRow),
  };
}

function bundleArtifactRow(
  a: ArchivedArtifactComparison,
): CodegenPreviewArchiveCompareBundleArtifactRow {
  const out: CodegenPreviewArchiveCompareBundleArtifactRow = {
    path: a.path,
    status: a.status,
  };
  if (a.archivedStatus) out.archivedStatus = a.archivedStatus;
  if (typeof a.archivedHash === 'string' && a.archivedHash.length > 0) {
    out.archivedHash = a.archivedHash;
  }
  if (typeof a.currentHash === 'string' && a.currentHash.length > 0) {
    out.currentHash = a.currentHash;
  }
  if (typeof a.archivedSizeBytes === 'number') {
    out.archivedSizeBytes = clampSize(a.archivedSizeBytes);
  }
  if (typeof a.currentSizeBytes === 'number') {
    out.currentSizeBytes = clampSize(a.currentSizeBytes);
  }
  // `content`, `previewText`, and any other non-whitelisted field
  // are deliberately NOT copied.
  return out;
}

function bundleDiagnosticRow(
  d: ArchivedDiagnosticComparison,
): CodegenPreviewArchiveCompareBundleDiagnosticRow {
  const out: CodegenPreviewArchiveCompareBundleDiagnosticRow = {
    status: d.status,
    severity: d.diagnostic.severity,
    code: d.diagnostic.code,
    message: d.diagnostic.message,
  };
  if (d.diagnostic.path) out.path = d.diagnostic.path;
  if (d.diagnostic.hint) out.hint = d.diagnostic.hint;
  if (d.archivedStatus) out.archivedStatus = d.archivedStatus;
  return out;
}

// ---------------------------------------------------------------------------
// Internal — primitive readers
// ---------------------------------------------------------------------------

function numberOrZero(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
    ? Math.trunc(n)
    : 0;
}

function clampSize(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function readIsoString(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  // Sanity-check: Date can parse it. We don't reformat — the
  // operator-supplied string is preserved verbatim if it parses.
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return value;
}
