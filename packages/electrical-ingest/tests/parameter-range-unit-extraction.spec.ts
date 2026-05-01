// Sprint 97 — explicit numeric bound (`min` / `max`) extraction
// from CSV `row_kind=parameter` rows and structured-XML
// `<Parameter>` elements, plus an end-to-end review→PIR-build
// path that surfaces R-PR-02 / R-PR-03 errors when the bounds
// (or unit) drift away from the v0 contract.
//
// Hard rules pinned by these tests:
//   - bounds never inferred from comments / descriptions / free
//     text; only explicit columns / attributes / child elements;
//   - unparseable / inverted / out-of-range bounds emit per-row
//     diagnostics and the offending bound is dropped while the
//     rest of the parameter is preserved;
//   - PIR-build forwards bounds verbatim into Parameter.min /
//     Parameter.max;
//   - R-PR-02 fires when default is outside an explicit range;
//   - R-PR-03 (B) fires when speed_setpoint_out parameter unit is
//     incompatible (rpm, %, …);
//   - missing unit on speed_setpoint_out surfaces an info, never
//     an error.

import { describe, expect, it } from 'vitest';

import {
  buildPirDraftCandidate,
  buildPirFromReviewedCandidate,
  confidenceOf,
  ingestElectricalCsv,
  ingestEplanXml,
  ingestTcecadXml,
  type PirBuildReviewState,
  type PirDraftCandidate,
} from '../src/index.js';
import { validate as validatePirProject } from '@plccopilot/pir';

const SOURCE_ID = 'csv:vfd-sprint97';

const HEADER =
  'row_kind,tag,kind,address,direction,data_type,role,parameter_id,default,unit,min,max,label';

function csvWith(rows: ReadonlyArray<string>): string {
  return [HEADER, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Hand-crafted vfd candidate — same shape used by Sprint 88L tests.
// ---------------------------------------------------------------------------

function handcraftedVfdCandidate(): PirDraftCandidate {
  const ref = (line: number) => ({
    sourceId: SOURCE_ID,
    kind: 'csv' as const,
    line,
  });
  return {
    id: 'cand_97',
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
    sourceGraphId: 'graph_97',
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
// 1. CSV — explicit bound extraction
// =============================================================================

describe('Sprint 97 — CSV parameter min/max extraction', () => {
  it('1. min + max columns flow into the candidate and PIR', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,50,Hz,0,60,M01 speed',
      'setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,,,',
    ]);
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft).toBeDefined();
    const p = draft!.parameters[0];
    expect(p.id).toBe('p_m01_speed');
    expect(p.min).toBe(0);
    expect(p.max).toBe(60);
    expect(p.unit).toBe('Hz');
  });

  it('2. min_value / max_value aliases extract identically to min / max', () => {
    const csv = [
      'row_kind,tag,kind,address,direction,data_type,role,parameter_id,default,unit,min_value,max_value,label',
      'parameter,,,,,real,,p_m01_speed,50,Hz,0,60,M01 speed',
    ].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const p = result.graph.metadata.parameterDraft!.parameters[0];
    expect(p.min).toBe(0);
    expect(p.max).toBe(60);
  });

  it('3. unparseable min drops the bound and emits CSV_PARAMETER_RANGE_INVALID', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,50,Hz,not-a-number,60,M01 speed',
    ]);
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft!;
    const p = draft.parameters[0];
    expect(p.min).toBeUndefined();
    expect(p.max).toBe(60);
    expect(
      draft.diagnostics.some(
        (d) =>
          d.code === 'CSV_PARAMETER_RANGE_INVALID' &&
          d.message.includes('min'),
      ),
    ).toBe(true);
  });

  it('4. unparseable max drops the bound and emits CSV_PARAMETER_RANGE_INVALID', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,50,Hz,0,xx,M01 speed',
    ]);
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft!;
    expect(draft.parameters[0].max).toBeUndefined();
    expect(draft.parameters[0].min).toBe(0);
    expect(
      draft.diagnostics.some(
        (d) =>
          d.code === 'CSV_PARAMETER_RANGE_INVALID' &&
          d.message.includes('max'),
      ),
    ).toBe(true);
  });

  it('5. inverted bounds (min > max) drop both and emit a range-invalid diagnostic', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,50,Hz,100,0,M01 speed',
    ]);
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const draft = result.graph.metadata.parameterDraft!;
    expect(draft.parameters[0].min).toBeUndefined();
    expect(draft.parameters[0].max).toBeUndefined();
    expect(
      draft.diagnostics.some(
        (d) =>
          d.code === 'CSV_PARAMETER_RANGE_INVALID' &&
          d.message.includes('greater'),
      ),
    ).toBe(true);
  });

  it('6. default below min emits CSV_PARAMETER_DEFAULT_OUT_OF_RANGE', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,-5,Hz,0,60,M01 speed',
    ]);
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const diags = result.graph.metadata.parameterDraft!.diagnostics;
    expect(
      diags.some(
        (d) =>
          d.code === 'CSV_PARAMETER_DEFAULT_OUT_OF_RANGE' &&
          d.message.includes('below'),
      ),
    ).toBe(true);
  });

  it('7. default above max emits CSV_PARAMETER_DEFAULT_OUT_OF_RANGE', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,200,Hz,0,60,M01 speed',
    ]);
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const diags = result.graph.metadata.parameterDraft!.diagnostics;
    expect(
      diags.some(
        (d) =>
          d.code === 'CSV_PARAMETER_DEFAULT_OUT_OF_RANGE' &&
          d.message.includes('above'),
      ),
    ).toBe(true);
  });

  it('8. legacy CSV without min / max columns extracts cleanly (backwards compat)', () => {
    const csv = [
      'row_kind,tag,kind,address,direction,data_type,role,parameter_id,default,unit,label',
      'parameter,,,,,real,,p_m01_speed,50,Hz,M01 speed',
    ].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const p = result.graph.metadata.parameterDraft!.parameters[0];
    expect(p.min).toBeUndefined();
    expect(p.max).toBeUndefined();
    expect(p.defaultValue).toBe(50);
  });

  it('9. free-text comment number is NOT parsed as min', () => {
    // The CSV ingestor only reads explicit columns. A "min=10"
    // hint embedded in the comment column must not bleed into
    // `min` / `max`.
    const csvHeader =
      'row_kind,tag,kind,address,direction,data_type,role,parameter_id,default,unit,comment,label';
    const csv = [
      csvHeader,
      'parameter,,,,,real,,p_m01_speed,50,Hz,operator note: min=10 max=80,M01 speed',
    ].join('\n');
    const result = ingestElectricalCsv({ sourceId: SOURCE_ID, text: csv });
    const p = result.graph.metadata.parameterDraft!.parameters[0];
    expect(p.min).toBeUndefined();
    expect(p.max).toBeUndefined();
  });
});

// =============================================================================
// 2. Structured XML — EPLAN attribute style + TcECAD child-element style
// =============================================================================

describe('Sprint 97 — structured XML parameter min/max extraction', () => {
  it('10. EPLAN attribute-style min / max flows into the candidate', () => {
    const xml = `<?xml version="1.0"?>
<EplanProject>
  <Parameter id="p_m01_speed" dataType="real" default="50" unit="Hz" min="0" max="60" />
</EplanProject>`;
    const r = ingestEplanXml({ sourceId: 'eplan:test', text: xml });
    const p = r.graph.metadata.parameterDraft!.parameters[0];
    expect(p.id).toBe('p_m01_speed');
    expect(p.min).toBe(0);
    expect(p.max).toBe(60);
    expect(p.unit).toBe('Hz');
  });

  it('11. TcECAD child-element-style min / max flows in', () => {
    const xml = `<?xml version="1.0"?>
<TcecadProject>
  <Parameter>
    <Id>p_m01_speed</Id>
    <DataType>real</DataType>
    <Default>50</Default>
    <Unit>Hz</Unit>
    <Min>0</Min>
    <Max>60</Max>
  </Parameter>
</TcecadProject>`;
    const r = ingestTcecadXml({
      sourceId: 'tcecad:test',
      text: xml,
    });
    const p = r.graph.metadata.parameterDraft!.parameters[0];
    expect(p.min).toBe(0);
    expect(p.max).toBe(60);
  });

  it('12. invalid min in EPLAN drops the bound + emits STRUCTURED_PARAMETER_RANGE_INVALID', () => {
    const xml = `<?xml version="1.0"?>
<EplanProject>
  <Parameter id="p_m01_speed" dataType="real" default="50" unit="Hz" min="not-a-number" max="60" />
</EplanProject>`;
    const r = ingestEplanXml({ sourceId: 'eplan:test', text: xml });
    const draft = r.graph.metadata.parameterDraft!;
    expect(draft.parameters[0].min).toBeUndefined();
    expect(draft.parameters[0].max).toBe(60);
    expect(
      draft.diagnostics.some(
        (d) => d.code === 'STRUCTURED_PARAMETER_RANGE_INVALID',
      ),
    ).toBe(true);
  });

  it('13. inverted bounds in TcECAD drop both + emit range-invalid', () => {
    const xml = `<?xml version="1.0"?>
<TcecadProject>
  <Parameter>
    <Id>p_m01_speed</Id>
    <DataType>real</DataType>
    <Default>50</Default>
    <Unit>Hz</Unit>
    <Min>100</Min>
    <Max>0</Max>
  </Parameter>
</TcecadProject>`;
    const r = ingestTcecadXml({
      sourceId: 'tcecad:test',
      text: xml,
    });
    const draft = r.graph.metadata.parameterDraft!;
    expect(draft.parameters[0].min).toBeUndefined();
    expect(draft.parameters[0].max).toBeUndefined();
    expect(
      draft.diagnostics.some(
        (d) =>
          d.code === 'STRUCTURED_PARAMETER_RANGE_INVALID' &&
          d.message.includes('greater'),
      ),
    ).toBe(true);
  });

  it('14. legacy EPLAN without min / max attributes extracts cleanly', () => {
    const xml = `<?xml version="1.0"?>
<EplanProject>
  <Parameter id="p_m01_speed" dataType="real" default="50" unit="Hz" />
</EplanProject>`;
    const r = ingestEplanXml({ sourceId: 'eplan:test', text: xml });
    const p = r.graph.metadata.parameterDraft!.parameters[0];
    expect(p.min).toBeUndefined();
    expect(p.max).toBeUndefined();
  });

  it('15. no inference from <Description> / <Comment> with embedded numbers', () => {
    const xml = `<?xml version="1.0"?>
<EplanProject>
  <Parameter id="p_m01_speed" dataType="real" default="50" unit="Hz">
    <Description>operator note: min=10 max=80</Description>
    <Comment>this is a hint about the bounds</Comment>
  </Parameter>
</EplanProject>`;
    const r = ingestEplanXml({ sourceId: 'eplan:test', text: xml });
    const p = r.graph.metadata.parameterDraft!.parameters[0];
    expect(p.min).toBeUndefined();
    expect(p.max).toBeUndefined();
  });
});

// =============================================================================
// 3. End-to-end CSV → review → PIR build
// =============================================================================

describe('Sprint 97 — end-to-end CSV → PIR with explicit min / max', () => {
  it('16. happy path: min / max flow into PIR Parameter and validation passes', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,50,Hz,0,60,M01 speed',
      'setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,,,',
    ]);
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csv,
    );
    const state = acceptAll(candidate);
    const result = buildPirFromReviewedCandidate(candidate, state, {
      projectId: 'p_e2e',
      projectName: 'e2e',
      machineId: 'm_e2e',
      machineName: 'm',
      stationId: 'st_e2e',
      stationName: 'st',
    });
    expect(result.pir).toBeDefined();
    if (!result.pir) return;
    const param = result.pir.machines[0].parameters.find(
      (p) => p.id.includes('m01_speed'),
    )!;
    expect(param.min).toBe(0);
    expect(param.max).toBe(60);
    expect(param.unit).toBe('Hz');
    const report = validatePirProject(result.pir);
    const errs = report.issues.filter((i) => i.severity === 'error');
    expect(errs, JSON.stringify(errs, null, 2)).toEqual([]);
  });

  it('17. default outside CSV-declared range → R-PR-02 error on PIR validate', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,200,Hz,0,60,M01 speed',
      'setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,,,',
    ]);
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csv,
    );
    const state = acceptAll(candidate);
    const result = buildPirFromReviewedCandidate(candidate, state, {
      projectId: 'p_e2e',
      projectName: 'e2e',
      machineId: 'm_e2e',
      machineName: 'm',
      stationId: 'st_e2e',
      stationName: 'st',
    });
    // Builder may either refuse the PIR (out-of-range default
    // hard-fails Zod refine elsewhere) or produce one that
    // validatePirProject rejects with R-PR-02. Either way an error
    // surfaces — diagnostically or via the absent pir.
    if (result.pir) {
      const report = validatePirProject(result.pir);
      expect(
        report.issues.some(
          (i) => i.rule === 'R-PR-02' && i.severity === 'error',
        ),
      ).toBe(true);
    } else {
      expect(
        result.diagnostics.some(
          (d) => d.severity === 'error',
        ),
      ).toBe(true);
    }
  });

  it('18. unit "rpm" on speed_setpoint_out → R-PR-03 error on PIR validate', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,1500,rpm,0,3000,M01 speed',
      'setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,,,',
    ]);
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csv,
    );
    const state = acceptAll(candidate);
    const result = buildPirFromReviewedCandidate(candidate, state, {
      projectId: 'p_e2e',
      projectName: 'e2e',
      machineId: 'm_e2e',
      machineName: 'm',
      stationId: 'st_e2e',
      stationName: 'st',
    });
    if (result.pir) {
      const report = validatePirProject(result.pir);
      expect(
        report.issues.some(
          (i) =>
            i.rule === 'R-PR-03' &&
            i.severity === 'error' &&
            i.message.includes('rpm'),
        ),
      ).toBe(true);
    } else {
      expect(
        result.diagnostics.some((d) => d.severity === 'error'),
      ).toBe(true);
    }
  });

  it('19. missing unit on speed_setpoint_out → info diagnostic, not error', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,50,,0,60,M01 speed',
      'setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,,,',
    ]);
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csv,
    );
    const state = acceptAll(candidate);
    const result = buildPirFromReviewedCandidate(candidate, state, {
      projectId: 'p_e2e',
      projectName: 'e2e',
      machineId: 'm_e2e',
      machineName: 'm',
      stationId: 'st_e2e',
      stationName: 'st',
    });
    expect(result.pir).toBeDefined();
    if (!result.pir) return;
    const report = validatePirProject(result.pir);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-PR-03' && i.severity === 'error',
      ),
    ).toBe(false);
    expect(
      report.issues.some(
        (i) => i.rule === 'R-PR-03' && i.severity === 'info',
      ),
    ).toBe(true);
  });

  it('20. removing min / max entirely from a previously-bounded fixture still validates clean', () => {
    const csv = csvWith([
      'parameter,,,,,real,,p_m01_speed,50,Hz,,,M01 speed',
      'setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,,,',
    ]);
    const candidate = applyCsvDraftToCandidate(
      handcraftedVfdCandidate(),
      csv,
    );
    const state = acceptAll(candidate);
    const result = buildPirFromReviewedCandidate(candidate, state, {
      projectId: 'p_e2e',
      projectName: 'e2e',
      machineId: 'm_e2e',
      machineName: 'm',
      stationId: 'st_e2e',
      stationName: 'st',
    });
    expect(result.pir).toBeDefined();
    if (!result.pir) return;
    const param = result.pir.machines[0].parameters.find(
      (p) => p.id.includes('m01_speed'),
    )!;
    expect(param.min).toBeUndefined();
    expect(param.max).toBeUndefined();
    const report = validatePirProject(result.pir);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

// silence the unused buildPirDraftCandidate import so the file
// stays self-contained for future graph-driven tests.
void buildPirDraftCandidate;
