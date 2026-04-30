// Sprint 88A — cross-source duplicate detection.
//
// Pure / read-only helper sitting next to Sprint 85's
// `electrical-graph-hardening`. The Sprint 85 hardening already
// flags duplicate IO addresses / tags / equipment ids inside a
// single candidate; Sprint 88A adds a *cross-source* filter:
// only emits when a duplicate group spans ≥ 2 distinct
// `SourceRef.sourceId` values.

import { describe, expect, it } from 'vitest';

import {
  diagnoseCrossSourceDuplicates,
  summarizeCrossSourceDuplicates,
} from '../src/mapping/cross-source-duplicates.js';
import {
  buildPirFromReviewedCandidate,
} from '../src/mapping/pir-builder.js';
import type { PirBuildReviewState } from '../src/mapping/review-types.js';
import { confidenceOf } from '../src/confidence.js';
import type {
  PirDraftCandidate,
  PirEquipmentCandidate,
  PirIoCandidate,
  SourceRef,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Tiny fixture helpers
// ---------------------------------------------------------------------------

function ref(sourceId: string, line = 1): SourceRef {
  return {
    sourceId,
    kind: 'csv',
    path: `${sourceId}.csv`,
    line,
    rawId: `R${line}`,
  };
}

function ioCandidate(
  overrides: Partial<PirIoCandidate> = {},
): PirIoCandidate {
  return {
    id: 'io_default',
    address: '%I0.0',
    direction: 'input',
    signalType: 'bool',
    label: 'Sample',
    sourceRefs: [ref('csv-1')],
    confidence: confidenceOf(0.85, 'csv'),
    ...overrides,
  };
}

function equipmentCandidate(
  overrides: Partial<PirEquipmentCandidate> = {},
): PirEquipmentCandidate {
  return {
    id: 'eq_default',
    kind: 'sensor_discrete',
    ioBindings: { feedback: 'io_default' },
    sourceRefs: [ref('csv-1')],
    confidence: confidenceOf(0.85, 'csv'),
    ...overrides,
  };
}

function candidate(
  overrides: Partial<PirDraftCandidate> = {},
): PirDraftCandidate {
  return {
    id: 'draft_x',
    name: 'cross-source-test',
    io: [],
    equipment: [],
    assumptions: [],
    diagnostics: [],
    sourceGraphId: 'graph_x',
    ...overrides,
  };
}

function acceptAll(c: PirDraftCandidate): PirBuildReviewState {
  const state: PirBuildReviewState = {
    ioCandidates: {},
    equipmentCandidates: {},
    assumptions: {},
  };
  for (const io of c.io ?? [])
    state.ioCandidates[io.id] = { id: io.id, decision: 'accepted' };
  for (const eq of c.equipment ?? [])
    state.equipmentCandidates[eq.id] = { id: eq.id, decision: 'accepted' };
  for (const a of c.assumptions ?? [])
    state.assumptions[a.id] = { id: a.id, decision: 'accepted' };
  return state;
}

// =============================================================================
// summarizeCrossSourceDuplicates — pure helper
// =============================================================================

describe('summarizeCrossSourceDuplicates (Sprint 88A)', () => {
  it('1. empty candidate produces an empty summary', () => {
    const c = candidate();
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoAddresses).toEqual([]);
    expect(s.duplicateIoTags).toEqual([]);
    expect(s.duplicateEquipmentIds).toEqual([]);
  });

  it('2. ignores pending and rejected items', () => {
    const a = ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1')] });
    const b = ioCandidate({ id: 'io_b', sourceRefs: [ref('eplan-1')] });
    const c = candidate({ io: [a, b] });
    const state = acceptAll(c);
    state.ioCandidates['io_b'].decision = 'pending';
    expect(
      summarizeCrossSourceDuplicates(c, state).duplicateIoAddresses,
    ).toEqual([]);
    state.ioCandidates['io_b'].decision = 'rejected';
    expect(
      summarizeCrossSourceDuplicates(c, state).duplicateIoAddresses,
    ).toEqual([]);
  });

  it('3. does NOT emit when the duplicate is within a single sourceId', () => {
    const a = ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1', 1)] });
    const b = ioCandidate({ id: 'io_b', sourceRefs: [ref('csv-1', 2)] });
    const c = candidate({ io: [a, b] });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoAddresses).toEqual([]);
  });

  it('4. emits cross-source duplicate IO address (CSV + EPLAN claim same address)', () => {
    const a = ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1')] });
    const b = ioCandidate({ id: 'io_b', sourceRefs: [ref('eplan-1')] });
    const c = candidate({ io: [a, b] });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoAddresses).toHaveLength(1);
    const g = s.duplicateIoAddresses[0];
    expect(g.itemIds).toEqual(['io_a', 'io_b']);
    expect([...g.sourceIds].sort()).toEqual(['csv-1', 'eplan-1']);
  });

  it('5. normalizes case + leading-% variants for buildable addresses (canonical key)', () => {
    // `%I0.0` and `I0.0` (no leading %) and `%i0.0` (lowercase)
    // all collapse to the same canonical parsed-address key.
    const a = ioCandidate({
      id: 'io_a',
      address: '%I0.0',
      sourceRefs: [ref('csv-1')],
    });
    const b = ioCandidate({
      id: 'io_b',
      address: 'I0.0', // EPLAN-style without leading %
      sourceRefs: [ref('eplan-1')],
    });
    const c = candidate({ io: [a, b] });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoAddresses).toHaveLength(1);
  });

  it('6. does NOT treat tcecad:<...> as equivalent to %I0.0', () => {
    const a = ioCandidate({
      id: 'io_a',
      address: '%I0.0',
      sourceRefs: [ref('csv-1')],
    });
    const b = ioCandidate({
      id: 'io_b',
      address: 'tcecad:GVL.iSensor1',
      sourceRefs: [ref('tcecad-1')],
    });
    const c = candidate({ io: [a, b] });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoAddresses).toEqual([]);
  });

  it('7. does NOT treat PDF channel marker text as a PLC address', () => {
    const a = ioCandidate({
      id: 'io_a',
      address: '%I0.0',
      sourceRefs: [ref('csv-1')],
    });
    const b = ioCandidate({
      id: 'io_b',
      address: '%I1', // PDF channel marker — non-buildable
      sourceRefs: [
        { ...ref('pdf-1'), kind: 'pdf', path: 'plan.pdf', page: '24' },
      ],
    });
    const c = candidate({ io: [a, b] });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoAddresses).toEqual([]);
  });

  it('8. emits cross-source duplicate IO tag', () => {
    const a = ioCandidate({
      id: 'io_a',
      address: '%I0.0',
      label: 'PartPresent',
      sourceRefs: [ref('csv-1')],
    });
    const b = ioCandidate({
      id: 'io_b',
      address: '%I0.1',
      label: 'PartPresent',
      sourceRefs: [ref('eplan-1')],
    });
    const c = candidate({ io: [a, b] });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoTags).toHaveLength(1);
    const g = s.duplicateIoTags[0];
    expect(g.key).toBe('partpresent'); // case-insensitive
    expect([...g.sourceIds].sort()).toEqual(['csv-1', 'eplan-1']);
  });

  it('9. emits cross-source duplicate equipment id', () => {
    const a = equipmentCandidate({
      id: 'eq_b1',
      sourceRefs: [ref('csv-1')],
      ioBindings: {},
    });
    const b = equipmentCandidate({
      id: 'eq_b1',
      sourceRefs: [ref('eplan-1')],
      ioBindings: {},
    });
    const c = candidate({ equipment: [a, b] });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateEquipmentIds).toHaveLength(1);
    expect([...s.duplicateEquipmentIds[0].sourceIds].sort()).toEqual([
      'csv-1',
      'eplan-1',
    ]);
  });

  it('10. is deterministic across runs (same input → same output)', () => {
    const c = candidate({
      io: [
        ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1')] }),
        ioCandidate({ id: 'io_b', sourceRefs: [ref('eplan-1')] }),
        ioCandidate({
          id: 'io_c',
          address: '%I0.1',
          label: 'shared',
          sourceRefs: [ref('csv-1')],
        }),
        ioCandidate({
          id: 'io_d',
          address: '%I0.2',
          label: 'Shared',
          sourceRefs: [ref('eplan-1')],
        }),
      ],
    });
    const a = summarizeCrossSourceDuplicates(c, acceptAll(c));
    const b = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('11. group ordering is stable: sorted by key then by first item id', () => {
    const c = candidate({
      io: [
        ioCandidate({ id: 'io_z', address: '%Q0.0', sourceRefs: [ref('csv-1')] }),
        ioCandidate({ id: 'io_y', address: '%Q0.0', sourceRefs: [ref('eplan-1')] }),
        ioCandidate({ id: 'io_b', address: '%I0.0', sourceRefs: [ref('csv-1')] }),
        ioCandidate({ id: 'io_a', address: '%I0.0', sourceRefs: [ref('eplan-1')] }),
      ],
    });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoAddresses).toHaveLength(2);
    // %I0.0 (area=I|bit=0|byte=0) sorts before %Q0.0 (area=Q…)
    expect(s.duplicateIoAddresses[0].key).toContain('area=I');
    expect(s.duplicateIoAddresses[1].key).toContain('area=Q');
    // Inside each group itemIds are sorted alphabetically.
    expect(s.duplicateIoAddresses[0].itemIds).toEqual(['io_a', 'io_b']);
  });

  it('12. preserves a representative SourceRef per item in the group', () => {
    const a = ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1', 7)] });
    const b = ioCandidate({ id: 'io_b', sourceRefs: [ref('eplan-1', 11)] });
    const c = candidate({ io: [a, b] });
    const s = summarizeCrossSourceDuplicates(c, acceptAll(c));
    expect(s.duplicateIoAddresses).toHaveLength(1);
    expect(s.duplicateIoAddresses[0].sourceRefs).toHaveLength(2);
    const sources = s.duplicateIoAddresses[0].sourceRefs
      .map((r) => r.sourceId)
      .sort();
    expect(sources).toEqual(['csv-1', 'eplan-1']);
  });
});

// =============================================================================
// diagnoseCrossSourceDuplicates — diagnostic shape
// =============================================================================

describe('diagnoseCrossSourceDuplicates (Sprint 88A)', () => {
  it('1. happy path produces zero diagnostics', () => {
    const c = candidate({
      io: [ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1')] })],
    });
    expect(
      diagnoseCrossSourceDuplicates(
        summarizeCrossSourceDuplicates(c, acceptAll(c)),
      ),
    ).toEqual([]);
  });

  it('2. cross-source IO address group → ONE warning with sources + items', () => {
    // Distinct labels so the tag-duplicate code does not also fire.
    const c = candidate({
      io: [
        ioCandidate({ id: 'io_a', label: 'A', sourceRefs: [ref('csv-1')] }),
        ioCandidate({ id: 'io_b', label: 'B', sourceRefs: [ref('eplan-1')] }),
      ],
    });
    const diags = diagnoseCrossSourceDuplicates(
      summarizeCrossSourceDuplicates(c, acceptAll(c)),
    );
    expect(diags).toHaveLength(1);
    const d = diags[0];
    expect(d.code).toBe('PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS');
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('csv-1');
    expect(d.message).toContain('eplan-1');
    expect(d.message).toContain('io_a');
    expect(d.message).toContain('io_b');
    expect(d.sourceRefs).toBeDefined();
    expect(d.sourceRefs!.length).toBe(2);
  });

  it('3. equipment id cross-source group → warning with code', () => {
    const c = candidate({
      equipment: [
        equipmentCandidate({
          id: 'eq_b1',
          sourceRefs: [ref('csv-1')],
          ioBindings: {},
        }),
        equipmentCandidate({
          id: 'eq_b1',
          sourceRefs: [ref('eplan-1')],
          ioBindings: {},
        }),
      ],
    });
    const diags = diagnoseCrossSourceDuplicates(
      summarizeCrossSourceDuplicates(c, acceptAll(c)),
    );
    const eq = diags.find(
      (d) => d.code === 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_EQUIPMENT_ID',
    );
    expect(eq).toBeDefined();
    expect(eq?.severity).toBe('warning');
  });

  it('4. tag cross-source group → warning with normalised key', () => {
    const c = candidate({
      io: [
        ioCandidate({
          id: 'io_a',
          address: '%I0.0',
          label: 'PartPresent',
          sourceRefs: [ref('csv-1')],
        }),
        ioCandidate({
          id: 'io_b',
          address: '%I0.1',
          label: 'PartPresent',
          sourceRefs: [ref('eplan-1')],
        }),
      ],
    });
    const diags = diagnoseCrossSourceDuplicates(
      summarizeCrossSourceDuplicates(c, acceptAll(c)),
    );
    const tag = diags.find(
      (d) => d.code === 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_TAG',
    );
    expect(tag).toBeDefined();
    expect(tag?.message).toContain('"partpresent"');
  });
});

// =============================================================================
// buildPirFromReviewedCandidate — integration
// =============================================================================

describe('buildPirFromReviewedCandidate — Sprint 88A integration', () => {
  it('1. CSV + EPLAN-style cross-source duplicate IO address fires PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS', () => {
    const a = ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1')] });
    const b = ioCandidate({ id: 'io_b', sourceRefs: [ref('eplan-1')] });
    const c = candidate({ io: [a, b], equipment: [] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS',
      ),
    ).toBe(true);
    // Sprint 85 same-candidate duplicate warning still fires alongside.
    expect(
      r.diagnostics.some((d) => d.code === 'PIR_BUILD_DUPLICATE_IO_ADDRESS'),
    ).toBe(true);
  });

  it('2. same-source duplicate fires Sprint 85 warning but NOT cross-source', () => {
    const a = ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1')] });
    const b = ioCandidate({ id: 'io_b', sourceRefs: [ref('csv-1')] });
    const c = candidate({ io: [a, b], equipment: [] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(
      r.diagnostics.some((d) => d.code === 'PIR_BUILD_DUPLICATE_IO_ADDRESS'),
    ).toBe(true);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS',
      ),
    ).toBe(false);
  });

  it('3. valid CSV simple path still builds a PIR preview (no Sprint 88A regressions)', () => {
    const c = candidate({
      io: [ioCandidate({ id: 'io_a', sourceRefs: [ref('csv-1')] })],
      equipment: [
        equipmentCandidate({
          id: 'eq_b1',
          sourceRefs: [ref('csv-1')],
          ioBindings: { feedback: 'io_a' },
        }),
      ],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(r.pir).toBeDefined();
    expect(r.pir?.machines[0].io).toHaveLength(1);
  });

  it('4. TcECAD-style unbuildable address stays rejected; no cross-source coercion', () => {
    const a = ioCandidate({
      id: 'io_a',
      address: '%I0.0',
      sourceRefs: [ref('csv-1')],
    });
    const b = ioCandidate({
      id: 'io_b',
      address: 'tcecad:GVL.iSensor1',
      sourceRefs: [ref('tcecad-1')],
    });
    const c = candidate({ io: [a, b], equipment: [] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    // Sprint 76 contract preserved: TcECAD address is unbuildable.
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS',
      ),
    ).toBe(true);
    // No cross-source duplicate emitted because the keys differ
    // (parsed:area=I|bit=0|byte=0 vs raw:tcecad:gvl.isensor1).
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS',
      ),
    ).toBe(false);
  });

  it('5. cross-source equipment id fires its own diagnostic', () => {
    const a = equipmentCandidate({
      id: 'eq_b1',
      sourceRefs: [ref('csv-1')],
      ioBindings: {},
    });
    const b = equipmentCandidate({
      id: 'eq_b1',
      sourceRefs: [ref('eplan-1')],
      ioBindings: {},
    });
    const c = candidate({
      io: [ioCandidate({ id: 'io_x', sourceRefs: [ref('csv-1')] })],
      equipment: [a, b],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_EQUIPMENT_ID',
      ),
    ).toBe(true);
  });

  it('6. cross-source tag duplicate fires the dedicated tag code', () => {
    const a = ioCandidate({
      id: 'io_a',
      address: '%I0.0',
      label: 'PartPresent',
      sourceRefs: [ref('csv-1')],
    });
    const b = ioCandidate({
      id: 'io_b',
      address: '%I0.1',
      label: 'PartPresent',
      sourceRefs: [ref('eplan-1')],
    });
    const c = candidate({ io: [a, b], equipment: [] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_TAG',
      ),
    ).toBe(true);
  });
});
