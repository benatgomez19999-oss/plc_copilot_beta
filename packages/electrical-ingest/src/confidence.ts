// Sprint 72 — pure confidence helpers. Confidence scores are floats
// in [0, 1]; helpers clamp out-of-range values rather than throwing
// (drawings will produce noisy data; the pipeline keeps going).
//
// Combination model (deterministic, no randomness):
//   - Multiple independent supporting evidences boost the score
//     toward 1 via complement-product (1 − ∏(1 − sᵢ·wᵢ)). This
//     resembles a "dependent OR" — each piece of evidence reduces
//     the residual doubt.
//   - Conflicting evidence (negative weight) is subtracted from
//     the raw score with a hard floor at 0.
//   - The reasons array is concatenated, deduplicated, deterministically
//     sorted by source then reason.

import type { Confidence, Evidence } from './types.js';

export const CONFIDENCE_ZERO: Confidence = Object.freeze({
  score: 0,
  reasons: Object.freeze([]) as unknown as string[],
});

export const CONFIDENCE_ONE: Confidence = Object.freeze({
  score: 1,
  reasons: Object.freeze([]) as unknown as string[],
});

/**
 * Clamp `score` to [0, 1]. Non-finite or non-numeric inputs become 0.
 */
export function clampConfidence(score: unknown): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

/**
 * Build a Confidence from an array of Evidence items. Deterministic,
 * pure. Empty input → score 0, no reasons.
 *
 * Algorithm:
 *   1. Normalise each evidence: clamp score, default weight 1.
 *   2. Sum negative weights' absolute contribution as `conflict`.
 *   3. For supporting (weight ≥ 0) evidences, compute
 *        boosted = 1 − ∏(1 − clamp(sᵢ · wᵢ))
 *   4. score = clamp(boosted − conflict).
 *   5. Reasons = `${source}: ${reason}` deduplicated + sorted.
 */
export function confidenceFromEvidence(
  evidences: readonly Evidence[],
): Confidence {
  if (!Array.isArray(evidences) || evidences.length === 0) {
    return { score: 0, reasons: [] };
  }
  let supporting = 0; // running product of (1 − sᵢ·wᵢ)
  supporting = 1;
  let conflict = 0;
  const reasonsSet = new Set<string>();
  for (const e of evidences) {
    if (!e || typeof e !== 'object') continue;
    const weight = typeof e.weight === 'number' && Number.isFinite(e.weight) ? e.weight : 1;
    const s = clampConfidence(e.score);
    const reason = `${e.source ?? '<unknown>'}: ${e.reason ?? ''}`;
    if (weight < 0) {
      conflict += s * Math.abs(weight);
    } else {
      const contribution = clampConfidence(s * weight);
      supporting *= 1 - contribution;
    }
    reasonsSet.add(reason);
  }
  const boosted = 1 - supporting;
  const score = clampConfidence(boosted - conflict);
  const reasons = [...reasonsSet].sort((a, b) => a.localeCompare(b));
  return { score, reasons };
}

/**
 * Combine multiple Confidence values (already-built). Same
 * complement-product as `confidenceFromEvidence` for supporting
 * evidence; reasons concatenate + dedupe + sort.
 */
export function combineConfidence(values: readonly Confidence[]): Confidence {
  if (!Array.isArray(values) || values.length === 0) {
    return { score: 0, reasons: [] };
  }
  let supporting = 1;
  const reasonsSet = new Set<string>();
  for (const c of values) {
    if (!c || typeof c !== 'object') continue;
    supporting *= 1 - clampConfidence(c.score);
    if (Array.isArray(c.reasons)) {
      for (const r of c.reasons) {
        if (typeof r === 'string' && r.length > 0) reasonsSet.add(r);
      }
    }
  }
  const score = clampConfidence(1 - supporting);
  const reasons = [...reasonsSet].sort((a, b) => a.localeCompare(b));
  return { score, reasons };
}

/**
 * Take the lowest score from a non-empty list. Useful when a
 * derived assertion is only as strong as its weakest premise.
 */
export function minConfidence(values: readonly Confidence[]): Confidence {
  if (!Array.isArray(values) || values.length === 0) {
    return { score: 0, reasons: [] };
  }
  let lo = 1;
  const reasonsSet = new Set<string>();
  for (const c of values) {
    if (!c || typeof c !== 'object') continue;
    const s = clampConfidence(c.score);
    if (s < lo) lo = s;
    if (Array.isArray(c.reasons)) {
      for (const r of c.reasons) {
        if (typeof r === 'string' && r.length > 0) reasonsSet.add(r);
      }
    }
  }
  return {
    score: lo,
    reasons: [...reasonsSet].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Convenience: build a Confidence with a single reason.
 */
export function confidenceOf(score: number, reason: string): Confidence {
  return {
    score: clampConfidence(score),
    reasons: typeof reason === 'string' && reason.length > 0 ? [reason] : [],
  };
}
