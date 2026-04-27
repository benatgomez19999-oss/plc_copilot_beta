import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateRockwellProject } from '../src/index.js';
import { compileProject } from '@plccopilot/codegen-core';
import {
  computeRockwellDiagnostics,
  renderProgramArtifactsRockwell,
} from '../src/renderers/artifacts-rockwell.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-25T00:00:00Z' } };

interface RockwellManifest {
  generator: string;
  backend: string;
  experimental: boolean;
  version: string;
  pir_version: string;
  project_id: string;
  project_name: string;
  target: { vendor: string; studio_version: string | null };
  features: {
    use_db_alarms: boolean;
    emit_fb_alarms: boolean;
    emit_diagnostics_in_manifest: boolean;
    strict_diagnostics: boolean;
  };
  artifacts: string[];
  generated_at: string;
  compiler_diagnostics?: Array<{
    code: string;
    severity: string;
    message: string;
  }>;
}

function loadManifest(
  opts: Parameters<typeof generateRockwellProject>[1] = CLOCK,
): RockwellManifest {
  const artifacts = generateRockwellProject(clone(), opts);
  const manifest = artifacts.find((a) => a.path.endsWith('manifest.json'))!;
  return JSON.parse(manifest.content) as RockwellManifest;
}

function diagsOf(
  m: RockwellManifest,
): NonNullable<RockwellManifest['compiler_diagnostics']> {
  if (!m.compiler_diagnostics) {
    throw new Error('expected compiler_diagnostics on rockwell manifest');
  }
  return m.compiler_diagnostics;
}

describe('generateRockwellProject — full artifact set', () => {
  const artifacts = generateRockwellProject(clone(), CLOCK);

  it('produces the expected Rockwell artifact bundle for the weldline fixture', () => {
    expect(artifacts.map((a) => a.path)).toEqual([
      'rockwell/FB_StLoad.st',
      'rockwell/FB_StWeld.st',
      'rockwell/FB_Alarms.st',
      'rockwell/UDT_Cylinder2Pos.st',
      'rockwell/UDT_MotorSimple.st',
      'rockwell/TAG_Parameters.st',
      'rockwell/TAG_Recipes.st',
      'rockwell/TAG_Alarms.st',
      'rockwell/manifest.json',
    ]);
  });

  it('assigns kind=st to every text artifact and kind=json to manifest', () => {
    for (const a of artifacts) {
      if (a.path.endsWith('manifest.json')) expect(a.kind).toBe('json');
      else expect(a.kind).toBe('st');
    }
  });

  it('attaches station diagnostics to station FB artifacts', () => {
    const loadFb = artifacts.find((a) => a.path.endsWith('FB_StLoad.st'))!;
    expect(loadFb.diagnostics).toBeDefined();
    expect(
      loadFb.diagnostics!.every((d) => d.stationId === 'st_load'),
    ).toBe(true);
  });

  it('does not attach diagnostics to UDT / TAG / manifest artifacts', () => {
    const udt = artifacts.find((a) => a.path.endsWith('UDT_MotorSimple.st'))!;
    const tag = artifacts.find((a) => a.path.endsWith('TAG_Alarms.st'))!;
    const json = artifacts.find((a) => a.kind === 'json')!;
    expect(udt.diagnostics).toBeUndefined();
    expect(tag.diagnostics).toBeUndefined();
    expect(json.diagnostics).toBeUndefined();
  });

  it('is deterministic across two independent runs', () => {
    const a = generateRockwellProject(clone(), CLOCK);
    const b = generateRockwellProject(clone(), CLOCK);
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
    expect(a.map((x) => x.diagnostics)).toEqual(b.map((x) => x.diagnostics));
  });
});

describe('rockwell manifest — backend metadata', () => {
  it('declares backend=rockwell and experimental=true', () => {
    const data = loadManifest();
    expect(data.backend).toBe('rockwell');
    expect(data.experimental).toBe(true);
    expect(data.target.vendor).toBe('rockwell_logix5000');
    expect(data.target.studio_version).toBeNull();
  });

  it('lists every non-manifest artifact by basename in emission order', () => {
    const data = loadManifest();
    expect(data.artifacts).toEqual([
      'FB_StLoad.st',
      'FB_StWeld.st',
      'FB_Alarms.st',
      'UDT_Cylinder2Pos.st',
      'UDT_MotorSimple.st',
      'TAG_Parameters.st',
      'TAG_Recipes.st',
      'TAG_Alarms.st',
    ]);
    expect(data.artifacts).not.toContain('manifest.json');
  });

  it('reuses the injected clock value', () => {
    const data = loadManifest();
    expect(data.generated_at).toBe('2026-04-25T00:00:00Z');
  });

  it('carries the resolved compiler features in snake_case', () => {
    const data = loadManifest();
    expect(data.features).toEqual({
      use_db_alarms: true,
      emit_fb_alarms: true,
      emit_diagnostics_in_manifest: true,
      strict_diagnostics: false,
    });
  });
});

describe('rockwell manifest — diagnostics', () => {
  it('includes ROCKWELL_EXPERIMENTAL_BACKEND (info)', () => {
    const diags = diagsOf(loadManifest());
    expect(
      diags.some(
        (d) =>
          d.code === 'ROCKWELL_EXPERIMENTAL_BACKEND' && d.severity === 'info',
      ),
    ).toBe(true);
  });

  it('includes ROCKWELL_NO_L5X_EXPORT (info)', () => {
    const diags = diagsOf(loadManifest());
    expect(
      diags.some(
        (d) => d.code === 'ROCKWELL_NO_L5X_EXPORT' && d.severity === 'info',
      ),
    ).toBe(true);
  });

  it('includes ROCKWELL_TIMER_PSEUDO_IEC (warning) when TON instances exist', () => {
    const diags = diagsOf(loadManifest());
    expect(
      diags.some(
        (d) =>
          d.code === 'ROCKWELL_TIMER_PSEUDO_IEC' && d.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('inherits compile-time diagnostics shared with Siemens/Codesys (e.g., TIMEOUT_NO_AUTO_TRANSITION)', () => {
    const diags = diagsOf(loadManifest());
    expect(
      diags.some((d) => d.code === 'TIMEOUT_NO_AUTO_TRANSITION'),
    ).toBe(true);
  });

  it('emitDiagnosticsInManifest=false strips compiler_diagnostics', () => {
    const data = loadManifest({
      manifest: CLOCK.manifest,
      features: { emitDiagnosticsInManifest: false },
    });
    expect(data.compiler_diagnostics).toBeUndefined();
  });
});

describe('rockwell — feature flag propagation', () => {
  it('useDbAlarms=false drops alarm artifacts (FB_Alarms + TAG_Alarms)', () => {
    const artifacts = generateRockwellProject(clone(), {
      manifest: CLOCK.manifest,
      features: { useDbAlarms: false },
    });
    const paths = artifacts.map((a) => a.path);
    expect(paths).not.toContain('rockwell/FB_Alarms.st');
    expect(paths).not.toContain('rockwell/TAG_Alarms.st');
  });

  it('useDbAlarms=false surfaces ALARMS_AS_LOOSE_TAGS info (shared with Siemens)', () => {
    const data = loadManifest({
      manifest: CLOCK.manifest,
      features: { useDbAlarms: false },
    });
    const diags = diagsOf(data);
    expect(diags.some((d) => d.code === 'ALARMS_AS_LOOSE_TAGS')).toBe(true);
  });
});

describe('renderProgramArtifactsRockwell — direct ProgramIR entry point', () => {
  it('augments diagnostics idempotently when given a raw ProgramIR', () => {
    const program = compileProject(clone(), CLOCK);
    const a = renderProgramArtifactsRockwell(program);
    const b = renderProgramArtifactsRockwell(program);
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
    const manifestA = JSON.parse(
      a.find((x) => x.path.endsWith('manifest.json'))!.content,
    ) as RockwellManifest;
    expect(diagsOf(manifestA).some((d) => d.code === 'ROCKWELL_EXPERIMENTAL_BACKEND')).toBe(true);
  });

  it('computeRockwellDiagnostics is pure and produces 3 entries when timers exist', () => {
    const program = compileProject(clone(), CLOCK);
    const diags = computeRockwellDiagnostics(program);
    const codes = diags.map((d) => d.code).sort();
    expect(codes).toEqual([
      'ROCKWELL_EXPERIMENTAL_BACKEND',
      'ROCKWELL_NO_L5X_EXPORT',
      'ROCKWELL_TIMER_PSEUDO_IEC',
    ]);
  });
});

describe('rockwell station FB content — sanity', () => {
  const artifacts = generateRockwellProject(clone(), CLOCK);
  const load = artifacts.find((a) => a.path.endsWith('FB_StLoad.st'))!;

  it('uses CASE state OF without Siemens # prefix', () => {
    expect(load.content).toContain('CASE state OF');
    expect(load.content).not.toContain('CASE #state OF');
  });

  it('writes alarms via the Alarms.<bit> namespace', () => {
    expect(load.content).toContain('Alarms.set_al_cyl_ext_timeout');
    expect(load.content).not.toContain('"DB_Alarms"');
    expect(load.content).not.toContain('GVL_Alarms.');
  });

  it('renders rising-edge ticks as one-shot bit pattern', () => {
    expect(load.content).toMatch(
      /R_TRIG_[a-z_0-9]+ := [a-z_0-9.]+ AND NOT R_TRIG_[a-z_0-9]+_MEM;/,
    );
    expect(load.content).toMatch(/R_TRIG_[a-z_0-9]+_MEM := [a-z_0-9.]+;/);
  });

  it('declares BOTH the one-shot BOOL and its _MEM companion', () => {
    expect(load.content).toMatch(/R_TRIG_[a-z_0-9]+ : BOOL;/);
    expect(load.content).toMatch(/R_TRIG_[a-z_0-9]+_MEM : BOOL;/);
    // Sprint 38 — line-anchored regex. The renderer's traceability
    // comment legitimately includes `source: R_TRIG`, so a bare
    // substring check is too brittle. Assert no variable
    // declaration retains the FB type instead.
    expect(load.content).not.toMatch(/^\s*\w+ : R_TRIG;/m);
  });

  it('keeps TON instances pseudo-IEC and flags them in declarations', () => {
    expect(load.content).toMatch(/TON_[a-z_0-9]+ : TON;/);
    expect(load.content).toContain('pseudo-IEC TON');
  });
});

describe('rockwell tag files — content shape', () => {
  const artifacts = generateRockwellProject(clone(), CLOCK);

  it('TAG_Alarms.st prefixes every bit with Alarms.', () => {
    const tag = artifacts.find((a) => a.path.endsWith('TAG_Alarms.st'))!;
    expect(tag.content).toContain('Alarms.ack_all : BOOL;');
    expect(tag.content).toContain('Alarms.set_al_cyl_ext_timeout : BOOL;');
    expect(tag.content).toContain('Alarms.active_al_cyl_ext_timeout : BOOL;');
  });

  it('TAG_Parameters.st uses Logix INT/DINT/REAL types and plain field names', () => {
    const tag = artifacts.find((a) => a.path.endsWith('TAG_Parameters.st'))!;
    expect(tag.content).toContain('p_weld_current : REAL := 150.0;');
    expect(tag.content).toContain('p_weld_time : DINT := 3000;');
    expect(tag.content).not.toContain('"DB_Global_Params"');
    expect(tag.content).not.toContain('Parameters.p_weld_current');
  });

  it('TAG_Recipes.st renders flattened recipe entries', () => {
    const tag = artifacts.find((a) => a.path.endsWith('TAG_Recipes.st'))!;
    expect(tag.content).toContain('r_default_p_weld_time : DINT := 3000;');
  });
});
