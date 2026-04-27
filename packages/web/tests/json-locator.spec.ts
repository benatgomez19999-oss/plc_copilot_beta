import { describe, expect, it } from 'vitest';
import {
  findJsonPathLine,
  parseJsonPath,
} from '../src/utils/json-locator.js';

describe('parseJsonPath', () => {
  it('returns [] for empty / `$`', () => {
    expect(parseJsonPath('')).toEqual([]);
    expect(parseJsonPath('$')).toEqual([]);
  });

  it('strips leading `$.` or `.`', () => {
    expect(parseJsonPath('$.foo')).toEqual(['foo']);
    expect(parseJsonPath('.foo')).toEqual(['foo']);
    expect(parseJsonPath('foo')).toEqual(['foo']);
  });

  it('parses dotted keys', () => {
    expect(parseJsonPath('foo.bar.baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('parses array indices as numbers', () => {
    expect(parseJsonPath('foo[0]')).toEqual(['foo', 0]);
    expect(parseJsonPath('foo[12]')).toEqual(['foo', 12]);
  });

  it('parses mixed paths', () => {
    expect(parseJsonPath('machines[0].stations[1].id')).toEqual([
      'machines',
      0,
      'stations',
      1,
      'id',
    ]);
  });

  it('returns null on malformed bracket', () => {
    expect(parseJsonPath('foo[')).toBeNull();
    expect(parseJsonPath('foo[abc]')).toBeNull();
    expect(parseJsonPath('foo[-1]')).toBeNull();
  });

  it('returns null on empty / non-strict brackets (sprint 36)', () => {
    // Empty brackets used to slip through because `Number('') === 0`.
    expect(parseJsonPath('foo[]')).toBeNull();
    // Whitespace-only must also fail.
    expect(parseJsonPath('foo[ ]')).toBeNull();
    // No leading `+`, no decimals, no exponent inside [].
    expect(parseJsonPath('foo[+1]')).toBeNull();
    expect(parseJsonPath('foo[1.0]')).toBeNull();
    expect(parseJsonPath('foo[1e2]')).toBeNull();
  });

  it('does not confuse stations[1] with stations[10]', () => {
    // Substring-trap guard: indices are parsed structurally, not by
    // textual prefix, so the first element of a 10+-element array
    // never gets pulled in for the 1-th element lookup.
    const a = parseJsonPath('stations[1]');
    const b = parseJsonPath('stations[10]');
    expect(a).toEqual(['stations', 1]);
    expect(b).toEqual(['stations', 10]);
    expect(a).not.toEqual(b);
  });
});

// =============================================================================
// findJsonPathLine — exercised on canonical 2-space pretty-printed JSON, the
// shape `projectToPrettyJson` produces.
// =============================================================================

const SIMPLE = `{
  "id": "prj_x",
  "name": "Test"
}
`;

const NESTED = `{
  "outer": {
    "inner": {
      "leaf": "v"
    }
  }
}
`;

const ARRAY_OF_PRIMITIVES = `{
  "arr": [
    "x",
    "y",
    "z"
  ]
}
`;

const ARRAY_OF_OBJECTS = `{
  "machines": [
    {
      "stations": [
        { "id": "st_a" },
        { "id": "st_b" }
      ]
    }
  ]
}
`;

describe('findJsonPathLine — root-level keys', () => {
  it('finds a top-level key', () => {
    expect(findJsonPathLine(SIMPLE, 'id')).toBe(2);
    expect(findJsonPathLine(SIMPLE, 'name')).toBe(3);
  });

  it('returns null for missing key', () => {
    expect(findJsonPathLine(SIMPLE, 'absent')).toBeNull();
  });

  it('returns null for empty path / `$`', () => {
    expect(findJsonPathLine(SIMPLE, '')).toBeNull();
    expect(findJsonPathLine(SIMPLE, '$')).toBeNull();
  });
});

describe('findJsonPathLine — nested objects', () => {
  it('finds a deeply-nested key', () => {
    expect(findJsonPathLine(NESTED, 'outer.inner.leaf')).toBe(4);
  });

  it('finds an intermediate object key', () => {
    expect(findJsonPathLine(NESTED, 'outer.inner')).toBe(3);
  });
});

describe('findJsonPathLine — arrays', () => {
  it('finds an indexed primitive in a top-level array', () => {
    expect(findJsonPathLine(ARRAY_OF_PRIMITIVES, 'arr[0]')).toBe(3);
    expect(findJsonPathLine(ARRAY_OF_PRIMITIVES, 'arr[1]')).toBe(4);
    expect(findJsonPathLine(ARRAY_OF_PRIMITIVES, 'arr[2]')).toBe(5);
  });

  it('finds a nested key inside an array element', () => {
    // Both objects are inline on lines 5 and 6 of ARRAY_OF_OBJECTS
    expect(
      findJsonPathLine(ARRAY_OF_OBJECTS, 'machines[0].stations[0].id'),
    ).toBe(5);
    expect(
      findJsonPathLine(ARRAY_OF_OBJECTS, 'machines[0].stations[1].id'),
    ).toBe(6);
  });

  it('returns null when array index is out of range', () => {
    expect(findJsonPathLine(ARRAY_OF_PRIMITIVES, 'arr[5]')).toBeNull();
  });

  it('returns null when array does not exist', () => {
    expect(findJsonPathLine(SIMPLE, 'arr[0]')).toBeNull();
  });
});

describe('findJsonPathLine — `$` prefix tolerance', () => {
  it('treats `$.foo` and `foo` identically', () => {
    expect(findJsonPathLine(SIMPLE, '$.id')).toBe(
      findJsonPathLine(SIMPLE, 'id'),
    );
  });
});
