// Sprint 62 — type declarations for the release-notes helper lib.

import type {
  ReleaseIssue,
  ReleasePlanDependencyUpdate,
  ReleasePlanPackage,
  ReleaseTarget,
  ReleaseWorkspace,
} from './release-plan-lib.mjs';

export interface ReleaseNotes {
  ok: boolean;
  title: string;
  current_version: string | null;
  target_version: string | null;
  package_count: number;
  packages: ReleasePlanPackage[];
  dependency_updates: ReleasePlanDependencyUpdate[];
  publish_order: string[];
  highlights: string[];
  compatibility: string[];
  checklist: string[];
  issues: ReleaseIssue[];
}

export function buildReleaseNotes(
  workspace: ReleaseWorkspace,
  target: ReleaseTarget,
): ReleaseNotes;

export function renderMarkdownReleaseNotes(notes: ReleaseNotes): string;
export function buildJsonReleaseNotes(notes: ReleaseNotes): ReleaseNotes;

export const _internal: Readonly<{
  HIGHLIGHT_TODO_ITEMS: readonly string[];
  COMPATIBILITY_NOTES: readonly string[];
  VERIFICATION_CHECKLIST: readonly string[];
  RELEASE_PACKAGE_DIRS: readonly string[];
}>;
