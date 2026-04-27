export {
  ast,
  isKeywordName,
  mergeSpans,
  type BinaryNode,
  type BinaryOp,
  type CallNode,
  type Expression,
  type KeywordName,
  type KeywordNode,
  type LiteralNode,
  type MemberNode,
  type RefNode,
  type Span,
  type UnaryNode,
  type UnaryOp,
} from './ast.js';

export {
  SCL_TYPES,
  commonNumericType,
  isComparable,
  isNumeric,
  isOrderable,
  type FunctionSig,
  type SclType,
} from './types.js';

export {
  hasErrors,
  makeDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type Severity,
} from './diagnostics.js';

export { lex, tokenSpan, type LexResult, type Token } from './lexer.js';
export { parseExpression, type ParseResult } from './parser.js';
export {
  DEFAULT_FUNCTIONS,
  DEFAULT_KEYWORD_TYPES,
  StaticSymbolEnvironment,
  checkExpression,
  type CheckResult,
  type SymbolEnvironment,
} from './checker.js';
export { prettyPrint, type PrettyOptions } from './pretty.js';
