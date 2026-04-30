// Sprint 88L — explicit-metadata parameter extraction from CSV,
// followed by a review→PIR build that yields a valid PIR where
// `motor_vfd_simple` carries
// `io_setpoint_bindings.speed_setpoint_out → <parameter id>`.
//
// Pipeline under test:
//
//   CSV bytes  ──ingestElectricalCsv──▶  ElectricalGraph
//                                        + graph.metadata.parameterDraft
//   Graph (or hand-crafted candidate) ─▶ PirDraftCandidate
//   Candidate  ──accept-all review───▶  PirBuildReviewState
//   State      ──buildPirFromReviewedCandidate─▶ Project (PIR-validated)
//
// Two surfaces exercised:
//   (a) CSV-side: `row_kind=parameter` + `row_kind=setpoint_binding`
//       rows produce `parameterDraft` on the graph, and a candidate
//       built from that graph carries a `parameters[]` entry plus
//       `ioSetpointBindings` on the matching equipment.
//   (b) Builder-side: a hand-crafted candidate (with explicit IO +
//       equipment + parameter — demonstrating the Sprint 88L surface
//       on its own, independent of the CSV's 1:1 device-per-row
//       constraint) flows cleanly through
//       `buildPirFromReviewedCandidate`, yielding a PIR with
//       `machine.parameters` + `equipment.io_setpoint_bindings` that
//       passes PIR validation including R-EQ-05.
//
// Hard rules pinned:
//   - parameters never synthesised; explicit metadata required;
//   - bindings only attach for accepted parameters;
//   - free-text comments do NOT yield parameters;
//   - SourceRef line numbers preserved end-to-end.

import { describe, expect, it } from 'vitest';

import {
  buildPirDraftCandidate,
  buildPirFromReviewedCandidate,
  confidenceOf,
  ingestElectricalCsv,
  type PirBuildReviewState,
  type PirDraftCandidate,
} from '../src/index.js';
import { validate as validatePirProject } from '@plccopilot/pir';

const SOURCE_ID = 'csv:vfd-fixture';

// ---------------------------------------------------------------------------
// CSV fixtures — minimal `row_kind` rows. The CSV here only contributes
// parameter + setpoint_binding rows; equipment + IO are hand-crafted in
// the candidate below (the existing CSV ingestor is 1:1 device/IO and
// can't cleanly express a single equipment with two outputs).
// ---------------------------------------------------------------------------

const HEADER =
  'row_kind,tag,kind,address,direction,data_type,role,parameter_id,default,unit,label';

function csvParameterAndBinding(): string {
  return [
    HEADER,
    'parameter,,,,,real,,p_m01_speed,50,Hz,M01 speed setpoint',
    'setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Hand-crafted draft candidate — represents a motor_vfd_simple equipment
// with two outputs (bool run_out + numeric speed_setpoint_out). Plumbing
// for `ioSetpointBindings` is supplied by the CSV-derived parameter
// draft.
// ---------------------------------------------------------------------------

function handcraftedVfdCandidate(): PirDraftCandidate {
  const ref = (line: number) => ({
    sourceId: SOURCE_ID,
    kind: 'csv' as const,
    line,
  });
  return {
    id: 'cand_88l',
    io: [
      {
        id: 'io_m01_run',
        address: '%Q0.0',
        signalType: 'bool',
        direction: 'output',
        label: 'M01 run',
        sourceRefs: [ref(2)],
        confidence: confidenceOf(0.9, 'test fixture'),
      },
      {
        id: 'io_m01_speed_aw',
        address: '%QD100',
        signalType: 'real',
        direction: 'output',
        label: 'M01 speed AW',
        sourceRefs: [ref(3)],
        confidence: confidenceOf(0.9, 'test fixture'),
      },
    ],
    equipment: [
      {
        id: 'mot01',
        kind: 'motor_vfd_simple',
        // The role-remap helper turns `drive` → first output slot
        // (`run_out`) and `drive_1` → second output slot
        // (`speed_setpoint_out`), matching `EQUIPMENT_ROLE_REMAP`.
        ioBindings: {
          drive: 'io_m01_run',
          drive_1: 'io_m01_speed_aw',
        },
        sourceRefs: [ref(1)],
        confidence: confidenceOf(0.9, 'test fixture'),
      },
    ],
    diagnostics: [],
    assumptions: [],
    sourceGraphId: 'graph_88l',
  };
}

function applyCsvDraftToCandidate(
  candidate: PirDraftCandidate,
  csvText: string,
): PirDraftCandidate {
  const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csvText });
  const draft = result.graph.metadata.parameterDraft;
  if (draft) {
    candidate.parameters = draft.parameters.map((p) => ({
      ...p,
      sourceRefs: [...p.sourceRefs],
    }));
    for (const [eqId, roleMap] of Object.entries(draft.setpointBindings)) {
      const eq = candidate.equipment.find((e) => e.id === eqId);
      if (!eq) continue;
      eq.ioSetpointBindings = { ...(eq.ioSetpointBindings ?? {}), ...roleMap };
    }
    // Pipe parameter-row diagnostics into the candidate (mirrors what
    // `buildPirDraftCandidate` does when consuming a graph).
    candidate.diagnostics.push(...draft.diagnostics);
  }
  return candidate;
}

function acceptAll(candidate: PirDraftCandidate): PirBuildReviewState {
  const state: PirBuildReviewState = {
    ioCandidates: {},
    equipmentCandidates: {},
    assumptions: {},
    parameterCandidates: {},
  };
  for (const io of candidate.io) {
    state.ioCandidates[io.id] = { id: io.id, decision: 'accepted' };
  }
  for (const eq of candidate.equipment) {
    state.equipmentCandidates[eq.id] = { id: eq.id, decision: 'accepted' };
  }
  for (const p of candidate.parameters ?? []) {
    state.parameterCandidates![p.id] = { id: p.id, decision: 'accepted' };
  }
  return state;
}

// =============================================================================
// (a) CSV-side surface — parameter + setpoint_binding row extraction.
// =============================================================================

describe('Sprint 88L — CSV row_kind=parameter / setpoint_binding extraction', () => {
  it('1. row_kind=parameter extracts a numeric ParameterCandidate with SourceRef', () => {
    const result = ingestElectricalCsv({
      sourceId: SOURCE_ID,
      text: csvParameterAndBinding(),
    });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft).toBeDefined();
    expect(draft!.parameters.length).toBe(1);
    const p = draft!.parameters[0];
    expect(p.id).toBe('p_m01_speed');
    expect(p.dataType).toBe('real');
    expect(p.defaultValue).toBe(50);
    expect(p.unit).toBe('Hz');
    expect(p.label).toBe('M01 speed setpoint');
    expect(p.sourceRefs[0].sourceId).toBe(SOURCE_ID);
    // Row 2 in the fixture (header is row 1).
    expect(p.sourceRefs[0].line).toBe(2);
  });

  it('2. row_kind=setpoint_binding records the equipment + role + parameter triple', () => {
    const result = ingestElectricalCsv({
      sourceId: SOURCE_ID,
      text: csvParameterAndBinding(),
    });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft).toBeDefined();
    expect(draft!.setpointBindings).toEqual({
      mot01: { speed_setpoint_out: 'p_m01_speed' },
    });
  });

  it('3. parameter row with data_type=bool fails extraction (numeric only — PIR R-EQ-05)', () => {
    const csv = [HEADER, 'parameter,,,,,bool,,p_lockout,0,,Lockout'].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.parameters).toEqual([]);
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'CSV_PARAMETER_METADATA_NOT_NUMERIC',
      ),
    ).toBe(true);
  });

  it('4. parameter row missing default fails extraction', () => {
    const csv = [HEADER, 'parameter,,,,,real,,p_m01_speed,,Hz,'].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.parameters).toEqual([]);
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'CSV_PARAMETER_METADATA_INCOMPLETE',
      ),
    ).toBe(true);
  });

  it('5. setpoint_binding with an unsupported role surfaces CSV_SETPOINT_BINDING_ROLE_UNSUPPORTED and creates no binding', () => {
    const csv = [
      HEADER,
      'parameter,,,,,real,,p_m01_speed,50,Hz,',
      'setpoint_binding,mot01,,,,,bogus_role,p_m01_speed,,,',
    ].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.setpointBindings).toEqual({});
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'CSV_SETPOINT_BINDING_ROLE_UNSUPPORTED',
      ),
    ).toBe(true);
  });

  it('6. setpoint_binding without parameter_id surfaces CSV_SETPOINT_BINDING_PARAMETER_MISSING', () => {
    const csv = [
      HEADER,
      'setpoint_binding,mot01,,,,,speed_setpoint_out,,,,',
    ].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.setpointBindings).toEqual({});
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'CSV_SETPOINT_BINDING_PARAMETER_MISSING',
      ),
    ).toBe(true);
  });

  it('7. duplicate parameter_id keeps the first occurrence and warns', () => {
    const csv = [
      HEADER,
      'parameter,,,,,real,,p_m01_speed,50,Hz,first',
      'parameter,,,,,real,,p_m01_speed,75,Hz,second',
    ].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.parameters.length).toBe(1);
    expect(draft!.parameters[0].defaultValue).toBe(50);
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'CSV_PARAMETER_DUPLICATE_ID',
      ),
    ).toBe(true);
  });

  it('8. free-text numeric comment on a device row does NOT yield a parameter (no inference)', () => {
    const csv = [
      HEADER,
      ',mot01,motor,,,,,,,,Conveyor motor: nominal speed 50 Hz',
    ].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    expect(result.graph.metadata.parameterDraft).toBeUndefined();
  });

  it('9. EPLAN/TcECAD-style legacy CSV (no row_kind=parameter rows) is a safe no-op', () => {
    // Sprint 88L is opt-in: when no parameter / binding rows are
    // present, the metadata sidecar stays absent so legacy graphs
    // and snapshots round-trip unchanged.
    const csv = [
      HEADER,
      ',B1,sensor,%I0.0,input,,,,,,Part present',
    ].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    expect(result.graph.metadata.parameterDraft).toBeUndefined();
    const candidate = buildPirDraftCandidate(result.graph);
    expect(candidate.parameters ?? []).toEqual([]);
    expect(
      candidate.diagnostics.some((d) =>
        d.code.startsWith('CSV_PARAMETER_'),
      ),
    ).toBe(false);
  });
});

// =============================================================================
// (b) Builder-side surface — accept-all review yields a valid PIR.
// =============================================================================

describe('Sprint 88L — buildPirFromReviewedCandidate (motor_vfd_simple end-to-end)', () => {
  it('1. accept-all review with parameter+binding produces PIR with machine.parameters + equipment.io_setpoint_bindings', () => {
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csvParameterAndBinding(),
    );
    const state = acceptAll(candidate);
    const built = buildPirFromReviewedCandidate(candidate, state);
    expect(built.pir).toBeDefined();
    const pir = built.pir!;
    const machine = pir.machines[0];
    expect(machine.parameters.length).toBe(1);
    const param = machine.parameters[0];
    expect(param.data_type).toBe('real');
    expect(param.default).toBe(50);
    expect(param.unit).toBe('Hz');
    const equipment = machine.stations[0].equipment[0];
    expect(equipment.type).toBe('motor_vfd_simple');
    expect(equipment.io_setpoint_bindings).toBeDefined();
    expect(equipment.io_setpoint_bindings!.speed_setpoint_out).toBe(
      param.id,
    );
  });

  it('2. happy build is clean of error diagnostics; PIR validation passes (R-EQ-05 satisfied)', () => {
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csvParameterAndBinding(),
    );
    const state = acceptAll(candidate);
    const built = buildPirFromReviewedCandidate(candidate, state);
    const errors = built.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    const report = validatePirProject(built.pir!);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.rule === 'R-EQ-05')).toEqual([]);
  });

  it('3. SourceMap export preserves the parameter SourceRef line under the canonical PIR id', () => {
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csvParameterAndBinding(),
    );
    const state = acceptAll(candidate);
    const built = buildPirFromReviewedCandidate(candidate, state);
    const pirParamId = built.pir!.machines[0].parameters[0].id;
    const refs = built.sourceMap[pirParamId];
    expect(refs).toBeDefined();
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].sourceId).toBe(SOURCE_ID);
    // The CSV parameter row landed on physical line 2 (header on line 1).
    expect(refs[0].line).toBe(2);
  });

  it('4. setpoint_binding without a matching parameter raises PIR_BUILD_SETPOINT_BINDING_REFERENCES_MISSING_PARAMETER and refuses the equipment', () => {
    // Equipment carries a binding to a parameter that was never
    // declared in the candidate (the parameter row is intentionally
    // absent). The builder refuses *the equipment* with the
    // dedicated diagnostic; the PIR may still build with the
    // accepted IO list, but the offending equipment is dropped.
    const candidate = handcraftedVfdCandidate();
    candidate.equipment[0].ioSetpointBindings = {
      speed_setpoint_out: 'p_does_not_exist',
    };
    const state = acceptAll(candidate);
    const built = buildPirFromReviewedCandidate(candidate, state);
    expect(
      built.diagnostics.some(
        (d) =>
          d.code ===
          'PIR_BUILD_SETPOINT_BINDING_REFERENCES_MISSING_PARAMETER',
      ),
    ).toBe(true);
    // The motor_vfd_simple equipment must NOT make it into the
    // built PIR — the binding error refused it.
    if (built.pir) {
      const equipmentTypes = built.pir.machines[0].stations[0].equipment.map(
        (e) => e.type,
      );
      expect(equipmentTypes).not.toContain('motor_vfd_simple');
    }
  });

  it('5. parameter pending review blocks the PIR build (PIR_BUILD_PARAMETER_CANDIDATE_PENDING)', () => {
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csvParameterAndBinding(),
    );
    const state = acceptAll(candidate);
    state.parameterCandidates![candidate.parameters![0].id] = {
      id: candidate.parameters![0].id,
      decision: 'pending',
    };
    const built = buildPirFromReviewedCandidate(candidate, state);
    expect(built.pir).toBeUndefined();
    expect(
      built.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_PARAMETER_CANDIDATE_PENDING',
      ),
    ).toBe(true);
  });

  it('6. rejected parameter raises PIR_BUILD_SETPOINT_BINDING_REFERENCES_UNACCEPTED_PARAMETER and refuses the equipment', () => {
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csvParameterAndBinding(),
    );
    const state = acceptAll(candidate);
    state.parameterCandidates![candidate.parameters![0].id] = {
      id: candidate.parameters![0].id,
      decision: 'rejected',
    };
    const built = buildPirFromReviewedCandidate(candidate, state);
    expect(
      built.diagnostics.some(
        (d) =>
          d.code ===
          'PIR_BUILD_SETPOINT_BINDING_REFERENCES_UNACCEPTED_PARAMETER',
      ),
    ).toBe(true);
    if (built.pir) {
      const equipmentTypes = built.pir.machines[0].stations[0].equipment.map(
        (e) => e.type,
      );
      expect(equipmentTypes).not.toContain('motor_vfd_simple');
    }
  });

  it('7. bool-typed parameter is refused by the builder with PIR_BUILD_ACCEPTED_PARAMETER_INVALID', () => {
    const candidate = handcraftedVfdCandidate();
    // Hand-construct a candidate parameter with a non-numeric data
    // type to bypass the CSV extractor's numeric-only filter (which
    // refuses bool at extraction time). The builder is the second
    // line of defence and must also refuse.
    candidate.parameters = [
      {
        id: 'p_lockout',
        dataType: 'int',
        defaultValue: 0,
        sourceRefs: [{ sourceId: SOURCE_ID, kind: 'csv', line: 99 }],
        confidence: confidenceOf(0.9, 'test'),
      },
    ];
    // Forcibly mutate to bool through the type system to exercise
    // the defensive branch.
    (
      candidate.parameters[0] as { dataType: string }
    ).dataType = 'bool';
    candidate.equipment[0].ioSetpointBindings = {
      speed_setpoint_out: 'p_lockout',
    };
    const state = acceptAll(candidate);
    const built = buildPirFromReviewedCandidate(candidate, state);
    expect(
      built.diagnostics.some(
        (d) => d.code === 'PIR_BUILD_ACCEPTED_PARAMETER_INVALID',
      ),
    ).toBe(true);
    // The bool parameter must NOT have landed in the PIR; either the
    // build was refused, or the parameter was dropped. In either
    // case the project's machine.parameters must not contain it.
    if (built.pir) {
      const paramIds = built.pir.machines[0].parameters.map((p) => p.id);
      expect(paramIds.some((id) => id.includes('p_lockout'))).toBe(false);
    }
  });
});
