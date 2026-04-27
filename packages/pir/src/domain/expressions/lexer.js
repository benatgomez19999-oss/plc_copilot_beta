import { EXPR_FUNCTIONS, EXPR_KEYWORDS } from '../refs.js';
const WS = /[ \t\r\n]/;
const DIGIT = /[0-9]/;
const ALPHA = /[a-zA-Z_]/;
const ALNUM = /[a-zA-Z0-9_]/;
export function tokenize(src) {
    const tokens = [];
    const issues = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (WS.test(c)) {
            i++;
            continue;
        }
        // single-char punctuation
        if (c === '(') {
            tokens.push({ type: 'lparen', value: '(', start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === ')') {
            tokens.push({ type: 'rparen', value: ')', start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === ',') {
            tokens.push({ type: 'comma', value: ',', start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === '.') {
            tokens.push({ type: 'dot', value: '.', start: i, end: i + 1 });
            i++;
            continue;
        }
        // 2-char operators
        const c2 = src[i + 1];
        if (c === '&' && c2 === '&') {
            tokens.push({ type: 'and', value: '&&', start: i, end: i + 2 });
            i += 2;
            continue;
        }
        if (c === '|' && c2 === '|') {
            tokens.push({ type: 'or', value: '||', start: i, end: i + 2 });
            i += 2;
            continue;
        }
        if (c === '=' && c2 === '=') {
            tokens.push({ type: 'eq', value: '==', start: i, end: i + 2 });
            i += 2;
            continue;
        }
        if (c === '!' && c2 === '=') {
            tokens.push({ type: 'neq', value: '!=', start: i, end: i + 2 });
            i += 2;
            continue;
        }
        if (c === '<' && c2 === '=') {
            tokens.push({ type: 'lte', value: '<=', start: i, end: i + 2 });
            i += 2;
            continue;
        }
        if (c === '>' && c2 === '=') {
            tokens.push({ type: 'gte', value: '>=', start: i, end: i + 2 });
            i += 2;
            continue;
        }
        // single-char operators
        if (c === '!') {
            tokens.push({ type: 'not', value: '!', start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === '<') {
            tokens.push({ type: 'lt', value: '<', start: i, end: i + 1 });
            i++;
            continue;
        }
        if (c === '>') {
            tokens.push({ type: 'gt', value: '>', start: i, end: i + 1 });
            i++;
            continue;
        }
        // numbers
        if (DIGIT.test(c)) {
            const start = i;
            while (i < src.length && DIGIT.test(src[i]))
                i++;
            // fractional part — only if dot is followed by a digit (otherwise it's a role separator)
            if (i < src.length && src[i] === '.' && i + 1 < src.length && DIGIT.test(src[i + 1])) {
                i++;
                while (i < src.length && DIGIT.test(src[i]))
                    i++;
            }
            tokens.push({ type: 'number', value: src.slice(start, i), start, end: i });
            continue;
        }
        // identifiers / keywords
        if (ALPHA.test(c)) {
            const start = i;
            while (i < src.length && ALNUM.test(src[i]))
                i++;
            const value = src.slice(start, i);
            const type = EXPR_KEYWORDS.has(value) ? 'keyword' : 'ident';
            tokens.push({ type, value, start, end: i });
            continue;
        }
        // bare `&` or `|` (not doubled) are not valid
        if (c === '&' || c === '|' || c === '=') {
            issues.push(`invalid operator "${c}" at position ${i} — did you mean "${c}${c}"?`);
            i++;
            continue;
        }
        issues.push(`invalid character "${c}" at position ${i}`);
        i++;
    }
    return { tokens, issues };
}
/**
 * Lex-level analyzer. Produces:
 *   - tokens (flat)
 *   - symbolRefs — TOP-LEVEL identifier references (dedup'd)
 *   - functionCalls — whitelist check done by validators
 *   - issues — lex errors + paren balance
 *
 * Function-call arguments are captured raw and are NOT emitted as symbolRefs
 * (per v0.1 grammar).
 */
export function analyzeExpression(expr) {
    const { tokens, issues } = tokenize(expr);
    // paren balance (whole expression)
    let depth = 0;
    for (const t of tokens) {
        if (t.type === 'lparen')
            depth++;
        else if (t.type === 'rparen') {
            depth--;
            if (depth < 0) {
                issues.push(`unbalanced ")" at position ${t.start}`);
                break;
            }
        }
    }
    if (depth > 0) {
        issues.push(`unbalanced "(" — ${depth} open paren(s) not closed`);
    }
    const symbolRefs = [];
    const functionCalls = [];
    let i = 0;
    while (i < tokens.length) {
        const tk = tokens[i];
        // Bare function name used as identifier (no lparen after) — reject.
        if (tk.type === 'ident' && EXPR_FUNCTIONS.has(tk.value)) {
            const next = tokens[i + 1];
            if (!next || next.type !== 'lparen') {
                issues.push(`function name "${tk.value}" used as identifier at position ${tk.start}`);
                i++;
                continue;
            }
        }
        if (tk.type === 'ident') {
            const next = tokens[i + 1];
            // Function call: IDENT '(' args ')'
            if (next && next.type === 'lparen') {
                const name = tk.value;
                i += 2; // past IDENT + '('
                const argsTokens = [[]];
                let d = 1;
                while (i < tokens.length && d > 0) {
                    const t = tokens[i];
                    if (t.type === 'lparen') {
                        d++;
                        argsTokens[argsTokens.length - 1].push(t);
                    }
                    else if (t.type === 'rparen') {
                        d--;
                        if (d === 0)
                            break;
                        argsTokens[argsTokens.length - 1].push(t);
                    }
                    else if (t.type === 'comma' && d === 1) {
                        argsTokens.push([]);
                    }
                    else {
                        argsTokens[argsTokens.length - 1].push(t);
                    }
                    i++;
                }
                const args = argsTokens
                    .map((arr) => arr.map((t) => t.value).join(''))
                    .filter((s) => s.length > 0);
                functionCalls.push({ name, args });
                if (i < tokens.length)
                    i++; // past closing ')'
                continue;
            }
            // Compound ref: IDENT '.' IDENT
            const dot = tokens[i + 1];
            const after = tokens[i + 2];
            if (dot && dot.type === 'dot' && after && after.type === 'ident') {
                symbolRefs.push(`${tk.value}.${after.value}`);
                i += 3;
                continue;
            }
            // Bare ref
            symbolRefs.push(tk.value);
            i++;
            continue;
        }
        i++;
    }
    const uniqueRefs = Array.from(new Set(symbolRefs));
    return {
        ok: issues.length === 0,
        tokens,
        symbolRefs: uniqueRefs,
        functionCalls,
        issues,
    };
}
