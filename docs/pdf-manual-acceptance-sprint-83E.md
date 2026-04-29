# Sprint 83E — manual PDF acceptance pass

> **Status: PDF source-evidence UX on top of Sprint 83D's
> stable diagnostic stream.** Sprints 79–83D established safe
> PDF ingestion: real text-layer extraction, PDF SourceRefs
> with `page` + `snippet` + `bbox`, strict PDF address
> handling, family classifier for non-IO tables, throttled +
> canonical non-IO rollups. Sprint 83E adds the first
> operator-facing PDF evidence UX in `@plccopilot/web`. The
> goal is **trust, traceability, and review ergonomics**, not
> new extraction capability. Volume / UX change only — no
> schema bump, no new ingestion code, no relaxed safety. Source
> evidence remains **representative-only** for rollup
> diagnostics — full per-occurrence drilldown stays a future
> sprint.

## What changed at the web layer

Three additions in `@plccopilot/web`:

1. **`packages/web/src/utils/pdf-rollup-evidence.ts`** (NEW) —
   pure helpers:
   - `extractPdfRollupPages(message)` — parses Sprint 83D
     rollup messages and returns the full page set
     (`{ pages, humanLabel }`). Recognises `"page 3"`,
     `"pages 80–86"`, `"pages 3, 49–54"`. En-dash (U+2013) and
     ASCII `-` both accepted. Pure / total.
   - `summarizePdfDiagnosticEvidence(diag)` — projects a PDF
     diagnostic into a UI-ready summary that combines the
     existing Sprint 82 `SourceRef` projection (Snippet,
     Bounding box, Page, Symbol, Source kind, …) with the
     rollup-message page set. Returns `null` for non-PDF
     diagnostics so CSV / EPLAN / TcECAD flows are unaffected.
     Carries a `representativeOnly` flag the UI must surface
     when the rollup names more pages than the SourceRef can
     drill into.

2. **`packages/web/src/components/electrical-review/PdfDiagnosticEvidence.tsx`**
   (NEW) — React component. Compact "Show PDF evidence" toggle
   with the page count + path + symbol. When expanded:
   - A `representative-only` notice (when applicable),
     explicitly stating the rollup covers `pages 80–86` but the
     source reference only points at the first page.
   - The full page list parsed from the message.
   - The Sprint 82 `SourceRefSummary` fields (Snippet, Bounding
     box, Page, Symbol, …) rendered as a `<dl>`.
   - **No page-region preview / bbox overlay.** A canvas
     preview would require introducing pdfjs rendering into the
     web app; Sprint 83E intentionally keeps pdfjs isolated to
     the extractor. Bbox is surfaced numerically (the existing
     Sprint 82 projection) so operators can correlate against
     the original PDF in another viewer.

3. **`packages/web/src/components/electrical-review/ElectricalDiagnosticsList.tsx`**
   (UPDATED) — for diagnostics whose `sourceRef.kind === 'pdf'`,
   the legacy one-liner is replaced with `<PdfDiagnosticEvidence>`.
   For every other kind (`csv`, `eplan`, `eplan-export`, `xml`,
   `twincat_ecad`, `manual`, `unknown`) the existing one-liner
   is preserved verbatim.

## What stays from Sprints 82 / 83A / 83B / 83C / 83D

- PDF address strictness intact — isolated `I1` / `O2` / `%I1`
  channel markers from PDF still NEVER become buildable PIR
  addresses.
- Non-IO family classifier intact — Sprint 83A semantics
  unchanged.
- Footer / weak-token / body-row hygiene gate intact —
  Sprint 83B suppression unchanged.
- Sprint 83C cross-page `detectIoTables` call intact.
- Sprint 83D canonical-section-role rollup keying intact —
  numbered TcECAD markers (`=COMPONENTS&EPB/N`,
  `=CABLE&EMB/N`, `=CONTENTS&EAB/N`, `=LEGEND&ETL/N`,
  `=TERMINAL&EMA/N`) and sibling BOM table headers across
  page series still collapse into one rollup per family/role.
- Diagnostic codes unchanged. No schema bump.
- `SourceRef` shape unchanged — Sprint 83E adds a *projection*
  on top, not new fields.
- Existing `SourceRefPanel` (used by candidate rows) renders
  PDF SourceRefs the same way as before.
- CSV / EPLAN / TcECAD diagnostic display unchanged.
- Raw PDF bytes still NEVER persisted in the localStorage
  snapshot.
- Confidence still capped at 0.65, ≥ 0.5.
- No OCR. No symbol recognition. No wire tracing. No
  multi-column / rotated-page support. No automatic codegen.
- Review-first behaviour: no auto-accept; no PIR build from
  non-strict PDF evidence; PIR build still refuses on
  TcECAD-shape PDFs that produce zero deterministic IO rows.

## Captured automated outcomes

A new spec lives at
`packages/web/tests/pdf-rollup-evidence.spec.ts` (15 tests):

- 7 `extractPdfRollupPages` cases — singular / range /
  mixed / ASCII-hyphen variant / dedup / null on no-phrase /
  reject Y < X.
- 8 `summarizePdfDiagnosticEvidence` cases — null for non-PDF
  / null for missing ref / surfaces Snippet+Bounding box+Page
  / `representativeOnly=true` for multi-page rollup /
  `representativeOnly=false` for single-page rollup / falls
  back to ref page when message has no phrase / compactLabel
  composition / stable React key.

The component layer (`PdfDiagnosticEvidence`) is intentionally
a thin renderer of these summaries; behaviour the operator
depends on is exercised at the helper level. No
@testing-library/react test was added — `packages/web/tests`
is currently a node-mode unit suite without DOM tooling, and
introducing one for a single component is out of scope for a
UX-only sprint.

| Behaviour | Sprint 83D web UX | Sprint 83E web UX |
| --- | --- | --- |
| `PDF_BOM_TABLE_DETECTED` rollup with `pages 80–86` | One-liner `source: pdf · …pdf · line 1 · pdf:p80:line:1` | Compact "Show PDF evidence · 7 pages · pages 80–86 · …" toggle. Expand reveals representative-only notice, page list, snippet, bbox |
| `PDF_CONTENTS_TABLE_IGNORED` rollup with `page 3` | One-liner | Compact toggle (`1 page · page 3`). Expand reveals snippet+bbox; no rep-only notice |
| `CSV_INVALID_ADDRESS` with CSV ref | One-liner | One-liner (unchanged) |
| `EPLAN_XML_INVALID_ADDRESS` with EPLAN ref | One-liner | One-liner (unchanged) |
| `TCECAD_XML_DUPLICATE_VARIABLE` with TcECAD ref | One-liner | One-liner (unchanged) |
| Strict-address `PDF_IO_ROW_EXTRACTED` with single-page PDF ref | One-liner | Compact toggle (1 page); no rep-only notice |

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprints 82 / 83A / 83B / 83C / 83D).
3. Press **Ingest**.
4. Expected (Sprint 83E):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks
     across 86 pages (same shape as 82 → 83D).
   - **Family rollups: 6–10 (preferred) / ≤ 12 (cap)** — the
     Sprint 83D contract is preserved verbatim. The expected
     stream typically contains:
     - 1 `PDF_BOM_TABLE_DETECTED` covering `pages 80–86`.
     - 1 `PDF_CONTENTS_TABLE_IGNORED` covering `pages 2–4`.
     - 1 `PDF_TERMINAL_TABLE_DETECTED` covering `pages 49–54`.
     - 1 or 2 `PDF_CABLE_TABLE_DETECTED` (overview + plan).
     - 0–1 `PDF_LEGEND_TABLE_IGNORED` if a legend section is
       detected.
   - **Each family rollup now has a "Show PDF evidence"
     toggle.** Click it. Expanded view should show:
     - A representative-only notice for multi-page rollups
       (BOM / cable / terminal / contents) explicitly stating
       the rollup covers e.g. `pages 80–86` but the source
       reference points at the first page.
     - The full page list, e.g. `Pages: 80, 81, 82, 83, 84, 85, 86`.
     - Snippet (e.g. `"Benennung (BMK) Menge Bezeichnung
       Typnummer Hersteller Artikelnummer"`).
     - Bounding box, e.g. `x=… y=… w=… h=… (pt)`.
     - Page (`80`), Source kind (`pdf`), File
       (`TcECAD_Import_V2_2_x.pdf`), Symbol (`pdf:p80:line:1`).
   - CSV / EPLAN / TcECAD diagnostic rows on the same page
     (if any other source was uploaded in the session) keep
     their existing one-liner.
   - **No `plc_channel:%I1` / `%I3` candidates.** Build PIR
     stays disabled / refuses.
   - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` still fires
     at the end. PIR build refuses honestly.
5. Also test a Case A strict-address PDF (Sprint 81 fixture):
   ```
   Address Tag Description
   I0.0 B1 Part present
   Q0.0 Y1 Cylinder extend
   ```
   Expected:
   - 2 IO candidates extracted.
   - Each `PDF_IO_ROW_EXTRACTED` info diagnostic has a "Show
     PDF evidence" toggle (single page; no rep-only notice).
   - Accept all → valid PIR preview with 2 IO + 2 equipment.
   - Strict-address path NOT regressed.
6. Open a CSV / EPLAN / TcECAD session in parallel. Confirm
   diagnostics in those flows still display the legacy
   one-liner (`source: csv · list.csv · line 5`).

## Honest constraints (Sprint 83E)

- **Source evidence is representative-only for multi-page
  rollups.** The operator sees the full page list (parsed
  from the diagnostic message), the snippet of the first
  page, and the bbox of the first page. **Per-page snippet/
  bbox drilldown is not yet available** — this is an
  intentional cliff. Adding it would require either
  threading the full page set through the rollup builder
  (schema change) or re-parsing the source on demand from a
  cached `PdfDocument` (state-management work).
  Sprint 83E surfaces the cliff honestly via the
  `representative-only` notice.
- **No page preview / no bbox overlay rendering.** Adding a
  rendered page with a highlighted bbox would require
  introducing pdfjs canvas rendering into the web app, which
  Sprint 83E intentionally does not. Bbox is surfaced
  numerically; operators can correlate against the original
  PDF in another viewer.
- **No new component-level browser tests.** The web tests
  are vitest node-mode pure-helper tests; introducing
  @testing-library/react for a single component is out of
  scope for a UX-only sprint. The component is intentionally
  a thin renderer of the helper output.
- **Localstorage shape unchanged.** Raw PDF bytes were never
  persisted (Sprint 78B privacy default); Sprint 83E adds no
  new persisted state.
- **No new diagnostic codes.** Sprint 83D codes carry through.
- **No layout heuristics, OCR, symbol recognition, wire
  tracing, multi-column / rotated-page support, or codegen.**
  All stay deferred.
- **PDF-derived confidence still capped at 0.65, ≥ 0.5.**
- **PDF snippets remain potentially sensitive.**

## Recommended next sprint

Two genuine candidates depending on operator feedback from
the manual TcECAD pass:

- **Sprint 83F — full per-occurrence drilldown.** Thread the
  full page set through the rollup occurrence into a UI-ready
  per-page evidence list (snippet + bbox per page). Removes
  the `representative-only` cliff and lets operators inspect
  every page covered by a rollup individually. Schema-light:
  the rollup occurrence already carries `pages: Set<number>`
  in `detectIoTables`; it just isn't surfaced through the
  diagnostic.

- **Sprint 84 — PDF page preview + bbox overlay.** Render the
  PDF page in a canvas (pdfjs) with the bbox highlighted.
  Adds pdfjs to the web bundle (currently isolated to the
  extractor adapter), which is the bigger architectural step.
  Worth doing only if operators specifically ask for visual
  source-region preview during PDF review.

OCR fallback, symbol recognition, wire-graph reconstruction,
and controlled codegen preview stay later in the roadmap.
