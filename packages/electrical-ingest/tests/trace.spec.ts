// Sprint 72 — pure tests for source-traceability helpers.

import { describe, expect, it } from 'vitest';

import {
  formatSourceRef,
  mergeSourceRefs,
  sourceRefsEqual,
} from '../src/sources/trace.js';
import type { SourceRef } from '../src/types.js';

describe('formatSourceRef', () => {
  it('formats a typical EPLAN-export ref', () => {
    const ref: SourceRef = {
      sourceId: 'src-1',
      kind: 'eplan-export',
      page: '10',
      sheet: '01',
      symbol: '-K2.1',
      line: 47,
    };
    const s = formatSourceRef(ref);
    expect(s).toContain('eplan-export');
    expect(s).toContain('sheet=01');
    expect(s).toContain('page=10');
    expect(s).toContain('symbol=-K2.1');
    expect(s).toContain('line 47');
    expect(s).toContain('sourceId=src-1');
  });

  it('omits empty / undefined fields', () => {
    const ref: SourceRef = {
      sourceId: 's',
      kind: 'csv',
      path: 'terminals.csv',
    };
    const s = formatSourceRef(ref);
    expect(s).toContain('csv:terminals.csv');
    expect(s).not.toContain('line');
    expect(s).not.toContain('column');
    expect(s).not.toContain('sheet=');
  });

  it('returns a sentinel for null / undefined input', () => {
    expect(formatSourceRef(null)).toContain('no-source');
    expect(formatSourceRef(undefined)).toContain('no-source');
  });
});

describe('sourceRefsEqual', () => {
  const a: SourceRef = { sourceId: 's1', kind: 'manual' };
  const b: SourceRef = { sourceId: 's1', kind: 'manual' };
  const c: SourceRef = { sourceId: 's2', kind: 'manual' };

  it('reflexive / symmetric on identical refs', () => {
    expect(sourceRefsEqual(a, a)).toBe(true);
    expect(sourceRefsEqual(a, b)).toBe(true);
    expect(sourceRefsEqual(b, a)).toBe(true);
  });

  it('different sourceId → not equal', () => {
    expect(sourceRefsEqual(a, c)).toBe(false);
  });

  it('treats undefined-vs-missing as the same', () => {
    const x: SourceRef = { sourceId: 's', kind: 'manual', page: undefined };
    const y: SourceRef = { sourceId: 's', kind: 'manual' };
    expect(sourceRefsEqual(x, y)).toBe(true);
  });

  it('handles null safely', () => {
    expect(sourceRefsEqual(a, null)).toBe(false);
    expect(sourceRefsEqual(null, null)).toBe(true);
  });
});

describe('mergeSourceRefs', () => {
  const a: SourceRef = { sourceId: 's1', kind: 'manual' };
  const b: SourceRef = { sourceId: 's2', kind: 'csv' };
  const aClone: SourceRef = { ...a };

  it('drops structural duplicates', () => {
    expect(mergeSourceRefs([a], [aClone])).toEqual([a]);
  });

  it('preserves first-seen order', () => {
    expect(mergeSourceRefs([a], [b])).toEqual([a, b]);
    expect(mergeSourceRefs([b], [a])).toEqual([b, a]);
  });

  it('handles undefined / null lists', () => {
    expect(mergeSourceRefs(null, undefined, [a])).toEqual([a]);
  });

  it('skips non-object entries', () => {
    expect(mergeSourceRefs([a, null as any, undefined as any, b])).toEqual([a, b]);
  });
});
