// Sprint 72 — public surface for `@plccopilot/electrical-ingest`.
//
// This package is private (not on npm). The barrel is here so
// internal consumers (web app, future codegen layers, future PIR
// builder) import from a single path:
//
//   import { ElectricalGraph, buildPirDraftCandidate } from '@plccopilot/electrical-ingest';
//
// Sprint 72 explicitly does NOT ship a real EPLAN parser, a PDF/OCR
// pipeline, or a final PIR generator. See
// docs/electrical-ingestion-architecture.md for the scope contract.

export type {
  Confidence,
  ElectricalDiagnostic,
  ElectricalDiagnosticCode,
  ElectricalDiagnosticSeverity,
  ElectricalEdge,
  ElectricalEdgeKind,
  ElectricalGraph,
  ElectricalIngestionInput,
  ElectricalIngestionOptions,
  ElectricalIngestionResult,
  ElectricalNode,
  ElectricalNodeKind,
  ElectricalSourceFile,
  ElectricalSourceIngestor,
  ElectricalSourceKind,
  EplanIngestionInput,
  EplanIngestionOptions,
  EplanIngestionResult,
  EplanIngestor,
  EplanSourceFile,
  Evidence,
  PirDraftCandidate,
  PirEquipmentCandidate,
  PirIoCandidate,
  PirMappingAssumption,
  SourceRef,
  SourceRefBoundingBox,
} from './types.js';

export {
  CONFIDENCE_ONE,
  CONFIDENCE_ZERO,
  clampConfidence,
  combineConfidence,
  confidenceFromEvidence,
  confidenceOf,
  minConfidence,
} from './confidence.js';

export {
  countDiagnosticsBySeverity,
  createElectricalDiagnostic,
  dedupeElectricalDiagnostics,
  sortElectricalDiagnostics,
} from './diagnostics.js';

export type {
  ElectricalGraphIndex,
  TracePathOptions,
  ValidationOptions,
} from './graph.js';

export {
  connectedComponents,
  findEdgesFrom,
  findEdgesTo,
  findNode,
  indexElectricalGraph,
  tracePath,
  validateElectricalGraph,
} from './graph.js';

export type { DetectedAddress } from './normalize.js';
export {
  detectPlcAddress,
  normalizeAttributes,
  normalizeLabel,
  normalizeNodeId,
} from './normalize.js';

export {
  formatSourceRef,
  mergeSourceRefs,
  sourceRefsEqual,
} from './sources/trace.js';

export {
  createUnsupportedEplanIngestor,
} from './sources/eplan.js';

export type {
  CsvCanonicalHeader,
  CsvElectricalIngestionInput,
  CsvElectricalIngestionOptions,
  CsvParseOptions,
  CsvParseResult,
  CsvRow,
  RowMappingResult,
} from './sources/csv.js';
export {
  CSV_CANONICAL_HEADERS,
  CSV_HEADER_ALIASES,
  buildCsvGraphId,
  createCsvElectricalIngestor,
  ingestElectricalCsv,
  mapCsvRowToGraphFragment,
  parseElectricalCsv,
} from './sources/csv.js';

// Sprint 74 — EPLAN structured XML ingestor v0.
export type {
  EplanXmlDetectedFormat,
  EplanXmlElementRecord,
  EplanXmlIngestionInput,
  EplanXmlIngestionOptions,
  EplanXmlParseResult,
  XmlRowMappingResult,
} from './sources/eplan-xml.js';
export {
  buildEplanXmlGraphId,
  createEplanXmlElectricalIngestor,
  detectEplanXmlFormat,
  ingestEplanXml,
  mapEplanXmlElementToFragment,
  parseEplanXml,
} from './sources/eplan-xml.js';

// Shared kind-alias table (Sprint 74 — extracted so multiple
// ingestors share one source of truth).
export { KIND_ALIASES, knownKindHintList } from './mapping/kind-aliases.js';

// Minimal XML utilities exposed for tests + future structured
// ingestors. These are pure helpers, not a full DOM.
export type { XmlAttribute, XmlElement, XmlParseError, XmlParseResult } from './sources/xml-utils.js';
export {
  decodeEntities,
  findAllElements,
  findElement,
  getAttribute,
  getChildText,
  parseXml,
  walkElements,
} from './sources/xml-utils.js';

export type { SourceRegistry } from './sources/generic.js';
export {
  createDefaultSourceRegistry,
  createSourceRegistry,
  ingestWithRegistry,
} from './sources/generic.js';

export type {
  InferredEquipmentRole,
  InferredIoRole,
} from './mapping/io-role-inference.js';
export {
  inferEquipmentRole,
  inferIoRole,
} from './mapping/io-role-inference.js';

export type { BuildPirDraftCandidateOptions } from './mapping/pir-candidate.js';
export {
  blockingDiagnostics,
  buildPirDraftCandidate,
} from './mapping/pir-candidate.js';

// Sprint 76 — PIR builder v0.
export type {
  PirBuildReviewDecision,
  PirBuildReviewedItemState,
  PirBuildReviewState,
} from './mapping/review-types.js';
export {
  PIR_BUILD_REVIEW_DECISIONS,
  getReviewedDecision,
} from './mapping/review-types.js';
export type {
  ParsedIoAddress,
  PirBuildDiagnostic,
  PirBuildDiagnosticCode,
  PirBuildOptions,
  PirBuildResult,
} from './mapping/pir-builder.js';
export {
  buildPirFromReviewedCandidate,
  canonicalisePirId,
  hasReviewableCandidates,
  isReviewedCandidateReadyForPirBuild,
  mapCandidateDirection,
  mapCandidateEquipmentKind,
  parseCandidateAddress,
  remapEquipmentRoles,
} from './mapping/pir-builder.js';

// Sprint 78A — Beckhoff/TwinCAT ECAD XML recognizer.
export type {
  TcecadIngestionInput,
  TcecadIngestionOptions,
  TcecadParseResult,
  TcecadVariableRecord,
} from './sources/twincat-ecad-xml.js';
export {
  buildTcecadGraphId,
  createTcecadXmlElectricalIngestor,
  detectTcecadXml,
  extractTcecadVariables,
  ingestTcecadXml,
  parseTcecadXml,
} from './sources/twincat-ecad-xml.js';

// Sprint 79 → 80 → 81 — PDF ingestion architecture + real text-
// layer extraction + IO-list table detection.
export type {
  PdfBoundingBox,
  PdfDocument,
  PdfDocumentMetadata,
  PdfIngestionInput,
  PdfIngestionOptions,
  PdfPage,
  PdfParseResult,
  PdfTableCandidate,
  PdfTableColumn,
  PdfTableColumnRole,
  PdfTableHeaderLayout,
  PdfTableRowCandidate,
  PdfTextBlock,
} from './sources/pdf-types.js';
export type { IngestPdfResult } from './sources/pdf.js';
export {
  buildPdfGraphId,
  createPdfElectricalIngestor,
  detectPdf,
  ingestPdf,
  parsePdfDocument,
} from './sources/pdf.js';

// Sprint 80 — pdfjs-dist text-layer adapter + line-grouping helpers.
// Exposed so future ingestors / debug tooling can call the same
// extractor; web code should keep going through `ingestPdf`.
export type {
  PdfTextLayerExtractionInput,
  PdfTextLayerExtractionResult,
  PdfTextLayerItem,
  PdfTextLayerPage,
} from './sources/pdf-text-layer.js';
export { extractPdfTextLayer } from './sources/pdf-text-layer.js';
export type {
  GroupItemsIntoLinesOptions,
  PdfTextLayerLine,
} from './sources/pdf-text-normalize.js';
export {
  combineBbox,
  groupItemsIntoLines,
} from './sources/pdf-text-normalize.js';

// Sprint 81 — IO-list table detection helpers.
export type {
  PdfTableDetectionResult,
  PdfTableDetectorLine,
} from './sources/pdf-table-detect.js';
export {
  detectIoTableHeader,
  detectIoTables,
  looksLikeIoRow,
} from './sources/pdf-table-detect.js';

// Sprint 82 — PDF-specific address strictness.
export type {
  PdfAddressClassification,
  PdfAddressClassificationResult,
} from './sources/pdf-address-strictness.js';
export {
  classifyPdfAddress,
  isPdfChannelMarker,
  isStrictPdfPlcAddress,
} from './sources/pdf-address-strictness.js';
