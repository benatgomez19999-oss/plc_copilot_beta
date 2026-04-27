import { describe, expect, it } from 'vitest';
import fixture from '../../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  compileProject,
  resolveFeatures,
} from '../../src/compiler/program/compile-project.js';
import { renderProgramArtifacts } from '../../src/compiler/program/artifacts.js';
import { serializeProgramIR } from '../../src/compiler/program/serialize.js';
import { CodegenError } from '../../src/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-25T00:00:00Z' } };

describe('compileProject — ProgramIR shape', () => {
  const program = compileProject(clone(), CLOCK);

  it('carries project identity fields straight from PIR', () => {
    expect(program.projectId).toBe('prj_weldline');
    expect(program.projectName).toBe('Weldline Demo Project');
    expect(program.pirVersion).toBe('0.1.0');
  });

  it('defaults target to siemens_s7_1500 / TIA V19', () => {
    expect(program.target.vendor).toBe('siemens_s7_1500');
    expect(program.target.tiaVersion).toBe('19');
  });

  it('produces one FB per station plus FB_Alarms at the end of blocks', () => {
    expect(program.blocks.map((b) => b.name)).toEqual([
      'FB_StLoad',
      'FB_StWeld',
      'FB_Alarms',
    ]);
    expect(program.blocks.map((b) => b.stationId)).toEqual([
      'st_load',
      'st_weld',
      undefined,
    ]);
  });

  it('exposes the resolved CompilerFeatures', () => {
    expect(program.features).toEqual({
      useDbAlarms: true,
      emitFbAlarms: true,
      emitDiagnosticsInManifest: true,
      strictDiagnostics: false,
    });
  });

  it('produces UDTs for equipment types present in the project', () => {
    expect(program.typeArtifacts.map((t) => t.name).sort()).toEqual([
      'UDT_Cylinder2Pos',
      'UDT_MotorSimple',
    ]);
  });

  it('produces DB_Global_Params, DB_Recipes, and DB_Alarms', () => {
    expect(program.dataBlocks.map((d) => d.name)).toEqual([
      'DB_Global_Params',
      'DB_Recipes',
      'DB_Alarms',
    ]);
    expect(program.dataBlocks.map((d) => d.dbKind)).toEqual([
      'params',
      'recipes',
      'alarms',
    ]);
  });

  it('produces exactly one CSV tag table', () => {
    expect(program.tagTables).toHaveLength(1);
    expect(program.tagTables[0]!.name).toBe('Tags_Main');
  });

  it('aggregates diagnostics in sorted + deduplicated form', () => {
    const copy = program.diagnostics.slice();
    const sorted = copy
      .slice()
      .sort((a, b) => {
        const order = { error: 0, warning: 1, info: 2 };
        const sev = order[a.severity] - order[b.severity];
        if (sev !== 0) return sev;
        return a.code.localeCompare(b.code);
      });
    // ProgramIR diagnostics are already sorted by (severity, code, ...).
    expect(program.diagnostics.map((d) => d.severity)).toEqual(
      sorted.map((d) => d.severity),
    );
    // Dedupe: no two identical (code, severity, stationId, path, symbol, message).
    const keys = new Set(
      program.diagnostics.map((d) =>
        [
          d.code,
          d.severity,
          d.path ?? '',
          d.stationId ?? '',
          d.symbol ?? '',
          d.message,
        ].join(' '),
      ),
    );
    expect(keys.size).toBe(program.diagnostics.length);
  });

  it('is deterministic across two independent runs', () => {
    const a = compileProject(clone(), CLOCK);
    const b = compileProject(clone(), CLOCK);
    expect(a.blocks.map((x) => x.name)).toEqual(b.blocks.map((x) => x.name));
    // TypeArtifactIR and DataBlockArtifactIR are now structured (fields[],
    // not pre-rendered content). Compare the structured data directly.
    expect(a.typeArtifacts.map((t) => t.fields)).toEqual(
      b.typeArtifacts.map((t) => t.fields),
    );
    expect(a.dataBlocks.map((d) => d.fields)).toEqual(
      b.dataBlocks.map((d) => d.fields),
    );
    expect(a.diagnostics).toEqual(b.diagnostics);
  });
});

describe('compileProject — manifest', () => {
  it('lists every non-manifest artifact by basename in emission order', () => {
    const program = compileProject(clone(), CLOCK);
    expect(program.manifest.artifactPaths).toEqual([
      'FB_StLoad.scl',
      'FB_StWeld.scl',
      'FB_Alarms.scl',
      'UDT_Cylinder2Pos.scl',
      'UDT_MotorSimple.scl',
      'DB_Global_Params.scl',
      'DB_Recipes.scl',
      'DB_Alarms.scl',
      'Tags_Main.csv',
    ]);
    expect(program.manifest.artifactPaths).not.toContain('manifest.json');
  });

  it('carries the resolved CompilerFeatures in the manifest', () => {
    const program = compileProject(clone(), CLOCK);
    expect(program.manifest.features).toEqual(program.features);
  });

  it('includes every aggregated diagnostic in compiler_diagnostics', () => {
    const program = compileProject(clone(), CLOCK);
    expect(program.manifest.compilerDiagnostics.length).toBe(
      program.diagnostics.length,
    );
  });
});

describe('compileProject — error propagation', () => {
  it('throws CodegenError when a station has an unsupported equipment type', () => {
    const p = clone();
    (p.machines[0]!.stations[0]!.equipment[0]!.type as string) =
      'valve_onoff';
    expect(() => compileProject(p)).toThrow(CodegenError);
  });

  it('throws CodegenError when a station-level activity error surfaces', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.states[1]!.activity = {
      activate: ['cyl01.fly'],
    };
    expect(() => compileProject(p)).toThrow(CodegenError);
  });
});

describe('renderProgramArtifacts', () => {
  const program = compileProject(clone(), CLOCK);
  const artifacts = renderProgramArtifacts(program);

  it('emits a deterministic artifact list', () => {
    expect(artifacts.map((a) => a.path)).toEqual([
      'siemens/FB_StLoad.scl',
      'siemens/FB_StWeld.scl',
      'siemens/FB_Alarms.scl',
      'siemens/UDT_Cylinder2Pos.scl',
      'siemens/UDT_MotorSimple.scl',
      'siemens/DB_Global_Params.scl',
      'siemens/DB_Recipes.scl',
      'siemens/DB_Alarms.scl',
      'siemens/Tags_Main.csv',
      'siemens/manifest.json',
    ]);
  });

  it('wires station-scoped diagnostics to each station FB', () => {
    const load = artifacts.find((a) =>
      a.path.endsWith('FB_StLoad.scl'),
    )!;
    expect(load.diagnostics).toBeDefined();
    expect(
      load.diagnostics!.every((d) => d.stationId === 'st_load'),
    ).toBe(true);
  });

  it('does not attach diagnostics to UDT/DB/tag artifacts', () => {
    const udt = artifacts.find((a) => a.path.endsWith('UDT_MotorSimple.scl'))!;
    const db = artifacts.find((a) => a.path.endsWith('DB_Alarms.scl'))!;
    const csv = artifacts.find((a) => a.kind === 'csv')!;
    expect(udt.diagnostics).toBeUndefined();
    expect(db.diagnostics).toBeUndefined();
    expect(csv.diagnostics).toBeUndefined();
  });
});

describe('resolveFeatures — defaults', () => {
  it('defaults useDbAlarms to (alarms.length > 0)', () => {
    expect(resolveFeatures(undefined, true).useDbAlarms).toBe(true);
    expect(resolveFeatures(undefined, false).useDbAlarms).toBe(false);
  });

  it('defaults emitFbAlarms = useDbAlarms', () => {
    expect(resolveFeatures(undefined, true).emitFbAlarms).toBe(true);
    expect(resolveFeatures(undefined, false).emitFbAlarms).toBe(false);
    expect(resolveFeatures({ useDbAlarms: false }, true).emitFbAlarms).toBe(
      false,
    );
  });

  it('respects explicit overrides', () => {
    const f = resolveFeatures(
      {
        useDbAlarms: true,
        emitFbAlarms: false,
        emitDiagnosticsInManifest: false,
        strictDiagnostics: true,
      },
      true,
    );
    expect(f).toEqual({
      useDbAlarms: true,
      emitFbAlarms: false,
      emitDiagnosticsInManifest: false,
      strictDiagnostics: true,
    });
  });
});

describe('compileProject — strict diagnostics', () => {
  it('emits ALARMS_AS_LOOSE_TAGS info diagnostic when useDbAlarms=false', () => {
    const program = compileProject(clone(), {
      manifest: CLOCK.manifest,
      features: { useDbAlarms: false },
    });
    expect(
      program.diagnostics.some(
        (d) =>
          d.code === 'ALARMS_AS_LOOSE_TAGS' && d.severity === 'info',
      ),
    ).toBe(true);
  });

  it('strictDiagnostics=true does not throw when diagnostics are only info/warning', () => {
    expect(() =>
      compileProject(clone(), {
        manifest: CLOCK.manifest,
        features: { strictDiagnostics: true },
      }),
    ).not.toThrow();
  });

  // NOTE: today every error diagnostic already makes the per-station pass
  // throw before strictDiagnostics gets a chance. The flag exists so that
  // future non-station passes (UDT/DB validators) have a well-defined escalation
  // path. The `.not.toThrow` check above guarantees strict mode does not cause
  // false positives on the happy path.
});

describe('serializeProgramIR — deterministic snapshot', () => {
  it('is byte-for-byte identical across runs', () => {
    const a = serializeProgramIR(compileProject(clone(), CLOCK));
    const b = serializeProgramIR(compileProject(clone(), CLOCK));
    expect(a).toBe(b);
  });

  it('embeds features + blocks + diagnostics metadata (content excluded)', () => {
    const serialized = serializeProgramIR(compileProject(clone(), CLOCK));
    const data = JSON.parse(serialized) as Record<string, unknown>;

    expect((data.project as { id: string }).id).toBe('prj_weldline');
    expect((data.features as Record<string, boolean>).useDbAlarms).toBe(true);

    const blocks = data.blocks as Array<{ name: string; stationId: string | null }>;
    expect(blocks.map((b) => b.name)).toEqual([
      'FB_StLoad',
      'FB_StWeld',
      'FB_Alarms',
    ]);
    // Post core-extraction: SerializedProgram exposes logical names only;
    // backends compute their own filesystem paths at render time. The `path`
    // field was dropped from the serialized block payload — `name` is enough.
    expect(blocks[0]!.name).toBe('FB_StLoad');

    // IR content intentionally not serialized.
    expect(JSON.stringify(data)).not.toContain('FUNCTION_BLOCK "FB_StLoad"');
  });

  it('uses null (not undefined) for missing optional fields', () => {
    const serialized = serializeProgramIR(compileProject(clone(), CLOCK));
    const data = JSON.parse(serialized) as { blocks: Array<{ stationId: string | null }> };
    const fbAlarms = data.blocks.find((b) => b.stationId === null);
    expect(fbAlarms).toBeDefined();
    expect(fbAlarms!.stationId).toBeNull();
  });
});
