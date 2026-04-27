// =============================================================================
// @plccopilot/codegen-codesys — EXPERIMENTAL Codesys / IEC 61131-3 ST backend
//
// Consumes the vendor-neutral ProgramIR from @plccopilot/codegen-core and
// renders Codesys-flavoured `.st` text artifacts:
//   - codesys/FB_*.st       (station + alarm function blocks)
//   - codesys/DUT_*.st      (equipment-type DUTs)
//   - codesys/GVL_*.st      (parameters / recipes / alarms namespaces)
//   - codesys/manifest.json
//
// What this POC does NOT do:
//   - emit a packaged `.project` Codesys archive
//   - declare global IO mappings
//   - generate POU pinmap / device tree / fieldbus config
// =============================================================================
export { generateCodesysProject, renderProgramArtifactsCodesys, } from './generators/codesys-project.js';
export { generateCodesysManifest, CODESYS_MANIFEST_PATH, } from './generators/codesys-manifest.js';
export { generateCodesysDuts, dutName as codesysDutName, } from './generators/codesys-udts.js';
export { generateGvlParameters, generateGvlRecipes, generateGvlAlarms, } from './generators/codesys-gvls.js';
// Renderer-level exports (for tooling that drives stages individually).
export { renderFunctionBlockCodesys, renderExprCodesys, renderStmtCodesys, renderVarSectionCodesys, siemensToCodesysText, } from './renderers/codesys-st.js';
export { renderTypeArtifactCodesys } from './renderers/types.js';
export { renderDataBlockCodesys } from './renderers/data-blocks.js';
// Naming + namespace registry (Codesys-side; NOT in core).
export { CODESYS_DIR, CODESYS_NAMESPACES } from './naming.js';
