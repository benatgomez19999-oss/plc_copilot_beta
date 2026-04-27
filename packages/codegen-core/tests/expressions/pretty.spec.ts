import { describe, expect, it } from 'vitest';
import { parseExpression } from '@plccopilot/codegen-core';
import { prettyPrint } from '@plccopilot/codegen-core';

describe('pretty printer', () => {
  it('renders a nested expression tree with spans', () => {
    const r = parseExpression(
      'estop_active || (io_part_sensor && cyl01.sensor_extended)',
    );
    const out = prettyPrint(r.ast);
    expect(out).toMatchInlineSnapshot(`
      "Binary || [0..56]
        Keyword estop_active [0..12]
        Binary && [17..56]
          Ref io_part_sensor [17..31]
          Member cyl01.sensor_extended [35..56]"
    `);
  });

  it('renders a call with opaque first arg', () => {
    const r = parseExpression('rising(sen_part)');
    const out = prettyPrint(r.ast);
    expect(out).toMatchInlineSnapshot(`
      "Call rising [0..16]
        Ref sen_part [7..15]"
    `);
  });

  it('can omit spans for stable snapshots', () => {
    const r = parseExpression('!io_ok');
    const out = prettyPrint(r.ast, { withSpans: false });
    expect(out).toMatchInlineSnapshot(`
      "Unary !
        Ref io_ok"
    `);
  });

  it('is deterministic for the same input', () => {
    const a = parseExpression('a && b || c').ast;
    const b = parseExpression('a && b || c').ast;
    expect(prettyPrint(a)).toBe(prettyPrint(b));
  });
});
