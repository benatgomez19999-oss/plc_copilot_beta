import type { GeneratedArtifact } from '@plccopilot/codegen-core';

/**
 * Locate the artifact in `previousArtifacts` whose `path` exactly matches
 * `currentPath`. Returns `null` when none matches.
 *
 * Exact-path lookup is intentional for this sprint — comparing across
 * different backends (e.g. siemens/FB_StLoad.scl vs codesys/FB_StLoad.st)
 * would be cross-backend semantic-diff and is explicitly out of scope.
 */
export function findPreviousArtifact(
  currentPath: string,
  previousArtifacts: readonly GeneratedArtifact[],
): GeneratedArtifact | null {
  for (const a of previousArtifacts) {
    if (a.path === currentPath) return a;
  }
  return null;
}

/**
 * `true` when `previous.content !== current.content`. Strict string compare,
 * not structural — for our use case (text artifacts written byte-by-byte
 * by deterministic renderers) this is sufficient and unambiguous.
 */
export function hasContentChanged(
  previous: GeneratedArtifact,
  current: GeneratedArtifact,
): boolean {
  return previous.content !== current.content;
}
