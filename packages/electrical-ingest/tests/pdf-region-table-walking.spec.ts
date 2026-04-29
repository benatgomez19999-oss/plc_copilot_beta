// Sprint 84.1 — region-aware table walking. The Sprint 84
// `clusterBlocksIntoRegions` helper is now wired into `pdf.ts`,
// and `detectIoTables` honors a per-line `regionId` barrier so
// a header in region A cannot absorb data rows in region B.
//
// These tests exercise `detectIoTables` directly with explicit
// `regionId`s to keep the contract precise and decoupled from
// the page-level clustering heuristics.

import { describe, expect, it } from 'vitest';

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
  regionId?: string,
): PdfTableDetectorLine {
  const line: PdfTableDetectorLine = { block, pageNumber };
  if (regionId) line.regionId = regionId;
  return line;
}

// =============================================================================
// Header in region A must not absorb data rows in region B
// =============================================================================

describe('detectIoTables — Sprint 84.1 region barrier', () => {
  it('1. table region followed by footer region — only table rows extract', () => {
    // Region A: header + 2 IO rows. Region B: footer-shaped line
    // that LOOKS like an IO row by accident (`I0.0 timestamp ...`)
    // — without the region barrier the walk would absorb it.
    const lines: PdfTableDetectorLine[] = [
      detectorLine(
        bboxBlock({ id: 'h', text: 'Address Tag Description', y: 700 }),
        1,
        'pdf:p1:r1',
      ),
      detectorLine(
        bboxBlock({ id: 'r1', text: 'I0.0 B1 Part present', y: 686 }),
        1,
        'pdf:p1:r1',
      ),
      detectorLine(
        bboxBlock({ id: 'r2', text: 'Q0.0 Y1 Cylinder extend', y: 672 }),
        1,
        'pdf:p1:r1',
      ),
      // Footer in a different region (would otherwise be absorbed).
      detectorLine(
        bboxBlock({
          id: 'foot',
          text: 'I0.1 page-footer ghost row that should NOT be a table row',
          y: 100,
        }),
        1,
        'pdf:p1:r2',
      ),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].rows).toHaveLength(3);
    expect(result.consumedBlockIds.has('foot')).toBe(false);
  });

  it('2. title block above table — title region does not produce a table; data rows still extract', () => {
    // Region A: title block lines. Region B: header + IO rows.
    const lines: PdfTableDetectorLine[] = [
      detectorLine(
        bboxBlock({ id: 't1', text: 'Cabinet 12 — Plant 3', y: 760 }),
        1,
        'pdf:p1:r1',
      ),
      detectorLine(
        bboxBlock({ id: 't2', text: 'Author: Beñat — Rev 4', y: 745 }),
        1,
        'pdf:p1:r1',
      ),
      detectorLine(
        bboxBlock({ id: 'h', text: 'Address Tag Description', y: 700 }),
        1,
        'pdf:p1:r2',
      ),
      detectorLine(
        bboxBlock({ id: 'r1', text: 'I0.0 B1 Part present', y: 686 }),
        1,
        'pdf:p1:r2',
      ),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].rows).toHaveLength(2); // header + 1 data row
    expect(result.consumedBlockIds.has('t1')).toBe(false);
    expect(result.consumedBlockIds.has('t2')).toBe(false);
  });

  it('3. two-column page: left region has IO list, right region has narrative — narrative not absorbed', () => {
    const lines: PdfTableDetectorLine[] = [
      detectorLine(
        bboxBlock({ id: 'L0', text: 'Address Tag Description', x: 50, y: 700 }),
        1,
        'pdf:p1:r1',
      ),
      detectorLine(
        bboxBlock({ id: 'L1', text: 'I0.0 B1 Part present', x: 50, y: 686 }),
        1,
        'pdf:p1:r1',
      ),
      detectorLine(
        bboxBlock({
          id: 'R0',
          text: 'Project narrative — overview',
          x: 350,
          y: 700,
        }),
        1,
        'pdf:p1:r2',
      ),
      detectorLine(
        bboxBlock({
          id: 'R1',
          text: 'I0.1 looks like an IO row in narrative prose',
          x: 350,
          y: 686,
        }),
        1,
        'pdf:p1:r2',
      ),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].rows.map((r) => r.rawText)).toEqual([
      'Address Tag Description',
      'I0.0 B1 Part present',
    ]);
    expect(result.consumedBlockIds.has('R0')).toBe(false);
    expect(result.consumedBlockIds.has('R1')).toBe(false);
  });

  it('4. BOM region still routes to PDF_BOM_TABLE_DETECTED rollup, even with region barriers', () => {
    const lines: PdfTableDetectorLine[] = [
      detectorLine(
        bboxBlock({
          id: 'h',
          text:
            'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
          y: 700,
        }),
        80,
        'pdf:p80:r1',
      ),
      detectorLine(
        bboxBlock({ id: 'foot', text: 'Datum 22.10.2013 Seite', y: 100 }),
        80,
        'pdf:p80:r2',
      ),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(
      result.diagnostics.some((d) => d.code === 'PDF_BOM_TABLE_DETECTED'),
    ).toBe(true);
    expect(
      result.diagnostics.some((d) => d.code === 'PDF_TABLE_HEADER_DETECTED'),
    ).toBe(false);
    // Footer line still suppressed via Sprint 83B hygiene gate, not via
    // region scoping — the region just keeps the BOM and footer from
    // being walked as one table.
    expect(result.tables).toHaveLength(0);
  });

  it('5. lines without regionId fall through to Sprint 81/83 unscoped behaviour', () => {
    // Same input as test 1 but with NO regionId — the footer ghost
    // row would be absorbed by the existing Sprint 81 walk.
    const lines: PdfTableDetectorLine[] = [
      detectorLine(
        bboxBlock({ id: 'h', text: 'Address Tag Description', y: 700 }),
      ),
      detectorLine(
        bboxBlock({ id: 'r1', text: 'I0.0 B1 Part present', y: 686 }),
      ),
      detectorLine(
        bboxBlock({ id: 'r2', text: 'Q0.0 Y1 Cylinder extend', y: 672 }),
      ),
      detectorLine(
        bboxBlock({ id: 'foot', text: 'I0.1 page-footer ghost row', y: 100 }),
      ),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    // Sprint 81 behaviour: walk continues until a non-IO-shaped
    // line is hit. The "page-footer ghost row" still pattern-
    // matches `looksLikeIoRow`, so it gets absorbed.
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].rows.length).toBeGreaterThanOrEqual(3);
    expect(result.consumedBlockIds.has('foot')).toBe(true);
  });

  it('6. mixed regionId / no regionId: only the tagged header enforces the barrier', () => {
    // Header has regionId but a row right after has no regionId — by
    // contract the walk falls through to unscoped behaviour for that
    // row (region barrier requires both sides to be tagged).
    const lines: PdfTableDetectorLine[] = [
      detectorLine(
        bboxBlock({ id: 'h', text: 'Address Tag Description', y: 700 }),
        1,
        'pdf:p1:r1',
      ),
      detectorLine(
        bboxBlock({ id: 'r1', text: 'I0.0 B1 Part present', y: 686 }),
        1,
        // intentionally no regionId
      ),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].rows).toHaveLength(2);
  });
});

// =============================================================================
// ingestPdf integration — text-mode (no geometry) preserved
// =============================================================================

describe('ingestPdf — Sprint 84.1 region clustering preserves text-mode', () => {
  it('1. text-mode (no bboxes) emits NO PDF_LAYOUT_REGION_CLUSTERED', async () => {
    const r = await ingestPdf({
      sourceId: 'tcecad',
      fileName: 'tcecad.pdf',
      text: [
        '--- page 80 ---',
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
        'Datum 22.10.2013 Seite',
      ].join('\n'),
    });
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_LAYOUT_REGION_CLUSTERED'),
    ).toBe(false);
  });

  it('2. strict-address Sprint 81 fixture still extracts 2 IO candidates', async () => {
    const r = await ingestPdf({
      sourceId: 'strict',
      fileName: 'strict.pdf',
      text: [
        '--- page 1 ---',
        'Address Tag Description',
        'I0.0 B1 Part present',
        'Q0.0 Y1 Cylinder extend',
      ].join('\n'),
    });
    expect(
      r.graph.nodes.filter((n) => n.kind === 'plc_channel').length,
    ).toBe(2);
  });

  it('3. multi-page TcECAD-shape mock preserves Sprint 83D rollup count + Sprint 83F additionalSourceRefs', async () => {
    const text = [
      '--- page 80 ---',
      '=COMPONENTS&EPB/1 Teileliste BECKH_P8_Dyn_v2',
      '--- page 81 ---',
      '=COMPONENTS&EPB/2 Teileliste BECKH_P8_Dyn_v2',
      '--- page 82 ---',
      '=COMPONENTS&EPB/3 Teileliste BECKH_P8_Dyn_v2',
    ].join('\n');
    const r = await ingestPdf({
      sourceId: 'mini',
      fileName: 'mini.pdf',
      text,
    });
    const bom = r.diagnostics.find(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    );
    expect(bom).toBeDefined();
    // Sprint 83D — exactly one BOM rollup for the canonical role.
    expect(
      r.diagnostics.filter((d) => d.code === 'PDF_BOM_TABLE_DETECTED'),
    ).toHaveLength(1);
    // Sprint 83F — additionalSourceRefs threading still works.
    expect(bom?.additionalSourceRefs?.length).toBe(2);
    expect(bom?.additionalSourceRefs?.map((r) => r.page)).toEqual(['81', '82']);
  });
});
