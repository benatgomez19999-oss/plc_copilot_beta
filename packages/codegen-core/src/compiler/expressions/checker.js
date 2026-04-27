import { makeDiagnostic } from './diagnostics.js';
import { isComparable, isOrderable, } from './types.js';
export const DEFAULT_KEYWORD_TYPES = {
    mode: 'Int',
    start_cmd: 'Bool',
    release_cmd: 'Bool',
    estop_active: 'Bool',
    auto: 'Int',
    manual: 'Int',
    setup: 'Int',
    maintenance: 'Int',
};
export const DEFAULT_FUNCTIONS = {
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
export class StaticSymbolEnvironment {
    refs;
    members;
    fns;
    keywords;
    constructor(refs = new Map(), members = new Map(), fns = DEFAULT_FUNCTIONS, keywords = DEFAULT_KEYWORD_TYPES) {
        this.refs = refs;
        this.members = members;
        this.fns = fns;
        this.keywords = keywords;
    }
    lookupRef(name) {
        return this.refs.get(name) ?? null;
    }
    lookupMember(object, property) {
        return this.members.get(`${object}.${property}`) ?? null;
    }
    lookupFunction(name) {
        return this.fns[name] ?? null;
    }
    keywordType(name) {
        return this.keywords[name] ?? null;
    }
    addRef(name, type) {
        this.refs.set(name, type);
        return this;
    }
    addMember(object, property, type) {
        this.members.set(`${object}.${property}`, type);
        return this;
    }
}
export function checkExpression(root, env) {
    const cache = new WeakMap();
    const diagnostics = [];
    const visit = (node) => {
        const cached = cache.get(node);
        if (cached)
            return cached;
        const t = compute(node);
        cache.set(node, t);
        return t;
    };
    const compute = (node) => {
        switch (node.kind) {
            case 'Literal':
                if (node.literalType === 'bool')
                    return 'Bool';
                if (node.literalType === 'real')
                    return 'Real';
                return 'DInt';
            case 'Keyword': {
                const t = env.keywordType(node.name);
                if (t === null) {
                    diagnostics.push(makeDiagnostic('error', 'UNKNOWN_KEYWORD', `keyword "${node.name}" has no declared type in environment`, node.span));
                    return 'Unknown';
                }
                return t;
            }
            case 'Ref': {
                const t = env.lookupRef(node.name);
                if (t === null) {
                    diagnostics.push(makeDiagnostic('error', 'UNKNOWN_REF', `reference "${node.name}" does not resolve to any io, parameter, equipment, or keyword`, node.span));
                    return 'Unknown';
                }
                return t;
            }
            case 'Member': {
                const t = env.lookupMember(node.object, node.property);
                if (t === null) {
                    diagnostics.push(makeDiagnostic('error', 'UNKNOWN_MEMBER', `reference "${node.object}.${node.property}" is not defined`, node.span));
                    return 'Unknown';
                }
                return t;
            }
            case 'Unary': {
                const operandT = visit(node.operand);
                if (operandT !== 'Bool' && operandT !== 'Unknown') {
                    diagnostics.push(makeDiagnostic('error', 'EXPECTED_BOOL', `unary "!" expects Bool, got ${operandT}`, node.span));
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
                            diagnostics.push(makeDiagnostic('error', 'EXPECTED_BOOL', `left side of "${node.op}" must be Bool, got ${l}`, node.left.span));
                        }
                        if (r !== 'Bool' && r !== 'Unknown') {
                            diagnostics.push(makeDiagnostic('error', 'EXPECTED_BOOL', `right side of "${node.op}" must be Bool, got ${r}`, node.right.span));
                        }
                        return 'Bool';
                    case '==':
                    case '!=':
                        if (!isComparable(l, r)) {
                            diagnostics.push(makeDiagnostic('error', 'EXPECTED_COMPARABLE', `cannot compare ${l} and ${r} with "${node.op}"`, node.span));
                        }
                        return 'Bool';
                    case '<':
                    case '<=':
                    case '>':
                    case '>=':
                        if (!isOrderable(l, r)) {
                            diagnostics.push(makeDiagnostic('error', 'EXPECTED_NUMERIC', `"${node.op}" requires numeric operands, got ${l} and ${r}`, node.span));
                        }
                        return 'Bool';
                }
            }
            case 'Call':
                return checkCall(node);
        }
    };
    const checkCall = (node) => {
        const sig = env.lookupFunction(node.callee);
        if (!sig) {
            diagnostics.push(makeDiagnostic('error', 'UNKNOWN_FUNCTION', `function "${node.callee}" is not defined`, node.span));
            for (const arg of node.args)
                visit(arg);
            return 'Unknown';
        }
        if (node.args.length !== sig.paramTypes.length) {
            diagnostics.push(makeDiagnostic('error', 'ARITY_MISMATCH', `function "${node.callee}" expects ${sig.paramTypes.length} argument(s), got ${node.args.length}`, node.span));
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
            if (i >= sig.paramTypes.length)
                return;
            const expected = sig.paramTypes[i];
            if (got !== expected && got !== 'Unknown') {
                diagnostics.push(makeDiagnostic('error', 'TYPE_MISMATCH', `argument ${i + 1} of "${node.callee}" expects ${expected}, got ${got}`, arg.span));
            }
        });
        return sig.returnType;
    };
    const rootType = root ? visit(root) : 'Unknown';
    return {
        rootType,
        diagnostics,
        typeOf(node) {
            return cache.get(node) ?? 'Unknown';
        },
    };
}
