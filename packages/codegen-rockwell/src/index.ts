// =============================================================================
// @plccopilot/codegen-rockwell — EXPERIMENTAL Rockwell / Studio 5000 ST POC
//
// Consumes the vendor-neutral ProgramIR from @plccopilot/codegen-core and
// renders Logix-flavoured `.st` text artifacts:
//   - rockwell/FB_*.st          (station + alarm function blocks)
//   - rockwell/UDT_*.st         (equipment-type UDT POC)
//   - rockwell/TAG_Parameters.st / TAG_Recipes.st / TAG_Alarms.st
//   - rockwell/manifest.json
//
// Backend-specific transformations:
//   - R_TRIG / F_TRIG → one-shot bit pattern (BOOL + companion `_MEM`)
//   - TON kept as pseudo-IEC; flagged by ROCKWELL_TIMER_PSEUDO_IEC
//
// What this POC does NOT do:
//   - emit a `.L5X` archive
//   - declare Logix controller / program / routine tags
//   - lower TON to Logix TIMER instructions
// =============================================================================

export {
  generateRockwellProject,
  renderProgramArtifactsRockwell,
  withRockwellDiagnostics,
  computeRockwellDiagnostics,
  type GenerateRockwellOptions,
} from './generators/rockwell-project.js';
export {
  generateRockwellManifest,
  ROCKWELL_MANIFEST_PATH,
} from './generators/rockwell-manifest.js';
export {
  generateRockwellTagFiles,
  renderRockwellTagFile,
} from './generators/rockwell-tags.js';

// Renderer-level exports.
export {
  renderFunctionBlockRockwell,
  renderExprRockwell,
  renderStmtRockwell,
  renderVarSectionRockwell,
  siemensToRockwellText,
} from './renderers/rockwell-st.js';
export { renderTypeArtifactRockwell } from './renderers/types.js';

// Naming + namespace registry (Rockwell-side; NOT in core).
export { ROCKWELL_DIR, ROCKWELL_NAMESPACES } from './naming.js';
