// Sprint 88I — Siemens supports `motor_vfd_simple` after the SCL
// renderer audit confirmed structural agnosticism: no per-kind
// switch in `renderStmt` / `renderTypeArtifactSiemens` /
// `renderFunctionBlock`; UDT fields iterated blindly with per-field
// `dataType` → SCL type; SymbolRef → parameter renders via the
// shared `renderStorage` path (`"name"` for `kind: 'global'`);
// canonical `UDT_MotorVfdSimple` name accepted verbatim with no
// DUT_* rewrite; manifest is equipment-agnostic.
//
// This spec mirrors `valve-onoff.spec.ts` for shape: synthetic
// project, end-to-end through `generateSiemensProject`, deterministic
// shape pinned by string assertions on UDT + station FB.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { generateSiemensProject } from '../src/index.js';
import { udtName } from '../src/naming.js';

const CLOCK = { manifest: { generatedAt: '2026-04-30T00:00:00Z' } };

function vfdProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_vfd88i',
    name: 'Sprint 88I motor_vfd_simple smoke (Siemens)',
    description:
      'Single-station VFD-driven motor with parameter-sourced speed setpoint, Siemens target.',
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

describe('generateSiemensProject — Sprint 88I motor_vfd_simple', () => {
  const artifacts = generateSiemensProject(vfdProject(), CLOCK);

  it('1. preflight passes — no READINESS_FAILED throw on a motor_vfd_simple project', () => {
    expect(artifacts.length).toBeGreaterThan(0);
  });

  it('2. emits UDT_MotorVfdSimple at siemens/UDT_MotorVfdSimple.scl with the documented field set', () => {
    const udt = artifacts.find(
      (a) => a.path === 'siemens/UDT_MotorVfdSimple.scl',
    );
    expect(udt).toBeDefined();
    expect(udt!.kind).toBe('scl');
    expect(udt!.content).toContain('TYPE "UDT_MotorVfdSimple"');
    expect(udt!.content).toContain('cmd_run : Bool;');
    expect(udt!.content).toContain('speed_setpoint : Real;');
    expect(udt!.content).toContain('fault : Bool;');
    expect(udt!.content).toContain('END_STRUCT;');
    expect(udt!.content).toContain('END_TYPE');
    // Pin the minimal v0 surface — none of these belong on the
    // motor_vfd_simple DUT/UDT until a higher-fidelity equipment
    // kind ships them deliberately.
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
    ]) {
      expect(udt!.content).not.toContain(forbidden);
    }
  });

  it('3. station FB body wires the run command into the run_out IO with a deterministic breadcrumb', () => {
    const fb = artifacts.find((a) => a.path === 'siemens/FB_StRun.scl');
    expect(fb).toBeDefined();
    // Lowering breadcrumb is part of the IR (emitted by
    // wireMotorVfdSimple) and survives Siemens rendering verbatim.
    expect(fb!.content).toContain(
      'mot01 (motor_vfd_simple): run_cmd -> run_out',
    );
    // Local command var rendered with `#` prefix (Siemens convention).
    expect(fb!.content).toContain('#mot01_run_cmd');
    // Bool output IO rendered as double-quoted global (Siemens convention).
    expect(fb!.content).toMatch(
      /"io_m01_run"\s*:=\s*#mot01_run_cmd/,
    );
  });

  it('4. station FB body wires the bound parameter symbol into speed_setpoint_out', () => {
    const fb = artifacts.find((a) => a.path === 'siemens/FB_StRun.scl');
    expect(fb).toBeDefined();
    expect(fb!.content).toContain(
      'mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out',
    );
    // Numeric output IO and parameter both render as double-quoted
    // globals (Siemens convention for `kind: 'global'` storage).
    // The key invariant: the source is the parameter, never a literal.
    expect(fb!.content).toMatch(
      /"io_m01_speed_aw"\s*:=\s*"p_m01_speed"/,
    );
  });

  it('5. lowering does NOT synthesise any numeric literal as the speed_setpoint source', () => {
    const fb = artifacts.find((a) => a.path === 'siemens/FB_StRun.scl');
    expect(fb).toBeDefined();
    // The Siemens station FB legitimately contains numeric literals
    // for sequence state machine dispatch (`#state := 0`, `:= 1`).
    // The contract pinned here is narrower: any assignment whose
    // target is `"io_m01_speed_aw"` must NOT be of the form
    // `"io_m01_speed_aw" := <number>;`. A literal RHS would mean
    // the lowering invented a value.
    expect(fb!.content).not.toMatch(
      /"io_m01_speed_aw"\s*:=\s*-?\d+(?:\.\d+)?\s*;/,
    );
  });

  it('6. lowering does NOT synthesise close/reset/reverse/ramp/permissive/fault-latch/busy/done/position signals', () => {
    const fb = artifacts.find((a) => a.path === 'siemens/FB_StRun.scl');
    expect(fb).toBeDefined();
    // Strip line comments before scanning so the lowering
    // breadcrumb (`// mot01 (motor_vfd_simple): ...`) does not
    // produce false positives.
    const stripped = fb!.content.replace(/\/\/[^\n]*/g, '');
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
    // the bit but lowering does not drive it; alarm/interlock layers
    // do).
    expect(stripped).not.toMatch(/mot01[._]fault\s*:=/);
  });

  it('7. udtName public helper returns the canonical name for motor_vfd_simple', () => {
    expect(udtName('motor_vfd_simple')).toBe('UDT_MotorVfdSimple');
  });

  it('8. manifest is clean of UNSUPPORTED_* / READINESS_FAILED / READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET', () => {
    const manifest = artifacts.find((a) => a.path === 'siemens/manifest.json');
    expect(manifest).toBeDefined();
    expect(manifest!.kind).toBe('json');
    const parsed = JSON.parse(manifest!.content);
    const diags: Array<{ code: string }> =
      parsed.compilerDiagnostics ?? parsed.compiler_diagnostics ?? [];
    expect(
      diags.every(
        (d) =>
          d.code !== 'UNSUPPORTED_EQUIPMENT' &&
          d.code !== 'UNSUPPORTED_ACTIVITY' &&
          d.code !== 'READINESS_FAILED' &&
          d.code !== 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(true);
  });

  it('9. missing speed_setpoint_out IO binding still surfaces UNBOUND_ROLE', () => {
    const p = vfdProject();
    delete (p.machines[0]!.stations[0]!.equipment[0]!.io_bindings as Record<
      string,
      string
    >).speed_setpoint_out;
    let caught: { code?: string; symbol?: string } | undefined;
    try {
      generateSiemensProject(p, CLOCK);
    } catch (e) {
      caught = e as { code: string; symbol: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('UNBOUND_ROLE');
    expect(caught?.symbol).toContain('speed_setpoint_out');
  });

  it('10. missing io_setpoint_bindings still surfaces UNBOUND_SETPOINT_SOURCE', () => {
    const p = vfdProject();
    delete p.machines[0]!.stations[0]!.equipment[0]!.io_setpoint_bindings;
    let caught: { code?: string; symbol?: string } | undefined;
    try {
      generateSiemensProject(p, CLOCK);
    } catch (e) {
      caught = e as { code: string; symbol: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('UNBOUND_SETPOINT_SOURCE');
    expect(caught?.symbol).toContain('speed_setpoint_out');
  });

  it('11. generation is deterministic across two runs of the same fixture', () => {
    const a = generateSiemensProject(vfdProject(), CLOCK);
    const b = generateSiemensProject(vfdProject(), CLOCK);
    expect(a.map((art) => art.path)).toEqual(b.map((art) => art.path));
    expect(a.map((art) => art.content)).toEqual(b.map((art) => art.content));
  });

  it('12. artifact list contains exactly one UDT_MotorVfdSimple, no duplicates', () => {
    const udtPaths = artifacts
      .filter((a) => a.path.includes('UDT_MotorVfdSimple'))
      .map((a) => a.path);
    expect(udtPaths).toEqual(['siemens/UDT_MotorVfdSimple.scl']);
    const allPaths = artifacts.map((a) => a.path);
    const uniquePaths = Array.from(new Set(allPaths));
    expect(allPaths.length).toBe(uniquePaths.length);
  });
});
