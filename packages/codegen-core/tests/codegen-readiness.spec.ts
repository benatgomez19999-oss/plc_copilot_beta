// Sprint 86 — codegen readiness preflight tests.
//
// Pure / total: every test runs without I/O and never mutates the
// input project. Asserts:
//   - happy path produces zero diagnostics + hasBlockingErrors=false
//   - empty PIR produces READINESS_PIR_EMPTY error
//   - unsupported equipment for target produces error
//   - duplicate IO addresses surface a deterministic warning
//   - duplicate equipment ids / generated symbols surface warnings
//   - placeholder sequence surfaces an info diagnostic
//   - capability narrowing per target works
//   - sortDiagnostics + dedupDiagnostics are honoured (deterministic order)
//   - preflightProject is pure (input deep-equal before/after)
//   - runTargetPreflight throws READINESS_FAILED on blocking errors

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import {
  CodegenError,
  getTargetCapabilities,
  preflightProject,
  runTargetPreflight,
  type CodegenTarget,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Tiny PIR fixtures
// ---------------------------------------------------------------------------

function happyProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'p_x',
    name: 'x',
    machines: [
      {
        id: 'm_x',
        name: 'm',
        stations: [
          {
            id: 'st_a',
            name: 'A',
            equipment: [
              {
                id: 'eq_b1',
                name: 'B1',
                type: 'sensor_discrete',
                code_symbol: 'B1',
                io_bindings: { feedback: 'io_b1' },
              },
            ],
            sequence: {
              states: [
                { id: 'init', initial: true, activities: [] },
                { id: 's2', activities: [] },
              ],
              transitions: [{ id: 't1', from: 'init', to: 's2' }],
            },
          },
        ],
        io: [
          {
            id: 'io_b1',
            name: 'B1',
            direction: 'in',
            data_type: 'bool',
            address: { memory_area: 'I', byte: 0, bit: 0 },
          },
        ],
        alarms: [],
        interlocks: [],
        parameters: [],
        recipes: [],
        safety_groups: [],
      },
    ],
  } as unknown as Project;
}

// =============================================================================
// preflightProject
// =============================================================================

describe('preflightProject (Sprint 86)', () => {
  it('1. happy path produces zero diagnostics', () => {
    const r = preflightProject(happyProject());
    expect(r.diagnostics).toEqual([]);
    expect(r.hasBlockingErrors).toBe(false);
    expect(r.target).toBe('core');
  });

  it('2. null/undefined project produces READINESS_PIR_EMPTY error', () => {
    const r1 = preflightProject(null);
    expect(r1.hasBlockingErrors).toBe(true);
    expect(r1.diagnostics[0].code).toBe('READINESS_PIR_EMPTY');
    const r2 = preflightProject(undefined);
    expect(r2.hasBlockingErrors).toBe(true);
  });

  it('3. project with no machines produces READINESS_PIR_EMPTY error', () => {
    const empty = { ...happyProject(), machines: [] } as Project;
    const r = preflightProject(empty);
    expect(r.hasBlockingErrors).toBe(true);
    expect(r.diagnostics[0].code).toBe('READINESS_PIR_EMPTY');
    expect(r.diagnostics[0].path).toBe('machines');
  });

  it('4. unsupported equipment produces READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET (error)', () => {
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'valve_onoff_unsupported';
    const r = preflightProject(p);
    expect(r.hasBlockingErrors).toBe(true);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(true);
  });

  it('5. duplicate IO addresses surface ONE warning per group', () => {
    const p = happyProject();
    p.machines[0].io.push({
      id: 'io_b2',
      name: 'B2',
      direction: 'in',
      data_type: 'bool',
      address: { memory_area: 'I', byte: 0, bit: 0 },
    } as unknown as Project['machines'][0]['io'][0]);
    const r = preflightProject(p);
    const dupes = r.diagnostics.filter(
      (d) => d.code === 'READINESS_DUPLICATE_IO_ADDRESS',
    );
    expect(dupes).toHaveLength(1);
    expect(dupes[0].severity).toBe('warning');
  });

  it('6. duplicate IO ids surface ONE warning per group', () => {
    const p = happyProject();
    p.machines[0].io.push({
      id: 'io_b1',
      name: 'B1 dup',
      direction: 'in',
      data_type: 'bool',
      address: { memory_area: 'I', byte: 1, bit: 0 },
    } as unknown as Project['machines'][0]['io'][0]);
    const r = preflightProject(p);
    expect(
      r.diagnostics.some((d) => d.code === 'READINESS_DUPLICATE_IO_ID'),
    ).toBe(true);
  });

  it('7. duplicate generated symbols surface a warning', () => {
    const p = happyProject();
    p.machines[0].stations[0].equipment.push({
      id: 'eq_b2',
      name: 'B2',
      type: 'sensor_discrete',
      code_symbol: 'B1', // collides with eq_b1's code_symbol
      io_bindings: {},
    } as unknown as Project['machines'][0]['stations'][0]['equipment'][0]);
    const r = preflightProject(p);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'READINESS_DUPLICATE_GENERATED_SYMBOL',
      ),
    ).toBe(true);
  });

  it('8. placeholder sequence surfaces info diagnostic', () => {
    const p = happyProject();
    p.machines[0].stations[0].sequence = {
      states: [
        { id: 'init', initial: true, activities: [] },
        { id: 'terminal', activities: [] },
      ],
      transitions: [{ id: 't1', from: 'init', to: 'terminal' }],
    } as unknown as Project['machines'][0]['stations'][0]['sequence'];
    const r = preflightProject(p);
    const placeholder = r.diagnostics.find(
      (d) => d.code === 'READINESS_PLACEHOLDER_SEQUENCE',
    );
    expect(placeholder).toBeDefined();
    expect(placeholder?.severity).toBe('info');
  });

  it('9. preflight is pure (input PIR deep-equal before/after)', () => {
    const p = happyProject();
    const before = JSON.stringify(p);
    preflightProject(p, { target: 'siemens' });
    expect(JSON.stringify(p)).toBe(before);
  });

  it('10. diagnostics are sorted deterministically', () => {
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'valve_onoff_unsupported';
    p.machines[0].io.push({
      id: 'io_b2',
      name: 'B2',
      direction: 'in',
      data_type: 'bool',
      address: { memory_area: 'I', byte: 0, bit: 0 },
    } as unknown as Project['machines'][0]['io'][0]);
    const r1 = preflightProject(p);
    const r2 = preflightProject(p);
    expect(r1.diagnostics.map((d) => d.code)).toEqual(
      r2.diagnostics.map((d) => d.code),
    );
    // Errors sort before warnings.
    const sevs = r1.diagnostics.map((d) => d.severity);
    const errIdx = sevs.indexOf('error');
    const warnIdx = sevs.indexOf('warning');
    if (errIdx !== -1 && warnIdx !== -1) {
      expect(errIdx).toBeLessThan(warnIdx);
    }
  });

  it('11. each target has its own capability table reachable via getTargetCapabilities', () => {
    const targets: CodegenTarget[] = ['core', 'siemens', 'codesys', 'rockwell'];
    for (const t of targets) {
      const caps = getTargetCapabilities(t);
      expect(caps.target).toBe(t);
      expect(caps.supportedEquipmentTypes.size).toBeGreaterThan(0);
      expect(caps.supportedIoDataTypes.size).toBeGreaterThan(0);
      expect(caps.supportedIoMemoryAreas.size).toBeGreaterThan(0);
    }
  });

  it('12. capability narrowing via override drops equipment outside the supplied set', () => {
    const p = happyProject();
    const r = preflightProject(p, {
      target: 'core',
      capabilities: {
        target: 'core',
        supportedEquipmentTypes: new Set(['motor_simple']),
        supportedIoDataTypes: new Set(['bool', 'int', 'dint', 'real']),
        supportedIoMemoryAreas: new Set(['I', 'Q', 'M', 'DB']),
      },
    });
    expect(
      r.diagnostics.some(
        (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(true);
  });
});

// =============================================================================
// runTargetPreflight
// =============================================================================

// =============================================================================
// Sprint 87A — per-target equipment support split (valve_onoff)
// =============================================================================

describe('preflightProject — Sprint 87A valve_onoff per-target split', () => {
  function valveProject(): Project {
    const p = happyProject();
    p.machines[0].stations[0].equipment[0] = {
      id: 'eq_v1',
      name: 'V1',
      type: 'valve_onoff',
      code_symbol: 'V1',
      io_bindings: { solenoid_out: 'io_b1' },
    } as unknown as Project['machines'][0]['stations'][0]['equipment'][0];
    return p;
  }

  it('1. core target accepts valve_onoff (no readiness error)', () => {
    const r = preflightProject(valveProject(), { target: 'core' });
    expect(r.hasBlockingErrors).toBe(false);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(false);
  });

  it('2. codesys target accepts valve_onoff (no readiness error)', () => {
    const r = preflightProject(valveProject(), { target: 'codesys' });
    expect(r.hasBlockingErrors).toBe(false);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(false);
  });

  it('3. siemens target accepts valve_onoff (Sprint 87C — post-SCL renderer audit)', () => {
    const r = preflightProject(valveProject(), { target: 'siemens' });
    expect(r.hasBlockingErrors).toBe(false);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(false);
  });

  it('4. rockwell target rejects valve_onoff via readiness (still narrow)', () => {
    const r = preflightProject(valveProject(), { target: 'rockwell' });
    expect(r.hasBlockingErrors).toBe(true);
    const diag = r.diagnostics.find(
      (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
    );
    expect(diag).toBeDefined();
    expect(diag?.message).toContain('valve_onoff');
    expect(diag?.message).toContain('rockwell');
  });

  it('5. capability tables reflect the Sprint 87C split', () => {
    expect(getTargetCapabilities('codesys').supportedEquipmentTypes.has('valve_onoff' as never)).toBe(true);
    expect(getTargetCapabilities('core').supportedEquipmentTypes.has('valve_onoff' as never)).toBe(true);
    // Sprint 87C — Siemens widened to include valve_onoff after audit.
    expect(getTargetCapabilities('siemens').supportedEquipmentTypes.has('valve_onoff' as never)).toBe(true);
    // Rockwell stays narrow until its Logix renderer is audited.
    expect(getTargetCapabilities('rockwell').supportedEquipmentTypes.has('valve_onoff' as never)).toBe(false);
  });

  it('6. preflight remains pure on a valve_onoff project (input deep-equal before/after)', () => {
    const p = valveProject();
    const before = JSON.stringify(p);
    preflightProject(p, { target: 'codesys' });
    preflightProject(p, { target: 'siemens' });
    expect(JSON.stringify(p)).toBe(before);
  });

  it('7. runTargetPreflight throws READINESS_FAILED for rockwell/valve_onoff but not for codesys / siemens', () => {
    const p = valveProject();
    expect(() => runTargetPreflight(p, 'codesys')).not.toThrow();
    // Sprint 87C — Siemens now accepts valve_onoff after the SCL
    // renderer audit, so runTargetPreflight no longer throws.
    expect(() => runTargetPreflight(p, 'siemens')).not.toThrow();
    let caught: CodegenError | undefined;
    try {
      runTargetPreflight(p, 'rockwell');
    } catch (e) {
      caught = e as CodegenError;
    }
    expect(caught?.code).toBe('READINESS_FAILED');
    const cause = caught?.cause as
      | { diagnostics: Array<{ code: string }> }
      | undefined;
    expect(
      cause?.diagnostics?.some(
        (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(true);
  });
});

describe('runTargetPreflight (Sprint 86)', () => {
  it('1. happy path returns the result without throwing', () => {
    const r = runTargetPreflight(happyProject(), 'siemens');
    expect(r.hasBlockingErrors).toBe(false);
  });

  it('2. blocking errors throw a CodegenError with code READINESS_FAILED', () => {
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'valve_onoff_unsupported';
    let caught: CodegenError | undefined;
    try {
      runTargetPreflight(p, 'siemens');
    } catch (e) {
      caught = e as CodegenError;
    }
    expect(caught).toBeDefined();
    expect(caught?.name).toBe('CodegenError');
    expect(caught?.code).toBe('READINESS_FAILED');
    // The throw carries the original diagnostic list as `cause`.
    const cause = caught?.cause as
      | { diagnostics: Array<{ code: string }>; target: CodegenTarget }
      | undefined;
    expect(cause?.target).toBe('siemens');
    expect(
      cause?.diagnostics?.some(
        (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(true);
  });
});
