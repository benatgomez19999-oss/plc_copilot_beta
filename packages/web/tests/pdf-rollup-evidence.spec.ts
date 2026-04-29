// Sprint 83E — pure tests for the PDF source-evidence helpers
// (`extractPdfRollupPages` + `summarizePdfDiagnosticEvidence`).
//
// The component layer is a thin renderer of these summaries; the
// behaviour the operator depends on lives in the helpers.

import { describe, expect, it } from 'vitest';

import {
  extractPdfRollupPages,
  summarizePdfDiagnosticEvidence,
} from '../src/utils/pdf-rollup-evidence.js';
import type {
  ElectricalDiagnostic,
  ElectricalDiagnosticCode,
  SourceRef,
} from '@plccopilot/electrical-ingest';

const PDF_REF: SourceRef = {
  sourceId: 'tcecad',
  kind: 'pdf',
  path: 'TcECAD_Import_V2_2_x.pdf',
  page: '80',
  line: 1,
  snippet: 'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
  symbol: 'pdf:p80:line:1',
  bbox: { x: 12.0, y: 540.5, width: 480.0, height: 16.0, unit: 'pt' },
};

const CSV_REF: SourceRef = {
  sourceId: 'src-csv',
  kind: 'csv',
  path: 'list.csv',
  line: 5,
};

function pdfDiag(
  message: string,
  ref: SourceRef = PDF_REF,
  code: ElectricalDiagnosticCode = 'PDF_BOM_TABLE_DETECTED',
): ElectricalDiagnostic {
  return {
    code,
    severity: 'info',
    message,
    sourceRef: ref,
  };
}

// =============================================================================
// extractPdfRollupPages
// =============================================================================

describe('extractPdfRollupPages (Sprint 83E)', () => {
  it('1. parses a singular "page N" phrase', () => {
    expect(
      extractPdfRollupPages(
        'Ignored contents/index sections on page 3. These are not IO lists.',
      ),
    ).toEqual({ pages: [3], humanLabel: 'page 3' });
  });

  it('2. parses a "pages X–Y" en-dash range', () => {
    const r = extractPdfRollupPages(
      'Ignored BOM / parts-list sections on pages 80–86. First evidence: …',
    );
    expect(r?.pages).toEqual([80, 81, 82, 83, 84, 85, 86]);
    expect(r?.humanLabel).toBe('pages 80–86');
  });

  it('3. parses a mixed singletons + ranges phrase', () => {
    const r = extractPdfRollupPages(
      'Ignored terminal-list sections on pages 3, 49–54. These are not IO lists.',
    );
    expect(r?.pages).toEqual([3, 49, 50, 51, 52, 53, 54]);
    expect(r?.humanLabel).toBe('pages 3, 49–54');
  });

  it('4. accepts an ASCII hyphen as the range separator', () => {
    const r = extractPdfRollupPages('Ignored cable-list sections on pages 5-7.');
    expect(r?.pages).toEqual([5, 6, 7]);
  });

  it('5. dedupes overlapping ranges', () => {
    const r = extractPdfRollupPages(
      'Ignored legend sections on pages 5, 5–7, 7. First evidence: …',
    );
    expect(r?.pages).toEqual([5, 6, 7]);
  });

  it('6. returns null when no page phrase is present', () => {
    expect(extractPdfRollupPages('Some unrelated diagnostic text')).toBeNull();
    expect(extractPdfRollupPages('')).toBeNull();
    expect(extractPdfRollupPages(undefined)).toBeNull();
  });

  it('7. rejects degenerate ranges (Y < X) without throwing', () => {
    expect(extractPdfRollupPages('Ignored sections on pages 9–2.')).toBeNull();
  });
});

// =============================================================================
// summarizePdfDiagnosticEvidence
// =============================================================================

describe('summarizePdfDiagnosticEvidence (Sprint 83E)', () => {
  it('1. returns null for a non-PDF diagnostic (CSV / EPLAN flow unaffected)', () => {
    expect(
      summarizePdfDiagnosticEvidence({
        code: 'CSV_EMPTY_INPUT',
        severity: 'info',
        message: 'whatever',
        sourceRef: CSV_REF,
      }),
    ).toBeNull();
  });

  it('2. returns null for a PDF diagnostic without sourceRef', () => {
    expect(
      summarizePdfDiagnosticEvidence({
        code: 'PDF_BOM_TABLE_DETECTED',
        severity: 'info',
        message: 'no ref attached',
      }),
    ).toBeNull();
  });

  it('3. surfaces the SourceRef projection (Snippet + Bounding box + Page)', () => {
    const s = summarizePdfDiagnosticEvidence(
      pdfDiag(
        'Ignored BOM / parts-list sections on pages 80–86. First evidence: "x" (bom_parts_list).',
      ),
    );
    expect(s).not.toBeNull();
    const labels = s!.representativeSourceRef.fields.map((f) => f.label);
    expect(labels).toContain('Snippet');
    expect(labels).toContain('Bounding box');
    expect(labels).toContain('Page');
  });

  it('4. flags representativeOnly=true when message names more pages than the ref (Sprint 83E fallback)', () => {
    const s = summarizePdfDiagnosticEvidence(
      pdfDiag('Ignored BOM / parts-list sections on pages 80–86. …'),
    );
    expect(s?.representativeOnly).toBe(true);
    expect(s?.pages).toEqual([80, 81, 82, 83, 84, 85, 86]);
    expect(s?.pagesHumanLabel).toBe('pages 80–86');
    expect(s?.perPageEvidence).toEqual([]);
  });

  it('5. flags representativeOnly=false for a single-page rollup', () => {
    const ref: SourceRef = { ...PDF_REF, page: '3' };
    const s = summarizePdfDiagnosticEvidence(
      pdfDiag(
        'Ignored contents/index sections on page 3. First evidence: "x" (contents_index).',
        ref,
        'PDF_CONTENTS_TABLE_IGNORED',
      ),
    );
    expect(s?.representativeOnly).toBe(false);
    expect(s?.pages).toEqual([3]);
    expect(s?.pagesHumanLabel).toBe('page 3');
  });

  it('6. falls back to the ref page when the message has no page phrase', () => {
    const s = summarizePdfDiagnosticEvidence(
      pdfDiag('No page phrase in this message'),
    );
    expect(s?.representativeOnly).toBe(false);
    expect(s?.pages).toEqual([80]);
    expect(s?.pagesHumanLabel).toBe('page 80');
  });

  it('7. compactLabel includes the page phrase + path + symbol for quick scanning', () => {
    const s = summarizePdfDiagnosticEvidence(
      pdfDiag(
        'Ignored BOM / parts-list sections on pages 80–86. First evidence: "x" (bom_parts_list).',
      ),
    );
    expect(s?.compactLabel).toContain('pages 80–86');
    expect(s?.compactLabel).toContain('TcECAD_Import_V2_2_x.pdf');
    expect(s?.compactLabel).toContain('pdf:p80:line:1');
  });

  it('8. produces a stable React key derived from code + ref + pages', () => {
    const a = summarizePdfDiagnosticEvidence(
      pdfDiag('Ignored BOM / parts-list sections on pages 80–86. …'),
    );
    const b = summarizePdfDiagnosticEvidence(
      pdfDiag('Ignored BOM / parts-list sections on pages 80–86. …'),
    );
    expect(a?.key).toBe(b?.key);
  });
});

// =============================================================================
// Sprint 83F — full per-occurrence drilldown
// =============================================================================

function pdfRefForPage(page: number, blockIndex = 1): SourceRef {
  return {
    sourceId: 'tcecad',
    kind: 'pdf',
    path: 'TcECAD_Import_V2_2_x.pdf',
    page: String(page),
    line: blockIndex,
    snippet: `BOM evidence on page ${page}`,
    symbol: `pdf:p${page}:line:${blockIndex}`,
    bbox: { x: 12.0, y: 540.5, width: 480.0, height: 16.0, unit: 'pt' },
  };
}

describe('summarizePdfDiagnosticEvidence — Sprint 83F per-page evidence', () => {
  it('1. clears representativeOnly when additionalSourceRefs cover every named page', () => {
    const ref = pdfRefForPage(80);
    const additional = [pdfRefForPage(81), pdfRefForPage(82)];
    const s = summarizePdfDiagnosticEvidence({
      code: 'PDF_BOM_TABLE_DETECTED',
      severity: 'info',
      message: 'Ignored BOM / parts-list sections on pages 80–82. …',
      sourceRef: ref,
      additionalSourceRefs: additional,
    });
    expect(s?.representativeOnly).toBe(false);
    expect(s?.perPageEvidence.map((e) => e.page)).toEqual([80, 81, 82]);
  });

  it('2. keeps representativeOnly when coverage is incomplete (older diagnostics fallback path)', () => {
    const s = summarizePdfDiagnosticEvidence({
      code: 'PDF_BOM_TABLE_DETECTED',
      severity: 'info',
      message: 'Ignored BOM / parts-list sections on pages 80–82. …',
      sourceRef: pdfRefForPage(80),
      additionalSourceRefs: [pdfRefForPage(81)],
    });
    expect(s?.representativeOnly).toBe(true);
    expect(s?.perPageEvidence.map((e) => e.page)).toEqual([80, 81]);
  });

  it('3. dedupes repeated pages in additionalSourceRefs', () => {
    const s = summarizePdfDiagnosticEvidence({
      code: 'PDF_BOM_TABLE_DETECTED',
      severity: 'info',
      message: 'Ignored BOM / parts-list sections on pages 80–81. …',
      sourceRef: pdfRefForPage(80),
      additionalSourceRefs: [
        pdfRefForPage(80, 2),
        pdfRefForPage(81),
        pdfRefForPage(81, 2),
      ],
    });
    expect(s?.perPageEvidence.map((e) => e.page)).toEqual([80, 81]);
  });

  it('4. drops non-PDF refs in additionalSourceRefs defensively', () => {
    const csv: SourceRef = { ...CSV_REF };
    const s = summarizePdfDiagnosticEvidence({
      code: 'PDF_BOM_TABLE_DETECTED',
      severity: 'info',
      message: 'Ignored BOM / parts-list sections on pages 80–81. …',
      sourceRef: pdfRefForPage(80),
      additionalSourceRefs: [csv, pdfRefForPage(81)],
    });
    expect(s?.perPageEvidence.map((e) => e.page)).toEqual([80, 81]);
  });

  it('5. produces empty perPageEvidence when additionalSourceRefs is missing (Sprint 83E behaviour preserved)', () => {
    const s = summarizePdfDiagnosticEvidence(
      pdfDiag('Ignored BOM / parts-list sections on pages 80–86. …'),
    );
    expect(s?.perPageEvidence).toEqual([]);
    expect(s?.representativeOnly).toBe(true);
  });

  it('6. each per-page entry exposes the Sprint 82 SourceRefSummary fields', () => {
    const s = summarizePdfDiagnosticEvidence({
      code: 'PDF_BOM_TABLE_DETECTED',
      severity: 'info',
      message: 'Ignored BOM / parts-list sections on pages 80–81. …',
      sourceRef: pdfRefForPage(80),
      additionalSourceRefs: [pdfRefForPage(81)],
    });
    const labels = s!.perPageEvidence[1].summary.fields.map((f) => f.label);
    expect(labels).toContain('Snippet');
    expect(labels).toContain('Bounding box');
    expect(labels).toContain('Page');
  });
});
