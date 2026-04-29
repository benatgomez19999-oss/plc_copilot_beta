# PDF text-layer extraction — Sprint 80 → 81 v0

> **Status: real text-layer extraction + IO-list table detection
> live in `@plccopilot/electrical-ingest` (Sprint 81).** Sprint
> 80 added the `pdfjs-dist`-backed text-layer extractor behind an
> isolated adapter. **Sprint 81** adds `pdf-table-detect.ts` on
> top of the same line-grouped output: it recognises IO-list-
> shaped headers (English + German + abbreviations), assembles
> `PdfTableCandidate`s, and feeds the new multi-pattern IO-row
> extractor (address-first / tag-first / tag+direction+address /
> address+tag+direction). **No OCR, no symbol recognition, no
> rotated-page or multi-column hardening.**
>
> Sprint 81's first deterministic acceptance harness lives at
> [`packages/electrical-ingest/tests/pdf-acceptance.spec.ts`](../packages/electrical-ingest/tests/pdf-acceptance.spec.ts);
> the captured outcomes + operator-side web upload checklist
> live at
> [`docs/pdf-manual-acceptance-sprint-81.md`](pdf-manual-acceptance-sprint-81.md).

## Why an adapter?

The whole codebase imports `pdfjs-dist` from exactly one file:
[`packages/electrical-ingest/src/sources/pdf-text-layer.ts`](../packages/electrical-ingest/src/sources/pdf-text-layer.ts).

This isolation matters because:

- The pdfjs API churns between majors. Pinning the surface to one
  adapter file means a future swap (mupdf, hand-rolled subset,
  newer pdfjs) only needs to re-implement `extractPdfTextLayer`.
- pdfjs's default ESM build needs `DOMMatrix` (browser-only); we
  use `pdfjs-dist/legacy/build/pdf.mjs` instead, which is
  officially the supported entry under Node.
- The adapter passes `disableFontFace`, `useSystemFonts: false`,
  `useWorkerFetch: false`, and `isEvalSupported: false` so the
  parser stays fully Node-friendly. Workers themselves still
  exist — see the "Worker configuration" section below for the
  browser path.
- Vite-bundled web code never imports pdfjs directly — the
  adapter is dynamic-imported, so the cost is paid only when the
  ingestor is actually called.

## Worker configuration (Sprint 81 post-fix)

pdfjs-dist v5 always uses a worker — even from the legacy Node
build. Two configurations matter:

### Node (vitest, CLI, future codegen)

`typeof window === 'undefined'`, so pdfjs falls back to a
"fake worker" that runs in-process. The adapter does NOT set
`GlobalWorkerOptions.workerSrc` in this path — Sprint 80's tests
have always run this way, no setup required.

### Browser (Vite-bundled web app)

pdfjs throws synchronously on the first `getDocument` call when
`GlobalWorkerOptions.workerSrc` is unset:

```
Error: No "GlobalWorkerOptions.workerSrc" specified.
```

Sprint 81 post-fix configures the worker via a Vite `?url`
dynamic import inside the adapter:

```ts
const m = await import(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
);
mod.GlobalWorkerOptions.workerSrc = m.default;
```

- The `?url` suffix is a Vite static-asset directive — at build
  time Vite emits the worker file as a regular static asset and
  the import resolves to its URL string. In dev, Vite serves it
  directly.
- Wrapped in `typeof window !== 'undefined'` so the helper is a
  no-op in Node.
- Wrapped in `try/catch` so a failure to resolve the worker URL
  (custom bundlers, future packaging changes) surfaces as a
  structured `PDF_TEXT_LAYER_EXTRACTION_FAILED` diagnostic from
  the downstream `getDocument` try/catch — never as an Uncaught
  promise.
- Memoised. The configuration is attempted exactly once across
  the lifetime of the module; subsequent extractions hit the
  cached state.

The web bundle does NOT import pdfjs directly. The `?url` import
lives inside `electrical-ingest`, which is what Vite resolves
through the workspace alias.

### Defence in depth: synchronous getDocument failure

`getDocument()` returns a `PDFDocumentLoadingTask` synchronously,
but pdfjs may throw synchronously on worker-setup failure. Sprint
81 post-fix moved the `getDocument` call inside the same
try/catch that already wraps `await loadingTask.promise`, so
either failure mode produces a `PDF_TEXT_LAYER_EXTRACTION_FAILED`
diagnostic + `parseFailed: true` in the result.

The web workspace adds one more layer: `handleIngest` is wrapped
in a try/catch that surfaces any residual rejection as a session
notice. The expected runtime path NEVER triggers it (the adapter
is contracted to never reject); the catch exists so a future
pdfjs major or unforeseen browser-side bug can't crash the React
tree.

## Adapter API

```ts
interface PdfTextLayerExtractionInput {
  bytes: Uint8Array;
  maxPages?: number;
}

interface PdfTextLayerItem {
  text: string;
  x: number;          // PDF point — origin bottom-left
  y: number;          // baseline y, NOT the visual top
  width: number;
  height: number;
  fontSize?: number;  // |transform[3]|
}

interface PdfTextLayerPage {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextLayerItem[];
  diagnostics: ElectricalDiagnostic[];
}

interface PdfTextLayerExtractionResult {
  ok: boolean;
  pages: PdfTextLayerPage[];
  diagnostics: ElectricalDiagnostic[];
  dependencyFailed: boolean;
  parseFailed: boolean;
  encrypted: boolean;
  pageCount: number;
}

function extractPdfTextLayer(
  input: PdfTextLayerExtractionInput,
): Promise<PdfTextLayerExtractionResult>;
```

The adapter NEVER throws. Every failure mode lands as a
combination of `ok: false` + a structured diagnostic in
`diagnostics`, plus one of the boolean flags
(`dependencyFailed`, `parseFailed`, `encrypted`).

## Coordinate system

- Origin is the bottom-left of the page. Y increases upward.
- Unit is the PDF point (1/72 inch).
- `(x, y)` is the lower-left of the text item's glyph box; `width`
  and `height` are pdfjs's reported metrics for the same item.
- `fontSize` is `|transform[3]|` (the vertical scale of the text
  matrix), useful for line-grouping tolerance.
- `viewport.scale = 1` is requested in `getViewport`, so page
  width/height come back in points.

If a future producer can only give us approximate geometry, the
diagnostic `PDF_TEXT_LAYER_BBOX_APPROXIMATED` (info) is reserved.
Sprint 80 always emits exact bboxes from the pdfjs `transform` so
the code does not yet raise it.

## Line grouping

[`pdf-text-normalize.ts`](../packages/electrical-ingest/src/sources/pdf-text-normalize.ts)
takes the raw item stream and produces deterministic lines:

- Sort items by `y` desc (PDF coords have origin at bottom-left),
  then `x` asc.
- Open a new line whenever the next item's y differs from the
  current line's anchor by more than `yTolerance` (default `2`
  PDF points).
- Within a line, sort items left-to-right by `x` and join them
  with the glue rule:
  - Insert a single space when the gap between two adjacent items
    is `>= 0.5 * fontSize`.
  - Otherwise concatenate without a space (kerning fallout —
    pdfjs sometimes splits the same printed word across multiple
    text items).
- The line's bbox is the union of its items' bboxes.

The algorithm is total + side-effect-free; the same input always
yields the same lines in the same order.

### Sprint 83A — header family classifier

After line-grouping, `detectIoTableHeader` runs the line text
through `classifyPdfTableHeader` (in
[`pdf-table-detect.ts`](../packages/electrical-ingest/src/sources/pdf-table-detect.ts)):

- Headers that look like BOM / terminal / cable / contents /
  legend lists are filtered OUT of IO-list detection — even
  when the role floor (`address` or `tag` column present) is
  satisfied. Those families now emit precise per-family info
  diagnostics (`PDF_BOM_TABLE_DETECTED` etc.) instead of the
  Sprint 81 over-broad `PDF_TABLE_HEADER_DETECTED`.
- Strong-token sets per family are listed in
  [`docs/pdf-manual-acceptance-sprint-83A.md`](pdf-manual-acceptance-sprint-83A.md).
- BOM beats IO unless IO has strictly more hits AND owns the
  `address` role; cable beats terminal on tie because `kabel`
  / `ader` are unambiguous.
- Non-IO family diagnostics dedupe by `(family, page, blockId)`
  — repeated BOM headers across pages still surface, but
  intra-page duplicates collapse.

### Sprint 82 — address strictness gate

After line-grouping + IO-row regex match, `extractIoRow` runs
the verbatim address token through `classifyPdfAddress` (in
[`pdf-address-strictness.ts`](../packages/electrical-ingest/src/sources/pdf-address-strictness.ts)):

- **Strict** byte-bit forms (`I0.0`, `Q0.1`, `%IX0.0`, Rockwell
  tag form) → row passes through, `plc_channel:<addr>` node and
  edge are created.
- **Channel markers** (`I1`, `O2`, `%I1`, `I3+`) → row preserved
  as device evidence with `attributes.channel_marker` set, but
  NO `plc_channel:` node and NO edge. The PIR builder cannot
  see the row as IO.
- **Ambiguous** addresses → same evidence-only treatment;
  diagnostic instead of channel-marker label.

Tag-column channel markers (`I1 I2` page-24 noise) reject the
whole row.

This gate is **PDF-only**. CSV / EPLAN / TcECAD continue using
`detectPlcAddress` directly.

### Limitations (Sprint 80 → 81 → 82)

- **Single-column / non-rotated only.** Multi-column reading order
  and rotated pages are deferred.
- **Vertical text** is not handled specially.
- **Hyphenation continuation** across lines is not joined.
- **Font kerning heuristic** is conservative — extreme kerning
  may insert extra spaces.
- **Table detection (Sprint 81)** is single-band only. A header
  line followed by ≥ 1 IO-row-shaped data lines forms a table.
  Borderless multi-row headers, repeated headers across page
  breaks, and merged cells are deferred.
- **Header keyword classifier (Sprint 81)** covers English +
  German + the most common abbreviated forms. New keyword
  variants land as a constant addition to `HEADER_KEYWORDS` in
  `pdf-table-detect.ts` — no schema or regex change.

## Failure paths

| Scenario | Flag | Diagnostic |
| --- | --- | --- |
| pdfjs-dist dynamic import threw | `dependencyFailed: true` | `PDF_DEPENDENCY_LOAD_FAILED` (error) |
| `getDocument().promise` rejected (parse error) | `parseFailed: true` | `PDF_TEXT_LAYER_EXTRACTION_FAILED` (error) |
| `getDocument().promise` raised `PasswordException` | `encrypted: true` | `PDF_ENCRYPTED_NOT_SUPPORTED` (error) |
| Per-page `getPage` / `getTextContent` threw | partial — that page is skipped | `PDF_TEXT_LAYER_EXTRACTION_FAILED` (error) on the page |
| Page has no extractable items | `ok: true`, page returned with `items: []` | `PDF_TEXT_LAYER_EMPTY_PAGE` (warning) on the page |
| `maxPages` reached | `ok: true`, only the first N pages returned | `PDF_PAGE_LIMIT_EXCEEDED` (warning) |

When the adapter fails AND the caller also supplied a test-mode
`text` body, `ingestPdf` falls back to the Sprint 79 text-mode
parser. Both diagnostic sets are preserved so operators see what
happened.

## Fixture strategy

Sprint 80 commits **no binary PDFs**. Fixtures are generated at
runtime by `buildMinimalPdfFixture(input: BuildPdfFixtureInput):
Uint8Array` — a hand-rolled, deterministic minimal-PDF builder
that emits valid bytes pdfjs can parse:

- Standard PDF 1.4 header + binary-comment marker.
- One catalog, one pages tree, one page object per input string,
  one content stream per page, one Helvetica font.
- Cross-reference table with byte-accurate offsets computed from
  the actual encoded objects (not the source strings).
- Each input string's lines become individual `Tj` operations
  with deterministic Y stepping (default `firstLineY = 720`,
  `lineSpacing = 18`).

The builder is committed at
[`packages/electrical-ingest/tests/fixtures/pdf/build-fixture.ts`](../packages/electrical-ingest/tests/fixtures/pdf/build-fixture.ts).

### Adding real-world test fixtures (Sprint 81+)

When Sprint 81 starts using real PDFs:

1. **Anonymise first.** Strip customer / project / site /
   personal identifiers from the PDF metadata, page text, and
   annotations.
2. Place the sanitised binary under
   `packages/electrical-ingest/tests/fixtures/pdf/`.
3. Keep fixtures small (≤ 100 KB each, ideally < 10 KB).
4. Add a focused test asserting whatever shape the fixture
   exposes.

## When this adapter is the wrong tool

- **Scanned image PDFs** with no embedded text layer — extraction
  returns `ok: true` but every page has zero items
  (`PDF_TEXT_LAYER_EMPTY_PAGE`). OCR is a separate sprint.
- **Highly stylised drawings** where text labels are individual
  glyph paths rather than a text layer — same as scanned PDFs.
- **Encrypted PDFs** — refused via `PDF_ENCRYPTED_NOT_SUPPORTED`.
  Operators must decrypt out-of-band first.
- **Forms / interactive features** — Sprint 80 only walks the
  static text layer. AcroForm field text is not collected.

## Future swap notes

If we ever need to replace `pdfjs-dist`:

1. Build the same `extractPdfTextLayer` function backed by the
   new producer.
2. Keep the `PdfTextLayerItem` shape (`text`, `x`, `y`, `width`,
   `height`, `fontSize?`) intact — it's the contract everything
   downstream depends on.
3. Preserve coordinate semantics (PDF-point space, origin
   bottom-left, baseline-y).
4. Preserve diagnostic codes — they are part of the public
   contract through the snapshot/export schemas.
