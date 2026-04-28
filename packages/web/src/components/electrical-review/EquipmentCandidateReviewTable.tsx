// Sprint 75 — equipment candidate review table. Mirrors the IO
// table's shape so operators have a single visual idiom for both
// kinds of candidate.

import { useState } from 'react';
import type { PirEquipmentCandidate } from '@plccopilot/electrical-ingest';

import type {
  ElectricalReviewState,
  ReviewDecision,
  ReviewItemType,
} from '../../utils/review-state.js';
import { ConfidenceBadge } from './ConfidenceBadge.js';
import { ReviewDecisionControls } from './ReviewDecisionControls.js';
import { SourceRefPanel } from './SourceRefPanel.js';

export interface EquipmentCandidateReviewTableProps {
  equipment: ReadonlyArray<PirEquipmentCandidate>;
  state: ElectricalReviewState;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

export function EquipmentCandidateReviewTable({
  equipment,
  state,
  onDecide,
}: EquipmentCandidateReviewTableProps): JSX.Element {
  if (equipment.length === 0) {
    return (
      <p className="muted">
        No equipment candidates. Equipment is only promoted at confidence
        ≥ 0.6 — lower-confidence devices stay as assumptions.
      </p>
    );
  }
  return (
    <table className="review-table review-table--equipment">
      <thead>
        <tr>
          <th scope="col">Decision</th>
          <th scope="col">Equipment id</th>
          <th scope="col">Kind</th>
          <th scope="col">IO bindings</th>
          <th scope="col">Confidence</th>
          <th scope="col">Sources</th>
        </tr>
      </thead>
      <tbody>
        {equipment.map((candidate) => (
          <EquipmentRow
            key={candidate.id}
            candidate={candidate}
            decision={
              state.equipmentCandidates[candidate.id]?.decision ?? 'pending'
            }
            onDecide={onDecide}
          />
        ))}
      </tbody>
    </table>
  );
}

interface EquipmentRowProps {
  candidate: PirEquipmentCandidate;
  decision: ReviewDecision;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

function EquipmentRow({
  candidate,
  decision,
  onDecide,
}: EquipmentRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const refCount = candidate.sourceRefs?.length ?? 0;
  const bindingsCount = Object.keys(candidate.ioBindings ?? {}).length;
  return (
    <>
      <tr className={`review-row review-row--${decision}`}>
        <td>
          <ReviewDecisionControls
            itemType="equipment"
            itemId={candidate.id}
            itemLabel={`Equipment ${candidate.id}`}
            decision={decision}
            onDecide={onDecide}
          />
        </td>
        <td>
          <code>{candidate.id}</code>
        </td>
        <td>{candidate.kind}</td>
        <td>
          {bindingsCount === 0 ? (
            <span className="muted">no IO bindings</span>
          ) : (
            <ul className="binding-list">
              {Object.entries(candidate.ioBindings).map(([role, ioId]) => (
                <li key={role}>
                  <strong>{role}</strong>: <code>{ioId}</code>
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
            aria-controls={`equipment-sources-${candidate.id}`}
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
            <div id={`equipment-sources-${candidate.id}`}>
              <SourceRefPanel
                refs={candidate.sourceRefs ?? []}
                ariaLabel={`Source evidence for equipment ${candidate.id}`}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
