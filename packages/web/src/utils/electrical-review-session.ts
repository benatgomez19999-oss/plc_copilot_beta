// Sprint 78B — pure session-snapshot helpers for the electrical-review
// workspace. The snapshot is the single piece of state the UI persists
// + serialises + reimports; everything else (PIR JSON, sourceMap,
// diagnostics) is derived. Helpers here MUST be:
//
//   - pure / deterministic when callers thread `nowIso`,
//   - DOM-free (Node-friendly for vitest `environment: 'node'`),
//   - defensive on restore (never throw on malformed input).
//
// Privacy invariant (Sprint 78B):
//   Raw source content is NEVER persisted by default. Operators can
//   add notes / metadata, but the original CSV/XML body is dropped.
//   Electrical drawings can be confidential — the v0 default is
//   "save only what we need to restore the review".
//
// Architectural invariant:
//   No prompt-style inference here. The snapshot only carries
//   structured evidence (candidate, reviewState, diagnostics) +
//   optional build result. A weak prompt cannot rewrite this file.
import type {
  ElectricalDiagnostic,
  PirBuildResult,
  PirDraftCandidate,
  SourceRef,
} from '@plccopilot/electrical-ingest';
import type { PirBuildDiagnostic } from '@plccopilot/electrical-ingest';

import type { DetectedInputKind } from './electrical-ingestion-flow.js';
import {
  createInitialReviewState,
  type ElectricalReviewState,
  type ReviewDecision,
  type ReviewItemType,
} from './review-state.js';

export const REVIEW_SESSION_SCHEMA_VERSION =
  'electrical-review-session.v1' as const;

/**
 * Sprint 78B v0 snapshot. The `schemaVersion` literal is checked on
 * restore so a future v2 reader can refuse v1 (or migrate). The
 * `build` field is optional — present iff the operator has pressed
 * "Build PIR" at least once during the session.
 */
export interface ElectricalReviewSessionSnapshot {
  schemaVersion: typeof REVIEW_SESSION_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  source: ElectricalReviewSessionSource;
  candidate: PirDraftCandidate;
  reviewState: ElectricalReviewState;
  ingestionDiagnostics: ElectricalDiagnostic[];
  build?: ElectricalReviewSessionBuild;
  notes?: string;
}

export interface ElectricalReviewSessionSource {
  sourceId: string;
  fileName?: string;
  /** From `detectInputKind` — 'csv' | 'xml' | 'unknown'. */
  inputKind: DetectedInputKind;
  /** Resolved by the registry — e.g. 'csv' / 'eplan-export' / 'twincat_ecad'. */
  sourceKind?: string;
  /** Lightweight FNV-1a hex of the raw input, for local identity. */
  contentHash?: string;
}

export interface ElectricalReviewSessionBuild {
  attemptedAt: string;
  /** Stored as unknown so restore stays defensive — caller validates. */
  pir?: unknown;
  diagnostics: PirBuildDiagnostic[];
  sourceMap?: Record<string, SourceRef[]>;
  acceptedInputCounts?: PirBuildResult['acceptedInputCounts'];
  skippedInputCounts?: PirBuildResult['skippedInputCounts'];
}

/**
 * Per-decision-bag counts. Cheap to derive; cached on the snapshot
 * for export/UX previews so consumers don't have to re-walk
 * `reviewState`.
 */
export interface ReviewDecisionCounts {
  io: ReviewBagCounts;
  equipment: ReviewBagCounts;
  assumption: ReviewBagCounts;
  total: ReviewBagCounts;
}

export interface ReviewBagCounts {
  pending: number;
  accepted: number;
  rejected: number;
  total: number;
}

// =============================================================================
// Lightweight content hash (FNV-1a 32-bit, hex-padded)
// =============================================================================

/**
 * Deterministic 32-bit FNV-1a over UTF-16 code units. Hex-padded
 * to 8 chars. Not cryptographic — good enough to flag "this is
 * the same source we just saved" for local identity. No `crypto`
 * dependency needed.
 */
export function lightweightContentHash(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '00000000';
  let hash = 0x811c9dc5; // offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    // 32-bit FNV prime multiply, kept inside Uint32 range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// =============================================================================
// Snapshot creation
// =============================================================================

export interface CreateReviewSessionSnapshotInput {
  source: ElectricalReviewSessionSource;
  candidate: PirDraftCandidate;
  reviewState: ElectricalReviewState;
  ingestionDiagnostics: readonly ElectricalDiagnostic[];
  build?: ElectricalReviewSessionBuild;
  notes?: string;
  /**
   * ISO 8601 string used for `updatedAt` (and `createdAt` on a
   * brand-new snapshot). Tests inject a fixed value; production
   * callers pass `new Date().toISOString()`.
   */
  nowIso: string;
  /**
   * Explicit `createdAt` to carry forward across autosaves of the
   * same session. When omitted, defaults to `nowIso`. The workspace
   * passes the original ingestion timestamp here so the snapshot's
   * `createdAt` stays stable while `updatedAt` advances.
   */
  createdAtIso?: string;
  /**
   * Optional previous snapshot. If supplied, `createdAt` is carried
   * forward (overrides `createdAtIso`) — useful for autosave patterns
   * where the same session is updated as the operator makes decisions.
   */
  previous?: ElectricalReviewSessionSnapshot | null;
}

/**
 * Build a fresh snapshot — pure / deterministic. The candidate +
 * reviewState are deep-copied via `structuredClone` so the saved
 * shape can never be mutated by the live workspace after persistence.
 *
 * Privacy: raw source content is NOT included. Callers may pass a
 * `contentHash` via `source.contentHash` for local identity.
 */
export function createReviewSessionSnapshot(
  input: CreateReviewSessionSnapshotInput,
): ElectricalReviewSessionSnapshot {
  if (typeof input.nowIso !== 'string' || input.nowIso.length === 0) {
    throw new Error('createReviewSessionSnapshot: nowIso is required.');
  }
  const previous = input.previous ?? null;
  const createdAt =
    previous && typeof previous.createdAt === 'string' && previous.createdAt
      ? previous.createdAt
      : typeof input.createdAtIso === 'string' && input.createdAtIso.length > 0
        ? input.createdAtIso
        : input.nowIso;
  const snap: ElectricalReviewSessionSnapshot = {
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    createdAt,
    updatedAt: input.nowIso,
    source: { ...input.source },
    candidate: structuredClone(input.candidate),
    reviewState: structuredClone(input.reviewState),
    ingestionDiagnostics: input.ingestionDiagnostics.map((d) =>
      structuredClone(d),
    ),
  };
  if (input.build) snap.build = structuredClone(input.build);
  if (typeof input.notes === 'string' && input.notes.length > 0) {
    snap.notes = input.notes;
  }
  return snap;
}

/**
 * Convenience: derive a `ElectricalReviewSessionBuild` from a live
 * `PirBuildResult` — strips the React-only state and pins `attemptedAt`
 * so the persisted snapshot is reproducible.
 */
export function snapshotBuildResult(
  result: PirBuildResult,
  attemptedAtIso: string,
): ElectricalReviewSessionBuild {
  if (!result || typeof result !== 'object') {
    return {
      attemptedAt: attemptedAtIso,
      diagnostics: [],
    };
  }
  const build: ElectricalReviewSessionBuild = {
    attemptedAt: attemptedAtIso,
    diagnostics: structuredClone(result.diagnostics ?? []),
  };
  if (result.pir) build.pir = structuredClone(result.pir);
  if (result.sourceMap && Object.keys(result.sourceMap).length > 0) {
    build.sourceMap = structuredClone(result.sourceMap);
  }
  if (result.acceptedInputCounts) {
    build.acceptedInputCounts = { ...result.acceptedInputCounts };
  }
  if (result.skippedInputCounts) {
    build.skippedInputCounts = { ...result.skippedInputCounts };
  }
  return build;
}

// =============================================================================
// Decision counts (pure projection)
// =============================================================================

const EMPTY_BAG: ReviewBagCounts = Object.freeze({
  pending: 0,
  accepted: 0,
  rejected: 0,
  total: 0,
});

function tally(
  ids: readonly string[],
  bag: Record<string, { decision?: ReviewDecision }>,
): ReviewBagCounts {
  const out: ReviewBagCounts = { pending: 0, accepted: 0, rejected: 0, total: 0 };
  for (const id of ids) {
    out.total++;
    const dec = bag[id]?.decision ?? 'pending';
    if (dec === 'accepted') out.accepted++;
    else if (dec === 'rejected') out.rejected++;
    else out.pending++;
  }
  return out;
}

/**
 * Roll up review decisions per bag + total. Pure / deterministic.
 * Used by ReviewSessionPanel to render "12 accepted / 3 pending"
 * badges without re-walking the candidate.
 */
export function summarizeReviewDecisionCounts(
  candidate: PirDraftCandidate,
  state: ElectricalReviewState,
): ReviewDecisionCounts {
  if (!candidate || typeof candidate !== 'object' || !state) {
    return {
      io: { ...EMPTY_BAG },
      equipment: { ...EMPTY_BAG },
      assumption: { ...EMPTY_BAG },
      total: { ...EMPTY_BAG },
    };
  }
  const ioIds = (candidate.io ?? []).map((i) => i.id);
  const eqIds = (candidate.equipment ?? []).map((e) => e.id);
  const asIds = (candidate.assumptions ?? []).map((a) => a.id);
  const io = tally(ioIds, state.ioCandidates ?? {});
  const equipment = tally(eqIds, state.equipmentCandidates ?? {});
  const assumption = tally(asIds, state.assumptions ?? {});
  return {
    io,
    equipment,
    assumption,
    total: {
      pending: io.pending + equipment.pending + assumption.pending,
      accepted: io.accepted + equipment.accepted + assumption.accepted,
      rejected: io.rejected + equipment.rejected + assumption.rejected,
      total: io.total + equipment.total + assumption.total,
    },
  };
}

// =============================================================================
// Restore
// =============================================================================

export type RestoreReviewSessionResult =
  | { ok: true; snapshot: ElectricalReviewSessionSnapshot }
  | { ok: false; reason: string };

/**
 * Defensive restore — never throws. Returns a discriminated result
 * so callers can render a clear message to the operator on every
 * failure mode.
 *
 * Validation order:
 *   1. value must be a non-null object.
 *   2. `schemaVersion` must equal v1 literal.
 *   3. `createdAt` / `updatedAt` must be non-empty strings.
 *   4. `source` must be an object with a non-empty `sourceId` + a
 *      known `inputKind`.
 *   5. `candidate` must look like a `PirDraftCandidate` (object with
 *      array-shaped io/equipment/assumptions).
 *   6. `reviewState` must look like an `ElectricalReviewState` (the
 *      three required record bags).
 *   7. `ingestionDiagnostics` must be an array.
 *   8. `build` (when present) must have an array `diagnostics`.
 *
 * Per-row shape (e.g. PirIoCandidate fields) is NOT checked — the
 * domain helpers tolerate missing optional fields, and over-validating
 * here would couple this file to every candidate-row schema change.
 */
export function restoreReviewSessionSnapshot(
  raw: unknown,
): RestoreReviewSessionResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'snapshot is not an object' };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported schemaVersion (got ${JSON.stringify(o.schemaVersion)}, want ${REVIEW_SESSION_SCHEMA_VERSION})`,
    };
  }
  if (typeof o.createdAt !== 'string' || o.createdAt.length === 0) {
    return { ok: false, reason: 'createdAt missing or empty' };
  }
  if (typeof o.updatedAt !== 'string' || o.updatedAt.length === 0) {
    return { ok: false, reason: 'updatedAt missing or empty' };
  }
  if (!isSourceShape(o.source)) {
    return { ok: false, reason: 'source missing or malformed' };
  }
  if (!isCandidateShape(o.candidate)) {
    return { ok: false, reason: 'candidate missing or malformed' };
  }
  if (!isReviewStateShape(o.reviewState)) {
    return { ok: false, reason: 'reviewState missing or malformed' };
  }
  if (!Array.isArray(o.ingestionDiagnostics)) {
    return { ok: false, reason: 'ingestionDiagnostics is not an array' };
  }
  if (o.build !== undefined && !isBuildShape(o.build)) {
    return { ok: false, reason: 'build present but malformed' };
  }
  // Re-clone defensively so the live workspace never aliases the
  // restored payload (callers may pass parsed JSON we don't own).
  const snapshot = structuredClone(o) as unknown as ElectricalReviewSessionSnapshot;
  return { ok: true, snapshot };
}

function isSourceShape(v: unknown): v is ElectricalReviewSessionSource {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.sourceId !== 'string' || o.sourceId.length === 0) return false;
  if (
    o.inputKind !== 'csv' &&
    o.inputKind !== 'xml' &&
    o.inputKind !== 'pdf' &&
    o.inputKind !== 'unknown'
  ) {
    return false;
  }
  return true;
}

function isCandidateShape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  // Each bag must be an array if present (allowed to be undefined —
  // matches the domain shape where empty arrays default-out via `?? []`).
  if (o.io !== undefined && !Array.isArray(o.io)) return false;
  if (o.equipment !== undefined && !Array.isArray(o.equipment)) return false;
  if (o.assumptions !== undefined && !Array.isArray(o.assumptions)) return false;
  if (o.diagnostics !== undefined && !Array.isArray(o.diagnostics)) return false;
  return true;
}

function isReviewStateShape(v: unknown): v is ElectricalReviewState {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isPlainRecord(o.ioCandidates) &&
    isPlainRecord(o.equipmentCandidates) &&
    isPlainRecord(o.assumptions)
  );
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isBuildShape(v: unknown): v is ElectricalReviewSessionBuild {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.attemptedAt !== 'string' || o.attemptedAt.length === 0) {
    return false;
  }
  if (!Array.isArray(o.diagnostics)) return false;
  if (o.sourceMap !== undefined && !isPlainRecord(o.sourceMap)) return false;
  return true;
}

// =============================================================================
// Initial review state for a restored candidate (defensive)
// =============================================================================

/**
 * Recompute initial review state from a restored candidate. Used when
 * the saved `reviewState` is somehow out of sync with the candidate
 * (e.g. ids drifted between sessions). Pure / deterministic.
 */
export function reviewStateFor(
  candidate: PirDraftCandidate,
): ElectricalReviewState {
  return createInitialReviewState(candidate);
}

/**
 * Walk decisionCounts across `(itemType, id)` pairs that exist in
 * the candidate but are missing in the saved state — re-defaulted
 * to `pending`. Pure. Returns a new state.
 */
export function reconcileReviewState(
  candidate: PirDraftCandidate,
  state: ElectricalReviewState,
): ElectricalReviewState {
  const next: ElectricalReviewState = {
    ioCandidates: { ...(state?.ioCandidates ?? {}) },
    equipmentCandidates: { ...(state?.equipmentCandidates ?? {}) },
    assumptions: { ...(state?.assumptions ?? {}) },
  };
  fill(next.ioCandidates, candidate.io ?? [], 'io');
  fill(next.equipmentCandidates, candidate.equipment ?? [], 'equipment');
  fill(next.assumptions, candidate.assumptions ?? [], 'assumption');
  return next;
}

function fill(
  bag: Record<string, { id: string; decision: ReviewDecision; note?: string }>,
  rows: ReadonlyArray<{ id: string }>,
  _type: ReviewItemType,
): void {
  for (const r of rows) {
    if (!bag[r.id]) bag[r.id] = { id: r.id, decision: 'pending' };
  }
}
