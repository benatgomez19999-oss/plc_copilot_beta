// Sprint 88A — Cross-source duplicate detection v0.
//
// Pure / DOM-free / total / read-only. Sprint 85's
// `electrical-graph-hardening` already detects duplicate IO
// addresses, IO tags, and equipment ids inside a single
// candidate. This helper layers a *cross-source* filter on top:
// a duplicate is only flagged when the group spans ≥ 2 distinct
// `SourceRef.sourceId` values. The motivation is to surface
// conflicts that arise when accepted evidence comes from more
// than one source (CSV + EPLAN, EPLAN + TcECAD, …) — the case
// where two ingestors disagree about the same physical address
// or symbol and the operator must reconcile before trusting the
// PIR / codegen.
//
// Hard rules (mirror Sprint 85's contract):
//   - No mutation of the candidate or review state.
//   - No automatic merge / rename / address synthesis.
//   - No assumption promotion.
//   - Cross-vendor address coercion is intentionally avoided:
//     a TcECAD `GVL.iSensor1` is NOT treated as equivalent to
//     a Siemens `%I0.0`. Items with non-buildable raw addresses
//     only match when they normalise to the same exact text;
//     items with buildable addresses match when their
//     `parseCandidateAddress` output is byte-equal.
//   - Diagnostics are deterministic, deduplicated, and only
//     fired when ≥ 2 distinct `sourceId`s participate.

import type {
  PirDraftCandidate,
  PirEquipmentCandidate,
  PirIoCandidate,
  SourceRef,
} from '../types.js';
import {
  type PirBuildDiagnostic,
} from './pir-builder.js';
import { parseCandidateAddress } from './pir-builder.js';
import {
  getReviewedDecision,
  type PirBuildReviewState,
} from './review-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CrossSourceDuplicateGroup {
  /** Stable normalised key the group was matched on (address / tag / id). */
  readonly key: string;
  /**
   * Distinct `SourceRef.sourceId` values represented in the
   * group. Always ≥ 2 (single-source groups are filtered out
   * upstream).
   */
  readonly sourceIds: ReadonlyArray<string>;
  /** Candidate ids of every accepted item in the group. */
  readonly itemIds: ReadonlyArray<string>;
  /**
   * One representative `SourceRef` per item in `itemIds`, in
   * the same order. The first occurrence per item is kept;
   * downstream UIs may render any subset.
   */
  readonly sourceRefs: ReadonlyArray<SourceRef>;
}

export interface CrossSourceDuplicateSummary {
  readonly duplicateIoAddresses: ReadonlyArray<CrossSourceDuplicateGroup>;
  readonly duplicateIoTags: ReadonlyArray<CrossSourceDuplicateGroup>;
  readonly duplicateEquipmentIds: ReadonlyArray<CrossSourceDuplicateGroup>;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Sprint 88A — derive the cross-source duplicate summary for a
 * reviewed candidate. Only `accepted` items contribute. Pure /
 * total / read-only.
 *
 * Detection rules:
 *   - **Address**: `parseCandidateAddress` is consulted first;
 *     buildable addresses group by their parsed-address key
 *     (memory area + byte + bit). Unbuildable addresses group
 *     by exact case-insensitive trimmed string — no vendor
 *     coercion.
 *   - **Tag**: `label.trim().toLowerCase()`. Empty tags skipped.
 *   - **Equipment id**: raw `eq.id` (mirrors Sprint 85 same-
 *     candidate dedup). Cross-source still requires ≥ 2
 *     distinct sourceIds.
 *   - All groups with < 2 distinct sourceIds are filtered out;
 *     they are already covered by Sprint 85's same-candidate
 *     hardening warnings.
 */
export function summarizeCrossSourceDuplicates(
  candidate: PirDraftCandidate | null | undefined,
  state: PirBuildReviewState,
): CrossSourceDuplicateSummary {
  const ioCandidates = candidate?.io ?? [];
  const equipmentCandidates = candidate?.equipment ?? [];

  const acceptedIo: PirIoCandidate[] = [];
  for (const io of ioCandidates) {
    if (getReviewedDecision(state, 'io', io.id) === 'accepted') {
      acceptedIo.push(io);
    }
  }
  const acceptedEquipment: PirEquipmentCandidate[] = [];
  for (const eq of equipmentCandidates) {
    if (getReviewedDecision(state, 'equipment', eq.id) === 'accepted') {
      acceptedEquipment.push(eq);
    }
  }

  // ---- Address bucketing ----
  const addressBuckets = new Map<string, IoBucketEntry[]>();
  for (const io of acceptedIo) {
    const key = ioAddressKey(io);
    if (key === '') continue;
    pushMapList(addressBuckets, key, {
      itemId: io.id,
      sourceIds: distinctSourceIds(io.sourceRefs),
      representativeRef: firstUsableSourceRef(io.sourceRefs),
    });
  }

  // ---- Tag bucketing ----
  const tagBuckets = new Map<string, IoBucketEntry[]>();
  for (const io of acceptedIo) {
    const key = normaliseTagKey(io.label);
    if (key === '') continue;
    pushMapList(tagBuckets, key, {
      itemId: io.id,
      sourceIds: distinctSourceIds(io.sourceRefs),
      representativeRef: firstUsableSourceRef(io.sourceRefs),
    });
  }

  // ---- Equipment id bucketing ----
  const equipmentBuckets = new Map<string, IoBucketEntry[]>();
  for (const eq of acceptedEquipment) {
    const key = (typeof eq.id === 'string' ? eq.id : '').trim();
    if (key === '') continue;
    pushMapList(equipmentBuckets, key, {
      itemId: eq.id,
      sourceIds: distinctSourceIds(eq.sourceRefs),
      representativeRef: firstUsableSourceRef(eq.sourceRefs),
    });
  }

  return {
    duplicateIoAddresses: groupsWithCrossSource(addressBuckets),
    duplicateIoTags: groupsWithCrossSource(tagBuckets),
    duplicateEquipmentIds: groupsWithCrossSource(equipmentBuckets),
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Sprint 88A — turn a `CrossSourceDuplicateSummary` into a
 * deterministic, deduplicated `PirBuildDiagnostic[]`. One
 * diagnostic per group; severity is `warning` across the board
 * (the underlying PIR validator may still hard-fail on
 * duplicate addresses, which is the correct fallback).
 */
export function diagnoseCrossSourceDuplicates(
  summary: CrossSourceDuplicateSummary,
): ReadonlyArray<PirBuildDiagnostic> {
  const out: PirBuildDiagnostic[] = [];

  for (const group of summary.duplicateIoAddresses) {
    out.push(buildDiagnostic({
      code: 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS',
      severity: 'warning',
      groupKind: 'IO address',
      group,
    }));
  }
  for (const group of summary.duplicateIoTags) {
    out.push(buildDiagnostic({
      code: 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_TAG',
      severity: 'warning',
      groupKind: 'IO tag',
      group,
    }));
  }
  for (const group of summary.duplicateEquipmentIds) {
    out.push(buildDiagnostic({
      code: 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_EQUIPMENT_ID',
      severity: 'warning',
      groupKind: 'equipment id',
      group,
    }));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface IoBucketEntry {
  itemId: string;
  sourceIds: ReadonlyArray<string>;
  representativeRef?: SourceRef;
}

function pushMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function distinctSourceIds(
  refs: ReadonlyArray<SourceRef> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    if (!r || typeof r !== 'object') continue;
    const sid = typeof r.sourceId === 'string' ? r.sourceId.trim() : '';
    if (sid === '') continue;
    if (seen.has(sid)) continue;
    seen.add(sid);
    out.push(sid);
  }
  return out;
}

function firstUsableSourceRef(
  refs: ReadonlyArray<SourceRef> | undefined,
): SourceRef | undefined {
  if (!Array.isArray(refs)) return undefined;
  for (const r of refs) {
    if (r && typeof r === 'object' && typeof r.sourceId === 'string') {
      return r;
    }
  }
  return undefined;
}

function ioAddressKey(io: PirIoCandidate): string {
  if (typeof io.address !== 'string' || io.address.length === 0) return '';
  // Buildable addresses go through `parseCandidateAddress` so
  // `%I0.0`, `%I 0.0`, and `%IX0.0` collapse to the same key
  // — exactly the behaviour Sprint 85 relies on. Unbuildable
  // raw strings (TcECAD `GVL.iSensor`, PDF channel marker text,
  // etc.) keep their textual form so we never coerce across
  // vendors.
  const parsed = parseCandidateAddress(io.address);
  if (parsed) return `parsed:${parsedAddressKey(parsed)}`;
  return `raw:${io.address.trim().toLowerCase()}`;
}

function parsedAddressKey(parsed: {
  address: { area?: string; byte?: number; bit?: number };
}): string {
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

function groupsWithCrossSource(
  buckets: ReadonlyMap<string, ReadonlyArray<IoBucketEntry>>,
): CrossSourceDuplicateGroup[] {
  const out: CrossSourceDuplicateGroup[] = [];
  for (const [key, entries] of buckets) {
    if (entries.length < 2) continue;
    const sourceIds = mergeSourceIds(entries);
    if (sourceIds.length < 2) continue;
    const itemIds = entries
      .map((e) => e.itemId)
      .sort((a, b) => a.localeCompare(b));
    const sourceRefs: SourceRef[] = [];
    const seenItem = new Set<string>();
    for (const e of entries) {
      if (seenItem.has(e.itemId)) continue;
      seenItem.add(e.itemId);
      if (e.representativeRef) sourceRefs.push(e.representativeRef);
    }
    out.push({ key, sourceIds, itemIds, sourceRefs });
  }
  // Stable order — by key, with a fallback on first item id.
  out.sort((a, b) => {
    if (a.key !== b.key) return a.key.localeCompare(b.key);
    return (a.itemIds[0] ?? '').localeCompare(b.itemIds[0] ?? '');
  });
  return out;
}

function mergeSourceIds(
  entries: ReadonlyArray<IoBucketEntry>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    for (const sid of e.sourceIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      out.push(sid);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function formatIdList(ids: ReadonlyArray<string>): string {
  if (ids.length === 0) return '[]';
  if (ids.length <= 5) return ids.map((id) => JSON.stringify(id)).join(', ');
  const head = ids.slice(0, 5).map((id) => JSON.stringify(id)).join(', ');
  return `${head} (+${ids.length - 5} more)`;
}

function buildDiagnostic(args: {
  code:
    | 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS'
    | 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_TAG'
    | 'PIR_BUILD_CROSS_SOURCE_DUPLICATE_EQUIPMENT_ID';
  severity: 'warning';
  groupKind: 'IO address' | 'IO tag' | 'equipment id';
  group: CrossSourceDuplicateGroup;
}): PirBuildDiagnostic {
  const { code, severity, groupKind, group } = args;
  const message =
    `Cross-source duplicate ${groupKind} ${JSON.stringify(group.key)}: ` +
    `items ${formatIdList(group.itemIds)} ` +
    `from sources ${formatIdList(group.sourceIds)}. ` +
    `The PIR builder will not silently merge cross-source duplicates — ` +
    `accept exactly one source for this ${groupKind} or rename / re-address the others.`;
  const out: PirBuildDiagnostic = {
    code,
    severity,
    message,
  };
  if (group.sourceRefs.length > 0) {
    out.sourceRefs = group.sourceRefs.slice();
  }
  return out;
}
