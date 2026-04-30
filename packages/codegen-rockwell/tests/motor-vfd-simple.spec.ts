// Sprint 88J — Rockwell supports `motor_vfd_simple` after the
// Logix renderer audit confirmed structural agnosticism: no
// per-equipment switch in `renderStmtRockwell` /
// `renderTypeArtifactRockwell` / `renderFunctionBlockRockwell`;
// fields iterated blindly with per-field `dataType` → IEC type;
// SymbolRef → parameter renders via the shared `renderStorage`
// path (bare global identifier on Rockwell, no quoting / no `#`
// prefix); canonical `UDT_MotorVfdSimple` accepted verbatim with
// no rewrite; per-project `ROCKWELL_*` diagnostics never gated on
// equipment kind.
//
// This spec mirrors `valve-onoff.spec.ts` for shape: synthetic
// project, end-to-end through `generateRockwellProject`,
// deterministic shape pinned by string assertions on UDT + station
// FB.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { generateRockwellProject } from '../src/index.js';

const CLOCK = { manifest: { generatedAt: '2026-04-30T00:00:00Z' } };

function vfdProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_vfd88j',
    name: 'Sprint 88J motor_vfd_simple smoke (Rockwell)',
    description:
      'Single-station VFD-driven motor with parameter-sourced speed setpoint, Rockwell target.',
    machines: [
      {
        id: 'mch_v',
        name: 'VFD machine',
        stations: [
          {
            id: 'st_run',
            name: 'Run Station',
            equipment: [
              {
                id: 'mot01',
                name: 'Conveyor motor',
                type: 'motor_vfd_simple',
                code_symbol: 'M01',
                io_bindings: {
                  run_out: 'io_m01_run',
                  speed_setpoint_out: 'io_m01_speed_aw',
                },
                io_setpoint_bindings: {
                  speed_setpoint_out: 'p_m01_speed',
                },
              },
            ],
            sequence: {
              states: [
                { id: 'st_idle', name: 'Idle', kind: 'initial' },
                {
                  id: 'st_running',
                  name: 'Running',
                  kind: 'normal',
                  activity: { activate: ['mot01.run'] },
                },
              ],
              transitions: [
                {
                  id: 't_start',
                  from: 'st_idle',
                  to: 'st_running',
                  trigger: 'rising(start_button)',
                  priority: 1,
                },
                {
                  id: 't_stop',
                  from: 'st_running',
                  to: 'st_idle',
                  trigger: 'falling(start_button)',
                  priority: 1,
                },
              ],
            },
          },
        ],
        io: [
          {
            id: 'io_m01_run',
            name: 'M01 run',
            direction: 'out',
            data_type: 'bool',
            address: { memory_area: 'Q', byte: 0, bit: 0 },
          },
          {
            id: 'io_m01_speed_aw',
            name: 'M01 speed AW',
            direction: 'out',
            data_type: 'real',
            address: { memory_area: 'Q', byte: 100 },
          },
          {
            id: 'start_button',
            name: 'Start button',
            direction: 'in',
            data_type: 'bool',
            address: { memory_area: 'I', byte: 0, bit: 0 },
          },
        ],
        alarms: [],
        interlocks: [],
        parameters: [
          {
            id: 'p_m01_speed',
            name: 'M01 speed setpoint',
            data_type: 'real',
            default: 50,
            min: 0,
            max: 100,
            unit: 'Hz',
          },
        ],
        recipes: [],
        safety_groups: [],
      },
    ],
  } as unknown as Project;
}

describe('generateRockwellProject — Sprint 88J motor_vfd_simple', () => {
  const artifacts = generateRockwellProject(vfdProject(), CLOCK);

  it('1. preflight passes — no READINESS_FAILED throw on a motor_vfd_simple project', () => {
    expect(artifacts.length).toBeGreaterThan(0);
  });

  it('2. emits UDT_MotorVfdSimple at rockwell/UDT_MotorVfdSimple.st with the documented field set', () => {
    const udt = artifacts.find(
      (a) => a.path === 'rockwell/UDT_MotorVfdSimple.st',
    );
    expect(udt).toBeDefined();
    expect(udt!.kind).toBe('st');
    expect(udt!.content).toContain('UDT_MotorVfdSimple');
    expect(udt!.content).toMatch(/cmd_run\s*:\s*BOOL/);
    expect(udt!.content).toMatch(/speed_setpoint\s*:\s*REAL/);
    expect(udt!.content).toMatch(/fault\s*:\s*BOOL/);
    // Pin the minimal v0 surface — none of these belong on the
    // motor_vfd_simple UDT until a higher-fidelity equipment kind
    // ships them deliberately.
    for (const forbidden of [
      'cmd_open',
      'cmd_close',
      'fb_open',
      'fb_closed',
      'busy',
      'done',
      'position',
      'reset',
      'reverse',
      'permissive',
      'ramp',
    ]) {
      expect(udt!.content).not.toContain(forbidden);
    }
  });

  it('3. station FB body wires the run command into the run_out IO with a deterministic breadcrumb', () => {
    const fb = artifacts.find((a) => a.path === 'rockwell/FB_StRun.st');
    expect(fb).toBeDefined();
    // Lowering breadcrumb is part of the IR (emitted by
    // wireMotorVfdSimple) and survives Rockwell rendering verbatim.
    expect(fb!.content).toContain(
      'mot01 (motor_vfd_simple): run_cmd -> run_out',
    );
    // Rockwell convention: bare global identifiers (no `#` prefix,
    // no double-quoting). Local command vars are also bare.
    expect(fb!.content).toMatch(/io_m01_run\s*:=\s*mot01_run_cmd/);
  });

  it('4. station FB body wires the bound parameter symbol into speed_setpoint_out', () => {
    const fb = artifacts.find((a) => a.path === 'rockwell/FB_StRun.st');
    expect(fb).toBeDefined();
    expect(fb!.content).toContain(
      'mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out',
    );
    // Parameter renders as a bare global identifier (Rockwell
    // convention via shared renderStorage with kind: 'global').
    // The key invariant: the source is the parameter, never a literal.
    expect(fb!.content).toMatch(
      /io_m01_speed_aw\s*:=\s*p_m01_speed\s*;/,
    );
  });

  it('5. lowering does NOT synthesise any literal as the speed_setpoint source', () => {
    const fb = artifacts.find((a) => a.path === 'rockwell/FB_StRun.st');
    expect(fb).toBeDefined();
    // The Rockwell station FB legitimately contains numeric
    // literals for sequence state machine dispatch. The contract
    // pinned here is narrower: any assignment whose target is
    // `io_m01_speed_aw` must NOT be of the form
    // `io_m01_speed_aw := <number>;` or
    // `io_m01_speed_aw := TRUE/FALSE;`. A literal RHS would mean
    // the lowering invented a value.
    expect(fb!.content).not.toMatch(
      /io_m01_speed_aw\s*:=\s*(?:TRUE|FALSE|-?\d+(?:\.\d+)?)\s*;/,
    );
  });

  it('6. lowering does NOT synthesise close/reset/reverse/ramp/permissive/fault-latch/busy/done/position signals', () => {
    const fb = artifacts.find((a) => a.path === 'rockwell/FB_StRun.st');
    expect(fb).toBeDefined();
    // Strip block + line comments before scanning so the lowering
    // breadcrumb does not produce false positives. Rockwell ST
    // accepts both `(* ... *)` and `// ...` comment styles.
    const stripped = fb!.content
      .replace(/\(\*[\s\S]*?\*\)/g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const forbidden of [
      'mot01_close',
      'mot01_busy',
      'mot01_done',
      'mot01_position',
      'mot01_reverse',
      'mot01_reset',
      'mot01_permissive',
      'mot01_ramp',
    ]) {
      expect(stripped).not.toContain(forbidden);
    }
    // Defensive: nothing assigns into mot01.fault (the UDT exposes
    // the bit but lowering does not drive it; alarm/interlock
    // layers do).
    expect(stripped).not.toMatch(/mot01[._]fault\s*:=/);
  });

  it('7. manifest is clean of UNSUPPORTED_* / READINESS_FAILED / READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET and retains ROCKWELL_EXPERIMENTAL_BACKEND', () => {
    const manifest = artifacts.find(
      (a) => a.path === 'rockwell/manifest.json',
    );
    expect(manifest).toBeDefined();
    expect(manifest!.kind).toBe('json');
    const parsed = JSON.parse(manifest!.content);
    const diags: Array<{ code: string }> =
      parsed.compiler_diagnostics ?? parsed.compilerDiagnostics ?? [];
    expect(
      diags.every(
        (d) =>
          d.code !== 'UNSUPPORTED_EQUIPMENT' &&
          d.code !== 'UNSUPPORTED_ACTIVITY' &&
          d.code !== 'READINESS_FAILED' &&
          d.code !== 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(true);
    // Rockwell still flags itself as experimental — keep the
    // existing global diagnostic intact.
    expect(diags.some((d) => d.code === 'ROCKWELL_EXPERIMENTAL_BACKEND')).toBe(
      true,
    );
  });

  it('8. missing speed_setpoint_out IO binding still surfaces UNBOUND_ROLE', () => {
    const p = vfdProject();
    delete (p.machines[0]!.stations[0]!.equipment[0]!.io_bindings as Record<
      string,
      string
    >).speed_setpoint_out;
    let caught: { code?: string; symbol?: string } | undefined;
    try {
      generateRockwellProject(p, CLOCK);
    } catch (e) {
      caught = e as { code: string; symbol: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('UNBOUND_ROLE');
    expect(caught?.symbol).toContain('speed_setpoint_out');
  });

  it('9. missing io_setpoint_bindings still surfaces UNBOUND_SETPOINT_SOURCE', () => {
    const p = vfdProject();
    delete p.machines[0]!.stations[0]!.equipment[0]!.io_setpoint_bindings;
    let caught: { code?: string; symbol?: string } | undefined;
    try {
      generateRockwellProject(p, CLOCK);
    } catch (e) {
      caught = e as { code: string; symbol: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('UNBOUND_SETPOINT_SOURCE');
    expect(caught?.symbol).toContain('speed_setpoint_out');
  });

  it('10. generation is deterministic across two runs of the same fixture', () => {
    const a = generateRockwellProject(vfdProject(), CLOCK);
    const b = generateRockwellProject(vfdProject(), CLOCK);
    expect(a.map((art) => art.path)).toEqual(b.map((art) => art.path));
    expect(a.map((art) => art.content)).toEqual(b.map((art) => art.content));
  });

  it('11. artifact list contains exactly one UDT_MotorVfdSimple, no duplicates', () => {
    const udtPaths = artifacts
      .filter((a) => a.path.includes('UDT_MotorVfdSimple'))
      .map((a) => a.path);
    expect(udtPaths).toEqual(['rockwell/UDT_MotorVfdSimple.st']);
    const allPaths = artifacts.map((a) => a.path);
    const uniquePaths = Array.from(new Set(allPaths));
    expect(allPaths.length).toBe(uniquePaths.length);
  });
});
