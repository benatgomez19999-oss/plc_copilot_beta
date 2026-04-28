// Sprint 78B — end-to-end workflow tests: ingest a real source,
// (optionally) build, snapshot, save, load, restore. These exercise
// the whole pure pipeline (everything except the React rendering)
// against the same registry the workspace uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCandidateFromIngestionResult,
  ingestElectricalInput,
} from '../src/utils/electrical-ingestion-flow.js';
import { buildPirPreview } from '../src/utils/pir-build-preview.js';
import {
  createInitialReviewState,
  setReviewDecision,
  type ElectricalReviewState,
} from '../src/utils/review-state.js';
import {
  createReviewSessionSnapshot,
  lightweightContentHash,
  reconcileReviewState,
  snapshotBuildResult,
} from '../src/utils/electrical-review-session.js';
import {
  clearLatestElectricalReviewSession,
  loadLatestElectricalReviewSession,
  saveElectricalReviewSession,
} from '../src/utils/electrical-review-storage.js';
import { computeExportAvailability } from '../src/utils/electrical-review-export.js';

const NOW = '2026-04-28T12:00:00.000Z';
const LATER = '2026-04-28T12:10:00.000Z';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const CSV_SAMPLE = `tag,kind,address,direction
B1,sensor,%I0.0,input
Y1,valve,%Q0.0,output
M1,motor,%Q0.1,output
`;

const TCECAD_MIN_XML = `<Project>
  <Name>demo</Name>
  <Description>TcECAD Import V2.2.x</Description>
  <CPUs>
    <CPU>
      <Name>CPU</Name>
      <Interfaces>
        <Interface>
          <Name>EtherCAT</Name>
          <Type>ETHERCATPROT</Type>
          <ChannelNo>1</ChannelNo>
          <Boxes>
            <Box>
              <Name>Box1</Name>
              <Type>EL1004</Type>
              <BoxNo>1005</BoxNo>
              <Variables>
                <Variable>
                  <Name>S1</Name>
                  <Comment>Lichttaster on conveyor entry</Comment>
                  <IsInput>true</IsInput>
                  <IoName>Input</IoName>
                  <IoGroup>Channel 1</IoGroup>
                  <IoDataType>BOOL</IoDataType>
                </Variable>
              </Variables>
            </Box>
          </Boxes>
        </Interface>
      </Interfaces>
    </CPU>
  </CPUs>
</Project>`;

describe('electrical-review session — CSV happy path', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. ingest → accept-all → build → snapshot carries pir + sourceMap', async () => {
    const ingestion = await ingestElectricalInput({
      sourceId: 'terminals.csv',
      text: CSV_SAMPLE,
      fileName: 'terminals.csv',
    });
    const candidate = createCandidateFromIngestionResult(ingestion);
    expect(candidate.io.length).toBeGreaterThan(0);

    let state = createInitialReviewState(candidate);
    for (const io of candidate.io) {
      state = setReviewDecision(state, 'io', io.id, 'accepted');
    }
    for (const eq of candidate.equipment) {
      state = setReviewDecision(state, 'equipment', eq.id, 'accepted');
    }
    for (const a of candidate.assumptions) {
      state = setReviewDecision(state, 'assumption', a.id, 'accepted');
    }

    const build = buildPirPreview(candidate, state);
    expect(build.ready).toBe(true);
    expect(build.result.pir).toBeDefined();

    const snap = createReviewSessionSnapshot({
      source: {
        sourceId: 'terminals.csv',
        fileName: 'terminals.csv',
        inputKind: 'csv',
        sourceKind: ingestion.graph.sourceKind,
        contentHash: lightweightContentHash(CSV_SAMPLE),
      },
      candidate,
      reviewState: state,
      ingestionDiagnostics: ingestion.diagnostics,
      build: snapshotBuildResult(build.result, NOW),
      nowIso: NOW,
    });
    expect(snap.build?.pir).toBeDefined();
    expect(snap.build?.sourceMap).toBeDefined();
    expect(snap.build?.diagnostics?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('2. round-trip via localStorage restores the same decisions', async () => {
    const ingestion = await ingestElectricalInput({
      sourceId: 'terminals.csv',
      text: CSV_SAMPLE,
      fileName: 'terminals.csv',
    });
    const candidate = createCandidateFromIngestionResult(ingestion);
    let state: ElectricalReviewState = createInitialReviewState(candidate);
    for (const io of candidate.io) {
      state = setReviewDecision(state, 'io', io.id, 'accepted');
    }

    const snap = createReviewSessionSnapshot({
      source: {
        sourceId: 'terminals.csv',
        fileName: 'terminals.csv',
        inputKind: 'csv',
        sourceKind: ingestion.graph.sourceKind,
      },
      candidate,
      reviewState: state,
      ingestionDiagnostics: ingestion.diagnostics,
      nowIso: NOW,
    });
    saveElectricalReviewSession(snap);

    const loaded = loadLatestElectricalReviewSession();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.snapshot.source.sourceKind).toBe(ingestion.graph.sourceKind);
    for (const io of candidate.io) {
      expect(loaded.snapshot.reviewState.ioCandidates[io.id]?.decision).toBe(
        'accepted',
      );
    }
  });
});

describe('electrical-review session — TcECAD path (refused build)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. accept-all → builder refuses → snapshot has diagnostics but no pir', async () => {
    const ingestion = await ingestElectricalInput({
      sourceId: 'plan.xml',
      text: TCECAD_MIN_XML,
      fileName: 'plan.xml',
    });
    expect(ingestion.graph.sourceKind).toBe('twincat_ecad');

    const candidate = createCandidateFromIngestionResult(ingestion);
    expect(candidate.io.length + candidate.equipment.length).toBeGreaterThan(
      0,
    );

    let state = createInitialReviewState(candidate);
    for (const io of candidate.io) {
      state = setReviewDecision(state, 'io', io.id, 'accepted');
    }
    for (const eq of candidate.equipment) {
      state = setReviewDecision(state, 'equipment', eq.id, 'accepted');
    }
    for (const a of candidate.assumptions) {
      state = setReviewDecision(state, 'assumption', a.id, 'accepted');
    }

    const build = buildPirPreview(candidate, state);
    // Builder refuses honestly: tcecad: addresses don't map to PIR.
    expect(build.result.pir).toBeUndefined();
    expect(build.result.diagnostics.length).toBeGreaterThan(0);

    const snap = createReviewSessionSnapshot({
      source: {
        sourceId: 'plan.xml',
        fileName: 'plan.xml',
        inputKind: 'xml',
        sourceKind: ingestion.graph.sourceKind,
      },
      candidate,
      reviewState: state,
      ingestionDiagnostics: ingestion.diagnostics,
      build: snapshotBuildResult(build.result, NOW),
      nowIso: NOW,
    });
    expect(snap.build?.pir).toBeUndefined();
    expect(snap.build?.diagnostics?.length ?? 0).toBeGreaterThan(0);

    // Availability projection: PIR + sourceMap not downloadable, but
    // build diagnostics + ingestion diagnostics + review session are.
    const a = computeExportAvailability({
      snapshot: snap,
      buildResult: build.result,
    });
    expect(a.pirJson).toBe(false);
    expect(a.sourceMap).toBe(false);
    expect(a.buildDiagnostics).toBe(true);
    expect(a.ingestionDiagnostics).toBe(true);
    expect(a.reviewSession).toBe(true);
    expect(a.bundle).toBe(true);
  });
});

describe('electrical-review session — Sprint 79 PDF (text-mode)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PDF_TEXT = `--- page 1 ---
I0.0 B1 Part present
Q0.0 Y1 Cylinder extend
`;

  it('1. PDF text-mode ingest → snapshot stores sourceKind="pdf" + PDF SourceRefs', async () => {
    const ingestion = await ingestElectricalInput({
      sourceId: 'plan.pdf',
      text: PDF_TEXT,
      fileName: 'plan.pdf',
    });
    expect(ingestion.graph.sourceKind).toBe('pdf');

    const candidate = createCandidateFromIngestionResult(ingestion);
    expect(candidate.io.length).toBeGreaterThan(0);

    const snap = createReviewSessionSnapshot({
      source: {
        sourceId: 'plan.pdf',
        fileName: 'plan.pdf',
        inputKind: 'pdf',
        sourceKind: ingestion.graph.sourceKind,
        contentHash: lightweightContentHash(PDF_TEXT),
      },
      candidate,
      reviewState: createInitialReviewState(candidate),
      ingestionDiagnostics: ingestion.diagnostics,
      nowIso: NOW,
    });
    saveElectricalReviewSession(snap);
    const loaded = loadLatestElectricalReviewSession();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.snapshot.source.inputKind).toBe('pdf');
    expect(loaded.snapshot.source.sourceKind).toBe('pdf');
    // PDF SourceRefs survive the round-trip.
    const ref = loaded.snapshot.candidate.io[0]?.sourceRefs[0];
    expect(ref?.kind).toBe('pdf');
    expect(ref?.page).toBeDefined();
  });

  it('2. snapshot JSON does NOT include raw PDF bytes / source text', async () => {
    const ingestion = await ingestElectricalInput({
      sourceId: 'plan.pdf',
      text: PDF_TEXT,
      fileName: 'plan.pdf',
    });
    const candidate = createCandidateFromIngestionResult(ingestion);
    const snap = createReviewSessionSnapshot({
      source: {
        sourceId: 'plan.pdf',
        fileName: 'plan.pdf',
        inputKind: 'pdf',
        sourceKind: ingestion.graph.sourceKind,
      },
      candidate,
      reviewState: createInitialReviewState(candidate),
      ingestionDiagnostics: ingestion.diagnostics,
      nowIso: NOW,
    });
    const json = JSON.stringify(snap);
    expect(json.includes('"rawContent"')).toBe(false);
    expect(json.includes('"sourceText"')).toBe(false);
    expect(json.includes('"bytes"')).toBe(false);
  });
});

describe('electrical-review session — restore + reconcile + clear', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. clearing removes the saved entry; subsequent load returns no-saved-session', async () => {
    const ingestion = await ingestElectricalInput({
      sourceId: 'terminals.csv',
      text: CSV_SAMPLE,
      fileName: 'terminals.csv',
    });
    const candidate = createCandidateFromIngestionResult(ingestion);
    const snap = createReviewSessionSnapshot({
      source: {
        sourceId: 'terminals.csv',
        fileName: 'terminals.csv',
        inputKind: 'csv',
      },
      candidate,
      reviewState: createInitialReviewState(candidate),
      ingestionDiagnostics: ingestion.diagnostics,
      nowIso: NOW,
    });
    saveElectricalReviewSession(snap);
    expect(loadLatestElectricalReviewSession().ok).toBe(true);
    clearLatestElectricalReviewSession();
    const after = loadLatestElectricalReviewSession();
    expect(after.ok).toBe(false);
  });

  it('2. reconcile fills missing decisions on a candidate with new ids', async () => {
    const ingestion = await ingestElectricalInput({
      sourceId: 'terminals.csv',
      text: CSV_SAMPLE,
      fileName: 'terminals.csv',
    });
    const candidate = createCandidateFromIngestionResult(ingestion);
    // Start with no decisions saved at all (mimicking a corrupted /
    // partial reviewState restored from disk).
    const reconciled = reconcileReviewState(candidate, {
      ioCandidates: {},
      equipmentCandidates: {},
      assumptions: {},
    });
    for (const io of candidate.io) {
      expect(reconciled.ioCandidates[io.id]?.decision).toBe('pending');
    }
  });

  it('3. createdAt advances forward across autosaves', async () => {
    const ingestion = await ingestElectricalInput({
      sourceId: 'terminals.csv',
      text: CSV_SAMPLE,
      fileName: 'terminals.csv',
    });
    const candidate = createCandidateFromIngestionResult(ingestion);
    const initial = createReviewSessionSnapshot({
      source: { sourceId: 'terminals.csv', inputKind: 'csv' },
      candidate,
      reviewState: createInitialReviewState(candidate),
      ingestionDiagnostics: ingestion.diagnostics,
      nowIso: NOW,
    });
    const next = createReviewSessionSnapshot({
      source: { sourceId: 'terminals.csv', inputKind: 'csv' },
      candidate,
      reviewState: createInitialReviewState(candidate),
      ingestionDiagnostics: ingestion.diagnostics,
      nowIso: LATER,
      createdAtIso: initial.createdAt,
    });
    expect(next.createdAt).toBe(initial.createdAt);
    expect(next.updatedAt).toBe(LATER);
  });
});
