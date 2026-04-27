/**
 * Best-effort JSONPath → line-number lookup.
 *
 * Goal: place Monaco markers next to the offending field instead of always
 * pinning them at line 1. This is heuristic — we don't run a position-tracking
 * JSON parser; we walk the source text segment by segment.
 *
 * Accepted path formats (all normalised to the same internal segment list):
 *   - `$`                            → []
 *   - `$.foo`                        → ['foo']
 *   - `foo`                          → ['foo']
 *   - `foo.bar`                      → ['foo', 'bar']
 *   - `machines[0]`                  → ['machines', 0]
 *   - `machines[0].stations[1].id`   → ['machines', 0, 'stations', 1, 'id']
 *   - `.foo`                         → ['foo']
 *
 * Reliability: works deterministically on canonical
 * `JSON.stringify(value, null, 2)` output (which is what the PIR editor
 * always shows). On hand-edited JSON with sibling keys that share names,
 * the result may be approximate. Returns `null` when the path cannot be
 * located — the caller falls back to line 1.
 */

export type PathSegment = string | number;

export function parseJsonPath(path: string): PathSegment[] | null {
  if (typeof path !== 'string') return null;
  let p = path.trim();
  if (p === '' || p === '$') return [];
  if (p.startsWith('$.')) p = p.slice(2);
  if (p.startsWith('.')) p = p.slice(1);

  const out: PathSegment[] = [];
  let i = 0;
  while (i < p.length) {
    const ch = p[i]!;
    if (ch === '.') {
      i++;
      continue;
    }
    if (ch === '[') {
      const close = p.indexOf(']', i);
      if (close < 0) return null;
      const inner = p.slice(i + 1, close);
      // Empty brackets (`foo[]`) are not a valid index. We reject
      // explicitly because `Number('')` is `0` — without this guard
      // an unfinished path would silently parse as element zero.
      if (inner.length === 0) return null;
      // Strict integer parse — `Number('1.5')` would yield 1.5 which
      // `Number.isInteger` already rejects, and a leading `+` /
      // whitespace would still pass `Number()` so we additionally
      // require the source text to be only digits (no `+`, no
      // exponent, no padding).
      if (!/^\d+$/.test(inner)) return null;
      const n = Number(inner);
      if (!Number.isInteger(n) || n < 0) return null;
      out.push(n);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
    out.push(p.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * Locate the 1-based line in `jsonText` corresponding to `path`. Returns
 * `null` when any segment cannot be matched.
 */
export function findJsonPathLine(
  jsonText: string,
  path: string,
): number | null {
  const segs = parseJsonPath(path);
  if (segs === null || segs.length === 0) return null;

  // `cursor` is the lookahead offset for the next segment. `lineAnchor`
  // is the offset whose line number we report — for the LAST segment we
  // want the line of the key declaration, not the line we'd advance to
  // after the colon.
  let cursor = 0;
  let lineAnchor = 0;
  for (const seg of segs) {
    if (typeof seg === 'number') {
      const arrStart = nextArrayOpen(jsonText, cursor);
      if (arrStart < 0) return null;
      const elementStart = advanceToNthElement(jsonText, arrStart + 1, seg);
      if (elementStart < 0) return null;
      cursor = elementStart;
      lineAnchor = elementStart;
    } else {
      const found = findKeyPosition(jsonText, cursor, seg);
      if (found === null) return null;
      cursor = found.afterColon;
      lineAnchor = found.keyStart;
    }
  }
  return countNewlinesUpTo(jsonText, lineAnchor) + 1;
}

// =============================================================================
// internal helpers
// =============================================================================

interface KeyMatch {
  /** Offset of the opening `"` of the key — used for line reporting. */
  keyStart: number;
  /** Offset just after the matching `:` — where the value starts (mod ws). */
  afterColon: number;
}

function findKeyPosition(
  text: string,
  from: number,
  key: string,
): KeyMatch | null {
  const pattern = new RegExp(`"${escapeRegex(key)}"\\s*:`, 'g');
  pattern.lastIndex = from;
  const m = pattern.exec(text);
  if (!m) return null;
  return { keyStart: m.index, afterColon: m.index + m[0].length };
}

/**
 * Skip whitespace (and a single trailing colon following a key) until the
 * next `[`. Returns the index of the `[` or -1 when no array opens here.
 */
function nextArrayOpen(text: string, from: number): number {
  let i = from;
  // Skip past the `:` that follows a key, if present.
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '[') return i;
    if (ch === ':' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    return -1;
  }
  return -1;
}

/**
 * Starting just after an array-open `[`, return the index of the start of
 * the `n`-th element (0-based). Tracks nesting + strings so commas inside
 * children don't fool the counter.
 */
function advanceToNthElement(text: string, start: number, n: number): number {
  let pos = start;
  if (n === 0) return skipWhitespace(text, pos);

  let depth = 0;
  let inString = false;
  let escape = false;
  let elementsPassed = 0;

  while (pos < text.length) {
    const ch = text[pos]!;
    if (escape) {
      escape = false;
      pos++;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      pos++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      pos++;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === ',' && depth === 0) {
      elementsPassed++;
      if (elementsPassed === n) {
        return skipWhitespace(text, pos + 1);
      }
    }
    pos++;
  }
  return -1;
}

function skipWhitespace(text: string, from: number): number {
  let p = from;
  while (p < text.length) {
    const ch = text[p]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') p++;
    else return p;
  }
  return p;
}

function countNewlinesUpTo(text: string, upTo: number): number {
  let count = 0;
  const limit = Math.min(upTo, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
