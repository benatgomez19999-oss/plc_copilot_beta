// =============================================================================
// @plccopilot/codegen-core — vendor-neutral compiler pipeline
//
// This package owns:
//   - Backend identifier union (BackendId)
//   - Diagnostic taxonomy + helpers
//   - Expression AST / lexer / parser / type-checker / pretty-printer
//   - Symbol table, resolver, render-symbol (RefIR / Storage rendering per backend)
//   - Vendor-neutral IR (FunctionBlockIR, ExprIR, StmtIR, RefIR, EdgeRefIR,
//     InstanceFieldIR, VarSectionIR, ProgramIR, TypeArtifactIR,
//     DataBlockArtifactIR, TagTableArtifactIR, ManifestIR)
//   - Lowering pipeline (station / sequence / activities / interlocks /
//     outputs / timers / edges + StationPlan helpers)
//   - Equipment-types IR builder + DataBlock IR builder + serializeProgramIR
//   - Pure naming helpers + JSON / CSV / indent utilities
//   - GeneratedArtifact / ArtifactKind / ArtifactDiagnostic / CodegenError
//
// What this package DOES NOT contain (lives in backend packages):
//   - SCL / IEC ST / Logix ST renderers
//   - Backend-specific paths, directories, file extensions
//   - Manifest emission (Siemens / Codesys / Rockwell each emit their own)
//   - generateXxxProject façades
// =============================================================================
export { SIEMENS, CODESYS, ROCKWELL } from './compiler/backend.js';
// ---------- Diagnostics ----------
export { diag, hasErrors, firstError, makeDiagnostic, toArtifactDiagnostic, formatDiagnostic, sortDiagnostics, dedupDiagnostics, } from './compiler/diagnostics.js';
// ---------- Artifact contract ----------
export { CodegenError, CODEGEN_ERROR_CODES, } from './types.js';
// ---------- Error serialisation (sprint 39 / 40) ----------
// Vendor-neutral, transport-safe wire shape for compiler errors.
// Consumed by the CLI's `formatError`, the web Worker compile
// response, and the App's error banner so all three surface the
// same rich UX (code, path, station, symbol, hint, cause).
//
// Sprint 40 also exports `codegenErrorFromDiagnostic` so the few
// diagnostic→throw adapter sites (compile-project per-station
// lowering re-throw, station-fb façade) can preserve every
// structured field instead of dropping all but `path`.
export { codegenErrorFromDiagnostic, serializeCompilerError, formatSerializedCompilerError, } from './compiler/errors.js';
// ---------- Diagnostic path helpers (sprint 40) ----------
// Stable bracket-indexed PIR JSON paths used as `CodegenError.path` /
// `Diagnostic.path`. Centralised here so every throw site formats the
// path identically and the web's `findJsonPathLine` can locate the
// offending line.
export { alarmPath, alarmWhenPath, equipmentIoBindingPath, equipmentIoBindingsPath, equipmentPath, equipmentTypePath, interlockInhibitsPath, interlockPath, interlockWhenPath, ioPath, machineAlarmsPath, machineInterlocksPath, machineIoPath, machinePath, parameterPath, parametersPath, recipePath, recipeValuePath, recipeValuesPath, recipesPath, stateActivityActivatePath, statePath, stationEquipmentPath, stationPath, statesPath, transitionFromPath, transitionGuardPath, transitionPath, transitionTimeoutAlarmPath, transitionTimeoutMsPath, transitionTimeoutPath, transitionToPath, transitionsPath, } from './compiler/diagnostic-paths.js';
export { applyExpressionContext, } from './compiler/expressions/context.js';
// ---------- Expressions ----------
// Renamed `BinaryOp` from the expression AST to avoid a collision with the
// IR-level `BinaryOp` (different operator alphabets).
export { ast, isKeywordName, mergeSpans, } from './compiler/expressions/ast.js';
export { SCL_TYPES, commonNumericType, isComparable, isNumeric, isOrderable, } from './compiler/expressions/types.js';
export { lex, tokenSpan } from './compiler/expressions/lexer.js';
export { parseExpression } from './compiler/expressions/parser.js';
export { DEFAULT_FUNCTIONS, DEFAULT_KEYWORD_TYPES, StaticSymbolEnvironment, checkExpression, } from './compiler/expressions/checker.js';
export { prettyPrint } from './compiler/expressions/pretty.js';
// ---------- Symbol table + render-symbol ----------
export { renderSymbol, renderRef, renderStorage, storageToRef, dbNamespaceFor, } from './compiler/symbols/render-symbol.js';
export { SymbolTable } from './compiler/symbols/table.js';
export { buildSymbolTable, registerLocalCommand, } from './compiler/symbols/resolver.js';
export { ir, ref, lowerExpression, astToIr, buildSymbolEnvironment, } from './compiler/ir/builder.js';
// ---------- Lowering passes ----------
export { lowerStation } from './compiler/lowering/station.js';
export { lowerStateActivity } from './compiler/lowering/activities.js';
export { lowerInterlocks } from './compiler/lowering/interlocks.js';
export { lowerOutputWiring } from './compiler/lowering/outputs.js';
export { lowerSequence, lowerWildcardTransitions, } from './compiler/lowering/sequence.js';
export { EdgeRegistry, edgeInstanceName, buildEdgeVarDecls, lowerEdgeTickBlock, } from './compiler/lowering/edges.js';
export { buildTimerVarDecls, lowerTimerBlock, } from './compiler/lowering/timers.js';
export { scanStation, commandVarName, timerVarName, checkActivitySupported, assertActivitySupported, commandsForEquipment, SUPPORTED_ACTIVITIES, } from './compiler/lowering/helpers.js';
export { buildEquipmentTypesIR, canonicalTypeName, 
/** @deprecated use `canonicalTypeName`. */
siemensTypeName, codesysTypeName, } from './compiler/program/types.js';
export { buildDbAlarmsIR, buildDbParamsIR, buildDbRecipesIR, } from './compiler/program/data-blocks.js';
export { buildTagTablesIR } from './compiler/program/tag-tables.js';
export { buildFbAlarmsIR, FB_ALARMS_NAME, } from './compiler/program/fb-alarms.js';
export { compileProject, resolveFeatures, } from './compiler/program/compile-project.js';
// Sprint 44 — diagnostic-first validator for `Alarm.when`.
// Exposed so consumers (CLI debug flags, tests, future tools) can
// surface alarm diagnostics without re-running the full compile.
export { collectAlarmDiagnostics, } from './compiler/program/alarm-diagnostics.js';
export { serializeProgramIR, } from './compiler/program/serialize.js';
// ---------- Naming helpers (vendor-neutral) ----------
export { toPascalCase, stationName, stationFbName, equipmentName, sanitizeSymbol, basename, } from './naming.js';
// ---------- Utilities ----------
export { stableJson } from './utils/json.js';
export { buildCsv, escapeCsvField, toCsvRow } from './utils/csv.js';
// Indent helpers — vendor-neutral renderers (Siemens, Codesys, Rockwell)
// share these so each backend doesn't reinvent space-prefixing /
// line joining. Sprint 37 — restored to the barrel after the codegen
// extraction (the shim at `codegen-siemens/src/utils/indent.ts` is
// `export * from '@plccopilot/codegen-core'`, so it can't see deep
// modules unless their symbols are surfaced here).
export { indentLines, joinLines, pad } from './utils/indent.js';
