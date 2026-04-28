// Sprint 72 — pure tests for confidence helpers.

import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_ONE,
  CONFIDENCE_ZERO,
  clampConfidence,
  combineConfidence,
  confidenceFromEvidence,
  confidenceOf,
  minConfidence,
} from '../src/confidence.js';

describe('clampConfidence', () => {
  it('clamps to [0, 1]', () => {
    expect(clampConfidence(-0.1)).toBe(0);
    expect(clampConfidence(1.5)).toBe(1);
    expect(clampConfidence(0.5)).toBe(0.5);
  });

  it('returns 0 for non-numeric / NaN / Infinity', () => {
    expect(clampConfidence('bad' as any)).toBe(0);
    expect(clampConfidence(NaN)).toBe(0);
    expect(clampConfidence(Infinity)).toBe(0);
    expect(clampConfidence(-Infinity)).toBe(0);
  });
});

describe('confidenceFromEvidence', () => {
  it('empty array yields score 0 with no reasons', () => {
    expect(confidenceFromEvidence([])).toEqual({ score: 0, reasons: [] });
  });

  it('single supporting evidence yields its (clamped) score', () => {
    const c = confidenceFromEvidence([
      { source: 'addr', score: 0.8, reason: 'matched' },
    ]);
    expect(c.score).toBeCloseTo(0.8, 5);
    expect(c.reasons).toEqual(['addr: matched']);
  });

  it('combines multiple supporting evidences via complement-product', () => {
    // 1 - (1-0.5)(1-0.5) = 0.75
    const c = confidenceFromEvidence([
      { source: 's1', score: 0.5, reason: 'a' },
      { source: 's2', score: 0.5, reason: 'b' },
    ]);
    expect(c.score).toBeCloseTo(0.75, 5);
  });

  it('conflicting evidence (negative weight) lowers the score', () => {
    const supportOnly = confidenceFromEvidence([
      { source: 's1', score: 0.8, reason: 'a' },
    ]).score;
    const withConflict = confidenceFromEvidence([
      { source: 's1', score: 0.8, reason: 'a' },
      { source: 's2', score: 0.5, reason: 'conflict', weight: -1 },
    ]).score;
    expect(withConflict).toBeLessThan(supportOnly);
  });

  it('reasons are deduplicated and deterministically sorted', () => {
    const c = confidenceFromEvidence([
      { source: 's2', score: 0.5, reason: 'b' },
      { source: 's1', score: 0.5, reason: 'a' },
      { source: 's1', score: 0.5, reason: 'a' }, // duplicate
    ]);
    expect(c.reasons).toEqual(['s1: a', 's2: b']);
  });

  it('clamps individual scores before combining', () => {
    const c = confidenceFromEvidence([
      { source: 's', score: 5, reason: 'overshoot' },
    ]);
    expect(c.score).toBe(1);
  });
});

describe('combineConfidence', () => {
  it('empty list is score 0', () => {
    expect(combineConfidence([])).toEqual({ score: 0, reasons: [] });
  });

  it('combines existing Confidence values like complement-product', () => {
    const a = confidenceOf(0.5, 'a');
    const b = confidenceOf(0.5, 'b');
    const c = combineConfidence([a, b]);
    expect(c.score).toBeCloseTo(0.75, 5);
    expect(c.reasons).toEqual(['a', 'b']);
  });

  it('single full-confidence value stays at 1', () => {
    expect(combineConfidence([CONFIDENCE_ONE]).score).toBe(1);
  });

  it('all zeros stays at 0', () => {
    expect(combineConfidence([CONFIDENCE_ZERO, CONFIDENCE_ZERO]).score).toBe(0);
  });
});

describe('minConfidence', () => {
  it('returns the lowest score', () => {
    const c = minConfidence([
      confidenceOf(0.9, 'a'),
      confidenceOf(0.4, 'b'),
      confidenceOf(0.7, 'c'),
    ]);
    expect(c.score).toBe(0.4);
  });

  it('preserves and dedupes reasons', () => {
    const c = minConfidence([
      confidenceOf(0.5, 'a'),
      confidenceOf(0.6, 'a'),
      confidenceOf(0.7, 'b'),
    ]);
    expect(c.reasons.sort()).toEqual(['a', 'b']);
  });

  it('empty list yields score 0', () => {
    expect(minConfidence([]).score).toBe(0);
  });
});

describe('confidenceOf', () => {
  it('builds a single-reason Confidence with clamped score', () => {
    expect(confidenceOf(2, 'r')).toEqual({ score: 1, reasons: ['r'] });
    expect(confidenceOf(-1, '')).toEqual({ score: 0, reasons: [] });
  });
});
