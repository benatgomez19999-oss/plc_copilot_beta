import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/weldline.json';
import { validate } from '../../src/validators/index.js';
import type { Project } from '../../src/domain/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('equipment rules', () => {
  it('weldline fixture validates clean of R-EQ-* / R-AV-*', () => {
    const report = validate(fixture as unknown as Project);
    const hits = report.issues.filter(
      (i) => i.rule.startsWith('R-EQ-') || i.rule === 'R-AV-01',
    );
    expect(hits, JSON.stringify(hits, null, 2)).toHaveLength(0);
  });

  it('R-EQ-01 triggers when a required role is missing on a cylinder', () => {
    const p = clone();
    const cyl = p.machines[0]!.stations[0]!.equipment[0]!;
    delete (cyl.io_bindings as Record<string, string>)['sensor_extended'];
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-EQ-01')).toBe(true);
  });

  it('R-EQ-02 triggers when a role points to an unknown io', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.equipment[0]!.io_bindings['solenoid_out'] =
      'io_ghost';
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-EQ-02')).toBe(true);
  });

  it('R-EQ-02 triggers when a role points to an io with the wrong direction', () => {
    const p = clone();
    // sensor_extended expects direction "in"; point it at an "out" signal.
    p.machines[0]!.stations[0]!.equipment[0]!.io_bindings['sensor_extended'] =
      'io_cyl01_sol';
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EQ-02' &&
          /direction/.test(i.message),
      ),
    ).toBe(true);
  });

  it('R-EQ-04 triggers when a required timing key is missing', () => {
    const p = clone();
    const cyl = p.machines[0]!.stations[0]!.equipment[0]!;
    delete (cyl.timing as Record<string, number>)['extend_timeout_ms'];
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-EQ-04')).toBe(true);
  });

  it('R-AV-01 triggers when an activity name is not allowed for the equipment type', () => {
    const p = clone();
    const state = p.machines[0]!.stations[0]!.sequence.states[1]!; // st_extending
    state.activity = { activate: ['cyl01.fly'] };
    const report = validate(p);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-AV-01' && i.message.includes('fly'),
      ),
    ).toBe(true);
  });

  it('R-AV-01 triggers when activating an equipment with no allowed activities', () => {
    const p = clone();
    const state = p.machines[0]!.stations[0]!.sequence.states[1]!;
    state.activity = { activate: ['sen_part'] };
    const report = validate(p);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-AV-01' && i.message.includes('sen_part'),
      ),
    ).toBe(true);
  });
});
