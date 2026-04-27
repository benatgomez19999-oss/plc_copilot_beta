import type { CallNode, Expression } from './ast.js';
import { makeDiagnostic, type Diagnostic } from './diagnostics.js';
import {
  isComparable,
  isOrderable,
  type FunctionSig,
  type SclType,
} from './types.js';

// Re-export the type aliases so consumers that historically imported
// them from `./checker.js` (e.g. `compiler/ir/builder.ts`) keep working
// without having to thread a second import through `./types.js`. Sprint
// 37 — restoring the contract that was implicit before the types were
// split out of this file.
export type { FunctionSig, SclType };

export interface SymbolEnvironment {
  lookupRef(name: string): SclType | null;
  lookupMember(object: string, property: string): SclType | null;
  lookupFunction(name: string): FunctionSig | null;
  keywordType(name: string): SclType | null;
}

export const DEFAULT_KEYWORD_TYPES: Record<string, SclType> = {
  mode: 'Int',
  start_cmd: 'Bool',
  release_cmd: 'Bool',
  estop_active: 'Bool',
  auto: 'Int',
  manual: 'Int',
  setup: 'Int',
  maintenance: 'Int',
};

export const DEFAULT_FUNCTIONS: Record<string, FunctionSig> = {
  rising: { paramTypes: ['Bool'], returnType: 'Bool', opaqueArgs: true },
  falling: { paramTypes: ['Bool'], returnType: 'Bool', opaqueArgs: true },
  edge: { paramTypes: ['Bool'], returnType: 'Bool', opaqueArgs: true },
  timer_expired: {
    paramTypes: ['TimerRef'],
    returnType: 'Bool',
    opaqueArgs: true,
  },
};

/**
 * Convenience environment for tests and MVP codegen paths that don't yet have
 * a typed symbol resolver (REQUISITO 2). Callers pre-populate ref + member
 * types; unknown lookups return null and produce diagnostics.
 */
export class StaticSymbolEnvironment implements SymbolEnvironment {
  constructor(
    private readonly refs: Map<string, SclType> = new Map(),
    private readonly members: Map<string, SclType> = new Map(),
    private readonly fns: Record<string, FunctionSig> = DEFAULT_FUNCTIONS,
    private readonly keywords: Record<string, SclType> = DEFAULT_KEYWORD_TYPES,
  ) {}

  lookupRef(name: string): SclType | null {
    return this.refs.get(name) ?? null;
  }

  lookupMember(object: string, property: string): SclType | null {
    return this.members.get(`${object}.${property}`) ?? null;
  }

  lookupFunction(name: string): FunctionSig | null {
    return this.fns[name] ?? null;
  }

  keywordType(name: string): SclType | null {
    return this.keywords[name] ?? null;
  }

  addRef(name: string, type: SclType): this {
    this.refs.set(name, type);
    return this;
  }

  addMember(object: string, property: string, type: SclType): this {
    this.members.set(`${object}.${property}`, type);
    return this;
  }
}

export interface CheckResult {
  rootType: SclType;
  diagnostics: Diagnostic[];
  typeOf(node: Expression): SclType;
}

export function checkExpression(
  root: Expression | null,
  env: SymbolEnvironment,
): CheckResult {
  const cache = new WeakMap<Expression, SclType>();
  const diagnostics: Diagnostic[] = [];

  const visit = (node: Expression): SclType => {
    const cached = cache.get(node);
    if (cached) return cached;
    const t = compute(node);
    cache.set(node, t);
    return t;
  };

  const compute = (node: Expression): SclType => {
    switch (node.kind) {
      case 'Literal':
        if (node.literalType === 'bool') return 'Bool';
        if (node.literalType === 'real') return 'Real';
        return 'DInt';

      case 'Keyword': {
        const t = env.keywordType(node.name);
        if (t === null) {
          diagnostics.push(
            makeDiagnostic(
              'error',
              'UNKNOWN_KEYWORD',
              `keyword "${node.name}" has no declared type in environment`,
              node.span,
            ),
          );
          return 'Unknown';
        }
        return t;
      }

      case 'Ref': {
        const t = env.lookupRef(node.name);
        if (t === null) {
          diagnostics.push(
            makeDiagnostic(
              'error',
              'UNKNOWN_REF',
              `reference "${node.name}" does not resolve to any io, parameter, equipment, or keyword`,
              node.span,
            ),
          );
          return 'Unknown';
        }
        return t;
      }

      case 'Member': {
        const t = env.lookupMember(node.object, node.property);
        if (t === null) {
          diagnostics.push(
            makeDiagnostic(
              'error',
              'UNKNOWN_MEMBER',
              `reference "${node.object}.${node.property}" is not defined`,
              node.span,
            ),
          );
          return 'Unknown';
        }
        return t;
      }

      case 'Unary': {
        const operandT = visit(node.operand);
        if (operandT !== 'Bool' && operandT !== 'Unknown') {
          diagnostics.push(
            makeDiagnostic(
              'error',
              'EXPECTED_BOOL',
              `unary "!" expects Bool, got ${operandT}`,
              node.span,
            ),
          );
        }
        return 'Bool';
      }

      case 'Binary': {
        const l = visit(node.left);
        const r = visit(node.right);
        switch (node.op) {
          case '&&':
          case '||':
            if (l !== 'Bool' && l !== 'Unknown') {
              diagnostics.push(
                makeDiagnostic(
                  'error',
                  'EXPECTED_BOOL',
                  `left side of "${node.op}" must be Bool, got ${l}`,
                  node.left.span,
                ),
              );
            }
            if (r !== 'Bool' && r !== 'Unknown') {
              diagnostics.push(
                makeDiagnostic(
                  'error',
                  'EXPECTED_BOOL',
                  `right side of "${node.op}" must be Bool, got ${r}`,
                  node.right.span,
                ),
              );
            }
            return 'Bool';

          case '==':
          case '!=':
            if (!isComparable(l, r)) {
              diagnostics.push(
                makeDiagnostic(
                  'error',
                  'EXPECTED_COMPARABLE',
                  `cannot compare ${l} and ${r} with "${node.op}"`,
                  node.span,
                ),
              );
            }
            return 'Bool';

          case '<':
          case '<=':
          case '>':
          case '>=':
            if (!isOrderable(l, r)) {
              diagnostics.push(
                makeDiagnostic(
                  'error',
                  'EXPECTED_NUMERIC',
                  `"${node.op}" requires numeric operands, got ${l} and ${r}`,
                  node.span,
                ),
              );
            }
            return 'Bool';
        }
      }

      case 'Call':
        return checkCall(node);
    }
  };

  const checkCall = (node: CallNode): SclType => {
    const sig = env.lookupFunction(node.callee);
    if (!sig) {
      diagnostics.push(
        makeDiagnostic(
          'error',
          'UNKNOWN_FUNCTION',
          `function "${node.callee}" is not defined`,
          node.span,
        ),
      );
      for (const arg of node.args) visit(arg);
      return 'Unknown';
    }

    if (node.args.length !== sig.paramTypes.length) {
      diagnostics.push(
        makeDiagnostic(
          'error',
          'ARITY_MISMATCH',
          `function "${node.callee}" expects ${sig.paramTypes.length} argument(s), got ${node.args.length}`,
          node.span,
        ),
      );
    }

    const enforce = !sig.opaqueArgs;

    // Opaque args (rising/falling/edge/timer_expired) are symbolic handles:
    // arity is checked, but argument resolution is delegated to the codegen
    // lowering layer (which decides how to interpret them). We do NOT visit
    // them here so that unresolved refs inside the handle don't leak as
    // UNKNOWN_REF diagnostics — the lowering layer produces its own.
    if (!enforce) {
      return sig.returnType;
    }

    node.args.forEach((arg, i) => {
      const got = visit(arg);
      if (i >= sig.paramTypes.length) return;
      const expected = sig.paramTypes[i]!;
      if (got !== expected && got !== 'Unknown') {
        diagnostics.push(
          makeDiagnostic(
            'error',
            'TYPE_MISMATCH',
            `argument ${i + 1} of "${node.callee}" expects ${expected}, got ${got}`,
            arg.span,
          ),
        );
      }
    });

    return sig.returnType;
  };

  const rootType = root ? visit(root) : 'Unknown';
  return {
    rootType,
    diagnostics,
    typeOf(node: Expression) {
      return cache.get(node) ?? 'Unknown';
    },
  };
}
