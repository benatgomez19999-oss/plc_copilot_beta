// Sprint 78B — operator-facing download surface for all electrical-
// ingestion artefacts. The component itself is purely presentational;
// availability + filenames come from the pure helpers in
// `utils/electrical-review-export.ts`.

import type { ExportAvailability } from '../../utils/electrical-review-export.js';

export interface ExportArtifactsPanelProps {
  /** Which downloads should be enabled. */
  availability: ExportAvailability;
  onDownloadReviewSession: () => void;
  onDownloadIngestionDiagnostics: () => void;
  onDownloadPirJson: () => void;
  onDownloadSourceMap: () => void;
  onDownloadBuildDiagnostics: () => void;
  onDownloadBundle: () => void;
}

export function ExportArtifactsPanel({
  availability,
  onDownloadReviewSession,
  onDownloadIngestionDiagnostics,
  onDownloadPirJson,
  onDownloadSourceMap,
  onDownloadBuildDiagnostics,
  onDownloadBundle,
}: ExportArtifactsPanelProps): JSX.Element {
  return (
    <section
      className="export-artifacts-panel"
      aria-label="Download review artefacts"
    >
      <header className="panel-header">
        <h3>Download artefacts</h3>
        <span className="muted">JSON snapshots · no upload · no codegen</span>
      </header>

      <p className="muted export-artifacts-disclaimer">
        These downloads contain extracted electrical evidence and your
        review decisions. <strong>Treat them as potentially sensitive.</strong>{' '}
        PIR preview is downloadable only after a valid build; for sources
        whose addresses cannot map to PIR (e.g. structured TcECAD), the
        builder refuses honestly and only diagnostics + the review
        session remain available.
      </p>

      <ul className="export-artifacts-list">
        <li>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!availability.reviewSession}
            title={
              availability.reviewSession
                ? undefined
                : 'Ingest a source first to enable this download'
            }
            onClick={onDownloadReviewSession}
          >
            Download review session
          </button>
          <span className="muted">
            Candidate, decisions, ingestion diagnostics + build summary if any.
          </span>
        </li>
        <li>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!availability.ingestionDiagnostics}
            title={
              availability.ingestionDiagnostics
                ? undefined
                : 'Ingest a source first to enable this download'
            }
            onClick={onDownloadIngestionDiagnostics}
          >
            Download ingestion diagnostics
          </button>
          <span className="muted">
            Structured diagnostics from the registry/ingestor only.
          </span>
        </li>
        <li>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!availability.pirJson}
            title={
              availability.pirJson
                ? undefined
                : 'No valid PIR was produced — build refused'
            }
            onClick={onDownloadPirJson}
          >
            Download PIR preview JSON
          </button>
          <span className="muted">
            Only enabled when the builder produced a schema-valid PIR.
          </span>
        </li>
        <li>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!availability.sourceMap}
            title={
              availability.sourceMap
                ? undefined
                : 'No source map yet — build refused or sourceMap empty'
            }
            onClick={onDownloadSourceMap}
          >
            Download source map
          </button>
          <span className="muted">
            Per-PIR-id source-trace sidecar (preserved evidence).
          </span>
        </li>
        <li>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!availability.buildDiagnostics}
            title={
              availability.buildDiagnostics
                ? undefined
                : 'Build has not been attempted yet'
            }
            onClick={onDownloadBuildDiagnostics}
          >
            Download build diagnostics
          </button>
          <span className="muted">
            Always useful — including refusal reasons (e.g. structured
            TcECAD addresses that don&apos;t map to PIR).
          </span>
        </li>
        <li>
          <button
            type="button"
            className="btn"
            disabled={!availability.bundle}
            title={
              availability.bundle
                ? 'Download a single ZIP containing every available artefact'
                : 'Ingest a source first to enable this download'
            }
            onClick={onDownloadBundle}
          >
            Download review bundle (ZIP)
          </button>
          <span className="muted">
            Bundles every available artefact above + a{' '}
            <code>summary.json</code> index.
          </span>
        </li>
      </ul>
    </section>
  );
}
