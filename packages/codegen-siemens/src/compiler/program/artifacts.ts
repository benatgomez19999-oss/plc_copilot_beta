import type { ArtifactDiagnostic, GeneratedArtifact } from '../../types.js';
import { toArtifactDiagnostic } from '../diagnostics.js';
import { renderFunctionBlock } from '../renderers/scl.js';
import { renderDataBlockSiemens } from '../renderers/data-blocks.js';
import { renderTypeArtifactSiemens } from '../renderers/types.js';
import { renderTagsCsv } from '../../generators/tags.js';
import { stableJson } from '../../utils/json.js';
import { SIEMENS_DIR, MANIFEST_PATH } from '../../naming.js';
import type { FunctionBlockIR } from '../ir/nodes.js';
import type { ManifestIR, ProgramIR } from './program.js';

const SIEMENS_GENERATOR = '@plccopilot/codegen-siemens';
const SIEMENS_GENERATOR_VERSION_DEFAULT = '0.1.0';
const SIEMENS_VENDOR_DEFAULT = 'siemens_s7_1500';
const SIEMENS_TIA_VERSION_DEFAULT = '19';

/**
 * Emit every artifact described by the ProgramIR, in the canonical order:
 *
 *   1. Station FBs (blocks)
 *   2. UDTs (typeArtifacts)
 *   3. DBs (dataBlocks)
 *   4. Tag tables
 *   5. manifest.json
 *
 * Station FBs receive the subset of diagnostics that carry their stationId;
 * the manifest receives every diagnostic via `compiler_diagnostics`.
 */
export function renderProgramArtifacts(
  program: ProgramIR,
): GeneratedArtifact[] {
  const out: GeneratedArtifact[] = [];

  for (const fb of program.blocks) {
    out.push(renderBlockArtifact(fb, program));
  }

  for (const t of program.typeArtifacts) {
    const rendered = renderTypeArtifactSiemens(t);
    out.push({ path: rendered.path, kind: 'scl', content: rendered.content });
  }

  for (const db of program.dataBlocks) {
    const rendered = renderDataBlockSiemens(db);
    out.push({ path: rendered.path, kind: 'scl', content: rendered.content });
  }

  for (const tt of program.tagTables) {
    out.push(renderTagsCsv(tt));
  }

  // Compute Siemens-flavoured artifact basenames in emission order. Used as
  // a fallback when `program.manifest.artifactPaths` is missing (i.e., the
  // ProgramIR came from `@plccopilot/codegen-core` directly).
  const artifactBasenames: string[] = [];
  for (const a of out) {
    artifactBasenames.push(
      a.path.includes('/') ? a.path.slice(a.path.lastIndexOf('/') + 1) : a.path,
    );
  }

  out.push(renderManifestArtifact(program.manifest, artifactBasenames));

  return out;
}

function renderBlockArtifact(
  fb: FunctionBlockIR,
  program: ProgramIR,
): GeneratedArtifact {
  const path = `${SIEMENS_DIR}/${fb.name}.scl`;
  const content = renderFunctionBlock(fb);

  const stationDiags: ArtifactDiagnostic[] = fb.stationId
    ? program.diagnostics
        .filter((d) => d.stationId === fb.stationId)
        .map(toArtifactDiagnostic)
    : [];

  const artifact: GeneratedArtifact = { path, kind: 'scl', content };
  if (stationDiags.length > 0) artifact.diagnostics = stationDiags;
  return artifact;
}

/**
 * Render the Siemens manifest. Resilient against neutral ManifestIR coming
 * straight from `@plccopilot/codegen-core` — Siemens-specific fields fall
 * back to their canonical defaults when the IR omits them.
 */
function renderManifestArtifact(
  m: ManifestIR,
  artifactPaths: readonly string[],
): GeneratedArtifact {
  const data: Record<string, unknown> = {
    generator: m.generator ?? SIEMENS_GENERATOR,
    version: m.generatorVersion ?? SIEMENS_GENERATOR_VERSION_DEFAULT,
    pir_version: m.pirVersion,
    project_id: m.projectId,
    project_name: m.projectName,
    target: {
      vendor: m.target?.vendor ?? SIEMENS_VENDOR_DEFAULT,
      tia_version: m.target?.tiaVersion ?? SIEMENS_TIA_VERSION_DEFAULT,
    },
    features: {
      use_db_alarms: m.features.useDbAlarms,
      emit_fb_alarms: m.features.emitFbAlarms,
      emit_diagnostics_in_manifest: m.features.emitDiagnosticsInManifest,
      strict_diagnostics: m.features.strictDiagnostics,
    },
    artifacts: m.artifactPaths ?? artifactPaths,
    generated_at: m.generatedAt,
  };

  if (m.features.emitDiagnosticsInManifest) {
    data.compiler_diagnostics = m.compilerDiagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
      ...(d.path !== undefined ? { path: d.path } : {}),
      ...(d.stationId !== undefined ? { station_id: d.stationId } : {}),
      ...(d.symbol !== undefined ? { symbol: d.symbol } : {}),
      ...(d.hint !== undefined ? { hint: d.hint } : {}),
    }));
  }

  return {
    path: m.path ?? MANIFEST_PATH,
    kind: 'json',
    content: stableJson(data),
  };
}
