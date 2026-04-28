# PDF text-layer extraction — Sprint 80 v0

> **Status: real text-layer extraction live in
> `@plccopilot/electrical-ingest` (Sprint 80).** Backed by
> `pdfjs-dist` (legacy Node build) behind an isolated adapter.
> Produces deterministic, line-grouped `PdfTextBlock`s with
> PDF-point bboxes and verbatim snippets. **No OCR, no symbol
> recognition, no rotated-page or multi-column hardening.**
>
> **Manual product validation with real-world PDFs is deferred
> until Sprint 81 finishes** — Sprint 80's tests use hand-crafted
> minimal PDFs generated at runtime by
> [`packages/electrical-ingest/tests/fixtures/pdf/build-fixture.ts`](../packages/electrical-ingest/tests/fixtures/pdf/build-fixture.ts).

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
- Workers require browser-context APIs we don't want to ship.
  The adapter passes `disableFontFace`, `useSystemFonts: false`,
  `useWorkerFetch: false`, and `isEvalSupported: false` so the
  parser stays fully Node-friendly.
- Vite-bundled web code never imports pdfjs directly — the
  adapter is dynamic-imported, so the cost is paid only when the
  ingestor is actually called.

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

### Limitations (Sprint 80)

- **Single-column / non-rotated only.** Multi-column reading order
  and rotated pages are deferred.
- **Vertical text** is not handled specially.
- **Hyphenation continuation** across lines is not joined.
- **Font kerning heuristic** is conservative — extreme kerning
  may insert extra spaces. Sprint 81 will tune.

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
