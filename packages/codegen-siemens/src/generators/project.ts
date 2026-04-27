import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '../types.js';
import {
  compileProject,
  type CompileProjectOptions,
} from '../compiler/program/compile-project.js';
import { renderProgramArtifacts } from '../compiler/program/artifacts.js';

export interface GenerateOptions extends CompileProjectOptions {}

/**
 * Public façade — signature unchanged. Internally this is now a thin adapter
 * over `compileProject` + `renderProgramArtifacts`. The intermediate
 * `ProgramIR` is reachable via `compileProject(project, opts)` for tooling.
 */
export function generateSiemensProject(
  project: Project,
  opts?: GenerateOptions,
): GeneratedArtifact[] {
  const program = compileProject(project, opts);
  return renderProgramArtifacts(program);
}
