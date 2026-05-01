import { describe, expect, it } from 'vitest';
import fixture from '../../src/fixtures/weldline.json';
import { validate } from '../../src/validators/index.js';
import type { Project } from '../../src/domain/types.js';
import { normalizeSpeedSetpointUnit } from '../../src/validators/rules/parameters.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// Sprint 97 — share a vfd-shaped fixture with the R-EQ-05 spec.
// Adding a `motor_vfd_simple` station + the parameter that backs
// its `speed_setpoint_out` is the only way R-PR-03 (B) can fire,
// since the rule walks the equipment setpoint bindings to find
// the affected parameter id.
function vfdProject(): Project {
  const p = clone();
  const m = p.machines[0]!;
  m.parameters.push({
    id: 'p_m01_speed',
    name: 'M01 Speed setpoint',
    data_type: 'real',
    default: 50,
    min: 0,
    max: 60,
    unit: 'Hz',
  } as unknown as Project['machines'][0]['parameters'][0]);
  m.io.push({
    id: 'io_m01_run',
    name: 'M01 run',
    direction: 'out',
    data_type: 'bool',
    address: { memory_area: 'Q', byte: 0, bit: 6 },
  } as unknown as Project['machines'][0]['io'][0]);
  m.io.push({
    id: 'io_m01_speed_aw',
    name: 'M01 speed AW',
    direction: 'out',
    data_type: 'real',
    address: { memory_area: 'Q', byte: 0, bit: 7 },
  } as unknown as Project['machines'][0]['io'][0]);
  const station = m.stations[0]!;
  const eq = station.equipment[0]!;
  for (const st of station.sequence.states) {
    if (st.activity?.activate) st.activity.activate = [];
  }
  eq.type = 'motor_vfd_simple' as Project['machines'][0]['stations'][0]['equipment'][0]['type'];
  eq.io_bindings = {
    run_out: 'io_m01_run',
    speed_setpoint_out: 'io_m01_speed_aw',
  };
  eq.io_setpoint_bindings = {
    speed_setpoint_out: 'p_m01_speed',
  };
  delete eq.timing;
  return p;
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

// =============================================================================
// Sprint 97 — R-PR-03 parameter range / unit consistency
// =============================================================================

describe('Sprint 97 — R-PR-03 range coherence', () => {
  it('1. parameter without min/max remains valid (backwards compat)', () => {
    const p = clone();
    p.machines[0]!.parameters.push({
      id: 'p_no_range',
      name: 'No range',
      data_type: 'real',
      default: 1.0,
    } as unknown as Project['machines'][0]['parameters'][0]);
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-PR-03')).toBe(false);
  });

  it('2. min finite + max finite + min <= max → no R-PR-03 issue', () => {
    const p = clone();
    p.machines[0]!.parameters.push({
      id: 'p_clean_range',
      name: 'Clean range',
      data_type: 'real',
      default: 5,
      min: 0,
      max: 10,
    } as unknown as Project['machines'][0]['parameters'][0]);
    const report = validate(p);
    expect(report.issues.some((i) => i.rule === 'R-PR-03')).toBe(false);
  });

  it('3. min > max → R-PR-03 error', () => {
    const p = clone();
    p.machines[0]!.parameters.push({
      id: 'p_inverted',
      name: 'Inverted',
      data_type: 'real',
      default: 5,
      min: 10,
      max: 0,
    } as unknown as Project['machines'][0]['parameters'][0]);
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-PR-03' &&
          i.severity === 'error' &&
          i.message.includes('min') &&
          i.message.includes('max'),
      ),
    ).toBe(true);
  });

  it('4. non-finite min slipped past the schema → R-PR-03 error', () => {
    // Fixtures that bypass Zod via `as Project` casts can reach
    // the validator with `Infinity` bounds; R-PR-03 is the
    // belt-and-braces check.
    const p = clone();
    p.machines[0]!.parameters.push({
      id: 'p_inf_min',
      name: 'Infinity min',
      data_type: 'real',
      default: 1,
      min: Number.POSITIVE_INFINITY,
      max: 10,
    } as unknown as Project['machines'][0]['parameters'][0]);
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-PR-03' &&
          i.severity === 'error' &&
          i.path?.endsWith('.min'),
      ),
    ).toBe(true);
  });

  it('5. non-finite max slipped past the schema → R-PR-03 error', () => {
    const p = clone();
    p.machines[0]!.parameters.push({
      id: 'p_inf_max',
      name: 'Infinity max',
      data_type: 'real',
      default: 1,
      max: Number.POSITIVE_INFINITY,
    } as unknown as Project['machines'][0]['parameters'][0]);
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-PR-03' &&
          i.severity === 'error' &&
          i.path?.endsWith('.max'),
      ),
    ).toBe(true);
  });
});

describe('Sprint 97 — R-PR-03 (B) speed_setpoint_out unit policy', () => {
  it('6. motor_vfd_simple with unit "Hz" passes', () => {
    const p = vfdProject();
    const report = validate(p);
    const hits = report.issues.filter((i) => i.rule === 'R-PR-03');
    expect(hits, JSON.stringify(hits, null, 2)).toHaveLength(0);
  });

  it('7. unit alias "hertz" / "HERTZ" passes', () => {
    for (const u of ['hertz', 'HERTZ', 'hz']) {
      const p = vfdProject();
      const param = p.machines[0]!.parameters.find(
        (q) => q.id === 'p_m01_speed',
      )!;
      param.unit = u;
      const report = validate(p);
      const hits = report.issues.filter(
        (i) => i.rule === 'R-PR-03' && i.severity === 'error',
      );
      expect(
        hits,
        `unit ${JSON.stringify(u)} should pass; got ${JSON.stringify(hits, null, 2)}`,
      ).toHaveLength(0);
    }
  });

  it('8. unit "rpm" hard-fails as incompatible', () => {
    const p = vfdProject();
    const param = p.machines[0]!.parameters.find(
      (q) => q.id === 'p_m01_speed',
    )!;
    param.unit = 'rpm';
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-PR-03' &&
          i.severity === 'error' &&
          i.message.includes('rpm'),
      ),
    ).toBe(true);
  });

  it('9. unit "%" hard-fails as incompatible', () => {
    const p = vfdProject();
    const param = p.machines[0]!.parameters.find(
      (q) => q.id === 'p_m01_speed',
    )!;
    param.unit = '%';
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-PR-03' &&
          i.severity === 'error' &&
          i.message.includes('"%"'),
      ),
    ).toBe(true);
  });

  it('10. missing unit surfaces an info diagnostic, not an error', () => {
    const p = vfdProject();
    const param = p.machines[0]!.parameters.find(
      (q) => q.id === 'p_m01_speed',
    )!;
    delete param.unit;
    const report = validate(p);
    const errs = report.issues.filter(
      (i) => i.rule === 'R-PR-03' && i.severity === 'error',
    );
    expect(errs).toHaveLength(0);
    const info = report.issues.find(
      (i) => i.rule === 'R-PR-03' && i.severity === 'info',
    );
    expect(info?.message).toMatch(/no unit/);
  });

  it('11. weldline fixture (no motor_vfd_simple) has no R-PR-03 unit-policy issue', () => {
    const report = validate(fixture as unknown as Project);
    const hits = report.issues.filter(
      (i) => i.rule === 'R-PR-03' && i.severity !== 'info',
    );
    expect(hits, JSON.stringify(hits, null, 2)).toHaveLength(0);
  });
});

describe('normalizeSpeedSetpointUnit — Sprint 97 helper', () => {
  it('12. Hz aliases canonicalise to "Hz"', () => {
    expect(normalizeSpeedSetpointUnit('Hz')).toBe('Hz');
    expect(normalizeSpeedSetpointUnit('hz')).toBe('Hz');
    expect(normalizeSpeedSetpointUnit('Hertz')).toBe('Hz');
    expect(normalizeSpeedSetpointUnit('HERTZ')).toBe('Hz');
    expect(normalizeSpeedSetpointUnit(' hertz ')).toBe('Hz');
  });

  it('13. unknown / non-Hz units return null', () => {
    expect(normalizeSpeedSetpointUnit('rpm')).toBeNull();
    expect(normalizeSpeedSetpointUnit('%')).toBeNull();
    expect(normalizeSpeedSetpointUnit('m/s')).toBeNull();
    expect(normalizeSpeedSetpointUnit('')).toBeNull();
    expect(normalizeSpeedSetpointUnit(undefined)).toBeNull();
  });
});
