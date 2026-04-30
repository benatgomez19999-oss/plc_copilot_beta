// Sprint 90B — Codegen preview diff projection.
//
// Pure / DOM-free / total. Sprint 90A taught the panel to download
// the *current* preview as a deterministic JSON bundle. Sprint 90B
// adds a second projection of the same already-computed preview
// state: the diff between the previous successful preview the
// operator has seen in this React session and the current one.
//
// Hard rules pinned by these helpers:
//   - Pure: no DOM, no I/O, no clock, no random.
//   - Diff is built from already-projected `CodegenPreviewView`s
//     (Sprint 89). The vendor pipeline is NEVER re-run here.
//   - Helpers do NOT mutate inputs (deep-equal before/after).
//   - Both arguments may be null/undefined; the helper handles
//     "no baseline yet", "current is null/missing", "both are
//     null" without crashing.
//   - Targets sort by the panel's display order
//     (siemens → codesys → rockwell), then artifact paths sort
//     alphabetically inside each target.
//   - Manifest diagnostics dedupe on a stable identity key
//     (severity + code + message + path + hint).
//   - Artifact content compares against the FULL Sprint 90A
//     `content` field — never against the truncated `previewText`.
//   - Textual diff samples are line-based, capped at
//     `MAX_DIFF_LINES_PER_ARTIFACT` lines AND
//     `MAX_DIFF_BYTES_PER_ARTIFACT` bytes; truncation flagged.
//   - Bundle / diff never carry raw source bytes (CSV / EPLAN /
//     TcECAD / PDF) — the helper only sees vendor pipeline output.
//   - Selection mismatch (e.g. previous=siemens, current=all) is
//     surfaced honestly via `selectionMatch: false` rather than
//     silently masking an apples-to-oranges comparison.

import type {
  CodegenPreviewArtifactView,
  CodegenPreviewDiagnostic,
  CodegenPreviewStatus,
  CodegenPreviewTarget,
  CodegenPreviewTargetView,
  CodegenPreviewView,
} from './codegen-preview-view.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CodegenPreviewArtifactDiffStatus =
  | 'added'
  | 'removed'
  | 'changed'
  | 'unchanged';

export type CodegenPreviewTargetDiffStatus =
  | 'added'
  | 'removed'
  | 'status_changed'
  | 'artifacts_changed'
  | 'diagnostics_changed'
  | 'unchanged';

export type CodegenPreviewDiagnosticDiffStatus = 'added' | 'removed';

/**
 * One sample line of the line-based artifact text diff. Status is
 * `removed` when the line existed only in the previous artifact,
 * `added` when only in the current one, and `context` for the
 * surrounding lines we keep around the first divergence.
 */
export interface CodegenPreviewArtifactDiffLine {
  status: 'added' | 'removed' | 'context';
  /** 1-based line number in the previous artifact (if applicable). */
  previousLine?: number;
  /** 1-based line number in the current artifact (if applicable). */
  currentLine?: number;
  text: string;
}

export interface CodegenPreviewArtifactDiff {
  path: string;
  status: CodegenPreviewArtifactDiffStatus;
  previousSizeBytes?: number;
  currentSizeBytes?: number;
  /**
   * Stable hash of the previous content (FNV-1a 32-bit). Useful for
   * tests + future de-dup. Undefined for `added`.
   */
  previousHash?: string;
  /** Same hash, current side. Undefined for `removed`. */
  currentHash?: string;
  /**
   * Compact line-based diff sample. Empty for `unchanged`,
   * `added`, `removed` (the existence of the artifact is the
   * signal). Populated for `changed`. `truncated` is `true` when
   * we hit the per-artifact line / byte cap.
   */
  diff?: {
    truncated: boolean;
    /** Index (1-based) of the first differing line in the previous artifact. */
    firstDifferingLine?: number;
    lines: ReadonlyArray<CodegenPreviewArtifactDiffLine>;
  };
}

export interface CodegenPreviewDiagnosticDiff {
  status: CodegenPreviewDiagnosticDiffStatus;
  diagnostic: CodegenPreviewDiagnostic;
}

export interface CodegenPreviewTargetDiff {
  target: CodegenPreviewTarget;
  status: CodegenPreviewTargetDiffStatus;
  /** Sprint 89 status on the previous side (if present). */
  previousStatus?: CodegenPreviewStatus;
  /** Sprint 89 status on the current side (if present). */
  currentStatus?: CodegenPreviewStatus;
  artifacts: ReadonlyArray<CodegenPreviewArtifactDiff>;
  diagnostics: ReadonlyArray<CodegenPreviewDiagnosticDiff>;
  /**
   * Per-target counts. Useful for the panel to render a quick
   * badge without re-walking `artifacts[]`.
   */
  counts: {
    artifactsAdded: number;
    artifactsRemoved: number;
    artifactsChanged: number;
    artifactsUnchanged: number;
    diagnosticsAdded: number;
    diagnosticsRemoved: number;
  };
}

export interface CodegenPreviewDiffSummary {
  targetsTotal: number;
  targetsChanged: number;
  artifactsAdded: number;
  artifactsRemoved: number;
  artifactsChanged: number;
  artifactsUnchanged: number;
  diagnosticsAdded: number;
  diagnosticsRemoved: number;
}

export interface CodegenPreviewDiffView {
  /**
   * `'no-baseline'`  — current exists but baseline is null.
   * `'no-current'`   — baseline exists but current is null.
   * `'no-inputs'`    — both inputs null/undefined.
   * `'unchanged'`    — both sides equal across compared dimensions.
   * `'changed'`      — at least one target differs.
   */
  state: 'no-baseline' | 'no-current' | 'no-inputs' | 'unchanged' | 'changed';
  /**
   * `false` when the operator's selected backend differs between
   * the two views (e.g. `'siemens'` vs `'all'`). Comparison still
   * runs target-by-target, but the panel should warn the operator
   * the comparison spans different selections.
   */
  selectionMatch: boolean;
  previousSelection?: CodegenPreviewView['selection'];
  currentSelection?: CodegenPreviewView['selection'];
  targets: ReadonlyArray<CodegenPreviewTargetDiff>;
  summary: CodegenPreviewDiffSummary;
  /** Operator-friendly one-liner the panel can render verbatim. */
  headline: string;
}

export interface BuildCodegenPreviewDiffOptions {
  /**
   * Override the per-artifact textual-diff caps. Tests use this to
   * pin the truncation paths without ginormous fixtures.
   */
  maxDiffLinesPerArtifact?: number;
  maxDiffBytesPerArtifact?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on diff sample lines per artifact. */
export const MAX_DIFF_LINES_PER_ARTIFACT = 80;

/** Hard cap on diff sample bytes per artifact (8 KB). */
export const MAX_DIFF_BYTES_PER_ARTIFACT = 8 * 1024;

/** How many context lines to keep before the first divergence. */
const DEFAULT_DIFF_CONTEXT_BEFORE = 2;

/** Panel display order — must mirror Sprint 89's VENDOR_TARGETS. */
const TARGET_ORDER: ReadonlyArray<CodegenPreviewTarget> = [
  'siemens',
  'codesys',
  'rockwell',
];

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function buildCodegenPreviewDiff(
  previous: CodegenPreviewView | null | undefined,
  current: CodegenPreviewView | null | undefined,
  options: BuildCodegenPreviewDiffOptions = {},
): CodegenPreviewDiffView {
  if (!previous && !current) {
    return emptyDiffView('no-inputs', undefined, undefined);
  }
  if (!previous) {
    return emptyDiffView('no-baseline', undefined, current?.selection);
  }
  if (!current) {
    return emptyDiffView('no-current', previous.selection, undefined);
  }

  const targetSet = new Set<CodegenPreviewTarget>();
  for (const t of previous.targets) targetSet.add(t.target);
  for (const t of current.targets) targetSet.add(t.target);
  const orderedTargets = sortTargets(Array.from(targetSet));

  const previousByTarget = indexTargets(previous.targets);
  const currentByTarget = indexTargets(current.targets);

  const targets: CodegenPreviewTargetDiff[] = orderedTargets.map((t) =>
    diffTargets(previousByTarget.get(t), currentByTarget.get(t), options),
  );

  const summary = summarizeTargets(targets);
  const state: CodegenPreviewDiffView['state'] =
    summary.targetsChanged === 0 &&
    summary.artifactsAdded === 0 &&
    summary.artifactsRemoved === 0 &&
    summary.artifactsChanged === 0 &&
    summary.diagnosticsAdded === 0 &&
    summary.diagnosticsRemoved === 0
      ? 'unchanged'
      : 'changed';

  const selectionMatch = previous.selection === current.selection;
  return {
    state,
    selectionMatch,
    previousSelection: previous.selection,
    currentSelection: current.selection,
    targets,
    summary,
    headline: makeHeadline(state, selectionMatch, summary),
  };
}

/**
 * Re-summarise a previously-built diff. Useful for the panel when
 * it wants to derive a fresh count without rebuilding the whole
 * view (the helper is cheap, but the panel layer prefers a
 * deterministic short-circuit).
 */
export function summarizeCodegenPreviewDiff(
  diff: CodegenPreviewDiffView,
): CodegenPreviewDiffSummary {
  return summarizeTargets(diff.targets);
}

/**
 * FNV-1a 32-bit hex hash of the artifact content. Deterministic,
 * dependency-free, plenty for "did this change" identity (NOT a
 * cryptographic primitive). Exported for the spec to assert
 * stability.
 */
export function deterministicContentHash(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Internal — view assembly
// ---------------------------------------------------------------------------

function emptyDiffView(
  state: 'no-baseline' | 'no-current' | 'no-inputs',
  previousSelection: CodegenPreviewView['selection'] | undefined,
  currentSelection: CodegenPreviewView['selection'] | undefined,
): CodegenPreviewDiffView {
  return {
    state,
    selectionMatch: previousSelection === currentSelection,
    previousSelection,
    currentSelection,
    targets: [],
    summary: zeroSummary(),
    headline: emptyHeadline(state),
  };
}

function emptyHeadline(state: 'no-baseline' | 'no-current' | 'no-inputs'): string {
  switch (state) {
    case 'no-baseline':
      return 'No previous preview to compare yet.';
    case 'no-current':
      return 'Current preview is unavailable.';
    case 'no-inputs':
      return 'No previews to compare.';
  }
}

function makeHeadline(
  state: 'unchanged' | 'changed',
  selectionMatch: boolean,
  s: CodegenPreviewDiffSummary,
): string {
  if (state === 'unchanged') {
    return selectionMatch
      ? 'No changes from previous preview.'
      : 'No changes within compared targets (different backend selections).';
  }
  const parts: string[] = [];
  if (s.artifactsAdded) parts.push(`${s.artifactsAdded} added`);
  if (s.artifactsRemoved) parts.push(`${s.artifactsRemoved} removed`);
  if (s.artifactsChanged) parts.push(`${s.artifactsChanged} changed`);
  const artifactPart = parts.length > 0 ? `${parts.join(', ')} artifact${
    s.artifactsAdded + s.artifactsRemoved + s.artifactsChanged === 1 ? '' : 's'
  }` : '';
  const diagPart =
    s.diagnosticsAdded || s.diagnosticsRemoved
      ? `${s.diagnosticsAdded + s.diagnosticsRemoved} diagnostic change${
          s.diagnosticsAdded + s.diagnosticsRemoved === 1 ? '' : 's'
        }`
      : '';
  const targetPart = `${s.targetsChanged} of ${s.targetsTotal} target${
    s.targetsTotal === 1 ? '' : 's'
  } changed`;
  const tail = [artifactPart, diagPart].filter((x) => x.length > 0).join('; ');
  const selectionWarn = selectionMatch
    ? ''
    : ' (different backend selections)';
  return tail ? `${targetPart} — ${tail}.${selectionWarn}` : `${targetPart}.${selectionWarn}`;
}

function zeroSummary(): CodegenPreviewDiffSummary {
  return {
    targetsTotal: 0,
    targetsChanged: 0,
    artifactsAdded: 0,
    artifactsRemoved: 0,
    artifactsChanged: 0,
    artifactsUnchanged: 0,
    diagnosticsAdded: 0,
    diagnosticsRemoved: 0,
  };
}

function summarizeTargets(
  targets: ReadonlyArray<CodegenPreviewTargetDiff>,
): CodegenPreviewDiffSummary {
  const out = zeroSummary();
  out.targetsTotal = targets.length;
  for (const t of targets) {
    if (t.status !== 'unchanged') out.targetsChanged += 1;
    out.artifactsAdded += t.counts.artifactsAdded;
    out.artifactsRemoved += t.counts.artifactsRemoved;
    out.artifactsChanged += t.counts.artifactsChanged;
    out.artifactsUnchanged += t.counts.artifactsUnchanged;
    out.diagnosticsAdded += t.counts.diagnosticsAdded;
    out.diagnosticsRemoved += t.counts.diagnosticsRemoved;
  }
  return out;
}

function indexTargets(
  targets: ReadonlyArray<CodegenPreviewTargetView>,
): Map<CodegenPreviewTarget, CodegenPreviewTargetView> {
  const out = new Map<CodegenPreviewTarget, CodegenPreviewTargetView>();
  for (const t of targets) {
    // Sprint 89 already guarantees one entry per target, but a
    // defensive `set` keeps a future drift from silently
    // double-counting an artifact.
    out.set(t.target, t);
  }
  return out;
}

function sortTargets(
  targets: ReadonlyArray<CodegenPreviewTarget>,
): CodegenPreviewTarget[] {
  const idx = new Map<CodegenPreviewTarget, number>(
    TARGET_ORDER.map((t, i) => [t, i] as const),
  );
  return targets
    .slice()
    .sort((a, b) => (idx.get(a) ?? 99) - (idx.get(b) ?? 99));
}

// ---------------------------------------------------------------------------
// Internal — per-target diff
// ---------------------------------------------------------------------------

function diffTargets(
  previous: CodegenPreviewTargetView | undefined,
  current: CodegenPreviewTargetView | undefined,
  options: BuildCodegenPreviewDiffOptions,
): CodegenPreviewTargetDiff {
  // Both undefined cannot happen (we built the union); narrow.
  const target = (current ?? previous!).target;

  if (!previous && current) {
    const artifacts = current.artifacts.map((a) => addedArtifact(a));
    const diagnostics = current.manifestDiagnostics.map((d) => ({
      status: 'added' as const,
      diagnostic: cloneDiagnostic(d),
    }));
    return {
      target,
      status: 'added',
      currentStatus: current.status,
      artifacts,
      diagnostics,
      counts: countArtifacts(artifacts, diagnostics),
    };
  }
  if (previous && !current) {
    const artifacts = previous.artifacts.map((a) => removedArtifact(a));
    const diagnostics = previous.manifestDiagnostics.map((d) => ({
      status: 'removed' as const,
      diagnostic: cloneDiagnostic(d),
    }));
    return {
      target,
      status: 'removed',
      previousStatus: previous.status,
      artifacts,
      diagnostics,
      counts: countArtifacts(artifacts, diagnostics),
    };
  }

  // Both present.
  const prev = previous!;
  const curr = current!;
  const artifacts = diffArtifacts(prev.artifacts, curr.artifacts, options);
  const diagnostics = diffDiagnostics(
    prev.manifestDiagnostics,
    curr.manifestDiagnostics,
  );
  const counts = countArtifacts(artifacts, diagnostics);

  let status: CodegenPreviewTargetDiffStatus;
  if (prev.status !== curr.status) {
    status = 'status_changed';
  } else if (
    counts.artifactsAdded ||
    counts.artifactsRemoved ||
    counts.artifactsChanged
  ) {
    status = 'artifacts_changed';
  } else if (counts.diagnosticsAdded || counts.diagnosticsRemoved) {
    status = 'diagnostics_changed';
  } else {
    status = 'unchanged';
  }

  return {
    target,
    status,
    previousStatus: prev.status,
    currentStatus: curr.status,
    artifacts,
    diagnostics,
    counts,
  };
}

function countArtifacts(
  artifacts: ReadonlyArray<CodegenPreviewArtifactDiff>,
  diagnostics: ReadonlyArray<CodegenPreviewDiagnosticDiff>,
): CodegenPreviewTargetDiff['counts'] {
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  for (const a of artifacts) {
    if (a.status === 'added') added += 1;
    else if (a.status === 'removed') removed += 1;
    else if (a.status === 'changed') changed += 1;
    else unchanged += 1;
  }
  let dAdded = 0;
  let dRemoved = 0;
  for (const d of diagnostics) {
    if (d.status === 'added') dAdded += 1;
    else dRemoved += 1;
  }
  return {
    artifactsAdded: added,
    artifactsRemoved: removed,
    artifactsChanged: changed,
    artifactsUnchanged: unchanged,
    diagnosticsAdded: dAdded,
    diagnosticsRemoved: dRemoved,
  };
}

// ---------------------------------------------------------------------------
// Internal — artifact diff
// ---------------------------------------------------------------------------

function diffArtifacts(
  previous: ReadonlyArray<CodegenPreviewArtifactView>,
  current: ReadonlyArray<CodegenPreviewArtifactView>,
  options: BuildCodegenPreviewDiffOptions,
): CodegenPreviewArtifactDiff[] {
  const prevByPath = new Map<string, CodegenPreviewArtifactView>();
  for (const a of previous) prevByPath.set(a.path, a);
  const currByPath = new Map<string, CodegenPreviewArtifactView>();
  for (const a of current) currByPath.set(a.path, a);

  const allPaths = new Set<string>();
  for (const p of prevByPath.keys()) allPaths.add(p);
  for (const p of currByPath.keys()) allPaths.add(p);

  const out: CodegenPreviewArtifactDiff[] = [];
  for (const p of Array.from(allPaths).sort((a, b) => a.localeCompare(b))) {
    const prev = prevByPath.get(p);
    const curr = currByPath.get(p);
    if (prev && !curr) {
      out.push(removedArtifact(prev));
      continue;
    }
    if (!prev && curr) {
      out.push(addedArtifact(curr));
      continue;
    }
    // Both present — compare full content.
    const prevContent = prev!.content;
    const currContent = curr!.content;
    const prevHash = deterministicContentHash(prevContent);
    const currHash = deterministicContentHash(currContent);
    if (prevContent === currContent) {
      out.push({
        path: p,
        status: 'unchanged',
        previousSizeBytes: prev!.sizeBytes,
        currentSizeBytes: curr!.sizeBytes,
        previousHash: prevHash,
        currentHash: currHash,
      });
      continue;
    }
    out.push({
      path: p,
      status: 'changed',
      previousSizeBytes: prev!.sizeBytes,
      currentSizeBytes: curr!.sizeBytes,
      previousHash: prevHash,
      currentHash: currHash,
      diff: makeLineDiff(prevContent, currContent, options),
    });
  }
  return out;
}

function addedArtifact(
  a: CodegenPreviewArtifactView,
): CodegenPreviewArtifactDiff {
  return {
    path: a.path,
    status: 'added',
    currentSizeBytes: a.sizeBytes,
    currentHash: deterministicContentHash(a.content),
  };
}

function removedArtifact(
  a: CodegenPreviewArtifactView,
): CodegenPreviewArtifactDiff {
  return {
    path: a.path,
    status: 'removed',
    previousSizeBytes: a.sizeBytes,
    previousHash: deterministicContentHash(a.content),
  };
}

// ---------------------------------------------------------------------------
// Internal — line diff
// ---------------------------------------------------------------------------

function makeLineDiff(
  previous: string,
  current: string,
  options: BuildCodegenPreviewDiffOptions,
): CodegenPreviewArtifactDiff['diff'] {
  const maxLines =
    options.maxDiffLinesPerArtifact ?? MAX_DIFF_LINES_PER_ARTIFACT;
  const maxBytes =
    options.maxDiffBytesPerArtifact ?? MAX_DIFF_BYTES_PER_ARTIFACT;

  const prevLines = previous.split('\n');
  const currLines = current.split('\n');

  // Find the first divergence — works on identical-prefix scans;
  // good enough for "what changed since last preview" without
  // pulling in a Myers algorithm.
  let firstDiff = 0;
  const maxScan = Math.min(prevLines.length, currLines.length);
  while (firstDiff < maxScan && prevLines[firstDiff] === currLines[firstDiff]) {
    firstDiff += 1;
  }

  const lines: CodegenPreviewArtifactDiffLine[] = [];
  let bytes = 0;
  let truncated = false;

  // Push helper that respects both caps.
  function push(line: CodegenPreviewArtifactDiffLine): boolean {
    const lineBytes = line.text.length + 1; // +1 for the implicit \n
    if (lines.length + 1 > maxLines || bytes + lineBytes > maxBytes) {
      truncated = true;
      return false;
    }
    lines.push(line);
    bytes += lineBytes;
    return true;
  }

  // Context window before the first divergence — keeps the diff
  // anchored for the operator without running away.
  const ctxStart = Math.max(0, firstDiff - DEFAULT_DIFF_CONTEXT_BEFORE);
  for (let i = ctxStart; i < firstDiff; i++) {
    if (
      !push({
        status: 'context',
        previousLine: i + 1,
        currentLine: i + 1,
        text: prevLines[i],
      })
    ) {
      break;
    }
  }

  // Walk forward emitting `removed` for prev, `added` for curr.
  // Stop when we exhaust either side or hit the cap.
  let pi = firstDiff;
  let ci = firstDiff;
  while (pi < prevLines.length || ci < currLines.length) {
    if (pi < prevLines.length) {
      const line = prevLines[pi];
      if (
        !(ci < currLines.length && line === currLines[ci])
      ) {
        if (
          !push({
            status: 'removed',
            previousLine: pi + 1,
            text: line,
          })
        ) {
          break;
        }
      }
      pi += 1;
    }
    if (ci < currLines.length) {
      const line = currLines[ci];
      // If we just emitted the same line as `removed`, skip the
      // `added` to avoid stuttering on aligned identical content.
      const shouldEmit = !(
        pi - 1 >= 0 &&
        pi - 1 < prevLines.length &&
        prevLines[pi - 1] === line
      );
      if (shouldEmit) {
        if (
          !push({
            status: 'added',
            currentLine: ci + 1,
            text: line,
          })
        ) {
          break;
        }
      }
      ci += 1;
    }
  }

  return {
    truncated,
    firstDifferingLine: firstDiff + 1,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Internal — diagnostic diff
// ---------------------------------------------------------------------------

function diffDiagnostics(
  previous: ReadonlyArray<CodegenPreviewDiagnostic>,
  current: ReadonlyArray<CodegenPreviewDiagnostic>,
): CodegenPreviewDiagnosticDiff[] {
  const prevSet = new Map<string, CodegenPreviewDiagnostic>();
  for (const d of previous) {
    const key = diagnosticKey(d);
    if (!prevSet.has(key)) prevSet.set(key, d);
  }
  const currSet = new Map<string, CodegenPreviewDiagnostic>();
  for (const d of current) {
    const key = diagnosticKey(d);
    if (!currSet.has(key)) currSet.set(key, d);
  }

  const out: CodegenPreviewDiagnosticDiff[] = [];
  for (const [key, d] of prevSet) {
    if (!currSet.has(key)) {
      out.push({ status: 'removed', diagnostic: cloneDiagnostic(d) });
    }
  }
  for (const [key, d] of currSet) {
    if (!prevSet.has(key)) {
      out.push({ status: 'added', diagnostic: cloneDiagnostic(d) });
    }
  }
  // Stable order: severity rank → code → status (added before removed).
  const severityRank: Record<CodegenPreviewDiagnostic['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  out.sort((a, b) => {
    const sev =
      severityRank[a.diagnostic.severity] -
      severityRank[b.diagnostic.severity];
    if (sev !== 0) return sev;
    const code = a.diagnostic.code.localeCompare(b.diagnostic.code);
    if (code !== 0) return code;
    if (a.status !== b.status) return a.status === 'added' ? -1 : 1;
    return a.diagnostic.message.localeCompare(b.diagnostic.message);
  });
  return out;
}

function diagnosticKey(d: CodegenPreviewDiagnostic): string {
  return [d.severity, d.code, d.message, d.path ?? '', d.hint ?? ''].join('|');
}

function cloneDiagnostic(
  d: CodegenPreviewDiagnostic,
): CodegenPreviewDiagnostic {
  return { ...d };
}
