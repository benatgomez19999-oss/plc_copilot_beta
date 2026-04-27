export function prettyPrint(node, opts = {}) {
    const pad = ' '.repeat(opts.indent ?? 2);
    const withSpans = opts.withSpans ?? true;
    const render = (n, depth) => {
        if (!n)
            return `${pad.repeat(depth)}<null>`;
        const indent = pad.repeat(depth);
        const loc = withSpans ? ` [${n.span.start}..${n.span.end}]` : '';
        switch (n.kind) {
            case 'Literal':
                return `${indent}Literal ${n.literalType} ${JSON.stringify(n.value)}${loc}`;
            case 'Keyword':
                return `${indent}Keyword ${n.name}${loc}`;
            case 'Ref':
                return `${indent}Ref ${n.name}${loc}`;
            case 'Member':
                return `${indent}Member ${n.object}.${n.property}${loc}`;
            case 'Unary':
                return [
                    `${indent}Unary ${n.op}${loc}`,
                    render(n.operand, depth + 1),
                ].join('\n');
            case 'Binary':
                return [
                    `${indent}Binary ${n.op}${loc}`,
                    render(n.left, depth + 1),
                    render(n.right, depth + 1),
                ].join('\n');
            case 'Call':
                return [
                    `${indent}Call ${n.callee}${loc}`,
                    ...n.args.map((a) => render(a, depth + 1)),
                ].join('\n');
        }
    };
    return render(node, 0);
}
