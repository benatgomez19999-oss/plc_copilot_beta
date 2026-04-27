import { describe, expect, it } from 'vitest';
import fixture from '../../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { scanStation } from '../../src/generators/helpers.js';
import { buildSymbolTable } from '../../src/compiler/symbols/resolver.js';
import {
  buildTimerVarDecls,
  lowerTimerBlock,
} from '../../src/compiler/lowering/timers.js';
import type { Diagnostic } from '../../src/compiler/diagnostics.js';
import { renderStmt } from '../../src/compiler/renderers/scl.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

function loadContext(stationId: 'st_load' | 'st_weld' = 'st_load') {
  const p = clone();
  const machine = p.machines[0]!;
  const station = machine.stations.find((s) => s.id === stationId)!;
  const stateIndex = new Map<string, number>();
  station.sequence.states.forEach((s, i) => stateIndex.set(s.id, i));
  const scan = scanStation(machine, station, stateIndex, 'x.scl');
  const { table } = buildSymbolTable(machine, station);
  return { plan: scan.plan!, table, stationId };
}

describe('timers — VAR declarations', () => {
  it('emits one TON decl per transition timeout', () => {
    const { plan } = loadContext();
    const decls = buildTimerVarDecls(plan);
    expect(decls).toHaveLength(2);
    expect(decls.map((d) => d.name).sort()).toEqual([
      'TON_t_extended',
      'TON_t_retracted',
    ]);
    for (const d of decls) expect(d.type).toBe('TON');
  });

  it('includes alarm id + duration in the inline comment', () => {
    const { plan } = loadContext();
    const decls = buildTimerVarDecls(plan);
    const ext = decls.find((d) => d.name === 'TON_t_extended')!;
    expect(ext.comment).toContain('al_cyl_ext_timeout');
    expect(ext.comment).toContain('5000 ms');
  });

  it('emits no declarations when the station has no timeouts', () => {
    const { plan } = loadContext('st_weld');
    expect(buildTimerVarDecls(plan)).toHaveLength(0);
  });
});

describe('timers — body block', () => {
  it('emits TON call with paren-wrapped state equality and T#<ms>MS', () => {
    const { plan, table, stationId } = loadContext();
    const diagnostics: Diagnostic[] = [];
    const stmts = lowerTimerBlock(plan, table, diagnostics, stationId, 'x.scl');

    const lines = stmts.flatMap((s) => renderStmt(s, 1)).join('\n');
    expect(lines).toMatch(
      /#TON_t_extended\(IN := \(#state = 1\), PT := T#5000MS\);/,
    );
    expect(lines).toMatch(
      /#TON_t_retracted\(IN := \(#state = 3\), PT := T#5000MS\);/,
    );
  });

  it('emits IF TON.Q THEN <alarm> := TRUE; END_IF; block', () => {
    const { plan, table, stationId } = loadContext();
    const diagnostics: Diagnostic[] = [];
    const stmts = lowerTimerBlock(plan, table, diagnostics, stationId, 'x.scl');

    const lines = stmts.flatMap((s) => renderStmt(s, 1)).join('\n');
    expect(lines).toContain('IF #TON_t_extended.Q THEN');
    // Under DB_Alarms v2, station FBs write the set_ bit; FB_Alarms latches it.
    expect(lines).toContain('"DB_Alarms".set_al_cyl_ext_timeout := TRUE;');
    expect(lines).toContain('END_IF;');
  });

  it('emits TON.Q via InstanceField IR (no Raw fallback)', () => {
    // Walk the produced StmtIR and assert no `Raw` text contains '#TON_'.
    const { plan, table, stationId } = loadContext();
    const diagnostics: import('../../src/compiler/diagnostics.js').Diagnostic[] = [];
    const stmts = lowerTimerBlock(plan, table, diagnostics, stationId, 'x.scl');
    let foundInstanceField = false;
    let foundRawTimerQ = false;
    const visitExpr = (e: unknown): void => {
      if (!e || typeof e !== 'object') return;
      const node = e as { kind?: string; text?: string; instance?: unknown; fieldName?: string; inner?: unknown; left?: unknown; right?: unknown; operand?: unknown };
      if (node.kind === 'InstanceField' && node.fieldName === 'Q') foundInstanceField = true;
      if (node.kind === 'Raw' && /#TON_/.test(node.text ?? '')) foundRawTimerQ = true;
      if (node.inner) visitExpr(node.inner);
      if (node.left) visitExpr(node.left);
      if (node.right) visitExpr(node.right);
      if (node.operand) visitExpr(node.operand);
    };
    const visit = (s: unknown): void => {
      if (!s || typeof s !== 'object') return;
      const stmt = s as Record<string, unknown>;
      if ('cond' in stmt) visitExpr(stmt.cond);
      if ('expr' in stmt) visitExpr(stmt.expr);
      const then_ = stmt.then;
      if (Array.isArray(then_)) for (const t of then_) visit(t);
    };
    for (const s of stmts) visit(s);
    expect(foundInstanceField).toBe(true);
    expect(foundRawTimerQ).toBe(false);
  });

  it('emits an info diagnostic per timeout (no auto-transition)', () => {
    const { plan, table, stationId } = loadContext();
    const diagnostics: Diagnostic[] = [];
    lowerTimerBlock(plan, table, diagnostics, stationId, 'x.scl');

    const infos = diagnostics.filter((d) => d.severity === 'info');
    expect(infos.every((d) => d.code === 'TIMEOUT_NO_AUTO_TRANSITION')).toBe(true);
    expect(infos).toHaveLength(2);
    expect(infos.some((d) => d.message.includes('t_extended'))).toBe(true);
    expect(infos.some((d) => d.message.includes('t_retracted'))).toBe(true);
  });

  it('does not emit when the plan has no timers', () => {
    const { plan, table } = loadContext('st_weld');
    const diagnostics: Diagnostic[] = [];
    const stmts = lowerTimerBlock(plan, table, diagnostics);
    expect(stmts).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });
});
