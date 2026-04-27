import type {
  BinaryNode,
  CallNode,
  Expression,
  KeywordNode,
  LiteralNode,
  MemberNode,
  RefNode,
  UnaryNode,
} from '../expressions/ast.js';
import {
  DEFAULT_FUNCTIONS,
  DEFAULT_KEYWORD_TYPES,
  checkExpression,
  type FunctionSig,
  type SclType,
  type SymbolEnvironment,
} from '../expressions/checker.js';
import { parseExpression } from '../expressions/parser.js';
import {
  applyExpressionContext,
  type ExpressionDiagnosticContext,
} from '../expressions/context.js';
import { diag, type Diagnostic } from '../diagnostics.js';
import type { SymbolTable } from '../symbols/table.js';
import type { ValueType } from '../symbols/types.js';
import { sanitizeSymbol } from '../../naming.js';
import type {
  BinaryOp,
  CaseArmIR,
  ExprIR,
  FbCallParam,
  RefIR,
  StmtIR,
  VarDeclIR,
} from './nodes.js';
import { EdgeRegistry, edgeInstanceName } from '../lowering/edges.js';

// -------------------- ref.* factories --------------------

export const ref = {
  local(name: string): RefIR {
    return { kind: 'local', name };
  },
  global(name: string): RefIR {
    return { kind: 'global', name };
  },
  dbField(dbName: string, fieldName: string): RefIR {
    return { kind: 'dbField', dbName, fieldName };
  },
  fbInstance(name: string): RefIR {
    return { kind: 'fbInstance', name };
  },
};

// -------------------- ir.* factories --------------------

export const ir = {
  raw(text: string): ExprIR {
    return { kind: 'Raw', text };
  },
  boolLit(value: boolean): ExprIR {
    return { kind: 'BoolLit', value };
  },
  numLit(value: number, numType: 'Int' | 'DInt' | 'Real' = 'DInt'): ExprIR {
    return { kind: 'NumLit', value, numType };
  },
  strLit(value: string): ExprIR {
    return { kind: 'StringLit', value };
  },
  sym(symbol: import('../symbols/types.js').ResolvedSymbol): ExprIR {
    return { kind: 'SymbolRef', symbol };
  },
  refExpr(r: RefIR): ExprIR {
    return { kind: 'Ref', ref: r };
  },
  edgeRef(
    instanceName: string,
    edgeKind: 'rising' | 'falling' | 'edge',
  ): ExprIR {
    return { kind: 'EdgeRef', instanceName, edgeKind };
  },
  instanceField(instance: RefIR, fieldName: string): ExprIR {
    return { kind: 'InstanceField', instance, fieldName };
  },
  paren(inner: ExprIR): ExprIR {
    return { kind: 'Paren', inner };
  },
  not(operand: ExprIR): ExprIR {
    return { kind: 'Unary', op: 'NOT', operand };
  },
  bin(op: BinaryOp, left: ExprIR, right: ExprIR): ExprIR {
    return { kind: 'Binary', op, left, right };
  },
  call(fn: string, args: ExprIR[]): ExprIR {
    return { kind: 'Call', fn, args };
  },

  assign(target: RefIR, expr: ExprIR, comment?: string): StmtIR {
    return { kind: 'Assign', target, expr, comment };
  },
  comment(text: string): StmtIR {
    return { kind: 'Comment', text };
  },
  rawStmt(text: string): StmtIR {
    return { kind: 'RawStmt', text };
  },
  blankLine(): StmtIR {
    return { kind: 'RawStmt', text: '' };
  },
  if_(
    cond: ExprIR,
    then_: StmtIR[],
    opts: {
      elseIfs?: { cond: ExprIR; body: StmtIR[] }[];
      else_?: StmtIR[];
    } = {},
  ): StmtIR {
    return {
      kind: 'If',
      cond,
      then: then_,
      elseIfs: opts.elseIfs,
      else: opts.else_,
    };
  },
  case_(
    selector: ExprIR,
    arms: CaseArmIR[],
    else_?: StmtIR[],
  ): StmtIR {
    return { kind: 'Case', selector, arms, else: else_ };
  },
  ton(instance: RefIR, inExpr: ExprIR, ptMs: number): StmtIR {
    return { kind: 'TonCall', instance, inExpr, ptMs };
  },
  fbCall(
    instance: RefIR,
    params: FbCallParam[],
    comment?: string,
  ): StmtIR {
    return { kind: 'FbCall', instance, params, comment };
  },

  varDecl(
    name: string,
    type: string,
    opts: { init?: string; comment?: string; preComment?: string } = {},
  ): VarDeclIR {
    return {
      name,
      type,
      init: opts.init,
      comment: opts.comment,
      preComment: opts.preComment,
    };
  },

  andAll(exprs: ExprIR[]): ExprIR {
    if (exprs.length === 0) return ir.boolLit(true);
    return exprs.reduce((l, r) => ir.bin('AND', l, r));
  },

  orAll(exprs: ExprIR[]): ExprIR {
    if (exprs.length === 0) return ir.boolLit(false);
    return exprs.reduce((l, r) => ir.bin('OR', l, r));
  },
};

// -------------------- Expression AST -> IR --------------------

const BIN_MAP: Record<string, BinaryOp> = {
  '&&': 'AND',
  '||': 'OR',
  '==': '=',
  '!=': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
};

export interface LowerExprResult {
  ir: ExprIR;
  diagnostics: Diagnostic[];
}

export function lowerExpression(
  source: string,
  table: SymbolTable,
  edges?: EdgeRegistry,
  diagnosticContext?: ExpressionDiagnosticContext,
): LowerExprResult {
  const diagnostics: Diagnostic[] = [];
  const edgeSink = edges ?? new EdgeRegistry();
  const parsed = parseExpression(source);
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.ast) {
    // Sprint 43 — even the early-exit empty-AST case must surface
    // its parser diagnostics with the caller's context (e.g. the
    // `transitionGuardPath` of the offending guard).
    return {
      ir: ir.boolLit(true),
      diagnostics: applyExpressionContext(diagnostics, diagnosticContext),
    };
  }

  const env = buildSymbolEnvironment(table);
  const checked = checkExpression(parsed.ast, env);

  for (const d of checked.diagnostics) {
    if (d.code === 'UNKNOWN_MEMBER') {
      diagnostics.push(refineMemberDiagnostic(d, parsed.ast, table));
    } else {
      diagnostics.push(d);
    }
  }

  const generatedIr = astToIr(parsed.ast, table, edgeSink, diagnostics);
  // Sprint 43 — the parser, the checker, AND the IR builder all push
  // into the shared `diagnostics` array. Decorating once at the end
  // hits every emitter (including refined member diagnostics +
  // edge-source UNKNOWN_REF/UNKNOWN_MEMBER warnings) without
  // touching their individual emit sites.
  return {
    ir: generatedIr,
    diagnostics: applyExpressionContext(diagnostics, diagnosticContext),
  };
}

function refineMemberDiagnostic(
  d: Diagnostic,
  root: Expression,
  table: SymbolTable,
): Diagnostic {
  const node = findMemberBySpan(root, d.span);
  if (!node) return d;
  const fullName = `${node.object}.${node.property}`;
  const hasEquipment = table
    .all()
    .some(
      (s) =>
        s.kind === 'equipment_role' &&
        s.pirName.startsWith(`${node.object}.`),
    );
  if (!hasEquipment) {
    return {
      ...d,
      code: 'UNKNOWN_EQUIPMENT',
      message: `reference "${fullName}" points to unknown equipment "${node.object}"`,
    };
  }
  return {
    ...d,
    code: 'UNBOUND_ROLE',
    message: `reference "${fullName}": role "${node.property}" is not defined on equipment "${node.object}"`,
  };
}

function findMemberBySpan(
  root: Expression,
  span: import('../diagnostics.js').Span | undefined,
): MemberNode | null {
  if (!span) return null;
  let found: MemberNode | null = null;
  const visit = (n: Expression): void => {
    if (found) return;
    if (
      n.kind === 'Member' &&
      n.span.start === span.start &&
      n.span.end === span.end
    ) {
      found = n;
      return;
    }
    switch (n.kind) {
      case 'Binary':
        visit(n.left);
        visit(n.right);
        break;
      case 'Unary':
        visit(n.operand);
        break;
      case 'Call':
        for (const a of n.args) visit(a);
        break;
      default:
        break;
    }
  };
  visit(root);
  return found;
}

export function astToIr(
  node: Expression,
  table: SymbolTable,
  edges: EdgeRegistry = new EdgeRegistry(),
  diagnostics: Diagnostic[] = [],
): ExprIR {
  switch (node.kind) {
    case 'Literal':
      return lowerLiteral(node);
    case 'Keyword':
      return lowerKeyword(node, table);
    case 'Ref':
      return lowerRef(node, table);
    case 'Member':
      return lowerMember(node, table);
    case 'Unary':
      return ir.not(astToIr(node.operand, table, edges, diagnostics));
    case 'Binary': {
      const op = BIN_MAP[node.op];
      return ir.bin(
        op,
        astToIr(node.left, table, edges, diagnostics),
        astToIr(node.right, table, edges, diagnostics),
      );
    }
    case 'Call':
      return lowerCall(node, table, edges, diagnostics);
  }
}

function lowerLiteral(node: LiteralNode): ExprIR {
  if (node.literalType === 'bool') return ir.boolLit(node.value as boolean);
  if (node.literalType === 'real')
    return ir.numLit(node.value as number, 'Real');
  return ir.numLit(node.value as number, 'DInt');
}

function lowerKeyword(node: KeywordNode, table: SymbolTable): ExprIR {
  const sym = table.resolve(node.name);
  return sym ? ir.sym(sym) : ir.raw(node.name);
}

function lowerRef(node: RefNode, table: SymbolTable): ExprIR {
  const sym = table.resolve(node.name);
  return sym ? ir.sym(sym) : ir.raw(node.name);
}

function lowerMember(node: MemberNode, table: SymbolTable): ExprIR {
  const fullName = `${node.object}.${node.property}`;
  const sym = table.resolve(fullName);
  return sym ? ir.sym(sym) : ir.raw(fullName);
}

function lowerCall(
  node: CallNode,
  table: SymbolTable,
  edges: EdgeRegistry,
  diagnostics: Diagnostic[],
): ExprIR {
  const primary = node.args[0];

  switch (node.callee) {
    case 'rising':
      return lowerEdgeCall(primary, 'rising', table, edges, diagnostics);
    case 'falling':
      return lowerEdgeCall(primary, 'falling', table, edges, diagnostics);
    case 'edge': {
      diagnostics.push(
        diag(
          'info',
          'EDGE_LOWERED_AS_RISING',
          `edge(${primary ? exprTextForHandle(primary) : '...'}) is lowered as rising(...) in codegen-siemens v0.1`,
          { span: node.span },
        ),
      );
      return lowerEdgeCall(primary, 'rising', table, edges, diagnostics);
    }
    case 'timer_expired': {
      // Vendor-neutral: emit InstanceField that the renderer wraps as
      // `#tag.Q` (Siemens) or `tag.Q` (Codesys) via renderRef.
      const tag = primary
        ? sanitizeSymbol(exprTextForHandle(primary))
        : '_';
      return ir.instanceField({ kind: 'fbInstance', name: tag }, 'Q');
    }
    default:
      return ir.call(
        node.callee,
        node.args.map((a) => astToIr(a, table, edges, diagnostics)),
      );
  }
}

function lowerEdgeCall(
  arg: Expression | undefined,
  kind: 'rising' | 'falling',
  table: SymbolTable,
  edges: EdgeRegistry,
  diagnostics: Diagnostic[],
): ExprIR {
  if (!arg) {
    const { instanceName } = edgeInstanceName(kind, 'noarg', edges.stationId);
    return ir.edgeRef(instanceName, kind);
  }
  const argText = exprTextForHandle(arg);
  const { instanceName, triggerType } = edgeInstanceName(
    kind,
    argText,
    edges.stationId,
  );
  const sourceSclExpr = lowerEdgeSource(arg, table, diagnostics);
  edges.register({
    instanceName,
    triggerType,
    sourceArgText: argText,
    sourceSclExpr,
  });
  return ir.edgeRef(instanceName, kind);
}

function lowerEdgeSource(
  arg: Expression,
  table: SymbolTable,
  diagnostics: Diagnostic[],
): ExprIR {
  if (arg.kind === 'Ref') {
    const direct = table.resolve(arg.name);
    if (direct) return ir.sym(direct);

    const bareEquipmentSignal = table.resolve(`${arg.name}.signal_in`);
    if (bareEquipmentSignal) return ir.sym(bareEquipmentSignal);

    diagnostics.push(
      diag(
        'warning',
        'UNKNOWN_REF',
        `edge source "${arg.name}" does not resolve to any io, parameter, equipment, or keyword — emitting symbolic CLK; wire manually`,
        {
          span: arg.span,
          symbol: arg.name,
          hint: 'add the signal to machine.io, bind an equipment role, or rename the edge argument',
        },
      ),
    );
    return ir.raw(arg.name);
  }

  if (arg.kind === 'Member') {
    const sym = table.resolve(`${arg.object}.${arg.property}`);
    if (sym) return ir.sym(sym);
    diagnostics.push(
      diag(
        'warning',
        'UNKNOWN_MEMBER',
        `Edge source "${arg.object}.${arg.property}" does not resolve — emitting symbolic CLK; wire manually.`,
        {
          span: arg.span,
          symbol: `${arg.object}.${arg.property}`,
          hint: `Bind "${arg.property}" in equipment "${arg.object}".io_bindings, or change the edge argument to an existing role.`,
        },
      ),
    );
    return ir.raw(`${arg.object}.${arg.property}`);
  }

  return astToIr(arg, table, new EdgeRegistry(), diagnostics);
}

function exprTextForHandle(node: Expression): string {
  switch (node.kind) {
    case 'Ref':
      return node.name;
    case 'Member':
      return `${node.object}.${node.property}`;
    case 'Literal':
      return String(node.value);
    default:
      return 'arg';
  }
}

// -------------------- SymbolEnvironment bridge --------------------

export function buildSymbolEnvironment(table: SymbolTable): SymbolEnvironment {
  return {
    lookupRef(name: string): SclType | null {
      const s = table.resolve(name);
      if (!s) return null;
      if (
        s.kind !== 'io' &&
        s.kind !== 'parameter' &&
        s.kind !== 'alarm' &&
        s.kind !== 'local'
      )
        return null;
      return valueTypeToSclType(s.valueType);
    },
    lookupMember(object: string, property: string): SclType | null {
      const s = table.resolve(`${object}.${property}`);
      if (!s || s.kind !== 'equipment_role') return null;
      return valueTypeToSclType(s.valueType);
    },
    lookupFunction(name: string): FunctionSig | null {
      return DEFAULT_FUNCTIONS[name] ?? null;
    },
    keywordType(name: string): SclType | null {
      const s = table.resolve(name);
      if (!s || s.kind !== 'keyword') {
        return DEFAULT_KEYWORD_TYPES[name] ?? null;
      }
      return valueTypeToSclType(s.valueType);
    },
  };
}

function valueTypeToSclType(v: ValueType): SclType {
  switch (v) {
    case 'bool':
      return 'Bool';
    case 'int':
      return 'DInt';
    case 'real':
      return 'Real';
    case 'string':
    case 'unknown':
    default:
      return 'Unknown';
  }
}
