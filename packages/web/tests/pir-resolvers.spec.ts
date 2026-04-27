import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  formatIoAddress,
  getEquipmentByPath,
  getMachineByIndex,
  getStationByPath,
  resolveEquipmentRelations,
  resolveIoBinding,
  resolveMachineSummary,
  resolveStationRelations,
} from '../src/utils/pir-resolvers.js';

function fixtureProject(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// =============================================================================
// Index lookups
// =============================================================================

describe('getMachineByIndex / getStationByPath / getEquipmentByPath', () => {
  it('resolves valid indices to the underlying record', () => {
    const p = fixtureProject();
    const m = getMachineByIndex(p, 0);
    expect(m).not.toBeNull();
    expect(m!.id).toBe('mch_weldline');

    const s = getStationByPath(p, 0, 1);
    expect(s).not.toBeNull();
    expect(s!.id).toBe('st_weld');

    const eq = getEquipmentByPath(p, 0, 0, 1);
    expect(eq).not.toBeNull();
    expect(eq!.id).toBe('sen_part');
  });

  it('returns null for out-of-range or non-integer indices', () => {
    const p = fixtureProject();
    expect(getMachineByIndex(p, 5)).toBeNull();
    expect(getMachineByIndex(p, -1)).toBeNull();
    expect(getMachineByIndex(p, 1.5)).toBeNull();
    expect(getStationByPath(p, 0, 99)).toBeNull();
    expect(getEquipmentByPath(p, 0, 0, 99)).toBeNull();
    // Cascading: a bad parent index short-circuits the lookup.
    expect(getStationByPath(p, 99, 0)).toBeNull();
    expect(getEquipmentByPath(p, 99, 0, 0)).toBeNull();
    expect(getEquipmentByPath(p, 0, 99, 0)).toBeNull();
  });
});

// =============================================================================
// Address formatting
// =============================================================================

describe('formatIoAddress', () => {
  it('formats I/Q/M with bit', () => {
    expect(formatIoAddress({ memory_area: 'I', byte: 0, bit: 0 })).toBe('I0.0');
    expect(formatIoAddress({ memory_area: 'Q', byte: 3, bit: 7 })).toBe('Q3.7');
    expect(formatIoAddress({ memory_area: 'M', byte: 12, bit: 4 })).toBe(
      'M12.4',
    );
  });

  it('formats I/Q/M without bit', () => {
    expect(formatIoAddress({ memory_area: 'M', byte: 5 })).toBe('M5');
  });

  it('formats DB with db_number, with and without bit', () => {
    expect(
      formatIoAddress({ memory_area: 'DB', byte: 0, db_number: 100 }),
    ).toBe('DB100.0');
    expect(
      formatIoAddress({
        memory_area: 'DB',
        byte: 4,
        bit: 1,
        db_number: 100,
      }),
    ).toBe('DB100.4.1');
  });
});

// =============================================================================
// IO bindings
// =============================================================================

describe('resolveIoBinding', () => {
  it('resolves all bindings on a fully-wired equipment', () => {
    const p = fixtureProject();
    const machine = p.machines[0]!;
    const cyl = machine.stations[0]!.equipment[0]!;
    const out = resolveIoBinding(machine, cyl);

    // 3 roles on cyl01: solenoid_out, sensor_extended, sensor_retracted.
    expect(out).toHaveLength(3);
    expect(out.every((b) => b.found)).toBe(true);

    // Sorted alphabetically by role for deterministic display.
    expect(out.map((b) => b.role)).toEqual([
      'sensor_extended',
      'sensor_retracted',
      'solenoid_out',
    ]);

    const sol = out.find((b) => b.role === 'solenoid_out')!;
    expect(sol.signal).toEqual({
      id: 'io_cyl01_sol',
      displayName: 'Cyl01 solenoid',
      addressRaw: 'Q0.0',
      dtype: 'bool',
      direction: 'out',
    });
  });

  it('flags missing IO targets with found=false and no signal', () => {
    const p = fixtureProject();
    const machine = p.machines[0]!;
    const cyl = machine.stations[0]!.equipment[0]!;
    // Re-target one role at a non-existent IO id.
    cyl.io_bindings = {
      solenoid_out: 'io_does_not_exist',
      sensor_extended: 'io_cyl01_ext',
      sensor_retracted: 'io_cyl01_ret',
    };
    const out = resolveIoBinding(machine, cyl);
    const sol = out.find((b) => b.role === 'solenoid_out')!;
    expect(sol.found).toBe(false);
    expect(sol.signal).toBeUndefined();
    expect(sol.ioId).toBe('io_does_not_exist');
    // Other roles unaffected.
    expect(out.find((b) => b.role === 'sensor_extended')!.found).toBe(true);
  });

  it('returns an empty array when io_bindings is missing entirely', () => {
    const p = fixtureProject();
    const machine = p.machines[0]!;
    const cyl = machine.stations[0]!.equipment[0]!;
    delete (cyl as unknown as Record<string, unknown>).io_bindings;
    expect(resolveIoBinding(machine, cyl)).toEqual([]);
  });
});

// =============================================================================
// Equipment relations
// =============================================================================

describe('resolveEquipmentRelations', () => {
  it('returns null when any index is out of range', () => {
    const p = fixtureProject();
    expect(resolveEquipmentRelations(p, 99, 0, 0)).toBeNull();
    expect(resolveEquipmentRelations(p, 0, 99, 0)).toBeNull();
    expect(resolveEquipmentRelations(p, 0, 0, 99)).toBeNull();
  });

  it('matches alarms via the vendor extension `alarm.equipment_id`', () => {
    const p = fixtureProject();
    // Stamp the extension field on one alarm and another off-target one.
    (p.machines[0]!.alarms[0]! as unknown as Record<string, unknown>).equipment_id =
      'cyl01';
    (p.machines[0]!.alarms[1]! as unknown as Record<string, unknown>).equipment_id =
      'mot01';
    const rel = resolveEquipmentRelations(p, 0, 0, 0)!;
    expect(rel.alarms.map((a) => a.id)).toEqual(['al_cyl_ext_timeout']);
  });

  it('matches interlocks whose `inhibits` is prefixed by `<eqId>.`', () => {
    const p = fixtureProject();
    const rel = resolveEquipmentRelations(p, 0, 0, 0)!; // cyl01
    expect(rel.interlocks.map((il) => il.id)).toEqual([
      'il_cyl01_no_extend_on_fault',
    ]);
  });

  it('does not cross-match equipment ids that share a substring prefix', () => {
    const p = fixtureProject();
    // Add an interlock against `cyl01a.extend` and a fake equipment cyl01a.
    p.machines[0]!.interlocks.push({
      id: 'il_cyl01a',
      inhibits: 'cyl01a.extend',
      when: 'estop_active',
    });
    const rel = resolveEquipmentRelations(p, 0, 0, 0)!; // cyl01, NOT cyl01a
    expect(rel.interlocks.map((il) => il.id)).toEqual([
      'il_cyl01_no_extend_on_fault',
    ]);
  });

  it('matches safety groups via affects { kind:"equipment", equipment_id }', () => {
    const p = fixtureProject();
    p.machines[0]!.safety_groups.push({
      id: 'sg_cyl01_only',
      name: 'Cyl01 isolated',
      trigger: 'estop_active',
      affects: [{ kind: 'equipment', equipment_id: 'cyl01' }],
      category: 'other',
    });
    const rel = resolveEquipmentRelations(p, 0, 0, 0)!;
    expect(rel.safetyGroups.map((sg) => sg.id)).toEqual(['sg_cyl01_only']);
  });

  it('matches safety groups via vendor extension `equipment.safety_group_ids`', () => {
    const p = fixtureProject();
    (p.machines[0]!.stations[0]!.equipment[0]! as unknown as Record<
      string,
      unknown
    >).safety_group_ids = ['sg_estop'];
    const rel = resolveEquipmentRelations(p, 0, 0, 0)!;
    expect(rel.safetyGroups.map((sg) => sg.id)).toEqual(['sg_estop']);
  });
});

// =============================================================================
// Station relations
// =============================================================================

describe('resolveStationRelations', () => {
  it('returns null for out-of-range indices', () => {
    const p = fixtureProject();
    expect(resolveStationRelations(p, 0, 99)).toBeNull();
    expect(resolveStationRelations(p, 99, 0)).toBeNull();
  });

  it('returns the station equipment slice + sequence summary', () => {
    const p = fixtureProject();
    const rel = resolveStationRelations(p, 0, 0)!; // st_load
    expect(rel.equipment.map((e) => e.id)).toEqual(['cyl01', 'sen_part']);

    expect(rel.sequence).toBeDefined();
    expect(rel.sequence!.states).toBe(5);
    expect(rel.sequence!.transitions).toBe(5);
    expect(rel.sequence!.initialState).toBe('st_idle');
    expect(rel.sequence!.terminalStates).toEqual(['st_fault']);
  });

  it('returns no terminal states when sequence has none', () => {
    const p = fixtureProject();
    // st_weld has 2 normal states only.
    const rel = resolveStationRelations(p, 0, 1)!;
    expect(rel.sequence!.states).toBe(2);
    expect(rel.sequence!.terminalStates).toEqual([]);
    expect(rel.sequence!.initialState).toBe('st_idle');
  });

  it('matches interlocks via any equipment that lives in the station', () => {
    const p = fixtureProject();
    // st_load has cyl01 → il_cyl01_no_extend_on_fault matches.
    const rel = resolveStationRelations(p, 0, 0)!;
    expect(rel.interlocks.map((il) => il.id)).toEqual([
      'il_cyl01_no_extend_on_fault',
    ]);
    // st_weld has mot01 only, no interlocks against it.
    const rel2 = resolveStationRelations(p, 0, 1)!;
    expect(rel2.interlocks).toHaveLength(0);
  });

  it('matches safety groups by station target and by station-equipment target', () => {
    const p = fixtureProject();
    // sg_estop already affects st_load + st_weld via `kind:"station"`.
    const rel = resolveStationRelations(p, 0, 0)!;
    expect(rel.safetyGroups.map((sg) => sg.id)).toEqual(['sg_estop']);

    // Also matches when the affect targets equipment that lives inside.
    p.machines[0]!.safety_groups.push({
      id: 'sg_cyl01',
      name: 'cyl only',
      trigger: 'estop_active',
      affects: [{ kind: 'equipment', equipment_id: 'cyl01' }],
      category: 'other',
    });
    const rel2 = resolveStationRelations(p, 0, 0)!;
    expect(rel2.safetyGroups.map((sg) => sg.id)).toEqual([
      'sg_estop',
      'sg_cyl01',
    ]);
  });

  it('matches alarms via the vendor extension `alarm.station_id`', () => {
    const p = fixtureProject();
    (p.machines[0]!.alarms[0]! as unknown as Record<string, unknown>).station_id =
      'st_load';
    const rel = resolveStationRelations(p, 0, 0)!;
    expect(rel.alarms.map((a) => a.id)).toEqual(['al_cyl_ext_timeout']);
  });

  it('tolerates a missing sequence (sequence=undefined)', () => {
    const p = fixtureProject();
    delete (p.machines[0]!.stations[1]! as unknown as Record<string, unknown>)
      .sequence;
    const rel = resolveStationRelations(p, 0, 1)!;
    expect(rel.sequence).toBeUndefined();
  });
});

// =============================================================================
// Machine summary
// =============================================================================

describe('resolveMachineSummary', () => {
  it('returns null for out-of-range', () => {
    const p = fixtureProject();
    expect(resolveMachineSummary(p, 99)).toBeNull();
  });

  it('counts stations / equipment / io / alarms / interlocks / parameters / recipes / safety_groups', () => {
    const p = fixtureProject();
    const s = resolveMachineSummary(p, 0)!;
    expect(s.stations).toBe(2);
    expect(s.equipment).toBe(3); // cyl01 + sen_part + mot01
    expect(s.io).toBe(9);
    expect(s.alarms).toBe(3);
    expect(s.interlocks).toBe(1);
    expect(s.parameters).toBe(2);
    expect(s.recipes).toBe(1);
    expect(s.safetyGroups).toBe(1);
  });

  it('counts IO directions by `direction`', () => {
    const p = fixtureProject();
    const s = resolveMachineSummary(p, 0)!;
    // Weldline IO: 2 outputs (io_cyl01_sol, io_mot01_run); 7 inputs.
    expect(s.outputs).toBe(2);
    expect(s.inputs).toBe(7);
  });

  it('builds an equipment-type histogram across all stations', () => {
    const p = fixtureProject();
    const s = resolveMachineSummary(p, 0)!;
    expect(s.equipmentTypeCount).toEqual({
      pneumatic_cylinder_2pos: 1,
      sensor_discrete: 1,
      motor_simple: 1,
    });
  });

  it('reports modes=0 when the vendor extension is absent, length when present', () => {
    const p = fixtureProject();
    expect(resolveMachineSummary(p, 0)!.modes).toBe(0);

    (p.machines[0]! as unknown as Record<string, unknown>).modes = [
      { id: 'auto' },
      { id: 'manual' },
    ];
    expect(resolveMachineSummary(p, 0)!.modes).toBe(2);
  });
});
