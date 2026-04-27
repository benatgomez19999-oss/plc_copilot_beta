// Sprint 65 — type declarations for the npm-view verifier helper lib.

import type { ReleaseWorkspace } from './release-plan-lib.mjs';

export const NPM_VIEW_DEFAULTS: Readonly<{ registry: string }>;

export interface NpmViewIssue {
  level: 'error';
  code: string;
  package: string | null;
  message: string;
  recommendation: string | null;
}

export interface NpmViewOptions {
  version: string | null;
  registry: string | null;
  tag: string | null;
  json: boolean;
  help: boolean;
}

export function parseNpmViewArgs(argv: readonly string[] | unknown): {
  options: NpmViewOptions | null;
  errors: NpmViewIssue[];
};

export interface ResolvedNpmViewOptions {
  version: string;
  registry: string;
  tag: string | null;
  json: boolean;
  help: boolean;
}

export function validateNpmViewOptions(
  rawOptions: Partial<NpmViewOptions> | null,
  workspace: ReleaseWorkspace | null,
): { options: ResolvedNpmViewOptions; issues: NpmViewIssue[] };

export function buildNpmViewPackageArgs(input: {
  packageName: string;
  version: string;
  registry: string;
}): readonly string[];

export function buildNpmViewTagArgs(input: {
  packageName: string;
  tag: string;
  registry: string;
}): readonly string[];

export function parseNpmViewJson(stdout: string | null | undefined): unknown;

export interface NpmViewExpectation {
  name: string;
  version: string;
  tag?: string | null;
}

export function validateNpmViewPackageMetadata(
  metadata: unknown,
  expected: NpmViewExpectation,
): NpmViewIssue[];

export function validateNpmViewTagVersion(
  value: unknown,
  expected: NpmViewExpectation & { tag: string },
): NpmViewIssue[];

export function isNpmViewNotFoundError(
  stderr: string | null | undefined,
  stdout: string | null | undefined,
): boolean;

export function expectedForCandidate(
  dir: string,
  version: string,
  tag?: string | null,
): NpmViewExpectation;
