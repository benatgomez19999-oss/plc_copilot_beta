// Sprint 69 — type declarations for the github-release helper lib.

import type { ReleaseWorkspace } from './release-plan-lib.mjs';

export const GITHUB_RELEASE_TAG_PREFIX: 'v';
export const GITHUB_RELEASE_DEFAULT_TITLE_PREFIX: 'PLC Copilot';
export const GITHUB_RELEASE_PACKAGE_ORDER: readonly string[];

export function expectedGithubReleaseConfirmation(version: string): string;
export function expectedGithubReleaseTag(version: string): string;
export function expectedGithubReleaseTitle(version: string): string;

export interface GithubReleaseIssue {
  level: 'error';
  code: string;
  message: string;
  recommendation: string | null;
}

export interface GithubReleaseOptions {
  version: string | null;
  tag: string | null;
  confirm: string;
  notesFile: string | null;
  validateOnly: boolean;
  json: boolean;
  help: boolean;
}

export function parseGithubReleaseArgs(argv: readonly string[] | unknown): {
  options: GithubReleaseOptions | null;
  errors: GithubReleaseIssue[];
};

export interface ResolvedGithubReleaseOptions {
  version: string;
  tag: string;
  confirm: string;
  notesFile: string | null;
  validateOnly: boolean;
  json: boolean;
  help: boolean;
}

export function validateGithubReleaseInputs(
  rawOptions: Partial<GithubReleaseOptions> | null,
  workspace: ReleaseWorkspace | null,
): { options: ResolvedGithubReleaseOptions; issues: GithubReleaseIssue[] };

export function validateReleaseNotesForGithubRelease(
  markdown: string | null | undefined,
  options?: { version?: string },
): GithubReleaseIssue[];

export function validateGithubReleaseAssets(
  input: { tarballPaths?: readonly string[]; manifestPath?: string },
  options?: { existsFn?: (path: string) => boolean },
): GithubReleaseIssue[];

export function buildGhReleaseCreateArgs(input: {
  version: string;
  tag: string;
  title?: string;
  notesFile: string;
  assetPaths: readonly string[];
}): readonly string[];

export function buildGhReleaseViewArgs(input: { tag: string }): readonly string[];

export function assertNoNpmMutationSurface(argv: readonly string[] | unknown): true;
