import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateSiemensProject } from '@plccopilot/codegen-siemens';
import { generateCodesysProject } from '@plccopilot/codegen-codesys';
import { generateRockwellProject } from '@plccopilot/codegen-rockwell';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-25T00:00:00Z' } };

const STATE_IDS = [
  'st_idle',
  'st_extending',
  'st_holding',
  'st_retracting',
  'st_fault',
];

describe('backend-equivalence — Siemens vs Codesys (same ProgramIR)', () => {
  const sie = generateSiemensProject(clone(), CLOCK);
  const cod = generateCodesysProject(clone(), CLOCK);

  it('both backends emit one station FB per station', () => {
    const sieStations = sie.filter((a) =>
      /\/FB_St[A-Z][A-Za-z]+\.scl$/.test(a.path),
    );
    const codStations = cod.filter((a) =>
      /\/FB_St[A-Z][A-Za-z]+\.st$/.test(a.path),
    );
    expect(sieStations.length).toBe(codStations.length);
    expect(codStations.length).toBe(2); // st_load + st_weld
  });

  it('both backends emit FB_Alarms when alarms exist', () => {
    expect(sie.some((a) => a.path.endsWith('FB_Alarms.scl'))).toBe(true);
    expect(cod.some((a) => a.path.endsWith('FB_Alarms.st'))).toBe(true);
  });

  it('both station FBs contain every PIR state id', () => {
    const sieLoad = sie.find((a) => a.path.endsWith('FB_StLoad.scl'))!;
    const codLoad = cod.find((a) => a.path.endsWith('FB_StLoad.st'))!;
    for (const id of STATE_IDS) {
      expect(sieLoad.content).toContain(id);
      expect(codLoad.content).toContain(id);
    }
  });

  it('both backends emit a CASE dispatch keyed on state', () => {
    const sieLoad = sie.find((a) => a.path.endsWith('FB_StLoad.scl'))!;
    const codLoad = cod.find((a) => a.path.endsWith('FB_StLoad.st'))!;
    expect(sieLoad.content).toContain('CASE #state OF');
    expect(codLoad.content).toContain('CASE state OF');
  });

  it('both alarm managers latch the same alarm set', () => {
    const sieAlarms = sie.find((a) => a.path.endsWith('FB_Alarms.scl'))!;
    const codAlarms = cod.find((a) => a.path.endsWith('FB_Alarms.st'))!;
    for (const id of [
      'al_cyl_ext_timeout',
      'al_cyl_ret_timeout',
      'al_estop_active',
    ]) {
      expect(sieAlarms.content).toContain(`set_${id}`);
      expect(sieAlarms.content).toContain(`active_${id}`);
      expect(codAlarms.content).toContain(`set_${id}`);
      expect(codAlarms.content).toContain(`active_${id}`);
    }
  });

  it('manifests carry the same compiler_diagnostics (shared ProgramIR)', () => {
    const sieManifest = JSON.parse(
      sie.find((a) => a.path.endsWith('manifest.json'))!.content,
    ) as { compiler_diagnostics: unknown[] };
    const codManifest = JSON.parse(
      cod.find((a) => a.path.endsWith('manifest.json'))!.content,
    ) as { compiler_diagnostics: unknown[] };
    expect(codManifest.compiler_diagnostics).toEqual(
      sieManifest.compiler_diagnostics,
    );
  });

  it('Codesys executable / declarative content carries no Siemens conventions', () => {
    // Strip (* ... *) comment blocks before checking — comments may legitimately
    // quote a transition id or include `// activity.activate: ...` text that
    // came verbatim from the IR.
    for (const a of cod) {
      if (a.kind === 'json') continue;
      const stripped = a.content.replace(/\(\*[\s\S]*?\*\)/g, '');
      expect(stripped).not.toMatch(/"[A-Za-z_][A-Za-z0-9_]*"/);
      expect(stripped).not.toMatch(/(^|\s)#[A-Za-z_]/);
      expect(stripped).not.toMatch(/^\s*VERSION : /m);
    }
  });

  it('both backends emit type artifacts with identical field lists', () => {
    const sieCyl = sie.find((a) => a.path.endsWith('UDT_Cylinder2Pos.scl'))!;
    const codCyl = cod.find((a) => a.path.endsWith('DUT_Cylinder2Pos.st'))!;
    for (const field of [
      'cmd_extend',
      'fb_extended',
      'fb_retracted',
      'busy',
      'fault',
    ]) {
      expect(sieCyl.content).toContain(`${field} : Bool;`);
      expect(codCyl.content).toContain(`${field} : BOOL;`);
    }
    const sieMot = sie.find((a) => a.path.endsWith('UDT_MotorSimple.scl'))!;
    const codMot = cod.find((a) => a.path.endsWith('DUT_MotorSimple.st'))!;
    for (const field of ['run_cmd', 'running_fb', 'fault']) {
      expect(sieMot.content).toContain(`${field} : Bool;`);
      expect(codMot.content).toContain(`${field} : BOOL;`);
    }
  });

  it('TON.Q checks render identically (modulo # prefix) on both backends', () => {
    const sieLoad = sie.find((a) => a.path.endsWith('FB_StLoad.scl'))!;
    const codLoad = cod.find((a) => a.path.endsWith('FB_StLoad.st'))!;
    expect(sieLoad.content).toContain('IF #TON_t_extended.Q THEN');
    expect(codLoad.content).toContain('IF TON_t_extended.Q THEN');
  });

  it('both backends agree on the number + names of state FBs', () => {
    const sieNames = sie
      .filter((a) => a.path.endsWith('.scl') && a.path.includes('/FB_St'))
      .map((a) => a.path.replace(/\.scl$/, '').replace(/^.*\//, ''));
    const codNames = cod
      .filter((a) => a.path.endsWith('.st') && a.path.includes('/FB_St'))
      .map((a) => a.path.replace(/\.st$/, '').replace(/^.*\//, ''));
    expect(sieNames).toEqual(codNames);
  });
});

describe('backend-equivalence — feature flags propagate to both', () => {
  it('useDbAlarms=false drops alarm artifacts from BOTH backends', () => {
    const opts = { ...CLOCK, features: { useDbAlarms: false } };
    const sie = generateSiemensProject(clone(), opts);
    const cod = generateCodesysProject(clone(), opts);
    expect(sie.some((a) => a.path.endsWith('DB_Alarms.scl'))).toBe(false);
    expect(sie.some((a) => a.path.endsWith('FB_Alarms.scl'))).toBe(false);
    expect(cod.some((a) => a.path.endsWith('GVL_Alarms.st'))).toBe(false);
    expect(cod.some((a) => a.path.endsWith('FB_Alarms.st'))).toBe(false);
  });
});

describe('backend-equivalence — determinism across backends', () => {
  it('Siemens output is byte-for-byte identical across two runs', () => {
    const a = generateSiemensProject(clone(), CLOCK);
    const b = generateSiemensProject(clone(), CLOCK);
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
  });

  it('Codesys output is byte-for-byte identical across two runs', () => {
    const a = generateCodesysProject(clone(), CLOCK);
    const b = generateCodesysProject(clone(), CLOCK);
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
  });

  it('Siemens and Codesys runs do not interfere with each other (no shared mutable state)', () => {
    // Interleave the calls to flush out any singleton / cache leakage.
    const sie1 = generateSiemensProject(clone(), CLOCK);
    const cod1 = generateCodesysProject(clone(), CLOCK);
    const sie2 = generateSiemensProject(clone(), CLOCK);
    const cod2 = generateCodesysProject(clone(), CLOCK);
    expect(sie1.map((x) => x.content)).toEqual(sie2.map((x) => x.content));
    expect(cod1.map((x) => x.content)).toEqual(cod2.map((x) => x.content));
  });
});

describe('backend-equivalence — minimal landmark snapshots', () => {
  // These snapshots are deliberately tiny: they pin a small, well-known set
  // of substrings on each backend so any accidental rendering drift surfaces
  // immediately. Full content snapshots would be brittle against intentional
  // formatting tweaks; these tighten only the contractual landmarks.

  const sie = generateSiemensProject(clone(), CLOCK);
  const cod = generateCodesysProject(clone(), CLOCK);

  it('Siemens FB_StLoad pins the canonical Siemens header', () => {
    const load = sie.find((a) => a.path.endsWith('FB_StLoad.scl'))!;
    const head = load.content.split('\n').slice(0, 8).join('\n');
    expect(head).toContain('FUNCTION_BLOCK "FB_StLoad"');
    expect(head).toContain(`{ S7_Optimized_Access := 'TRUE' }`);
    expect(head).toContain('VERSION : 0.1');
  });

  it('Codesys FB_StLoad pins the canonical IEC 61131-3 header', () => {
    const load = cod.find((a) => a.path.endsWith('FB_StLoad.st'))!;
    const head = load.content.split('\n').slice(0, 8).join('\n');
    expect(head).toContain('FUNCTION_BLOCK FB_StLoad');
    expect(head).not.toContain('"FB_StLoad"');
    expect(head).not.toContain('VERSION');
    expect(head).not.toContain('S7_Optimized_Access');
  });

  it('Siemens DB_Alarms pins canonical DATA_BLOCK structure', () => {
    const db = sie.find((a) => a.path.endsWith('DB_Alarms.scl'))!;
    expect(db.content).toContain('DATA_BLOCK "DB_Alarms"');
    expect(db.content).toContain('ack_all : Bool;');
    expect(db.content).toContain('set_al_cyl_ext_timeout : Bool;');
    expect(db.content).toContain('END_DATA_BLOCK');
  });

  it('Codesys GVL_Alarms pins canonical VAR_GLOBAL structure', () => {
    const gvl = cod.find((a) => a.path.endsWith('GVL_Alarms.st'))!;
    expect(gvl.content).toContain('VAR_GLOBAL');
    expect(gvl.content).toContain('ack_all : BOOL;');
    expect(gvl.content).toContain('set_al_cyl_ext_timeout : BOOL;');
    expect(gvl.content).toContain('END_VAR');
  });
});

// =============================================================================
// Tri-backend equivalence — Siemens / Codesys / Rockwell
// All three consume the same ProgramIR. Counts and contractual elements must
// match; backend-specific lexical conventions are validated elsewhere.
// =============================================================================

const ALARM_IDS = [
  'al_cyl_ext_timeout',
  'al_cyl_ret_timeout',
  'al_estop_active',
];

describe('backend-equivalence — tri-backend (Siemens / Codesys / Rockwell)', () => {
  const sie = generateSiemensProject(clone(), CLOCK);
  const cod = generateCodesysProject(clone(), CLOCK);
  const roc = generateRockwellProject(clone(), CLOCK);

  function stationsOf(
    artifacts: { path: string }[],
    ext: 'scl' | 'st',
  ): string[] {
    const re = new RegExp(`/FB_St[A-Z][A-Za-z]+\\.${ext}$`);
    return artifacts
      .filter((a) => re.test(a.path))
      .map((a) => a.path.replace(/^.*\//, '').replace(/\.\w+$/, ''));
  }

  it('all three backends emit one station FB per PIR station, with identical names', () => {
    const sieNames = stationsOf(sie, 'scl');
    const codNames = stationsOf(cod, 'st');
    const rocNames = stationsOf(roc, 'st');
    expect(sieNames.length).toBe(2); // st_load + st_weld
    expect(codNames).toEqual(sieNames);
    expect(rocNames).toEqual(sieNames);
  });

  it('all three backends emit FB_Alarms', () => {
    expect(sie.some((a) => a.path.endsWith('FB_Alarms.scl'))).toBe(true);
    expect(cod.some((a) => a.path.endsWith('FB_Alarms.st'))).toBe(true);
    expect(roc.some((a) => a.path.endsWith('FB_Alarms.st'))).toBe(true);
  });

  it('all three alarm managers latch the same alarm set', () => {
    const sieAlarms = sie.find((a) => a.path.endsWith('FB_Alarms.scl'))!;
    const codAlarms = cod.find((a) => a.path.endsWith('FB_Alarms.st'))!;
    const rocAlarms = roc.find((a) => a.path.endsWith('FB_Alarms.st'))!;
    for (const id of ALARM_IDS) {
      expect(sieAlarms.content).toContain(`set_${id}`);
      expect(sieAlarms.content).toContain(`active_${id}`);
      expect(codAlarms.content).toContain(`set_${id}`);
      expect(codAlarms.content).toContain(`active_${id}`);
      expect(rocAlarms.content).toContain(`set_${id}`);
      expect(rocAlarms.content).toContain(`active_${id}`);
    }
  });

  it('all three backends emit equipment-derived UDTs with identical names', () => {
    const sieUdts = sie
      .filter((a) => /UDT_[A-Za-z0-9_]+\.scl$/.test(a.path))
      .map((a) => a.path.replace(/^.*\//, '').replace(/\.\w+$/, ''));
    const rocUdts = roc
      .filter((a) => /UDT_[A-Za-z0-9_]+\.st$/.test(a.path))
      .map((a) => a.path.replace(/^.*\//, '').replace(/\.\w+$/, ''));
    expect(sieUdts.sort()).toEqual(['UDT_Cylinder2Pos', 'UDT_MotorSimple']);
    expect(rocUdts.sort()).toEqual(sieUdts.sort());
  });

  it('all three manifests inherit base compile-time diagnostics (TIMEOUT_NO_AUTO_TRANSITION)', () => {
    const sieDiags = JSON.parse(
      sie.find((a) => a.path.endsWith('manifest.json'))!.content,
    ).compiler_diagnostics as Array<{ code: string }>;
    const codDiags = JSON.parse(
      cod.find((a) => a.path.endsWith('manifest.json'))!.content,
    ).compiler_diagnostics as Array<{ code: string }>;
    const rocDiags = JSON.parse(
      roc.find((a) => a.path.endsWith('manifest.json'))!.content,
    ).compiler_diagnostics as Array<{ code: string }>;
    for (const diags of [sieDiags, codDiags, rocDiags]) {
      expect(diags.some((d) => d.code === 'TIMEOUT_NO_AUTO_TRANSITION')).toBe(
        true,
      );
    }
  });

  it('only the Rockwell manifest carries ROCKWELL_* diagnostics', () => {
    const sieCodes = (
      JSON.parse(
        sie.find((a) => a.path.endsWith('manifest.json'))!.content,
      ).compiler_diagnostics as Array<{ code: string }>
    ).map((d) => d.code);
    const codCodes = (
      JSON.parse(
        cod.find((a) => a.path.endsWith('manifest.json'))!.content,
      ).compiler_diagnostics as Array<{ code: string }>
    ).map((d) => d.code);
    const rocCodes = (
      JSON.parse(
        roc.find((a) => a.path.endsWith('manifest.json'))!.content,
      ).compiler_diagnostics as Array<{ code: string }>
    ).map((d) => d.code);
    expect(sieCodes.some((c) => c.startsWith('ROCKWELL_'))).toBe(false);
    expect(codCodes.some((c) => c.startsWith('ROCKWELL_'))).toBe(false);
    expect(rocCodes).toContain('ROCKWELL_EXPERIMENTAL_BACKEND');
    expect(rocCodes).toContain('ROCKWELL_NO_L5X_EXPORT');
    expect(rocCodes).toContain('ROCKWELL_TIMER_PSEUDO_IEC');
  });

  it('all three backends are deterministic across two runs', () => {
    const sie2 = generateSiemensProject(clone(), CLOCK);
    const cod2 = generateCodesysProject(clone(), CLOCK);
    const roc2 = generateRockwellProject(clone(), CLOCK);
    expect(sie.map((a) => a.content)).toEqual(sie2.map((a) => a.content));
    expect(cod.map((a) => a.content)).toEqual(cod2.map((a) => a.content));
    expect(roc.map((a) => a.content)).toEqual(roc2.map((a) => a.content));
  });

  it('useDbAlarms=false drops alarm artifacts on ALL THREE backends', () => {
    const opts = { ...CLOCK, features: { useDbAlarms: false } };
    const sieF = generateSiemensProject(clone(), opts);
    const codF = generateCodesysProject(clone(), opts);
    const rocF = generateRockwellProject(clone(), opts);
    expect(sieF.some((a) => a.path.endsWith('DB_Alarms.scl'))).toBe(false);
    expect(sieF.some((a) => a.path.endsWith('FB_Alarms.scl'))).toBe(false);
    expect(codF.some((a) => a.path.endsWith('GVL_Alarms.st'))).toBe(false);
    expect(codF.some((a) => a.path.endsWith('FB_Alarms.st'))).toBe(false);
    expect(rocF.some((a) => a.path.endsWith('TAG_Alarms.st'))).toBe(false);
    expect(rocF.some((a) => a.path.endsWith('FB_Alarms.st'))).toBe(false);
  });
});
