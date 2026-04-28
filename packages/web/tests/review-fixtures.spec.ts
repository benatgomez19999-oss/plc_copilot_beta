// Sprint 75 — pin the canonical review fixture so structural
// regressions surface in CI rather than during a demo.

import { describe, expect, it } from 'vitest';

import {
  EMPTY_REVIEW_CANDIDATE,
  SAMPLE_REVIEW_CANDIDATE,
} from '../src/utils/review-fixtures.js';

describe('SAMPLE_REVIEW_CANDIDATE', () => {
  it('exposes 3 IO + 2 equipment + 1 assumption', () => {
    expect(SAMPLE_REVIEW_CANDIDATE.io.length).toBe(3);
    expect(SAMPLE_REVIEW_CANDIDATE.equipment.length).toBe(2);
    expect(SAMPLE_REVIEW_CANDIDATE.assumptions.length).toBe(1);
  });

  it('every IO + equipment + assumption carries at least one source ref', () => {
    for (const io of SAMPLE_REVIEW_CANDIDATE.io) {
      expect(io.sourceRefs.length).toBeGreaterThan(0);
    }
    for (const eq of SAMPLE_REVIEW_CANDIDATE.equipment) {
      expect(eq.sourceRefs.length).toBeGreaterThan(0);
    }
    for (const a of SAMPLE_REVIEW_CANDIDATE.assumptions) {
      expect(a.sourceRefs.length).toBeGreaterThan(0);
    }
  });

  it('mixes CSV and EPLAN evidence', () => {
    const kinds = new Set<string>();
    for (const io of SAMPLE_REVIEW_CANDIDATE.io) {
      for (const r of io.sourceRefs) kinds.add(r.kind);
    }
    expect(kinds.has('csv')).toBe(true);
    expect(kinds.has('eplan')).toBe(true);
  });

  it('exposes the EPLAN XML locator on at least one source ref', () => {
    const found = SAMPLE_REVIEW_CANDIDATE.io.some((io) =>
      io.sourceRefs.some(
        (r) => r.kind === 'eplan' && typeof r.symbol === 'string' && r.symbol.length > 0,
      ),
    );
    expect(found).toBe(true);
  });

  it('carries diagnostics with at least one error and at least one warning', () => {
    const sevs = SAMPLE_REVIEW_CANDIDATE.diagnostics.map((d) => d.severity);
    expect(sevs).toContain('error');
    expect(sevs).toContain('warning');
  });

  it('every assumption has confidence below the equipment-promotion threshold (< 0.6)', () => {
    for (const a of SAMPLE_REVIEW_CANDIDATE.assumptions) {
      expect(a.confidence.score).toBeLessThan(0.6);
    }
  });

  it('is frozen so consumers can rely on stable identity', () => {
    expect(Object.isFrozen(SAMPLE_REVIEW_CANDIDATE)).toBe(true);
  });
});

describe('EMPTY_REVIEW_CANDIDATE', () => {
  it('has empty arrays everywhere', () => {
    expect(EMPTY_REVIEW_CANDIDATE.io).toEqual([]);
    expect(EMPTY_REVIEW_CANDIDATE.equipment).toEqual([]);
    expect(EMPTY_REVIEW_CANDIDATE.assumptions).toEqual([]);
    expect(EMPTY_REVIEW_CANDIDATE.diagnostics).toEqual([]);
  });

  it('still has a deterministic id', () => {
    expect(EMPTY_REVIEW_CANDIDATE.id).toBe('review-fixture:empty');
  });
});
