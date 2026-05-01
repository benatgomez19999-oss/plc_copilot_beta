// Sprint 96 — pure tests for the imported codegen preview
// archive-compare bundle parser. Uses the Sprint 95 builder
// (powered by real Sprint 89 / 91 / 94 helpers) so the test
// fixtures can never drift away from the actual bundle shape
// the operator saves to disk.
//
// What we pin:
//   - empty / whitespace-only → empty (no throw).
//   - malformed JSON → invalid with a stable error string.
//   - wrong kind (Sprint 90A preview / Sprint 91 diff bundle) →
//     invalid.
//   - wrong version → invalid.
//   - real Sprint 95 bundles (changed / unchanged / partially-
//     comparable / selection-mismatch / not-comparable) round-
//     trip and arrive deep-equal.
//   - whitelist privacy: stray `content` / `previewText` /
//     `pir_version` / raw-source-looking strings on a polluted
//     bundle never make it into the rebuilt view.
//   - parser does not mutate the input value.
//   - two parses on the same input deep-equal.
//   - rejects malformed targets[] / counts / selection.
//   - target / artifact / diagnostic enums validated; unknown
//     values rejected.
//   - `isSupportedCodegenPreviewArchiveCompareBundle` mirrors
//     the parser's verdict.

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
  buildCodegenPreviewArchiveCompareBundle,
  CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND,
  CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION,
  type CodegenPreviewArchiveCompareBundle,
} from '../src/utils/codegen-preview-archive-compare-download.js';
import {
  isSupportedCodegenPreviewArchiveCompareBundle,
  parseCodegenPreviewArchiveCompareBundle,
  parseCodegenPreviewArchiveCompareBundleText,
} from '../src/utils/codegen-preview-archive-compare-import.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_CREATED_AT = '2026-05-01T12:00:00.000Z';

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

function notComparableComparison(): ArchivedPreviewComparisonView {
  const archived = diffBundle({
    prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
    currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
  });
  const current = previewWith('codesys', {
    codesys: () => {
      throw new CodegenError('INTERNAL_ERROR', 'boom');
    },
  });
  return compareImportedDiffWithCurrentPreview({
    importedBundle: archived,
    currentView: current,
  });
}

function bundleFor(
  c: ArchivedPreviewComparisonView,
): CodegenPreviewArchiveCompareBundle {
  return buildCodegenPreviewArchiveCompareBundle({
    comparison: c,
    createdAt: FIXED_CREATED_AT,
  });
}

// =============================================================================
// 1. Empty / malformed text
// =============================================================================

describe('parseCodegenPreviewArchiveCompareBundleText — empty / malformed', () => {
  it('1. empty string → empty (no throw)', () => {
    const v = parseCodegenPreviewArchiveCompareBundleText('');
    expect(v.status).toBe('empty');
    expect(v.bundle).toBeUndefined();
    expect(v.error).toBeUndefined();
  });

  it('2. whitespace-only → empty', () => {
    expect(parseCodegenPreviewArchiveCompareBundleText('   \n\t').status).toBe(
      'empty',
    );
  });

  it('3. malformed JSON → invalid with stable error', () => {
    const v = parseCodegenPreviewArchiveCompareBundleText('{not json}');
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/not valid JSON/);
  });
});

// =============================================================================
// 2. Wrong kind / version
// =============================================================================

describe('parseCodegenPreviewArchiveCompareBundle — wrong kind / version', () => {
  it('4. missing kind → invalid', () => {
    const v = parseCodegenPreviewArchiveCompareBundle({
      version: 1,
      targets: [],
    });
    expect(v.status).toBe('invalid');
    expect(v.error).toContain(CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND);
  });

  it('5. wrong kind (Sprint 90A preview bundle kind) → invalid', () => {
    const v = parseCodegenPreviewArchiveCompareBundle({
      kind: 'plc-copilot-codegen-preview',
      version: 1,
    });
    expect(v.status).toBe('invalid');
  });

  it('6. wrong kind (Sprint 91 diff bundle kind) → invalid', () => {
    const v = parseCodegenPreviewArchiveCompareBundle({
      kind: 'plc-copilot.codegen-preview-diff',
      version: 1,
    });
    expect(v.status).toBe('invalid');
  });

  it('7. wrong version → invalid (no silent upgrade)', () => {
    const v = parseCodegenPreviewArchiveCompareBundle({
      kind: CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND,
      version: 2,
    });
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/version/i);
  });

  it('8. non-object input → invalid', () => {
    expect(parseCodegenPreviewArchiveCompareBundle(42).status).toBe('invalid');
    expect(parseCodegenPreviewArchiveCompareBundle('x').status).toBe('invalid');
    expect(parseCodegenPreviewArchiveCompareBundle([1]).status).toBe('invalid');
  });

  it('9. null / undefined → empty (operator picked nothing)', () => {
    expect(parseCodegenPreviewArchiveCompareBundle(null).status).toBe('empty');
    expect(parseCodegenPreviewArchiveCompareBundle(undefined).status).toBe(
      'empty',
    );
  });
});

// =============================================================================
// 3. Round trip
// =============================================================================

describe('parseCodegenPreviewArchiveCompareBundle — round trip', () => {
  it('10. real Sprint 95 changed bundle → loaded, all fields preserved', () => {
    const original = bundleFor(changedComparison());
    const v = parseCodegenPreviewArchiveCompareBundleText(
      JSON.stringify(original),
    );
    expect(v.status).toBe('loaded');
    expect(v.bundle).toEqual(original);
    expect(v.summary).toMatch(/Archived comparison/);
  });

  it('11. real Sprint 95 unchanged bundle → loaded, state preserved', () => {
    const original = bundleFor(unchangedComparison());
    const v = parseCodegenPreviewArchiveCompareBundle(original);
    expect(v.status).toBe('loaded');
    expect(v.bundle?.state).toBe('unchanged-against-archive');
    expect(v.bundle?.targets[0].status).toBe('same');
  });

  it('12. selection-mismatch bundle round-trips', () => {
    const original = bundleFor(selectionMismatchComparison());
    const v = parseCodegenPreviewArchiveCompareBundle(original);
    expect(v.status).toBe('loaded');
    expect(v.bundle?.state).toBe('selection-mismatch');
    expect(v.bundle?.selection.selectionMatch).toBe(false);
  });

  it('13. partially-comparable bundle round-trips', () => {
    const original = bundleFor(partiallyComparableComparison());
    const v = parseCodegenPreviewArchiveCompareBundle(original);
    expect(v.status).toBe('loaded');
    expect(v.bundle?.state).toBe('partially-comparable');
    expect(v.bundle?.targets.map((t) => t.target)).toEqual([
      'siemens',
      'codesys',
      'rockwell',
    ]);
  });

  it('14. not-comparable target rows survive round trip', () => {
    const original = bundleFor(notComparableComparison());
    const v = parseCodegenPreviewArchiveCompareBundle(original);
    expect(v.status).toBe('loaded');
    expect(v.bundle?.targets[0].status).toBe('not-comparable');
  });

  it('15. createdAt preserved verbatim', () => {
    const original = bundleFor(changedComparison());
    const v = parseCodegenPreviewArchiveCompareBundle(original);
    expect(v.bundle?.createdAt).toBe(FIXED_CREATED_AT);
  });

  it('16. snapshotName preserved (and defaults to "compare")', () => {
    const original = bundleFor(changedComparison());
    expect(original.snapshotName).toBe('compare');
    const v = parseCodegenPreviewArchiveCompareBundle(original);
    expect(v.bundle?.snapshotName).toBe('compare');
  });

  it('17. counts preserved verbatim', () => {
    const original = bundleFor(changedComparison());
    const v = parseCodegenPreviewArchiveCompareBundle(original);
    expect(v.bundle?.counts).toEqual(original.counts);
  });

  it('18. artifact + diagnostic order preserved', () => {
    const original = bundleFor(changedComparison());
    const v = parseCodegenPreviewArchiveCompareBundle(original);
    expect(
      v.bundle!.targets[0].artifactComparisons.map((a) => a.path),
    ).toEqual(original.targets[0].artifactComparisons.map((a) => a.path));
    expect(
      v.bundle!.targets[0].diagnosticComparisons.map(
        (d) => `${d.status}|${d.code}|${d.severity}`,
      ),
    ).toEqual(
      original.targets[0].diagnosticComparisons.map(
        (d) => `${d.status}|${d.code}|${d.severity}`,
      ),
    );
  });
});

// =============================================================================
// 4. Whitelist / privacy
// =============================================================================

describe('parseCodegenPreviewArchiveCompareBundle — whitelist / privacy', () => {
  it('19. extra top-level fields are stripped', () => {
    const original = bundleFor(changedComparison());
    const polluted = {
      ...JSON.parse(JSON.stringify(original)),
      rawPdfBytes: 'should-not-survive',
      pir_version: '0.1.0',
      content: 'FUNCTION_BLOCK X',
    } as Record<string, unknown>;
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('loaded');
    const json = JSON.stringify(v.bundle);
    expect(json).not.toContain('should-not-survive');
    expect(json).not.toContain('"pir_version"');
    expect(json).not.toContain('FUNCTION_BLOCK X');
    expect(json).not.toContain('"content"');
  });

  it('20. extra per-artifact fields (e.g. content) are dropped', () => {
    const original = bundleFor(changedComparison());
    const polluted = JSON.parse(JSON.stringify(original));
    polluted.targets[0].artifactComparisons[0].content =
      'FULL_CONTENT_THAT_MUST_NOT_LEAK';
    polluted.targets[0].artifactComparisons[0].previewText = 'snippet';
    polluted.targets[0].artifactComparisons[0].rawCsv = 'row_kind,name\n';
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('loaded');
    const json = JSON.stringify(v.bundle);
    expect(json).not.toContain('FULL_CONTENT_THAT_MUST_NOT_LEAK');
    expect(json).not.toContain('"previewText"');
    expect(json).not.toContain('row_kind,');
  });

  it('21. extra per-target fields (e.g. raw source ref) are dropped', () => {
    const original = bundleFor(changedComparison());
    const polluted = JSON.parse(JSON.stringify(original));
    polluted.targets[0].secretSourceRef = '<EplanProject>...</EplanProject>';
    polluted.targets[0].pdfBytes = '%PDF-1.4...';
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('loaded');
    const json = JSON.stringify(v.bundle);
    expect(json).not.toContain('<EplanProject');
    expect(json).not.toContain('%PDF-');
  });
});

// =============================================================================
// 5. Defensive validation
// =============================================================================

describe('parseCodegenPreviewArchiveCompareBundle — defensive validation', () => {
  it('22. missing targets array → invalid', () => {
    const polluted = { ...bundleFor(changedComparison()) } as unknown as Record<
      string,
      unknown
    >;
    delete polluted.targets;
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/targets/);
  });

  it('23. unsupported target name → invalid', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    polluted.targets[0].target = 'core';
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
  });

  it('24. unsupported global state → invalid', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    polluted.state = 'sideways';
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/state/);
  });

  it('25. unsupported target status → invalid', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    polluted.targets[0].status = 'wibbly';
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
  });

  it('26. unsupported artifact comparison status → invalid', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    polluted.targets[0].artifactComparisons[0].status = 'wobbly';
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
  });

  it('27. malformed counts (negative number) → invalid', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    polluted.counts.targetsCompared = -1;
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/counts/);
  });

  it('28. malformed selection (missing selectionMatch) → invalid', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    delete polluted.selection.selectionMatch;
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/selection/);
  });

  it('29. missing createdAt → invalid', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    delete polluted.createdAt;
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/createdAt/);
  });

  it('30. unparseable createdAt → invalid', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    polluted.createdAt = 'not-a-date';
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/createdAt/);
  });
});

// =============================================================================
// 6. Determinism / immutability / predicate
// =============================================================================

describe('parseCodegenPreviewArchiveCompareBundle — determinism', () => {
  it('31. helper does not mutate the input value', () => {
    const original = bundleFor(changedComparison());
    const before = JSON.stringify(original);
    parseCodegenPreviewArchiveCompareBundle(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('32. two parses of the same input deep-equal', () => {
    const original = bundleFor(changedComparison());
    const a = parseCodegenPreviewArchiveCompareBundle(original);
    const b = parseCodegenPreviewArchiveCompareBundle(original);
    expect(a).toEqual(b);
  });

  it('33. isSupportedCodegenPreviewArchiveCompareBundle mirrors the parser', () => {
    expect(
      isSupportedCodegenPreviewArchiveCompareBundle(
        bundleFor(changedComparison()),
      ),
    ).toBe(true);
    expect(isSupportedCodegenPreviewArchiveCompareBundle(null)).toBe(false);
    expect(
      isSupportedCodegenPreviewArchiveCompareBundle({
        kind: 'plc-copilot.codegen-preview-diff',
        version: CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION,
      }),
    ).toBe(false);
  });

  it('34. empty targets[] is preserved (Sprint 95 contract allows it)', () => {
    const polluted = JSON.parse(
      JSON.stringify(bundleFor(changedComparison())),
    );
    polluted.targets = [];
    polluted.counts.targetsCompared = 0;
    polluted.counts.targetsChanged = 0;
    const v = parseCodegenPreviewArchiveCompareBundle(polluted);
    expect(v.status).toBe('loaded');
    expect(v.bundle?.targets).toEqual([]);
  });
});
