// Sprint 79 — PDF ingestion architecture v0. Two paths:
//
//   1. **Bytes path (binary stub).** Validates the `%PDF-` header,
//      sniffs for `/Encrypt`, and returns an empty document plus the
//      honest diagnostic set (`PDF_UNSUPPORTED_BINARY_PARSER`,
//      `PDF_TEXT_LAYER_UNAVAILABLE`, `PDF_OCR_NOT_ENABLED`,
//      `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED`). NEVER fakes
//      binary parsing.
//
//   2. **Text path (test mode).** Treats the input as already-
//      extracted plain text — the format real-world PDF parsers
//      produce after the binary decoder runs. Recognises the
//      `--- page N ---` page-delimiter convention so fixtures and
//      tests can exercise downstream architecture without binding
//      to a binary parser dependency.
//
// What the text path does deterministically:
//   - Builds `PdfDocument` / `PdfPage` / `PdfTextBlock` records with
//     `SourceRef.kind === 'pdf'`, page numbers, and verbatim
//     snippets.
//   - Tries a single conservative IO-row pattern
//     (`<address> <tag> [<label>]`) to surface graph candidates.
//     Confidence is intentionally low; downstream review is required
//     before any of this can promote to PIR.
//
// What the text path explicitly does NOT do:
//   - Layout-aware table detection (emits
//     `PDF_TABLE_DETECTION_NOT_IMPLEMENTED`).
//   - OCR (emits `PDF_OCR_NOT_ENABLED` if `allowOcr` is set).
//   - Symbol/connection-graph recognition.
//   - Any kind of free-form-prompt-driven inference.
//
// Trademark / scope: this ingestor handles arbitrary PDF files by
// shape only — it makes no claim about supporting any particular
// vendor's PDF export format.

import { createElectricalDiagnostic } from '../diagnostics.js';
import { confidenceFromEvidence } from '../confidence.js';
import { detectPlcAddress } from '../normalize.js';
import { KIND_ALIASES } from '../mapping/kind-aliases.js';
import type {
  ElectricalDiagnostic,
  ElectricalEdge,
  ElectricalGraph,
  ElectricalIngestionInput,
  ElectricalIngestionResult,
  ElectricalNode,
  ElectricalNodeKind,
  ElectricalSourceFile,
  ElectricalSourceIngestor,
  SourceRef,
} from '../types.js';
import type {
  PdfBoundingBox,
  PdfDocument,
  PdfDocumentMetadata,
  PdfIngestionInput,
  PdfIngestionOptions,
  PdfPage,
  PdfParseResult,
  PdfTextBlock,
} from './pdf-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PDF_HEADER = '%PDF-';
const PDF_HEADER_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MIN_TEXT_CONFIDENCE = 0;

// Test-mode page delimiter:  ---  page  N  ---
//   - leading/trailing whitespace tolerated
//   - any number of `-` >= 3
//   - case-insensitive on the word "page"
const PAGE_DELIMITER_RE = /^[\s​]*-{3,}\s*page\s+(\d+)\s*-{3,}[\s​]*$/i;

// Conservative IO-row pattern:  address  tag  [label]
//   - address: matched by `detectPlcAddress` (Siemens %I/%Q forms)
//   - tag: short alphanumeric token (B1, Y2, M3, …) capped at 16
//   - label: rest of the line, optional, kept verbatim
const IO_ROW_RE =
  /^\s*(?<addr>%?[IQM][WDB]?\d+(?:[.\/]\d+)?)\s+(?<tag>[A-Za-z][A-Za-z0-9_.+\-]{0,15})(?:\s+(?<label>.+?))?\s*$/;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the input file looks like a PDF — by extension,
 * declared kind, or `%PDF-` magic header on its bytes / text content.
 *
 * This is intentionally permissive on the text side (a string body
 * starting with `%PDF-` may or may not be a real PDF; the ingestor
 * still validates downstream and emits `PDF_MALFORMED` if needed).
 */
export function detectPdf(file: ElectricalSourceFile | null | undefined): boolean {
  if (!file || typeof file !== 'object') return false;
  if (file.kind === 'pdf') return true;
  if (typeof file.path === 'string' && file.path.toLowerCase().endsWith('.pdf')) {
    return true;
  }
  const c = file.content;
  if (typeof c === 'string') return c.startsWith(PDF_HEADER);
  if (c instanceof Uint8Array) return startsWithPdfHeader(c);
  return false;
}

function startsWithPdfHeader(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_HEADER_BYTES.length) return false;
  for (let i = 0; i < PDF_HEADER_BYTES.length; i++) {
    if (bytes[i] !== PDF_HEADER_BYTES[i]) return false;
  }
  return true;
}

function bytesContain(bytes: Uint8Array, needle: string): boolean {
  // Cheap forward scan — Sprint 79 only needs to spot one short ASCII
  // marker (`/Encrypt`) inside the trailer dictionary; we don't
  // bother with a streaming Boyer-Moore.
  if (needle.length === 0) return true;
  if (bytes.length < needle.length) return false;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Text-mode parser
// ---------------------------------------------------------------------------

interface ParsedTextLine {
  text: string;
  /** 1-based line index inside its page (after stripping the delimiter row). */
  lineInPage: number;
}

interface ParsedTextPage {
  pageNumber: number;
  lines: ParsedTextLine[];
}

/**
 * Split the test-mode text body into pages. Lines matching
 * `PAGE_DELIMITER_RE` introduce a new page; everything before any
 * delimiter belongs to page 1 by default.
 */
function splitTextIntoPages(text: string): ParsedTextPage[] {
  const pages: ParsedTextPage[] = [];
  let current: ParsedTextPage = { pageNumber: 1, lines: [] };
  pages.push(current);
  let nextLineIndex = 1;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = PAGE_DELIMITER_RE.exec(rawLine);
    if (m) {
      const declared = Number.parseInt(m[1], 10);
      // If the very first content of the body is a delimiter, the
      // empty initial page is replaced by the declared one.
      if (current.lines.length === 0 && pages.length === 1) {
        current.pageNumber = declared;
      } else {
        current = { pageNumber: declared, lines: [] };
        pages.push(current);
      }
      nextLineIndex = 1;
      continue;
    }
    if (rawLine.trim().length === 0) {
      // Skip blank lines but advance the line counter so the user-
      // facing line numbers match the source file.
      nextLineIndex++;
      continue;
    }
    current.lines.push({ text: rawLine, lineInPage: nextLineIndex });
    nextLineIndex++;
  }
  // If the last page has no lines AND it's not the only page, drop it.
  if (pages.length > 1 && pages[pages.length - 1].lines.length === 0) {
    pages.pop();
  }
  return pages;
}

function blockId(sourceId: string, page: number, blockIndex: number): string {
  return `pdf:${sourceId}:p${page}:b${blockIndex}`;
}

function buildPdfSourceRef(args: {
  sourceId: string;
  fileName?: string;
  page: number;
  line: number;
  snippet?: string;
  rawId?: string;
  bbox?: PdfBoundingBox;
}): SourceRef {
  const ref: SourceRef = {
    sourceId: args.sourceId,
    kind: 'pdf',
    page: String(args.page),
  };
  if (args.fileName) ref.path = args.fileName;
  if (args.line) ref.line = args.line;
  if (args.rawId) ref.rawId = args.rawId;
  if (args.snippet) ref.snippet = args.snippet;
  if (args.bbox) {
    ref.bbox = {
      x: args.bbox.x,
      y: args.bbox.y,
      width: args.bbox.width,
      height: args.bbox.height,
      unit: args.bbox.unit,
    };
  }
  ref.symbol = `pdf:page:${args.page}/line:${args.line}`;
  return ref;
}

/**
 * Build text blocks from the parsed pages. Confidence ladder:
 *   - 0.6 if the line matches the IO-row pattern (we *think* we
 *     found something machine-relevant).
 *   - 0.5 otherwise (it's text, but we make no claim about its
 *     meaning).
 *
 * Producers are encouraged to attach `bbox` when geometry is known
 * (real binary parsers in future sprints will). The test-mode path
 * leaves `bbox` undefined.
 */
function buildTextBlocksForPage(
  page: ParsedTextPage,
  sourceId: string,
  fileName: string | undefined,
): PdfTextBlock[] {
  const blocks: PdfTextBlock[] = [];
  let blockIndex = 1;
  for (const line of page.lines) {
    const matchesIoRow = IO_ROW_RE.test(line.text);
    const confidence = matchesIoRow ? 0.6 : 0.5;
    const block: PdfTextBlock = {
      id: blockId(sourceId, page.pageNumber, blockIndex),
      text: line.text,
      confidence,
      sourceRef: buildPdfSourceRef({
        sourceId,
        fileName,
        page: page.pageNumber,
        line: line.lineInPage,
        snippet: line.text.length > 160 ? line.text.slice(0, 160) + '…' : line.text,
      }),
    };
    blocks.push(block);
    blockIndex++;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Public: parsePdfDocument (text-mode)
// ---------------------------------------------------------------------------

/**
 * Parse already-extracted PDF text into a structured `PdfDocument`.
 * Pure / deterministic. NEVER throws on malformed input — surfaces
 * issues via `diagnostics`.
 *
 * Honest about its scope:
 *   - No binary decoding. `bytes` are NOT consumed by this function.
 *   - No table detection. `tableCandidates` is always `[]`.
 *   - No symbol recognition.
 */
export function parsePdfDocument(input: PdfIngestionInput): PdfParseResult {
  const diagnostics: ElectricalDiagnostic[] = [];
  const sourceId = input.sourceId;
  const fileName = input.fileName;

  if (typeof input.text !== 'string' || input.text.length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_EMPTY_INPUT',
        message: 'PDF text input is empty.',
      }),
    );
    return {
      document: emptyDocument(input),
      diagnostics,
    };
  }

  const opts = withDefaultOptions(input.options);
  const pages = splitTextIntoPages(input.text);
  const limitedPages = pages.slice(0, opts.maxPages);
  if (pages.length > opts.maxPages) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_PAGE_LIMIT_EXCEEDED',
        message: `Page limit of ${opts.maxPages} reached; ${pages.length - opts.maxPages} page(s) ignored.`,
      }),
    );
  }

  const docPages: PdfPage[] = [];
  let totalBlocks = 0;
  for (const p of limitedPages) {
    const blocks = buildTextBlocksForPage(p, sourceId, fileName).filter(
      (b) => b.confidence >= opts.minTextConfidence,
    );
    totalBlocks += blocks.length;
    docPages.push({
      pageNumber: p.pageNumber,
      textBlocks: blocks,
      tableCandidates: [],
      diagnostics: [],
    });
  }

  if (totalBlocks === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_NO_TEXT_BLOCKS',
        message: 'No text blocks extracted from PDF input.',
      }),
    );
  } else {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_TEXT_BLOCK_EXTRACTED',
        severity: 'info',
        message: `${totalBlocks} text block(s) extracted from ${docPages.length} page(s).`,
      }),
    );
  }

  // Roadmap reminder — Sprint 79 v0 deliberately stops short of
  // table detection. Surface it once per parse, not once per page,
  // so the diagnostics list stays readable.
  diagnostics.push(
    createElectricalDiagnostic({
      code: 'PDF_TABLE_DETECTION_NOT_IMPLEMENTED',
      severity: 'info',
      message:
        'Layout-aware table detection is not implemented in Sprint 79 v0. See docs/pdf-ingestion-architecture.md.',
    }),
  );

  if (input.options?.allowOcr) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_OCR_NOT_ENABLED',
        severity: 'info',
        message:
          'allowOcr=true was passed, but Sprint 79 v0 does not run OCR. The flag is reserved for a future opt-in.',
      }),
    );
  }

  const document: PdfDocument = {
    sourceId,
    fileName,
    pageCount: docPages.length,
    pages: docPages,
    diagnostics: [],
  };
  return { document, diagnostics };
}

function emptyDocument(input: PdfIngestionInput): PdfDocument {
  return {
    sourceId: input.sourceId,
    fileName: input.fileName,
    pageCount: 0,
    pages: [],
    diagnostics: [],
  };
}

function withDefaultOptions(
  options: PdfIngestionOptions | undefined,
): Required<Pick<PdfIngestionOptions, 'maxPages' | 'minTextConfidence'>> &
  PdfIngestionOptions {
  return {
    extractTextLayer: options?.extractTextLayer ?? true,
    allowOcr: options?.allowOcr ?? false,
    maxPages:
      typeof options?.maxPages === 'number' && options.maxPages > 0
        ? options.maxPages
        : DEFAULT_MAX_PAGES,
    minTextConfidence:
      typeof options?.minTextConfidence === 'number'
        ? options.minTextConfidence
        : DEFAULT_MIN_TEXT_CONFIDENCE,
  };
}

// ---------------------------------------------------------------------------
// Bytes-mode (honest binary stub)
// ---------------------------------------------------------------------------

interface BytesValidationResult {
  ok: boolean;
  encrypted: boolean;
  diagnostics: ElectricalDiagnostic[];
}

function validateBytes(
  bytes: Uint8Array,
  options: PdfIngestionOptions | undefined,
): BytesValidationResult {
  const diagnostics: ElectricalDiagnostic[] = [];
  if (bytes.length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_EMPTY_INPUT',
        message: 'PDF byte input is empty.',
      }),
    );
    return { ok: false, encrypted: false, diagnostics };
  }
  if (!startsWithPdfHeader(bytes)) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_MALFORMED',
        message: 'Input does not start with the PDF "%PDF-" magic header.',
      }),
    );
    return { ok: false, encrypted: false, diagnostics };
  }
  const encrypted = bytesContain(bytes, '/Encrypt');
  if (encrypted) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_ENCRYPTED_NOT_SUPPORTED',
        message: 'PDF appears to be encrypted (/Encrypt detected); Sprint 79 v0 cannot ingest it.',
      }),
    );
  }
  diagnostics.push(
    createElectricalDiagnostic({
      code: 'PDF_UNSUPPORTED_BINARY_PARSER',
      message:
        'Sprint 79 v0 has no binary PDF text-layer parser. The %PDF- header was recognised but the document body was not decoded.',
      hint:
        'Pass already-extracted text via PdfIngestionInput.text for the test-mode path, or wait for the production parser scheduled in a later sprint.',
    }),
  );
  diagnostics.push(
    createElectricalDiagnostic({
      code: 'PDF_TEXT_LAYER_UNAVAILABLE',
      message:
        'No text layer was extracted because the binary parser is not implemented.',
    }),
  );
  if (options?.allowOcr) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_OCR_NOT_ENABLED',
        severity: 'info',
        message:
          'allowOcr=true was passed, but Sprint 79 v0 does not run OCR. The flag is reserved for a future opt-in.',
      }),
    );
  }
  return { ok: !encrypted, encrypted, diagnostics };
}

// ---------------------------------------------------------------------------
// IO-row extraction (text-mode only, deterministic, low-confidence)
// ---------------------------------------------------------------------------

function inferKindFromLabel(text: string): ElectricalNodeKind {
  // Case-insensitive lookup against the shared kind-alias map —
  // same logic Sprints 73/74/78A use, so a "valve" comment renders
  // the same way no matter which ingestor produced it.
  const tokens = text
    .toLowerCase()
    .split(/[\s,;:.\-_/]+/)
    .filter((t) => t.length > 0);
  for (const tok of tokens) {
    const hint = KIND_ALIASES.get(tok);
    if (hint) return hint;
  }
  return 'unknown';
}

interface ExtractedIoRow {
  pageNumber: number;
  block: PdfTextBlock;
  address: string;
  tag: string;
  label: string;
  direction: 'input' | 'output' | 'unknown';
  signalType: 'bool' | 'int' | 'real' | 'unknown';
  confidence: number;
  reasons: string[];
}

function extractIoRow(
  pageNumber: number,
  block: PdfTextBlock,
): ExtractedIoRow | null {
  const m = IO_ROW_RE.exec(block.text);
  if (!m || !m.groups) return null;
  const rawAddress = (m.groups['addr'] ?? '').trim();
  const tag = m.groups['tag'] ?? '';
  const label = m.groups['label']?.trim() ?? '';
  // Normalize: detectPlcAddress's Siemens regex requires the `%`
  // prefix; PDF rows often write `I0.0` instead. Prefix when
  // missing, then validate.
  const probe = rawAddress.startsWith('%') ? rawAddress : `%${rawAddress}`;
  const detected = detectPlcAddress(probe);
  if (!detected) return null;
  const reasons: string[] = ['pdf-row-pattern-match'];
  let confidence = 0.55;
  if (label.length > 0) {
    confidence += 0.05;
    reasons.push('label-present');
  }
  // Conservative: PDF-derived rows never start higher than 0.65.
  if (confidence > 0.65) confidence = 0.65;
  return {
    pageNumber,
    block,
    address: detected.raw,
    tag,
    label,
    direction: detected.direction,
    signalType: 'bool',
    confidence,
    reasons,
  };
}

function buildGraphFromIoRows(
  rows: readonly ExtractedIoRow[],
  sourceId: string,
  fileName: string | undefined,
): { nodes: ElectricalNode[]; edges: ElectricalEdge[] } {
  const nodes: ElectricalNode[] = [];
  const edges: ElectricalEdge[] = [];
  const seenChannel = new Set<string>();
  let edgeIndex = 1;
  for (const r of rows) {
    const ref = r.block.sourceRef;
    const labelKind = r.label.length > 0 ? inferKindFromLabel(r.label) : 'unknown';
    const deviceKind: ElectricalNodeKind =
      labelKind === 'unknown'
        ? r.direction === 'input'
          ? 'sensor'
          : r.direction === 'output'
            ? 'actuator'
            : 'unknown'
        : labelKind;
    const deviceId = `pdf_device:${r.tag}`;
    const channelId = `plc_channel:${r.address}`;
    nodes.push({
      id: deviceId,
      kind: deviceKind,
      label: r.label || r.tag,
      sourceRefs: [ref],
      confidence: confidenceFromEvidence([
        { source: 'pdf-row', score: r.confidence, reason: r.reasons.join(',') },
      ]),
      attributes: {
        tag: r.tag,
        ...(r.label ? { label: r.label } : {}),
      },
    });
    if (!seenChannel.has(channelId)) {
      nodes.push({
        id: channelId,
        kind: 'plc_channel',
        label: r.address,
        sourceRefs: [ref],
        confidence: confidenceFromEvidence([
          { source: 'pdf-row', score: r.confidence, reason: r.reasons.join(',') },
        ]),
        attributes: {
          address: r.address,
          direction: r.direction,
          signal_type: r.signalType,
        },
      });
      seenChannel.add(channelId);
    }
    const edgeKind = r.direction === 'output' ? 'drives' : 'signals';
    const fromTo =
      r.direction === 'output'
        ? { from: channelId, to: deviceId }
        : { from: deviceId, to: channelId };
    edges.push({
      id: `pdf_edge:${edgeIndex}:${r.tag}`,
      kind: edgeKind,
      from: fromTo.from,
      to: fromTo.to,
      sourceRefs: [ref],
      confidence: confidenceFromEvidence([
        { source: 'pdf-row', score: r.confidence, reason: r.reasons.join(',') },
      ]),
      attributes: {
        tag: r.tag,
        address: r.address,
        direction: r.direction,
      },
    });
    edgeIndex++;
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Driver: ingestPdf
// ---------------------------------------------------------------------------

export interface IngestPdfResult extends PdfParseResult {
  graph: ElectricalGraph;
}

export function buildPdfGraphId(input: PdfIngestionInput): string {
  return `electrical_pdf:${input.sourceId}`;
}

/**
 * Full driver: parse → build graph → assemble result. Pure /
 * deterministic. NEVER throws on malformed input.
 *
 * Returns:
 *   - `document` — the structured `PdfDocument` (always present;
 *     empty pages on bytes-only inputs).
 *   - `graph` — `ElectricalGraph` with `sourceKind: 'pdf'`. Empty
 *     `nodes`/`edges` are NORMAL for bytes-only input or text input
 *     where no IO row matched.
 *   - `diagnostics` — combined document-level + graph-level
 *     diagnostics.
 */
export function ingestPdf(input: PdfIngestionInput): IngestPdfResult {
  if (!input || typeof input !== 'object') {
    return {
      document: emptyDocument({ sourceId: 'unknown' } as PdfIngestionInput),
      graph: emptyGraph({ sourceId: 'unknown' } as PdfIngestionInput),
      diagnostics: [
        createElectricalDiagnostic({
          code: 'PDF_EMPTY_INPUT',
          message: 'PDF ingest input is missing or not an object.',
        }),
      ],
    };
  }

  const aggregated: ElectricalDiagnostic[] = [];
  let document: PdfDocument = emptyDocument(input);
  let nodes: ElectricalNode[] = [];
  let edges: ElectricalEdge[] = [];
  let metadata: PdfDocumentMetadata | undefined;

  // Bytes path — honest stub.
  if (input.bytes && input.bytes.length > 0) {
    const v = validateBytes(input.bytes, input.options);
    aggregated.push(...v.diagnostics);
    if (v.encrypted) {
      metadata = { encrypted: true };
      document = { ...document, metadata };
    }
    if (typeof input.text !== 'string' || input.text.length === 0) {
      // Bytes only — no further extraction. Surface the
      // "electrical extraction not implemented" reminder once.
      aggregated.push(
        createElectricalDiagnostic({
          code: 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED',
          severity: 'info',
          message:
            'Sprint 79 v0 does not extract electrical evidence from binary PDFs. Use the test-mode text path for fixtures.',
        }),
      );
      return {
        document,
        graph: { ...emptyGraph(input), diagnostics: dedupePassthrough(aggregated) },
        diagnostics: aggregated,
      };
    }
  }

  // Text path — parse + try IO-row extraction.
  if (typeof input.text === 'string' && input.text.length > 0) {
    const parsed = parsePdfDocument(input);
    document = metadata
      ? { ...parsed.document, metadata }
      : parsed.document;
    aggregated.push(...parsed.diagnostics);

    const rows: ExtractedIoRow[] = [];
    for (const page of document.pages) {
      for (const block of page.textBlocks) {
        const row = extractIoRow(page.pageNumber, block);
        if (row) rows.push(row);
      }
    }
    if (rows.length === 0 && document.pages.some((p) => p.textBlocks.length > 0)) {
      aggregated.push(
        createElectricalDiagnostic({
          code: 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED',
          severity: 'info',
          message:
            'No deterministic IO-list rows were detected in the text layer. Sprint 79 v0 only recognises simple "<address> <tag> [<label>]" patterns.',
        }),
      );
    } else if (rows.length > 0) {
      const built = buildGraphFromIoRows(rows, input.sourceId, input.fileName);
      nodes = built.nodes;
      edges = built.edges;
    }
  } else if (!input.bytes || input.bytes.length === 0) {
    aggregated.push(
      createElectricalDiagnostic({
        code: 'PDF_EMPTY_INPUT',
        message: 'PDF ingest input has neither bytes nor text.',
      }),
    );
  }

  const graph: ElectricalGraph = {
    id: buildPdfGraphId(input),
    sourceKind: 'pdf',
    nodes,
    edges,
    diagnostics: dedupePassthrough(aggregated),
    metadata: {
      sourceFiles: input.fileName ? [input.fileName] : [],
      generator: 'electrical-ingest@pdf-v0',
    },
  };
  return { document, graph, diagnostics: aggregated };
}

function emptyGraph(input: PdfIngestionInput): ElectricalGraph {
  return {
    id: buildPdfGraphId(input),
    sourceKind: 'pdf',
    nodes: [],
    edges: [],
    diagnostics: [],
    metadata: {
      sourceFiles: input.fileName ? [input.fileName] : [],
      generator: 'electrical-ingest@pdf-v0',
    },
  };
}

// `dedupeElectricalDiagnostics` already exists in `diagnostics.ts`,
// but it's stricter than what we want here (it dedupes by message
// equality). For the PDF aggregator we just preserve order, since
// every per-block diag is already unique by content.
function dedupePassthrough(
  d: readonly ElectricalDiagnostic[],
): ElectricalDiagnostic[] {
  return [...d];
}

// ---------------------------------------------------------------------------
// Registry-facing wrapper
// ---------------------------------------------------------------------------

/**
 * Build a registry-facing PDF ingestor. Adapts `PdfIngestionInput`
 * <-> `ElectricalIngestionInput`:
 *   - `canIngest` returns true iff at least one file looks like a
 *     PDF (extension, `kind: 'pdf'`, or `%PDF-` magic).
 *   - `ingest` walks the files; each PDF file is ingested
 *     independently and the results are concatenated. Non-PDF
 *     files are ignored (the registry routes those to other
 *     ingestors).
 */
export function createPdfElectricalIngestor(): ElectricalSourceIngestor {
  return {
    canIngest(input: ElectricalIngestionInput): boolean {
      if (!input || typeof input !== 'object') return false;
      if (!Array.isArray(input.files) || input.files.length === 0) return false;
      return input.files.some((f) => detectPdf(f));
    },

    async ingest(input: ElectricalIngestionInput): Promise<ElectricalIngestionResult> {
      const sourceId = input.sourceId;
      const allDiagnostics: ElectricalDiagnostic[] = [];
      const allNodes: ElectricalNode[] = [];
      const allEdges: ElectricalEdge[] = [];
      const sourceFiles: string[] = [];
      for (const f of input.files ?? []) {
        if (!detectPdf(f)) continue;
        sourceFiles.push(f.path);
        const c = f.content;
        const ingestion = ingestPdf({
          sourceId,
          fileName: f.path,
          bytes: c instanceof Uint8Array ? c : undefined,
          text: typeof c === 'string' && !c.startsWith(PDF_HEADER) ? c : undefined,
        });
        allDiagnostics.push(...ingestion.diagnostics);
        allNodes.push(...ingestion.graph.nodes);
        allEdges.push(...ingestion.graph.edges);
      }
      const graph: ElectricalGraph = {
        id: `electrical_pdf:${sourceId}`,
        sourceKind: 'pdf',
        nodes: allNodes,
        edges: allEdges,
        diagnostics: dedupePassthrough(allDiagnostics),
        metadata: {
          sourceFiles,
          generator: 'electrical-ingest@pdf-v0',
        },
      };
      return { graph, diagnostics: allDiagnostics };
    },
  };
}
