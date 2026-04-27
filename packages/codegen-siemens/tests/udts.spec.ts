import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateUdts } from '../src/generators/udts.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('generateUdts', () => {
  it('emits UDT_Cylinder2Pos when a pneumatic_cylinder_2pos exists', () => {
    const udts = generateUdts(clone());
    const udt = udts.find((u) => u.path.endsWith('UDT_Cylinder2Pos.scl'));
    expect(udt).toBeDefined();
    expect(udt!.kind).toBe('scl');
    expect(udt!.content).toContain('TYPE "UDT_Cylinder2Pos"');
    expect(udt!.content).toContain('cmd_extend : Bool;');
    expect(udt!.content).toContain('fb_extended : Bool;');
    expect(udt!.content).toContain('fb_retracted : Bool;');
    expect(udt!.content).toContain('busy : Bool;');
    expect(udt!.content).toContain('fault : Bool;');
    expect(udt!.content).toContain('END_STRUCT;');
    expect(udt!.content).toContain('END_TYPE');
  });

  it('emits UDT_MotorSimple when a motor_simple exists', () => {
    const udts = generateUdts(clone());
    const udt = udts.find((u) => u.path.endsWith('UDT_MotorSimple.scl'));
    expect(udt).toBeDefined();
    expect(udt!.content).toContain('TYPE "UDT_MotorSimple"');
    expect(udt!.content).toContain('run_cmd : Bool;');
    expect(udt!.content).toContain('running_fb : Bool;');
    expect(udt!.content).toContain('fault : Bool;');
  });

  it('does not emit a UDT for sensor_discrete (no template registered)', () => {
    const udts = generateUdts(clone());
    expect(
      udts.some((u) => u.path.toLowerCase().includes('sensor')),
    ).toBe(false);
  });

  it('does not duplicate the UDT when the same type appears multiple times', () => {
    const p = clone();
    p.machines[0]!.stations[1]!.equipment.push({
      id: 'cyl02',
      name: 'Second cylinder',
      type: 'pneumatic_cylinder_2pos',
      code_symbol: 'Cyl02',
      io_bindings: {
        solenoid_out: 'io_cyl01_sol',
        sensor_extended: 'io_cyl01_ext',
        sensor_retracted: 'io_cyl01_ret',
      },
      timing: { extend_timeout_ms: 5000, retract_timeout_ms: 5000 },
    });
    const udts = generateUdts(p);
    const cyls = udts.filter((u) => u.path.endsWith('UDT_Cylinder2Pos.scl'));
    expect(cyls).toHaveLength(1);
  });

  it('emits UDTs in a stable alphabetical order by path', () => {
    const udts = generateUdts(clone()).map((u) => u.path);
    expect(udts).toEqual([
      'siemens/UDT_Cylinder2Pos.scl',
      'siemens/UDT_MotorSimple.scl',
    ]);
  });

  it('is deterministic across calls', () => {
    const a = generateUdts(clone()).map((u) => u.content);
    const b = generateUdts(clone()).map((u) => u.content);
    expect(a).toEqual(b);
  });
});

describe('TypeArtifactIR — single source of truth across backends', () => {
  it('Siemens UDT and Codesys DUT share identical field lists', async () => {
    const { buildEquipmentTypesIR } = await import(
      '../src/compiler/program/types.js'
    );
    const types = buildEquipmentTypesIR(clone());
    const cyl = types.find((t) => t.name === 'UDT_Cylinder2Pos')!;
    expect(cyl.fields.map((f) => f.name)).toEqual([
      'cmd_extend',
      'fb_extended',
      'fb_retracted',
      'busy',
      'fault',
    ]);
    const mot = types.find((t) => t.name === 'UDT_MotorSimple')!;
    expect(mot.fields.map((f) => f.name)).toEqual([
      'run_cmd',
      'running_fb',
      'fault',
    ]);
  });

  it('TypeArtifactIR exposes structured fields (no pre-rendered content)', async () => {
    const { buildEquipmentTypesIR } = await import(
      '../src/compiler/program/types.js'
    );
    const types = buildEquipmentTypesIR(clone());
    for (const t of types) {
      expect(t.fields).toBeDefined();
      expect(t.fields.length).toBeGreaterThan(0);
      // No pre-rendered SCL text on the IR. Cast goes through `unknown`
      // because `TypeArtifactIR` has no index signature — we want to
      // assert the absence of a property whose name isn't in the type.
      expect(
        (t as unknown as Record<string, unknown>).content,
      ).toBeUndefined();
      expect(t.typeKind).toBe('equipment');
    }
  });
});
