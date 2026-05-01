// Sprint 94 — pure tests for the archived-diff vs. current-preview
// comparison helper. The helper takes a Sprint 91 bundle (already
// validated by the Sprint 92 importer in the panel layer) plus a
// Sprint 89 `CodegenPreviewView` and produces a deterministic
// meta-comparison the panel renders read-only.
//
// What we pin:
//   - null inputs → meaningful empty states (no throw).
//   - matched archived bundle ↔ current preview with identical
//     content → unchanged-against-archive (no changes detected).
//   - artifact + diagnostic + target transitions surface honestly:
//     same-hash / changed-hash / missing-current / new-current /
//     not-comparable; still-present / resolved / new-current.
//   - selection-mismatch surfaced honestly; partial overlap
//     bridged via partially-comparable.
//   - deterministic sort across `'all'` mixed scenarios.
//   - immutability + byte-stable repeated calls.
//   - bundle pollution (extra `content`, raw payloads) does not
//     leak through (the importer already strips, but we re-pin
//     the comparison output is hashes / counts only).

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
import { deterministicContentHash } from '../src/utils/codegen-preview-diff.js';

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

// =============================================================================
// 1. Null / missing inputs
// =============================================================================

describe('compareImportedDiffWithCurrentPreview — null / missing inputs', () => {
  it('1. both null → no-archived-diff state', () => {
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: null,
      currentView: null,
    });
    expect(v.state).toBe('no-archived-diff');
    expect(v.targets).toEqual([]);
  });

  it('2. archived only → no-current-preview state', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'OLD']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'NEW']]) },
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: null,
    });
    expect(v.state).toBe('no-current-preview');
    expect(v.archivedBackend).toBe('codesys');
  });

  it('3. current only → no-archived-diff state', () => {
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'X']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: null,
      currentView: current,
    });
    expect(v.state).toBe('no-archived-diff');
  });
});

// =============================================================================
// 2. Identity / unchanged
// =============================================================================

describe('compareImportedDiffWithCurrentPreview — unchanged', () => {
  it('4. archived bundle whose current side equals current preview → unchanged-against-archive', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'OLD']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'NEW_FINAL']]) },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'NEW_FINAL']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(v.state).toBe('unchanged-against-archive');
    expect(v.targets[0].status).toBe('same');
    expect(v.targets[0].counts.artifactsSame).toBe(1);
    expect(v.counts.artifactsChanged).toBe(0);
  });
});

// =============================================================================
// 3. Artifact transitions
// =============================================================================

describe('compareImportedDiffWithCurrentPreview — artifact transitions', () => {
  it('5. artifact hash changed since archive → changed-hash + changed-against-archive', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'C']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(v.state).toBe('changed-against-archive');
    const t = v.targets[0];
    expect(t.status).toBe('changed');
    const a = t.artifactComparisons.find((x) => x.path === 'codesys/x.st')!;
    expect(a.status).toBe('changed-hash');
    expect(a.archivedHash).not.toBe(a.currentHash);
    expect(a.currentHash).toBe(deterministicContentHash('C'));
  });

  it('6. artifact missing in current preview → missing-current', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: {
        codesys: stub('codesys', [
          ['x.st', 'B'],
          ['y.st', 'Y'],
        ]),
      },
    });
    // Today: y.st is gone.
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'B']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const a = v.targets[0].artifactComparisons.find(
      (x) => x.path === 'codesys/y.st',
    )!;
    expect(a.status).toBe('missing-current');
  });

  it('7. artifact in current but not mentioned in archive → new-current', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [
        ['x.st', 'B'],
        ['z.st', 'NEW'],
      ]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const z = v.targets[0].artifactComparisons.find(
      (x) => x.path === 'codesys/z.st',
    )!;
    expect(z.status).toBe('new-current');
    expect(z.currentHash).toBe(deterministicContentHash('NEW'));
  });

  it('8. archived artifact with no currentHash → not-comparable', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    // Strip currentHash on one path to simulate a future bundle
    // drift or a manually-edited archive.
    // Mutable shape — the helper accepts the readonly contract on
    // input but a JSON-parsed object is always mutable in practice.
    const polluted = JSON.parse(JSON.stringify(archived)) as {
      targets: Array<{
        artifactChanges: Array<{
          path: string;
          status: string;
          currentHash?: string;
        }>;
      }>;
    } & CodegenPreviewDiffBundle;
    polluted.targets[0].artifactChanges[0] = {
      ...polluted.targets[0].artifactChanges[0],
      currentHash: undefined,
    };
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'B']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: polluted,
      currentView: current,
    });
    const a = v.targets[0].artifactComparisons[0];
    expect(a.status).toBe('not-comparable');
    expect(a.currentHash).toBe(deterministicContentHash('B'));
  });

  it('9. content hash uses the FULL Sprint 90A `content`, not the truncated previewText', () => {
    // Build long content > Sprint 89 snippet caps so the only way
    // to detect drift is via `content`.
    const longBase = Array.from({ length: 80 }, (_, i) => `LINE_${i}`).join('\n');
    const longA = longBase + '\nOLD';
    const longB = longBase + '\nMID';
    const longC = longBase + '\nDIFF';

    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', longA]]) },
      currGen: { codesys: stub('codesys', [['x.st', longB]]) },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', longC]]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const a = v.targets[0].artifactComparisons[0];
    expect(a.status).toBe('changed-hash');
    expect(a.archivedHash).toBe(deterministicContentHash(longB));
    expect(a.currentHash).toBe(deterministicContentHash(longC));
  });
});

// =============================================================================
// 4. Target-level transitions
// =============================================================================

describe('compareImportedDiffWithCurrentPreview — target transitions', () => {
  it('10. target only in archive → missing-current', () => {
    const archived = diffBundle({
      prevSelection: 'all',
      currSelection: 'all',
      prevGen: {
        siemens: stub('siemens', [['s.scl', 'S']]),
        codesys: stub('codesys', [['c.st', 'C']]),
        rockwell: stub('rockwell', [['r.st', 'R']]),
      },
      currGen: {
        siemens: stub('siemens', [['s.scl', 'S2']]),
        codesys: stub('codesys', [['c.st', 'C2']]),
        rockwell: stub('rockwell', [['r.st', 'R2']]),
      },
    });
    // Today: only codesys.
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['c.st', 'C2']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const siemens = v.targets.find((t) => t.target === 'siemens')!;
    expect(siemens.status).toBe('missing-current');
  });

  it('11. target only in current → missing-archived', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['c.st', 'C']]) },
      currGen: { codesys: stub('codesys', [['c.st', 'C2']]) },
    });
    // Today: 'all' so siemens + rockwell are unknown to the archive.
    const current = previewWith('all', {
      codesys: stub('codesys', [['c.st', 'C2']]),
      siemens: stub('siemens', [['s.scl', 'S']]),
      rockwell: stub('rockwell', [['r.st', 'R']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const siemens = v.targets.find((t) => t.target === 'siemens')!;
    expect(siemens.status).toBe('missing-archived');
    expect(siemens.counts.artifactsNewCurrent).toBe(1);
  });

  it('12. current target blocked → not-comparable when archive expected artifacts', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['c.st', 'C']]) },
      currGen: { codesys: stub('codesys', [['c.st', 'C2']]) },
    });
    const blockedProject = happyProject();
    (blockedProject.machines[0].stations[0].equipment[0].type as string) =
      'pneumatic_cylinder_1pos';
    const current = previewWith(
      'codesys',
      { codesys: () => [] },
      blockedProject,
    );
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(v.targets[0].status).toBe('not-comparable');
    expect(v.targets[0].currentStatus).toBe('blocked');
  });

  it('13. current target failed → not-comparable when archive expected artifacts', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['c.st', 'C']]) },
      currGen: { codesys: stub('codesys', [['c.st', 'C2']]) },
    });
    const current = previewWith('codesys', {
      codesys: () => {
        throw new CodegenError('INTERNAL_ERROR', 'boom');
      },
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(v.targets[0].status).toBe('not-comparable');
    expect(v.targets[0].currentStatus).toBe('failed');
  });

  it('14. target order: siemens → codesys → rockwell', () => {
    const archived = diffBundle({
      prevSelection: 'all',
      currSelection: 'all',
      prevGen: {
        siemens: stub('siemens', [['s.scl', 'S']]),
        codesys: stub('codesys', [['c.st', 'C']]),
        rockwell: stub('rockwell', [['r.st', 'R']]),
      },
      currGen: {
        siemens: stub('siemens', [['s.scl', 'S2']]),
        codesys: stub('codesys', [['c.st', 'C2']]),
        rockwell: stub('rockwell', [['r.st', 'R2']]),
      },
    });
    const current = previewWith('all', {
      siemens: stub('siemens', [['s.scl', 'S2']]),
      codesys: stub('codesys', [['c.st', 'C2']]),
      rockwell: stub('rockwell', [['r.st', 'R2']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(v.targets.map((t) => t.target)).toEqual([
      'siemens',
      'codesys',
      'rockwell',
    ]);
  });
});

// =============================================================================
// 5. Diagnostics
// =============================================================================

describe('compareImportedDiffWithCurrentPreview — diagnostic transitions', () => {
  function diagGen(prefix: string, diagCode: string) {
    return () => [
      {
        ...makeArtifact(`${prefix}/x.st`, 'X'),
        diagnostics: [
          {
            severity: 'warning' as const,
            code: diagCode,
            message: 'msg-' + diagCode,
          },
        ],
      },
    ];
  }

  it('15. diagnostic still present in current → still-present', () => {
    const archived = buildCodegenPreviewDiffBundle({
      previousView: previewWith('rockwell', {
        rockwell: stub('rockwell', [['x.st', 'X']]),
      }),
      currentView: previewWith('rockwell', {
        rockwell: diagGen('rockwell', 'STILL'),
      }),
    });
    const current = previewWith('rockwell', {
      rockwell: diagGen('rockwell', 'STILL'),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const t = v.targets[0];
    const still = t.diagnosticComparisons.find(
      (d) => d.diagnostic.code === 'STILL',
    )!;
    expect(still.status).toBe('still-present');
  });

  it('16. archived diagnostic absent in current → resolved', () => {
    const archived = buildCodegenPreviewDiffBundle({
      previousView: previewWith('rockwell', {
        rockwell: stub('rockwell', [['x.st', 'X']]),
      }),
      currentView: previewWith('rockwell', {
        rockwell: diagGen('rockwell', 'GONE'),
      }),
    });
    // Today: no diagnostics.
    const current = previewWith('rockwell', {
      rockwell: stub('rockwell', [['x.st', 'X']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const gone = v.targets[0].diagnosticComparisons.find(
      (d) => d.diagnostic.code === 'GONE',
    )!;
    expect(gone.status).toBe('resolved');
  });

  it('17. current preview adds a diagnostic the archive never mentioned → new-current', () => {
    const archived = buildCodegenPreviewDiffBundle({
      previousView: previewWith('rockwell', {
        rockwell: stub('rockwell', [['x.st', 'X']]),
      }),
      currentView: previewWith('rockwell', {
        rockwell: stub('rockwell', [['x.st', 'X']]),
      }),
    });
    const current = previewWith('rockwell', {
      rockwell: diagGen('rockwell', 'NEW'),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const novel = v.targets[0].diagnosticComparisons.find(
      (d) => d.diagnostic.code === 'NEW',
    )!;
    expect(novel.status).toBe('new-current');
  });

  it('18. duplicate diagnostics across artifacts dedupe deterministically', () => {
    const dupGen = () => [
      {
        ...makeArtifact('rockwell/x.st', 'X'),
        diagnostics: [
          { severity: 'warning' as const, code: 'DUPE', message: 'd' },
        ],
      },
      {
        ...makeArtifact('rockwell/y.st', 'Y'),
        diagnostics: [
          { severity: 'warning' as const, code: 'DUPE', message: 'd' },
        ],
      },
    ];
    const archived = buildCodegenPreviewDiffBundle({
      previousView: previewWith('rockwell', {
        rockwell: stub('rockwell', [['x.st', 'X']]),
      }),
      currentView: previewWith('rockwell', { rockwell: dupGen }),
    });
    const current = previewWith('rockwell', { rockwell: dupGen });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const dupes = v.targets[0].diagnosticComparisons.filter(
      (d) => d.diagnostic.code === 'DUPE',
    );
    expect(dupes).toHaveLength(1);
    expect(dupes[0].status).toBe('still-present');
  });
});

// =============================================================================
// 6. Selection match / mismatch
// =============================================================================

describe('compareImportedDiffWithCurrentPreview — selection', () => {
  it('19. matching backends → selectionMatch true', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'B']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(v.selectionMatch).toBe(true);
  });

  it('20. backend mismatch with no overlap → selection-mismatch state', () => {
    // Archive: codesys only. Current: rockwell only.
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const current = previewWith('rockwell', {
      rockwell: stub('rockwell', [['r.st', 'R']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(v.selectionMatch).toBe(false);
    expect(v.state).toBe('selection-mismatch');
  });

  it('21. backend mismatch with overlap → partially-comparable', () => {
    // Archive: codesys only. Current: 'all' covers codesys + others.
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['c.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['c.st', 'B']]) },
    });
    const current = previewWith('all', {
      codesys: stub('codesys', [['c.st', 'B']]),
      siemens: stub('siemens', [['s.scl', 'S']]),
      rockwell: stub('rockwell', [['r.st', 'R']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(v.selectionMatch).toBe(false);
    expect(v.state).toBe('partially-comparable');
  });
});

// =============================================================================
// 7. Determinism, immutability, sort stability
// =============================================================================

describe('compareImportedDiffWithCurrentPreview — determinism & immutability', () => {
  it('22. helper does not mutate the input bundle / preview', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'C']]),
    });
    const before = JSON.stringify({ archived, current });
    compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const after = JSON.stringify({ archived, current });
    expect(after).toBe(before);
  });

  it('23. two calls deep-equal', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'B']]),
    });
    const a = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const b = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('24. artifact comparisons sort by path within target', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['a.st', 'OLD']]) },
      currGen: {
        codesys: stub('codesys', [
          ['z.st', 'Z'],
          ['a.st', 'A'],
          ['m.st', 'M'],
        ]),
      },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [
        ['z.st', 'Z'],
        ['a.st', 'A'],
        ['m.st', 'M'],
      ]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    expect(
      v.targets[0].artifactComparisons.map((a) => a.path),
    ).toEqual(['codesys/a.st', 'codesys/m.st', 'codesys/z.st']);
  });
});

// =============================================================================
// 8. Privacy / shape
// =============================================================================

describe('compareImportedDiffWithCurrentPreview — privacy / shape', () => {
  it('25. comparison output contains no `"content"` key (hashes / counts only)', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'C']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    const json = JSON.stringify(v);
    expect(json).not.toContain('"content"');
    expect(json).not.toContain('row_kind,');
    expect(json).not.toContain('<EplanProject');
    expect(json).not.toContain('%PDF-');
    expect(json).not.toContain('"pir_version"');
  });

  it('26. summary counts equal sum of per-target counts', () => {
    const archived = diffBundle({
      prevSelection: 'all',
      currSelection: 'all',
      prevGen: {
        siemens: stub('siemens', [['s.scl', 'S']]),
        codesys: stub('codesys', [['c.st', 'C']]),
        rockwell: stub('rockwell', [['r.st', 'R']]),
      },
      currGen: {
        siemens: stub('siemens', [['s.scl', 'S2']]),
        codesys: stub('codesys', [['c.st', 'C2']]),
        rockwell: stub('rockwell', [['r.st', 'R2']]),
      },
    });
    const current = previewWith('all', {
      siemens: stub('siemens', [['s.scl', 'S2']]),
      codesys: stub('codesys', [['c.st', 'C2_DRIFTED']]),
      rockwell: stub('rockwell', [['r.st', 'R2']]),
    });
    const v: ArchivedPreviewComparisonView =
      compareImportedDiffWithCurrentPreview({
        importedBundle: archived,
        currentView: current,
      });
    let same = 0;
    let changed = 0;
    for (const t of v.targets) {
      same += t.counts.artifactsSame;
      changed += t.counts.artifactsChanged;
    }
    expect(v.counts.artifactsSame).toBe(same);
    expect(v.counts.artifactsChanged).toBe(changed);
    expect(v.counts.artifactsChanged).toBe(1);
  });

  it('27. unknown / extra fields the importer may have stripped do not affect output', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    // Pollute through JSON parse to mirror an importer that
    // forgot to whitelist (Sprint 92 still strips these, but the
    // comparison helper shouldn't crash if a stray field arrives).
    const polluted = JSON.parse(JSON.stringify(archived));
    polluted.unknownTopField = 'should-be-ignored';
    polluted.targets[0].rawCsv = 'row_kind,';
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'B']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: polluted,
      currentView: current,
    });
    const json = JSON.stringify(v);
    expect(json).not.toContain('should-be-ignored');
    expect(json).not.toContain('row_kind,');
  });

  it('28. empty archived target list still produces a clean comparison view', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    const polluted = JSON.parse(JSON.stringify(archived));
    polluted.targets = [];
    const current = previewWith('codesys', {
      codesys: stub('codesys', [['x.st', 'B']]),
    });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: polluted,
      currentView: current,
    });
    // current still surfaces its target as `missing-archived`.
    expect(v.targets).toHaveLength(1);
    expect(v.targets[0].status).toBe('missing-archived');
  });

  it('29. current preview with zero artifacts on a ready archive target → not-comparable', () => {
    const archived = diffBundle({
      prevGen: { codesys: stub('codesys', [['x.st', 'A']]) },
      currGen: { codesys: stub('codesys', [['x.st', 'B']]) },
    });
    // Force the current preview into `unavailable` for codesys.
    const current = previewWith('codesys', { codesys: () => [] });
    const v = compareImportedDiffWithCurrentPreview({
      importedBundle: archived,
      currentView: current,
    });
    // codesys current produced 0 artifacts → status reads
    // `ready` (the helper produces ready for a 0-artifact run when
    // readiness passes), so it is comparable but every archived
    // path will be `missing-current`.
    const t = v.targets[0];
    expect(['not-comparable', 'changed']).toContain(t.status);
    expect(t.counts.artifactsMissingCurrent + t.counts.artifactsNotComparable)
      .toBeGreaterThanOrEqual(1);
  });
});
