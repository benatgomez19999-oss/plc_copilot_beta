import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  CodegenError,
  codegenErrorFromDiagnostic,
  compileProject,
  diag,
  equipmentPath,
  equipmentTypePath,
  formatSerializedCompilerError,
  interlockPath,
  ioPath,
  machinePath,
  parameterPath,
  recipePath,
  recipeValuePath,
  serializeCompilerError,
  stationPath,
  transitionPath,
} from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// =============================================================================
// Sprint 40 — diagnostic-paths helpers
// =============================================================================

describe('diagnostic-paths helpers', () => {
  it('builds bracket-indexed paths in the canonical PIR style', () => {
    expect(machinePath()).toBe('machines[0]');
    expect(machinePath(2)).toBe('machines[2]');
    expect(stationPath(0, 1)).toBe('machines[0].stations[1]');
    expect(equipmentPath(0, 1, 2)).toBe(
      'machines[0].stations[1].equipment[2]',
    );
    expect(equipmentTypePath(0, 1, 2)).toBe(
      'machines[0].stations[1].equipment[2].type',
    );
    expect(transitionPath(0, 1, 3)).toBe(
      'machines[0].stations[1].sequence.transitions[3]',
    );
    expect(interlockPath(0, 5)).toBe('machines[0].interlocks[5]');
    expect(parameterPath(0, 4)).toBe('machines[0].parameters[4]');
    expect(recipePath(0, 7)).toBe('machines[0].recipes[7]');
    expect(ioPath(0, 9)).toBe('machines[0].io[9]');
  });

  it('encodes recipe value param ids without quoting (PIR ids are identifier-safe)', () => {
    expect(recipeValuePath(0, 0, 'p_weld_time')).toBe(
      'machines[0].recipes[0].values.p_weld_time',
    );
    expect(recipeValuePath(0, 0, 'p_x')).toBe(
      'machines[0].recipes[0].values.p_x',
    );
  });
});

// =============================================================================
// Sprint 40 — codegenErrorFromDiagnostic preserves every metadata field
// =============================================================================

describe('codegenErrorFromDiagnostic', () => {
  it('preserves code + message + path + stationId + symbol + hint', () => {
    const d = diag('error', 'UNKNOWN_IO', 'IO not declared', {
      path: 'machines[0].stations[0]',
      stationId: 'st_load',
      symbol: 'io_ghost',
      hint: 'Add io_ghost to machine.io.',
    });
    const e = codegenErrorFromDiagnostic(d);
    expect(e).toBeInstanceOf(CodegenError);
    expect(e.code).toBe('UNKNOWN_IO');
    expect(e.message).toBe('IO not declared');
    expect(e.path).toBe('machines[0].stations[0]');
    expect(e.stationId).toBe('st_load');
    expect(e.symbol).toBe('io_ghost');
    expect(e.hint).toBe('Add io_ghost to machine.io.');
  });

  it('omits unset fields cleanly (no `undefined` keys leak)', () => {
    const d = diag('error', 'NO_MACHINE', 'no machine');
    const e = codegenErrorFromDiagnostic(d);
    expect(e.path).toBeUndefined();
    expect(e.stationId).toBeUndefined();
    expect(e.symbol).toBeUndefined();
    expect(e.hint).toBeUndefined();
  });
});

// =============================================================================
// Sprint 40 — first-class throws in compile-project carry full metadata
// =============================================================================

describe('compileProject — NO_MACHINE (sprint 40)', () => {
  it('throws CodegenError with path + hint when project has no machine', () => {
    const p = clone();
    (p as { machines: unknown[] }).machines = [];
    expect(() => compileProject(p)).toThrow(CodegenError);
    try {
      compileProject(p);
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('NO_MACHINE');
      expect(err.path).toBe('machines');
      expect(err.hint).toContain('Add one machine');
      const s = serializeCompilerError(err);
      expect(s.code).toBe('NO_MACHINE');
      expect(s.path).toBe('machines');
      expect(s.hint).toContain('Add one machine');
      expect(s.stack).toBeUndefined();
      const formatted = formatSerializedCompilerError(s);
      expect(formatted).toContain('[NO_MACHINE]');
      expect(formatted).toContain('(path: machines)');
      expect(formatted).toContain('Hint: Add one machine');
    }
  });
});

describe('compileProject — UNSUPPORTED_EQUIPMENT (sprint 40)', () => {
  function projectWithUnsupportedEquipment(): Project {
    const p = clone();
    // Pick the first equipment of the first station; flip its type.
    (p.machines[0]!.stations[0]!.equipment[0]!.type as string) =
      'valve_onoff_unsupported';
    return p;
  }

  it('throws CodegenError carrying stationId + symbol + path + hint', () => {
    const p = projectWithUnsupportedEquipment();
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('UNSUPPORTED_EQUIPMENT');
      // Surface the offending equipment id as `symbol`.
      expect(err.symbol).toBe(p.machines[0]!.stations[0]!.equipment[0]!.id);
      // Station scope picks the right station id from the fixture.
      expect(err.stationId).toBe(p.machines[0]!.stations[0]!.id);
      // Path points at the `.type` field (machines[0].stations[0].equipment[0].type).
      expect(err.path).toBe('machines[0].stations[0].equipment[0].type');
      // Hint enumerates supported types so the user can fix locally.
      expect(err.hint).toMatch(/pneumatic_cylinder_2pos/);
      expect(err.hint).toMatch(/motor_simple/);
    }
  });

  it('formatSerializedCompilerError surfaces every metadata field on a single line', () => {
    const p = projectWithUnsupportedEquipment();
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const out = formatSerializedCompilerError(serializeCompilerError(e));
      expect(out.split('\n')).toHaveLength(1);
      expect(out).toContain('[UNSUPPORTED_EQUIPMENT]');
      expect(out).toContain(
        '(path: machines[0].stations[0].equipment[0].type',
      );
      expect(out).toContain('station: ');
      expect(out).toContain('symbol: ');
      expect(out).toContain('Hint: ');
      // No stack trace by default.
      expect(out).not.toMatch(/\bat \w/);
    }
  });
});

// =============================================================================
// Sprint 40 — diagnostic adapter carries lowering metadata to throw site
// =============================================================================

describe('compileProject — diagnostic adapter preserves metadata', () => {
  it('rethrows lowering diagnostics with stationId + symbol intact', () => {
    // Break a station so lowering produces an error diagnostic. We point a
    // station equipment's signal_in role at a non-existent IO so the
    // resolver emits UNKNOWN_IO with structured metadata.
    const p = clone();
    const eq = p.machines[0]!.stations[0]!.equipment[0]!;
    eq.io_bindings = { ...eq.io_bindings, signal_in: 'io_does_not_exist' };
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      // The lowering pipeline attached station scope; the adapter
      // must have preserved it through the rethrow.
      expect(err.stationId).toBeDefined();
      // And the symbol (the offending IO id or equipment role).
      expect(err.symbol).toBeDefined();
    }
  });
});
