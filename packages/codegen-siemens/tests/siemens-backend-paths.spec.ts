import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateSiemensProject } from '../src/generators/project.js';
import { compileProject as compileProjectCore } from '@plccopilot/codegen-core';
import { renderProgramArtifacts } from '../src/compiler/program/artifacts.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-26T00:00:00Z' } };

/**
 * Siemens backend takes ownership of every physical path. The ProgramIR from
 * core is logical; this test pins the Siemens-side path conventions
 * (`siemens/<name>.<ext>`).
 */
describe('siemens backend — physical artifact paths', () => {
  const artifacts = generateSiemensProject(clone(), CLOCK);
  const paths = artifacts.map((a) => a.path);

  it('every artifact path is rooted at `siemens/`', () => {
    for (const p of paths) expect(p.startsWith('siemens/')).toBe(true);
  });

  it('FBs use `.scl`, tag table uses `.csv`, manifest uses `.json`', () => {
    expect(paths.filter((p) => p.endsWith('.scl')).length).toBeGreaterThan(0);
    expect(paths.filter((p) => p.endsWith('.csv'))).toEqual([
      'siemens/Tags_Main.csv',
    ]);
    expect(paths.filter((p) => p.endsWith('.json'))).toEqual([
      'siemens/manifest.json',
    ]);
  });

  it('canonical artifact set is emitted in the documented order', () => {
    expect(paths).toEqual([
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

  it('manifest carries Siemens-flavoured generator + target', () => {
    const manifest = artifacts.find((a) => a.path === 'siemens/manifest.json')!;
    const data = JSON.parse(manifest.content) as {
      generator: string;
      target: { vendor: string; tia_version: string };
      artifacts: string[];
    };
    expect(data.generator).toBe('@plccopilot/codegen-siemens');
    expect(data.target.vendor).toBe('siemens_s7_1500');
    expect(data.target.tia_version).toBe('19');
    expect(data.artifacts).not.toContain('manifest.json');
    expect(data.artifacts).toContain('FB_StLoad.scl');
    expect(data.artifacts).toContain('Tags_Main.csv');
  });

  it('SCL FB headers retain `S7_Optimized_Access` (renderer-injected)', () => {
    const load = artifacts.find((a) => a.path.endsWith('FB_StLoad.scl'))!;
    expect(load.content).toContain(`{ S7_Optimized_Access := 'TRUE' }`);
    const fbAlarms = artifacts.find((a) => a.path.endsWith('FB_Alarms.scl'))!;
    expect(fbAlarms.content).toContain(`{ S7_Optimized_Access := 'TRUE' }`);
  });

  it('Tags_Main.csv renders Siemens %I/%Q-style addresses', () => {
    const csv = artifacts.find((a) => a.path.endsWith('Tags_Main.csv'))!;
    expect(csv.content).toMatch(/%I[0-9]+\.[0-9]+/);
  });

  it('output is deterministic across two runs', () => {
    const a = generateSiemensProject(clone(), CLOCK);
    const b = generateSiemensProject(clone(), CLOCK);
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
  });
});

describe('siemens renderer — accepts neutral ProgramIR from core', () => {
  it('renders a complete Siemens artifact bundle from a core-only ProgramIR', () => {
    const program = compileProjectCore(clone(), { generatedAt: '2026-04-26T00:00:00Z' });
    const artifacts = renderProgramArtifacts(program);
    const paths = artifacts.map((a) => a.path);
    expect(paths).toContain('siemens/manifest.json');
    expect(paths.filter((p) => p.endsWith('.scl')).length).toBeGreaterThan(0);

    const manifest = artifacts.find((a) => a.path === 'siemens/manifest.json')!;
    const data = JSON.parse(manifest.content) as {
      generator: string;
      target: { vendor: string; tia_version: string };
      artifacts: string[];
    };
    // Defaults injected by the Siemens manifest renderer when the IR is neutral.
    expect(data.generator).toBe('@plccopilot/codegen-siemens');
    expect(data.target.vendor).toBe('siemens_s7_1500');
    expect(data.target.tia_version).toBe('19');
    expect(data.artifacts.length).toBeGreaterThan(0);
  });
});
