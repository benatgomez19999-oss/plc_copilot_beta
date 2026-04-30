// Sprint 90A — Codegen preview download bundle.
//
// Pure / DOM-free / total. The Sprint 89 preview panel projects an
// in-memory `CodegenPreviewView` (per-target status + capped UI
// snippets + the full artifact content retained on each
// `CodegenPreviewArtifactView.content`). Sprint 90A serialises
// that already-computed state into a single JSON bundle the
// operator can save locally — without re-running the vendor
// pipeline.
//
// Hard rules pinned by these helpers:
//   - Pure: no DOM, no I/O, no clock, no random. Browser-side
//     download is a separate one-line adapter.
//   - Bundle never includes raw source bytes (CSV / EPLAN / TcECAD
//     / PDF). It contains generated code only.
//   - Bundle never reaches localStorage; the panel's adapter
//     downloads the Blob and discards it.
//   - Backend `'all'` records every target in the manifest; only
//     successful targets contribute artifacts. Blocked / failed /
//     unavailable targets keep their status + summary +
//     diagnostics + (for failed) error block in the manifest with
//     an empty `artifacts` array — no fabricated content.
//   - Stale views and views with no successful target are not
//     downloadable (`isPreviewDownloadable` returns false).
//   - Helpers do NOT mutate the input view.

import type {
  CodegenPreviewArtifactView,
  CodegenPreviewDiagnostic,
  CodegenPreviewStatus,
  CodegenPreviewTarget,
  CodegenPreviewTargetView,
  CodegenPreviewView,
} from './codegen-preview-view.js';

// ---------------------------------------------------------------------------
// Bundle shape (frozen in tests)
// ---------------------------------------------------------------------------

export const CODEGEN_PREVIEW_BUNDLE_KIND =
  'plc-copilot-codegen-preview' as const;
export const CODEGEN_PREVIEW_BUNDLE_VERSION = 1 as const;

export interface CodegenPreviewBundleArtifact {
  path: string;
  /** Full artifact content. Sprint 89's UI 40-line / 4-KB cap does not apply. */
  content: string;
  sizeBytes: number;
  kind?: CodegenPreviewArtifactView['kind'];
}

export interface CodegenPreviewBundleTarget {
  target: CodegenPreviewTarget;
  status: CodegenPreviewStatus;
  summary: string;
  /** Empty for blocked / failed / unavailable / running targets. */
  artifacts: ReadonlyArray<CodegenPreviewBundleArtifact>;
  /** Severity-grouped + deduped manifest diagnostics, mirrored from the panel view. */
  diagnostics: ReadonlyArray<CodegenPreviewDiagnostic>;
  /** Present only on `failed` targets — preserves the original CodegenError code. */
  error?: { code?: string; message: string };
}

export interface CodegenPreviewBundle {
  /** Stable discriminator so external tooling can sniff the format. */
  kind: typeof CODEGEN_PREVIEW_BUNDLE_KIND;
  /** Schema version. Bumped if the JSON shape ever changes. */
  version: typeof CODEGEN_PREVIEW_BUNDLE_VERSION;
  /** The operator's selected backend, copied from the preview view. */
  selection: CodegenPreviewView['selection'];
  /** Aggregate verdict across `targets[]`. */
  status: CodegenPreviewStatus;
  /** Helper-rendered one-liner mirroring the panel's summary. */
  summary: string;
  targets: ReadonlyArray<CodegenPreviewBundleTarget>;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * True iff the given preview state can be turned into a meaningful
 * bundle: the operator has a fresh result with at least one
 * successful target that produced artifacts. Stale / unavailable
 * / null views are NOT downloadable. Blocked-only previews are
 * NOT downloadable.
 */
export function isPreviewDownloadable(args: {
  view: CodegenPreviewView | null | undefined;
  stale: boolean;
}): boolean {
  if (args.stale) return false;
  const view = args.view;
  if (!view) return false;
  if (view.status === 'unavailable') return false;
  for (const t of view.targets) {
    if (
      (t.status === 'ready' || t.status === 'ready_with_warnings') &&
      t.artifacts.length > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Build the deterministic bundle object from a preview view.
 * Reads `CodegenPreviewArtifactView.content` (full, uncapped) for
 * each successful target. Blocked / failed / unavailable targets
 * are recorded in the manifest with empty `artifacts` arrays so
 * the operator can see why a target is missing without the bundle
 * fabricating placeholders.
 *
 * Pure — never mutates the input view, never produces a different
 * bundle on a second call with the same input.
 */
export function buildCodegenPreviewBundle(
  view: CodegenPreviewView,
): CodegenPreviewBundle {
  const targets: CodegenPreviewBundleTarget[] = view.targets.map(bundleTarget);
  return {
    kind: CODEGEN_PREVIEW_BUNDLE_KIND,
    version: CODEGEN_PREVIEW_BUNDLE_VERSION,
    selection: view.selection,
    status: view.status,
    summary: view.summary,
    targets,
  };
}

/**
 * Serialise a bundle to a deterministic, pretty-printed JSON
 * string. Two-space indentation keeps a diff against a previous
 * bundle reading cleanly.
 */
export function serializeCodegenPreviewBundle(
  bundle: CodegenPreviewBundle,
): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Operator-friendly filename derived from the operator's
 * selection. No timestamp — the helper stays deterministic for
 * tests; the component layer can override at click time if it
 * wants a wall-clock suffix.
 */
export function makeCodegenPreviewBundleFilename(
  selection: CodegenPreviewView['selection'],
): string {
  return `plc-copilot-codegen-preview-${selection}.json`;
}

/**
 * True iff the bundle carries at least one artifact across all
 * its targets. Convenience predicate the panel can use after
 * `buildCodegenPreviewBundle`.
 */
export function bundleHasArtifacts(bundle: CodegenPreviewBundle): boolean {
  for (const t of bundle.targets) {
    if (t.artifacts.length > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function bundleTarget(
  view: CodegenPreviewTargetView,
): CodegenPreviewBundleTarget {
  const status = view.status;
  const successful =
    status === 'ready' || status === 'ready_with_warnings';

  // Successful targets contribute their full-content artifacts.
  // Everything else lands with `artifacts: []` so the manifest
  // still records the target's status + summary + diagnostics +
  // (for failed) error block.
  const artifacts: CodegenPreviewBundleArtifact[] = successful
    ? collectArtifacts(view.artifacts)
    : [];

  const out: CodegenPreviewBundleTarget = {
    target: view.target,
    status,
    summary: view.summary,
    artifacts,
    diagnostics: view.manifestDiagnostics.map(cloneDiagnostic),
  };
  if (view.error) {
    out.error = { ...view.error };
  }
  return out;
}

function collectArtifacts(
  artifacts: ReadonlyArray<CodegenPreviewArtifactView>,
): CodegenPreviewBundleArtifact[] {
  const out: CodegenPreviewBundleArtifact[] = artifacts.map((a) => ({
    path: a.path,
    content: a.content,
    sizeBytes: a.content.length,
    ...(a.kind ? { kind: a.kind } : {}),
  }));
  // `view.artifacts` is already path-sorted in Sprint 89, but
  // re-sort defensively in case the upstream view ever drifts.
  out.sort((x, y) => x.path.localeCompare(y.path));
  return out;
}

function cloneDiagnostic(
  d: CodegenPreviewDiagnostic,
): CodegenPreviewDiagnostic {
  // Shallow clone — the diagnostic shape is flat strings, so a
  // spread is sufficient to keep the bundle decoupled from the
  // input view.
  return { ...d };
}
