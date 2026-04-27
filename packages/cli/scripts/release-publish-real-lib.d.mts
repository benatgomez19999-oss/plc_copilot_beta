// Sprint 63 — type declarations for the real-publish helper lib.

import type { ReleaseWorkspace } from './release-plan-lib.mjs';

export const VALID_NPM_TAGS: readonly ['next', 'latest', 'beta'];
export const PUBLISH_SCOPE: '@plccopilot';
export const PUBLISH_REQUIRED_ENV_VARS: readonly string[];
export const PUBLISH_ORDER: readonly string[];

export function expectedPublishConfirmation(version: string): string;

export function buildNpmPublishCommand(opts: { tag: string }): readonly string[];

export interface PublishInputIssue {
  level: 'error';
  code: string;
  message: string;
  recommendation: string | null;
}

export interface PublishInputValidationResult {
  issues: PublishInputIssue[];
  expectedConfirm: string | null;
}

export function validatePublishInputs(
  inputs: {
    version: string | undefined;
    tag: string | undefined;
    confirm?: string;
    env?: Record<string, string | undefined>;
    validateOnly?: boolean;
  },
  workspace: ReleaseWorkspace | null,
): PublishInputValidationResult;
