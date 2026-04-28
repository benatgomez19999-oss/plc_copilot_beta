# Electrical review session format — Sprint 78B v0

> **Schema:** `electrical-review-session.v1`
>
> **Stability:** v0; backwards compatibility is **not** guaranteed
> across major schema versions. Future versions bump the
> `schemaVersion` literal and may require an explicit migration
> step.

The review-session snapshot is the single piece of state the web
workspace persists, exports, and re-imports. It carries the
*evidence* (extracted candidate + diagnostics) and the *decisions*
(your accept/reject state), plus an optional build summary. It
**deliberately omits** the raw input text — electrical drawings
can carry confidential customer/project identifiers.

The contract is defined by
[`packages/web/src/utils/electrical-review-session.ts`](../packages/web/src/utils/electrical-review-session.ts).
Tests pin the contract:
[`packages/web/tests/electrical-review-session.spec.ts`](../packages/web/tests/electrical-review-session.spec.ts).

## Schema

```ts
interface ElectricalReviewSessionSnapshot {
  schemaVersion: 'electrical-review-session.v1';
  createdAt: string;            // ISO 8601 — pinned at first save
  updatedAt: string;            // ISO 8601 — bumped on every autosave
  source: {
    sourceId: string;           // caller-supplied (file name when one)
    fileName?: string;
    inputKind: 'csv' | 'xml' | 'unknown';
    sourceKind?: string;        // resolved by the registry
                                //   ('csv' | 'eplan-export' | 'twincat_ecad')
    contentHash?: string;       // FNV-1a 32-bit hex — local identity only
  };
  candidate: PirDraftCandidate; // full IO + equipment + assumptions + diagnostics
  reviewState: ElectricalReviewState;
  ingestionDiagnostics: ElectricalDiagnostic[];
  build?: {
    attemptedAt: string;        // ISO 8601 — when "Build PIR" was clicked
    pir?: unknown;              // schema-valid PIR project, when produced
    diagnostics: PirBuildDiagnostic[];
    sourceMap?: Record<string, SourceRef[]>;
    acceptedInputCounts?: { io: number; equipment: number; assumptions: number };
    skippedInputCounts?: { pending: number; rejected: number; unsupportedAssumptions: number };
  };
  notes?: string;               // free-form operator note
}
```

## Why these fields, in this shape

- `schemaVersion` is a literal so a future v2 reader can refuse v1
  rather than silently reinterpret it. The defensive validator in
  [`restoreReviewSessionSnapshot`](../packages/web/src/utils/electrical-review-session.ts)
  rejects any other value.
- `createdAt` is pinned and `updatedAt` advances every autosave so
  external tooling can derive an "age" without diffing the
  decisions.
- `source.contentHash` is a non-cryptographic FNV-1a 32-bit hash
  over the raw input. It exists for local identity ("is this the
  same file we already reviewed once?"). It is **not** an integrity
  check and **must not** be treated as one.
- `candidate` is the full domain `PirDraftCandidate`. It already
  carries its own `diagnostics` array, but those are the *post-
  graph-mapping* diagnostics. The registry-side diagnostics live
  in `ingestionDiagnostics` so the snapshot has both surfaces.
- `reviewState` is a `Record<string, ReviewedItemState>` per bag —
  not an array — so adding/removing items between code revisions
  doesn't reorder things and a new id can be reconciled in by
  [`reconcileReviewState`](../packages/web/src/utils/electrical-review-session.ts).
- `build` is optional. Present iff the operator pressed **Build PIR
  preview** at least once during the session. `pir` is `unknown` to
  avoid coupling restore to the live `@plccopilot/pir` schema —
  callers re-validate before promoting.
- `notes` is reserved; the v0 UI does not surface a note input but
  the field is allowed so external tooling can author one.

## Privacy invariants (load-bearing)

1. **No raw source content** is written into the snapshot. The
   `source` block has a hash and metadata only. Operators who need
   to re-ingest from the exact same input must keep the original
   source file alongside the snapshot — it is not in `localStorage`
   nor in any download.
2. **No user identity, no audit-trail attribution.** Sprint 78B v0
   has no auth and no concept of "who made this decision". The
   snapshot carries only timestamps. Do not retrofit a user field
   into v1; bump to v2 first.
3. **No upload.** Persistence is `localStorage` only; downloads are
   browser-initiated `Blob` URLs. Nothing leaves the operator's
   machine.

## Defensive restore — what gets rejected

[`restoreReviewSessionSnapshot`](../packages/web/src/utils/electrical-review-session.ts)
returns `{ ok: false, reason }` on:

- non-object input
- wrong / missing `schemaVersion`
- missing / empty `createdAt` / `updatedAt`
- malformed `source` (missing `sourceId`, unknown `inputKind`)
- malformed `candidate` (`io` / `equipment` / `assumptions` /
  `diagnostics` not array when present)
- malformed `reviewState` (any of the three required record bags
  missing)
- `ingestionDiagnostics` not an array
- `build` present but with non-array `diagnostics` /
  non-string `attemptedAt` / non-record `sourceMap`

Per-row shape (e.g. PirIoCandidate fields, SourceRef fields) is
**not** revalidated here — that would couple this layer to every
candidate-row schema change. The domain helpers tolerate missing
optional fields, and over-validating would surface false-positive
"corrupt session" errors.

## Storage layout

Layout is documented in
[`packages/web/src/utils/electrical-review-storage.ts`](../packages/web/src/utils/electrical-review-storage.ts):

- `plccopilot:electricalReview:latest` — single-slot for the
  most recent autosave.
- `plccopilot:electricalReview:session:<id>` — reserved prefix
  for future per-source slots; not used in v0.

## Compatibility expectations

- **v1 → v1.x:** any change that does not add/rename a required
  field can land in-place without bumping the schemaVersion.
  Optional fields may be added freely.
- **v1 → v2:** any breaking shape change (renaming, removing,
  retyping a required field, repurposing an existing field, adding
  a new required field) bumps the literal. `restoreReviewSessionSnapshot`
  rejects v1 in v2; a future migration helper would parse v1 and
  emit v2 explicitly.

## Reading the snapshot outside `@plccopilot/web`

Anyone reading a snapshot from disk in another tool should treat
it as a structured-evidence payload, not as a final PIR or as a
PLC code description. The PIR preview (when present) is itself
already validated against `@plccopilot/pir` — but the snapshot's
purpose is the *evidence and review trail*, not the PIR.
