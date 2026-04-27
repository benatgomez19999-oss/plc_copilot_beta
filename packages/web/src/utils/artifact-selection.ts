import type { GeneratedArtifact } from '@plccopilot/codegen-core';

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Strip the LAST `.ext` from a basename, so `FB_StWeld.scl` and
 * `FB_StWeld.st` both reduce to `FB_StWeld`. Files with no extension
 * (e.g. `LICENSE`) and dotfiles (`.gitignore`) are returned as-is —
 * we only strip the suffix when there is a real basename before the
 * dot. `manifest.json` reduces to `manifest`, which is fine: the
 * `isManifest` guard runs separately and operates on the full path.
 */
function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

function isManifest(a: GeneratedArtifact): boolean {
  return a.path.endsWith('manifest.json');
}

/**
 * Pick the artifact path the UI should auto-select after a (re-)compile.
 *
 * Heuristic, in order:
 *   1. The user's previous selection still exists → keep it.
 *   2. Same basename **stem** exists in a different backend directory
 *      (e.g. user had `siemens/FB_StWeld.scl`, now generating Codesys
 *      and there is `codesys/FB_StWeld.st`) → follow that file. We
 *      compare stems, not full basenames, because each backend uses
 *      its own extension (`.scl`, `.st`, ...) for the same logical
 *      function block. Match must be exact on the stem — `FB_StWeld`
 *      does NOT match `FB_StWeldMore`.
 *   3. First non-manifest artifact (so we don't open `manifest.json` first).
 *   4. First artifact (last resort).
 *   5. null (empty list).
 *
 * Pure function — no DOM, no side effects. Easy to unit-test.
 */
export function selectBestArtifact(
  previousPath: string | null,
  artifacts: ReadonlyArray<GeneratedArtifact>,
): string | null {
  if (artifacts.length === 0) return null;

  if (previousPath) {
    const exact = artifacts.find((a) => a.path === previousPath);
    if (exact) return exact.path;

    const prevStem = stem(basename(previousPath));
    if (prevStem.length > 0) {
      const sameStem = artifacts.find(
        (a) => stem(basename(a.path)) === prevStem,
      );
      if (sameStem) return sameStem.path;
    }
  }

  const nonManifest = artifacts.find((a) => !isManifest(a));
  if (nonManifest) return nonManifest.path;

  return artifacts[0]!.path;
}
