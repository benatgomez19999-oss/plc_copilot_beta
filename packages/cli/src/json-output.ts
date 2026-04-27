import {
  stableJson,
  type SerializedCompilerError,
} from '@plccopilot/codegen-core';
import type { Issue, Project, ValidationReport } from '@plccopilot/pir';
import { serializeCliFailure } from './errors.js';
import type { CliIO } from './cli.js';

/**
 * Sprint 45 — machine-readable CLI output contract.
 *
 * Every JSON-mode payload starts from this base so consumers (CI,
 * agents, orchestrators) can branch on `command` + `ok` and rely on
 * a stable timestamp. Snake-case field names match the existing
 * `summary.json` convention.
 *
 * `command` includes `'unknown'` to cover the dispatcher's
 * "unknown command" error path; the strict per-command builders
 * never use that variant.
 */
export type CliCommandName = 'generate' | 'validate' | 'inspect';
export type CliJsonCommandName = CliCommandName | 'unknown';

export interface CliJsonBase {
  ok: boolean;
  command: CliJsonCommandName;
  generated_at: string;
}

export interface CliJsonErrorResult extends CliJsonBase {
  ok: false;
  error: SerializedCompilerError;
}

export interface CliDiagnosticCounts {
  errors: number;
  warnings: number;
  info: number;
}

export interface CliGenerateRunSummary {
  backend: 'siemens' | 'codesys' | 'rockwell';
  artifact_count: number;
  diagnostics: CliDiagnosticCounts;
}

export interface CliGenerateJsonResult extends CliJsonBase {
  ok: true;
  command: 'generate';
  backend: 'siemens' | 'codesys' | 'rockwell' | 'all';
  out_dir: string;
  artifact_count: number;
  written_files: string[];
  diagnostics: CliDiagnosticCounts;
  runs?: CliGenerateRunSummary[];
  summary_path: string;
}

export interface CliValidateIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  path?: string;
}

export interface CliValidateJsonResult extends CliJsonBase {
  ok: boolean;
  command: 'validate';
  project_id?: string;
  project_name?: string;
  issues: CliValidateIssue[];
  counts: CliDiagnosticCounts;
}

export interface CliInspectMachineSummary {
  id: string;
  name?: string;
  stations: number;
  equipment: number;
  io: number;
  alarms: number;
  parameters: number;
  recipes: number;
}

export interface CliInspectJsonResult extends CliJsonBase {
  ok: true;
  command: 'inspect';
  project: {
    id: string;
    name: string;
    pir_version: string;
  };
  counts: {
    machines: number;
    stations: number;
    equipment: number;
    io: number;
    alarms: number;
    parameters: number;
    recipes: number;
  };
  machines: CliInspectMachineSummary[];
  supported_backends: Array<'siemens' | 'codesys' | 'rockwell' | 'all'>;
}

export type CliJsonResult =
  | CliGenerateJsonResult
  | CliValidateJsonResult
  | CliInspectJsonResult
  | CliJsonErrorResult;

// =============================================================================
// Builders
// =============================================================================

/**
 * Wall-clock provider — defaults to `Date.now()`. Tests can inject a
 * fixed clock to make the output byte-deterministic without monkey-
 * patching globals.
 */
export type CliClock = () => Date;

const realClock: CliClock = () => new Date();

function isoNow(clock: CliClock = realClock): string {
  return clock().toISOString();
}

export function buildErrorPayload(
  command: CliJsonCommandName,
  error: unknown,
  debug = false,
  clock: CliClock = realClock,
): CliJsonErrorResult {
  return {
    ok: false,
    command,
    generated_at: isoNow(clock),
    error: serializeCliFailure(error, debug),
  };
}

export interface BuildGeneratePayloadInput {
  backend: 'siemens' | 'codesys' | 'rockwell' | 'all';
  outDir: string;
  artifactCount: number;
  writtenFiles: readonly string[];
  diagnostics: CliDiagnosticCounts;
  summaryPath: string;
  runs?: readonly CliGenerateRunSummary[];
}

export function buildGeneratePayload(
  input: BuildGeneratePayloadInput,
  clock: CliClock = realClock,
): CliGenerateJsonResult {
  const out: CliGenerateJsonResult = {
    ok: true,
    command: 'generate',
    generated_at: isoNow(clock),
    backend: input.backend,
    out_dir: input.outDir,
    artifact_count: input.artifactCount,
    written_files: input.writtenFiles.slice(),
    diagnostics: { ...input.diagnostics },
    summary_path: input.summaryPath,
  };
  if (input.runs) out.runs = input.runs.map((r) => ({ ...r }));
  return out;
}

function issueToCliShape(issue: Issue): CliValidateIssue {
  const out: CliValidateIssue = {
    severity: issue.severity,
    rule: issue.rule,
    message: issue.message,
  };
  if (issue.path) out.path = issue.path;
  return out;
}

export function countValidateIssues(
  issues: readonly Issue[],
): CliDiagnosticCounts {
  const out: CliDiagnosticCounts = { errors: 0, warnings: 0, info: 0 };
  for (const i of issues) {
    if (i.severity === 'error') out.errors++;
    else if (i.severity === 'warning') out.warnings++;
    else out.info++;
  }
  return out;
}

export function buildValidatePayload(
  project: Project,
  report: ValidationReport,
  clock: CliClock = realClock,
): CliValidateJsonResult {
  return {
    ok: report.ok,
    command: 'validate',
    generated_at: isoNow(clock),
    project_id: project.id,
    project_name: project.name,
    issues: report.issues.map(issueToCliShape),
    counts: countValidateIssues(report.issues),
  };
}

export function buildInspectPayload(
  project: Project,
  clock: CliClock = realClock,
): CliInspectJsonResult {
  let stations = 0;
  let equipment = 0;
  let io = 0;
  let alarms = 0;
  let parameters = 0;
  let recipes = 0;
  const machines: CliInspectMachineSummary[] = [];

  for (const m of project.machines) {
    const mEq = m.stations.reduce((acc, s) => acc + s.equipment.length, 0);
    stations += m.stations.length;
    equipment += mEq;
    io += m.io.length;
    alarms += m.alarms.length;
    parameters += m.parameters.length;
    recipes += m.recipes.length;
    const summary: CliInspectMachineSummary = {
      id: m.id,
      stations: m.stations.length,
      equipment: mEq,
      io: m.io.length,
      alarms: m.alarms.length,
      parameters: m.parameters.length,
      recipes: m.recipes.length,
    };
    if (m.name) summary.name = m.name;
    machines.push(summary);
  }

  return {
    ok: true,
    command: 'inspect',
    generated_at: isoNow(clock),
    project: {
      id: project.id,
      name: project.name,
      pir_version: project.pir_version,
    },
    counts: {
      machines: project.machines.length,
      stations,
      equipment,
      io,
      alarms,
      parameters,
      recipes,
    },
    machines,
    supported_backends: ['siemens', 'codesys', 'rockwell', 'all'],
  };
}

// =============================================================================
// Output side-effect — single chokepoint so the test shim can capture it.
// =============================================================================

/**
 * Serialise `payload` deterministically (via core's `stableJson`) and
 * push it to `io.log` as a single line. The CLI never mixes JSON and
 * human output, so callers should ensure no other `io.log` happened
 * in JSON mode.
 */
export function writeJson(io: CliIO, payload: CliJsonResult): void {
  io.log(stableJson(payload));
}
