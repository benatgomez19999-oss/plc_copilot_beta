import type { PirDiffEntry, PirDiffKind } from './pir-diff.js';

/**
 * Lookup result for a single JSONPath inside a `PirDiffEntry[]`. The
 * detail-card UI uses `changed` as a render gate — when false, the
 * `<FieldDiff>` component returns null.
 *
 * `kind` mirrors the diff entry it came from so future surfaces (e.g.
 * showing only "added" or "removed" entries) can branch on it without
 * recomputing.
 */
export interface FieldDiffResult {
  changed: boolean;
  appliedValue?: unknown;
  draftValue?: unknown;
  kind?: PirDiffKind;
}

/**
 * Exact-path lookup. Returns `{ changed: false }` when no diff entry
 * matches `path`, or when `diffs` is undefined / empty.
 *
 * Linear scan — diff lists are small (a handful to a few dozen entries)
 * for any realistic PIR edit. The detail card calls this once per
 * editable field per render; a hash map would over-engineer the
 * problem.
 */
export function getFieldDiff(
  diffs: PirDiffEntry[] | undefined,
  path: string,
): FieldDiffResult {
  if (!diffs || diffs.length === 0) return { changed: false };
  for (const d of diffs) {
    if (d.path === path) {
      return {
        changed: true,
        appliedValue: d.appliedValue,
        draftValue: d.draftValue,
        kind: d.kind,
      };
    }
  }
  return { changed: false };
}
