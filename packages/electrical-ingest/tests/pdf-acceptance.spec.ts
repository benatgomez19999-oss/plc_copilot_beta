// Sprint 81 — manual PDF acceptance harness, dressed as a vitest
// spec so it runs through the existing TS-aware test runner with
// no extra tooling.
//
// The four cases below mirror the manual-acceptance plan in
// `docs/pdf-manual-acceptance-sprint-81.md`. Each case ingests a
// representative deterministic PDF and asserts the high-level
// outcome (number of tables, number of channels, presence of
// specific diagnostic codes). The detailed per-case summary the
// closeout doc references is captured by reading the same test
// output (no console noise — the vitest runner swallows
// `console.log` unless `--reporter=verbose` is set, so we use
// `expect`-style structural assertions instead).

import { describe, expect, it } from 'vitest';

import { ingestPdf } from '../src/sources/pdf.js';
import {
  buildMinimalPdfFixture,
  buildTabularPdfFixture,
} from './fixtures/pdf/build-fixture.js';

function diagnosticCodes(diagnostics: Array<{ code: string }>): Set<string> {
  return new Set(diagnostics.map((d) => d.code));
}

function channelCount(graph: { nodes: Array<{ id: string }> }): number {
  return graph.nodes.filter((n) => n.id.startsWith('plc_channel:')).length;
}

// ---------------------------------------------------------------------------
// Case A — Tabular IO list (Address / Tag / Description)
// ---------------------------------------------------------------------------

describe('manual acceptance — Case A: tabular IO list', () => {
  it('extracts a table + 4 IO channels + raises PDF_TABLE_HEADER_DETECTED', async () => {
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
              y: 682,
              cells: [
                { text: 'I0.1', x: 50 },
                { text: 'B2', x: 150 },
                { text: 'Part absent', x: 220 },
              ],
            },
            {
              y: 664,
              cells: [
                { text: 'Q0.0', x: 50 },
                { text: 'Y1', x: 150 },
                { text: 'Cylinder extend', x: 220 },
              ],
            },
            {
              y: 646,
              cells: [
                { text: 'Q0.1', x: 50 },
                { text: 'M1', x: 150 },
                { text: 'Conveyor motor', x: 220 },
              ],
            },
          ],
        },
      ],
    });
    const r = await ingestPdf({
      sourceId: 'acceptance-A',
      fileName: 'A-io-table.pdf',
      bytes,
    });
    expect(r.graph.sourceKind).toBe('pdf');
    expect(channelCount(r.graph)).toBe(4);
    const tables = r.document.pages[0].tableCandidates;
    expect(tables.length).toBe(1);
    // header + 4 data rows
    expect(tables[0].rows.length).toBe(5);
    const codes = diagnosticCodes(r.diagnostics);
    expect(codes.has('PDF_TABLE_HEADER_DETECTED')).toBe(true);
    expect(codes.has('PDF_TABLE_CANDIDATE_DETECTED')).toBe(true);
    expect(codes.has('PDF_TEXT_LAYER_EXTRACTED')).toBe(true);
    expect(codes.has('PDF_MANUAL_REVIEW_REQUIRED')).toBe(true);
    // Sprint 79 stub codes must NOT appear on a real text-layer PDF.
    expect(codes.has('PDF_UNSUPPORTED_BINARY_PARSER')).toBe(false);
    expect(codes.has('PDF_TEXT_LAYER_UNAVAILABLE')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case B — Tag-first IO list with explicit Direction column
// ---------------------------------------------------------------------------

describe('manual acceptance — Case B: tag-first + direction column', () => {
  it('extracts the table + 2 channels + uses the address direction (no conflict)', async () => {
    const bytes = buildTabularPdfFixture({
      pages: [
        {
          rows: [
            {
              y: 720,
              cells: [
                { text: 'Tag', x: 50 },
                { text: 'Address', x: 130 },
                { text: 'Direction', x: 220 },
                { text: 'Description', x: 320 },
              ],
            },
            {
              y: 700,
              cells: [
                { text: 'B1', x: 50 },
                { text: 'I0.0', x: 130 },
                { text: 'input', x: 220 },
                { text: 'Lichttaster', x: 320 },
              ],
            },
            {
              y: 682,
              cells: [
                { text: 'Y1', x: 50 },
                { text: 'Q0.0', x: 130 },
                { text: 'output', x: 220 },
                { text: 'Magnetventil', x: 320 },
              ],
            },
          ],
        },
      ],
    });
    const r = await ingestPdf({
      sourceId: 'acceptance-B',
      fileName: 'B-tag-first.pdf',
      bytes,
    });
    expect(channelCount(r.graph)).toBe(2);
    const tables = r.document.pages[0].tableCandidates;
    expect(tables.length).toBe(1);
    expect(tables[0].headerLayout?.columns.map((c) => c.role)).toContain(
      'direction',
    );
    const codes = diagnosticCodes(r.diagnostics);
    expect(codes.has('PDF_IO_ROW_EXTRACTED')).toBe(true);
    // No conflict: B1+input matches I-address direction.
    expect(codes.has('PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case C — Selectable-text PDF with no IO rows (narrative)
// ---------------------------------------------------------------------------

describe('manual acceptance — Case C: narrative (no IO rows)', () => {
  it('extracts text blocks but produces no IO candidates and no false positives', async () => {
    const bytes = buildMinimalPdfFixture({
      pages: [
        [
          'This document is a narrative description of the cell layout.',
          'It has no IO list inside it; the next page may carry one.',
          'Sprint 81 must not invent IO from narrative text.',
        ].join('\n'),
      ],
    });
    const r = await ingestPdf({
      sourceId: 'acceptance-C',
      fileName: 'C-narrative.pdf',
      bytes,
    });
    expect(r.graph.nodes).toEqual([]);
    expect(r.graph.edges).toEqual([]);
    expect(r.document.pages[0].textBlocks.length).toBeGreaterThan(0);
    const codes = diagnosticCodes(r.diagnostics);
    expect(codes.has('PDF_TEXT_LAYER_EXTRACTED')).toBe(true);
    expect(codes.has('PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED')).toBe(true);
    expect(codes.has('PDF_MANUAL_REVIEW_REQUIRED')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case D — Malformed bytes (not a PDF)
// ---------------------------------------------------------------------------

describe('manual acceptance — Case D: malformed bytes', () => {
  it('emits PDF_MALFORMED and produces an empty graph', async () => {
    const r = await ingestPdf({
      sourceId: 'acceptance-D',
      fileName: 'D-malformed.pdf',
      bytes: new TextEncoder().encode('this is not a PDF file'),
    });
    expect(r.graph.nodes).toEqual([]);
    const codes = diagnosticCodes(r.diagnostics);
    expect(codes.has('PDF_MALFORMED')).toBe(true);
    expect(codes.has('PDF_TEXT_LAYER_EXTRACTED')).toBe(false);
  });
});
