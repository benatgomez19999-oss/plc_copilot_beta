import type { Project } from '@plccopilot/pir';
import { parseJsonPath } from './json-locator.js';
import { diffPirValues, type PirDiffEntry } from './pir-diff.js';

/**
 * Iterate the structure-tree ancestors a JSONPath contributes to. The
 * navigator renders four levels — `$`, machine, station, equipment — and
 * any path nested under one of them counts towards every ancestor along
 * the chain.
 *
 * A path that goes beyond equipment (e.g. `cyl01.io_bindings.solenoid_out`)
 * still contributes to equipment / station / machine / root — the leaf
 * `io_bindings` is not a structure node so we stop short of it.
 *
 * Paths that branch off above equipment (`machines[0].io[0].name`) only
 * contribute to machine + root; the diff entry exists, but no station or
 * equipment owns it.
 *
 * Exported so the validation-issue layer can reuse the exact same lifting
 * logic — keeps "what counts as a structure ancestor" defined in one
 * place. Sprint 24's diff helpers iterate this for `PirDiffEntry`;
 * sprint 28's validation helpers iterate it for `Issue`.
 */
export function* structureAncestorsForJsonPath(
  path: string,
): Iterable<string> {
  yield '$';
  const segs = parseJsonPath(path);
  if (!segs) return;

  if (segs[0] !== 'machines' || typeof segs[1] !== 'number') return;
  const machinePath = `$.machines[${segs[1]}]`;
  yield machinePath;

  if (segs[2] !== 'stations' || typeof segs[3] !== 'number') return;
  const stationPath = `${machinePath}.stations[${segs[3]}]`;
  yield stationPath;

  if (segs[4] !== 'equipment' || typeof segs[5] !== 'number') return;
  yield `${stationPath}.equipment[${segs[5]}]`;
}

/**
 * Fold a diff list into `Map<structureNodeJsonPath, number>` so the
 * navigator can render `● N` pills next to each affected node.
 *
 *   - Each `PirDiffEntry` counts as **1**, regardless of `kind`
 *     (`added` / `removed` / `changed`). The user wants "how many things
 *     are pending here", not "how many bytes changed".
 *   - Each diff entry contributes to **every structure ancestor** along
 *     its path (project / machine / station / equipment), so collapsed
 *     branches still show a non-zero pill summarising the descendants.
 *   - Sub-trees beyond equipment (IO, alarms, sequence, …) roll up into
 *     the deepest structure ancestor they live under — the tree never
 *     renders an `equipment.io_bindings.role` row, so we don't try to
 *     count one.
 *
 * The function is pure and deterministic — given equal inputs it returns
 * equal results across runs. Map insertion order tracks the diff list
 * order; tests should query via `.get(path)` rather than iterate.
 */
export function getStructureChangeCounts(
  applied: Project | null,
  draft: Project | null,
): Map<string, number> {
  if (!applied || !draft) return new Map();
  return structureChangeCountsFromDiffs(diffPirValues(applied, draft));
}

/**
 * Same fold as `getStructureChangeCounts`, but starting from a precomputed
 * diff list. Used by App when it already keeps a memoized `pirDiffs` to
 * avoid running `diffPirValues` twice.
 */
export function structureChangeCountsFromDiffs(
  diffs: PirDiffEntry[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (diffs.length === 0) return out;

  for (const d of diffs) {
    for (const ancestor of structureAncestorsForJsonPath(d.path)) {
      out.set(ancestor, (out.get(ancestor) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Per-node breakdown of pending diffs by `PirDiffEntry.kind`. The badge
 * consumes this for its tooltip / aria-label so the user sees what kind
 * of change is pending under a branch (`2 changed · 1 added`) without
 * leaving the tree.
 *
 * `total` is always the sum of the three kind buckets, so any caller
 * that just wants the count can read it without summing manually. Kept
 * as a separate field for cheap lookup.
 */
export interface StructureChangeBreakdown {
  total: number;
  added: number;
  removed: number;
  changed: number;
}

/**
 * Fold a diff list into `Map<structureNodeJsonPath, breakdown>`. Shares
 * the ancestor-iteration helper with `structureChangeCountsFromDiffs`,
 * so both maps lift the same diff entries onto the same ancestor chain
 * — they can never disagree about which nodes are touched. Sum of each
 * bucket's `total` across all nodes equals what the count map reports.
 *
 * Defensive default: an unrecognised `kind` is counted as `changed`.
 * `pir-diff.ts` only emits `'added' | 'removed' | 'changed'`, but if a
 * future diff producer adds a new kind, the bucket lookup falls through
 * to `changed` so `total` stays consistent and the UI keeps rendering.
 */
export function structureChangeBreakdownsFromDiffs(
  diffs: readonly PirDiffEntry[],
): Map<string, StructureChangeBreakdown> {
  const out = new Map<string, StructureChangeBreakdown>();
  if (diffs.length === 0) return out;

  for (const d of diffs) {
    const bucket: keyof StructureChangeBreakdown =
      d.kind === 'added' || d.kind === 'removed' ? d.kind : 'changed';
    for (const ancestor of structureAncestorsForJsonPath(d.path)) {
      let b = out.get(ancestor);
      if (!b) {
        b = { total: 0, added: 0, removed: 0, changed: 0 };
        out.set(ancestor, b);
      }
      b.total++;
      b[bucket]++;
    }
  }
  return out;
}

/**
 * Format a breakdown into a short human-readable phrase for tooltips and
 * aria-labels. Order of kinds is fixed (`changed → added → removed`)
 * because that is roughly the dominant edit type for visual saves;
 * zero-count buckets are omitted so the string never shows `0 added`.
 *
 * Total-function: returns `No pending changes` when every bucket is 0,
 * so the call site can use the result unconditionally.
 *
 * Examples:
 *   { total:1, changed:1 }                  → "1 changed"
 *   { total:3, changed:2, added:1 }         → "2 changed · 1 added"
 *   { total:2, added:1, removed:1 }         → "1 added · 1 removed"
 *   { total:0 }                             → "No pending changes"
 */
export function formatStructureChangeBreakdown(
  b: StructureChangeBreakdown,
): string {
  if (b.total === 0) return 'No pending changes';
  const parts: string[] = [];
  if (b.changed > 0) parts.push(`${b.changed} changed`);
  if (b.added > 0) parts.push(`${b.added} added`);
  if (b.removed > 0) parts.push(`${b.removed} removed`);
  return parts.join(' · ');
}

/**
 * Lift a list of `PirDiffEntry` paths into the four structure-tree levels
 * the navigator renders (project root, machine, station, equipment).
 *
 * Implemented as a thin wrapper over `structureChangeCountsFromDiffs` so
 * Set membership and counter keys can never disagree. Existing callers
 * that only need "is this node changed?" stay on this overload.
 */
export function changedStructurePathsFromDiffs(
  diffs: PirDiffEntry[],
): Set<string> {
  return new Set(structureChangeCountsFromDiffs(diffs).keys());
}

/**
 * Convenience wrapper for App: diff two projects and lift the result into
 * the structure-path Set in one call. Returns an empty Set when either
 * side is missing — the navigator treats that as "no dots".
 */
export function getChangedStructurePaths(
  applied: Project | null,
  draft: Project | null,
): Set<string> {
  if (!applied || !draft) return new Set();
  return changedStructurePathsFromDiffs(diffPirValues(applied, draft));
}

/**
 * Returns true iff the diff entry's `path` resolves under `nodePath` in the
 * structure tree. The rule that matters is preventing substring traps —
 * `stations[1]` must NOT match `stations[10].name` — so we check exact
 * equality first, then require the next character after the prefix to be
 * a structural separator (`.` for object descent, `[` for further array
 * indexing). Empty `nodePath` is rejected explicitly.
 *
 * The `$` root is special-cased: every diff path emitted by `diffPirValues`
 * starts with `$`, so `nodePath === '$'` matches any non-empty diff path.
 */
export function isDiffUnderNodePath(
  diffPath: string,
  nodePath: string,
): boolean {
  if (nodePath === '' || diffPath === '') return false;
  if (nodePath === '$') return diffPath.startsWith('$');
  if (diffPath === nodePath) return true;
  if (diffPath.length <= nodePath.length) return false;
  if (!diffPath.startsWith(nodePath)) return false;
  const next = diffPath[nodePath.length];
  return next === '.' || next === '[';
}

/**
 * List every diff path that falls under `nodePath`, in `pirDiffs` order,
 * with duplicate paths collapsed (first occurrence wins). Used by the
 * tree's `● N` badge to cycle through pending changes — App keeps a
 * per-node click counter and indexes into this array modulo its length.
 *
 *   - Order is deterministic because `diffPirValues` itself is
 *     (sorted-key object descent, by-index array descent, depth-first).
 *   - Dedupe is a defensive safeguard: `diffPirValues` doesn't currently
 *     emit identical paths twice, but the cycle invariant ("each click
 *     advances to a distinct change") matters more than the diff
 *     producer's contract, so we enforce it here.
 *   - Empty `nodePath` or empty `diffs` → `[]`. The root path `$`
 *     matches every diff (special-cased inside `isDiffUnderNodePath`).
 */
export function changedDescendantPaths(
  nodePath: string,
  diffs: readonly PirDiffEntry[],
): string[] {
  if (!nodePath || diffs.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of diffs) {
    if (!isDiffUnderNodePath(d.path, nodePath)) continue;
    if (seen.has(d.path)) continue;
    seen.add(d.path);
    out.push(d.path);
  }
  return out;
}

/**
 * Locate the first `PirDiffEntry` whose path falls under `nodePath`. Used
 * as a back-compat shim by the tree badge when the parent only supplied
 * `diffs` + `onFocusInEditor` (no cycle handler) — the caller wants the
 * single first change, not the cycle.
 *
 * Implemented as `changedDescendantPaths(...)[0] ?? null` so the two
 * helpers share one filter predicate and one iteration order — they can
 * never disagree about "what counts as a descendant".
 */
export function firstChangedDescendantPath(
  nodePath: string,
  diffs: readonly PirDiffEntry[],
): string | null {
  return changedDescendantPaths(nodePath, diffs)[0] ?? null;
}
