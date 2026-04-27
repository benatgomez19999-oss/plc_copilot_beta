import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/weldline.json';
import { validate } from '../../src/validators/index.js';
import { analyzeExpression } from '../../src/domain/expressions/lexer.js';
import type { Project } from '../../src/domain/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('expression rules (R-EX-01)', () => {
  it('weldline fixture validates clean of R-EX-01', () => {
    const report = validate(fixture as unknown as Project);
    const hits = report.issues.filter((i) => i.rule === 'R-EX-01');
    expect(hits, JSON.stringify(hits, null, 2)).toHaveLength(0);
  });

  it('lexer rejects unbalanced parens', () => {
    const r = analyzeExpression('(mode == auto');
    expect(r.ok).toBe(false);
    expect(r.issues.some((m) => /unbalanced/.test(m))).toBe(true);
  });

  it('lexer rejects invalid characters', () => {
    const r = analyzeExpression('a @ b');
    expect(r.ok).toBe(false);
    expect(r.issues.some((m) => m.includes('invalid character'))).toBe(true);
  });

  it('R-EX-01 triggers on unbalanced parens in a transition guard', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.transitions[0]!.guard =
      '(mode == auto';
    const report = validate(p);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-EX-01' && /unbalanced/.test(i.message),
      ),
    ).toBe(true);
  });

  it('R-EX-01 triggers on functions outside the whitelist', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.transitions[0]!.trigger = 'foo(x)';
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EX-01' && i.message.includes('"foo"'),
      ),
    ).toBe(true);
  });

  it('R-EX-01 triggers on an unknown io reference', () => {
    const p = clone();
    p.machines[0]!.interlocks[0]!.when = 'io_ghost';
    const report = validate(p);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-EX-01' && i.message.includes('io_ghost'),
      ),
    ).toBe(true);
  });

  it('R-EX-01 triggers on an unknown equipment.role reference', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.transitions[1]!.trigger =
      'cyl01.ghost_role';
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EX-01' && i.message.includes('ghost_role'),
      ),
    ).toBe(true);
  });

  it('R-EX-01 triggers on a reference to an unknown equipment', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.transitions[1]!.trigger =
      'ghost_eq.sensor_extended';
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EX-01' && i.message.includes('ghost_eq'),
      ),
    ).toBe(true);
  });

  it('accepts a composed valid expression mixing keyword + io + equipment.role', () => {
    const p = clone();
    p.machines[0]!.interlocks[0]!.when =
      'estop_active || (io_part_sensor && cyl01.sensor_extended)';
    const report = validate(p);
    const exprErrors = report.issues.filter((i) => i.rule === 'R-EX-01');
    expect(exprErrors, JSON.stringify(exprErrors, null, 2)).toHaveLength(0);
  });

  it('accepts a valid whitelisted function with opaque args (no arg-level resolution in v0.1)', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.transitions[0]!.trigger =
      'rising(anything_goes_here)';
    const report = validate(p);
    const exprErrors = report.issues.filter((i) => i.rule === 'R-EX-01');
    expect(exprErrors, JSON.stringify(exprErrors, null, 2)).toHaveLength(0);
  });
});
