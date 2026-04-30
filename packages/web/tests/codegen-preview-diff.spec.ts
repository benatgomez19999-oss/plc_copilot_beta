// Sprint 90B — pure tests for the codegen preview diff helper.
//
// The Sprint 89/90A panel + download bundle stay green; this spec
// only exercises the new diff helper, which compares two
// already-projected `CodegenPreviewView`s without re-running the
// vendor pipeline.
//
// What we pin here:
//   - null / missing inputs → meaningful "no-baseline / no-current
//     / no-inputs" states (never crashes, never invents content).
//   - identical previews → unchanged, with zeroed counts.
//   - artifact added / removed / changed / unchanged.
//   - target added / removed / status_changed / artifacts_changed
//     / diagnostics_changed / unchanged.
//   - manifest diagnostics added / removed / deduped on
//     severity+code+message+path+hint.
//   - deterministic sort across targets (siemens → codesys →
//     rockwell) and within targets by path / code.
//   - artifact content compared on the FULL `content` field, not
//     the truncated `previewText`.
//   - per-artifact textual diff respects the line cap and byte
//     cap; truncated flag is honest.
//   - helper does not mutate inputs; two calls produce byte-equal
//     output.
//   - bundle text never carries raw source bytes (privacy).
//   - selection mismatch is surfaced via `selectionMatch: false`
//     instead of being silently treated as identical.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import { CodegenError } from '@plccopilot/codegen-core';

import {
  buildCodegenPreviewView,
  type CodegenPreviewView,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINES,
} from '../src/utils/codegen-preview-view.js';
import {
  buildCodegenPreviewDiff,
  deterministicContentHash,
  MAX_DIFF_LINES_PER_ARTIFACT,
  MAX_DIFF_BYTES_PER_ARTIFACT,
  summarizeCodegenPreviewDiff,
} from '../src/utils/codegen-preview-diff.js';

// ---------------------------------------------------------------------------
// Fixtures (mirror Sprint 90A's stub style — no real PIR machinery)
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

function stubGenerator(
  prefix: string,
  files: ReadonlyArray<readonly [string, string]>,
  manifestDiags: GeneratedArtifact['diagnostics'] = undefined,
): (p: Project) => GeneratedArtifact[] {
  return () => {
    const arts = files.map(([p, c]) => makeArtifact(`${prefix}/${p}`, c));
    if (manifestDiags && arts.length > 0) {
      arts[arts.length - 1] = {
        ...arts[arts.length - 1],
        diagnostics: manifestDiags,
      };
    }
    return arts;
  };
}

function previewWith(
  selection: 'codesys' | 'siemens' | 'rockwell' | 'all',
  generators: Parameters<typeof buildCodegenPreviewView>[0]['generators'],
  project: Project = happyProject(),
): CodegenPreviewView {
  return buildCodegenPreviewView({ project, selection, generators });
}

// =============================================================================
// 1. Null / missing inputs
// =============================================================================

describe('buildCodegenPreviewDiff — null / missing inputs', () => {
  it('1. both null → no-inputs state, zero counts, neutral headline', () => {
    const diff = buildCodegenPreviewDiff(null, null);
    expect(diff.state).toBe('no-inputs');
    expect(diff.targets).toEqual([]);
    expect(diff.summary).toMatchObject({
      targetsTotal: 0,
      targetsChanged: 0,
      artifactsAdded: 0,
      artifactsRemoved: 0,
      artifactsChanged: 0,
    });
    expect(diff.headline).toBe('No previews to compare.');
  });

  it('2. baseline null + current ready → no-baseline state', () => {
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const diff = buildCodegenPreviewDiff(null, current);
    expect(diff.state).toBe('no-baseline');
    expect(diff.targets).toEqual([]);
    expect(diff.headline).toBe('No previous preview to compare yet.');
    expect(diff.currentSelection).toBe('codesys');
    expect(diff.previousSelection).toBeUndefined();
  });

  it('3. baseline ready + current null → no-current state', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const diff = buildCodegenPreviewDiff(previous, null);
    expect(diff.state).toBe('no-current');
    expect(diff.previousSelection).toBe('codesys');
  });
});

// =============================================================================
// 2. Identity / unchanged
// =============================================================================

describe('buildCodegenPreviewDiff — unchanged', () => {
  it('4. identical previews → unchanged, zero changed counts', () => {
    const a = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'CONTENT']]),
    });
    const b = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'CONTENT']]),
    });
    const diff = buildCodegenPreviewDiff(a, b);
    expect(diff.state).toBe('unchanged');
    expect(diff.targets).toHaveLength(1);
    expect(diff.targets[0].status).toBe('unchanged');
    expect(diff.summary.artifactsChanged).toBe(0);
    expect(diff.summary.artifactsAdded).toBe(0);
    expect(diff.summary.artifactsRemoved).toBe(0);
    expect(diff.summary.artifactsUnchanged).toBe(1);
    expect(diff.headline).toBe('No changes from previous preview.');
  });
});

// =============================================================================
// 3. Artifact-level diffs
// =============================================================================

describe('buildCodegenPreviewDiff — artifact diffs', () => {
  it('5. artifact added between previews', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['x.st', 'X'],
        ['y.st', 'Y'],
      ]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    expect(diff.state).toBe('changed');
    const t = diff.targets[0];
    expect(t.status).toBe('artifacts_changed');
    const added = t.artifacts.find((a) => a.status === 'added');
    expect(added?.path).toBe('codesys/y.st');
    expect(added?.currentSizeBytes).toBe(1);
    expect(added?.previousSizeBytes).toBeUndefined();
  });

  it('6. artifact removed between previews', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['x.st', 'X'],
        ['y.st', 'Y'],
      ]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    const t = diff.targets[0];
    const removed = t.artifacts.find((a) => a.status === 'removed');
    expect(removed?.path).toBe('codesys/y.st');
    expect(removed?.previousSizeBytes).toBe(1);
    expect(removed?.currentSizeBytes).toBeUndefined();
  });

  it('7. artifact changed → status=changed, diff sample populated, hashes differ', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'A\nB\nC\n']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'A\nB\nD\n']]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    const t = diff.targets[0];
    const changed = t.artifacts.find((a) => a.status === 'changed');
    expect(changed).toBeDefined();
    expect(changed!.previousHash).not.toBe(changed!.currentHash);
    expect(changed!.diff).toBeDefined();
    expect(changed!.diff!.firstDifferingLine).toBe(3);
    const removedLines = changed!.diff!.lines.filter(
      (l) => l.status === 'removed',
    );
    const addedLines = changed!.diff!.lines.filter(
      (l) => l.status === 'added',
    );
    expect(removedLines.map((l) => l.text)).toContain('C');
    expect(addedLines.map((l) => l.text)).toContain('D');
  });

  it('8. artifact unchanged carries identical hash + no diff sample', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'CONTENT']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'CONTENT']]),
    });
    const t = buildCodegenPreviewDiff(previous, current).targets[0];
    const a = t.artifacts[0];
    expect(a.status).toBe('unchanged');
    expect(a.previousHash).toBe(a.currentHash);
    expect(a.diff).toBeUndefined();
  });
});

// =============================================================================
// 4. Target-level diffs
// =============================================================================

describe('buildCodegenPreviewDiff — target-level transitions', () => {
  it('9. target added (was missing in baseline)', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('all', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
      siemens: stubGenerator('siemens', [['s.scl', 'S']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    const siemens = diff.targets.find((t) => t.target === 'siemens');
    expect(siemens?.status).toBe('added');
    expect(siemens?.previousStatus).toBeUndefined();
    expect(siemens?.counts.artifactsAdded).toBe(1);
  });

  it('10. target removed (was present in baseline only)', () => {
    const previous = previewWith('all', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
      siemens: stubGenerator('siemens', [['s.scl', 'S']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    const siemens = diff.targets.find((t) => t.target === 'siemens');
    expect(siemens?.status).toBe('removed');
    expect(siemens?.counts.artifactsRemoved).toBe(1);
  });

  it('11. target status changed ready → failed', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('codesys', {
      codesys: () => {
        throw new CodegenError('INTERNAL_ERROR', 'boom');
      },
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    const t = diff.targets[0];
    expect(t.status).toBe('status_changed');
    expect(t.previousStatus).toBe('ready');
    expect(t.currentStatus).toBe('failed');
  });
});

// =============================================================================
// 5. Manifest diagnostics
// =============================================================================

describe('buildCodegenPreviewDiff — manifest diagnostics', () => {
  it('12. diagnostic added between previews', () => {
    const previous = previewWith('rockwell', {
      rockwell: stubGenerator('rockwell', [['x.st', 'X']]),
    });
    const current = previewWith('rockwell', {
      rockwell: stubGenerator(
        'rockwell',
        [['x.st', 'X']],
        [
          {
            severity: 'warning',
            code: 'NEW_WARNING',
            message: 'new',
          },
        ],
      ),
    });
    const t = buildCodegenPreviewDiff(previous, current).targets[0];
    expect(t.counts.diagnosticsAdded).toBe(1);
    expect(t.counts.diagnosticsRemoved).toBe(0);
    expect(t.diagnostics[0].status).toBe('added');
    expect(t.diagnostics[0].diagnostic.code).toBe('NEW_WARNING');
  });

  it('13. diagnostic removed between previews', () => {
    const previous = previewWith('rockwell', {
      rockwell: stubGenerator(
        'rockwell',
        [['x.st', 'X']],
        [
          {
            severity: 'warning',
            code: 'OLD_WARNING',
            message: 'old',
          },
        ],
      ),
    });
    const current = previewWith('rockwell', {
      rockwell: stubGenerator('rockwell', [['x.st', 'X']]),
    });
    const t = buildCodegenPreviewDiff(previous, current).targets[0];
    expect(t.counts.diagnosticsRemoved).toBe(1);
    expect(t.diagnostics[0].status).toBe('removed');
  });

  it('14. duplicate diagnostics on the current side dedupe before diffing', () => {
    const dup = {
      severity: 'warning' as const,
      code: 'DUPE',
      message: 'd',
      hint: 'h',
    };
    const previous = previewWith('rockwell', {
      rockwell: stubGenerator('rockwell', [['x.st', 'X']]),
    });
    const current = previewWith('rockwell', {
      rockwell: stubGenerator(
        'rockwell',
        [
          ['x.st', 'X'],
          ['y.st', 'Y'],
        ],
        [dup, dup],
      ),
    });
    const t = buildCodegenPreviewDiff(previous, current).targets[0];
    // Only one DUPE diagnostic flows in even though it appears twice.
    const codes = t.diagnostics.map((d) => d.diagnostic.code);
    expect(codes.filter((c) => c === 'DUPE')).toHaveLength(1);
  });
});

// =============================================================================
// 6. Stable ordering
// =============================================================================

describe('buildCodegenPreviewDiff — deterministic sort', () => {
  it('15. targets land in display order siemens → codesys → rockwell', () => {
    const previous = previewWith('all', {
      siemens: stubGenerator('siemens', [['s.scl', 'S']]),
      codesys: stubGenerator('codesys', [['c.st', 'C']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
    });
    const current = previewWith('all', {
      siemens: stubGenerator('siemens', [['s.scl', 'S']]),
      codesys: stubGenerator('codesys', [['c.st', 'C']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    expect(diff.targets.map((t) => t.target)).toEqual([
      'siemens',
      'codesys',
      'rockwell',
    ]);
  });

  it('16. backend-all mixed ready / blocked still diffs per target without leaking', () => {
    const baseProject = happyProject();
    const blockedProject = happyProject();
    (blockedProject.machines[0].stations[0].equipment[0].type as string) =
      'pneumatic_cylinder_1pos';

    const previous = previewWith(
      'all',
      {
        siemens: stubGenerator('siemens', [['s.scl', 'S1']]),
        codesys: stubGenerator('codesys', [['c.st', 'C1']]),
        rockwell: stubGenerator('rockwell', [['r.st', 'R1']]),
      },
      baseProject,
    );
    const current = previewWith(
      'all',
      {
        // The blocked-readiness path means generators are short-
        // circuited regardless of stub; we still sanity-check the
        // diff doesn't fabricate artifacts on blocked targets.
        siemens: () => [],
        codesys: () => [],
        rockwell: () => [],
      },
      blockedProject,
    );
    const diff = buildCodegenPreviewDiff(previous, current);
    expect(diff.targets).toHaveLength(3);
    for (const t of diff.targets) {
      // status_changed because previous=ready, current=blocked.
      expect(t.status).toBe('status_changed');
      expect(t.currentStatus).toBe('blocked');
      // No fabricated changed artifacts on the blocked side.
      const fabricated = t.artifacts.filter((a) => a.status === 'changed');
      expect(fabricated).toHaveLength(0);
      // Previous artifacts surface as `removed`.
      expect(t.counts.artifactsRemoved).toBe(1);
    }
  });
});

// =============================================================================
// 7. Content fidelity (full content, not snippet)
// =============================================================================

describe('buildCodegenPreviewDiff — content fidelity & truncation', () => {
  it('17. content diff uses the full Sprint 90A `content`, not the truncated snippet', () => {
    // Build content longer than the Sprint 89 snippet cap so the
    // helper can only see the difference if it reads `content`.
    const tail = 'TAIL_LINE_DIFFERS_HERE';
    const prevContent =
      Array.from(
        { length: MAX_PREVIEW_LINES + 5 },
        (_, i) => `LINE_${i}`,
      ).join('\n') + '\nPREV_TAIL';
    const currContent =
      Array.from(
        { length: MAX_PREVIEW_LINES + 5 },
        (_, i) => `LINE_${i}`,
      ).join('\n') + '\n' + tail;
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', prevContent]]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', currContent]]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    const changed = diff.targets[0].artifacts.find(
      (a) => a.status === 'changed',
    );
    expect(changed).toBeDefined();
    // Hashes differ because the FULL contents differ — the snippet
    // would have collapsed both contents to identical truncated text.
    expect(changed!.previousHash).not.toBe(changed!.currentHash);
    const addedLines = changed!.diff!.lines.filter(
      (l) => l.status === 'added',
    );
    expect(addedLines.map((l) => l.text)).toContain(tail);
  });

  it('18. textual diff truncates by line cap, marks truncated:true', () => {
    // Force a small line cap so two well-spaced changes overflow.
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['x.st', Array.from({ length: 200 }, (_, i) => `OLD_${i}`).join('\n')],
      ]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['x.st', Array.from({ length: 200 }, (_, i) => `NEW_${i}`).join('\n')],
      ]),
    });
    const diff = buildCodegenPreviewDiff(previous, current, {
      maxDiffLinesPerArtifact: 8,
    });
    const changed = diff.targets[0].artifacts[0];
    expect(changed.status).toBe('changed');
    expect(changed.diff!.truncated).toBe(true);
    expect(changed.diff!.lines.length).toBeLessThanOrEqual(8);
  });

  it('19. textual diff truncates by byte cap', () => {
    const big = 'X'.repeat(2_000);
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['x.st', `${big}\nOLD_TAIL`],
      ]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['x.st', `${big}\nNEW_TAIL_LINE`],
      ]),
    });
    const diff = buildCodegenPreviewDiff(previous, current, {
      // Generous line cap, tight byte cap → byte path is the one
      // that fires.
      maxDiffLinesPerArtifact: 1_000,
      maxDiffBytesPerArtifact: 64,
    });
    const changed = diff.targets[0].artifacts[0];
    expect(changed.diff!.truncated).toBe(true);
  });

  it('20. caps are realistic defaults (helper-exported constants)', () => {
    expect(MAX_DIFF_LINES_PER_ARTIFACT).toBe(80);
    expect(MAX_DIFF_BYTES_PER_ARTIFACT).toBe(8 * 1024);
  });
});

// =============================================================================
// 8. Determinism, immutability, privacy
// =============================================================================

describe('buildCodegenPreviewDiff — determinism, immutability, privacy', () => {
  it('21. helper does not mutate the input views (deep-equal before/after)', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'OLD']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'NEW']]),
    });
    const before = JSON.stringify({ previous, current });
    buildCodegenPreviewDiff(previous, current);
    const after = JSON.stringify({ previous, current });
    expect(after).toBe(before);
  });

  it('22. two calls on the same inputs produce byte-identical JSON', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'OLD']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'NEW']]),
    });
    const a = JSON.stringify(buildCodegenPreviewDiff(previous, current));
    const b = JSON.stringify(buildCodegenPreviewDiff(previous, current));
    expect(a).toBe(b);
  });

  it('23. diff serialisation contains no raw source markers', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'OLD']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'NEW']]),
    });
    const text = JSON.stringify(buildCodegenPreviewDiff(previous, current));
    expect(text).not.toContain('row_kind,');
    expect(text).not.toContain('<EplanProject');
    expect(text).not.toContain('<TcecadProject');
    expect(text).not.toContain('%PDF-');
    expect(text).not.toContain('"pir_version"');
  });

  it('24. selection mismatch is surfaced honestly (not silently identical)', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('all', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
      siemens: stubGenerator('siemens', [['s.scl', 'S']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    expect(diff.selectionMatch).toBe(false);
    expect(diff.previousSelection).toBe('codesys');
    expect(diff.currentSelection).toBe('all');
    // Even though the codesys side is identical, the panel still
    // sees siemens + rockwell as added — i.e. honest.
    expect(diff.summary.targetsChanged).toBeGreaterThan(0);
  });

  it('25. summarizeCodegenPreviewDiff matches the inline summary', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['x.st', 'X'],
        ['y.st', 'Y'],
      ]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    expect(summarizeCodegenPreviewDiff(diff)).toEqual(diff.summary);
  });

  it('26. deterministicContentHash is stable + sensitive to byte changes', () => {
    expect(deterministicContentHash('a')).toBe(deterministicContentHash('a'));
    expect(deterministicContentHash('a')).not.toBe(
      deterministicContentHash('b'),
    );
    // Sanity — non-empty hash for a non-empty string.
    expect(deterministicContentHash('x')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('27. content above MAX_PREVIEW_BYTES still hashes & diffs without crashing', () => {
    const huge = 'X'.repeat(MAX_PREVIEW_BYTES + 256);
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', huge]]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', `${huge}\nDIFF`]]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    const changed = diff.targets[0].artifacts[0];
    expect(changed.status).toBe('changed');
    expect(changed.previousHash).not.toBe(changed.currentHash);
  });
});
