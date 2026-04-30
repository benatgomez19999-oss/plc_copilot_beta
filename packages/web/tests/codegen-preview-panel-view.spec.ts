// Sprint 93 — pure tests for the codegen panel polish helper.
// Pins the renderer-shared copy and status-class mapping so the
// readiness / preview / live diff / archived diff panels stay
// uniform across future renderer drift.

import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_DIFF_STATUS_LABEL,
  IMPORTED_DIFF_READ_ONLY_NOTICE,
  PREVIEW_STATUS_LABEL,
  READINESS_STATUS_LABEL,
  STALE_DIFF_NOTICE,
  STALE_PREVIEW_NOTICE,
  TARGET_DIFF_STATUS_LABEL,
  artifactDiffStatusPolishToken,
  diagnosticChangeStatusPolishToken,
  formatArchivedTargetOneLiner,
  formatArtifactChangesSummary,
  formatArtifactCountSummary,
  formatDiagnosticChangesSummary,
  formatDiagnosticChangesSummaryFromArtifactDiff,
  formatDiffSampleSummary,
  formatManifestDiagnosticSummary,
  formatPreviewSnippetSummary,
  formatReadinessGroupSummary,
  formatTargetDiffOneLiner,
  previewStatusPolishToken,
  readinessStatusPolishToken,
  setAllExpanded,
  severityPolishToken,
  statusBadgeClass,
  targetDiffStatusPolishToken,
} from '../src/utils/codegen-preview-panel-view.js';

// =============================================================================
// 1. Constants & labels
// =============================================================================

describe('Sprint 93 — copy constants', () => {
  it('1. imported-diff read-only notice is stable', () => {
    expect(IMPORTED_DIFF_READ_ONLY_NOTICE).toBe(
      'Imported diff is read-only. It does not affect the current preview, Generate, or saved session.',
    );
  });

  it('2. stale preview / diff notices are stable', () => {
    expect(STALE_PREVIEW_NOTICE).toBe(
      'Preview is stale — project or backend changed. Refresh to re-run.',
    );
    expect(STALE_DIFF_NOTICE).toBe(
      'Diff is paused while the preview is stale. Refresh the preview to re-compare against the previous successful run and download an up-to-date diff bundle.',
    );
  });

  it('3. status labels cover every renderer enum', () => {
    expect(PREVIEW_STATUS_LABEL.ready).toBe('Ready');
    expect(PREVIEW_STATUS_LABEL.ready_with_warnings).toBe('Warnings');
    expect(PREVIEW_STATUS_LABEL.failed).toBe('Failed');
    expect(READINESS_STATUS_LABEL.ready).toBe('Ready');
    expect(READINESS_STATUS_LABEL.warning).toBe('Warnings');
    expect(TARGET_DIFF_STATUS_LABEL.artifacts_changed).toBe(
      'Artifacts changed',
    );
    expect(TARGET_DIFF_STATUS_LABEL.unchanged).toBe('Unchanged');
    expect(ARTIFACT_DIFF_STATUS_LABEL.added).toBe('Added');
  });
});

// =============================================================================
// 2. Status → polish-token mapping (cross-panel palette)
// =============================================================================

describe('status → polish-token', () => {
  it('4. preview status maps to canonical tokens', () => {
    expect(previewStatusPolishToken('ready')).toBe('ready');
    expect(previewStatusPolishToken('ready_with_warnings')).toBe('warning');
    expect(previewStatusPolishToken('blocked')).toBe('blocked');
    expect(previewStatusPolishToken('failed')).toBe('failed');
    expect(previewStatusPolishToken('unavailable')).toBe('unavailable');
    expect(previewStatusPolishToken('running')).toBe('running');
  });

  it('5. readiness status maps to canonical tokens', () => {
    expect(readinessStatusPolishToken('ready')).toBe('ready');
    expect(readinessStatusPolishToken('warning')).toBe('warning');
    expect(readinessStatusPolishToken('blocked')).toBe('blocked');
    expect(readinessStatusPolishToken('unavailable')).toBe('unavailable');
  });

  it('6. target diff status maps cleanly', () => {
    expect(targetDiffStatusPolishToken('added')).toBe('added');
    expect(targetDiffStatusPolishToken('removed')).toBe('removed');
    expect(targetDiffStatusPolishToken('artifacts_changed')).toBe('changed');
    expect(targetDiffStatusPolishToken('diagnostics_changed')).toBe('info');
    expect(targetDiffStatusPolishToken('status_changed')).toBe('warning');
    expect(targetDiffStatusPolishToken('unchanged')).toBe('unchanged');
  });

  it('7. artifact diff status maps cleanly', () => {
    expect(artifactDiffStatusPolishToken('added')).toBe('added');
    expect(artifactDiffStatusPolishToken('removed')).toBe('removed');
    expect(artifactDiffStatusPolishToken('changed')).toBe('changed');
    expect(artifactDiffStatusPolishToken('unchanged')).toBe('unchanged');
  });

  it('8. diagnostic-change + severity maps cleanly', () => {
    expect(diagnosticChangeStatusPolishToken('added')).toBe('added');
    expect(diagnosticChangeStatusPolishToken('removed')).toBe('removed');
    expect(severityPolishToken('error')).toBe('failed');
    expect(severityPolishToken('warning')).toBe('warning');
    expect(severityPolishToken('info')).toBe('info');
  });

  it('9. unknown statuses fall back to safe defaults (no throw)', () => {
    expect(previewStatusPolishToken('mystery')).toBe('unavailable');
    expect(readinessStatusPolishToken('mystery')).toBe('unavailable');
    expect(targetDiffStatusPolishToken('mystery')).toBe('unchanged');
    expect(artifactDiffStatusPolishToken('mystery')).toBe('unchanged');
    expect(severityPolishToken('mystery')).toBe('info');
  });

  it('10. statusBadgeClass returns the unified class set', () => {
    expect(statusBadgeClass('ready')).toBe(
      'badge status-badge status-badge--ready',
    );
    expect(statusBadgeClass('removed')).toBe(
      'badge status-badge status-badge--removed',
    );
  });
});

// =============================================================================
// 3. <details> summary formatters
// =============================================================================

describe('artifact / diagnostic / readiness summaries', () => {
  it('11. formatArtifactCountSummary covers 0 / 1 / N', () => {
    expect(formatArtifactCountSummary(0)).toBe('Artifacts · none');
    expect(formatArtifactCountSummary(1)).toBe('Artifacts · 1 file');
    expect(formatArtifactCountSummary(4)).toBe('Artifacts · 4 files');
    // Defensive: NaN / negative falls back to "none"
    expect(formatArtifactCountSummary(Number.NaN)).toBe('Artifacts · none');
    expect(formatArtifactCountSummary(-3)).toBe('Artifacts · none');
  });

  it('12. formatPreviewSnippetSummary surfaces truncated count', () => {
    const arts = [
      { truncated: false } as never,
      { truncated: true } as never,
      { truncated: true } as never,
    ];
    expect(formatPreviewSnippetSummary(arts)).toBe(
      'Artifacts · 3 files (2 truncated)',
    );
    expect(formatPreviewSnippetSummary([])).toBe('Artifacts · none');
  });

  it('13. formatManifestDiagnosticSummary groups by severity', () => {
    expect(
      formatManifestDiagnosticSummary([
        { severity: 'warning', code: 'A', message: 'a' } as never,
        { severity: 'error', code: 'B', message: 'b' } as never,
        { severity: 'warning', code: 'C', message: 'c' } as never,
      ]),
    ).toBe('Manifest diagnostics · 1 error · 2 warnings');
    expect(formatManifestDiagnosticSummary([])).toBe(
      'Manifest diagnostics · none',
    );
  });

  it('14. formatReadinessGroupSummary aggregates groups', () => {
    expect(
      formatReadinessGroupSummary([
        { severity: 'warning', items: [{}, {}] } as never,
        { severity: 'info', items: [{}] } as never,
      ]),
    ).toBe('Readiness diagnostics · 1 warning · 1 info');
    expect(formatReadinessGroupSummary([])).toBe(
      'Readiness diagnostics · none',
    );
  });

  it('15. formatArtifactChangesSummary skips zero buckets', () => {
    expect(
      formatArtifactChangesSummary({
        artifactsAdded: 1,
        artifactsRemoved: 0,
        artifactsChanged: 2,
      }),
    ).toBe('Artifact changes · 1 added · 2 changed');
    expect(
      formatArtifactChangesSummary({
        artifactsAdded: 0,
        artifactsRemoved: 0,
        artifactsChanged: 0,
      }),
    ).toBe('Artifact changes · none');
  });

  it('16. formatDiagnosticChangesSummary singular/plural', () => {
    expect(formatDiagnosticChangesSummary(0)).toBe('Diagnostic changes · none');
    expect(formatDiagnosticChangesSummary(1)).toBe(
      'Diagnostic changes · 1 change',
    );
    expect(formatDiagnosticChangesSummary(3)).toBe(
      'Diagnostic changes · 3 changes',
    );
  });

  it('17. formatDiffSampleSummary marks truncated', () => {
    expect(
      formatDiffSampleSummary({ path: 'siemens/FB.scl', truncated: false }),
    ).toBe('Diff sample · siemens/FB.scl');
    expect(
      formatDiffSampleSummary({ path: 'siemens/FB.scl', truncated: true }),
    ).toBe('Diff sample · siemens/FB.scl (truncated)');
  });
});

// =============================================================================
// 4. Target one-liner (live + archived)
// =============================================================================

describe('target one-liner', () => {
  it('18. formatTargetDiffOneLiner mirrors live diff wording', () => {
    expect(
      formatTargetDiffOneLiner({
        artifactsAdded: 1,
        artifactsRemoved: 1,
        artifactsChanged: 0,
        diagnosticsAdded: 1,
        diagnosticsRemoved: 0,
      }),
    ).toBe('1 added, 1 removed, 0 changed; 1 diagnostic change.');
  });

  it('19. one-liner collapses zero-count branches', () => {
    expect(
      formatTargetDiffOneLiner({
        artifactsAdded: 0,
        artifactsRemoved: 0,
        artifactsChanged: 0,
        diagnosticsAdded: 0,
        diagnosticsRemoved: 0,
      }),
    ).toBe('no artifact changes; no diagnostic changes.');
  });

  it('20. archived-target one-liner reuses the same wording', () => {
    expect(
      formatArchivedTargetOneLiner({
        target: 'codesys',
        state: 'changed',
        targetStatus: 'artifacts_changed',
        counts: {
          artifactsAdded: 2,
          artifactsRemoved: 0,
          artifactsChanged: 1,
          diagnosticsAdded: 0,
          diagnosticsRemoved: 0,
        },
        artifactChanges: [],
        diagnosticChanges: [],
      } as never),
    ).toBe('2 added, 0 removed, 1 changed; no diagnostic changes.');
  });

  it('21. formatDiagnosticChangesSummaryFromArtifactDiff reuses the formatter', () => {
    expect(
      formatDiagnosticChangesSummaryFromArtifactDiff([
        { status: 'added', diagnostic: { code: 'X' } } as never,
        { status: 'removed', diagnostic: { code: 'Y' } } as never,
      ]),
    ).toBe('Diagnostic changes · 2 changes');
  });
});

// =============================================================================
// 5. Expand / collapse helper
// =============================================================================

describe('setAllExpanded', () => {
  it('22. returns a fresh map keyed by the supplied keys', () => {
    expect(setAllExpanded(['a', 'b', 'c'], true)).toEqual({
      a: true,
      b: true,
      c: true,
    });
    expect(setAllExpanded(['a', 'b'], false)).toEqual({ a: false, b: false });
  });

  it('23. empty keys → empty record', () => {
    expect(setAllExpanded([], true)).toEqual({});
  });

  it('24. does not mutate the input array', () => {
    const keys = ['a', 'b'];
    const before = [...keys];
    setAllExpanded(keys, true);
    expect(keys).toEqual(before);
  });
});
