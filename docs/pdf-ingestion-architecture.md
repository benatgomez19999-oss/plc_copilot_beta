# PDF ingestion architecture — Sprint 79 → 80

> **Status: text-layer extraction v0 (Sprint 80).** Sprint 79
> landed the foundation: source kind, document/page/block model,
> page/bbox-capable `SourceRef`s, structured diagnostics, an
> honest binary stub, and a deterministic test-mode text path.
> **Sprint 80** replaces the binary stub with a real text-layer
> extractor backed by `pdfjs-dist` (legacy Node build), behind an
> isolated adapter that the rest of the codebase never imports
> directly. Confidence stays conservative; review-first stays
> load-bearing; OCR / symbol recognition / wire tracing remain
> deferred.
>
> **Manual product validation with real PDFs is explicitly
> deferred until Sprint 81 finishes.** Sprint 80's tests use
> hand-crafted minimal PDFs generated at runtime; the suite is
> deterministic and DOM-free.

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
| `PDF_AMBIGUOUS_IO_ROW` | warning | Reserved for future use (not raised in Sprint 80) |

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
together with Sprint 80.

1. **Sprint 81 — IO/table extraction + manual PDF acceptance pass.**
   Improve line/table grouping; detect simple IO-list tables; better
   column heuristics; validate against real public/sample PDFs;
   first explicit manual product validation pass for PDF — Sprint
   80's tests use hand-crafted minimal PDFs only.
2. **OCR fallback (opt-in).** Only when `allowOcr: true` AND a
   sandboxed OCR service is configured. The output still flows
   through the same review gate; OCR-derived blocks must be
   labelled (`SourceRef.snippet` + a dedicated diagnostic).
3. **Symbol / connection-graph recognition.** Beyond text — actual
   geometry of schematic symbols. Will need a deterministic
   pattern library and a lower default confidence than text-row
   extraction.
4. **Cross-page references.** Tag-level deduplication when the
   same device appears on multiple sheets. Likely shared with the
   EPLAN XML side.
5. **Rotated / multi-column hardening.** Vertical text, rotated
   pages, multi-column reading order — Sprint 80's grouping is
   single-column / non-rotated only.

Each step must keep the architectural invariant intact: every
extracted fact carries a `SourceRef`, never auto-promotes to PIR,
and is reviewable by a human before any downstream consumer.

## Test coverage (Sprint 79 + 80)

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
