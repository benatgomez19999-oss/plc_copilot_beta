// =============================================================================
// @plccopilot/codegen-siemens — Siemens TIA Portal SCL backend
//
// Owns:
//   - SCL renderer (renderFunctionBlock, renderExpr, renderStmt, …)
//   - Siemens DATA_BLOCK / UDT / Tags CSV renderers
//   - Siemens manifest generation
//   - generateSiemensProject / renderProgramArtifacts (Siemens flavour)
//
// Re-exports from @plccopilot/codegen-core for backwards-compatible imports.
//
// Re-exports from @plccopilot/codegen-codesys and @plccopilot/codegen-rockwell
// are kept as @deprecated transitional shims; new code should import directly
// from those packages.
// =============================================================================
// ---------- Siemens public API ----------
export { generateSiemensProject, } from './generators/project.js';
export { generateStationFb } from './generators/station-fb.js';
export { generateUdts } from './generators/udts.js';
export { generateDbGlobalParams, renderScalarValue, } from './generators/db-params.js';
export { generateDbRecipes } from './generators/db-recipes.js';
export { generateDbAlarms, DB_ALARMS_NAME, DB_ALARMS_PATH, } from './generators/db-alarms.js';
export { generateFbAlarmsIR, FB_ALARMS_NAME, FB_ALARMS_PATH, } from './generators/fb-alarms.js';
export { generateTagsTable, renderTagsCsv } from './generators/tags.js';
export { generateManifest, } from './generators/manifest.js';
// Siemens naming + paths
export { stationName, stationFbName, stationArtifactPath, equipmentName, toPascalCase, sanitizeSymbol, udtName, udtArtifactPath, basename, SIEMENS_DIR, DB_PARAMS_NAME, DB_PARAMS_PATH, DB_RECIPES_NAME, DB_RECIPES_PATH, TAGS_CSV_PATH, MANIFEST_PATH, } from './naming.js';
// Siemens renderers + symbol resolver helpers
export { renderExpression } from './renderers/expression.js';
export { renderTimerBlock, renderTimerDecls } from './renderers/timers.js';
export { buildSymbolContext, renderKeyword, resolveToSclSymbol, ioSymbolForRole, tagSymbol, alarmSymbol, localSymbol, } from './renderers/symbols.js';
// Siemens-specific IR renderers
export { renderDataBlockSiemens } from './compiler/renderers/data-blocks.js';
export { renderTypeArtifactSiemens } from './compiler/renderers/types.js';
// Siemens compileProject + artifact pipeline (legacy wrapper that overlays
// Siemens defaults on top of core's neutral compileProject)
export { compileProject, resolveFeatures, } from './compiler/program/compile-project.js';
export { renderProgramArtifacts } from './compiler/program/artifacts.js';
// ---------- Core re-exports (backwards compat) ----------
// Anything that used to live in this package's own `compiler/` tree now lives
// in @plccopilot/codegen-core. These re-exports keep legacy imports working.
export { 
// Diagnostics
diag, hasErrors, firstError, makeDiagnostic, toArtifactDiagnostic, formatDiagnostic, sortDiagnostics, dedupDiagnostics, 
// Symbol layer
renderSymbol, renderRef, renderStorage, storageToRef, dbNamespaceFor, 
// IR builder
ref, 
// Lowering helpers
scanStation, commandVarName, timerVarName, checkActivitySupported, assertActivitySupported, commandsForEquipment, SUPPORTED_ACTIVITIES, EdgeRegistry, edgeInstanceName, buildEdgeVarDecls, lowerEdgeTickBlock, 
// Program IR builders
buildDbAlarmsIR, buildDbParamsIR, buildDbRecipesIR, buildEquipmentTypesIR, buildTagTablesIR, buildFbAlarmsIR, canonicalTypeName, 
/** @deprecated use `canonicalTypeName`. */
siemensTypeName, codesysTypeName, serializeProgramIR, 
// Utilities
buildCsv, escapeCsvField, toCsvRow, stableJson, 
// Errors
CodegenError, CODEGEN_ERROR_CODES, } from '@plccopilot/codegen-core';
// =============================================================================
// Deprecated transitional re-exports — Codesys backend
//
// New code should import directly from `@plccopilot/codegen-codesys`. These
// aliases are kept so legacy consumers that import Codesys symbols from
// `@plccopilot/codegen-siemens` keep compiling. Per-symbol JSDoc surfaces
// the deprecation in IDE tooling.
// =============================================================================
import * as __codesys from '@plccopilot/codegen-codesys';
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const generateCodesysProject = __codesys.generateCodesysProject;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const renderProgramArtifactsCodesys = __codesys.renderProgramArtifactsCodesys;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const generateCodesysDuts = __codesys.generateCodesysDuts;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const codesysDutName = __codesys.codesysDutName;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const generateGvlParameters = __codesys.generateGvlParameters;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const generateGvlRecipes = __codesys.generateGvlRecipes;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const generateGvlAlarms = __codesys.generateGvlAlarms;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const generateCodesysManifest = __codesys.generateCodesysManifest;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const CODESYS_DIR = __codesys.CODESYS_DIR;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const CODESYS_MANIFEST_PATH = __codesys.CODESYS_MANIFEST_PATH;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const renderFunctionBlockCodesys = __codesys.renderFunctionBlockCodesys;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const renderExprCodesys = __codesys.renderExprCodesys;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const renderStmtCodesys = __codesys.renderStmtCodesys;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const renderVarSectionCodesys = __codesys.renderVarSectionCodesys;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const siemensToCodesysText = __codesys.siemensToCodesysText;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const renderTypeArtifactCodesys = __codesys.renderTypeArtifactCodesys;
/** @deprecated import from `@plccopilot/codegen-codesys` instead. */
export const renderDataBlockCodesys = __codesys.renderDataBlockCodesys;
// =============================================================================
// Deprecated transitional re-exports — Rockwell backend
//
// New code should import directly from `@plccopilot/codegen-rockwell`.
// =============================================================================
import * as __rockwell from '@plccopilot/codegen-rockwell';
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const generateRockwellProject = __rockwell.generateRockwellProject;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const renderProgramArtifactsRockwell = __rockwell.renderProgramArtifactsRockwell;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const withRockwellDiagnostics = __rockwell.withRockwellDiagnostics;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const computeRockwellDiagnostics = __rockwell.computeRockwellDiagnostics;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const generateRockwellManifest = __rockwell.generateRockwellManifest;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const ROCKWELL_DIR = __rockwell.ROCKWELL_DIR;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const ROCKWELL_MANIFEST_PATH = __rockwell.ROCKWELL_MANIFEST_PATH;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const renderFunctionBlockRockwell = __rockwell.renderFunctionBlockRockwell;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const renderExprRockwell = __rockwell.renderExprRockwell;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const renderStmtRockwell = __rockwell.renderStmtRockwell;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const renderVarSectionRockwell = __rockwell.renderVarSectionRockwell;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const siemensToRockwellText = __rockwell.siemensToRockwellText;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const renderTypeArtifactRockwell = __rockwell.renderTypeArtifactRockwell;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const generateRockwellTagFiles = __rockwell.generateRockwellTagFiles;
/** @deprecated import from `@plccopilot/codegen-rockwell` instead. */
export const renderRockwellTagFile = __rockwell.renderRockwellTagFile;
