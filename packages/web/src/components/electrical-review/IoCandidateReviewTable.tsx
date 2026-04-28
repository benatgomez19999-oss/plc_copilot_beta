// Sprint 75 — IO candidate review table. Each row exposes:
//   - decision controls (accept / reject / pending)
//   - tag/address/direction/signal-type
//   - confidence badge
//   - source-ref drilldown (collapsed by default)

import { useState } from 'react';
import type { PirIoCandidate } from '@plccopilot/electrical-ingest';

import type {
  ElectricalReviewState,
  ReviewDecision,
  ReviewItemType,
} from '../../utils/review-state.js';
import { ConfidenceBadge } from './ConfidenceBadge.js';
import { ReviewDecisionControls } from './ReviewDecisionControls.js';
import { SourceRefPanel } from './SourceRefPanel.js';

export interface IoCandidateReviewTableProps {
  io: ReadonlyArray<PirIoCandidate>;
  state: ElectricalReviewState;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

export function IoCandidateReviewTable({
  io,
  state,
  onDecide,
}: IoCandidateReviewTableProps): JSX.Element {
  if (io.length === 0) {
    return (
      <p className="muted">
        No IO candidates. Ingest a CSV / EPLAN export to populate the
        review queue.
      </p>
    );
  }
  return (
    <table className="review-table review-table--io">
      <thead>
        <tr>
          <th scope="col">Decision</th>
          <th scope="col">Address</th>
          <th scope="col">Direction</th>
          <th scope="col">Signal</th>
          <th scope="col">Label</th>
          <th scope="col">Confidence</th>
          <th scope="col">Sources</th>
        </tr>
      </thead>
      <tbody>
        {io.map((candidate) => (
          <IoRow
            key={candidate.id}
            candidate={candidate}
            decision={state.ioCandidates[candidate.id]?.decision ?? 'pending'}
            onDecide={onDecide}
          />
        ))}
      </tbody>
    </table>
  );
}

interface IoRowProps {
  candidate: PirIoCandidate;
  decision: ReviewDecision;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

function IoRow({ candidate, decision, onDecide }: IoRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const refCount = candidate.sourceRefs?.length ?? 0;
  return (
    <>
      <tr className={`review-row review-row--${decision}`}>
        <td>
          <ReviewDecisionControls
            itemType="io"
            itemId={candidate.id}
            itemLabel={`IO ${candidate.address ?? candidate.label ?? candidate.id}`}
            decision={decision}
            onDecide={onDecide}
          />
        </td>
        <td>{candidate.address ?? <span className="muted">—</span>}</td>
        <td>{candidate.direction ?? <span className="muted">unknown</span>}</td>
        <td>{candidate.signalType ?? <span className="muted">unknown</span>}</td>
        <td>{candidate.label ?? <span className="muted">—</span>}</td>
        <td>
          <ConfidenceBadge confidence={candidate.confidence} />
        </td>
        <td>
          <button
            type="button"
            className="link-button"
            aria-expanded={expanded}
            aria-controls={`io-sources-${candidate.id}`}
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
          <td colSpan={7}>
            <div id={`io-sources-${candidate.id}`}>
              <SourceRefPanel
                refs={candidate.sourceRefs ?? []}
                ariaLabel={`Source evidence for IO ${candidate.id}`}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
