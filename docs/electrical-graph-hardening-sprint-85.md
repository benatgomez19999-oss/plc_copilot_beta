# Sprint 85 — Electrical graph / PIR hardening v0

> **Status: pre-build root-cause diagnostics for the reviewed →
> PIR handoff.** Sprints 79 → 84.1B finished the PDF ingestion
> arc. Sprint 85 moves away from PDFs and tightens the
> `buildPirFromReviewedCandidate` path: a small pure hardening
> layer runs after the review gate and before the per-item
> build loop, surfacing root-cause diagnostics so operators see
> *why* a build will be empty/partial instead of just the
> post-hoc cascade.

## What hardening catches

Eight new diagnostic codes on `PirBuildDiagnosticCode`. All are
emitted from
[`packages/electrical-ingest/src/mapping/electrical-graph-hardening.ts`](../packages/electrical-ingest/src/mapping/electrical-graph-hardening.ts).

| Code | Severity | When it fires |
| --- | --- | --- |
| `PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO` | error | Accepted equipment binds to an IO id that doesn't exist anywhere in the candidate. |
| `PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO` | warning | Accepted equipment binds to an IO that exists but was rejected/pending. |
| `PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO` | warning | Accepted equipment binds to an accepted IO whose address fails `parseCandidateAddress` (e.g. TwinCAT structured names, PDF channel markers). |
| `PIR_BUILD_DUPLICATE_IO_ADDRESS` | warning | ≥ 2 accepted IO map to the same parsed PIR address. **One** warning per duplicate group, never per pair. |
| `PIR_BUILD_DUPLICATE_IO_TAG` | info | ≥ 2 accepted IO share a normalised label/tag. |
| `PIR_BUILD_ACCEPTED_IO_ORPHANED` | info | Accepted IO not referenced by any accepted equipment. **One** rolled-up info diagnostic listing every orphan. |
| `PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED` | warning | Accepted equipment with zero buildable IO references. One per equipment. |
| `PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING` | warning | Accepted-IO set is non-empty but every IO failed pre-build address parsing. |

The hardening pass classifies each `ioBindings` reference into
exactly one bucket (missing > unaccepted > unbuildable > built),
so an equipment with multiple bad refs doesn't double-count.

## What hardening does NOT infer

- **No automatic merging of duplicates.** If two accepted IO map
  to the same address, the operator gets a warning. The PIR
  schema validator may still refuse — that refusal is honest;
  no winner is silently chosen.
- **No address synthesis.** TwinCAT structured names
  (`GVL.iSensor1`) and PDF channel markers (`%I1`, `I3`) stay
  unbuildable; the hardening pass surfaces a precise root-cause
  diagnostic but never invents a valid PIR address.
- **No assumption promotion.** Accepted assumptions still go
  through the existing `PIR_BUILD_UNSUPPORTED_ASSUMPTION` path;
  hardening doesn't touch them.
- **No automatic codegen.** Sprint 85 is purely diagnostic; no
  PLC code is emitted.
- **No graph mutation.** `summarizeAcceptedGraph` is read-only;
  every counter / set is derived from the input.

## Wiring

`buildPirFromReviewedCandidate` in
[`pir-builder.ts`](../packages/electrical-ingest/src/mapping/pir-builder.ts)
now has a hardening pass between the gate and the build loop:

```ts
if (blockedByPending || blockedByErrorDiagnostics) {
  // existing PIR_BUILD_REVIEW_NOT_READY path
  return finaliseRefused(ctx);
}

// Sprint 85 — hardening pass.
const hardeningSummary = summarizeAcceptedGraph(candidate, state);
for (const d of diagnoseHardenedGraph(candidate, hardeningSummary)) {
  pushDiag(ctx, d);
}

// existing accept / reject pass for IO + equipment + assumptions
```

The hardening diagnostics are pushed into `ctx.diagnostics`
*alongside* the existing per-item codes. Operators see the
root-cause warning early, then the per-item cascade for context.

## Duplicate policy

Address dedup key = the parsed `IoAddress` field set (e.g.
`area=I|byte=0|bit=0`). Two accepted IO with the same key go
into the same group. The hardening pass emits **one warning
per group**, never per pair. The builder does NOT pick a
winner; both IO continue into the per-item loop. If the
`@plccopilot/pir` schema validator refuses the duplicate
addresses (it currently does), the build refuses honestly with
both `PIR_BUILD_DUPLICATE_IO_ADDRESS` and
`PIR_BUILD_SCHEMA_VALIDATION_FAILED` in the diagnostic stream;
the operator must accept exactly one or rename the others.

## SourceMap / SourceRef behaviour

- The Sprint 76 `sourceMap` sidecar is unchanged: it still
  contains exactly one entry per *created* PIR object (IO
  signal or equipment), keyed by canonicalised PIR id. Items
  the build refused or skipped do not appear.
- Hardening diagnostics carry `sourceRefs` when the offending
  item has them:
  - Equipment-related codes carry the equipment's `sourceRefs`.
  - `PIR_BUILD_DUPLICATE_IO_ADDRESS` carries the union of every
    duplicate IO's `sourceRefs` so the operator can correlate
    each occurrence.
  - `PIR_BUILD_DUPLICATE_IO_TAG` and
    `PIR_BUILD_ACCEPTED_IO_ORPHANED` are rolled-up summaries —
    the operator can read the candidate ids from the message
    text and pull `sourceRefs` from the candidate directly.
  - `PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING` is a
    document-level signal and carries no `sourceRefs`.

## Why unsupported addresses remain rejected

The PIR address space is intentionally narrow (Siemens
`%I0.0` / `%IB1` / `%IW10` / `%QD200` and Rockwell
`Local:N:I.Data[B].b`). TwinCAT structured names, PDF channel
markers, and free-form CSV strings deliberately fall outside
that space — the review-first architecture refuses to invent a
mapping. The hardening pass exposes the root cause of those
refusals via specific codes; it never relaxes the address gate.

## Why no codegen is triggered

Sprint 85 is a diagnostic-quality sprint. No PIR build runs
codegen. No accepted candidate becomes PLC code. The
review-first invariant is unchanged: a human accepts each
candidate; the PIR is built; codegen is a separate later
pipeline that consumes a validated PIR. Sprint 85 does not
move that boundary.
