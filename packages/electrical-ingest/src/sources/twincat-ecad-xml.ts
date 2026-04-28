// Sprint 78A — Beckhoff/TwinCAT ECAD Import XML recognizer.
//
// Honest scope:
//   - Recognises the public TcECAD Import shape:
//     `Project/CPUs/CPU/Interfaces/Interface/Boxes/Box/Variables/Variable`.
//   - Extracts useful IO + module evidence from this real-world
//     structured ECAD export.
//   - Maps each `<Variable>` into:
//       device/sensor/valve/motor node (kind inferred conservatively)
//       plc_channel node (with structured tcecad: address)
//       module/box node (kind: plc_module)
//       wired_to / signals / drives edges
//
// Out of scope:
//   - This is NOT vendor-certified Beckhoff schema support.
//   - This is NOT EPLAN — `sourceKind` becomes `'twincat_ecad'`.
//   - No Siemens-style %I/%Q address synthesis. The TcECAD address
//     is structured and stored as a deterministic
//     `tcecad:<boxNo>:<channelNumber>` string in attributes; the
//     PIR builder will refuse it (correctly) because it has no PIR
//     IoAddress mapping. Sprint 78A keeps that honest.
//   - No EDZ/EPDZ archive extraction; no PDF/OCR.
//
// Architecture invariants this module preserves:
//   - Reuses xml-utils.ts (no new XML parser).
//   - Reuses KIND_ALIASES via `kind-aliases.ts` for the device-role
//     hints derived from variable names / German comments.
//   - Every node + edge carries a SourceRef with kind 'twincat_ecad',
//     line, path, rawId, and the deterministic XML locator in
//     `symbol`.

import { confidenceFromEvidence, confidenceOf } from '../confidence.js';
import { createElectricalDiagnostic } from '../diagnostics.js';
import { KIND_ALIASES } from '../mapping/kind-aliases.js';
import { normalizeNodeId } from '../normalize.js';
import { mergeSourceRefs } from './trace.js';
import {
  findAllElements,
  findElement,
  getAttribute,
  getChildText,
  parseXml,
  walkElements,
  type XmlElement,
} from './xml-utils.js';
import type {
  ElectricalDiagnostic,
  ElectricalEdge,
  ElectricalGraph,
  ElectricalIngestionInput,
  ElectricalIngestionResult,
  ElectricalNode,
  ElectricalNodeKind,
  ElectricalSourceIngestor,
  Evidence,
  PirIoCandidate,
  SourceRef,
} from '../types.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Predicate over an already-parsed XML root: does this look like a
 * Beckhoff/TwinCAT ECAD Import structure?
 *
 * Signals (any of):
 *   1. Root tag is `Project` AND a child or descendant `Description`
 *      contains `TcECAD Import` (case-insensitive).
 *   2. Root contains `<CPUs>/<CPU>/<Interfaces>/<Interface>/<Boxes>/<Box>/<Variables>/<Variable>`.
 *   3. Any `<Variable>` descendant carries `<IsInput>` + `<IoName>`
 *      + `<IoDataType>` siblings — the Beckhoff Variable shape.
 */
export function detectTcecadXml(root: XmlElement | null): boolean {
  if (!root) return false;
  if (root.tagLower !== 'project') return false;

  // Signal 1 — Description child contains "TcECAD Import".
  const descText =
    getChildText(root, 'description') ??
    findElement(root, 'description')?.text ??
    '';
  if (/tc?ecad/i.test(descText)) return true;

  // Signal 2/3 — look for a Box/Variable structural fingerprint.
  for (const el of walkElements(root)) {
    if (el.tagLower !== 'variable') continue;
    const hasIsInput = el.children.some((c) => c.tagLower === 'isinput');
    const hasIoName = el.children.some((c) => c.tagLower === 'ioname');
    const hasIoDataType = el.children.some((c) => c.tagLower === 'iodatatype');
    if (hasIsInput && hasIoName && hasIoDataType) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Element extraction
// ---------------------------------------------------------------------------

export interface TcecadVariableRecord {
  /** Variable's original name from the source XML. */
  name: string;
  comment?: string;
  isInput: boolean | null;
  ioName?: string;
  ioGroup?: string;
  ioDataType?: string;
  /** Box context (required). */
  boxName: string;
  boxType?: string;
  boxNo?: string;
  /** Interface context (optional). */
  interfaceName?: string;
  interfaceType?: string;
  interfaceChannelNo?: string;
  /** CPU context (optional). */
  cpuName?: string;
  /** XML locator for the source ref. */
  sourcePath: string;
  /** 1-based line of the opening `<Variable>` tag. */
  line: number;
}

export interface TcecadParseResult {
  variables: TcecadVariableRecord[];
  diagnostics: ElectricalDiagnostic[];
}

function readChildText(el: XmlElement, name: string): string | undefined {
  const t = getChildText(el, name);
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

function readBool(el: XmlElement, name: string): boolean | null {
  const t = readChildText(el, name);
  if (t === undefined) return null;
  const v = t.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

/**
 * Walk the XML tree and pull out every `<Variable>` we recognise as
 * a Beckhoff/TwinCAT Variable (must have at least IsInput, IoName,
 * and IoDataType siblings — the shape that defines the format).
 *
 * The walker climbs back up to extract Box / Interface / CPU
 * context from the variable's ancestors so each record carries the
 * full provenance chain without us having to walk twice.
 */
export function extractTcecadVariables(root: XmlElement): TcecadVariableRecord[] {
  const out: TcecadVariableRecord[] = [];
  collect(root, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  return out;

  function collect(
    el: XmlElement,
    cpuName: string | undefined,
    interfaceName: string | undefined,
    interfaceType: string | undefined,
    interfaceChannelNo: string | undefined,
    boxName: string | undefined,
    boxType: string | undefined,
    boxNo: string | undefined,
  ): void {
    let cpu = cpuName;
    let iName = interfaceName;
    let iType = interfaceType;
    let iCh = interfaceChannelNo;
    let bName = boxName;
    let bType = boxType;
    let bNo = boxNo;

    if (el.tagLower === 'cpu') {
      cpu = readChildText(el, 'name') ?? cpu;
    }
    if (el.tagLower === 'interface') {
      iName = readChildText(el, 'name') ?? iName;
      iType = readChildText(el, 'type') ?? iType;
      iCh = readChildText(el, 'channelno') ?? iCh;
    }
    if (el.tagLower === 'box') {
      bName = readChildText(el, 'name') ?? bName;
      bType = readChildText(el, 'type') ?? bType;
      bNo = readChildText(el, 'boxno') ?? bNo;
    }
    if (el.tagLower === 'variable') {
      const name = readChildText(el, 'name');
      if (name && bName) {
        out.push({
          name,
          comment: readChildText(el, 'comment'),
          isInput: readBool(el, 'isinput'),
          ioName: readChildText(el, 'ioname'),
          ioGroup: readChildText(el, 'iogroup'),
          ioDataType: readChildText(el, 'iodatatype'),
          boxName: bName,
          boxType: bType,
          boxNo: bNo,
          interfaceName: iName,
          interfaceType: iType,
          interfaceChannelNo: iCh,
          cpuName: cpu,
          sourcePath: el.locator,
          line: el.line,
        });
      }
      // Variables don't nest meaningfully — but recurse anyway for
      // robustness against unexpected schema variants.
    }

    for (const child of el.children) {
      collect(child, cpu, iName, iType, iCh, bName, bType, bNo);
    }
  }
}

// ---------------------------------------------------------------------------
// Parser entry point — public API
// ---------------------------------------------------------------------------

export interface TcecadIngestionOptions {
  /** Drop derived nodes whose confidence is below this score. Default 0. */
  minConfidence?: number;
}

export interface TcecadIngestionInput {
  sourceId: string;
  text: string;
  fileName?: string;
  options?: TcecadIngestionOptions;
}

export function parseTcecadXml(text: string): TcecadParseResult {
  const diagnostics: ElectricalDiagnostic[] = [];
  if (typeof text !== 'string' || text.length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'EPLAN_XML_EMPTY_INPUT',
        message: 'TcECAD XML input was empty.',
      }),
    );
    return { variables: [], diagnostics };
  }
  const parsed = parseXml(text);
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'EPLAN_XML_MALFORMED',
          message: `XML parse error at line ${e.line} col ${e.column}: ${e.message}`,
        }),
      );
    }
  }
  if (!parsed.root) {
    return { variables: [], diagnostics };
  }
  if (!detectTcecadXml(parsed.root)) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'EPLAN_XML_UNKNOWN_ROOT',
        message: 'XML does not match the recognised Beckhoff/TwinCAT ECAD Import shape.',
        hint: 'expected root <Project> with a Description containing "TcECAD Import" or a CPUs/CPU/Interfaces/Interface/Boxes/Box/Variables/Variable structure.',
      }),
    );
    return { variables: [], diagnostics };
  }

  diagnostics.push(
    createElectricalDiagnostic({
      code: 'TCECAD_XML_DETECTED',
      severity: 'info',
      message: 'Recognised Beckhoff/TwinCAT ECAD Import XML structure.',
    }),
  );

  const variables = extractTcecadVariables(parsed.root);
  if (variables.length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'TCECAD_XML_NO_VARIABLES',
        message:
          'TcECAD root recognised but no <Variable> elements with IsInput/IoName/IoDataType were found.',
      }),
    );
  }

  return { variables, diagnostics };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const SAFETY_HINTS = /\b(estop|e-?stop|notaus|notstop|emergency|safety)\b/i;
const SENSOR_HINTS = /\b(sensor|lichttaster|reedkontakt|druckschalter|schalter|prox|proximity|switch|limit|input|signal)\b/i;
const VALVE_HINTS = /\b(valve|magnetventil|ventil|solenoid|sov)\b/i;
const MOTOR_HINTS = /\b(motor|sch[uü]tz|servo|drive|reglerfreigabe|antrieb|conveyor|pump)\b/i;

function inferKindFromText(
  text: string | undefined,
  isInput: boolean | null,
): { kind: ElectricalNodeKind; reason: string; score: number } {
  const haystack = (text ?? '').toLowerCase();
  if (haystack.length > 0) {
    // Priority order is deliberate: SAFETY → VALVE → SENSOR → MOTOR.
    // SENSOR keywords (lichttaster / reedkontakt / proximity / etc.)
    // are more specific than MOTOR keywords like "conveyor" — and
    // a sensor comment commonly mentions the conveyor it's mounted
    // on. Picking SENSOR first avoids "Lichttaster on conveyor"
    // collapsing to motor. The MOTOR rule still fires for the
    // unambiguous "Motor Schütz" / "Servo" / "Reglerfreigabe"
    // cases because those don't match SENSOR_HINTS.
    if (SAFETY_HINTS.test(haystack)) {
      return { kind: 'safety_device', reason: 'safety hint in name/comment', score: 0.7 };
    }
    if (VALVE_HINTS.test(haystack)) {
      return { kind: 'valve', reason: 'valve hint in name/comment', score: 0.7 };
    }
    if (SENSOR_HINTS.test(haystack)) {
      return { kind: 'sensor', reason: 'sensor hint in name/comment', score: 0.65 };
    }
    if (MOTOR_HINTS.test(haystack)) {
      return { kind: 'motor', reason: 'motor hint in name/comment', score: 0.65 };
    }
    // Try the shared KIND_ALIASES table as a last-resort exact match.
    for (const token of haystack.split(/[\s_-]+/)) {
      const mapped = KIND_ALIASES.get(token);
      if (mapped) return { kind: mapped, reason: `kind alias ${token}`, score: 0.5 };
    }
  }
  // Direction-only fallback. If we know it's an input but no
  // descriptive text, say "sensor" tentatively (low confidence).
  if (isInput === true) {
    return { kind: 'sensor', reason: 'fallback: input direction → tentative sensor', score: 0.35 };
  }
  if (isInput === false) {
    return { kind: 'unknown', reason: 'fallback: output direction with no hint', score: 0.3 };
  }
  return { kind: 'unknown', reason: 'no hint', score: 0.2 };
}

function makeRef(
  sourceId: string,
  fileName: string | undefined,
  line: number,
  rawId: string,
  symbol: string,
): SourceRef {
  const ref: SourceRef = {
    sourceId,
    kind: 'twincat_ecad',
    line,
    rawId,
    symbol,
  };
  if (typeof fileName === 'string' && fileName.length > 0) ref.path = fileName;
  return ref;
}

function structuredAddress(boxNo: string | undefined, ioGroup: string | undefined): string {
  const box = boxNo ?? 'unknown';
  const ch = ioGroup ?? 'unknown';
  return `tcecad:${box}:${ch}`;
}

// ---------------------------------------------------------------------------
// Graph builder + ingestor
// ---------------------------------------------------------------------------

export function buildTcecadGraphId(sourceId: string): string {
  return `electrical_twincat_ecad:${sourceId}`;
}

export function ingestTcecadXml(
  input: TcecadIngestionInput,
): ElectricalIngestionResult {
  const sourceId = input.sourceId;
  const fileName = input.fileName;
  const { variables, diagnostics: parseDiags } = parseTcecadXml(input.text);
  const diagnostics: ElectricalDiagnostic[] = [...parseDiags];
  const allNodes: ElectricalNode[] = [];
  const allEdges: ElectricalEdge[] = [];

  const seenVariableNames = new Map<string, number>();
  const moduleNodesByBox = new Map<string, ElectricalNode>();

  for (const v of variables) {
    if (!v.name) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'TCECAD_XML_MISSING_VARIABLE_NAME',
          message: `TcECAD <Variable> at ${v.sourcePath} (line ${v.line}) has no <Name> — skipping.`,
        }),
      );
      continue;
    }
    if (seenVariableNames.has(v.name)) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'TCECAD_XML_DUPLICATE_VARIABLE',
          message: `TcECAD variable ${JSON.stringify(v.name)} at line ${v.line} is a duplicate (first seen at line ${seenVariableNames.get(v.name)}). Skipping.`,
          sourceRef: makeRef(sourceId, fileName, v.line, v.name, v.sourcePath),
        }),
      );
      continue;
    }
    seenVariableNames.set(v.name, v.line);

    if (!v.boxName) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'TCECAD_XML_MISSING_BOX_CONTEXT',
          message: `TcECAD variable ${v.name} at line ${v.line} has no Box ancestor — skipping.`,
        }),
      );
      continue;
    }

    const baseRef = makeRef(sourceId, fileName, v.line, v.name, v.sourcePath);

    // -----------------------------------------------------------
    // Module/box node — created once per Box and reused across the
    // variables that share it. SourceRefs accumulate.
    // -----------------------------------------------------------
    const boxKey = v.boxNo ?? v.boxName;
    let moduleNode = moduleNodesByBox.get(boxKey);
    if (!moduleNode) {
      const moduleId = normalizeNodeId(`module:${boxKey}`);
      moduleNode = {
        id: moduleId,
        kind: 'plc_module',
        label: v.boxName,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.85, `tcecad: Box ${v.boxName} (${v.boxType ?? 'unknown'})`),
        attributes: {
          box_name: v.boxName,
          ...(v.boxType ? { box_type: v.boxType } : {}),
          ...(v.boxNo ? { box_no: v.boxNo } : {}),
          ...(v.interfaceName ? { interface_name: v.interfaceName } : {}),
          ...(v.interfaceType ? { interface_type: v.interfaceType } : {}),
          ...(v.interfaceChannelNo ? { interface_channel_no: v.interfaceChannelNo } : {}),
          ...(v.cpuName ? { cpu_name: v.cpuName } : {}),
          source_format: 'twincat_ecad_import',
        },
      };
      allNodes.push(moduleNode);
      moduleNodesByBox.set(boxKey, moduleNode);
    } else {
      moduleNode.sourceRefs = mergeSourceRefs(moduleNode.sourceRefs, [baseRef]);
    }

    // -----------------------------------------------------------
    // Direction
    // -----------------------------------------------------------
    let direction: PirIoCandidate['direction'] = 'unknown';
    if (v.isInput === true) direction = 'input';
    else if (v.isInput === false) direction = 'output';
    else {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'TCECAD_XML_UNKNOWN_DIRECTION',
          message: `TcECAD variable ${v.name} at line ${v.line} has no parseable <IsInput> — direction unknown.`,
          sourceRef: baseRef,
        }),
      );
    }
    // Cross-check with IoName when present.
    if (
      v.ioName &&
      direction !== 'unknown' &&
      ((direction === 'input' && /^output$/i.test(v.ioName)) ||
        (direction === 'output' && /^input$/i.test(v.ioName)))
    ) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'TCECAD_XML_DIRECTION_CONFLICT',
          message: `TcECAD variable ${v.name} (line ${v.line}): IsInput=${v.isInput} but IoName=${JSON.stringify(v.ioName)}.`,
          sourceRef: baseRef,
        }),
      );
    }

    // -----------------------------------------------------------
    // Signal data type
    // -----------------------------------------------------------
    let signalType: PirIoCandidate['signalType'] = 'unknown';
    if (v.ioDataType) {
      const norm = v.ioDataType.trim().toLowerCase();
      if (norm === 'bool') signalType = 'bool';
      else if (norm === 'int' || norm === 'word' || norm === 'uint' || norm === 'sint' || norm === 'usint') {
        signalType = 'int';
      } else if (norm === 'real' || norm === 'lreal' || norm === 'dword' || norm === 'dint') {
        signalType = 'real';
      } else {
        diagnostics.push(
          createElectricalDiagnostic({
            code: 'TCECAD_XML_UNSUPPORTED_IO_DATATYPE',
            message: `TcECAD variable ${v.name} (line ${v.line}) has IoDataType=${JSON.stringify(v.ioDataType)} which has no canonical signal-type mapping.`,
            sourceRef: baseRef,
          }),
        );
      }
    }

    // -----------------------------------------------------------
    // PLC channel node — structured TcECAD address (no Siemens-style
    // %I/%Q synthesis; PIR builder will refuse this honestly).
    // -----------------------------------------------------------
    const addr = structuredAddress(v.boxNo, v.ioGroup);
    const channelId = normalizeNodeId(`plc_channel:${addr}`);
    // The channel label embeds the direction so the Sprint 72
    // candidate mapper's label-pattern fallback (`/\b(input|...)/`)
    // can pick it up — the structured address itself has no
    // direction encoding. This is honest: we are not synthesising
    // a Siemens %I/%Q; we are explicitly labelling the structured
    // address with the direction the source XML stated.
    const directionTag =
      direction === 'unknown' ? '' : ` (${direction})`;
    const channelNode: ElectricalNode = {
      id: channelId,
      kind: 'plc_channel',
      label: `${addr}${directionTag}`,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.55, `tcecad: structured address ${addr}`),
      attributes: {
        structured_address: addr,
        family: 'twincat_ecad',
        direction,
        ...(signalType !== 'unknown' ? { signal_type: signalType } : {}),
        ...(v.boxNo ? { box_no: v.boxNo } : {}),
        ...(v.ioGroup ? { io_group: v.ioGroup } : {}),
        ...(v.ioName ? { io_name: v.ioName } : {}),
      },
    };
    // Dedup channel by id.
    const existingChannel = allNodes.find((n) => n.id === channelId);
    if (existingChannel) {
      existingChannel.sourceRefs = mergeSourceRefs(existingChannel.sourceRefs, [baseRef]);
    } else {
      allNodes.push(channelNode);
    }
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'TCECAD_XML_STRUCTURED_ADDRESS_USED',
        severity: 'info',
        message: `TcECAD variable ${v.name}: using structured address ${addr} (no Siemens-style %I/%Q synthesis — PIR builder will refuse without a canonical address).`,
        sourceRef: baseRef,
      }),
    );

    // -----------------------------------------------------------
    // Device node — inferred from variable name + comment hints.
    // -----------------------------------------------------------
    const inferred = inferKindFromText(`${v.name} ${v.comment ?? ''}`, v.isInput);
    const deviceId = normalizeNodeId(`device:${v.name}`);
    const evidences: Evidence[] = [
      {
        source: 'tcecad-name-comment',
        score: inferred.score,
        reason: inferred.reason,
      },
    ];
    if (v.ioDataType === 'BOOL') {
      evidences.push({
        source: 'tcecad-iodatatype',
        score: 0.6,
        reason: 'BOOL signal',
      });
    }
    const deviceNode: ElectricalNode = {
      id: deviceId,
      kind: inferred.kind,
      label: v.comment ?? v.name,
      sourceRefs: [baseRef],
      confidence: confidenceFromEvidence(evidences),
      attributes: {
        variable_name: v.name,
        ...(v.comment ? { comment: v.comment } : {}),
        ...(v.ioDataType ? { io_data_type: v.ioDataType } : {}),
        ...(v.ioName ? { io_name: v.ioName } : {}),
        ...(v.ioGroup ? { io_group: v.ioGroup } : {}),
        box_name: v.boxName,
        ...(v.boxType ? { box_type: v.boxType } : {}),
        ...(v.boxNo ? { box_no: v.boxNo } : {}),
        ...(v.interfaceName ? { interface_name: v.interfaceName } : {}),
        ...(v.cpuName ? { cpu_name: v.cpuName } : {}),
        source_format: 'twincat_ecad_import',
      },
    };
    allNodes.push(deviceNode);

    // -----------------------------------------------------------
    // Edges
    //   - device ↔ channel (signals/drives based on direction)
    //   - module → channel (contains)
    // -----------------------------------------------------------
    if (direction === 'input') {
      allEdges.push({
        id: normalizeNodeId(`e_${deviceNode.id}_${channelId}_signals`),
        kind: 'signals',
        from: deviceNode.id,
        to: channelId,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.7, 'tcecad input device → channel'),
        attributes: {},
      });
    } else if (direction === 'output') {
      allEdges.push({
        id: normalizeNodeId(`e_${channelId}_${deviceNode.id}_drives`),
        kind: 'drives',
        from: channelId,
        to: deviceNode.id,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.7, 'tcecad output channel → device'),
        attributes: {},
      });
    }
    // Module → channel via belongs_to (closest existing edge kind).
    const moduleChannelEdgeId = normalizeNodeId(
      `e_${channelId}_${moduleNode.id}_belongs_to`,
    );
    if (!allEdges.some((e) => e.id === moduleChannelEdgeId)) {
      allEdges.push({
        id: moduleChannelEdgeId,
        kind: 'belongs_to',
        from: channelId,
        to: moduleNode.id,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.75, `tcecad: channel hosted by ${v.boxName}`),
        attributes: {},
      });
    }
  }

  if (variables.length > 0 && allNodes.filter((n) => n.id.startsWith('device:')).length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'TCECAD_XML_PARTIAL_EXTRACTION',
        message:
          'TcECAD variables present but none could be mapped to device nodes — see prior diagnostics for the reason.',
      }),
    );
  }

  const graph: ElectricalGraph = {
    id: buildTcecadGraphId(sourceId),
    sourceKind: 'twincat_ecad',
    nodes: allNodes,
    edges: allEdges,
    diagnostics: [...diagnostics],
    metadata: {
      sourceFiles: fileName ? [fileName] : [],
      generator: 'electrical-ingest@twincat-ecad-v0',
    },
  };
  return { graph, diagnostics };
}

/**
 * Registry-facing TcECAD ingestor. Only accepts `kind: 'xml'` files
 * whose content matches `detectTcecadXml`. Everything else returns
 * `false` from `canIngest`, leaving them for the next ingestor in
 * the registry chain.
 */
export function createTcecadXmlElectricalIngestor(): ElectricalSourceIngestor {
  return {
    canIngest(input: ElectricalIngestionInput): boolean {
      if (!input || typeof input !== 'object') return false;
      if (!Array.isArray(input.files) || input.files.length === 0) return false;
      return input.files.every((f) => {
        if (!f || typeof f !== 'object' || f.kind !== 'xml') return false;
        if (typeof f.content !== 'string' && !(f.content instanceof Uint8Array)) {
          return false;
        }
        const text =
          typeof f.content === 'string'
            ? f.content
            : new TextDecoder('utf-8').decode(f.content);
        const parsed = parseXml(text);
        return detectTcecadXml(parsed.root);
      });
    },
    async ingest(input: ElectricalIngestionInput): Promise<ElectricalIngestionResult> {
      const diagnostics: ElectricalDiagnostic[] = [];
      const allNodes: ElectricalNode[] = [];
      const allEdges: ElectricalEdge[] = [];
      const sourceFiles: string[] = [];

      for (const file of input.files) {
        if (!file || typeof file !== 'object' || file.kind !== 'xml') continue;
        sourceFiles.push(file.path);
        let text: string;
        if (typeof file.content === 'string') {
          text = file.content;
        } else if (file.content instanceof Uint8Array) {
          text = new TextDecoder('utf-8').decode(file.content);
        } else {
          diagnostics.push(
            createElectricalDiagnostic({
              code: 'EPLAN_XML_EMPTY_INPUT',
              message: `TcECAD XML file ${JSON.stringify(file.path)} has no inline content.`,
            }),
          );
          continue;
        }
        const partial = ingestTcecadXml({
          sourceId: input.sourceId,
          text,
          fileName: file.path,
        });
        diagnostics.push(...partial.diagnostics);
        for (const n of partial.graph.nodes) {
          const existing = allNodes.find((x) => x.id === n.id);
          if (!existing) allNodes.push(n);
          else existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, n.sourceRefs);
        }
        for (const e of partial.graph.edges) {
          const existing = allEdges.find((x) => x.id === e.id);
          if (!existing) allEdges.push(e);
          else existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, e.sourceRefs);
        }
      }

      const graph: ElectricalGraph = {
        id: buildTcecadGraphId(input.sourceId),
        sourceKind: 'twincat_ecad',
        nodes: allNodes,
        edges: allEdges,
        diagnostics: [...diagnostics],
        metadata: {
          sourceFiles,
          generator: 'electrical-ingest@twincat-ecad-v0',
        },
      };
      return { graph, diagnostics };
    },
  };
}

// re-export so tests can introspect easily
export { findAllElements, findElement, walkElements };
