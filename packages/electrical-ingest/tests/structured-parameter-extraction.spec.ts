// Sprint 88M — structured XML parameter extraction across EPLAN
// XML and TcECAD XML. Mirror of Sprint 88L's CSV spec, exercising
// the shared `extractStructuredParameterDraft` helper and both
// ingestor sidecars. Hard rules pinned:
//
//   - structured-only: only <Parameter> / <SetpointBinding>
//     elements yield drafts; nothing is inferred from <Comment>,
//     <Description>, free text, or numeric values embedded in
//     unrelated attributes.
//   - numeric-only data types (int / dint / real); bool refused.
//   - only `speed_setpoint_out` role supported in v0.
//   - missing / unparseable required fields fire deterministic
//     diagnostics; the offending element is dropped.
//   - legacy XML without explicit <Parameter> / <SetpointBinding>
//     elements stays metadata-clean (no `parameterDraft` sidecar).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildPirDraftCandidate,
  buildPirFromReviewedCandidate,
  ingestEplanXml,
  ingestTcecadXml,
  type PirBuildReviewState,
  type PirDraftCandidate,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadFixture(name: string): string {
  return readFileSync(
    resolve(__dirname, 'fixtures', 'eplan', name),
    'utf-8',
  );
}

const EPLAN_FIXTURE = 'structured-parameters-eplan.xml';
const TCECAD_FIXTURE = 'structured-parameters-twincat.xml';
const EPLAN_LEGACY_FIXTURE = 'simple-eplan-export.xml';
const TCECAD_LEGACY_FIXTURE = 'twincat-ecad-import.xml';

const SOURCE_ID = 'xml:vfd-fixture';

function acceptAllFromCandidate(
  candidate: PirDraftCandidate,
): PirBuildReviewState {
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
  for (const a of candidate.assumptions) {
    state.assumptions[a.id] = { id: a.id, decision: 'accepted' };
  }
  for (const p of candidate.parameters ?? []) {
    state.parameterCandidates![p.id] = { id: p.id, decision: 'accepted' };
  }
  return state;
}

// =============================================================================
// EPLAN — structured Parameter + SetpointBinding extraction
// =============================================================================

describe('Sprint 88M — EPLAN structured parameter extraction', () => {
  it('1. <Parameter> element produces a numeric ParameterCandidate with SourceRef', () => {
    const result = ingestEplanXml({
      sourceId: SOURCE_ID,
      text: loadFixture(EPLAN_FIXTURE),
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
    expect(p.sourceRefs[0].kind).toBe('eplan');
    // Line number flows from the XML parser (1-based).
    expect(p.sourceRefs[0].line).toBeGreaterThan(0);
  });

  it('2. <SetpointBinding> element records equipment+role+parameter triple', () => {
    const result = ingestEplanXml({
      sourceId: SOURCE_ID,
      text: loadFixture(EPLAN_FIXTURE),
    });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.setpointBindings).toEqual({
      M01: { speed_setpoint_out: 'p_m01_speed' },
    });
  });

  it('3. buildPirDraftCandidate threads parameters and ioSetpointBindings onto the candidate', () => {
    const result = ingestEplanXml({
      sourceId: SOURCE_ID,
      text: loadFixture(EPLAN_FIXTURE),
    });
    const candidate = buildPirDraftCandidate(result.graph);
    expect(candidate.parameters?.length).toBe(1);
    expect(candidate.parameters![0].id).toBe('p_m01_speed');
    // Equipment candidate id mapping resolves the raw EPLAN tag
    // ("M01") against the candidate's `eq_device:m01` form via the
    // 88L raw-tag matcher. The bound role lands on the equipment.
    const motor = candidate.equipment.find(
      (e) => e.id.toLowerCase().includes('m01'),
    );
    expect(motor).toBeDefined();
    expect(motor!.ioSetpointBindings).toEqual({
      speed_setpoint_out: 'p_m01_speed',
    });
  });

  it('4. invalid <Parameter> shapes fire deterministic diagnostics', () => {
    // Bool data type — refused.
    const boolXml = `<?xml version="1.0"?><EplanProject>
      <Parameter id="p_lockout" dataType="bool" default="0"/>
    </EplanProject>`;
    const r1 = ingestEplanXml({ sourceId: SOURCE_ID, text: boolXml });
    expect(r1.graph.metadata.parameterDraft?.parameters).toEqual([]);
    expect(
      r1.graph.metadata.parameterDraft?.diagnostics.some(
        (d) => d.code === 'STRUCTURED_PARAMETER_METADATA_NOT_NUMERIC',
      ),
    ).toBe(true);

    // Missing default — refused.
    const missingDefaultXml = `<?xml version="1.0"?><EplanProject>
      <Parameter id="p_x" dataType="real"/>
    </EplanProject>`;
    const r2 = ingestEplanXml({ sourceId: SOURCE_ID, text: missingDefaultXml });
    expect(r2.graph.metadata.parameterDraft?.parameters).toEqual([]);
    expect(
      r2.graph.metadata.parameterDraft?.diagnostics.some(
        (d) => d.code === 'STRUCTURED_PARAMETER_DEFAULT_INVALID',
      ),
    ).toBe(true);

    // Missing id — refused.
    const noIdXml = `<?xml version="1.0"?><EplanProject>
      <Parameter dataType="real" default="50"/>
    </EplanProject>`;
    const r3 = ingestEplanXml({ sourceId: SOURCE_ID, text: noIdXml });
    expect(r3.graph.metadata.parameterDraft?.parameters).toEqual([]);
    expect(
      r3.graph.metadata.parameterDraft?.diagnostics.some(
        (d) => d.code === 'STRUCTURED_PARAMETER_METADATA_INCOMPLETE',
      ),
    ).toBe(true);
  });

  it('5. <SetpointBinding> with unsupported role surfaces STRUCTURED_SETPOINT_BINDING_ROLE_UNSUPPORTED and creates no binding', () => {
    const xml = `<?xml version="1.0"?><EplanProject>
      <Parameter id="p_x" dataType="real" default="50"/>
      <SetpointBinding equipmentId="M01" role="bogus_role" parameterId="p_x"/>
    </EplanProject>`;
    const result = ingestEplanXml({ sourceId: SOURCE_ID, text: xml });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.setpointBindings).toEqual({});
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'STRUCTURED_SETPOINT_BINDING_ROLE_UNSUPPORTED',
      ),
    ).toBe(true);
  });

  it('6. <SetpointBinding> with no parameterId surfaces STRUCTURED_SETPOINT_BINDING_PARAMETER_MISSING', () => {
    const xml = `<?xml version="1.0"?><EplanProject>
      <SetpointBinding equipmentId="M01" role="speed_setpoint_out"/>
    </EplanProject>`;
    const result = ingestEplanXml({ sourceId: SOURCE_ID, text: xml });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.setpointBindings).toEqual({});
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'STRUCTURED_SETPOINT_BINDING_PARAMETER_MISSING',
      ),
    ).toBe(true);
  });

  it('7. duplicate parameter ids keep the first occurrence and warn', () => {
    const xml = `<?xml version="1.0"?><EplanProject>
      <Parameter id="p_dup" dataType="real" default="10"/>
      <Parameter id="p_dup" dataType="real" default="20"/>
    </EplanProject>`;
    const result = ingestEplanXml({ sourceId: SOURCE_ID, text: xml });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.parameters.length).toBe(1);
    expect(draft!.parameters[0].defaultValue).toBe(10);
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'STRUCTURED_PARAMETER_DUPLICATE_ID',
      ),
    ).toBe(true);
  });

  it('8. legacy EPLAN XML (no <Parameter> / <SetpointBinding>) leaves metadata.parameterDraft undefined', () => {
    const result = ingestEplanXml({
      sourceId: SOURCE_ID,
      text: loadFixture(EPLAN_LEGACY_FIXTURE),
    });
    expect(result.graph.metadata.parameterDraft).toBeUndefined();
  });

  it('9. free-text comments mentioning numbers do NOT yield parameters', () => {
    // The fixture has an Element with label "M01 speed AW: nominal
    // 50 Hz at full load". That free-text 50 must NOT become a
    // parameter — only the explicit <Parameter id="p_m01_speed">
    // counts.
    const result = ingestEplanXml({
      sourceId: SOURCE_ID,
      text: loadFixture(EPLAN_FIXTURE),
    });
    const ids = result.graph.metadata.parameterDraft!.parameters.map((p) => p.id);
    expect(ids).toEqual(['p_m01_speed']);
  });
});

// =============================================================================
// TcECAD — structured Parameter + SetpointBinding extraction
// =============================================================================

describe('Sprint 88M — TcECAD structured parameter extraction', () => {
  it('1. <Parameter> element produces a numeric ParameterCandidate with TcECAD SourceRef', () => {
    const result = ingestTcecadXml({
      sourceId: SOURCE_ID,
      text: loadFixture(TCECAD_FIXTURE),
    });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft).toBeDefined();
    expect(draft!.parameters.length).toBe(1);
    const p = draft!.parameters[0];
    expect(p.id).toBe('p_m01_speed');
    expect(p.dataType).toBe('real');
    expect(p.defaultValue).toBe(50);
    expect(p.unit).toBe('Hz');
    expect(p.sourceRefs[0].sourceId).toBe(SOURCE_ID);
    expect(p.sourceRefs[0].kind).toBe('twincat_ecad');
  });

  it('2. <SetpointBinding> element records equipment+role+parameter triple', () => {
    const result = ingestTcecadXml({
      sourceId: SOURCE_ID,
      text: loadFixture(TCECAD_FIXTURE),
    });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft!.setpointBindings).toEqual({
      M01: { speed_setpoint_out: 'p_m01_speed' },
    });
  });

  it('3. legacy TcECAD XML (no <Parameter> / <SetpointBinding>) leaves metadata.parameterDraft undefined', () => {
    const result = ingestTcecadXml({
      sourceId: SOURCE_ID,
      text: loadFixture(TCECAD_LEGACY_FIXTURE),
    });
    expect(result.graph.metadata.parameterDraft).toBeUndefined();
  });

  it('4. <Variable> Comment mentioning "50 Hz" does NOT yield a parameter (no inference)', () => {
    const result = ingestTcecadXml({
      sourceId: SOURCE_ID,
      text: loadFixture(TCECAD_FIXTURE),
    });
    const ids = (result.graph.metadata.parameterDraft?.parameters ?? []).map(
      (p) => p.id,
    );
    // Only the explicit <Parameter id="p_m01_speed"> counts.
    expect(ids).toEqual(['p_m01_speed']);
  });

  it('5. invalid <Parameter> shapes fire the same generic STRUCTURED_* diagnostics as EPLAN', () => {
    // We share the helper, so the codes are uniform across sources.
    const xml = `<?xml version="1.0"?><Project>
      <Description>TcECAD Import V2.2.12</Description>
      <Parameter id="p_bad" dataType="bool" default="0"/>
    </Project>`;
    const result = ingestTcecadXml({ sourceId: SOURCE_ID, text: xml });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft).toBeDefined();
    expect(draft!.parameters).toEqual([]);
    expect(
      draft!.diagnostics.some(
        (d) => d.code === 'STRUCTURED_PARAMETER_METADATA_NOT_NUMERIC',
      ),
    ).toBe(true);
  });
});

// =============================================================================
// End-to-end — EPLAN review → PIR build with motor_vfd_simple
// =============================================================================

describe('Sprint 88M — buildPirFromReviewedCandidate (EPLAN structured fixture)', () => {
  // The EPLAN structured fixture uses a `kind="motor"` Element for
  // M01. To produce a `motor_vfd_simple` candidate, the operator
  // must declare the kind via the existing `motor_vfd_simple`
  // alias (Sprint 88L). We hand-craft a minimal candidate that
  // reflects what the operator's review accepts; the parameter
  // and binding flow through from the EPLAN sidecar.
  it('1. accept-all review with EPLAN parameterDraft populates machine.parameters + Equipment.io_setpoint_bindings', () => {
    const result = ingestEplanXml({
      sourceId: SOURCE_ID,
      text: loadFixture(EPLAN_FIXTURE),
    });
    const draft = result.graph.metadata.parameterDraft;
    expect(draft).toBeDefined();

    // Hand-craft a motor_vfd_simple candidate (the EPLAN device
    // path produces a `motor_simple` candidate by default; in a
    // real workflow the operator would correct the kind via review
    // UI before promoting). We mirror that step here.
    const candidate: PirDraftCandidate = {
      id: 'cand_88m_eplan',
      io: [
        {
          id: 'io_m01_run',
          address: '%Q0.0',
          signalType: 'bool',
          direction: 'output',
          sourceRefs: [{ sourceId: SOURCE_ID, kind: 'eplan', line: 1 }],
          confidence: { score: 0.9, reasons: ['test fixture'] },
        },
        {
          id: 'io_m01_speed_aw',
          address: '%QD100',
          signalType: 'real',
          direction: 'output',
          sourceRefs: [{ sourceId: SOURCE_ID, kind: 'eplan', line: 2 }],
          confidence: { score: 0.9, reasons: ['test fixture'] },
        },
      ],
      equipment: [
        {
          id: 'M01',
          kind: 'motor_vfd_simple',
          ioBindings: { drive: 'io_m01_run', drive_1: 'io_m01_speed_aw' },
          ioSetpointBindings: draft!.setpointBindings.M01,
          sourceRefs: [{ sourceId: SOURCE_ID, kind: 'eplan', line: 1 }],
          confidence: { score: 0.9, reasons: ['test fixture'] },
        },
      ],
      parameters: draft!.parameters,
      diagnostics: [],
      assumptions: [],
      sourceGraphId: result.graph.id,
    };

    const state = acceptAllFromCandidate(candidate);
    const built = buildPirFromReviewedCandidate(candidate, state);
    expect(built.pir).toBeDefined();
    const pir = built.pir!;
    const machine = pir.machines[0];
    expect(machine.parameters.length).toBe(1);
    expect(machine.parameters[0].data_type).toBe('real');
    expect(machine.parameters[0].default).toBe(50);
    expect(machine.parameters[0].unit).toBe('Hz');
    const eq = machine.stations[0].equipment[0];
    expect(eq.type).toBe('motor_vfd_simple');
    expect(eq.io_setpoint_bindings).toBeDefined();
    expect(eq.io_setpoint_bindings!.speed_setpoint_out).toBe(
      machine.parameters[0].id,
    );

    // No R-EQ-05 issues.
    const errors = built.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
  });
});
