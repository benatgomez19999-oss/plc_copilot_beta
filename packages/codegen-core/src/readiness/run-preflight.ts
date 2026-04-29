// Sprint 86 — shared helper for target façades.
//
// Targets call `runTargetPreflight(project, target)` at the
// start of their `generateXxxProject` entry. The helper:
//
//   1. Calls `preflightProject(project, { target })`.
//   2. If any error severity diagnostic was collected, throws
//      a single `CodegenError('READINESS_FAILED', …)` whose
//      message is a rolled-up summary and whose `cause` carries
//      the full diagnostic list.
//   3. Otherwise returns the `PreflightResult` unchanged so
//      the caller may also surface warnings/info into the
//      manifest.
//
// Pure / total. No I/O.

import type { Project } from '@plccopilot/pir';

import { CodegenError } from '../types.js';
import {
  preflightProject,
  type CodegenTarget,
  type PreflightResult,
} from './codegen-readiness.js';

export function runTargetPreflight(
  project: Project,
  target: CodegenTarget,
): PreflightResult {
  const result = preflightProject(project, { target });
  if (!result.hasBlockingErrors) return result;

  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  const first = errors[0];
  // Single-line message: the existing CLI / web formatters
  // (`formatSerializedCompilerError`) split on `\n` and assume one
  // line per error. Keep the rolled-up summary readable but joined
  // with ` | ` so downstream UX contracts hold.
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
