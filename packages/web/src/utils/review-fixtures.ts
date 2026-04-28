// Sprint 75 — stable fixtures for the electrical-review panel.
// Used by tests AND by the React components in dev-mode preview.
// The shape is exactly `PirDraftCandidate` so consumers don't need
// adapters; the values are picked to exercise every UX branch:
//
//   - sensor IO from CSV (input, %I0.0)            — high confidence
//   - valve IO from EPLAN XML (output, %Q0.0)      — high confidence, with XML locator
//   - motor IO + equipment from EPLAN XML (%Q0.1)  — high confidence
//   - unknown-kind device                          — low confidence, becomes assumption
//   - duplicate-address warning diagnostic         — non-blocking
//   - one diagnostic with severity error           — blocking
//
// All confidence scores + reasons + source refs are deterministic
// so the snapshot-style tests are stable.

import type {
  Confidence,
  PirDraftCandidate,
  PirEquipmentCandidate,
  PirIoCandidate,
  PirMappingAssumption,
  SourceRef,
} from '@plccopilot/electrical-ingest';

const CSV_REF: SourceRef = {
  sourceId: 'simple-csv',
  kind: 'csv',
  path: 'simple-electrical-list.csv',
  line: 2,
  rawId: 'B1',
  sheet: '=A1/12',
};

const EPLAN_VALVE_REF: SourceRef = {
  sourceId: 'simple-eplan',
  kind: 'eplan',
  path: 'simple-eplan-export.xml',
  line: 18,
  rawId: 'Y1',
  sheet: '=A1/13',
  symbol: '/EplanProject[1]/Pages[1]/Page[2]/Element[1]',
};

const EPLAN_MOTOR_REF: SourceRef = {
  sourceId: 'simple-eplan',
  kind: 'eplan',
  path: 'simple-eplan-export.xml',
  line: 24,
  rawId: 'M1',
  sheet: '=A1/14',
  symbol: '/EplanProject[1]/Pages[1]/Page[3]/Element[1]',
};

const UNKNOWN_REF: SourceRef = {
  sourceId: 'ambiguous-eplan',
  kind: 'eplan-export',
  path: 'ambiguous-eplan-export.xml',
  line: 12,
  rawId: 'M9',
  sheet: '=A1/04',
  symbol: '/ElectricalProject[1]/Pages[1]/Page[4]/Element[1]',
};

function highConfidence(reason: string): Confidence {
  return { score: 0.85, reasons: [reason] };
}
function mediumConfidence(reason: string): Confidence {
  return { score: 0.65, reasons: [reason] };
}
function lowConfidence(reason: string): Confidence {
  return { score: 0.35, reasons: [reason] };
}

const SENSOR_IO: PirIoCandidate = {
  id: 'io_plc_channel:%I0.0',
  address: '%I0.0',
  signalType: 'bool',
  direction: 'input',
  label: 'Part present',
  sourceRefs: [CSV_REF],
  confidence: highConfidence('csv: address %I0.0 → siemens input'),
};

const VALVE_IO: PirIoCandidate = {
  id: 'io_plc_channel:%Q0.0',
  address: '%Q0.0',
  signalType: 'bool',
  direction: 'output',
  label: 'Cylinder extend',
  sourceRefs: [EPLAN_VALVE_REF],
  confidence: highConfidence('eplan-xml: address %Q0.0 → siemens output'),
};

const MOTOR_IO: PirIoCandidate = {
  id: 'io_plc_channel:%Q0.1',
  address: '%Q0.1',
  signalType: 'bool',
  direction: 'output',
  label: 'Conveyor motor',
  sourceRefs: [EPLAN_MOTOR_REF],
  confidence: mediumConfidence('eplan-xml: address %Q0.1 → siemens output'),
};

const VALVE_EQUIPMENT: PirEquipmentCandidate = {
  id: 'eq_device:Y1',
  kind: 'valve_solenoid',
  ioBindings: { drive: VALVE_IO.id },
  sourceRefs: [EPLAN_VALVE_REF],
  confidence: highConfidence('eplan-xml: kind=valve → valve_solenoid'),
};

const MOTOR_EQUIPMENT: PirEquipmentCandidate = {
  id: 'eq_device:M1',
  kind: 'motor_simple',
  ioBindings: { drive: MOTOR_IO.id },
  sourceRefs: [EPLAN_MOTOR_REF],
  confidence: mediumConfidence('eplan-xml: kind=motor → motor_simple'),
};

const UNKNOWN_ASSUMPTION: PirMappingAssumption = {
  id: 'assum_device:M9',
  message:
    'device "M9" (kind="mystery_box") was tentatively classified as unknown — review required.',
  confidence: lowConfidence('eplan-xml: kind=mystery_box; capped'),
  sourceRefs: [UNKNOWN_REF],
};

/**
 * The canonical fixture used by tests and the dev-mode preview.
 * Frozen so consumers can rely on identity equality and stable
 * keys.
 */
export const SAMPLE_REVIEW_CANDIDATE: PirDraftCandidate = Object.freeze({
  id: 'review-fixture:0.1.0',
  name: 'review-fixture',
  io: [SENSOR_IO, VALVE_IO, MOTOR_IO],
  equipment: [VALVE_EQUIPMENT, MOTOR_EQUIPMENT],
  assumptions: [UNKNOWN_ASSUMPTION],
  diagnostics: [
    {
      code: 'CSV_DUPLICATE_ADDRESS',
      severity: 'warning',
      message:
        'PLC channel %Q0.0 is referenced by 2 devices (eq_device:Y1, eq_device:M3). Review against the schematic.',
      hint: 'shared inputs are legitimate but suspicious.',
      nodeId: 'plc_channel:%Q0.0',
    },
    {
      code: 'EPLAN_XML_UNKNOWN_KIND',
      severity: 'warning',
      message:
        'EPLAN XML element "M9" at line 12 has unknown kind "mystery_box".',
      sourceRef: UNKNOWN_REF,
      hint: 'recognised kinds: actuator, cable, motor, plc, ...',
    },
    {
      code: 'EPLAN_XML_MISSING_DEVICE_TAG',
      severity: 'error',
      message:
        'EPLAN XML element at /ElectricalProject[1]/Pages[1]/Page[1]/Element[1] (line 8) has no tag — element skipped.',
    },
  ],
  sourceGraphId: 'electrical_csv:simple+electrical_eplan_xml:simple',
} as PirDraftCandidate);

/**
 * Empty fixture — the panel must render without errors when there
 * is nothing to review yet (e.g. before any source has been
 * ingested).
 */
export const EMPTY_REVIEW_CANDIDATE: PirDraftCandidate = Object.freeze({
  id: 'review-fixture:empty',
  io: [],
  equipment: [],
  assumptions: [],
  diagnostics: [],
  sourceGraphId: '',
} as PirDraftCandidate);
