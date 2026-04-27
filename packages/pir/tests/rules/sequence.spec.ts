import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/weldline.json';
import { validate } from '../../src/validators/index.js';
import type { Project } from '../../src/domain/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('sequence rules', () => {
  it('fixture validates clean (no errors)', () => {
    const report = validate(fixture as unknown as Project);
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('R-SM-01 triggers when no initial state exists', () => {
    const p = clone();
    for (const s of p.machines[0]!.stations[0]!.sequence.states) {
      if (s.kind === 'initial') s.kind = 'normal';
    }
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-SM-01')).toBe(true);
  });

  it('R-SM-02 triggers on unknown state in transition', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.transitions[0]!.to = 'st_ghost';
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-SM-02')).toBe(true);
  });

  it('R-SM-05 triggers on unknown alarm in transition timeout', () => {
    const p = clone();
    const t = p.machines[0]!.stations[0]!.sequence.transitions.find(
      (x) => x.timeout !== undefined,
    );
    if (t && t.timeout) t.timeout.alarm_id = 'al_ghost';
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-SM-05')).toBe(true);
  });

  it('R-SM-08 triggers on priority collision from the same state', () => {
    const p = clone();
    const seq = p.machines[0]!.stations[0]!.sequence;
    const first = seq.transitions[0]!;
    seq.transitions.push({
      ...first,
      id: 't_twin',
    });
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-SM-08')).toBe(true);
  });
});
