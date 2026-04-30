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

// =============================================================================
// Sprint 88G — R-EQ-05 io_setpoint_bindings rule
//
// Each test starts from the weldline fixture, swaps one cylinder for a
// `motor_vfd_simple` (the only equipment kind that today *requires* a
// setpoint source), and asserts the rule fires (or does not fire) for
// the expected scenario.
// =============================================================================

function vfdProject(): Project {
  const p = clone();
  const m = p.machines[0]!;
  // Add a numeric machine parameter to bind against.
  m.parameters.push({
    id: 'p_m01_speed',
    name: 'M01 Speed setpoint',
    data_type: 'real',
    default: 50,
    min: 0,
    max: 100,
    unit: 'Hz',
  } as unknown as Project['machines'][0]['parameters'][0]);
  // And a bool parameter for the negative dtype-mismatch test.
  m.parameters.push({
    id: 'p_lockout',
    name: 'Lockout',
    data_type: 'bool',
    default: false,
  } as unknown as Project['machines'][0]['parameters'][0]);
  // Add a numeric output IO channel for speed_setpoint_out (analog Q-word).
  m.io.push({
    id: 'io_m01_speed_aw',
    name: 'M01 speed setpoint (AW)',
    direction: 'out',
    data_type: 'real',
    address: { memory_area: 'Q', byte: 100 },
  } as unknown as Project['machines'][0]['io'][0]);
  // And a bool output for run_out.
  m.io.push({
    id: 'io_m01_run',
    name: 'M01 run',
    direction: 'out',
    data_type: 'bool',
    address: { memory_area: 'Q', byte: 0, bit: 7 },
  } as unknown as Project['machines'][0]['io'][0]);
  // Replace the first equipment slot with a motor_vfd_simple. Keep the
  // sequence the way the fixture has it — R-EQ-05 only inspects the
  // equipment + parameters, not the sequence shape.
  const station = m.stations[0]!;
  const eq = station.equipment[0]!;
  // Drop activity references that no longer apply to this equipment.
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

describe('Sprint 88G — R-EQ-05 io_setpoint_bindings', () => {
  it('1. happy path: motor_vfd_simple with numeric parameter passes (no R-EQ-05 issue)', () => {
    const p = vfdProject();
    const report = validate(p);
    const hits = report.issues.filter((i) => i.rule === 'R-EQ-05');
    expect(hits, JSON.stringify(hits, null, 2)).toHaveLength(0);
  });

  it('2. motor_vfd_simple without io_setpoint_bindings fails (sub-rule A)', () => {
    const p = vfdProject();
    delete p.machines[0]!.stations[0]!.equipment[0]!.io_setpoint_bindings;
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EQ-05' && /requires a setpoint source/.test(i.message),
      ),
    ).toBe(true);
  });

  it('3. binding to missing parameter fails (sub-rule B4)', () => {
    const p = vfdProject();
    p.machines[0]!.stations[0]!.equipment[0]!.io_setpoint_bindings = {
      speed_setpoint_out: 'p_does_not_exist',
    };
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EQ-05' && /unknown parameter/.test(i.message),
      ),
    ).toBe(true);
  });

  it('4. binding to bool parameter fails (sub-rule B5)', () => {
    const p = vfdProject();
    p.machines[0]!.stations[0]!.equipment[0]!.io_setpoint_bindings = {
      speed_setpoint_out: 'p_lockout',
    };
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EQ-05' && /numeric parameter/.test(i.message),
      ),
    ).toBe(true);
  });

  it('5. binding to unknown role fails (sub-rule B1)', () => {
    const p = vfdProject();
    p.machines[0]!.stations[0]!.equipment[0]!.io_setpoint_bindings = {
      speed_setpoint_out: 'p_m01_speed',
      bogus_role: 'p_m01_speed',
    };
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EQ-05' && /not defined for equipment type/.test(i.message),
      ),
    ).toBe(true);
  });

  it('6. binding to a non-numeric / input role fails (sub-rule B2)', () => {
    // `running_fb` is an optional bool *input* role on motor_vfd_simple.
    const p = vfdProject();
    const eq = p.machines[0]!.stations[0]!.equipment[0]!;
    // Add a bool feedback input first so the role is bound in io_bindings.
    p.machines[0]!.io.push({
      id: 'io_m01_running',
      name: 'M01 running fb',
      direction: 'in',
      data_type: 'bool',
      address: { memory_area: 'I', byte: 5, bit: 0 },
    } as unknown as Project['machines'][0]['io'][0]);
    eq.io_bindings.running_fb = 'io_m01_running';
    eq.io_setpoint_bindings = {
      speed_setpoint_out: 'p_m01_speed',
      running_fb: 'p_m01_speed',
    };
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EQ-05' &&
          /only allowed on numeric output roles/.test(i.message),
      ),
    ).toBe(true);
  });

  it('7. binding for a role missing from io_bindings fails (sub-rule B3)', () => {
    const p = vfdProject();
    const eq = p.machines[0]!.stations[0]!.equipment[0]!;
    // Drop the physical IO channel for `speed_setpoint_out` while
    // keeping the setpoint source binding. R-EQ-01 will also fire for
    // the missing required role; R-EQ-05 must additionally flag the
    // setpoint-binding-without-IO mismatch.
    delete (eq.io_bindings as Record<string, string>).speed_setpoint_out;
    const report = validate(p);
    expect(
      report.issues.some(
        (i) =>
          i.rule === 'R-EQ-05' &&
          /requires that role to also appear in io_bindings/.test(i.message),
      ),
    ).toBe(true);
  });

  it('8. backwards compatibility: weldline fixture (no io_setpoint_bindings) stays clean', () => {
    // Sanity: the fixture has no VFD; no required numeric output roles
    // exist, so sub-rule A never fires and sub-rule B has nothing to
    // iterate. R-EQ-05 must produce zero issues.
    const report = validate(fixture as unknown as Project);
    const hits = report.issues.filter((i) => i.rule === 'R-EQ-05');
    expect(hits, JSON.stringify(hits, null, 2)).toHaveLength(0);
  });
});
