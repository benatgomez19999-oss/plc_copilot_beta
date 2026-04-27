import type { Project } from '@plccopilot/pir';
import type {
  ArtifactDiagnostic,
  GeneratedArtifact,
} from '@plccopilot/codegen-core';
import { generateSiemensProject } from '@plccopilot/codegen-siemens';
import { generateCodesysProject } from '@plccopilot/codegen-codesys';
import { generateRockwellProject } from '@plccopilot/codegen-rockwell';

export type BackendChoice = 'siemens' | 'codesys' | 'rockwell' | 'all';

export interface CompileSummary {
  artifactCount: number;
  errors: number;
  warnings: number;
  info: number;
}

export interface CompileResult {
  backend: BackendChoice;
  artifacts: GeneratedArtifact[];
  diagnostics: ArtifactDiagnostic[];
  summary: CompileSummary;
}

export interface CompilePirOptions {
  /** ISO timestamp embedded in each backend's manifest. Useful for repro builds. */
  generatedAt?: string;
}

type Single = Exclude<BackendChoice, 'all'>;

/**
 * Run one or more backend pipelines on a Project, in-browser. Pure: no
 * filesystem touch, no network. The same façade as the CLI exposes — same
 * deterministic output, just consumed from React state instead of disk.
 *
 * For `'all'`, the three backends run sequentially and their artifacts
 * concatenated. Each artifact's `path` already carries its backend
 * directory prefix (`siemens/…`, `codesys/…`, `rockwell/…`), so they never
 * collide.
 */
export function compilePir(
  project: Project,
  backend: BackendChoice,
  opts?: CompilePirOptions,
): CompileResult {
  const options = opts?.generatedAt
    ? { manifest: { generatedAt: opts.generatedAt } }
    : undefined;

  if (backend === 'all') {
    const sie = generateSiemensProject(project, options);
    const cod = generateCodesysProject(project, options);
    const roc = generateRockwellProject(project, options);
    return buildResult('all', [...sie, ...cod, ...roc]);
  }

  return buildResult(backend, generateForBackend(backend, project, options));
}

function generateForBackend(
  backend: Single,
  project: Project,
  options: { manifest: { generatedAt: string } } | undefined,
): GeneratedArtifact[] {
  switch (backend) {
    case 'siemens':
      return generateSiemensProject(project, options);
    case 'codesys':
      return generateCodesysProject(project, options);
    case 'rockwell':
      return generateRockwellProject(project, options);
    default: {
      const exhaustive: never = backend;
      throw new Error(`unknown backend "${String(exhaustive)}"`);
    }
  }
}

function buildResult(
  backend: BackendChoice,
  artifacts: GeneratedArtifact[],
): CompileResult {
  const diagnostics: ArtifactDiagnostic[] = [];
  for (const a of artifacts) {
    if (a.diagnostics) diagnostics.push(...a.diagnostics);
  }
  return {
    backend,
    artifacts,
    diagnostics,
    summary: {
      artifactCount: artifacts.length,
      errors: countSeverity(diagnostics, 'error'),
      warnings: countSeverity(diagnostics, 'warning'),
      info: countSeverity(diagnostics, 'info'),
    },
  };
}

function countSeverity(
  diagnostics: readonly ArtifactDiagnostic[],
  severity: 'error' | 'warning' | 'info',
): number {
  let n = 0;
  for (const d of diagnostics) if (d.severity === severity) n++;
  return n;
}
