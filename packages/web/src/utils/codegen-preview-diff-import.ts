// Sprint 92 — Imported codegen preview diff bundle parser.
//
// Pure / DOM-free / total. Sprint 91 produced a deterministic
// `plc-copilot.codegen-preview-diff` v1 JSON file the operator
// can save locally. Sprint 92 adds the read-only round trip:
// the operator picks the file in the browser, the panel hands
// the text to this helper, and the helper either returns a
// validated bundle or a clear error string. Nothing is mutated,
// no vendor pipeline is re-run, and any extra fields the JSON
// happens to carry (including a stray `content` payload from a
// future format drift) are dropped on the floor by the
// whitelist-rebuild validator.
//
// Hard rules:
//   - Total — never throws on operator-supplied input. Bad JSON,
//     missing keys, wrong kind, wrong version, wrong target name
//     → all surface as `status: 'invalid'` with a short, stable
//     `error` string.
//   - Deterministic — two calls on the same input produce
//     deep-equal output.
//   - Pure — no DOM, no I/O, no clock, no random. The file
//     read happens in the panel; this helper only sees the
//     resulting string / parsed value.
//   - No mutation of the input value. Validation rebuilds a
//     fresh bundle; the operator-supplied object is never
//     pinned by the returned view.
//   - Strict v1 contract. Anything that is not in Sprint 91's
//     bundle shape is rejected or omitted. We don't try to
//     auto-upgrade older bundles (none exist) and we don't
//     accept future versions silently — the helper rejects
//     `version !== 1` on purpose so a future bundle bump shows
//     up loudly.

import {
  CODEGEN_PREVIEW_DIFF_BUNDLE_KIND,
  CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION,
  type CodegenPreviewDiffBundle,
  type CodegenPreviewDiffBundleArtifactChange,
  type CodegenPreviewDiffBundleCounts,
  type CodegenPreviewDiffBundleDiagnosticChange,
  type CodegenPreviewDiffBundleSelection,
  type CodegenPreviewDiffBundleSelectionBlock,
  type CodegenPreviewDiffBundleState,
  type CodegenPreviewDiffBundleTarget,
  type CodegenPreviewDiffBundleTargetState,
} from './codegen-preview-diff-download.js';
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

export type ImportedCodegenPreviewDiffStatus = 'empty' | 'loaded' | 'invalid';

export interface ImportedCodegenPreviewDiffView {
  readonly status: ImportedCodegenPreviewDiffStatus;
  /** Operator-friendly one-liner the panel can render verbatim. */
  readonly summary: string;
  /** Validated bundle. Present only on `status === 'loaded'`. */
  readonly bundle?: CodegenPreviewDiffBundle;
  /** Stable error string. Present only on `status === 'invalid'`. */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Public — parse from raw text
// ---------------------------------------------------------------------------

/**
 * Parse the JSON text the operator picked from disk. Returns
 *   - `empty`   when the input is empty / whitespace-only,
 *   - `invalid` when JSON parse fails or the v1 contract is not met,
 *   - `loaded`  with the validated bundle on success.
 *
 * Never throws. Useful as the panel's single entry-point.
 */
export function parseCodegenPreviewDiffBundleText(
  input: string,
): ImportedCodegenPreviewDiffView {
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
  return parseCodegenPreviewDiffBundle(parsed);
}

/**
 * Parse an already-deserialised JSON value. Useful when the
 * panel has decoded the file via another path (e.g. drag-and-
 * drop, paste). Same `empty | loaded | invalid` semantics.
 */
export function parseCodegenPreviewDiffBundle(
  value: unknown,
): ImportedCodegenPreviewDiffView {
  if (value === null || value === undefined) return emptyView();
  if (typeof value !== 'object') {
    return invalidView(
      'Could not import diff bundle: expected a JSON object at the top level.',
    );
  }
  const obj = value as Record<string, unknown>;

  if (obj.kind !== CODEGEN_PREVIEW_DIFF_BUNDLE_KIND) {
    return invalidView(
      `Could not import diff bundle: expected kind ${CODEGEN_PREVIEW_DIFF_BUNDLE_KIND} version ${CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION}.`,
    );
  }
  if (obj.version !== CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION) {
    return invalidView(
      `Could not import diff bundle: unsupported version. This build understands version ${CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION} only.`,
    );
  }

  const selection = parseSelection(obj.selection);
  if (!selection) {
    return invalidView(
      'Could not import diff bundle: missing or malformed selection block.',
    );
  }

  const state = parseTopLevelState(obj.state);
  if (!state) {
    return invalidView(
      'Could not import diff bundle: state must be "unchanged" or "changed".',
    );
  }

  const summary = readString(obj.summary, '');
  if (!summary) {
    return invalidView(
      'Could not import diff bundle: summary is required.',
    );
  }

  const counts = parseCounts(obj.counts);
  if (!counts) {
    return invalidView(
      'Could not import diff bundle: counts block is missing or malformed.',
    );
  }

  if (!Array.isArray(obj.targets)) {
    return invalidView(
      'Could not import diff bundle: targets must be an array.',
    );
  }
  const targets: CodegenPreviewDiffBundleTarget[] = [];
  for (const raw of obj.targets) {
    const t = parseTarget(raw);
    if (!t) {
      return invalidView(
        'Could not import diff bundle: at least one target entry is missing required fields.',
      );
    }
    targets.push(t);
  }

  // Snapshot name — optional in the wild (older Sprint 91 bundles
  // always carry one, but be lenient). Sanitisation already
  // happened at write time; we trust the string verbatim.
  const snapshotName = readString(obj.snapshotName, 'diff');

  const bundle: CodegenPreviewDiffBundle = {
    kind: CODEGEN_PREVIEW_DIFF_BUNDLE_KIND,
    version: CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION,
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
 * True iff the value parses as a Sprint 91 v1 diff bundle.
 * Lighter-weight predicate for the panel to gate UI that does
 * not need the full validated bundle.
 */
export function isSupportedCodegenPreviewDiffBundle(
  value: unknown,
): boolean {
  return parseCodegenPreviewDiffBundle(value).status === 'loaded';
}

// ---------------------------------------------------------------------------
// Internal — view factories
// ---------------------------------------------------------------------------

function emptyView(): ImportedCodegenPreviewDiffView {
  return {
    status: 'empty',
    summary:
      'Imported diff: none. Import a previously downloaded plc-copilot.codegen-preview-diff JSON to inspect it read-only.',
  };
}

function invalidView(error: string): ImportedCodegenPreviewDiffView {
  return {
    status: 'invalid',
    summary: error,
    error,
  };
}

function makeLoadedSummary(bundle: CodegenPreviewDiffBundle): string {
  const targetWord = bundle.targets.length === 1 ? 'target' : 'targets';
  const stateWord = bundle.state === 'unchanged' ? 'no changes' : 'changes';
  return `Imported diff (${bundle.selection.backend}, ${bundle.targets.length} ${targetWord}, ${stateWord}).`;
}

// ---------------------------------------------------------------------------
// Internal — selection
// ---------------------------------------------------------------------------

const VALID_BACKENDS: ReadonlyArray<CodegenPreviewDiffBundleSelection> = [
  'codesys',
  'siemens',
  'rockwell',
  'all',
];

function parseSelection(
  value: unknown,
): CodegenPreviewDiffBundleSelectionBlock | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const backend = obj.backend;
  if (!isBackend(backend)) return null;
  const previousBackend = obj.previousBackend;
  let prev: CodegenPreviewDiffBundleSelection | null;
  if (previousBackend === null || previousBackend === undefined) {
    prev = null;
  } else if (isBackend(previousBackend)) {
    prev = previousBackend;
  } else {
    return null;
  }
  const selectionMatch = obj.selectionMatch;
  if (typeof selectionMatch !== 'boolean') return null;
  return {
    backend,
    previousBackend: prev,
    selectionMatch,
  };
}

function isBackend(
  value: unknown,
): value is CodegenPreviewDiffBundleSelection {
  return (
    typeof value === 'string' &&
    VALID_BACKENDS.indexOf(value as CodegenPreviewDiffBundleSelection) !== -1
  );
}

// ---------------------------------------------------------------------------
// Internal — state
// ---------------------------------------------------------------------------

function parseTopLevelState(
  value: unknown,
): CodegenPreviewDiffBundleState | null {
  if (value === 'unchanged' || value === 'changed') return value;
  return null;
}

function parseTargetState(
  value: unknown,
): CodegenPreviewDiffBundleTargetState | null {
  if (value === 'unchanged' || value === 'changed') return value;
  return null;
}

const VALID_TARGET_STATUSES: ReadonlyArray<CodegenPreviewTargetDiffStatus> = [
  'added',
  'removed',
  'status_changed',
  'artifacts_changed',
  'diagnostics_changed',
  'unchanged',
];

function parseTargetStatus(
  value: unknown,
): CodegenPreviewTargetDiffStatus | null {
  if (
    typeof value === 'string' &&
    VALID_TARGET_STATUSES.indexOf(value as CodegenPreviewTargetDiffStatus) !== -1
  ) {
    return value as CodegenPreviewTargetDiffStatus;
  }
  return null;
}

const VALID_ARTIFACT_STATUSES: ReadonlyArray<CodegenPreviewArtifactDiffStatus> = [
  'added',
  'removed',
  'changed',
  'unchanged',
];

function parseArtifactStatus(
  value: unknown,
): CodegenPreviewArtifactDiffStatus | null {
  if (
    typeof value === 'string' &&
    VALID_ARTIFACT_STATUSES.indexOf(value as CodegenPreviewArtifactDiffStatus) !==
      -1
  ) {
    return value as CodegenPreviewArtifactDiffStatus;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal — counts
// ---------------------------------------------------------------------------

function parseCounts(
  value: unknown,
): CodegenPreviewDiffBundleCounts | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const required = [
    'targetsCompared',
    'targetsChanged',
    'artifactsAdded',
    'artifactsRemoved',
    'artifactsChanged',
    'diagnosticsChanged',
  ] as const;
  const out: Record<(typeof required)[number], number> = {
    targetsCompared: 0,
    targetsChanged: 0,
    artifactsAdded: 0,
    artifactsRemoved: 0,
    artifactsChanged: 0,
    diagnosticsChanged: 0,
  };
  for (const k of required) {
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[k] = Math.trunc(v);
  }
  return out;
}

function parsePerTargetCounts(
  value: unknown,
): CodegenPreviewDiffBundleTarget['counts'] | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const required = [
    'artifactsAdded',
    'artifactsRemoved',
    'artifactsChanged',
    'diagnosticsAdded',
    'diagnosticsRemoved',
  ] as const;
  const out: Record<(typeof required)[number], number> = {
    artifactsAdded: 0,
    artifactsRemoved: 0,
    artifactsChanged: 0,
    diagnosticsAdded: 0,
    diagnosticsRemoved: 0,
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
): CodegenPreviewDiffBundleTarget | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const target = obj.target;
  if (
    typeof target !== 'string' ||
    VALID_TARGETS.indexOf(target as CodegenPreviewTarget) === -1
  ) {
    return null;
  }

  const state = parseTargetState(obj.state);
  if (!state) return null;

  const targetStatus = parseTargetStatus(obj.targetStatus);
  if (!targetStatus) return null;

  const counts = parsePerTargetCounts(obj.counts);
  if (!counts) return null;

  if (!Array.isArray(obj.artifactChanges)) return null;
  const artifactChanges: CodegenPreviewDiffBundleArtifactChange[] = [];
  for (const raw of obj.artifactChanges) {
    const a = parseArtifactChange(raw);
    if (!a) return null;
    artifactChanges.push(a);
  }

  if (!Array.isArray(obj.diagnosticChanges)) return null;
  const diagnosticChanges: CodegenPreviewDiffBundleDiagnosticChange[] = [];
  for (const raw of obj.diagnosticChanges) {
    const d = parseDiagnosticChange(raw);
    if (!d) return null;
    diagnosticChanges.push(d);
  }

  // previousStatus / currentStatus are optional strings and surface
  // free-form so an evolving Sprint 89 status enum doesn't break
  // older imports. We still copy them through verbatim (no
  // arbitrary content from anywhere else in the bundle).
  const out: CodegenPreviewDiffBundleTarget = {
    target: target as CodegenPreviewTarget,
    state,
    targetStatus,
    counts,
    artifactChanges,
    diagnosticChanges,
  };
  if (typeof obj.previousStatus === 'string') out.previousStatus = obj.previousStatus;
  if (typeof obj.currentStatus === 'string') out.currentStatus = obj.currentStatus;
  return out;
}

// ---------------------------------------------------------------------------
// Internal — artifact change
// ---------------------------------------------------------------------------

function parseArtifactChange(
  value: unknown,
): CodegenPreviewDiffBundleArtifactChange | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string' || path.length === 0) return null;
  const status = parseArtifactStatus(obj.status);
  if (!status) return null;

  const out: CodegenPreviewDiffBundleArtifactChange = { path, status };
  if (typeof obj.previousSizeBytes === 'number') {
    out.previousSizeBytes = clampSize(obj.previousSizeBytes);
  }
  if (typeof obj.currentSizeBytes === 'number') {
    out.currentSizeBytes = clampSize(obj.currentSizeBytes);
  }
  if (typeof obj.previousHash === 'string') out.previousHash = obj.previousHash;
  if (typeof obj.currentHash === 'string') out.currentHash = obj.currentHash;
  if (obj.diff !== undefined) {
    const diff = parseDiffSample(obj.diff);
    if (diff === null) return null;
    out.diff = diff;
  }
  // `content` and any other extra fields are deliberately NOT
  // copied. The Sprint 91 bundle never carries content; the
  // whitelist rebuild pins that invariant for any importer.
  return out;
}

function clampSize(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function parseDiffSample(
  value: unknown,
): NonNullable<CodegenPreviewDiffBundleArtifactChange['diff']> | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.truncated !== 'boolean') return null;
  if (!Array.isArray(obj.lines)) return null;
  const lines: Array<{
    status: 'added' | 'removed' | 'context';
    previousLine?: number;
    currentLine?: number;
    text: string;
  }> = [];
  for (const raw of obj.lines) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const status = r.status;
    if (status !== 'added' && status !== 'removed' && status !== 'context') {
      return null;
    }
    const text = r.text;
    if (typeof text !== 'string') return null;
    const line: {
      status: 'added' | 'removed' | 'context';
      previousLine?: number;
      currentLine?: number;
      text: string;
    } = { status, text };
    if (typeof r.previousLine === 'number' && Number.isFinite(r.previousLine)) {
      line.previousLine = Math.trunc(r.previousLine);
    }
    if (typeof r.currentLine === 'number' && Number.isFinite(r.currentLine)) {
      line.currentLine = Math.trunc(r.currentLine);
    }
    lines.push(line);
  }
  const out: NonNullable<CodegenPreviewDiffBundleArtifactChange['diff']> = {
    truncated: obj.truncated as boolean,
    lines,
  };
  if (
    typeof obj.firstDifferingLine === 'number' &&
    Number.isFinite(obj.firstDifferingLine)
  ) {
    out.firstDifferingLine = Math.trunc(obj.firstDifferingLine);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal — diagnostic change
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: ReadonlyArray<CodegenPreviewDiagnostic['severity']> = [
  'error',
  'warning',
  'info',
];

function parseDiagnosticChange(
  value: unknown,
): CodegenPreviewDiffBundleDiagnosticChange | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const status = obj.status;
  if (status !== 'added' && status !== 'removed') return null;
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
  const out: CodegenPreviewDiffBundleDiagnosticChange = {
    status,
    severity: severity as CodegenPreviewDiagnostic['severity'],
    code: obj.code,
    message: obj.message,
  };
  if (typeof obj.path === 'string') out.path = obj.path;
  if (typeof obj.hint === 'string') out.hint = obj.hint;
  return out;
}

// ---------------------------------------------------------------------------
// Internal — primitive readers
// ---------------------------------------------------------------------------

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
