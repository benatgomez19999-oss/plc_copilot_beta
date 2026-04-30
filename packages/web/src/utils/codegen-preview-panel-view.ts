// Sprint 93 — Codegen preview / diff / readiness panel polish.
//
// Pure / DOM-free / total. Sprints 87B → 92 each shipped a small
// piece of UX (readiness, preview, live diff, download bundles,
// imported diff). The renderer code grew enough inline copy and
// per-component class mappings that the panels drifted apart in
// surface-level details — `Manifest diagnostics (2)` vs.
// `Diagnostics: 2 warnings`, `unchanged` vs. `no changes`, blue
// vs. dark-blue badges for the same status, etc. Sprint 93
// pulls every piece of copy and every status→class mapping into
// this helper so:
//
//   1. The renderers stay thin and uniform.
//   2. The exact wording is testable without RTL.
//   3. Future sprints add a status by editing one place.
//
// Hard rules:
//   - Pure: no DOM, no I/O, no clock, no random.
//   - Total: every helper accepts arbitrary input (including
//     unknown statuses) and falls back to safe defaults rather
//     than throwing.
//   - Deterministic: same input → byte-identical output.
//   - No mutation: helpers never modify their input.

import type {
  CodegenPreviewArtifactDiff,
  CodegenPreviewDiagnosticDiff,
  CodegenPreviewTargetDiff,
} from './codegen-preview-diff.js';
import type {
  CodegenPreviewArtifactView,
  CodegenPreviewDiagnostic,
  CodegenPreviewStatus,
} from './codegen-preview-view.js';
import type { CodegenReadinessGroup } from './codegen-readiness-view.js';
import type { CodegenPreviewDiffBundleTarget } from './codegen-preview-diff-download.js';

// ---------------------------------------------------------------------------
// Constants — copy that should not drift across renderers
// ---------------------------------------------------------------------------

/**
 * Stable read-only notice for the imported (archived) diff
 * section. Pinned by tests so it never silently shifts wording
 * (the operator-visible privacy guarantee depends on it).
 */
export const IMPORTED_DIFF_READ_ONLY_NOTICE =
  'Imported diff is read-only. It does not affect the current preview, Generate, or saved session.';

/** Stale-preview notice — renderer-shared so the tone matches across panels. */
export const STALE_PREVIEW_NOTICE =
  'Preview is stale — project or backend changed. Refresh to re-run.';

/** Stale-diff notice (Sprint 90B + 91 paused state). */
export const STALE_DIFF_NOTICE =
  'Diff is paused while the preview is stale. Refresh the preview to re-compare against the previous successful run and download an up-to-date diff bundle.';

// ---------------------------------------------------------------------------
// Status → label / class mapping
// ---------------------------------------------------------------------------

/**
 * Canonical preview-status label. Existing renderers already
 * agreed on these strings; the helper just owns them.
 */
export const PREVIEW_STATUS_LABEL: Record<CodegenPreviewStatus, string> = {
  unavailable: 'Unavailable',
  running: 'Running',
  ready: 'Ready',
  ready_with_warnings: 'Warnings',
  blocked: 'Blocked',
  failed: 'Failed',
};

/** Sprint 87B readiness-status label. */
export type CodegenReadinessStatusKey =
  | 'ready'
  | 'warning'
  | 'blocked'
  | 'unavailable';

export const READINESS_STATUS_LABEL: Record<
  CodegenReadinessStatusKey,
  string
> = {
  ready: 'Ready',
  warning: 'Warnings',
  blocked: 'Blocked',
  unavailable: 'Unavailable',
};

/**
 * Sprint 90B target-diff status label. The fine-grained statuses
 * `artifacts_changed` / `diagnostics_changed` / `status_changed`
 * surface in the panel as more readable phrases — no underscores.
 */
export type TargetDiffStatusKey = CodegenPreviewTargetDiff['status'];

export const TARGET_DIFF_STATUS_LABEL: Record<TargetDiffStatusKey, string> = {
  added: 'Added',
  removed: 'Removed',
  status_changed: 'Status changed',
  artifacts_changed: 'Artifacts changed',
  diagnostics_changed: 'Diagnostics changed',
  unchanged: 'Unchanged',
};

/** Sprint 90B / 91 artifact-diff status label. */
export type ArtifactDiffStatusKey = CodegenPreviewArtifactDiff['status'];

export const ARTIFACT_DIFF_STATUS_LABEL: Record<
  ArtifactDiffStatusKey,
  string
> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  unchanged: 'Unchanged',
};

/**
 * Unified "polish" status family. Every panel maps its own status
 * onto one of these tokens; CSS keyed off `.status-badge--<polish>`
 * gives the operator the same color for "this is bad" / "this is
 * fine" across panels.
 */
export type PolishStatusToken =
  | 'ready'
  | 'warning'
  | 'blocked'
  | 'failed'
  | 'unavailable'
  | 'running'
  | 'added'
  | 'removed'
  | 'changed'
  | 'unchanged'
  | 'info';

export function previewStatusPolishToken(
  status: CodegenPreviewStatus | string,
): PolishStatusToken {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'ready_with_warnings':
      return 'warning';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'unavailable':
      return 'unavailable';
    case 'running':
      return 'running';
    default:
      return 'unavailable';
  }
}

export function readinessStatusPolishToken(
  status: string,
): PolishStatusToken {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'warning':
      return 'warning';
    case 'blocked':
      return 'blocked';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'unavailable';
  }
}

export function targetDiffStatusPolishToken(
  status: string,
): PolishStatusToken {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'status_changed':
      return 'warning';
    case 'artifacts_changed':
      return 'changed';
    case 'diagnostics_changed':
      return 'info';
    case 'unchanged':
      return 'unchanged';
    default:
      return 'unchanged';
  }
}

export function artifactDiffStatusPolishToken(
  status: string,
): PolishStatusToken {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'changed':
      return 'changed';
    case 'unchanged':
      return 'unchanged';
    default:
      return 'unchanged';
  }
}

export function diagnosticChangeStatusPolishToken(
  status: string,
): PolishStatusToken {
  return status === 'added'
    ? 'added'
    : status === 'removed'
      ? 'removed'
      : 'unchanged';
}

export function severityPolishToken(severity: string): PolishStatusToken {
  switch (severity) {
    case 'error':
      return 'failed';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    default:
      return 'info';
  }
}

/**
 * Renderer-side helper: build the full class string for a status
 * badge. Always includes the legacy `badge` class (so existing CSS
 * keeps working) plus the unified `status-badge--<token>` class
 * Sprint 93 adds for cross-panel consistency.
 */
export function statusBadgeClass(token: PolishStatusToken): string {
  return `badge status-badge status-badge--${token}`;
}

// ---------------------------------------------------------------------------
// `<details>` summary copy
// ---------------------------------------------------------------------------

/**
 * `Artifacts · 4 files`, `Artifacts · 1 file`, `Artifacts · none`.
 * Used by the Sprint 89 preview card.
 */
export function formatArtifactCountSummary(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'Artifacts · none';
  if (count === 1) return 'Artifacts · 1 file';
  return `Artifacts · ${count} files`;
}

/**
 * `Preview snippets · 4 files (1 truncated)`. The Sprint 89 card
 * already lists the artifacts under a `<details>`; the snippet
 * truncation flag is the new piece of context.
 */
export function formatPreviewSnippetSummary(
  artifacts: ReadonlyArray<CodegenPreviewArtifactView>,
): string {
  const total = artifacts.length;
  const truncated = artifacts.filter((a) => a.truncated).length;
  const head = formatArtifactCountSummary(total);
  if (truncated <= 0) return head;
  return `${head} (${truncated} truncated)`;
}

/**
 * `Manifest diagnostics · 2 warnings · 1 error`. Severity-grouped
 * with the same order the helper uses (error → warning → info).
 */
export function formatManifestDiagnosticSummary(
  diagnostics: ReadonlyArray<CodegenPreviewDiagnostic>,
): string {
  const counts = severityCounts(diagnostics.map((d) => d.severity));
  if (counts.total === 0) return 'Manifest diagnostics · none';
  return `Manifest diagnostics · ${formatSeverityList(counts)}`;
}

/**
 * Sprint 87B readiness groups already carry severity + items.
 * Summary mirrors the manifest diagnostic line.
 */
export function formatReadinessGroupSummary(
  groups: ReadonlyArray<CodegenReadinessGroup>,
): string {
  const counts = severityCounts(groups.map((g) => g.severity));
  if (counts.total === 0) return 'Readiness diagnostics · none';
  return `Readiness diagnostics · ${formatSeverityList(counts)}`;
}

/**
 * `Artifact changes · 1 added · 2 changed · 1 removed`. Skips
 * zero-count buckets so the line stays scannable. Sprint 90B /
 * 91 / 92 callers all use this.
 */
export function formatArtifactChangesSummary(counts: {
  artifactsAdded: number;
  artifactsRemoved: number;
  artifactsChanged: number;
}): string {
  const parts: string[] = [];
  if (counts.artifactsAdded > 0) parts.push(`${counts.artifactsAdded} added`);
  if (counts.artifactsChanged > 0)
    parts.push(`${counts.artifactsChanged} changed`);
  if (counts.artifactsRemoved > 0)
    parts.push(`${counts.artifactsRemoved} removed`);
  if (parts.length === 0) return 'Artifact changes · none';
  return `Artifact changes · ${parts.join(' · ')}`;
}

/**
 * `Diagnostic changes · 3 changes` / `Diagnostic changes · 1 change`.
 */
export function formatDiagnosticChangesSummary(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'Diagnostic changes · none';
  if (count === 1) return 'Diagnostic changes · 1 change';
  return `Diagnostic changes · ${count} changes`;
}

/**
 * `Diff sample · siemens/FB.scl` / `Diff sample · siemens/FB.scl (truncated)`.
 */
export function formatDiffSampleSummary(args: {
  path: string;
  truncated: boolean;
}): string {
  return args.truncated
    ? `Diff sample · ${args.path} (truncated)`
    : `Diff sample · ${args.path}`;
}

/**
 * Sprint 90B target row + Sprint 92 archived target row both
 * render a one-line per-target summary. Same wording across both.
 */
export function formatTargetDiffOneLiner(args: {
  artifactsAdded: number;
  artifactsRemoved: number;
  artifactsChanged: number;
  diagnosticsAdded: number;
  diagnosticsRemoved: number;
}): string {
  const aTotal =
    args.artifactsAdded + args.artifactsRemoved + args.artifactsChanged;
  const artifactPart =
    aTotal === 0
      ? 'no artifact changes'
      : `${args.artifactsAdded} added, ${args.artifactsRemoved} removed, ${args.artifactsChanged} changed`;
  const dTotal = args.diagnosticsAdded + args.diagnosticsRemoved;
  const diagPart =
    dTotal === 0
      ? 'no diagnostic changes'
      : `${dTotal} diagnostic change${dTotal === 1 ? '' : 's'}`;
  return `${artifactPart}; ${diagPart}.`;
}

// ---------------------------------------------------------------------------
// Expand / Collapse helper
// ---------------------------------------------------------------------------

/**
 * Tiny pure helper used by the Sprint 93 *Expand all* / *Collapse
 * all* buttons. Returns a fresh map keyed by the supplied keys
 * with every value set to `open`. The renderer keeps this in
 * `useState` and reads it as a controlled `open` prop on each
 * `<details>`.
 *
 * Pure — never mutates the input array.
 */
export function setAllExpanded<K extends string>(
  keys: ReadonlyArray<K>,
  open: boolean,
): Record<K, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = open;
  return out as Record<K, boolean>;
}

// ---------------------------------------------------------------------------
// Sprint 92 archived diff helpers
// ---------------------------------------------------------------------------

/**
 * The Sprint 92 archived target row needs the same one-liner the
 * live diff produces. Bridges `CodegenPreviewDiffBundleTarget` →
 * `formatTargetDiffOneLiner`. Pure passthrough.
 */
export function formatArchivedTargetOneLiner(
  target: CodegenPreviewDiffBundleTarget,
): string {
  return formatTargetDiffOneLiner({
    artifactsAdded: target.counts.artifactsAdded,
    artifactsRemoved: target.counts.artifactsRemoved,
    artifactsChanged: target.counts.artifactsChanged,
    diagnosticsAdded: target.counts.diagnosticsAdded,
    diagnosticsRemoved: target.counts.diagnosticsRemoved,
  });
}

/**
 * Same idea for diagnostic-change summaries: archived-target
 * diagnostic counts feed the same formatter.
 */
export function formatDiagnosticChangesSummaryFromArtifactDiff(
  diagnostics: ReadonlyArray<CodegenPreviewDiagnosticDiff>,
): string {
  return formatDiagnosticChangesSummary(diagnostics.length);
}

// ---------------------------------------------------------------------------
// Internal — severity counting
// ---------------------------------------------------------------------------

interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

function severityCounts(severities: ReadonlyArray<string>): SeverityCounts {
  const out: SeverityCounts = { error: 0, warning: 0, info: 0, total: 0 };
  for (const s of severities) {
    if (s === 'error' || s === 'warning' || s === 'info') {
      out[s] += 1;
      out.total += 1;
    }
  }
  return out;
}

function formatSeverityList(counts: SeverityCounts): string {
  const parts: string[] = [];
  if (counts.error > 0) {
    parts.push(`${counts.error} error${counts.error === 1 ? '' : 's'}`);
  }
  if (counts.warning > 0) {
    parts.push(`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`);
  }
  if (counts.info > 0) {
    parts.push(`${counts.info} info${counts.info === 1 ? '' : ''}`);
  }
  return parts.join(' · ');
}
