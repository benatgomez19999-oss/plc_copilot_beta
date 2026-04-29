// Sprint 79 — PDF document model types. These describe the *evidence*
// extracted from a PDF (a hierarchy of pages → text blocks →
// optionally tables) and the input/output shape of the PDF ingestor.
// They live here, separate from the generic `types.ts`, so adding
// PDF-specific shapes never widens the cross-cutting type surface
// every other ingestor depends on.
//
// Architectural invariants (load-bearing — do not relax):
//
//   - A `PdfDocument` is *evidence*, not PIR. Nothing here is a fact
//     about the controlled machine. Promotion to PIR only happens
//     via the existing review-first builder gate.
//
//   - Every `PdfTextBlock` carries a `SourceRef` (kind: 'pdf') with
//     `page` + `bbox` (when known) + `snippet`. Producers MUST set
//     these fields — empty `SourceRef` is a contract violation.
//
//   - Confidence on PDF-derived blocks is conservative. A single PDF
//     line never reads at higher confidence than a structured CSV
//     row that names the same address explicitly.
//
//   - The ingestor NEVER fakes binary parsing. Bytes-only inputs
//     emit `PDF_UNSUPPORTED_BINARY_PARSER` + friends and return an
//     empty document; production parser is future work.

import type { ElectricalDiagnostic, SourceRef } from '../types.js';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Visual region inside a page. The `unit` field is mandatory for the
 * PDF model (the cross-cutting `SourceRefBoundingBox` keeps it
 * optional so non-PDF producers can omit it).
 */
export interface PdfBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'pt' | 'px' | 'normalized';
}

// ---------------------------------------------------------------------------
// Document / page / blocks / tables
// ---------------------------------------------------------------------------

export interface PdfDocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  /** ISO 8601 — extracted verbatim from PDF info dictionary if available. */
  createdAt?: string;
  modifiedAt?: string;
  /** True iff the parser detected a `/Encrypt` dictionary in the trailer. */
  encrypted?: boolean;
}

export interface PdfTextBlock {
  /**
   * Deterministic id of the form `pdf:<sourceId>:p<page>:b<index>`.
   * The index is 1-based and stable across re-ingestions of the
   * same input.
   */
  id: string;
  text: string;
  bbox?: PdfBoundingBox;
  /**
   * Confidence in `[0, 1]`. Test-mode (text-input) blocks default
   * to a conservative `0.5`; pattern-recognised IO rows go up to
   * `0.6`. Real binary-extraction confidences come from the
   * underlying PDF parser when one ships.
   */
  confidence: number;
  /** Always `kind: 'pdf'`; carries `page`, `bbox` (when known), and `snippet`. */
  sourceRef: SourceRef;
}

export interface PdfTableRowCandidate {
  /**
   * Underlying text-layer items that make up this row's cells. Empty
   * when the producer only had line-level granularity (Sprint 81 v0
   * mostly populates this from the parent line's items).
   */
  cells: PdfTextBlock[];
  confidence: number;
  /**
   * Sprint 81 — verbatim row text. When the row originated from a
   * single line block, this matches the line's text. Snippet length
   * is bounded by the same per-block snippet cap.
   */
  rawText?: string;
  /**
   * Sprint 81 — discriminator of header vs data vs unknown rows. The
   * header row always appears first inside its parent table.
   */
  kind?: 'header' | 'data' | 'unknown';
  /**
   * Sprint 81 — source-trace for the row. Carries the same
   * `kind: 'pdf'` SourceRef the parent line block had (page, line,
   * snippet, bbox, symbol).
   */
  sourceRef?: SourceRef;
}

/**
 * Sprint 81 — column role tags. The header detector tries to map
 * each header label to one of these roles. `'unknown'` means the
 * detector saw a column but couldn't classify it; that column is
 * preserved so the operator can still see it during review.
 */
export type PdfTableColumnRole =
  | 'address'
  | 'tag'
  | 'direction'
  | 'description'
  | 'channel'
  | 'comment'
  | 'signal_type'
  | 'unknown';

export interface PdfTableColumn {
  role: PdfTableColumnRole;
  /** Verbatim header text (the operator's label). */
  headerLabel: string;
  /** Approximate left-edge x of the column in PDF point space. */
  xMin: number;
  /** Approximate right-edge x of the column in PDF point space. */
  xMax: number;
}

export interface PdfTableHeaderLayout {
  columns: PdfTableColumn[];
  /** Verbatim header line text. */
  rawText: string;
}

export interface PdfTableCandidate {
  /**
   * Deterministic id of the form `pdf:<sourceId>:p<page>:t<index>`.
   * Sprint 81 populates this for the IO-list-shaped tables it can
   * recognise; future sprints will broaden the recogniser without
   * a schema bump.
   */
  id: string;
  pageNumber: number;
  bbox?: PdfBoundingBox;
  rows: PdfTableRowCandidate[];
  confidence: number;
  sourceRef: SourceRef;
  /**
   * Sprint 81 — header layout, when the table started with a header
   * line the detector could classify. Absent when the rows look
   * IO-list-shaped but have no recognisable header.
   */
  headerLayout?: PdfTableHeaderLayout;
}

export interface PdfPage {
  /** 1-based page number — matches PDF reader UIs. */
  pageNumber: number;
  /** Optional page geometry; populated by future binary parsers. */
  width?: number;
  height?: number;
  rotation?: number;
  textBlocks: PdfTextBlock[];
  /** Sprint 79 v0 leaves this empty — see PDF_TABLE_DETECTION_NOT_IMPLEMENTED. */
  tableCandidates: PdfTableCandidate[];
  diagnostics: ElectricalDiagnostic[];
}

export interface PdfDocument {
  sourceId: string;
  fileName?: string;
  /** Total number of pages, when known. May be `pages.length`. */
  pageCount?: number;
  pages: PdfPage[];
  diagnostics: ElectricalDiagnostic[];
  metadata?: PdfDocumentMetadata;
}

// ---------------------------------------------------------------------------
// Ingestor input / options / parse result
// ---------------------------------------------------------------------------

export interface PdfIngestionInput {
  sourceId: string;
  fileName?: string;
  /**
   * Raw PDF bytes. Sprint 79 v0 validates the `%PDF-` header but
   * does NOT decode the binary stream; bytes-only inputs return an
   * empty document with structured "not implemented" diagnostics.
   */
  bytes?: Uint8Array;
  /**
   * Test-mode pre-extracted text. The ingestor recognises the
   * page-delimiter convention `--- page N ---` (case-insensitive,
   * any leading/trailing whitespace allowed) and otherwise treats
   * the whole input as page 1. This path exists so the
   * architecture can be unit-tested without binding to a binary
   * PDF parser dependency.
   */
  text?: string;
  options?: PdfIngestionOptions;
}

export interface PdfIngestionOptions {
  /**
   * Allow OCR fallback for scanned PDFs. Sprint 79 v0 NEVER runs
   * OCR; this flag is reserved so a future opt-in can land
   * without breaking the ingestor signature. When set in v0, the
   * ingestor still emits `PDF_OCR_NOT_ENABLED` info — it does not
   * silently degrade to a faked extraction.
   */
  allowOcr?: boolean;
  /**
   * Attempt text-layer extraction when bytes are provided. Sprint
   * 79 v0 has no real binary parser, so this flag is reserved.
   * Default `true`.
   */
  extractTextLayer?: boolean;
  /**
   * Hard limit on pages processed. Pages beyond the limit emit a
   * `PDF_PAGE_LIMIT_EXCEEDED` warning and are dropped. Default
   * `200` (a chair-of-thumb for "is this a normal-sized electrical
   * doc, or a 5000-page archive bomb?").
   */
  maxPages?: number;
  /**
   * Floor on per-block confidence. Blocks whose computed confidence
   * is below this threshold are dropped (with a per-block
   * diagnostic). Default `0` — keep everything; rely on the review
   * UI's confidence badge.
   */
  minTextConfidence?: number;
}

export interface PdfParseResult {
  document: PdfDocument;
  diagnostics: ElectricalDiagnostic[];
}
