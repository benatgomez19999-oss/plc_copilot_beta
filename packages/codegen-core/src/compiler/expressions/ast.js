export function mergeSpans(a, b) {
    return {
        start: Math.min(a.start, b.start),
        end: Math.max(a.end, b.end),
    };
}
export function isKeywordName(value) {
    return (value === 'mode' ||
        value === 'start_cmd' ||
        value === 'release_cmd' ||
        value === 'estop_active' ||
        value === 'auto' ||
        value === 'manual' ||
        value === 'setup' ||
        value === 'maintenance');
}
export const ast = {
    literal(value, literalType, span) {
        return { kind: 'Literal', value, literalType, span };
    },
    keyword(name, span) {
        return { kind: 'Keyword', name, span };
    },
    ref(name, span) {
        return { kind: 'Ref', name, span };
    },
    member(object, property, span) {
        return { kind: 'Member', object, property, span };
    },
    call(callee, args, span) {
        return { kind: 'Call', callee, args, span };
    },
    not(operand, span) {
        return { kind: 'Unary', op: '!', operand, span };
    },
    bin(op, left, right, span) {
        return { kind: 'Binary', op, left, right, span };
    },
};
