/**
 * Pure structural diff over JSON-like values.
 *
 * Produces a flat list of `PirDiffEntry` records keyed by JSONPath strings
 * compatible with `parseJsonPath` / `findJsonPathLine`. The output order is
 * deterministic for any pair of equal inputs (objects walked in sorted-key
 * order; arrays walked by index; depth-first).
 *
 * Design notes:
 *   - `Object.is` for scalar equality so `NaN === NaN`, `+0` vs `-0`, and
 *     `null` vs `undefined` are distinguished correctly. PIR validation
 *     and codegen all rely on these distinctions (default values, optional
 *     fields), so we mirror them in the visual diff.
 *   - Arrays are diffed by index — added / removed entries do NOT recurse
 *     into the new subtree. A freshly-appended station yields ONE
 *     `added` entry carrying the whole station object as `draftValue`,
 *     not hundreds of leaf entries. This keeps the tree-marking layer
 *     tractable and matches the user's expectation of "added" as a
 *     coarse signal.
 *   - Plain objects are diffed by the **sorted union of keys** so the
 *     output is independent of property iteration order. That makes the
 *     diff stable across `JSON.parse` runs and serialization rounds.
 *
 * No mutation, no I/O, no React. Suitable for `useMemo` and unit tests.
 */

export type PirDiffKind = 'added' | 'removed' | 'changed';

export interface PirDiffEntry {
  path: string;
  kind: PirDiffKind;
  appliedValue?: unknown;
  draftValue?: unknown;
}

export function diffPirValues(
  applied: unknown,
  draft: unknown,
  basePath: string = '$',
): PirDiffEntry[] {
  const out: PirDiffEntry[] = [];
  walk(out, applied, draft, basePath);
  return out;
}

// =============================================================================
// internal walker
// =============================================================================

function walk(
  out: PirDiffEntry[],
  a: unknown,
  b: unknown,
  path: string,
): void {
  if (Object.is(a, b)) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      const sub = `${path}[${i}]`;
      if (i >= a.length) {
        out.push({ path: sub, kind: 'added', draftValue: b[i] });
      } else if (i >= b.length) {
        out.push({ path: sub, kind: 'removed', appliedValue: a[i] });
      } else {
        walk(out, a[i], b[i], sub);
      }
    }
    return;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = sortedUnionKeys(a, b);
    for (const k of keys) {
      const sub = path === '$' ? `$.${k}` : `${path}.${k}`;
      const aHas = Object.prototype.hasOwnProperty.call(a, k);
      const bHas = Object.prototype.hasOwnProperty.call(b, k);
      if (!aHas && bHas) {
        out.push({ path: sub, kind: 'added', draftValue: b[k] });
      } else if (aHas && !bHas) {
        out.push({ path: sub, kind: 'removed', appliedValue: a[k] });
      } else {
        walk(out, a[k], b[k], sub);
      }
    }
    return;
  }

  // Type mismatch (object vs array, null vs object, …) OR scalars differ.
  out.push({ path, kind: 'changed', appliedValue: a, draftValue: b });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sortedUnionKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const set = new Set<string>();
  for (const k of Object.keys(a)) set.add(k);
  for (const k of Object.keys(b)) set.add(k);
  return Array.from(set).sort();
}
