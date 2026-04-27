import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  stableJson,
  type GeneratedArtifact,
} from '@plccopilot/codegen-core';
import { fail } from '../errors.js';

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  info: number;
}

export interface BackendSummary {
  backend: string;
  artifact_count: number;
  diagnostics: DiagnosticCounts;
  artifacts: string[];
}

export interface AllBackendsSummary {
  backend: 'all';
  runs: BackendSummary[];
}

/**
 * Aggregate diagnostic severities across `artifact.diagnostics`. The
 * manifest's `compiler_diagnostics` field is intentionally NOT scanned to
 * avoid double-counting the same diagnostic that has already been
 * surfaced on a station-FB artifact. (See README §CLI for the limitation.)
 */
export function aggregateDiagnostics(
  artifacts: readonly GeneratedArtifact[],
): DiagnosticCounts {
  const counts: DiagnosticCounts = { errors: 0, warnings: 0, info: 0 };
  for (const a of artifacts) {
    if (!a.diagnostics) continue;
    for (const d of a.diagnostics) {
      if (d.severity === 'error') counts.errors++;
      else if (d.severity === 'warning') counts.warnings++;
      else if (d.severity === 'info') counts.info++;
    }
  }
  return counts;
}

export function buildBackendSummary(
  backend: string,
  artifacts: readonly GeneratedArtifact[],
): BackendSummary {
  return {
    backend,
    artifact_count: artifacts.length,
    diagnostics: aggregateDiagnostics(artifacts),
    artifacts: artifacts.map((a) => a.path),
  };
}

/**
 * Serialise a summary deterministically (via core's `stableJson`) and write
 * it to `<outDir>/summary.json`. Errors are surfaced as `CliError` (exit 1).
 */
export function writeSummary(
  outDir: string,
  summary: BackendSummary | AllBackendsSummary,
): string {
  const path = join(resolve(outDir), 'summary.json');
  try {
    writeFileSync(path, stableJson(summary), 'utf-8');
  } catch (e) {
    fail(`failed to write summary.json`, 1, e);
  }
  return path;
}
