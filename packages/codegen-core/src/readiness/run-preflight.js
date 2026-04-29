// Sprint 86 — runtime mirror of run-preflight.ts.
import { CodegenError } from '../types.js';
import { preflightProject } from './codegen-readiness.js';

export function runTargetPreflight(project, target) {
    const result = preflightProject(project, { target });
    if (!result.hasBlockingErrors) return result;
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    const first = errors[0];
    // Single-line message (see .ts source for the rationale).
    const summary = errors.map((d) => `[${d.code}] ${d.message}`).join(' | ');
    const message =
        `Codegen readiness failed for target ${target}: ` +
        `${errors.length} blocking diagnostic(s). ${summary}`;
    throw new CodegenError('READINESS_FAILED', message, {
        path: first?.path,
        stationId: first?.stationId,
        symbol: first?.symbol,
        hint: first?.hint ?? `Run preflightProject(project, { target: '${target}' }) for the full list.`,
        cause: { diagnostics: result.diagnostics, target },
    });
}
