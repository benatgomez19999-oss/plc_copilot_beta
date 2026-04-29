// Sprint 77 + 78B — top-level orchestrator for the web electrical-
// ingestion + review + PIR build flow + (78B) review-session
// persistence and export. Self-contained: takes no props.
//
// Pipeline:
//
//   1. Operator pastes / uploads CSV / EPLAN / TcECAD XML.
//   2. `runElectricalIngestion` routes through the real
//      electrical-ingest registry (CSV → TcECAD → EPLAN → stub).
//   3. `ElectricalReviewPanel` shows IO + equipment + assumptions
//      + diagnostics; operator accepts/rejects.
//   4. Sprint 78B — review state autosaves to localStorage on every
//      decision; the operator can also press "Save now",
//      "Load last", "Clear saved", or import a saved JSON.
//   5. `PirBuildPanel` button is disabled until the gate passes.
//   6. On click, `buildPirPreview` runs and the JSON / sourceMap /
//      build diagnostics surface below.
//   7. `ExportArtifactsPanel` exposes per-artefact downloads + a
//      review-bundle ZIP.
//
// Privacy invariants (Sprint 78B):
//   - Raw source content is NOT persisted in the snapshot. Only the
//     candidate, decisions, diagnostics and build metadata.
//   - `contentHash` is a non-cryptographic local-identity marker.
//   - All persistence is client-side; no backend, no auth, no upload.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ElectricalDiagnostic,
  PirBuildResult,
  PirDraftCandidate,
} from '@plccopilot/electrical-ingest';

import {
  canIngestElectricalSource,
  detectInputKind,
  ingestElectricalInput,
  createCandidateFromIngestionResult,
  type DetectedInputKind,
} from '../../utils/electrical-ingestion-flow.js';
import {
  buildPirPreview,
  type PirBuildPreview,
} from '../../utils/pir-build-preview.js';
import {
  createInitialReviewState,
  type ElectricalReviewState,
} from '../../utils/review-state.js';
import {
  createReviewSessionSnapshot,
  lightweightContentHash,
  reconcileReviewState,
  restoreReviewSessionSnapshot,
  snapshotBuildResult,
  type ElectricalReviewSessionSnapshot,
} from '../../utils/electrical-review-session.js';
import {
  clearLatestElectricalReviewSession,
  loadLatestElectricalReviewSession,
  saveElectricalReviewSession,
} from '../../utils/electrical-review-storage.js';
import {
  computeExportAvailability,
  makeArtifactFileName,
  serializeBuildDiagnostics,
  serializeIngestionDiagnostics,
  serializePirJson,
  serializeReviewSession,
  serializeSourceMap,
  triggerBundleDownload,
  triggerJsonDownload,
} from '../../utils/electrical-review-export.js';
import { BuildDiagnosticsPanel } from './BuildDiagnosticsPanel.js';
import { ElectricalReviewPanel } from './ElectricalReviewPanel.js';
import { PirBuildPanel } from './PirBuildPanel.js';
import { PirJsonPreview } from './PirJsonPreview.js';
import { SourceMapPreview } from './SourceMapPreview.js';
import { ReviewSessionPanel } from './ReviewSessionPanel.js';
import { ExportArtifactsPanel } from './ExportArtifactsPanel.js';

interface IngestionState {
  candidate: PirDraftCandidate;
  reviewState: ElectricalReviewState;
  detectedKind: DetectedInputKind;
  inputFileName: string;
  /** Sprint 78B — kept so we can persist + re-export. */
  sourceId: string;
  ingestionDiagnostics: ElectricalDiagnostic[];
  sourceKind?: string;
  contentHash?: string;
  createdAtIso: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function ElectricalIngestionWorkspace(): JSX.Element {
  const [text, setText] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  // Sprint 79 — raw bytes from a binary upload (PDF). Held alongside
  // the text body so the user can switch between paste-mode and
  // file-mode without losing one. Cleared on Reset and on text-mode
  // re-paste.
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  const [ingestion, setIngestion] = useState<IngestionState | null>(null);
  const [buildPreview, setBuildPreview] = useState<PirBuildPreview | null>(
    null,
  );
  const [buildAttemptedAt, setBuildAttemptedAt] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectedKind = useMemo<DetectedInputKind>(
    () => detectInputKind(text, fileName, bytes ?? undefined),
    [text, fileName, bytes],
  );

  // ---------------------------------------------------------------------------
  // Snapshot derivation (single source of truth for persistence + export)
  // ---------------------------------------------------------------------------

  const snapshot = useMemo<ElectricalReviewSessionSnapshot | null>(() => {
    if (!ingestion) return null;
    const build =
      buildPreview && buildAttemptedAt
        ? snapshotBuildResult(buildPreview.result, buildAttemptedAt)
        : undefined;
    return createReviewSessionSnapshot({
      source: {
        sourceId: ingestion.sourceId,
        fileName: ingestion.inputFileName || undefined,
        inputKind: ingestion.detectedKind,
        sourceKind: ingestion.sourceKind,
        contentHash: ingestion.contentHash,
      },
      candidate: ingestion.candidate,
      reviewState: ingestion.reviewState,
      ingestionDiagnostics: ingestion.ingestionDiagnostics,
      build,
      nowIso: nowIso(),
      createdAtIso: ingestion.createdAtIso,
    });
  }, [ingestion, buildPreview, buildAttemptedAt]);

  // Autosave whenever the snapshot changes meaningfully (ingest /
  // accept / reject / build). Best-effort — `saveElectricalReviewSession`
  // never throws even on quota / privacy mode.
  useEffect(() => {
    if (!snapshot) return;
    saveElectricalReviewSession(snapshot);
    setSavedAt(snapshot.updatedAt);
  }, [snapshot]);

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------

  const handleIngest = useCallback(async () => {
    setPending(true);
    setBuildPreview(null);
    setBuildAttemptedAt(null);
    setSessionNotice(null);
    try {
      const sourceId =
        fileName.length > 0 ? fileName : `manual-${Date.now()}`;
      const ingestionResult = await ingestElectricalInput({
        sourceId,
        text,
        fileName: fileName.length > 0 ? fileName : undefined,
        bytes: bytes ?? undefined,
      });
      const candidate = createCandidateFromIngestionResult(ingestionResult);
      // Sprint 79 — when bytes were provided, hash the byte length +
      // first/last 64 bytes via a quick text projection. Avoids
      // converting the whole binary to a string for hashing.
      const hashSource =
        bytes && bytes.length > 0
          ? `pdf:${bytes.length}:${Array.from(bytes.slice(0, 64)).join(',')}|${Array.from(bytes.slice(-64)).join(',')}`
          : text;
      setIngestion({
        candidate,
        reviewState: createInitialReviewState(candidate),
        detectedKind,
        inputFileName: fileName,
        sourceId,
        ingestionDiagnostics: ingestionResult.diagnostics,
        sourceKind: ingestionResult.graph?.sourceKind,
        contentHash: lightweightContentHash(hashSource),
        createdAtIso: nowIso(),
      });
    } catch (err) {
      // Sprint 81 post-fix — defence-in-depth catch. The domain
      // layer (`ingestElectricalInput` → `ingestPdf` → adapter)
      // is contracted to NEVER reject for ingestion-level
      // failures; every error path lands as a structured
      // diagnostic. If something still leaks through (e.g. a
      // browser-side pdfjs worker setup error in a future
      // pdfjs version), surface it to the operator as a
      // session notice instead of an Uncaught promise.
      const message =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setSessionNotice(`Ingest failed unexpectedly: ${message}`);
    } finally {
      setPending(false);
    }
  }, [text, fileName, detectedKind, bytes]);

  const handleBuild = useCallback(() => {
    if (!ingestion) return;
    const preview = buildPirPreview(ingestion.candidate, ingestion.reviewState);
    setBuildPreview(preview);
    setBuildAttemptedAt(nowIso());
  }, [ingestion]);

  const handleReset = useCallback(() => {
    setText('');
    setFileName('');
    setBytes(null);
    setIngestion(null);
    setBuildPreview(null);
    setBuildAttemptedAt(null);
    setSessionNotice(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // ---------------------------------------------------------------------------
  // Sprint 78B — session persistence handlers
  // ---------------------------------------------------------------------------

  const handleSaveNow = useCallback(() => {
    if (!snapshot) return;
    saveElectricalReviewSession(snapshot);
    setSavedAt(snapshot.updatedAt);
    setSessionNotice('Session saved locally.');
  }, [snapshot]);

  const restoreSnapshot = useCallback(
    (s: ElectricalReviewSessionSnapshot, source: 'local' | 'import') => {
      const reconciled = reconcileReviewState(s.candidate, s.reviewState);
      setIngestion({
        candidate: s.candidate,
        reviewState: reconciled,
        detectedKind: s.source.inputKind,
        inputFileName: s.source.fileName ?? '',
        sourceId: s.source.sourceId,
        ingestionDiagnostics: s.ingestionDiagnostics,
        sourceKind: s.source.sourceKind,
        contentHash: s.source.contentHash,
        createdAtIso: s.createdAt,
      });
      setText('');
      setFileName(s.source.fileName ?? '');
      setBuildAttemptedAt(s.build?.attemptedAt ?? null);
      // Restored builds never replay — operator must press Build PIR
      // again if they want a live preview, since pir/sourceMap on
      // disk may be from a previous code revision.
      setBuildPreview(null);
      setSavedAt(s.updatedAt);
      setSessionNotice(
        source === 'local'
          ? 'Last saved session restored.'
          : 'Imported session loaded.',
      );
    },
    [],
  );

  const handleLoadLast = useCallback(() => {
    const result = loadLatestElectricalReviewSession();
    if (!result.ok) {
      setSessionNotice(result.reason);
      return;
    }
    restoreSnapshot(result.snapshot, 'local');
  }, [restoreSnapshot]);

  const handleClearSaved = useCallback(() => {
    clearLatestElectricalReviewSession();
    setSavedAt(null);
    setSessionNotice('Saved session cleared.');
  }, []);

  const handleImportSession = useCallback(
    async (file: File) => {
      try {
        const raw = await file.text();
        const parsed = JSON.parse(raw);
        const restored = restoreReviewSessionSnapshot(parsed);
        if (!restored.ok) {
          setSessionNotice(`Import failed: ${restored.reason}`);
          return;
        }
        restoreSnapshot(restored.snapshot, 'import');
      } catch (err) {
        setSessionNotice(
          `Import failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    },
    [restoreSnapshot],
  );

  // ---------------------------------------------------------------------------
  // Sprint 78B — export handlers (filenames derived from source file)
  // ---------------------------------------------------------------------------

  const baseName = ingestion?.inputFileName ?? '';

  const availability = useMemo(
    () =>
      computeExportAvailability({
        snapshot,
        buildResult: buildPreview?.result ?? null,
      }),
    [snapshot, buildPreview],
  );

  const buildResultForExport: PirBuildResult | undefined =
    buildPreview?.result;

  const handleDownloadReviewSession = useCallback(() => {
    if (!snapshot) return;
    triggerJsonDownload(
      makeArtifactFileName(baseName, 'review-session.json'),
      serializeReviewSession(snapshot),
    );
  }, [snapshot, baseName]);

  const handleDownloadIngestionDiagnostics = useCallback(() => {
    if (!snapshot) return;
    triggerJsonDownload(
      makeArtifactFileName(baseName, 'ingestion-diagnostics.json'),
      serializeIngestionDiagnostics(snapshot.ingestionDiagnostics ?? []),
    );
  }, [snapshot, baseName]);

  const handleDownloadPirJson = useCallback(() => {
    const pir = buildResultForExport?.pir ?? snapshot?.build?.pir;
    if (!pir) return;
    triggerJsonDownload(
      makeArtifactFileName(baseName, 'pir-preview.json'),
      serializePirJson(pir),
    );
  }, [buildResultForExport, snapshot, baseName]);

  const handleDownloadSourceMap = useCallback(() => {
    const map = buildResultForExport?.sourceMap ?? snapshot?.build?.sourceMap;
    if (!map || Object.keys(map).length === 0) return;
    triggerJsonDownload(
      makeArtifactFileName(baseName, 'source-map.json'),
      serializeSourceMap(map),
    );
  }, [buildResultForExport, snapshot, baseName]);

  const handleDownloadBuildDiagnostics = useCallback(() => {
    const diags =
      buildResultForExport?.diagnostics ?? snapshot?.build?.diagnostics;
    if (!diags) return;
    triggerJsonDownload(
      makeArtifactFileName(baseName, 'build-diagnostics.json'),
      serializeBuildDiagnostics(diags),
    );
  }, [buildResultForExport, snapshot, baseName]);

  const handleDownloadBundle = useCallback(async () => {
    if (!snapshot) return;
    await triggerBundleDownload(
      { snapshot, buildResult: buildResultForExport ?? null },
      makeArtifactFileName(baseName, 'review-bundle.zip'),
      nowIso(),
    );
  }, [snapshot, buildResultForExport, baseName]);

  const previewState = useMemo(
    () =>
      ingestion
        ? buildPirPreview(ingestion.candidate, ingestion.reviewState)
        : null,
    [ingestion],
  );

  return (
    <section
      className="electrical-ingestion-workspace"
      aria-label="Electrical ingestion + review workspace"
    >
      <header className="panel-header">
        <h2>Electrical ingestion (preview)</h2>
        <span className="muted">
          CSV / EPLAN XML / TcECAD XML / PDF (v0) → review → PIR preview · no automatic codegen
        </span>
      </header>

      <section
        className="electrical-ingestion-input"
        aria-label="Source input"
      >
        <h3>Source input</h3>
        <div className="electrical-ingestion-input-row">
          <label className="text-input">
            <span>File name (used for source refs)</span>
            <input
              type="text"
              placeholder="e.g. terminals.csv or plan.xml"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
            />
          </label>
          <span className={`badge detected-kind detected-kind--${detectedKind}`}>
            Detected: {detectedKind}
          </span>
        </div>
        <label className="text-input">
          <span>Paste source text (CSV / EPLAN XML / TcECAD XML / pre-extracted PDF text)</span>
          <textarea
            rows={8}
            spellCheck={false}
            placeholder="Paste a CSV terminal list, an EPLAN/TcECAD structured XML export, or PDF text already extracted by another tool (delimit pages with '--- page N ---')..."
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Switching to text-mode invalidates any byte upload —
              // they describe different sources.
              if (bytes !== null) setBytes(null);
            }}
          />
        </label>
        {bytes !== null ? (
          <p className="muted electrical-ingestion-bytes-note" role="status">
            Binary PDF loaded ({bytes.length} bytes). Sprint 80/81 will
            attempt local PDF text-layer extraction and IO/table
            detection. <strong>OCR is not run</strong> — scanned or
            image-only PDFs may produce diagnostics
            (<code>PDF_TEXT_LAYER_EMPTY_PAGE</code>,{' '}
            <code>PDF_NO_TEXT_BLOCKS</code>) and no candidates. Press{' '}
            <strong>Ingest</strong> to start.
          </p>
        ) : null}
        <div className="electrical-ingestion-input-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xml,.pdf,text/csv,text/xml,application/xml,application/pdf"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setFileName(file.name);
              const lower = file.name.toLowerCase();
              if (lower.endsWith('.pdf')) {
                const buffer = await file.arrayBuffer();
                const u8 = new Uint8Array(buffer);
                setBytes(u8);
                setText('');
              } else {
                const content = await file.text();
                setText(content);
                setBytes(null);
              }
            }}
          />
          <button
            type="button"
            className="btn"
            onClick={handleIngest}
            disabled={
              !canIngestElectricalSource({
                inputKind: detectedKind,
                sourceText: text,
                bytes,
                pending,
              })
            }
            aria-label="Ingest electrical evidence"
          >
            {pending ? 'Ingesting...' : 'Ingest'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleReset}
            aria-label="Reset workspace"
          >
            Reset
          </button>
        </div>
      </section>

      {/* Sprint 78B — session panel is always visible so the operator
          can "Load last" / "Import" before any ingestion. */}
      <ReviewSessionPanel
        snapshot={snapshot}
        saved={savedAt !== null && snapshot?.updatedAt === savedAt}
        savedAt={savedAt}
        notice={sessionNotice}
        onSaveNow={handleSaveNow}
        onLoadLast={handleLoadLast}
        onClearSaved={handleClearSaved}
        onDownloadSession={handleDownloadReviewSession}
        onImportSession={handleImportSession}
      />

      {ingestion ? (
        <>
          {/* Sprint 77 controlled mode: the workspace is the single
              source of truth for review decisions, and the panel is a
              pure presentation layer. */}
          <ElectricalReviewPanel
            candidate={ingestion.candidate}
            state={ingestion.reviewState}
            onStateChange={(next) =>
              setIngestion((prev) => (prev ? { ...prev, reviewState: next } : prev))
            }
          />

          <PirBuildPanel
            ready={previewState?.ready ?? false}
            readyReasons={previewState?.readyReasons ?? []}
            hasBuiltPir={Boolean(buildPreview?.result.pir)}
            onBuild={handleBuild}
          />

          {buildPreview ? (
            <>
              <BuildDiagnosticsPanel diagnostics={buildPreview.result.diagnostics} />
              <PirJsonPreview result={buildPreview.result} />
              <SourceMapPreview result={buildPreview.result} />
            </>
          ) : null}

          <ExportArtifactsPanel
            availability={availability}
            onDownloadReviewSession={handleDownloadReviewSession}
            onDownloadIngestionDiagnostics={handleDownloadIngestionDiagnostics}
            onDownloadPirJson={handleDownloadPirJson}
            onDownloadSourceMap={handleDownloadSourceMap}
            onDownloadBuildDiagnostics={handleDownloadBuildDiagnostics}
            onDownloadBundle={handleDownloadBundle}
          />
        </>
      ) : (
        <p className="muted">
          Provide a CSV / EPLAN XML / TcECAD XML / PDF source and press{' '}
          <strong>Ingest</strong> to start the review, or use{' '}
          <strong>Load last</strong> above to restore a saved session.
          PDF binary uploads are parsed locally for selectable text;
          <strong> OCR is not run</strong>.
        </p>
      )}
    </section>
  );
}
