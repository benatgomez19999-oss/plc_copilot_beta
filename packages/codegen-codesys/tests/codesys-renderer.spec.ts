import { describe, expect, it } from 'vitest';
import {
  renderExprCodesys,
  renderFunctionBlockCodesys,
  renderStmtCodesys,
  renderVarSectionCodesys,
  siemensToCodesysText,
} from '../src/renderers/codesys-st.js';
import { ir, ref } from '@plccopilot/codegen-core';
import type { FunctionBlockIR } from '@plccopilot/codegen-core';

describe('siemensToCodesysText — Raw fallback translation', () => {
  it('drops the leading # from FB-local refs', () => {
    expect(siemensToCodesysText('#state')).toBe('state');
    expect(siemensToCodesysText('#cyl01_extend_cmd')).toBe('cyl01_extend_cmd');
    expect(siemensToCodesysText('#TON_t_extended.Q')).toBe('TON_t_extended.Q');
  });

  it('strips quotes around bare global identifiers', () => {
    expect(siemensToCodesysText('"io_part_sensor"')).toBe('io_part_sensor');
    expect(siemensToCodesysText('"al_estop_active"')).toBe('al_estop_active');
  });

  it('rewrites "DB_Alarms".X into GVL_Alarms.X', () => {
    expect(siemensToCodesysText('"DB_Alarms".set_al_cyl_ext_timeout')).toBe(
      'GVL_Alarms.set_al_cyl_ext_timeout',
    );
    expect(siemensToCodesysText('"DB_Alarms".active_al_estop_active')).toBe(
      'GVL_Alarms.active_al_estop_active',
    );
  });

  it('preserves IEC time literals (T#5000MS)', () => {
    expect(siemensToCodesysText('T#5000MS')).toBe('T#5000MS');
  });

  it('handles a full Siemens-flavoured TON call line', () => {
    const sie = `#TON_t_extended(IN := (#state = 1), PT := T#5000MS);`;
    const cod = siemensToCodesysText(sie);
    expect(cod).toBe(`TON_t_extended(IN := (state = 1), PT := T#5000MS);`);
  });
});

describe('renderExprCodesys — expression rendering', () => {
  it('renders booleans and numerics IEC-style', () => {
    expect(renderExprCodesys(ir.boolLit(true))).toBe('TRUE');
    expect(renderExprCodesys(ir.boolLit(false))).toBe('FALSE');
    expect(renderExprCodesys(ir.numLit(42))).toBe('42');
    expect(renderExprCodesys(ir.numLit(3.14, 'Real'))).toBe('3.14');
    expect(renderExprCodesys(ir.numLit(2, 'Real'))).toBe('2.0');
  });

  it('strips Siemens hashes / quotes from Raw nodes (fallback path)', () => {
    expect(renderExprCodesys(ir.raw('#state'))).toBe('state');
    expect(renderExprCodesys(ir.raw('"io_x"'))).toBe('io_x');
  });

  it('renders structured Ref nodes without going through the regex', () => {
    expect(renderExprCodesys(ir.refExpr(ref.local('state')))).toBe('state');
    expect(renderExprCodesys(ir.refExpr(ref.global('io_x')))).toBe('io_x');
    expect(
      renderExprCodesys(ir.refExpr(ref.dbField('DB_Alarms', 'set_al'))),
    ).toBe('GVL_Alarms.set_al');
  });

  it('renders binary / not / paren as IEC ST', () => {
    expect(
      renderExprCodesys(
        ir.bin('AND', ir.refExpr(ref.local('a')), ir.refExpr(ref.local('b'))),
      ),
    ).toBe('a AND b');
    expect(renderExprCodesys(ir.not(ir.refExpr(ref.local('a'))))).toBe(
      'NOT a',
    );
    expect(
      renderExprCodesys(
        ir.paren(
          ir.bin('OR', ir.refExpr(ref.local('a')), ir.refExpr(ref.local('b'))),
        ),
      ),
    ).toBe('(a OR b)');
  });
});

describe('renderStmtCodesys — statement rendering', () => {
  it('renders Assign with IEC := and (* *) comments using RefIR target', () => {
    const stmt = ir.assign(
      ref.local('state'),
      ir.numLit(1),
      '-> st_extending',
    );
    expect(renderStmtCodesys(stmt, 0)).toEqual([
      'state := 1; (* -> st_extending *)',
    ]);
  });

  it('renders Comment as (* ... *)', () => {
    expect(renderStmtCodesys(ir.comment('header'), 0)).toEqual([
      '(* header *)',
    ]);
  });

  it('renders IF/END_IF without # or quotes', () => {
    const stmt = ir.if_(
      ir.paren(ir.refExpr(ref.local('i_estop_active'))),
      [ir.assign(ref.local('state'), ir.numLit(4))],
    );
    const out = renderStmtCodesys(stmt, 0).join('\n');
    expect(out).toContain('IF (i_estop_active) THEN');
    expect(out).toContain('state := 4;');
    expect(out).toContain('END_IF;');
  });

  it('renders TonCall with IEC time literal', () => {
    const stmt = ir.ton(
      ref.fbInstance('TON_a'),
      ir.paren(
        ir.bin('=', ir.refExpr(ref.local('state')), ir.numLit(1)),
      ),
      5000,
    );
    expect(renderStmtCodesys(stmt, 0)).toEqual([
      'TON_a(IN := (state = 1), PT := T#5000MS);',
    ]);
  });

  it('renders FbCall (e.g., R_TRIG tick) without #', () => {
    const stmt = ir.fbCall(
      ref.fbInstance('R_TRIG_st_load_x'),
      [{ name: 'CLK', value: ir.refExpr(ref.global('io_x')) }],
    );
    expect(renderStmtCodesys(stmt, 0)).toEqual([
      'R_TRIG_st_load_x(CLK := io_x);',
    ]);
  });

  it('renders InstanceField (TON.Q / hold_timer.Q) without # or regex', () => {
    expect(
      renderExprCodesys(
        ir.instanceField(ref.fbInstance('TON_t_extended'), 'Q'),
      ),
    ).toBe('TON_t_extended.Q');
    expect(
      renderExprCodesys(
        ir.instanceField(ref.fbInstance('hold_timer'), 'Q'),
      ),
    ).toBe('hold_timer.Q');
  });
});

describe('renderVarSectionCodesys — sections', () => {
  it('emits VAR_INPUT / END_VAR with (* *) inline comments', () => {
    const lines = renderVarSectionCodesys(
      {
        section: 'VAR_INPUT',
        decls: [
          { name: 'i_mode', type: 'INT', comment: '1=auto 2=manual' },
          { name: 'i_start_cmd', type: 'BOOL' },
        ],
      },
      0,
    ).join('\n');
    expect(lines).toContain('VAR_INPUT');
    expect(lines).toContain('i_mode : INT; (* 1=auto 2=manual *)');
    expect(lines).toContain('i_start_cmd : BOOL;');
    expect(lines).toContain('END_VAR');
  });
});

describe('renderFunctionBlockCodesys — top-level FB', () => {
  const fb: FunctionBlockIR = {
    name: 'FB_Test',
    headerComments: ['=====', 'Test FB', '====='],
    attributes: [`{ S7_Optimized_Access := 'TRUE' }`],
    version: '0.1',
    varSections: [
      { section: 'VAR_INPUT', decls: [{ name: 'i_x', type: 'BOOL' }] },
      { section: 'VAR', decls: [{ name: 'state', type: 'INT', init: '0' }] },
    ],
    body: [
      ir.assign(ref.local('state'), ir.numLit(1)),
      ir.assign(ref.local('o_x'), ir.refExpr(ref.local('state'))),
    ],
    stationId: 'st_test',
  };

  it('emits FUNCTION_BLOCK without quotes or VERSION line', () => {
    const out = renderFunctionBlockCodesys(fb);
    expect(out).toContain('FUNCTION_BLOCK FB_Test');
    expect(out).not.toContain('"FB_Test"');
    expect(out).not.toContain('VERSION : 0.1');
    expect(out).not.toContain('S7_Optimized_Access');
  });

  it('omits the BEGIN keyword (IEC 61131-3 compliance)', () => {
    expect(renderFunctionBlockCodesys(fb)).not.toContain('\nBEGIN\n');
  });

  it('wraps marker-free header lines in (* *)', () => {
    const out = renderFunctionBlockCodesys(fb);
    expect(out).toContain('(* ===== *)');
    expect(out).toContain('(* Test FB *)');
  });

  it('closes with END_FUNCTION_BLOCK', () => {
    expect(renderFunctionBlockCodesys(fb)).toContain('END_FUNCTION_BLOCK');
  });

  it('is deterministic across calls', () => {
    expect(renderFunctionBlockCodesys(fb)).toBe(renderFunctionBlockCodesys(fb));
  });
});
