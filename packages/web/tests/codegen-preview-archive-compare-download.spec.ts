// Sprint 95 — pure tests for the archive comparison download
// bundle helper. Uses a real Sprint 94 comparison view as the
// input (built from real Sprint 89 / 91 helpers) so the spec
// can never drift away from the actual shape the panel hands
// the helper at click time.
//
// What we pin:
//   - Gate: null / stale / no-archived-diff / no-current-preview
//     are NOT downloadable; unchanged-against-archive,
//     changed-against-archive, partially-comparable, and
//     selection-mismatch ARE downloadable.
//   - Bundle shape (kind + version + createdAt + selection +
//     state + summary + counts + targets[]).
//   - Whitelist rebuild: stray `content` / `previewText` /
//     `pir_version` / raw-source-looking strings on a polluted
//     comparison view never make it into the serialised bundle.
//   - Filename helper: deterministic; default name omits the
//     suffix; sanitised slug shows up otherwise.
//   - Snapshot-name sanitiser collapses runs, drops unsafe chars,
//     clamps to 64.
//   - createdAt — explicit ISO is preserved; default is
//     deterministic and parseable.
//   - Helper does NOT mutate the input comparison view; two
//     builds with the same args deep-equal.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import { CodegenError } from '@plccopilot/codegen-core';

import {
  buildCodegenPreviewView,
  type CodegenPreviewView,
} from '../src/utils/codegen-preview-view.js';
import {
  buildCodegenPreviewDiffBundle,
  type CodegenPreviewDiffBundle,
} from '../src/utils/codegen-preview-diff-download.js';
import {
  compareImportedDiffWithCurrentPreview,
  type ArchivedPreviewComparisonView,
} from '../src/utils/codegen-preview-archive-compare.js';
import {
  CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND,
  CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION,
  buildCodegenPreviewArchiveCompareBundle,
  codegenPreviewArchiveCompareFilename,
  isArchiveCompareDownloadable,
  sanitizeArchiveCompareSnapshotName,
  serializeCodegenPreviewArchiveCompareBundle,
} from '../src/utils/codegen-preview-archive-compare-download.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function happyProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'p_x',
    name: 'x',
    machines: [
      {
        id: 'm_x',
        name: 'm',
        stations: [
          {
            id: 'st_a',
            name: 'A',
            equipment: [
              {
                id: 'eq_b1',
                name: 'B1',
                type: 'sensor_discrete',
                code_symbol: 'B1',
                io_bindings: { feedback: 'io_b1' },
              },
            ],
            sequence: {
              states: [
                { id: 'init', initial: true, activities: [] },
                { id: 's2', activities: [] },
              ],
              transitions: [{ id: 't1', from: 'init', to: 's2' }],
            },
          },
        ],
        io: [
          {
            id: 'io_b1',
            name: 'B1',
            direction: 'in',
            data_type: 'bool',
            address: { memory_area: 'I', byte: 0, bit: 0 },
          },
        ],
        alarms: [],
        interlocks: [],
        parameters: [],
        recipes: [],
        safety_groups: [],
      },
    ],
  } as unknown as Project;
}

function makeArtifact(path: string, content: string): GeneratedArtifact {
  const kind: GeneratedArtifact['kind'] = path.endsWith('.scl')
    ? 'scl'
    : path.endsWith('.json')
      ? 'json'
      : 'st';
  return { path, kind, content };
}

function stub(prefix: string, files: ReadonlyArray<readonly [string, string]>) {
  return () => files.map(([p, c]) => makeArtifact(`${prefix}/${p}`, c));
}

function previewWith(
  selection: 'codesys' | 'siemens' | 'rockwell' | 'all',
  generators: Parameters<typeof buildCodegenPreviewView>[0]['generators'],
  project: Project = happyProject(),
): CodegenPreviewView {
  return buildCodegenPreviewView({ project, selection, generators });
}

function diffBundle(args: {
  prevSelection?: 'codesys' | 'siemens' | 'rockwell' | 'all';
  currSelection?: 'codesys' | 'siemens' | 'rockwell' | 'all';
  prevGen: Parameters<typeof buildCodegenPreviewView>[0]['generators'];
  currGen: Parameters<typeof buildCodegenPreviewView>[0]['generators'];
}): CodegenPreviewDiffBundle {
  const prev = previewWith(args.prevSelection ?? 'codesys', args.prevGen);
  const curr = previewWith(args.currSelection ?? 'codesys', args.currGen);
  return buildCodegenPreviewDiffBundle({
    previousView: prev,
    currentView: curr,
  });
}

const FIXED_CREATED_AT = '2026-05-01T12:00:00.000Z';

function changedComparison(): ArchivedPreviewComparisonView {
  const archived = diffBundle({
    prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
    currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
  });
  const current = previewWith('codesys', {
    codesys: stub('codesys', [['x.st', 'C']]),
  });
  return compareImportedDiffWithCurrentPreview({
    importedBundle: archived,
    currentView: current,
  });
}

function unchangedComparison(): ArchivedPreviewComparisonView {
  const archived = diffBundle({
    prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
    currGen: { codesys: stub('codesys', [['x.st', 'NEW_FINAL']]) },
  });
  const current = previewWith('codesys', {
    codesys: stub('codesys', [['x.st', 'NEW_FINAL']]),
  });
  return compareImportedDiffWithCurrentPreview({
    importedBundle: archived,
    currentView: current,
  });
}

function selectionMismatchComparison(): ArchivedPreviewComparisonView {
  const archived = diffBundle({
    prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
    currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
  });
  // Today: rockwell only — no overlap with codesys.
  const current = previewWith('rockwell', {
    rockwell: stub('rockwell', [['r.st', 'R']]),
  });
  return compareImportedDiffWithCurrentPreview({
    importedBundle: archived,
    currentView: current,
  });
}

function partiallyComparableComparison(): ArchivedPreviewComparisonView {
  const archived = diffBundle({
    prevGen: { codesys: stub('codesys', [['c.st', 'A']]) },
    currGen: { codesys: stub('codesys', [['c.st', 'B']]) },
  });
  const current = previewWith('all', {
    codesys: stub('codesys', [['c.st', 'B']]),
    siemens: stub('siemens', [['s.scl', 'S']]),
    rockwell: stub('rockwell', [['r.st', 'R']]),
  });
  return compareImportedDiffWithCurrentPreview({
    importedBundle: archived,
    currentView: current,
  });
}

// =============================================================================
// 1. isArchiveCompareDownloadable gate
// =============================================================================

describe('isArchiveCompareDownloadable', () => {
  it('1. null comparison → not downloadable', () => {
    expect(isArchiveCompareDownloadable({ comparison: null })).toBe(false);
  });

  it('2. stale flag → not downloadable', () => {
    expect(
      isArchiveCompareDownloadable({
        comparison: changedComparison(),
        stale: true,
      }),
    ).toBe(false);
  });

  it('3. no-archived-diff state → not downloadable', () => {
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: null,
      currentView: previewWith('codesys', {
        codesys: stub('codesys', [['x.st', 'X']]),
      }),
    });
    expect(v.state).toBe('no-archived-diff');
    expect(isArchiveCompareDownloadable({ comparison: v })).toBe(false);
  });

  it('4. no-current-preview state → not downloadable', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: null,
    });
    expect(v.state).toBe('no-current-preview');
    expect(isArchiveCompareDownloadable({ comparison: v })).toBe(false);
  });

  it('5. unchanged-against-archive → downloadable', () => {
    expect(
      isArchiveCompareDownloadable({ comparison: unchangedComparison() }),
    ).toBe(true);
  });

  it('6. changed-against-archive → downloadable', () => {
    expect(
      isArchiveCompareDownloadable({ comparison: changedComparison() }),
    ).toBe(true);
  });

  it('7. partially-comparable → downloadable', () => {
    expect(
      isArchiveCompareDownloadable({
        comparison: partiallyComparableComparison(),
      }),
    ).toBe(true);
  });

  it('8. selection-mismatch → downloadable (records the mismatch honestly)', () => {
    expect(
      isArchiveCompareDownloadable({
        comparison: selectionMismatchComparison(),
      }),
    ).toBe(true);
  });
});

// =============================================================================
// 2. Bundle shape
// =============================================================================

describe('buildCodegenPreviewArchiveCompareBundle — shape', () => {
  it('9. kind + version + state + summary copied verbatim', () => {
    const c = changedComparison();
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: c,
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.kind).toBe(CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND);
    expect(bundle.version).toBe(CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION);
    expect(bundle.state).toBe(c.state);
    expect(bundle.summary).toBe(c.summary);
  });

  it('10. createdAt explicit is preserved', () => {
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: changedComparison(),
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.createdAt).toBe(FIXED_CREATED_AT);
  });

  it('11. createdAt default is a parseable ISO string', () => {
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: changedComparison(),
    });
    expect(typeof bundle.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(bundle.createdAt))).toBe(false);
  });

  it('12. invalid createdAt falls back to the deterministic default', () => {
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: changedComparison(),
      createdAt: 'not-a-date',
    });
    expect(bundle.createdAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('13. selection block preserves both backends + selectionMatch', () => {
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: partiallyComparableComparison(),
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.selection.archivedBackend).toBe('codesys');
    expect(bundle.selection.currentBackend).toBe('all');
    expect(bundle.selection.selectionMatch).toBe(false);
  });

  it('14. counts equal the comparison view counts', () => {
    const c = changedComparison();
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: c,
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.counts).toEqual({
      targetsCompared: c.counts.targetsCompared,
      targetsChanged: c.counts.targetsChanged,
      artifactsSame: c.counts.artifactsSame,
      artifactsChanged: c.counts.artifactsChanged,
      artifactsMissingCurrent: c.counts.artifactsMissingCurrent,
      artifactsNewCurrent: c.counts.artifactsNewCurrent,
      diagnosticsStillPresent: c.counts.diagnosticsStillPresent,
      diagnosticsResolved: c.counts.diagnosticsResolved,
      diagnosticsNewCurrent: c.counts.diagnosticsNewCurrent,
    });
  });

  it('15. targets sort by path within each target group (siemens → codesys → rockwell preserved from the view)', () => {
    const c = partiallyComparableComparison();
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: c,
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.targets.map((t) => t.target)).toEqual(
      c.targets.map((t) => t.target),
    );
    for (const t of bundle.targets) {
      const paths = t.artifactComparisons.map((a) => a.path);
      const sorted = [...paths].sort((a, b) => a.localeCompare(b));
      expect(paths).toEqual(sorted);
    }
  });

  it('16. artifact rows carry hashes / sizes / status by whitelist', () => {
    const c = changedComparison();
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: c,
      createdAt: FIXED_CREATED_AT,
    });
    const row = bundle.targets[0].artifactComparisons[0];
    expect(row.path).toBe('codesys/x.st');
    expect(row.status).toBe('changed-hash');
    expect(typeof row.archivedHash).toBe('string');
    expect(typeof row.currentHash).toBe('string');
    expect(row.archivedHash).not.toBe(row.currentHash);
  });

  it('17. diagnostic rows are flattened: severity / code / message / status', () => {
    // Construct a comparison with a manifest diagnostic.
    const archived = buildCodegenPreviewDiffBundle({
      previousView: previewWith('rockwell', {
        rockwell: stub('rockwell', [['x.st', 'X']]),
      }),
      currentView: previewWith('rockwell', {
        rockwell: () => [
          {
            ...makeArtifact('rockwell/x.st', 'X'),
            diagnostics: [
              {
                severity: 'warning' as const,
                code: 'STILL',
                message: 'still here',
              },
            ],
          },
        ],
      }),
    });
    const current = previewWith('rockwell', {
      rockwell: () => [
        {
          ...makeArtifact('rockwell/x.st', 'X'),
          diagnostics: [
            {
              severity: 'warning' as const,
              code: 'STILL',
              message: 'still here',
            },
          ],
        },
      ],
    });
    const c = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: c,
      createdAt: FIXED_CREATED_AT,
    });
    const dRow = bundle.targets[0].diagnosticComparisons.find(
      (d) => d.code === 'STILL',
    )!;
    expect(dRow.severity).toBe('warning');
    expect(dRow.message).toBe('still here');
    expect(dRow.status).toBe('still-present');
  });

  it('18. not-comparable target rows survive without crashing', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const current = previewWith('codesys', {
      codesys: () => {
        throw new CodegenError('INTERNAL_ERROR', 'boom');
      },
    });
    const c = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: c,
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.targets[0].status).toBe('not-comparable');
    expect(bundle.state).toBe('changed-against-archive');
  });

  it('19. selection-mismatch comparison is faithfully recorded', () => {
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: selectionMismatchComparison(),
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.state).toBe('selection-mismatch');
    expect(bundle.selection.selectionMatch).toBe(false);
  });

  it('20. unchanged-against-archive bundle reports the clean state', () => {
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: unchangedComparison(),
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.state).toBe('unchanged-against-archive');
    expect(bundle.counts.artifactsChanged).toBe(0);
    expect(bundle.targets[0].status).toBe('same');
  });
});

// =============================================================================
// 3. Whitelist / privacy
// =============================================================================

describe('buildCodegenPreviewArchiveCompareBundle — whitelist / privacy', () => {
  it('21. polluted artifact rows do not leak content / raw payloads', () => {
    const c = changedComparison();
    // Inject the kind of payload a future format drift might
    // accidentally smuggle in.
    const polluted = JSON.parse(JSON.stringify(c)) as typeof c & {
      targets: Array<{
        artifactComparisons: Array<Record<string, unknown>>;
      }>;
    };
    polluted.targets[0].artifactComparisons[0].content =
      'FUNCTION_BLOCK SECRET END_FUNCTION_BLOCK';
    polluted.targets[0].artifactComparisons[0].previewText = 'snippet';
    polluted.targets[0].artifactComparisons[0].rawCsv = 'row_kind,A\n';
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: polluted as unknown as ArchivedPreviewComparisonView,
      createdAt: FIXED_CREATED_AT,
    });
    const json = serializeCodegenPreviewArchiveCompareBundle(bundle);
    expect(json).not.toContain('"content"');
    expect(json).not.toContain('"previewText"');
    expect(json).not.toContain('FUNCTION_BLOCK SECRET');
    expect(json).not.toContain('row_kind,');
  });

  it('22. polluted top-level fields are dropped', () => {
    const c = changedComparison();
    const polluted = JSON.parse(JSON.stringify(c));
    polluted.rawPdfBytes = '%PDF-1.4...';
    polluted.pir_version = '0.1.0';
    polluted.eplanProject = '<EplanProject>...</EplanProject>';
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: polluted,
      createdAt: FIXED_CREATED_AT,
    });
    const json = serializeCodegenPreviewArchiveCompareBundle(bundle);
    expect(json).not.toContain('%PDF-');
    expect(json).not.toContain('"pir_version"');
    expect(json).not.toContain('<EplanProject');
  });

  it('23. polluted diagnostic rows do not leak extra fields', () => {
    // Build a comparison with a real diagnostic, then pollute it.
    const archived = buildCodegenPreviewDiffBundle({
      previousView: previewWith('rockwell', {
        rockwell: stub('rockwell', [['x.st', 'X']]),
      }),
      currentView: previewWith('rockwell', {
        rockwell: () => [
          {
            ...makeArtifact('rockwell/x.st', 'X'),
            diagnostics: [
              {
                severity: 'warning' as const,
                code: 'X',
                message: 'msg',
              },
            ],
          },
        ],
      }),
    });
    const current = previewWith('rockwell', {
      rockwell: () => [
        {
          ...makeArtifact('rockwell/x.st', 'X'),
          diagnostics: [
            {
              severity: 'warning' as const,
              code: 'X',
              message: 'msg',
            },
          ],
        },
      ],
    });
    const c = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const polluted = JSON.parse(JSON.stringify(c));
    polluted.targets[0].diagnosticComparisons[0].diagnostic.content =
      'should-not-survive';
    polluted.targets[0].diagnosticComparisons[0].rawSourceRef =
      '<TcecadProject>...';
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: polluted,
      createdAt: FIXED_CREATED_AT,
    });
    const json = serializeCodegenPreviewArchiveCompareBundle(bundle);
    expect(json).not.toContain('should-not-survive');
    expect(json).not.toContain('<TcecadProject');
  });
});

// =============================================================================
// 4. Filename + sanitiser
// =============================================================================

describe('codegenPreviewArchiveCompareFilename', () => {
  it('24. default snapshot name → no suffix', () => {
    expect(codegenPreviewArchiveCompareFilename({})).toBe(
      'plc-copilot-codegen-preview-archive-compare.json',
    );
    expect(codegenPreviewArchiveCompareFilename({ snapshotName: 'compare' })).toBe(
      'plc-copilot-codegen-preview-archive-compare.json',
    );
    expect(
      codegenPreviewArchiveCompareFilename({ snapshotName: '' }),
    ).toBe('plc-copilot-codegen-preview-archive-compare.json');
  });

  it('25. custom snapshot name lands sanitised in the filename', () => {
    expect(
      codegenPreviewArchiveCompareFilename({
        snapshotName: '  Pre/Prod  Audit v2 ',
      }),
    ).toBe(
      'plc-copilot-codegen-preview-archive-compare-pre-prod-audit-v2.json',
    );
  });

  it('26. sanitiser collapses runs, drops unsafe chars, clamps to 64', () => {
    expect(sanitizeArchiveCompareSnapshotName(' Hello,  World!! ')).toBe(
      'hello-world',
    );
    expect(sanitizeArchiveCompareSnapshotName('--..--')).toBe('');
    expect(sanitizeArchiveCompareSnapshotName(undefined)).toBe('');
    const long = 'a'.repeat(200);
    expect(sanitizeArchiveCompareSnapshotName(long)).toHaveLength(64);
  });
});

// =============================================================================
// 5. Determinism + immutability + roundtrip
// =============================================================================

describe('buildCodegenPreviewArchiveCompareBundle — determinism + immutability', () => {
  it('27. helper does not mutate the comparison view', () => {
    const c = changedComparison();
    const before = JSON.stringify(c);
    buildCodegenPreviewArchiveCompareBundle({
      comparison: c,
      createdAt: FIXED_CREATED_AT,
    });
    expect(JSON.stringify(c)).toBe(before);
  });

  it('28. two builds with the same args yield byte-identical JSON', () => {
    const c = changedComparison();
    const a = serializeCodegenPreviewArchiveCompareBundle(
      buildCodegenPreviewArchiveCompareBundle({
        comparison: c,
        createdAt: FIXED_CREATED_AT,
      }),
    );
    const b = serializeCodegenPreviewArchiveCompareBundle(
      buildCodegenPreviewArchiveCompareBundle({
        comparison: c,
        createdAt: FIXED_CREATED_AT,
      }),
    );
    expect(a).toBe(b);
  });

  it('29. JSON.parse(serialize(bundle)) deep-equals the bundle', () => {
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: changedComparison(),
      createdAt: FIXED_CREATED_AT,
      snapshotName: 'audit-2026-05',
    });
    const text = serializeCodegenPreviewArchiveCompareBundle(bundle);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(bundle);
  });

  it('30. empty target list still produces a clean bundle', () => {
    // Force-empty `targets` — shouldn't happen on a real
    // comparison that survived the gate, but we exercise the
    // path defensively.
    const c = changedComparison();
    const empty: ArchivedPreviewComparisonView = {
      ...c,
      targets: [],
    };
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: empty,
      createdAt: FIXED_CREATED_AT,
    });
    expect(bundle.targets).toEqual([]);
  });
});
