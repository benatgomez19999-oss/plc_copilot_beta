import { describe, expect, it } from 'vitest';
import {
  findJsonPathValueRange,
  type JsonTextRange,
} from '../src/utils/json-range-locator.js';

/**
 * Slice the substring corresponding to a `JsonTextRange` straight out of
 * `text`. Lets every assertion talk about *what was highlighted* rather
 * than fiddling with raw line/column numbers — readable AND a lossless
 * encoding of the four corners.
 */
function slice(text: string, r: JsonTextRange): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let l = r.startLineNumber; l <= r.endLineNumber; l++) {
    const line = lines[l - 1] ?? '';
    const startCol = l === r.startLineNumber ? r.startColumn : 1;
    // endColumn is exclusive (Monaco convention).
    const endCol = l === r.endLineNumber ? r.endColumn : line.length + 1;
    out.push(line.slice(startCol - 1, endCol - 1));
  }
  return out.join('\n');
}

const SIMPLE = `{
  "name": "Demo",
  "enabled": true,
  "count": 42,
  "ratio": -1.5e3,
  "missing": null,
  "machines": [
    {
      "id": "m01"
    },
    {
      "id": "m02",
      "stations": ["alpha", "beta"]
    }
  ]
}
`;

// =============================================================================
// Happy paths — scalar values
// =============================================================================

describe('findJsonPathValueRange — scalar values', () => {
  it('1. root "$" covers the entire object including braces', () => {
    const r = findJsonPathValueRange(SIMPLE, '$');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toMatch(/^\{[\s\S]*\}$/);
    expect(r!.startLineNumber).toBe(1);
    expect(r!.startColumn).toBe(1);
  });

  it('2. string property covers the quoted value (quotes included)', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.name');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('"Demo"');
  });

  it('3. number property covers just the number tokens', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.count');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('42');
  });

  it('3b. signed exponent number covers -1.5e3 entirely', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.ratio');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('-1.5e3');
  });

  it('4. boolean property covers `true`', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.enabled');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('true');
  });

  it('5. null property covers `null`', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.missing');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('null');
  });
});

// =============================================================================
// Nested objects + array elements
// =============================================================================

describe('findJsonPathValueRange — nested structures', () => {
  it('6. nested object property covers the value inside a sub-object', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.machines[0].id');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('"m01"');
  });

  it('7. array primitive element covers just that element', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.machines[1].stations[0]');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('"alpha"');
  });

  it('7b. second array element', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.machines[1].stations[1]');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('"beta"');
  });

  it('8. array object element covers the balanced braces of that object', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.machines[0]');
    expect(r).not.toBeNull();
    const s = slice(SIMPLE, r!);
    expect(s.startsWith('{')).toBe(true);
    expect(s.endsWith('}')).toBe(true);
    expect(s).toContain('"id": "m01"');
  });

  it('10. object value covers balanced braces (nested object case)', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.machines[1]');
    expect(r).not.toBeNull();
    const s = slice(SIMPLE, r!);
    // Must include both inner keys and a balanced closing brace.
    expect(s).toContain('"id": "m02"');
    expect(s).toContain('"stations": ["alpha", "beta"]');
    expect(s.endsWith('}')).toBe(true);
  });

  it('11. array value covers balanced brackets', () => {
    const r = findJsonPathValueRange(SIMPLE, '$.machines[1].stations');
    expect(r).not.toBeNull();
    expect(slice(SIMPLE, r!)).toBe('["alpha", "beta"]');
  });
});

// =============================================================================
// Escapes
// =============================================================================

describe('findJsonPathValueRange — string escapes', () => {
  it('9. string with escaped quote is matched in full (closing quote is unescaped)', () => {
    const json = `{\n  "msg": "He said \\"hi\\""\n}\n`;
    const r = findJsonPathValueRange(json, '$.msg');
    expect(r).not.toBeNull();
    expect(slice(json, r!)).toBe('"He said \\"hi\\""');
  });

  it('9b. string with escaped backslash terminates at the right `"`', () => {
    const json = `{\n  "p": "a\\\\",\n  "q": "after"\n}\n`;
    const r = findJsonPathValueRange(json, '$.p');
    expect(r).not.toBeNull();
    expect(slice(json, r!)).toBe('"a\\\\"');
    // The next field must still be locatable — proves we didn't run
    // past `"a\\"` and consume the `,` / next key.
    const r2 = findJsonPathValueRange(json, '$.q');
    expect(slice(json, r2!)).toBe('"after"');
  });
});

// =============================================================================
// Failure modes
// =============================================================================

describe('findJsonPathValueRange — failure modes', () => {
  it('12. missing path returns null', () => {
    expect(findJsonPathValueRange(SIMPLE, '$.does_not_exist')).toBeNull();
  });

  it('13. out-of-range array index returns null', () => {
    expect(findJsonPathValueRange(SIMPLE, '$.machines[99]')).toBeNull();
  });

  it('14. malformed path returns null', () => {
    expect(findJsonPathValueRange(SIMPLE, 'foo[abc]')).toBeNull();
    expect(findJsonPathValueRange(SIMPLE, 'foo[')).toBeNull();
  });

  it('15. malformed JSON-ish text returns null without throwing', () => {
    expect(() =>
      findJsonPathValueRange('not json at all', '$.foo'),
    ).not.toThrow();
    expect(findJsonPathValueRange('not json at all', '$.foo')).toBeNull();
  });

  it('15b. unterminated string returns null for the affected key', () => {
    const broken = `{\n  "name": "no closing quote\n}\n`;
    // The opening quote starts a string that never ends — scanner returns -1.
    expect(findJsonPathValueRange(broken, '$.name')).toBeNull();
  });

  it('15c. unterminated brace returns null for the root', () => {
    expect(findJsonPathValueRange('{', '$')).toBeNull();
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('findJsonPathValueRange — determinism', () => {
  it('16. repeated calls with identical inputs produce identical ranges', () => {
    const a = findJsonPathValueRange(SIMPLE, '$.machines[1].stations[1]');
    const b = findJsonPathValueRange(SIMPLE, '$.machines[1].stations[1]');
    expect(a).toEqual(b);
  });

  it('16b. ranges round-trip via the slice helper', () => {
    // For every scalar example we know what the slice should be.
    const cases: Array<[string, string]> = [
      ['$.name', '"Demo"'],
      ['$.count', '42'],
      ['$.enabled', 'true'],
      ['$.missing', 'null'],
      ['$.machines[0].id', '"m01"'],
      ['$.machines[1].stations[1]', '"beta"'],
    ];
    for (const [path, expected] of cases) {
      const r = findJsonPathValueRange(SIMPLE, path);
      expect(r, `path ${path}`).not.toBeNull();
      expect(slice(SIMPLE, r!), `path ${path}`).toBe(expected);
    }
  });
});
