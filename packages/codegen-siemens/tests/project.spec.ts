import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateSiemensProject } from '../src/generators/project.js';
import { CodegenError } from '../src/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const MANIFEST_CLOCK = { generatedAt: '2026-04-23T00:00:00Z' };

describe('generateSiemensProject — full artifact set', () => {
  const artifacts = generateSiemensProject(clone(), { manifest: MANIFEST_CLOCK });

  it('produces the expected artifact set for the weldline fixture', () => {
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

  it('assigns a reasonable kind to each artifact', () => {
    const byPath = new Map(artifacts.map((a) => [a.path, a.kind]));
    expect(byPath.get('siemens/FB_StLoad.scl')).toBe('scl');
    expect(byPath.get('siemens/UDT_Cylinder2Pos.scl')).toBe('scl');
    expect(byPath.get('siemens/DB_Global_Params.scl')).toBe('scl');
    expect(byPath.get('siemens/DB_Recipes.scl')).toBe('scl');
    expect(byPath.get('siemens/Tags_Main.csv')).toBe('csv');
    expect(byPath.get('siemens/manifest.json')).toBe('json');
  });

  it('is deterministic across two independent runs (including diagnostics)', () => {
    const a1 = generateSiemensProject(clone(), { manifest: MANIFEST_CLOCK });
    const a2 = generateSiemensProject(clone(), { manifest: MANIFEST_CLOCK });
    expect(a1.map((a) => a.content)).toEqual(a2.map((a) => a.content));
    expect(a1.map((a) => a.diagnostics)).toEqual(a2.map((a) => a.diagnostics));
  });

  it('attaches diagnostics to station FB artifacts', () => {
    const loadFb = artifacts.find((a) => a.path.endsWith('FB_StLoad.scl'))!;
    expect(loadFb.diagnostics).toBeDefined();
    // st_load has timeouts → TIMEOUT_NO_AUTO_TRANSITION info diagnostic.
    expect(
      loadFb.diagnostics!.some(
        (d) => d.code === 'TIMEOUT_NO_AUTO_TRANSITION',
      ),
    ).toBe(true);
  });

  it('non-SCL artifacts do not expose diagnostics', () => {
    const csv = artifacts.find((a) => a.kind === 'csv');
    const json = artifacts.find((a) => a.kind === 'json');
    expect(csv!.diagnostics).toBeUndefined();
    expect(json!.diagnostics).toBeUndefined();
  });
});

describe('generateSiemensProject — manifest', () => {
  it('lists every other artifact (by basename) but not itself', () => {
    const artifacts = generateSiemensProject(clone(), { manifest: MANIFEST_CLOCK });
    const manifest = artifacts.find((a) => a.path.endsWith('manifest.json'))!;
    const data = JSON.parse(manifest.content) as {
      generator: string;
      version: string;
      pir_version: string;
      project_id: string;
      project_name: string;
      target: { vendor: string; tia_version: string };
      artifacts: string[];
      generated_at: string;
    };
    expect(data.generator).toBe('@plccopilot/codegen-siemens');
    expect(data.pir_version).toBe('0.1.0');
    expect(data.project_id).toBe('prj_weldline');
    expect(data.target.vendor).toBe('siemens_s7_1500');
    expect(data.target.tia_version).toBe('19');
    expect(data.generated_at).toBe('2026-04-23T00:00:00Z');
    expect(data.artifacts).toEqual([
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
    expect(data.artifacts).not.toContain('manifest.json');
  });

  it('uses the injected clock value', () => {
    const a = generateSiemensProject(clone(), {
      manifest: { generatedAt: '2030-01-01T00:00:00Z', tiaVersion: '20' },
    });
    const manifest = a.find((x) => x.path.endsWith('manifest.json'))!;
    const data = JSON.parse(manifest.content) as {
      generated_at: string;
      target: { tia_version: string };
    };
    expect(data.generated_at).toBe('2030-01-01T00:00:00Z');
    expect(data.target.tia_version).toBe('20');
  });
});

describe('generateSiemensProject — conditional emission', () => {
  it('does not emit UDTs for equipment types not present', () => {
    const p = clone();
    p.machines[0]!.stations = [
      {
        id: 'st_only_sensor',
        name: 'Sensor-only',
        equipment: [p.machines[0]!.stations[0]!.equipment[1]!], // sen_part
        sequence: {
          states: [{ id: 'st_idle', name: 'Idle', kind: 'initial' }],
          transitions: [],
        },
      },
    ];
    const a = generateSiemensProject(p, { manifest: MANIFEST_CLOCK });
    const paths = a.map((art) => art.path);
    expect(paths).not.toContain('siemens/UDT_Cylinder2Pos.scl');
    expect(paths).not.toContain('siemens/UDT_MotorSimple.scl');
  });

  it('skips DB_Global_Params / DB_Recipes when parameters + recipes are empty', () => {
    const p = clone();
    p.machines[0]!.parameters = [];
    p.machines[0]!.recipes = [];
    const paths = generateSiemensProject(p, { manifest: MANIFEST_CLOCK }).map(
      (a) => a.path,
    );
    expect(paths).not.toContain('siemens/DB_Global_Params.scl');
    expect(paths).not.toContain('siemens/DB_Recipes.scl');
  });

  it('still fails with CodegenError for out-of-scope equipment', () => {
    const p = clone();
    (p.machines[0]!.stations[0]!.equipment[0]!.type as string) = 'valve_onoff';
    expect(() => generateSiemensProject(p)).toThrow(CodegenError);
  });

  it('features.useDbAlarms=false omits DB_Alarms and FB_Alarms and uses loose tags', () => {
    const artifacts = generateSiemensProject(clone(), {
      manifest: MANIFEST_CLOCK,
      features: { useDbAlarms: false },
    });
    const paths = artifacts.map((a) => a.path);
    expect(paths).not.toContain('siemens/DB_Alarms.scl');
    expect(paths).not.toContain('siemens/FB_Alarms.scl');
    const load = artifacts.find((a) => a.path.endsWith('FB_StLoad.scl'))!;
    // Loose-tag mode: alarm writes collapse to the raw id.
    expect(load.content).toContain('"al_cyl_ext_timeout" := TRUE');
    expect(load.content).not.toContain('"DB_Alarms"');
  });
});

describe('Siemens output stays intact (regression guard)', () => {
  const artifacts = generateSiemensProject(clone(), { manifest: MANIFEST_CLOCK });

  it('every station FB still uses # for FB-local refs and "DB_Alarms".set_ for alarms', () => {
    const stationFbs = artifacts.filter(
      (a) => a.kind === 'scl' && /\/FB_St[A-Z][A-Za-z]+\.scl$/.test(a.path),
    );
    expect(stationFbs.length).toBeGreaterThan(0);
    for (const fb of stationFbs) {
      expect(fb.content).toContain('FUNCTION_BLOCK "FB_');
      expect(fb.content).toContain('#state');
    }
    const load = stationFbs.find((a) => a.path.endsWith('FB_StLoad.scl'))!;
    expect(load.content).toContain('"DB_Alarms".set_al_cyl_ext_timeout');
    expect(load.content).toContain('IF #TON_t_extended.Q THEN');
  });

  it('still produces the canonical Siemens artifact set', () => {
    const paths = artifacts.map((a) => a.path);
    expect(paths).toContain('siemens/UDT_Cylinder2Pos.scl');
    expect(paths).toContain('siemens/UDT_MotorSimple.scl');
    expect(paths).toContain('siemens/DB_Global_Params.scl');
    expect(paths).toContain('siemens/DB_Recipes.scl');
    expect(paths).toContain('siemens/DB_Alarms.scl');
    expect(paths).toContain('siemens/Tags_Main.csv');
    expect(paths).toContain('siemens/manifest.json');
  });

  it('UDTs are SCL-style with quoted name and Bool field types', () => {
    const cyl = artifacts.find((a) => a.path.endsWith('UDT_Cylinder2Pos.scl'))!;
    expect(cyl.content).toContain('TYPE "UDT_Cylinder2Pos"');
    expect(cyl.content).toContain('cmd_extend : Bool;');
    expect(cyl.content).toContain('END_STRUCT;');
  });

  it('DB_Global_Params + DB_Recipes use SCL DATA_BLOCK with Siemens types', () => {
    const params = artifacts.find((a) => a.path.endsWith('DB_Global_Params.scl'))!;
    expect(params.content).toContain('DATA_BLOCK "DB_Global_Params"');
    expect(params.content).toContain('p_weld_current : Real');
    expect(params.content).toContain('p_weld_time : DInt');

    const recipes = artifacts.find((a) => a.path.endsWith('DB_Recipes.scl'))!;
    expect(recipes.content).toContain('DATA_BLOCK "DB_Recipes"');
    expect(recipes.content).toContain('r_default_p_weld_time : DInt');
  });
});

describe('public API surface — guard against accidental removals', () => {
  it('exports the documented top-level functions as callable values', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.generateSiemensProject).toBe('function');
    expect(typeof mod.generateCodesysProject).toBe('function');
    expect(typeof mod.generateRockwellProject).toBe('function');
    expect(typeof mod.compileProject).toBe('function');
    expect(typeof mod.renderProgramArtifacts).toBe('function');
    expect(typeof mod.renderProgramArtifactsCodesys).toBe('function');
    expect(typeof mod.renderProgramArtifactsRockwell).toBe('function');
    expect(typeof mod.serializeProgramIR).toBe('function');
    expect(typeof mod.dbNamespaceFor).toBe('function');
  });

  it('returns a non-empty artifact list from each public generator', () => {
    const sie = generateSiemensProject(clone(), { manifest: MANIFEST_CLOCK });
    expect(sie.length).toBeGreaterThan(0);
    expect(sie.every((a) => typeof a.content === 'string')).toBe(true);
    expect(sie.every((a) => a.kind === 'scl' || a.kind === 'csv' || a.kind === 'json')).toBe(true);
  });

  it('serializeProgramIR returns deterministic JSON for the same project + clock', async () => {
    const { compileProject, serializeProgramIR } = await import(
      '../src/index.js'
    );
    const a = serializeProgramIR(
      compileProject(clone(), { manifest: MANIFEST_CLOCK }),
    );
    const b = serializeProgramIR(
      compileProject(clone(), { manifest: MANIFEST_CLOCK }),
    );
    expect(a).toBe(b);
    // Sanity: it's actually JSON.
    expect(() => JSON.parse(a)).not.toThrow();
  });
});
