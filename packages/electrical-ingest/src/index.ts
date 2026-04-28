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
  ElectricalNode,
  ElectricalNodeKind,
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
