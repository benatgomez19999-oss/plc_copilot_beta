// Sprint 75 — top-level composition. Renders summary header + IO
// table + equipment table + assumptions + diagnostics. State is
// kept in `useState`; pure helpers do all the actual work, so a
// future sprint can lift it out (e.g. into a context / persisted
// store) without changing this component's shape.

import { useMemo, useState } from 'react';
import type { PirDraftCandidate } from '@plccopilot/electrical-ingest';

import {
  createInitialReviewState,
  isReadyForPirBuilder,
  setReviewDecision,
  summarizeReviewState,
  type ElectricalReviewState,
  type ReviewDecision,
  type ReviewItemType,
} from '../../utils/review-state.js';
import { AssumptionsPanel } from './AssumptionsPanel.js';
import { ElectricalDiagnosticsList } from './ElectricalDiagnosticsList.js';
import { EquipmentCandidateReviewTable } from './EquipmentCandidateReviewTable.js';
import { IoCandidateReviewTable } from './IoCandidateReviewTable.js';
import { ParameterCandidateReviewTable } from './ParameterCandidateReviewTable.js';

export interface ElectricalReviewPanelProps {
  candidate: PirDraftCandidate;
  /**
   * Optional initial state; if omitted, every item starts pending.
   * Useful for tests or for restoring an in-progress review.
   * Ignored when `state` (controlled mode) is provided.
   */
  initialState?: ElectricalReviewState;
  /**
   * Sprint 77 — optional controlled mode. When `state` +
   * `onStateChange` are provided, the panel becomes a pure
   * presentational view of the parent's state. When omitted, the
   * panel manages its own state via `useState` (Sprint 75 default).
   */
  state?: ElectricalReviewState;
  onStateChange?: (next: ElectricalReviewState) => void;
}

export function ElectricalReviewPanel({
  candidate,
  initialState,
  state: controlledState,
  onStateChange,
}: ElectricalReviewPanelProps): JSX.Element {
  const isControlled = controlledState !== undefined && onStateChange !== undefined;
  const [internalState, setInternalState] = useState<ElectricalReviewState>(
    () => controlledState ?? initialState ?? createInitialReviewState(candidate),
  );
  const state: ElectricalReviewState = isControlled
    ? (controlledState as ElectricalReviewState)
    : internalState;

  function handleDecide(
    itemType: ReviewItemType,
    itemId: string,
    decision: ReviewDecision,
  ): void {
    if (isControlled) {
      const next = setReviewDecision(state, itemType, itemId, decision);
      onStateChange!(next);
      return;
    }
    setInternalState((prev) => setReviewDecision(prev, itemType, itemId, decision));
  }

  const summary = useMemo(
    () => summarizeReviewState(candidate, state),
    [candidate, state],
  );
  const ready = useMemo(
    () => isReadyForPirBuilder(candidate, state),
    [candidate, state],
  );

  const parameters = candidate.parameters ?? [];
  const isEmpty =
    candidate.io.length === 0 &&
    candidate.equipment.length === 0 &&
    candidate.assumptions.length === 0 &&
    candidate.diagnostics.length === 0 &&
    parameters.length === 0;

  return (
    <section
      className="electrical-review-panel"
      aria-label={`Electrical review for candidate ${candidate.id}`}
    >
      <header className="panel-header electrical-review-header">
        <div>
          <h2>Electrical review</h2>
          <p className="muted">
            Candidate <code>{candidate.id}</code>
            {candidate.name ? <> · {candidate.name}</> : null}
          </p>
        </div>
        <ReviewSummaryHeader summary={summary} ready={ready} />
      </header>

      <p className="electrical-review-disclaimer muted">
        This is a <strong>draft candidate</strong>, not final PIR.
        Sources of truth: traceable evidence (CSV / EPLAN exports).
        Free-form prompts cannot promote anything below the
        review threshold — accept / reject explicitly.
      </p>

      {isEmpty ? (
        <p className="muted electrical-review-empty">
          No data to review yet. Ingest a CSV or EPLAN structured XML
          export to populate the review queue.
        </p>
      ) : null}

      {candidate.io.length > 0 ? (
        <section
          className="electrical-review-section"
          aria-label="IO candidates"
        >
          <h3>IO candidates ({candidate.io.length})</h3>
          <IoCandidateReviewTable
            io={candidate.io}
            state={state}
            onDecide={handleDecide}
          />
        </section>
      ) : null}

      {candidate.equipment.length > 0 ? (
        <section
          className="electrical-review-section"
          aria-label="Equipment candidates"
        >
          <h3>Equipment candidates ({candidate.equipment.length})</h3>
          <EquipmentCandidateReviewTable
            equipment={candidate.equipment}
            state={state}
            onDecide={handleDecide}
          />
        </section>
      ) : null}

      {parameters.length > 0 ? (
        <section
          className="electrical-review-section"
          aria-label="Parameter candidates"
        >
          <h3>Parameter candidates ({parameters.length})</h3>
          <p className="muted">
            Parameter metadata (data type, default, unit, min, max) is
            shown below as ingested. Sprint 97's PIR R-PR-03 enforces
            range / unit coherence on build; this view is read-only.
          </p>
          <ParameterCandidateReviewTable
            parameters={parameters}
            state={state}
            onDecide={handleDecide}
          />
        </section>
      ) : null}

      {candidate.assumptions.length > 0 ? (
        <section
          className="electrical-review-section"
          aria-label="Assumptions"
        >
          <h3>Assumptions ({candidate.assumptions.length})</h3>
          <p className="muted">
            Assumptions never default to accepted. Each one needs an
            explicit human decision before downstream steps may consume
            it.
          </p>
          <AssumptionsPanel
            assumptions={candidate.assumptions}
            state={state}
            onDecide={handleDecide}
          />
        </section>
      ) : null}

      {candidate.diagnostics.length > 0 ? (
        <ElectricalDiagnosticsList diagnostics={candidate.diagnostics} />
      ) : null}
    </section>
  );
}

interface ReviewSummaryHeaderProps {
  summary: ReturnType<typeof summarizeReviewState>;
  ready: boolean;
}

function ReviewSummaryHeader({
  summary,
  ready,
}: ReviewSummaryHeaderProps): JSX.Element {
  return (
    <div
      className="review-summary"
      role="status"
      aria-label={`Review summary: ${summary.accepted} accepted, ${summary.rejected} rejected, ${summary.pending} pending`}
    >
      <span className="badge review-summary--accepted">
        {summary.accepted} accepted
      </span>
      <span className="badge review-summary--rejected">
        {summary.rejected} rejected
      </span>
      <span className="badge review-summary--pending">
        {summary.pending} pending
      </span>
      <span className="badge review-summary--errors">
        {summary.blockingDiagnostics} blocking
      </span>
      <span className="badge review-summary--warnings">
        {summary.warnings} warnings
      </span>
      {summary.lowConfidencePending > 0 ? (
        <span className="badge review-summary--low-confidence">
          {summary.lowConfidencePending} low-confidence pending
        </span>
      ) : null}
      <span
        className={`badge review-summary--ready review-summary--ready-${ready ? 'yes' : 'no'}`}
      >
        {ready ? 'Ready for PIR builder' : 'Review required'}
      </span>
    </div>
  );
}
