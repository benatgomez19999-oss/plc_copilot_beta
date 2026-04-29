# Sprint 83B — manual PDF acceptance pass

> **Status: diagnostic-hygiene throttling on top of Sprint 83A's
> family classifier.** Sprint 83A made the classifier safe — BOM
> headers no longer slip through the IO-list gate. The Sprint
> 83A manual run on `TcECAD_Import_V2_2_x.pdf` (86 pages) then
> exposed a noise problem: the non-IO branch emitted hundreds of
> per-line family diagnostics (vendor metadata footers, repeated
> title-block lines, body rows that incidentally hit a strong
> family token). Sprint 83B keeps the safety guarantee and makes
> the diagnostic stream operator-readable.

## What changed at the domain layer

Three cooperating helpers were added to
[`packages/electrical-ingest/src/sources/pdf-table-detect.ts`](../packages/electrical-ingest/src/sources/pdf-table-detect.ts):

1. **`isFooterOrTitleBlockLine(text)`** — recognises repeated
   page-footer / title-block metadata. Lines matching any of
   the patterns below NEVER produce a non-IO family diagnostic,
   regardless of how the classifier votes:
   - `^Datum \d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4} … \bSeite\b` (German
     title-block footer).
   - `^Bearb\b` (editor field; almost always followed by an
     ECAD reference designator like `=CABLE`).
   - `^Änderungsdatum\b`.
   - `^Anzahl der Seiten\b`.
   - `^Seite N (von|/) M$` (trailing page counter).

2. **`passesNonIoFamilyHeaderShapeGate(text, classification)`** —
   only lets a non-IO family diagnostic through when the line
   is *header-shaped*. Pass rules (any of):
   - The line matches a canonical family-title regex
     (`Stückliste`, `Teileliste`, `Klemmenplan`,
     `Klemmleistenübersicht`, `Kabelplan`, `Kabelübersicht`,
     `Inhaltsverzeichnis`, `Legende`, `Parts list`, `Bill of
     materials`, `Terminal list`, `Cable list`, `Table of
     contents`).
   - The line has ≥ 3 strong family-token hits AND ≥ 4 total
     non-trivial tokens (a real column-header row).

   Footer / title-block lines (caught by the first helper) ALWAYS
   fail this gate, regardless of any token count.

3. **`nonIoFamilyDiagnosticSignature(text)`** — normalised dedup
   key. Trim + lowercase + collapse whitespace, capped at 120
   chars. The `detectIoTables` dedup key changed from Sprint
   83A's `${family}:${page}:${blockId}` (per-line!) to Sprint
   83B's `${sourceId}:${page}:${family}:${signature}`
   (per-page-per-signature).

## What stays from Sprints 82 & 83A

- PDF address strictness intact — isolated `I1` / `O2` / `%I1`
  channel markers from PDF still NEVER become buildable PIR
  addresses.
- IO-list classifier semantics intact — real `Address Tag
  Description`-shaped headers still produce
  `PdfTableCandidate` + `PDF_TABLE_HEADER_DETECTED`.
- Family classifier semantics intact — BOM/terminal/cable/
  contents/legend still resolve correctly.
- Source-evidence drilldown still surfaces snippet + bbox.
- Raw PDF bytes still NEVER persisted in the snapshot.
- CSV / EPLAN / TcECAD ingestors untouched.

## Captured automated outcomes

The Sprint 83B harness lives in
`packages/electrical-ingest/tests/pdf-table-family-throttling.spec.ts`
(36 tests).

| Case | Sprint 83A behaviour | Sprint 83B behaviour |
| --- | --- | --- |
| `Datum 22.10.2013 … Seite` | Emitted `PDF_CONTENTS_TABLE_IGNORED` per line | **Suppressed** (footer regex) |
| `Bearb RAL =CABLE` | Emitted `PDF_CABLE_TABLE_DETECTED` per line | **Suppressed** (footer regex) |
| `Änderungsdatum … Anzahl der Seiten 86` | Emitted contents diagnostic | **Suppressed** |
| `Fabrikat BECKHOFF` | Emitted `PDF_BOM_TABLE_DETECTED` (1 strong token, < 4 tokens) | **Suppressed** (header-shape gate) |
| `Hersteller (Firma) Beckhoff Automation GmbH` | Emitted `PDF_BOM_TABLE_DETECTED` | **Suppressed** (1 strong BOM token) |
| `Klemmen ` | Emitted `PDF_TERMINAL_TABLE_DETECTED` | **Suppressed** (single-token line) |
| `=CABLE&EMB/24 2` | Emitted `PDF_CABLE_TABLE_DETECTED` per row | **Suppressed** (no strong token + body shape) |
| `Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer` | Emitted `PDF_BOM_TABLE_DETECTED` per occurrence | **One diagnostic per (page, signature)** — repeats on the same page collapse |
| Real IO-list header `Address Tag Description` | Emitted `PDF_TABLE_HEADER_DETECTED` + `PdfTableCandidate` | **Unchanged** — IO path NOT regressed |

For the realistic TcECAD-style integration test (mock page with
9 lines: 4 footer/metadata + 1 BOM canonical header + 3 body
rows + 1 trailing footer), Sprint 83B emits **at most 2 family
diagnostics** (one BOM canonical-header + 0–1 contents/footer
edge), down from Sprint 83A's 6+.

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprint 82's and 83A's manual runs).
3. Press **Ingest**.
4. Expected (Sprint 83B):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks
     across 86 pages (same shape as Sprint 82 / 83A).
   - **Diagnostics drop from hundreds to a manageable count.**
     Each BOM page emits roughly one `PDF_BOM_TABLE_DETECTED`
     for the canonical header line; vendor metadata
     ("Hersteller (Firma) Beckhoff Automation GmbH",
     "Fabrikat BECKHOFF", "Datum … Seite", "Bearb RAL =CABLE",
     "Änderungsdatum … Anzahl der Seiten 86") emit ZERO
     diagnostics.
   - Module-overview pages with isolated channel markers still
     emit Sprint 82's `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS`
     warnings + `PDF_MODULE_CHANNEL_MARKER_DETECTED` info.
   - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` still fires
     at the end (no IO rows extracted).
   - **No `plc_channel:%I1`/`%I3` candidates.** Build PIR stays
     disabled / refuses.
   - Source-evidence drilldown still shows Snippet + Bounding
     box (pt) (Sprint 82 fix preserved).
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

## Honest constraints (Sprint 83B)

- **Diagnostics hygiene only — no new extraction capability.**
  Sprint 83B is a noise reduction pass. The PDF v0/v1 extractor
  semantics from Sprints 79–83A are unchanged.
- **The footer/title-block recogniser is heuristic.** It handles
  the patterns observed in `TcECAD_Import_V2_2_x.pdf`. Other
  PDFs may use different footer conventions (e.g. ANSI title
  blocks, vendor-specific stamps); those will fall through and
  potentially still emit a single throttled diagnostic. Adding
  new footer regexes is a constant addition to
  `FOOTER_OR_TITLE_BLOCK_PATTERNS` — no schema change.
- **The header-shape gate's 3-strong-tokens threshold may be
  too strict for some borderline headers** (e.g. a 2-strong-
  token cable line `Kabel Ader Quelle Ziel` — the canonical
  `Kabelübersicht` title still passes). Operators can confirm
  the family classification against the captured snippet
  during review.
- **No layout heuristics.** The classifier still operates per
  line, not per page. A line that names a non-IO family in
  isolation on a page that's actually an IO-list page would
  still suppress on Sprint 83B (it would suppress under Sprint
  83A too — the difference is just the diagnostic count).
- **No OCR. No symbol recognition. No wire tracing. No
  multi-column / rotated-page support. No automatic codegen.**
- **PDF-derived confidence still capped at 0.65, ≥ 0.5.**
- **Raw PDF bytes still NEVER persisted in the snapshot.**
- **PDF snippets remain potentially sensitive.**
- **Classifier vocabulary is heuristic and not vendor-certified.**
  Sprint 83B keeps the same `STRONG_*_TOKENS` sets from Sprint
  83A; it doesn't add new vendor-specific keywords.

## Recommended next sprint

If Sprint 83B's hygiene gate behaves correctly on the
`TcECAD_Import_V2_2_x.pdf` browser pass:

- **Sprint 83 — PDF source-evidence UX.** Optional page
  preview with bbox overlays, click-through from a candidate
  to its source region on the rendered PDF page, better
  operator trust during review.

Alternative if real-world PDFs surface more layout-shape
problems:

- **Sprint 83C — PDF layout hardening.** Multi-column
  ordering, rotated pages, coordinate normalisation, region
  clustering, better column-position detection from real
  geometry.

OCR fallback, symbol recognition, wire-graph reconstruction,
and controlled codegen preview stay later in the roadmap.
