// Sprint 77 + 78A + 79 — pure helpers for the web electrical-ingestion
// flow. React shells call these; the flow itself is deterministic and
// testable in Node (matching the existing web test pattern).
//
// Pipeline:
//
//   detectInputKind(text, fileName?)
//     → ingestElectricalInput(input)              (CSV / XML / PDF / unknown)
//     → ElectricalIngestionResult
//     → createCandidateFromIngestionResult(result) → PirDraftCandidate
//
// Sprint 79 adds the `'pdf'` input kind. PDF inputs may carry either
// pre-extracted text (test-mode) or raw bytes; both go through the
// default registry's PDF ingestor, which honestly refuses to fake
// binary parsing.
//
// The downstream review + build preview live in
// `pir-build-preview.ts` and the React components.

import {
  buildPirDraftCandidate,
  createDefaultSourceRegistry,
  createUnsupportedEplanIngestor,
  ingestWithRegistry,
  type ElectricalDiagnostic,
  type ElectricalGraph,
  type ElectricalIngestionInput,
  type ElectricalIngestionResult,
  type ElectricalSourceFile,
  type PirDraftCandidate,
} from '@plccopilot/electrical-ingest';

export type DetectedInputKind = 'csv' | 'xml' | 'pdf' | 'unknown';

/**
 * Decide which ingestor a free-form text + optional fileName +
 * (Sprint 79) optional bytes should be routed to.
 *
 *   1. Trust the file extension when present (`.csv`, `.xml`,
 *      `.pdf`).
 *   2. Sprint 79 — if the input has bytes whose first 5 bytes are
 *      the `%PDF-` magic header, classify as `'pdf'`.
 *   3. Otherwise sniff the trimmed text content:
 *        - leading `%PDF-` literal → `'pdf'` (pre-extracted from a
 *          binary PDF that still kept the header on disk),
 *        - leading `<` → `'xml'`,
 *        - first non-blank line contains `,` → `'csv'`.
 *      Empty content → `'unknown'`.
 *
 * The detector is intentionally minimal: it is the *router*, not
 * the *parser*. The actual format validation happens inside each
 * ingestor and surfaces structured diagnostics.
 */
export function detectInputKind(
  text: string,
  fileName?: string | null,
  bytes?: Uint8Array | null,
): DetectedInputKind {
  if (typeof fileName === 'string' && fileName.length > 0) {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.csv')) return 'csv';
    if (lower.endsWith('.xml')) return 'xml';
    if (lower.endsWith('.pdf')) return 'pdf';
  }
  if (bytes instanceof Uint8Array && bytes.length >= 5) {
    if (
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46 &&
      bytes[4] === 0x2d
    ) {
      return 'pdf';
    }
  }
  if (typeof text !== 'string') return 'unknown';
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'unknown';
  if (trimmed.startsWith('%PDF-')) return 'pdf';
  if (trimmed.startsWith('<')) return 'xml';
  // Heuristic: a CSV header has commas in the first non-blank line.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.includes(',')) return 'csv';
  return 'unknown';
}

export interface ElectricalInputDescriptor {
  /** Required — used for SourceRef.sourceId. */
  sourceId: string;
  /**
   * Body as UTF-8 text. May be the pasted CSV/XML, or — for the
   * Sprint 79 PDF test-mode path — a pre-extracted text body. Pass
   * an empty string when only `bytes` are supplied.
   */
  text: string;
  /** Optional file name — used for SourceRef.path + extension detection. */
  fileName?: string;
  /**
   * Sprint 79 — raw bytes for binary inputs (PDF). When supplied the
   * file picker's `arrayBuffer()` result is forwarded verbatim to
   * the registry. The PDF ingestor honours `bytes`; CSV/XML
   * ingestors ignore it.
   */
  bytes?: Uint8Array;
}

/**
 * Hand off the input to the real `@plccopilot/electrical-ingest`
 * registry. Builds an `ElectricalIngestionInput` shaped for the
 * registry-facing ingestors and returns the
 * `ElectricalIngestionResult`. Never throws: malformed input
 * surfaces as diagnostics inside the result's graph.
 *
 * Sprint 77 routes:
 *   - 'csv'     → createCsvElectricalIngestor()
 *   - 'xml'     → createEplanXmlElectricalIngestor()
 *   - 'unknown' → createUnsupportedEplanIngestor() (returns empty
 *                 graph + UNSUPPORTED_SOURCE_FEATURE diagnostics)
 *
 * The registry is constructed inline here (not the package's
 * `createDefaultSourceRegistry`) because Sprint 77 wants explicit
 * routing — easy to follow when reading the web flow.
 */
export async function ingestElectricalInput(
  input: ElectricalInputDescriptor,
): Promise<ElectricalIngestionResult> {
  if (!input || typeof input !== 'object') {
    return synthesiseEmptyResult('input must be an object.');
  }
  if (typeof input.sourceId !== 'string' || input.sourceId.length === 0) {
    return synthesiseEmptyResult('sourceId is required.');
  }
  if (typeof input.text !== 'string') {
    return synthesiseEmptyResult('text must be a string.');
  }

  const kind = detectInputKind(input.text, input.fileName, input.bytes);
  // Sprint 79 — for PDF, prefer raw bytes when supplied; otherwise
  // fall back to the pre-extracted-text path. CSV/XML keep using
  // the text content verbatim.
  const fileExt =
    kind === 'xml' ? 'xml' : kind === 'pdf' ? 'pdf' : 'csv';
  const content =
    kind === 'pdf' && input.bytes instanceof Uint8Array && input.bytes.length > 0
      ? input.bytes
      : input.text;
  const file: ElectricalSourceFile = {
    path: input.fileName ?? `${input.sourceId}.${fileExt}`,
    kind: kind === 'unknown' ? 'unknown' : kind,
    content,
  };
  const registryInput: ElectricalIngestionInput = {
    sourceId: input.sourceId,
    files: [file],
  };

  // Sprint 78A — route through the default registry so every
  // recognizer (CSV → TcECAD → EPLAN → PDF → unsupported) gets a
  // chance at the input. We still keep the explicit unsupported
  // fall-through for `unknown` so the diagnostic message is
  // friendly.
  if (kind === 'unknown') {
    return createUnsupportedEplanIngestor().ingest(registryInput);
  }
  return ingestWithRegistry(createDefaultSourceRegistry(), registryInput);
}

function synthesiseEmptyResult(message: string): ElectricalIngestionResult {
  const diag: ElectricalDiagnostic = {
    code: 'UNSUPPORTED_SOURCE_FEATURE',
    severity: 'error',
    message: `electrical-ingestion-flow: ${message}`,
  };
  const graph: ElectricalGraph = {
    id: 'electrical-ingestion-flow:invalid',
    sourceKind: 'unknown',
    nodes: [],
    edges: [],
    diagnostics: [diag],
    metadata: { generator: 'electrical-ingestion-flow@sprint-77' },
  };
  return { graph, diagnostics: [diag] };
}

/**
 * Convert an `ElectricalIngestionResult` (which contains the graph
 * and the registry-side diagnostics) into a `PirDraftCandidate`.
 * The candidate carries the graph's diagnostics so downstream
 * panels surface them.
 */
export function createCandidateFromIngestionResult(
  result: ElectricalIngestionResult,
): PirDraftCandidate {
  return buildPirDraftCandidate(result.graph);
}

/**
 * Convenience: detect kind + ingest + build candidate in one pass.
 * Useful for the React shell that just needs the candidate.
 */
export async function runElectricalIngestion(
  input: ElectricalInputDescriptor,
): Promise<{
  result: ElectricalIngestionResult;
  candidate: PirDraftCandidate;
  detectedKind: DetectedInputKind;
}> {
  const detectedKind = detectInputKind(input.text, input.fileName, input.bytes);
  const result = await ingestElectricalInput(input);
  const candidate = createCandidateFromIngestionResult(result);
  return { result, candidate, detectedKind };
}

// =============================================================================
// canIngestElectricalSource — pure predicate behind the workspace's
// "Ingest" button. Sprint 81 fix: PDF binary uploads must enable
// the button even when the textarea is empty.
// =============================================================================

export interface CanIngestElectricalSourceInput {
  /** Detected input kind (CSV / XML / PDF / unknown). */
  inputKind: DetectedInputKind;
  /** Pasted text in the workspace textarea. */
  sourceText: string;
  /**
   * Bytes from a binary file upload (Sprint 79 PDF). For non-PDF
   * inputs this is always null.
   */
  bytes: Uint8Array | null;
  /** Whether an ingestion is already in flight. */
  pending: boolean;
}

/**
 * Decide whether the workspace's Ingest button should be enabled.
 *
 * Rule:
 *   - never while an ingestion is pending,
 *   - true when there is non-empty text (any input kind), OR
 *   - true when the input kind is `'pdf'` AND bytes are loaded
 *     (the binary path produces valid PDF evidence on its own).
 *
 * Pure / DOM-free / total. The component should derive its
 * `disabled` attribute from `!canIngestElectricalSource(...)`.
 */
export function canIngestElectricalSource(
  input: CanIngestElectricalSourceInput,
): boolean {
  if (!input || typeof input !== 'object') return false;
  if (input.pending === true) return false;
  const hasSourceText =
    typeof input.sourceText === 'string' && input.sourceText.trim().length > 0;
  const hasPdfBytes =
    input.inputKind === 'pdf' &&
    input.bytes instanceof Uint8Array &&
    input.bytes.length > 0;
  return hasSourceText || hasPdfBytes;
}
