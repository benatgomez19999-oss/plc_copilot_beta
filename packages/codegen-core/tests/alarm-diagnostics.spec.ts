import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  CodegenError,
  alarmPath,
  alarmWhenPath,
  collectAlarmDiagnostics,
  compileProject,
  dedupDiagnostics,
  hasErrors,
  machineAlarmsPath,
  serializeCompilerError,
} from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// =============================================================================
// Sprint 44 — alarm path helpers (added in sprint 43, exercised here for
// regression).
// =============================================================================

describe('alarm path helpers', () => {
  it('build canonical bracket-indexed strings', () => {
    expect(machineAlarmsPath(0)).toBe('machines[0].alarms');
    expect(alarmPath(0, 2)).toBe('machines[0].alarms[2]');
    expect(alarmWhenPath(0, 2)).toBe('machines[0].alarms[2].when');
  });
});

// =============================================================================
// Sprint 44 — collectAlarmDiagnostics
// =============================================================================

describe('collectAlarmDiagnostics — empty / valid cases', () => {
  it('returns [] when machine has no alarms', () => {
    const p = clone();
    p.machines[0]!.alarms = [];
    const out = collectAlarmDiagnostics(p.machines[0]!);
    expect(out).toEqual([]);
  });

  it('returns [] when alarms have no when expression', () => {
    const p = clone();
    p.machines[0]!.alarms.forEach((a) => {
      delete (a as { when?: string }).when;
    });
    const out = collectAlarmDiagnostics(p.machines[0]!);
    expect(out).toEqual([]);
  });

  it('skips silently when machine has zero stations (no env to seed)', () => {
    const p = clone();
    p.machines[0]!.stations = [];
    p.machines[0]!.alarms[0]!.when = 'unknown_func(1)';
    const out = collectAlarmDiagnostics(p.machines[0]!);
    expect(out).toEqual([]);
  });

  it('emits no error diagnostics for a syntactically valid alarm.when', () => {
    const p = clone();
    // The weldline fixture has IO `io_part_sensor` that resolves to bool.
    p.machines[0]!.alarms[0]!.when = 'io_part_sensor';
    const out = collectAlarmDiagnostics(p.machines[0]!);
    expect(hasErrors(out)).toBe(false);
  });
});

describe('collectAlarmDiagnostics — error cases carry alarm.when JSON path', () => {
  it('UNKNOWN_FUNCTION surfaces machines[0].alarms[<i>].when + symbol + hint', () => {
    const p = clone();
    p.machines[0]!.alarms[0]!.when = 'unknown_func(1)';
    const out = collectAlarmDiagnostics(p.machines[0]!);
    const err = out.find((d) => d.code === 'UNKNOWN_FUNCTION');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('error');
    expect(err!.path).toBe(alarmWhenPath(0, 0));
    expect(err!.symbol).toBe(p.machines[0]!.alarms[0]!.id);
    expect(err!.hint).toMatch(/alarm condition/);
    // Alarms are machine-level; we never invent a stationId.
    expect(err!.stationId).toBeUndefined();
  });

  it('ARITY_MISMATCH on rising() with no args carries alarm.when path', () => {
    const p = clone();
    p.machines[0]!.alarms[0]!.when = 'rising()';
    const out = collectAlarmDiagnostics(p.machines[0]!);
    const err = out.find((d) => d.code === 'ARITY_MISMATCH');
    expect(err).toBeDefined();
    expect(err!.path).toBe(alarmWhenPath(0, 0));
    expect(err!.symbol).toBe(p.machines[0]!.alarms[0]!.id);
  });

  it('emits one diagnostic per offending alarm in machine.alarms order', () => {
    const p = clone();
    // Need at least two alarms in the fixture.
    if (p.machines[0]!.alarms.length < 2) {
      throw new Error('weldline fixture must declare ≥2 alarms');
    }
    p.machines[0]!.alarms[0]!.when = 'unknown_func(1)';
    p.machines[0]!.alarms[1]!.when = 'unknown_other(2)';
    const out = collectAlarmDiagnostics(p.machines[0]!);
    const unknownFn = out.filter((d) => d.code === 'UNKNOWN_FUNCTION');
    expect(unknownFn.length).toBeGreaterThanOrEqual(2);
    // Each carries its own alarm index.
    expect(unknownFn.map((d) => d.path)).toContain(alarmWhenPath(0, 0));
    expect(unknownFn.map((d) => d.path)).toContain(alarmWhenPath(0, 1));
  });
});

describe('collectAlarmDiagnostics — dedup compatibility', () => {
  it('dedupDiagnostics collapses repeated alarm diagnostics by stable key', () => {
    const p = clone();
    p.machines[0]!.alarms[0]!.when = 'unknown_func(1)';
    const out = collectAlarmDiagnostics(p.machines[0]!);
    const doubled = dedupDiagnostics([...out, ...out]);
    expect(doubled.length).toBe(out.length);
  });
});

// =============================================================================
// Sprint 44 — compileProject integration: non-strict vs strictDiagnostics
// =============================================================================

describe('compileProject — alarm.when integration', () => {
  it('non-strict includes alarm diagnostic in manifest.compilerDiagnostics, no throw', () => {
    const p = clone();
    p.machines[0]!.alarms[0]!.when = 'unknown_func(1)';
    const program = compileProject(p);
    const alarmDiag = program.manifest.compilerDiagnostics.find(
      (d) =>
        d.code === 'UNKNOWN_FUNCTION' &&
        d.path === alarmWhenPath(0, 0),
    );
    expect(alarmDiag).toBeDefined();
    expect(alarmDiag!.symbol).toBe(p.machines[0]!.alarms[0]!.id);
    expect(alarmDiag!.hint).toMatch(/alarm condition/);
  });

  it('strictDiagnostics promotes the first alarm error into a thrown CodegenError', () => {
    const p = clone();
    p.machines[0]!.alarms[0]!.when = 'unknown_func(1)';
    try {
      compileProject(p, { features: { strictDiagnostics: true } });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('UNKNOWN_FUNCTION');
      expect(err.path).toBe(alarmWhenPath(0, 0));
      expect(err.symbol).toBe(p.machines[0]!.alarms[0]!.id);
      const s = serializeCompilerError(err);
      expect(s.path).toBe(alarmWhenPath(0, 0));
      expect(s.stack).toBeUndefined();
    }
  });

  it('does not introduce alarm diagnostics for a clean weldline fixture', () => {
    const program = compileProject(clone());
    const alarmErrors = program.manifest.compilerDiagnostics.filter(
      (d) =>
        d.severity === 'error' &&
        typeof d.path === 'string' &&
        d.path.startsWith('machines[0].alarms['),
    );
    expect(alarmErrors).toEqual([]);
  });
});
