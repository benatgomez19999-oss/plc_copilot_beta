# PDF ingestion architecture — Sprint 79 → 80 → 81 → 82 → 83A → 83B → 83C

> **Status: non-IO family diagnostic rollups (Sprint 83C).**
> Sprint 79 landed the foundation. Sprint 80 added a real
> text-layer extractor. Sprint 81 added IO-list table extraction
> + the first acceptance harness. Sprint 82 closed a real-world
> safety gap with PDF-specific address strictness. Sprint 83A
> hardened the family classifier so BOM / terminal / cable /
> contents / legend headers stop slipping through the IO gate.
> Sprint 83B suppressed footer / weak-token / body-row noise and
> collapsed within-page duplicates. **Sprint 83C** keeps every
> Sprint 82 / 83A / 83B safety guarantee verbatim and aggregates
> the surviving non-IO family diagnostics across pages: instead
> of 7 `PDF_BOM_TABLE_DETECTED` infos for an 86-page TcECAD PDF,
> the operator sees 1 rollup with `pages 80–86`. Volume / UX
> change only — no schema bump, no new extraction capability,
> no loosened safety. Confidence still capped at `0.65`. Still
> no OCR, symbol recognition, multi-column / rotated support,
> wire tracing, or automatic PIR/codegen.

## Why PDF support is strategic

PLC Copilot's mission is dual-source ingestion:

1. **Structured exports** — CSV terminal lists, EPLAN XML, Beckhoff/
   TwinCAT ECAD XML. These are already production-grade ingestors
   in `@plccopilot/electrical-ingest`.
2. **Document sources** — PDF schematics, IO lists, terminal-strip
   layouts, cabinet drawings. These are how electrical contractors
   typically hand off evidence to PLC programmers when a structured
   export is unavailable.

A serious industrial copilot must read both. The architectural
gate is the same: **a weak prompt must never override hard,
source-traceable evidence**. PDF ingestion makes that gate
load-bearing for documents too — every claim from a PDF page
carries a `SourceRef` with `kind: 'pdf'`, `page`, optional
`bbox`, and a verbatim `snippet` so the operator can audit "where
did this fact come from?" before it can promote to PIR.

## Non-goals (load-bearing through Sprint 80)

- **No OCR.** Sprint 80 NEVER runs OCR — not even silently when
  `allowOcr: true` is passed; that flag is reserved for a future
  opt-in and currently raises `PDF_OCR_NOT_ENABLED` info.
- **No symbol / connection-graph recognition.** Sprint 80 only
  extracts text-layer items + clusters them into lines; it makes
  no claim about reading schematic geometry.
- **No layout-aware table detection.** Every parse emits
  `PDF_TABLE_DETECTION_NOT_IMPLEMENTED` info as a roadmap reminder.
- **No symbol / connection-graph recognition.** PDFs of schematic
  diagrams are accepted as input but Sprint 79 produces text
  blocks only.
- **No prompt-driven inference.** The IO-row extractor is a single,
  conservative regex (`<address> <tag> [<label>]`). Anything more
  ambitious must wait for higher-confidence sprints.
- **No PLC codegen.** Always.
- **No raw PDF persistence.** The Sprint 78B review-session
  snapshot does NOT carry the PDF bytes (privacy default).

## Sprint 83C — what changed on top of Sprint 83B

Volume / UX hardening sprint. No new extraction capability; the
Sprint 82 strictness gate, Sprint 83A family classifier, and
Sprint 83B hygiene helpers stay verbatim.

Sprint 83B kept per-page-per-signature granularity. Identical BOM
canonical headers on pages 80–86 each emitted their own
`PDF_BOM_TABLE_DETECTED`; the operator saw 7+ family diagnostics
per real-world TcECAD PDF. Sprint 83C aggregates by `(family,
signature)` only (page deliberately removed from the dedup key)
and emits one rollup info diagnostic per group with a compressed
page range:

- `compressPageRanges(pages)` — pure helper. Drops non-finite /
  non-positive entries, sorts, dedups, coalesces consecutive runs
  into `"X–Y"` (en-dash). Returns `""` for empty, `"1"` for a
  single page, `"80–86"` for one run, `"3, 49–54"` for mixed.
- `detectIoTables` non-IO branch — accumulates each occurrence
  into a `Map<key, NonIoFamilyOccurrence>` keyed by
  `${family}:${signature}`. Each occurrence keeps a `Set<number>`
  of pages, the first page's `SourceRef` as representative, the
  first occurrence's snippet, and the first reason. At end of
  scan the map is sorted by family name then min page and one
  rollup info diagnostic is emitted per group with the message:
  `Ignored ${label} sections on ${pagePhrase}. These are not IO
  lists. First evidence: "${snippet}" (${reason}).`
- The diagnostic codes are unchanged
  (`PDF_BOM_TABLE_DETECTED`, `PDF_TERMINAL_TABLE_DETECTED`,
  `PDF_CABLE_TABLE_DETECTED`, `PDF_CONTENTS_TABLE_IGNORED`,
  `PDF_LEGEND_TABLE_IGNORED`, `PDF_TABLE_HEADER_REJECTED`).
  No schema bump.

`pdf.ts`'s text-mode and bytes-mode paths now call
`detectIoTables` ONCE across all pages (collecting detector lines
from every page, then redistributing the returned
`tableCandidates` back to each `PdfPage` by `pageNumber`).
Previous per-page-loop call would have prevented Sprint 83C
aggregation from firing on the real pipeline.

For the realistic TcECAD-style mock (BOM headers on pages 80–86
+ cable on 49–54 + contents on 3 + terminal on 1), Sprint 83C
emits **at most 4 family rollups**, down from Sprint 83B's 7+.

Manual acceptance: documented in
[`docs/pdf-manual-acceptance-sprint-83C.md`](pdf-manual-acceptance-sprint-83C.md).

## Sprint 83B — what changed on top of Sprint 83A

Diagnostic-hygiene sprint. No new extraction capability; the
Sprint 83A family classifier and Sprint 82 strictness gate
stay verbatim.

The Sprint 83A non-IO branch deduplicated by
`(family, page, blockId)` — but every line of an 86-page
TcECAD PDF has a different `blockId`, so vendor-metadata
footers, repeated title-block lines, and body rows that
incidentally hit a strong family token each emitted their own
diagnostic. The manual run on `TcECAD_Import_V2_2_x.pdf`
produced **hundreds** of duplicate non-IO family diagnostics.

Sprint 83B adds three cooperating helpers in
[`pdf-table-detect.ts`](../packages/electrical-ingest/src/sources/pdf-table-detect.ts):

- `isFooterOrTitleBlockLine(text)` — recognises German
  title-block / footer metadata (`Datum … Seite`, `Bearb …`,
  `Änderungsdatum …`, `Anzahl der Seiten …`, trailing
  `Seite N von M`). Footer lines NEVER produce a non-IO
  family diagnostic.
- `passesNonIoFamilyHeaderShapeGate(text, classification)` —
  requires a canonical family-title regex match
  (`Stückliste`, `Klemmenplan`, `Kabelübersicht`,
  `Inhaltsverzeichnis`, `Legende`, …) OR ≥ 3 strong family
  tokens AND ≥ 4 total non-trivial tokens. Single-strong-token
  lines (`Fabrikat BECKHOFF`, `Klemmen `, `Hersteller (Firma)
  …`) and body rows (`=CABLE&EMB/24 2`) are suppressed.
- `nonIoFamilyDiagnosticSignature(text)` — normalised dedup
  key (lowercase + collapse whitespace + cap at 120 chars).
  The `detectIoTables` dedup key changed to
  `${sourceId}:${page}:${family}:${signature}`, so identical
  headers within a page collapse to one diagnostic; the same
  header on a different page still produces one (per-page
  granularity preserved).

For the realistic TcECAD-style mock page (footer + vendor
metadata + canonical BOM header + body rows), the Sprint 83B
integration test asserts ≤ 2 non-IO family diagnostics, down
from the Sprint 83A 6+ baseline.

Manual acceptance: documented in
[`docs/pdf-manual-acceptance-sprint-83B.md`](pdf-manual-acceptance-sprint-83B.md).

## Sprint 83A — what changed on top of Sprint 82

Classifier hardening sprint surfaced by the Sprint 82 manual run
on `TcECAD_Import_V2_2_x.pdf`. Sprint 81's `detectIoTableHeader`
flagged BOM headers like
`Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer`
as IO-list-shaped because `bmk → tag` + `bezeichnung → description`
satisfied the role floor. Sprint 83A introduces a per-family
classifier on top of the role keywords:

- `classifyPdfTableHeader(text)` returns one of `'io_list' |
  'bom_parts_list' | 'terminal_list' | 'cable_list' |
  'contents_index' | 'legend' | 'unknown'` with strong-token
  sets per family + auditable `reasons`.
- `detectIoTableHeader` returns `null` for any non-IO family,
  even when the role floor passes.
- `detectIoTables` non-IO branch emits family-specific info
  diagnostics (`PDF_BOM_TABLE_DETECTED`,
  `PDF_TERMINAL_TABLE_DETECTED`, `PDF_CABLE_TABLE_DETECTED`,
  `PDF_CONTENTS_TABLE_IGNORED`, `PDF_LEGEND_TABLE_IGNORED`,
  `PDF_TABLE_HEADER_REJECTED`), one per `(family, page,
  blockId)`. The Sprint 81 over-broad `PDF_TABLE_HEADER_DETECTED`
  no longer fires for non-IO families.

CSV / EPLAN / TcECAD ingestors keep using `detectPlcAddress` and
their own classifiers; the family classifier is PDF-only.

Sprint 82's address strictness gate is preserved verbatim:
isolated `I1` / `O2` / `%I1` channel markers from PDF still
never become buildable PIR addresses.

Manual acceptance regression on `TcECAD_Import_V2_2_x.pdf`:
pages 80–86 BOM headers no longer surface as IO-list headers;
the rest of the diagnostic stream (Sprint 80 text-layer extraction,
Sprint 81 page-level table-detection-not-implemented,
Sprint 82 channel-marker warnings) is unchanged. Documented in
[`docs/pdf-manual-acceptance-sprint-83A.md`](pdf-manual-acceptance-sprint-83A.md).

## Sprint 82 — what changed on top of Sprint 81

Safety / hardening sprint. No new feature; one new safety
classifier, two new files, one regression scenario.

### `classifyPdfAddress(token)` — PDF-only strictness

Lives in
[`packages/electrical-ingest/src/sources/pdf-address-strictness.ts`](../packages/electrical-ingest/src/sources/pdf-address-strictness.ts).
Returns `'strict_plc_address' | 'channel_marker' | 'ambiguous' |
'invalid'`:

- **Strict** — explicit byte-bit notation (`I0.0`, `Q0.1`,
  `%I0.0`, `%Q0.1`, `I 0.0`), explicit IEC `%IX0.0` / `%QX0.0`
  / `%MX0.0`, or Rockwell `Local:1:I.Data[0].0`.
- **Channel marker** — bare `I\d+` / `O\d+` / `Q\d+`
  (with or without `%` prefix, with or without `+` / `-`
  modifier). On a Beckhoff EL1004 / EL2004 hardware-overview
  page these are *module channels*, NOT byte/bit addresses.
- **Ambiguous** — anything else address-shaped.

CSV / EPLAN / TcECAD ingestors keep using `detectPlcAddress`
unchanged. The strictness classifier is invoked from PDF-row
extraction only.

### `extractIoRow` strictness gate

After the row regex matches:

1. If the **tag column** is itself a channel marker, the whole
   row is rejected (the `I1 I2` page-24 noise case).
2. The **address column** is classified.
3. **Strict** → row passes through with `address` set. Same
   diagnostics as Sprint 81 (`PDF_IO_ROW_EXTRACTED` info).
4. **Channel marker** → row preserved as evidence with
   `address: undefined` and `addressClassification:
   'channel_marker'`. Diagnostics:
   - `PDF_MODULE_CHANNEL_MARKER_DETECTED` (info)
   - `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS` (warning)
5. **Ambiguous** → row preserved as evidence. Diagnostics:
   - `PDF_IO_ROW_REQUIRES_STRICT_ADDRESS` (warning)
   - `PDF_IO_ROW_AMBIGUOUS_ADDRESS` (warning)

Confidence on non-strict rows takes a `-0.05` penalty, capped
between 0.5 and 0.65.

### `buildGraphFromIoRows` non-strict branch

Strict rows still produce `pdf_device:<tag>` + `plc_channel:<addr>`
+ direction-aware edge as before. Non-strict rows produce only
the device evidence node, with two new attributes:

- `attributes.channel_marker` — verbatim raw token (`'I1'`,
  `'%Q1'`, etc.).
- `attributes.address_classification` — `'channel_marker' |
  'ambiguous'`.

The `plc_channel:` node is NOT created. The PIR builder never
sees the row as IO → `%I1` will never appear in a built PIR.

### Web — source-evidence drilldown surfaces snippet + bbox

`packages/web/src/utils/review-source-refs.ts` projection now
includes:

- `Snippet` — the verbatim row text the extractor captured.
- `Bounding box` — `x=… y=… w=… h=… (pt)` in PDF point space.

Sprint 79–81 already populated these fields on the `SourceRef`,
but the UI dropped them. Sprint 81's manual TcECAD run confirmed
the gap; Sprint 82 closes it.

### Manual acceptance regression

`TcECAD_Import_V2_2_x.pdf`'s page-24 channel markers no longer
become buildable `%I1` / `%I3` PIR IO addresses. Documented in
[`docs/pdf-manual-acceptance-sprint-82.md`](pdf-manual-acceptance-sprint-82.md).

## Sprint 81 — what changed on top of Sprint 80

Sprint 81 extends the producer side; the snapshot/export contract
is unchanged.

### IO-row extraction is multi-pattern

`extractIoRow` (in `pdf.ts`) now tries four patterns in priority
order and records which one matched in the row's `reasons` trail
(`pdf-row-pattern:<name>`):

1. **`tag-dir-addr`** — `<tag> <direction-word> <address> [label]`.
   Direction words: `input`/`in`/`output`/`out` + `eingang`/
   `ausgang` + the very-short forms (`i`/`o`/`e`/`a`).
2. **`addr-tag-dir`** — `<address> <tag> <direction-word> [label]`.
3. **`addr-tag`** — Sprint 79 baseline.
4. **`tag-addr`** — tag-first variant for EPLAN-style exports.

### Address direction wins on conflict

When a row supplies both an explicit direction word and an address
whose family already implies a direction (`I` / `Q`), the address
direction wins and `PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT`
(warning) is raised so the operator sees the mismatch during
review. Confidence is not lowered — PDF-derived rows are already
capped at 0.65.

### Table detection v0

[`packages/electrical-ingest/src/sources/pdf-table-detect.ts`](../packages/electrical-ingest/src/sources/pdf-table-detect.ts)
walks each page's lines top-to-bottom and:

1. Looks for an IO-list-shaped header (`detectIoTableHeader`):
   ≥ 2 known keywords AND at least one of them maps to `address`
   or `tag`. Keyword map covers English + German + abbreviated
   forms (Address / Adresse / Addr / E/A / Eingang / Ausgang /
   BMK / Bezeichnung / Funktion / Channel / Kanal / etc.).
2. Treats subsequent lines as data rows while they match
   `looksLikeIoRow` (any of the four IO-row patterns above).
3. Closes the table on the first non-row line.
4. Emits `PDF_TABLE_HEADER_DETECTED` + `PDF_TABLE_CANDIDATE_DETECTED`
   + one `PDF_TABLE_ROW_EXTRACTED` per data row.

Each row stores its parent line block in `cells`, the verbatim
text in `rawText`, the row kind (`'header' | 'data' | 'unknown'`),
and the same `SourceRef` (`kind: 'pdf'`, `page`, `bbox`,
`snippet`). The detector populates `headerLayout.columns` with
real x positions when geometry is available — the bytes path
seeds them from the pdfjs items, the test-mode text path
synthesises proportional bands (Sprint 81's hard requirement of
≥ 2 known keywords protects the fallback against false
positives).

### Confidence ladder (Sprint 81)

| Pattern | Base | Adjustments |
| --- | --- | --- |
| `addr-tag` | 0.55 | `+0.05` if label present |
| `tag-addr` | 0.55 | `+0.05` if label present |
| `tag-dir-addr` | 0.55 | `+0.05` label, `+0.02` direction column, `+0.02` header-aware pattern |
| `addr-tag-dir` | 0.55 | `+0.05` label, `+0.02` direction column, `+0.02` header-aware pattern |

Hard cap remains `0.65`. PDF-derived nodes never read higher than
a structured CSV/XML row.

### Manual acceptance harness

The first deterministic acceptance harness lives in
[`packages/electrical-ingest/tests/pdf-acceptance.spec.ts`](../packages/electrical-ingest/tests/pdf-acceptance.spec.ts).
Four cases (tabular IO list, tag-first + direction column,
narrative no-IO, malformed bytes). Run with:

```sh
pnpm --filter @plccopilot/electrical-ingest test -- pdf-acceptance
```

Detailed expected outcomes + operator-side web-upload
instructions:
[`docs/pdf-manual-acceptance-sprint-81.md`](pdf-manual-acceptance-sprint-81.md).

## Sprint 80 supported behaviour

Three paths through `ingestPdf` (priority order):

### 1. Bytes path with real text-layer extraction (Sprint 80 — NEW)

When the caller supplies `PdfIngestionInput.bytes`:

- The first 5 bytes are checked against `%PDF-`. Mismatch →
  `PDF_MALFORMED` error; extractor is not invoked.
- Otherwise the bytes go through `extractPdfTextLayer` (see
  [`docs/pdf-text-layer-extraction.md`](pdf-text-layer-extraction.md)),
  which dynamically imports `pdfjs-dist/legacy/build/pdf.mjs`,
  walks each page, and yields a list of text items with
  `(x, y, width, height)` in PDF point space.
- `pdf-text-normalize.ts` clusters items by baseline-Y into
  deterministic lines. Each line becomes a `PdfTextBlock` with a
  combined `bbox` (unit `'pt'`), deterministic id
  (`pdf:<sourceId>:p<page>:b<index>`), and a `SourceRef` carrying
  `kind: 'pdf'`, `path`, `page`, `line` (= block index in page),
  `snippet`, `bbox`, and a `symbol` of the form
  `pdf:page:N/line:M`.
- The same conservative IO-row regex from Sprint 79 runs over each
  line's text; matches produce `pdf_device:<tag>` +
  `plc_channel:<address>` nodes with `signals` (input) or `drives`
  (output) edges. PDF-derived nodes never read above 0.65
  confidence.
- Per-parse diagnostic surface:
  - `PDF_TEXT_LAYER_EXTRACTED` (info) — N line blocks across M pages.
  - `PDF_TABLE_DETECTION_NOT_IMPLEMENTED` (info) — roadmap reminder.
  - `PDF_OCR_NOT_ENABLED` (info, only if `allowOcr` was set).
  - `PDF_TEXT_LAYER_EMPTY_PAGE` (warning, per page) — the page
    has no extractable text (typical for scanned-image-only pages).
  - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` (info) — text
    layer extracted but no IO-row pattern matched.
  - `PDF_NO_TEXT_BLOCKS` (warning) — extraction succeeded but
    every page was empty.

Failure modes (no fake fall-through):

- `PDF_DEPENDENCY_LOAD_FAILED` (error) — `pdfjs-dist` failed to
  dynamically import. Possible after a partial reinstall.
- `PDF_TEXT_LAYER_EXTRACTION_FAILED` (error) — `pdfjs.getDocument`
  threw on this byte stream (unsupported version, corrupted
  cross-ref table, etc.).
- `PDF_ENCRYPTED_NOT_SUPPORTED` (error) — `pdfjs` raised a
  `PasswordException`. The metadata flag `encrypted: true` is
  set on the `PdfDocument`.

When extraction fails AND `text` was also supplied, the ingestor
falls back to path 3 (test-mode text) so fixtures keep working.

### 2. Bytes path fallback to test-mode text (Sprint 80)

If `bytes` were provided but the real extractor failed (encrypted,
malformed body, dependency-load failed, parse error) AND `text`
was also supplied, the ingestor honours the Sprint 79 test-mode
parser. Both diagnostic sets are preserved so operators see what
happened.

### 3. Test-mode text path (Sprint 79 — preserved verbatim)

When the caller supplies only `PdfIngestionInput.text`:

- **Page splitting.** Lines matching `--- page N ---`
  (case-insensitive, leading/trailing whitespace tolerated)
  introduce a new page. Everything before the first delimiter is
  page 1.
- **Block extraction.** Each non-blank source line becomes a
  `PdfTextBlock` with the same id format as path 1.
- **Confidence ladder.** Same as path 1: 0.6 for IO-row matches,
  0.5 otherwise; never above 0.65.
- **Conservative IO extraction.** Same regex.

This path stays so Sprint 79 fixtures and the `parsePdfDocument`
public helper keep working unchanged.

## Document model

```ts
interface PdfDocument {
  sourceId: string;
  fileName?: string;
  pageCount?: number;
  pages: PdfPage[];
  diagnostics: ElectricalDiagnostic[];
  metadata?: PdfDocumentMetadata;     // title/author/.../encrypted
}

interface PdfPage {
  pageNumber: number;                 // 1-based
  width?: number; height?: number; rotation?: number;
  textBlocks: PdfTextBlock[];
  tableCandidates: PdfTableCandidate[];   // always [] in v0
  diagnostics: ElectricalDiagnostic[];
}

interface PdfTextBlock {
  id: string;                         // pdf:<sourceId>:p<page>:b<index>
  text: string;
  bbox?: PdfBoundingBox;
  confidence: number;                 // [0, 1]
  sourceRef: SourceRef;               // kind: 'pdf'
}

interface PdfBoundingBox {
  x: number; y: number; width: number; height: number;
  unit: 'pt' | 'px' | 'normalized';
}
```

`PdfTableCandidate` is reserved — its shape is locked in but never
populated by Sprint 79. Future sprints may detect tables without a
schema bump.

## SourceRef extensions

Sprint 79 added two optional fields to the cross-cutting
`SourceRef`:

- `bbox?: SourceRefBoundingBox` — visual region.
- `snippet?: string` — short verbatim excerpt.

Both are optional on every `SourceRef.kind`, so existing CSV /
EPLAN / TcECAD ingestors are unaffected. The format reference in
[`docs/electrical-review-session-format.md`](electrical-review-session-format.md)
explains how the persistence layer handles them.

## Diagnostics catalogue

| Code | Severity | When |
| --- | --- | --- |
| `PDF_EMPTY_INPUT` | error | No bytes and no text supplied |
| `PDF_MALFORMED` | error | Bytes do not start with `%PDF-` |
| `PDF_ENCRYPTED_NOT_SUPPORTED` | error | pdfjs raised `PasswordException` (Sprint 80) |
| `PDF_PAGE_LIMIT_EXCEEDED` | warning | More than `maxPages` (default 200) |
| `PDF_UNSUPPORTED_BINARY_PARSER` | warning | **Sprint 79 stub only — no longer emitted by Sprint 80's real path** |
| `PDF_TEXT_LAYER_UNAVAILABLE` | warning | **Sprint 79 stub only — no longer emitted by Sprint 80's real path** |
| `PDF_TEXT_LAYER_EXTRACTED` | info | **Sprint 80** — N line blocks across M pages |
| `PDF_TEXT_LAYER_EMPTY_PAGE` | warning | **Sprint 80** — extracted page contained zero items |
| `PDF_TEXT_LAYER_BBOX_APPROXIMATED` | info | Reserved for future use (not raised in Sprint 80) |
| `PDF_TEXT_LAYER_EXTRACTION_FAILED` | error | **Sprint 80** — pdfjs threw on `getDocument` or `getTextContent` |
| `PDF_DEPENDENCY_LOAD_FAILED` | error | **Sprint 80** — dynamic import of pdfjs-dist failed |
| `PDF_OCR_NOT_ENABLED` | info | `allowOcr=true` was set; OCR is not implemented |
| `PDF_TABLE_DETECTION_NOT_IMPLEMENTED` | info | Always raised once per parse |
| `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` | info | Text recovered but no IO-row matched |
| `PDF_NO_TEXT_BLOCKS` | warning | Text path: input was all whitespace; Bytes path: extraction OK but every page empty |
| `PDF_TEXT_BLOCK_EXTRACTED` | info | Test-mode-text per-parse summary count |
| `PDF_AMBIGUOUS_IO_ROW` | warning | Reserved for future use (not raised in Sprint 81) |
| `PDF_TABLE_HEADER_DETECTED` | info | **Sprint 81** — IO-list header recognised on a page |
| `PDF_TABLE_HEADER_UNSUPPORTED` | warning | Reserved (header shape was not recognisable) |
| `PDF_TABLE_CANDIDATE_DETECTED` | info | **Sprint 81** — a table with ≥ 1 data row was assembled |
| `PDF_TABLE_ROW_EXTRACTED` | info | **Sprint 81** — per data-row info diagnostic |
| `PDF_TABLE_ROW_AMBIGUOUS` | warning | Reserved (row matched header but values were ambiguous) |
| `PDF_IO_ROW_EXTRACTED` | info | **Sprint 81** — IO row extracted, with the matched pattern in the message |
| `PDF_IO_ROW_AMBIGUOUS` | warning | Reserved |
| `PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT` | warning | **Sprint 81** — address direction mismatched a direction-column word; address wins |
| `PDF_IO_ROW_MISSING_TAG` | warning | Reserved |
| `PDF_IO_ROW_MISSING_ADDRESS` | warning | Reserved |
| `PDF_COLUMN_LAYOUT_UNSUPPORTED` | warning | Reserved (multi-column / rotated) |
| `PDF_MULTI_COLUMN_ORDER_UNCERTAIN` | warning | Reserved |
| `PDF_MANUAL_REVIEW_REQUIRED` | info | **Sprint 81** — at least one PDF-derived candidate exists; review required before promotion to PIR |
| `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS` | warning | **Sprint 82** — row's address column was a channel marker; row preserved as evidence but NOT promoted to a buildable PLC address |
| `PDF_MODULE_CHANNEL_MARKER_DETECTED` | info | **Sprint 82** — channel marker recognised in row (per-row companion to the warning above) |
| `PDF_IO_ROW_REQUIRES_STRICT_ADDRESS` | warning | **Sprint 82** — row's address column is ambiguous; strict byte-bit notation required |
| `PDF_IO_ROW_AMBIGUOUS_ADDRESS` | warning | **Sprint 82** — sibling diagnostic to strict-address-required |
| `PDF_PIR_BUILD_ADDRESS_BLOCKED` | warning | Reserved for the PIR-builder reporter (raised when an accepted PDF candidate has no buildable address) |
| `PDF_SOURCE_SNIPPET_MISSING` | info | Reserved — flagged when a candidate landed without the Sprint 80/81 snippet |
| `PDF_SOURCE_BBOX_MISSING` | info | Reserved — flagged when a candidate landed without the Sprint 80/81 bbox |
| `PDF_BOM_TABLE_DETECTED` | info | **Sprint 83A** — BOM / parts / material list header recognised; ignored for IO extraction |
| `PDF_TERMINAL_TABLE_DETECTED` | info | **Sprint 83A** — terminal-list / Klemmenplan header recognised; ignored for IO extraction |
| `PDF_CABLE_TABLE_DETECTED` | info | **Sprint 83A** — cable-list / Kabelplan header recognised; ignored for IO extraction |
| `PDF_CONTENTS_TABLE_IGNORED` | info | **Sprint 83A** — table-of-contents header recognised; ignored |
| `PDF_LEGEND_TABLE_IGNORED` | info | **Sprint 83A** — legend / Strukturierungsprinzipien header recognised; ignored |
| `PDF_TABLE_HEADER_REJECTED` | info | **Sprint 83A** — fallback when a header line passes the role floor but has no recognised family |
| `PDF_TABLE_HEADER_CLASSIFIED` | info | Reserved for downstream callers that want to record full family classification metadata |

## Registry routing

[`createDefaultSourceRegistry`](../packages/electrical-ingest/src/sources/generic.ts)
walks ingestors in registration order. Sprint 79 inserts the PDF
ingestor in front of the unsupported stub:

```
1. CSV          (Sprint 73)
2. TcECAD XML   (Sprint 78A)
3. EPLAN XML    (Sprint 74)
4. PDF          (Sprint 79 — NEW)
5. Unsupported  (Sprint 72 — fall-through for .edz / .epdz)
```

The PDF ingestor's `canIngest` returns true if any file in the
input has `kind: 'pdf'`, ends with `.pdf`, or whose content starts
with `%PDF-`. Existing CSV / EPLAN / TcECAD routes are unchanged.

## Web flow

`packages/web/src/utils/electrical-ingestion-flow.ts` was extended
in two ways:

1. `DetectedInputKind` now includes `'pdf'`. `detectInputKind`
   recognises `.pdf` extensions, the `%PDF-` magic byte sequence
   on a `Uint8Array`, and the literal `%PDF-` prefix on text
   bodies.
2. `ElectricalInputDescriptor.bytes?: Uint8Array` is honoured by
   `ingestElectricalInput` for PDF inputs. The workspace's file
   picker reads `.pdf` files via `arrayBuffer()` (not `text()`)
   and forwards the bytes to the registry.

The workspace's empty-state copy and badge mention PDF; the
binary-PDF case shows an honest banner ("Sprint 79 v0 has no
binary text-layer parser…") so operators are never surprised.

## Privacy invariants

- **No raw bytes in localStorage / exports.** The Sprint 78B
  snapshot persists only the extracted *evidence* (candidate +
  diagnostics + reviewState). When the input was a binary PDF, the
  candidate may be empty — that is the correct result, not a bug.
- **Text-mode pre-extracted text is also not persisted by
  default.** Operators who pasted a PDF text dump should treat the
  exported review session as potentially sensitive (the snippets
  inside `SourceRef.snippet` carry verbatim source text).
- **`contentHash`** is FNV-1a 32-bit hex. For binary inputs the
  workspace hashes a projection of the byte length + the first/
  last 64 bytes — non-cryptographic, used for local identity only.

## Future roadmap

Each step is an independent sprint; nothing is required to land
together with Sprint 82.

1. **Sprint 83 — PDF source-evidence UX.** Optional page
   preview with bbox overlays, click-through from a candidate
   to its source region on the rendered PDF page, better
   operator trust during review. Pick this if Sprint 82's
   strictness gate behaves correctly on real-world PDFs.

2. **Sprint 83A (alt) — PDF layout hardening.** Multi-column
   ordering, rotated pages, coordinate normalisation, region
   clustering, better column-position detection from real
   geometry. Pick this if real-world PDFs surface more layout
   shape problems than evidence-UX problems.

3. **Older planned items kept for reference (will be sequenced
   into the schedule once the PDF UX direction is set):**

   **PDF extraction hardening (folded into 83A above).** Multi-column
   ordering, rotated pages, coordinate normalisation, better
   column-position detection from real geometry, row/column
   confidence scoring, richer UI for the source-ref drilldown
   (bbox overlays).
2. **Sprint 82A (alt) — PDF layout architecture.** Explicit
   `PdfLayoutRegion` model, region clustering, optional
   page-preview component with bbox overlays. Pick this if
   Sprint 81's manual-acceptance reveals more layout-shape
   problems than column-detection problems.
3. **OCR fallback (opt-in).** Only when `allowOcr: true` AND a
   sandboxed OCR service is configured. The output still flows
   through the same review gate; OCR-derived blocks must be
   labelled (`SourceRef.snippet` + a dedicated diagnostic).
4. **Symbol / connection-graph recognition.** Beyond text — actual
   geometry of schematic symbols. Will need a deterministic
   pattern library and a lower default confidence than text-row
   extraction.
5. **Cross-page references.** Tag-level deduplication when the
   same device appears on multiple sheets. Likely shared with the
   EPLAN XML side.

Each step must keep the architectural invariant intact: every
extracted fact carries a `SourceRef`, never auto-promotes to PIR,
and is reviewable by a human before any downstream consumer.

## Test coverage (Sprint 79 + 80 + 81 + 82 + 83A + 83B)

Sprint 83B — new:
- `packages/electrical-ingest/tests/pdf-table-family-throttling.spec.ts` —
  36 tests: `isFooterOrTitleBlockLine` (7) covering each
  title-block/footer pattern + non-matches + defensiveness;
  `passesNonIoFamilyHeaderShapeGate` (9) covering canonical
  titles + multi-strong-token + weak-token suppression +
  defensiveness; `nonIoFamilyDiagnosticSignature` (4)
  covering normalisation + cap + dedup-friendliness;
  `detectIoTables` integration (12) covering footer
  suppression (3), weak single-token suppression (3), BOM
  canonical header (1), per-page-per-signature dedup (2),
  body-row suppression (2), IO-list regression (1);
  `ingestPdf` integration with realistic TcECAD-style fixture
  (4) — compact diagnostic stream, Sprint 82 channel-marker
  regression, strict-address regression, mixed BOM page +
  real IO page.
- `packages/electrical-ingest/tests/pdf-table-family.spec.ts` —
  Sprint 83A test 3 updated: bare `Kabel Ader Quelle Ziel` is
  now suppressed by the hygiene gate (only 2 strong cable
  tokens); the canonical `Kabelübersicht …` title still
  passes.

Sprint 83A — new:
- `packages/electrical-ingest/tests/pdf-table-family.spec.ts` —
  35 tests: `classifyPdfTableHeader` table-driven family
  resolution (16) covering IO-list / BOM / terminal / cable /
  contents / legend / mixed / role-dedup / empty-input;
  `detectIoTableHeader` family gate (6) verifying non-IO
  families return null and IO still passes; `detectIoTables`
  non-IO family diagnostics (9) including the deduplication
  rule (one diagnostic per `(family, page, blockId)`);
  `ingestPdf` end-to-end (4) with BOM-only / mixed BOM-IO /
  Sprint 82 channel-marker regression / strict-address
  regression.

Sprint 82 — new:
- `packages/electrical-ingest/tests/pdf-address-strictness.spec.ts`
  — 42 tests: classifier table over strict / channel-marker /
  ambiguous / invalid tokens (33), strictness gate inside
  `ingestPdf` (8), `PdfDraftCandidate` integration confirming
  channel-marker rows produce zero IO candidates (1).
- `packages/web/tests/review-source-refs.spec.ts` — 4 new
  tests pinning that PDF `snippet` + `bbox` are surfaced in
  the source-ref drilldown (with `(pt)` unit), and that
  malformed bbox shapes are dropped cleanly.



Sprint 81 — new:
- `packages/electrical-ingest/tests/pdf-table-detect.spec.ts` —
  32 tests: header-keyword classifier, `looksLikeIoRow` predicate,
  per-page table assembler (incl. multi-table on a page),
  `ingestPdf` IO-row variants (text-mode), `ingestPdf` end-to-end
  with a column-aligned tabular real-bytes PDF.
- `packages/electrical-ingest/tests/pdf-acceptance.spec.ts` —
  4 acceptance cases (tabular IO list, tag-first + direction
  column, narrative no-IO, malformed bytes) — see
  [`docs/pdf-manual-acceptance-sprint-81.md`](pdf-manual-acceptance-sprint-81.md).
- `packages/electrical-ingest/tests/fixtures/pdf/build-fixture.ts`
  gained `buildTabularPdfFixture` (places labelled cells at exact
  `(x, y)` PDF point positions so the line-grouper sees real
  geometry).



Sprint 79:
- `packages/electrical-ingest/tests/pdf.spec.ts` — 40 tests
  (Sprint 80 updated several assertions: bytes-path tests now
  expect `PDF_TEXT_LAYER_EXTRACTION_FAILED` instead of the
  removed Sprint 79 `PDF_UNSUPPORTED_BINARY_PARSER` /
  `PDF_TEXT_LAYER_UNAVAILABLE` codes; all `ingestPdf` calls are
  awaited).
- `packages/electrical-ingest/tests/sources.spec.ts` — registry
  count refreshed (4 → 5).
- `packages/electrical-ingest/tests/eplan-xml.spec.ts` — `.pdf`
  fall-through assertion replaced with the PDF-ingestor honest-
  empty-input assertion.
- `packages/web/tests/electrical-ingestion-flow.spec.ts` —
  detection + flow block (Sprint 80 flipped one assertion: the
  bytes-only-header test now expects `PDF_TEXT_LAYER_EXTRACTION_FAILED`
  + `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED`).
- `packages/web/tests/electrical-review-session.spec.ts` —
  `'pdf'` accepted as `inputKind`.
- `packages/web/tests/electrical-review-session-workflow.spec.ts`
  — end-to-end PDF text-mode round-trip + privacy assertion.

Sprint 80 — new:
- `packages/electrical-ingest/tests/pdf-text-layer.spec.ts` —
  22 tests: `extractPdfTextLayer` real-bytes path (8),
  `groupItemsIntoLines` + `combineBbox` line-grouping helpers (8),
  `ingestPdf` end-to-end with real bytes including PDF
  SourceRef + bbox preservation through `PirDraftCandidate` (6).
- `packages/electrical-ingest/tests/fixtures/pdf/build-fixture.ts`
  — minimal-PDF fixture builder (no committed binary blobs).
- `packages/web/tests/electrical-ingestion-flow.spec.ts` —
  Sprint 80 block (2 tests): real PDF bytes through
  `runElectricalIngestion` produce IO candidates with
  `SourceRef.bbox.unit === 'pt'`.
