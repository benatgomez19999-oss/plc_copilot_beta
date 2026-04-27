import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  CodegenError,
  alarmPath,
  alarmWhenPath,
  applyExpressionContext,
  compileProject,
  diag,
  interlockWhenPath,
  machineAlarmsPath,
  serializeCompilerError,
  transitionGuardPath,
} from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// =============================================================================
// Sprint 43 — alarm path helpers (added alongside transition / interlock
// helpers from sprints 41/42).
// =============================================================================

describe('alarm path helpers — sprint 43', () => {
  it('alarmPath / alarmWhenPath / machineAlarmsPath build canonical strings', () => {
    expect(machineAlarmsPath(0)).toBe('machines[0].alarms');
    expect(alarmPath(0, 2)).toBe('machines[0].alarms[2]');
    expect(alarmWhenPath(0, 2)).toBe('machines[0].alarms[2].when');
  });

  it('transitionGuardPath / interlockWhenPath remain stable (sprint 41/42)', () => {
    expect(transitionGuardPath(0, 1, 3)).toBe(
      'machines[0].stations[1].sequence.transitions[3].guard',
    );
    expect(interlockWhenPath(0, 1)).toBe('machines[0].interlocks[1].when');
  });
});

// =============================================================================
// Sprint 43 — applyExpressionContext fills MISSING fields only.
// =============================================================================

describe('applyExpressionContext', () => {
  it('fills only the missing fields, never overwrites diagnostic-owned metadata', () => {
    const own = diag('error', 'INVALID_REF', 'broken', {
      path: 'own.path',
      symbol: 'own.symbol',
    });
    const out = applyExpressionContext([own], {
      path: 'ctx.path',
      stationId: 'st_load',
      symbol: 'ctx.symbol',
      hint: 'ctx hint',
    });
    expect(out).toHaveLength(1);
    // own.path / own.symbol survived.
    expect(out[0]!.path).toBe('own.path');
    expect(out[0]!.symbol).toBe('own.symbol');
    // stationId / hint were absent on the diagnostic, so the
    // context filled them.
    expect(out[0]!.stationId).toBe('st_load');
    expect(out[0]!.hint).toBe('ctx hint');
  });

  it('returns a copy when context is undefined (no mutation, no field changes)', () => {
    const own = diag('warning', 'UNKNOWN_REF', 'maybe', { symbol: 'foo' });
    const out = applyExpressionContext([own], undefined);
    expect(out).toEqual([own]);
    expect(out).not.toBe(own); // copy semantics — caller can mutate freely
  });

  it('returns the SAME diagnostic reference when the context cannot fill any gap', () => {
    const own = diag('error', 'INTERNAL_ERROR', 'msg', {
      path: 'p',
      stationId: 's',
      symbol: 'sy',
      hint: 'h',
    });
    const out = applyExpressionContext([own], {
      path: 'ctx',
      stationId: 'ctx',
      symbol: 'ctx',
      hint: 'ctx',
    });
    // No gap → return the original ref to avoid pointless allocation.
    expect(out[0]).toBe(own);
  });
});

// =============================================================================
// Sprint 43 — transition.guard expression errors carry transitionGuardPath.
// =============================================================================

describe('transition.guard — expression diagnostics carry guard JSON path', () => {
  it('UNKNOWN_FN in guard surfaces .sequence.transitions[<ti>].guard', () => {
    const p = clone();
    // weldline doesn't declare a guard naturally — inject one on the
    // first transition that has a known source state so the guard
    // expression is reachable.
    const stationIndex = 0;
    const station = p.machines[0]!.stations[stationIndex]!;
    const transitionIndex = station.sequence.transitions.findIndex(
      (t) => t.from !== '*',
    );
    expect(transitionIndex).toBeGreaterThanOrEqual(0);
    station.sequence.transitions[transitionIndex]!.guard =
      'unknown_func(123)';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      // The expression checker emits UNKNOWN_FUNCTION for unknown
      // functions; the adapter promotes it to CodegenError.
      expect(err.code).toBe('UNKNOWN_FUNCTION');
      expect(err.path).toBe(
        transitionGuardPath(0, stationIndex, transitionIndex),
      );
      expect(err.stationId).toBe(
        p.machines[0]!.stations[stationIndex]!.id,
      );
      // The guard's owner (transition.id) carries through as `symbol`.
      expect(err.symbol).toBe(
        p.machines[0]!.stations[stationIndex]!.sequence.transitions[
          transitionIndex
        ]!.id,
      );
      expect(err.hint).toMatch(/transition guard/);
      // Serializer + formatter preserve the path as a navigable JSON path.
      const s = serializeCompilerError(err);
      expect(s.path).toBe(
        transitionGuardPath(0, stationIndex, transitionIndex),
      );
    }
  });
});

// =============================================================================
// Sprint 43 — interlock.when expression errors carry interlockWhenPath.
// =============================================================================

describe('interlock.when — expression diagnostics carry when JSON path', () => {
  it('UNKNOWN_FN in interlock.when surfaces machines[0].interlocks[<i>].when', () => {
    const p = clone();
    const m = p.machines[0]!;
    if (m.interlocks.length === 0) {
      throw new Error('weldline fixture must declare at least one interlock');
    }
    const interlockIndex = 0;
    m.interlocks[interlockIndex]!.when = 'unknown_func(1)';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('UNKNOWN_FUNCTION');
      expect(err.path).toBe(interlockWhenPath(0, interlockIndex));
      // Station scope = the station that consumes this interlock.
      expect(err.stationId).toBeDefined();
      expect(err.symbol).toBe(m.interlocks[interlockIndex]!.id);
      expect(err.hint).toMatch(/interlock condition/);
    }
  });
});
