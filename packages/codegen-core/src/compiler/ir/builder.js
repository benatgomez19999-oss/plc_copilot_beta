import { DEFAULT_FUNCTIONS, DEFAULT_KEYWORD_TYPES, checkExpression, } from '../expressions/checker.js';
import { parseExpression } from '../expressions/parser.js';
import { applyExpressionContext, } from '../expressions/context.js';
import { diag } from '../diagnostics.js';
import { sanitizeSymbol } from '../../naming.js';
import { EdgeRegistry, edgeInstanceName } from '../lowering/edges.js';
// -------------------- ref.* factories --------------------
export const ref = {
    local(name) {
        return { kind: 'local', name };
    },
    global(name) {
        return { kind: 'global', name };
    },
    dbField(dbName, fieldName) {
        return { kind: 'dbField', dbName, fieldName };
    },
    fbInstance(name) {
        return { kind: 'fbInstance', name };
    },
};
// -------------------- ir.* factories --------------------
export const ir = {
    raw(text) {
        return { kind: 'Raw', text };
    },
    boolLit(value) {
        return { kind: 'BoolLit', value };
    },
    numLit(value, numType = 'DInt') {
        return { kind: 'NumLit', value, numType };
    },
    strLit(value) {
        return { kind: 'StringLit', value };
    },
    sym(symbol) {
        return { kind: 'SymbolRef', symbol };
    },
    refExpr(r) {
        return { kind: 'Ref', ref: r };
    },
    edgeRef(instanceName, edgeKind) {
        return { kind: 'EdgeRef', instanceName, edgeKind };
    },
    instanceField(instance, fieldName) {
        return { kind: 'InstanceField', instance, fieldName };
    },
    paren(inner) {
        return { kind: 'Paren', inner };
    },
    not(operand) {
        return { kind: 'Unary', op: 'NOT', operand };
    },
    bin(op, left, right) {
        return { kind: 'Binary', op, left, right };
    },
    call(fn, args) {
        return { kind: 'Call', fn, args };
    },
    assign(target, expr, comment) {
        return { kind: 'Assign', target, expr, comment };
    },
    comment(text) {
        return { kind: 'Comment', text };
    },
    rawStmt(text) {
        return { kind: 'RawStmt', text };
    },
    blankLine() {
        return { kind: 'RawStmt', text: '' };
    },
    if_(cond, then_, opts = {}) {
        return {
            kind: 'If',
            cond,
            then: then_,
            elseIfs: opts.elseIfs,
            else: opts.else_,
        };
    },
    case_(selector, arms, else_) {
        return { kind: 'Case', selector, arms, else: else_ };
    },
    ton(instance, inExpr, ptMs) {
        return { kind: 'TonCall', instance, inExpr, ptMs };
    },
    fbCall(instance, params, comment) {
        return { kind: 'FbCall', instance, params, comment };
    },
    varDecl(name, type, opts = {}) {
        return {
            name,
            type,
            init: opts.init,
            comment: opts.comment,
            preComment: opts.preComment,
        };
    },
    andAll(exprs) {
        if (exprs.length === 0)
            return ir.boolLit(true);
        return exprs.reduce((l, r) => ir.bin('AND', l, r));
    },
    orAll(exprs) {
        if (exprs.length === 0)
            return ir.boolLit(false);
        return exprs.reduce((l, r) => ir.bin('OR', l, r));
    },
};
// -------------------- Expression AST -> IR --------------------
const BIN_MAP = {
    '&&': 'AND',
    '||': 'OR',
    '==': '=',
    '!=': '<>',
    '<': '<',
    '<=': '<=',
    '>': '>',
    '>=': '>=',
};
export function lowerExpression(source, table, edges, diagnosticContext) {
    const diagnostics = [];
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
        }
        else {
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
function refineMemberDiagnostic(d, root, table) {
    const node = findMemberBySpan(root, d.span);
    if (!node)
        return d;
    const fullName = `${node.object}.${node.property}`;
    const hasEquipment = table
        .all()
        .some((s) => s.kind === 'equipment_role' &&
        s.pirName.startsWith(`${node.object}.`));
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
function findMemberBySpan(root, span) {
    if (!span)
        return null;
    let found = null;
    const visit = (n) => {
        if (found)
            return;
        if (n.kind === 'Member' &&
            n.span.start === span.start &&
            n.span.end === span.end) {
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
                for (const a of n.args)
                    visit(a);
                break;
            default:
                break;
        }
    };
    visit(root);
    return found;
}
export function astToIr(node, table, edges = new EdgeRegistry(), diagnostics = []) {
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
            return ir.bin(op, astToIr(node.left, table, edges, diagnostics), astToIr(node.right, table, edges, diagnostics));
        }
        case 'Call':
            return lowerCall(node, table, edges, diagnostics);
    }
}
function lowerLiteral(node) {
    if (node.literalType === 'bool')
        return ir.boolLit(node.value);
    if (node.literalType === 'real')
        return ir.numLit(node.value, 'Real');
    return ir.numLit(node.value, 'DInt');
}
function lowerKeyword(node, table) {
    const sym = table.resolve(node.name);
    return sym ? ir.sym(sym) : ir.raw(node.name);
}
function lowerRef(node, table) {
    const sym = table.resolve(node.name);
    return sym ? ir.sym(sym) : ir.raw(node.name);
}
function lowerMember(node, table) {
    const fullName = `${node.object}.${node.property}`;
    const sym = table.resolve(fullName);
    return sym ? ir.sym(sym) : ir.raw(fullName);
}
function lowerCall(node, table, edges, diagnostics) {
    const primary = node.args[0];
    switch (node.callee) {
        case 'rising':
            return lowerEdgeCall(primary, 'rising', table, edges, diagnostics);
        case 'falling':
            return lowerEdgeCall(primary, 'falling', table, edges, diagnostics);
        case 'edge': {
            diagnostics.push(diag('info', 'EDGE_LOWERED_AS_RISING', `edge(${primary ? exprTextForHandle(primary) : '...'}) is lowered as rising(...) in codegen-siemens v0.1`, { span: node.span }));
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
            return ir.call(node.callee, node.args.map((a) => astToIr(a, table, edges, diagnostics)));
    }
}
function lowerEdgeCall(arg, kind, table, edges, diagnostics) {
    if (!arg) {
        const { instanceName } = edgeInstanceName(kind, 'noarg', edges.stationId);
        return ir.edgeRef(instanceName, kind);
    }
    const argText = exprTextForHandle(arg);
    const { instanceName, triggerType } = edgeInstanceName(kind, argText, edges.stationId);
    const sourceSclExpr = lowerEdgeSource(arg, table, diagnostics);
    edges.register({
        instanceName,
        triggerType,
        sourceArgText: argText,
        sourceSclExpr,
    });
    return ir.edgeRef(instanceName, kind);
}
function lowerEdgeSource(arg, table, diagnostics) {
    if (arg.kind === 'Ref') {
        const direct = table.resolve(arg.name);
        if (direct)
            return ir.sym(direct);
        const bareEquipmentSignal = table.resolve(`${arg.name}.signal_in`);
        if (bareEquipmentSignal)
            return ir.sym(bareEquipmentSignal);
        diagnostics.push(diag('warning', 'UNKNOWN_REF', `edge source "${arg.name}" does not resolve to any io, parameter, equipment, or keyword — emitting symbolic CLK; wire manually`, {
            span: arg.span,
            symbol: arg.name,
            hint: 'add the signal to machine.io, bind an equipment role, or rename the edge argument',
        }));
        return ir.raw(arg.name);
    }
    if (arg.kind === 'Member') {
        const sym = table.resolve(`${arg.object}.${arg.property}`);
        if (sym)
            return ir.sym(sym);
        diagnostics.push(diag('warning', 'UNKNOWN_MEMBER', `Edge source "${arg.object}.${arg.property}" does not resolve — emitting symbolic CLK; wire manually.`, {
            span: arg.span,
            symbol: `${arg.object}.${arg.property}`,
            hint: `Bind "${arg.property}" in equipment "${arg.object}".io_bindings, or change the edge argument to an existing role.`,
        }));
        return ir.raw(`${arg.object}.${arg.property}`);
    }
    return astToIr(arg, table, new EdgeRegistry(), diagnostics);
}
function exprTextForHandle(node) {
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
export function buildSymbolEnvironment(table) {
    return {
        lookupRef(name) {
            const s = table.resolve(name);
            if (!s)
                return null;
            if (s.kind !== 'io' &&
                s.kind !== 'parameter' &&
                s.kind !== 'alarm' &&
                s.kind !== 'local')
                return null;
            return valueTypeToSclType(s.valueType);
        },
        lookupMember(object, property) {
            const s = table.resolve(`${object}.${property}`);
            if (!s || s.kind !== 'equipment_role')
                return null;
            return valueTypeToSclType(s.valueType);
        },
        lookupFunction(name) {
            return DEFAULT_FUNCTIONS[name] ?? null;
        },
        keywordType(name) {
            const s = table.resolve(name);
            if (!s || s.kind !== 'keyword') {
                return DEFAULT_KEYWORD_TYPES[name] ?? null;
            }
            return valueTypeToSclType(s.valueType);
        },
    };
}
function valueTypeToSclType(v) {
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
