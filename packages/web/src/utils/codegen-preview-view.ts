// Sprint 89 — Codegen preview view projection.
//
// Pure / DOM-free / total. Mirror of Sprint 87B's
// `buildCodegenReadinessView`, but one layer down: instead of
// only running readiness preflight, this helper *also* runs the
// real vendor pipeline (`generateCodesysProject` /
// `generateSiemensProject` / `generateRockwellProject`) when
// readiness is clean enough to attempt it, and produces a
// per-target view the operator reviews BEFORE pressing Generate.
//
// Hard rules:
//   - The helper never throws. CodegenError → `failed` view with
//     a serialized `error: { code, message }`. Defensive any-error
//     catch keeps the UI from crashing on unforeseen exceptions.
//   - Generation is sync, in-process, on the same thread. Worker
//     usage is reserved for the canonical Generate flow; preview
//     is "I just want to peek".
//   - No artifacts are persisted. Snippets are truncated at a
//     fixed line / byte budget per artifact and marked
//     `truncated: true` when clipped.
//   - Backend `'all'` expands into one view per vendor target;
//     a failure on one target does not poison the others.
//   - Readiness `'blocked'` short-circuits — we do NOT call the
//     vendor function when readiness already says no.

import {
  generateCodesysProject,
} from '@plccopilot/codegen-codesys';
import { CodegenError } from '@plccopilot/codegen-core';
import {
  generateRockwellProject,
} from '@plccopilot/codegen-rockwell';
import {
  generateSiemensProject,
} from '@plccopilot/codegen-siemens';
import type {
  ArtifactDiagnostic,
  GeneratedArtifact,
} from '@plccopilot/codegen-core';
import type { Project } from '@plccopilot/pir';

import {
  buildCodegenReadinessView,
  type CodegenReadinessGroup,
  type CodegenReadinessView,
} from './codegen-readiness-view.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CodegenPreviewStatus =
  | 'unavailable'
  | 'running'
  | 'ready'
  | 'ready_with_warnings'
  | 'blocked'
  | 'failed';

export interface CodegenPreviewArtifactView {
  path: string;
  kind: GeneratedArtifact['kind'];
  sizeBytes: number;
  /** Up to `MAX_PREVIEW_LINES` lines / `MAX_PREVIEW_BYTES` bytes; truncated otherwise. */
  previewText: string;
  truncated: boolean;
  /**
   * Sprint 90A — full artifact content (no UI cap). Retained on the
   * preview view so the explicit download bundle can be produced
   * from already-computed preview state without re-running the
   * vendor pipeline. The Sprint 89 panel intentionally displays
   * only `previewText`; nothing in the rendering path reads
   * `content`.
   */
  content: string;
}

export interface CodegenPreviewDiagnostic {
  severity: ArtifactDiagnostic['severity'];
  code: string;
  message: string;
  path?: string;
  hint?: string;
}

export interface CodegenPreviewError {
  code?: string;
  message: string;
}

/**
 * The vendor targets the preview supports. Sprint 89 deliberately
 * excludes `'core'` — the operator never selects "core" as a
 * generation target; the bare `compileProject` pipeline is an
 * implementation detail used by tests, not a UX surface.
 */
export type CodegenPreviewTarget = 'codesys' | 'siemens' | 'rockwell';

export interface CodegenPreviewTargetView {
  target: CodegenPreviewTarget;
  status: CodegenPreviewStatus;
  /** One short sentence the panel can render as a per-target verdict. */
  summary: string;
  /** Number of artifacts the vendor returned. `0` when blocked / failed. */
  artifactCount: number;
  /**
   * Sprint 87B readiness groups (severity-grouped diagnostics, sorted
   * deterministically). Always populated — even on `ready` status —
   * so the operator can drill into warnings.
   */
  readinessGroups: ReadonlyArray<CodegenReadinessGroup>;
  /**
   * Manifest / per-artifact diagnostics aggregated from
   * `GeneratedArtifact.diagnostics`. Severity-grouped + deduped on a
   * `code|severity|message` key. Empty when blocked/failed before
   * generation runs.
   */
  manifestDiagnostics: ReadonlyArray<CodegenPreviewDiagnostic>;
  /**
   * Artifact list sorted by `path` ascending. Each entry carries a
   * truncated content snippet for the panel. `[]` when blocked or
   * failed.
   */
  artifacts: ReadonlyArray<CodegenPreviewArtifactView>;
  /** Populated only when `status === 'failed'`. */
  error?: CodegenPreviewError;
}

export interface CodegenPreviewView {
  /**
   * The operator's selected backend, including `'all'`. Carried so
   * the panel can render a heading consistent with the selector.
   */
  selection: CodegenPreviewTarget | 'all';
  /** Aggregate verdict across `targets[]`. */
  status: CodegenPreviewStatus;
  /** One short sentence summarising the aggregate verdict. */
  summary: string;
  targets: ReadonlyArray<CodegenPreviewTargetView>;
}

export interface BuildCodegenPreviewViewArgs {
  project: Project | null | undefined;
  /**
   * Target(s) to preview. `'all'` expands into the three vendor
   * targets and runs each independently (one failure does not
   * poison the others).
   */
  selection: CodegenPreviewTarget | 'all';
  /**
   * ISO timestamp embedded in each backend's manifest. Optional;
   * defaults to `'1970-01-01T00:00:00.000Z'` so test fixtures stay
   * deterministic. Production callers should pass
   * `new Date().toISOString()`.
   */
  generatedAt?: string;
  /**
   * Override per-target generators — useful for tests that don't
   * want to import the real vendor packages, or for stubbing a
   * failing vendor without mutating production code. When omitted
   * the helper imports the real generators directly.
   */
  generators?: Partial<
    Record<
      CodegenPreviewTarget,
      (
        project: Project,
        opts: { manifest: { generatedAt: string } } | undefined,
      ) => GeneratedArtifact[]
    >
  >;
}

const VENDOR_TARGETS: ReadonlyArray<CodegenPreviewTarget> = [
  'siemens',
  'codesys',
  'rockwell',
];

// ---------------------------------------------------------------------------
// Snippet truncation budget
// ---------------------------------------------------------------------------

/** Hard cap on how many lines a single artifact preview includes. */
export const MAX_PREVIEW_LINES = 40;

/** Hard cap on how many bytes a single artifact preview includes (4 KB). */
export const MAX_PREVIEW_BYTES = 4 * 1024;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const DEFAULT_GENERATED_AT = '1970-01-01T00:00:00.000Z';

export function buildCodegenPreviewView(
  args: BuildCodegenPreviewViewArgs,
): CodegenPreviewView {
  const { project, selection } = args;
  const generatedAt = args.generatedAt ?? DEFAULT_GENERATED_AT;

  // ---- Unavailable: no project to preview against ----
  if (!project) {
    return {
      selection,
      status: 'unavailable',
      summary: 'Build and apply a PIR before previewing generated code.',
      targets: [],
    };
  }

  const targetsToPreview: ReadonlyArray<CodegenPreviewTarget> =
    selection === 'all' ? VENDOR_TARGETS : [selection];

  const targets: CodegenPreviewTargetView[] = targetsToPreview.map((t) =>
    buildSingleTargetPreview({
      project,
      target: t,
      generatedAt,
      generators: args.generators ?? {},
    }),
  );

  return {
    selection,
    status: aggregateStatus(targets),
    summary: aggregateSummary(selection, targets),
    targets,
  };
}

// ---------------------------------------------------------------------------
// Per-target driver
// ---------------------------------------------------------------------------

interface PerTargetArgs {
  project: Project;
  target: CodegenPreviewTarget;
  generatedAt: string;
  generators: BuildCodegenPreviewViewArgs['generators'];
}

function buildSingleTargetPreview(
  args: PerTargetArgs,
): CodegenPreviewTargetView {
  const { project, target } = args;
  // Sprint 87B readiness shapes the panel's first verdict. We
  // ALWAYS run readiness — even when generation will pass — so
  // the panel keeps surfacing warning / info groups for the
  // operator to drill into.
  const readiness = buildCodegenReadinessView({ project, target });

  if (readiness.status === 'unavailable') {
    return {
      target,
      status: 'unavailable',
      summary: readiness.summary,
      artifactCount: 0,
      readinessGroups: readiness.groups,
      manifestDiagnostics: [],
      artifacts: [],
    };
  }

  if (readiness.status === 'blocked') {
    return {
      target,
      status: 'blocked',
      summary: readiness.summary,
      artifactCount: 0,
      readinessGroups: readiness.groups,
      manifestDiagnostics: [],
      artifacts: [],
    };
  }

  // Readiness is `'ready'` or `'warning'` — attempt generation.
  return runVendorGeneration(args, readiness);
}

function runVendorGeneration(
  args: PerTargetArgs,
  readiness: CodegenReadinessView,
): CodegenPreviewTargetView {
  const { project, target, generatedAt } = args;
  const generator = resolveGenerator(target, args.generators);
  const opts = { manifest: { generatedAt } };
  let artifacts: GeneratedArtifact[];
  try {
    artifacts = generator(project, opts);
  } catch (err) {
    return failedTargetView(target, readiness, err);
  }

  // Defensive: a vendor returning a non-array would crash later.
  if (!Array.isArray(artifacts)) {
    return failedTargetView(target, readiness, {
      code: 'INTERNAL_ERROR',
      message: `${target} generator returned a non-array result.`,
    });
  }

  const manifestDiagnostics = aggregateManifestDiagnostics(artifacts);
  const artifactViews = artifacts
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(toArtifactView);

  // Status verdict combines readiness warnings and manifest warnings.
  const hasWarnings =
    readiness.warningCount > 0 ||
    manifestDiagnostics.some(
      (d) => d.severity === 'warning' || d.severity === 'info',
    );
  const status: CodegenPreviewStatus = hasWarnings
    ? 'ready_with_warnings'
    : 'ready';

  return {
    target,
    status,
    summary: makeReadySummary(target, artifactViews.length, hasWarnings),
    artifactCount: artifactViews.length,
    readinessGroups: readiness.groups,
    manifestDiagnostics,
    artifacts: artifactViews,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveGenerator(
  target: CodegenPreviewTarget,
  overrides: BuildCodegenPreviewViewArgs['generators'],
): (
  project: Project,
  opts: { manifest: { generatedAt: string } } | undefined,
) => GeneratedArtifact[] {
  const override = overrides?.[target];
  if (override) return override;
  switch (target) {
    case 'codesys':
      return generateCodesysProject;
    case 'siemens':
      return generateSiemensProject;
    case 'rockwell':
      return generateRockwellProject;
    default: {
      const exhaustive: never = target;
      throw new Error(`unknown vendor target ${String(exhaustive)}`);
    }
  }
}

function failedTargetView(
  target: CodegenPreviewTarget,
  readiness: CodegenReadinessView,
  err: unknown,
): CodegenPreviewTargetView {
  const error = serializeError(err);
  return {
    target,
    status: 'failed',
    summary: `Preview failed for ${target}: ${error.code ?? 'error'}.`,
    artifactCount: 0,
    readinessGroups: readiness.groups,
    manifestDiagnostics: [],
    artifacts: [],
    error,
  };
}

function serializeError(err: unknown): CodegenPreviewError {
  if (err instanceof CodegenError) {
    return { code: err.code, message: err.message };
  }
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : String(err),
    };
  }
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: String(err) };
}

/**
 * Severity-group + dedup vendor manifest diagnostics on
 * `code|severity|message`. Sorted error → warning → info → code.
 */
function aggregateManifestDiagnostics(
  artifacts: ReadonlyArray<GeneratedArtifact>,
): CodegenPreviewDiagnostic[] {
  const seen = new Map<string, CodegenPreviewDiagnostic>();
  for (const a of artifacts) {
    if (!a.diagnostics) continue;
    for (const d of a.diagnostics) {
      const key = `${d.code}|${d.severity}|${d.message}`;
      if (!seen.has(key)) {
        seen.set(key, {
          severity: d.severity,
          code: d.code,
          message: d.message,
          path: d.path,
          hint: d.hint,
        });
      }
    }
  }
  const out = Array.from(seen.values());
  const order: Record<ArtifactDiagnostic['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  out.sort((a, b) => {
    const sev = order[a.severity] - order[b.severity];
    if (sev !== 0) return sev;
    return a.code.localeCompare(b.code);
  });
  return out;
}

function toArtifactView(a: GeneratedArtifact): CodegenPreviewArtifactView {
  const truncated = truncateForPreview(a.content);
  // sizeBytes uses raw character count as a crude UTF-8 proxy. The
  // panel only renders a "≈ N bytes" hint, so absolute fidelity
  // doesn't matter — the truncation budget itself protects memory.
  const sizeBytes = a.content.length;
  return {
    path: a.path,
    kind: a.kind,
    sizeBytes,
    previewText: truncated.text,
    truncated: truncated.truncated,
    // Sprint 90A — keep the full content reachable for the
    // explicit download bundle. The component still renders only
    // the truncated `previewText`.
    content: typeof a.content === 'string' ? a.content : '',
  };
}

function truncateForPreview(content: string): {
  text: string;
  truncated: boolean;
} {
  if (typeof content !== 'string') return { text: '', truncated: false };
  let truncated = false;
  let text = content;
  if (text.length > MAX_PREVIEW_BYTES) {
    text = text.slice(0, MAX_PREVIEW_BYTES);
    truncated = true;
  }
  const lines = text.split('\n');
  if (lines.length > MAX_PREVIEW_LINES) {
    text = lines.slice(0, MAX_PREVIEW_LINES).join('\n');
    truncated = true;
  }
  return { text, truncated };
}

function aggregateStatus(
  targets: ReadonlyArray<CodegenPreviewTargetView>,
): CodegenPreviewStatus {
  if (targets.length === 0) return 'unavailable';
  // Worst-case rollup: failed > blocked > ready_with_warnings > ready.
  const ranks: Record<CodegenPreviewStatus, number> = {
    unavailable: -1,
    ready: 0,
    ready_with_warnings: 1,
    blocked: 2,
    failed: 3,
    running: 4,
  };
  let worst: CodegenPreviewStatus = 'ready';
  for (const t of targets) {
    if (ranks[t.status] > ranks[worst]) worst = t.status;
  }
  return worst;
}

function aggregateSummary(
  selection: CodegenPreviewTarget | 'all',
  targets: ReadonlyArray<CodegenPreviewTargetView>,
): string {
  if (targets.length === 0) {
    return 'Build and apply a PIR before previewing generated code.';
  }
  if (selection !== 'all') {
    return targets[0].summary;
  }
  const ready = targets.filter(
    (t) => t.status === 'ready' || t.status === 'ready_with_warnings',
  ).length;
  const blocked = targets.filter((t) => t.status === 'blocked').length;
  const failed = targets.filter((t) => t.status === 'failed').length;
  if (failed > 0) {
    return `Preview produced ${ready}/${targets.length} ready target(s); ${failed} failed, ${blocked} blocked.`;
  }
  if (blocked > 0) {
    return `Preview produced ${ready}/${targets.length} ready target(s); ${blocked} blocked by readiness.`;
  }
  return `Preview ready for all ${targets.length} vendor targets.`;
}

function makeReadySummary(
  target: CodegenPreviewTarget,
  artifactCount: number,
  hasWarnings: boolean,
): string {
  if (hasWarnings) {
    return `Preview ready for ${target} (${artifactCount} artifact${artifactCount === 1 ? '' : 's'}, with warnings).`;
  }
  return `Preview ready for ${target} (${artifactCount} artifact${artifactCount === 1 ? '' : 's'}).`;
}
