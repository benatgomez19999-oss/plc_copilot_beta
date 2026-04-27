import { tokenize as pirTokenize } from '@plccopilot/pir';
import { makeDiagnostic } from './diagnostics.js';
export function lex(source) {
    const { tokens, issues } = pirTokenize(source);
    const diagnostics = issues.map((msg) => toLexDiagnostic(msg, source));
    return { tokens, diagnostics, source };
}
export function tokenSpan(t) {
    return { start: t.start, end: t.end };
}
function toLexDiagnostic(issue, src) {
    const match = /position (\d+)/.exec(issue);
    const pos = match
        ? Math.min(Number(match[1]), Math.max(0, src.length - 1))
        : 0;
    const span = {
        start: Math.max(0, pos),
        end: Math.min(pos + 1, Math.max(1, src.length)),
    };
    return makeDiagnostic('error', 'LEX_ERROR', issue, span);
}
