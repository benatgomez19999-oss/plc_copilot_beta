// Sprint 68 — type declarations for the promote-latest helper lib.

import type { ReleaseWorkspace } from './release-plan-lib.mjs';

export const PROMOTE_SOURCE_TAG: 'next';
export const PROMOTE_TARGET_TAG: 'latest';
export const PROMOTE_SCOPE: '@plccopilot';
export const PROMOTE_DEFAULT_REGISTRY: string;
export const PROMOTE_REQUIRED_ENV_VARS: readonly string[];
export const PROMOTE_PACKAGE_ORDER: readonly string[];

export function expectedPromoteConfirmation(version: string): string;

export interface PromoteIssue {
  level: 'error';
  code: string;
  message: string;
  recommendation: string | null;
}

export interface PromoteOptions {
  version: string | null;
  registry: string | null;
  confirm: string;
  validateOnly: boolean;
  json: boolean;
  help: boolean;
}

export function parsePromoteLatestArgs(argv: readonly string[] | unknown): {
  options: PromoteOptions | null;
  errors: PromoteIssue[];
};

export interface ResolvedPromoteOptions {
  version: string;
  registry: string;
  confirm: string;
  validateOnly: boolean;
  json: boolean;
  help: boolean;
  env?: Record<string, string | undefined>;
}

export function validatePromoteInputs(
  rawOptions: (Partial<PromoteOptions> & { env?: Record<string, string | undefined> }) | null,
  workspace: ReleaseWorkspace | null,
): { options: ResolvedPromoteOptions; issues: PromoteIssue[] };

export function buildNpmViewTagArgs(input: {
  packageName: string;
  tag: 'next' | 'latest' | 'beta';
  registry: string;
}): readonly string[];

export function buildNpmDistTagAddArgs(input: {
  packageName: string;
  version: string;
  tag: 'latest';
  registry: string;
}): readonly string[];

export function isNpmNotFoundError(
  stderr: string | null | undefined,
  stdout: string | null | undefined,
): boolean;

export function parseNpmJson(stdout: string | null | undefined): unknown;

export interface TagVersionExpectation {
  packageName: string;
  version: string;
  tag: 'next' | 'latest' | 'beta';
}

export function validateTagVersion(
  value: unknown,
  expected: TagVersionExpectation,
): PromoteIssue[];

export function assertNoPublishSurface(argv: readonly string[] | unknown): true;
