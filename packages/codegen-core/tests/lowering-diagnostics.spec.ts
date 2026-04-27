import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  CodegenError,
  codegenErrorFromDiagnostic,
  compileProject,
  equipmentIoBindingPath,
  formatSerializedCompilerError,
  interlockInhibitsPath,
  interlockWhenPath,
  serializeCompilerError,
  stateActivityActivatePath,
  statePath,
  statesPath,
  transitionFromPath,
  transitionGuardPath,
  transitionTimeoutPath,
  transitionToPath,
} from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// =============================================================================
// Sprint 41 — new path helpers
// =============================================================================

describe('diagnostic-paths — sprint 41 helpers', () => {
  it('builds state / sequence / transition paths', () => {
    expect(statesPath(0, 1)).toBe(
      'machines[0].stations[1].sequence.states',
    );
    expect(statePath(0, 1, 2)).toBe(
      'machines[0].stations[1].sequence.states[2]',
    );
    expect(stateActivityActivatePath(0, 1, 2, 0)).toBe(
      'machines[0].stations[1].sequence.states[2].activity.activate[0]',
    );
    expect(transitionFromPath(0, 1, 3)).toBe(
      'machines[0].stations[1].sequence.transitions[3].from',
    );
    expect(transitionToPath(0, 1, 3)).toBe(
      'machines[0].stations[1].sequence.transitions[3].to',
    );
    expect(transitionGuardPath(0, 1, 3)).toBe(
      'machines[0].stations[1].sequence.transitions[3].guard',
    );
    expect(transitionTimeoutPath(0, 1, 3)).toBe(
      'machines[0].stations[1].sequence.transitions[3].timeout',
    );
  });

  it('builds interlock paths', () => {
    expect(interlockInhibitsPath(0, 4)).toBe(
      'machines[0].interlocks[4].inhibits',
    );
    expect(interlockWhenPath(0, 4)).toBe(
      'machines[0].interlocks[4].when',
    );
  });

  it('builds equipment.io_bindings.<role> with arbitrary role names (incl. underscores)', () => {
    expect(equipmentIoBindingPath(0, 1, 2, 'extend_cmd')).toBe(
      'machines[0].stations[1].equipment[2].io_bindings.extend_cmd',
    );
    expect(equipmentIoBindingPath(0, 0, 0, 'signal_in')).toBe(
      'machines[0].stations[0].equipment[0].io_bindings.signal_in',
    );
  });
});

// =============================================================================
// Sprint 41 — lowering diagnostic metadata flows through to thrown CodegenError
// =============================================================================

describe('lowering — UNSUPPORTED_ACTIVITY metadata reaches CodegenError', () => {
  it('throws with stationId + symbol + hint when an unknown activity is referenced', () => {
    const p = clone();
    // Add a state whose activate references a bogus activity on an
    // existing equipment.
    const station = p.machines[0]!.stations[0]!;
    const eqId = station.equipment[0]!.id;
    station.sequence.states[0]!.activity = {
      activate: [`${eqId}.bogus_activity`],
    };
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('UNSUPPORTED_ACTIVITY');
      expect(err.stationId).toBe(station.id);
      expect(err.symbol).toBe(`${eqId}.bogus_activity`);
      expect(err.hint).toMatch(/allowed activities|extend SUPPORTED_ACTIVITIES/);
      const formatted = formatSerializedCompilerError(
        serializeCompilerError(err),
      );
      expect(formatted).toContain('[UNSUPPORTED_ACTIVITY]');
      expect(formatted).toContain('Hint: ');
    }
  });
});

describe('lowering — INTERLOCK_ROLE_UNRESOLVED metadata', () => {
  it('emits the inhibits JSON path + station + symbol + hint when invalid', () => {
    const p = clone();
    // Replace the first interlock's inhibits with a malformed string.
    const m = p.machines[0]!;
    if (m.interlocks.length === 0) {
      // Fixture should have at least one; bail with a meaningful test
      // failure rather than a silent skip.
      throw new Error('weldline fixture must declare at least one interlock');
    }
    m.interlocks[0]!.inhibits = 'not_a_dotted_ref';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('INTERLOCK_ROLE_UNRESOLVED');
      expect(err.path).toBe(interlockInhibitsPath(0, 0));
      expect(err.stationId).toBeDefined();
      expect(err.symbol).toBe(m.interlocks[0]!.id);
      expect(err.hint).toBeDefined();
      expect(err.hint).toContain('equipmentId.activity');
    }
  });
});

describe('lowering — TIMEOUT_RENDER_ERROR metadata', () => {
  it('emits stationId + symbol + actionable hint for non-positive timeout', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    const t = station.sequence.transitions.find((tr) => tr.timeout);
    if (!t) {
      throw new Error('weldline fixture must declare at least one timeout');
    }
    t.timeout!.ms = 0;
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('TIMEOUT_RENDER_ERROR');
      expect(err.stationId).toBe(station.id);
      expect(err.symbol).toBe(t.id);
      expect(err.hint).toMatch(/positive integer/);
    }
  });
});

describe('lowering — EMPTY_STATION metadata', () => {
  it('carries stationId + symbol + hint when sequence.states is empty', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.states = [];
    p.machines[0]!.stations[0]!.sequence.transitions = [];
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('EMPTY_STATION');
      expect(err.stationId).toBe(p.machines[0]!.stations[0]!.id);
      expect(err.symbol).toBe(p.machines[0]!.stations[0]!.id);
      expect(err.hint).toMatch(/Add at least one state/);
    }
  });
});

describe('lowering — UNKNOWN_STATE metadata', () => {
  it('carries stationId + symbol + hint for transitions to missing states', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    if (station.sequence.transitions.length === 0) {
      throw new Error('fixture must declare at least one transition');
    }
    station.sequence.transitions[0]!.to = 'state_does_not_exist';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('UNKNOWN_STATE');
      expect(err.stationId).toBe(station.id);
      expect(err.symbol).toBe('state_does_not_exist');
      expect(err.hint).toMatch(/Add the target state|change transition\.to/);
    }
  });
});

// =============================================================================
// Sprint 41 — info diagnostics keep their severity AND get hints
// =============================================================================

describe('lowering — TIMEOUT_NO_AUTO_TRANSITION info preserves severity + adds hint', () => {
  it('weldline emits the info with stationId + symbol + hint, never throws', () => {
    const result = compileProject(clone());
    const infos = result.manifest.compilerDiagnostics.filter(
      (d) => d.code === 'TIMEOUT_NO_AUTO_TRANSITION',
    );
    expect(infos.length).toBeGreaterThan(0);
    for (const i of infos) {
      expect(i.severity).toBe('info');
      expect(typeof i.stationId).toBe('string');
      expect(typeof i.symbol).toBe('string');
      expect(typeof i.hint).toBe('string');
      expect(i.hint).toMatch(/timeout raises the alarm|fault state/);
    }
  });
});

// =============================================================================
// Sprint 41 — adapter still preserves all metadata for any new emitter
// =============================================================================

describe('codegenErrorFromDiagnostic — preserves enriched lowering diagnostics', () => {
  it('round-trips a lowering Diagnostic with every metadata field set', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    const eqId = station.equipment[0]!.id;
    station.sequence.states[0]!.activity = {
      activate: [`${eqId}.bogus_activity`],
    };
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as CodegenError;
      const s = serializeCompilerError(err);
      expect(s.code).toBe('UNSUPPORTED_ACTIVITY');
      expect(s.stationId).toBe(station.id);
      expect(s.symbol).toBe(`${eqId}.bogus_activity`);
      expect(s.hint).toBeDefined();
      // The adapter helper accepts the same Diagnostic shape and
      // produces a CodegenError with the same fields.
      const fromAdapter = codegenErrorFromDiagnostic({
        code: 'UNSUPPORTED_ACTIVITY',
        severity: 'error',
        message: err.message,
        stationId: err.stationId,
        symbol: err.symbol,
        hint: err.hint,
      });
      expect(fromAdapter.stationId).toBe(err.stationId);
      expect(fromAdapter.symbol).toBe(err.symbol);
      expect(fromAdapter.hint).toBe(err.hint);
    }
  });
});
