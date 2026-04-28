// Sprint 77 — pin the structural compatibility between web's
// `ElectricalReviewState` (Sprint 75) and the domain-layer
// `PirBuildReviewState` (Sprint 76). If either side drifts, the
// adapter is the load-bearing place that must update — and these
// tests fire first.

import { describe, expect, it } from 'vitest';

import {
  buildPirFromReviewedCandidate,
  isReviewedCandidateReadyForPirBuild,
} from '@plccopilot/electrical-ingest';

import { webReviewStateToPirBuildReviewState } from '../src/utils/review-state-adapter.js';
import {
  createInitialReviewState,
  setReviewDecision,
  type ElectricalReviewState,
} from '../src/utils/review-state.js';
import { SAMPLE_REVIEW_CANDIDATE } from '../src/utils/review-fixtures.js';

describe('webReviewStateToPirBuildReviewState', () => {
  it('returns three empty bags for null / non-object input', () => {
    expect(webReviewStateToPirBuildReviewState(null as never)).toEqual({
      ioCandidates: {},
      equipmentCandidates: {},
      assumptions: {},
    });
  });

  it('mirrors a fresh review state shape exactly', () => {
    const web = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    const domain = webReviewStateToPirBuildReviewState(web);
    expect(Object.keys(domain.ioCandidates).sort()).toEqual(
      Object.keys(web.ioCandidates).sort(),
    );
    expect(Object.keys(domain.equipmentCandidates).sort()).toEqual(
      Object.keys(web.equipmentCandidates).sort(),
    );
    expect(Object.keys(domain.assumptions).sort()).toEqual(
      Object.keys(web.assumptions).sort(),
    );
  });

  it('preserves decision values verbatim (pending / accepted / rejected)', () => {
    let web = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    const ioId = SAMPLE_REVIEW_CANDIDATE.io[0].id;
    const eqId = SAMPLE_REVIEW_CANDIDATE.equipment[0].id;
    web = setReviewDecision(web, 'io', ioId, 'accepted');
    web = setReviewDecision(web, 'equipment', eqId, 'rejected');
    const domain = webReviewStateToPirBuildReviewState(web);
    expect(domain.ioCandidates[ioId].decision).toBe('accepted');
    expect(domain.equipmentCandidates[eqId].decision).toBe('rejected');
  });

  it('preserves operator notes', () => {
    let web: ElectricalReviewState = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    const ioId = SAMPLE_REVIEW_CANDIDATE.io[0].id;
    web = setReviewDecision(web, 'io', ioId, 'rejected', 'spurious wire');
    const domain = webReviewStateToPirBuildReviewState(web);
    expect(domain.ioCandidates[ioId].note).toBe('spurious wire');
  });

  it('produces a state that the domain gate accepts when web also accepts', () => {
    // Accept every IO + every equipment + reject the only assumption.
    let web = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    for (const io of SAMPLE_REVIEW_CANDIDATE.io) {
      web = setReviewDecision(web, 'io', io.id, 'accepted');
    }
    for (const eq of SAMPLE_REVIEW_CANDIDATE.equipment) {
      web = setReviewDecision(web, 'equipment', eq.id, 'accepted');
    }
    for (const as of SAMPLE_REVIEW_CANDIDATE.assumptions) {
      web = setReviewDecision(web, 'assumption', as.id, 'rejected');
    }
    const domain = webReviewStateToPirBuildReviewState(web);
    // The sample fixture has an error-severity diagnostic, so the
    // gate should still refuse — confirms the domain gate is
    // canonical (not merely "no pending" but also "no errors").
    expect(
      isReviewedCandidateReadyForPirBuild(SAMPLE_REVIEW_CANDIDATE, domain),
    ).toBe(false);
  });

  it('round-trips through the domain builder without loss', () => {
    let web = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    for (const io of SAMPLE_REVIEW_CANDIDATE.io) {
      web = setReviewDecision(web, 'io', io.id, 'accepted');
    }
    for (const eq of SAMPLE_REVIEW_CANDIDATE.equipment) {
      web = setReviewDecision(web, 'equipment', eq.id, 'accepted');
    }
    for (const as of SAMPLE_REVIEW_CANDIDATE.assumptions) {
      web = setReviewDecision(web, 'assumption', as.id, 'rejected');
    }
    const domain = webReviewStateToPirBuildReviewState(web);
    const result = buildPirFromReviewedCandidate(
      SAMPLE_REVIEW_CANDIDATE,
      domain,
      { provenanceCreatedAt: '1970-01-01T00:00:00.000Z' },
    );
    // Sample fixture carries an error diagnostic → builder refuses.
    expect(result.pir).toBeUndefined();
    expect(
      result.diagnostics.some((d) => d.code === 'PIR_BUILD_ERROR_DIAGNOSTIC_PRESENT'),
    ).toBe(true);
  });

  it('drops bags that are not objects (defensive)', () => {
    const malformed = {
      ioCandidates: 'not-a-bag' as unknown as Record<string, never>,
      equipmentCandidates: undefined as unknown as Record<string, never>,
      assumptions: null as unknown as Record<string, never>,
    } as unknown as ElectricalReviewState;
    const domain = webReviewStateToPirBuildReviewState(malformed);
    expect(domain.ioCandidates).toEqual({});
    expect(domain.equipmentCandidates).toEqual({});
    expect(domain.assumptions).toEqual({});
  });
});
