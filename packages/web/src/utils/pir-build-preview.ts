// Sprint 77 — wrapper around the domain-layer PIR builder for the
// web flow. Adds a UX-friendly `readyReasons` field summarising
// why a build was refused (so the React panel can show a useful
// tooltip / error block without re-deriving the same answer).

import {
  buildPirFromReviewedCandidate,
  isReviewedCandidateReadyForPirBuild,
  type PirBuildOptions,
  type PirBuildResult,
  type PirDraftCandidate,
} from '@plccopilot/electrical-ingest';

import { hasReviewableItems, type ElectricalReviewState } from './review-state.js';
import { webReviewStateToPirBuildReviewState } from './review-state-adapter.js';

export interface PirBuildPreview {
  /**
   * The full builder result. `pir` is `undefined` when the build
   * was refused; consult `diagnostics` and `readyReasons` for why.
   */
  result: PirBuildResult;
  /** Convenience flag: true iff the gate would let the build run. */
  ready: boolean;
  /**
   * Human-readable list of reasons the build is *not* ready —
   * empty when `ready === true`. Used by the React panel to show
   * the operator what to do next.
   */
  readyReasons: string[];
}

/**
 * Run the domain-layer builder against a web-shaped review state.
 * Returns the full builder result + a UX-friendly readiness
 * summary. Pure / never throws.
 *
 * The function does NOT short-circuit when the gate is false — it
 * still calls the builder, which produces structured diagnostics
 * (`PIR_BUILD_PENDING_REVIEW_ITEM`, `PIR_BUILD_REVIEW_NOT_READY`,
 * etc.). That way the panel always shows the same diagnostics
 * the operator would see if they pressed "Build PIR" anyway.
 */
export function buildPirPreview(
  candidate: PirDraftCandidate,
  reviewState: ElectricalReviewState,
  options?: PirBuildOptions,
): PirBuildPreview {
  const domainState = webReviewStateToPirBuildReviewState(reviewState);
  const ready = isReviewedCandidateReadyForPirBuild(candidate, domainState);
  const result = buildPirFromReviewedCandidate(
    candidate,
    domainState,
    options ?? {},
  );
  return {
    result,
    ready,
    readyReasons: collectReadyReasons(candidate, reviewState),
  };
}

/**
 * Inspect the candidate + the web review state and produce a list
 * of readable reasons the build is not ready. Empty list ⇒ ready.
 *
 *   - "N IO candidate(s) still pending review"
 *   - "N equipment candidate(s) still pending review"
 *   - "N assumption(s) still pending review"
 *   - "N error-severity ingestion diagnostic(s) blocking build"
 *
 * Used by the React panel for the disabled-button tooltip and the
 * "Build PIR" status label.
 */
export function collectReadyReasons(
  candidate: PirDraftCandidate,
  state: ElectricalReviewState,
): string[] {
  const out: string[] = [];

  // Sprint 78A — empty candidate is not ready. The reason has to
  // be raised before the per-bag counters because if there's
  // nothing to review, those counters would all read zero and the
  // UX would silently flip to "ready" — exactly the bug the real
  // Beckhoff/TwinCAT XML test surfaced.
  if (!hasReviewableItems(candidate)) {
    out.push(
      'no reviewable candidates — the ingestor extracted no IO, equipment, or assumptions from this source',
    );
    return out;
  }

  let pendingIo = 0;
  for (const io of candidate.io ?? []) {
    if ((state.ioCandidates?.[io.id]?.decision ?? 'pending') === 'pending') pendingIo++;
  }
  if (pendingIo > 0) {
    out.push(
      `${pendingIo} IO candidate${pendingIo === 1 ? '' : 's'} still pending review`,
    );
  }

  let pendingEq = 0;
  for (const eq of candidate.equipment ?? []) {
    if ((state.equipmentCandidates?.[eq.id]?.decision ?? 'pending') === 'pending') pendingEq++;
  }
  if (pendingEq > 0) {
    out.push(
      `${pendingEq} equipment candidate${pendingEq === 1 ? '' : 's'} still pending review`,
    );
  }

  let pendingAs = 0;
  for (const as of candidate.assumptions ?? []) {
    if ((state.assumptions?.[as.id]?.decision ?? 'pending') === 'pending') pendingAs++;
  }
  if (pendingAs > 0) {
    out.push(
      `${pendingAs} assumption${pendingAs === 1 ? '' : 's'} still pending review`,
    );
  }

  let errorDiags = 0;
  for (const d of candidate.diagnostics ?? []) {
    if (d.severity === 'error') errorDiags++;
  }
  if (errorDiags > 0) {
    out.push(
      `${errorDiags} error-severity ingestion diagnostic${errorDiags === 1 ? '' : 's'} blocking build`,
    );
  }

  return out;
}

/**
 * Pretty-print the built PIR for the JSON preview component. Uses
 * 2-space indent, sorted top-level keys are NOT enforced (PIR's
 * shape is canonical and order-irrelevant). Returns null when no
 * PIR is available.
 */
export function formatPirJson(result: PirBuildResult): string | null {
  if (!result.pir) return null;
  return JSON.stringify(result.pir, null, 2);
}
