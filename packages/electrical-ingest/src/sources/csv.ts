// Sprint 73 — first concrete electrical-source ingestor: CSV.
//
// Scope (deliberate):
//   - Parse a small, well-defined CSV dialect: comma delimiter,
//     CRLF or LF, quoted fields, escaped `""` inside quotes, empty
//     cells. Anything else surfaces as a diagnostic.
//   - Accept a fixed set of canonical columns plus a few common
//     aliases (CSV exports from EPLAN / Excel / hand-written
//     terminal lists tend to converge on the same 8-12 column
//     names).
//   - Convert each row into nodes + edges in the canonical
//     ElectricalGraph, with a SourceRef pointing back at the row.
//   - Emit diagnostics — never throw — on every ambiguous or
//     malformed input.
//
// Out of scope (honest):
//   - No semicolon / tab / pipe delimiters. Add them when a real
//     fixture demands it.
//   - No multi-line cells with embedded newlines inside quotes
//     beyond the simplest case.
//   - No EPLAN XML / EDZ — that is Sprint 74.
//   - No final PIR generation — the existing
//     `buildPirDraftCandidate` consumes the graph this ingestor
//     produces.

import { confidenceFromEvidence, confidenceOf } from '../confidence.js';
import { createElectricalDiagnostic } from '../diagnostics.js';
import { KIND_ALIASES, knownKindHintList } from '../mapping/kind-aliases.js';
import { detectPlcAddress, normalizeNodeId } from '../normalize.js';
import { mergeSourceRefs } from './trace.js';
import type {
  ElectricalDiagnostic,
  ElectricalEdge,
  ElectricalEdgeKind,
  ElectricalGraph,
  ElectricalIngestionInput,
  ElectricalIngestionResult,
  ElectricalNode,
  ElectricalNodeKind,
  ElectricalParameterDraft,
  ElectricalSourceIngestor,
  Evidence,
  PirParameterCandidate,
  SourceRef,
} from '../types.js';

// ---------------------------------------------------------------------------
// Header alias table — deterministic, lowercase keys.
// ---------------------------------------------------------------------------

export const CSV_CANONICAL_HEADERS = Object.freeze([
  'tag',
  'kind',
  'address',
  'direction',
  'label',
  'terminal',
  'terminal_strip',
  'cable',
  'wire',
  'sheet',
  'page',
  'plc',
  'module',
  'channel',
  'signal',
  'role',
  'device',
  'function',
  'location',
  'comment',
  // Sprint 88L — explicit-metadata row-kind discriminator + the
  // four columns that carry numeric Parameter metadata. All five
  // are additive: legacy CSVs that don't set them keep the
  // device-row pipeline they always had.
  'row_kind',
  'parameter_id',
  'default',
  'unit',
  'data_type',
  // Sprint 97 — explicit numeric bounds for setpoint parameters.
  // Only ever consumed when the row is a `row_kind=parameter` row;
  // device rows ignore them. Aliases map to these two canonical
  // columns in `CSV_HEADER_ALIASES`.
  'min',
  'max',
] as const);

export type CsvCanonicalHeader = (typeof CSV_CANONICAL_HEADERS)[number];

/**
 * Map of `<lowercased raw header>` → canonical column name. Order
 * matters only for the test snapshot; the mapping itself is
 * deterministic. New aliases can be added freely; conflicts (two
 * raw headers mapping to the same canonical column) are flagged at
 * parse time as `CSV_DUPLICATE_HEADER`.
 */
export const CSV_HEADER_ALIASES: ReadonlyMap<string, CsvCanonicalHeader> =
  new Map([
    // tag
    ['tag', 'tag'],
    ['device_tag', 'tag'],
    ['equipment', 'tag'],
    ['equipment_id', 'tag'],
    // kind
    ['kind', 'kind'],
    ['type', 'kind'],
    ['device_type', 'kind'],
    ['equipment_type', 'kind'],
    // address
    ['address', 'address'],
    ['io_address', 'address'],
    ['plc_address', 'address'],
    // direction
    ['direction', 'direction'],
    ['io_direction', 'direction'],
    ['dir', 'direction'],
    // label
    ['label', 'label'],
    ['description', 'label'],
    ['text', 'label'],
    // terminal
    ['terminal', 'terminal'],
    ['terminal_id', 'terminal'],
    ['terminal_point', 'terminal'],
    // terminal strip
    ['terminal_strip', 'terminal_strip'],
    ['strip', 'terminal_strip'],
    // cable
    ['cable', 'cable'],
    ['cable_id', 'cable'],
    // wire
    ['wire', 'wire'],
    ['wire_id', 'wire'],
    ['conductor', 'wire'],
    // sheet
    ['sheet', 'sheet'],
    ['drawing', 'sheet'],
    ['source_page', 'sheet'],
    // page (kept distinct so we don't lose finer-grained info; the
    // ingestor copies sheet from page when sheet is empty)
    ['page', 'page'],
    // plc / module / channel
    ['plc', 'plc'],
    ['cpu', 'plc'],
    ['module', 'module'],
    ['card', 'module'],
    ['io_module', 'module'],
    ['channel', 'channel'],
    // signal / role
    ['signal', 'signal'],
    ['signal_id', 'signal'],
    ['io_signal', 'signal'],
    ['role', 'role'],
    ['io_role', 'role'],
    // device / function / location / comment — pass-through
    ['device', 'device'],
    ['function', 'function'],
    ['location', 'location'],
    ['comment', 'comment'],
    // Sprint 88L — explicit-metadata row discriminator + parameter/binding columns
    ['row_kind', 'row_kind'],
    ['record_kind', 'row_kind'],
    ['record', 'row_kind'],
    ['parameter_id', 'parameter_id'],
    ['param_id', 'parameter_id'],
    ['default', 'default'],
    ['default_value', 'default'],
    ['unit', 'unit'],
    ['units', 'unit'],
    ['eu', 'unit'],
    ['data_type', 'data_type'],
    ['dtype', 'data_type'],
    ['datatype', 'data_type'],
    // Sprint 97 — min / max aliases for `row_kind=parameter` rows.
    ['min', 'min'],
    ['minimum', 'min'],
    ['min_value', 'min'],
    ['range_min', 'min'],
    ['max', 'max'],
    ['maximum', 'max'],
    ['max_value', 'max'],
    ['range_max', 'max'],
  ] as const);

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

export interface CsvParseOptions {
  /** Default `,`. Sprint 73 only supports comma. */
  delimiter?: ',';
  /** Used for diagnostics' SourceRef; default `'csv'`. */
  sourceId?: string;
  /** File path for diagnostics (`SourceRef.path`). */
  fileName?: string;
}

export interface CsvRow {
  /** 1-based data row number (header row is row 0; first data row is 1). */
  rowNumber: number;
  /** 1-based physical line number in the input — useful for editor links. */
  lineNumber: number;
  /** Canonicalised cell map. Aliased headers resolve here. */
  cells: Record<string, string>;
  /** Raw CSV line (unparsed). Useful for diagnostics. */
  raw: string;
}

export interface CsvParseResult {
  headers: string[];
  /** Headers after alias resolution; same length as `headers`. */
  canonicalHeaders: (CsvCanonicalHeader | string)[];
  rows: CsvRow[];
  diagnostics: ElectricalDiagnostic[];
}

/**
 * Parse a CSV string into rows. Pure: no I/O, deterministic. Empty
 * input emits `CSV_EMPTY_INPUT`. Missing header emits
 * `CSV_MISSING_HEADER`.
 */
export function parseElectricalCsv(
  text: string,
  options: CsvParseOptions = {},
): CsvParseResult {
  const sourceId = options.sourceId ?? 'csv';
  const fileName = options.fileName;
  const delimiter = options.delimiter ?? ',';
  if (delimiter !== ',') {
    return {
      headers: [],
      canonicalHeaders: [],
      rows: [],
      diagnostics: [
        createElectricalDiagnostic({
          code: 'CSV_UNSUPPORTED_DELIMITER',
          message: `delimiter ${JSON.stringify(delimiter)} is not supported (Sprint 73 only allows comma).`,
        }),
      ],
    };
  }
  if (typeof text !== 'string' || text.length === 0) {
    return {
      headers: [],
      canonicalHeaders: [],
      rows: [],
      diagnostics: [
        createElectricalDiagnostic({
          code: 'CSV_EMPTY_INPUT',
          message: 'CSV input was empty.',
        }),
      ],
    };
  }

  const diagnostics: ElectricalDiagnostic[] = [];
  const rawLines = splitCsvLines(text);
  if (rawLines.length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_EMPTY_INPUT',
        message: 'CSV input contained no parseable lines.',
      }),
    );
    return { headers: [], canonicalHeaders: [], rows: [], diagnostics };
  }

  // First non-blank line = header row.
  let headerLineIdx = -1;
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].text.trim().length > 0) {
      headerLineIdx = i;
      break;
    }
  }
  if (headerLineIdx === -1) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_MISSING_HEADER',
        message: 'CSV input contained no header row.',
      }),
    );
    return { headers: [], canonicalHeaders: [], rows: [], diagnostics };
  }
  const headerRaw = rawLines[headerLineIdx];
  const parsedHeader = parseCsvLine(headerRaw.text);
  if (parsedHeader.unclosed) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_UNCLOSED_QUOTE',
        message: `CSV header (line ${headerRaw.lineNumber}) has an unclosed quoted field.`,
      }),
    );
  }
  const headers = parsedHeader.cells.map((c) => c.trim());
  // Header sanity checks.
  if (headers.length === 0 || headers.every((h) => h.length === 0)) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_MISSING_HEADER',
        message: 'CSV header row was empty or all-blank.',
      }),
    );
    return { headers: [], canonicalHeaders: [], rows: [], diagnostics };
  }

  // Canonicalise headers + detect alias collisions.
  const canonicalHeaders: (CsvCanonicalHeader | string)[] = [];
  const seen = new Map<string, number>(); // canonical → first-index it appeared at
  for (let i = 0; i < headers.length; i++) {
    const raw = headers[i].toLowerCase();
    const canonical = CSV_HEADER_ALIASES.get(raw) ?? raw;
    canonicalHeaders.push(canonical);
    if (canonical.length === 0) continue;
    if (seen.has(canonical)) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_DUPLICATE_HEADER',
          message: `header ${JSON.stringify(headers[i])} (canonical ${JSON.stringify(canonical)}) appears more than once (also at index ${seen.get(canonical)}).`,
        }),
      );
    } else {
      seen.set(canonical, i);
    }
  }

  // Parse the rest of the lines as data rows.
  const rows: CsvRow[] = [];
  let dataRowNumber = 0;
  for (let i = headerLineIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.text.trim().length === 0) continue;
    const parsed = parseCsvLine(line.text);
    if (parsed.unclosed) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_UNCLOSED_QUOTE',
          message: `CSV row at line ${line.lineNumber} has an unclosed quoted field; row skipped.`,
          sourceRef: makeRowRef(sourceId, fileName, line.lineNumber),
        }),
      );
      continue;
    }
    if (parsed.cells.length !== headers.length) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_ROW_WIDTH_MISMATCH',
          message: `CSV row at line ${line.lineNumber} has ${parsed.cells.length} cell(s); expected ${headers.length}.`,
          sourceRef: makeRowRef(sourceId, fileName, line.lineNumber),
        }),
      );
      // Continue with whatever cells we got — pad with empty strings.
    }
    dataRowNumber++;
    const cellRecord: Record<string, string> = {};
    for (let j = 0; j < canonicalHeaders.length; j++) {
      const key = canonicalHeaders[j] as string;
      if (key.length === 0) continue;
      const v = (parsed.cells[j] ?? '').trim();
      if (v.length > 0) cellRecord[key] = v;
    }
    rows.push({
      rowNumber: dataRowNumber,
      lineNumber: line.lineNumber,
      cells: cellRecord,
      raw: line.text,
    });
  }

  return { headers, canonicalHeaders, rows, diagnostics };
}

/**
 * Split a CSV string into lines, preserving 1-based line numbers
 * and surviving CRLF/LF mixed input. Strips a single trailing
 * newline so the last line isn't a phantom empty record.
 */
function splitCsvLines(
  text: string,
): { text: string; lineNumber: number }[] {
  const out: { text: string; lineNumber: number }[] = [];
  let buffer = '';
  let lineNumber = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '\r') {
      out.push({ text: buffer, lineNumber });
      buffer = '';
      lineNumber++;
      // Skip the \n in CRLF.
      if (i + 1 < text.length && text.charAt(i + 1) === '\n') i++;
    } else if (ch === '\n') {
      out.push({ text: buffer, lineNumber });
      buffer = '';
      lineNumber++;
    } else {
      buffer += ch;
    }
  }
  if (buffer.length > 0) out.push({ text: buffer, lineNumber });
  return out;
}

/**
 * Parse a single CSV line into cells. Supports quoted fields and
 * `""` escapes. Returns whether the line ended inside a quote
 * (`unclosed = true`) so the caller can flag it.
 */
function parseCsvLine(line: string): { cells: string[]; unclosed: boolean } {
  const cells: string[] = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line.charAt(i + 1) === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return { cells, unclosed: inQuote };
}

function makeRowRef(
  sourceId: string,
  fileName: string | undefined,
  lineNumber: number,
  rawId?: string,
  sheet?: string,
): SourceRef {
  const ref: SourceRef = {
    sourceId,
    kind: 'csv',
    line: lineNumber,
  };
  if (typeof fileName === 'string' && fileName.length > 0) ref.path = fileName;
  if (typeof rawId === 'string' && rawId.length > 0) ref.rawId = rawId;
  if (typeof sheet === 'string' && sheet.length > 0) ref.sheet = sheet;
  return ref;
}

// ---------------------------------------------------------------------------
// Ingestor
// ---------------------------------------------------------------------------

export interface CsvElectricalIngestionOptions {
  /**
   * Drop derived nodes whose confidence is below this score.
   * Default 0 — keep everything; rely on diagnostics for low-
   * confidence filtering.
   */
  minConfidence?: number;
}

export interface CsvElectricalIngestionInput {
  sourceId: string;
  text: string;
  fileName?: string;
  options?: CsvElectricalIngestionOptions;
}

/**
 * Build a deterministic graph id for a given CSV source.
 */
export function buildCsvGraphId(sourceId: string): string {
  return `electrical_csv:${sourceId}`;
}

/**
 * Convert one CSV row to canonical nodes + edges. Pure; no I/O.
 * Used by the ingestor below; exported so tests can pin the
 * row-level mapping in isolation.
 */
export interface RowMappingResult {
  nodes: ElectricalNode[];
  edges: ElectricalEdge[];
  diagnostics: ElectricalDiagnostic[];
}

export function mapCsvRowToGraphFragment(
  row: CsvRow,
  context: {
    sourceId: string;
    fileName?: string;
  },
): RowMappingResult {
  const nodes: ElectricalNode[] = [];
  const edges: ElectricalEdge[] = [];
  const diagnostics: ElectricalDiagnostic[] = [];
  const cells = row.cells;

  // Sprint 88L — `row_kind=parameter|setpoint_binding` rows are
  // handled by the explicit parameter-draft extractor in
  // `ingestElectricalCsv`, not the device-row pipeline. Returning
  // an empty fragment here (rather than emitting CSV_MISSING_TAG
  // because parameter/binding rows legitimately have no `tag`)
  // keeps the device pipeline untouched.
  const rowKind = (cells['row_kind'] ?? '').toLowerCase();
  if (rowKind === 'parameter' || rowKind === 'setpoint_binding') {
    return { nodes, edges, diagnostics };
  }

  const tag = cells['tag'];
  if (!tag || tag.length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_MISSING_TAG',
        message: `CSV row at line ${row.lineNumber} has no tag — skipping.`,
        sourceRef: makeRowRef(context.sourceId, context.fileName, row.lineNumber),
      }),
    );
    return { nodes, edges, diagnostics };
  }

  const sheet = cells['sheet'] ?? cells['page'];
  const baseRef = makeRowRef(
    context.sourceId,
    context.fileName,
    row.lineNumber,
    tag,
    sheet,
  );

  // -------------------------------------------------------------
  // Device node
  // -------------------------------------------------------------
  const rawKind = (cells['kind'] ?? '').toLowerCase();
  let deviceKind: ElectricalNodeKind = 'unknown';
  let kindConfidence: Evidence[] = [];
  if (rawKind.length === 0) {
    kindConfidence.push({
      source: 'csv-kind-empty',
      score: 0.2,
      reason: 'kind cell empty',
      weight: 1,
    });
  } else {
    const mapped = KIND_ALIASES.get(rawKind);
    if (mapped) {
      deviceKind = mapped;
      kindConfidence.push({
        source: 'csv-kind',
        score: 0.85,
        reason: `kind=${rawKind} → ${mapped}`,
      });
    } else {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_UNKNOWN_KIND',
          message: `CSV row at line ${row.lineNumber} has unknown kind ${JSON.stringify(rawKind)}.`,
          sourceRef: baseRef,
          hint: `recognised kinds: ${knownKindHintList()}.`,
        }),
      );
      kindConfidence.push({
        source: 'csv-kind',
        score: 0.4,
        reason: `unknown kind=${rawKind}; capped`,
      });
    }
  }

  const deviceId = normalizeNodeId(`device:${tag}`);
  const attributes: Record<string, string | number | boolean> = {};
  if (cells['function']) attributes['function'] = cells['function'];
  if (cells['location']) attributes['location'] = cells['location'];
  if (cells['comment']) attributes['comment'] = cells['comment'];
  if (cells['role']) attributes['role'] = cells['role'];
  attributes['raw_tag'] = tag;
  if (rawKind.length > 0) attributes['raw_kind'] = rawKind;

  const deviceNode: ElectricalNode = {
    id: deviceId,
    kind: deviceKind,
    label: cells['label'] ?? tag,
    sourceRefs: [baseRef],
    confidence: confidenceFromEvidence(kindConfidence),
    attributes,
  };
  nodes.push(deviceNode);

  // -------------------------------------------------------------
  // PLC channel node from address
  // -------------------------------------------------------------
  let channelNode: ElectricalNode | null = null;
  const rawAddress = cells['address'];
  if (rawAddress) {
    const detected = detectPlcAddress(rawAddress);
    if (!detected) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_INVALID_ADDRESS',
          message: `CSV row at line ${row.lineNumber} has unrecognised PLC address ${JSON.stringify(rawAddress)}.`,
          sourceRef: baseRef,
          hint: 'use a strict form: %I0.0 / %Q1.7 / Local:1:I.Data[0].0 / I0.0 / Q1.7.',
        }),
      );
    } else {
      const channelId = normalizeNodeId(`plc_channel:${detected.raw}`);
      const channelAttrs: Record<string, string | number | boolean> = {
        address: detected.raw,
        family: detected.family,
        direction: detected.direction,
      };
      // Direction column versus address direction — flag conflict.
      const colDir = (cells['direction'] ?? '').toLowerCase();
      if (
        colDir.length > 0 &&
        (colDir === 'input' || colDir === 'output') &&
        detected.direction !== 'unknown' &&
        colDir !== detected.direction
      ) {
        diagnostics.push(
          createElectricalDiagnostic({
            code: 'CSV_DIRECTION_ADDRESS_CONFLICT',
            message: `CSV row at line ${row.lineNumber} has direction=${colDir} but address ${detected.raw} implies ${detected.direction}.`,
            sourceRef: baseRef,
          }),
        );
      }

      // Signal type — bit-addressed bool, otherwise unknown.
      const isBit = /\.\d+$/.test(detected.raw) || /[A-Z]X\d/i.test(detected.raw);
      if (isBit) channelAttrs['signal_type'] = 'bool';

      channelNode = {
        id: channelId,
        kind: 'plc_channel',
        label: detected.raw,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.85, `address ${detected.raw} parsed as ${detected.family}`),
        attributes: channelAttrs,
      };
      nodes.push(channelNode);

      // Edge: device ↔ channel based on direction.
      const edgeKind: ElectricalEdgeKind =
        detected.direction === 'output' ? 'drives' : 'signals';
      // For inputs: device → channel (sensor signals channel).
      // For outputs: channel → device (channel drives actuator).
      const edge: ElectricalEdge = {
        id: normalizeNodeId(
          `e_${detected.direction === 'output' ? channelNode.id : deviceNode.id}_${detected.direction === 'output' ? deviceNode.id : channelNode.id}_${edgeKind}`,
        ),
        kind: edgeKind,
        from: detected.direction === 'output' ? channelNode.id : deviceNode.id,
        to: detected.direction === 'output' ? deviceNode.id : channelNode.id,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.8, 'csv address ↔ device binding'),
        attributes: {},
      };
      edges.push(edge);
    }
  }

  // -------------------------------------------------------------
  // Terminal node
  // -------------------------------------------------------------
  let terminalNode: ElectricalNode | null = null;
  const rawTerminal = cells['terminal'];
  if (rawTerminal) {
    const termId = normalizeNodeId(`terminal:${rawTerminal}`);
    terminalNode = {
      id: termId,
      kind: 'terminal',
      label: rawTerminal,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.8, 'csv terminal'),
      attributes: {
        terminal: rawTerminal,
        ...(cells['terminal_strip'] ? { strip: cells['terminal_strip'] } : {}),
      },
    };
    nodes.push(terminalNode);
    edges.push({
      id: normalizeNodeId(`e_${deviceNode.id}_${terminalNode.id}_wired_to`),
      kind: 'wired_to',
      from: deviceNode.id,
      to: terminalNode.id,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.8, 'csv device wired_to terminal'),
      attributes: {},
    });
    if (channelNode) {
      edges.push({
        id: normalizeNodeId(`e_${terminalNode.id}_${channelNode.id}_wired_to`),
        kind: 'wired_to',
        from: terminalNode.id,
        to: channelNode.id,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.7, 'csv terminal wired_to channel'),
        attributes: {},
      });
    }
  }

  // -------------------------------------------------------------
  // Cable + wire nodes
  // -------------------------------------------------------------
  const cable = cells['cable'];
  const wire = cells['wire'];
  if (cable) {
    const cableId = normalizeNodeId(`cable:${cable}`);
    nodes.push({
      id: cableId,
      kind: 'cable',
      label: cable,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.7, 'csv cable'),
      attributes: { cable },
    });
    if (terminalNode) {
      edges.push({
        id: normalizeNodeId(`e_${terminalNode.id}_${cableId}_wired_to`),
        kind: 'wired_to',
        from: terminalNode.id,
        to: cableId,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.7, 'csv terminal wired_to cable'),
        attributes: {},
      });
    }
  }
  if (wire) {
    const wireId = normalizeNodeId(`wire:${wire}`);
    nodes.push({
      id: wireId,
      kind: 'wire',
      label: wire,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.65, 'csv wire'),
      attributes: { wire },
    });
    if (terminalNode) {
      edges.push({
        id: normalizeNodeId(`e_${terminalNode.id}_${wireId}_wired_to`),
        kind: 'wired_to',
        from: terminalNode.id,
        to: wireId,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.65, 'csv terminal wired_to wire'),
        attributes: {},
      });
    }
  }

  return { nodes, edges, diagnostics };
}

// ---------------------------------------------------------------------------
// Sprint 88L — parameter + setpoint-binding row extractors.
//
// `row_kind=parameter` rows declare a numeric machine Parameter
// (id, data_type, default, optional unit / label). They never come
// from inference: every required field must be explicitly set on
// the row, otherwise a diagnostic fires and the row is dropped.
//
// `row_kind=setpoint_binding` rows declare an explicit edge from
// an equipment+role pair to a parameter id. Today only
// `speed_setpoint_out` is supported (the v0 numeric output role on
// `motor_vfd_simple`); other roles surface
// CSV_SETPOINT_BINDING_ROLE_UNSUPPORTED.
// ---------------------------------------------------------------------------

const SUPPORTED_SETPOINT_ROLES: ReadonlySet<string> = new Set([
  'speed_setpoint_out',
]);

function parseParameterDataType(
  raw: string | undefined,
): 'int' | 'dint' | 'real' | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'int') return 'int';
  if (v === 'dint') return 'dint';
  if (v === 'real') return 'real';
  return null;
}

function parseParameterDefault(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

function extractParameterRow(
  row: CsvRow,
  context: { sourceId: string; fileName?: string },
  draft: ElectricalParameterDraft,
  seenIds: Set<string>,
): void {
  const cells = row.cells;
  const id = (cells['parameter_id'] ?? cells['tag'] ?? '').trim();
  const ref = makeRowRef(
    context.sourceId,
    context.fileName,
    row.lineNumber,
    id || undefined,
    cells['sheet'] ?? cells['page'],
  );
  if (id.length === 0) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_PARAMETER_METADATA_INCOMPLETE',
        message: `CSV parameter row at line ${row.lineNumber} has no parameter_id (and no fallback tag).`,
        sourceRef: ref,
        hint: 'set the `parameter_id` column to a stable id (e.g. p_m01_speed).',
      }),
    );
    return;
  }
  if (seenIds.has(id)) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_PARAMETER_DUPLICATE_ID',
        message: `CSV parameter row at line ${row.lineNumber} duplicates parameter_id ${JSON.stringify(id)}; second occurrence skipped.`,
        sourceRef: ref,
      }),
    );
    return;
  }

  const dataType = parseParameterDataType(cells['data_type']);
  if (!dataType) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_PARAMETER_METADATA_NOT_NUMERIC',
        message: `CSV parameter row at line ${row.lineNumber} (id ${JSON.stringify(id)}) declares data_type ${JSON.stringify(cells['data_type'] ?? '')}; expected one of int / dint / real (numeric only — bool parameters cannot back a numeric output role per PIR R-EQ-05).`,
        sourceRef: ref,
        hint: 'set data_type to int, dint, or real.',
      }),
    );
    return;
  }

  const defaultValue = parseParameterDefault(cells['default']);
  if (defaultValue === null) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_PARAMETER_METADATA_INCOMPLETE',
        message: `CSV parameter row at line ${row.lineNumber} (id ${JSON.stringify(id)}) is missing or has an unparseable \`default\` (got ${JSON.stringify(cells['default'] ?? '')}).`,
        sourceRef: ref,
        hint: 'set `default` to a finite number; unit conversion is the operator\'s responsibility — Sprint 88L does no scaling.',
      }),
    );
    return;
  }

  // Sprint 97 — optional numeric bounds. Every step is explicit:
  // an unparseable value is rejected with a per-row diagnostic and
  // the bound is dropped (the row keeps the rest of its metadata).
  const minRaw = cells['min'];
  const maxRaw = cells['max'];
  let minValue: number | undefined;
  if (minRaw !== undefined && minRaw.trim().length > 0) {
    const n = Number(minRaw.trim());
    if (Number.isFinite(n)) {
      minValue = n;
    } else {
      draft.diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_PARAMETER_RANGE_INVALID',
          message: `CSV parameter row at line ${row.lineNumber} (id ${JSON.stringify(id)}) has unparseable min ${JSON.stringify(minRaw)}; bound dropped.`,
          sourceRef: ref,
          hint: 'set `min` to a finite number, or leave the column empty to omit the bound.',
        }),
      );
    }
  }
  let maxValue: number | undefined;
  if (maxRaw !== undefined && maxRaw.trim().length > 0) {
    const n = Number(maxRaw.trim());
    if (Number.isFinite(n)) {
      maxValue = n;
    } else {
      draft.diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_PARAMETER_RANGE_INVALID',
          message: `CSV parameter row at line ${row.lineNumber} (id ${JSON.stringify(id)}) has unparseable max ${JSON.stringify(maxRaw)}; bound dropped.`,
          sourceRef: ref,
          hint: 'set `max` to a finite number, or leave the column empty to omit the bound.',
        }),
      );
    }
  }
  if (
    minValue !== undefined &&
    maxValue !== undefined &&
    minValue > maxValue
  ) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_PARAMETER_RANGE_INVALID',
        message: `CSV parameter row at line ${row.lineNumber} (id ${JSON.stringify(id)}) has min ${minValue} greater than max ${maxValue}; bounds dropped.`,
        sourceRef: ref,
      }),
    );
    minValue = undefined;
    maxValue = undefined;
  }
  if (
    minValue !== undefined &&
    defaultValue < minValue
  ) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_PARAMETER_DEFAULT_OUT_OF_RANGE',
        message: `CSV parameter row at line ${row.lineNumber} (id ${JSON.stringify(id)}) default ${defaultValue} is below min ${minValue}; PIR R-PR-02 will reject this on build.`,
        sourceRef: ref,
      }),
    );
  }
  if (
    maxValue !== undefined &&
    defaultValue > maxValue
  ) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_PARAMETER_DEFAULT_OUT_OF_RANGE',
        message: `CSV parameter row at line ${row.lineNumber} (id ${JSON.stringify(id)}) default ${defaultValue} is above max ${maxValue}; PIR R-PR-02 will reject this on build.`,
        sourceRef: ref,
      }),
    );
  }

  seenIds.add(id);
  const param: PirParameterCandidate = {
    id,
    label: cells['label']?.length ? cells['label'] : undefined,
    dataType,
    defaultValue,
    unit: cells['unit']?.length ? cells['unit'] : undefined,
    description: cells['comment']?.length ? cells['comment'] : undefined,
    sourceRefs: [ref],
    confidence: confidenceOf(0.9, 'csv parameter row with explicit metadata'),
  };
  if (minValue !== undefined) param.min = minValue;
  if (maxValue !== undefined) param.max = maxValue;
  // Drop undefined optional keys so the candidate stays JSON-clean.
  if (param.label === undefined) delete (param as { label?: string }).label;
  if (param.unit === undefined) delete (param as { unit?: string }).unit;
  if (param.description === undefined) {
    delete (param as { description?: string }).description;
  }
  draft.parameters.push(param);
  draft.diagnostics.push(
    createElectricalDiagnostic({
      code: 'CSV_PARAMETER_EXTRACTED',
      message: `parameter ${JSON.stringify(id)} (${dataType}, default=${defaultValue}${param.unit ? `, unit=${param.unit}` : ''}${param.min !== undefined ? `, min=${param.min}` : ''}${param.max !== undefined ? `, max=${param.max}` : ''}) extracted from CSV row ${row.lineNumber}.`,
      sourceRef: ref,
    }),
  );
}

function extractSetpointBindingRow(
  row: CsvRow,
  context: { sourceId: string; fileName?: string },
  draft: ElectricalParameterDraft,
): void {
  const cells = row.cells;
  // Equipment id can land in either `tag` (matches the existing
  // device-row convention) or the explicit `parameter_id`-cousin we
  // give for clarity. We accept both; `tag` wins when both set.
  const equipmentId = (cells['tag'] ?? '').trim();
  const role = (cells['role'] ?? '').trim();
  const parameterId = (cells['parameter_id'] ?? '').trim();
  const ref = makeRowRef(
    context.sourceId,
    context.fileName,
    row.lineNumber,
    equipmentId || undefined,
    cells['sheet'] ?? cells['page'],
  );

  if (equipmentId.length === 0) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_SETPOINT_BINDING_TARGET_MISSING',
        message: `CSV setpoint_binding row at line ${row.lineNumber} has no equipment id (tag column is empty).`,
        sourceRef: ref,
      }),
    );
    return;
  }
  if (role.length === 0) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_SETPOINT_BINDING_ROLE_UNSUPPORTED',
        message: `CSV setpoint_binding row at line ${row.lineNumber} has no \`role\` column.`,
        sourceRef: ref,
        hint: 'set role to a numeric output role on the target equipment (currently only `speed_setpoint_out`).',
      }),
    );
    return;
  }
  if (!SUPPORTED_SETPOINT_ROLES.has(role)) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_SETPOINT_BINDING_ROLE_UNSUPPORTED',
        message: `CSV setpoint_binding row at line ${row.lineNumber} declares role ${JSON.stringify(role)}; Sprint 88L only supports ${[...SUPPORTED_SETPOINT_ROLES].map((r) => JSON.stringify(r)).join(', ')}.`,
        sourceRef: ref,
      }),
    );
    return;
  }
  if (parameterId.length === 0) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'CSV_SETPOINT_BINDING_PARAMETER_MISSING',
        message: `CSV setpoint_binding row at line ${row.lineNumber} (equipment ${JSON.stringify(equipmentId)}, role ${JSON.stringify(role)}) has no \`parameter_id\`.`,
        sourceRef: ref,
      }),
    );
    return;
  }

  const map = draft.setpointBindings[equipmentId] ?? {};
  map[role] = parameterId;
  draft.setpointBindings[equipmentId] = map;
}

/**
 * Direct text-based ingestion entry point. Used by the registry-
 * facing wrapper below, but also useful in tests / consumers that
 * already have the CSV string in memory.
 */
export function ingestElectricalCsv(
  input: CsvElectricalIngestionInput,
): ElectricalIngestionResult {
  const sourceId = input.sourceId;
  const fileName = input.fileName;
  const text = input.text;
  const parsed = parseElectricalCsv(text, { sourceId, fileName });
  const diagnostics: ElectricalDiagnostic[] = [...parsed.diagnostics];
  const allNodes: ElectricalNode[] = [];
  const allEdges: ElectricalEdge[] = [];

  // Track duplicate tags + duplicate addresses across rows.
  const seenTags = new Map<string, number>();
  const channelToDevices = new Map<string, string[]>();

  // Sprint 88L — parameter draft accumulator. Populated from
  // `row_kind=parameter` and `row_kind=setpoint_binding` rows; only
  // attached to graph.metadata when non-empty so legacy CSVs stay
  // metadata-clean.
  const parameterDraft: ElectricalParameterDraft = {
    parameters: [],
    setpointBindings: {},
    diagnostics: [],
  };
  const seenParameterIds = new Set<string>();

  for (const row of parsed.rows) {
    const rowKind = (row.cells['row_kind'] ?? '').toLowerCase();
    if (rowKind === 'parameter') {
      extractParameterRow(
        row,
        { sourceId, fileName },
        parameterDraft,
        seenParameterIds,
      );
      continue;
    }
    if (rowKind === 'setpoint_binding') {
      extractSetpointBindingRow(row, { sourceId, fileName }, parameterDraft);
      continue;
    }

    const tag = row.cells['tag'];
    if (tag && tag.length > 0) {
      if (seenTags.has(tag)) {
        diagnostics.push(
          createElectricalDiagnostic({
            code: 'CSV_DUPLICATE_TAG',
            message: `CSV row at line ${row.lineNumber} has duplicate tag ${JSON.stringify(tag)} (first seen at line ${seenTags.get(tag)}). Row skipped.`,
            sourceRef: makeRowRef(sourceId, fileName, row.lineNumber, tag),
          }),
        );
        continue;
      }
      seenTags.set(tag, row.lineNumber);
    }

    const fragment = mapCsvRowToGraphFragment(row, { sourceId, fileName });
    diagnostics.push(...fragment.diagnostics);

    // Merge fragment nodes/edges, deduplicating by id + propagating
    // source refs for shared infrastructure (terminals / cables /
    // wires / channels referenced by multiple rows).
    for (const n of fragment.nodes) {
      const existing = allNodes.find((x) => x.id === n.id);
      if (!existing) {
        allNodes.push(n);
      } else {
        existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, n.sourceRefs);
      }
    }
    for (const e of fragment.edges) {
      const existing = allEdges.find((x) => x.id === e.id);
      if (!existing) {
        allEdges.push(e);
      } else {
        existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, e.sourceRefs);
      }
    }

    // Address-uniqueness tracking — multiple devices on same channel
    // is a real but suspicious situation; flag with a warning.
    const channelNode = fragment.nodes.find((n) => n.kind === 'plc_channel');
    const deviceNode = fragment.nodes.find((n) => n.kind !== 'plc_channel' && n.id.startsWith('device:'));
    if (channelNode && deviceNode) {
      const list = channelToDevices.get(channelNode.id) ?? [];
      list.push(deviceNode.id);
      channelToDevices.set(channelNode.id, list);
    }
  }

  for (const [channelId, deviceIds] of channelToDevices) {
    if (deviceIds.length > 1) {
      const node = allNodes.find((n) => n.id === channelId);
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_DUPLICATE_ADDRESS',
          message: `PLC channel ${node?.label ?? channelId} is referenced by ${deviceIds.length} devices (${deviceIds.join(', ')}). This is unusual — review the source.`,
          nodeId: channelId,
          hint:
            'shared inputs (e.g., one sensor wired to multiple devices) are legitimate, but verify against the schematic.',
        }),
      );
    }
  }

  const metadata: ElectricalGraph['metadata'] = {
    sourceFiles: fileName ? [fileName] : [],
    generator: 'electrical-ingest@csv',
  };
  // Sprint 88L — only attach the parameter draft when something
  // structurally explicit was seen. Empty drafts on legacy CSVs
  // leave metadata untouched so the cross-source duplicate
  // detector + snapshots don't see a new always-present field.
  if (
    parameterDraft.parameters.length > 0 ||
    Object.keys(parameterDraft.setpointBindings).length > 0 ||
    parameterDraft.diagnostics.length > 0
  ) {
    metadata.parameterDraft = parameterDraft;
    diagnostics.push(...parameterDraft.diagnostics);
  }
  const graph: ElectricalGraph = {
    id: buildCsvGraphId(sourceId),
    sourceKind: 'csv',
    nodes: allNodes,
    edges: allEdges,
    diagnostics: [...diagnostics],
    metadata,
  };
  return { graph, diagnostics };
}

/**
 * Build a registry-facing ingestor (matches `ElectricalSourceIngestor`
 * shape from `types.ts`). Accepts the same files-list input the
 * source registry uses; one file at a time is parsed, results are
 * merged. CSV files must have `kind === 'csv'` and a `content`
 * field that is either a string or a Uint8Array (UTF-8 decoded).
 */
export function createCsvElectricalIngestor(): ElectricalSourceIngestor {
  return {
    canIngest(input: ElectricalIngestionInput): boolean {
      if (!input || typeof input !== 'object') return false;
      if (!Array.isArray(input.files) || input.files.length === 0) return false;
      return input.files.every(
        (f) => f && typeof f === 'object' && f.kind === 'csv' && f.content !== undefined,
      );
    },
    async ingest(input: ElectricalIngestionInput): Promise<ElectricalIngestionResult> {
      const diagnostics: ElectricalDiagnostic[] = [];
      const allNodes: ElectricalNode[] = [];
      const allEdges: ElectricalEdge[] = [];
      const sourceFiles: string[] = [];

      for (const file of input.files) {
        if (!file || typeof file !== 'object' || file.kind !== 'csv') continue;
        sourceFiles.push(file.path);
        let text: string;
        if (typeof file.content === 'string') {
          text = file.content;
        } else if (file.content instanceof Uint8Array) {
          text = new TextDecoder('utf-8').decode(file.content);
        } else {
          diagnostics.push(
            createElectricalDiagnostic({
              code: 'CSV_EMPTY_INPUT',
              message: `CSV file ${JSON.stringify(file.path)} has no inline content; loader must read the file first.`,
              sourceRef: { sourceId: input.sourceId, kind: 'csv', path: file.path },
            }),
          );
          continue;
        }
        const partial = ingestElectricalCsv({
          sourceId: input.sourceId,
          fileName: file.path,
          text,
          options: input.options,
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
        id: buildCsvGraphId(input.sourceId),
        sourceKind: 'csv',
        nodes: allNodes,
        edges: allEdges,
        diagnostics: [...diagnostics],
        metadata: {
          sourceFiles,
          generator: 'electrical-ingest@csv',
        },
      };
      return { graph, diagnostics };
    },
  };
}
