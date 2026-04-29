// Sprint 81 — table-detector + improved IO-row extractor tests.
// Two surfaces:
//
//   1. `detectIoTableHeader` (header keyword classifier on a line).
//   2. `detectIoTables` (per-page assembler over a list of lines).
//   3. `looksLikeIoRow` (predicate over a single line text).
//
// The end-to-end "ingest a real tabular PDF" tests live below, in
// the third describe block, and use the new
// `buildTabularPdfFixture` helper to put labelled cells at exact
// (x, y) positions.

import { describe, expect, it } from 'vitest';

import {
  detectIoTableHeader,
  detectIoTables,
  looksLikeIoRow,
} from '../src/sources/pdf-table-detect.js';
import type { PdfTableDetectorLine } from '../src/sources/pdf-table-detect.js';
import type { PdfTextBlock } from '../src/sources/pdf-types.js';
import { ingestPdf } from '../src/sources/pdf.js';
import { buildTabularPdfFixture } from './fixtures/pdf/build-fixture.js';

function block(text: string, page = 1, blockIndex = 1): PdfTextBlock {
  return {
    id: `pdf:s1:p${page}:b${blockIndex}`,
    text,
    confidence: 0.5,
    sourceRef: {
      sourceId: 's1',
      kind: 'pdf',
      path: 'plan.pdf',
      page: String(page),
      line: blockIndex,
      snippet: text,
      symbol: `pdf:page:${page}/line:${blockIndex}`,
    },
  };
}

function line(
  text: string,
  page = 1,
  blockIndex = 1,
  items?: Array<{ text: string; x: number; width: number }>,
): PdfTableDetectorLine {
  return { block: block(text, page, blockIndex), items, pageNumber: page };
}

// =============================================================================
// detectIoTableHeader — keyword classifier
// =============================================================================

describe('detectIoTableHeader', () => {
  it('1. returns null for empty / non-string input', () => {
    expect(detectIoTableHeader({ text: '' })).toBeNull();
    // @ts-expect-error
    expect(detectIoTableHeader({ text: null })).toBeNull();
    // @ts-expect-error
    expect(detectIoTableHeader(null)).toBeNull();
  });

  it('2. recognises Address + Tag + Description with whitespace splits', () => {
    const h = detectIoTableHeader({ text: 'Address  Tag  Description' });
    expect(h).not.toBeNull();
    if (!h) return;
    const roles = h.columns.map((c) => c.role);
    expect(roles).toContain('address');
    expect(roles).toContain('tag');
    expect(roles).toContain('description');
  });

  it('3. recognises Tag + Address + Direction + Description', () => {
    const h = detectIoTableHeader({
      text: 'Tag  Address  Direction  Description',
    });
    expect(h).not.toBeNull();
    if (!h) return;
    const roles = h.columns.map((c) => c.role);
    expect(roles).toEqual(['tag', 'address', 'direction', 'description']);
  });

  it('4. recognises German E/A + BMK + Bezeichnung', () => {
    const h = detectIoTableHeader({ text: 'E/A  BMK  Bezeichnung' });
    expect(h).not.toBeNull();
    if (!h) return;
    const roles = h.columns.map((c) => c.role);
    expect(roles).toContain('address');
    expect(roles).toContain('tag');
    expect(roles).toContain('description');
  });

  it('5. requires an address OR tag column — refuses Description-only headers', () => {
    expect(
      detectIoTableHeader({ text: 'Description  Comment  Channel' }),
    ).toBeNull();
  });

  it('6. requires at least 2 known keywords (single-keyword false-positives blocked)', () => {
    expect(detectIoTableHeader({ text: 'Just an address line' })).toBeNull();
  });

  it('7. preserves x-positions when items geometry is supplied', () => {
    const h = detectIoTableHeader({
      text: 'Address Tag Description',
      items: [
        { text: 'Address', x: 50, width: 50 },
        { text: 'Tag', x: 150, width: 30 },
        { text: 'Description', x: 220, width: 80 },
      ],
    });
    expect(h).not.toBeNull();
    if (!h) return;
    expect(h.columns[0].xMin).toBe(50);
    expect(h.columns[1].xMin).toBe(150);
    expect(h.columns[2].xMin).toBe(220);
  });

  it('8. ignores tokens that do not classify as known keywords', () => {
    const h = detectIoTableHeader({ text: 'Address  Tag  Stuff  Description' });
    expect(h).not.toBeNull();
    if (!h) return;
    const labels = h.columns.map((c) => c.headerLabel);
    expect(labels).not.toContain('Stuff');
  });
});

// =============================================================================
// looksLikeIoRow — multi-pattern predicate
// =============================================================================

describe('looksLikeIoRow', () => {
  it('1. recognises address-first row', () => {
    expect(looksLikeIoRow('I0.0 B1 Part present')).toBe(true);
    expect(looksLikeIoRow('Q0.1 M1 Conveyor motor')).toBe(true);
  });

  it('2. recognises tag-first row', () => {
    expect(looksLikeIoRow('B1 I0.0 Part present')).toBe(true);
    expect(looksLikeIoRow('Y1 Q0.0 Cylinder extend')).toBe(true);
  });

  it('3. recognises tag + direction-word + address row', () => {
    expect(looksLikeIoRow('B1 input I0.0 Part present')).toBe(true);
    expect(looksLikeIoRow('Y1 output Q0.0 Cylinder extend')).toBe(true);
    expect(looksLikeIoRow('B1 eingang I0.0 Lichttaster')).toBe(true);
  });

  it('4. rejects clearly non-IO lines', () => {
    expect(looksLikeIoRow('this is just text')).toBe(false);
    expect(looksLikeIoRow('Description Comment')).toBe(false);
    expect(looksLikeIoRow('')).toBe(false);
  });

  it('5. rejects tag-only and address-only lines', () => {
    expect(looksLikeIoRow('B1')).toBe(false);
    expect(looksLikeIoRow('I0.0')).toBe(false);
  });
});

// =============================================================================
// detectIoTables — per-page assembler
// =============================================================================

describe('detectIoTables', () => {
  it('1. empty / null input returns no tables', () => {
    expect(detectIoTables({ lines: [], sourceId: 's1' }).tables).toEqual([]);
    // @ts-expect-error
    expect(detectIoTables({ lines: null, sourceId: 's1' }).tables).toEqual([]);
  });

  it('2. assembles a single header + 2 data rows into one PdfTableCandidate', () => {
    const result = detectIoTables({
      sourceId: 's1',
      fileName: 'plan.pdf',
      lines: [
        line('Address Tag Description', 1, 1),
        line('I0.0 B1 Part present', 1, 2),
        line('Q0.0 Y1 Cylinder extend', 1, 3),
        line('unrelated text', 1, 4),
      ],
    });
    expect(result.tables.length).toBe(1);
    const t = result.tables[0];
    expect(t.rows.length).toBe(3);
    expect(t.rows[0].kind).toBe('header');
    expect(t.rows[1].kind).toBe('data');
    expect(t.rows[2].kind).toBe('data');
    expect(t.headerLayout).toBeDefined();
    expect(t.headerLayout?.columns.map((c) => c.role)).toContain('address');
  });

  it('3. preserves the header line bbox / sourceRef / page', () => {
    const result = detectIoTables({
      sourceId: 's1',
      fileName: 'plan.pdf',
      lines: [
        line('Address Tag Description', 7, 1),
        line('I0.0 B1 Part present', 7, 2),
      ],
    });
    expect(result.tables[0].pageNumber).toBe(7);
    expect(result.tables[0].sourceRef.kind).toBe('pdf');
    expect(result.tables[0].sourceRef.page).toBe('7');
    expect(result.tables[0].sourceRef.path).toBe('plan.pdf');
  });

  it('4. emits PDF_TABLE_HEADER_DETECTED + PDF_TABLE_CANDIDATE_DETECTED + PDF_TABLE_ROW_EXTRACTED', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Address Tag Description', 1, 1),
        line('I0.0 B1 Part present', 1, 2),
        line('Q0.0 Y1 Cylinder extend', 1, 3),
      ],
    });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_TABLE_HEADER_DETECTED');
    expect(codes).toContain('PDF_TABLE_CANDIDATE_DETECTED');
    expect(codes.filter((c) => c === 'PDF_TABLE_ROW_EXTRACTED').length).toBe(2);
  });

  it('5. lone header (no data rows) emits header-detected but creates no table', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Address Tag Description', 1, 1),
        line('unrelated paragraph text', 1, 2),
      ],
    });
    expect(result.tables).toEqual([]);
    expect(
      result.diagnostics.some((d) => d.code === 'PDF_TABLE_HEADER_DETECTED'),
    ).toBe(true);
  });

  it('6. consumed block ids include header + every data row', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Address Tag Description', 1, 1),
        line('I0.0 B1 Part present', 1, 2),
        line('Q0.0 Y1 Cylinder extend', 1, 3),
      ],
    });
    expect(result.consumedBlockIds.size).toBe(3);
    expect(result.consumedBlockIds.has('pdf:s1:p1:b1')).toBe(true);
    expect(result.consumedBlockIds.has('pdf:s1:p1:b2')).toBe(true);
    expect(result.consumedBlockIds.has('pdf:s1:p1:b3')).toBe(true);
  });

  it('7. multiple tables on the same page get distinct ids', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Address Tag Description', 1, 1),
        line('I0.0 B1 Part present', 1, 2),
        line('section break text', 1, 3),
        line('Tag Address Direction', 1, 4),
        line('Y1 Q0.0 output Cylinder extend', 1, 5),
      ],
    });
    expect(result.tables.length).toBe(2);
    expect(result.tables[0].id).not.toBe(result.tables[1].id);
  });

  it('8. row sourceRef carries the row line snippet', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Address Tag Description', 1, 1),
        line('I0.0 B1 Part present', 1, 2),
      ],
    });
    const row = result.tables[0].rows[1];
    expect(row.sourceRef?.snippet).toBe('I0.0 B1 Part present');
    expect(row.rawText).toBe('I0.0 B1 Part present');
  });
});

// =============================================================================
// ingestPdf — Sprint 81 IO row variants (text-mode)
// =============================================================================

describe('ingestPdf — Sprint 81 IO row variants (text-mode)', () => {
  it('1. extracts an address-first row (Sprint 79 baseline)', async () => {
    const r = await ingestPdf({
      sourceId: 's',
      fileName: 'plan.pdf',
      text: 'I0.0 B1 Part present',
    });
    expect(r.graph.nodes.length).toBeGreaterThan(0);
  });

  it('2. extracts a tag-first row', async () => {
    const r = await ingestPdf({
      sourceId: 's',
      fileName: 'plan.pdf',
      text: 'B1 I0.0 Part present',
    });
    expect(r.graph.nodes.length).toBeGreaterThan(0);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_IO_ROW_EXTRACTED');
  });

  it('3. extracts a tag + direction-word + address row', async () => {
    const r = await ingestPdf({
      sourceId: 's',
      fileName: 'plan.pdf',
      text: 'B1 input I0.0 Part present',
    });
    expect(r.graph.nodes.length).toBeGreaterThan(0);
  });

  it('4. extracts a tag + Eingang + address row (German)', async () => {
    const r = await ingestPdf({
      sourceId: 's',
      fileName: 'plan.pdf',
      text: 'B1 eingang I0.0 Lichttaster',
    });
    expect(r.graph.nodes.length).toBeGreaterThan(0);
  });

  it('5. address-direction conflict emits PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT (warning, address wins)', async () => {
    const r = await ingestPdf({
      sourceId: 's',
      fileName: 'plan.pdf',
      text: 'B1 output I0.0 Mislabeled',
    });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT');
    // Address direction wins: %I → input.
    const channel = r.graph.nodes.find((n) => n.kind === 'plc_channel');
    expect(channel?.attributes.direction).toBe('input');
  });

  it('6. confidence remains capped at 0.65', async () => {
    const r = await ingestPdf({
      sourceId: 's',
      fileName: 'plan.pdf',
      text: 'B1 input I0.0 Part present sensor',
    });
    for (const n of r.graph.nodes) {
      expect(n.confidence.score).toBeLessThanOrEqual(0.65);
    }
  });

  it('7. emits PDF_MANUAL_REVIEW_REQUIRED (info) when rows extracted', async () => {
    const r = await ingestPdf({
      sourceId: 's',
      fileName: 'plan.pdf',
      text: 'I0.0 B1 Part present\nQ0.0 Y1 Cylinder extend',
    });
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_MANUAL_REVIEW_REQUIRED'),
    ).toBe(true);
  });

  it('8. text-mode also runs table detection and surfaces table candidates on the page', async () => {
    const r = await ingestPdf({
      sourceId: 's',
      fileName: 'plan.pdf',
      text: 'Address Tag Description\nI0.0 B1 Part present\nQ0.0 Y1 Cylinder extend',
    });
    const tables = r.document.pages[0].tableCandidates;
    expect(tables.length).toBe(1);
    expect(tables[0].rows[0].kind).toBe('header');
    expect(tables[0].rows.length).toBe(3);
  });
});

// =============================================================================
// ingestPdf — Sprint 81 end-to-end with a tabular real-bytes PDF
// =============================================================================

describe('ingestPdf — Sprint 81 end-to-end with a tabular real-bytes PDF', () => {
  it('1. detects the IO-list table from a column-aligned PDF and extracts data rows', async () => {
    const bytes = buildTabularPdfFixture({
      pages: [
        {
          rows: [
            {
              y: 720,
              cells: [
                { text: 'Address', x: 50 },
                { text: 'Tag', x: 150 },
                { text: 'Description', x: 220 },
              ],
            },
            {
              y: 700,
              cells: [
                { text: 'I0.0', x: 50 },
                { text: 'B1', x: 150 },
                { text: 'Part present', x: 220 },
              ],
            },
            {
              y: 680,
              cells: [
                { text: 'Q0.0', x: 50 },
                { text: 'Y1', x: 150 },
                { text: 'Cylinder extend', x: 220 },
              ],
            },
          ],
        },
      ],
    });
    const r = await ingestPdf({
      sourceId: 'plan-1',
      fileName: 'plan.pdf',
      bytes,
    });
    const tables = r.document.pages[0].tableCandidates;
    expect(tables.length).toBe(1);
    expect(tables[0].headerLayout?.columns.map((c) => c.role)).toContain(
      'address',
    );
    expect(tables[0].rows.length).toBe(3); // 1 header + 2 data
    expect(r.graph.nodes.length).toBeGreaterThan(0);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_TABLE_HEADER_DETECTED');
    expect(codes).toContain('PDF_TABLE_CANDIDATE_DETECTED');
    expect(codes).toContain('PDF_MANUAL_REVIEW_REQUIRED');
  });

  it('2. tabular PDF preserves bbox in the header layout (x-positions seeded from real items)', async () => {
    const bytes = buildTabularPdfFixture({
      pages: [
        {
          rows: [
            {
              y: 720,
              cells: [
                { text: 'Address', x: 50 },
                { text: 'Tag', x: 150 },
                { text: 'Description', x: 220 },
              ],
            },
            {
              y: 700,
              cells: [
                { text: 'I0.0', x: 50 },
                { text: 'B1', x: 150 },
                { text: 'Part present', x: 220 },
              ],
            },
          ],
        },
      ],
    });
    const r = await ingestPdf({
      sourceId: 'plan-1',
      fileName: 'plan.pdf',
      bytes,
    });
    const cols = r.document.pages[0].tableCandidates[0]?.headerLayout?.columns ?? [];
    expect(cols.length).toBeGreaterThanOrEqual(2);
    // Real x positions — anchored at 50 / 150 / 220 in the fixture.
    const addressCol = cols.find((c) => c.role === 'address');
    expect(addressCol?.xMin).toBe(50);
  });

  it('3. row sourceRef.bbox carries unit pt (real text-layer geometry)', async () => {
    const bytes = buildTabularPdfFixture({
      pages: [
        {
          rows: [
            {
              y: 720,
              cells: [
                { text: 'Address', x: 50 },
                { text: 'Tag', x: 150 },
              ],
            },
            {
              y: 700,
              cells: [
                { text: 'I0.0', x: 50 },
                { text: 'B1', x: 150 },
              ],
            },
          ],
        },
      ],
    });
    const r = await ingestPdf({
      sourceId: 'plan-1',
      fileName: 'plan.pdf',
      bytes,
    });
    const row = r.document.pages[0].tableCandidates[0]?.rows[1];
    expect(row?.sourceRef?.bbox?.unit).toBe('pt');
  });
});
