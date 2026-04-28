// Sprint 77 — pure helpers for the web electrical-ingestion flow.
// React shells call these; the flow itself is deterministic and
// testable in Node (matching the existing web test pattern).
//
// Pipeline:
//
//   detectInputKind(text, fileName?)
//     → ingestElectricalInput(input)              (CSV / EPLAN-XML / unknown)
//     → ElectricalIngestionResult
//     → createCandidateFromIngestionResult(result) → PirDraftCandidate
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

export type DetectedInputKind = 'csv' | 'xml' | 'unknown';

/**
 * Decide whether a free-form text + optional fileName should be
 * routed to the CSV ingestor or the EPLAN XML ingestor.
 *
 *   1. Trust the file extension when present (`.csv`, `.xml`).
 *   2. Otherwise sniff the trimmed content: a leading `<` →
 *      'xml'; otherwise 'csv' (most CSV exports have a header
 *      first line). If the content is empty → 'unknown'.
 *
 * The function is intentionally minimal — Sprint 77 doesn't try
 * to detect EDZ archives, PDFs, or any other binary format.
 */
export function detectInputKind(
  text: string,
  fileName?: string | null,
): DetectedInputKind {
  if (typeof fileName === 'string' && fileName.length > 0) {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.csv')) return 'csv';
    if (lower.endsWith('.xml')) return 'xml';
  }
  if (typeof text !== 'string') return 'unknown';
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'unknown';
  if (trimmed.startsWith('<')) return 'xml';
  // Heuristic: a CSV header has commas in the first non-blank line.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.includes(',')) return 'csv';
  return 'unknown';
}

export interface ElectricalInputDescriptor {
  /** Required — used for SourceRef.sourceId. */
  sourceId: string;
  /** Required body — UTF-8 text or pre-decoded bytes. */
  text: string;
  /** Optional file name — used for SourceRef.path + extension detection. */
  fileName?: string;
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

  const kind = detectInputKind(input.text, input.fileName);
  const file: ElectricalSourceFile = {
    path: input.fileName ?? `${input.sourceId}.${kind === 'xml' ? 'xml' : 'csv'}`,
    kind: kind === 'unknown' ? 'unknown' : kind,
    content: input.text,
  };
  const registryInput: ElectricalIngestionInput = {
    sourceId: input.sourceId,
    files: [file],
  };

  // Sprint 78A — route through the default registry so the
  // Beckhoff/TwinCAT ECAD recognizer + the EPLAN XML ingestor both
  // get a chance at the input. Earlier sprints called individual
  // ingestors directly, but that bypassed the TcECAD detection
  // chain. We still keep the explicit unsupported fall-through
  // for `unknown` so the diagnostic message is friendly.
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
  const detectedKind = detectInputKind(input.text, input.fileName);
  const result = await ingestElectricalInput(input);
  const candidate = createCandidateFromIngestionResult(result);
  return { result, candidate, detectedKind };
}
