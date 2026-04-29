import { runTargetPreflight } from '@plccopilot/codegen-core';
import { compileProject, } from '../compiler/program/compile-project.js';
import { renderProgramArtifacts } from '../compiler/program/artifacts.js';
/**
 * Public façade — signature unchanged. Internally this is now a thin adapter
 * over `compileProject` + `renderProgramArtifacts`. Sprint 86 — runs the
 * codegen readiness preflight first; throws `READINESS_FAILED` on blocking
 * diagnostics.
 */
export function generateSiemensProject(project, opts) {
    runTargetPreflight(project, 'siemens');
    const program = compileProject(project, opts);
    return renderProgramArtifacts(program);
}
