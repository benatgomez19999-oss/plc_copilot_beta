# Sprint 83D — manual PDF acceptance pass

> **Status: non-IO rollup canonicalization on top of Sprint 83C's
> cross-page rollups.** Sprint 83C aggregated non-IO family
> diagnostics by `(family, signature)` so identical canonical
> headers across pages 80–86 collapsed into one rollup with a
> compressed page range. The browser pass on
> `TcECAD_Import_V2_2_x.pdf` (86 pages) showed the key was still
> too granular: numbered TcECAD section markers
> (`=COMPONENTS&EPB/1` … `/7`, `=CABLE&EMB/1` … `/24`,
> `=CONTENTS&EAB/1..3`, `=LEGEND&ETL/1..6`, `=TERMINAL&EMA/1..7`)
> each produced a distinct signature, and the BOM page series
> emitted three separate rollups for the sibling table headers
> (`Teileliste / Stückliste …`, `Benennung (BMK) …`, `Schaltplan
> / Position …`).
> Sprint 83D switches the rollup key from `(family, signature)`
> to `(family, canonical-section-role)`. Numbered marker series
> and sibling header lines collapse into a single rollup per
> family/role. Volume / UX change only — no schema bump, no
> new extraction capability, no widening of Sprint 82
> strictness or Sprint 83A/83B safety gates.

## What changed at the domain layer

Three pure helpers were added to
[`packages/electrical-ingest/src/sources/pdf-table-detect.ts`](../packages/electrical-ingest/src/sources/pdf-table-detect.ts):

1. **`normalizeNumberedPdfSectionMarker(text)`** — recognises a
   canonical TcECAD numbered section marker and returns
   `{ marker, family }`, discarding the `/N` / `/N.M` suffix:
   - `=COMPONENTS&EPB/N` → `{ COMPONENTS_EPB, bom_parts_list }`
   - `=CABLE&EMB/N` → `{ CABLE_EMB, cable_list }`
   - `=CONTENTS&EAB/N` → `{ CONTENTS_EAB, contents_index }`
   - `=LEGEND&ETL/N` → `{ LEGEND_ETL, legend }`
   - `=TERMINAL&EMA/N` → `{ TERMINAL_EMA, terminal_list }`

   Pure / DOM-free / total. Returns `null` for non-marker text.

2. **`canonicalizeNonIoHeaderRole(text, family)`** — derives the
   *section role* per family. One stable bucket each for BOM /
   contents / legend; cable and terminal split by overview /
   plan keywords:
   - `bom_parts_list` → always `bom_parts_list`
   - `cable_list` → `cable_overview` (Kabelübersicht /
     `cable overview`), `cable_plan` (Kabelplan / `cable plan`),
     or `cable_index` (everything else, e.g. raw `=CABLE&EMB/N`
     markers)
   - `terminal_list` → `terminal_overview`
     (Klemmleistenübersicht / `terminal overview`),
     `terminal_plan` (Klemmenplan / Klemmleiste /
     `terminal plan` / `terminal list`), or `terminal_index`
   - `contents_index` → always `contents_index`
   - `legend` → always `legend`
   - `unknown` / `io_list` → `null` (these never enter the
     rollup path)

3. **`canonicalizeNonIoFamilyRollupKey({ family, text })`** —
   composes the rollup key as `${family}:${role}`. Falls back to
   `${family}:_sig:${signature}` when no canonical role resolves
   (defensive — every current non-IO family resolves a role).

The `detectIoTables` non-IO branch now keys the
`Map<key, NonIoFamilyOccurrence>` by the canonical key. The
within-page hygiene gate (Sprint 83B), classifier (Sprint 83A),
strictness gate (Sprint 82), and cross-page single-call from
`pdf.ts` (Sprint 83C) are all preserved verbatim. Diagnostic
codes are unchanged: `PDF_BOM_TABLE_DETECTED`,
`PDF_TERMINAL_TABLE_DETECTED`, `PDF_CABLE_TABLE_DETECTED`,
`PDF_CONTENTS_TABLE_IGNORED`, `PDF_LEGEND_TABLE_IGNORED`,
`PDF_TABLE_HEADER_REJECTED`.

## What stays from Sprints 82 / 83A / 83B / 83C

- PDF address strictness intact — isolated `I1` / `O2` / `%I1`
  channel markers still NEVER become buildable PIR addresses.
- IO-list classifier semantics intact — real `Address Tag
  Description`-shaped headers still produce `PdfTableCandidate`
  + `PDF_TABLE_HEADER_DETECTED`.
- Family classifier semantics intact — BOM / terminal / cable /
  contents / legend resolve the same way; only the rollup
  grouping shape changes.
- Footer / title-block suppression intact — `Datum … Seite`,
  `Bearb …`, `Änderungsdatum …`, `Anzahl der Seiten …` still
  produce zero diagnostics.
- Header-shape gate intact — single-strong-token lines and body
  rows still suppressed before they can enter the rollup.
- Cross-page detection intact — `pdf.ts` text-mode and bytes-
  mode paths still call `detectIoTables` ONCE across all pages
  and redistribute `tableCandidates` back to each `PdfPage` by
  `pageNumber`.
- Source-evidence drilldown still surfaces `snippet` + `bbox`
  via the representative `SourceRef`. The representative ref is
  still the first page where the canonical role appeared — full
  per-occurrence source evidence is **not** yet exposed in the
  UI.
- Diagnostic codes are unchanged. No schema bump.
- Raw PDF bytes still NEVER persisted in the snapshot.
- CSV / EPLAN / TcECAD ingestors untouched.

## Captured automated outcomes

A new spec lives at
`packages/electrical-ingest/tests/pdf-table-family-rollup-canonicalization.spec.ts`
(27 tests):

- 5 `normalizeNumberedPdfSectionMarker` cases (per-family marker
  recognition + tolerated whitespace + null returns).
- 5 `canonicalizeNonIoHeaderRole` cases (BOM single bucket /
  cable overview-plan-index split / terminal overview-plan-index
  split / contents+legend single buckets / unknown returns null).
- 3 `canonicalizeNonIoFamilyRollupKey` composed-key cases.
- 10 `detectIoTables` rollup-canonicalization cases — numbered
  COMPONENTS/EPB collapse to 1; numbered CABLE/EMB collapse to
  1; CONTENTS/EAB collapse to 1; LEGEND/ETL collapse to 1;
  TERMINAL/EMA collapse to 1; sibling BOM table headers across
  pages collapse to 1; cable overview vs plan stay as 2 rollups;
  Klemmenplan pages 49–54 collapse to 1; footer suppression
  preserved; strict IO-list path NOT regressed.
- 4 `ingestPdf` integration cases — channel-marker strictness
  preserved; cross-page numbered cable markers collapse to one
  rollup with `pages 3–4`; full TcECAD-shape mock (contents 2–4
  + terminal 49–54 + cable overview 55–56 + cable plan 57–79 +
  BOM 80–86, all with numbered markers) stays under the 12-
  rollup cap and resolves to exactly the expected 5 family
  rollups; mixed strict-address PDF + numbered BOM keeps 2 IO
  channels and 1 BOM rollup.

| Case | Sprint 83C behaviour | Sprint 83D behaviour |
| --- | --- | --- |
| `=COMPONENTS&EPB/1..7 Teileliste` (7 pages) | 7 `PDF_BOM_TABLE_DETECTED` (one per `/N` signature) | **1** `PDF_BOM_TABLE_DETECTED` with `pages 80–86` |
| `=CABLE&EMB/1..24 Kabelplan` (24 pages) | 24 `PDF_CABLE_TABLE_DETECTED` | **1** with `pages 51–74` |
| `=CONTENTS&EAB/1..3 Inhaltsverzeichnis …` (3 pages) | 3 `PDF_CONTENTS_TABLE_IGNORED` | **1** with `pages 2–4` |
| `=LEGEND&ETL/1..6 Legende …` (6 pages) | 6 `PDF_LEGEND_TABLE_IGNORED` | **1** with `pages 6–11` |
| `=TERMINAL&EMA/1..7 Klemmenplan …` (7 pages) | 7 `PDF_TERMINAL_TABLE_DETECTED` | **1** with `pages 49–55` |
| Sibling BOM headers across pages 80–82 (Teileliste / Benennung) | 2 BOM rollups (different signatures) | **1** with `pages 80–82` |
| `Kabelübersicht` (55–56) + `Kabelplan` (57–79) | 2 rollups | **2** rollups (intentional split — overview ≠ plan) |
| Real IO-list header `Address Tag Description` | unchanged — IO path | unchanged — IO path NOT regressed |
| Footer / vendor metadata | suppressed (zero diagnostics) | suppressed (zero diagnostics) |
| TcECAD-shape full mock (numbered markers across all 5 sections) | 7+ family rollups | **5** family rollups (BOM, contents, terminal, cable overview, cable plan), well under the 12-cap |

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprints 82 / 83A / 83B / 83C).
3. Press **Ingest**.
4. Expected (Sprint 83D):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks
     across 86 pages (same shape as 82 / 83A / 83B / 83C).
   - **Family diagnostics drop from "one per signature" to "one
     per canonical section role"** — typical stream:
     - `PDF_BOM_TABLE_DETECTED` × 1 with phrasing
       `"Ignored BOM / parts-list sections on pages 80–86 …"`.
     - `PDF_CONTENTS_TABLE_IGNORED` × 1 with `pages 2–4`.
     - `PDF_TERMINAL_TABLE_DETECTED` × 1 with `pages 49–54`.
     - `PDF_CABLE_TABLE_DETECTED` × 1 for cable overview
       (`pages 55–56`).
     - `PDF_CABLE_TABLE_DETECTED` × 1 for cable plan
       (`pages 57–79`).
     - `PDF_LEGEND_TABLE_IGNORED` × 0–1 if a legend section
       passes the gate.
     - **Hard upper bound: 12 non-IO family rollups.**
       **Preferred target: 6–10.** Sprint 83C baseline for
       this input was dozens.
   - No diagnostics for individual numbered entries
     `=COMPONENTS&EPB/1..7`, `=CABLE&EMB/1..24`,
     `=CONTENTS&EAB/1..3`, `=LEGEND&ETL/1..6`,
     `=TERMINAL&EMA/1..7` — they all roll up into the
     family/section-role rollups above.
   - Vendor metadata (`Hersteller (Firma) Beckhoff Automation
     GmbH`, `Fabrikat BECKHOFF`, `Datum … Seite`, `Bearb RAL
     =CABLE`, `Änderungsdatum … Anzahl der Seiten 86`) still
     emits ZERO diagnostics.
   - Module-overview pages with isolated channel markers still
     emit Sprint 82's `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS`
     warnings + `PDF_MODULE_CHANNEL_MARKER_DETECTED` info.
   - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` still fires at
     the end (no IO rows extracted).
   - **No `plc_channel:%I1` / `%I3` candidates.** Build PIR
     stays disabled / refuses.
   - Source-evidence drilldown still shows Snippet + Bounding
     box (pt) (Sprint 82 fix preserved). Each rollup's
     representative `SourceRef` points at the first page where
     the canonical role appeared.
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

## Honest constraints (Sprint 83D)

- **Volume / UX change only — no new extraction capability.**
  Sprint 83D regroups the diagnostics Sprint 83C would already
  have emitted. It does NOT extract new IO rows, recognise new
  families, classify new tokens, or change confidence semantics.
- **Per-canonical-role granularity only.** Two BOM table-header
  variants on different page series share the same rollup if
  both classify as `bom_parts_list`. If you want per-table-shape
  evidence in the operator stream, that is future work.
- **Cable + terminal overview-vs-plan are intentionally split.**
  `Kabelübersicht` and `Kabelplan` produce two cable rollups
  even when interleaved on the same pages, because they document
  different logical sections. Same for
  `Klemmleistenübersicht` vs `Klemmenplan`.
- **Numbered markers are normalised lossily.** `=CABLE&EMB/1`
  and `=CABLE&EMB/24` collapse to the same key. The original
  numbers are not exposed in the diagnostic message — only the
  page range. Downstream tools needing per-marker evidence can
  parse the underlying `tableCandidates` (which still carry
  per-page bbox), but the family-rollup diagnostic itself does
  not.
- **Representative `SourceRef` only points at the first page.**
  Full per-occurrence source evidence — clickable drilldown
  into every page a rollup covered — is not yet exposed in the
  UI. That is a recommended follow-up.
- **No layout heuristics.** Per-line classification only. A
  line that names a non-IO family in isolation on a page that's
  actually an IO-list page still suppresses the same way.
- **No OCR. No symbol recognition. No wire tracing. No
  multi-column / rotated-page support. No automatic codegen.**
- **PDF-derived confidence still capped at 0.65, ≥ 0.5.**
- **Raw PDF bytes still NEVER persisted in the snapshot.**
- **PDF snippets remain potentially sensitive.**

## Recommended next sprint

Only if Sprint 83D's manual TcECAD pass actually reduces the
non-IO family rollup count to the 6–10 preferred target:

- **Sprint 83E / 84 — PDF source-evidence UX.** Page preview
  with bbox overlays, click-through from a rollup diagnostic
  into all pages it covered (currently only the representative
  page is linked), grouped rollup drilldown with per-occurrence
  snippets. This is the first sprint that builds new UI on top
  of the now-stable diagnostic stream.

If Sprint 83D's manual pass reveals new layout-shape problems
on real-world PDFs (rotated pages, multi-column blocks, PDFs
without `--- page N ---` text equivalents):

- **Sprint 84 — PDF layout hardening.** Multi-column ordering,
  rotated pages, coordinate normalisation, region clustering,
  better column-position detection from real geometry.

OCR fallback, symbol recognition, wire-graph reconstruction,
and controlled codegen preview stay later in the roadmap.
