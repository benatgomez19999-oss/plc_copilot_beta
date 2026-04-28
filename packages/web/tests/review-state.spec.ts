// Sprint 75 — pure tests for the review-state helpers. The
// architecture invariant is "no item leaves pending without an
// explicit human decision"; these assertions pin it.

import { describe, expect, it } from 'vitest';

import {
  REVIEW_DECISIONS,
  createInitialReviewState,
  filterDiagnosticsBySeverity,
  getReviewDecision,
  isReadyForPirBuilder,
  setReviewDecision,
  summarizeReviewState,
} from '../src/utils/review-state.js';
import {
  EMPTY_REVIEW_CANDIDATE,
  SAMPLE_REVIEW_CANDIDATE,
} from '../src/utils/review-fixtures.js';
import type { PirDraftCandidate } from '@plccopilot/electrical-ingest';

describe('review-state — REVIEW_DECISIONS', () => {
  it('exposes exactly pending | accepted | rejected', () => {
    expect([...REVIEW_DECISIONS]).toEqual(['pending', 'accepted', 'rejected']);
  });
});

describe('createInitialReviewState', () => {
  it('marks every IO + equipment + assumption as pending', () => {
    const state = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    for (const io of SAMPLE_REVIEW_CANDIDATE.io) {
      expect(state.ioCandidates[io.id].decision).toBe('pending');
    }
    for (const eq of SAMPLE_REVIEW_CANDIDATE.equipment) {
      expect(state.equipmentCandidates[eq.id].decision).toBe('pending');
    }
    for (const a of SAMPLE_REVIEW_CANDIDATE.assumptions) {
      expect(state.assumptions[a.id].decision).toBe('pending');
    }
  });

  it('produces empty bags for an empty candidate', () => {
    const state = createInitialReviewState(EMPTY_REVIEW_CANDIDATE);
    expect(state.ioCandidates).toEqual({});
    expect(state.equipmentCandidates).toEqual({});
    expect(state.assumptions).toEqual({});
  });

  it('handles candidates with missing arrays gracefully', () => {
    const partial = { id: 'x' } as unknown as PirDraftCandidate;
    expect(() => createInitialReviewState(partial)).not.toThrow();
  });
});

describe('setReviewDecision', () => {
  const initial = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
  const ioId = SAMPLE_REVIEW_CANDIDATE.io[0].id;
  const eqId = SAMPLE_REVIEW_CANDIDATE.equipment[0].id;
  const asId = SAMPLE_REVIEW_CANDIDATE.assumptions[0].id;

  it('returns a new state object (immutable update)', () => {
    const next = setReviewDecision(initial, 'io', ioId, 'accepted');
    expect(next).not.toBe(initial);
    expect(next.ioCandidates).not.toBe(initial.ioCandidates);
    expect(initial.ioCandidates[ioId].decision).toBe('pending');
  });

  it('accepts an IO candidate', () => {
    const next = setReviewDecision(initial, 'io', ioId, 'accepted');
    expect(next.ioCandidates[ioId].decision).toBe('accepted');
  });

  it('rejects an equipment candidate', () => {
    const next = setReviewDecision(initial, 'equipment', eqId, 'rejected');
    expect(next.equipmentCandidates[eqId].decision).toBe('rejected');
  });

  it('flips an assumption from pending → rejected', () => {
    const next = setReviewDecision(initial, 'assumption', asId, 'rejected');
    expect(next.assumptions[asId].decision).toBe('rejected');
  });

  it('preserves an optional note', () => {
    const next = setReviewDecision(
      initial,
      'io',
      ioId,
      'rejected',
      'spurious wire',
    );
    expect(next.ioCandidates[ioId].note).toBe('spurious wire');
  });

  it('drops empty notes (does not store empty strings)', () => {
    const next = setReviewDecision(initial, 'io', ioId, 'accepted', '');
    expect(next.ioCandidates[ioId].note).toBeUndefined();
  });

  it('throws on empty id', () => {
    expect(() => setReviewDecision(initial, 'io', '', 'accepted')).toThrow();
  });

  it('throws on a non-canonical decision string', () => {
    expect(() =>
      setReviewDecision(initial, 'io', ioId, 'maybe' as never),
    ).toThrow();
  });

  it('chained updates each return new state without aliasing', () => {
    const a = setReviewDecision(initial, 'io', ioId, 'accepted');
    const b = setReviewDecision(a, 'equipment', eqId, 'rejected');
    expect(a.equipmentCandidates[eqId].decision).toBe('pending');
    expect(b.equipmentCandidates[eqId].decision).toBe('rejected');
  });
});

describe('getReviewDecision', () => {
  const initial = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);

  it('returns the current decision for known items', () => {
    const ioId = SAMPLE_REVIEW_CANDIDATE.io[0].id;
    const next = setReviewDecision(initial, 'io', ioId, 'accepted');
    expect(getReviewDecision(next, 'io', ioId)).toBe('accepted');
  });

  it("returns 'pending' for unknown items (does not throw)", () => {
    expect(getReviewDecision(initial, 'io', 'unknown-id')).toBe('pending');
    expect(getReviewDecision(initial, 'equipment', 'nope')).toBe('pending');
    expect(getReviewDecision(initial, 'assumption', 'nope')).toBe('pending');
  });
});

describe('summarizeReviewState', () => {
  it('counts every category for the sample candidate', () => {
    const state = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    const summary = summarizeReviewState(SAMPLE_REVIEW_CANDIDATE, state);
    // 3 IO + 2 equipment + 1 assumption = 6 total.
    expect(summary.total).toBe(6);
    expect(summary.pending).toBe(6);
    expect(summary.accepted).toBe(0);
    expect(summary.rejected).toBe(0);
    // Sample diagnostics: 1 error + 2 warnings.
    expect(summary.blockingDiagnostics).toBe(1);
    expect(summary.warnings).toBe(2);
  });

  it('counts a pending low-confidence assumption under lowConfidencePending', () => {
    const state = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    const summary = summarizeReviewState(SAMPLE_REVIEW_CANDIDATE, state);
    expect(summary.lowConfidencePending).toBe(1);
  });

  it('moving low-confidence pending → accepted clears lowConfidencePending', () => {
    const initial = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    const asId = SAMPLE_REVIEW_CANDIDATE.assumptions[0].id;
    const next = setReviewDecision(initial, 'assumption', asId, 'accepted');
    expect(summarizeReviewState(SAMPLE_REVIEW_CANDIDATE, next).lowConfidencePending).toBe(0);
  });

  it('shifts counts when items move pending → accepted/rejected', () => {
    const initial = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    const ioId = SAMPLE_REVIEW_CANDIDATE.io[0].id;
    const eqId = SAMPLE_REVIEW_CANDIDATE.equipment[0].id;
    const next = setReviewDecision(
      setReviewDecision(initial, 'io', ioId, 'accepted'),
      'equipment',
      eqId,
      'rejected',
    );
    const s = summarizeReviewState(SAMPLE_REVIEW_CANDIDATE, next);
    expect(s.accepted).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.pending).toBe(4);
    expect(s.total).toBe(6);
  });

  it('handles the empty candidate', () => {
    const state = createInitialReviewState(EMPTY_REVIEW_CANDIDATE);
    const summary = summarizeReviewState(EMPTY_REVIEW_CANDIDATE, state);
    expect(summary.total).toBe(0);
    expect(summary.pending).toBe(0);
    expect(summary.blockingDiagnostics).toBe(0);
  });
});

describe('isReadyForPirBuilder', () => {
  it('returns false when items are still pending', () => {
    const state = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    expect(isReadyForPirBuilder(SAMPLE_REVIEW_CANDIDATE, state)).toBe(false);
  });

  it('returns false when a blocking diagnostic exists, even if all items are decided', () => {
    let state = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    for (const io of SAMPLE_REVIEW_CANDIDATE.io) {
      state = setReviewDecision(state, 'io', io.id, 'accepted');
    }
    for (const eq of SAMPLE_REVIEW_CANDIDATE.equipment) {
      state = setReviewDecision(state, 'equipment', eq.id, 'accepted');
    }
    for (const as of SAMPLE_REVIEW_CANDIDATE.assumptions) {
      state = setReviewDecision(state, 'assumption', as.id, 'rejected');
    }
    // The sample carries one error-severity diagnostic, so we are
    // never ready until that's cleared at the source level.
    expect(isReadyForPirBuilder(SAMPLE_REVIEW_CANDIDATE, state)).toBe(false);
  });

  it('Sprint 78A — empty candidate is NOT ready (no reviewable items)', () => {
    // Sprint 75 originally returned true here ("nothing pending,
    // no errors → ready"). Sprint 77 manual testing of the public
    // Beckhoff/TwinCAT XML showed an unrecognised XML produced an
    // empty candidate that the UI then flipped to "READY TO BUILD".
    // Sprint 78A makes the gate refuse in this situation.
    const state = createInitialReviewState(EMPTY_REVIEW_CANDIDATE);
    expect(isReadyForPirBuilder(EMPTY_REVIEW_CANDIDATE, state)).toBe(false);
  });
});

describe('filterDiagnosticsBySeverity', () => {
  const diags = SAMPLE_REVIEW_CANDIDATE.diagnostics;

  it('returns all when severity is null/undefined', () => {
    expect(filterDiagnosticsBySeverity(diags, null).length).toBe(diags.length);
    expect(filterDiagnosticsBySeverity(diags, undefined).length).toBe(diags.length);
  });

  it('filters by severity (warning)', () => {
    const warnings = filterDiagnosticsBySeverity(diags, 'warning');
    expect(warnings.length).toBe(2);
    expect(warnings.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('filters by severity (error)', () => {
    const errors = filterDiagnosticsBySeverity(diags, 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].severity).toBe('error');
  });

  it('does not mutate the input', () => {
    const snap = JSON.stringify(diags);
    filterDiagnosticsBySeverity(diags, 'warning');
    expect(JSON.stringify(diags)).toBe(snap);
  });
});
