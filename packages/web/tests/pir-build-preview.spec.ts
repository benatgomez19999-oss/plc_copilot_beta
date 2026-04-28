// Sprint 77 — pure tests for the buildPirPreview wrapper.
// Walks the full pipeline from a CSV / EPLAN-XML text → ingested
// graph → candidate → review state → PIR preview, asserting the
// architectural invariants stay load-bearing.

import { describe, expect, it } from 'vitest';

import {
  buildPirPreview,
  collectReadyReasons,
  formatPirJson,
} from '../src/utils/pir-build-preview.js';
import { runElectricalIngestion } from '../src/utils/electrical-ingestion-flow.js';
import {
  createInitialReviewState,
  setReviewDecision,
  type ElectricalReviewState,
} from '../src/utils/review-state.js';
import { SAMPLE_REVIEW_CANDIDATE } from '../src/utils/review-fixtures.js';
import type { PirDraftCandidate } from '@plccopilot/electrical-ingest';

const FIXED_OPTIONS = {
  provenanceCreatedAt: '1970-01-01T00:00:00.000Z',
};

const SIMPLE_CSV = `tag,kind,address,direction,label
B1,sensor,%I0.0,input,Part present
Y1,valve,%Q0.0,output,Cylinder extend
M1,motor,%Q0.1,output,Conveyor motor`;

const SIMPLE_XML = `<?xml version="1.0"?>
<EplanProject>
  <Pages>
    <Page sheet="=A1/12">
      <Element tag="B1" kind="sensor" address="%I0.0" direction="input"/>
      <Element tag="Y1" kind="valve" address="%Q0.0" direction="output"/>
      <Element tag="M1" kind="motor" address="%Q0.1" direction="output"/>
    </Page>
  </Pages>
</EplanProject>`;

function acceptAll(candidate: PirDraftCandidate): ElectricalReviewState {
  let state = createInitialReviewState(candidate);
  for (const io of candidate.io) {
    state = setReviewDecision(state, 'io', io.id, 'accepted');
  }
  for (const eq of candidate.equipment) {
    state = setReviewDecision(state, 'equipment', eq.id, 'accepted');
  }
  for (const as of candidate.assumptions) {
    state = setReviewDecision(state, 'assumption', as.id, 'rejected');
  }
  return state;
}

// =============================================================================
// collectReadyReasons
// =============================================================================

describe('collectReadyReasons', () => {
  it('returns empty list when state has no pending and no error diagnostics', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    expect(collectReadyReasons(candidate, acceptAll(candidate))).toEqual([]);
  });

  it('reports pending IO count', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    const state = createInitialReviewState(candidate);
    const reasons = collectReadyReasons(candidate, state);
    expect(reasons.some((r) => /IO candidate/.test(r))).toBe(true);
  });

  it('reports pending equipment count', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    const state = createInitialReviewState(candidate);
    // Accept every IO so only equipment remains pending.
    let s = state;
    for (const io of candidate.io) {
      s = setReviewDecision(s, 'io', io.id, 'accepted');
    }
    const reasons = collectReadyReasons(candidate, s);
    expect(reasons.some((r) => /equipment candidate/.test(r))).toBe(true);
    expect(reasons.some((r) => /IO candidate/.test(r))).toBe(false);
  });

  it('reports error-severity ingestion diagnostics', () => {
    const reasons = collectReadyReasons(SAMPLE_REVIEW_CANDIDATE, createInitialReviewState(SAMPLE_REVIEW_CANDIDATE));
    // Sample fixture carries one error-severity diagnostic.
    expect(reasons.some((r) => /error-severity/.test(r))).toBe(true);
  });
});

// =============================================================================
// buildPirPreview — gate failures
// =============================================================================

describe('buildPirPreview — gate failures', () => {
  it('refuses when items are pending', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    const preview = buildPirPreview(
      candidate,
      createInitialReviewState(candidate),
      FIXED_OPTIONS,
    );
    expect(preview.ready).toBe(false);
    expect(preview.result.pir).toBeUndefined();
    expect(preview.readyReasons.length).toBeGreaterThan(0);
  });

  it('refuses when error diagnostics exist (sample fixture)', () => {
    const preview = buildPirPreview(
      SAMPLE_REVIEW_CANDIDATE,
      acceptAll(SAMPLE_REVIEW_CANDIDATE),
      FIXED_OPTIONS,
    );
    expect(preview.ready).toBe(false);
    expect(preview.result.pir).toBeUndefined();
  });

  it('still calls the builder when not ready (so diagnostics surface)', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    const preview = buildPirPreview(
      candidate,
      createInitialReviewState(candidate),
      FIXED_OPTIONS,
    );
    expect(
      preview.result.diagnostics.some((d) => d.code === 'PIR_BUILD_PENDING_REVIEW_ITEM'),
    ).toBe(true);
  });
});

// =============================================================================
// buildPirPreview — accepted-only success path
// =============================================================================

describe('buildPirPreview — CSV happy path', () => {
  it('builds a valid PIR for an accepted CSV input', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 'csv',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    const preview = buildPirPreview(candidate, acceptAll(candidate), FIXED_OPTIONS);
    expect(preview.ready).toBe(true);
    expect(preview.result.pir).toBeDefined();
    expect(preview.result.diagnostics.some((d) => d.code === 'PIR_BUILD_PLACEHOLDER_SEQUENCE_USED')).toBe(true);
  });

  it('preserves CSV source refs in the sourceMap sidecar', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 'csv',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    const preview = buildPirPreview(candidate, acceptAll(candidate), FIXED_OPTIONS);
    const ioId = preview.result.pir!.machines[0].io[0].id;
    const refs = preview.result.sourceMap[ioId];
    expect(refs.some((r) => r.kind === 'csv' && r.path === 'list.csv')).toBe(true);
  });

  it('rejected items are excluded from the PIR', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 'csv',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    let state = acceptAll(candidate);
    // Reject the motor equipment + the motor IO so the build is
    // self-consistent (we don't leave a binding pointing at a
    // rejected IO).
    const motorEq = candidate.equipment.find((e) => e.kind === 'motor_simple');
    const motorIo = candidate.io.find((io) => io.address === '%Q0.1');
    if (motorEq) state = setReviewDecision(state, 'equipment', motorEq.id, 'rejected');
    if (motorIo) state = setReviewDecision(state, 'io', motorIo.id, 'rejected');
    const preview = buildPirPreview(candidate, state, FIXED_OPTIONS);
    expect(preview.result.pir).toBeDefined();
    const types = preview.result.pir!.machines[0].stations[0].equipment.map(
      (eq) => eq.type,
    );
    expect(types).not.toContain('motor_simple');
    expect(preview.result.skippedInputCounts.rejected).toBeGreaterThanOrEqual(2);
  });
});

describe('buildPirPreview — EPLAN XML happy path', () => {
  it('builds a valid PIR for an accepted EPLAN XML input', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 'xml',
      text: SIMPLE_XML,
      fileName: 'plan.xml',
    });
    const preview = buildPirPreview(candidate, acceptAll(candidate), FIXED_OPTIONS);
    expect(preview.ready).toBe(true);
    expect(preview.result.pir).toBeDefined();
  });

  it('preserves EPLAN locator (symbol) in sourceMap', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 'xml',
      text: SIMPLE_XML,
      fileName: 'plan.xml',
    });
    const preview = buildPirPreview(candidate, acceptAll(candidate), FIXED_OPTIONS);
    const eqEntry = Object.entries(preview.result.sourceMap).find(([id]) =>
      id.startsWith('eq_'),
    );
    expect(eqEntry).toBeDefined();
    expect(eqEntry![1].some((r) => r.kind === 'eplan' && r.symbol)).toBe(true);
  });
});

// =============================================================================
// formatPirJson
// =============================================================================

describe('formatPirJson', () => {
  it('returns a 2-space-indented JSON string when pir is present', async () => {
    const { candidate } = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    const preview = buildPirPreview(candidate, acceptAll(candidate), FIXED_OPTIONS);
    const json = formatPirJson(preview.result);
    expect(typeof json).toBe('string');
    expect(json!.startsWith('{\n  "pir_version"')).toBe(true);
  });

  it('returns null when pir is undefined', () => {
    expect(
      formatPirJson({
        pir: undefined,
        diagnostics: [],
        sourceMap: {},
        acceptedInputCounts: { io: 0, equipment: 0, assumptions: 0 },
        skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
      }),
    ).toBeNull();
  });
});

// =============================================================================
// Empty / invalid inputs
// =============================================================================

describe('buildPirPreview — empty / invalid inputs', () => {
  it('handles an empty candidate (refuses with empty-input diagnostic)', () => {
    const empty: PirDraftCandidate = {
      id: 'empty',
      io: [],
      equipment: [],
      assumptions: [],
      diagnostics: [],
      sourceGraphId: 'g',
    };
    const preview = buildPirPreview(empty, createInitialReviewState(empty), FIXED_OPTIONS);
    expect(preview.ready).toBe(true);
    expect(preview.result.pir).toBeUndefined();
    expect(
      preview.result.diagnostics.some((d) => d.code === 'PIR_BUILD_EMPTY_ACCEPTED_INPUT'),
    ).toBe(true);
  });

  it('does not throw on null state (returns refusal)', () => {
    const empty: PirDraftCandidate = {
      id: 'empty',
      io: [],
      equipment: [],
      assumptions: [],
      diagnostics: [],
      sourceGraphId: 'g',
    };
    const preview = buildPirPreview(
      empty,
      null as unknown as ElectricalReviewState,
      FIXED_OPTIONS,
    );
    expect(preview.result.pir).toBeUndefined();
  });
});
