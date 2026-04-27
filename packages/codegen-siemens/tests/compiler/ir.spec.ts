import { describe, expect, it } from 'vitest';
import { ir, ref } from '../../src/compiler/ir/builder.js';
import type { FunctionBlockIR } from '../../src/compiler/ir/nodes.js';
import {
  renderExpr,
  renderFunctionBlock,
  renderStmt,
} from '../../src/compiler/renderers/scl.js';
import {
  renderExprCodesys,
  renderStmtCodesys,
} from '@plccopilot/codegen-codesys';

describe('ir — expression rendering', () => {
  it('renders literals with SCL conventions', () => {
    expect(renderExpr(ir.boolLit(true))).toBe('TRUE');
    expect(renderExpr(ir.boolLit(false))).toBe('FALSE');
    expect(renderExpr(ir.numLit(42))).toBe('42');
    expect(renderExpr(ir.numLit(3.14, 'Real'))).toBe('3.14');
    expect(renderExpr(ir.numLit(2, 'Real'))).toBe('2.0');
    expect(renderExpr(ir.strLit("it's fine"))).toBe("'it''s fine'");
  });

  it('renders RefIR per backend', () => {
    expect(renderExpr(ir.refExpr(ref.local('state')))).toBe('#state');
    expect(renderExpr(ir.refExpr(ref.global('io_x')))).toBe('"io_x"');
    expect(
      renderExpr(ir.refExpr(ref.dbField('DB_Alarms', 'set_al_x'))),
    ).toBe('"DB_Alarms".set_al_x');
    expect(renderExpr(ir.refExpr(ref.fbInstance('TON_a')))).toBe('#TON_a');

    expect(renderExprCodesys(ir.refExpr(ref.local('state')))).toBe('state');
    expect(renderExprCodesys(ir.refExpr(ref.global('io_x')))).toBe('io_x');
    expect(
      renderExprCodesys(ir.refExpr(ref.dbField('DB_Alarms', 'set_al_x'))),
    ).toBe('GVL_Alarms.set_al_x');
    expect(renderExprCodesys(ir.refExpr(ref.fbInstance('TON_a')))).toBe(
      'TON_a',
    );
  });

  it('renders EdgeRef per backend with .Q access', () => {
    const e = ir.edgeRef('R_TRIG_st_load_x', 'rising');
    expect(renderExpr(e)).toBe('#R_TRIG_st_load_x.Q');
    expect(renderExprCodesys(e)).toBe('R_TRIG_st_load_x.Q');
  });

  it('renders InstanceField (TON.Q) without any Raw fallback', () => {
    const e = ir.instanceField(ref.fbInstance('TON_t_extended'), 'Q');
    expect(renderExpr(e)).toBe('#TON_t_extended.Q');
    expect(renderExprCodesys(e)).toBe('TON_t_extended.Q');
  });

  it('renders InstanceField for timer_expired-style refs', () => {
    const e = ir.instanceField(ref.fbInstance('hold_timer'), 'Q');
    expect(renderExpr(e)).toBe('#hold_timer.Q');
    expect(renderExprCodesys(e)).toBe('hold_timer.Q');
  });

  it('renders binary / unary / paren as SCL', () => {
    expect(
      renderExpr(ir.bin('AND', ir.refExpr(ref.local('a')), ir.refExpr(ref.local('b')))),
    ).toBe('#a AND #b');
    expect(renderExpr(ir.not(ir.refExpr(ref.local('a'))))).toBe('NOT #a');
  });

  it('andAll / orAll collapse correctly', () => {
    expect(renderExpr(ir.andAll([]))).toBe('TRUE');
    expect(renderExpr(ir.orAll([]))).toBe('FALSE');
  });
});

describe('ir — statement rendering', () => {
  it('renders Assign with RefIR target on both backends', () => {
    const stmt = ir.assign(ref.local('state'), ir.numLit(1), '-> next');
    expect(renderStmt(stmt, 0)).toEqual([
      '#state := 1;  // -> next',
    ]);
    expect(renderStmtCodesys(stmt, 0)).toEqual([
      'state := 1; (* -> next *)',
    ]);
  });

  it('renders IF / END_IF with RefIR conds', () => {
    const stmt = ir.if_(
      ir.paren(ir.refExpr(ref.local('cond'))),
      [ir.assign(ref.local('x'), ir.boolLit(true))],
    );
    expect(renderStmt(stmt, 0)).toEqual([
      'IF (#cond) THEN',
      '    #x := TRUE;',
      'END_IF;',
    ]);
  });

  it('renders TON invocation with T#<ms>MS using fbInstance Ref', () => {
    const stmt = ir.ton(
      ref.fbInstance('TON_a'),
      ir.paren(ir.bin('=', ir.refExpr(ref.local('state')), ir.numLit(1))),
      5000,
    );
    expect(renderStmt(stmt, 0)).toEqual([
      '#TON_a(IN := (#state = 1), PT := T#5000MS);',
    ]);
    expect(renderStmtCodesys(stmt, 0)).toEqual([
      'TON_a(IN := (state = 1), PT := T#5000MS);',
    ]);
  });

  it('renders FbCall with structured fbInstance Ref', () => {
    const stmt = ir.fbCall(
      ref.fbInstance('R_TRIG_st_load_x'),
      [{ name: 'CLK', value: ir.refExpr(ref.global('io_x')) }],
    );
    expect(renderStmt(stmt, 0)).toEqual([
      '#R_TRIG_st_load_x(CLK := "io_x");',
    ]);
    expect(renderStmtCodesys(stmt, 0)).toEqual([
      'R_TRIG_st_load_x(CLK := io_x);',
    ]);
  });

  it('CommentIR text never carries comment markers', () => {
    const c = ir.comment('--- header ---');
    expect((c as Extract<typeof c, { kind: 'Comment' }>).text).not.toMatch(
      /\/\/|\(\*|\*\)/,
    );
    expect(renderStmt(c, 0)).toEqual(['// --- header ---']);
    expect(renderStmtCodesys(c, 0)).toEqual(['(* --- header --- *)']);
  });
});

describe('ir — function block rendering is deterministic', () => {
  const fb: FunctionBlockIR = {
    name: 'FB_Test',
    headerComments: ['test header'],
    attributes: [`{ S7_Optimized_Access := 'TRUE' }`],
    version: '0.1',
    varSections: [
      { section: 'VAR_INPUT', decls: [{ name: 'i_x', type: 'BOOL' }] },
      {
        section: 'VAR',
        decls: [
          { name: 'state', type: 'INT', init: '0' },
          {
            name: 'TON_a',
            type: 'TON',
            comment: 'alarm: al_x (1000 ms)',
            preComment: '--- Transition timeouts (TON) ---',
          },
        ],
      },
    ],
    body: [
      ir.comment('--- Sequence dispatch ---'),
      ir.case_(ir.refExpr(ref.local('state')), [
        { value: 0, label: 'st_init (initial)', body: [] },
      ]),
      ir.blankLine(),
      ir.assign(ref.local('o_x'), ir.refExpr(ref.local('i_x'))),
    ],
  };

  it('emits identical output across runs', () => {
    expect(renderFunctionBlock(fb)).toBe(renderFunctionBlock(fb));
  });

  it('contains expected SCL sections and landmarks (Siemens)', () => {
    const out = renderFunctionBlock(fb);
    expect(out).toContain('FUNCTION_BLOCK "FB_Test"');
    expect(out).toContain('// test header');
    expect(out).toContain('VAR_INPUT');
    expect(out).toContain('state : INT := 0;');
    expect(out).toContain('TON_a : TON;');
    expect(out).toContain('CASE #state OF');
    expect(out).toContain('END_CASE;');
    expect(out).toContain('#o_x := #i_x;');
    expect(out).toContain('END_FUNCTION_BLOCK');
  });
});
