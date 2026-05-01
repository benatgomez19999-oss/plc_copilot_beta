// Sprint 98 — Parameter candidate review section. Renders a row
// per `PirParameterCandidate` with the same decision controls
// IO / Equipment use, plus a metadata card driven by Sprint 98's
// `buildParameterReviewView` helper. Source-ref drilldown
// mirrors the IO table's pattern exactly so operators have one
// muscle-memory across the panel.

import { useState } from 'react';
import type { PirParameterCandidate } from '@plccopilot/electrical-ingest';

import {
  buildParameterReviewView,
  type ParameterReviewView,
} from '../../utils/parameter-review-view.js';
import { statusBadgeClass } from '../../utils/codegen-preview-panel-view.js';
import type {
  ElectricalReviewState,
  ReviewDecision,
  ReviewItemType,
} from '../../utils/review-state.js';
import { ConfidenceBadge } from './ConfidenceBadge.js';
import { ReviewDecisionControls } from './ReviewDecisionControls.js';
import { SourceRefPanel } from './SourceRefPanel.js';

export interface ParameterCandidateReviewTableProps {
  parameters: ReadonlyArray<PirParameterCandidate>;
  state: ElectricalReviewState;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

export function ParameterCandidateReviewTable({
  parameters,
  state,
  onDecide,
}: ParameterCandidateReviewTableProps): JSX.Element {
  if (parameters.length === 0) {
    return (
      <p className="muted">
        No parameter candidates. Ingest a CSV / EPLAN export with
        explicit parameter rows / elements to populate the review
        queue.
      </p>
    );
  }
  return (
    <table className="review-table review-table--parameter">
      <thead>
        <tr>
          <th scope="col">Decision</th>
          <th scope="col">Parameter</th>
          <th scope="col">Summary</th>
          <th scope="col">Status</th>
          <th scope="col">Confidence</th>
          <th scope="col">Sources</th>
        </tr>
      </thead>
      <tbody>
        {parameters.map((candidate) => {
          const view = buildParameterReviewView(candidate);
          const decision =
            state.parameterCandidates?.[candidate.id]?.decision ?? 'pending';
          return (
            <ParameterRow
              key={candidate.id}
              candidate={candidate}
              view={view}
              decision={decision}
              onDecide={onDecide}
            />
          );
        })}
      </tbody>
    </table>
  );
}

interface ParameterRowProps {
  candidate: PirParameterCandidate;
  view: ParameterReviewView;
  decision: ReviewDecision;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

function ParameterRow({
  candidate,
  view,
  decision,
  onDecide,
}: ParameterRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const refCount = candidate.sourceRefs?.length ?? 0;
  return (
    <>
      <tr className={`review-row review-row--${decision}`}>
        <td>
          <ReviewDecisionControls
            itemType="parameter"
            itemId={candidate.id}
            itemLabel={`Parameter ${view.label}`}
            decision={decision}
            onDecide={onDecide}
          />
        </td>
        <td className="parameter-review-id-cell">
          <code className="parameter-review-id">{view.id}</code>
          {view.label !== view.id ? (
            <p className="parameter-review-label muted">{view.label}</p>
          ) : null}
        </td>
        <td className="parameter-review-summary-cell">
          <p className="parameter-review-summary">{view.summary}</p>
          <p className="parameter-review-range muted">
            {view.dataTypeLabel} · default <code>{view.defaultLabel}</code>{' '}
            · unit <code>{view.unitLabel}</code> · range{' '}
            <code>{view.rangeLabel}</code>
          </p>
        </td>
        <td className="parameter-review-badges">
          {view.badges.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <ul className="parameter-review-badge-list">
              {view.badges.map((b, i) => (
                <li key={`${candidate.id}-badge-${i}-${b.label}`}>
                  <span
                    className={statusBadgeClass(b.token)}
                    title={b.hint}
                  >
                    {b.label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </td>
        <td>
          <ConfidenceBadge confidence={candidate.confidence} />
        </td>
        <td>
          <button
            type="button"
            className="link-button"
            aria-expanded={expanded}
            aria-controls={`parameter-sources-${candidate.id}`}
            onClick={() => setExpanded((v) => !v)}
          >
            {refCount === 0
              ? 'No sources'
              : expanded
                ? `Hide ${refCount} source${refCount === 1 ? '' : 's'}`
                : `Show ${refCount} source${refCount === 1 ? '' : 's'}`}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="review-source-ref-row">
          <td colSpan={6}>
            <details className="parameter-review-details" open>
              <summary>Parameter metadata</summary>
              <ul className="parameter-review-detail-rows">
                {view.detailRows.map((r) => (
                  <li
                    key={`${candidate.id}-row-${r.label}`}
                    className="parameter-review-detail-row"
                  >
                    <span className="parameter-review-detail-label">
                      {r.label}:
                    </span>{' '}
                    <code>{r.value}</code>
                  </li>
                ))}
              </ul>
            </details>
            <div id={`parameter-sources-${candidate.id}`}>
              <SourceRefPanel
                refs={candidate.sourceRefs ?? []}
                ariaLabel={`Source evidence for parameter ${candidate.id}`}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
