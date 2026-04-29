// Sprint 79 → 80 — PDF ingestion. Three paths, in priority order:
//
//   1. **Bytes path with real text-layer extraction (Sprint 80).**
//      `extractPdfTextLayer` (pdfjs-dist legacy build) parses the
//      bytes, recovers per-page text items + bbox + font metrics,
//      and `pdf-text-normalize.ts` clusters them into deterministic
//      lines. Each line becomes a `PdfTextBlock` with a real
//      `SourceRef` (`kind: 'pdf'`, `page`, `bbox` in PDF points,
//      `snippet`). The conservative Sprint 79 IO-row regex runs
//      over the normalised line text and produces low-confidence
//      `ElectricalGraph` evidence. Failure modes (encrypted,
//      malformed, dependency-load-failed, per-page extraction
//      failure) all surface as structured diagnostics.
//
//   2. **Bytes path fallback to test-mode text (Sprint 79).** When
//      bytes extraction fails AND `text` is also supplied, the
//      ingestor honours the legacy test-mode parser so fixtures
//      that rely on the `--- page N ---` convention keep working.
//      The relevant failure diagnostic is preserved alongside.
//
//   3. **Text path (Sprint 79 test mode).** No bytes, just text.
//      Recognises the `--- page N ---` page-delimiter convention.
//      Same conservative IO-row regex; same conservative
//      confidence ladder (PDF-derived nodes ≤ 0.65).
//
// Architectural invariants (load-bearing — do not relax):
//   - PDF facts NEVER auto-promote to PIR. Sprint 75/76/78B review
//     gate is the only path forward.
//   - PDF-derived confidence is conservative and strictly below
//     structured CSV/XML rows.
//   - No OCR, no symbol recognition, no wire tracing, no cross-
//     page reference resolution. Every gap is a diagnostic, never
//     silent.
//
// Trademark / scope: this ingestor handles arbitrary PDF files by
// shape only — it makes no claim about supporting any particular
// vendor's PDF export format.

import { createElectricalDiagnostic } from '../diagnostics.js';
import { confidenceFromEvidence } from '../confidence.js';
import { detectPlcAddress } from '../normalize.js';
import { KIND_ALIASES } from '../mapping/kind-aliases.js';
import {
  classifyPdfAddress,
  isPdfChannelMarker,
  type PdfAddressClassification,
} from './pdf-address-strictness.js';
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
import {
  extractPdfTextLayer,
  type PdfTextLayerExtractionResult,
} from './pdf-text-layer.js';
import {
  groupItemsIntoLines,
  type PdfTextLayerLine,
} from './pdf-text-normalize.js';
import {
  clusterBlocksIntoRegions,
  detectColumnLayout,
  detectPageRotation,
  orderBlocksByLayout,
} from './pdf-layout.js';
import { detectIoTables, type PdfTableDetectorLine } from './pdf-table-detect.js';

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

// Sprint 79 IO-row pattern: `address tag [label]`. Sprint 81
// adds the tag-first and tag+direction-word variants below — kept
// as separate regexes so each pattern can be tested in isolation
// and the source pattern that matched is preserved on the
// `ExtractedIoRow` reasons trail.
//   - address: matched by `detectPlcAddress` (Siemens %I/%Q forms)
//   - tag: short alphanumeric token (B1, Y2, M3, …) capped at 16
//   - label: rest of the line, optional, kept verbatim
const IO_ROW_RE =
  /^\s*(?<addr>%?[IQM][WDB]?\d+(?:[.\/]\d+)?)\s+(?<tag>[A-Za-z][A-Za-z0-9_.+\-]{0,15})(?:\s+(?<label>.+?))?\s*$/;

/**
 * Sprint 81 — tag-first variant: `<tag> <address> [label]`.
 *
 * The tag is constrained to alphanumeric tokens whose leading char
 * is a letter that does NOT already look like a PLC-address prefix
 * (`I` / `Q` / `M` with or without `%`), so the regex doesn't
 * accidentally swallow address-first rows where the address starts
 * with a single uppercase letter.
 */
const IO_ROW_TAG_FIRST_RE =
  /^\s*(?<tag>(?!%?[IQM][WDB]?\d)[A-Za-z][A-Za-z0-9_.+\-]{0,15})\s+(?<addr>%?[IQM][WDB]?\d+(?:[.\/]\d+)?)(?:\s+(?<label>.+?))?\s*$/;

/**
 * Sprint 81 — tag + direction-word + address: `<tag> <direction>
 * <address> [label]`. Direction keywords cover English + German +
 * the very short forms (`i` / `o` / `e` / `a`) some industrial
 * sites use in column headers.
 */
const IO_ROW_TAG_DIR_ADDR_RE =
  /^\s*(?<tag>(?!%?[IQM][WDB]?\d)[A-Za-z][A-Za-z0-9_.+\-]{0,15})\s+(?<dir>input|output|in|out|eingang|ausgang|i|o|e|a)\s+(?<addr>%?[IQM][WDB]?\d+(?:[.\/]\d+)?)(?:\s+(?<label>.+?))?\s*$/i;

/**
 * Sprint 81 — direction-word table where the address is in a
 * separate column from the direction word: `<address> <tag>
 * <direction> [label]`. The direction column may explicitly say
 * `input` / `output` / `eingang` / `ausgang`.
 */
const IO_ROW_ADDR_TAG_DIR_RE =
  /^\s*(?<addr>%?[IQM][WDB]?\d+(?:[.\/]\d+)?)\s+(?<tag>(?!%?[IQM][WDB]?\d)[A-Za-z][A-Za-z0-9_.+\-]{0,15})\s+(?<dir>input|output|in|out|eingang|ausgang)\s*(?<label>.*)?$/i;

function normaliseDirectionWord(
  s: string | undefined | null,
): 'input' | 'output' | null {
  if (typeof s !== 'string') return null;
  const norm = s.trim().toLowerCase();
  if (
    norm === 'input' ||
    norm === 'in' ||
    norm === 'eingang' ||
    norm === 'i' ||
    norm === 'e'
  )
    return 'input';
  if (
    norm === 'output' ||
    norm === 'out' ||
    norm === 'ausgang' ||
    norm === 'o' ||
    norm === 'a'
  )
    return 'output';
  return null;
}

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

// Sprint 79 once carried a `bytesContain` helper that sniffed the
// trailer for `/Encrypt`. Sprint 80 delegates encryption detection
// to pdfjs-dist (it raises `PasswordException` from `getDocument`),
// so the helper is gone.

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
// Bytes-mode (Sprint 80 — real text-layer extraction; stub gone)
// ---------------------------------------------------------------------------
//
// The Sprint 79 `validateBytes` helper that emitted the
// `PDF_UNSUPPORTED_BINARY_PARSER` + `PDF_TEXT_LAYER_UNAVAILABLE`
// pair has been removed. The flow is now:
//
//   1. `startsWithPdfHeader(bytes)` for a cheap header check
//      (Sprint 79 contract: emit `PDF_MALFORMED` on mismatch).
//   2. `extractPdfTextLayer(bytes, opts)` (pdfjs-dist) for the
//      real decode — it owns encryption detection, parse-failure
//      diagnostics, and per-page extraction.
//
// `PDF_UNSUPPORTED_BINARY_PARSER` is intentionally NOT emitted in
// the success path. It can still appear in the codebase as a
// historical code (Sprint 79 stub fallback) but Sprint 80's real
// path no longer raises it.

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
  /**
   * Sprint 82 — `address` is `undefined` when the row's address
   * column was a channel marker (e.g. `I1` on a Beckhoff EL1004
   * overview) or otherwise non-strict. The row is still kept as
   * source evidence; `buildGraphFromIoRows` will NOT create a
   * `plc_channel:` node + edge for it.
   */
  address?: string;
  /**
   * Sprint 82 — verbatim address token even when it didn't pass
   * the strictness gate. Stored for review in `attributes.channel_marker`.
   */
  rawAddressToken: string;
  tag: string;
  label: string;
  direction: 'input' | 'output' | 'unknown';
  signalType: 'bool' | 'int' | 'real' | 'unknown';
  confidence: number;
  reasons: string[];
  /**
   * Sprint 81 — per-row diagnostics produced during extraction
   * (e.g. address-direction conflict). Aggregated by the caller
   * into the document-level diagnostics list.
   */
  diagnostics: ElectricalDiagnostic[];
  /**
   * Sprint 82 — PDF-specific strictness classification of the
   * row's address column. `'strict_plc_address'` rows are
   * promoted to a `plc_channel:` node + edge as before; every
   * other classification is preserved as evidence only and
   * raises `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS` /
   * `PDF_IO_ROW_AMBIGUOUS_ADDRESS`.
   */
  addressClassification: PdfAddressClassification;
}

function extractIoRow(
  pageNumber: number,
  block: PdfTextBlock,
): ExtractedIoRow | null {
  // Sprint 81 — try each pattern in order. Every successful match
  // produces a normalised tuple `(address, tag, label, direction)`
  // plus the regex name in `reasons` so the source pattern is
  // preserved end-to-end.
  let rawAddress = '';
  let tag = '';
  let label = '';
  let directionWord: 'input' | 'output' | null = null;
  let pattern: 'addr-tag' | 'tag-addr' | 'tag-dir-addr' | 'addr-tag-dir' | null =
    null;

  let m = IO_ROW_TAG_DIR_ADDR_RE.exec(block.text);
  if (m && m.groups) {
    rawAddress = (m.groups['addr'] ?? '').trim();
    tag = m.groups['tag'] ?? '';
    label = m.groups['label']?.trim() ?? '';
    directionWord = normaliseDirectionWord(m.groups['dir']);
    pattern = 'tag-dir-addr';
  }
  if (!pattern) {
    m = IO_ROW_ADDR_TAG_DIR_RE.exec(block.text);
    if (m && m.groups) {
      rawAddress = (m.groups['addr'] ?? '').trim();
      tag = m.groups['tag'] ?? '';
      label = m.groups['label']?.trim() ?? '';
      directionWord = normaliseDirectionWord(m.groups['dir']);
      pattern = 'addr-tag-dir';
    }
  }
  if (!pattern) {
    m = IO_ROW_RE.exec(block.text);
    if (m && m.groups) {
      rawAddress = (m.groups['addr'] ?? '').trim();
      tag = m.groups['tag'] ?? '';
      label = m.groups['label']?.trim() ?? '';
      pattern = 'addr-tag';
    }
  }
  if (!pattern) {
    m = IO_ROW_TAG_FIRST_RE.exec(block.text);
    if (m && m.groups) {
      rawAddress = (m.groups['addr'] ?? '').trim();
      tag = m.groups['tag'] ?? '';
      label = m.groups['label']?.trim() ?? '';
      pattern = 'tag-addr';
    }
  }
  if (!pattern) return null;

  // Sprint 82 — page-24-style noise: lines like "I1 I2" on a
  // Beckhoff module overview match the regex (addr=I1, tag=I2)
  // but neither side is a real address+tag pair. Reject the
  // whole row when the tag column is itself a channel marker.
  if (isPdfChannelMarker(tag)) {
    return null;
  }

  // Normalize: detectPlcAddress's Siemens regex requires the `%`
  // prefix; PDF rows often write `I0.0` instead. Prefix when
  // missing, then validate.
  const probe = rawAddress.startsWith('%') ? rawAddress : `%${rawAddress}`;
  const detected = detectPlcAddress(probe);
  if (!detected) return null;

  // Sprint 82 — PDF-specific strictness gate. `detectPlcAddress`
  // accepts Siemens forms where the bit is OPTIONAL (`%I1`), which
  // is correct for CSV / EPLAN but unsafe for PDF: an isolated
  // `I1` on a module overview is a channel marker, not an
  // address. Classify the verbatim raw token (not the
  // `%`-prefixed probe) so the operator-facing diagnostic
  // matches what the PDF actually printed.
  const classification = classifyPdfAddress(rawAddress);
  const reasons: string[] = [`pdf-row-pattern:${pattern}`];
  const diagnostics: ElectricalDiagnostic[] = [];

  // Resolve direction. The address direction is the structural
  // signal (I→input, Q→output, M→unknown). When a column word is
  // also present, prefer the address direction but flag a conflict
  // so the operator sees it during review.
  let direction: 'input' | 'output' | 'unknown' = detected.direction;
  if (directionWord && direction !== 'unknown' && directionWord !== direction) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT',
        severity: 'warning',
        message: `Row "${truncatePdfRow(block.text, 80)}": address direction (${direction}) does not match column direction (${directionWord}). Address wins.`,
        sourceRef: block.sourceRef,
      }),
    );
    reasons.push('direction-conflict');
  } else if (directionWord && direction === 'unknown') {
    direction = directionWord;
    reasons.push('direction-from-column');
  }

  // Confidence ladder. Same shape Sprint 79/80 used; Sprint 81
  // bumps the explicit-direction-column case slightly because
  // direction-aware extraction is more reliable than a bare
  // `address tag` pattern.
  let confidence = 0.55;
  if (label.length > 0) {
    confidence += 0.05;
    reasons.push('label-present');
  }
  if (directionWord) {
    confidence += 0.02;
    reasons.push('direction-column-present');
  }
  if (pattern === 'tag-dir-addr' || pattern === 'addr-tag-dir') {
    confidence += 0.02;
    reasons.push('header-aware-pattern');
  }
  // Sprint 82 — channel-marker / ambiguous addresses cap one
  // notch lower. They land as evidence-only; downstream graph
  // construction will refuse to synthesise a buildable PLC
  // address from them.
  if (
    classification.classification === 'channel_marker' ||
    classification.classification === 'ambiguous'
  ) {
    confidence -= 0.05;
    reasons.push(`pdf-address-${classification.classification}`);
  }
  // Conservative: PDF-derived rows never exceed 0.65 (and never
  // dip below 0.5 — a cap on both sides keeps the review UI's
  // confidence badge legible).
  if (confidence > 0.65) confidence = 0.65;
  if (confidence < 0.5) confidence = 0.5;

  // Sprint 82 — strictness diagnostics. The row is preserved as
  // evidence either way; the diagnostics tell the operator why
  // a buildable PIR address was (or wasn't) produced.
  if (classification.classification === 'strict_plc_address') {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_IO_ROW_EXTRACTED',
        severity: 'info',
        message: `IO row extracted (${pattern}): ${detected.raw} ${tag}${label ? ' ' + label : ''}`,
        sourceRef: block.sourceRef,
      }),
    );
  } else {
    // `PDF_MODULE_CHANNEL_MARKER_DETECTED` (info) records that
    // we saw the marker; `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS`
    // (warning) explains why nothing was promoted to a buildable
    // PLC address. `PDF_IO_ROW_REQUIRES_STRICT_ADDRESS` (warning)
    // covers the ambiguous case.
    if (classification.classification === 'channel_marker') {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_MODULE_CHANNEL_MARKER_DETECTED',
          severity: 'info',
          message: `Channel marker "${rawAddress}" recognised in row (${classification.reason}).`,
          sourceRef: block.sourceRef,
        }),
      );
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS',
          severity: 'warning',
          message: `Row "${truncatePdfRow(block.text, 80)}": "${rawAddress}" looks like a module channel marker, not a strict PLC address. The row is preserved as evidence but will NOT be promoted to a buildable PIR IO address.`,
          sourceRef: block.sourceRef,
          hint: 'Strict PLC address forms required from PDF: %I0.0 / %Q0.1 / I 0.0 / Q 1.2 / %IX0.0 / Local:1:I.Data[0].0.',
        }),
      );
    } else {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_IO_ROW_REQUIRES_STRICT_ADDRESS',
          severity: 'warning',
          message: `Row "${truncatePdfRow(block.text, 80)}": address "${rawAddress}" did not match a strict PLC-address shape (${classification.reason}). The row is preserved as evidence but will NOT be promoted to a buildable PIR IO address.`,
          sourceRef: block.sourceRef,
        }),
      );
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_IO_ROW_AMBIGUOUS_ADDRESS',
          severity: 'warning',
          message: `Ambiguous address column on row "${truncatePdfRow(block.text, 80)}".`,
          sourceRef: block.sourceRef,
        }),
      );
    }
  }

  return {
    pageNumber,
    block,
    address:
      classification.classification === 'strict_plc_address'
        ? detected.raw
        : undefined,
    rawAddressToken: rawAddress,
    tag,
    label,
    direction,
    signalType: 'bool',
    confidence,
    reasons,
    diagnostics,
    addressClassification: classification.classification,
  };
}

function truncatePdfRow(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function buildGraphFromIoRows(
  rows: readonly ExtractedIoRow[],
  sourceId: string,
  fileName: string | undefined,
): { nodes: ElectricalNode[]; edges: ElectricalEdge[] } {
  void sourceId;
  void fileName;
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
        // Sprint 82 — when the row's address column was a
        // channel marker / ambiguous, preserve the verbatim
        // token so the operator can audit it during review,
        // but DO NOT promote it to a buildable PLC address.
        ...(r.addressClassification !== 'strict_plc_address'
          ? {
              channel_marker: r.rawAddressToken,
              address_classification: r.addressClassification,
            }
          : {}),
      },
    });

    // Sprint 82 — `plc_channel:` + edge are ONLY emitted for
    // strict PLC addresses. Channel-marker / ambiguous rows are
    // kept as device evidence above; the PIR builder never sees
    // them as IO and therefore can never synthesise an `%I1`
    // address from a Beckhoff module overview.
    if (r.addressClassification !== 'strict_plc_address' || !r.address) {
      continue;
    }
    const channelId = `plc_channel:${r.address}`;
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
 * Full driver: bytes → text-layer extraction → graph; or text-mode
 * parse → graph. Async (the text-layer extractor is async). NEVER
 * throws on malformed input — every failure mode lands as a
 * structured diagnostic.
 *
 * Returns:
 *   - `document` — the structured `PdfDocument` (always present;
 *     empty pages on bytes-only inputs that fail to parse).
 *   - `graph` — `ElectricalGraph` with `sourceKind: 'pdf'`. Empty
 *     `nodes`/`edges` are NORMAL for any input whose text layer
 *     contained no IO-row-pattern match.
 *   - `diagnostics` — combined document-level + graph-level
 *     diagnostics.
 *
 * Resolution priority when both `bytes` and `text` are supplied:
 *   1. Run the bytes extractor.
 *   2. If extraction OK → use it and ignore `text`.
 *   3. If extraction failed (encrypted, malformed, dependency
 *      load failed, parse error) AND `text` is non-empty → fall
 *      back to the Sprint 79 test-mode parser. Both diagnostic
 *      sets are preserved so the operator sees what happened.
 */
export async function ingestPdf(
  input: PdfIngestionInput,
): Promise<IngestPdfResult> {
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
  let bytesExtractionSucceeded = false;

  // ---- Bytes path: real text-layer extraction (Sprint 80) ----
  if (input.bytes && input.bytes.length > 0) {
    // Cheap header sanity-check first — saves loading pdfjs for
    // obvious non-PDFs and matches the Sprint 79 PDF_MALFORMED
    // contract.
    if (!startsWithPdfHeader(input.bytes)) {
      aggregated.push(
        createElectricalDiagnostic({
          code: 'PDF_MALFORMED',
          message: 'Input does not start with the PDF "%PDF-" magic header.',
        }),
      );
    } else {
      const opts = withDefaultOptions(input.options);
      const extraction = await extractPdfTextLayer({
        bytes: input.bytes,
        maxPages: opts.maxPages,
      });
      aggregated.push(...extraction.diagnostics);
      if (extraction.encrypted) {
        metadata = { encrypted: true };
        document = { ...document, metadata };
      }
      if (extraction.ok) {
        const built = buildPdfDocumentFromExtraction(extraction, input);
        document = metadata ? { ...built.document, metadata } : built.document;
        aggregated.push(...built.diagnostics);
        nodes = built.nodes;
        edges = built.edges;
        bytesExtractionSucceeded = true;
      }
    }

    // No text fallback path — surface the canonical Sprint 79
    // "electrical extraction not implemented" reminder when bytes
    // failed AND no text was supplied. The operator should see a
    // clear "we couldn't get anything out of this PDF" signal.
    if (
      !bytesExtractionSucceeded &&
      (typeof input.text !== 'string' || input.text.length === 0)
    ) {
      aggregated.push(
        createElectricalDiagnostic({
          code: 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED',
          severity: 'info',
          message:
            'No electrical evidence was extracted from this PDF. The text layer was not recoverable; supply pre-extracted text via PdfIngestionInput.text or wait for the higher-fidelity parser scheduled in a future sprint.',
        }),
      );
    }
  }

  // ---- Text path (Sprint 79 test mode) ----
  // Runs only when bytes did NOT succeed; if the bytes extractor
  // already produced a document, ignore `text` to avoid duplicate
  // pages.
  if (
    !bytesExtractionSucceeded &&
    typeof input.text === 'string' &&
    input.text.length > 0
  ) {
    const parsed = parsePdfDocument(input);
    document = metadata
      ? { ...parsed.document, metadata }
      : parsed.document;
    aggregated.push(...parsed.diagnostics);

    // Sprint 81 — run table detection over each page's lines
    // before flat IO extraction. Tables are a strictly additive
    // signal: lines absorbed into a table still go through
    // `extractIoRow`, but the table candidate is preserved on
    // the page and the per-table diagnostics are surfaced.
    //
    // Sprint 83C — call `detectIoTables` ONCE over all pages so
    // non-IO family diagnostics can roll up across page ranges
    // (e.g. "BOM on pages 80–86") instead of one per page.
    //
    // Sprint 84 — when blocks carry geometry, reorder per page
    // by column-aware reading order so multi-column pages don't
    // interleave unrelated columns into the detector input.
    // No-op for test-mode (no bboxes) — Sprint 79/81 ordering
    // is preserved verbatim.
    //
    // Sprint 84.1 — also cluster each page's ordered blocks into
    // vertical regions and tag detector lines with a `regionId`,
    // so `detectIoTables` cannot bridge a header in one region
    // with data rows in another (footer / title-block / unrelated
    // narrative on the same line stream). Region tagging only
    // fires when geometry resolves ≥ 2 regions; single-region
    // pages stay unscoped (no `regionId` set).
    const allDetectorLines: PdfTableDetectorLine[] = [];
    for (const page of document.pages) {
      const orderedBlocks = orderBlocksByLayout(page.textBlocks, {
        pageWidth: page.width,
        pageHeight: page.height,
      });
      const layout = detectColumnLayout(page.textBlocks, {
        pageWidth: page.width,
        pageHeight: page.height,
      });
      if (layout.multiColumn) {
        aggregated.push(
          createElectricalDiagnostic({
            code: 'PDF_LAYOUT_MULTI_COLUMN_DETECTED',
            severity: 'info',
            message:
              `Detected ${layout.columns.length} columns on page ` +
              `${page.pageNumber}; using column-aware reading order.`,
          }),
        );
      }
      const rotation = detectPageRotation(page);
      if (rotation.suspected) {
        aggregated.push(
          createElectricalDiagnostic({
            code: 'PDF_LAYOUT_ROTATION_SUSPECTED',
            severity: 'info',
            message:
              `Page ${page.pageNumber} looks rotated ` +
              `(${rotation.reason}); deterministic extraction may be ` +
              `unreliable on this page.`,
          }),
        );
      }
      const regions = clusterBlocksIntoRegions(orderedBlocks);
      const regionIdByBlockId = new Map<string, string>();
      if (regions.length >= 2) {
        aggregated.push(
          createElectricalDiagnostic({
            code: 'PDF_LAYOUT_REGION_CLUSTERED',
            severity: 'info',
            message:
              `Clustered page ${page.pageNumber} into ${regions.length} ` +
              `vertical region(s); IO-table walks are scoped to a single region.`,
          }),
        );
        regions.forEach((region, idx) => {
          const rid = `pdf:p${page.pageNumber}:r${idx + 1}`;
          for (const b of region.blocks) {
            regionIdByBlockId.set(b.id, rid);
          }
        });
      }
      for (const block of orderedBlocks) {
        const line: PdfTableDetectorLine = {
          block,
          items: undefined,
          pageNumber: page.pageNumber,
        };
        const rid = regionIdByBlockId.get(block.id);
        if (rid) line.regionId = rid;
        allDetectorLines.push(line);
      }
    }
    const tableResult = detectIoTables({
      lines: allDetectorLines,
      sourceId: input.sourceId,
      fileName: input.fileName,
    });
    aggregated.push(...tableResult.diagnostics);

    const updatedPages: PdfPage[] = [];
    const rows: ExtractedIoRow[] = [];
    for (const page of document.pages) {
      for (const block of page.textBlocks) {
        const row = extractIoRow(page.pageNumber, block);
        if (row) {
          rows.push(row);
          aggregated.push(...row.diagnostics);
        }
      }
      updatedPages.push({
        ...page,
        tableCandidates: tableResult.tables.filter(
          (t) => t.pageNumber === page.pageNumber,
        ),
      });
    }
    document = { ...document, pages: updatedPages };
    if (rows.length === 0 && document.pages.some((p) => p.textBlocks.length > 0)) {
      aggregated.push(
        createElectricalDiagnostic({
          code: 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED',
          severity: 'info',
          message:
            'No deterministic IO-list rows were detected in the text layer. Sprint 81 recognises address-first / tag-first / direction-word IO row variants only.',
        }),
      );
    } else if (rows.length > 0) {
      const built = buildGraphFromIoRows(rows, input.sourceId, input.fileName);
      nodes = built.nodes;
      edges = built.edges;
      aggregated.push(
        createElectricalDiagnostic({
          code: 'PDF_MANUAL_REVIEW_REQUIRED',
          severity: 'info',
          message: `${rows.length} PDF-derived IO row(s) extracted; review required before promotion to PIR.`,
        }),
      );
    }
  } else if (
    !bytesExtractionSucceeded &&
    (!input.bytes || input.bytes.length === 0)
  ) {
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

/**
 * Sprint 80 — turn a raw `PdfTextLayerExtractionResult` into a
 * `PdfDocument` plus the same `ElectricalGraph` shape Sprint 79
 * produced from text-mode input. Each line (clustered by Y by
 * `groupItemsIntoLines`) becomes a `PdfTextBlock`; the bbox is
 * the union of the line's items in PDF point space.
 */
function buildPdfDocumentFromExtraction(
  extraction: PdfTextLayerExtractionResult,
  input: PdfIngestionInput,
): {
  document: PdfDocument;
  diagnostics: ElectricalDiagnostic[];
  nodes: ElectricalNode[];
  edges: ElectricalEdge[];
} {
  const diagnostics: ElectricalDiagnostic[] = [];
  const opts = withDefaultOptions(input.options);
  const docPages: PdfPage[] = [];
  let totalBlocks = 0;
  // Sprint 81 — keep per-page item streams alongside the line
  // blocks so the table detector can use real x positions for
  // header column mapping (instead of falling back to whitespace
  // splitting like the test-mode path does).
  const perPageDetectorLines: Array<
    Array<{
      block: PdfTextBlock;
      items?: Array<{ text: string; x: number; width: number }>;
      pageNumber: number;
    }>
  > = [];
  for (const p of extraction.pages) {
    const lines = groupItemsIntoLines(p.items);
    const blocks: PdfTextBlock[] = [];
    const detectorLines: Array<{
      block: PdfTextBlock;
      items?: Array<{ text: string; x: number; width: number }>;
      pageNumber: number;
    }> = [];
    for (let i = 0; i < lines.length; i++) {
      const block = makeTextBlockFromLine(
        lines[i],
        p.pageNumber,
        i + 1,
        input.sourceId,
        input.fileName,
      );
      if (block.confidence >= opts.minTextConfidence) {
        blocks.push(block);
        detectorLines.push({
          block,
          items: lines[i].items.map((it) => ({
            text: it.text,
            x: it.x,
            width: it.width,
          })),
          pageNumber: p.pageNumber,
        });
      }
    }
    totalBlocks += blocks.length;
    perPageDetectorLines.push(detectorLines);
    docPages.push({
      pageNumber: p.pageNumber,
      width: p.width,
      height: p.height,
      textBlocks: blocks,
      tableCandidates: [],
      diagnostics: p.diagnostics,
    });
  }

  // Document-level success diagnostic. Note: `extraction.diagnostics`
  // already contains per-page warnings (empty page / extraction
  // failure); adding the success info here keeps the surface
  // consistent with the Sprint 79 text-mode contract that emits
  // a per-parse `PDF_TEXT_BLOCK_EXTRACTED`.
  if (totalBlocks > 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_TEXT_LAYER_EXTRACTED',
        severity: 'info',
        message: `Real text-layer extracted: ${totalBlocks} line block(s) across ${docPages.length} page(s).`,
      }),
    );
  } else {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_NO_TEXT_BLOCKS',
        message: 'PDF has a text layer but it produced zero usable line blocks.',
      }),
    );
  }
  diagnostics.push(
    createElectricalDiagnostic({
      code: 'PDF_TABLE_DETECTION_NOT_IMPLEMENTED',
      severity: 'info',
      message:
        'Layout-aware table detection beyond Sprint 81 v0 is not implemented yet. Sprint 81 recognises single-column IO-list tables only; multi-column / rotated layouts remain deferred.',
    }),
  );
  if (input.options?.allowOcr) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_OCR_NOT_ENABLED',
        severity: 'info',
        message:
          'allowOcr=true was passed, but Sprint 81 v0 does not run OCR. The flag is reserved for a future opt-in.',
      }),
    );
  }

  // Sprint 81 — run table detection per page with real x geometry,
  // attach the candidates to the page, then run the IO-row regex
  // over every block (table + non-table, since tables don't change
  // the per-row contract — they just provide context).
  //
  // Sprint 83C — call `detectIoTables` ONCE over all pages so
  // non-IO family diagnostics can roll up across page ranges
  // (e.g. "BOM on pages 80–86") instead of one per page.
  //
  // Sprint 84 — reorder detector lines per page by column-aware
  // reading order before forwarding them to `detectIoTables`.
  // Multi-column pages and pages flagged as rotated emit their
  // own info diagnostics so the operator knows the extractor took
  // a layout-aware path on that page.
  const allDetectorLines: PdfTableDetectorLine[] = [];
  for (let pi = 0; pi < docPages.length; pi++) {
    const lines = perPageDetectorLines[pi];
    if (!lines || lines.length === 0) continue;
    const page = docPages[pi];
    const pageBlocks = lines.map((l) => l.block);
    const layout = detectColumnLayout(pageBlocks, {
      pageWidth: page.width,
      pageHeight: page.height,
    });
    if (layout.multiColumn) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_LAYOUT_MULTI_COLUMN_DETECTED',
          severity: 'info',
          message:
            `Detected ${layout.columns.length} columns on page ` +
            `${page.pageNumber}; using column-aware reading order.`,
        }),
      );
    }
    const rotation = detectPageRotation(page);
    if (rotation.suspected) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_LAYOUT_ROTATION_SUSPECTED',
          severity: 'info',
          message:
            `Page ${page.pageNumber} looks rotated ` +
            `(${rotation.reason}); deterministic extraction may be ` +
            `unreliable on this page.`,
        }),
      );
    }
    const ordered = orderBlocksByLayout(pageBlocks, {
      pageWidth: page.width,
      pageHeight: page.height,
    });
    // Sprint 84.1 — region clustering on the same ordered blocks.
    const regions = clusterBlocksIntoRegions(ordered);
    const regionIdByBlockId = new Map<string, string>();
    if (regions.length >= 2) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_LAYOUT_REGION_CLUSTERED',
          severity: 'info',
          message:
            `Clustered page ${page.pageNumber} into ${regions.length} ` +
            `vertical region(s); IO-table walks are scoped to a single region.`,
        }),
      );
      regions.forEach((region, idx) => {
        const rid = `pdf:p${page.pageNumber}:r${idx + 1}`;
        for (const b of region.blocks) {
          regionIdByBlockId.set(b.id, rid);
        }
      });
    }
    const lineByBlockId = new Map(lines.map((l) => [l.block.id, l]));
    for (const block of ordered) {
      const line = lineByBlockId.get(block.id);
      if (!line) continue;
      const rid = regionIdByBlockId.get(block.id);
      if (rid) {
        // Sprint 84.1 — clone (shallow) so we don't mutate the
        // input detector-line array that the caller may still
        // be using.
        allDetectorLines.push({ ...line, regionId: rid });
      } else {
        allDetectorLines.push(line);
      }
    }
  }
  if (allDetectorLines.length > 0) {
    const tableResult = detectIoTables({
      lines: allDetectorLines,
      sourceId: input.sourceId,
      fileName: input.fileName,
    });
    diagnostics.push(...tableResult.diagnostics);
    for (let pi = 0; pi < docPages.length; pi++) {
      const pageNumber = docPages[pi].pageNumber;
      const tablesForPage = tableResult.tables.filter(
        (t) => t.pageNumber === pageNumber,
      );
      if (tablesForPage.length > 0) {
        docPages[pi] = {
          ...docPages[pi],
          tableCandidates: tablesForPage,
        };
      }
    }
  }

  const rows: ExtractedIoRow[] = [];
  for (const page of docPages) {
    for (const block of page.textBlocks) {
      const row = extractIoRow(page.pageNumber, block);
      if (row) {
        rows.push(row);
        diagnostics.push(...row.diagnostics);
      }
    }
  }
  let nodes: ElectricalNode[] = [];
  let edges: ElectricalEdge[] = [];
  if (rows.length === 0 && totalBlocks > 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED',
        severity: 'info',
        message:
          'No deterministic IO-list rows were detected in the extracted text layer. Sprint 81 recognises address-first / tag-first / direction-word IO row variants only.',
      }),
    );
  } else if (rows.length > 0) {
    const built = buildGraphFromIoRows(rows, input.sourceId, input.fileName);
    nodes = built.nodes;
    edges = built.edges;
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_MANUAL_REVIEW_REQUIRED',
        severity: 'info',
        message: `${rows.length} PDF-derived IO row(s) extracted; review required before promotion to PIR.`,
      }),
    );
  }

  const document: PdfDocument = {
    sourceId: input.sourceId,
    fileName: input.fileName,
    pageCount: extraction.pageCount,
    pages: docPages,
    diagnostics: [],
  };
  return { document, diagnostics, nodes, edges };
}

function makeTextBlockFromLine(
  line: PdfTextLayerLine,
  pageNumber: number,
  blockIndex: number,
  sourceId: string,
  fileName: string | undefined,
): PdfTextBlock {
  // Real text-layer extraction is already a structured signal —
  // a real glyph stream landed on this line. Sprint 80 keeps the
  // confidence ladder Sprint 79 set: 0.6 if the line text matches
  // the IO-row pattern, 0.5 otherwise. PDF-derived blocks never
  // exceed 0.65 downstream.
  const matchesIoRow = IO_ROW_RE.test(line.text);
  const confidence = matchesIoRow ? 0.6 : 0.5;
  const snippet =
    line.text.length > 160 ? line.text.slice(0, 160) + '…' : line.text;
  return {
    id: blockId(sourceId, pageNumber, blockIndex),
    text: line.text,
    bbox: line.bbox,
    confidence,
    sourceRef: buildPdfSourceRef({
      sourceId,
      fileName,
      page: pageNumber,
      // Use the block index inside the page as the line number —
      // matches the Sprint 79 text-mode contract (1-based, sorted
      // top-to-bottom).
      line: blockIndex,
      snippet,
      bbox: line.bbox,
    }),
  };
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
        const ingestion = await ingestPdf({
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
