// Sprint 78B — pure serialisation + availability + filename helpers
// for the electrical-review export panel. All helpers are
// deterministic and DOM-free; the only DOM-touching surface is
// `triggerJsonDownload` (a thin wrapper around `downloadText`) and
// `triggerBundleDownload` (uses `URL.createObjectURL`). Tests can
// exercise everything else in `environment: 'node'`.
import JSZip from 'jszip';
import type {
  ElectricalDiagnostic,
  PirBuildDiagnostic,
  PirBuildResult,
  SourceRef,
} from '@plccopilot/electrical-ingest';

import { downloadText } from './download.js';
import type { ElectricalReviewSessionSnapshot } from './electrical-review-session.js';

// =============================================================================
// Filenames
// =============================================================================

/**
 * Conservative filename sanitiser:
 *   - Trim whitespace.
 *   - Replace any character outside the ASCII-letter/digit/`-_.`
 *     class with `-`.
 *   - Collapse runs of `-`.
 *   - Trim leading / trailing `-` / `.`.
 *   - Cap to 64 chars.
 *
 * Cross-platform safe: rejects Windows-reserved chars (`<>:"/\|?*`),
 * NUL, control chars; cannot produce `..` segments. Empty / all-junk
 * input falls back to the caller-supplied default.
 */
export function sanitizeBaseName(input: string, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const trimmed = input.trim();
  if (trimmed.length === 0) return fallback;
  const cleaned = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 64);
  return cleaned.length === 0 ? fallback : cleaned;
}

/**
 * Build a deterministic artefact filename of the form
 *
 *   plccopilot-{base}-{suffix}.json
 *
 * Example: `makeArtifactFileName('terminals', 'review-session.json')`
 * → `plccopilot-terminals-review-session.json`. The base is sanitised
 * via `sanitizeBaseName`; an empty / undefined base collapses to
 * `plccopilot-{suffix}`.
 */
export function makeArtifactFileName(
  base: string | undefined | null,
  suffix: string,
): string {
  if (typeof suffix !== 'string' || suffix.length === 0) {
    throw new Error('makeArtifactFileName: suffix is required.');
  }
  const baseStr =
    typeof base === 'string' && base.length > 0
      ? sanitizeBaseName(base, '')
      : '';
  return baseStr.length > 0
    ? `plccopilot-${baseStr}-${suffix}`
    : `plccopilot-${suffix}`;
}

// =============================================================================
// Pure serialisation (stable, pretty, 2-space indent)
// =============================================================================

/**
 * Pretty-print any JSON-able value with 2-space indent + trailing
 * newline. Throws on circular structures (matches `JSON.stringify`
 * behaviour) — callers are expected to pass plain data.
 */
function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

export function serializeReviewSession(
  snapshot: ElectricalReviewSessionSnapshot,
): string {
  return prettyJson(snapshot);
}

export function serializePirJson(pir: unknown): string {
  return prettyJson(pir);
}

export function serializeSourceMap(
  sourceMap: Record<string, SourceRef[]>,
): string {
  return prettyJson(sourceMap);
}

export function serializeBuildDiagnostics(
  diagnostics: readonly PirBuildDiagnostic[],
): string {
  return prettyJson(diagnostics);
}

export function serializeIngestionDiagnostics(
  diagnostics: readonly ElectricalDiagnostic[],
): string {
  return prettyJson(diagnostics);
}

// =============================================================================
// Availability projection (pure)
// =============================================================================

export interface ExportAvailabilityInput {
  /** Snapshot must exist for any export. */
  snapshot: ElectricalReviewSessionSnapshot | null;
  /**
   * Live build result. May be null when no build has been attempted
   * yet — in which case build-side downloads are disabled.
   */
  buildResult?: PirBuildResult | null;
}

export interface ExportAvailability {
  /** Always available when the snapshot is present. */
  reviewSession: boolean;
  ingestionDiagnostics: boolean;
  /** Available iff the build returned a valid `pir`. */
  pirJson: boolean;
  /** Available iff `sourceMap` is non-empty. */
  sourceMap: boolean;
  /** Available iff a build has been attempted (regardless of outcome). */
  buildDiagnostics: boolean;
  /** Bundle is available whenever the snapshot is present. */
  bundle: boolean;
}

/**
 * Decide which downloads should be enabled, given the live snapshot
 * + (optional) build result. Pure / deterministic. The component
 * uses this projection to disable the matching buttons.
 */
export function computeExportAvailability(
  input: ExportAvailabilityInput,
): ExportAvailability {
  const hasSnapshot = !!input.snapshot;
  const buildResult = input.buildResult ?? null;
  const hasBuildAttempt = !!buildResult || !!input.snapshot?.build;
  const hasPir =
    !!buildResult?.pir || !!input.snapshot?.build?.pir;
  const liveMap = buildResult?.sourceMap;
  const savedMap = input.snapshot?.build?.sourceMap;
  const hasSourceMap =
    (liveMap !== undefined && Object.keys(liveMap).length > 0) ||
    (savedMap !== undefined && Object.keys(savedMap).length > 0);
  return {
    reviewSession: hasSnapshot,
    ingestionDiagnostics: hasSnapshot,
    pirJson: hasPir,
    sourceMap: hasSourceMap,
    buildDiagnostics: hasBuildAttempt,
    bundle: hasSnapshot,
  };
}

// =============================================================================
// Bundle (ZIP) — uses pre-existing JSZip dependency
// =============================================================================

export interface BuildReviewBundleZipInput {
  snapshot: ElectricalReviewSessionSnapshot;
  buildResult?: PirBuildResult | null;
}

export interface ReviewBundleSummary {
  schemaVersion: 'electrical-review-bundle.summary.v1';
  generatedAt: string;
  sourceFileName?: string;
  sourceKind?: string;
  inputKind: 'csv' | 'xml' | 'pdf' | 'unknown';
  hasPir: boolean;
  hasSourceMap: boolean;
  buildAttempted: boolean;
  contents: string[];
}

/**
 * Build a JSZip with all available artefacts. Pure (no DOM) — the
 * caller wires the result through `zip.generateAsync({type:'blob'})`
 * + `triggerDownload` for actual download. Tests inspect entries
 * directly via `Object.keys(zip.files)`.
 *
 * Bundle layout (entries are added only when their data is present):
 *
 *   review-session.json          (always)
 *   ingestion-diagnostics.json   (always)
 *   pir-preview.json             (only if pir built)
 *   source-map.json              (only if non-empty)
 *   build-diagnostics.json       (only if build attempted)
 *   summary.json                 (always — index of what's inside)
 */
export function buildReviewBundleZip(
  input: BuildReviewBundleZipInput,
  generatedAtIso: string,
): JSZip {
  if (!input || !input.snapshot) {
    throw new Error('buildReviewBundleZip: snapshot is required.');
  }
  if (typeof generatedAtIso !== 'string' || generatedAtIso.length === 0) {
    throw new Error('buildReviewBundleZip: generatedAtIso is required.');
  }
  const zip = new JSZip();
  const snap = input.snapshot;
  const live = input.buildResult ?? null;
  const contents: string[] = [];

  zip.file('review-session.json', serializeReviewSession(snap), {
    createFolders: false,
  });
  contents.push('review-session.json');

  zip.file(
    'ingestion-diagnostics.json',
    serializeIngestionDiagnostics(snap.ingestionDiagnostics ?? []),
    { createFolders: false },
  );
  contents.push('ingestion-diagnostics.json');

  const pir = live?.pir ?? snap.build?.pir;
  if (pir) {
    zip.file('pir-preview.json', serializePirJson(pir), {
      createFolders: false,
    });
    contents.push('pir-preview.json');
  }

  const map = live?.sourceMap ?? snap.build?.sourceMap;
  if (map && Object.keys(map).length > 0) {
    zip.file('source-map.json', serializeSourceMap(map), {
      createFolders: false,
    });
    contents.push('source-map.json');
  }

  const diags = live?.diagnostics ?? snap.build?.diagnostics;
  if (diags) {
    zip.file('build-diagnostics.json', serializeBuildDiagnostics(diags), {
      createFolders: false,
    });
    contents.push('build-diagnostics.json');
  }

  const summary: ReviewBundleSummary = {
    schemaVersion: 'electrical-review-bundle.summary.v1',
    generatedAt: generatedAtIso,
    sourceFileName: snap.source.fileName,
    sourceKind: snap.source.sourceKind,
    inputKind: snap.source.inputKind,
    hasPir: !!pir,
    hasSourceMap: !!(map && Object.keys(map).length > 0),
    buildAttempted: !!(live || snap.build),
    contents,
  };
  zip.file('summary.json', JSON.stringify(summary, null, 2) + '\n', {
    createFolders: false,
  });

  return zip;
}

// =============================================================================
// Download triggers (DOM-touching — only used by the React panel)
// =============================================================================

export function triggerJsonDownload(filename: string, content: string): void {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('triggerJsonDownload: filename is required.');
  }
  downloadText(filename, content, 'application/json');
}

/**
 * Browser-only: bundles the artefacts into a ZIP and triggers a
 * single download. Sprint 78B keeps this thin so it can be called
 * directly from the React panel; the bundle construction itself is
 * tested via `buildReviewBundleZip`.
 */
export async function triggerBundleDownload(
  input: BuildReviewBundleZipInput,
  filename: string,
  generatedAtIso: string,
): Promise<void> {
  const zip = buildReviewBundleZip(input, generatedAtIso);
  const blob = await zip.generateAsync({ type: 'blob' });
  // Dynamic DOM access — guarded so tests never crash on import.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
