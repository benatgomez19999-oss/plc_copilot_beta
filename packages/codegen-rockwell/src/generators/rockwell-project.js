import { compileProject, runTargetPreflight, } from '@plccopilot/codegen-core';
import { renderProgramArtifactsRockwell } from '../renderers/artifacts-rockwell.js';
/**
 * EXPERIMENTAL Rockwell / Studio 5000 ST POC backend. Sprint 86 — runs the
 * codegen readiness preflight first; throws `READINESS_FAILED` on blocking
 * diagnostics.
 */
export function generateRockwellProject(project, options) {
    runTargetPreflight(project, 'rockwell');
    const program = compileProject(project, options);
    return renderProgramArtifactsRockwell(program);
}
export { renderProgramArtifactsRockwell, withRockwellDiagnostics, computeRockwellDiagnostics, } from '../renderers/artifacts-rockwell.js';
