import type { Project } from '@plccopilot/pir';
import {
  compileProject,
  type CompileProjectOptions,
  type GeneratedArtifact,
} from '@plccopilot/codegen-core';
import { renderProgramArtifactsRockwell } from '../renderers/artifacts-rockwell.js';

export interface GenerateRockwellOptions extends CompileProjectOptions {}

/**
 * EXPERIMENTAL Rockwell / Studio 5000 ST POC backend.
 *
 * Reuses the same `compileProject` → `ProgramIR` pipeline as Siemens and
 * Codesys, then layers Rockwell-specific diagnostics (`ROCKWELL_*`) before
 * rendering. The result is a bundle of Logix-flavoured `.st` text files and
 * a manifest.json — NOT a Studio 5000 L5X archive.
 */
export function generateRockwellProject(
  project: Project,
  options?: GenerateRockwellOptions,
): GeneratedArtifact[] {
  const program = compileProject(project, options);
  return renderProgramArtifactsRockwell(program);
}

export {
  renderProgramArtifactsRockwell,
  withRockwellDiagnostics,
  computeRockwellDiagnostics,
} from '../renderers/artifacts-rockwell.js';
