// Sprint 64 — type declarations for the registry-install smoke helper lib.

import type { ReleaseWorkspace } from './release-plan-lib.mjs';

export const REGISTRY_SMOKE_DEFAULTS: Readonly<{
  registry: string;
  packageName: string;
}>;

export interface RegistrySmokeOptions {
  version: string | null;
  registry: string | null;
  packageName: string | null;
  keep: boolean;
  help: boolean;
}

export interface RegistrySmokeIssue {
  level: 'error';
  code: string;
  message: string;
  recommendation: string | null;
}

export interface ParsedRegistrySmokeArgs {
  options: RegistrySmokeOptions | null;
  errors: RegistrySmokeIssue[];
}

export function parseRegistrySmokeArgs(argv: readonly string[] | unknown): ParsedRegistrySmokeArgs;

export interface ResolvedRegistrySmokeOptions {
  version: string;
  registry: string;
  packageName: string;
  keep: boolean;
  help: boolean;
}

export function validateRegistrySmokeOptions(
  rawOptions: Partial<RegistrySmokeOptions> | null,
  workspace: ReleaseWorkspace | null,
): { options: ResolvedRegistrySmokeOptions; issues: RegistrySmokeIssue[] };

export interface NpmInstallArgsInput {
  packageName: string;
  version: string;
  registry: string;
}

export function buildNpmInstallArgs(input: NpmInstallArgsInput): readonly string[];

export function buildInstalledBinPath(consumerDir: string, platform?: NodeJS.Platform): string;

export function isNpmNotFoundError(stderr: string | null | undefined, stdout: string | null | undefined): boolean;

export interface SpawnLike {
  status?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error | null;
}

export function summarizeSpawnFailure(label: string, result: SpawnLike, max?: number): string;
