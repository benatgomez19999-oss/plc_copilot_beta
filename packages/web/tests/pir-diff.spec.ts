import { describe, expect, it } from 'vitest';
import { diffPirValues } from '../src/utils/pir-diff.js';

describe('diffPirValues — equal inputs', () => {
  it('returns [] for byte-equal scalars', () => {
    expect(diffPirValues('a', 'a')).toEqual([]);
    expect(diffPirValues(7, 7)).toEqual([]);
    expect(diffPirValues(true, true)).toEqual([]);
    expect(diffPirValues(null, null)).toEqual([]);
  });

  it('returns [] for deeply-equal objects/arrays', () => {
    expect(diffPirValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });
});

describe('diffPirValues — scalar / object / array changes', () => {
  it('reports a scalar `changed` at the root path when default basePath is used', () => {
    expect(diffPirValues(1, 2)).toEqual([
      { path: '$', kind: 'changed', appliedValue: 1, draftValue: 2 },
    ]);
  });

  it('reports a single `changed` for a top-level scalar field', () => {
    expect(diffPirValues({ name: 'a' }, { name: 'b' })).toEqual([
      {
        path: '$.name',
        kind: 'changed',
        appliedValue: 'a',
        draftValue: 'b',
      },
    ]);
  });

  it('recurses into nested objects', () => {
    const out = diffPirValues(
      { outer: { inner: 'x' } },
      { outer: { inner: 'y' } },
    );
    expect(out).toEqual([
      {
        path: '$.outer.inner',
        kind: 'changed',
        appliedValue: 'x',
        draftValue: 'y',
      },
    ]);
  });

  it('recurses into arrays by index', () => {
    const out = diffPirValues({ a: [1, 2, 3] }, { a: [1, 5, 3] });
    expect(out).toEqual([
      {
        path: '$.a[1]',
        kind: 'changed',
        appliedValue: 2,
        draftValue: 5,
      },
    ]);
  });
});

describe('diffPirValues — added / removed', () => {
  it('reports an `added` property with the draft value', () => {
    const out = diffPirValues({ a: 1 }, { a: 1, b: 'new' });
    expect(out).toEqual([
      { path: '$.b', kind: 'added', draftValue: 'new' },
    ]);
  });

  it('reports a `removed` property with the applied value', () => {
    const out = diffPirValues({ a: 1, b: 'old' }, { a: 1 });
    expect(out).toEqual([
      { path: '$.b', kind: 'removed', appliedValue: 'old' },
    ]);
  });

  it('reports an added array element WITHOUT recursing into its subtree', () => {
    const out = diffPirValues(
      { xs: [1] },
      { xs: [1, { deep: { inside: true } }] },
    );
    expect(out).toEqual([
      {
        path: '$.xs[1]',
        kind: 'added',
        draftValue: { deep: { inside: true } },
      },
    ]);
  });

  it('reports a removed array element with the original subtree', () => {
    const out = diffPirValues(
      { xs: [1, { gone: true }] },
      { xs: [1] },
    );
    expect(out).toEqual([
      {
        path: '$.xs[1]',
        kind: 'removed',
        appliedValue: { gone: true },
      },
    ]);
  });
});

describe('diffPirValues — type mismatch', () => {
  it('treats null vs object as a single `changed` entry (no recursion)', () => {
    const out = diffPirValues({ a: null }, { a: { x: 1 } });
    expect(out).toEqual([
      {
        path: '$.a',
        kind: 'changed',
        appliedValue: null,
        draftValue: { x: 1 },
      },
    ]);
  });

  it('treats array vs object as a single `changed` entry', () => {
    const out = diffPirValues({ a: [1, 2] }, { a: { 0: 1, 1: 2 } });
    expect(out).toEqual([
      {
        path: '$.a',
        kind: 'changed',
        appliedValue: [1, 2],
        draftValue: { 0: 1, 1: 2 },
      },
    ]);
  });
});

describe('diffPirValues — determinism', () => {
  it('walks object keys in alphabetical order regardless of input order', () => {
    const a = { z: 1, a: 1, m: 1 };
    const b = { z: 2, a: 2, m: 2 };
    expect(diffPirValues(a, b).map((d) => d.path)).toEqual([
      '$.a',
      '$.m',
      '$.z',
    ]);
    // And again with the keys in a different insertion order — same output.
    const aRev = { m: 1, a: 1, z: 1 };
    const bRev = { m: 2, a: 2, z: 2 };
    expect(diffPirValues(aRev, bRev).map((d) => d.path)).toEqual([
      '$.a',
      '$.m',
      '$.z',
    ]);
  });

  it('emits identical output for two calls with identical inputs', () => {
    const a = { name: 'x', items: [1, 2] };
    const b = { name: 'y', items: [1, 3] };
    expect(diffPirValues(a, b)).toEqual(diffPirValues(a, b));
  });
});

describe('diffPirValues — basePath override', () => {
  it('threads a custom basePath into the produced paths', () => {
    expect(diffPirValues({ name: 'a' }, { name: 'b' }, '$.machines[0]')).toEqual(
      [
        {
          path: '$.machines[0].name',
          kind: 'changed',
          appliedValue: 'a',
          draftValue: 'b',
        },
      ],
    );
  });
});
