// Sprint 83E — PDF source-evidence helpers for the review UI.
//
// Pure / DOM-free / total. The Sprint 83D rollup diagnostic
// message carries a compressed page phrase ("page 3", "pages
// 80–86", "pages 3, 49–54"); the diagnostic's `sourceRef` only
// points at the *representative* (first) page where the
// canonical role appeared. To render an honest drilldown, the
// UI needs:
//
//   1. The full page set from the message text, so the operator
//      sees every page the rollup covered.
//   2. A flag indicating that the source evidence is *only*
//      representative — clicking through opens the first page,
//      not all of them.
//
// Both pieces are derived here so the component can stay a thin
// renderer.

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
   * single representative SourceRef. The UI must surface this
   * honestly — clicking through only opens the first page.
   */
  representativeOnly: boolean;
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
  // Representative-only when more pages are named in the message
  // than the representative ref points at, OR when the message
  // has no page phrase but the ref carries a single page (i.e.
  // an older diagnostic surfaced via the rollup channel).
  const representativeOnly =
    pages.length > 1 ||
    (pageInfo != null && refPage != null && !pages.includes(refPage));
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
  };
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
