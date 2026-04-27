import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateCodesysProject } from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-25T00:00:00Z' } };

describe('generateCodesysProject — artifact set', () => {
  const artifacts = generateCodesysProject(clone(), CLOCK);

  it('produces the expected artifact list under codesys/', () => {
    expect(artifacts.map((a) => a.path)).toEqual([
      'codesys/FB_StLoad.st',
      'codesys/FB_StWeld.st',
      'codesys/FB_Alarms.st',
      'codesys/DUT_Cylinder2Pos.st',
      'codesys/DUT_MotorSimple.st',
      'codesys/GVL_Parameters.st',
      'codesys/GVL_Recipes.st',
      'codesys/GVL_Alarms.st',
      'codesys/manifest.json',
    ]);
  });

  it('every .st artifact is kind=st and every json is kind=json', () => {
    for (const a of artifacts) {
      if (a.path.endsWith('.st')) expect(a.kind).toBe('st');
      else if (a.path.endsWith('.json')) expect(a.kind).toBe('json');
    }
  });
});

describe('generateCodesysProject — FB_StLoad content', () => {
  const artifacts = generateCodesysProject(clone(), CLOCK);
  const load = artifacts.find((a) => a.path.endsWith('FB_StLoad.st'))!;

  it('emits FUNCTION_BLOCK without Siemens quoting', () => {
    expect(load.content).toContain('FUNCTION_BLOCK FB_StLoad');
    expect(load.content).not.toContain('"FB_StLoad"');
  });

  it('strips # prefix from FB-local refs', () => {
    expect(load.content).toContain('state := 0');
    expect(load.content).toMatch(/state := \d+; \(\* -> st_/);
    expect(load.content).not.toContain('#state');
    expect(load.content).not.toContain('#i_estop_active');
  });

  it('rewrites alarm writes to GVL_Alarms.set_<id>', () => {
    expect(load.content).toContain(
      'GVL_Alarms.set_al_cyl_ext_timeout := TRUE',
    );
    expect(load.content).not.toContain('"DB_Alarms"');
  });

  it('preserves IEC time literal T#5000MS', () => {
    expect(load.content).toContain('T#5000MS');
  });

  it('includes the CASE dispatch with all state ids', () => {
    expect(load.content).toContain('CASE state OF');
    for (const id of [
      'st_idle',
      'st_extending',
      'st_holding',
      'st_retracting',
      'st_fault',
    ]) {
      expect(load.content).toContain(id);
    }
  });

  it('declares R_TRIG instances and ticks them with IEC syntax', () => {
    expect(load.content).toContain('R_TRIG_st_load_sen_part : R_TRIG');
    expect(load.content).toMatch(
      /R_TRIG_st_load_sen_part\(CLK := io_part_sensor\);/,
    );
  });

  it('uses (* *) comments, not //', () => {
    expect(load.content).toContain('(*');
    expect(load.content).toContain('*)');
    // Header banner converted from //
    expect(load.content).not.toMatch(/^\s*\/\/ /m);
  });

  it('does NOT emit the BEGIN keyword', () => {
    expect(load.content).not.toMatch(/\nBEGIN\n/);
  });
});

describe('generateCodesysProject — DUTs', () => {
  const artifacts = generateCodesysProject(clone(), CLOCK);

  it('emits DUT for pneumatic_cylinder_2pos with IEC types', () => {
    const dut = artifacts.find((a) => a.path.endsWith('DUT_Cylinder2Pos.st'))!;
    expect(dut.content).toContain('TYPE DUT_Cylinder2Pos :');
    expect(dut.content).toContain('cmd_extend : BOOL;');
    expect(dut.content).toContain('END_STRUCT');
    expect(dut.content).toContain('END_TYPE');
  });

  it('emits DUT for motor_simple', () => {
    const dut = artifacts.find((a) => a.path.endsWith('DUT_MotorSimple.st'))!;
    expect(dut.content).toContain('TYPE DUT_MotorSimple :');
    expect(dut.content).toContain('run_cmd : BOOL;');
  });
});

describe('generateCodesysProject — GVLs', () => {
  const artifacts = generateCodesysProject(clone(), CLOCK);

  it('GVL_Parameters declares each parameter with IEC type + init', () => {
    const gvl = artifacts.find((a) => a.path.endsWith('GVL_Parameters.st'))!;
    expect(gvl.content).toContain('VAR_GLOBAL');
    expect(gvl.content).toContain('p_weld_current : REAL := 150.0;');
    expect(gvl.content).toContain('p_weld_time : DINT := 3000;');
    expect(gvl.content).toContain('END_VAR');
  });

  it('GVL_Recipes flattens <recipeId>_<paramId>', () => {
    const gvl = artifacts.find((a) => a.path.endsWith('GVL_Recipes.st'))!;
    expect(gvl.content).toContain('r_default_p_weld_current : REAL := 150.0;');
    expect(gvl.content).toContain('r_default_p_weld_time : DINT := 3000;');
  });

  it('GVL_Alarms has ack_all + set_/active_ pairs', () => {
    const gvl = artifacts.find((a) => a.path.endsWith('GVL_Alarms.st'))!;
    expect(gvl.content).toContain('ack_all : BOOL;');
    expect(gvl.content).toContain('set_al_cyl_ext_timeout : BOOL;');
    expect(gvl.content).toContain('active_al_cyl_ext_timeout : BOOL;');
  });
});

describe('generateCodesysProject — manifest', () => {
  const artifacts = generateCodesysProject(clone(), CLOCK);
  const manifest = artifacts.find((a) => a.path.endsWith('manifest.json'))!;
  const data = JSON.parse(manifest.content) as {
    backend: string;
    experimental: boolean;
    target: { vendor: string };
    artifacts: string[];
    features: { use_db_alarms: boolean };
    compiler_diagnostics?: unknown[];
    generated_at: string;
  };

  it('marks itself as the codesys backend, experimental', () => {
    expect(data.backend).toBe('codesys');
    expect(data.experimental).toBe(true);
    expect(data.target.vendor).toBe('codesys_iec61131');
  });

  it('inherits the generated_at clock from compileProject options', () => {
    expect(data.generated_at).toBe('2026-04-25T00:00:00Z');
  });

  it('lists every emitted artifact (basenames) but not manifest.json', () => {
    expect(data.artifacts).toContain('FB_StLoad.st');
    expect(data.artifacts).toContain('GVL_Alarms.st');
    expect(data.artifacts).not.toContain('manifest.json');
  });

  it('includes compiler_diagnostics when emitDiagnosticsInManifest is on', () => {
    expect(data.compiler_diagnostics).toBeDefined();
    expect(Array.isArray(data.compiler_diagnostics)).toBe(true);
  });
});

describe('generateCodesysProject — determinism', () => {
  it('produces byte-for-byte identical artifact contents across runs', () => {
    const a = generateCodesysProject(clone(), CLOCK);
    const b = generateCodesysProject(clone(), CLOCK);
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
    expect(a.map((x) => x.path)).toEqual(b.map((x) => x.path));
  });
});
