import { resolve } from 'node:path';
import type { Project } from '@plccopilot/pir';
import { type GeneratedArtifact } from '@plccopilot/codegen-core';
import { generateSiemensProject } from '@plccopilot/codegen-siemens';
import { generateCodesysProject } from '@plccopilot/codegen-codesys';
import { generateRockwellProject } from '@plccopilot/codegen-rockwell';
import { CliError, formatError } from '../errors.js';
import { readProjectFromFile } from '../io/read-project.js';
import { writeArtifacts } from '../io/write-artifacts.js';
import {
  aggregateDiagnostics,
  buildBackendSummary,
  writeSummary,
  type AllBackendsSummary,
  type BackendSummary,
  type DiagnosticCounts,
} from '../io/summary.js';
import {
  buildErrorPayload,
  buildGeneratePayload,
  writeJson,
  type CliGenerateRunSummary,
} from '../json-output.js';
import type { CliIO } from '../cli.js';

export type GenerateBackend = 'siemens' | 'codesys' | 'rockwell' | 'all';

export interface GenerateArgs {
  input: string;
  out: string;
  backend: GenerateBackend;
  generatedAt?: string;
  /** Sprint 45 — emit a single stable JSON payload to stdout. */
  json?: boolean;
  /** Sprint 45 — include stack traces in serialized errors. */
  debug?: boolean;
}

type Single = Exclude<GenerateBackend, 'all'>;

/**
 * Dispatch to the right backend façade. Each backend's `Options` type
 * extends `CompileProjectOptions` from core, so the shared
 * `{ manifest: { generatedAt } }` shape is structurally compatible with
 * each. A union-of-functions over three different param types is not
 * directly callable in TypeScript, hence the switch.
 */
function generateForBackend(
  backend: Single,
  project: Project,
  generatedAt?: string,
): GeneratedArtifact[] {
  const opts = generatedAt ? { manifest: { generatedAt } } : undefined;
  switch (backend) {
    case 'siemens':
      return generateSiemensProject(project, opts);
    case 'codesys':
      return generateCodesysProject(project, opts);
    case 'rockwell':
      return generateRockwellProject(project, opts);
    default: {
      // Defence-in-depth — `cli.ts` already validates --backend at the
      // dispatcher boundary, but `runGenerate` is also exported for tooling
      // that might pass an arbitrary string.
      const exhaustive: never = backend;
      throw new CliError(`unknown backend "${String(exhaustive)}"`, 1);
    }
  }
}

/**
 * Sprint 45 — emit a JSON error payload (when `--json` is set) or the
 * existing human stderr line, then return the CliError-derived exit
 * code. Centralised so every catch block in this file follows the
 * same contract.
 */
function emitFailure(
  io: CliIO,
  args: GenerateArgs,
  error: unknown,
): number {
  if (args.json) {
    writeJson(io, buildErrorPayload('generate', error, args.debug ?? false));
  } else {
    io.error(formatError(error));
  }
  return error instanceof CliError ? error.code : 1;
}

/**
 * Run the `generate` command.
 *
 * Exit codes:
 *   0 — artifacts written and no error diagnostics
 *   1 — generation failed (file/JSON/schema/codegen/write error)
 *   2 — generation succeeded but artifact diagnostics contain errors
 */
export async function runGenerate(
  args: GenerateArgs,
  io: CliIO,
): Promise<number> {
  let project: Project;
  try {
    project = readProjectFromFile(args.input);
  } catch (e) {
    return emitFailure(io, args, e);
  }

  const outAbs = resolve(args.out);

  if (args.backend === 'all') {
    return runAllBackends(project, outAbs, args, io);
  }

  let artifacts: GeneratedArtifact[];
  try {
    artifacts = generateForBackend(args.backend, project, args.generatedAt);
  } catch (e) {
    return emitFailure(io, args, e);
  }

  let writtenFiles: string[];
  try {
    writtenFiles = writeArtifacts(outAbs, artifacts);
  } catch (e) {
    return emitFailure(io, args, e);
  }

  const summary = buildBackendSummary(args.backend, artifacts);
  let summaryPath: string;
  try {
    summaryPath = writeSummary(outAbs, summary);
  } catch (e) {
    return emitFailure(io, args, e);
  }

  if (args.json) {
    writeJson(
      io,
      buildGeneratePayload({
        backend: args.backend,
        outDir: outAbs,
        artifactCount: summary.artifact_count,
        writtenFiles,
        diagnostics: summary.diagnostics,
        summaryPath,
      }),
    );
  } else {
    printBackendLine(io, summary, outAbs);
  }
  return summary.diagnostics.errors > 0 ? 2 : 0;
}

function runAllBackends(
  project: Project,
  outAbs: string,
  args: GenerateArgs,
  io: CliIO,
): number {
  const runs: BackendSummary[] = [];
  const allArtifacts: GeneratedArtifact[] = [];

  const backends: readonly Single[] = ['siemens', 'codesys', 'rockwell'];
  for (const backend of backends) {
    let artifacts: GeneratedArtifact[];
    try {
      artifacts = generateForBackend(backend, project, args.generatedAt);
    } catch (e) {
      // Sprint 45 — JSON mode emits one structured error; human mode
      // keeps the `[backend]` prefix so the user sees which run died.
      if (args.json) {
        writeJson(
          io,
          buildErrorPayload('generate', e, args.debug ?? false),
        );
      } else {
        io.error(`[${backend}] ${formatError(e)}`);
      }
      return 1;
    }
    runs.push(buildBackendSummary(backend, artifacts));
    allArtifacts.push(...artifacts);
  }

  let writtenFiles: string[];
  try {
    writtenFiles = writeArtifacts(outAbs, allArtifacts);
  } catch (e) {
    return emitFailure(io, args, e);
  }

  const summary: AllBackendsSummary = { backend: 'all', runs };
  let summaryPath: string;
  try {
    summaryPath = writeSummary(outAbs, summary);
  } catch (e) {
    return emitFailure(io, args, e);
  }

  let totalErrors = 0;
  if (args.json) {
    const totalDiags: DiagnosticCounts = aggregateDiagnostics(allArtifacts);
    totalErrors = totalDiags.errors;
    const runSummaries: CliGenerateRunSummary[] = runs.map((r) => ({
      backend: r.backend as 'siemens' | 'codesys' | 'rockwell',
      artifact_count: r.artifact_count,
      diagnostics: { ...r.diagnostics },
    }));
    writeJson(
      io,
      buildGeneratePayload({
        backend: 'all',
        outDir: outAbs,
        artifactCount: allArtifacts.length,
        writtenFiles,
        diagnostics: totalDiags,
        summaryPath,
        runs: runSummaries,
      }),
    );
  } else {
    for (const run of runs) {
      printBackendLine(io, run, outAbs);
      totalErrors += run.diagnostics.errors;
    }
  }
  return totalErrors > 0 ? 2 : 0;
}

function printBackendLine(
  io: CliIO,
  summary: BackendSummary,
  outAbs: string,
): void {
  io.log(
    `Generated ${summary.artifact_count} artifacts for backend ${summary.backend}`,
  );
  io.log(`Output: ${outAbs}`);
  io.log(
    `Diagnostics: ${summary.diagnostics.info} info, ${summary.diagnostics.warnings} warning, ${summary.diagnostics.errors} errors`,
  );
}

