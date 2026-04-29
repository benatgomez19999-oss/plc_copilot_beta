// Sprint 85 — Electrical graph / PIR hardening v0.
//
// Pure / DOM-free / total. The Sprint 76 PIR builder walks
// accepted candidates one-by-one, emits per-item diagnostics
// (`PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS`,
// `PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID`, …), and refuses the
// build with a generic `PIR_BUILD_EMPTY_ACCEPTED_INPUT` when
// nothing could be built. On TcECAD-style inputs this hides
// the *root cause* — operators saw "equipment invalid" + "empty
// accepted input" with no pointer to the unbuildable IO that
// triggered the cascade.
//
// Sprint 85 adds a small hardening pass that runs AFTER the
// pending/error gate and BEFORE the per-item build loops:
//
//   1. `summarizeAcceptedGraph` walks the accepted subset and
//      computes a normalised graph summary (accepted IO/equipment
//      ids, buildable vs unbuildable IO, equipment→IO references,
//      duplicates, orphans).
//
//   2. `diagnoseHardenedGraph` turns that summary into a small,
//      stable, deduplicated list of `PirBuildDiagnostic`s. Each
//      diagnostic surfaces *one* root-cause; downstream per-item
//      diagnostics still fire for context but are no longer the
//      only signal.
//
// Hard rules:
//   - No mutation of the candidate, review state, or builder
//     context.
//   - No new buildable evidence.
//   - No automatic deduplication / merging (warnings only).
//   - Diagnostics roll up by equipment to avoid per-binding
//     spam.
//   - Existing `PIR_BUILD_*` codes keep their meaning; the new
//     codes never replace them — they precede them as
//     root-cause hints.

import type {
  PirDraftCandidate,
  PirIoCandidate,
  PirEquipmentCandidate,
  SourceRef,
} from '../types.js';
import { parseCandidateAddress } from './pir-builder.js';
import {
  getReviewedDecision,
  type PirBuildReviewState,
} from './review-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Sprint 85 — root-cause diagnostic codes. */
export type PirBuildHardeningDiagnosticCode =
  | 'PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO'
  | 'PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO'
  | 'PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO'
  | 'PIR_BUILD_ACCEPTED_IO_ORPHANED'
  | 'PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED'
  | 'PIR_BUILD_DUPLICATE_IO_ADDRESS'
  | 'PIR_BUILD_DUPLICATE_IO_TAG'
  | 'PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING';

export interface HardeningDiagnostic {
  code: PirBuildHardeningDiagnosticCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  candidateId?: string;
  sourceRefs?: SourceRef[];
}

export interface HardenedGraphSummary {
  /** Candidate ids of IO marked accepted in the review state. */
  acceptedIoIds: ReadonlySet<string>;
  /** Candidate ids of equipment marked accepted. */
  acceptedEquipmentIds: ReadonlySet<string>;
  /**
   * Subset of `acceptedIoIds` whose `address` would parse
   * cleanly via `parseCandidateAddress`. Strict-address PDF
   * channel markers, raw TwinCAT structured-address strings,
   * and IO with no address all fall out of this set.
   */
  buildableIoIds: ReadonlySet<string>;
  /** Accepted IO that fails address parsing (root cause for cascades). */
  unbuildableAcceptedIoIds: ReadonlySet<string>;
  /** Map: parsed-address-key → list of accepted IO candidate ids. */
  duplicateIoAddressGroups: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Map: normalised tag/label → list of accepted IO candidate ids. */
  duplicateIoTagGroups: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Equipment id → list of IO candidate ids referenced via `ioBindings`. */
  equipmentReferences: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Accepted equipment whose `ioBindings` reference an unknown IO id. */
  equipmentMissingIoRefs: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Accepted equipment whose refs point at an IO that exists but wasn't accepted. */
  equipmentUnacceptedIoRefs: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Accepted equipment whose refs point at an accepted-but-unbuildable IO. */
  equipmentUnbuildableIoRefs: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Accepted IO not referenced by any accepted equipment. */
  orphanIoIds: ReadonlySet<string>;
  /** Accepted equipment with no references at all OR no buildable references. */
  orphanEquipmentIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Sprint 85 — produce a hardened summary of the accepted graph.
 * Pure / total. Inputs are not mutated.
 */
export function summarizeAcceptedGraph(
  candidate: PirDraftCandidate,
  state: PirBuildReviewState,
): HardenedGraphSummary {
  const ioCandidates: ReadonlyArray<PirIoCandidate> = candidate?.io ?? [];
  const equipmentCandidates: ReadonlyArray<PirEquipmentCandidate> =
    candidate?.equipment ?? [];

  const allIoIds = new Set<string>();
  for (const io of ioCandidates) allIoIds.add(io.id);

  const acceptedIoIds = new Set<string>();
  const acceptedEquipmentIds = new Set<string>();
  for (const io of ioCandidates) {
    if (getReviewedDecision(state, 'io', io.id) === 'accepted') {
      acceptedIoIds.add(io.id);
    }
  }
  for (const eq of equipmentCandidates) {
    if (getReviewedDecision(state, 'equipment', eq.id) === 'accepted') {
      acceptedEquipmentIds.add(eq.id);
    }
  }

  // Buildable accepted IO = address is a non-empty string AND
  // `parseCandidateAddress` returns a non-null value. We test the
  // address only — direction / label issues are surfaced by the
  // existing per-item diagnostics in the build loop.
  const buildableIoIds = new Set<string>();
  const unbuildableAcceptedIoIds = new Set<string>();
  const acceptedIoByAddressKey = new Map<string, string[]>();
  const acceptedIoByTagKey = new Map<string, string[]>();
  for (const io of ioCandidates) {
    if (!acceptedIoIds.has(io.id)) continue;
    const parsed =
      typeof io.address === 'string' && io.address.length > 0
        ? parseCandidateAddress(io.address)
        : null;
    if (parsed) {
      buildableIoIds.add(io.id);
      // Address dedup key — memory area + offsets give a stable
      // "same physical address" signal across naming variants.
      const key = parsedAddressKey(parsed);
      const list = acceptedIoByAddressKey.get(key) ?? [];
      list.push(io.id);
      acceptedIoByAddressKey.set(key, list);
    } else {
      unbuildableAcceptedIoIds.add(io.id);
    }
    // Tag dedup key — trim + lowercase the label, when present.
    const tagKey = normaliseTagKey(io.label);
    if (tagKey.length > 0) {
      const list = acceptedIoByTagKey.get(tagKey) ?? [];
      list.push(io.id);
      acceptedIoByTagKey.set(tagKey, list);
    }
  }

  const duplicateIoAddressGroups = new Map<string, ReadonlyArray<string>>();
  for (const [key, ids] of acceptedIoByAddressKey) {
    if (ids.length > 1) duplicateIoAddressGroups.set(key, ids.slice());
  }
  const duplicateIoTagGroups = new Map<string, ReadonlyArray<string>>();
  for (const [key, ids] of acceptedIoByTagKey) {
    if (ids.length > 1) duplicateIoTagGroups.set(key, ids.slice());
  }

  // Walk equipment and classify each io binding ref.
  const equipmentReferences = new Map<string, ReadonlyArray<string>>();
  const equipmentMissingIoRefs = new Map<string, ReadonlyArray<string>>();
  const equipmentUnacceptedIoRefs = new Map<string, ReadonlyArray<string>>();
  const equipmentUnbuildableIoRefs = new Map<string, ReadonlyArray<string>>();
  const referencedAcceptedIo = new Set<string>();
  for (const eq of equipmentCandidates) {
    if (!acceptedEquipmentIds.has(eq.id)) continue;
    const refs: string[] = [];
    const missing: string[] = [];
    const unaccepted: string[] = [];
    const unbuildable: string[] = [];
    for (const ioId of Object.values(eq.ioBindings ?? {})) {
      if (typeof ioId !== 'string' || ioId.length === 0) continue;
      refs.push(ioId);
      if (!allIoIds.has(ioId)) {
        missing.push(ioId);
        continue;
      }
      if (!acceptedIoIds.has(ioId)) {
        unaccepted.push(ioId);
        continue;
      }
      if (!buildableIoIds.has(ioId)) {
        unbuildable.push(ioId);
        continue;
      }
      // Buildable + accepted reference.
      referencedAcceptedIo.add(ioId);
    }
    equipmentReferences.set(eq.id, refs);
    if (missing.length > 0) equipmentMissingIoRefs.set(eq.id, missing);
    if (unaccepted.length > 0) equipmentUnacceptedIoRefs.set(eq.id, unaccepted);
    if (unbuildable.length > 0)
      equipmentUnbuildableIoRefs.set(eq.id, unbuildable);
  }

  const orphanIoIds = new Set<string>();
  for (const ioId of acceptedIoIds) {
    if (!referencedAcceptedIo.has(ioId)) orphanIoIds.add(ioId);
  }
  const orphanEquipmentIds = new Set<string>();
  for (const eqId of acceptedEquipmentIds) {
    const refs = equipmentReferences.get(eqId) ?? [];
    if (refs.length === 0) {
      orphanEquipmentIds.add(eqId);
      continue;
    }
    const buildableHits = refs.filter((id) => buildableIoIds.has(id));
    if (buildableHits.length === 0) orphanEquipmentIds.add(eqId);
  }

  return {
    acceptedIoIds,
    acceptedEquipmentIds,
    buildableIoIds,
    unbuildableAcceptedIoIds,
    duplicateIoAddressGroups,
    duplicateIoTagGroups,
    equipmentReferences,
    equipmentMissingIoRefs,
    equipmentUnacceptedIoRefs,
    equipmentUnbuildableIoRefs,
    orphanIoIds,
    orphanEquipmentIds,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Sprint 85 — produce a deduplicated, deterministic list of
 * hardening diagnostics from a summary. The list is ordered:
 *
 *   1. Per-equipment root-cause diagnostics (missing → unaccepted
 *      → unbuildable). One diagnostic per equipment per
 *      classification.
 *   2. Duplicate-address warnings (one per group).
 *   3. Duplicate-tag info diagnostics (one per group).
 *   4. Orphan IO info (single rolled-up diagnostic).
 *   5. Orphan equipment warnings (one per equipment).
 *   6. `PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING` warning when
 *      accepted-IO set is non-empty but buildable-IO set is empty.
 */
export function diagnoseHardenedGraph(
  candidate: PirDraftCandidate,
  summary: HardenedGraphSummary,
): HardeningDiagnostic[] {
  const out: HardeningDiagnostic[] = [];
  const equipmentById = new Map<string, PirEquipmentCandidate>();
  for (const eq of candidate?.equipment ?? []) equipmentById.set(eq.id, eq);
  const ioById = new Map<string, PirIoCandidate>();
  for (const io of candidate?.io ?? []) ioById.set(io.id, io);

  // Stable iteration: walk equipment in insertion order.
  for (const eq of candidate?.equipment ?? []) {
    if (!summary.acceptedEquipmentIds.has(eq.id)) continue;
    const missing = summary.equipmentMissingIoRefs.get(eq.id);
    if (missing && missing.length > 0) {
      out.push({
        code: 'PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO',
        severity: 'error',
        message:
          `Accepted equipment ${eq.id} references IO id(s) that don't exist in the candidate: ` +
          formatIdList(missing) +
          '.',
        candidateId: eq.id,
        sourceRefs: eq.sourceRefs,
      });
    }
    const unaccepted = summary.equipmentUnacceptedIoRefs.get(eq.id);
    if (unaccepted && unaccepted.length > 0) {
      out.push({
        code: 'PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO',
        severity: 'warning',
        message:
          `Accepted equipment ${eq.id} references IO that exist in the candidate but were not accepted: ` +
          formatIdList(unaccepted) +
          '. Accept those IO or remove the binding before building.',
        candidateId: eq.id,
        sourceRefs: eq.sourceRefs,
      });
    }
    const unbuildable = summary.equipmentUnbuildableIoRefs.get(eq.id);
    if (unbuildable && unbuildable.length > 0) {
      out.push({
        code: 'PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO',
        severity: 'warning',
        message:
          `Accepted equipment ${eq.id} references accepted IO whose addresses cannot be mapped to PIR: ` +
          formatIdList(unbuildable) +
          '. The IO addresses are unsupported (e.g. TwinCAT structured / PDF channel-marker). ' +
          'PIR build will not include this equipment.',
        candidateId: eq.id,
        sourceRefs: eq.sourceRefs,
      });
    }
  }

  // Duplicate address groups — sorted by address key for stability.
  const addressKeys = Array.from(summary.duplicateIoAddressGroups.keys()).sort();
  for (const key of addressKeys) {
    const ids = summary.duplicateIoAddressGroups.get(key) ?? [];
    if (ids.length < 2) continue;
    const refs = collectSourceRefs(ids, ioById);
    out.push({
      code: 'PIR_BUILD_DUPLICATE_IO_ADDRESS',
      severity: 'warning',
      message:
        `Duplicate accepted IO address ${JSON.stringify(key)}: ` +
        formatIdList(ids) +
        '. The PIR builder will not silently merge duplicates — accept exactly one or rename the others.',
      sourceRefs: refs.length > 0 ? refs : undefined,
    });
  }

  // Duplicate tag groups.
  const tagKeys = Array.from(summary.duplicateIoTagGroups.keys()).sort();
  for (const key of tagKeys) {
    const ids = summary.duplicateIoTagGroups.get(key) ?? [];
    if (ids.length < 2) continue;
    out.push({
      code: 'PIR_BUILD_DUPLICATE_IO_TAG',
      severity: 'info',
      message:
        `Duplicate accepted IO tag/name ${JSON.stringify(key)}: ` +
        formatIdList(ids) +
        '.',
    });
  }

  // Orphan IO — single rolled-up diagnostic; per-IO would spam.
  if (summary.orphanIoIds.size > 0) {
    const ids = Array.from(summary.orphanIoIds).sort();
    out.push({
      code: 'PIR_BUILD_ACCEPTED_IO_ORPHANED',
      severity: 'info',
      message:
        `${ids.length} accepted IO not referenced by any accepted equipment: ` +
        formatIdList(ids) +
        '. This is normal for raw imports; the IO will appear in the PIR but is not wired to equipment.',
    });
  }

  // Orphan equipment — one warning per equipment, since each is a
  // distinct review failure (different sourceRefs, different
  // explanation).
  for (const eq of candidate?.equipment ?? []) {
    if (!summary.orphanEquipmentIds.has(eq.id)) continue;
    out.push({
      code: 'PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED',
      severity: 'warning',
      message:
        `Accepted equipment ${eq.id} has no buildable IO references — PIR build will skip it.`,
      candidateId: eq.id,
      sourceRefs: eq.sourceRefs,
    });
  }

  // Catch-all: accepted IO existed but none could be built.
  if (
    summary.acceptedIoIds.size > 0 &&
    summary.buildableIoIds.size === 0
  ) {
    out.push({
      code: 'PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING',
      severity: 'warning',
      message:
        `${summary.acceptedIoIds.size} IO accepted but none had a PIR-buildable address. ` +
        'PIR build will refuse with no IO output. Re-review address strictness or adjust source.',
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parsedAddressKey(parsed: { address: { area?: string; byte?: number; bit?: number } }): string {
  // `parseCandidateAddress` returns a `ParsedIoAddress` whose
  // `.address` carries area + byte + bit (or area + word + length
  // for word addresses). Build a stable string key from whatever
  // fields are present.
  const addr = parsed.address ?? {};
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const fields = Object.entries(addr as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`);
  return fields.join('|');
}

function normaliseTagKey(label: unknown): string {
  if (typeof label !== 'string') return '';
  return label.trim().toLowerCase();
}

function formatIdList(ids: ReadonlyArray<string>): string {
  if (ids.length === 0) return '[]';
  if (ids.length <= 5) return ids.map((id) => JSON.stringify(id)).join(', ');
  const head = ids.slice(0, 5).map((id) => JSON.stringify(id)).join(', ');
  return `${head} (+${ids.length - 5} more)`;
}

function collectSourceRefs(
  ids: ReadonlyArray<string>,
  ioById: Map<string, PirIoCandidate>,
): SourceRef[] {
  const out: SourceRef[] = [];
  for (const id of ids) {
    const io = ioById.get(id);
    if (io && Array.isArray(io.sourceRefs)) out.push(...io.sourceRefs);
  }
  return out;
}

