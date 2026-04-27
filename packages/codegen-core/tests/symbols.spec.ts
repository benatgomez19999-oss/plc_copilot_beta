import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { buildSymbolTable } from '@plccopilot/codegen-core';
import { renderSymbol } from '@plccopilot/codegen-core';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('buildSymbolTable — vendor-neutral storage', () => {
  const project = clone();
  const machine = project.machines[0]!;
  const station = machine.stations[0]!; // st_load
  const { table, diagnostics } = buildSymbolTable(machine, station);

  it('produces no diagnostics for a well-formed PIR', () => {
    expect(diagnostics).toHaveLength(0);
  });

  it('resolves an io bare ref to global storage (no Siemens markers)', () => {
    const sym = table.resolve('io_part_sensor');
    expect(sym).not.toBeNull();
    expect(sym!.kind).toBe('io');
    expect(sym!.valueType).toBe('bool');
    expect(sym!.storage).toEqual({ kind: 'global', name: 'io_part_sensor' });
  });

  it('resolves a parameter (dint → int) to global storage', () => {
    const sym = table.resolve('p_weld_time');
    expect(sym!.kind).toBe('parameter');
    expect(sym!.valueType).toBe('int');
    expect(sym!.storage).toEqual({ kind: 'global', name: 'p_weld_time' });
  });

  it('resolves an alarm to dbField storage targeting set_<id>', () => {
    const sym = table.resolve('al_cyl_ext_timeout');
    expect(sym!.kind).toBe('alarm');
    expect(sym!.storage).toEqual({
      kind: 'dbField',
      dbName: 'DB_Alarms',
      fieldName: 'set_al_cyl_ext_timeout',
    });
  });

  it('resolves equipment.role to global storage of the bound IO', () => {
    const sym = table.resolve('cyl01.sensor_extended');
    expect(sym!.kind).toBe('equipment_role');
    expect(sym!.storage).toEqual({ kind: 'global', name: 'io_cyl01_ext' });
    expect(sym!.stationId).toBe('st_load');
  });

  it('resolves keywords with the right storage shape', () => {
    expect(table.resolve('estop_active')!.storage).toEqual({
      kind: 'local',
      name: 'i_estop_active',
    });
    expect(table.resolve('mode')!.storage).toEqual({
      kind: 'local',
      name: 'i_mode',
    });
    expect(table.resolve('auto')!.storage).toEqual({
      kind: 'literal',
      text: '1',
    });
    expect(table.resolve('maintenance')!.storage).toEqual({
      kind: 'literal',
      text: '4',
    });
  });

  it('returns null for unknown symbols', () => {
    expect(table.resolve('nothing_here')).toBeNull();
    expect(table.resolve('cyl01.ghost_role')).toBeNull();
  });

  it('does NOT carry pre-rendered Siemens text in the symbol layer', () => {
    for (const sym of table.all()) {
      // No `sclName` field, no `#`, no `"..."` decoration on any
      // storage value. Cast through `unknown` — `ResolvedSymbol` has
      // no index signature and we are intentionally probing for the
      // absence of a non-typed key.
      expect(
        (sym as unknown as Record<string, unknown>).sclName,
      ).toBeUndefined();
      // Sprint 38 — the previous version stringified `sym.storage`
      // and asserted against `/"/.../`, which always matched because
      // `JSON.stringify` itself emits double quotes around every
      // key + string value. The real intent is "no Siemens-rendered
      // fragment is baked into a storage VALUE", so collect the
      // string values out of the tagged union and inspect those.
      const values: string[] = [];
      const s = sym.storage;
      switch (s.kind) {
        case 'local':
        case 'global':
          values.push(s.name);
          break;
        case 'dbField':
          values.push(s.dbName, s.fieldName);
          break;
        case 'literal':
          values.push(s.text);
          break;
      }
      for (const v of values) {
        // No Siemens local-instance prefix `#name`.
        expect(v).not.toMatch(/^#/);
        // No Siemens DB-name decoration `"DB"`.
        expect(v).not.toMatch(/"/);
      }
    }
  });

  it('emits UNKNOWN_IO when a role points to a missing io', () => {
    const p = clone();
    const s = p.machines[0]!.stations[0]!;
    s.equipment[0]!.io_bindings['solenoid_out'] = 'io_does_not_exist';
    const { diagnostics } = buildSymbolTable(p.machines[0]!, s);
    expect(diagnostics.some((d) => d.code === 'UNKNOWN_IO')).toBe(true);
  });
});

describe('renderSymbol — backend-aware lexical convention', () => {
  const project = clone();
  const machine = project.machines[0]!;
  const station = machine.stations[0]!;
  const { table } = buildSymbolTable(machine, station);

  it('renders a global IO different per backend', () => {
    const sym = table.resolve('io_part_sensor')!;
    expect(renderSymbol(sym, 'siemens')).toBe('"io_part_sensor"');
    expect(renderSymbol(sym, 'codesys')).toBe('io_part_sensor');
  });

  it('renders a local keyword (mode) different per backend', () => {
    const sym = table.resolve('mode')!;
    expect(renderSymbol(sym, 'siemens')).toBe('#i_mode');
    expect(renderSymbol(sym, 'codesys')).toBe('i_mode');
  });

  it('renders dbField alarms as DB / GVL per backend', () => {
    const sym = table.resolve('al_cyl_ext_timeout')!;
    expect(renderSymbol(sym, 'siemens')).toBe(
      '"DB_Alarms".set_al_cyl_ext_timeout',
    );
    // After core-extraction the GVL namespace map lives in
    // `@plccopilot/codegen-codesys`. Without a map, core renders identity.
    expect(renderSymbol(sym, 'codesys')).toBe(
      'DB_Alarms.set_al_cyl_ext_timeout',
    );
    expect(
      renderSymbol(sym, 'codesys', { DB_Alarms: 'GVL_Alarms' }),
    ).toBe('GVL_Alarms.set_al_cyl_ext_timeout');
  });

  it('renders literal storage identically across backends', () => {
    const sym = table.resolve('auto')!;
    expect(renderSymbol(sym, 'siemens')).toBe('1');
    expect(renderSymbol(sym, 'codesys')).toBe('1');
  });
});
