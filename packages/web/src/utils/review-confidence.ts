// Sprint 75 — confidence classification for the electrical-review
// UI. Pure helpers. The Sprint 73/74 ingestors emit a numeric
// `Confidence.score` in `[0, 1]`; this module turns it into one of
// three review-relevant labels with stable thresholds.
//
// Industrial principle: low-confidence items must be visually
// obvious. The badge itself uses both colour AND a text label so
// the workflow remains accessible (no colour-only signalling).

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

export const CONFIDENCE_HIGH_THRESHOLD = 0.8;
export const CONFIDENCE_MEDIUM_THRESHOLD = 0.6;

export interface ClassifiedConfidence {
  /** Clamped score in [0, 1] that drove the classification. */
  score: number;
  level: ConfidenceLevel;
  /** Short human label. Stable for tests / a11y / non-color UI. */
  label: string;
  /** Sentence-form description for tooltips / aria-label. */
  description: string;
}

function clamp01(score: unknown): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

/**
 * Classify a numeric confidence score (or a `Confidence.score`
 * field) into the four review levels.
 *
 *   - >= 0.8 → high
 *   - >= 0.6 → medium
 *   - <  0.6 → low
 *   - non-numeric / NaN / Infinity → unknown
 *
 * The thresholds match the Sprint 72/73 architecture: the
 * `PirDraftCandidate` builder promotes equipment at confidence
 * `>= 0.6`; anything below is an assumption. The UI inherits the
 * same boundary so "this row is below the promotion threshold" is
 * visually apparent without re-reading the doc.
 */
export function classifyConfidence(score: unknown): ClassifiedConfidence {
  const clamped = clamp01(score);
  if (clamped === null) {
    return {
      score: 0,
      level: 'unknown',
      label: 'Unknown',
      description: 'Confidence not provided',
    };
  }
  const pct = Math.round(clamped * 100);
  if (clamped >= CONFIDENCE_HIGH_THRESHOLD) {
    return {
      score: clamped,
      level: 'high',
      label: `High (${pct}%)`,
      description: `High confidence (${pct}%)`,
    };
  }
  if (clamped >= CONFIDENCE_MEDIUM_THRESHOLD) {
    return {
      score: clamped,
      level: 'medium',
      label: `Medium (${pct}%)`,
      description: `Medium confidence (${pct}%) — review recommended`,
    };
  }
  return {
    score: clamped,
    level: 'low',
    label: `Low (${pct}%)`,
    description: `Low confidence (${pct}%) — human review required before promotion`,
  };
}

/**
 * Convenience: extract the score from a `Confidence` object or a
 * raw number. The Sprint 72 `Confidence` type has a `score` field
 * but the candidate types occasionally pass numbers directly in
 * test fixtures.
 */
export function readConfidenceScore(
  confidence: { score?: unknown } | number | null | undefined,
): number | null {
  if (typeof confidence === 'number') return clamp01(confidence);
  if (confidence && typeof confidence === 'object') {
    return clamp01((confidence as { score?: unknown }).score);
  }
  return null;
}
