// Sprint 89 — pure tests for `buildCodegenPreviewView`.
//
// The web Codegen-Preview panel is a thin renderer; the
// behaviour the operator depends on lives in this helper:
//
//   - `unavailable` when no project is loaded,
//   - per-target verdicts (ready / ready_with_warnings / blocked /
//     failed) computed from readiness + actual generation,
//   - artifact list sorted deterministically by path,
//   - artifact previews truncated at fixed line / byte budgets,
//   - manifest diagnostics severity-grouped + deduped,
//   - backend `'all'` expands into 3 target views; one failure
//     does not poison the others,
//   - readiness `'blocked'` short-circuits — the vendor is not
//     called when readiness already says no,
//   - the helper does NOT mutate the input project.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import { CodegenError } from '@plccopilot/codegen-core';

import {
  buildCodegenPreviewView,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_LINES,
} from '../src/utils/codegen-preview-view.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function happyProject(): Project {
  // Minimal valid PIR: one machine, one station, one sensor.
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

function makeArtifact(
  path: string,
  content = 'TYPE FB :\nVAR\nEND_VAR\nEND_TYPE\n',
  diagnostics: GeneratedArtifact['diagnostics'] = undefined,
): GeneratedArtifact {
  const kind: GeneratedArtifact['kind'] = path.endsWith('.scl')
    ? 'scl'
    : path.endsWith('.json')
      ? 'json'
      : 'st';
  return diagnostics ? { path, kind, content, diagnostics } : { path, kind, content };
}

function stubGenerator(
  prefix: string,
  paths: ReadonlyArray<string>,
  manifestDiags: GeneratedArtifact['diagnostics'] = undefined,
): (p: Project) => GeneratedArtifact[] {
  return () => {
    const arts = paths.map((p) => makeArtifact(`${prefix}/${p}`));
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
// 1. Unavailable
// =============================================================================

describe('buildCodegenPreviewView — unavailable', () => {
  it('1. null project → unavailable + empty target list', () => {
    const v = buildCodegenPreviewView({
      project: null,
      selection: 'codesys',
    });
    expect(v.status).toBe('unavailable');
    expect(v.targets).toEqual([]);
    expect(v.summary).toMatch(/Build and apply a PIR/);
  });

  it('2. undefined project → unavailable', () => {
    const v = buildCodegenPreviewView({
      project: undefined,
      selection: 'all',
    });
    expect(v.status).toBe('unavailable');
    expect(v.targets).toEqual([]);
  });
});

// =============================================================================
// 2. Ready single-target
// =============================================================================

describe('buildCodegenPreviewView — ready single-target', () => {
  it('1. happy project + clean generator → ready, artifact paths sorted', () => {
    const generator = stubGenerator('codesys', [
      'FB_StA.st',
      'DUT_SensorDiscrete.st',
      'manifest.json',
    ]);
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: generator },
    });
    expect(v.status).toBe('ready');
    expect(v.targets).toHaveLength(1);
    const t = v.targets[0];
    expect(t.target).toBe('codesys');
    expect(t.artifactCount).toBe(3);
    // Sorted ascending by path.
    expect(t.artifacts.map((a) => a.path)).toEqual([
      'codesys/DUT_SensorDiscrete.st',
      'codesys/FB_StA.st',
      'codesys/manifest.json',
    ]);
    expect(t.error).toBeUndefined();
    expect(t.summary).toMatch(/Preview ready for codesys/);
  });

  it('2. manifest warnings on the result → ready_with_warnings; preserved + deduped', () => {
    const dupDiag = {
      severity: 'warning' as const,
      code: 'ROCKWELL_EXPERIMENTAL_BACKEND',
      message: 'experimental',
    };
    const generator = stubGenerator(
      'rockwell',
      ['UDT_X.st', 'manifest.json'],
      [dupDiag, dupDiag],
    );
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'rockwell',
      generators: { rockwell: generator },
    });
    expect(v.targets[0].status).toBe('ready_with_warnings');
    // Dedup squashes the two identical entries to one.
    expect(v.targets[0].manifestDiagnostics).toHaveLength(1);
    expect(v.targets[0].manifestDiagnostics[0].code).toBe(
      'ROCKWELL_EXPERIMENTAL_BACKEND',
    );
    expect(v.targets[0].summary).toMatch(/with warnings/);
  });
});

// =============================================================================
// 3. Snippets — truncation
// =============================================================================

describe('buildCodegenPreviewView — snippet truncation', () => {
  it('1. content longer than MAX_PREVIEW_LINES is truncated', () => {
    const longContent =
      Array.from({ length: MAX_PREVIEW_LINES + 5 }, (_, i) => `LINE_${i}`).join(
        '\n',
      );
    const generator = (): GeneratedArtifact[] => [
      makeArtifact('codesys/long.st', longContent),
    ];
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: generator },
    });
    const a = v.targets[0].artifacts[0];
    expect(a.truncated).toBe(true);
    expect(a.previewText.split('\n').length).toBeLessThanOrEqual(
      MAX_PREVIEW_LINES,
    );
    // Original content size preserved as a hint.
    expect(a.sizeBytes).toBe(longContent.length);
  });

  it('2. content longer than MAX_PREVIEW_BYTES is truncated', () => {
    // Single very long line — line count is fine, but byte budget hits.
    const huge = 'X'.repeat(MAX_PREVIEW_BYTES + 1024);
    const generator = (): GeneratedArtifact[] => [
      makeArtifact('codesys/huge.st', huge),
    ];
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: generator },
    });
    const a = v.targets[0].artifacts[0];
    expect(a.truncated).toBe(true);
    expect(a.previewText.length).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });

  it('3. small content is NOT truncated', () => {
    const generator = (): GeneratedArtifact[] => [
      makeArtifact('codesys/small.st', 'TYPE T :\nEND_TYPE\n'),
    ];
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: generator },
    });
    expect(v.targets[0].artifacts[0].truncated).toBe(false);
  });
});

// =============================================================================
// 4. Failed target
// =============================================================================

describe('buildCodegenPreviewView — failed target', () => {
  it('1. CodegenError → status failed, error.code preserved, no crash', () => {
    const generator = (): GeneratedArtifact[] => {
      throw new CodegenError(
        'READINESS_FAILED',
        'simulated readiness failure',
        { hint: 'fix the project' },
      );
    };
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: generator },
    });
    expect(v.targets[0].status).toBe('failed');
    expect(v.targets[0].error?.code).toBe('READINESS_FAILED');
    expect(v.targets[0].error?.message).toMatch(/simulated readiness/);
    expect(v.targets[0].artifactCount).toBe(0);
    expect(v.targets[0].summary).toMatch(/Preview failed for codesys/);
  });

  it('2. plain Error (non-CodegenError) → status failed, message preserved', () => {
    const generator = (): GeneratedArtifact[] => {
      throw new Error('boom');
    };
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'siemens',
      generators: { siemens: generator },
    });
    expect(v.targets[0].status).toBe('failed');
    expect(v.targets[0].error?.message).toMatch(/boom/);
  });

  it('3. non-array vendor return → defensive failed status', () => {
    // Some vendor implementations could regress; the helper guards
    // against returning a non-array.
    const generator = (() => 'not an array') as unknown as (
      p: Project,
    ) => GeneratedArtifact[];
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: generator },
    });
    expect(v.targets[0].status).toBe('failed');
    expect(v.targets[0].error?.code).toBe('INTERNAL_ERROR');
  });
});

// =============================================================================
// 5. Backend 'all'
// =============================================================================

describe('buildCodegenPreviewView — backend "all"', () => {
  it('1. expands into three vendor target views', () => {
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'all',
      generators: {
        codesys: stubGenerator('codesys', ['DUT_X.st']),
        siemens: stubGenerator('siemens', ['UDT_X.scl']),
        rockwell: stubGenerator('rockwell', ['UDT_X.st']),
      },
    });
    expect(v.targets).toHaveLength(3);
    const targetNames = v.targets.map((t) => t.target).sort();
    expect(targetNames).toEqual(['codesys', 'rockwell', 'siemens']);
    expect(v.status).toBe('ready');
  });

  it('2. one failed target does not poison the others', () => {
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'all',
      generators: {
        codesys: stubGenerator('codesys', ['DUT_X.st']),
        siemens: () => {
          throw new CodegenError('INTERNAL_ERROR', 'siemens crashed');
        },
        rockwell: stubGenerator('rockwell', ['UDT_X.st']),
      },
    });
    const byTarget = Object.fromEntries(
      v.targets.map((t) => [t.target, t.status]),
    );
    expect(byTarget.codesys).toBe('ready');
    expect(byTarget.siemens).toBe('failed');
    expect(byTarget.rockwell).toBe('ready');
    expect(v.status).toBe('failed');
    expect(v.summary).toMatch(/2\/3 ready target/);
  });

  it('3. one blocked + two ready → aggregate "blocked" with explanatory summary', () => {
    // The siemens generator should never be called for this case
    // because we make Siemens see an unsupported equipment. We
    // mutate the project to a kind not in any vendor capability
    // table (`pneumatic_cylinder_1pos`). The other two targets
    // also block on the same kind, so all three end up blocked.
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'pneumatic_cylinder_1pos';
    let siemensCalled = false;
    const v = buildCodegenPreviewView({
      project: p,
      selection: 'all',
      generators: {
        codesys: stubGenerator('codesys', ['x.st']),
        siemens: () => {
          siemensCalled = true;
          return [];
        },
        rockwell: stubGenerator('rockwell', ['x.st']),
      },
    });
    // All three blocked at readiness; vendor functions never called.
    expect(siemensCalled).toBe(false);
    for (const t of v.targets) {
      expect(t.status).toBe('blocked');
      expect(t.artifactCount).toBe(0);
      // Readiness groups carry the blocking diagnostic.
      expect(
        t.readinessGroups.some(
          (g) => g.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
        ),
      ).toBe(true);
    }
    expect(v.status).toBe('blocked');
  });
});

// =============================================================================
// 6. Determinism + immutability
// =============================================================================

describe('buildCodegenPreviewView — determinism + immutability', () => {
  it('1. helper does NOT mutate the input project', () => {
    const p = happyProject();
    const before = JSON.stringify(p);
    buildCodegenPreviewView({
      project: p,
      selection: 'codesys',
      generators: { codesys: stubGenerator('codesys', ['x.st']) },
    });
    expect(JSON.stringify(p)).toBe(before);
  });

  it('2. duplicate artifact paths are preserved (vendor responsibility) but sort is stable', () => {
    // The helper does NOT dedup artifact paths — that's the
    // vendor's contract. We only assert it doesn't crash and the
    // sort is stable.
    const generator = (): GeneratedArtifact[] => [
      makeArtifact('codesys/dup.st', 'a'),
      makeArtifact('codesys/dup.st', 'b'),
      makeArtifact('codesys/aaa.st', 'c'),
    ];
    const v = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'codesys',
      generators: { codesys: generator },
    });
    expect(v.targets[0].artifactCount).toBe(3);
    const paths = v.targets[0].artifacts.map((a) => a.path);
    expect(paths[0]).toBe('codesys/aaa.st');
    expect(paths.slice(1)).toEqual(['codesys/dup.st', 'codesys/dup.st']);
  });

  it('3. two runs with the same project + generators produce equivalent views', () => {
    const make = () =>
      buildCodegenPreviewView({
        project: happyProject(),
        selection: 'codesys',
        generators: { codesys: stubGenerator('codesys', ['a.st', 'b.st']) },
      });
    const a = make();
    const b = make();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// =============================================================================
// 7. Readiness short-circuit (the canonical "blocked" path)
// =============================================================================

describe('buildCodegenPreviewView — readiness short-circuit', () => {
  it('1. unsupported equipment → blocked; vendor generator NOT called', () => {
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'pneumatic_cylinder_1pos';
    let called = false;
    const v = buildCodegenPreviewView({
      project: p,
      selection: 'codesys',
      generators: {
        codesys: () => {
          called = true;
          return [];
        },
      },
    });
    expect(called).toBe(false);
    expect(v.targets[0].status).toBe('blocked');
    expect(v.targets[0].artifactCount).toBe(0);
    expect(v.targets[0].error).toBeUndefined();
  });

  it('2. happy valve_onoff project → not blocked (post-Sprint 88C convergence)', () => {
    const p = happyProject();
    p.machines[0].stations[0].equipment[0] = {
      id: 'eq_v1',
      name: 'V1',
      type: 'valve_onoff',
      code_symbol: 'V1',
      io_bindings: { solenoid_out: 'io_b1' },
    } as unknown as Project['machines'][0]['stations'][0]['equipment'][0];
    const v = buildCodegenPreviewView({
      project: p,
      selection: 'codesys',
      generators: { codesys: stubGenerator('codesys', ['DUT_ValveOnoff.st']) },
    });
    // valve_onoff is universally supported (CODESYS / Siemens /
    // Rockwell). Readiness lets us through; the stub returns an
    // artifact list.
    expect(v.targets[0].status).toMatch(/^ready/);
  });
});
