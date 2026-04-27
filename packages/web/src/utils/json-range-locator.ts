import { parseJsonPath, type PathSegment } from './json-locator.js';

/**
 * 1-based Monaco-style range over `jsonText`.
 *
 * Convention:
 *   - `startLineNumber` / `startColumn` are inclusive.
 *   - `endLineNumber` / `endColumn` are **exclusive** — `endColumn` points
 *     to the column immediately after the last selected character. This
 *     matches Monaco's `Range` constructor and `editor.deltaDecorations`,
 *     so callers can pass the four numbers straight through.
 */
export interface JsonTextRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * Locate the JSON value (not the key, not the colon, not the whitespace)
 * for a given JSONPath inside `jsonText`. Returns `null` when:
 *   - the path is malformed
 *   - any intermediate key / index does not exist
 *   - the value cannot be scanned (unterminated string, mismatched
 *     bracket, garbage after a literal start)
 *
 * Path syntax matches `parseJsonPath` from `json-locator.ts`, so the
 * navigator (which uses `findJsonPathLine`) and the value-range locator
 * share one grammar.
 *
 * Output is best-effort, like the rest of the JSON tooling — designed
 * for canonical pretty-printed output (`projectToPrettyJson`), tolerant
 * of common hand-edits, NOT a substitute for a real JSON parser. When
 * the scanner can't be confident, it returns `null` and the caller
 * falls back to whole-line highlighting.
 */
export function findJsonPathValueRange(
  jsonText: string,
  jsonPath: string,
): JsonTextRange | null {
  const segs = parseJsonPath(jsonPath);
  if (segs === null) return null;

  const start = locateValueStart(jsonText, segs);
  if (start < 0) return null;

  const end = findJsonValueEnd(jsonText, start);
  if (end < 0 || end <= start) return null;

  const startPos = positionToLineColumn(jsonText, start);
  const endPos = positionToLineColumn(jsonText, end);
  return {
    startLineNumber: startPos.line,
    startColumn: startPos.column,
    endLineNumber: endPos.line,
    endColumn: endPos.column,
  };
}

// =============================================================================
// Walking the path
// =============================================================================

/**
 * Walk every path segment, leaving the cursor at the first byte of the
 * target value. Returns -1 when any segment can't be matched.
 *
 * Differs from `findJsonPathLine`'s walker on string segments: that one
 * stops at the key (`"foo":`); we walk past the colon + whitespace so
 * the cursor lands at the value's first byte. On number segments the
 * shared `advanceToNthElement` helper already returns the element start
 * — same behavior as the line locator.
 */
function locateValueStart(text: string, segs: PathSegment[]): number {
  if (segs.length === 0) {
    const startWs = skipWhitespace(text, 0);
    return startWs < text.length ? startWs : -1;
  }

  let cursor = 0;
  for (const seg of segs) {
    if (typeof seg === 'number') {
      const arrStart = nextArrayOpen(text, cursor);
      if (arrStart < 0) return -1;
      const elementStart = advanceToNthElement(text, arrStart + 1, seg);
      if (elementStart < 0) return -1;
      cursor = elementStart;
    } else {
      const keyPos = findKeyPosition(text, cursor, seg);
      if (keyPos < 0) return -1;
      const colonPos = text.indexOf(':', keyPos);
      if (colonPos < 0) return -1;
      cursor = skipWhitespace(text, colonPos + 1);
    }
  }
  return cursor;
}

// =============================================================================
// Value-end scanner
// =============================================================================

/**
 * Return the index just past the last byte of the JSON value starting at
 * `start`. -1 on any scan failure (unterminated string, unbalanced
 * bracket, garbage that doesn't begin a valid JSON value).
 */
function findJsonValueEnd(text: string, start: number): number {
  if (start < 0 || start >= text.length) return -1;
  const ch = text[start];
  if (ch === '"') return scanStringEnd(text, start);
  if (ch === '{') return scanBalanced(text, start, '{', '}');
  if (ch === '[') return scanBalanced(text, start, '[', ']');
  if (text.startsWith('true', start)) return start + 4;
  if (text.startsWith('false', start)) return start + 5;
  if (text.startsWith('null', start)) return start + 4;
  if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) {
    let pos = start;
    while (pos < text.length) {
      const c = text[pos]!;
      if (
        c === '-' ||
        c === '+' ||
        c === '.' ||
        c === 'e' ||
        c === 'E' ||
        (c >= '0' && c <= '9')
      ) {
        pos++;
      } else break;
    }
    return pos > start ? pos : -1;
  }
  return -1;
}

/**
 * Scan from an opening `"` to the matching closing `"`, returning the
 * index just past the closing quote. Treats `\\` and `\"` as escape
 * sequences. -1 on unterminated input.
 */
function scanStringEnd(text: string, quotePos: number): number {
  let pos = quotePos + 1;
  while (pos < text.length) {
    const c = text[pos];
    if (c === '\\') {
      // Skip the backslash and the escaped char in one step. Even if the
      // escape sequence is malformed (e.g. `\` at the very end of the
      // string), this advances past it; the loop continues until either
      // a real closing quote or end-of-input.
      pos += 2;
      continue;
    }
    if (c === '"') return pos + 1;
    pos++;
  }
  return -1;
}

/**
 * Balanced scanner for `{...}` / `[...]` pairs, string-aware so that
 * brackets / braces inside string literals don't fool the depth count.
 * Returns the index just past the closing bracket, or -1 if the input
 * runs out before depth returns to 0.
 */
function scanBalanced(
  text: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  let pos = start;
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
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return pos + 1;
      if (depth < 0) return -1;
    }
    pos++;
  }
  return -1;
}

// =============================================================================
// Path helpers (private — see comment in `findJsonPathValueRange` for why
// these aren't shared with `json-locator.ts`).
// =============================================================================

function findKeyPosition(text: string, from: number, key: string): number {
  const pattern = new RegExp(`"${escapeRegex(key)}"\\s*:`, 'g');
  pattern.lastIndex = from;
  const m = pattern.exec(text);
  return m ? m.index : -1;
}

function nextArrayOpen(text: string, from: number): number {
  let i = from;
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
    const c = text[p];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') p++;
    else return p;
  }
  return p;
}

function positionToLineColumn(
  text: string,
  pos: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const limit = Math.min(pos, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
