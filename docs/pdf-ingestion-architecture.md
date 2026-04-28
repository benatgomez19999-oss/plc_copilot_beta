# PDF ingestion architecture — Sprint 79 v0

> **Status: architecture v0.** Sprint 79 lays the *foundation* for
> ingesting electrical PDF documents into PLC Copilot's evidence
> pipeline. It does NOT ship a production binary parser, OCR,
> table-detection, or symbol recognition. It DOES ship: a source
> kind, a document/page/block model, page/bbox-capable
> `SourceRef`s, a structured diagnostic catalogue, an honest binary
> stub, and a deterministic test-mode text-extraction path.

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

## Non-goals (load-bearing for v0)

- **No OCR.** Sprint 79 v0 NEVER runs OCR — not even silently when
  `allowOcr: true` is passed; that flag is reserved for a future
  opt-in and currently raises `PDF_OCR_NOT_ENABLED` info.
- **No production binary parser.** Bytes-only inputs are validated
  for the `%PDF-` magic header and sniffed for `/Encrypt`, but the
  document body is not decoded. Honest diagnostics surface this
  (`PDF_UNSUPPORTED_BINARY_PARSER`, `PDF_TEXT_LAYER_UNAVAILABLE`).
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

## v0 supported behaviour

Two paths through `ingestPdf` / `parsePdfDocument` /
`createPdfElectricalIngestor`:

### 1. Test-mode text path

When the caller supplies `PdfIngestionInput.text`, the ingestor
treats the input as **already-extracted plain text** (the format a
real binary parser would produce) and runs the v0 pipeline:

- **Page splitting.** Lines matching `--- page N ---`
  (case-insensitive, leading/trailing whitespace tolerated)
  introduce a new page. Everything before the first delimiter is
  page 1.
- **Block extraction.** Each non-blank source line becomes a
  `PdfTextBlock` with a deterministic id
  (`pdf:<sourceId>:p<page>:b<index>`), its verbatim text, and a
  `SourceRef` carrying `kind: 'pdf'`, `path`, `page`, `line`,
  `snippet`, and a `symbol` of the form `pdf:page:N/line:M`.
- **Confidence ladder.** Lines that match the IO-row pattern read
  at `0.6`; other text reads at `0.5`. PDF-derived rows never
  exceed `0.65` — strictly below CSV/EPLAN structured rows.
- **Conservative IO extraction.** Lines matching
  `<address> <tag> [<label>]` (Siemens-style addresses: `I0.0`,
  `Q0.1`, `%I0.0`, `%Q0.0`, plus byte/word variants) produce a
  `pdf_device:<tag>` node and a `plc_channel:<address>` node, with
  a `signals` (input) or `drives` (output) edge between them. The
  device kind is inferred from label hints (`sensor`, `valve`,
  `motor`, etc.) using the shared `KIND_ALIASES` table.

### 2. Bytes path (honest binary stub)

When the caller supplies `PdfIngestionInput.bytes`:

- The first 5 bytes are checked against `%PDF-`. Mismatch →
  `PDF_MALFORMED` error.
- The body is scanned for `/Encrypt` (a brittle but documented
  sniff for the trailer dictionary). Match →
  `PDF_ENCRYPTED_NOT_SUPPORTED` error +
  `metadata.encrypted = true`.
- The ingestor emits the honest set:
  - `PDF_UNSUPPORTED_BINARY_PARSER` (warning)
  - `PDF_TEXT_LAYER_UNAVAILABLE` (warning)
  - `PDF_OCR_NOT_ENABLED` (info, only if `allowOcr` was set)
  - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` (info)
- Returns an empty `ElectricalGraph` with `sourceKind: 'pdf'`.

This stub exists so the architecture, the registry routing, and
the review/persist/export flow can be exercised end-to-end without
binding to a binary-PDF dependency. Operators see structured
diagnostics rather than a fake extraction.

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
| `PDF_ENCRYPTED_NOT_SUPPORTED` | error | `/Encrypt` detected in trailer |
| `PDF_PAGE_LIMIT_EXCEEDED` | warning | More than `maxPages` (default 200) |
| `PDF_UNSUPPORTED_BINARY_PARSER` | warning | Bytes path — no binary decoder ships in v0 |
| `PDF_TEXT_LAYER_UNAVAILABLE` | warning | Bytes path — no text was extracted |
| `PDF_OCR_NOT_ENABLED` | info | `allowOcr=true` was set; OCR is not implemented |
| `PDF_TABLE_DETECTION_NOT_IMPLEMENTED` | info | Always raised once per parse |
| `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` | info | Bytes-only input or no IO-row matched |
| `PDF_NO_TEXT_BLOCKS` | warning | Text input contained only whitespace |
| `PDF_TEXT_BLOCK_EXTRACTED` | info | Per-parse summary count |
| `PDF_AMBIGUOUS_IO_ROW` | warning | Reserved for future use (not raised in v0) |

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
together with v0.

1. **Production text-layer extraction.** Add a vetted, deterministic
   PDF text-layer parser (likely `pdfjs-dist` or a hand-rolled
   parser for a constrained subset). Replace the bytes-only stub
   with a real producer of `PdfTextBlock`s including geometry.
2. **Table extraction.** Use line-clustering / column-detection
   heuristics to populate `PdfTableCandidate.rows`. High-confidence
   IO-list tables become a strong source of `ElectricalGraph`
   candidates (similar to the CSV ingestor).
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

## Test coverage (Sprint 79)

- `packages/electrical-ingest/tests/pdf.spec.ts` — 40 tests:
  detection (6), parser (12), bytes path (6), text-mode IO-row
  extraction (8), `PirDraftCandidate` integration (2), registry
  routing (5).
- `packages/electrical-ingest/tests/sources.spec.ts` — registry
  count refreshed (4 → 5).
- `packages/electrical-ingest/tests/eplan-xml.spec.ts` — `.pdf`
  fall-through assertion replaced with the Sprint 79 PDF-ingestor
  honest-empty-input assertion.
- `packages/web/tests/electrical-ingestion-flow.spec.ts` — Sprint
  79 detection + flow block (10 tests).
- `packages/web/tests/electrical-review-session.spec.ts` — adds
  `'pdf'` as a valid `inputKind`; flips the "unknown" sentinel to
  `'edz'`.
- `packages/web/tests/electrical-review-session-workflow.spec.ts` —
  end-to-end PDF text-mode round-trip + privacy assertion (2 tests).
