export * from './domain/types.js';
export { kindOf } from './domain/shapes/kinds.js';
export {
  EQUIPMENT_SHAPES,
  type EquipmentShape,
} from './domain/shapes/equipment.js';
export * from './schemas/index.js';
export {
  validate,
  buildContext,
  emptyReport,
  addIssue,
  machinePath,
  rawAddress,
} from './validators/index.js';
export type {
  Issue,
  Severity,
  ValidationContext,
  ValidationReport,
} from './validators/index.js';
export {
  analyzeExpression,
  tokenize,
} from './domain/expressions/lexer.js';
export type {
  AnalyzeResult,
  FunctionCall,
  Token,
  TokenType,
} from './domain/expressions/lexer.js';
export {
  EXPR_KEYWORDS,
  EXPR_FUNCTIONS,
  ID_RE,
  isKeyword,
  isFunctionName,
  isIdLike,
  isEquipmentRoleFormat,
  parseEquipmentRoleRef,
  parseActivationRef,
  resolveSymbol,
} from './domain/refs.js';
export type {
  EquipmentRoleRef,
  ActivationRef,
  ShapeRoles,
  SymbolResolution,
  SymbolResolveInput,
} from './domain/refs.js';
