import {
  flattenPirStructure,
  type PirStructureNodeTree,
} from './pir-structure.js';

/**
 * Returns true iff `path` matches the `jsonPath` of any node in `tree`
 * (project, machine, station, or equipment). Comparison is exact —
 * bracket-indexed paths such as `$.machines[0].stations[1].equipment[2]`
 * are matched literally, the same way `parseJsonPath` consumes them.
 */
export function pathExistsInStructure(
  tree: PirStructureNodeTree,
  path: string,
): boolean {
  return flattenPirStructure(tree).some((n) => n.jsonPath === path);
}

/**
 * Convenience wrapper used by App when the structure tree is rebuilt
 * (mode toggle, draft swap, applied swap). Returns the same string when
 * the previous selection still resolves, otherwise `null`. Treats a
 * `null` input as a pass-through so callers don't need to special-case
 * the "nothing was selected" path.
 */
export function preserveOrClearSelection(
  tree: PirStructureNodeTree,
  selectedPath: string | null,
): string | null {
  if (selectedPath === null) return null;
  return pathExistsInStructure(tree, selectedPath) ? selectedPath : null;
}
