# Sprint 98 — Parameter review UX polish

> **Status: shipped in `@plccopilot/web`.** Adds a dedicated
> *Parameter candidates* section to the Electrical review
> panel. Pure / DOM-free helper drives the formatting; thin
> renderer reuses Sprint 93's unified status-badge palette and
> the existing decision-controls / source-ref pattern. Web-only,
> no schema / model / validation / codegen change.

## Why

Sprints 88L → 88M → 97 wired the industrial side: explicit
parameter extraction from CSV / EPLAN / TcECAD, optional
`min` / `max` / `unit` metadata, and the new PIR validator rule
`R-PR-03` enforcing range / unit coherence on
`motor_vfd_simple.speed_setpoint_out`. Operators could see the
metadata in the JSON candidate but had no place in the review
panel to scan it before pressing **Accept**. Sprint 98 fixes
that surface gap.

## Scope

- New helper `buildParameterReviewView(candidate)` projects a
  `PirParameterCandidate` to renderer-friendly strings + status
  badges.
- New thin component `ParameterCandidateReviewTable` rendered as
  a sibling section under *Equipment candidates*.
- Decision-controls / source-ref drilldown identical to the IO
  table — same muscle memory.
- Reuses Sprint 93's unified `.status-badge--<token>` palette;
  no new color rules.

## What is shown

Per parameter candidate the card surfaces:

| Field | Format example | Fallback |
|---|---|---|
| Id | `p_m01_speed` | `unknown` |
| Label | `M01 speed setpoint` | id, when label missing |
| Data type | `Real` / `Int` / `DInt` / `Bool` | `Unknown type` |
| Default | `50` / `50.5` | `Missing default` |
| Unit | `Hz` | `No unit` |
| Range | `0–60` (en-dash) | `No range` / `≥ 0` / `≤ 60` / `50` (when min == max) / `Invalid range metadata` |
| Summary | `Real · default 50 · Hz · range 0–60` | degrades phrase by phrase |

Detail rows under an `<details>` block: id, data type, default,
unit, min, max — in stable order.

## Status badges

Sprint 98 reuses Sprint 93's unified palette:

| Condition | Token | Label | Hint |
|---|---|---|---|
| min and/or max present + finite + coherent | `ready` | `Range` | parameter has explicit numeric bounds |
| min/max absent | `info` | `No range` | parameter has no explicit min / max; ingestion never inferred bounds from comments |
| min/max non-finite or `min > max` | `failed` | `Invalid range metadata` | PIR R-PR-03 will reject this on build |
| unit present | `info` | `Unit Hz` (or whatever string the candidate carries) | parameter declares an explicit engineering unit |
| unit missing | `warning` | `No unit` | PIR R-PR-03 surfaces this as info on speed_setpoint_out roles |
| default missing | `failed` | `Missing default` | a numeric default is required by the PIR builder |
| default non-finite | `failed` | `Invalid default` | the PIR builder will refuse this candidate |
| default outside `[min, max]` | `warning` | `Default outside range` | PIR R-PR-02 will reject this on build |

Badges are advisory; they do not change `isReadyForPirBuilder`,
do not change review-state semantics, and do not produce new
diagnostic codes. Existing ingestion / build diagnostics keep
appearing in the *Diagnostics* section unchanged.

## Hard rules

- **Web-only.** No PIR / codegen-core / vendor / electrical-
  ingest / CLI / worker / canonical Generate / canonical export-
  bundle / `localStorage` change.
- **No new validation semantics.** The helper *describes* what
  the candidate carries; PIR R-PR-02 / R-PR-03 / Sprint 88L
  ingestion diagnostics decide build acceptance.
- **No new bundle format.** No new fields on
  `PirParameterCandidate` or `ReviewState`.
- **Backwards-compatible with old snapshots.** Candidates
  without `parameters` (or with an empty array) skip the
  parameter section entirely; the review panel renders
  identically to Sprint 88L for those bundles.
- **No new dependencies.** Pure helper + standard React hooks +
  CSS.
- **No React Testing Library.** Tests stay helper-level. The
  component is thin; the helper covers every formatting + badge
  branch.

## Manual verification checklist

1. `pnpm web:dev`. Author a CSV with explicit bounds:

   ```csv
   row_kind,parameter_id,data_type,default,unit,min,max
   parameter,p_m01_speed,real,50,Hz,0,60
   ```

   plus the device + setpoint_binding rows.

2. Drop the CSV into the workspace. Confirm the review panel now
   shows a *Parameter candidates (1)* section.

3. Confirm the row reads:
   - id `p_m01_speed`,
   - summary `Real · default 50 · Hz · range 0–60`,
   - badges `Range` (ready) and `Unit Hz` (info),
   - decision controls work (accept / reject / pending).

4. Click *Show 1 source*. Confirm the detail block shows id /
   data type / default / unit / min / max + the source-ref
   snippet.

5. Drop a CSV with `unit` empty:
   - Summary contains `no unit`.
   - Badge `No unit` (warning) appears.

6. Drop a CSV with `min` / `max` empty:
   - Summary contains `no range`.
   - Badge `No range` (info) appears.

7. Drop a CSV with `default 200` and `max 60`:
   - Existing `CSV_PARAMETER_DEFAULT_OUT_OF_RANGE` warning still
     appears in the diagnostics section.
   - Badge `Default outside range` (warning) appears on the
     parameter row.
   - `R-PR-02` error still surfaces at build time.

8. Drop a CSV with `min 100` `max 0` (inverted):
   - The ingestion drops the bounds and emits
     `CSV_PARAMETER_RANGE_INVALID`.
   - The review row shows `No range` because the candidate
     itself no longer has bounds.

9. Hand-author a polluted candidate JSON with
   `min: Number.POSITIVE_INFINITY`. Confirm the row shows
   `Invalid range metadata` (failed badge). PIR R-PR-03 still
   rejects on build.

10. Generate / Preview / live diff / archived diff / archived
    comparison flows all behave identically to before. The
    canonical session export bundle is byte-identical to its
    Sprint 97 shape.

11. Refresh the browser. Old session snapshots without
    `parameterCandidates` still load and the review panel
    skips the parameter section cleanly.

## What stays out

- No parameter editor / inline edits.
- No recipe / parameter override UI.
- No new validation rules.
- No new diagnostic codes.
- No min/max extraction changes (Sprint 97 owns that).
- No codegen / Generate / preview-diff / canonical export
  changes.
- No legacy badge CSS cleanup — Sprint 93's unified palette is
  reused but the legacy `.preview-badge--*` / `.readiness-
  badge--*` / `.preview-diff-badge--*` rules remain for cascade
  safety, exactly as Sprint 93 left them.

## Recommended next sprint

1. **Pause-and-listen.** Sprint 98 closes the surface that Sprint
   97 opened. Wait for operator feedback on the new badges and
   formatters before layering more.
2. **Recipe / parameter override guardrails** — only worthwhile
   if real fixtures show recipe values landing outside their
   parameter range. The PIR validator's R-PR-01 already catches
   it; ingestion-side `CSV_RECIPE_VALUE_OUT_OF_RANGE` would
   front-load the diagnostic.
3. **Legacy badge CSS cleanup.** Once Sprint 98 has ridden in
   production for a release, remove the legacy
   `.preview-badge--*` / `.readiness-badge--*` /
   `.preview-diff-badge--*` rules and the associated `${legacy-
   class}` concatenations. Pure CSS / renderer cleanup, no new
   surface.
