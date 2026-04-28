// Sprint 62 — type declarations for the publish-dry-run helper lib.

export interface PublishDryRunCommand {
  cmd: 'npm';
  args: string[];
}

export function buildPublishDryRunCommand(forwardArgs?: string[]): PublishDryRunCommand;
export function isDryRunCommand(cmd: PublishDryRunCommand | unknown): boolean;

export interface PublishDryRunResult {
  id?: string;
  name?: string;
  version?: string;
  filename?: string;
  files?: Array<{ path: string; size?: number; mode?: number }>;
  size?: number;
  unpackedSize?: number;
  shasum?: string;
  integrity?: string;
}

export function parsePublishDryRunOutput(stdout: string): PublishDryRunResult | null;

export interface PublishExpectation {
  name: string;
  version: string;
}

export interface PublishDryRunIssue {
  level: 'error';
  code: string;
  package: string | null;
  message: string;
  recommendation: string | null;
}

export function checkPublishDryRunResult(
  parsed: PublishDryRunResult | null,
  expected: PublishExpectation,
): PublishDryRunIssue[];

export interface PublishDryRunSpawnLike {
  status: number | null;
  stdout: string | null | undefined;
  stderr: string | null | undefined;
  error?: Error | null;
}

export function checkPublishDryRunSpawn(
  result: PublishDryRunSpawnLike,
  expected: PublishExpectation,
): PublishDryRunIssue[];

/**
 * Sprint 67 closeout — true when the npm dry-run failure message
 * names the exact `expectedVersion` as the conflicting one. Lets
 * `pnpm run ci` keep accepting `release:publish-dry-run` after a
 * successful publish without masking real conflicts on a different
 * version.
 */
export function isAlreadyPublishedError(
  stderr: string | null | undefined,
  stdout: string | null | undefined,
  expectedVersion: string,
): boolean;
