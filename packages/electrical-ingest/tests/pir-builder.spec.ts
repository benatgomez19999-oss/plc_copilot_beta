// Sprint 76 — exhaustive tests for the PIR builder v0. Every
// architectural invariant the sprint plan called out is pinned
// here, plus enough fixture round-trips to keep the gate honest.
//
// Architecture invariants this spec pins:
//   - Pending items / error diagnostics block the build.
//   - Rejected items are silently excluded but still counted.
//   - Accepted assumptions never become hard PIR facts.
//   - IO / equipment ids canonicalise deterministically to
//     PIR-safe ids (matching IdSchema).
//   - Source refs propagate via the sourceMap sidecar (not lost).
//   - Built PIR validates against `@plccopilot/pir`'s validator
//     for clean inputs.
//   - Unsupported equipment kinds + un-mappable addresses fail
//     loudly, never silently default.

import { describe, expect, it } from 'vitest';
import { validate as validatePirProject } from '@plccopilot/pir';

import {
  buildPirDraftCandidate,
} from '../src/mapping/pir-candidate.js';
import {
  buildPirFromReviewedCandidate,
  canonicalisePirId,
  isReviewedCandidateReadyForPirBuild,
  mapCandidateDirection,
  mapCandidateEquipmentKind,
  parseCandidateAddress,
  type PirBuildOptions,
} from '../src/mapping/pir-builder.js';
import type { PirBuildReviewState } from '../src/mapping/review-types.js';
import { ingestElectricalCsv } from '../src/sources/csv.js';
import { ingestEplanXml } from '../src/sources/eplan-xml.js';
import { confidenceOf } from '../src/confidence.js';
import type {
  ElectricalDiagnostic,
  PirDraftCandidate,
  PirIoCandidate,
  PirEquipmentCandidate,
  PirMappingAssumption,
  SourceRef,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers — small, hand-built candidates for unit tests
// ---------------------------------------------------------------------------

const REF: SourceRef = {
  sourceId: 't',
  kind: 'csv',
  path: 'test.csv',
  line: 2,
  rawId: 'B1',
};

function ioCandidate(overrides: Partial<PirIoCandidate> = {}): PirIoCandidate {
  return {
    id: 'io_plc_channel:%I0.0',
    address: '%I0.0',
    direction: 'input',
    signalType: 'bool',
    label: 'Sample sensor',
    sourceRefs: [REF],
    confidence: confidenceOf(0.85, 'csv'),
    ...overrides,
  };
}

function equipmentCandidate(
  overrides: Partial<PirEquipmentCandidate> = {},
): PirEquipmentCandidate {
  return {
    id: 'eq_device:B1',
    kind: 'sensor_discrete',
    ioBindings: { feedback: 'io_plc_channel:%I0.0' },
    sourceRefs: [REF],
    confidence: confidenceOf(0.85, 'csv'),
    ...overrides,
  };
}

function assumption(
  overrides: Partial<PirMappingAssumption> = {},
): PirMappingAssumption {
  return {
    id: 'assum_device:M9',
    message: 'tentative classification',
    confidence: confidenceOf(0.4, 'csv'),
    sourceRefs: [REF],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<PirDraftCandidate> = {},
): PirDraftCandidate {
  return {
    id: 'draft_test',
    name: 'unit-test draft',
    io: [ioCandidate()],
    equipment: [equipmentCandidate()],
    assumptions: [],
    diagnostics: [],
    sourceGraphId: 'graph_test',
    ...overrides,
  };
}

function acceptAll(c: PirDraftCandidate): PirBuildReviewState {
  const state: PirBuildReviewState = {
    ioCandidates: {},
    equipmentCandidates: {},
    assumptions: {},
  };
  for (const io of c.io ?? []) state.ioCandidates[io.id] = { id: io.id, decision: 'accepted' };
  for (const eq of c.equipment ?? []) state.equipmentCandidates[eq.id] = { id: eq.id, decision: 'accepted' };
  for (const a of c.assumptions ?? []) state.assumptions[a.id] = { id: a.id, decision: 'accepted' };
  return state;
}

const FIXED_OPTIONS: PirBuildOptions = {
  provenanceCreatedAt: '1970-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// canonicalisePirId
// ---------------------------------------------------------------------------

describe('canonicalisePirId', () => {
  it('strips device: prefix and lowercases', () => {
    expect(canonicalisePirId('device:B1')).toBe('b1');
  });
  it('handles plc_channel:%I0.0 → i0_0', () => {
    expect(canonicalisePirId('plc_channel:%I0.0')).toBe('i0_0');
  });
  it('strips io_plc_channel: AND respects prefix', () => {
    expect(canonicalisePirId('io_plc_channel:%Q1.7', 'io')).toBe('io_q1_7');
  });
  it('strips eq_device: AND respects prefix', () => {
    expect(canonicalisePirId('eq_device:Y1', 'eq')).toBe('eq_y1');
  });
  it('rewrites runs of underscores to single', () => {
    expect(canonicalisePirId('a___b')).toBe('a_b');
  });
  it('prefixes leading-digit results with x', () => {
    expect(canonicalisePirId('123')).toBe('x123');
  });
  it('caps at 63 chars', () => {
    const long = 'x'.repeat(200);
    expect(canonicalisePirId(long).length).toBeLessThanOrEqual(63);
  });
  it('throws on empty / non-string', () => {
    expect(() => canonicalisePirId('')).toThrow();
    expect(() => canonicalisePirId(undefined as never)).toThrow();
  });
  it('always produces an id matching PIR IdSchema', () => {
    for (const raw of [
      'device:B1',
      'eq_device:Y1',
      'plc_channel:%I0.0',
      'plc_channel:%Q15.7',
      'io_plc_channel:%MD100',
      'unknown:thing',
    ]) {
      const id = canonicalisePirId(raw, 'io');
      expect(id).toMatch(/^[a-z][a-z0-9_]{1,62}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// parseCandidateAddress
// ---------------------------------------------------------------------------

describe('parseCandidateAddress', () => {
  it('parses Siemens %I0.0 to {I, 0, 0} bool', () => {
    expect(parseCandidateAddress('%I0.0')).toEqual({
      address: { memory_area: 'I', byte: 0, bit: 0 },
      data_type: 'bool',
    });
  });
  it('parses Siemens %Q1.7 to {Q, 1, 7} bool', () => {
    expect(parseCandidateAddress('%Q1.7')).toEqual({
      address: { memory_area: 'Q', byte: 1, bit: 7 },
      data_type: 'bool',
    });
  });
  it('parses Codesys %IX0.0 same as %I0.0', () => {
    const r = parseCandidateAddress('%IX0.0');
    expect(r?.address.memory_area).toBe('I');
    expect(r?.address.byte).toBe(0);
    expect(r?.address.bit).toBe(0);
    expect(r?.data_type).toBe('bool');
  });
  it('parses %IW10 as int word', () => {
    const r = parseCandidateAddress('%IW10');
    expect(r).toEqual({
      address: { memory_area: 'I', byte: 10 },
      data_type: 'int',
    });
  });
  it('parses %MD100 as real double-word', () => {
    const r = parseCandidateAddress('%MD100');
    expect(r?.address.memory_area).toBe('M');
    expect(r?.data_type).toBe('real');
  });
  it('parses bare %I0 as bit 0', () => {
    expect(parseCandidateAddress('%I0')).toEqual({
      address: { memory_area: 'I', byte: 0, bit: 0 },
      data_type: 'bool',
    });
  });
  it('parses Rockwell Local:1:I.Data[0].0 to {I, 0, 0} with descriptionHint', () => {
    const r = parseCandidateAddress('Local:1:I.Data[0].0');
    expect(r?.address).toEqual({ memory_area: 'I', byte: 0, bit: 0 });
    expect(r?.descriptionHint).toContain('Local:1');
  });
  it('returns null on unrecognised input', () => {
    expect(parseCandidateAddress('not-an-address')).toBeNull();
    expect(parseCandidateAddress('')).toBeNull();
    expect(parseCandidateAddress(undefined as never)).toBeNull();
  });
  it('rejects bit > 7', () => {
    expect(parseCandidateAddress('%I0.9')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapCandidateDirection / mapCandidateEquipmentKind
// ---------------------------------------------------------------------------

describe('mapCandidateDirection', () => {
  it('maps input → in / output → out', () => {
    expect(mapCandidateDirection('input')).toBe('in');
    expect(mapCandidateDirection('output')).toBe('out');
  });
  it('returns null for unknown / undefined', () => {
    expect(mapCandidateDirection('unknown')).toBeNull();
    expect(mapCandidateDirection(undefined)).toBeNull();
  });
});

describe('mapCandidateEquipmentKind', () => {
  it('maps known kinds to PIR equivalents', () => {
    expect(mapCandidateEquipmentKind('sensor_discrete')).toBe('sensor_discrete');
    expect(mapCandidateEquipmentKind('motor_simple')).toBe('motor_simple');
    expect(mapCandidateEquipmentKind('pneumatic_cylinder_2pos')).toBe('pneumatic_cylinder_2pos');
    expect(mapCandidateEquipmentKind('valve_solenoid')).toBe('valve_onoff');
  });
  it('returns null for unknown', () => {
    expect(mapCandidateEquipmentKind('unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isReviewedCandidateReadyForPirBuild — the gate
// ---------------------------------------------------------------------------

describe('isReviewedCandidateReadyForPirBuild', () => {
  it('returns true when every item is accepted/rejected and no error diagnostics', () => {
    const c = candidate();
    const state = acceptAll(c);
    expect(isReviewedCandidateReadyForPirBuild(c, state)).toBe(true);
  });

  it('returns false when an IO is pending', () => {
    const c = candidate();
    const state: PirBuildReviewState = {
      ioCandidates: { [c.io[0].id]: { id: c.io[0].id, decision: 'pending' } },
      equipmentCandidates: { [c.equipment[0].id]: { id: c.equipment[0].id, decision: 'accepted' } },
      assumptions: {},
    };
    expect(isReviewedCandidateReadyForPirBuild(c, state)).toBe(false);
  });

  it('returns false when equipment is pending', () => {
    const c = candidate();
    const state: PirBuildReviewState = {
      ioCandidates: { [c.io[0].id]: { id: c.io[0].id, decision: 'accepted' } },
      equipmentCandidates: { [c.equipment[0].id]: { id: c.equipment[0].id, decision: 'pending' } },
      assumptions: {},
    };
    expect(isReviewedCandidateReadyForPirBuild(c, state)).toBe(false);
  });

  it('returns false when an assumption is pending', () => {
    const c = candidate({ assumptions: [assumption()] });
    const state = acceptAll(c);
    state.assumptions[c.assumptions[0].id].decision = 'pending';
    expect(isReviewedCandidateReadyForPirBuild(c, state)).toBe(false);
  });

  it('returns false when an io decision is missing entirely', () => {
    const c = candidate();
    const state: PirBuildReviewState = {
      ioCandidates: {}, // missing io decision
      equipmentCandidates: { [c.equipment[0].id]: { id: c.equipment[0].id, decision: 'accepted' } },
      assumptions: {},
    };
    expect(isReviewedCandidateReadyForPirBuild(c, state)).toBe(false);
  });

  it('returns false when candidate has any error-severity diagnostic', () => {
    const c = candidate({
      diagnostics: [
        { code: 'CSV_DUPLICATE_HEADER', severity: 'error', message: 'x' },
      ] as ElectricalDiagnostic[],
    });
    expect(isReviewedCandidateReadyForPirBuild(c, acceptAll(c))).toBe(false);
  });

  it('returns true when only warnings exist', () => {
    const c = candidate({
      diagnostics: [
        { code: 'CSV_UNKNOWN_KIND', severity: 'warning', message: 'x' },
      ] as ElectricalDiagnostic[],
    });
    expect(isReviewedCandidateReadyForPirBuild(c, acceptAll(c))).toBe(true);
  });

  it('Sprint 78A — empty candidate is NOT ready (no reviewable items)', () => {
    // Sprint 76 originally returned true here ("caller must check
    // counts"). Sprint 77 manual testing showed an empty candidate
    // would flow through the UI as "READY TO BUILD" without any
    // reviewable items — exactly the UX bug Sprint 78A fixes by
    // making the gate return false when there is nothing to review.
    const c = candidate({ io: [], equipment: [], assumptions: [], diagnostics: [] });
    expect(
      isReviewedCandidateReadyForPirBuild(c, {
        ioCandidates: {},
        equipmentCandidates: {},
        assumptions: {},
      }),
    ).toBe(false);
  });

  it('handles malformed inputs without throwing', () => {
    expect(isReviewedCandidateReadyForPirBuild(null as never, {} as never)).toBe(false);
    expect(isReviewedCandidateReadyForPirBuild({} as never, null as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPirFromReviewedCandidate — gate failures
// ---------------------------------------------------------------------------

describe('buildPirFromReviewedCandidate — gate failures', () => {
  it('refuses with PIR_BUILD_PENDING_REVIEW_ITEM when IO is pending', () => {
    const c = candidate();
    const state: PirBuildReviewState = {
      ioCandidates: { [c.io[0].id]: { id: c.io[0].id, decision: 'pending' } },
      equipmentCandidates: { [c.equipment[0].id]: { id: c.equipment[0].id, decision: 'accepted' } },
      assumptions: {},
    };
    const r = buildPirFromReviewedCandidate(c, state, FIXED_OPTIONS);
    expect(r.pir).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_PENDING_REVIEW_ITEM');
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_REVIEW_NOT_READY');
  });

  it('refuses with PIR_BUILD_ERROR_DIAGNOSTIC_PRESENT when error diag exists', () => {
    const c = candidate({
      diagnostics: [
        { code: 'CSV_MISSING_HEADER', severity: 'error', message: 'x' },
      ] as ElectricalDiagnostic[],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_ERROR_DIAGNOSTIC_PRESENT');
  });

  it('refuses with PIR_BUILD_REVIEW_NOT_READY when state is null', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, null as never, FIXED_OPTIONS);
    expect(r.pir).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_REVIEW_NOT_READY');
  });

  it('refuses with PIR_BUILD_EMPTY_ACCEPTED_INPUT when nothing is accepted', () => {
    const c = candidate({ io: [], equipment: [], assumptions: [] });
    const r = buildPirFromReviewedCandidate(c, { ioCandidates: {}, equipmentCandidates: {}, assumptions: {} }, FIXED_OPTIONS);
    expect(r.pir).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_EMPTY_ACCEPTED_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Accepted-only filtering
// ---------------------------------------------------------------------------

describe('buildPirFromReviewedCandidate — accepted-only filtering', () => {
  it('rejected IO is excluded from PIR + counted in skippedInputCounts', () => {
    const c = candidate();
    const state = acceptAll(c);
    state.ioCandidates[c.io[0].id].decision = 'rejected';
    // Equipment accepted but IO binding will fail because the IO
    // is no longer accepted — assert PIR not built and the proper
    // diagnostic surfaces.
    const r = buildPirFromReviewedCandidate(c, state, FIXED_OPTIONS);
    expect(r.pir).toBeUndefined();
    expect(r.skippedInputCounts.rejected).toBe(1);
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID');
  });

  it('accepting just IO + skipping equipment still builds PIR with empty equipment', () => {
    const c = candidate({ equipment: [] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeDefined();
    expect(r.pir!.machines[0].io.length).toBe(1);
    expect(r.pir!.machines[0].stations[0].equipment.length).toBe(0);
  });

  it('rejected equipment + accepted IO without binding builds clean PIR', () => {
    const c = candidate();
    const state = acceptAll(c);
    state.equipmentCandidates[c.equipment[0].id].decision = 'rejected';
    const r = buildPirFromReviewedCandidate(c, state, FIXED_OPTIONS);
    expect(r.pir).toBeDefined();
    expect(r.skippedInputCounts.rejected).toBe(1);
    expect(r.acceptedInputCounts.io).toBe(1);
    expect(r.acceptedInputCounts.equipment).toBe(0);
    expect(r.pir!.machines[0].stations[0].equipment).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// IO conversion
// ---------------------------------------------------------------------------

describe('buildPirFromReviewedCandidate — IO conversion', () => {
  it('preserves address, direction, and label', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeDefined();
    const io = r.pir!.machines[0].io[0];
    expect(io.address).toEqual({ memory_area: 'I', byte: 0, bit: 0 });
    expect(io.direction).toBe('in');
    expect(io.name).toBe('Sample sensor');
  });

  it('emits PIR_BUILD_ACCEPTED_IO_MISSING_ADDRESS when address is absent', () => {
    const c = candidate({ io: [ioCandidate({ address: undefined })] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeUndefined(); // no IO, no equipment binding → empty + refusal
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_ACCEPTED_IO_MISSING_ADDRESS');
  });

  it('emits PIR_BUILD_ACCEPTED_IO_MISSING_DIRECTION when direction is unknown', () => {
    const c = candidate({ io: [ioCandidate({ direction: 'unknown' })] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_ACCEPTED_IO_MISSING_DIRECTION');
  });

  it('emits PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS when address cannot be mapped', () => {
    const c = candidate({ io: [ioCandidate({ address: 'gibberish' })] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS');
  });

  it('IoSignal id matches PIR IdSchema regex', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    for (const io of r.pir!.machines[0].io) {
      expect(io.id).toMatch(/^[a-z][a-z0-9_]{1,62}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Equipment conversion
// ---------------------------------------------------------------------------

describe('buildPirFromReviewedCandidate — equipment conversion', () => {
  it('motor_simple maps to motor_simple', () => {
    const c = candidate({
      io: [ioCandidate({ id: 'io_q', address: '%Q0.1', direction: 'output' })],
      equipment: [
        equipmentCandidate({
          id: 'eq_device:M1',
          kind: 'motor_simple',
          ioBindings: { drive: 'io_q' },
        }),
      ],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeDefined();
    expect(r.pir!.machines[0].stations[0].equipment[0].type).toBe('motor_simple');
  });

  it('valve_solenoid maps to valve_onoff', () => {
    const c = candidate({
      io: [ioCandidate({ id: 'io_q', address: '%Q0.0', direction: 'output' })],
      equipment: [
        equipmentCandidate({
          id: 'eq_device:Y1',
          kind: 'valve_solenoid',
          ioBindings: { drive: 'io_q' },
        }),
      ],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir!.machines[0].stations[0].equipment[0].type).toBe('valve_onoff');
  });

  it('unknown kind emits PIR_BUILD_UNSUPPORTED_EQUIPMENT_KIND', () => {
    const c = candidate({
      equipment: [equipmentCandidate({ kind: 'unknown' })],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_UNSUPPORTED_EQUIPMENT_KIND');
  });

  it('Equipment id matches PIR IdSchema regex', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    for (const eq of r.pir!.machines[0].stations[0].equipment) {
      expect(eq.id).toMatch(/^[a-z][a-z0-9_]{1,62}$/);
    }
  });

  it('io_bindings re-key to PIR-side io ids', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    const eq = r.pir!.machines[0].stations[0].equipment[0];
    const ioId = r.pir!.machines[0].io[0].id;
    expect(Object.values(eq.io_bindings)).toContain(ioId);
  });

  it('emits PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID when binding refers to missing IO', () => {
    const c = candidate({
      equipment: [
        equipmentCandidate({
          ioBindings: { feedback: 'io_plc_channel:%I9.9' }, // no IO with this id
        }),
      ],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID');
  });
});

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

describe('buildPirFromReviewedCandidate — assumptions', () => {
  it('accepted assumption never becomes hard PIR', () => {
    const c = candidate({ assumptions: [assumption()] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeDefined();
    // No equipment / IO from the assumption.
    expect(r.pir!.machines[0].stations[0].equipment.length).toBe(1); // only the original eq
    expect(r.pir!.machines[0].io.length).toBe(1);
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_UNSUPPORTED_ASSUMPTION');
    expect(r.acceptedInputCounts.assumptions).toBe(1);
    expect(r.skippedInputCounts.unsupportedAssumptions).toBe(1);
  });

  it('accepted assumption is recorded in sourceMap under canonical id', () => {
    const c = candidate({ assumptions: [assumption()] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    const keys = Object.keys(r.sourceMap);
    expect(keys.some((k) => k.startsWith('assum_'))).toBe(true);
  });

  it('rejected assumption is excluded + not in sourceMap', () => {
    const c = candidate({ assumptions: [assumption()] });
    const state = acceptAll(c);
    state.assumptions[c.assumptions[0].id].decision = 'rejected';
    const r = buildPirFromReviewedCandidate(c, state, FIXED_OPTIONS);
    expect(r.skippedInputCounts.rejected).toBe(1);
    const keys = Object.keys(r.sourceMap);
    expect(keys.some((k) => k.startsWith('assum_'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SourceMap sidecar
// ---------------------------------------------------------------------------

describe('buildPirFromReviewedCandidate — sourceMap', () => {
  it('every accepted IO has a sourceMap entry', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    for (const io of r.pir!.machines[0].io) {
      expect(r.sourceMap[io.id]).toBeDefined();
      expect(r.sourceMap[io.id].length).toBeGreaterThan(0);
    }
  });

  it('every accepted equipment has a sourceMap entry', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    for (const eq of r.pir!.machines[0].stations[0].equipment) {
      expect(r.sourceMap[eq.id]).toBeDefined();
      expect(r.sourceMap[eq.id].length).toBeGreaterThan(0);
    }
  });

  it('preserves CSV source ref kind/path/line', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    const ioId = r.pir!.machines[0].io[0].id;
    const ref = r.sourceMap[ioId][0];
    expect(ref.kind).toBe('csv');
    expect(ref.path).toBe('test.csv');
    expect(ref.line).toBe(2);
  });

  it('preserves EPLAN XML locator (symbol)', () => {
    const eplanRef: SourceRef = {
      sourceId: 'p',
      kind: 'eplan',
      path: 'plan.xml',
      line: 18,
      rawId: 'Y1',
      symbol: '/EplanProject[1]/Pages[1]/Page[2]/Element[1]',
    };
    const c = candidate({
      io: [ioCandidate({ sourceRefs: [eplanRef] })],
      equipment: [equipmentCandidate({ sourceRefs: [eplanRef] })],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    const eqId = r.pir!.machines[0].stations[0].equipment[0].id;
    expect(r.sourceMap[eqId][0].symbol).toContain('/EplanProject[1]');
  });

  it('handles items without source refs', () => {
    const c = candidate({
      io: [ioCandidate({ sourceRefs: [] })],
      equipment: [],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeDefined();
    const ioId = r.pir!.machines[0].io[0].id;
    expect(r.sourceMap[ioId]).toEqual([]);
  });

  it('sourceMap keys match IDs in the built PIR exactly', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    for (const ioId of r.pir!.machines[0].io.map((io) => io.id)) {
      expect(Object.keys(r.sourceMap)).toContain(ioId);
    }
    for (const eqId of r.pir!.machines[0].stations[0].equipment.map((eq) => eq.id)) {
      expect(Object.keys(r.sourceMap)).toContain(eqId);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema validation hookup
// ---------------------------------------------------------------------------

describe('buildPirFromReviewedCandidate — schema validation', () => {
  it('built PIR validates against @plccopilot/pir for a clean simple candidate', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeDefined();
    const report = validatePirProject(r.pir!);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('emits PIR_BUILD_PLACEHOLDER_SEQUENCE_USED + PIR_BUILD_SOURCE_REFS_SIDECAR_USED info diagnostics on success', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PIR_BUILD_PLACEHOLDER_SEQUENCE_USED');
    expect(codes).toContain('PIR_BUILD_SOURCE_REFS_SIDECAR_USED');
  });
});

// ---------------------------------------------------------------------------
// Counts + miscellanea
// ---------------------------------------------------------------------------

describe('buildPirFromReviewedCandidate — counts', () => {
  it('counts accepted IO + equipment + assumptions correctly', () => {
    const c = candidate({ assumptions: [assumption()] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.acceptedInputCounts).toEqual({ io: 1, equipment: 1, assumptions: 1 });
  });

  it('counts rejected items', () => {
    const c = candidate({ assumptions: [assumption()] });
    const state = acceptAll(c);
    state.assumptions[c.assumptions[0].id].decision = 'rejected';
    const r = buildPirFromReviewedCandidate(c, state, FIXED_OPTIONS);
    expect(r.skippedInputCounts.rejected).toBe(1);
  });

  it('does not throw on malformed candidate', () => {
    const r = buildPirFromReviewedCandidate(null as never, {} as never);
    expect(r.pir).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain('PIR_BUILD_REVIEW_NOT_READY');
  });
});

// ---------------------------------------------------------------------------
// Round-trip with real ingestors
// ---------------------------------------------------------------------------

describe('CSV → review → PIR builder', () => {
  it('produces a valid PIR for a simple CSV input', () => {
    const csvText = [
      'tag,kind,address,direction,label',
      'B1,sensor,%I0.0,input,Part present',
      'Y1,valve,%Q0.0,output,Cylinder extend',
      'M1,motor,%Q0.1,output,Conveyor motor',
    ].join('\n');
    const graph = ingestElectricalCsv({
      sourceId: 'simple',
      text: csvText,
      fileName: 'simple.csv',
    }).graph;
    const candidate = buildPirDraftCandidate(graph);
    const result = buildPirFromReviewedCandidate(
      candidate,
      acceptAll(candidate),
      FIXED_OPTIONS,
    );
    expect(result.pir).toBeDefined();
    const report = validatePirProject(result.pir!);
    expect(report.ok).toBe(true);
    // Every IO + equipment carries a sourceMap entry with a CSV ref.
    for (const io of result.pir!.machines[0].io) {
      const refs = result.sourceMap[io.id];
      expect(refs.some((r) => r.kind === 'csv')).toBe(true);
    }
  });
});

describe('EPLAN XML → review → PIR builder', () => {
  it('produces a valid PIR for a simple EPLAN XML input', () => {
    const xml =
      '<EplanProject>' +
      '<Pages>' +
      '<Page sheet="=A1/12">' +
      '<Element tag="B1" kind="sensor" address="%I0.0" direction="input"/>' +
      '<Element tag="Y1" kind="valve" address="%Q0.0" direction="output"/>' +
      '</Page>' +
      '</Pages>' +
      '</EplanProject>';
    const graph = ingestEplanXml({
      sourceId: 'simple-eplan',
      text: xml,
      fileName: 'simple.xml',
    }).graph;
    const candidate = buildPirDraftCandidate(graph);
    const result = buildPirFromReviewedCandidate(
      candidate,
      acceptAll(candidate),
      FIXED_OPTIONS,
    );
    expect(result.pir).toBeDefined();
    const report = validatePirProject(result.pir!);
    expect(report.ok).toBe(true);
    // EPLAN source refs preserve the XML locator into the sourceMap.
    const equipmentEntry = Object.entries(result.sourceMap).find(
      ([id]) => id.startsWith('eq_'),
    );
    expect(equipmentEntry).toBeDefined();
    expect(
      equipmentEntry![1].some((r) => r.kind === 'eplan' && r.symbol),
    ).toBe(true);
  });
});

describe('Mixed CSV + EPLAN candidate', () => {
  it('builder preserves both CSV and EPLAN refs in sourceMap', () => {
    // Hand-built: one sensor from CSV, one valve from EPLAN.
    const csvRef: SourceRef = {
      sourceId: 's',
      kind: 'csv',
      path: 'list.csv',
      line: 2,
      rawId: 'B1',
    };
    const eplanRef: SourceRef = {
      sourceId: 's',
      kind: 'eplan',
      path: 'plan.xml',
      line: 12,
      rawId: 'Y1',
      symbol: '/EplanProject[1]/Pages[1]/Page[1]/Element[1]',
    };
    const c: PirDraftCandidate = {
      id: 'mixed',
      io: [
        ioCandidate({
          id: 'io_plc_channel:%I0.0',
          address: '%I0.0',
          direction: 'input',
          sourceRefs: [csvRef],
        }),
        ioCandidate({
          id: 'io_plc_channel:%Q0.0',
          address: '%Q0.0',
          direction: 'output',
          sourceRefs: [eplanRef],
        }),
      ],
      equipment: [
        equipmentCandidate({
          id: 'eq_device:B1',
          kind: 'sensor_discrete',
          ioBindings: { feedback: 'io_plc_channel:%I0.0' },
          sourceRefs: [csvRef],
        }),
        equipmentCandidate({
          id: 'eq_device:Y1',
          kind: 'valve_solenoid',
          ioBindings: { drive: 'io_plc_channel:%Q0.0' },
          sourceRefs: [eplanRef],
        }),
      ],
      assumptions: [],
      diagnostics: [],
      sourceGraphId: 'mixed',
    };
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeDefined();
    const refKinds = new Set<string>();
    for (const refs of Object.values(r.sourceMap)) {
      for (const ref of refs) refKinds.add(ref.kind);
    }
    expect(refKinds.has('csv')).toBe(true);
    expect(refKinds.has('eplan')).toBe(true);
  });
});

describe('Ambiguous candidate refuses to build', () => {
  it('candidate with error diagnostic refuses to build', () => {
    const c = candidate({
      diagnostics: [
        { code: 'CSV_MISSING_HEADER', severity: 'error', message: 'x' },
      ] as ElectricalDiagnostic[],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c), FIXED_OPTIONS);
    expect(r.pir).toBeUndefined();
  });
});
