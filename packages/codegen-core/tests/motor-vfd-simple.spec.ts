// Sprint 88G — codegen-core lowering for motor_vfd_simple.
//
// Sprint 88E audited the kind and deferred support pending a PIR-side
// numeric-setpoint source (Sprint 88F decided Option A: parameter →
// role binding). Sprint 88G ships the PIR shape (`io_setpoint_bindings`
// + R-EQ-05) and the codegen-core lowering (`wireMotorVfdSimple`,
// `UDT_MotorVfdSimple`). Vendor capability tables stay closed; this
// spec exercises `compileProject` directly so the new lowering path
// has coverage before the per-target audits in Sprint 88H/88I/88J.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { compileProject } from '../src/index.js';
import { CodegenError, runTargetPreflight } from '../src/index.js';

function vfdProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_vfd88g',
    name: 'Sprint 88G motor_vfd_simple smoke',
    description:
      'Single-station VFD-driven motor with parameter-sourced speed setpoint.',
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

const CLOCK = { generatedAt: '2026-04-30T00:00:00Z' };

describe('compileProject — Sprint 88G motor_vfd_simple lowering', () => {
  it('1. happy fixture compiles without throwing', () => {
    expect(() => compileProject(vfdProject(), CLOCK)).not.toThrow();
  });

  it('2. produces UDT_MotorVfdSimple with cmd_run + speed_setpoint + fault and nothing else', () => {
    const program = compileProject(vfdProject(), CLOCK);
    const udt = program.typeArtifacts.find(
      (t) => t.name === 'UDT_MotorVfdSimple',
    );
    expect(udt).toBeDefined();
    const fieldNames = udt!.fields.map((f) => f.name);
    expect(fieldNames).toEqual(['cmd_run', 'speed_setpoint', 'fault']);
    const fieldTypes = udt!.fields.map((f) => `${f.name}:${f.dataType}`);
    expect(fieldTypes).toEqual([
      'cmd_run:Bool',
      'speed_setpoint:Real',
      'fault:Bool',
    ]);
  });

  it('3. station FB body assigns run_cmd to run_out', () => {
    const program = compileProject(vfdProject(), CLOCK);
    const fb = program.blocks.find((b) => b.name === 'FB_StRun');
    expect(fb).toBeDefined();
    // Walk the body looking for an Assign whose comment carries the
    // canonical run-wiring breadcrumb.
    const dump = JSON.stringify(fb!.body);
    expect(dump).toContain('mot01 (motor_vfd_simple): run_cmd -> run_out');
    // The assignment target is the io storage `io_m01_run` (global).
    expect(dump).toContain('"name":"io_m01_run"');
    // The expression refers to the local command var produced by the
    // sequence layer (`mot01_run_cmd`).
    expect(dump).toContain('mot01_run_cmd');
  });

  it('4. station FB body assigns the bound parameter symbol to speed_setpoint_out', () => {
    const program = compileProject(vfdProject(), CLOCK);
    const fb = program.blocks.find((b) => b.name === 'FB_StRun');
    expect(fb).toBeDefined();
    const dump = JSON.stringify(fb!.body);
    expect(dump).toContain(
      'mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out',
    );
    // Target is the analog Q-word IO storage.
    expect(dump).toContain('"name":"io_m01_speed_aw"');
    // Expression is a SymbolRef to the parameter (kind: 'parameter').
    expect(dump).toContain('"kind":"parameter"');
    expect(dump).toContain('"pirName":"p_m01_speed"');
  });

  it('5. the speed_setpoint_out assignment expression is a SymbolRef to a parameter, never a NumLit', () => {
    const program = compileProject(vfdProject(), CLOCK);
    const fb = program.blocks.find((b) => b.name === 'FB_StRun');
    expect(fb).toBeDefined();
    const dump = JSON.stringify(fb!.body);
    // Locate the speed-setpoint Assign IR by its unique target name and
    // assert its `expr` is a SymbolRef (the bound parameter), never a
    // NumLit. NumLits legitimately appear elsewhere (sequence state
    // machine `state := <int>` dispatch); we narrow the scope to the
    // setpoint assignment alone.
    const re = new RegExp(
      String.raw`"target":\{"kind":"global","name":"io_m01_speed_aw"\},"expr":\{"kind":"([A-Za-z]+)"`,
    );
    const m = dump.match(re);
    expect(m, 'speed_setpoint_out Assign IR not found').not.toBeNull();
    expect(m![1]).toBe('SymbolRef');
    expect(m![1]).not.toBe('NumLit');
  });

  it('6. lowering does NOT emit any close output / busy / done / position / fault latch / second coil for the VFD', () => {
    const program = compileProject(vfdProject(), CLOCK);
    const fb = program.blocks.find((b) => b.name === 'FB_StRun');
    const dump = JSON.stringify(fb!.body);
    // None of these should appear because none are part of the v0
    // motor_vfd_simple contract.
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
      expect(dump).not.toContain(forbidden);
    }
    // Defensive: nothing assigns into mot01.fault from the lowering
    // (it lives on the DUT but is driven by alarm/interlock layers).
    expect(dump).not.toMatch(/mot01[._]fault/);
  });

  it('7. compileProject is deterministic across two runs of the VFD fixture', () => {
    const a = compileProject(vfdProject(), CLOCK);
    const b = compileProject(vfdProject(), CLOCK);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('8. runTargetPreflight does NOT throw for codesys (Sprint 88H — post-audit widening)', () => {
    expect(() => runTargetPreflight(vfdProject(), 'codesys')).not.toThrow();
  });

  it('9. runTargetPreflight does NOT throw for siemens (Sprint 88I — post-audit widening)', () => {
    expect(() => runTargetPreflight(vfdProject(), 'siemens')).not.toThrow();
  });

  it('10. runTargetPreflight throws READINESS_FAILED for rockwell (vendor stays closed; audit lands in 88J)', () => {
    let caught: CodegenError | undefined;
    try {
      runTargetPreflight(vfdProject(), 'rockwell');
    } catch (e) {
      caught = e as CodegenError;
    }
    expect(caught?.code).toBe('READINESS_FAILED');
    const cause = caught?.cause as
      | { diagnostics: Array<{ code: string }> }
      | undefined;
    expect(
      cause?.diagnostics?.some(
        (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(true);
  });

  it('11. runTargetPreflight does NOT throw for the core target (mirrors compileProject scope)', () => {
    expect(() => runTargetPreflight(vfdProject(), 'core')).not.toThrow();
  });
});
