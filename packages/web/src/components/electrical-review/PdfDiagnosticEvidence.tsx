// Sprint 83E → 83F — PDF source-evidence drilldown for diagnostics.
//
// The Sprint 83D rollup message carries a compressed page phrase
// ("pages 80–86", "pages 3, 49–54"). Sprint 83F threads
// per-page `SourceRef` evidence through the diagnostic's
// optional `additionalSourceRefs` array; this component
// surfaces it as a per-page list when available and falls
// back to the Sprint 83E representative-only notice when not.
//
// No page-region preview / bbox overlay yet — that's a future
// sprint and would require canvas rendering on top of pdfjs in
// the web app, which Sprint 83F intentionally does not introduce.

import { useState } from 'react';

import type { PdfDiagnosticEvidenceSummary } from '../../utils/pdf-rollup-evidence.js';

export interface PdfDiagnosticEvidenceProps {
  summary: PdfDiagnosticEvidenceSummary;
}

export function PdfDiagnosticEvidence({
  summary,
}: PdfDiagnosticEvidenceProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const pageCountLabel =
    summary.pages.length > 1
      ? `${summary.pages.length} pages`
      : summary.pages.length === 1
        ? '1 page'
        : 'no pages';
  return (
    <div className="pdf-diagnostic-evidence" data-testid="pdf-diagnostic-evidence">
      <button
        type="button"
        className="pdf-diagnostic-evidence-toggle"
        aria-expanded={open}
        aria-controls={`pdf-evidence-${summary.key}`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide PDF evidence' : 'Show PDF evidence'}
        <span className="muted"> · {pageCountLabel}</span>
        {summary.compactLabel ? (
          <span className="muted"> · {summary.compactLabel}</span>
        ) : null}
      </button>
      {open ? (
        <div
          id={`pdf-evidence-${summary.key}`}
          className="pdf-diagnostic-evidence-body"
          role="region"
          aria-label="PDF source evidence"
        >
          {summary.representativeOnly ? (
            <p
              className="pdf-evidence-representative-notice"
              role="note"
            >
              Representative evidence only — the rollup covers{' '}
              {summary.pagesHumanLabel || 'multiple pages'}, but the source
              reference points at the first page where the canonical section
              was detected. Per-page drilldown is not yet available.
            </p>
          ) : null}
          {summary.pages.length > 0 ? (
            <p className="pdf-evidence-page-list muted">
              Pages: {summary.pages.join(', ')}
            </p>
          ) : null}
          {summary.perPageEvidence.length > 1 ? (
            <ul
              className="pdf-evidence-per-page"
              aria-label="Per-page PDF evidence"
            >
              {summary.perPageEvidence.map((entry) => (
                <li key={entry.key} className="pdf-evidence-per-page-item">
                  <h5 className="pdf-evidence-per-page-title">
                    Page {entry.page}
                  </h5>
                  <dl className="pdf-evidence-fields">
                    {entry.summary.fields.map((f) => (
                      <div key={f.key} className="pdf-evidence-field">
                        <dt>{f.label}</dt>
                        <dd>{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <dl className="pdf-evidence-fields">
              {summary.representativeSourceRef.fields.map((f) => (
                <div key={f.key} className="pdf-evidence-field">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </div>
  );
}
