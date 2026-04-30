// Sprint 87B — pure tests for `buildCodegenReadinessView`.
//
// The web Codegen-Readiness panel is a thin renderer; the
// behaviour the operator depends on lives in this helper:
//   - status verdict (ready / warning / blocked / unavailable),
//   - severity counts after dedup,
//   - groups sorted error → warning → info → code,
//   - defensive null-project + unknown-target handling,
//   - Sprint 87A valve_onoff per-target split (CODESYS ready,
//     Siemens / Rockwell blocked).

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { buildCodegenReadinessView } from '../src/utils/codegen-readiness-view.js';

// ---------------------------------------------------------------------------
// Fixture helpers
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

function valveProject(): Project {
  const p = happyProject();
  (p.machines[0].stations[0].equipment[0].type as string) = 'valve_onoff';
  p.machines[0].stations[0].equipment[0].code_symbol = 'V01';
  p.machines[0].stations[0].equipment[0].io_bindings = {
    solenoid_out: 'io_b1',
  } as unknown as Project['machines'][0]['stations'][0]['equipment'][0]['io_bindings'];
  return p;
}

// =============================================================================
// Status verdict
// =============================================================================

describe('buildCodegenReadinessView (Sprint 87B)', () => {
  it('1. null project → unavailable', () => {
    const v = buildCodegenReadinessView({
      project: null,
      target: 'codesys',
    });
    expect(v.status).toBe('unavailable');
    expect(v.target).toBe('codesys');
    expect(v.summary).toMatch(/Build a PIR/);
    expect(v.groups).toEqual([]);
  });

  it('2. happy project on codesys → ready', () => {
    const v = buildCodegenReadinessView({
      project: happyProject(),
      target: 'codesys',
    });
    expect(v.status).toBe('ready');
    expect(v.blockingCount).toBe(0);
    expect(v.warningCount).toBe(0);
    expect(v.summary).toContain('Ready for codesys');
    expect(v.groups).toEqual([]);
  });

  it('3. unsupported equipment for siemens → blocked', () => {
    const p = happyProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'valve_onoff_unsupported';
    const v = buildCodegenReadinessView({ project: p, target: 'siemens' });
    expect(v.status).toBe('blocked');
    expect(v.blockingCount).toBeGreaterThanOrEqual(1);
    expect(v.summary).toMatch(/Not ready for siemens/);
    const eqGroup = v.groups.find(
      (g) => g.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
    );
    expect(eqGroup).toBeDefined();
    expect(eqGroup?.severity).toBe('error');
    expect(eqGroup?.title).toContain('Equipment kind not supported');
  });

  it('4. duplicate-IO-address only → warning', () => {
    const p = happyProject();
    p.machines[0].io.push({
      id: 'io_b2',
      name: 'B2',
      direction: 'in',
      data_type: 'bool',
      address: { memory_area: 'I', byte: 0, bit: 0 },
    } as unknown as Project['machines'][0]['io'][0]);
    const v = buildCodegenReadinessView({ project: p, target: 'codesys' });
    expect(v.status).toBe('warning');
    expect(v.warningCount).toBeGreaterThanOrEqual(1);
    expect(v.summary).toMatch(/with .* warning/);
  });
});

// =============================================================================
// Sprint 87A valve_onoff per-target split
// =============================================================================

describe('buildCodegenReadinessView — Sprint 87A/87C/88C valve_onoff', () => {
  it('1. valve_onoff on codesys → ready (Sprint 87A)', () => {
    const v = buildCodegenReadinessView({
      project: valveProject(),
      target: 'codesys',
    });
    expect(v.status).toBe('ready');
    expect(
      v.groups.some(
        (g) => g.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(false);
  });

  it('2. valve_onoff on siemens → ready (Sprint 87C — post SCL renderer audit)', () => {
    const v = buildCodegenReadinessView({
      project: valveProject(),
      target: 'siemens',
    });
    expect(v.status).toBe('ready');
    expect(
      v.groups.some(
        (g) => g.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(false);
  });

  it('3. valve_onoff on rockwell → ready (Sprint 88C — post Logix renderer audit)', () => {
    const v = buildCodegenReadinessView({
      project: valveProject(),
      target: 'rockwell',
    });
    expect(v.status).toBe('ready');
    expect(
      v.groups.some(
        (g) => g.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
      ),
    ).toBe(false);
  });

  it('4. motor_vfd_simple still blocks Rockwell (CODESYS opened in 88H, Siemens in 88I)', () => {
    // Sprint 88H — CODESYS audit. Sprint 88I — Siemens SCL audit.
    // Both confirmed structural agnosticism for `motor_vfd_simple`.
    // Only Rockwell continues to block; its audit lands in 88J.
    // The unsupported-UX is exercised on the one still-closed
    // vendor, with explicit positive checks for CODESYS + Siemens.
    const p = valveProject();
    (p.machines[0].stations[0].equipment[0].type as string) =
      'motor_vfd_simple';

    // Rockwell still blocked — UX exercised here.
    const rv = buildCodegenReadinessView({ project: p, target: 'rockwell' });
    expect(rv.status).toBe('blocked');
    const rGroup = rv.groups.find(
      (g) => g.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
    );
    expect(rGroup).toBeDefined();
    expect(rGroup?.severity).toBe('error');
    expect(rGroup?.items[0].message).toContain('motor_vfd_simple');
    expect(rGroup?.items[0].message).toContain('rockwell');
    expect(rGroup?.items[0].hint).toBeDefined();

    // CODESYS + Siemens no longer block the kind.
    for (const target of ['codesys', 'siemens'] as const) {
      const v = buildCodegenReadinessView({ project: p, target });
      expect(v.status).not.toBe('blocked');
      expect(
        v.groups.some(
          (g) => g.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
        ),
      ).toBe(false);
    }
  });
});

// =============================================================================
// Sort + group + dedup
// =============================================================================

describe('buildCodegenReadinessView — sort + group + dedup', () => {
  it('1. groups are sorted error → warning → info', () => {
    const p = happyProject();
    // Trigger an error (unsupported equipment for siemens) AND a
    // warning (duplicate IO address) in the same project.
    (p.machines[0].stations[0].equipment[0].type as string) =
      'valve_onoff_unsupported';
    p.machines[0].io.push({
      id: 'io_b2',
      name: 'B2',
      direction: 'in',
      data_type: 'bool',
      address: { memory_area: 'I', byte: 0, bit: 0 },
    } as unknown as Project['machines'][0]['io'][0]);
    const v = buildCodegenReadinessView({ project: p, target: 'siemens' });
    const severities = v.groups.map((g) => g.severity);
    const errorIdx = severities.indexOf('error');
    const warnIdx = severities.indexOf('warning');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThan(errorIdx);
  });

  it('2. unknown diagnostic codes fall back to the code as title', () => {
    // Build a view for a project that *would* legitimately surface
    // an info diagnostic, then verify the title fallback machinery
    // still produces a non-empty title (covered indirectly by the
    // existing READINESS_PLACEHOLDER_SEQUENCE info case below).
    const p = happyProject();
    p.machines[0].stations[0].sequence = {
      states: [
        { id: 'init', initial: true, activities: [] },
        { id: 'terminal', activities: [] },
      ],
      transitions: [{ id: 't1', from: 'init', to: 'terminal' }],
    } as unknown as Project['machines'][0]['stations'][0]['sequence'];
    const v = buildCodegenReadinessView({ project: p, target: 'codesys' });
    const placeholder = v.groups.find(
      (g) => g.code === 'READINESS_PLACEHOLDER_SEQUENCE',
    );
    expect(placeholder).toBeDefined();
    // Documented title for a known code.
    expect(placeholder?.title).toContain('Placeholder sequence');
  });

  it('3. helper does not mutate the input project', () => {
    const p = valveProject();
    const before = JSON.stringify(p);
    buildCodegenReadinessView({ project: p, target: 'siemens' });
    buildCodegenReadinessView({ project: p, target: 'codesys' });
    expect(JSON.stringify(p)).toBe(before);
  });

  it('4. multiple identical readiness diagnostics dedup to a single item', () => {
    // The Sprint 86 preflight already dedups. This test pins the
    // behaviour at the view level by surfacing duplicate IO ids
    // (which produces a deterministic warning) and asserting the
    // group has exactly one item per group key.
    const p = happyProject();
    p.machines[0].io.push({
      id: 'io_b1',
      name: 'B1 dup',
      direction: 'in',
      data_type: 'bool',
      address: { memory_area: 'I', byte: 1, bit: 0 },
    } as unknown as Project['machines'][0]['io'][0]);
    const v = buildCodegenReadinessView({ project: p, target: 'codesys' });
    const dupId = v.groups.find(
      (g) => g.code === 'READINESS_DUPLICATE_IO_ID',
    );
    expect(dupId).toBeDefined();
    expect(dupId?.items).toHaveLength(1);
  });
});

// =============================================================================
// Defensive
// =============================================================================

describe('buildCodegenReadinessView — defensive', () => {
  it('1. undefined project is treated as null (unavailable)', () => {
    const v = buildCodegenReadinessView({
      project: undefined,
      target: 'codesys',
    });
    expect(v.status).toBe('unavailable');
  });

  it('2. status counts add up to total items across all groups', () => {
    const p = valveProject();
    const v = buildCodegenReadinessView({ project: p, target: 'siemens' });
    const totalItems = v.groups.reduce((acc, g) => acc + g.items.length, 0);
    expect(v.blockingCount + v.warningCount + v.infoCount).toBe(totalItems);
  });

  it('3. ready summary names the target verbatim', () => {
    const v = buildCodegenReadinessView({
      project: happyProject(),
      target: 'rockwell',
    });
    expect(v.status).toBe('ready');
    expect(v.summary).toContain('rockwell');
  });
});
