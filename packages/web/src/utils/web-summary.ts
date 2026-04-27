/**
 * Sprint 51 — pure helper that produces the `summary.json` payload
 * embedded inside the artifacts ZIP downloaded from the Web MVP
 * (`handleDownloadZip` in `App.tsx`).
 *
 * Shape is **preserved verbatim** from the previous inline literal
 * to avoid breaking integrators who may already be parsing the
 * downloaded ZIP. Notable inherited quirks:
 *
 *   - `artifactCount` uses camelCase (mirrors `CompileSummary`).
 *   - `generated_at` uses snake_case (matches every other timestamp
 *     PLC Copilot emits).
 *   - Diagnostic counts (`errors` / `warnings` / `info`) live at the
 *     root, not inside a `diagnostics` object.
 *
 * The contract is now formalised by the CLI's
 * `web-zip-summary.schema.json` so any future drift is caught by
 * the schema-validation test suite.
 */

export type WebZipBackend = 'siemens' | 'codesys' | 'rockwell' | 'all';

export interface WebZipDiagnosticsCounts {
  errors: number;
  warnings: number;
  info: number;
}

export interface WebZipSummary {
  backend: WebZipBackend;
  artifactCount: number;
  errors: number;
  warnings: number;
  info: number;
  generated_at: string;
}

export interface BuildWebZipSummaryInput {
  backend: WebZipBackend;
  artifactCount: number;
  diagnostics: WebZipDiagnosticsCounts;
  /**
   * ISO 8601 timestamp. Defaults to `new Date().toISOString()` so
   * tests can pin a deterministic value while production still
   * stamps the wall clock.
   */
  generatedAt?: string;
}

export function buildWebZipSummary(
  input: BuildWebZipSummaryInput,
): WebZipSummary {
  return {
    backend: input.backend,
    artifactCount: input.artifactCount,
    errors: input.diagnostics.errors,
    warnings: input.diagnostics.warnings,
    info: input.diagnostics.info,
    generated_at: input.generatedAt ?? new Date().toISOString(),
  };
}
