// Sprint 75 — accept / reject / pending controls for one review
// item. Stateless: parent passes the current decision and an
// `onDecide` callback; the controls just render buttons.

import type {
  ReviewDecision,
  ReviewItemType,
} from '../../utils/review-state.js';

export interface ReviewDecisionControlsProps {
  itemType: ReviewItemType;
  itemId: string;
  /** Caller-friendly label for aria — e.g. tag/address. */
  itemLabel: string;
  decision: ReviewDecision;
  onDecide: (
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ) => void;
}

const DECISION_LABELS: Record<ReviewDecision, string> = {
  pending: 'Pending',
  accepted: 'Accept',
  rejected: 'Reject',
};

export function ReviewDecisionControls({
  itemType,
  itemId,
  itemLabel,
  decision,
  onDecide,
}: ReviewDecisionControlsProps): JSX.Element {
  return (
    <div
      className={`review-decision-controls review-decision--${decision}`}
      role="radiogroup"
      aria-label={`Review decision for ${itemLabel}`}
    >
      <button
        type="button"
        className="review-decision-button review-decision-button--accept"
        aria-pressed={decision === 'accepted'}
        aria-label={`Accept ${itemLabel}`}
        onClick={() => onDecide(itemType, itemId, 'accepted')}
        disabled={decision === 'accepted'}
      >
        {DECISION_LABELS.accepted}
      </button>
      <button
        type="button"
        className="review-decision-button review-decision-button--reject"
        aria-pressed={decision === 'rejected'}
        aria-label={`Reject ${itemLabel}`}
        onClick={() => onDecide(itemType, itemId, 'rejected')}
        disabled={decision === 'rejected'}
      >
        {DECISION_LABELS.rejected}
      </button>
      <button
        type="button"
        className="review-decision-button review-decision-button--reset"
        aria-pressed={decision === 'pending'}
        aria-label={`Reset ${itemLabel} to pending`}
        onClick={() => onDecide(itemType, itemId, 'pending')}
        disabled={decision === 'pending'}
      >
        {DECISION_LABELS.pending}
      </button>
    </div>
  );
}
