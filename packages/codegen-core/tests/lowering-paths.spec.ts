import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  CodegenError,
  compileProject,
  equipmentIoBindingPath,
  interlockInhibitsPath,
  serializeCompilerError,
  statesPath,
  transitionFromPath,
  transitionTimeoutMsPath,
  transitionTimeoutPath,
  transitionToPath,
} from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// =============================================================================
// Sprint 42 — every emitter that has a real PIR coordinate must surface a
// JSON path instead of the FB-name placeholder.
// =============================================================================

describe('lowering paths — sprint 42', () => {
  it('EMPTY_STATION points at machines[0].stations[<si>].sequence.states', () => {
    const p = clone();
    const stationIndex = 0;
    const station = p.machines[0]!.stations[stationIndex]!;
    station.sequence.states = [];
    station.sequence.transitions = [];
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodegenError);
      const err = e as CodegenError;
      expect(err.code).toBe('EMPTY_STATION');
      expect(err.path).toBe(statesPath(0, stationIndex));
    }
  });

  it('NO_INITIAL_STATE points at the same statesPath', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    for (const s of station.sequence.states) s.kind = 'normal';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as CodegenError).code).toBe('NO_INITIAL_STATE');
      expect((e as CodegenError).path).toBe(statesPath(0, 0));
    }
  });

  it('UNKNOWN_STATE points at machines[0].stations[<si>].sequence.transitions[<ti>].to', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    if (station.sequence.transitions.length === 0) {
      throw new Error('weldline must have at least one transition');
    }
    // Pick the first transition with a non-wildcard target so the
    // generated path is deterministic.
    const ti = station.sequence.transitions.findIndex(
      (t) => t.from !== '*',
    );
    expect(ti).toBeGreaterThanOrEqual(0);
    station.sequence.transitions[ti]!.to = 'state_does_not_exist';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as CodegenError;
      expect(err.code).toBe('UNKNOWN_STATE');
      expect(err.path).toBe(transitionToPath(0, 0, ti));
    }
  });

  it('TIMEOUT_RENDER_ERROR (ms <= 0) points at transitions[<ti>].timeout.ms', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    const ti = station.sequence.transitions.findIndex((t) => t.timeout);
    if (ti < 0) {
      throw new Error('weldline must declare at least one timeout');
    }
    station.sequence.transitions[ti]!.timeout!.ms = 0;
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as CodegenError;
      expect(err.code).toBe('TIMEOUT_RENDER_ERROR');
      expect(err.path).toBe(transitionTimeoutMsPath(0, 0, ti));
    }
  });

  it('TIMEOUT_RENDER_ERROR (unknown source state) points at transitions[<ti>].from', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    const ti = station.sequence.transitions.findIndex(
      (t) => t.timeout && t.from !== '*',
    );
    if (ti < 0) {
      throw new Error(
        'weldline must declare at least one non-wildcard timeout',
      );
    }
    station.sequence.transitions[ti]!.from = 'state_does_not_exist';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as CodegenError;
      expect(err.code).toBe('TIMEOUT_RENDER_ERROR');
      expect(err.path).toBe(transitionFromPath(0, 0, ti));
    }
  });

  it('TIMEOUT_NO_AUTO_TRANSITION info carries transitions[<ti>].timeout', () => {
    const result = compileProject(clone());
    const infos = result.manifest.compilerDiagnostics.filter(
      (d) => d.code === 'TIMEOUT_NO_AUTO_TRANSITION',
    );
    expect(infos.length).toBeGreaterThan(0);
    for (const i of infos) {
      expect(i.severity).toBe('info');
      // The path always ends in `.timeout` and carries the
      // station + transition index.
      expect(i.path).toMatch(
        /^machines\[0\]\.stations\[\d+\]\.sequence\.transitions\[\d+\]\.timeout$/,
      );
    }
  });

  it('UNSUPPORTED_ACTIVITY (state activate) points at states[i].activity.activate[j]', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    const eqId = station.equipment[0]!.id;
    // Use the FIRST state's activate (or create one) so the index
    // is deterministic.
    station.sequence.states[0]!.activity = {
      activate: [`${eqId}.bogus_activity`],
    };
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as CodegenError;
      expect(err.code).toBe('UNSUPPORTED_ACTIVITY');
      expect(err.path).toBe(
        'machines[0].stations[0].sequence.states[0].activity.activate[0]',
      );
    }
  });

  it('UNBOUND_ROLE (cylinder) points at equipment[<ei>].io_bindings.solenoid_out', () => {
    const p = clone();
    const station = p.machines[0]!.stations[0]!;
    // Find a pneumatic_cylinder_2pos to break.
    const ei = station.equipment.findIndex(
      (e) => e.type === 'pneumatic_cylinder_2pos',
    );
    if (ei < 0) {
      throw new Error('fixture must declare a pneumatic_cylinder_2pos');
    }
    // Drop the binding without changing the equipment type, so we
    // hit the wireCylinder2Pos UNBOUND_ROLE path specifically.
    delete (station.equipment[ei]!.io_bindings as Record<string, string>)
      .solenoid_out;
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as CodegenError;
      expect(err.code).toBe('UNBOUND_ROLE');
      expect(err.path).toBe(
        equipmentIoBindingPath(0, 0, ei, 'solenoid_out'),
      );
      expect(err.symbol).toBe(`${station.equipment[ei]!.id}.solenoid_out`);
    }
  });

  it('INTERLOCK_ROLE_UNRESOLVED keeps machines[<m>].interlocks[<i>].inhibits (sprint 41 regression)', () => {
    const p = clone();
    const m = p.machines[0]!;
    if (m.interlocks.length === 0) {
      throw new Error('fixture must declare at least one interlock');
    }
    m.interlocks[0]!.inhibits = 'not_a_dotted_ref';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as CodegenError;
      expect(err.code).toBe('INTERLOCK_ROLE_UNRESOLVED');
      expect(err.path).toBe(interlockInhibitsPath(0, 0));
    }
  });

  it('serializeCompilerError preserves the new JSON paths', () => {
    const p = clone();
    p.machines[0]!.stations[0]!.sequence.transitions[0]!.to =
      'state_does_not_exist';
    try {
      compileProject(p);
      throw new Error('expected throw');
    } catch (e) {
      const s = serializeCompilerError(e);
      expect(s.code).toBe('UNKNOWN_STATE');
      expect(s.path).toBe(transitionToPath(0, 0, 0));
      expect(s.stack).toBeUndefined();
    }
  });
});
