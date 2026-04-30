// Sprint 88H — CODESYS supports `motor_vfd_simple` after the
// Logix/SCL-style audit confirmed structural agnosticism: no
// per-equipment switch in the CODESYS renderer, the DUT renderer
// iterates `TypeArtifactIR.fields` blindly, the Assign / SymbolRef
// IR nodes render generically, and `codesysTypeName` lexically
// rewrites `UDT_*` → `DUT_*` for any canonical name (including
// `UDT_MotorVfdSimple` from Sprint 88G's core widening). The
// CODESYS façade now joins `core` on the wider capability set;
// Siemens and Rockwell still reject the kind via
// `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` until their own
// audits in Sprint 88I and 88J.
//
// This spec mirrors `valve-onoff.spec.ts` for shape: synthetic
// project, end-to-end through `generateCodesysProject`, deterministic
// shape pinned by string assertions on the DUT + station FB.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { generateCodesysProject } from '../src/index.js';

const CLOCK = { manifest: { generatedAt: '2026-04-30T00:00:00Z' } };

function vfdProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_vfd88h',
    name: 'Sprint 88H motor_vfd_simple smoke (CODESYS)',
    description:
      'Single-station VFD-driven motor with parameter-sourced speed setpoint, CODESYS target.',
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

describe('generateCodesysProject — Sprint 88H motor_vfd_simple', () => {
  const artifacts = generateCodesysProject(vfdProject(), CLOCK);

  it('1. preflight passes — no READINESS_FAILED throw on a motor_vfd_simple project', () => {
    expect(artifacts.length).toBeGreaterThan(0);
  });

  it('2. emits DUT_MotorVfdSimple with the documented field set and nothing else', () => {
    const dut = artifacts.find(
      (a) => a.path === 'codesys/DUT_MotorVfdSimple.st',
    );
    expect(dut).toBeDefined();
    expect(dut!.kind).toBe('st');
    expect(dut!.content).toContain('TYPE DUT_MotorVfdSimple :');
    expect(dut!.content).toContain('cmd_run : BOOL;');
    expect(dut!.content).toContain('speed_setpoint : REAL;');
    expect(dut!.content).toContain('fault : BOOL;');
    expect(dut!.content).toContain('END_STRUCT');
    expect(dut!.content).toContain('END_TYPE');
    // Pin the minimal v0 surface — none of these belong on the
    // motor_vfd_simple DUT until a higher-fidelity equipment kind
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
    ]) {
      expect(dut!.content).not.toContain(forbidden);
    }
  });

  it('3. station FB body wires the run command into the run_out IO with a deterministic breadcrumb', () => {
    const fb = artifacts.find((a) => a.path === 'codesys/FB_StRun.st');
    expect(fb).toBeDefined();
    // Lowering breadcrumb is part of the IR (emitted by
    // wireMotorVfdSimple) and survives CODESYS rendering verbatim.
    expect(fb!.content).toContain(
      'mot01 (motor_vfd_simple): run_cmd -> run_out',
    );
    // The local command var produced by the sequence layer.
    expect(fb!.content).toContain('mot01_run_cmd');
    // The bound bool output IO; CODESYS uses bare global names
    // (no `#` prefix, no quotes).
    expect(fb!.content).toMatch(/io_m01_run\s*:=\s*mot01_run_cmd/);
  });

  it('4. station FB body wires the bound parameter symbol into speed_setpoint_out', () => {
    const fb = artifacts.find((a) => a.path === 'codesys/FB_StRun.st');
    expect(fb).toBeDefined();
    expect(fb!.content).toContain(
      'mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out',
    );
    // The assignment writes the bound parameter (rendered as a
    // bare global identifier in CODESYS ST) into the bound numeric
    // output IO. The key invariant: the source is the parameter,
    // never a numeric literal.
    expect(fb!.content).toMatch(
      /io_m01_speed_aw\s*:=\s*p_m01_speed\s*;/,
    );
  });

  it('5. lowering does NOT synthesise any numeric literal as the speed_setpoint source', () => {
    const fb = artifacts.find((a) => a.path === 'codesys/FB_StRun.st');
    expect(fb).toBeDefined();
    // The CODESYS station FB legitimately contains numeric literals
    // for the sequence state machine (e.g. `state := 0`, `state := 1`).
    // The contract we pin here is narrower: the assignment whose
    // target is `io_m01_speed_aw` must NOT be of the form
    // `io_m01_speed_aw := <number>;`. Any literal as the right-hand
    // side of the speed-setpoint assignment would mean the lowering
    // invented a value.
    expect(fb!.content).not.toMatch(
      /io_m01_speed_aw\s*:=\s*-?\d+(?:\.\d+)?\s*;/,
    );
  });

  it('6. lowering does NOT synthesise close/reset/reverse/ramp/permissive/fault-latch/busy/done/position signals', () => {
    const fb = artifacts.find((a) => a.path === 'codesys/FB_StRun.st');
    expect(fb).toBeDefined();
    // Strip block comments before scanning so the lowering
    // breadcrumb (`(* mot01 (motor_vfd_simple): ... *)`) does not
    // produce false positives.
    const stripped = fb!.content.replace(/\(\*[\s\S]*?\*\)/g, '');
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
    // Defensive: nothing assigns into mot01.fault (DUT exposes the
    // bit but lowering does not drive it; alarm/interlock layers do).
    expect(stripped).not.toMatch(/mot01[._]fault\s*:=/);
  });

  it('7. manifest is clean of UNSUPPORTED_* / READINESS_FAILED / READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET', () => {
    const manifest = artifacts.find(
      (a) => a.path === 'codesys/manifest.json',
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
  });

  it('8. missing speed_setpoint_out IO binding still surfaces UNBOUND_ROLE', () => {
    const p = vfdProject();
    delete (p.machines[0]!.stations[0]!.equipment[0]!.io_bindings as Record<
      string,
      string
    >).speed_setpoint_out;
    let caught: { code?: string; symbol?: string } | undefined;
    try {
      generateCodesysProject(p, CLOCK);
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
      generateCodesysProject(p, CLOCK);
    } catch (e) {
      caught = e as { code: string; symbol: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('UNBOUND_SETPOINT_SOURCE');
    expect(caught?.symbol).toContain('speed_setpoint_out');
  });

  it('10. generation is deterministic across two runs of the same fixture', () => {
    const a = generateCodesysProject(vfdProject(), CLOCK);
    const b = generateCodesysProject(vfdProject(), CLOCK);
    expect(a.map((art) => art.path)).toEqual(b.map((art) => art.path));
    expect(a.map((art) => art.content)).toEqual(b.map((art) => art.content));
  });

  it('11. artifact list contains exactly one DUT_MotorVfdSimple, no duplicates', () => {
    const dutPaths = artifacts
      .filter((a) => a.path.includes('DUT_MotorVfdSimple'))
      .map((a) => a.path);
    expect(dutPaths).toEqual(['codesys/DUT_MotorVfdSimple.st']);
    const allPaths = artifacts.map((a) => a.path);
    const uniquePaths = Array.from(new Set(allPaths));
    expect(allPaths.length).toBe(uniquePaths.length);
  });
});
