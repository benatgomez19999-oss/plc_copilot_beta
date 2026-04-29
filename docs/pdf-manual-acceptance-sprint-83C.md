# Sprint 83C — manual PDF acceptance pass

> **Status: non-IO family diagnostic rollups on top of Sprint 83B's
> diagnostic-hygiene gates.** Sprint 83A made the family classifier
> safe; Sprint 83B suppressed footer / single-token / body-row
> noise and collapsed within-page duplicates. The Sprint 83B run
> on `TcECAD_Import_V2_2_x.pdf` (86 pages) still produced one
> diagnostic per page per family — pages 80–86 each emitted their
> own `PDF_BOM_TABLE_DETECTED`, plus per-page contents/cable/
> terminal hits. Operationally this is too noisy. Sprint 83C
> aggregates them into one rollup per `(family, signature)` group
> with a compressed page range (`pages 80–86`, `pages 3, 49–54`).
> Volume / UX change only — no schema change, no loosening of
> Sprint 82 strictness, no loosening of Sprint 83A/83B safety.

## What changed at the domain layer

Two cooperating additions in
[`packages/electrical-ingest/src/sources/pdf-table-detect.ts`](../packages/electrical-ingest/src/sources/pdf-table-detect.ts):

1. **`compressPageRanges(pages: ReadonlyArray<number | string>): string`**
   — pure helper. Accepts a numeric or stringified page list (any
   order, with duplicates). Drops non-finite / non-positive entries.
   Returns:
   - empty string for an empty input,
   - `"1"` for a single page,
   - `"80–86"` for a single consecutive run (en-dash, U+2013),
   - `"3, 49–54"` for mixed singletons + runs.

2. **Rollup aggregation inside `detectIoTables`** — the non-IO
   branch no longer pushes one diagnostic per `(family, page,
   signature)`. It records each occurrence into a
   `Map<key, NonIoFamilyOccurrence>` keyed by
   `${family}:${signature}` (page deliberately removed from the
   key so the same canonical header on pages 80–86 collapses to
   one group). Each occurrence retains:
   - `pages: Set<number>` — every page the signature appeared on,
   - `representativeSourceRef` — the first page's `SourceRef`
     (page + bbox + snippet),
   - `representativeSnippet` — the first occurrence's text,
   - `firstReason` — the first classifier reason that fired.

   At the end of `detectIoTables`, occurrences are sorted by
   family name then by min page, and one rollup info diagnostic
   is emitted per group with the message:

   > `Ignored ${label} sections on ${pagePhrase}. These are not IO
   > lists. First evidence: "${snippet}" (${reason}).`

   where `${label}` is the human-readable family
   (`BOM / parts-list`, `terminal-list`, `cable-list`,
   `contents/index`, `legend`) and `${pagePhrase}` is `page 1`
   (singular) or `pages 80–86` / `pages 3, 49–54`.

## What stays from Sprints 82 / 83A / 83B

- PDF address strictness intact — isolated `I1` / `O2` / `%I1`
  channel markers from PDF still NEVER become buildable PIR
  addresses.
- IO-list classifier semantics intact — real `Address Tag
  Description`-shaped headers still produce `PdfTableCandidate`
  + `PDF_TABLE_HEADER_DETECTED`.
- Family classifier semantics intact — BOM / terminal / cable /
  contents / legend resolve the same way; only the diagnostic
  shape changes.
- Footer / title-block suppression intact — `Datum … Seite`,
  `Bearb …`, `Änderungsdatum …`, `Anzahl der Seiten …` etc.
  still produce zero diagnostics.
- Header-shape gate intact — single-strong-token lines and body
  rows still suppressed before they can enter the rollup.
- Within-page dedup intact — repeated identical headers on the
  same page contribute only once to the page set.
- Source-evidence drilldown still surfaces `snippet` + `bbox`
  via the representative `SourceRef`.
- Diagnostic codes are unchanged: `PDF_BOM_TABLE_DETECTED`,
  `PDF_TERMINAL_TABLE_DETECTED`, `PDF_CABLE_TABLE_DETECTED`,
  `PDF_CONTENTS_TABLE_IGNORED`, `PDF_LEGEND_TABLE_IGNORED`,
  `PDF_TABLE_HEADER_REJECTED`. No new code, no schema bump.
- Raw PDF bytes still NEVER persisted in the snapshot.
- CSV / EPLAN / TcECAD ingestors untouched.

## `pdf.ts` — single cross-page `detectIoTables` call

For rollups to actually span pages in production ingest, the
`pdf.ts` text-mode and bytes-mode paths now collect detector
lines from every page first, call `detectIoTables` ONCE with the
combined input, push the diagnostics once, and redistribute the
returned `tableCandidates` back to the matching `PdfPage` by
`pageNumber`. Previous behaviour invoked `detectIoTables` inside
a per-page loop, which would have prevented Sprint 83C
aggregation from ever firing on the real pipeline. Pure ingest
output (graph + diagnostics) is identical for IO-list inputs;
only the non-IO family diagnostic count changes.

## Captured automated outcomes

A new spec lives at
`packages/electrical-ingest/tests/pdf-table-family-rollups.spec.ts`
(22 tests):

- 8 `compressPageRanges` cases (empty / single / consecutive run
  80–86 / mixed `[3, 49, 50, 51, 52, 53, 54]` → `"3, 49–54"` /
  unsorted / duplicates / non-finite drops / single-string input).
- 10 `detectIoTables` rollup cases — BOM headers on pages 80–86
  produce ONE rollup with `pages 80–86`; cable headers on
  non-consecutive pages roll up to `pages 5, 12–13`; mixed
  families produce one rollup each, ordered by family name then
  min page; a single-page case prints `page N` (singular); the
  legend / contents-index family roll up the same way; footer /
  weak / body-shape suppression still yields zero rollup
  diagnostics; an IO-list-shaped header still produces a
  `PdfTableCandidate` + `PDF_TABLE_HEADER_DETECTED` (no rollup);
  ordering is stable across runs.
- 4 `ingestPdf` integration cases over text-mode delimited
  fixtures — TcECAD-shaped multi-page mock collapses to ≤ 4
  family rollups (down from ≥ 7 under Sprint 83B); strict
  IO-list path NOT regressed; channel-marker classification not
  regressed; mixed strict-address PDF + BOM rollup keeps the IO
  path intact and emits one BOM rollup.

| Case | Sprint 83B behaviour | Sprint 83C behaviour |
| --- | --- | --- |
| Identical BOM canonical header on pages 80, 81, 82, 83, 84, 85, 86 | 7 `PDF_BOM_TABLE_DETECTED` (one per page) | **1** `PDF_BOM_TABLE_DETECTED` with `pages 80–86` |
| Same cable canonical header on pages 5, 12, 13 | 3 `PDF_CABLE_TABLE_DETECTED` | **1** with `pages 5, 12–13` |
| Single-page contents header on page 3 | 1 `PDF_CONTENTS_TABLE_IGNORED` (`page 3`) | **1** `PDF_CONTENTS_TABLE_IGNORED` (`page 3`) — phrasing singular |
| TcECAD-shaped 86-page mock (BOM on 80–86 + cable on 49–54 + contents on 3 + terminal on 1) | 7+ family diagnostics | **≤ 4** family diagnostics (one per family group) |
| Strict-address Sprint 81 fixture (`I0.0 B1` etc.) | unchanged — IO path | unchanged — IO path NOT regressed |
| Page-24 channel markers (Sprint 82) | unchanged — `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS` | unchanged — Sprint 82 strictness preserved |

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprints 82 / 83A / 83B).
3. Press **Ingest**.
4. Expected (Sprint 83C):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks across
     86 pages (same shape as 82 / 83A / 83B).
   - **Family diagnostics drop from "one per page" to "one per
     family group with a compressed page range"** — typical
     stream:
     - `PDF_BOM_TABLE_DETECTED` × 1 with phrasing
       `"Ignored BOM / parts-list sections on pages 80–86 …"`.
     - `PDF_CONTENTS_TABLE_IGNORED` × 1 (typically `page 3`).
     - `PDF_CABLE_TABLE_DETECTED` × 1 if the document has a
       cable section.
     - `PDF_TERMINAL_TABLE_DETECTED` × 1 if a terminal-list
       header is detected.
     - **Hard upper bound: 4 family rollups.** The Sprint 83B
       baseline for this input was 7+.
   - Vendor metadata (`Hersteller (Firma) Beckhoff Automation
     GmbH`, `Fabrikat BECKHOFF`, `Datum … Seite`, `Bearb RAL
     =CABLE`, `Änderungsdatum … Anzahl der Seiten 86`) still
     emits ZERO diagnostics.
   - Module-overview pages with isolated channel markers still
     emit Sprint 82's `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS`
     warnings + `PDF_MODULE_CHANNEL_MARKER_DETECTED` info.
   - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` still fires at
     the end (no IO rows extracted).
   - **No `plc_channel:%I1` / `%I3` candidates.** Build PIR stays
     disabled / refuses.
   - Source-evidence drilldown still shows Snippet + Bounding
     box (pt) (Sprint 82 fix preserved). Each rollup's
     representative `SourceRef` points at the first page where
     the signature appeared.
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

## Honest constraints (Sprint 83C)

- **Volume / UX change only — no new extraction capability.**
  Sprint 83C aggregates the diagnostics Sprint 83B already chose
  to emit. It does NOT extract new IO rows, recognise new
  families, classify new tokens, or change confidence semantics.
- **Per-signature granularity, not per-region.** Two BOM headers
  whose normalised text differs (e.g. one with an extra column,
  one without) produce two rollups. The signature key is the
  Sprint 83B `nonIoFamilyDiagnosticSignature` (lowercase + collapse
  whitespace + cap at 120 chars).
- **Page ranges are compressed lossily for human readers.** The
  representative `SourceRef` only points at the first page; the
  full page set is in the message text (`pages 80–86`). If you
  need machine-readable per-page evidence for a downstream tool,
  parse the message or use the underlying `tableCandidates`.
- **Family-then-min-page ordering only.** Within a family, the
  earliest-page rollup comes first. Across families the order is
  alphabetical (`bom_parts_list` before `cable_list` before
  `contents_index` before `legend` before `terminal_list`).
- **Single-page documents look identical to Sprint 83B.** Rollup
  for a single page prints `page 1` (singular) and the count is
  one — no change in user-visible behaviour for short PDFs.
- **No layout heuristics.** The classifier still operates per
  line, not per page. A line that names a non-IO family in
  isolation on a page that's actually an IO-list page would
  still suppress on Sprint 83C (it would suppress under Sprint
  83A / 83B too).
- **No OCR. No symbol recognition. No wire tracing. No
  multi-column / rotated-page support. No automatic codegen.**
- **PDF-derived confidence still capped at 0.65, ≥ 0.5.**
- **Raw PDF bytes still NEVER persisted in the snapshot.**
- **PDF snippets remain potentially sensitive.**

## Recommended next sprint

If Sprint 83C's rollups behave correctly on the
`TcECAD_Import_V2_2_x.pdf` browser pass:

- **Sprint 83D — PDF source-evidence UX.** Optional page
  preview with bbox overlays, click-through from a candidate
  to its source region on the rendered PDF page, group-level
  drilldown into all pages a rollup covered (currently only the
  representative page is linked).

Alternative if real-world PDFs surface more layout-shape problems:

- **Sprint 84 — PDF layout hardening.** Multi-column ordering,
  rotated pages, coordinate normalisation, region clustering,
  better column-position detection from real geometry.

OCR fallback, symbol recognition, wire-graph reconstruction, and
controlled codegen preview stay later in the roadmap.
