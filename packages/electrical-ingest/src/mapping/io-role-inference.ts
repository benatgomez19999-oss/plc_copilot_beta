// Sprint 72 — heuristic role inference for IO and equipment. These
// helpers run on a single ElectricalNode at a time and return
// candidate roles + a confidence + the evidence list that produced
// the score. They never write back into the graph; they're inputs
// to `buildPirDraftCandidate`.
//
// Sprint 72 ships *deterministic, naming-based* heuristics. Future
// sprints can add stronger signals (wired-to topology, IEC 61346
// device classes from EPLAN structure aspects, etc.) — and the
// design here keeps the evidence list extensible.

import { confidenceFromEvidence, confidenceOf } from '../confidence.js';
import { detectPlcAddress } from '../normalize.js';
import type {
  Confidence,
  ElectricalNode,
  Evidence,
  PirEquipmentCandidate,
  PirIoCandidate,
} from '../types.js';

// ---------------------------------------------------------------------------
// IO role
// ---------------------------------------------------------------------------

export interface InferredIoRole {
  direction: PirIoCandidate['direction'];
  signalType: PirIoCandidate['signalType'];
  address?: string;
  confidence: Confidence;
}

/**
 * Infer IO role from a `plc_channel` node. Looks at:
 *   - the address attribute (Siemens %I0.0 / Codesys %IX0.0 / etc.)
 *   - the label / name when it contains direction hints (DI / DO,
 *     "input"/"output", "_in"/"_out", "I/O" markers)
 *
 * Returns `direction='unknown'` when nothing matches — does NOT
 * default to 'input', because a silent default would invent IO.
 */
export function inferIoRole(node: ElectricalNode): InferredIoRole {
  const evidences: Evidence[] = [];
  let direction: PirIoCandidate['direction'] = 'unknown';
  let signalType: PirIoCandidate['signalType'] = 'unknown';
  let address: string | undefined;

  const addr =
    node.attributes &&
    typeof node.attributes['address'] === 'string'
      ? (node.attributes['address'] as string)
      : node.label;
  const detected = detectPlcAddress(addr);
  if (detected) {
    address = detected.raw;
    direction = detected.direction;
    // Heuristic: bit-addressed I/Q channels are bool; word/dword
    // addresses (W/D suffixed) imply int/real respectively.
    if (/[BWD]\d+$/i.test(detected.raw) || /\.\d+$/.test(detected.raw) === false) {
      const tail = detected.raw.match(/[XBWD]/i)?.[0]?.toUpperCase();
      if (tail === 'X' || /\.\d+$/.test(detected.raw)) signalType = 'bool';
      else if (tail === 'W') signalType = 'int';
      else if (tail === 'D') signalType = 'real';
    } else {
      signalType = 'bool';
    }
    evidences.push({
      source: 'plc-address',
      score: 0.85,
      reason: `address ${detected.raw} (${detected.family}, direction=${detected.direction})`,
      weight: 1,
    });
  }

  const labelLower = (node.label ?? '').toLowerCase();
  if (
    /\b(input|di\d|input_|_in\b|in_)/.test(labelLower) &&
    direction === 'unknown'
  ) {
    direction = 'input';
    evidences.push({
      source: 'label-pattern',
      score: 0.5,
      reason: `label ${JSON.stringify(node.label)} suggests an input`,
    });
  } else if (
    /\b(output|do\d|output_|_out\b|out_)/.test(labelLower) &&
    direction === 'unknown'
  ) {
    direction = 'output';
    evidences.push({
      source: 'label-pattern',
      score: 0.5,
      reason: `label ${JSON.stringify(node.label)} suggests an output`,
    });
  }

  if (evidences.length === 0) {
    evidences.push({
      source: 'no-evidence',
      score: 0,
      reason: 'no PLC address / no directional label keyword',
    });
  }

  return {
    direction,
    signalType,
    address,
    confidence: confidenceFromEvidence(evidences),
  };
}

// ---------------------------------------------------------------------------
// Equipment role
// ---------------------------------------------------------------------------

const SENSOR_LABEL_PATTERNS = [
  /\b(sensor|sens|prox|pressostat|switch|limit)\b/i,
  /\b(s\d+|b\d+)\b/,
];
const MOTOR_LABEL_PATTERNS = [/\b(motor|drive|mtr|m\d+|kf\d+)\b/i];
const VALVE_LABEL_PATTERNS = [/\b(valve|sov|solenoid|ev\d+|y\d+)\b/i];
const CYLINDER_LABEL_PATTERNS = [/\b(cylinder|cyl|piston|c\d+)\b/i];

export interface InferredEquipmentRole {
  kind: PirEquipmentCandidate['kind'];
  confidence: Confidence;
}

/**
 * Infer the equipment kind from a node. Looks at:
 *   - the explicit `kind` field if it's already a known equipment
 *     class (sensor / motor / valve)
 *   - label patterns (case-insensitive)
 *   - tags (exact match against well-known IEC 61346 classes if
 *     present)
 *
 * Returns `kind='unknown'` and a low-confidence Confidence when
 * nothing matches — the caller should then emit an
 * `UNKNOWN_DEVICE_ROLE` diagnostic.
 */
export function inferEquipmentRole(node: ElectricalNode): InferredEquipmentRole {
  const evidences: Evidence[] = [];

  if (node.kind === 'sensor') {
    evidences.push({
      source: 'graph-kind',
      score: 0.9,
      reason: 'node.kind == sensor',
    });
    return {
      kind: 'sensor_discrete',
      confidence: confidenceFromEvidence(evidences),
    };
  }
  if (node.kind === 'motor') {
    evidences.push({
      source: 'graph-kind',
      score: 0.9,
      reason: 'node.kind == motor',
    });
    return {
      kind: 'motor_simple',
      confidence: confidenceFromEvidence(evidences),
    };
  }
  if (node.kind === 'valve') {
    evidences.push({
      source: 'graph-kind',
      score: 0.85,
      reason: 'node.kind == valve',
    });
    return {
      kind: 'valve_solenoid',
      confidence: confidenceFromEvidence(evidences),
    };
  }

  const label = node.label ?? '';
  if (CYLINDER_LABEL_PATTERNS.some((rx) => rx.test(label))) {
    evidences.push({
      source: 'label-pattern',
      score: 0.55,
      reason: `label ${JSON.stringify(label)} matches a cylinder pattern`,
    });
    return {
      kind: 'pneumatic_cylinder_2pos',
      confidence: confidenceFromEvidence(evidences),
    };
  }
  if (SENSOR_LABEL_PATTERNS.some((rx) => rx.test(label))) {
    evidences.push({
      source: 'label-pattern',
      score: 0.6,
      reason: `label ${JSON.stringify(label)} matches a sensor pattern`,
    });
    return {
      kind: 'sensor_discrete',
      confidence: confidenceFromEvidence(evidences),
    };
  }
  if (MOTOR_LABEL_PATTERNS.some((rx) => rx.test(label))) {
    evidences.push({
      source: 'label-pattern',
      score: 0.55,
      reason: `label ${JSON.stringify(label)} matches a motor pattern`,
    });
    return {
      kind: 'motor_simple',
      confidence: confidenceFromEvidence(evidences),
    };
  }
  if (VALVE_LABEL_PATTERNS.some((rx) => rx.test(label))) {
    evidences.push({
      source: 'label-pattern',
      score: 0.5,
      reason: `label ${JSON.stringify(label)} matches a valve pattern`,
    });
    return {
      kind: 'valve_solenoid',
      confidence: confidenceFromEvidence(evidences),
    };
  }

  return {
    kind: 'unknown',
    confidence: confidenceOf(0, 'no equipment-role evidence'),
  };
}
