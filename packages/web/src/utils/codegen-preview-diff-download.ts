// Sprint 91 — Codegen preview diff download bundle.
//
// Pure / DOM-free / total. Sprint 90B added an ephemeral
// `<PreviewDiffSection>` that compares the operator's current
// successful preview against the previous successful one in the
// same React session. Sprint 91 layers a single explicit
// "Download diff bundle" action on top: it serialises the diff
// already computed by `buildCodegenPreviewDiff` into a small,
// auditable JSON the operator saves locally.
//
// Hard rules pinned by these helpers:
//   - Pure: no DOM, no I/O, no clock, no random. The browser-side
//     download is a one-line adapter that reuses `downloadText`.
//   - The bundle is built FROM the already-computed diff. The
//     vendor pipeline is NEVER re-run.
//   - The bundle is a *diff archive*, not an *artifact archive*.
//     It only contains the metadata + the line-based diff sample
//     Sprint 90B already capped (≤ 80 lines / 8 KB per artifact,
//     `truncated` flagged). The full artifact content the Sprint
//     90A preview bundle carries is NEVER copied here.
//   - Bundle never includes raw source bytes (CSV / EPLAN /
//     TcECAD / PDF). The only strings it may carry are vendor
//     pipeline output (already filtered by Sprint 90B's diff
//     sample cap).
//   - Bundle never includes `pir_version` or other PIR-shape
//     fields. Selection, status transitions, hashes, paths,
//     diagnostics — that's the surface.
//   - Bundle never reaches `localStorage`; the panel adapter
//     downloads the Blob and discards it.
//   - Stale views and views without a current+baseline pair are
//     not downloadable (`isPreviewDiffDownloadable` returns
//     false). The current preview must itself be a Sprint 90A
//     downloadable preview before the diff bundle is offered —
//     i.e. failed / blocked / unavailable refreshes do NOT
//     surface a diff bundle.
//   - Helpers do NOT mutate the input views or diff.

import {
  buildCodegenPreviewDiff,
  type CodegenPreviewArtifactDiff,
  type CodegenPreviewArtifactDiffStatus,
  type CodegenPreviewDiagnosticDiff,
  type CodegenPreviewDiffView,
  type CodegenPreviewTargetDiff,
  type CodegenPreviewTargetDiffStatus,
} from './codegen-preview-diff.js';
import { isPreviewDownloadable } from './codegen-preview-download.js';
import type {
  CodegenPreviewTarget,
  CodegenPreviewView,
} from './codegen-preview-view.js';

// ---------------------------------------------------------------------------
// Bundle shape (frozen by tests)
// ---------------------------------------------------------------------------

export const CODEGEN_PREVIEW_DIFF_BUNDLE_KIND =
  'plc-copilot.codegen-preview-diff' as const;
export const CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION = 1 as const;

export type CodegenPreviewDiffBundleSelection =
  | CodegenPreviewTarget
  | 'all';

export type CodegenPreviewDiffBundleState = 'unchanged' | 'changed';

export type CodegenPreviewDiffBundleTargetState =
  | 'unchanged'
  | 'changed';

export interface CodegenPreviewDiffBundleSelectionBlock {
  /** Backend selection on the current side. */
  backend: CodegenPreviewDiffBundleSelection;
  /** Backend selection on the previous side. Null if the diff has no baseline. */
  previousBackend: CodegenPreviewDiffBundleSelection | null;
  /** True iff `backend === previousBackend`. */
  selectionMatch: boolean;
}

export interface CodegenPreviewDiffBundleCounts {
  targetsCompared: number;
  targetsChanged: number;
  artifactsAdded: number;
  artifactsRemoved: number;
  artifactsChanged: number;
  /** Sum of diagnostics added + removed across compared targets. */
  diagnosticsChanged: number;
}

export interface CodegenPreviewDiffBundleArtifactChange {
  path: string;
  status: CodegenPreviewArtifactDiffStatus;
  previousSizeBytes?: number;
  currentSizeBytes?: number;
  /** FNV-1a hex hash carried over verbatim from Sprint 90B. */
  previousHash?: string;
  currentHash?: string;
  /**
   * Line-based diff sample, already capped by Sprint 90B at
   * `MAX_DIFF_LINES_PER_ARTIFACT` lines / `MAX_DIFF_BYTES_PER_ARTIFACT`
   * bytes; `truncated: true` when clipped. Only present on
   * `status === 'changed'`.
   */
  diff?: CodegenPreviewArtifactDiff['diff'];
}

export interface CodegenPreviewDiffBundleDiagnosticChange {
  status: CodegenPreviewDiagnosticDiff['status'];
  severity: CodegenPreviewDiagnosticDiff['diagnostic']['severity'];
  code: string;
  message: string;
  path?: string;
  hint?: string;
}

export interface CodegenPreviewDiffBundleTarget {
  target: CodegenPreviewTarget;
  /** Coarse-grained per-target verdict (`unchanged` | `changed`). */
  state: CodegenPreviewDiffBundleTargetState;
  /** Sprint 90B's fine-grained status, kept for auditability. */
  targetStatus: CodegenPreviewTargetDiffStatus;
  previousStatus?: string;
  currentStatus?: string;
  counts: {
    artifactsAdded: number;
    artifactsRemoved: number;
    artifactsChanged: number;
    diagnosticsAdded: number;
    diagnosticsRemoved: number;
  };
  /**
   * Only changed / added / removed artifacts land here. Unchanged
   * artifacts are intentionally omitted — the bundle is a diff
   * archive, not an artifact archive.
   */
  artifactChanges: ReadonlyArray<CodegenPreviewDiffBundleArtifactChange>;
  diagnosticChanges: ReadonlyArray<CodegenPreviewDiffBundleDiagnosticChange>;
}

export interface CodegenPreviewDiffBundle {
  kind: typeof CODEGEN_PREVIEW_DIFF_BUNDLE_KIND;
  version: typeof CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION;
  /** Operator-supplied or default name; sanitised. */
  snapshotName: string;
  selection: CodegenPreviewDiffBundleSelectionBlock;
  state: CodegenPreviewDiffBundleState;
  /** One-liner mirroring Sprint 90B's headline. */
  summary: string;
  counts: CodegenPreviewDiffBundleCounts;
  targets: ReadonlyArray<CodegenPreviewDiffBundleTarget>;
}

// ---------------------------------------------------------------------------
// Public — gating
// ---------------------------------------------------------------------------

export interface IsPreviewDiffDownloadableArgs {
  previousView: CodegenPreviewView | null | undefined;
  currentView: CodegenPreviewView | null | undefined;
  stale: boolean;
}

/**
 * True iff the operator can meaningfully save the current diff:
 *   - the panel is not stale,
 *   - both a baseline and a current preview exist,
 *   - the current preview is itself a Sprint 90A downloadable
 *     preview (i.e. has at least one successful target with
 *     artifacts).
 *
 * Mirrors Sprint 90A's `isPreviewDownloadable` semantics for
 * "successful" so the two download buttons stay in lockstep.
 */
export function isPreviewDiffDownloadable(
  args: IsPreviewDiffDownloadableArgs,
): boolean {
  if (args.stale) return false;
  const prev = args.previousView;
  const curr = args.currentView;
  if (!prev || !curr) return false;
  if (!isPreviewDownloadable({ view: curr, stale: false })) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public — builder
// ---------------------------------------------------------------------------

export interface BuildCodegenPreviewDiffBundleArgs {
  previousView: CodegenPreviewView;
  currentView: CodegenPreviewView;
  /**
   * Optional operator-provided label. Sanitised through
   * `sanitizePreviewDiffSnapshotName`. Falls back to a
   * deterministic default keyed off the current backend.
   */
  snapshotName?: string;
}

/**
 * Build the deterministic diff bundle from two
 * `CodegenPreviewView`s. Internally calls
 * `buildCodegenPreviewDiff` once — never re-runs the vendor
 * pipeline. Pure; never mutates the input views.
 */
export function buildCodegenPreviewDiffBundle(
  args: BuildCodegenPreviewDiffBundleArgs,
): CodegenPreviewDiffBundle {
  const diff = buildCodegenPreviewDiff(args.previousView, args.currentView);
  const state: CodegenPreviewDiffBundleState =
    diff.state === 'changed' ? 'changed' : 'unchanged';

  const targets: CodegenPreviewDiffBundleTarget[] = diff.targets.map(
    bundleTarget,
  );

  const counts = aggregateCounts(diff, targets);

  const snapshotName =
    sanitizePreviewDiffSnapshotName(args.snapshotName) ||
    defaultSnapshotName(args.currentView.selection);

  return {
    kind: CODEGEN_PREVIEW_DIFF_BUNDLE_KIND,
    version: CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION,
    snapshotName,
    selection: {
      backend: args.currentView.selection,
      previousBackend: args.previousView.selection,
      selectionMatch: diff.selectionMatch,
    },
    state,
    summary: diff.headline,
    counts,
    targets,
  };
}

/**
 * Serialise a bundle to a deterministic, pretty-printed JSON
 * string. Two-space indentation matches Sprint 90A's preview
 * bundle for visual parity in operator-side diffs.
 */
export function serializeCodegenPreviewDiffBundle(
  bundle: CodegenPreviewDiffBundle,
): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Operator-friendly filename. Deterministic: derived solely from
 * the bundle's selection + sanitised snapshot name. No timestamp.
 *
 *   plc-copilot-codegen-preview-diff-${backend}-${snapshotName}.json
 *
 * The trailing `-${snapshotName}` is omitted when the sanitised
 * name reduces to the default `'diff'` so the common case stays
 * short.
 */
export function createCodegenPreviewDiffFilename(
  bundle: CodegenPreviewDiffBundle,
): string {
  const backend = bundle.selection.backend;
  const name = bundle.snapshotName;
  if (name === 'diff' || name === '') {
    return `plc-copilot-codegen-preview-diff-${backend}.json`;
  }
  return `plc-copilot-codegen-preview-diff-${backend}-${name}.json`;
}

/**
 * Reduce a free-form snapshot name to a deterministic, filename-
 * safe slug. Lowercases, keeps `[a-z0-9-]`, collapses runs of
 * `-`, trims leading/trailing dashes. Empty / whitespace-only /
 * all-punctuation input collapses to `''` so the caller can fall
 * back to a default.
 */
export function sanitizePreviewDiffSnapshotName(
  name: string | undefined | null,
): string {
  if (typeof name !== 'string') return '';
  const lower = name.toLowerCase();
  // Replace anything outside [a-z0-9] with a dash, collapse runs.
  const slug = lower
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  // Cap length so a pathological paste does not produce a 4 KB
  // filename. 64 chars is plenty for an operator label.
  return slug.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function defaultSnapshotName(
  selection: CodegenPreviewView['selection'],
): string {
  // The default name is just `'diff'` — the backend is already
  // surfaced in the filename, no need to duplicate it.
  void selection;
  return 'diff';
}

function bundleTarget(
  t: CodegenPreviewTargetDiff,
): CodegenPreviewDiffBundleTarget {
  const state: CodegenPreviewDiffBundleTargetState =
    t.status === 'unchanged' ? 'unchanged' : 'changed';

  // Pull only the diff-bearing artifact rows. `unchanged` is
  // omitted on purpose — the bundle is a diff archive.
  const artifactChanges = t.artifacts
    .filter((a) => a.status !== 'unchanged')
    .map(toBundleArtifactChange);

  const diagnosticChanges = t.diagnostics.map(toBundleDiagnosticChange);

  return {
    target: t.target,
    state,
    targetStatus: t.status,
    previousStatus: t.previousStatus,
    currentStatus: t.currentStatus,
    counts: {
      artifactsAdded: t.counts.artifactsAdded,
      artifactsRemoved: t.counts.artifactsRemoved,
      artifactsChanged: t.counts.artifactsChanged,
      diagnosticsAdded: t.counts.diagnosticsAdded,
      diagnosticsRemoved: t.counts.diagnosticsRemoved,
    },
    artifactChanges,
    diagnosticChanges,
  };
}

function toBundleArtifactChange(
  a: CodegenPreviewArtifactDiff,
): CodegenPreviewDiffBundleArtifactChange {
  const out: CodegenPreviewDiffBundleArtifactChange = {
    path: a.path,
    status: a.status,
  };
  if (typeof a.previousSizeBytes === 'number') {
    out.previousSizeBytes = a.previousSizeBytes;
  }
  if (typeof a.currentSizeBytes === 'number') {
    out.currentSizeBytes = a.currentSizeBytes;
  }
  if (a.previousHash) out.previousHash = a.previousHash;
  if (a.currentHash) out.currentHash = a.currentHash;
  if (a.diff) {
    // Already capped by Sprint 90B; deep-copy the lines array so a
    // future caller mutating the bundle does not bleed back into
    // the source diff.
    out.diff = {
      truncated: a.diff.truncated,
      firstDifferingLine: a.diff.firstDifferingLine,
      lines: a.diff.lines.map((l) => ({ ...l })),
    };
  }
  return out;
}

function toBundleDiagnosticChange(
  d: CodegenPreviewDiagnosticDiff,
): CodegenPreviewDiffBundleDiagnosticChange {
  const out: CodegenPreviewDiffBundleDiagnosticChange = {
    status: d.status,
    severity: d.diagnostic.severity,
    code: d.diagnostic.code,
    message: d.diagnostic.message,
  };
  if (d.diagnostic.path) out.path = d.diagnostic.path;
  if (d.diagnostic.hint) out.hint = d.diagnostic.hint;
  return out;
}

function aggregateCounts(
  diff: CodegenPreviewDiffView,
  targets: ReadonlyArray<CodegenPreviewDiffBundleTarget>,
): CodegenPreviewDiffBundleCounts {
  let diagnosticsChanged = 0;
  let targetsChanged = 0;
  for (const t of targets) {
    diagnosticsChanged +=
      t.counts.diagnosticsAdded + t.counts.diagnosticsRemoved;
    if (t.state !== 'unchanged') targetsChanged += 1;
  }
  return {
    targetsCompared: targets.length,
    targetsChanged,
    artifactsAdded: diff.summary.artifactsAdded,
    artifactsRemoved: diff.summary.artifactsRemoved,
    artifactsChanged: diff.summary.artifactsChanged,
    diagnosticsChanged,
  };
}
