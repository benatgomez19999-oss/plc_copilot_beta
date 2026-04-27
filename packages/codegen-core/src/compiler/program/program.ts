import type { IoSignal } from '@plccopilot/pir';
import type { ArtifactDiagnostic } from '../../types.js';
import type { Diagnostic } from '../diagnostics.js';
import type { FunctionBlockIR } from '../ir/nodes.js';

/**
 * Vendor-neutral target descriptor. Optional in the core IR — backends
 * populate `vendor` / `tiaVersion` (or their own equivalents) at render time.
 */
export interface ProgramTarget {
  vendor?: string;
  tiaVersion?: string;
}

/**
 * Project-level compiler feature flags. Defaults are derived from the PIR in
 * `resolveFeatures` so existing call sites that pass no options keep working.
 *
 *   useDbAlarms                 — alarms resolve via DB_Alarms (canonical IR).
 *                                 Default: machine.alarms.length > 0.
 *   emitFbAlarms                — emit FB_Alarms block (requires useDbAlarms).
 *                                 Default: same as useDbAlarms.
 *   emitDiagnosticsInManifest   — backends include `compiler_diagnostics` in
 *                                 the rendered manifest payload. Default: true.
 *   strictDiagnostics           — any error diagnostic triggers CodegenError
 *                                 at the end of compileProject, regardless of
 *                                 whether station lowering already threw.
 *                                 Default: false.
 */
export interface CompilerFeatures {
  useDbAlarms: boolean;
  emitFbAlarms: boolean;
  emitDiagnosticsInManifest: boolean;
  strictDiagnostics: boolean;
}

export interface TypeFieldIR {
  name: string;
  dataType: string;
  comment?: string;
}

/**
 * Vendor-neutral struct/UDT description. `name` carries the canonical IR
 * spelling (`UDT_Cylinder2Pos`); the Codesys renderer remaps to `DUT_*`,
 * Rockwell uses `name` verbatim. `path` is the canonical logical name —
 * backends compute their filesystem path at render time.
 */
export interface TypeArtifactIR {
  name: string;
  path: string;
  typeKind: 'equipment';
  fields: TypeFieldIR[];
}

export type DataBlockKind = 'params' | 'recipes' | 'alarms' | 'other';

/**
 * Vendor-neutral structured data block. Every backend renders to its own
 * concrete artifact (Siemens `DATA_BLOCK`, Codesys `VAR_GLOBAL`, Rockwell
 * tag list). `name` is the canonical IR spelling; backends remap the
 * namespace via `dbNamespaceFor(backend, name)`.
 */
export interface DataBlockArtifactIR {
  name: string;
  dbKind: DataBlockKind;
  fields: DataFieldIR[];
}

export interface DataFieldIR {
  name: string;
  /** Canonical IR type name ('Bool', 'Int', 'DInt', 'Real'). */
  dataType: string;
  /** Initial value rendered as IR text (e.g. '150.0', 'TRUE', '3000'). */
  initialValue?: string;
  /** Inline trailing comment (no markers — renderer wraps). */
  comment?: string;
  /** Section header rendered above this field (no markers). */
  preComment?: string;
}

/**
 * Source of a tag row — used by backends to decide which logical section the
 * tag belongs to (e.g., Siemens CSV grouping, Codesys GVL split).
 */
export type TagSource = 'io' | 'parameter' | 'station_state';

/**
 * Vendor-neutral tag row. `dataType` is the canonical IR spelling; addresses
 * are carried as the original PIR `IoSignal.address` so each backend renders
 * to its own syntax (`%I0.0`, bare bit position, Logix tag, …) without core
 * leakage.
 */
export interface TagRowIR {
  name: string;
  dataType: string;
  ioAddress?: IoSignal['address'];
  comment?: string;
  source: TagSource;
}

/**
 * Vendor-neutral tag table descriptor. Carries logical name + role + rows;
 * `path`, `format`, and rendered `content` are backend concerns and are NOT
 * present in the core IR.
 */
export interface TagTableArtifactIR {
  name: string;
  kind: 'main';
  rows: TagRowIR[];
}

/**
 * Vendor-neutral manifest metadata. Backends overlay their own physical
 * fields (path, generator, artifactPaths) at render time. Optional fields
 * here are populated by backend wrappers for backward-compatible consumers
 * that read these via `program.manifest`.
 */
export interface ManifestIR {
  /** Backend-specific filesystem path. Filled by backend wrappers/renderers. */
  path?: string;
  /** Backend-specific generator package name. */
  generator?: string;
  generatorVersion?: string;
  pirVersion: string;
  projectId: string;
  projectName: string;
  target?: ProgramTarget;
  /** Backend-specific artifact basenames in emission order. */
  artifactPaths?: string[];
  generatedAt: string;
  compilerDiagnostics: ArtifactDiagnostic[];
  features: CompilerFeatures;
}

/**
 * ProgramIR — the deterministic, vendor-neutral description of a compiled
 * project. Populated by `compileProject` (in `@plccopilot/codegen-core`) and
 * rendered to `GeneratedArtifact[]` by each backend's renderer.
 *
 * Nothing in this tree is Siemens-specific in the core pipeline:
 *   - `target` is optional (backends decide vendor / version)
 *   - `manifest.path` / `manifest.generator` / `manifest.artifactPaths` are
 *     optional (backends fill them at render time)
 *   - `tagTables[].rows[].ioAddress` is the structured PIR address; backends
 *     format it to their own syntax
 */
export interface ProgramIR {
  projectId: string;
  projectName: string;
  pirVersion: string;
  /** Always present; fields are optional and filled by backend wrappers. */
  target: ProgramTarget;
  blocks: FunctionBlockIR[];
  typeArtifacts: TypeArtifactIR[];
  dataBlocks: DataBlockArtifactIR[];
  tagTables: TagTableArtifactIR[];
  manifest: ManifestIR;
  /** Aggregated, sorted, deduplicated diagnostics from every compile pass. */
  diagnostics: Diagnostic[];
  /** Resolved feature flags actually used during this compilation. */
  features: CompilerFeatures;
}
