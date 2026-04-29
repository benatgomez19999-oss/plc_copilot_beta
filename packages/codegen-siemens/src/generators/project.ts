import type { Project } from '@plccopilot/pir';
import { runTargetPreflight } from '@plccopilot/codegen-core';
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
 *
 * Sprint 86 — runs the codegen readiness preflight before
 * `compileProject` and throws a single `READINESS_FAILED`
 * `CodegenError` with the rolled-up diagnostic list when any
 * preflight error is found. Non-blocking warnings and info
 * pass through; the per-target manifest renderer still surfaces
 * them downstream.
 */
export function generateSiemensProject(
  project: Project,
  opts?: GenerateOptions,
): GeneratedArtifact[] {
  runTargetPreflight(project, 'siemens');
  const program = compileProject(project, opts);
  return renderProgramArtifacts(program);
}
