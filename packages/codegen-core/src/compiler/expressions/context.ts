import type { Diagnostic } from '../diagnostics.js';

/**
 * Sprint 43 — minimal "where does this expression come from in the
 * PIR" record threaded into `lowerExpression` so its parser /
 * checker / IR-builder Diagnostics carry the offending PIR field's
 * JSON path, station scope, owning entity id, and an actionable
 * hint.
 *
 * The expression layer never knows where its source string came
 * from — that's the caller's responsibility (transition guard,
 * interlock when, alarm when, edge source, …). When the caller can
 * point at a JSON path, it stamps this context; emitters that
 * produce Diagnostics without their own metadata inherit the
 * context's fields automatically.
 *
 * All fields are optional so a partial context (e.g. just `path`)
 * can still enrich diagnostics meaningfully.
 */
export interface ExpressionDiagnosticContext {
  path?: string;
  stationId?: string;
  symbol?: string;
  hint?: string;
}

/**
 * Sprint 43 — fill missing metadata fields on every diagnostic
 * with the context's values. Diagnostic's OWN fields always win:
 * a Diagnostic that already carries `path: 'machines[0].io[3]'`
 * keeps that path even when the surrounding expression context
 * supplies something more generic. This mirrors the
 * `codegenErrorFromDiagnostic` philosophy of "the more specific
 * source wins, the wrapper only fills gaps".
 *
 * Returns a new array of (potentially) new Diagnostic objects;
 * never mutates the input. Returns the input unchanged when
 * `context` is undefined / null so the call site can use this as
 * a no-op decorator.
 */
export function applyExpressionContext(
  diagnostics: readonly Diagnostic[],
  context: ExpressionDiagnosticContext | undefined,
): Diagnostic[] {
  if (!context) return diagnostics.slice();
  return diagnostics.map((d) => {
    // Cheap fast-path: when the diagnostic already has every field
    // the context could fill, return the original reference. Saves
    // an allocation per untouched Diagnostic.
    const needsPath = context.path !== undefined && d.path === undefined;
    const needsStation =
      context.stationId !== undefined && d.stationId === undefined;
    const needsSymbol =
      context.symbol !== undefined && d.symbol === undefined;
    const needsHint = context.hint !== undefined && d.hint === undefined;
    if (!needsPath && !needsStation && !needsSymbol && !needsHint) return d;
    return {
      ...d,
      ...(needsPath ? { path: context.path } : {}),
      ...(needsStation ? { stationId: context.stationId } : {}),
      ...(needsSymbol ? { symbol: context.symbol } : {}),
      ...(needsHint ? { hint: context.hint } : {}),
    };
  });
}
