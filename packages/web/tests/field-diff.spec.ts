import { describe, expect, it } from 'vitest';
import { getFieldDiff } from '../src/utils/field-diff.js';
import type { PirDiffEntry } from '../src/utils/pir-diff.js';

const SAMPLE: PirDiffEntry[] = [
  {
    path: '$.machines[0].name',
    kind: 'changed',
    appliedValue: 'Old',
    draftValue: 'New',
  },
  {
    path: '$.machines[0].description',
    kind: 'added',
    draftValue: 'Just added',
  },
  {
    path: '$.machines[0].stations[1].equipment[0].code_symbol',
    kind: 'removed',
    appliedValue: 'OldSym',
  },
];

describe('getFieldDiff — exact-path lookup', () => {
  it('returns changed:true with both values for a `changed` entry', () => {
    expect(getFieldDiff(SAMPLE, '$.machines[0].name')).toEqual({
      changed: true,
      kind: 'changed',
      appliedValue: 'Old',
      draftValue: 'New',
    });
  });

  it('returns changed:true with only draftValue for an `added` entry', () => {
    expect(getFieldDiff(SAMPLE, '$.machines[0].description')).toEqual({
      changed: true,
      kind: 'added',
      appliedValue: undefined,
      draftValue: 'Just added',
    });
  });

  it('returns changed:true with only appliedValue for a `removed` entry', () => {
    expect(
      getFieldDiff(
        SAMPLE,
        '$.machines[0].stations[1].equipment[0].code_symbol',
      ),
    ).toEqual({
      changed: true,
      kind: 'removed',
      appliedValue: 'OldSym',
      draftValue: undefined,
    });
  });

  it('returns changed:false when no entry matches the path', () => {
    expect(getFieldDiff(SAMPLE, '$.machines[0].stations[0].name')).toEqual({
      changed: false,
    });
  });

  it('returns changed:false on undefined / empty diff lists', () => {
    expect(getFieldDiff(undefined, '$.name')).toEqual({ changed: false });
    expect(getFieldDiff([], '$.name')).toEqual({ changed: false });
  });

  it('exact-matches: a substring of a known path does NOT match', () => {
    // The sample has `$.machines[0].name`; a parent-prefix lookup
    // should not surface that entry.
    expect(getFieldDiff(SAMPLE, '$.machines[0]')).toEqual({ changed: false });
  });
});
