// Sprint 74 — minimal XML utilities for the EPLAN structured-export
// ingestor. Pure / Node-built-ins-only. Hand-rolled because the
// monorepo policy is "no new runtime dependencies for ingestion" and
// real EPLAN exports are well-formed XML that doesn't need a full
// W3C DOM.
//
// Scope (deliberate):
//   - Parse element trees: open / close / self-closing tags + text
//     content + attribute lists.
//   - Skip XML declarations (`<?xml ... ?>`), comments
//     (`<!-- ... -->`), processing instructions (`<? ... ?>`),
//     and `<!DOCTYPE ...>`.
//   - Decode the canonical entities `&lt; &gt; &amp; &quot; &apos;`
//     and decimal/hex numeric character references.
//   - Track 1-based line/column for source-ref construction.
//   - NEVER throw. Malformed input emits a structured error instead.
//
// Out of scope:
//   - XML namespaces (we accept `<ns:tag>` syntactically, but treat
//     the prefix as part of the tag name).
//   - DTD / external entity resolution.
//   - Mixed-content semantics (text nodes between children are
//     captured but rarely meaningful for EPLAN exports).

export interface XmlAttribute {
  name: string;
  value: string;
}

export interface XmlElement {
  /** Tag name as it appears in the source (not lowercased). */
  tag: string;
  /** Lowercased tag, for case-insensitive lookups. */
  tagLower: string;
  /** Attribute list, in source order. */
  attrs: ReadonlyArray<XmlAttribute>;
  /** Lowercased attribute name → string value (last-wins on duplicates). */
  attrMap: ReadonlyMap<string, string>;
  /** Direct child elements (text nodes are dropped — see `text` below). */
  children: ReadonlyArray<XmlElement>;
  /** Concatenated text content of this element (children's text excluded). */
  text: string;
  /** 1-based line of the opening tag. */
  line: number;
  /** 1-based column of the opening tag. */
  column: number;
  /** Slash-separated locator from the document root, e.g. `/EplanProject/Pages/Page[1]/Element[2]`. */
  locator: string;
}

export interface XmlParseError {
  message: string;
  line: number;
  column: number;
}

export interface XmlParseResult {
  /** Document root element (null on a parse error). */
  root: XmlElement | null;
  errors: XmlParseError[];
}

/**
 * Parse an XML string into a minimal element tree. Pure. Returns
 * `{ root: null, errors: [...] }` if the input is empty or
 * malformed past recovery; otherwise `{ root, errors: [] }` (or
 * non-empty errors if recovery was possible — strict callers can
 * still treat any error as a parse failure).
 */
export function parseXml(text: string): XmlParseResult {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      root: null,
      errors: [{ message: 'XML input was empty.', line: 1, column: 1 }],
    };
  }

  const errors: XmlParseError[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  function advance(n: number): void {
    for (let k = 0; k < n && i < text.length; k++) {
      if (text.charCodeAt(i) === 10) {
        line++;
        column = 1;
      } else if (text.charCodeAt(i) === 13) {
        line++;
        column = 1;
        if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
          // CRLF — consume \n on the next iteration without bumping line again.
          i++;
        }
      } else {
        column++;
      }
      i++;
    }
  }

  function peek(s: string): boolean {
    return text.startsWith(s, i);
  }

  function skipWhitespace(): void {
    while (i < text.length) {
      const ch = text.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) advance(1);
      else break;
    }
  }

  function recordError(message: string): void {
    errors.push({ message, line, column });
  }

  // Skip prolog: declarations, doctypes, comments, processing instructions,
  // and any leading whitespace.
  function skipProlog(): void {
    for (;;) {
      skipWhitespace();
      if (peek('<?')) {
        const close = text.indexOf('?>', i);
        if (close === -1) {
          recordError('unterminated processing instruction.');
          i = text.length;
          return;
        }
        advance(close + 2 - i);
      } else if (peek('<!--')) {
        const close = text.indexOf('-->', i);
        if (close === -1) {
          recordError('unterminated comment.');
          i = text.length;
          return;
        }
        advance(close + 3 - i);
      } else if (peek('<!DOCTYPE')) {
        // Skip until matching `>` at depth 0 (DOCTYPE may have inner `[ ... ]`).
        let depth = 0;
        while (i < text.length) {
          if (text.charAt(i) === '[') depth++;
          else if (text.charAt(i) === ']') depth--;
          else if (text.charAt(i) === '>' && depth === 0) {
            advance(1);
            return;
          }
          advance(1);
        }
        recordError('unterminated DOCTYPE.');
        return;
      } else {
        return;
      }
    }
  }

  function parseAttributes(end: number): {
    attrs: XmlAttribute[];
    selfClosing: boolean;
    consumed: number;
  } {
    // We have already consumed the opening `<` and the tag name; on
    // entry, `i` points just past the tag name. The caller provides
    // `end`, the index of the closing `>` of the start tag.
    const attrs: XmlAttribute[] = [];
    let selfClosing = false;
    while (i < end) {
      const ch = text.charAt(i);
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        advance(1);
        continue;
      }
      if (ch === '/' && i + 1 <= end && text.charAt(i + 1) === '>') {
        selfClosing = true;
        advance(1);
        break;
      }
      // attribute name
      let nameStart = i;
      while (i < end) {
        const c = text.charAt(i);
        if (c === '=' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/' || c === '>') break;
        advance(1);
      }
      const name = text.slice(nameStart, i);
      if (name.length === 0) {
        // Avoid infinite loop on unexpected input.
        advance(1);
        continue;
      }
      // optional whitespace then `=`
      while (i < end && /\s/.test(text.charAt(i))) advance(1);
      if (text.charAt(i) === '=') {
        advance(1);
        while (i < end && /\s/.test(text.charAt(i))) advance(1);
        const quote = text.charAt(i);
        if (quote === '"' || quote === "'") {
          advance(1);
          const valStart = i;
          while (i < end && text.charAt(i) !== quote) advance(1);
          const value = decodeEntities(text.slice(valStart, i));
          if (text.charAt(i) === quote) advance(1);
          attrs.push({ name, value });
        } else {
          // Unquoted attribute value — accept up to next whitespace
          // or `>`. Real EPLAN exports always quote, but accept it.
          const valStart = i;
          while (i < end && !/[\s/>]/.test(text.charAt(i))) advance(1);
          const value = decodeEntities(text.slice(valStart, i));
          attrs.push({ name, value });
        }
      } else {
        // Boolean-style attribute (no value) — treat as empty string.
        attrs.push({ name, value: '' });
      }
    }
    return { attrs, selfClosing, consumed: end - i };
  }

  // The actual recursive-descent. We capture the *opening tag*
  // location on `<` so source refs point at the start of the tag.
  function parseElement(parentLocator: string, siblingIndexes: Map<string, number>): XmlElement | null {
    if (text.charAt(i) !== '<') {
      recordError('expected element start.');
      return null;
    }
    const tagStartLine = line;
    const tagStartColumn = column;
    advance(1); // `<`
    const nameStart = i;
    while (i < text.length) {
      const c = text.charAt(i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/' || c === '>') break;
      advance(1);
    }
    const tagName = text.slice(nameStart, i);
    if (tagName.length === 0) {
      recordError('empty element name.');
      // skip to next `>` to recover
      const close = text.indexOf('>', i);
      if (close === -1) {
        i = text.length;
      } else {
        advance(close + 1 - i);
      }
      return null;
    }

    // Find the `>` that closes the start tag.
    let scan = i;
    while (scan < text.length) {
      const c = text.charAt(scan);
      if (c === '>') break;
      if (c === '"' || c === "'") {
        // Skip quoted attribute value to avoid stopping at `>` inside it.
        const matchEnd = text.indexOf(c, scan + 1);
        if (matchEnd === -1) {
          scan = text.length;
          break;
        }
        scan = matchEnd + 1;
      } else {
        scan++;
      }
    }
    if (scan >= text.length) {
      recordError(`unterminated start tag <${tagName}>.`);
      i = text.length;
      return null;
    }
    const startTagEnd = scan; // index of the `>` of the start tag
    const { attrs, selfClosing } = parseAttributes(startTagEnd);
    advance(startTagEnd + 1 - i); // consume the `>`

    // Build locator.
    const seen = (siblingIndexes.get(tagName) ?? 0) + 1;
    siblingIndexes.set(tagName, seen);
    const locator = `${parentLocator}/${tagName}[${seen}]`;

    const attrMap = new Map<string, string>();
    for (const a of attrs) attrMap.set(a.name.toLowerCase(), a.value);

    const element: XmlElement = {
      tag: tagName,
      tagLower: tagName.toLowerCase(),
      attrs,
      attrMap,
      children: [],
      text: '',
      line: tagStartLine,
      column: tagStartColumn,
      locator,
    };
    if (selfClosing) return element;

    // Parse body until matching close tag.
    const childSiblings = new Map<string, number>();
    let textBuffer = '';
    while (i < text.length) {
      if (peek('<!--')) {
        const close = text.indexOf('-->', i);
        if (close === -1) {
          recordError('unterminated comment.');
          i = text.length;
          break;
        }
        advance(close + 3 - i);
        continue;
      }
      if (peek('<![CDATA[')) {
        const close = text.indexOf(']]>', i + 9);
        if (close === -1) {
          recordError('unterminated CDATA.');
          i = text.length;
          break;
        }
        textBuffer += text.slice(i + 9, close);
        advance(close + 3 - i);
        continue;
      }
      if (peek('</')) {
        // Close tag — read name, ensure it matches, consume `>`, return.
        advance(2);
        const closeNameStart = i;
        while (i < text.length && text.charAt(i) !== '>' && !/\s/.test(text.charAt(i))) {
          advance(1);
        }
        const closeName = text.slice(closeNameStart, i);
        while (i < text.length && text.charAt(i) !== '>') advance(1);
        if (text.charAt(i) === '>') advance(1);
        if (closeName !== tagName) {
          recordError(`mismatched close tag </${closeName}> (expected </${tagName}>).`);
        }
        // Mutate the element with collected children/text.
        (element.children as XmlElement[]) = element.children as XmlElement[]; // already correct shape
        element.text = decodeEntities(textBuffer);
        return element;
      }
      if (peek('<')) {
        const child = parseElement(locator, childSiblings);
        if (child) (element.children as XmlElement[]).push(child);
        continue;
      }
      // Text content character.
      textBuffer += text.charAt(i);
      advance(1);
    }

    recordError(`unterminated element <${tagName}>.`);
    element.text = decodeEntities(textBuffer);
    return element;
  }

  skipProlog();
  if (i >= text.length || text.charAt(i) !== '<') {
    errors.push({ message: 'no root element found.', line, column });
    return { root: null, errors };
  }
  // Mutable arrays in element bodies → cast via inner state. To
  // keep TS happy we initialise children on the element; the
  // recursive helper pushes into it.
  const rootElement = parseElement('', new Map());
  if (!rootElement) {
    return { root: null, errors };
  }
  // Skip trailing whitespace / comments — surface them as errors only
  // if there's any non-whitespace, non-comment content past root.
  while (i < text.length) {
    if (peek('<!--')) {
      const close = text.indexOf('-->', i);
      if (close === -1) break;
      advance(close + 3 - i);
      continue;
    }
    if (peek('<?')) {
      const close = text.indexOf('?>', i);
      if (close === -1) break;
      advance(close + 2 - i);
      continue;
    }
    const ch = text.charAt(i);
    if (/\s/.test(ch)) {
      advance(1);
      continue;
    }
    errors.push({
      message: `unexpected content past root: ${JSON.stringify(text.slice(i, i + 16))}`,
      line,
      column,
    });
    break;
  }
  return { root: rootElement, errors };
}

const ENTITY_MAP: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/**
 * Decode the canonical XML entities + numeric character references.
 * Unknown entities are left literal — XML decoders are usually
 * fault-tolerant about user-defined entities.
 */
export function decodeEntities(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = ENTITY_MAP[body];
    return named !== undefined ? named : match;
  });
}

/**
 * Walk an element tree depth-first, including the root. Helper for
 * extractors that need to find every element with a given tag.
 */
export function* walkElements(
  root: XmlElement,
): IterableIterator<XmlElement> {
  yield root;
  for (const child of root.children) {
    yield* walkElements(child);
  }
}

/**
 * Find the first descendant (or self) whose lowercased tag matches.
 */
export function findElement(
  root: XmlElement,
  tagLower: string,
): XmlElement | null {
  for (const el of walkElements(root)) {
    if (el.tagLower === tagLower) return el;
  }
  return null;
}

/**
 * Find every descendant (or self) whose lowercased tag matches.
 */
export function findAllElements(
  root: XmlElement,
  tagLower: string,
): XmlElement[] {
  const out: XmlElement[] = [];
  for (const el of walkElements(root)) {
    if (el.tagLower === tagLower) out.push(el);
  }
  return out;
}

/**
 * Read an attribute, falling back across alternative names. Returns
 * `null` if none match. Case-insensitive on attribute names.
 */
export function getAttribute(
  el: XmlElement,
  ...names: ReadonlyArray<string>
): string | null {
  for (const n of names) {
    const v = el.attrMap.get(n.toLowerCase());
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Find the first child element by tag (case-insensitive); returns
 * its text content or `null`.
 */
export function getChildText(
  el: XmlElement,
  tagLower: string,
): string | null {
  for (const c of el.children) {
    if (c.tagLower === tagLower) {
      const t = c.text.trim();
      return t.length > 0 ? t : null;
    }
  }
  return null;
}
