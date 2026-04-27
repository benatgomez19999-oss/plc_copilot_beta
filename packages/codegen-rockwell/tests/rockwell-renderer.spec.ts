import { describe, expect, it } from 'vitest';
import {
  renderExprRockwell,
  renderFunctionBlockRockwell,
  renderStmtRockwell,
  renderVarSectionRockwell,
  siemensToRockwellText,
} from '../src/renderers/rockwell-st.js';
import { ir, ref } from '@plccopilot/codegen-core';
import type { FunctionBlockIR } from '@plccopilot/codegen-core';

describe('siemensToRockwellText — Raw fallback translation', () => {
  it('drops the leading # from FB-local refs', () => {
    expect(siemensToRockwellText('#state')).toBe('state');
    expect(siemensToRockwellText('#cyl01_extend_cmd')).toBe(
      'cyl01_extend_cmd',
    );
  });

  it('strips quotes around bare global identifiers', () => {
    expect(siemensToRockwellText('"io_part_sensor"')).toBe('io_part_sensor');
  });

  it('rewrites "DB_Alarms".X into Alarms.X (Rockwell namespace)', () => {
    expect(siemensToRockwellText('"DB_Alarms".set_al_cyl_ext_timeout')).toBe(
      'Alarms.set_al_cyl_ext_timeout',
    );
    expect(siemensToRockwellText('"DB_Alarms".active_al_estop_active')).toBe(
      'Alarms.active_al_estop_active',
    );
  });

  it('rewrites "DB_Global_Params".X / "DB_Recipes".X', () => {
    expect(siemensToRockwellText('"DB_Global_Params".p_weld_time')).toBe(
      'Parameters.p_weld_time',
    );
    expect(siemensToRockwellText('"DB_Recipes".r_default_p_weld_time')).toBe(
      'Recipes.r_default_p_weld_time',
    );
  });

  it('preserves IEC time literals (T#5000MS)', () => {
    expect(siemensToRockwellText('T#5000MS')).toBe('T#5000MS');
  });
});

describe('renderExprRockwell — expression rendering', () => {
  it('renders booleans and numerics Logix-style', () => {
    expect(renderExprRockwell(ir.boolLit(true))).toBe('TRUE');
    expect(renderExprRockwell(ir.boolLit(false))).toBe('FALSE');
    expect(renderExprRockwell(ir.numLit(42))).toBe('42');
    expect(renderExprRockwell(ir.numLit(3.14, 'Real'))).toBe('3.14');
    expect(renderExprRockwell(ir.numLit(2, 'Real'))).toBe('2.0');
  });

  it('renders RefIR variants with Rockwell conventions', () => {
    expect(renderExprRockwell(ir.refExpr(ref.local('state')))).toBe('state');
    expect(renderExprRockwell(ir.refExpr(ref.global('io_x')))).toBe('io_x');
    expect(
      renderExprRockwell(ir.refExpr(ref.dbField('DB_Alarms', 'set_al'))),
    ).toBe('Alarms.set_al');
    expect(
      renderExprRockwell(
        ir.refExpr(ref.dbField('DB_Global_Params', 'p_weld_time')),
      ),
    ).toBe('Parameters.p_weld_time');
    expect(renderExprRockwell(ir.refExpr(ref.fbInstance('TON_x')))).toBe(
      'TON_x',
    );
  });

  it('renders EdgeRef as bare one-shot bit (no .Q)', () => {
    expect(
      renderExprRockwell({
        kind: 'EdgeRef',
        instanceName: 'R_TRIG_st_load_io_x',
        edgeKind: 'rising',
      }),
    ).toBe('R_TRIG_st_load_io_x');
    expect(
      renderExprRockwell({
        kind: 'EdgeRef',
        instanceName: 'F_TRIG_st_load_io_y',
        edgeKind: 'falling',
      }),
    ).toBe('F_TRIG_st_load_io_y');
  });

  it('renders InstanceField (TON.Q) with Rockwell ref convention', () => {
    expect(
      renderExprRockwell(
        ir.instanceField(ref.fbInstance('TON_t_extended'), 'Q'),
      ),
    ).toBe('TON_t_extended.Q');
  });

  it('strips Siemens hashes / quotes from Raw nodes (fallback path)', () => {
    expect(renderExprRockwell(ir.raw('#state'))).toBe('state');
    expect(renderExprRockwell(ir.raw('"io_x"'))).toBe('io_x');
    expect(renderExprRockwell(ir.raw('"DB_Alarms".set_x'))).toBe(
      'Alarms.set_x',
    );
  });
});

describe('renderStmtRockwell — statement rendering', () => {
  it('renders Assign with // comments using RefIR target', () => {
    const stmt = ir.assign(
      ref.local('state'),
      ir.numLit(1),
      '-> st_extending',
    );
    expect(renderStmtRockwell(stmt, 0)).toEqual([
      'state := 1; // -> st_extending',
    ]);
  });

  it('renders dbField assignment via Alarms.<bit>', () => {
    const stmt = ir.assign(
      ref.dbField('DB_Alarms', 'set_al_cyl_ext_timeout'),
      ir.boolLit(true),
    );
    expect(renderStmtRockwell(stmt, 0)).toEqual([
      'Alarms.set_al_cyl_ext_timeout := TRUE;',
    ]);
  });

  it('renders Comment as // …', () => {
    expect(renderStmtRockwell(ir.comment('header'), 0)).toEqual([
      '// header',
    ]);
  });

  it('renders IF/END_IF without # or quotes', () => {
    const stmt = ir.if_(
      ir.paren(ir.refExpr(ref.local('i_estop_active'))),
      [ir.assign(ref.local('state'), ir.numLit(4))],
    );
    const out = renderStmtRockwell(stmt, 0).join('\n');
    expect(out).toContain('IF (i_estop_active) THEN');
    expect(out).toContain('state := 4;');
    expect(out).toContain('END_IF;');
  });

  it('renders TonCall with pseudo-IEC marker comment', () => {
    const stmt = ir.ton(
      ref.fbInstance('TON_a'),
      ir.paren(
        ir.bin('=', ir.refExpr(ref.local('state')), ir.numLit(1)),
      ),
      5000,
    );
    const lines = renderStmtRockwell(stmt, 0);
    expect(lines).toEqual([
      'TON_a(IN := (state = 1), PT := T#5000MS); // pseudo-IEC TON',
    ]);
  });

  it('renders rising-edge FbCall as one-shot bit pattern', () => {
    const stmt = ir.fbCall(
      ref.fbInstance('R_TRIG_st_load_io_x'),
      [{ name: 'CLK', value: ir.refExpr(ref.global('io_x')) }],
    );
    expect(renderStmtRockwell(stmt, 0)).toEqual([
      'R_TRIG_st_load_io_x := io_x AND NOT R_TRIG_st_load_io_x_MEM;',
      'R_TRIG_st_load_io_x_MEM := io_x;',
    ]);
  });

  it('renders falling-edge FbCall as inverted one-shot bit pattern', () => {
    const stmt = ir.fbCall(
      ref.fbInstance('F_TRIG_st_load_io_y'),
      [{ name: 'CLK', value: ir.refExpr(ref.global('io_y')) }],
    );
    expect(renderStmtRockwell(stmt, 0)).toEqual([
      'F_TRIG_st_load_io_y := NOT io_y AND F_TRIG_st_load_io_y_MEM;',
      'F_TRIG_st_load_io_y_MEM := io_y;',
    ]);
  });

  it('renders non-edge FbCall as standard call', () => {
    const stmt = ir.fbCall(
      ref.fbInstance('CustomFB_x'),
      [{ name: 'arg', value: ir.refExpr(ref.local('a')) }],
    );
    expect(renderStmtRockwell(stmt, 0)).toEqual([
      'CustomFB_x(arg := a);',
    ]);
  });
});

describe('renderVarSectionRockwell — sections', () => {
  it('emits VAR_INPUT / END_VAR with Logix-style types', () => {
    const lines = renderVarSectionRockwell(
      {
        section: 'VAR_INPUT',
        decls: [
          { name: 'i_mode', type: 'Int', comment: '1=auto 2=manual' },
          { name: 'i_start_cmd', type: 'Bool' },
        ],
      },
      0,
    ).join('\n');
    expect(lines).toContain('VAR_INPUT');
    expect(lines).toContain('i_mode : INT;  // 1=auto 2=manual');
    expect(lines).toContain('i_start_cmd : BOOL;');
    expect(lines).toContain('END_VAR');
  });

  it('expands R_TRIG decls into BOOL one-shot + companion BOOL _MEM', () => {
    const lines = renderVarSectionRockwell(
      {
        section: 'VAR',
        decls: [
          { name: 'R_TRIG_st_load_io_x', type: 'R_TRIG' },
        ],
      },
      0,
    ).join('\n');
    expect(lines).toMatch(/R_TRIG_st_load_io_x : BOOL;/);
    expect(lines).toMatch(/R_TRIG_st_load_io_x_MEM : BOOL;/);
    // Sprint 38 — match the **declaration line shape** (`name : R_TRIG;`)
    // rather than a bare substring. The renderer's trailing comment
    // legitimately includes `source: R_TRIG` for traceability, so a
    // `not.toContain(': R_TRIG')` check would always fail. The
    // semantic claim is "no variable declaration retains the R_TRIG
    // FB type" — match exactly that.
    expect(lines).not.toMatch(/^\s*\w+ : R_TRIG;/m);
  });

  it('expands F_TRIG decls into BOOL one-shot + companion BOOL _MEM', () => {
    const lines = renderVarSectionRockwell(
      {
        section: 'VAR',
        decls: [
          { name: 'F_TRIG_st_load_io_y', type: 'F_TRIG' },
        ],
      },
      0,
    ).join('\n');
    expect(lines).toMatch(/F_TRIG_st_load_io_y : BOOL;/);
    expect(lines).toMatch(/F_TRIG_st_load_io_y_MEM : BOOL;/);
    // Sprint 38 — same fix as for R_TRIG above: line-anchored regex
    // so the trailing `source: F_TRIG` comment doesn't trip the
    // assertion. The semantic claim is "no `: F_TRIG;` declaration
    // remains".
    expect(lines).not.toMatch(/^\s*\w+ : F_TRIG;/m);
  });

  it('flags TON declarations as pseudo-IEC in the trailing comment', () => {
    const lines = renderVarSectionRockwell(
      {
        section: 'VAR',
        decls: [{ name: 'TON_t_extended', type: 'TON' }],
      },
      0,
    ).join('\n');
    expect(lines).toContain('TON_t_extended : TON;');
    expect(lines).toContain('pseudo-IEC TON');
  });
});

describe('renderFunctionBlockRockwell — top-level routine envelope', () => {
  const fb: FunctionBlockIR = {
    name: 'FB_Test',
    headerComments: ['Test FB header'],
    attributes: [`{ S7_Optimized_Access := 'TRUE' }`],
    version: '0.1',
    varSections: [
      { section: 'VAR_INPUT', decls: [{ name: 'i_x', type: 'Bool' }] },
      { section: 'VAR', decls: [{ name: 'state', type: 'DInt', init: '0' }] },
    ],
    body: [
      ir.assign(ref.local('state'), ir.numLit(1)),
      ir.assign(ref.local('o_x'), ir.refExpr(ref.local('state'))),
    ],
    stationId: 'st_test',
  };

  it('emits ROUTINE / END_ROUTINE wrapper without Siemens conventions', () => {
    const out = renderFunctionBlockRockwell(fb);
    expect(out).toContain('ROUTINE FB_Test');
    expect(out).toContain('END_ROUTINE');
    expect(out).not.toContain('FUNCTION_BLOCK');
    expect(out).not.toContain('S7_Optimized_Access');
    expect(out).not.toContain('VERSION : 0.1');
    expect(out).not.toContain('"FB_Test"');
  });

  it('does not emit BEGIN keyword (no IEC FB envelope)', () => {
    expect(renderFunctionBlockRockwell(fb)).not.toContain('\nBEGIN\n');
  });

  it('includes the experimental POC banner and L5X disclaimer', () => {
    const out = renderFunctionBlockRockwell(fb);
    expect(out).toContain('Rockwell ST POC');
    expect(out).toContain('ROCKWELL_NO_L5X_EXPORT');
  });

  it('is deterministic across repeated renders', () => {
    expect(renderFunctionBlockRockwell(fb)).toBe(
      renderFunctionBlockRockwell(fb),
    );
  });

  it('renders Logix-style INT/DINT/BOOL in VAR sections', () => {
    const out = renderFunctionBlockRockwell(fb);
    expect(out).toContain('i_x : BOOL;');
    expect(out).toContain('state : DINT := 0;');
  });
});
