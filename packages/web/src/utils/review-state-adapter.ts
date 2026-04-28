// Sprint 77 — adapter between the web review-state shape (Sprint
// 75) and the domain-layer PirBuildReviewState (Sprint 76). The
// two are *structurally identical* by design, so the adapter is a
// pure type cast at runtime — its purpose is to give consumers a
// single explicit name for the conversion + a place to attach
// regression tests if either side ever drifts.
//
// Why an adapter at all:
//   - `electrical-ingest` does not depend on `web` (no circular
//     deps). The web type and the domain type don't share an
//     identity at the type level.
//   - A function with a clear name documents the boundary and
//     gives tests something to anchor against.

import type { PirBuildReviewState } from '@plccopilot/electrical-ingest';

import type {
  ElectricalReviewState,
  ReviewedItemState,
} from './review-state.js';

/**
 * Project the web's `ElectricalReviewState` into the domain-layer
 * `PirBuildReviewState`. Pure: the runtime shape is identical so
 * the cast is structural.
 *
 * If a future sprint diverges the two shapes, this adapter is the
 * single place that needs to copy fields explicitly — and the
 * `review-state-adapter.spec.ts` tests will fail loudly first.
 */
export function webReviewStateToPirBuildReviewState(
  state: ElectricalReviewState,
): PirBuildReviewState {
  if (!state || typeof state !== 'object') {
    return { ioCandidates: {}, equipmentCandidates: {}, assumptions: {} };
  }
  return {
    ioCandidates: copyBag(state.ioCandidates),
    equipmentCandidates: copyBag(state.equipmentCandidates),
    assumptions: copyBag(state.assumptions),
  };
}

function copyBag(
  bag: Record<string, ReviewedItemState> | undefined,
): Record<string, { id: string; decision: 'pending' | 'accepted' | 'rejected'; note?: string }> {
  const out: Record<string, { id: string; decision: 'pending' | 'accepted' | 'rejected'; note?: string }> = {};
  if (!bag || typeof bag !== 'object') return out;
  for (const [key, value] of Object.entries(bag)) {
    if (!value || typeof value !== 'object') continue;
    const copy: { id: string; decision: 'pending' | 'accepted' | 'rejected'; note?: string } = {
      id: value.id,
      decision: value.decision,
    };
    if (typeof value.note === 'string' && value.note.length > 0) {
      copy.note = value.note;
    }
    out[key] = copy;
  }
  return out;
}
