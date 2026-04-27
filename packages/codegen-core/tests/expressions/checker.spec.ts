import { describe, expect, it } from 'vitest';
import { parseExpression } from '@plccopilot/codegen-core';
import {
  StaticSymbolEnvironment,
  checkExpression,
} from '@plccopilot/codegen-core';

function envWithDefaults(): StaticSymbolEnvironment {
  return new StaticSymbolEnvironment()
    .addRef('io_ok', 'Bool')
    .addRef('io_part_sensor', 'Bool')
    .addRef('p_weld_time', 'DInt')
    .addRef('p_weld_current', 'Real')
    .addRef('hold_timer', 'TimerRef')
    .addMember('cyl01', 'sensor_extended', 'Bool')
    .addMember('cyl01', 'sensor_retracted', 'Bool');
}

function checkOk(src: string, env = envWithDefaults()) {
  const r = parseExpression(src);
  expect(r.diagnostics).toHaveLength(0);
  const c = checkExpression(r.ast, env);
  return { root: c.rootType, diag: c.diagnostics, result: c };
}

describe('checker — happy paths', () => {
  it('types a pure boolean expression as Bool', () => {
    const { root, diag } = checkOk(
      'estop_active || (io_part_sensor && cyl01.sensor_extended)',
    );
    expect(root).toBe('Bool');
    expect(diag).toHaveLength(0);
  });

  it('types a comparison between numeric ref and literal as Bool', () => {
    const { root, diag } = checkOk('p_weld_time > 100');
    expect(root).toBe('Bool');
    expect(diag).toHaveLength(0);
  });

  it('types rising(sen_part) as Bool without enforcing arg type', () => {
    const env = envWithDefaults();
    // sen_part not declared — opaque arg means no UNKNOWN_REF is raised for the arg.
    const { root } = checkOk('rising(sen_part)', env);
    expect(root).toBe('Bool');
  });

  it('types mode == auto (Int vs Int) as Bool', () => {
    const { root, diag } = checkOk('mode == auto');
    expect(root).toBe('Bool');
    expect(diag).toHaveLength(0);
  });

  it('types unary NOT over Bool', () => {
    const { root, diag } = checkOk('!io_ok');
    expect(root).toBe('Bool');
    expect(diag).toHaveLength(0);
  });
});

describe('checker — error cases', () => {
  it('reports UNKNOWN_REF for undeclared bare identifier', () => {
    const { diag } = checkOk('nope && io_ok');
    expect(diag.some((d) => d.code === 'UNKNOWN_REF')).toBe(true);
  });

  it('reports UNKNOWN_MEMBER for undeclared equipment.role', () => {
    const { diag } = checkOk('cyl01.ghost_role || io_ok');
    expect(diag.some((d) => d.code === 'UNKNOWN_MEMBER')).toBe(true);
  });

  it('reports UNKNOWN_FUNCTION for unknown call', () => {
    const { diag } = checkOk('foo(x)');
    expect(diag.some((d) => d.code === 'UNKNOWN_FUNCTION')).toBe(true);
  });

  it('reports ARITY_MISMATCH when call arity is wrong', () => {
    const { diag } = checkOk('rising()');
    expect(diag.some((d) => d.code === 'ARITY_MISMATCH')).toBe(true);
  });

  it('reports EXPECTED_BOOL on non-boolean && operand', () => {
    const { diag } = checkOk('p_weld_time && io_ok');
    expect(diag.some((d) => d.code === 'EXPECTED_BOOL')).toBe(true);
  });

  it('reports EXPECTED_NUMERIC on non-numeric <', () => {
    const { diag } = checkOk('io_ok < 3');
    expect(diag.some((d) => d.code === 'EXPECTED_NUMERIC')).toBe(true);
  });

  it('reports EXPECTED_COMPARABLE when == mixes bool and int', () => {
    const { diag } = checkOk('io_ok == p_weld_time');
    expect(diag.some((d) => d.code === 'EXPECTED_COMPARABLE')).toBe(true);
  });

  it('does not cascade once a subexpression is Unknown', () => {
    // `nope` → Unknown; && with Bool should NOT raise EXPECTED_BOOL on the Unknown side.
    const { diag } = checkOk('nope && io_ok');
    expect(diag.filter((d) => d.code === 'EXPECTED_BOOL')).toHaveLength(0);
  });
});

describe('checker — typeOf lookup', () => {
  it('exposes per-node type via typeOf()', () => {
    const r = parseExpression('p_weld_time > 100');
    const env = envWithDefaults();
    const res = checkExpression(r.ast, env);
    const root = r.ast!;
    if (root.kind !== 'Binary') throw new Error('unexpected root kind');
    expect(res.typeOf(root)).toBe('Bool');
    expect(res.typeOf(root.left)).toBe('DInt');
    expect(res.typeOf(root.right)).toBe('DInt');
  });
});
