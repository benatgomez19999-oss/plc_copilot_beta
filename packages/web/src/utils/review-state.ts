// Sprint 75 — pure review-state helpers for the electrical-review
// panel. Industrial invariant: nothing leaves a 'pending' state
// without an explicit human decision; nothing under 'rejected' may
// later flow into PIR generation. The helpers are immutable +
// deterministic so the eventual UI never has to reason about race
// conditions.
//
// Sprint 75 keeps state in-memory only — no persistence, no auth.
// Future sprints can layer either of those on top without changing
// these helpers.

import type {
  ElectricalDiagnostic,
  PirDraftCandidate,
  PirEquipmentCandidate,
  PirIoCandidate,
  PirMappingAssumption,
  PirParameterCandidate,
} from '@plccopilot/electrical-ingest';

import { classifyConfidence } from './review-confidence.js';

export type ReviewDecision = 'pending' | 'accepted' | 'rejected';

export const REVIEW_DECISIONS = Object.freeze<ReviewDecision[]>([
  'pending',
  'accepted',
  'rejected',
]);

// Sprint 88L — `parameter` joins the bag types so a parameter
// candidate can be reviewed independently of equipment / IO.
export type ReviewItemType = 'io' | 'equipment' | 'assumption' | 'parameter';

export interface ReviewedItemState {
  id: string;
  decision: ReviewDecision;
  /** Optional human comment captured at decision time. */
  note?: string;
}

export interface ElectricalReviewState {
  ioCandidates: Record<string, ReviewedItemState>;
  equipmentCandidates: Record<string, ReviewedItemState>;
  assumptions: Record<string, ReviewedItemState>;
  /**
   * Sprint 88L — parameter candidate decisions. Optional so a state
   * persisted by an older session (no parameter rows) is still
   * readable; readers default to `'pending'` when the bag is
   * undefined.
   */
  parameterCandidates?: Record<string, ReviewedItemState>;
}

/**
 * Build the initial review state for a candidate. All items default
 * to `pending` — assumptions in particular MUST NOT default to
 * `accepted`, that is the architectural invariant.
 */
export function createInitialReviewState(
  candidate: PirDraftCandidate,
): ElectricalReviewState {
  const state: ElectricalReviewState = {
    ioCandidates: {},
    equipmentCandidates: {},
    assumptions: {},
  };
  for (const io of candidate.io ?? []) {
    state.ioCandidates[io.id] = { id: io.id, decision: 'pending' };
  }
  for (const eq of candidate.equipment ?? []) {
    state.equipmentCandidates[eq.id] = { id: eq.id, decision: 'pending' };
  }
  for (const a of candidate.assumptions ?? []) {
    state.assumptions[a.id] = { id: a.id, decision: 'pending' };
  }
  // Sprint 88L — only seed the parameter bag when the candidate
  // actually carries parameters; legacy candidates keep an
  // undefined `parameterCandidates` field so older snapshots round-
  // trip cleanly through structuredClone / JSON.
  const params = candidate.parameters ?? [];
  if (params.length > 0) {
    state.parameterCandidates = {};
    for (const p of params) {
      state.parameterCandidates[p.id] = { id: p.id, decision: 'pending' };
    }
  }
  return state;
}

/**
 * Immutably update a single item's decision. Returns a new state
 * object; the input is never mutated. Unknown item ids are
 * created fresh — useful when callers want to add notes to items
 * the candidate didn't initially expose (rare; mostly defensive).
 */
export function setReviewDecision(
  state: ElectricalReviewState,
  itemType: ReviewItemType,
  id: string,
  decision: ReviewDecision,
  note?: string,
): ElectricalReviewState {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('setReviewDecision: id must be a non-empty string.');
  }
  if (!REVIEW_DECISIONS.includes(decision)) {
    throw new Error(
      `setReviewDecision: decision must be one of ${REVIEW_DECISIONS.join(' | ')} (got ${JSON.stringify(decision)}).`,
    );
  }
  const next: ReviewedItemState = { id, decision };
  if (typeof note === 'string' && note.length > 0) next.note = note;

  switch (itemType) {
    case 'io':
      return {
        ...state,
        ioCandidates: { ...state.ioCandidates, [id]: next },
      };
    case 'equipment':
      return {
        ...state,
        equipmentCandidates: { ...state.equipmentCandidates, [id]: next },
      };
    case 'assumption':
      return {
        ...state,
        assumptions: { ...state.assumptions, [id]: next },
      };
    case 'parameter':
      // Sprint 88L — parameter bag is optional on legacy state
      // objects; create it on first write.
      return {
        ...state,
        parameterCandidates: {
          ...(state.parameterCandidates ?? {}),
          [id]: next,
        },
      };
    default: {
      const _exhaustive: never = itemType;
      void _exhaustive;
      return state;
    }
  }
}

/**
 * Read the decision for an item; returns `'pending'` when the item
 * is unknown to the state — keeps callers from having to handle
 * `undefined`.
 */
export function getReviewDecision(
  state: ElectricalReviewState,
  itemType: ReviewItemType,
  id: string,
): ReviewDecision {
  const bag =
    itemType === 'io'
      ? state.ioCandidates
      : itemType === 'equipment'
        ? state.equipmentCandidates
        : itemType === 'parameter'
          ? state.parameterCandidates ?? {}
          : state.assumptions;
  return bag[id]?.decision ?? 'pending';
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  total: number;
  accepted: number;
  rejected: number;
  pending: number;
  blockingDiagnostics: number;
  warnings: number;
  /** Pending items whose own confidence is `low`. Highlighted in UI. */
  lowConfidencePending: number;
}

/**
 * Roll up the candidate + state into a stable summary for the
 * panel header. Pure / deterministic.
 */
export function summarizeReviewState(
  candidate: PirDraftCandidate,
  state: ElectricalReviewState,
): ReviewSummary {
  const counts: ReviewSummary = {
    total: 0,
    accepted: 0,
    rejected: 0,
    pending: 0,
    blockingDiagnostics: 0,
    warnings: 0,
    lowConfidencePending: 0,
  };

  function tallyItem(
    item:
      | PirIoCandidate
      | PirEquipmentCandidate
      | PirMappingAssumption
      | PirParameterCandidate,
    type: ReviewItemType,
  ): void {
    counts.total++;
    const decision = getReviewDecision(state, type, item.id);
    if (decision === 'accepted') counts.accepted++;
    else if (decision === 'rejected') counts.rejected++;
    else counts.pending++;
    if (
      decision === 'pending' &&
      classifyConfidence(item.confidence?.score).level === 'low'
    ) {
      counts.lowConfidencePending++;
    }
  }

  for (const io of candidate.io ?? []) tallyItem(io, 'io');
  for (const eq of candidate.equipment ?? []) tallyItem(eq, 'equipment');
  for (const as of candidate.assumptions ?? []) tallyItem(as, 'assumption');
  // Sprint 88L — tally parameter candidates alongside the other
  // reviewable items.
  for (const p of candidate.parameters ?? []) tallyItem(p, 'parameter');

  for (const d of candidate.diagnostics ?? []) {
    if (d.severity === 'error') counts.blockingDiagnostics++;
    else if (d.severity === 'warning') counts.warnings++;
  }

  return counts;
}

/**
 * Convenience predicate for the "ready to promote to PIR" gate
 * (Sprint 76 builder consumes this). A candidate is ready when:
 *   - it has at least one reviewable item (Sprint 78A — empty
 *     candidates must not be reported as ready),
 *   - every IO + equipment + assumption is either accepted or
 *     rejected (no pending),
 *   - no `error`-severity diagnostic remains.
 *
 * Mirror of the domain helper `isReviewedCandidateReadyForPirBuild`
 * — both predicates MUST agree on semantics so the UI button and
 * the builder gate refuse the same situations.
 */
export function isReadyForPirBuilder(
  candidate: PirDraftCandidate,
  state: ElectricalReviewState,
): boolean {
  if (!hasReviewableItems(candidate)) return false;
  const summary = summarizeReviewState(candidate, state);
  return summary.pending === 0 && summary.blockingDiagnostics === 0;
}

/**
 * True if the candidate has at least one IO / equipment / assumption
 * row to review. Mirror of the domain helper's
 * `hasReviewableCandidates` — kept in web so the empty-candidate
 * UX message can be raised without crossing package boundaries.
 */
export function hasReviewableItems(candidate: PirDraftCandidate): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const io = candidate.io ?? [];
  const eq = candidate.equipment ?? [];
  const as = candidate.assumptions ?? [];
  // Sprint 88L — parameter candidates are reviewable items too.
  const params = candidate.parameters ?? [];
  return (
    io.length > 0 || eq.length > 0 || as.length > 0 || params.length > 0
  );
}

/**
 * Filter diagnostics by severity for the panel's filter chips.
 * Returns a new array; never mutates the input. Pass `null`/
 * `undefined` to keep all severities.
 */
export function filterDiagnosticsBySeverity(
  diagnostics: readonly ElectricalDiagnostic[],
  severity: ElectricalDiagnostic['severity'] | null | undefined,
): ElectricalDiagnostic[] {
  if (!severity) return [...diagnostics];
  return diagnostics.filter((d) => d.severity === severity);
}
