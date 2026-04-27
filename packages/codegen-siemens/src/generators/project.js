import { compileProject, } from '../compiler/program/compile-project.js';
import { renderProgramArtifacts } from '../compiler/program/artifacts.js';
/**
 * Public façade — signature unchanged. Internally this is now a thin adapter
 * over `compileProject` + `renderProgramArtifacts`. The intermediate
 * `ProgramIR` is reachable via `compileProject(project, opts)` for tooling.
 */
export function generateSiemensProject(project, opts) {
    const program = compileProject(project, opts);
    return renderProgramArtifacts(program);
}
