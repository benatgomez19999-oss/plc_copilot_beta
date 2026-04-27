/**
 * Sprint 61 — type declarations for the release-plan library so the
 * Vitest spec under `packages/cli/tests/` can import the `.mjs` under
 * strict tsc without TS7016. Keep this surface minimal — the runtime
 * is in the `.mjs` file.
 */

export const RELEASE_PACKAGE_DIRS: readonly string[];
export const EXPECTED_PACKAGE_NAMES: Readonly<Record<string, string>>;
export const RELEASE_PUBLISH_ORDER: readonly string[];
export const ISSUE_CODES: Readonly<Record<string, string>>;

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: unknown): SemverParts | null;
export function formatSemver(v: SemverParts): string;
export function bumpVersion(version: string, kind: 'patch' | 'minor' | 'major'): string;
export function compareSemver(a: string, b: string): -1 | 0 | 1;

export interface ReleasePackageJsonInfo {
  raw: string;
  parsed: any;
  path: string;
}

export interface ReleaseCandidate {
  dir: string;
  packageDir: string;
  missing: boolean;
  pkg?: ReleasePackageJsonInfo | null;
  parseError?: string | null;
}

export interface ReleaseWorkspace {
  repoRoot: string;
  candidates: ReleaseCandidate[];
  npmrc: string | null;
}

export function loadReleaseWorkspace(repoRoot: string): ReleaseWorkspace;

export interface ReleaseIssue {
  level: 'error';
  code: string;
  package: string | null;
  message: string;
  recommendation: string | null;
}

export interface ReleaseCheckResult {
  issues: ReleaseIssue[];
  sharedVersion: string | null;
}

export function checkReleaseState(workspace: ReleaseWorkspace): ReleaseCheckResult;

export type ReleaseTarget =
  | { kind: 'bump'; bump: 'patch' | 'minor' | 'major' }
  | { kind: 'exact'; version: string };

export interface ReleasePlanPackage {
  dir: string;
  name: string;
  current_version: string | null;
  target_version: string | null;
}

export interface ReleasePlanDependencyUpdate {
  package: string;
  section: 'dependencies' | 'peerDependencies' | 'optionalDependencies';
  dependency: string;
  from: string | null;
  to: string | null;
}

export interface ReleasePlan {
  ok: boolean;
  current_version: string | null;
  target_version: string | null;
  package_count: number;
  packages: ReleasePlanPackage[];
  dependency_updates: ReleasePlanDependencyUpdate[];
  publish_order: string[];
  gates: string[];
  issues: ReleaseIssue[];
}

export function buildReleasePlan(
  workspace: ReleaseWorkspace,
  target: ReleaseTarget,
): ReleasePlan;

export function renderMarkdownPlan(plan: ReleasePlan): string;
export function buildJsonPlan(plan: ReleasePlan): ReleasePlan;
export function applyReleasePlan(
  workspace: ReleaseWorkspace,
  plan: ReleasePlan,
): string[];

export interface PackManifestEntry {
  name: string;
  version: string;
  files?: Array<{ path: string }>;
}

export interface PackManifestExpectation {
  name: string;
  version: string;
  requiredEntries: string[];
}

export function checkPackManifest(
  manifest: PackManifestEntry[] | unknown,
  expected: PackManifestExpectation,
): ReleaseIssue[];
