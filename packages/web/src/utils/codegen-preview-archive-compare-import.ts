// Sprint 96 — Imported codegen preview archive-compare bundle
// parser. Mirrors Sprint 92's Sprint 91 importer pattern, but
// for the Sprint 95 v1 bundle:
//
//   kind:    'plc-copilot.codegen-preview-archive-compare'
//   version: 1
//
// Pure / DOM-free / total. The operator picks a previously
// downloaded JSON in the panel; the panel hands the text to
// `parseCodegenPreviewArchiveCompareBundleText`, and the helper
// either returns a validated bundle or a stable error string.
// The validator never throws on operator-supplied input,
// rebuilds a fresh bundle from a v1 whitelist of known fields,
// and drops any extras (a stray `content`, `previewText`, raw
// source payload, `pir_version`) on the floor.
//
// Hard rules:
//   - Total — never throws on operator-supplied input. Empty /
//     bad JSON / wrong kind / wrong version → `status: 'invalid'`
//     with a stable, terse `error` string.
//   - Pure — no DOM, no I/O, no clock, no random.
//   - Deterministic — two parses of the same input deep-equal.
//   - No mutation — the operator-supplied object is never pinned
//     by the returned view.
//   - Strict v1 contract. Anything not in Sprint 95's bundle
//     shape is rejected or omitted.
//   - Reuses the Sprint 95 type tree verbatim; Sprint 96 does
//     NOT introduce a new format.

import {
  CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND,
  CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION,
  type CodegenPreviewArchiveCompareBundle,
  type CodegenPreviewArchiveCompareBundleArtifactRow,
  type CodegenPreviewArchiveCompareBundleCounts,
  type CodegenPreviewArchiveCompareBundleDiagnosticRow,
  type CodegenPreviewArchiveCompareBundleSelectionBlock,
  type CodegenPreviewArchiveCompareBundleTarget,
} from './codegen-preview-archive-compare-download.js';
import type {
  ArchivedArtifactComparisonStatus,
  ArchivedDiagnosticComparisonStatus,
  ArchivedPreviewComparisonState,
  ArchivedTargetComparisonStatus,
  ArchivedTargetCounts,
} from './codegen-preview-archive-compare.js';
import type {
  CodegenPreviewArtifactDiffStatus,
  CodegenPreviewTargetDiffStatus,
} from './codegen-preview-diff.js';
import type {
  CodegenPreviewDiagnostic,
  CodegenPreviewTarget,
} from './codegen-preview-view.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImportedCodegenPreviewArchiveCompareStatus =
  | 'empty'
  | 'loaded'
  | 'invalid';

export interface ImportedCodegenPreviewArchiveCompareView {
  readonly status: ImportedCodegenPreviewArchiveCompareStatus;
  readonly summary: string;
  readonly bundle?: CodegenPreviewArchiveCompareBundle;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Public — parse from raw text
// ---------------------------------------------------------------------------

/**
 * Parse the JSON text the operator picked from disk.
 *
 *   - Empty / whitespace-only → `'empty'`
 *   - JSON.parse failure or v1 contract violation → `'invalid'`
 *   - Success → `'loaded'` with the validated bundle
 *
 * Never throws.
 */
export function parseCodegenPreviewArchiveCompareBundleText(
  input: string,
): ImportedCodegenPreviewArchiveCompareView {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return emptyView();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return invalidView(
      'Could not parse JSON. The file is not valid JSON text.',
    );
  }
  return parseCodegenPreviewArchiveCompareBundle(parsed);
}

/**
 * Parse an already-deserialised value. Useful for paste / drag-
 * and-drop callers. Same `empty | loaded | invalid` semantics.
 */
export function parseCodegenPreviewArchiveCompareBundle(
  value: unknown,
): ImportedCodegenPreviewArchiveCompareView {
  if (value === null || value === undefined) return emptyView();
  if (typeof value !== 'object') {
    return invalidView(
      'Could not import comparison bundle: expected a JSON object at the top level.',
    );
  }
  const obj = value as Record<string, unknown>;

  if (obj.kind !== CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND) {
    return invalidView(
      `Could not import comparison bundle: expected kind ${CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND} version ${CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION}.`,
    );
  }
  if (obj.version !== CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION) {
    return invalidView(
      `Could not import comparison bundle: unsupported version. This build understands version ${CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION} only.`,
    );
  }

  const createdAt = readCreatedAt(obj.createdAt);
  if (!createdAt) {
    return invalidView(
      'Could not import comparison bundle: createdAt is missing or not parseable.',
    );
  }

  const snapshotName = readString(obj.snapshotName, 'compare');

  const selection = parseSelection(obj.selection);
  if (!selection) {
    return invalidView(
      'Could not import comparison bundle: missing or malformed selection block.',
    );
  }

  const state = parseGlobalState(obj.state);
  if (!state) {
    return invalidView(
      'Could not import comparison bundle: state must be a known ArchivedPreviewComparisonState.',
    );
  }

  const summary = readString(obj.summary, '');
  if (!summary) {
    return invalidView(
      'Could not import comparison bundle: summary is required.',
    );
  }

  const counts = parseGlobalCounts(obj.counts);
  if (!counts) {
    return invalidView(
      'Could not import comparison bundle: counts block is missing or malformed.',
    );
  }

  if (!Array.isArray(obj.targets)) {
    return invalidView(
      'Could not import comparison bundle: targets must be an array.',
    );
  }
  const targets: CodegenPreviewArchiveCompareBundleTarget[] = [];
  for (const raw of obj.targets) {
    const t = parseTarget(raw);
    if (!t) {
      return invalidView(
        'Could not import comparison bundle: at least one target entry is missing required fields.',
      );
    }
    targets.push(t);
  }

  const bundle: CodegenPreviewArchiveCompareBundle = {
    kind: CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND,
    version: CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION,
    createdAt,
    snapshotName,
    selection,
    state,
    summary,
    counts,
    targets,
  };

  return {
    status: 'loaded',
    summary: makeLoadedSummary(bundle),
    bundle,
  };
}

/**
 * True iff the value parses as a Sprint 95 v1 archive comparison
 * bundle. Lighter predicate the panel can use without inspecting
 * the validated bundle.
 */
export function isSupportedCodegenPreviewArchiveCompareBundle(
  value: unknown,
): boolean {
  return (
    parseCodegenPreviewArchiveCompareBundle(value).status === 'loaded'
  );
}

// ---------------------------------------------------------------------------
// Internal — view factories
// ---------------------------------------------------------------------------

function emptyView(): ImportedCodegenPreviewArchiveCompareView {
  return {
    status: 'empty',
    summary:
      'Archived comparison: none. Import a previously downloaded plc-copilot.codegen-preview-archive-compare JSON to inspect it read-only.',
  };
}

function invalidView(error: string): ImportedCodegenPreviewArchiveCompareView {
  return {
    status: 'invalid',
    summary: error,
    error,
  };
}

function makeLoadedSummary(
  bundle: CodegenPreviewArchiveCompareBundle,
): string {
  const targetWord = bundle.targets.length === 1 ? 'target' : 'targets';
  return `Archived comparison (${bundle.state}, ${bundle.targets.length} ${targetWord}).`;
}

// ---------------------------------------------------------------------------
// Internal — selection
// ---------------------------------------------------------------------------

const VALID_BACKENDS: ReadonlyArray<CodegenPreviewTarget | 'all'> = [
  'codesys',
  'siemens',
  'rockwell',
  'all',
];

function isBackend(
  value: unknown,
): value is CodegenPreviewTarget | 'all' {
  return (
    typeof value === 'string' &&
    VALID_BACKENDS.indexOf(value as CodegenPreviewTarget | 'all') !== -1
  );
}

function parseSelection(
  value: unknown,
): CodegenPreviewArchiveCompareBundleSelectionBlock | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const selectionMatch = obj.selectionMatch;
  if (typeof selectionMatch !== 'boolean') return null;

  const out: CodegenPreviewArchiveCompareBundleSelectionBlock = {
    selectionMatch,
  };
  if (obj.archivedBackend !== undefined && obj.archivedBackend !== null) {
    if (!isBackend(obj.archivedBackend)) return null;
    out.archivedBackend = obj.archivedBackend;
  }
  if (obj.currentBackend !== undefined && obj.currentBackend !== null) {
    if (!isBackend(obj.currentBackend)) return null;
    out.currentBackend = obj.currentBackend;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal — state enums
// ---------------------------------------------------------------------------

const VALID_GLOBAL_STATES: ReadonlyArray<ArchivedPreviewComparisonState> = [
  'no-archived-diff',
  'no-current-preview',
  'selection-mismatch',
  'unchanged-against-archive',
  'changed-against-archive',
  'partially-comparable',
];

function parseGlobalState(
  value: unknown,
): ArchivedPreviewComparisonState | null {
  if (
    typeof value === 'string' &&
    VALID_GLOBAL_STATES.indexOf(value as ArchivedPreviewComparisonState) !== -1
  ) {
    return value as ArchivedPreviewComparisonState;
  }
  return null;
}

const VALID_TARGET_STATUSES: ReadonlyArray<ArchivedTargetComparisonStatus> = [
  'same',
  'changed',
  'missing-current',
  'missing-archived',
  'not-comparable',
];

function parseTargetStatus(
  value: unknown,
): ArchivedTargetComparisonStatus | null {
  if (
    typeof value === 'string' &&
    VALID_TARGET_STATUSES.indexOf(value as ArchivedTargetComparisonStatus) !==
      -1
  ) {
    return value as ArchivedTargetComparisonStatus;
  }
  return null;
}

const VALID_ARTIFACT_STATUSES: ReadonlyArray<ArchivedArtifactComparisonStatus> = [
  'same-hash',
  'changed-hash',
  'missing-current',
  'new-current',
  'not-comparable',
];

function parseArtifactStatus(
  value: unknown,
): ArchivedArtifactComparisonStatus | null {
  if (
    typeof value === 'string' &&
    VALID_ARTIFACT_STATUSES.indexOf(
      value as ArchivedArtifactComparisonStatus,
    ) !== -1
  ) {
    return value as ArchivedArtifactComparisonStatus;
  }
  return null;
}

const VALID_DIAGNOSTIC_STATUSES: ReadonlyArray<ArchivedDiagnosticComparisonStatus> = [
  'still-present',
  'resolved',
  'new-current',
  'not-comparable',
];

function parseDiagnosticStatus(
  value: unknown,
): ArchivedDiagnosticComparisonStatus | null {
  if (
    typeof value === 'string' &&
    VALID_DIAGNOSTIC_STATUSES.indexOf(
      value as ArchivedDiagnosticComparisonStatus,
    ) !== -1
  ) {
    return value as ArchivedDiagnosticComparisonStatus;
  }
  return null;
}

// Sprint 91 / 90B archive-side enums (carried verbatim from the
// imported diff bundle into the archive comparison's
// `archivedStatus` fields).
const VALID_ARCHIVED_TARGET_STATUSES: ReadonlyArray<CodegenPreviewTargetDiffStatus> = [
  'added',
  'removed',
  'status_changed',
  'artifacts_changed',
  'diagnostics_changed',
  'unchanged',
];

function parseArchivedTargetStatus(
  value: unknown,
): CodegenPreviewTargetDiffStatus | null {
  if (
    typeof value === 'string' &&
    VALID_ARCHIVED_TARGET_STATUSES.indexOf(
      value as CodegenPreviewTargetDiffStatus,
    ) !== -1
  ) {
    return value as CodegenPreviewTargetDiffStatus;
  }
  return null;
}

const VALID_ARCHIVED_ARTIFACT_STATUSES: ReadonlyArray<CodegenPreviewArtifactDiffStatus> = [
  'added',
  'removed',
  'changed',
  'unchanged',
];

function parseArchivedArtifactStatus(
  value: unknown,
): CodegenPreviewArtifactDiffStatus | null {
  if (
    typeof value === 'string' &&
    VALID_ARCHIVED_ARTIFACT_STATUSES.indexOf(
      value as CodegenPreviewArtifactDiffStatus,
    ) !== -1
  ) {
    return value as CodegenPreviewArtifactDiffStatus;
  }
  return null;
}

function parseArchivedDiagnosticStatus(
  value: unknown,
): 'added' | 'removed' | null {
  if (value === 'added' || value === 'removed') return value;
  return null;
}

// ---------------------------------------------------------------------------
// Internal — counts
// ---------------------------------------------------------------------------

function parseGlobalCounts(
  value: unknown,
): CodegenPreviewArchiveCompareBundleCounts | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const required = [
    'targetsCompared',
    'targetsChanged',
    'artifactsSame',
    'artifactsChanged',
    'artifactsMissingCurrent',
    'artifactsNewCurrent',
    'diagnosticsStillPresent',
    'diagnosticsResolved',
    'diagnosticsNewCurrent',
  ] as const;
  const out: Record<(typeof required)[number], number> = {
    targetsCompared: 0,
    targetsChanged: 0,
    artifactsSame: 0,
    artifactsChanged: 0,
    artifactsMissingCurrent: 0,
    artifactsNewCurrent: 0,
    diagnosticsStillPresent: 0,
    diagnosticsResolved: 0,
    diagnosticsNewCurrent: 0,
  };
  for (const k of required) {
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[k] = Math.trunc(v);
  }
  return out;
}

function parsePerTargetCounts(value: unknown): ArchivedTargetCounts | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const required = [
    'artifactsSame',
    'artifactsChanged',
    'artifactsMissingCurrent',
    'artifactsNewCurrent',
    'artifactsNotComparable',
    'diagnosticsStillPresent',
    'diagnosticsResolved',
    'diagnosticsNewCurrent',
  ] as const;
  const out: Record<(typeof required)[number], number> = {
    artifactsSame: 0,
    artifactsChanged: 0,
    artifactsMissingCurrent: 0,
    artifactsNewCurrent: 0,
    artifactsNotComparable: 0,
    diagnosticsStillPresent: 0,
    diagnosticsResolved: 0,
    diagnosticsNewCurrent: 0,
  };
  for (const k of required) {
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[k] = Math.trunc(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal — target row
// ---------------------------------------------------------------------------

const VALID_TARGETS: ReadonlyArray<CodegenPreviewTarget> = [
  'codesys',
  'siemens',
  'rockwell',
];

function parseTarget(
  value: unknown,
): CodegenPreviewArchiveCompareBundleTarget | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const target = obj.target;
  if (
    typeof target !== 'string' ||
    VALID_TARGETS.indexOf(target as CodegenPreviewTarget) === -1
  ) {
    return null;
  }

  const status = parseTargetStatus(obj.status);
  if (!status) return null;

  const summary = readString(obj.summary, '');

  const counts = parsePerTargetCounts(obj.counts);
  if (!counts) return null;

  if (!Array.isArray(obj.artifactComparisons)) return null;
  const artifactComparisons: CodegenPreviewArchiveCompareBundleArtifactRow[] = [];
  for (const raw of obj.artifactComparisons) {
    const a = parseArtifactRow(raw);
    if (!a) return null;
    artifactComparisons.push(a);
  }

  if (!Array.isArray(obj.diagnosticComparisons)) return null;
  const diagnosticComparisons: CodegenPreviewArchiveCompareBundleDiagnosticRow[] = [];
  for (const raw of obj.diagnosticComparisons) {
    const d = parseDiagnosticRow(raw);
    if (!d) return null;
    diagnosticComparisons.push(d);
  }

  const out: CodegenPreviewArchiveCompareBundleTarget = {
    target: target as CodegenPreviewTarget,
    status,
    summary,
    counts,
    artifactComparisons,
    diagnosticComparisons,
  };
  if (typeof obj.archivedTargetStatus === 'string') {
    const a = parseArchivedTargetStatus(obj.archivedTargetStatus);
    if (a) out.archivedTargetStatus = a;
  }
  if (typeof obj.archivedRecordedCurrentStatus === 'string') {
    out.archivedRecordedCurrentStatus = obj.archivedRecordedCurrentStatus;
  }
  if (typeof obj.currentStatus === 'string') {
    out.currentStatus = obj.currentStatus;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal — artifact row
// ---------------------------------------------------------------------------

function parseArtifactRow(
  value: unknown,
): CodegenPreviewArchiveCompareBundleArtifactRow | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const path = obj.path;
  if (typeof path !== 'string' || path.length === 0) return null;
  const status = parseArtifactStatus(obj.status);
  if (!status) return null;

  const out: CodegenPreviewArchiveCompareBundleArtifactRow = { path, status };
  if (typeof obj.archivedHash === 'string' && obj.archivedHash.length > 0) {
    out.archivedHash = obj.archivedHash;
  }
  if (typeof obj.currentHash === 'string' && obj.currentHash.length > 0) {
    out.currentHash = obj.currentHash;
  }
  if (typeof obj.archivedSizeBytes === 'number') {
    out.archivedSizeBytes = clampSize(obj.archivedSizeBytes);
  }
  if (typeof obj.currentSizeBytes === 'number') {
    out.currentSizeBytes = clampSize(obj.currentSizeBytes);
  }
  if (typeof obj.archivedStatus === 'string') {
    const a = parseArchivedArtifactStatus(obj.archivedStatus);
    if (a) out.archivedStatus = a;
  }
  // `content`, `previewText`, and any other extra field are
  // deliberately NOT copied. The whitelist rebuild pins the
  // privacy invariant for any importer.
  return out;
}

// ---------------------------------------------------------------------------
// Internal — diagnostic row
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: ReadonlyArray<CodegenPreviewDiagnostic['severity']> = [
  'error',
  'warning',
  'info',
];

function parseDiagnosticRow(
  value: unknown,
): CodegenPreviewArchiveCompareBundleDiagnosticRow | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const status = parseDiagnosticStatus(obj.status);
  if (!status) return null;

  const severity = obj.severity;
  if (
    typeof severity !== 'string' ||
    VALID_SEVERITIES.indexOf(
      severity as CodegenPreviewDiagnostic['severity'],
    ) === -1
  ) {
    return null;
  }
  if (typeof obj.code !== 'string') return null;
  if (typeof obj.message !== 'string') return null;

  const out: CodegenPreviewArchiveCompareBundleDiagnosticRow = {
    status,
    severity: severity as CodegenPreviewDiagnostic['severity'],
    code: obj.code,
    message: obj.message,
  };
  if (typeof obj.path === 'string') out.path = obj.path;
  if (typeof obj.hint === 'string') out.hint = obj.hint;
  if (typeof obj.archivedStatus === 'string') {
    const a = parseArchivedDiagnosticStatus(obj.archivedStatus);
    if (a) out.archivedStatus = a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal — primitive readers
// ---------------------------------------------------------------------------

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readCreatedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (Number.isNaN(Date.parse(value))) return null;
  return value;
}

function clampSize(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}
