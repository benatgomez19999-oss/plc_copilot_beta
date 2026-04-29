// Sprint 83E → 83F — PDF source-evidence helpers for the review UI.
//
// Pure / DOM-free / total. The Sprint 83D rollup diagnostic
// message carries a compressed page phrase ("page 3", "pages
// 80–86", "pages 3, 49–54").
//
// Sprint 83E surfaced the message page list + the first
// occurrence's `sourceRef` only — multi-page rollups carried a
// `representativeOnly` notice. Sprint 83F adds full
// per-occurrence drilldown via the new
// `ElectricalDiagnostic.additionalSourceRefs` array: when the
// diagnostic carries one extra `SourceRef` per page beyond the
// representative, we project them into a `perPageEvidence`
// list. Older diagnostics that don't carry the array fall back
// to the Sprint 83E representative-only path verbatim.

import type {
  ElectricalDiagnostic,
  SourceRef,
} from '@plccopilot/electrical-ingest';

import {
  summarizeSourceRef,
  type SourceRefSummary,
} from './review-source-refs.js';

// ---------------------------------------------------------------------------
// Page-phrase parser
// ---------------------------------------------------------------------------

const PAGE_PHRASE_RE =
  /\b(?:page|pages)\s+([0-9]+(?:\s*[–\-]\s*[0-9]+)?(?:\s*,\s*[0-9]+(?:\s*[–\-]\s*[0-9]+)?)*)/i;

function parseRangePart(part: string): number[] {
  const trimmed = part.trim();
  if (trimmed.length === 0) return [];
  const dashMatch = trimmed.match(/^([0-9]+)\s*[–\-]\s*([0-9]+)$/);
  if (dashMatch) {
    const a = Number.parseInt(dashMatch[1], 10);
    const b = Number.parseInt(dashMatch[2], 10);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < 1 ||
      b < 1 ||
      a > b
    ) {
      return [];
    }
    const out: number[] = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  const single = Number.parseInt(trimmed, 10);
  if (Number.isFinite(single) && single >= 1) return [single];
  return [];
}

export interface PdfRollupPages {
  /** Sorted, de-duplicated list of page numbers covered by the rollup. */
  pages: number[];
  /** The original page-phrase substring, e.g. `"pages 80–86"`. */
  humanLabel: string;
}

/**
 * Parse a Sprint 83D rollup diagnostic message and return the
 * page set the rollup covers, plus the human-readable phrase
 * that appeared in the message. Returns `null` when no page
 * phrase is present (defensive — older diagnostics).
 *
 * Recognised shapes:
 *   - `"page 3"` (singular) → `{ pages: [3], humanLabel: 'page 3' }`
 *   - `"pages 80–86"` → `{ pages: [80, …, 86], humanLabel: 'pages 80–86' }`
 *   - `"pages 3, 49–54"` → `{ pages: [3, 49, 50, 51, 52, 53, 54], … }`
 *
 * The en-dash (`U+2013`) and ASCII `-` are both accepted so the
 * helper survives mid-stream unicode normalisation. Pure / total.
 */
export function extractPdfRollupPages(
  message: unknown,
): PdfRollupPages | null {
  if (typeof message !== 'string' || message.length === 0) return null;
  const m = message.match(PAGE_PHRASE_RE);
  if (!m) return null;
  const list = m[1];
  const parts = list.split(',');
  const collected = new Set<number>();
  for (const part of parts) {
    for (const n of parseRangePart(part)) collected.add(n);
  }
  if (collected.size === 0) return null;
  const pages = Array.from(collected).sort((a, b) => a - b);
  const humanLabel = m[0];
  return { pages, humanLabel };
}

// ---------------------------------------------------------------------------
// Diagnostic-evidence summary
// ---------------------------------------------------------------------------

/**
 * Sprint 83F — one entry per page covered by a rollup, when the
 * diagnostic carries `additionalSourceRefs`. The page is the
 * authoritative key (parsed from the SourceRef). Snippet + bbox
 * are projected via the existing `SourceRefSummary` so the
 * UI can re-use the Sprint 82 field rendering verbatim.
 */
export interface PdfPerPageEvidence {
  /** Stable React key for the per-page row. */
  key: string;
  /** 1-based PDF page number this evidence belongs to. */
  page: number;
  /** Sprint 82 field projection (Snippet, Bounding box, Page, Symbol, …). */
  summary: SourceRefSummary;
}

export interface PdfDiagnosticEvidenceSummary {
  /** Stable React key derived from the diagnostic identity. */
  key: string;
  /** Compact label shown when the panel is collapsed. */
  compactLabel: string;
  /** Source-ref projection (Snippet, Bounding box, Page, Symbol, …). */
  representativeSourceRef: SourceRefSummary;
  /** All pages the rollup message names, when present. */
  pages: number[];
  /** Original "page N" / "pages …" phrase from the message, when present. */
  pagesHumanLabel: string;
  /**
   * `true` when the rollup message names more pages than the
   * available SourceRef evidence can drill into. The UI must
   * surface this honestly. Sprint 83F clears this flag when
   * `perPageEvidence` covers every page named in the message.
   */
  representativeOnly: boolean;
  /**
   * Sprint 83F — per-page evidence list. Empty when the
   * diagnostic does not carry `additionalSourceRefs` (older
   * rollups, or single-page diagnostics where only the
   * representative ref exists). Sorted by page ascending.
   */
  perPageEvidence: PdfPerPageEvidence[];
}

/**
 * Project a PDF-source diagnostic into a UI-ready summary that
 * combines the existing Sprint 82 SourceRef fields with the
 * Sprint 83D rollup-message page set. Returns `null` when the
 * diagnostic has no PDF SourceRef — non-PDF diagnostics keep
 * their existing one-liner display.
 *
 * Pure / DOM-free / total.
 */
export function summarizePdfDiagnosticEvidence(
  diag: ElectricalDiagnostic,
): PdfDiagnosticEvidenceSummary | null {
  if (!diag || typeof diag !== 'object') return null;
  const ref = diag.sourceRef;
  if (!ref || ref.kind !== 'pdf') return null;
  const sourceRef = summarizeSourceRef(ref);
  const pageInfo = extractPdfRollupPages(diag.message);
  const refPage = pdfRefPageNumber(ref);
  const pages = pageInfo ? pageInfo.pages : refPage != null ? [refPage] : [];
  const pagesHumanLabel = pageInfo
    ? pageInfo.humanLabel
    : refPage != null
      ? `page ${refPage}`
      : '';

  // Sprint 83F — project per-occurrence evidence from
  // `additionalSourceRefs` when present. The first occurrence
  // stays in `sourceRef`; we prepend it so the per-page list
  // covers every page the rollup represents in one place.
  const perPageEvidence = buildPerPageEvidence(diag, ref, sourceRef);

  // Sprint 83F — clear the rep-only flag when per-page evidence
  // covers every page named in the message (or the message has
  // no phrase and we have at least one piece of evidence). Older
  // diagnostics without `additionalSourceRefs` keep the Sprint
  // 83E rep-only behaviour verbatim.
  const perPagePages = new Set(perPageEvidence.map((e) => e.page));
  const fullCoverage =
    perPageEvidence.length > 0 &&
    (pages.length === 0 || pages.every((p) => perPagePages.has(p)));
  const representativeOnly =
    !fullCoverage &&
    (pages.length > 1 ||
      (pageInfo != null && refPage != null && !pages.includes(refPage)));

  const compactLabel = buildCompactLabel(diag, pages, pagesHumanLabel);
  const key = [
    diag.code,
    sourceRef.key,
    pages.length > 0 ? pages.join(',') : '',
  ].join('|');
  return {
    key,
    compactLabel,
    representativeSourceRef: sourceRef,
    pages,
    pagesHumanLabel,
    representativeOnly,
    perPageEvidence,
  };
}

function buildPerPageEvidence(
  diag: ElectricalDiagnostic,
  representativeRef: SourceRef,
  representativeSummary: SourceRefSummary,
): PdfPerPageEvidence[] {
  const additional = diag.additionalSourceRefs;
  if (!Array.isArray(additional) || additional.length === 0) return [];
  const byPage = new Map<number, PdfPerPageEvidence>();
  const repPage = pdfRefPageNumber(representativeRef);
  if (repPage != null) {
    byPage.set(repPage, {
      key: `pdf-evidence:${representativeSummary.key}:${repPage}`,
      page: repPage,
      summary: representativeSummary,
    });
  }
  for (const ref of additional) {
    if (!ref || typeof ref !== 'object' || ref.kind !== 'pdf') continue;
    const page = pdfRefPageNumber(ref);
    if (page == null) continue;
    if (byPage.has(page)) continue;
    const summary = summarizeSourceRef(ref);
    byPage.set(page, {
      key: `pdf-evidence:${summary.key}:${page}`,
      page,
      summary,
    });
  }
  return Array.from(byPage.values()).sort((a, b) => a.page - b.page);
}

function pdfRefPageNumber(ref: SourceRef): number | null {
  if (typeof ref.page === 'string') {
    const n = Number.parseInt(ref.page, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return null;
}

function buildCompactLabel(
  diag: ElectricalDiagnostic,
  pages: number[],
  pagesHumanLabel: string,
): string {
  const parts: string[] = ['pdf'];
  if (pagesHumanLabel.length > 0) {
    parts.push(pagesHumanLabel);
  } else if (pages.length === 1) {
    parts.push(`page ${pages[0]}`);
  }
  if (typeof diag.sourceRef?.path === 'string' && diag.sourceRef.path.length > 0) {
    parts.push(diag.sourceRef.path);
  }
  if (
    typeof diag.sourceRef?.symbol === 'string' &&
    diag.sourceRef.symbol.length > 0
  ) {
    parts.push(diag.sourceRef.symbol);
  }
  return parts.join(' · ');
}
