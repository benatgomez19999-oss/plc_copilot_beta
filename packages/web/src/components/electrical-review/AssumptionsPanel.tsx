// Sprint 75 — assumptions panel. CRITICAL: assumptions default to
// `pending` and MUST NOT be auto-accepted. The component itself
// simply renders the items + decision controls; the
// `createInitialReviewState` helper ensures every assumption
// starts in `pending`.

import { useState } from 'react';
import type { PirMappingAssumption } from '@plccopilot/electrical-ingest';

import type {
  ElectricalReviewState,
  ReviewDecision,
  ReviewItemType,
} from '../../utils/review-state.js';
import { ConfidenceBadge } from './ConfidenceBadge.js';
import { ReviewDecisionControls } from './ReviewDecisionControls.js';
import { SourceRefPanel } from './SourceRefPanel.js';

export interface AssumptionsPanelProps {
  assumptions: ReadonlyArray<PirMappingAssumption>;
  state: ElectricalReviewState;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

export function AssumptionsPanel({
  assumptions,
  state,
  onDecide,
}: AssumptionsPanelProps): JSX.Element {
  if (assumptions.length === 0) {
    return (
      <p className="muted">
        No assumptions to review. Devices below the equipment-promotion
        threshold (confidence ≥ 0.6) appear here.
      </p>
    );
  }
  return (
    <ul className="assumption-list">
      {assumptions.map((assumption) => (
        <AssumptionItem
          key={assumption.id}
          assumption={assumption}
          decision={
            state.assumptions[assumption.id]?.decision ?? 'pending'
          }
          onDecide={onDecide}
        />
      ))}
    </ul>
  );
}

interface AssumptionItemProps {
  assumption: PirMappingAssumption;
  decision: ReviewDecision;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

function AssumptionItem({
  assumption,
  decision,
  onDecide,
}: AssumptionItemProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const refCount = assumption.sourceRefs?.length ?? 0;
  return (
    <li
      className={`assumption-item assumption-item--${decision}`}
      aria-label={`Assumption ${assumption.id}`}
    >
      <div className="assumption-header">
        <ReviewDecisionControls
          itemType="assumption"
          itemId={assumption.id}
          itemLabel={`Assumption ${assumption.id}`}
          decision={decision}
          onDecide={onDecide}
        />
        <ConfidenceBadge confidence={assumption.confidence} />
      </div>
      <p className="assumption-message">{assumption.message}</p>
      <div className="assumption-footer">
        <button
          type="button"
          className="link-button"
          aria-expanded={expanded}
          aria-controls={`assumption-sources-${assumption.id}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {refCount === 0
            ? 'No sources'
            : expanded
              ? `Hide ${refCount} source${refCount === 1 ? '' : 's'}`
              : `Show ${refCount} source${refCount === 1 ? '' : 's'}`}
        </button>
      </div>
      {expanded ? (
        <div id={`assumption-sources-${assumption.id}`} className="assumption-sources">
          <SourceRefPanel
            refs={assumption.sourceRefs ?? []}
            ariaLabel={`Source evidence for assumption ${assumption.id}`}
          />
        </div>
      ) : null}
    </li>
  );
}
