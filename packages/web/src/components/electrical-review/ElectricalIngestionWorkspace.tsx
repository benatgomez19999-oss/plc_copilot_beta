// Sprint 77 — top-level orchestrator for the web electrical-
// ingestion + review + PIR build flow. Self-contained: takes no
// props (Sprint 77 mounts it as a side-section under App.tsx;
// future sprints can lift state up if needed).
//
// Pipeline:
//
//   1. Operator pastes / uploads CSV or EPLAN XML.
//   2. `runElectricalIngestion` routes through the real
//      electrical-ingest registry.
//   3. `ElectricalReviewPanel` shows IO + equipment + assumptions
//      + diagnostics; operator accepts/rejects.
//   4. `PirBuildPanel` button is disabled until the gate passes.
//   5. On click, `buildPirPreview` runs and the JSON / sourceMap
//      / build diagnostics surface below.

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  PirBuildResult,
  PirDraftCandidate,
} from '@plccopilot/electrical-ingest';

import {
  detectInputKind,
  runElectricalIngestion,
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
import { BuildDiagnosticsPanel } from './BuildDiagnosticsPanel.js';
import { ElectricalReviewPanel } from './ElectricalReviewPanel.js';
import { PirBuildPanel } from './PirBuildPanel.js';
import { PirJsonPreview } from './PirJsonPreview.js';
import { SourceMapPreview } from './SourceMapPreview.js';

interface IngestionState {
  candidate: PirDraftCandidate;
  reviewState: ElectricalReviewState;
  detectedKind: DetectedInputKind;
  inputFileName: string;
}

export function ElectricalIngestionWorkspace(): JSX.Element {
  const [text, setText] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [pending, setPending] = useState<boolean>(false);
  const [ingestion, setIngestion] = useState<IngestionState | null>(null);
  const [buildPreview, setBuildPreview] = useState<PirBuildPreview | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectedKind = useMemo<DetectedInputKind>(
    () => detectInputKind(text, fileName),
    [text, fileName],
  );

  const handleIngest = useCallback(async () => {
    setPending(true);
    setBuildPreview(null);
    try {
      const sourceId =
        fileName.length > 0 ? fileName : `manual-${Date.now()}`;
      const { candidate, detectedKind: kind } = await runElectricalIngestion({
        sourceId,
        text,
        fileName: fileName.length > 0 ? fileName : undefined,
      });
      setIngestion({
        candidate,
        reviewState: createInitialReviewState(candidate),
        detectedKind: kind,
        inputFileName: fileName,
      });
    } finally {
      setPending(false);
    }
  }, [text, fileName]);

  const handleBuild = useCallback(() => {
    if (!ingestion) return;
    const preview = buildPirPreview(ingestion.candidate, ingestion.reviewState);
    setBuildPreview(preview);
  }, [ingestion]);

  const handleReset = useCallback(() => {
    setText('');
    setFileName('');
    setIngestion(null);
    setBuildPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

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
          CSV / EPLAN XML → review → PIR preview · no automatic codegen
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
          <span>Paste source text (CSV or EPLAN XML)</span>
          <textarea
            rows={8}
            spellCheck={false}
            placeholder="Paste a CSV terminal list or an EPLAN structured XML export here..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="electrical-ingestion-input-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xml,text/csv,text/xml,application/xml"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const content = await file.text();
              setText(content);
              setFileName(file.name);
            }}
          />
          <button
            type="button"
            className="btn"
            onClick={handleIngest}
            disabled={pending || text.trim().length === 0}
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
        </>
      ) : (
        <p className="muted">
          Provide a CSV or EPLAN XML source and press <strong>Ingest</strong>{' '}
          to start the review.
        </p>
      )}
    </section>
  );
}

