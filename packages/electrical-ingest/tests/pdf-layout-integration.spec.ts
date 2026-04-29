// Sprint 84 — integration tests proving the layout helpers
// don't regress the existing PDF detector and that the new
// per-page diagnostics fire end-to-end through `ingestPdf`.

import { describe, expect, it } from 'vitest';

import {
  detectColumnLayout,
  orderBlocksByLayout,
} from '../src/sources/pdf-layout.js';
import {
  detectIoTables,
  type PdfTableDetectorLine,
} from '../src/sources/pdf-table-detect.js';
import type { PdfTextBlock } from '../src/sources/pdf-types.js';
import { ingestPdf } from '../src/sources/pdf.js';

interface BlockOpts {
  id: string;
  text: string;
  page?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

function bboxBlock(opts: BlockOpts): PdfTextBlock {
  const page = opts.page ?? 1;
  return {
    id: opts.id,
    text: opts.text,
    confidence: 0.5,
    sourceRef: {
      sourceId: 's1',
      kind: 'pdf',
      path: 'fixture.pdf',
      page: String(page),
      snippet: opts.text,
      symbol: opts.id,
    },
    bbox: {
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      width: opts.w ?? 100,
      height: opts.h ?? 12,
      unit: 'pt',
    },
  };
}

function detectorLine(
  block: PdfTextBlock,
  pageNumber = 1,
): PdfTableDetectorLine {
  return { block, pageNumber };
}

// =============================================================================
// orderBlocksByLayout + detectIoTables — single-column happy path
// =============================================================================

describe('Sprint 84 — single-column IO list (Sprint 81 baseline preserved)', () => {
  it('1. strict-address single-column fixture still extracts an IO table candidate', () => {
    const blocks = [
      bboxBlock({ id: 'h', text: 'Address Tag Description', x: 50, y: 700, w: 250 }),
      bboxBlock({ id: 'r1', text: 'I0.0 B1 Part present', x: 50, y: 686, w: 250 }),
      bboxBlock({ id: 'r2', text: 'Q0.0 Y1 Cylinder extend', x: 50, y: 672, w: 250 }),
    ];
    const ordered = orderBlocksByLayout(blocks);
    expect(ordered.map((b) => b.id)).toEqual(['h', 'r1', 'r2']);
    const result = detectIoTables({
      sourceId: 's1',
      lines: ordered.map((b) => detectorLine(b, 1)),
    });
    expect(result.tables.length).toBe(1);
    expect(result.tables[0].rows.length).toBe(3);
  });
});

// =============================================================================
// orderBlocksByLayout + detectIoTables — multi-column page
// =============================================================================

describe('Sprint 84 — multi-column page does not interleave columns', () => {
  it('1. left column reads top-to-bottom before right column starts', () => {
    // Left column: header + 2 rows of strict-address IO. Right
    // column: unrelated narrative text. Without column-aware
    // ordering the detector would interleave them by y and the
    // header row would not be followed by IO rows in sequence.
    const left = [
      bboxBlock({ id: 'L0', text: 'Address Tag Description', x: 50, y: 700, w: 200 }),
      bboxBlock({ id: 'L1', text: 'I0.0 B1 Part present', x: 50, y: 686, w: 200 }),
      bboxBlock({ id: 'L2', text: 'Q0.0 Y1 Cylinder extend', x: 50, y: 672, w: 200 }),
    ];
    const right = [
      bboxBlock({ id: 'R0', text: 'Project narrative — overview', x: 350, y: 700, w: 200 }),
      bboxBlock({ id: 'R1', text: 'Notes about the cabinet', x: 350, y: 686, w: 200 }),
      bboxBlock({ id: 'R2', text: 'Designer revision history', x: 350, y: 672, w: 200 }),
    ];
    const blocks = [...left, ...right];
    const layout = detectColumnLayout(blocks);
    expect(layout.multiColumn).toBe(true);
    expect(layout.columns).toHaveLength(2);
    const orderedIds = orderBlocksByLayout(blocks).map((b) => b.id);
    // Left column drained first, top-to-bottom; then right column.
    expect(orderedIds).toEqual(['L0', 'L1', 'L2', 'R0', 'R1', 'R2']);
    const result = detectIoTables({
      sourceId: 's1',
      lines: orderedIds.map((id) =>
        detectorLine(blocks.find((b) => b.id === id)!),
      ),
    });
    expect(result.tables.length).toBe(1);
    expect(result.tables[0].rows.length).toBe(3);
  });
});

// =============================================================================
// False-positive non-IO pages — Sprint 83A/B/C/D safety preserved
// =============================================================================

describe('Sprint 84 — false-positive non-IO regions still produce rollups, not IO', () => {
  it('1. BOM page with bbox geometry still routes to PDF_BOM_TABLE_DETECTED rollup', () => {
    const bomHeader = bboxBlock({
      id: 'h',
      text:
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
      x: 50,
      y: 700,
      w: 500,
    });
    const result = detectIoTables({
      sourceId: 's1',
      lines: [detectorLine(bomHeader, 80)],
    });
    expect(result.tables).toHaveLength(0);
    expect(
      result.diagnostics.some((d) => d.code === 'PDF_BOM_TABLE_DETECTED'),
    ).toBe(true);
    expect(
      result.diagnostics.some((d) => d.code === 'PDF_TABLE_HEADER_DETECTED'),
    ).toBe(false);
  });

  it('2. cable-plan page on multi-column layout still routes to cable rollup', () => {
    const cableHeader = bboxBlock({
      id: 'h',
      text: 'Kabelplan BECKH_P8_Dyn_v3',
      x: 50,
      y: 700,
      w: 500,
    });
    const result = detectIoTables({
      sourceId: 's1',
      lines: [detectorLine(cableHeader, 57)],
    });
    expect(
      result.diagnostics.some((d) => d.code === 'PDF_CABLE_TABLE_DETECTED'),
    ).toBe(true);
  });
});

// =============================================================================
// ingestPdf — multi-column diagnostic firing end-to-end (text-mode no-op)
// =============================================================================

describe('Sprint 84 — ingestPdf preserves Sprint 83 contracts', () => {
  it('1. text-mode (no bboxes) does NOT emit PDF_LAYOUT_MULTI_COLUMN_DETECTED', async () => {
    const r = await ingestPdf({
      sourceId: 'tcecad',
      fileName: 'tcecad.pdf',
      text: [
        '--- page 80 ---',
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
        '--- page 81 ---',
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
      ].join('\n'),
    });
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_LAYOUT_MULTI_COLUMN_DETECTED'),
    ).toBe(false);
    // Sprint 83D/F BOM rollup contract still holds.
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_BOM_TABLE_DETECTED'),
    ).toBe(true);
  });

  it('2. text-mode does NOT emit PDF_LAYOUT_ROTATION_SUSPECTED', async () => {
    const r = await ingestPdf({
      sourceId: 'rot',
      fileName: 'rot.pdf',
      text: [
        '--- page 1 ---',
        'Address Tag Description',
        'I0.0 B1 Part present',
        'Q0.0 Y1 Cylinder extend',
      ].join('\n'),
    });
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_LAYOUT_ROTATION_SUSPECTED'),
    ).toBe(false);
    // Sprint 81 strict-address path still produces 2 IO channels.
    expect(
      r.graph.nodes.filter((n) => n.kind === 'plc_channel').length,
    ).toBe(2);
  });
});
