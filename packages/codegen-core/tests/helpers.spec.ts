import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project, Station } from '@plccopilot/pir';
import { scanStation } from '@plccopilot/codegen-core';
import { hasErrors } from '@plccopilot/codegen-core';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

function stationById(project: Project, id: string): Station {
  const s = project.machines[0]!.stations.find((x) => x.id === id);
  if (!s) throw new Error(`fixture missing station ${id}`);
  return s;
}

function indexStates(station: Station): Map<string, number> {
  const m = new Map<string, number>();
  station.sequence.states.forEach((s, i) => m.set(s.id, i));
  return m;
}

describe('scanStation — diagnostic-first contract', () => {
  it('returns a plan with no error diagnostics for a valid station', () => {
    const p = clone();
    const machine = p.machines[0]!;
    const station = stationById(p, 'st_load');
    const result = scanStation(machine, station, indexStates(station), 'x.scl');

    expect(result.plan).toBeDefined();
    expect(hasErrors(result.diagnostics)).toBe(false);
    expect(result.plan!.commands.length).toBeGreaterThanOrEqual(1);
    expect(result.plan!.timers.length).toBe(2); // t_extended + t_retracted
    expect(result.plan!.interlocks.length).toBe(1); // il_cyl01_no_extend_on_fault
  });

  it('does NOT throw on unsupported activity — emits diagnostic error instead', () => {
    const p = clone();
    const station = stationById(p, 'st_load');
    station.sequence.states[1]!.activity = { activate: ['cyl01.fly'] };

    // Must NOT throw
    let result: ReturnType<typeof scanStation> | undefined;
    expect(() => {
      result = scanStation(p.machines[0]!, station, indexStates(station), 'x.scl');
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(hasErrors(result!.diagnostics)).toBe(true);
    const errors = result!.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.some((d) => d.code === 'UNSUPPORTED_ACTIVITY')).toBe(true);
    expect(errors.some((d) => d.message.includes('fly'))).toBe(true);
  });

  it('emits diagnostic for activation on equipment not in station', () => {
    const p = clone();
    const station = stationById(p, 'st_load');
    station.sequence.states[1]!.activity = { activate: ['ghost_eq.extend'] };

    const result = scanStation(
      p.machines[0]!,
      station,
      indexStates(station),
      'x.scl',
    );
    expect(hasErrors(result.diagnostics)).toBe(true);
    expect(
      result.diagnostics.some((d) => d.code === 'UNKNOWN_EQUIPMENT'),
    ).toBe(true);
  });

  it('emits diagnostic for invalid interlock (unsupported inhibited role)', () => {
    const p = clone();
    p.machines[0]!.interlocks[0]!.inhibits = 'cyl01.fly';
    const station = stationById(p, 'st_load');

    const result = scanStation(
      p.machines[0]!,
      station,
      indexStates(station),
      'x.scl',
    );
    expect(hasErrors(result.diagnostics)).toBe(true);
    expect(
      result.diagnostics.some((d) => d.code === 'INTERLOCK_ROLE_UNRESOLVED'),
    ).toBe(true);
  });

  it('emits diagnostic for invalid (non-positive) timeout', () => {
    const p = clone();
    const station = stationById(p, 'st_load');
    station.sequence.transitions[1]!.timeout = {
      ms: 0,
      alarm_id: 'al_cyl_ext_timeout',
    };

    const result = scanStation(
      p.machines[0]!,
      station,
      indexStates(station),
      'x.scl',
    );
    expect(hasErrors(result.diagnostics)).toBe(true);
    expect(
      result.diagnostics.some((d) => d.code === 'TIMEOUT_RENDER_ERROR'),
    ).toBe(true);
  });

  it('continues scanning past one error (best-effort plan)', () => {
    const p = clone();
    const station = stationById(p, 'st_load');
    // Inject bad activity AND keep valid timeouts.
    station.sequence.states[1]!.activity = { activate: ['cyl01.fly'] };

    const result = scanStation(
      p.machines[0]!,
      station,
      indexStates(station),
      'x.scl',
    );
    expect(result.plan).toBeDefined();
    // Bad activity was skipped but timers still collected.
    expect(result.plan!.timers.length).toBe(2);
  });

  it('cross-station interlocks are silently skipped (not an error)', () => {
    const p = clone();
    p.machines[0]!.interlocks[0]!.inhibits = 'mot01.run'; // mot01 lives in st_weld
    const station = stationById(p, 'st_load');

    const result = scanStation(
      p.machines[0]!,
      station,
      indexStates(station),
      'x.scl',
    );
    expect(hasErrors(result.diagnostics)).toBe(false);
    expect(result.plan!.interlocks).toHaveLength(0);
  });
});
