import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/weldline.json';
import { validate } from '../../src/validators/index.js';
import type { Project } from '../../src/domain/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('parameter & recipe rules', () => {
  it('weldline fixture validates clean of R-PR-*', () => {
    const report = validate(fixture as unknown as Project);
    const hits = report.issues.filter((i) => i.rule.startsWith('R-PR-'));
    expect(hits, JSON.stringify(hits, null, 2)).toHaveLength(0);
  });

  it('R-PR-01 triggers when a recipe references a missing parameter', () => {
    const p = clone();
    (p.machines[0]!.recipes[0]!.values as Record<string, number | boolean>)[
      'p_ghost'
    ] = 5;
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-PR-01')).toBe(true);
  });

  it('R-PR-01 triggers when a recipe value is out of range', () => {
    const p = clone();
    (p.machines[0]!.recipes[0]!.values as Record<string, number | boolean>)[
      'p_weld_time'
    ] = 99999;
    const report = validate(p);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-PR-01' && i.message.includes('range'),
      ),
    ).toBe(true);
  });

  it('R-PR-02 triggers when a default does not match the declared dtype', () => {
    const p = clone();
    const param = p.machines[0]!.parameters[0]!; // p_weld_time (dint)
    param.default = 3.14;
    const report = validate(p);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-PR-02' && i.message.includes('dtype'),
      ),
    ).toBe(true);
  });

  it('R-PR-02 triggers when a default is out of range', () => {
    const p = clone();
    const param = p.machines[0]!.parameters[1]!; // p_weld_current (real, 50..300)
    param.default = 999.0;
    const report = validate(p);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-PR-02' && i.message.includes('range'),
      ),
    ).toBe(true);
  });
});
