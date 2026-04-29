# Sprint 83A — manual PDF acceptance pass

> **Status: classifier hardening on top of Sprint 82's address
> strictness.** The Sprint 82 manual run on the public 86-page
> `TcECAD_Import_V2_2_x.pdf` produced clean diagnostics for the
> module-overview pages but kept reporting BOM headers
> (pages 80–86) as IO-list-shaped via Sprint 81's
> `PDF_TABLE_HEADER_DETECTED` info. Sprint 83A introduces a
> table-family classifier so BOM / terminal / cable / contents /
> legend headers land as their own family diagnostics — the
> operator's stream stays explainable.

## What changed at the domain layer

- New `classifyPdfTableHeader(text)` returning
  `{ family, confidence, roles, reasons }` with families
  `io_list | bom_parts_list | terminal_list | cable_list |
  contents_index | legend | unknown`.
- Strong-token sets per family:
  - **IO** — `address` / `addr` / `adresse` / `io` / `i/o` /
    `e/a` / `input` / `output` / `eingang` / `ausgang` /
    `direction` / `signal` / `channel` / `kanal` / `sps` /
    `plc`.
  - **BOM** — `menge` / `quantity` / `artikelnummer` /
    `typnummer` / `hersteller` / `manufacturer` / `lieferant` /
    `bestellnummer` / `stückliste` / `teileliste` /
    `parts-list` / `material` / `bom` / `catalog`.
  - **Terminal** — `klemmenplan` / `klemmleiste` / `klemme` /
    `terminal` / `ziel` / `quelle` / `anschluss`.
  - **Cable** — `kabel` / `kabelplan` / `kabelübersicht` /
    `cable` / `ader` / `conductor` / `wire`.
  - **Contents** — `inhaltsverzeichnis` / `contents` / `seite`
    / `datum` / `bearbeiter`.
  - **Legend** — `legende` / `legend` / `strukturierungsprinzipien`
    / `referenzkennzeichen`.
- Resolution rules (first match wins, every decision auditable
  via `reasons`):
  1. Legend tokens win when present.
  2. Contents tokens win when ≥ 2 are present.
  3. BOM beats IO unless IO has strictly more hits AND owns the
     `address` role. ← **closes the page-80–86 gap.**
  4. Cable beats terminal on tie (`kabel` / `ader` are
     unambiguous; `Quelle` / `Ziel` are ambiguous and appear
     on cable lists too).
  5. IO requires ≥ 1 strong IO token AND ≥ 2 column roles.
- `detectIoTableHeader` now returns `null` for any non-IO
  family, even when the role floor passes (`bmk → tag` +
  `bezeichnung → description` no longer slips through).
- `detectIoTables` non-IO branch emits one precise info
  diagnostic per `(family, page, blockId)`:
  - `PDF_BOM_TABLE_DETECTED`
  - `PDF_TERMINAL_TABLE_DETECTED`
  - `PDF_CABLE_TABLE_DETECTED`
  - `PDF_CONTENTS_TABLE_IGNORED`
  - `PDF_LEGEND_TABLE_IGNORED`
  - `PDF_TABLE_HEADER_REJECTED` (fallback)

## What stays from Sprint 82

- PDF address strictness — isolated `I1` / `O2` / `%I1` channel
  markers are still NOT promoted to buildable PIR addresses.
- `extractIoRow` still rejects channel-marker tags.
- `buildGraphFromIoRows` still skips `plc_channel:` + edge for
  non-strict rows.
- PDF-derived confidence stays ≤ 0.65, ≥ 0.5.
- Source-evidence drilldown still surfaces snippet + bbox.
- Raw PDF bytes still NEVER persisted.
- CSV / EPLAN / TcECAD ingestors untouched.

## Captured automated outcomes

The Sprint 83A harness lives in
`packages/electrical-ingest/tests/pdf-table-family.spec.ts`
(35 tests). The Sprint 82 strictness harness (42 tests) +
Sprint 81 acceptance harness (4 tests) remain green.

The real-observed header from the Sprint 82 manual run:

```
Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer
```

Now classifies as `bom_parts_list`, raises
`PDF_BOM_TABLE_DETECTED` (info), and produces NO table
candidate. The Sprint 81 over-broad `PDF_TABLE_HEADER_DETECTED`
no longer fires for BOM rows.

The strict-address path (Sprint 81 Case A):

```
I0.0 B1 Part present
Q0.0 Y1 Cylinder extend
```

Still produces 2 IO candidates + table candidate as before.
The IO-list path is NOT regressed.

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprint 82's manual run).
3. Press **Ingest**.
4. Expected (Sprint 83A):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks
     across 86 pages (same shape as Sprint 82).
   - **Pages 80–86** no longer emit `PDF_TABLE_HEADER_DETECTED`.
     Each page emits ONE `PDF_BOM_TABLE_DETECTED` info instead
     (or zero if the BOM header repeats verbatim across pages
     — deduped by `(family, page, blockId)`).
   - Module-overview pages with isolated channel markers
     (`I1` / `I3`) still emit `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS`
     warnings + `PDF_MODULE_CHANNEL_MARKER_DETECTED` info
     (Sprint 82 behaviour preserved).
   - **No `plc_channel:%I1` / `plc_channel:%I3` candidates.**
     Build PIR stays disabled / refuses.
   - Source-evidence drilldown still shows `Snippet` +
     `Bounding box (pt)` (Sprint 82 fix preserved).
5. Also test a generated strict-address PDF (Sprint 81 Case A):
   ```
   I0.0 B1 Part present
   Q0.0 Y1 Cylinder extend
   ```
   Expected: 2 IO candidates extracted; accept all → valid PIR
   preview with 2 IO + 2 equipment. The strict-address path
   has NOT regressed.

## Honest constraints (Sprint 83A)

- **Strong-token sets are not exhaustive.** Real subcontractor
  PDFs may use vendor-specific BOM / terminal / cable
  vocabulary that Sprint 83A doesn't yet recognise. Those will
  fall back to `'unknown'` family and the assembler ignores
  them silently — operators see neither an IO table nor a
  family diagnostic. Adding new keywords is a constant addition
  to the relevant `STRONG_*_TOKENS` set; no schema or regex
  change.
- **Header-only fallback (no items geometry).** The text-mode
  path splits the line by whitespace. Single-character header
  cells inside a multi-word header (e.g. `Tag Code`) won't
  classify cleanly. The bytes path uses real pdfjs item
  geometry and is unaffected.
- **No layout heuristics yet.** Sprint 83A doesn't classify
  pages by title (e.g. "Inhaltsverzeichnis"); it operates per
  line. A line that happens to mention "Inhaltsverzeichnis"
  outside a contents page would still classify as
  `contents_index`. In practice, contents tokens are rare
  outside of contents pages so this is acceptable for v0.
- **No OCR. No symbol recognition. No wire tracing. No
  multi-column / rotated-page support. No automatic codegen.**
- **Confidence on PDF-derived nodes still capped at 0.65.**
- **Raw PDF bytes still NEVER persisted in the snapshot.**

## Recommended next sprint

If Sprint 83A's classifier behaves correctly on the
`TcECAD_Import_V2_2_x.pdf` browser pass:

- **Sprint 83 — PDF source-evidence UX.** Optional page
  preview with bbox overlays, click-through from a candidate
  to its source region on the rendered PDF page, better
  operator trust during review.

Alternative if real-world PDFs surface more layout-shape
problems:

- **Sprint 83B — PDF layout hardening.** Multi-column
  ordering, rotated pages, coordinate normalisation, region
  clustering, better column-position detection from real
  geometry.

OCR fallback, symbol recognition, wire-graph reconstruction,
and controlled codegen preview stay later in the roadmap.
