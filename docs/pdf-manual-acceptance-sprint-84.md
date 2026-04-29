# Sprint 84 — manual PDF acceptance pass

> **Status: PDF layout hardening v0 on top of Sprint 83F's
> stable rollup + per-occurrence drilldown.** Sprints 79–83F
> established safe PDF ingestion + diagnostic stream + per-page
> evidence drilldown. Sprint 84 adds *layout-analysis* helpers
> on top of the text-layer extractor: column-aware reading
> order, region clustering, and a rotation heuristic. The goal
> is **deterministic ordering for multi-column pages** and
> *honest* surfacing of layouts the v0 detector cannot reliably
> reason about (rotated pages). Volume / UX hardening only —
> no new buildable evidence comes out of the new helpers, no
> new extraction patterns, no canvas rendering, no OCR. Sprint
> 84 is **v0**: the helpers are wired into the existing
> ordering step and emit two new info diagnostics; further
> integration (region-aware table walking, per-cell column
> hints from geometry) is deferred to v1.

## What changed at the domain layer

A new pure-helper module
[`packages/electrical-ingest/src/sources/pdf-layout.ts`](../packages/electrical-ingest/src/sources/pdf-layout.ts)
adds four total / DOM-free / side-effect-free helpers:

1. **`detectColumnLayout(blocks, options)`** — clusters block
   centerlines (`bbox.x + bbox.width/2`) one-pass. Two adjacent
   centers separated by more than `minColumnGapPt` (default
   `36pt`) open a new column. Columns below the size floor
   (`minBlocksPerColumn`, default `3`) are rejected and their
   blocks reattached to the closest meaningful column. Returns
   `{ columns, multiColumn, orientation }`. Falls back to
   single-column when fewer than `2 * minBlocksPerColumn` blocks
   carry geometry.

2. **`orderBlocksByLayout(blocks, options)`** — column-by-column
   left-to-right, top-to-bottom (descending `bbox.y +
   bbox.height` since PDF coordinates have origin at
   bottom-left). Stable tie-break by `bbox.x`. **No-op for
   blocks without geometry** — Sprint 79/81 test-mode ordering
   is preserved verbatim.

3. **`clusterBlocksIntoRegions(blocks, options)`** — vertical-
   gap clustering. Blocks separated by a gap > `vGapMultiplier
   * medianBlockHeight` (default `2.0`) open a new region.
   Returns `[{ blocks, bbox }]` with a combined region bbox.
   Reserved for v1 wiring; exposed now for tests + future
   table-region scoping.

4. **`detectPageRotation(page)`** — two signals: (a) the page
   carries a non-zero multiple-of-90 `rotation` tag from the
   parser, or (b) the median block aspect ratio (width /
   height, across ≥ 5 geometry-bearing blocks) is `< 0.6`
   (indicating extreme tall-narrow stripes typical of rotated
   pages). v0 *flags*; it does NOT un-rotate.

Two new info-only diagnostic codes were added to
[`ElectricalDiagnosticCode`](../packages/electrical-ingest/src/types.ts):

- **`PDF_LAYOUT_MULTI_COLUMN_DETECTED`** — emitted per page
  whose blocks cluster into ≥ 2 meaningful columns. Operator
  knows the extractor took a column-aware reordering path.
- **`PDF_LAYOUT_ROTATION_SUSPECTED`** — emitted per page
  flagged by `detectPageRotation`. Operator knows the
  deterministic extractor *may* mis-order text on that page;
  the page is still surfaced as evidence (no `SourceRef`s are
  dropped).

Both codes are `info` severity. Neither reflects a buildable
PIR claim; the existing review-first gate is unchanged.

## What changed at the wiring layer

`pdf.ts` now reorders blocks per page through
`orderBlocksByLayout` before constructing detector lines —
both in the **text-mode** path (for parity, although that path
never carries bboxes) and in the **bytes-mode** path (which is
where the new ordering actually fires on real PDFs):

- For each page with geometry-bearing blocks, the column-aware
  layout is computed; the page's blocks are reordered
  column-by-column; the reordered detector lines are forwarded
  to the existing Sprint 83C single cross-page `detectIoTables`
  call.
- Multi-column / rotation diagnostics are emitted alongside the
  reordering step.
- **No change to `detectIoTables`** — the table detector keeps
  its Sprint 81 single-column happy-path semantics. Sprint 84
  v0 only changes the *order* in which lines reach the detector.

## What stays from Sprints 82 / 83A / 83B / 83C / 83D / 83E / 83F

- PDF address strictness intact — isolated `I1` / `O2` / `%I1`
  channel markers from PDF still NEVER become buildable PIR
  addresses.
- Family classifier semantics intact — Sprint 83A unchanged.
- Footer / weak-token / body-row hygiene gate intact —
  Sprint 83B suppression unchanged.
- Cross-page `detectIoTables` call intact — Sprint 83C single
  invocation preserved.
- Canonical-section-role keying intact — Sprint 83D rollup
  count contract preserved.
- Sprint 83E representative-only fallback notice still appears
  for older diagnostics or partial coverage.
- Sprint 83F per-page `additionalSourceRefs` drilldown still
  populates for multi-page rollups; the web UI grouped per-page
  view is unaffected.
- Diagnostic codes for non-IO families unchanged.
  `PDF_LAYOUT_MULTI_COLUMN_DETECTED` and
  `PDF_LAYOUT_ROTATION_SUSPECTED` are purely additive.
- `SourceRef` shape unchanged.
- localStorage shape unchanged. Raw PDF bytes still NEVER
  persisted in the snapshot.
- CSV / EPLAN / TcECAD ingestors untouched.
- Confidence still capped at 0.65, ≥ 0.5.
- No OCR. No symbol recognition. No wire tracing. No
  multi-column / rotated *extraction* (v0 only flags). No
  automatic codegen. No canvas rendering.

## Captured automated outcomes

Two new specs land:

1. **`tests/pdf-layout.spec.ts` (21 tests)** — pure helper
   coverage:
   - `detectColumnLayout` × 6 — empty input / no-geometry
     fallback / floor for too-few blocks / two-column
     detection / orphan reattachment / page-orientation read.
   - `orderBlocksByLayout` × 5 — input-order fallback /
     single-column descending y / column-by-column /
     left-to-right tie-break / determinism.
   - `clusterBlocksIntoRegions` × 5 — empty / no-geometry
     fallback / packed → 1 region / gap → split / multiplier
     override.
   - `detectPageRotation` × 5 — `rotation=90` / `rotation=270`
     / normal landscape / aspect-ratio heuristic /
     too-few-blocks fallback.

2. **`tests/pdf-layout-integration.spec.ts` (6 tests)** —
   integration coverage:
   - Sprint 81 baseline strict-address single-column fixture
     still extracts a 3-row IO table candidate after
     `orderBlocksByLayout`.
   - Two-column page with strict-address IO on the left and
     narrative on the right reads `L0..L2` then `R0..R2`; the
     detector still extracts a 3-row IO table candidate.
   - BOM page with multi-column geometry still routes to
     `PDF_BOM_TABLE_DETECTED` rollup, NOT `PDF_TABLE_HEADER_DETECTED`.
   - Cable-plan page still routes to `PDF_CABLE_TABLE_DETECTED`.
   - Text-mode (no bboxes) does NOT emit
     `PDF_LAYOUT_MULTI_COLUMN_DETECTED` — Sprint 79/81
     contract preserved.
   - Text-mode does NOT emit `PDF_LAYOUT_ROTATION_SUSPECTED`,
     and Sprint 81 strict-address still produces 2 IO channels.

| Behaviour | Sprint 83F | Sprint 84 |
| --- | --- | --- |
| Single-column IO list | Detector input ordered by extraction order | Detector input ordered top-to-bottom by `bbox` (functionally identical) |
| Two-column page (IO left, narrative right) | Detector might interleave columns by y | **Detector reads left column then right column** |
| Page with `rotation=90` | No flag | `PDF_LAYOUT_ROTATION_SUSPECTED` info diagnostic |
| Multi-column page detected | No flag | `PDF_LAYOUT_MULTI_COLUMN_DETECTED` info diagnostic |
| Test-mode ingest (no bboxes) | Existing behaviour | Existing behaviour (helpers no-op) |
| BOM/cable/terminal/contents/legend rollups | Sprint 83D/F per-page drilldown | Same — no rollup count change |
| Strict-address fixture → 2 IO candidates | Yes | Yes |
| TcECAD `%I1`/`%I3` channel markers | Refused | Refused |

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprints 82 → 83F).
3. Press **Ingest**.
4. Expected (Sprint 84):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks
     across 86 pages (same shape as 82 → 83F).
   - **Family rollup count: 6–10 (preferred) / ≤ 12 (cap)** —
     Sprint 83D contract preserved verbatim.
   - **Per-page drilldown unchanged** — Sprint 83F grouped
     per-page evidence still appears under each
     `PDF_BOM_TABLE_DETECTED` / `PDF_CABLE_TABLE_DETECTED` /
     `PDF_TERMINAL_TABLE_DETECTED` / `PDF_CONTENTS_TABLE_IGNORED`
     toggle.
   - **New layout diagnostics** for any page where the helpers
     fire:
     - `PDF_LAYOUT_MULTI_COLUMN_DETECTED` — info, with the
       column count and page number.
     - `PDF_LAYOUT_ROTATION_SUSPECTED` — info, with the reason
       (`page-rotation-tag` or `block-aspect-ratio`).
     Whether these fire on TcECAD depends on the underlying
     pdfjs output; both are non-fatal info messages and don't
     change extraction.
   - **No `plc_channel:%I1` / `%I3` candidates.** Build PIR
     stays disabled / refuses.
   - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` still fires
     at the end (no IO rows extracted).
5. Also test a Case A strict-address PDF (Sprint 81 fixture):
   ```
   Address Tag Description
   I0.0 B1 Part present
   Q0.0 Y1 Cylinder extend
   ```
   Expected:
   - 2 IO candidates extracted.
   - Accept all → valid PIR preview with 2 IO + 2 equipment.
   - Strict-address path NOT regressed.
6. Optional: upload a PDF with a known multi-column IO list (a
   left-column IO table next to a right-column narrative) and
   verify a `PDF_LAYOUT_MULTI_COLUMN_DETECTED` info appears,
   and the IO rows extract from the left column intact.
7. Upload a CSV / EPLAN / TcECAD source: confirm those
   diagnostics still display the legacy one-liner unchanged.

## Honest constraints (Sprint 84 v0)

- **No new extraction capability.** The helpers reorder /
  cluster / flag the blocks the extractor already emitted; they
  never invent a row, a column, a header, or a `SourceRef`.
- **Region clustering is exposed but NOT wired into table
  detection yet.** Sprint 84 v0 keeps `detectIoTables`
  unchanged. v1 may scope table walking to a single region so
  a footer + table sequence cannot be treated as one continuous
  block; that's a behaviour change with regression risk and is
  deferred until manual feedback says it matters.
- **No per-cell column-role inference from geometry.** Sprint
  81's `detectIoTableHeader` already takes per-item geometry
  via `PdfTableDetectorLine.items`; the geometry-aware role
  hints suggested in the spec would need a deeper refactor of
  that path. Deferred.
- **Page rotation is detected, not corrected.** The flag is
  honest evidence to the operator: deterministic extraction may
  be unreliable on this page. v1 could reverse-rotate the
  text-layer geometry; risk is high so v0 stops at flagging.
- **Multi-column threshold is heuristic.** `36pt` column gap
  and `3` blocks-per-column are tuned for typical electrical-
  drawing layouts; weird PDFs will fall back to single-column
  and the extractor proceeds with extraction-order as before.
  Wrong → false multi-column → blocks reordered without
  regression because the detector is independent of order
  for non-IO classification.
- **No canvas / page preview.** pdfjs stays isolated to the
  extractor adapter.
- **localStorage shape unchanged.** Raw PDF bytes still NEVER
  persisted.
- **No new diagnostic codes for region clustering.** The two
  new codes cover the wired signals (multi-column ordering,
  rotation suspected); region clustering only becomes
  diagnostic-emitting when v1 wires it.
- **PDF-derived confidence still capped at 0.65, ≥ 0.5.**
- **PDF snippets remain potentially sensitive.**

## Recommended next sprint

Two options depending on what the manual TcECAD pass + a
multi-column fixture pass surface:

- **Sprint 84.1 — region-aware table walking** (preferred if
  a multi-column fixture shows the detector still mis-treats
  a footer + table as one continuous block). Wire
  `clusterBlocksIntoRegions` into `detectIoTables` so the
  header+rows walk is scoped to a single region. Risk: existing
  Sprint 81/83 tests must keep passing.

- **Sprint 84.2 — geometry-aware column hints from header
  cells** (preferred if operators see column mis-attribution
  on real-world IO lists). Use `PdfTableDetectorLine.items`
  per-cell `x`/`width` to assign `address` / `tag` / etc. roles
  to row blocks by geometry, not by string-position regex.

Alternatives:

- **Sprint 85 — PDF page preview + bbox overlay.** Render a
  PDF page in a canvas (pdfjs) with the bbox highlighted.
  Bigger architectural step (adds pdfjs to the web bundle).
  Worth doing only if operators specifically ask for visual
  source-region preview.

OCR fallback, symbol recognition, wire-graph reconstruction,
and controlled codegen preview stay later in the roadmap.
