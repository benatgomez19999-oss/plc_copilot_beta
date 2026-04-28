// Sprint 71 — type declarations for the audit-signatures helper lib.

import type { ReleaseWorkspace } from './release-plan-lib.mjs';

export const AUDIT_SIGNATURES_DEFAULT_REGISTRY: string;
export const AUDIT_SIGNATURES_DEFAULT_PACKAGE: '@plccopilot/cli';
export const AUDIT_SIGNATURES_SCOPE: '@plccopilot/';
export const AUDIT_SIGNATURES_INSTALL_FLAGS: readonly string[];
export const AUDIT_SIGNATURES_DEFAULTS: {
  readonly registry: string;
  readonly packageName: string;
  readonly installFlags: readonly string[];
};

export interface AuditSignaturesIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  recommendation: string | null;
}

export interface AuditSignaturesOptions {
  version: string | null;
  registry: string | null;
  packageName: string | null;
  keep: boolean;
  json: boolean;
  help: boolean;
}

export function parseAuditSignaturesArgs(argv: readonly string[] | unknown): {
  options: AuditSignaturesOptions | null;
  errors: AuditSignaturesIssue[];
};

export interface ResolvedAuditSignaturesOptions {
  version: string;
  registry: string;
  packageName: string;
  keep: boolean;
  json: boolean;
  help: boolean;
}

export function validateAuditSignaturesOptions(
  rawOptions: Partial<AuditSignaturesOptions> | null,
  workspace?: ReleaseWorkspace | null,
): { options: ResolvedAuditSignaturesOptions; issues: AuditSignaturesIssue[] };

export function buildNpmInstallArgs(input: {
  packageName: string;
  version: string;
  registry: string;
}): readonly string[];

export function buildNpmAuditSignaturesArgs(input?: {
  json?: boolean;
}): readonly string[];

export function assertNoNpmMutationSurfaceAuditSignatures(
  argv: readonly string[] | unknown,
): true;

export function buildInstalledPackageSpec(input: {
  packageName: string;
  version: string;
}): string;

export function parseAuditSignaturesJson(stdout: string | null | undefined): unknown;

export function isNpmAuditSignaturesUnsupported(
  stderr: string | null | undefined,
  stdout: string | null | undefined,
): boolean;

export function isSignatureFailure(
  stderr: string | null | undefined,
  stdout: string | null | undefined,
): boolean;

export function isNoSignaturesFound(
  stderr: string | null | undefined,
  stdout: string | null | undefined,
): boolean;

export function isPackageNotFoundError(
  stderr: string | null | undefined,
  stdout: string | null | undefined,
): boolean;

export interface SpawnSummary {
  label: string;
  status: number | null;
  stdout: string | null;
  stderr: string | null;
}

export function summarizeSpawnFailure(
  label: string,
  result: { stdout?: unknown; stderr?: unknown; status?: unknown } | null | undefined,
  max?: number,
): SpawnSummary | string;

export interface AuditSignaturesReport {
  ok: boolean;
  version: string | null;
  registry: string | null;
  package: string | null;
  installed: boolean;
  audit_signatures: {
    status: number | null;
    passed: boolean;
    invalid_count: number | null;
    missing_count: number | null;
    raw: unknown;
    stdout_summary: string | null;
    stderr_summary: string | null;
  };
  install_summary: {
    status: number | null;
    stdout_summary: string | null;
    stderr_summary: string | null;
  } | null;
  temp_dir: string | null;
  note: string;
  issues: AuditSignaturesIssue[];
}

export function buildAuditSignaturesReport(input: {
  version: string;
  registry: string;
  packageName: string;
  installResult?: { status?: number; stdout?: string; stderr?: string } | null;
  auditResult?: { status?: number; stdout?: string; stderr?: string } | null;
  auditJson?: unknown;
  installIssues?: AuditSignaturesIssue[];
  auditIssues?: AuditSignaturesIssue[];
  tempDir?: string;
}): AuditSignaturesReport;
