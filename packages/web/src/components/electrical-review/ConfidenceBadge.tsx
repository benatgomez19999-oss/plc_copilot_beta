// Sprint 75 — purely presentational confidence badge. Reads
// score/Confidence and delegates classification to the pure
// `classifyConfidence` helper. Both colour AND text label are
// shown so the UI remains accessible (no colour-only signalling).

import {
  classifyConfidence,
  readConfidenceScore,
} from '../../utils/review-confidence.js';

export interface ConfidenceBadgeProps {
  /** Either a `Confidence` object or the raw 0..1 score. */
  confidence: { score?: unknown } | number | null | undefined;
}

export function ConfidenceBadge({ confidence }: ConfidenceBadgeProps): JSX.Element {
  const score = readConfidenceScore(confidence);
  const classified = classifyConfidence(score);
  return (
    <span
      className={`badge confidence-${classified.level}`}
      role="status"
      aria-label={classified.description}
      title={classified.description}
    >
      {classified.label}
    </span>
  );
}
