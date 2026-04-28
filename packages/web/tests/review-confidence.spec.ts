// Sprint 75 — pure tests for the confidence classification
// helper. Stable thresholds; no React.

import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_HIGH_THRESHOLD,
  CONFIDENCE_MEDIUM_THRESHOLD,
  classifyConfidence,
  readConfidenceScore,
} from '../src/utils/review-confidence.js';

describe('classifyConfidence — thresholds', () => {
  it('exposes the two thresholds at 0.8 / 0.6', () => {
    expect(CONFIDENCE_HIGH_THRESHOLD).toBe(0.8);
    expect(CONFIDENCE_MEDIUM_THRESHOLD).toBe(0.6);
  });

  it('classifies >= 0.8 as high', () => {
    expect(classifyConfidence(0.8).level).toBe('high');
    expect(classifyConfidence(0.9).level).toBe('high');
    expect(classifyConfidence(1).level).toBe('high');
    // Boundary equality must be high, not medium.
    expect(classifyConfidence(0.8).label.startsWith('High')).toBe(true);
  });

  it('classifies [0.6, 0.8) as medium', () => {
    expect(classifyConfidence(0.6).level).toBe('medium');
    expect(classifyConfidence(0.65).level).toBe('medium');
    expect(classifyConfidence(0.79).level).toBe('medium');
  });

  it('classifies < 0.6 as low', () => {
    expect(classifyConfidence(0).level).toBe('low');
    expect(classifyConfidence(0.35).level).toBe('low');
    expect(classifyConfidence(0.59).level).toBe('low');
  });

  it('classifies non-numeric / NaN / Infinity as unknown', () => {
    expect(classifyConfidence(NaN).level).toBe('unknown');
    expect(classifyConfidence(Infinity).level).toBe('unknown');
    expect(classifyConfidence(-Infinity).level).toBe('unknown');
    expect(classifyConfidence('high' as any).level).toBe('unknown');
    expect(classifyConfidence(null).level).toBe('unknown');
    expect(classifyConfidence(undefined).level).toBe('unknown');
  });

  it('clamps out-of-range scores', () => {
    expect(classifyConfidence(1.5).level).toBe('high');
    expect(classifyConfidence(1.5).score).toBe(1);
    expect(classifyConfidence(-0.1).level).toBe('low');
    expect(classifyConfidence(-0.1).score).toBe(0);
  });

  it('produces a label that includes the percentage', () => {
    expect(classifyConfidence(0.85).label).toBe('High (85%)');
    expect(classifyConfidence(0.65).label).toBe('Medium (65%)');
    expect(classifyConfidence(0.35).label).toBe('Low (35%)');
  });

  it('produces a description sentence mentioning the percent or status', () => {
    const c = classifyConfidence(0.65);
    expect(c.description.toLowerCase()).toContain('medium');
    expect(c.description).toContain('65%');
  });
});

describe('readConfidenceScore', () => {
  it('extracts the score from a Confidence object', () => {
    expect(readConfidenceScore({ score: 0.5 })).toBe(0.5);
  });

  it('passes a raw number through (clamped)', () => {
    expect(readConfidenceScore(0.42)).toBe(0.42);
    expect(readConfidenceScore(1.5)).toBe(1);
    expect(readConfidenceScore(-0.1)).toBe(0);
  });

  it('returns null for null / undefined / non-finite', () => {
    expect(readConfidenceScore(null)).toBeNull();
    expect(readConfidenceScore(undefined)).toBeNull();
    expect(readConfidenceScore({ score: 'nope' })).toBeNull();
    expect(readConfidenceScore(NaN)).toBeNull();
  });
});
