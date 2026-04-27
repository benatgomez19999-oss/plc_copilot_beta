import { parseJsonPath, type PathSegment } from './json-locator.js';

/**
 * Result of a JSONPath patch attempt. The patch util never throws — it
 * always returns one of these branches so the UI can render the error
 * inline instead of bubbling exceptions through React.
 */
export type PatchResult =
  | { ok: true; jsonText: string }
  | { ok: false; error: string };

/**
 * Strict JSONPath parser used by the visual-edit patch flow. Reuses the
 * same grammar as `parseJsonPath` (so navigator paths and patch paths
 * share one source of truth) but throws on malformed input — `setJsonPathValue`
 * catches and converts the throw into a `{ ok:false }` result.
 *
 * Accepts:  $   $.foo   foo[0].bar   machines[0].stations[1].name
 * Rejects:  foo[abc]    foo[          (any path `parseJsonPath` returns null for)
 */
export function parseEditableJsonPath(path: string): PathSegment[] {
  const segs = parseJsonPath(path);
  if (segs === null) {
    throw new Error(`Invalid JSONPath: ${JSON.stringify(path)}`);
  }
  return segs;
}

/**
 * Set a value at `path` inside the JSON document `jsonText`.
 *
 * Behavior contract — important details for callers:
 *
 *   - The input string is never mutated; on success the caller receives a
 *     freshly stringified JSON document.
 *   - Output is always `JSON.stringify(obj, null, 2) + '\n'` so successive
 *     patches converge on the same canonical formatting as
 *     `projectToPrettyJson` (no spurious diff churn after Apply).
 *   - For object parents, the leaf segment may name a property that does
 *     not yet exist — that is the **add description / code_symbol** flow.
 *   - For array parents, the leaf index must already be in range — this
 *     util intentionally does NOT support array insert / append / delete
 *     (the spec keeps complex structural edits in JSON-only mode).
 *   - The root path `$` is rejected: replacing the whole document from a
 *     single field would mask user intent. Callers that need that should
 *     use the editor directly.
 *   - Any intermediate missing key / out-of-range index produces a clear
 *     error; the patch is never applied partially.
 */
export function setJsonPathValue(
  jsonText: string,
  path: string,
  value: unknown,
): PatchResult {
  let segs: PathSegment[];
  try {
    segs = parseEditableJsonPath(path);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (segs.length === 0) {
    return {
      ok: false,
      error: 'Cannot patch the root path `$` — edit individual fields instead.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return {
      ok: false,
      error: `Cannot patch — the draft is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  // Walk every segment except the last, requiring each to exist. We hold
  // the immediate parent of the leaf as `cursor`.
  let cursor: unknown = parsed;
  for (let i = 0; i < segs.length - 1; i++) {
    const stepped = stepInto(cursor, segs[i]!);
    if (!stepped.ok) return stepped;
    cursor = stepped.value;
  }

  const writeResult = writeLeaf(cursor, segs[segs.length - 1]!, value);
  if (!writeResult.ok) return writeResult;

  return { ok: true, jsonText: JSON.stringify(parsed, null, 2) + '\n' };
}

// =============================================================================
// internal helpers
// =============================================================================

type Step =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function stepInto(cursor: unknown, seg: PathSegment): Step {
  if (typeof seg === 'number') {
    if (!Array.isArray(cursor)) {
      return {
        ok: false,
        error: `Path expected an array at index [${seg}], got ${describeKind(cursor)}.`,
      };
    }
    if (seg < 0 || seg >= cursor.length) {
      return {
        ok: false,
        error: `Array index [${seg}] is out of range (length ${cursor.length}).`,
      };
    }
    return { ok: true, value: cursor[seg] };
  }
  // string key
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
    return {
      ok: false,
      error: `Path expected an object at key "${seg}", got ${describeKind(cursor)}.`,
    };
  }
  if (!(seg in (cursor as Record<string, unknown>))) {
    return {
      ok: false,
      error: `Path key "${seg}" does not exist on the parent object.`,
    };
  }
  return { ok: true, value: (cursor as Record<string, unknown>)[seg] };
}

type Write =
  | { ok: true }
  | { ok: false; error: string };

function writeLeaf(parent: unknown, seg: PathSegment, value: unknown): Write {
  if (typeof seg === 'number') {
    if (!Array.isArray(parent)) {
      return {
        ok: false,
        error: `Cannot set index [${seg}] on a non-array parent (got ${describeKind(parent)}).`,
      };
    }
    if (seg < 0 || seg >= parent.length) {
      return {
        ok: false,
        error: `Array index [${seg}] is out of range (length ${parent.length}).`,
      };
    }
    parent[seg] = value;
    return { ok: true };
  }
  if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) {
    return {
      ok: false,
      error: `Cannot set key "${seg}" on a non-object parent (got ${describeKind(parent)}).`,
    };
  }
  // For object parents we always assign — JS creates the prop if absent,
  // which is precisely the "add description / code_symbol" flow.
  (parent as Record<string, unknown>)[seg] = value;
  return { ok: true };
}

function describeKind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
