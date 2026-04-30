// Sprint 91 — pure tests for the codegen preview diff download
// bundle helpers. The Sprint 89/90A/90B helpers stay green; this
// spec exercises the new diff bundle helper, which serialises the
// already-computed Sprint 90B diff into a small auditable JSON
// the operator saves locally.
//
// What we pin here:
//   - downloadability gate (null / no-baseline / no-current /
//     stale / failed-current views are NOT downloadable).
//   - bundle shape (kind + version + selection + counts +
//     per-target rows + state mapping).
//   - bundle is a *diff archive*, not an *artifact archive*: full
//     artifact content never leaks past Sprint 90B's already-
//     capped diff sample; unchanged artifacts are omitted.
//   - artifact + diagnostic ordering deterministic across
//     backend `'all'`.
//   - selection mismatch surfaced honestly (selectionMatch:false).
//   - filename helper deterministic; snapshot name sanitiser
//     reduces free-form input to a filesystem-safe slug.
//   - helper does NOT mutate the input views, two calls yield
//     byte-identical JSON.
//   - privacy negative assertions: bundle text contains no
//     row_kind, no <EplanProject, no <TcecadProject, no %PDF-,
//     no `pir_version`.

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
  CODEGEN_PREVIEW_DIFF_BUNDLE_KIND,
  CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION,
  buildCodegenPreviewDiffBundle,
  createCodegenPreviewDiffFilename,
  isPreviewDiffDownloadable,
  sanitizePreviewDiffSnapshotName,
  serializeCodegenPreviewDiffBundle,
} from '../src/utils/codegen-preview-diff-download.js';
import {
  buildCodegenPreviewDiff,
} from '../src/utils/codegen-preview-diff.js';

// ---------------------------------------------------------------------------
// Fixtures (mirror Sprint 90A/90B)
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
// 1. isPreviewDiffDownloadable gate
// =============================================================================

describe('isPreviewDiffDownloadable', () => {
  it('1. both null → not downloadable', () => {
    expect(
      isPreviewDiffDownloadable({
        previousView: null,
        currentView: null,
        stale: false,
      }),
    ).toBe(false);
  });

  it('2. no baseline → not downloadable', () => {
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    expect(
      isPreviewDiffDownloadable({
        previousView: null,
        currentView: current,
        stale: false,
      }),
    ).toBe(false);
  });

  it('3. no current → not downloadable', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    expect(
      isPreviewDiffDownloadable({
        previousView: previous,
        currentView: null,
        stale: false,
      }),
    ).toBe(false);
  });

  it('4. stale view → not downloadable', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'OLD']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'NEW']]),
    });
    expect(
      isPreviewDiffDownloadable({
        previousView: previous,
        currentView: current,
        stale: true,
      }),
    ).toBe(false);
  });

  it('5. current view is failed → not downloadable', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('codesys', {
      codesys: () => {
        throw new CodegenError('INTERNAL_ERROR', 'boom');
      },
    });
    expect(
      isPreviewDiffDownloadable({
        previousView: previous,
        currentView: current,
        stale: false,
      }),
    ).toBe(false);
  });

  it('6. current view all-blocked → not downloadable', () => {
    const previous = previewWith('all', {
      siemens: stubGenerator('siemens', [['s.scl', 'S']]),
      codesys: stubGenerator('codesys', [['c.st', 'C']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
    });
    const blockedProject = happyProject();
    (blockedProject.machines[0].stations[0].equipment[0].type as string) =
      'pneumatic_cylinder_1pos';
    const current = previewWith(
      'all',
      {
        siemens: () => [],
        codesys: () => [],
        rockwell: () => [],
      },
      blockedProject,
    );
    expect(
      isPreviewDiffDownloadable({
        previousView: previous,
        currentView: current,
        stale: false,
      }),
    ).toBe(false);
  });

  it('7. unchanged diff with both sides successful → downloadable', () => {
    const a = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'CONTENT']]),
    });
    const b = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'CONTENT']]),
    });
    expect(
      isPreviewDiffDownloadable({
        previousView: a,
        currentView: b,
        stale: false,
      }),
    ).toBe(true);
  });

  it('8. changed diff with both sides successful → downloadable', () => {
    const a = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'OLD']]),
    });
    const b = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'NEW']]),
    });
    expect(
      isPreviewDiffDownloadable({
        previousView: a,
        currentView: b,
        stale: false,
      }),
    ).toBe(true);
  });
});

// =============================================================================
// 2. buildCodegenPreviewDiffBundle — happy paths
// =============================================================================

describe('buildCodegenPreviewDiffBundle — happy paths', () => {
  it('9. unchanged bundle: state=unchanged, zero counts, kind+version pinned', () => {
    const a = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'C']]),
    });
    const b = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'C']]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: a,
      currentView: b,
    });
    expect(bundle.kind).toBe(CODEGEN_PREVIEW_DIFF_BUNDLE_KIND);
    expect(bundle.version).toBe(CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION);
    expect(bundle.state).toBe('unchanged');
    expect(bundle.counts).toMatchObject({
      targetsCompared: 1,
      targetsChanged: 0,
      artifactsAdded: 0,
      artifactsRemoved: 0,
      artifactsChanged: 0,
      diagnosticsChanged: 0,
    });
    expect(bundle.targets[0].state).toBe('unchanged');
    // Diff archive — unchanged artifacts are omitted from
    // artifactChanges to keep the bundle lean.
    expect(bundle.targets[0].artifactChanges).toHaveLength(0);
  });

  it('10. changed bundle records added / removed / changed paths', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['keep.st', 'K'],
        ['drop.st', 'D'],
      ]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['keep.st', 'K_NEW'],
        ['add.st', 'A'],
      ]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    expect(bundle.state).toBe('changed');
    const target = bundle.targets[0];
    expect(target.state).toBe('changed');
    const paths = target.artifactChanges.map((a) => a.path);
    // Sorted by path within the target.
    expect(paths).toEqual(['codesys/add.st', 'codesys/drop.st', 'codesys/keep.st']);
    const byPath = Object.fromEntries(
      target.artifactChanges.map((a) => [a.path, a.status]),
    );
    expect(byPath['codesys/add.st']).toBe('added');
    expect(byPath['codesys/drop.st']).toBe('removed');
    expect(byPath['codesys/keep.st']).toBe('changed');
  });

  it('11. backend "all" with mixed targets keeps target order siemens → codesys → rockwell', () => {
    const previous = previewWith('all', {
      siemens: stubGenerator('siemens', [['s.scl', 'S1']]),
      codesys: stubGenerator('codesys', [['c.st', 'C1']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R1']]),
    });
    const current = previewWith('all', {
      siemens: stubGenerator('siemens', [['s.scl', 'S2']]),
      codesys: stubGenerator('codesys', [['c.st', 'C1']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R2']]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    expect(bundle.targets.map((t) => t.target)).toEqual([
      'siemens',
      'codesys',
      'rockwell',
    ]);
    expect(bundle.counts.targetsCompared).toBe(3);
    expect(bundle.counts.targetsChanged).toBe(2);
    expect(
      bundle.targets.find((t) => t.target === 'codesys')!.state,
    ).toBe('unchanged');
  });

  it('12. selectionMatch=false reflected in bundle when backends differ', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('all', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
      siemens: stubGenerator('siemens', [['s.scl', 'S']]),
      rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    expect(bundle.selection.backend).toBe('all');
    expect(bundle.selection.previousBackend).toBe('codesys');
    expect(bundle.selection.selectionMatch).toBe(false);
    // Honest record: siemens + rockwell come in as 'added' targets.
    const siemens = bundle.targets.find((t) => t.target === 'siemens')!;
    expect(siemens.targetStatus).toBe('added');
    expect(siemens.state).toBe('changed');
  });

  it('13. counts match Sprint 90B summary', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['keep.st', 'K'],
        ['drop.st', 'D'],
      ]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['keep.st', 'K_NEW'],
        ['add.st', 'A'],
      ]),
    });
    const diff = buildCodegenPreviewDiff(previous, current);
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    expect(bundle.counts.artifactsAdded).toBe(diff.summary.artifactsAdded);
    expect(bundle.counts.artifactsRemoved).toBe(diff.summary.artifactsRemoved);
    expect(bundle.counts.artifactsChanged).toBe(diff.summary.artifactsChanged);
    expect(bundle.counts.diagnosticsChanged).toBe(
      diff.summary.diagnosticsAdded + diff.summary.diagnosticsRemoved,
    );
  });

  it('14. status_changed target preserves previousStatus + currentStatus', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('codesys', {
      codesys: () => {
        throw new CodegenError('INTERNAL_ERROR', 'boom');
      },
    });
    // Diff helper still runs even though the *current view* is
    // failed; the gate above guards the panel from offering a
    // download in that case. We exercise the bundle's faithfulness
    // here — the bundle records the transition rather than
    // fabricating artifact diffs.
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    const t = bundle.targets[0];
    expect(t.targetStatus).toBe('status_changed');
    expect(t.previousStatus).toBe('ready');
    expect(t.currentStatus).toBe('failed');
    // No fabricated 'changed' artifact rows on a failed target.
    expect(
      t.artifactChanges.filter((a) => a.status === 'changed'),
    ).toHaveLength(0);
  });
});

// =============================================================================
// 3. Diagnostic + sample fidelity
// =============================================================================

describe('buildCodegenPreviewDiffBundle — diagnostics + samples', () => {
  it('15. diagnostic added/removed surface with severity + code + message', () => {
    const previous = previewWith('rockwell', {
      rockwell: stubGenerator(
        'rockwell',
        [['x.st', 'X']],
        [
          {
            severity: 'warning',
            code: 'OLD',
            message: 'old',
          },
        ],
      ),
    });
    const current = previewWith('rockwell', {
      rockwell: stubGenerator(
        'rockwell',
        [['x.st', 'X']],
        [
          {
            severity: 'warning',
            code: 'NEW',
            message: 'new',
          },
        ],
      ),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    const t = bundle.targets[0];
    const diags = t.diagnosticChanges.map(
      (d) => `${d.status}|${d.severity}|${d.code}|${d.message}`,
    );
    expect(diags).toContain('removed|warning|OLD|old');
    expect(diags).toContain('added|warning|NEW|new');
  });

  it('16. duplicate diagnostics from Sprint 90B dedup survive into the bundle', () => {
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
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    const codes = bundle.targets[0].diagnosticChanges
      .filter((d) => d.code === 'DUPE')
      .map((d) => d.code);
    expect(codes).toHaveLength(1);
  });

  it('17. changed artifact carries the Sprint 90B-capped diff sample, not full content', () => {
    // Build a content much larger than the diff cap. Sprint 90B
    // already truncates the sample at 80 lines / 8 KB; the bundle
    // must inherit that cap.
    const longTail =
      Array.from({ length: 500 }, (_, i) => `OLD_${i}`).join('\n');
    const longTailNew =
      Array.from({ length: 500 }, (_, i) => `NEW_${i}`).join('\n');
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', longTail]]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', longTailNew]]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    const a = bundle.targets[0].artifactChanges[0];
    expect(a.status).toBe('changed');
    expect(a.diff).toBeDefined();
    // No way the full 500-line content survives — the diff sample
    // is bounded by the Sprint 90B caps.
    expect(a.diff!.lines.length).toBeLessThanOrEqual(80);
    // The bundle never carries a `content` field — sanity-check
    // that lines past the cap (e.g. line 200) never made it into
    // the serialised bundle.
    const json = JSON.stringify(bundle);
    expect(json.includes('OLD_300')).toBe(false);
    expect(json.includes('NEW_300')).toBe(false);
    // And no `"content":` field key anywhere, since the diff
    // archive deliberately omits Sprint 90A's full-content field.
    expect(json.includes('"content"')).toBe(false);
  });

  it('18. unchanged artifacts are omitted from artifactChanges (diff archive, not artifact archive)', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['keep.st', 'K'],
        ['edit.st', 'OLD'],
      ]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [
        ['keep.st', 'K'],
        ['edit.st', 'NEW'],
      ]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    const paths = bundle.targets[0].artifactChanges.map((a) => a.path);
    expect(paths).toEqual(['codesys/edit.st']);
    expect(paths).not.toContain('codesys/keep.st');
  });
});

// =============================================================================
// 4. Filename + snapshot name sanitisation
// =============================================================================

describe('createCodegenPreviewDiffFilename', () => {
  it('19. default snapshot name omits the suffix', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    expect(bundle.snapshotName).toBe('diff');
    expect(createCodegenPreviewDiffFilename(bundle)).toBe(
      'plc-copilot-codegen-preview-diff-codesys.json',
    );
  });

  it('20. custom snapshot name lands in the filename, sanitised', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'X']]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
      snapshotName: '  Pre/Prod  Review v2 ',
    });
    expect(bundle.snapshotName).toBe('pre-prod-review-v2');
    expect(createCodegenPreviewDiffFilename(bundle)).toBe(
      'plc-copilot-codegen-preview-diff-codesys-pre-prod-review-v2.json',
    );
  });

  it('21. sanitizePreviewDiffSnapshotName collapses runs and drops unsafe chars', () => {
    expect(sanitizePreviewDiffSnapshotName(' Hello,  World!! ')).toBe(
      'hello-world',
    );
    expect(sanitizePreviewDiffSnapshotName('--..--')).toBe('');
    expect(sanitizePreviewDiffSnapshotName(undefined)).toBe('');
    expect(sanitizePreviewDiffSnapshotName(null as unknown as string)).toBe('');
    // Length cap: >64 chars should be truncated.
    const long = 'a'.repeat(200);
    expect(sanitizePreviewDiffSnapshotName(long)).toHaveLength(64);
  });
});

// =============================================================================
// 5. Determinism, immutability, privacy
// =============================================================================

describe('buildCodegenPreviewDiffBundle — determinism, immutability, privacy', () => {
  it('22. helper does not mutate the input views (deep-equal before/after)', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'OLD']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'NEW']]),
    });
    const before = JSON.stringify({ previous, current });
    buildCodegenPreviewDiffBundle({ previousView: previous, currentView: current });
    const after = JSON.stringify({ previous, current });
    expect(after).toBe(before);
  });

  it('23. two builds on the same inputs yield byte-identical JSON', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'OLD']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'NEW']]),
    });
    const a = serializeCodegenPreviewDiffBundle(
      buildCodegenPreviewDiffBundle({ previousView: previous, currentView: current }),
    );
    const b = serializeCodegenPreviewDiffBundle(
      buildCodegenPreviewDiffBundle({ previousView: previous, currentView: current }),
    );
    expect(a).toBe(b);
  });

  it('24. serialised bundle contains no raw source markers and no PIR fields', () => {
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'OLD']]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', 'NEW']]),
    });
    const text = serializeCodegenPreviewDiffBundle(
      buildCodegenPreviewDiffBundle({ previousView: previous, currentView: current }),
    );
    expect(text).not.toContain('row_kind,');
    expect(text).not.toContain('<EplanProject');
    expect(text).not.toContain('<TcecadProject');
    expect(text).not.toContain('%PDF-');
    expect(text).not.toContain('"pir_version"');
  });

  it('25. oversized content well past the diff byte cap does not survive into the bundle', () => {
    // 12 KB single line — overshoots both `MAX_PREVIEW_BYTES`
    // (4 KB) and the Sprint 90B diff byte cap
    // (`MAX_DIFF_BYTES_PER_ARTIFACT` = 8 KB), so the line is
    // dropped from the diff sample with `truncated: true`.
    const huge = 'X'.repeat(12 * 1024);
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', `${huge}\nOLD_TAIL`]]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', `${huge}\nNEW_TAIL`]]),
    });
    const text = serializeCodegenPreviewDiffBundle(
      buildCodegenPreviewDiffBundle({ previousView: previous, currentView: current }),
    );
    // The huge single line never lands verbatim — it overshoots
    // the diff byte cap and is dropped.
    expect(text.includes(huge)).toBe(false);
    // No `"content":` key anywhere — the Sprint 90A full-content
    // field is deliberately omitted from the diff bundle.
    expect(text.includes('"content"')).toBe(false);
  });

  it('26. snippet from Sprint 89 cap is irrelevant — diff still uses the FULL content', () => {
    // Two views whose previewText snippets would collapse to
    // identical truncated text, but whose full content differs in
    // a single trailing line. The bundle must still see the
    // change.
    const tail = 'DIFFERENT_TAIL';
    const prev =
      Array.from(
        { length: MAX_PREVIEW_LINES + 5 },
        (_, i) => `LINE_${i}`,
      ).join('\n') + '\nPREV_TAIL';
    const curr =
      Array.from(
        { length: MAX_PREVIEW_LINES + 5 },
        (_, i) => `LINE_${i}`,
      ).join('\n') + '\n' + tail;
    const previous = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', prev]]),
    });
    const current = previewWith('codesys', {
      codesys: stubGenerator('codesys', [['x.st', curr]]),
    });
    const bundle = buildCodegenPreviewDiffBundle({
      previousView: previous,
      currentView: current,
    });
    expect(bundle.state).toBe('changed');
    const a = bundle.targets[0].artifactChanges[0];
    expect(a.status).toBe('changed');
    expect(a.diff!.lines.some((l) => l.text === tail)).toBe(true);
  });
});
