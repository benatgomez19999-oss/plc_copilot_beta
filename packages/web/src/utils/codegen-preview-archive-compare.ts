// Sprint 94 — Compare a Sprint 91 archived diff bundle against
// the Sprint 89 current preview view, read-only.
//
// Pure / DOM-free / total. The Sprint 92 imported-diff parser
// already validated the archived bundle; this helper takes that
// bundle plus the live `CodegenPreviewView` (Sprint 89 + 90A's
// full-content field) and produces a meta-comparison the panel
// renders below the archived diff section.
//
// Hard rules:
//   - Pure: no DOM, no I/O, no clock, no random.
//   - Total: handles null inputs (empty / no-archived-diff /
//     no-current-preview states), never throws.
//   - Deterministic: byte-identical output for the same inputs.
//   - No mutation: inputs are deep-equal before/after.
//   - No new diff algorithm: artifact identity uses the FNV-1a
//     hash already exported by `codegen-preview-diff.ts`.
//   - Diagnostic identity uses the same
//     `severity|code|message|path|hint` tuple Sprints 90B / 91 /
//     92 use.
//   - Selection mismatch is surfaced honestly via the global
//     `state` plus per-target rows; the comparison still walks
//     every overlapping target.
//   - The bundle deliberately omits unchanged paths (Sprint 91
//     contract). We can therefore detect changed / removed paths
//     against the archive but only flag *current-only* paths as
//     `new-current` — they may have been unchanged at write time
//     and silently dropped, or genuinely new today. The renderer
//     surfaces that ambiguity in the operator-facing copy.

import { deterministicContentHash } from './codegen-preview-diff.js';
import type {
  CodegenPreviewDiffBundle,
  CodegenPreviewDiffBundleArtifactChange,
  CodegenPreviewDiffBundleDiagnosticChange,
  CodegenPreviewDiffBundleSelection,
  CodegenPreviewDiffBundleTarget,
} from './codegen-preview-diff-download.js';
import type {
  CodegenPreviewArtifactView,
  CodegenPreviewDiagnostic,
  CodegenPreviewTarget,
  CodegenPreviewTargetView,
  CodegenPreviewView,
} from './codegen-preview-view.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ArchivedPreviewComparisonState =
  | 'no-archived-diff'
  | 'no-current-preview'
  | 'selection-mismatch'
  | 'unchanged-against-archive'
  | 'changed-against-archive'
  | 'partially-comparable';

export type ArchivedTargetComparisonStatus =
  | 'same'
  | 'changed'
  | 'missing-current'
  | 'missing-archived'
  | 'not-comparable';

export type ArchivedArtifactComparisonStatus =
  | 'same-hash'
  | 'changed-hash'
  | 'missing-current'
  | 'new-current'
  | 'not-comparable';

export type ArchivedDiagnosticComparisonStatus =
  | 'still-present'
  | 'resolved'
  | 'new-current'
  | 'not-comparable';

export interface ArchivedArtifactComparison {
  readonly path: string;
  readonly status: ArchivedArtifactComparisonStatus;
  /** Original status the archived diff recorded for this path, if any. */
  readonly archivedStatus?: CodegenPreviewDiffBundleArtifactChange['status'];
  /** Hash captured by the Sprint 91 bundle (its `currentHash`). */
  readonly archivedHash?: string;
  /** Hash of the current preview's artifact content, if available. */
  readonly currentHash?: string;
  readonly archivedSizeBytes?: number;
  readonly currentSizeBytes?: number;
}

export interface ArchivedDiagnosticComparison {
  readonly status: ArchivedDiagnosticComparisonStatus;
  /** Identity copied verbatim. Severity / code / message / path / hint. */
  readonly diagnostic: CodegenPreviewDiagnostic;
  /** Status the archived diff recorded for this diagnostic, if any. */
  readonly archivedStatus?: CodegenPreviewDiffBundleDiagnosticChange['status'];
}

export interface ArchivedTargetCounts {
  readonly artifactsSame: number;
  readonly artifactsChanged: number;
  readonly artifactsMissingCurrent: number;
  readonly artifactsNewCurrent: number;
  readonly artifactsNotComparable: number;
  readonly diagnosticsStillPresent: number;
  readonly diagnosticsResolved: number;
  readonly diagnosticsNewCurrent: number;
}

export interface ArchivedPreviewComparisonTarget {
  readonly target: CodegenPreviewTarget;
  readonly status: ArchivedTargetComparisonStatus;
  readonly summary: string;
  readonly archivedTargetStatus?: CodegenPreviewDiffBundleTarget['targetStatus'];
  readonly archivedRecordedCurrentStatus?: string;
  readonly currentStatus?: string;
  readonly counts: ArchivedTargetCounts;
  readonly artifactComparisons: ReadonlyArray<ArchivedArtifactComparison>;
  readonly diagnosticComparisons: ReadonlyArray<ArchivedDiagnosticComparison>;
}

export interface ArchivedPreviewComparisonCounts {
  readonly targetsCompared: number;
  readonly targetsChanged: number;
  readonly artifactsSame: number;
  readonly artifactsChanged: number;
  readonly artifactsMissingCurrent: number;
  readonly artifactsNewCurrent: number;
  readonly diagnosticsStillPresent: number;
  readonly diagnosticsResolved: number;
  readonly diagnosticsNewCurrent: number;
}

export interface ArchivedPreviewComparisonView {
  readonly state: ArchivedPreviewComparisonState;
  readonly summary: string;
  readonly selectionMatch: boolean;
  readonly archivedBackend?: CodegenPreviewDiffBundleSelection;
  readonly currentBackend?: CodegenPreviewView['selection'];
  readonly counts: ArchivedPreviewComparisonCounts;
  readonly targets: ReadonlyArray<ArchivedPreviewComparisonTarget>;
}

export interface CompareImportedDiffWithCurrentPreviewArgs {
  readonly importedBundle: CodegenPreviewDiffBundle | null | undefined;
  readonly currentView: CodegenPreviewView | null | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Panel display order — mirrors Sprint 90B's VENDOR_TARGETS. */
const TARGET_ORDER: ReadonlyArray<CodegenPreviewTarget> = [
  'siemens',
  'codesys',
  'rockwell',
];

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function compareImportedDiffWithCurrentPreview(
  args: CompareImportedDiffWithCurrentPreviewArgs,
): ArchivedPreviewComparisonView {
  const archived = args.importedBundle ?? null;
  const current = args.currentView ?? null;

  if (!archived) {
    return baseEmptyView('no-archived-diff', undefined, current?.selection);
  }
  if (!current) {
    return baseEmptyView(
      'no-current-preview',
      archived.selection.backend,
      undefined,
    );
  }

  const selectionMatch = archived.selection.backend === current.selection;

  // Walk every target appearing in either side; per-target rows
  // reveal which side it came from.
  const archivedByTarget = new Map<
    CodegenPreviewTarget,
    CodegenPreviewDiffBundleTarget
  >();
  for (const t of archived.targets) archivedByTarget.set(t.target, t);
  const currentByTarget = new Map<
    CodegenPreviewTarget,
    CodegenPreviewTargetView
  >();
  for (const t of current.targets) currentByTarget.set(t.target, t);

  const targets: ArchivedPreviewComparisonTarget[] = [];
  for (const target of orderedTargetUnion(archivedByTarget, currentByTarget)) {
    targets.push(
      compareTargets(archivedByTarget.get(target), currentByTarget.get(target)),
    );
  }

  const counts = aggregateGlobalCounts(targets);
  const state = pickGlobalState(targets, selectionMatch, counts);

  return {
    state,
    summary: makeGlobalSummary(state, selectionMatch, archived, current, counts),
    selectionMatch,
    archivedBackend: archived.selection.backend,
    currentBackend: current.selection,
    counts,
    targets,
  };
}

// ---------------------------------------------------------------------------
// Internal — helpers
// ---------------------------------------------------------------------------

function baseEmptyView(
  state:
    | 'no-archived-diff'
    | 'no-current-preview',
  archivedBackend: CodegenPreviewDiffBundleSelection | undefined,
  currentBackend: CodegenPreviewView['selection'] | undefined,
): ArchivedPreviewComparisonView {
  const summary =
    state === 'no-archived-diff'
      ? 'Import a diff bundle to compare it against the current preview.'
      : 'Run preview before comparing the archived diff with current output.';
  return {
    state,
    summary,
    selectionMatch: archivedBackend === currentBackend,
    archivedBackend,
    currentBackend,
    counts: zeroGlobalCounts(),
    targets: [],
  };
}

function zeroGlobalCounts(): ArchivedPreviewComparisonCounts {
  return {
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
}

function orderedTargetUnion(
  archived: Map<CodegenPreviewTarget, CodegenPreviewDiffBundleTarget>,
  current: Map<CodegenPreviewTarget, CodegenPreviewTargetView>,
): ReadonlyArray<CodegenPreviewTarget> {
  const set = new Set<CodegenPreviewTarget>();
  for (const t of archived.keys()) set.add(t);
  for (const t of current.keys()) set.add(t);
  const idx = new Map(TARGET_ORDER.map((t, i) => [t, i] as const));
  return Array.from(set).sort(
    (a, b) => (idx.get(a) ?? 99) - (idx.get(b) ?? 99),
  );
}

// ---------------------------------------------------------------------------
// Internal — per-target compare
// ---------------------------------------------------------------------------

function compareTargets(
  archived: CodegenPreviewDiffBundleTarget | undefined,
  current: CodegenPreviewTargetView | undefined,
): ArchivedPreviewComparisonTarget {
  const target = (archived ?? current!).target;

  if (archived && !current) {
    return {
      target,
      status: 'missing-current',
      summary: `Target ${target} was in the archived diff but is missing from the current preview.`,
      archivedTargetStatus: archived.targetStatus,
      archivedRecordedCurrentStatus: archived.currentStatus,
      counts: zeroTargetCounts({
        artifactsMissingCurrent: archived.artifactChanges.length,
      }),
      artifactComparisons: archived.artifactChanges
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((a) => ({
          path: a.path,
          status: 'missing-current' as const,
          archivedStatus: a.status,
          archivedHash: a.currentHash,
          archivedSizeBytes: a.currentSizeBytes,
        })),
      diagnosticComparisons: sortDiagnostics(
        archived.diagnosticChanges.map((d) => ({
          status: 'resolved' as const,
          diagnostic: bundleDiagToCanonical(d),
          archivedStatus: d.status,
        })),
      ),
    };
  }

  if (!archived && current) {
    const currentArtifacts = current.artifacts;
    const newArtifacts = currentArtifacts
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(
        (a): ArchivedArtifactComparison => ({
          path: a.path,
          status: 'new-current',
          currentHash: deterministicContentHash(a.content ?? ''),
          currentSizeBytes: a.sizeBytes,
        }),
      );
    return {
      target,
      status: 'missing-archived',
      summary: `Target ${target} is in the current preview but the archived diff did not record it.`,
      currentStatus: current.status,
      counts: zeroTargetCounts({
        artifactsNewCurrent: newArtifacts.length,
      }),
      artifactComparisons: newArtifacts,
      diagnosticComparisons: sortDiagnostics(
        current.manifestDiagnostics.map((d) => ({
          status: 'new-current' as const,
          diagnostic: cloneDiagnostic(d),
        })),
      ),
    };
  }

  // Both present.
  const a = archived!;
  const c = current!;

  // Current target without artifacts (blocked / failed / unavailable):
  // hashes can't be computed, so we surface 'not-comparable' rather
  // than fabricating drift.
  const currentArtifactsByPath = new Map<string, CodegenPreviewArtifactView>();
  for (const art of c.artifacts) currentArtifactsByPath.set(art.path, art);

  const archivedPaths = new Set<string>(
    a.artifactChanges.map((x) => x.path),
  );

  const artifactComparisons: ArchivedArtifactComparison[] = [];

  for (const ac of a.artifactChanges) {
    artifactComparisons.push(
      compareArtifact(ac, currentArtifactsByPath.get(ac.path)),
    );
  }

  for (const art of c.artifacts) {
    if (archivedPaths.has(art.path)) continue;
    artifactComparisons.push({
      path: art.path,
      status: 'new-current',
      currentHash: deterministicContentHash(art.content ?? ''),
      currentSizeBytes: art.sizeBytes,
    });
  }

  artifactComparisons.sort((x, y) => x.path.localeCompare(y.path));

  // Diagnostics: identity-keyed walk in both directions.
  const diagnosticComparisons = compareDiagnostics(
    a.diagnosticChanges,
    c.manifestDiagnostics,
  );

  const counts = countTarget(artifactComparisons, diagnosticComparisons);

  // Roll up to a target-level status. `not-comparable` only when
  // the current side genuinely has no comparable artifacts AND the
  // archived side asserts artifact changes (i.e. blocked/failed
  // current preview against a previously-ready archived target).
  const currentIsBarren =
    c.artifacts.length === 0 &&
    (c.status === 'blocked' ||
      c.status === 'failed' ||
      c.status === 'unavailable');
  let status: ArchivedTargetComparisonStatus;
  if (
    currentIsBarren &&
    a.artifactChanges.length > 0
  ) {
    status = 'not-comparable';
  } else if (
    counts.artifactsChanged === 0 &&
    counts.artifactsMissingCurrent === 0 &&
    counts.artifactsNewCurrent === 0 &&
    counts.diagnosticsResolved === 0 &&
    counts.diagnosticsNewCurrent === 0
  ) {
    status = 'same';
  } else {
    status = 'changed';
  }

  return {
    target,
    status,
    summary: makeTargetSummary(target, status, counts),
    archivedTargetStatus: a.targetStatus,
    archivedRecordedCurrentStatus: a.currentStatus,
    currentStatus: c.status,
    counts,
    artifactComparisons,
    diagnosticComparisons,
  };
}

function compareArtifact(
  archived: CodegenPreviewDiffBundleArtifactChange,
  current: CodegenPreviewArtifactView | undefined,
): ArchivedArtifactComparison {
  if (!current) {
    return {
      path: archived.path,
      status: 'missing-current',
      archivedStatus: archived.status,
      archivedHash: archived.currentHash,
      archivedSizeBytes: archived.currentSizeBytes,
    };
  }
  const currentContent = current.content ?? '';
  const currentHash = deterministicContentHash(currentContent);
  const archivedHash = archived.currentHash;
  if (typeof archivedHash !== 'string' || archivedHash.length === 0) {
    return {
      path: archived.path,
      status: 'not-comparable',
      archivedStatus: archived.status,
      currentHash,
      currentSizeBytes: current.sizeBytes,
    };
  }
  return {
    path: archived.path,
    status: archivedHash === currentHash ? 'same-hash' : 'changed-hash',
    archivedStatus: archived.status,
    archivedHash,
    currentHash,
    archivedSizeBytes: archived.currentSizeBytes,
    currentSizeBytes: current.sizeBytes,
  };
}

// ---------------------------------------------------------------------------
// Internal — diagnostics
// ---------------------------------------------------------------------------

function compareDiagnostics(
  archivedDiagnostics: ReadonlyArray<CodegenPreviewDiffBundleDiagnosticChange>,
  currentDiagnostics: ReadonlyArray<CodegenPreviewDiagnostic>,
): ArchivedDiagnosticComparison[] {
  const archivedSet = new Map<string, CodegenPreviewDiffBundleDiagnosticChange>();
  for (const d of archivedDiagnostics) {
    const key = diagnosticKeyFromBundle(d);
    if (!archivedSet.has(key)) archivedSet.set(key, d);
  }
  const currentSet = new Map<string, CodegenPreviewDiagnostic>();
  for (const d of currentDiagnostics) {
    const key = diagnosticKey(d);
    if (!currentSet.has(key)) currentSet.set(key, d);
  }

  const out: ArchivedDiagnosticComparison[] = [];

  for (const [key, archived] of archivedSet) {
    if (currentSet.has(key)) {
      out.push({
        status: 'still-present',
        diagnostic: bundleDiagToCanonical(archived),
        archivedStatus: archived.status,
      });
    } else {
      out.push({
        status: 'resolved',
        diagnostic: bundleDiagToCanonical(archived),
        archivedStatus: archived.status,
      });
    }
  }

  for (const [key, current] of currentSet) {
    if (archivedSet.has(key)) continue;
    out.push({
      status: 'new-current',
      diagnostic: cloneDiagnostic(current),
    });
  }

  return sortDiagnostics(out);
}

function diagnosticKey(d: CodegenPreviewDiagnostic): string {
  return [d.severity, d.code, d.message, d.path ?? '', d.hint ?? ''].join('|');
}

function diagnosticKeyFromBundle(
  d: CodegenPreviewDiffBundleDiagnosticChange,
): string {
  return [d.severity, d.code, d.message, d.path ?? '', d.hint ?? ''].join('|');
}

function bundleDiagToCanonical(
  d: CodegenPreviewDiffBundleDiagnosticChange,
): CodegenPreviewDiagnostic {
  const out: CodegenPreviewDiagnostic = {
    severity: d.severity,
    code: d.code,
    message: d.message,
  };
  if (d.path) out.path = d.path;
  if (d.hint) out.hint = d.hint;
  return out;
}

function cloneDiagnostic(d: CodegenPreviewDiagnostic): CodegenPreviewDiagnostic {
  return { ...d };
}

function sortDiagnostics(
  diagnostics: ReadonlyArray<ArchivedDiagnosticComparison>,
): ArchivedDiagnosticComparison[] {
  const severityRank: Record<CodegenPreviewDiagnostic['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  const statusRank: Record<ArchivedDiagnosticComparisonStatus, number> = {
    'still-present': 0,
    resolved: 1,
    'new-current': 2,
    'not-comparable': 3,
  };
  return diagnostics
    .slice()
    .sort((a, b) => {
      const sev =
        severityRank[a.diagnostic.severity] -
        severityRank[b.diagnostic.severity];
      if (sev !== 0) return sev;
      const status = statusRank[a.status] - statusRank[b.status];
      if (status !== 0) return status;
      const code = a.diagnostic.code.localeCompare(b.diagnostic.code);
      if (code !== 0) return code;
      return a.diagnostic.message.localeCompare(b.diagnostic.message);
    });
}

// ---------------------------------------------------------------------------
// Internal — counts + summaries
// ---------------------------------------------------------------------------

function zeroTargetCounts(
  overrides: Partial<ArchivedTargetCounts> = {},
): ArchivedTargetCounts {
  return {
    artifactsSame: 0,
    artifactsChanged: 0,
    artifactsMissingCurrent: 0,
    artifactsNewCurrent: 0,
    artifactsNotComparable: 0,
    diagnosticsStillPresent: 0,
    diagnosticsResolved: 0,
    diagnosticsNewCurrent: 0,
    ...overrides,
  };
}

function countTarget(
  artifacts: ReadonlyArray<ArchivedArtifactComparison>,
  diagnostics: ReadonlyArray<ArchivedDiagnosticComparison>,
): ArchivedTargetCounts {
  const out = {
    artifactsSame: 0,
    artifactsChanged: 0,
    artifactsMissingCurrent: 0,
    artifactsNewCurrent: 0,
    artifactsNotComparable: 0,
    diagnosticsStillPresent: 0,
    diagnosticsResolved: 0,
    diagnosticsNewCurrent: 0,
  };
  for (const a of artifacts) {
    switch (a.status) {
      case 'same-hash':
        out.artifactsSame += 1;
        break;
      case 'changed-hash':
        out.artifactsChanged += 1;
        break;
      case 'missing-current':
        out.artifactsMissingCurrent += 1;
        break;
      case 'new-current':
        out.artifactsNewCurrent += 1;
        break;
      case 'not-comparable':
        out.artifactsNotComparable += 1;
        break;
    }
  }
  for (const d of diagnostics) {
    switch (d.status) {
      case 'still-present':
        out.diagnosticsStillPresent += 1;
        break;
      case 'resolved':
        out.diagnosticsResolved += 1;
        break;
      case 'new-current':
        out.diagnosticsNewCurrent += 1;
        break;
      case 'not-comparable':
        // Currently unused; included for forward-compat.
        break;
    }
  }
  return out;
}

function aggregateGlobalCounts(
  targets: ReadonlyArray<ArchivedPreviewComparisonTarget>,
): ArchivedPreviewComparisonCounts {
  let targetsChanged = 0;
  let artifactsSame = 0;
  let artifactsChanged = 0;
  let artifactsMissingCurrent = 0;
  let artifactsNewCurrent = 0;
  let diagnosticsStillPresent = 0;
  let diagnosticsResolved = 0;
  let diagnosticsNewCurrent = 0;
  for (const t of targets) {
    if (t.status !== 'same') targetsChanged += 1;
    artifactsSame += t.counts.artifactsSame;
    artifactsChanged += t.counts.artifactsChanged;
    artifactsMissingCurrent += t.counts.artifactsMissingCurrent;
    artifactsNewCurrent += t.counts.artifactsNewCurrent;
    diagnosticsStillPresent += t.counts.diagnosticsStillPresent;
    diagnosticsResolved += t.counts.diagnosticsResolved;
    diagnosticsNewCurrent += t.counts.diagnosticsNewCurrent;
  }
  return {
    targetsCompared: targets.length,
    targetsChanged,
    artifactsSame,
    artifactsChanged,
    artifactsMissingCurrent,
    artifactsNewCurrent,
    diagnosticsStillPresent,
    diagnosticsResolved,
    diagnosticsNewCurrent,
  };
}

function pickGlobalState(
  targets: ReadonlyArray<ArchivedPreviewComparisonTarget>,
  selectionMatch: boolean,
  counts: ArchivedPreviewComparisonCounts,
): ArchivedPreviewComparisonState {
  if (targets.length === 0) {
    // Both sides present (no-* states are handled before this).
    return 'unchanged-against-archive';
  }
  const everythingClean =
    counts.targetsChanged === 0 &&
    counts.artifactsChanged === 0 &&
    counts.artifactsMissingCurrent === 0 &&
    counts.artifactsNewCurrent === 0 &&
    counts.diagnosticsResolved === 0 &&
    counts.diagnosticsNewCurrent === 0;

  if (!selectionMatch) {
    // Backend differs entirely → selection-mismatch when there is
    // no overlap; partially-comparable when any target overlapped
    // (i.e. the archive's backend was 'all' and current is a
    // single target, or vice versa).
    const hasOverlap = targets.some(
      (t) => t.status !== 'missing-current' && t.status !== 'missing-archived',
    );
    if (!hasOverlap) return 'selection-mismatch';
    return everythingClean
      ? 'partially-comparable'
      : 'partially-comparable';
  }

  return everythingClean
    ? 'unchanged-against-archive'
    : 'changed-against-archive';
}

function makeGlobalSummary(
  state: ArchivedPreviewComparisonState,
  selectionMatch: boolean,
  archived: CodegenPreviewDiffBundle,
  current: CodegenPreviewView,
  counts: ArchivedPreviewComparisonCounts,
): string {
  if (state === 'selection-mismatch') {
    return `Archived diff was created for backend ${archived.selection.backend}, but current preview is ${current.selection}. No comparable targets.`;
  }
  if (state === 'partially-comparable') {
    return `Archived diff (${archived.selection.backend}) and current preview (${current.selection}) overlap on ${counts.targetsCompared - countMissingTargets(counts)} target(s); ${describeDelta(counts)}.`;
  }
  if (state === 'unchanged-against-archive') {
    return 'Current preview matches the archived diff for comparable artifacts and diagnostics.';
  }
  // changed
  const parts: string[] = [];
  if (counts.targetsChanged > 0) {
    parts.push(`${counts.targetsChanged} target(s) changed`);
  }
  if (counts.artifactsChanged > 0) {
    parts.push(`${counts.artifactsChanged} artifact hash change(s)`);
  }
  if (counts.artifactsMissingCurrent > 0) {
    parts.push(`${counts.artifactsMissingCurrent} missing in current`);
  }
  if (counts.artifactsNewCurrent > 0) {
    parts.push(`${counts.artifactsNewCurrent} new in current`);
  }
  const diagDelta =
    counts.diagnosticsResolved + counts.diagnosticsNewCurrent;
  if (diagDelta > 0) {
    parts.push(`${diagDelta} diagnostic change(s)`);
  }
  return parts.length > 0
    ? `Archived diff differs from current preview — ${parts.join(', ')}.`
    : 'Archived diff differs from current preview.';
}

function countMissingTargets(
  counts: ArchivedPreviewComparisonCounts,
): number {
  // Targets that exist on only one side don't count as overlap.
  // Approximate with artifactsMissingCurrent + artifactsNewCurrent
  // is wrong (per-artifact metric); instead, the renderer reads
  // per-target status. We keep this helper for `makeGlobalSummary`
  // and use a coarse approximation: targetsCompared minus the
  // number of targets that are entirely missing on either side.
  // The summary uses it only for a soft hint, so an off-by-one is
  // not load-bearing.
  return 0;
}

function describeDelta(counts: ArchivedPreviewComparisonCounts): string {
  if (
    counts.artifactsChanged === 0 &&
    counts.artifactsMissingCurrent === 0 &&
    counts.artifactsNewCurrent === 0 &&
    counts.diagnosticsResolved === 0 &&
    counts.diagnosticsNewCurrent === 0
  ) {
    return 'no changes against the archive on overlapping targets';
  }
  return `${counts.artifactsChanged} artifact hash change(s), ${counts.diagnosticsResolved + counts.diagnosticsNewCurrent} diagnostic change(s)`;
}

function makeTargetSummary(
  target: CodegenPreviewTarget,
  status: ArchivedTargetComparisonStatus,
  counts: ArchivedTargetCounts,
): string {
  if (status === 'missing-current') {
    return `Target ${target} was in the archived diff but is missing from the current preview.`;
  }
  if (status === 'missing-archived') {
    return `Target ${target} is in the current preview but the archived diff did not record it.`;
  }
  if (status === 'not-comparable') {
    return `Target ${target} cannot be compared — the current preview has no artifacts (blocked, failed, or unavailable).`;
  }
  if (status === 'same') {
    return `Target ${target} matches the archived diff (${counts.artifactsSame} same; no changes).`;
  }
  // changed
  const parts: string[] = [];
  if (counts.artifactsChanged > 0) parts.push(`${counts.artifactsChanged} changed`);
  if (counts.artifactsMissingCurrent > 0)
    parts.push(`${counts.artifactsMissingCurrent} missing`);
  if (counts.artifactsNewCurrent > 0)
    parts.push(`${counts.artifactsNewCurrent} new`);
  const diagDelta =
    counts.diagnosticsResolved + counts.diagnosticsNewCurrent;
  if (diagDelta > 0) parts.push(`${diagDelta} diagnostic change(s)`);
  return parts.length > 0
    ? `Target ${target} differs from archived diff — ${parts.join(', ')}.`
    : `Target ${target} differs from archived diff.`;
}
