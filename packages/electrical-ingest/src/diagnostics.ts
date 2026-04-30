// Sprint 72 — diagnostic helpers for the electrical ingestion
// pipeline. Diagnostics are immutable plain objects; the helpers
// here are pure (no I/O, deterministic ordering, no Date.now).

import type {
  ElectricalDiagnostic,
  ElectricalDiagnosticCode,
  ElectricalDiagnosticSeverity,
  SourceRef,
} from './types.js';

const SEVERITY_RANK: Record<ElectricalDiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export interface CreateDiagnosticInput {
  code: ElectricalDiagnosticCode;
  severity?: ElectricalDiagnosticSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  sourceRef?: SourceRef;
  hint?: string;
}

/**
 * Build a single diagnostic. The default severity is inferred from
 * the code: edge-endpoint / duplicate-id / missing-source-ref
 * issues are errors; classification ambiguity / low-confidence are
 * warnings; informational.
 */
export function createElectricalDiagnostic(
  input: CreateDiagnosticInput,
): ElectricalDiagnostic {
  const severity =
    input.severity ?? defaultSeverityForCode(input.code);
  const out: ElectricalDiagnostic = {
    code: input.code,
    severity,
    message: input.message,
  };
  if (input.nodeId !== undefined) out.nodeId = input.nodeId;
  if (input.edgeId !== undefined) out.edgeId = input.edgeId;
  if (input.sourceRef !== undefined) out.sourceRef = input.sourceRef;
  if (input.hint !== undefined) out.hint = input.hint;
  return out;
}

function defaultSeverityForCode(
  code: ElectricalDiagnosticCode,
): ElectricalDiagnosticSeverity {
  switch (code) {
    case 'DUPLICATE_NODE_ID':
    case 'EDGE_ENDPOINT_MISSING':
    case 'SOURCE_REF_MISSING':
    case 'PLC_CHANNEL_DUPLICATE_MAPPING':
    // Sprint 73 — CSV codes that block a row from producing nodes:
    case 'CSV_EMPTY_INPUT':
    case 'CSV_MISSING_HEADER':
    case 'CSV_UNCLOSED_QUOTE':
    case 'CSV_DUPLICATE_HEADER':
    case 'CSV_MISSING_TAG':
    // Sprint 74 — EPLAN-XML errors that block parsing entirely:
    case 'EPLAN_XML_EMPTY_INPUT':
    case 'EPLAN_XML_MALFORMED':
    case 'EPLAN_XML_MISSING_DEVICE_TAG':
    // Sprint 78A — TcECAD errors that skip a variable:
    case 'TCECAD_XML_MISSING_VARIABLE_NAME':
    case 'TCECAD_XML_MISSING_BOX_CONTEXT':
    // Sprint 79 — PDF errors that block ingestion entirely:
    case 'PDF_EMPTY_INPUT':
    case 'PDF_MALFORMED':
    case 'PDF_ENCRYPTED_NOT_SUPPORTED':
    // Sprint 80 — text-layer extractor errors that prevent any
    // text recovery from a binary PDF (the ingestor still falls
    // back to the test-mode text path if text was also supplied):
    case 'PDF_TEXT_LAYER_EXTRACTION_FAILED':
    case 'PDF_DEPENDENCY_LOAD_FAILED':
      return 'error';
    // Sprint 81 — IO-row warnings (per-row issues that don't block
    // ingestion but lower confidence / require operator review):
    case 'PDF_TABLE_ROW_AMBIGUOUS':
    case 'PDF_IO_ROW_AMBIGUOUS':
    case 'PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT':
    case 'PDF_IO_ROW_MISSING_TAG':
    case 'PDF_IO_ROW_MISSING_ADDRESS':
    case 'PDF_TABLE_HEADER_UNSUPPORTED':
    case 'PDF_COLUMN_LAYOUT_UNSUPPORTED':
    case 'PDF_MULTI_COLUMN_ORDER_UNCERTAIN':
    // Sprint 82 — channel-marker safety + ambiguous-address
    // warnings. The extractor preserves the row as evidence but
    // refuses to synthesise a buildable PLC address from a PDF
    // channel marker (e.g. Beckhoff EL1004 `I1` / `O2`):
    case 'PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS':
    case 'PDF_IO_ROW_REQUIRES_STRICT_ADDRESS':
    case 'PDF_IO_ROW_AMBIGUOUS_ADDRESS':
    case 'PDF_PIR_BUILD_ADDRESS_BLOCKED':
      return 'warning';
    case 'AMBIGUOUS_DEVICE_KIND':
    case 'LOW_CONFIDENCE_DEVICE_CLASSIFICATION':
    case 'PLC_CHANNEL_UNRESOLVED':
    case 'IO_SIGNAL_MISSING_ADDRESS':
    case 'INCOMPLETE_WIRING_CHAIN':
    case 'UNKNOWN_DEVICE_ROLE':
    // Sprint 73 — CSV codes that warn but don't block a row:
    case 'CSV_ROW_WIDTH_MISMATCH':
    case 'CSV_UNSUPPORTED_DELIMITER':
    case 'CSV_UNKNOWN_KIND':
    case 'CSV_INVALID_ADDRESS':
    case 'CSV_DUPLICATE_TAG':
    case 'CSV_DUPLICATE_ADDRESS':
    case 'CSV_DIRECTION_ADDRESS_CONFLICT':
    // Sprint 74 — EPLAN-XML warnings (per-element / partial / format):
    case 'EPLAN_XML_UNKNOWN_ROOT':
    case 'EPLAN_XML_UNSUPPORTED_FORMAT':
    case 'EPLAN_XML_UNKNOWN_KIND':
    case 'EPLAN_XML_INVALID_ADDRESS':
    case 'EPLAN_XML_DUPLICATE_TAG':
    case 'EPLAN_XML_DUPLICATE_ADDRESS':
    case 'EPLAN_XML_DIRECTION_ADDRESS_CONFLICT':
    case 'EPLAN_XML_MISSING_SOURCE_REF':
    case 'EPLAN_XML_PARTIAL_EXTRACTION':
    // Sprint 78A — TcECAD warnings (per-variable / partial / format):
    case 'TCECAD_XML_NO_VARIABLES':
    case 'TCECAD_XML_UNSUPPORTED_IO_DATATYPE':
    case 'TCECAD_XML_UNKNOWN_DIRECTION':
    case 'TCECAD_XML_DUPLICATE_VARIABLE':
    case 'TCECAD_XML_STRUCTURED_ADDRESS_USED':
    case 'TCECAD_XML_DIRECTION_CONFLICT':
    case 'TCECAD_XML_PARTIAL_EXTRACTION':
    // Sprint 79 — PDF warnings that explain a missing capability or
    // a per-row extraction issue without blocking the ingestion:
    case 'PDF_UNSUPPORTED_BINARY_PARSER':
    case 'PDF_TEXT_LAYER_UNAVAILABLE':
    case 'PDF_NO_TEXT_BLOCKS':
    case 'PDF_AMBIGUOUS_IO_ROW':
    case 'PDF_PAGE_LIMIT_EXCEEDED':
    // Sprint 80 — empty page after a successful binary parse (text
    // layer exists but page produced zero items — typical for a
    // scanned-image-on-blank page):
    case 'PDF_TEXT_LAYER_EMPTY_PAGE':
      return 'warning';
    case 'UNSUPPORTED_SOURCE_FEATURE':
    case 'TCECAD_XML_DETECTED':
    // Sprint 79 — PDF info diagnostics that document v0 scope:
    case 'PDF_OCR_NOT_ENABLED':
    case 'PDF_TABLE_DETECTION_NOT_IMPLEMENTED':
    case 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED':
    case 'PDF_TEXT_BLOCK_EXTRACTED':
    // Sprint 80 — text-layer extractor success info:
    case 'PDF_TEXT_LAYER_EXTRACTED':
    case 'PDF_TEXT_LAYER_BBOX_APPROXIMATED':
    // Sprint 81 — IO/table extraction success info:
    case 'PDF_TABLE_HEADER_DETECTED':
    case 'PDF_TABLE_CANDIDATE_DETECTED':
    case 'PDF_TABLE_ROW_EXTRACTED':
    case 'PDF_IO_ROW_EXTRACTED':
    case 'PDF_MANUAL_REVIEW_REQUIRED':
    // Sprint 82 — info-level signals: a channel marker was seen
    // (preserved as evidence, but not promoted), and per-row
    // SourceRef-richness reminders.
    case 'PDF_MODULE_CHANNEL_MARKER_DETECTED':
    case 'PDF_SOURCE_SNIPPET_MISSING':
    case 'PDF_SOURCE_BBOX_MISSING':
    // Sprint 83A — table-family classifier signals. None of
    // these are buildable; they exist so the operator's
    // diagnostic stream stays precise (a BOM table is not an
    // IO list — Sprint 81's PDF_TABLE_HEADER_DETECTED no longer
    // fires for non-IO families).
    case 'PDF_BOM_TABLE_DETECTED':
    case 'PDF_TERMINAL_TABLE_DETECTED':
    case 'PDF_CABLE_TABLE_DETECTED':
    case 'PDF_CONTENTS_TABLE_IGNORED':
    case 'PDF_LEGEND_TABLE_IGNORED':
    case 'PDF_TABLE_HEADER_REJECTED':
    case 'PDF_TABLE_HEADER_CLASSIFIED':
    // Sprint 84 — layout-analysis info diagnostics.
    case 'PDF_LAYOUT_MULTI_COLUMN_DETECTED':
    case 'PDF_LAYOUT_ROTATION_SUSPECTED':
    // Sprint 84.1 — region-aware table walking diagnostic.
    case 'PDF_LAYOUT_REGION_CLUSTERED':
    // Sprint 88L — `CSV_PARAMETER_EXTRACTED` is a positive
    // signal that an explicit parameter row landed in the draft.
    case 'CSV_PARAMETER_EXTRACTED':
    // Sprint 88M — same positive signal, structured-source flavour.
    case 'STRUCTURED_PARAMETER_EXTRACTED':
      return 'info';
    // Sprint 88L — duplicate parameter id is a warning (second
    // occurrence skipped; first one wins). All other parameter /
    // setpoint-binding row failures block the row deterministically.
    case 'CSV_PARAMETER_DUPLICATE_ID':
    // Sprint 88M — structured-source duplicate is the same shape.
    case 'STRUCTURED_PARAMETER_DUPLICATE_ID':
      return 'warning';
    case 'CSV_PARAMETER_METADATA_INCOMPLETE':
    case 'CSV_PARAMETER_METADATA_NOT_NUMERIC':
    case 'CSV_SETPOINT_BINDING_TARGET_MISSING':
    case 'CSV_SETPOINT_BINDING_PARAMETER_MISSING':
    case 'CSV_SETPOINT_BINDING_ROLE_UNSUPPORTED':
    // Sprint 88M — structured-source equivalents.
    case 'STRUCTURED_PARAMETER_METADATA_INCOMPLETE':
    case 'STRUCTURED_PARAMETER_METADATA_NOT_NUMERIC':
    case 'STRUCTURED_PARAMETER_DEFAULT_INVALID':
    case 'STRUCTURED_SETPOINT_BINDING_TARGET_MISSING':
    case 'STRUCTURED_SETPOINT_BINDING_PARAMETER_MISSING':
    case 'STRUCTURED_SETPOINT_BINDING_ROLE_UNSUPPORTED':
      return 'error';
    default: {
      // Exhaustiveness — TS will flag a missing case if a code is
      // added to the union and not handled here.
      const _exhaustive: never = code;
      void _exhaustive;
      return 'warning';
    }
  }
}

/**
 * Deduplicate diagnostics. Two diagnostics are equal iff their
 * code + severity + message + nodeId + edgeId + hint match. The
 * `sourceRef` is intentionally not part of the key — multiple
 * source refs raising the same diagnostic compress into one.
 *
 * Order is preserved (first occurrence wins).
 */
export function dedupeElectricalDiagnostics(
  diagnostics: readonly ElectricalDiagnostic[],
): ElectricalDiagnostic[] {
  const seen = new Set<string>();
  const out: ElectricalDiagnostic[] = [];
  for (const d of diagnostics) {
    const key = [
      d.code,
      d.severity,
      d.message,
      d.nodeId ?? '',
      d.edgeId ?? '',
      d.hint ?? '',
    ].join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * Stable, deterministic order:
 *   1. severity (error < warning < info)
 *   2. code (alphabetical)
 *   3. nodeId (alphabetical, undefined last)
 *   4. edgeId (alphabetical, undefined last)
 *   5. message (alphabetical)
 *
 * Sort is non-mutating: caller's array is not modified.
 */
export function sortElectricalDiagnostics(
  diagnostics: readonly ElectricalDiagnostic[],
): ElectricalDiagnostic[] {
  const copy = [...diagnostics];
  copy.sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity];
    const sb = SEVERITY_RANK[b.severity];
    if (sa !== sb) return sa - sb;
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    const an = a.nodeId ?? '￿';
    const bn = b.nodeId ?? '￿';
    if (an !== bn) return an.localeCompare(bn);
    const ae = a.edgeId ?? '￿';
    const be = b.edgeId ?? '￿';
    if (ae !== be) return ae.localeCompare(be);
    return a.message.localeCompare(b.message);
  });
  return copy;
}

/**
 * Convenience: count by severity. Useful for the report-builder
 * `errorCount` / `warningCount` rollup.
 */
export function countDiagnosticsBySeverity(
  diagnostics: readonly ElectricalDiagnostic[],
): Record<ElectricalDiagnosticSeverity, number> {
  const out: Record<ElectricalDiagnosticSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const d of diagnostics) out[d.severity]++;
  return out;
}
