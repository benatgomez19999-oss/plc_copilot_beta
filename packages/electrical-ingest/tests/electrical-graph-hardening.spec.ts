// Sprint 85 — electrical graph / PIR hardening v0.
//
// Tests the new pre-build hardening pass:
//   - `summarizeAcceptedGraph` (pure summary)
//   - `diagnoseHardenedGraph` (pure diagnostics)
//   - `buildPirFromReviewedCandidate` integration:
//     • root-cause diagnostics surface before per-item cascade
//     • existing gate semantics intact
//     • sourceMap traceability preserved
//     • TcECAD / PDF strict-address refusal preserved.

import { describe, expect, it } from 'vitest';

import {
  diagnoseHardenedGraph,
  summarizeAcceptedGraph,
} from '../src/mapping/electrical-graph-hardening.js';
import {
  buildPirFromReviewedCandidate,
  isReviewedCandidateReadyForPirBuild,
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
// Tiny fixture helpers (mirrors pir-builder.spec.ts)
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
  for (const io of c.io ?? [])
    state.ioCandidates[io.id] = { id: io.id, decision: 'accepted' };
  for (const eq of c.equipment ?? [])
    state.equipmentCandidates[eq.id] = { id: eq.id, decision: 'accepted' };
  for (const a of c.assumptions ?? [])
    state.assumptions[a.id] = { id: a.id, decision: 'accepted' };
  return state;
}

// =============================================================================
// summarizeAcceptedGraph
// =============================================================================

describe('summarizeAcceptedGraph (Sprint 85)', () => {
  it('1. happy path: accepted IO + equipment with valid binding', () => {
    const c = candidate();
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(Array.from(summary.acceptedIoIds)).toEqual(['io_plc_channel:%I0.0']);
    expect(Array.from(summary.acceptedEquipmentIds)).toEqual(['eq_device:B1']);
    expect(summary.buildableIoIds.has('io_plc_channel:%I0.0')).toBe(true);
    expect(summary.unbuildableAcceptedIoIds.size).toBe(0);
    expect(summary.equipmentReferences.get('eq_device:B1')).toEqual([
      'io_plc_channel:%I0.0',
    ]);
    expect(summary.orphanIoIds.size).toBe(0);
    expect(summary.orphanEquipmentIds.size).toBe(0);
  });

  it('2. accepted IO with TcECAD-style structured address is unbuildable', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })],
    });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(summary.unbuildableAcceptedIoIds.has('io_plc_channel:%I0.0')).toBe(
      true,
    );
    expect(summary.buildableIoIds.size).toBe(0);
  });

  it('3. equipment binding to missing IO id is classified', () => {
    const c = candidate({
      equipment: [
        equipmentCandidate({
          ioBindings: { feedback: 'io_does_not_exist' },
        }),
      ],
    });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(summary.equipmentMissingIoRefs.get('eq_device:B1')).toEqual([
      'io_does_not_exist',
    ]);
  });

  it('4. equipment binding to unaccepted IO is classified', () => {
    const c = candidate();
    const state = acceptAll(c);
    state.ioCandidates['io_plc_channel:%I0.0'].decision = 'rejected';
    const summary = summarizeAcceptedGraph(c, state);
    expect(summary.equipmentUnacceptedIoRefs.get('eq_device:B1')).toEqual([
      'io_plc_channel:%I0.0',
    ]);
  });

  it('5. equipment binding to unbuildable IO is classified', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })],
    });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(summary.equipmentUnbuildableIoRefs.get('eq_device:B1')).toEqual([
      'io_plc_channel:%I0.0',
    ]);
  });

  it('6. duplicate accepted IO addresses are grouped', () => {
    const a = ioCandidate({ id: 'io_a', address: '%I0.0', label: 'A' });
    const b = ioCandidate({ id: 'io_b', address: '%I0.0', label: 'B' });
    const c = candidate({ io: [a, b], equipment: [] });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(summary.duplicateIoAddressGroups.size).toBe(1);
    const ids = Array.from(summary.duplicateIoAddressGroups.values())[0];
    expect(ids).toEqual(['io_a', 'io_b']);
  });

  it('7. duplicate accepted IO tags/labels are grouped', () => {
    const a = ioCandidate({ id: 'io_a', address: '%I0.0', label: 'PartPresent' });
    const b = ioCandidate({ id: 'io_b', address: '%I0.1', label: 'PartPresent' });
    const c = candidate({ io: [a, b], equipment: [] });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(summary.duplicateIoTagGroups.size).toBe(1);
    const ids = Array.from(summary.duplicateIoTagGroups.values())[0];
    expect(ids).toEqual(['io_a', 'io_b']);
  });

  it('8. orphan IO (not referenced by any equipment) is classified', () => {
    const c = candidate({ equipment: [] });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(Array.from(summary.orphanIoIds)).toEqual(['io_plc_channel:%I0.0']);
  });

  it('9. orphan equipment (no buildable refs) is classified', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })], // unbuildable
    });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(Array.from(summary.orphanEquipmentIds)).toEqual(['eq_device:B1']);
  });
});

// =============================================================================
// diagnoseHardenedGraph
// =============================================================================

describe('diagnoseHardenedGraph (Sprint 85)', () => {
  it('1. happy path emits no hardening diagnostics', () => {
    const c = candidate();
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    expect(diagnoseHardenedGraph(c, summary)).toEqual([]);
  });

  it('2. unbuildable IO ref → PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO (warning)', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })],
    });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    const diags = diagnoseHardenedGraph(c, summary);
    const target = diags.find(
      (d) => d.code === 'PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO',
    );
    expect(target).toBeDefined();
    expect(target?.severity).toBe('warning');
    expect(target?.candidateId).toBe('eq_device:B1');
    expect(target?.sourceRefs).toEqual([REF]);
  });

  it('3. unaccepted IO ref → PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO (warning)', () => {
    const c = candidate();
    const state = acceptAll(c);
    state.ioCandidates['io_plc_channel:%I0.0'].decision = 'rejected';
    const summary = summarizeAcceptedGraph(c, state);
    const diags = diagnoseHardenedGraph(c, summary);
    expect(
      diags.some(
        (d) => d.code === 'PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO',
      ),
    ).toBe(true);
  });

  it('4. missing IO ref → PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO (error)', () => {
    const c = candidate({
      equipment: [
        equipmentCandidate({
          ioBindings: { feedback: 'io_does_not_exist' },
        }),
      ],
    });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    const diags = diagnoseHardenedGraph(c, summary);
    const target = diags.find(
      (d) => d.code === 'PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO',
    );
    expect(target).toBeDefined();
    expect(target?.severity).toBe('error');
  });

  it('5. duplicate IO address → ONE PIR_BUILD_DUPLICATE_IO_ADDRESS (warning)', () => {
    const a = ioCandidate({ id: 'io_a', address: '%I0.0' });
    const b = ioCandidate({ id: 'io_b', address: '%I0.0' });
    const c = candidate({ io: [a, b], equipment: [] });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    const diags = diagnoseHardenedGraph(c, summary);
    const dupes = diags.filter(
      (d) => d.code === 'PIR_BUILD_DUPLICATE_IO_ADDRESS',
    );
    expect(dupes).toHaveLength(1);
    expect(dupes[0].severity).toBe('warning');
  });

  it('6. duplicate IO tag → PIR_BUILD_DUPLICATE_IO_TAG (info)', () => {
    const a = ioCandidate({ id: 'io_a', address: '%I0.0', label: 'PartPresent' });
    const b = ioCandidate({ id: 'io_b', address: '%I0.1', label: 'PartPresent' });
    const c = candidate({ io: [a, b], equipment: [] });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    const diags = diagnoseHardenedGraph(c, summary);
    const tag = diags.find((d) => d.code === 'PIR_BUILD_DUPLICATE_IO_TAG');
    expect(tag).toBeDefined();
    expect(tag?.severity).toBe('info');
  });

  it('7. orphan IO emits ONE rolled-up info', () => {
    const c = candidate({ equipment: [] });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    const diags = diagnoseHardenedGraph(c, summary);
    const orphans = diags.filter(
      (d) => d.code === 'PIR_BUILD_ACCEPTED_IO_ORPHANED',
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].severity).toBe('info');
  });

  it('8. orphan equipment → PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED (warning)', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })], // unbuildable
    });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    const diags = diagnoseHardenedGraph(c, summary);
    const orphan = diags.find(
      (d) => d.code === 'PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED',
    );
    expect(orphan).toBeDefined();
    expect(orphan?.severity).toBe('warning');
  });

  it('9. all accepted IO unbuildable → PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING (warning)', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })],
      equipment: [],
    });
    const summary = summarizeAcceptedGraph(c, acceptAll(c));
    const diags = diagnoseHardenedGraph(c, summary);
    const target = diags.find(
      (d) => d.code === 'PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING',
    );
    expect(target).toBeDefined();
    expect(target?.severity).toBe('warning');
  });
});

// =============================================================================
// buildPirFromReviewedCandidate — integration
// =============================================================================

describe('buildPirFromReviewedCandidate — Sprint 85 hardening integration', () => {
  it('1. happy path still builds PIR exactly as before', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(r.pir).toBeDefined();
    expect(r.pir?.machines[0].io).toHaveLength(1);
    expect(r.pir?.machines[0].stations[0].equipment).toHaveLength(1);
    // Hardening pass produces no diagnostics on the happy path.
    expect(
      r.diagnostics.some((d) =>
        [
          'PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO',
          'PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO',
          'PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO',
          'PIR_BUILD_ACCEPTED_IO_ORPHANED',
          'PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED',
          'PIR_BUILD_DUPLICATE_IO_ADDRESS',
          'PIR_BUILD_DUPLICATE_IO_TAG',
          'PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING',
        ].includes(d.code),
      ),
    ).toBe(false);
  });

  it('2. TcECAD-style unsupported address → no PIR IO + root-cause + cascade', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    // Build refused (no PIR).
    expect(r.pir).toBeUndefined();
    // Root-cause diagnostic is emitted by the hardening pass.
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO',
      ),
    ).toBe(true);
    // Existing per-item cascade still fires.
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS',
      ),
    ).toBe(true);
    // No fake Siemens address synthesis.
    expect(r.pir).toBeUndefined();
  });

  it('3. equipment with missing IO ref produces precise root-cause diagnostic', () => {
    const c = candidate({
      equipment: [
        equipmentCandidate({
          ioBindings: { feedback: 'io_does_not_exist' },
        }),
      ],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    const root = r.diagnostics.find(
      (d) => d.code === 'PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO',
    );
    expect(root).toBeDefined();
    expect(root?.severity).toBe('error');
  });

  it('4. equipment with unaccepted IO ref produces precise root-cause diagnostic', () => {
    const c = candidate();
    const state = acceptAll(c);
    state.ioCandidates['io_plc_channel:%I0.0'].decision = 'rejected';
    const r = buildPirFromReviewedCandidate(c, state);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO',
      ),
    ).toBe(true);
  });

  it('5. duplicate IO address produces ONE warning, no unsafe merge', () => {
    const a = ioCandidate({ id: 'io_a', address: '%I0.0' });
    const b = ioCandidate({ id: 'io_b', address: '%I0.0' });
    const c = candidate({ io: [a, b], equipment: [] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    const dupes = r.diagnostics.filter(
      (d) => d.code === 'PIR_BUILD_DUPLICATE_IO_ADDRESS',
    );
    // Exactly ONE warning per duplicate group, never per pair.
    expect(dupes).toHaveLength(1);
    expect(dupes[0].severity).toBe('warning');
    // No silent merge: if the @plccopilot/pir schema validator
    // refuses duplicate addresses, the build refuses honestly
    // (both IO are still tracked in `acceptedInputCounts.io`).
    expect(r.acceptedInputCounts.io).toBe(2);
  });

  it('6. orphan IO emits one info diagnostic and still builds the IO', () => {
    const c = candidate({ equipment: [] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    const orphans = r.diagnostics.filter(
      (d) => d.code === 'PIR_BUILD_ACCEPTED_IO_ORPHANED',
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].severity).toBe('info');
    expect(r.pir?.machines[0].io).toHaveLength(1);
  });

  it('7. orphan equipment emits warning and is excluded from PIR', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })], // unbuildable
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    const orphan = r.diagnostics.find(
      (d) => d.code === 'PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED',
    );
    expect(orphan).toBeDefined();
    expect(r.pir).toBeUndefined();
  });

  it('8. all accepted items unbuildable → no PIR + clear NO_BUILDABLE_IO + EMPTY_ACCEPTED_INPUT', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })],
      equipment: [],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(r.pir).toBeUndefined();
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING',
      ),
    ).toBe(true);
    expect(
      r.diagnostics.some((d) => d.code === 'PIR_BUILD_EMPTY_ACCEPTED_INPUT'),
    ).toBe(true);
  });

  it('9. accepted-only behavior still excludes rejected items', () => {
    const a = ioCandidate({ id: 'io_a', address: '%I0.0' });
    const b = ioCandidate({ id: 'io_b', address: '%I0.1' });
    const c = candidate({ io: [a, b], equipment: [] });
    const state = acceptAll(c);
    state.ioCandidates['io_b'].decision = 'rejected';
    const r = buildPirFromReviewedCandidate(c, state);
    expect(r.pir?.machines[0].io).toHaveLength(1);
    expect(r.skippedInputCounts.rejected).toBe(1);
  });

  it('10. pending review state still blocks PIR builder', () => {
    const c = candidate();
    const state = acceptAll(c);
    state.ioCandidates['io_plc_channel:%I0.0'].decision = 'pending';
    expect(isReviewedCandidateReadyForPirBuild(c, state)).toBe(false);
    const r = buildPirFromReviewedCandidate(c, state);
    expect(r.pir).toBeUndefined();
    expect(
      r.diagnostics.some((d) => d.code === 'PIR_BUILD_REVIEW_NOT_READY'),
    ).toBe(true);
  });

  it('11. empty candidate still blocks PIR builder', () => {
    const c = candidate({ io: [], equipment: [], assumptions: [] });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(r.pir).toBeUndefined();
    expect(
      r.diagnostics.some((d) => d.code === 'PIR_BUILD_EMPTY_ACCEPTED_INPUT'),
    ).toBe(true);
  });

  it('12. sourceMap contains only created PIR objects', () => {
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    const ids = Object.keys(r.sourceMap);
    expect(ids.length).toBe(2); // 1 IO + 1 equipment
    for (const id of ids) {
      const isInPir =
        r.pir?.machines[0].io.some((s) => s.id === id) ||
        r.pir?.machines[0].stations[0].equipment.some((e) => e.id === id);
      expect(isInPir).toBe(true);
    }
  });

  it('13. sourceRefs preserved on hardening diagnostics for unbuildable accepted items', () => {
    const c = candidate({
      io: [ioCandidate({ address: 'GVL.iSensor1' })],
    });
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    const root = r.diagnostics.find(
      (d) => d.code === 'PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO',
    );
    expect(root?.sourceRefs).toBeDefined();
    expect(root?.sourceRefs?.length).toBeGreaterThan(0);
  });

  it('14. existing CSV happy path still builds (no Sprint 85 regressions)', () => {
    // Use a hand-built candidate that mirrors a clean CSV import.
    const c = candidate();
    const r = buildPirFromReviewedCandidate(c, acceptAll(c));
    expect(r.pir).toBeDefined();
    expect(r.pir?.machines[0].io).toHaveLength(1);
  });
});
