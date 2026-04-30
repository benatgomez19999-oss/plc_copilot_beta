// Sprint 76 — review-state types in the domain layer. The
// `@plccopilot/web` package already has equivalent types under
// `src/utils/review-state.ts`; this module mirrors the shape so
// the domain-side PIR builder can consume reviewer decisions
// WITHOUT introducing a circular dependency on web.
//
// Web's helper still lives in web (it owns the React state plumbing
// + the UI gate). Sprint 77 will likely migrate web's helper to
// import from here for a single source of truth, but Sprint 76
// keeps both shapes structurally compatible — assignable in either
// direction by `Object.assign` because the field names + value
// unions match exactly.

export type PirBuildReviewDecision = 'pending' | 'accepted' | 'rejected';

export const PIR_BUILD_REVIEW_DECISIONS: ReadonlyArray<PirBuildReviewDecision> =
  Object.freeze(['pending', 'accepted', 'rejected'] as const);

export interface PirBuildReviewedItemState {
  id: string;
  decision: PirBuildReviewDecision;
  /** Optional human comment captured at decision time. */
  note?: string;
}

export interface PirBuildReviewState {
  ioCandidates: Record<string, PirBuildReviewedItemState>;
  equipmentCandidates: Record<string, PirBuildReviewedItemState>;
  assumptions: Record<string, PirBuildReviewedItemState>;
  /**
   * Sprint 88L — parameter candidate decisions, parallel to
   * IO / equipment / assumption buckets. Optional so existing
   * callers that don't carry parameter candidates stay
   * compatible; readers default unknown ids to `'pending'`.
   */
  parameterCandidates?: Record<string, PirBuildReviewedItemState>;
}

/**
 * Convenience: read a decision out of a review-state bag, defaulting
 * to `'pending'` when the id is unknown. Mirrors the web helper.
 */
export function getReviewedDecision(
  state: PirBuildReviewState,
  bag: 'io' | 'equipment' | 'assumption' | 'parameter',
  id: string,
): PirBuildReviewDecision {
  const target =
    bag === 'io'
      ? state.ioCandidates
      : bag === 'equipment'
        ? state.equipmentCandidates
        : bag === 'parameter'
          ? state.parameterCandidates ?? {}
          : state.assumptions;
  return target?.[id]?.decision ?? 'pending';
}
