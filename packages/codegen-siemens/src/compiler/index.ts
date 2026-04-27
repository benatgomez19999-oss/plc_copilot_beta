// Canonical entrypoints for the internal compiler pipeline.
// External consumers should still use `generateSiemensProject` /
// `generateStationFb` from the package root; these exports are for tooling
// that wants to drive stages individually.

export * from './diagnostics.js';
export * from './symbols/types.js';
export { SymbolTable } from './symbols/table.js';
export { buildSymbolTable, registerLocalCommand } from './symbols/resolver.js';

export * from './ir/nodes.js';
export { ir, lowerExpression, astToIr, buildSymbolEnvironment } from './ir/builder.js';

export {
  renderExpr,
  renderStmt,
  renderVarSection,
  renderFunctionBlock,
} from './renderers/scl.js';

export { lowerStation, type StationLoweringResult } from './lowering/station.js';
export { lowerSequence, lowerWildcardTransitions } from './lowering/sequence.js';
export { lowerStateActivity } from './lowering/activities.js';
export { lowerTimerBlock, buildTimerVarDecls } from './lowering/timers.js';
export { lowerInterlocks } from './lowering/interlocks.js';
export { lowerOutputWiring } from './lowering/outputs.js';
