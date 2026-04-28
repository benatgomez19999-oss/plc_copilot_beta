// Sprint 78B — pure tests for the session-snapshot helpers. Every
// helper is deterministic when callers thread `nowIso`; nothing
// touches the DOM, so these run under `environment: 'node'` like
// the rest of the web suite.

import { describe, expect, it } from 'vitest';
import type { PirBuildResult } from '@plccopilot/electrical-ingest';

import {
  EMPTY_REVIEW_CANDIDATE,
  SAMPLE_REVIEW_CANDIDATE,
} from '../src/utils/review-fixtures.js';
import { createInitialReviewState, setReviewDecision } from '../src/utils/review-state.js';
import {
  REVIEW_SESSION_SCHEMA_VERSION,
  createReviewSessionSnapshot,
  lightweightContentHash,
  reconcileReviewState,
  restoreReviewSessionSnapshot,
  reviewStateFor,
  snapshotBuildResult,
  summarizeReviewDecisionCounts,
} from '../src/utils/electrical-review-session.js';

const NOW = '2026-04-28T12:00:00.000Z';
const LATER = '2026-04-28T12:05:00.000Z';

describe('lightweightContentHash', () => {
  it('1. is deterministic for the same input', () => {
    expect(lightweightContentHash('terminals.csv,B1,sensor')).toBe(
      lightweightContentHash('terminals.csv,B1,sensor'),
    );
  });

  it('2. differs for different inputs', () => {
    expect(lightweightContentHash('A')).not.toBe(lightweightContentHash('B'));
  });

  it('3. handles empty / non-string defensively', () => {
    expect(lightweightContentHash('')).toBe('00000000');
    // @ts-expect-error — defensive on non-string
    expect(lightweightContentHash(undefined)).toBe('00000000');
    // @ts-expect-error
    expect(lightweightContentHash(null)).toBe('00000000');
  });

  it('4. is 8-char hex', () => {
    expect(lightweightContentHash('hello world')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('createReviewSessionSnapshot', () => {
  const state = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);

  it('1. pins schemaVersion to v1', () => {
    const snap = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    expect(snap.schemaVersion).toBe('electrical-review-session.v1');
    expect(snap.schemaVersion).toBe(REVIEW_SESSION_SCHEMA_VERSION);
  });

  it('2. defaults createdAt = updatedAt = nowIso', () => {
    const snap = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    expect(snap.createdAt).toBe(NOW);
    expect(snap.updatedAt).toBe(NOW);
  });

  it('3. carries createdAt forward across autosaves via createdAtIso', () => {
    const snap = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: LATER,
      createdAtIso: NOW,
    });
    expect(snap.createdAt).toBe(NOW);
    expect(snap.updatedAt).toBe(LATER);
  });

  it('4. carries createdAt forward via previous snapshot', () => {
    const first = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    const second = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: LATER,
      previous: first,
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(LATER);
  });

  it('5. preserves source metadata', () => {
    const snap = createReviewSessionSnapshot({
      source: {
        sourceId: 'src-1',
        fileName: 'terminals.csv',
        inputKind: 'csv',
        sourceKind: 'csv',
        contentHash: 'deadbeef',
      },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    expect(snap.source).toEqual({
      sourceId: 'src-1',
      fileName: 'terminals.csv',
      inputKind: 'csv',
      sourceKind: 'csv',
      contentHash: 'deadbeef',
    });
  });

  it('6. preserves candidate + reviewState (deep-copied)', () => {
    const snap = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    expect(snap.candidate.id).toBe(SAMPLE_REVIEW_CANDIDATE.id);
    expect(snap.candidate).not.toBe(SAMPLE_REVIEW_CANDIDATE);
    expect(snap.reviewState).not.toBe(state);
  });

  it('7. preserves ingestion diagnostics (cloned)', () => {
    const diag = {
      code: 'TCECAD_XML_DETECTED',
      severity: 'info',
      message: 'detected',
    } as const;
    const snap = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [diag],
      nowIso: NOW,
    });
    expect(snap.ingestionDiagnostics).toEqual([diag]);
    expect(snap.ingestionDiagnostics[0]).not.toBe(diag);
  });

  it('8. omits build when not provided', () => {
    const snap = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    expect(snap.build).toBeUndefined();
  });

  it('9. preserves build when provided', () => {
    const build = {
      attemptedAt: NOW,
      diagnostics: [],
      pir: { id: 'p1' },
      sourceMap: { 'io_b1': [] },
      acceptedInputCounts: { io: 1, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const snap = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      build,
      nowIso: NOW,
    });
    expect(snap.build?.attemptedAt).toBe(NOW);
    expect(snap.build?.pir).toEqual({ id: 'p1' });
    expect(snap.build?.sourceMap).toEqual({ 'io_b1': [] });
  });

  it('10. raw source content is NEVER written into the snapshot', () => {
    const snap = createReviewSessionSnapshot({
      source: {
        sourceId: 'src-1',
        fileName: 'plan.xml',
        inputKind: 'xml',
        contentHash: 'abc12345',
      },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    const json = JSON.stringify(snap);
    expect(json.includes('contentHash')).toBe(true);
    // Sanity: there is no `rawContent` / `text` / `body` field in the
    // snapshot shape — and the helper API offers no way to add one.
    expect(json.includes('"rawContent"')).toBe(false);
    expect(json.includes('"sourceText"')).toBe(false);
  });

  it('11. throws when nowIso is missing', () => {
    expect(() =>
      createReviewSessionSnapshot({
        source: { sourceId: 'src-1', inputKind: 'csv' },
        candidate: SAMPLE_REVIEW_CANDIDATE,
        reviewState: state,
        ingestionDiagnostics: [],
        // @ts-expect-error
        nowIso: undefined,
      }),
    ).toThrow(/nowIso/);
  });

  it('12. handles empty candidate cleanly', () => {
    const snap = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'unknown' },
      candidate: EMPTY_REVIEW_CANDIDATE,
      reviewState: createInitialReviewState(EMPTY_REVIEW_CANDIDATE),
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    expect(snap.candidate.io ?? []).toEqual([]);
  });
});

describe('snapshotBuildResult', () => {
  it('1. returns minimal build for an empty result', () => {
    const result: PirBuildResult = {
      diagnostics: [],
      sourceMap: {},
      acceptedInputCounts: { io: 0, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const build = snapshotBuildResult(result, NOW);
    expect(build.attemptedAt).toBe(NOW);
    expect(build.diagnostics).toEqual([]);
    expect(build.pir).toBeUndefined();
    expect(build.sourceMap).toBeUndefined();
  });

  it('2. carries pir / non-empty sourceMap / counts when present', () => {
    const result: PirBuildResult = {
      pir: { id: 'p1' } as never,
      diagnostics: [
        {
          code: 'PIR_BUILD_PLACEHOLDER_SEQUENCE_USED',
          severity: 'info',
          message: 'placeholder used',
        },
      ],
      sourceMap: { io_b1: [] },
      acceptedInputCounts: { io: 1, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const build = snapshotBuildResult(result, NOW);
    expect(build.pir).toEqual({ id: 'p1' });
    expect(build.sourceMap).toEqual({ io_b1: [] });
    expect(build.diagnostics).toHaveLength(1);
    expect(build.acceptedInputCounts).toEqual({
      io: 1,
      equipment: 0,
      assumptions: 0,
    });
  });

  it('3. omits empty sourceMap', () => {
    const result: PirBuildResult = {
      diagnostics: [],
      sourceMap: {},
      acceptedInputCounts: { io: 0, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const build = snapshotBuildResult(result, NOW);
    expect(build.sourceMap).toBeUndefined();
  });
});

describe('summarizeReviewDecisionCounts', () => {
  it('1. counts pending across bags for an unreviewed candidate', () => {
    const counts = summarizeReviewDecisionCounts(
      SAMPLE_REVIEW_CANDIDATE,
      createInitialReviewState(SAMPLE_REVIEW_CANDIDATE),
    );
    expect(counts.io.total).toBe(SAMPLE_REVIEW_CANDIDATE.io.length);
    expect(counts.equipment.total).toBe(SAMPLE_REVIEW_CANDIDATE.equipment.length);
    expect(counts.assumption.total).toBe(SAMPLE_REVIEW_CANDIDATE.assumptions.length);
    expect(counts.total.pending).toBe(counts.total.total);
    expect(counts.total.accepted).toBe(0);
    expect(counts.total.rejected).toBe(0);
  });

  it('2. counts accepted/rejected after decisions', () => {
    let s = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    s = setReviewDecision(s, 'io', SAMPLE_REVIEW_CANDIDATE.io[0].id, 'accepted');
    s = setReviewDecision(s, 'io', SAMPLE_REVIEW_CANDIDATE.io[1].id, 'rejected');
    const c = summarizeReviewDecisionCounts(SAMPLE_REVIEW_CANDIDATE, s);
    expect(c.io.accepted).toBe(1);
    expect(c.io.rejected).toBe(1);
    expect(c.io.pending).toBe(SAMPLE_REVIEW_CANDIDATE.io.length - 2);
  });

  it('3. tolerates empty candidate', () => {
    const c = summarizeReviewDecisionCounts(
      EMPTY_REVIEW_CANDIDATE,
      createInitialReviewState(EMPTY_REVIEW_CANDIDATE),
    );
    expect(c.total.total).toBe(0);
  });
});

describe('restoreReviewSessionSnapshot', () => {
  const state = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
  const valid = createReviewSessionSnapshot({
    source: { sourceId: 'src-1', inputKind: 'csv', fileName: 'terminals.csv' },
    candidate: SAMPLE_REVIEW_CANDIDATE,
    reviewState: state,
    ingestionDiagnostics: [],
    nowIso: NOW,
  });

  it('1. round-trips JSON.parse(stringify(snap))', () => {
    const r = restoreReviewSessionSnapshot(JSON.parse(JSON.stringify(valid)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot.source.fileName).toBe('terminals.csv');
  });

  it('2. rejects null / non-object', () => {
    expect(restoreReviewSessionSnapshot(null).ok).toBe(false);
    expect(restoreReviewSessionSnapshot(7 as never).ok).toBe(false);
    expect(restoreReviewSessionSnapshot('hi' as never).ok).toBe(false);
  });

  it('3. rejects wrong schemaVersion', () => {
    const bad = { ...JSON.parse(JSON.stringify(valid)), schemaVersion: 'v0' };
    const r = restoreReviewSessionSnapshot(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/schemaVersion/);
  });

  it('4. rejects missing createdAt / updatedAt', () => {
    const bad = JSON.parse(JSON.stringify(valid));
    delete bad.createdAt;
    expect(restoreReviewSessionSnapshot(bad).ok).toBe(false);
  });

  it('5. rejects malformed source', () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.source = { sourceId: '', inputKind: 'csv' };
    expect(restoreReviewSessionSnapshot(bad).ok).toBe(false);
  });

  it('6. rejects unknown inputKind', () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.source.inputKind = 'pdf';
    expect(restoreReviewSessionSnapshot(bad).ok).toBe(false);
  });

  it('7. rejects malformed candidate (io not array)', () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.candidate.io = 'not-an-array';
    expect(restoreReviewSessionSnapshot(bad).ok).toBe(false);
  });

  it('8. rejects malformed reviewState (missing bag)', () => {
    const bad = JSON.parse(JSON.stringify(valid));
    delete bad.reviewState.equipmentCandidates;
    expect(restoreReviewSessionSnapshot(bad).ok).toBe(false);
  });

  it('9. rejects ingestionDiagnostics not array', () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.ingestionDiagnostics = { foo: 'bar' };
    expect(restoreReviewSessionSnapshot(bad).ok).toBe(false);
  });

  it('10. rejects malformed build (non-array diagnostics)', () => {
    const withBuild = createReviewSessionSnapshot({
      source: { sourceId: 'src-1', inputKind: 'csv' },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: state,
      ingestionDiagnostics: [],
      build: { attemptedAt: NOW, diagnostics: [] },
      nowIso: NOW,
    });
    const bad = JSON.parse(JSON.stringify(withBuild));
    bad.build.diagnostics = 'oops';
    expect(restoreReviewSessionSnapshot(bad).ok).toBe(false);
  });

  it('11. accepts unknown inputKind="unknown"', () => {
    const ok = createReviewSessionSnapshot({
      source: { sourceId: 's', inputKind: 'unknown' },
      candidate: EMPTY_REVIEW_CANDIDATE,
      reviewState: createInitialReviewState(EMPTY_REVIEW_CANDIDATE),
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    expect(restoreReviewSessionSnapshot(JSON.parse(JSON.stringify(ok))).ok).toBe(
      true,
    );
  });

  it('12. defensive clone — caller may mutate input afterwards safely', () => {
    const raw = JSON.parse(JSON.stringify(valid));
    const r = restoreReviewSessionSnapshot(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    raw.source.fileName = 'mutated';
    expect(r.snapshot.source.fileName).toBe('terminals.csv');
  });
});

describe('reviewStateFor + reconcileReviewState', () => {
  it('1. reviewStateFor mirrors createInitialReviewState', () => {
    const a = reviewStateFor(SAMPLE_REVIEW_CANDIDATE);
    const b = createInitialReviewState(SAMPLE_REVIEW_CANDIDATE);
    expect(a).toEqual(b);
  });

  it('2. reconcile adds missing ids as pending', () => {
    const partial = {
      ioCandidates: {
        [SAMPLE_REVIEW_CANDIDATE.io[0].id]: {
          id: SAMPLE_REVIEW_CANDIDATE.io[0].id,
          decision: 'accepted' as const,
        },
      },
      equipmentCandidates: {},
      assumptions: {},
    };
    const reconciled = reconcileReviewState(SAMPLE_REVIEW_CANDIDATE, partial);
    // Existing decision preserved.
    expect(
      reconciled.ioCandidates[SAMPLE_REVIEW_CANDIDATE.io[0].id]?.decision,
    ).toBe('accepted');
    // Missing ids defaulted to pending.
    for (const e of SAMPLE_REVIEW_CANDIDATE.equipment) {
      expect(reconciled.equipmentCandidates[e.id]?.decision).toBe('pending');
    }
  });

  it('3. reconcile is total-defensive on null state', () => {
    const reconciled = reconcileReviewState(
      SAMPLE_REVIEW_CANDIDATE,
      // @ts-expect-error — defensive on null
      null,
    );
    for (const io of SAMPLE_REVIEW_CANDIDATE.io) {
      expect(reconciled.ioCandidates[io.id]?.decision).toBe('pending');
    }
  });
});
