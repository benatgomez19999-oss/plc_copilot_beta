import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/weldline.json';
import { validate } from '../../src/validators/index.js';
import type { Project } from '../../src/domain/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('id rules', () => {
  it('weldline fixture validates clean (no errors)', () => {
    const report = validate(fixture as unknown as Project);
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  it('R-ID-02 detects duplicate IO ids', () => {
    const p = clone();
    const io = p.machines[0]!.io;
    const first = io[0]!;
    io.push({
      ...first,
      address: { ...first.address, byte: 99, bit: 7 },
    });
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-ID-02')).toBe(true);
  });

  it('R-ID-03 detects duplicate equipment ids across stations', () => {
    const p = clone();
    const stations = p.machines[0]!.stations;
    const loadEq = stations[0]!.equipment[0]!;
    stations[1]!.equipment.push({ ...loadEq });
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-ID-03')).toBe(true);
  });

  it('R-SM-09 detects duplicate transition ids in a sequence', () => {
    const p = clone();
    const seq = p.machines[0]!.stations[0]!.sequence;
    const first = seq.transitions[0]!;
    seq.transitions.push({ ...first, priority: 99 });
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-SM-09')).toBe(true);
  });
});
