// Sprint 90A — pure tests for the codegen preview download bundle
// helpers. The Sprint 89 panel is a thin renderer; the download
// behaviour the operator depends on lives in this helper:
//
//   - downloadability gate (idle / unavailable / blocked / failed
//     / stale views are NOT downloadable),
//   - bundle shape (kind + version + selection + per-target rows),
//   - full artifact content (no UI 40-line / 4-KB cap),
//   - blocked / failed / unavailable targets land in the manifest
//     with empty `artifacts` arrays — never fabricated content,
//   - artifact ordering deterministic by path,
//   - manifest diagnostics deduped + preserved verbatim,
//   - filename helper deterministic (no timestamp),
//   - helper does NOT mutate the input view, runs deterministic
//     across two invocations.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import { CodegenError } from '@plccopilot/codegen-core';

import {
  buildCodegenPreviewView,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINES,
} from '../src/utils/codegen-preview-view.js';
import {
  CODEGEN_PREVIEW_BUNDLE_KIND,
  CODEGEN_PREVIEW_BUNDLE_VERSION,
  buildCodegenPreviewBundle,
  bundleHasArtifacts,
  isPreviewDownloadable,
  makeCodegenPreviewBundleFilename,
  serializeCodegenPreviewBundle,
} from '../src/utils/codegen-preview-download.js';

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

// =============================================================================
// 1. isPreviewDownloadable
// =============================================================================

describe('isPreviewDownloadable', () => {
  it('1. null view → not downloadable', () => {
    expect(isPreviewDownloadable({ view: null, stale: false })).toBe(false);
  });

  it('2. stale view → not downloadable', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: stubGenerator('codesys', [['x.st', 'X']]) },
    });
    expect(isPreviewDownloadable({ view, stale: true })).toBe(false);
  });

  it('3. unavailable view (no project) → not downloadable', () => {
    const view = buildCodegenPreviewView({
      project: null,
      selection: 'codesys',
    });
    expect(isPreviewDownloadable({ view, stale: false })).toBe(false);
  });

  it('4. ready view with at least one artifact → downloadable', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: stubGenerator('codesys', [['x.st', 'X']]) },
    });
    expect(isPreviewDownloadable({ view, stale: false })).toBe(true);
  });

  it('5. all-blocked preview → not downloadable', () => {
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'pneumatic_cylinder_1pos';
    const view = buildCodegenPreviewView({
      project: p,
      selection: 'all',
      generators: {
        codesys: () => [],
        siemens: () => [],
        rockwell: () => [],
      },
    });
    expect(isPreviewDownloadable({ view, stale: false })).toBe(false);
  });

  it('6. all-failed preview → not downloadable', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'all',
      generators: {
        codesys: () => {
          throw new CodegenError('INTERNAL_ERROR', 'boom');
        },
        siemens: () => {
          throw new CodegenError('INTERNAL_ERROR', 'boom');
        },
        rockwell: () => {
          throw new CodegenError('INTERNAL_ERROR', 'boom');
        },
      },
    });
    expect(isPreviewDownloadable({ view, stale: false })).toBe(false);
  });

  it('7. ready single target with empty artifact list → not downloadable', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: () => [] },
    });
    expect(isPreviewDownloadable({ view, stale: false })).toBe(false);
  });
});

// =============================================================================
// 2. buildCodegenPreviewBundle — happy paths
// =============================================================================

describe('buildCodegenPreviewBundle — happy paths', () => {
  it('1. single-target ready: bundle carries kind + version + selection + full artifact content', () => {
    const longContent = Array.from(
      { length: MAX_PREVIEW_LINES + 5 },
      (_, i) => `LINE_${i}`,
    ).join('\n');
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: {
        codesys: stubGenerator('codesys', [['big.st', longContent]]),
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    expect(bundle.kind).toBe(CODEGEN_PREVIEW_BUNDLE_KIND);
    expect(bundle.version).toBe(CODEGEN_PREVIEW_BUNDLE_VERSION);
    expect(bundle.selection).toBe('codesys');
    expect(bundle.targets).toHaveLength(1);
    expect(bundle.targets[0].artifacts).toHaveLength(1);
    const a = bundle.targets[0].artifacts[0];
    // Bundle bypasses the panel's UI snippet cap: the full content
    // survives, including all MAX_PREVIEW_LINES + 5 lines.
    expect(a.content.split('\n')).toHaveLength(MAX_PREVIEW_LINES + 5);
    expect(a.content).toBe(longContent);
    expect(a.sizeBytes).toBe(longContent.length);
  });

  it('2. very-long single-line content survives the byte cap', () => {
    const huge = 'X'.repeat(MAX_PREVIEW_BYTES + 1024);
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: {
        codesys: stubGenerator('codesys', [['huge.st', huge]]),
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    expect(bundle.targets[0].artifacts[0].content).toBe(huge);
    expect(bundle.targets[0].artifacts[0].sizeBytes).toBe(huge.length);
  });

  it('3. artifact ordering is deterministic by path', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: {
        codesys: stubGenerator('codesys', [
          ['z.st', 'Z'],
          ['a.st', 'A'],
          ['m.st', 'M'],
        ]),
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    expect(bundle.targets[0].artifacts.map((a) => a.path)).toEqual([
      'codesys/a.st',
      'codesys/m.st',
      'codesys/z.st',
    ]);
  });

  it('4. manifest diagnostics are deduped and preserved verbatim', () => {
    const dupDiag = {
      severity: 'warning' as const,
      code: 'ROCKWELL_EXPERIMENTAL_BACKEND',
      message: 'experimental',
      hint: 'still experimental',
    };
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'rockwell',
      generators: {
        rockwell: stubGenerator(
          'rockwell',
          [['UDT_X.st', 'TYPE'], ['manifest.json', '{}']],
          [dupDiag, dupDiag],
        ),
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    expect(bundle.targets[0].diagnostics).toHaveLength(1);
    expect(bundle.targets[0].diagnostics[0]).toEqual({
      severity: 'warning',
      code: 'ROCKWELL_EXPERIMENTAL_BACKEND',
      message: 'experimental',
      hint: 'still experimental',
    });
  });

  it('5. ready_with_warnings status flows into bundle status + summary', () => {
    const dupDiag = {
      severity: 'warning' as const,
      code: 'ROCKWELL_EXPERIMENTAL_BACKEND',
      message: 'experimental',
    };
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'rockwell',
      generators: {
        rockwell: stubGenerator(
          'rockwell',
          [['UDT_X.st', 'TYPE'], ['manifest.json', '{}']],
          [dupDiag],
        ),
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    expect(bundle.targets[0].status).toBe('ready_with_warnings');
    expect(bundle.summary).toMatch(/ready/i);
  });
});

// =============================================================================
// 3. Backend "all"
// =============================================================================

describe('buildCodegenPreviewBundle — backend "all"', () => {
  it('1. all-blocked: bundle records every target with empty artifacts and no fabricated content', () => {
    // `pneumatic_cylinder_1pos` is not in any vendor capability
    // table, so all three targets short-circuit at readiness.
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'pneumatic_cylinder_1pos';
    const view = buildCodegenPreviewView({
      project: p,
      selection: 'all',
      generators: {
        codesys: () => {
          throw new Error('should not be called when blocked');
        },
        siemens: () => {
          throw new Error('should not be called when blocked');
        },
        rockwell: () => {
          throw new Error('should not be called when blocked');
        },
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    expect(bundle.targets).toHaveLength(3);
    for (const t of bundle.targets) {
      expect(t.status).toBe('blocked');
      expect(t.artifacts).toEqual([]);
    }
    expect(bundleHasArtifacts(bundle)).toBe(false);
  });

  it('1b. mixed all (ready + ready) + the same readiness diagnostics flow into the bundle', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'all',
      generators: {
        codesys: stubGenerator('codesys', [['c.st', 'C']]),
        siemens: stubGenerator('siemens', [['s.scl', 'S']]),
        rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    expect(bundle.targets).toHaveLength(3);
    for (const t of bundle.targets) {
      expect(['ready', 'ready_with_warnings']).toContain(t.status);
      expect(t.artifacts).toHaveLength(1);
    }
  });

  it('2. one failed target does not poison the others', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'all',
      generators: {
        codesys: stubGenerator('codesys', [['c.st', 'C']]),
        siemens: () => {
          throw new CodegenError('INTERNAL_ERROR', 'siemens crashed', {
            hint: 'try harder',
          });
        },
        rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    const byTarget = Object.fromEntries(
      bundle.targets.map((t) => [t.target, t]),
    );
    expect(byTarget.codesys.status).toBe('ready');
    expect(byTarget.codesys.artifacts).toHaveLength(1);
    expect(byTarget.siemens.status).toBe('failed');
    expect(byTarget.siemens.artifacts).toEqual([]);
    expect(byTarget.siemens.error?.code).toBe('INTERNAL_ERROR');
    expect(byTarget.rockwell.status).toBe('ready');
    expect(byTarget.rockwell.artifacts).toHaveLength(1);
  });
});

// =============================================================================
// 4. Filename helper
// =============================================================================

describe('makeCodegenPreviewBundleFilename', () => {
  it('1. single-vendor selection produces selection-specific name', () => {
    expect(makeCodegenPreviewBundleFilename('codesys')).toBe(
      'plc-copilot-codegen-preview-codesys.json',
    );
    expect(makeCodegenPreviewBundleFilename('siemens')).toBe(
      'plc-copilot-codegen-preview-siemens.json',
    );
    expect(makeCodegenPreviewBundleFilename('rockwell')).toBe(
      'plc-copilot-codegen-preview-rockwell.json',
    );
  });

  it('2. backend "all" produces all-suffixed name', () => {
    expect(makeCodegenPreviewBundleFilename('all')).toBe(
      'plc-copilot-codegen-preview-all.json',
    );
  });

  it('3. filename helper is deterministic across calls (no timestamp)', () => {
    const a = makeCodegenPreviewBundleFilename('codesys');
    const b = makeCodegenPreviewBundleFilename('codesys');
    expect(a).toBe(b);
    // No digit groups that would suggest a wall-clock suffix.
    expect(a).not.toMatch(/\d{4}/);
  });
});

// =============================================================================
// 5. Determinism + immutability
// =============================================================================

describe('buildCodegenPreviewBundle — determinism + immutability', () => {
  it('1. helper does NOT mutate the input view', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: stubGenerator('codesys', [['x.st', 'X']]) },
    });
    const before = JSON.stringify(view);
    buildCodegenPreviewBundle(view);
    expect(JSON.stringify(view)).toBe(before);
  });

  it('2. two invocations on the same view produce equal bundles', () => {
    const make = () =>
      buildCodegenPreviewView({
        project: happyProject(),
        selection: 'all',
        generators: {
          codesys: stubGenerator('codesys', [['c.st', 'C']]),
          siemens: stubGenerator('siemens', [['s.scl', 'S']]),
          rockwell: stubGenerator('rockwell', [['r.st', 'R']]),
        },
      });
    const a = buildCodegenPreviewBundle(make());
    const b = buildCodegenPreviewBundle(make());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('3. serialised JSON survives a round-trip with the same shape', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: {
        codesys: stubGenerator('codesys', [
          ['DUT_X.st', 'TYPE\nEND_TYPE\n'],
          ['manifest.json', '{}'],
        ]),
      },
    });
    const bundle = buildCodegenPreviewBundle(view);
    const text = serializeCodegenPreviewBundle(bundle);
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe(CODEGEN_PREVIEW_BUNDLE_KIND);
    expect(parsed.version).toBe(CODEGEN_PREVIEW_BUNDLE_VERSION);
    expect(parsed.targets[0].artifacts.map((a: { path: string }) => a.path))
      .toEqual([
        'codesys/DUT_X.st',
        'codesys/manifest.json',
      ]);
  });
});

// =============================================================================
// 6. Privacy — no source bytes leak
// =============================================================================

describe('buildCodegenPreviewBundle — privacy', () => {
  it('1. bundle JSON contains generated artifact text only — no raw source bytes', () => {
    // The Sprint 89 helper never sees raw CSV / EPLAN / TcECAD /
    // PDF input; it consumes a `Project` and calls the vendor
    // pipeline. The bundle is a strict pass-through of the
    // pipeline's output. This test pins that promise by
    // serialising the bundle and asserting it does not contain
    // common raw-source markers (the legacy CSV first line, an
    // EPLAN root tag, etc.).
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: {
        codesys: stubGenerator('codesys', [
          ['x.st', 'TYPE\nEND_TYPE\n'],
        ]),
      },
    });
    const text = serializeCodegenPreviewBundle(buildCodegenPreviewBundle(view));
    // None of these tokens land in vendor codegen output.
    expect(text).not.toContain('row_kind,');
    expect(text).not.toContain('<EplanProject');
    expect(text).not.toContain('<TcecadProject');
    expect(text).not.toContain('%PDF-');
    // The pir_version field on the project is also NOT serialised
    // into the bundle (we copy view fields, not project fields).
    expect(text).not.toContain('pir_version');
  });
});

// =============================================================================
// 7. bundleHasArtifacts
// =============================================================================

describe('bundleHasArtifacts', () => {
  it('1. true when at least one target has artifacts', () => {
    const view = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: stubGenerator('codesys', [['x.st', 'X']]) },
    });
    expect(bundleHasArtifacts(buildCodegenPreviewBundle(view))).toBe(true);
  });

  it('2. false when every target is blocked', () => {
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'pneumatic_cylinder_1pos';
    const view = buildCodegenPreviewView({
      project: p,
      selection: 'all',
      generators: {
        codesys: () => [],
        siemens: () => [],
        rockwell: () => [],
      },
    });
    expect(bundleHasArtifacts(buildCodegenPreviewBundle(view))).toBe(false);
  });
});
