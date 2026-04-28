// Sprint 72 — canonical, source-agnostic types for the electrical
// ingestion pipeline. Every concrete source (EPLAN export, CSV
// terminal list, PDF fallback, manual entry) normalises into the
// types in this file. Nothing here is EPLAN-specific.
//
// Key principle: every node, edge, and IO candidate carries
// `sourceRefs` and `confidence`. Generators that invent data without
// either are violating the architecture — keep that invariant in
// the helpers.

export type ElectricalSourceKind =
  | 'eplan'
  | 'eplan-export'
  | 'pdf'
  | 'csv'
  | 'xml'
  | 'manual'
  // Sprint 78A — Beckhoff/TwinCAT ECAD import XML. NOT EPLAN; this
  // is a separate ECAD-export shape used by Beckhoff/TwinCAT
  // tooling. Recognised by the dedicated TcECAD ingestor.
  | 'twincat_ecad'
  | 'unknown';

export interface SourceRef {
  /** Stable id for the originating source (e.g. file uuid, batch id). */
  sourceId: string;
  kind: ElectricalSourceKind;
  /** Human-readable page label (e.g. "10", "EPL=01+S1.10"). */
  page?: string;
  /** Sheet/sub-page identifier within multi-sheet pages. */
  sheet?: string;
  /** File path when the source is a local file. */
  path?: string;
  /** Symbol identifier from the source software (e.g. EPLAN function id). */
  symbol?: string;
  /** Line number in a text source (CSV / XML). */
  line?: number;
  /** Column number in a text source. */
  column?: number;
  /** Raw identifier as it appeared in the source (e.g. EPLAN device tag). */
  rawId?: string;
  // ---- Sprint 79: PDF source-trace fields. Optional on every kind so
  // ---- the existing CSV/EPLAN/TcECAD ingestors are unaffected.
  /**
   * Visual region inside the page that originated the evidence.
   * Coordinates use whatever unit the producer ingestor declares
   * (`PdfBoundingBox.unit`). Optional — not every PDF block carries
   * geometry.
   */
  bbox?: SourceRefBoundingBox;
  /**
   * Short text excerpt copied verbatim from the source — useful for
   * the review UI's "show me what you saw" drilldown. Snippets are
   * intentionally short (≤ a sentence-ish) and never the full page.
   */
  snippet?: string;
}

/**
 * Sprint 79 — bounding-box variant carried inside `SourceRef.bbox`.
 * The `PdfBoundingBox` shape under `pdf-types.ts` is the canonical
 * one for PDF text blocks; this duplicate-shaped type lives here so
 * `SourceRef` can stay free of cross-module dependencies (the type
 * file is at the top of the dependency DAG).
 */
export interface SourceRefBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Unit hint. `'pt'` is the PDF native point (1/72 inch).
   * `'normalized'` means coordinates are in `[0, 1]` relative to
   * page width/height. Producers should pick one and stick to it
   * across a single ingestion result.
   */
  unit?: 'pt' | 'px' | 'normalized';
}

export interface Confidence {
  /** Float in [0, 1]. Helpers in `confidence.ts` clamp to this range. */
  score: number;
  /** Human-readable reasons; deterministic order, deduplicated. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export type ElectricalNodeKind =
  | 'device'
  | 'terminal'
  | 'terminal_strip'
  | 'connector'
  | 'wire'
  | 'cable'
  | 'plc'
  | 'plc_module'
  | 'plc_channel'
  | 'sensor'
  | 'actuator'
  | 'motor'
  | 'valve'
  | 'safety_device'
  | 'power_supply'
  | 'unknown';

export interface ElectricalNode {
  id: string;
  kind: ElectricalNodeKind;
  label?: string;
  tags?: string[];
  sourceRefs: SourceRef[];
  confidence: Confidence;
  attributes: Record<string, string | number | boolean>;
}

export type ElectricalEdgeKind =
  | 'connected_to'
  | 'wired_to'
  | 'belongs_to'
  | 'mounted_on'
  | 'supplies'
  | 'drives'
  | 'signals'
  | 'maps_to_channel'
  | 'unknown';

export interface ElectricalEdge {
  id: string;
  kind: ElectricalEdgeKind;
  /** Endpoint node ids — must exist in the graph; validator checks this. */
  from: string;
  to: string;
  sourceRefs: SourceRef[];
  confidence: Confidence;
  attributes: Record<string, string | number | boolean>;
}

export interface ElectricalGraph {
  id: string;
  name?: string;
  sourceKind: ElectricalSourceKind;
  nodes: ElectricalNode[];
  edges: ElectricalEdge[];
  diagnostics: ElectricalDiagnostic[];
  metadata: {
    createdAt?: string;
    sourceFiles?: string[];
    generator?: string;
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type ElectricalDiagnosticSeverity = 'error' | 'warning' | 'info';

export type ElectricalDiagnosticCode =
  | 'DUPLICATE_NODE_ID'
  | 'EDGE_ENDPOINT_MISSING'
  | 'AMBIGUOUS_DEVICE_KIND'
  | 'LOW_CONFIDENCE_DEVICE_CLASSIFICATION'
  | 'PLC_CHANNEL_UNRESOLVED'
  | 'PLC_CHANNEL_DUPLICATE_MAPPING'
  | 'IO_SIGNAL_MISSING_ADDRESS'
  | 'SOURCE_REF_MISSING'
  | 'UNSUPPORTED_SOURCE_FEATURE'
  | 'INCOMPLETE_WIRING_CHAIN'
  | 'UNKNOWN_DEVICE_ROLE'
  // ---- Sprint 73: CSV ingestor ----
  | 'CSV_EMPTY_INPUT'
  | 'CSV_MISSING_HEADER'
  | 'CSV_DUPLICATE_HEADER'
  | 'CSV_ROW_WIDTH_MISMATCH'
  | 'CSV_UNCLOSED_QUOTE'
  | 'CSV_UNSUPPORTED_DELIMITER'
  | 'CSV_UNKNOWN_KIND'
  | 'CSV_MISSING_TAG'
  | 'CSV_INVALID_ADDRESS'
  | 'CSV_DUPLICATE_TAG'
  | 'CSV_DUPLICATE_ADDRESS'
  | 'CSV_DIRECTION_ADDRESS_CONFLICT'
  // ---- Sprint 74: EPLAN structured XML ingestor v0 ----
  | 'EPLAN_XML_EMPTY_INPUT'
  | 'EPLAN_XML_MALFORMED'
  | 'EPLAN_XML_UNKNOWN_ROOT'
  | 'EPLAN_XML_UNSUPPORTED_FORMAT'
  | 'EPLAN_XML_MISSING_DEVICE_TAG'
  | 'EPLAN_XML_UNKNOWN_KIND'
  | 'EPLAN_XML_INVALID_ADDRESS'
  | 'EPLAN_XML_DUPLICATE_TAG'
  | 'EPLAN_XML_DUPLICATE_ADDRESS'
  | 'EPLAN_XML_DIRECTION_ADDRESS_CONFLICT'
  | 'EPLAN_XML_MISSING_SOURCE_REF'
  | 'EPLAN_XML_PARTIAL_EXTRACTION'
  // ---- Sprint 78A: Beckhoff/TwinCAT ECAD XML recognizer ----
  | 'TCECAD_XML_DETECTED'
  | 'TCECAD_XML_NO_VARIABLES'
  | 'TCECAD_XML_MISSING_VARIABLE_NAME'
  | 'TCECAD_XML_MISSING_BOX_CONTEXT'
  | 'TCECAD_XML_UNSUPPORTED_IO_DATATYPE'
  | 'TCECAD_XML_UNKNOWN_DIRECTION'
  | 'TCECAD_XML_DUPLICATE_VARIABLE'
  | 'TCECAD_XML_STRUCTURED_ADDRESS_USED'
  | 'TCECAD_XML_DIRECTION_CONFLICT'
  | 'TCECAD_XML_PARTIAL_EXTRACTION'
  // ---- Sprint 79: PDF ingestion architecture v0 ----
  // Document-level / hard-fail conditions:
  | 'PDF_EMPTY_INPUT'
  | 'PDF_MALFORMED'
  | 'PDF_ENCRYPTED_NOT_SUPPORTED'
  | 'PDF_PAGE_LIMIT_EXCEEDED'
  // Capability-not-implemented diagnostics — Sprint 79 deliberately
  // refuses to fake binary parsing / OCR / table detection / electrical
  // extraction, so the operator sees an honest list of what the build
  // does and does not do:
  | 'PDF_UNSUPPORTED_BINARY_PARSER'
  | 'PDF_TEXT_LAYER_UNAVAILABLE'
  | 'PDF_OCR_NOT_ENABLED'
  | 'PDF_TABLE_DETECTION_NOT_IMPLEMENTED'
  | 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED'
  // Per-block / per-row diagnostics raised by the test-mode text
  // ingestor + the simple IO-row extractor:
  | 'PDF_NO_TEXT_BLOCKS'
  | 'PDF_TEXT_BLOCK_EXTRACTED'
  | 'PDF_AMBIGUOUS_IO_ROW'
  // ---- Sprint 80: real text-layer extraction (pdfjs-dist adapter) ----
  // Success path:
  | 'PDF_TEXT_LAYER_EXTRACTED'
  | 'PDF_TEXT_LAYER_EMPTY_PAGE'
  | 'PDF_TEXT_LAYER_BBOX_APPROXIMATED'
  // Failure / fallback paths (the architecture refuses to silently
  // degrade — every failure has a structured code + an honest fall-
  // back to the Sprint 79 test-mode text path when text was also
  // supplied):
  | 'PDF_TEXT_LAYER_EXTRACTION_FAILED'
  | 'PDF_DEPENDENCY_LOAD_FAILED';

export interface ElectricalDiagnostic {
  code: ElectricalDiagnosticCode;
  severity: ElectricalDiagnosticSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  sourceRef?: SourceRef;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Confidence evidence (for confidenceFromEvidence)
// ---------------------------------------------------------------------------

export interface Evidence {
  /** Logical source of the evidence — e.g. "device-name-pattern", "wired-to-plc". */
  source: string;
  /** Float in [0, 1]; clamped by helpers. */
  score: number;
  reason: string;
  /**
   * Optional weight. Default 1.0. Negative weight is allowed and
   * represents *conflicting* evidence — the helpers lower the
   * combined score when conflicting evidence is present.
   */
  weight?: number;
}

// ---------------------------------------------------------------------------
// PIR draft candidate types
// ---------------------------------------------------------------------------
//
// These are intentionally *draft* shapes — Sprint 72 does NOT emit
// final PIR. The candidate carries enough structure to feed a future
// review UI + a future PIR builder, while keeping every claim
// traceable.

export interface PirIoCandidate {
  id: string;
  /** Channel address such as %I0.0, %Q1.7, %IW10. */
  address?: string;
  signalType?: 'bool' | 'int' | 'real' | 'string' | 'unknown';
  direction?: 'input' | 'output' | 'unknown';
  label?: string;
  sourceRefs: SourceRef[];
  confidence: Confidence;
}

export interface PirEquipmentCandidate {
  id: string;
  kind:
    | 'sensor_discrete'
    | 'motor_simple'
    | 'pneumatic_cylinder_2pos'
    | 'valve_solenoid'
    | 'unknown';
  /**
   * Logical role → IO candidate id. e.g. for a 2-pos cylinder:
   *   { extend: "io_q12", retract: "io_q13",
   *     extended: "io_i08", retracted: "io_i09" }
   */
  ioBindings: Record<string, string>;
  sourceRefs: SourceRef[];
  confidence: Confidence;
}

export interface PirMappingAssumption {
  id: string;
  message: string;
  confidence: Confidence;
  sourceRefs: SourceRef[];
}

export interface PirDraftCandidate {
  id: string;
  name?: string;
  io: PirIoCandidate[];
  equipment: PirEquipmentCandidate[];
  diagnostics: ElectricalDiagnostic[];
  assumptions: PirMappingAssumption[];
  /** Id of the source ElectricalGraph the candidate was derived from. */
  sourceGraphId: string;
}

// ---------------------------------------------------------------------------
// EPLAN ingestion interfaces
// ---------------------------------------------------------------------------
//
// Sprint 72 only ships the *interfaces* + an honest unsupported stub.
// Real EPLAN parsing (XML / EDZ macros / EPDZ exports) is future
// work — see docs/electrical-ingestion-architecture.md.

export interface EplanSourceFile {
  path: string;
  kind: 'xml' | 'edz' | 'pdf' | 'csv' | 'unknown';
  /**
   * Optional in-memory content. Real parsers may prefer to read from
   * `path` instead; the interface allows both so callers can stage
   * files in a sandbox or pass already-loaded buffers.
   */
  content?: string | Uint8Array;
}

export interface EplanIngestionOptions {
  /** Prefer structured exports (XML/EDZ) over PDF when both exist. */
  preferStructuredExports?: boolean;
  /**
   * Allow OCR fallback on PDF inputs. Sprint 72 does not implement
   * OCR; this flag exists so future implementations can opt in.
   */
  allowOcr?: boolean;
  /**
   * Filter: drop derived nodes whose confidence is below this score.
   * Default 0 (keep everything; rely on diagnostics for low-confidence
   * filtering).
   */
  minConfidence?: number;
}

export interface EplanIngestionInput {
  sourceId: string;
  files: EplanSourceFile[];
  options?: EplanIngestionOptions;
}

export interface EplanIngestionResult {
  graph: ElectricalGraph;
  diagnostics: ElectricalDiagnostic[];
}

export interface EplanIngestor {
  /**
   * Quick predicate — does this ingestor know how to handle the
   * given input? Implementations should be cheap (look at file
   * extensions / kinds, not parse content).
   */
  canIngest(input: EplanIngestionInput): boolean;
  ingest(input: EplanIngestionInput): Promise<EplanIngestionResult>;
}

// ---------------------------------------------------------------------------
// Sprint 73 — generic source-ingestor types.
// ---------------------------------------------------------------------------
//
// The Sprint 72 EPLAN interfaces above are file-list shaped, which
// happens to be the right model for *every* structured source we'll
// support (EPLAN XML, EPLAN EDZ, CSV, manual JSON). Sprint 73
// promotes them to generic names while keeping the original Eplan*
// names as type aliases so existing call sites keep compiling.
//
// New ingestors (CSV today, EPLAN XML next sprint, etc.) implement
// the generic shape; the source registry consumes whichever name.

export type ElectricalIngestionInput = EplanIngestionInput;
export type ElectricalIngestionOptions = EplanIngestionOptions;
export type ElectricalSourceFile = EplanSourceFile;
export type ElectricalIngestionResult = EplanIngestionResult;
export type ElectricalSourceIngestor = EplanIngestor;
