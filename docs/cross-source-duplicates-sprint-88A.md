# Sprint 88A — Cross-source duplicate detection v0

> **Status: read-only audit layer for cross-source conflicts in
> the reviewed → PIR handoff.** Sprint 85 surfaced duplicates
> within a single candidate; Sprint 88A adds a *cross-source*
> filter that fires only when ≥ 2 distinct
> `SourceRef.sourceId` values participate in the same duplicate
> group. The motivation is the multi-source review case (CSV +
> EPLAN, EPLAN + TcECAD, …) where two ingestors disagree about
> the same physical address or symbol — the operator must
> reconcile before trusting the PIR / codegen.
>
> The detector never auto-merges, never picks a winner, and
> never coerces vendor-specific addresses across families.
> Volume / UX hardening only — no schema bump on existing
> consumers, no PIR mutation, no codegen change.

## What it detects

Three new diagnostic codes added to `PirBuildDiagnosticCode`:

| Code | Severity | When it fires |
| --- | --- | --- |
| `PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS` | warning | ≥ 2 accepted IO with the same canonical parsed address (or the same exact normalised raw text for unbuildable addresses) come from ≥ 2 distinct `sourceId`s. |
| `PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_TAG` | warning | ≥ 2 accepted IO with the same `label.trim().toLowerCase()` come from ≥ 2 distinct `sourceId`s. |
| `PIR_BUILD_CROSS_SOURCE_DUPLICATE_EQUIPMENT_ID` | warning | ≥ 2 accepted equipment with the same raw `id` come from ≥ 2 distinct `sourceId`s. |

All three codes are `warning` severity. The PIR builder still
emits `error`-severity Sprint 85 diagnostics underneath when
appropriate (e.g. `PIR_BUILD_DUPLICATE_IO_ADDRESS`); the
cross-source codes are *additional, more specific signals* that
name the sources involved.

## What it does NOT detect / does NOT do

- **No vendor coercion.** A TcECAD `tcecad:GVL.iSensor1` is
  NOT treated as equivalent to a Siemens `%I0.0`. PDF channel
  markers are NOT promoted to PLC addresses. Items with
  unbuildable raw addresses match only when their
  case-insensitive trimmed text is byte-equal.
- **No automatic merge.** When a cross-source duplicate fires,
  the builder does not pick a winner. The Sprint 76 PIR schema
  validator may still hard-fail on duplicate addresses (its
  job); Sprint 88A is the upstream warning that names the
  sources so the operator can resolve in review.
- **No automatic rename.** Tag/equipment-id duplicates are
  flagged, never silently disambiguated.
- **No address synthesis.** Unbuildable addresses stay
  unbuildable; Sprint 76's `PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS`
  still fires and Sprint 85's hardening counts the IO as
  unbuildable.
- **No assumption promotion.**
- **No same-source duplicate suppression.** Sprint 85's
  same-candidate duplicate warnings still fire when a single
  source contains the conflict; Sprint 88A only adds the
  cross-source-specific warning when ≥ 2 sources participate.
- **No source-aware rollup beyond the candidate boundary.** The
  helper looks at the *current* `PirDraftCandidate`; if a
  future merger lands items from multiple ingest passes into
  one candidate, this detector picks them up automatically. If
  the multi-source flow remains "one source per session" (as it
  is today in the web UI), the detector is dormant — that's the
  correct behaviour, by design.

## Examples

**Cross-source IO address (CSV + EPLAN):**
```text
[warning] PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS:
  Cross-source duplicate IO address "parsed:area=I|bit=0|byte=0":
  items "io_a", "io_b" from sources "csv-1", "eplan-1".
  The PIR builder will not silently merge cross-source duplicates —
  accept exactly one source for this IO address or rename / re-address
  the others.
```

**Cross-source IO tag:**
```text
[warning] PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_TAG:
  Cross-source duplicate IO tag "partpresent": …
```

**Cross-source equipment id:**
```text
[warning] PIR_BUILD_CROSS_SOURCE_DUPLICATE_EQUIPMENT_ID:
  Cross-source duplicate equipment id "eq_b1": …
```

The diagnostic carries the union of representative `SourceRef`s
for each item in the group so operators can drill back to each
source location.

## Wiring

Inside [`packages/electrical-ingest/src/mapping/pir-builder.ts`](../packages/electrical-ingest/src/mapping/pir-builder.ts),
the cross-source pass runs immediately after Sprint 85's
`diagnoseHardenedGraph` and BEFORE the per-item build loop:

```ts
const hardeningSummary = summarizeAcceptedGraph(candidate, state);
for (const d of diagnoseHardenedGraph(candidate, hardeningSummary)) {
  pushDiag(ctx, d);
}

// Sprint 88A — cross-source duplicate detection.
const crossSourceSummary = summarizeCrossSourceDuplicates(
  candidate,
  state,
);
for (const d of diagnoseCrossSourceDuplicates(crossSourceSummary)) {
  pushDiag(ctx, d);
}
```

Sprint 76's gate semantics (pending blocks; rejected silently
skipped; empty candidate rejected; accepted-only build) and the
sourceMap sidecar shape are unchanged.

## Relation to Sprint 85 hardening

Sprint 85 added `summarizeAcceptedGraph` + `diagnoseHardenedGraph`
which detects duplicates **within the accepted subset of one
candidate**. It emits:

- `PIR_BUILD_DUPLICATE_IO_ADDRESS` (warning, one per group)
- `PIR_BUILD_DUPLICATE_IO_TAG` (info, one per group)

Sprint 88A's helper sits *next to* Sprint 85's, not on top.
Both run; both can fire on the same input. They are
complementary:

- Sprint 85 fires for any duplicate, regardless of source.
- Sprint 88A fires only when the duplicate spans ≥ 2 distinct
  sourceIds, and emits a different, more specific code.

When operators see *both* a Sprint 85 warning and a Sprint 88A
warning for the same address, the path forward is the same as
Sprint 85: the PIR validator will refuse if the duplicate
survives; the operator must accept one source and reject the
others (or rename / re-address).

## Current limitation: single-active-source UI

The web UX as of Sprint 87C imports one source per review
session. Today's review snapshots therefore typically have one
`sourceId` per accepted item — the cross-source detector stays
dormant on a single-source session and emits nothing.

The detector is **already source-aware inside one candidate**:
if a future Sprint 88B / merger flow lands items from multiple
passes (CSV + EPLAN, EPLAN + TcECAD, …) into one
`PirDraftCandidate`, the detector picks them up automatically
without any code change. Sprint 88A ships the audit layer
ahead of that UX work so the safety contract is in place
before multi-source review becomes operator-visible.

## Files touched

**`@plccopilot/electrical-ingest`**
- `src/mapping/cross-source-duplicates.ts` (NEW) — pure helper
  exporting `summarizeCrossSourceDuplicates` +
  `diagnoseCrossSourceDuplicates` + view types.
- `src/mapping/pir-builder.ts` — three new
  `PirBuildDiagnosticCode` entries; one wiring block after
  Sprint 85 hardening.
- `tests/cross-source-duplicates.spec.ts` (NEW, 22 tests).

**Docs**
- `docs/cross-source-duplicates-sprint-88A.md` (NEW).
- `docs/electrical-ingestion-architecture.md` — refreshed
  status + Sprint 88A section.

No `@plccopilot/codegen-*` / `@plccopilot/web` / `@plccopilot/pir`
/ `@plccopilot/cli` changes. No worker-protocol change. No
schema change on existing consumers. The Sprint 87B
CodegenReadinessPanel and the Sprint 86 readiness pass surface
these new codes through the existing severity-based render
path automatically — the operator-facing display gets them for
free.

## Tests / gates

| Package | Pre-88A | Sprint 88A | New tests |
| --- | --- | --- | --- |
| `@plccopilot/electrical-ingest` | 650 | **672** | +22 |
| `@plccopilot/codegen-core` | 755 | 755 | 0 |
| `@plccopilot/codegen-codesys` | 52 | 52 | 0 |
| `@plccopilot/codegen-siemens` | 172 | 172 | 0 |
| `@plccopilot/codegen-rockwell` | 60 | 60 | 0 |
| `@plccopilot/codegen-integration-tests` | 109 | 109 | 0 |
| `@plccopilot/cli` | 757 | 757 | 0 |
| `@plccopilot/web` | 832 | 832 | 0 |
| `@plccopilot/pir` | 36 | 36 | 0 |
| **Repo total** | **3,423** | **3,445** | **+22** |

The 22 new tests cover: empty candidate; pending / rejected
items skipped; same-source duplicate NOT emitted; CSV+EPLAN
address dup emitted; case + leading-`%` normalisation; TcECAD
NOT coerced to Siemens; PDF channel markers NOT coerced; tag
duplicate; equipment id duplicate; deterministic dedup; stable
ordering; representative `SourceRef` preservation; integration
with `buildPirFromReviewedCandidate` (cross-source warning
co-exists with Sprint 85 same-candidate warning); same-source
duplicate fires Sprint 85 only (no cross-source); valid CSV
still builds PIR; TcECAD unbuildable still rejected (no
"fixing" via cross-source); cross-source equipment id wired
end-to-end; cross-source tag wired end-to-end.

## Honest constraints

- **Cross-source detection is read-only.** No automatic merge,
  rename, remap, or rejection. Operators decide.
- **Cross-vendor addresses do NOT get coerced.** Buildable
  parsed-address keys collapse Siemens variants (`%I0.0`,
  `I0.0`, `%i0.0`); unbuildable raw strings only match on
  exact case-insensitive trimmed text. TcECAD structured names
  and PDF channel markers do NOT collide with Siemens addresses.
- **Same-source duplicates are NOT silenced.** Sprint 85's
  same-candidate warnings still fire alongside.
- **No PIR mutation, no schema change, no localStorage
  change.** Diagnostic codes are additive on the existing
  `PirBuildDiagnosticCode` union.
- **No web UI changes.** Sprint 87B's
  CodegenReadinessPanel renders the new codes via the
  severity-based path; Sprint 88A adds three rows to the
  existing diagnostics-list pattern automatically.
- **No PDF / OCR / layout changes.** PDF arc remains paused.
- **No codegen change.** Sprint 87C's per-target capability
  tables and the renderer audits stay intact.
- **Single-source review sessions emit zero Sprint 88A
  diagnostics by design.** The audit layer is dormant until
  multi-source review lands.
- **Per-candidate scope.** Detector reads one
  `PirDraftCandidate` at a time. Multi-candidate review (if it
  ever ships) needs a Sprint 88B merger pass.

## Manual verification checklist

1. Build a CSV-only review session with one `%I0.0` IO →
   accept → Build PIR. Expected: zero
   `PIR_BUILD_CROSS_SOURCE_DUPLICATE_*` diagnostics.
2. Hand-construct a synthetic candidate (via test fixture or
   future merger flow) where two accepted IO with `%I0.0` come
   from `sourceId: 'csv-1'` and `sourceId: 'eplan-1'`. Build.
   Expected: one `PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS`
   warning naming both `csv-1` + `eplan-1` and both items.
3. Hand-construct a candidate with two accepted IO sharing tag
   `"PartPresent"` from different sources. Expected: one
   `PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_TAG` warning.
4. Hand-construct a candidate with two accepted equipment
   sharing id `eq_b1` from different sources. Expected: one
   `PIR_BUILD_CROSS_SOURCE_DUPLICATE_EQUIPMENT_ID` warning.
5. Hand-construct a candidate where one IO has a Siemens
   `%I0.0` from CSV and another has TcECAD
   `tcecad:GVL.iSensor1` from a TcECAD source. Expected:
   no `PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS` warning
   (correctly NOT coerced); the TcECAD address still produces
   `PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS` from the existing
   strictness gate.
6. Web flow: open the Codegen Readiness panel after building
   a multi-source PIR; the new codes should render through the
   existing diagnostics list.
7. CLI: `pnpm cli generate --backend siemens` on a project
   with a cross-source duplicate exits with the existing
   `READINESS_FAILED` if any blocking codegen issue exists; the
   cross-source warning rides the manifest's
   `compiler_diagnostics`.

## Recommended next sprint

1. **Sprint 88B — multi-source review session UX / import
   bundle flow** — only if operator engagements need to combine
   sources in one review session. Sprint 88A's audit layer is
   the right groundwork; 88B builds the UX on top.
2. **Sprint 88C — Rockwell `valve_onoff` audit + widening** —
   only when an operator engagement asks for Logix.
3. **Sprint 89 — controlled codegen preview** — only after
   readiness + cross-source-duplicate detection have had real
   exposure.

Default: hold cross-source UX work (88B) until operators ask
for multi-source sessions, and prefer 88C only if a Logix
engagement actually lands. Sprint 88A's audit layer is now
load-bearing and will catch the conflict the moment multi-
source flow is enabled.
