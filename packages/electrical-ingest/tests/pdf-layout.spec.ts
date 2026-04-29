// Sprint 84 — pure tests for the PDF layout helpers in
// `src/sources/pdf-layout.ts`. The Sprint 79 test-mode text path
// produces blocks without bboxes; the helpers must no-op there
// (preserving Sprint 79/81 behaviour). Real bytes-mode produces
// bboxes via pdfjs; the helpers only kick in there. We test
// both branches with synthetic geometry so neither needs a real
// PDF binary fixture.

import { describe, expect, it } from 'vitest';

import {
  clusterBlocksIntoRegions,
  detectColumnLayout,
  detectPageRotation,
  orderBlocksByLayout,
} from '../src/sources/pdf-layout.js';
import type { PdfTextBlock } from '../src/sources/pdf-types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface BlockOpts {
  id: string;
  text: string;
  /** PDF point space; origin bottom-left. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

function bboxBlock(opts: BlockOpts): PdfTextBlock {
  return {
    id: opts.id,
    text: opts.text,
    confidence: 0.5,
    sourceRef: {
      sourceId: 's1',
      kind: 'pdf',
      page: '1',
      snippet: opts.text,
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

function noBboxBlock(id: string, text: string): PdfTextBlock {
  return {
    id,
    text,
    confidence: 0.5,
    sourceRef: {
      sourceId: 's1',
      kind: 'pdf',
      page: '1',
      snippet: text,
    },
  };
}

// =============================================================================
// detectColumnLayout
// =============================================================================

describe('detectColumnLayout (Sprint 84)', () => {
  it('1. returns single-column for empty input', () => {
    expect(detectColumnLayout([])).toEqual({
      columns: [],
      multiColumn: false,
      orientation: 'unknown',
    });
  });

  it('2. returns single-column when no blocks have geometry (Sprint 79 fallback)', () => {
    const blocks = [
      noBboxBlock('b1', 'top line'),
      noBboxBlock('b2', 'middle line'),
      noBboxBlock('b3', 'bottom line'),
    ];
    const layout = detectColumnLayout(blocks);
    expect(layout.multiColumn).toBe(false);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0].blocks).toEqual(blocks);
  });

  it('3. returns single-column when too few geometry-bearing blocks', () => {
    const blocks = [
      bboxBlock({ id: 'b1', text: 'a', x: 50 }),
      bboxBlock({ id: 'b2', text: 'b', x: 60 }),
    ];
    expect(detectColumnLayout(blocks).multiColumn).toBe(false);
  });

  it('4. detects two columns when blocks cluster on two centerlines', () => {
    const left: PdfTextBlock[] = [];
    const right: PdfTextBlock[] = [];
    for (let i = 0; i < 5; i++) {
      left.push(
        bboxBlock({
          id: `L${i}`,
          text: `left ${i}`,
          x: 50,
          y: 700 - i * 14,
          w: 80,
        }),
      );
      right.push(
        bboxBlock({
          id: `R${i}`,
          text: `right ${i}`,
          x: 350,
          y: 700 - i * 14,
          w: 80,
        }),
      );
    }
    const layout = detectColumnLayout([...left, ...right]);
    expect(layout.multiColumn).toBe(true);
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[0].blocks.map((b) => b.id)).toEqual([
      'L0',
      'L1',
      'L2',
      'L3',
      'L4',
    ]);
    expect(layout.columns[1].blocks.map((b) => b.id)).toEqual([
      'R0',
      'R1',
      'R2',
      'R3',
      'R4',
    ]);
  });

  it('5. reattaches orphan blocks (small accumulator) to nearest meaningful column', () => {
    const main: PdfTextBlock[] = [];
    for (let i = 0; i < 5; i++) {
      main.push(
        bboxBlock({ id: `M${i}`, text: `main ${i}`, x: 50, w: 80, y: 700 - i * 14 }),
      );
      main.push(
        bboxBlock({
          id: `R${i}`,
          text: `right ${i}`,
          x: 350,
          w: 80,
          y: 700 - i * 14,
        }),
      );
    }
    // Two orphan blocks far to the right (distinct centerline but
    // below the size floor of 3).
    main.push(
      bboxBlock({ id: 'O1', text: 'orphan 1', x: 520, w: 40, y: 600 }),
    );
    main.push(
      bboxBlock({ id: 'O2', text: 'orphan 2', x: 525, w: 40, y: 580 }),
    );
    const layout = detectColumnLayout(main);
    expect(layout.multiColumn).toBe(true);
    // Orphans go to the nearest meaningful column (right column).
    const rightIds = layout.columns[1].blocks.map((b) => b.id);
    expect(rightIds).toContain('O1');
    expect(rightIds).toContain('O2');
  });

  it('6. reads page orientation from page geometry when given', () => {
    const blocks: PdfTextBlock[] = [];
    expect(
      detectColumnLayout(blocks, { pageWidth: 612, pageHeight: 792 }).orientation,
    ).toBe('portrait');
    expect(
      detectColumnLayout(blocks, { pageWidth: 792, pageHeight: 612 }).orientation,
    ).toBe('landscape');
  });
});

// =============================================================================
// orderBlocksByLayout
// =============================================================================

describe('orderBlocksByLayout (Sprint 84)', () => {
  it('1. preserves input order when no blocks have geometry (Sprint 79 fallback)', () => {
    const blocks = [
      noBboxBlock('b1', 'first'),
      noBboxBlock('b2', 'second'),
      noBboxBlock('b3', 'third'),
    ];
    expect(orderBlocksByLayout(blocks).map((b) => b.id)).toEqual([
      'b1',
      'b2',
      'b3',
    ]);
  });

  it('2. orders single-column blocks descending y (top of page first)', () => {
    const blocks = [
      bboxBlock({ id: 'mid', text: 'mid', y: 400 }),
      bboxBlock({ id: 'top', text: 'top', y: 700 }),
      bboxBlock({ id: 'bot', text: 'bot', y: 100 }),
    ];
    expect(orderBlocksByLayout(blocks).map((b) => b.id)).toEqual([
      'top',
      'mid',
      'bot',
    ]);
  });

  it('3. emits left column then right column for two-column pages', () => {
    const blocks = [
      bboxBlock({ id: 'L1', text: 'L1', x: 50, w: 80, y: 700 }),
      bboxBlock({ id: 'R1', text: 'R1', x: 350, w: 80, y: 700 }),
      bboxBlock({ id: 'L2', text: 'L2', x: 50, w: 80, y: 686 }),
      bboxBlock({ id: 'R2', text: 'R2', x: 350, w: 80, y: 686 }),
      bboxBlock({ id: 'L3', text: 'L3', x: 50, w: 80, y: 672 }),
      bboxBlock({ id: 'R3', text: 'R3', x: 350, w: 80, y: 672 }),
      bboxBlock({ id: 'L4', text: 'L4', x: 50, w: 80, y: 658 }),
      bboxBlock({ id: 'R4', text: 'R4', x: 350, w: 80, y: 658 }),
    ];
    const ordered = orderBlocksByLayout(blocks).map((b) => b.id);
    expect(ordered.slice(0, 4)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(ordered.slice(4)).toEqual(['R1', 'R2', 'R3', 'R4']);
  });

  it('4. tie-breaks same-y blocks left-to-right by bbox.x', () => {
    const blocks = [
      bboxBlock({ id: 'b', text: 'b', x: 200, y: 700, w: 50 }),
      bboxBlock({ id: 'a', text: 'a', x: 100, y: 700, w: 50 }),
    ];
    expect(orderBlocksByLayout(blocks).map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('5. is deterministic across runs', () => {
    const make = () =>
      [
        bboxBlock({ id: 'mid', text: 'mid', y: 400 }),
        bboxBlock({ id: 'top', text: 'top', y: 700 }),
        bboxBlock({ id: 'bot', text: 'bot', y: 100 }),
      ];
    const a = orderBlocksByLayout(make()).map((b) => b.id);
    const b = orderBlocksByLayout(make()).map((b) => b.id);
    expect(a).toEqual(b);
  });
});

// =============================================================================
// clusterBlocksIntoRegions
// =============================================================================

describe('clusterBlocksIntoRegions (Sprint 84)', () => {
  it('1. returns one region for empty input', () => {
    expect(clusterBlocksIntoRegions([])).toEqual([]);
  });

  it('2. returns one region when blocks have no geometry (geometric breaks need geometry)', () => {
    const blocks = [
      noBboxBlock('b1', 'a'),
      noBboxBlock('b2', 'b'),
      noBboxBlock('b3', 'c'),
    ];
    const regions = clusterBlocksIntoRegions(blocks);
    expect(regions).toHaveLength(1);
    expect(regions[0].blocks).toHaveLength(3);
  });

  it('3. keeps tightly-packed blocks in one region', () => {
    const blocks: PdfTextBlock[] = [];
    for (let i = 0; i < 6; i++) {
      blocks.push(bboxBlock({ id: `b${i}`, text: `${i}`, y: 700 - i * 14, h: 12 }));
    }
    const regions = clusterBlocksIntoRegions(blocks);
    expect(regions).toHaveLength(1);
  });

  it('4. opens a new region when a vertical gap > 2× median height appears', () => {
    const blocks: PdfTextBlock[] = [];
    // Region A: pages 700–658 (4 lines, ~14pt apart, height 12pt).
    for (let i = 0; i < 4; i++) {
      blocks.push(
        bboxBlock({ id: `A${i}`, text: `A${i}`, y: 700 - i * 14, h: 12 }),
      );
    }
    // 60pt vertical gap (> 2 × 12pt = 24pt).
    for (let i = 0; i < 3; i++) {
      blocks.push(
        bboxBlock({ id: `B${i}`, text: `B${i}`, y: 580 - i * 14, h: 12 }),
      );
    }
    const regions = clusterBlocksIntoRegions(blocks);
    expect(regions).toHaveLength(2);
    expect(regions[0].blocks.map((b) => b.id)).toEqual([
      'A0',
      'A1',
      'A2',
      'A3',
    ]);
    expect(regions[1].blocks.map((b) => b.id)).toEqual(['B0', 'B1', 'B2']);
  });

  it('5. respects vGapMultiplier override', () => {
    // Inter-block gap: A.bottom (700) - B.top (650+12=662) = 38pt.
    // h=12 → 2×=24pt (split), 5×=60pt (merge).
    const blocks: PdfTextBlock[] = [
      bboxBlock({ id: 'A', text: 'A', y: 700, h: 12 }),
      bboxBlock({ id: 'B', text: 'B', y: 650, h: 12 }),
      bboxBlock({ id: 'C', text: 'C', y: 636, h: 12 }),
    ];
    // Default 2× = 24pt threshold → A separated from B.
    expect(clusterBlocksIntoRegions(blocks).length).toBeGreaterThan(1);
    // Loose threshold (5× = 60pt) → all in one region.
    expect(
      clusterBlocksIntoRegions(blocks, { vGapMultiplier: 5 }),
    ).toHaveLength(1);
  });
});

// =============================================================================
// detectPageRotation
// =============================================================================

describe('detectPageRotation (Sprint 84)', () => {
  it('1. flags page.rotation === 90', () => {
    const r = detectPageRotation({ rotation: 90, textBlocks: [] });
    expect(r.suspected).toBe(true);
    expect(r.reason).toBe('page-rotation-tag');
  });

  it('2. flags page.rotation === 270', () => {
    const r = detectPageRotation({ rotation: 270, textBlocks: [] });
    expect(r.suspected).toBe(true);
  });

  it('3. does not flag rotation=0 with normal landscape blocks', () => {
    const blocks: PdfTextBlock[] = [];
    for (let i = 0; i < 8; i++) {
      blocks.push(
        bboxBlock({ id: `b${i}`, text: `block ${i}`, x: 50, y: 700 - i * 14, w: 200, h: 12 }),
      );
    }
    expect(detectPageRotation({ textBlocks: blocks }).suspected).toBe(false);
  });

  it('4. flags rotation via aspect-ratio heuristic on extreme tall-narrow blocks', () => {
    const blocks: PdfTextBlock[] = [];
    for (let i = 0; i < 6; i++) {
      blocks.push(
        bboxBlock({
          id: `tall${i}`,
          text: `tall ${i}`,
          x: 100 + i * 14,
          y: 100,
          w: 12,
          h: 200,
        }),
      );
    }
    const r = detectPageRotation({ textBlocks: blocks });
    expect(r.suspected).toBe(true);
    expect(r.reason).toBe('block-aspect-ratio');
  });

  it('5. does not flag pages with too few geometry-bearing blocks', () => {
    const blocks: PdfTextBlock[] = [
      bboxBlock({ id: 'a', text: 'a', x: 0, y: 0, w: 12, h: 200 }),
    ];
    expect(detectPageRotation({ textBlocks: blocks }).suspected).toBe(false);
  });
});
