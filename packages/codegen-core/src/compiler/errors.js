import { CodegenError } from '../types.js';
/**
 * Reduce any thrown value to a transport-safe
 * `SerializedCompilerError`. Branches on the input shape:
 *
 *   - `CodegenError` instance → preserves `code`, `path`, plus the
 *     extension fields (`stationId`, `symbol`, `hint`) when populated
 *     by the throw site. `cause` is summarised to its message.
 *   - Other `Error` subclasses → `name` + `message` (+ cause + optional
 *     stack).
 *   - Non-Error throws (string / number / null / unknown object) →
 *     `name: 'Error'` + best-effort string conversion. Never throws,
 *     immune to circular references.
 *
 * `cause` is always summarised one level deep — never serialised
 * recursively — so the output is bounded and JSON.stringify-safe.
 */
export function serializeCompilerError(error, options = {}) {
    const includeStack = options.includeStack ?? false;
    if (error instanceof CodegenError) {
        const out = {
            name: error.name,
            code: error.code,
            message: error.message,
        };
        if (error.path)
            out.path = error.path;
        if (error.stationId)
            out.stationId = error.stationId;
        if (error.symbol)
            out.symbol = error.symbol;
        if (error.hint)
            out.hint = error.hint;
        const causeStr = summariseCause(error.cause);
        if (causeStr !== null)
            out.cause = causeStr;
        if (includeStack && typeof error.stack === 'string') {
            out.stack = error.stack;
        }
        return out;
    }
    if (error instanceof Error) {
        const out = {
            name: error.name || 'Error',
            message: error.message || String(error),
        };
        const causeStr = summariseCause(error.cause);
        if (causeStr !== null)
            out.cause = causeStr;
        if (includeStack && typeof error.stack === 'string') {
            out.stack = error.stack;
        }
        return out;
    }
    if (typeof error === 'string') {
        return { name: 'Error', message: error };
    }
    return {
        name: 'Error',
        message: stringifySafe(error),
    };
}
function summariseCause(cause) {
    if (cause === undefined || cause === null)
        return null;
    if (cause instanceof Error)
        return cause.message || cause.name || 'Error';
    if (typeof cause === 'string')
        return cause;
    return stringifySafe(cause);
}
/**
 * Best-effort `String(v)` that never throws — defends against
 * objects with a hostile `toString` and circular references.
 */
function stringifySafe(v) {
    try {
        if (typeof v === 'string')
            return v;
        if (v === null)
            return 'null';
        if (v === undefined)
            return 'undefined';
        return String(v);
    }
    catch {
        return '[unrepresentable]';
    }
}
/**
 * Sprint 40 — promote a diagnostic-first error into a `CodegenError`,
 * preserving every structured field the lowering pipeline already
 * populates (`path`, `stationId`, `symbol`, `hint`). Adapter sites
 * (e.g. `compileProject` re-throwing the first error in a station
 * lowering result, or `generateStationFb`) used to copy only `path`
 * — every other field was dropped on the way out, leaving CLI / web
 * UIs to render decorations that lacked half their context. This
 * helper is a single chokepoint so the conversion stays consistent.
 *
 * The diagnostic's `code` is asserted to `CodegenErrorCode`. The two
 * unions overlap by construction (`DiagnosticCode` is a superset that
 * includes info-only codes like `EDGE_LOWERED_AS_RISING`); callers
 * only invoke this for `severity === 'error'` diagnostics, whose
 * codes are always within the `CodegenErrorCode` slice. We don't
 * runtime-validate because the alternative (throwing here) would mask
 * the real underlying error.
 */
export function codegenErrorFromDiagnostic(diagnostic) {
    return new CodegenError(diagnostic.code, diagnostic.message, {
        ...(diagnostic.path !== undefined ? { path: diagnostic.path } : {}),
        ...(diagnostic.stationId !== undefined
            ? { stationId: diagnostic.stationId }
            : {}),
        ...(diagnostic.symbol !== undefined ? { symbol: diagnostic.symbol } : {}),
        ...(diagnostic.hint !== undefined ? { hint: diagnostic.hint } : {}),
    });
}
/**
 * Render a `SerializedCompilerError` as a stable, single-line
 * human-readable string. Format:
 *
 *     [CODE] message (path: …, station: …, symbol: …) Hint: … Cause: …
 *
 * Sections are skipped when their fields are empty. The single-line
 * shape is the contract — both CLI stderr and the web banner consume
 * it, so a UI choosing to wrap is the renderer's call, not the
 * formatter's.
 *
 * If the serialized error carries a `stack`, it is appended on
 * subsequent lines. Stack is only present when the caller of
 * `serializeCompilerError` opted in via `includeStack: true` —
 * default UI flows therefore stay single-line.
 *
 * No-code errors (plain `Error`, non-Error throws) render as
 * `<Name>: message …` — mirroring the native `Error.toString()`
 * shape so users still recognise it.
 */
export function formatSerializedCompilerError(error) {
    const head = error.code
        ? `[${error.code}] ${error.message}`
        : `${error.name}: ${error.message}`;
    const parts = [head];
    const meta = [];
    if (error.path)
        meta.push(`path: ${error.path}`);
    if (error.stationId)
        meta.push(`station: ${error.stationId}`);
    if (error.symbol)
        meta.push(`symbol: ${error.symbol}`);
    if (meta.length > 0)
        parts.push(`(${meta.join(', ')})`);
    if (error.hint)
        parts.push(`Hint: ${error.hint}`);
    if (error.cause)
        parts.push(`Cause: ${error.cause}`);
    const line = parts.join(' ');
    return error.stack ? `${line}\n${error.stack}` : line;
}
