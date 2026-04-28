// Sprint 80 — pdfjs-dist adapter + line-grouping helpers. These
// tests build minimal valid PDFs at runtime via
// `tests/fixtures/pdf/build-fixture.ts` (no committed binary
// blobs) and exercise the real adapter end-to-end. The test suite
// runs in vitest's `node` environment.
//
// Slow-test note: pdfjs-dist's first import is ~hundreds of ms.
// Subsequent calls reuse the memoised module reference, but the
// total file-level runtime is in the seconds. The adapter has a
// reset hook (`__resetPdfjsModuleCacheForTests`) for tests that
// need to simulate a fresh import.

import { describe, expect, it } from 'vitest';

import {
  combineBbox,
  groupItemsIntoLines,
} from '../src/sources/pdf-text-normalize.js';
import {
  extractPdfTextLayer,
  type PdfTextLayerItem,
} from '../src/sources/pdf-text-layer.js';
import { ingestPdf } from '../src/sources/pdf.js';
import { buildPirDraftCandidate } from '../src/index.js';
import { buildMinimalPdfFixture } from './fixtures/pdf/build-fixture.js';

const SIMPLE_PDF_TEXT = 'I0.0 B1 Part present\nQ0.0 Y1 Cylinder extend';
const TWO_PAGE_PDF_TEXT_PAGE2 = 'Q0.1 M1 Conveyor motor\nnote about wiring';

// =============================================================================
// extractPdfTextLayer — real bytes path
// =============================================================================

describe('extractPdfTextLayer (Sprint 80)', () => {
  it('1. returns ok=false on null / empty / non-Uint8Array bytes', async () => {
    const r1 = await extractPdfTextLayer({ bytes: new Uint8Array(0) });
    expect(r1.ok).toBe(false);
    const r2 = await extractPdfTextLayer({
      // @ts-expect-error — defensive on non-Uint8Array
      bytes: 'not-bytes',
    });
    expect(r2.ok).toBe(false);
  });

  it('2. extracts pages + items from a hand-crafted minimal PDF', async () => {
    const bytes = buildMinimalPdfFixture({ pages: [SIMPLE_PDF_TEXT] });
    const r = await extractPdfTextLayer({ bytes });
    expect(r.ok).toBe(true);
    expect(r.pageCount).toBe(1);
    expect(r.pages.length).toBe(1);
    const items = r.pages[0].items;
    const allText = items.map((i) => i.text).join(' ');
    expect(allText).toContain('I0.0');
    expect(allText).toContain('B1');
    expect(allText).toContain('Q0.0');
    expect(allText).toContain('Y1');
  });

  it('3. preserves x/y/width/height as numbers in PDF point space', async () => {
    const bytes = buildMinimalPdfFixture({ pages: [SIMPLE_PDF_TEXT] });
    const r = await extractPdfTextLayer({ bytes });
    expect(r.ok).toBe(true);
    const items = r.pages[0].items;
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(typeof it.x).toBe('number');
      expect(typeof it.y).toBe('number');
      expect(typeof it.width).toBe('number');
      expect(typeof it.height).toBe('number');
      expect(Number.isFinite(it.x)).toBe(true);
      expect(Number.isFinite(it.y)).toBe(true);
    }
  });

  it('4. returns 1-based pageNumber + page width/height from the viewport', async () => {
    const bytes = buildMinimalPdfFixture({ pages: ['hello'] });
    const r = await extractPdfTextLayer({ bytes });
    const p = r.pages[0];
    expect(p.pageNumber).toBe(1);
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
  });

  it('5. parseFailed=true with PDF_TEXT_LAYER_EXTRACTION_FAILED for header-only stub bytes', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n%body…');
    const r = await extractPdfTextLayer({ bytes });
    expect(r.ok).toBe(false);
    expect(r.parseFailed).toBe(true);
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_TEXT_LAYER_EXTRACTION_FAILED'),
    ).toBe(true);
  });

  it('6. emits PDF_TEXT_LAYER_EMPTY_PAGE on an extracted page with no text items', async () => {
    // Build a fixture whose only "line" is the empty string; pdfjs
    // will see an empty content stream and yield zero text items.
    const bytes = buildMinimalPdfFixture({ pages: [''] });
    const r = await extractPdfTextLayer({ bytes });
    expect(r.ok).toBe(true);
    expect(r.pages[0].items.length).toBe(0);
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_TEXT_LAYER_EMPTY_PAGE'),
    ).toBe(true);
  });

  it('7. respects maxPages and emits PDF_PAGE_LIMIT_EXCEEDED', async () => {
    const bytes = buildMinimalPdfFixture({
      pages: ['page 1', 'page 2', 'page 3'],
    });
    const r = await extractPdfTextLayer({ bytes, maxPages: 2 });
    expect(r.ok).toBe(true);
    expect(r.pageCount).toBe(3);
    expect(r.pages.length).toBe(2);
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_PAGE_LIMIT_EXCEEDED'),
    ).toBe(true);
  });

  it('8. handles a multi-page PDF without losing pages', async () => {
    const bytes = buildMinimalPdfFixture({
      pages: [SIMPLE_PDF_TEXT, TWO_PAGE_PDF_TEXT_PAGE2],
    });
    const r = await extractPdfTextLayer({ bytes });
    expect(r.ok).toBe(true);
    expect(r.pages.length).toBe(2);
    expect(r.pages[0].pageNumber).toBe(1);
    expect(r.pages[1].pageNumber).toBe(2);
    const p2text = r.pages[1].items.map((i) => i.text).join(' ');
    expect(p2text).toContain('Q0.1');
    expect(p2text).toContain('M1');
  });
});

// =============================================================================
// groupItemsIntoLines + combineBbox — pure deterministic helpers
// =============================================================================

describe('groupItemsIntoLines + combineBbox', () => {
  function item(
    text: string,
    x: number,
    y: number,
    width: number,
    height = 12,
    fontSize = 12,
  ): PdfTextLayerItem {
    return { text, x, y, width, height, fontSize };
  }

  it('1. clusters items with the same y into one line, sorted left-to-right', () => {
    const lines = groupItemsIntoLines([
      item('B1', 100, 700, 12),
      item('I0.0', 50, 700, 28),
      item('Part', 130, 700, 24),
    ]);
    expect(lines.length).toBe(1);
    expect(lines[0].items.map((i) => i.text)).toEqual(['I0.0', 'B1', 'Part']);
  });

  it('2. opens a new line when y differs by more than yTolerance', () => {
    const lines = groupItemsIntoLines([
      item('A', 50, 700, 12),
      item('B', 50, 680, 12),
    ]);
    expect(lines.length).toBe(2);
    expect(lines[0].text).toBe('A');
    expect(lines[1].text).toBe('B');
  });

  it('3. sorts lines top-to-bottom (PDF y desc) deterministically', () => {
    const lines = groupItemsIntoLines([
      item('lower', 50, 600, 24),
      item('upper', 50, 700, 24),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['upper', 'lower']);
  });

  it('4. inserts a space when adjacent items have a gap >= 0.5 * fontSize', () => {
    // Item ends at x=80, next starts at x=88 (gap=8). Font size 12,
    // threshold = 6. 8 >= 6, so a space goes in.
    const lines = groupItemsIntoLines([
      item('A', 50, 700, 30),
      item('B', 88, 700, 30),
    ]);
    expect(lines[0].text).toBe('A B');
  });

  it('5. joins without a space when items are tightly kerned', () => {
    // Item ends at x=80, next starts at x=82 (gap=2). Below threshold.
    const lines = groupItemsIntoLines([
      item('foo', 50, 700, 30),
      item('bar', 82, 700, 30),
    ]);
    expect(lines[0].text).toBe('foobar');
  });

  it('6. line bbox is the union of its items', () => {
    const lines = groupItemsIntoLines([
      item('A', 50, 700, 10, 14),
      item('B', 70, 702, 10, 14),
    ]);
    expect(lines.length).toBe(1);
    const { bbox } = lines[0];
    expect(bbox.unit).toBe('pt');
    // Combined: minX=50 (A.x), maxX=80 (B.x + B.width). Width = 30.
    expect(bbox.x).toBe(50);
    expect(bbox.width).toBe(30);
    expect(bbox.y).toBe(700);
    expect(bbox.height).toBeGreaterThan(0);
  });

  it('7. combineBbox handles the empty / single-item edge cases', () => {
    expect(combineBbox([])).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      unit: 'pt',
    });
    const one = combineBbox([item('hi', 10, 20, 30, 14)]);
    expect(one).toEqual({ x: 10, y: 20, width: 30, height: 14, unit: 'pt' });
  });

  it('8. is total / non-throwing on null / undefined input', () => {
    expect(groupItemsIntoLines(null as never)).toEqual([]);
    expect(groupItemsIntoLines(undefined as never)).toEqual([]);
    expect(groupItemsIntoLines([])).toEqual([]);
  });
});

// =============================================================================
// ingestPdf — end-to-end with real bytes
// =============================================================================

describe('ingestPdf — Sprint 80 end-to-end with real bytes', () => {
  it('1. real selectable-text PDF produces PdfDocument + IO candidates', async () => {
    const bytes = buildMinimalPdfFixture({ pages: [SIMPLE_PDF_TEXT] });
    const r = await ingestPdf({
      sourceId: 'plan-1',
      fileName: 'plan.pdf',
      bytes,
    });
    expect(r.document.pages.length).toBe(1);
    expect(r.document.pages[0].textBlocks.length).toBeGreaterThan(0);
    expect(r.graph.nodes.length).toBeGreaterThan(0);
    expect(r.graph.edges.length).toBeGreaterThan(0);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_TEXT_LAYER_EXTRACTED');
    expect(codes).not.toContain('PDF_UNSUPPORTED_BINARY_PARSER');
    expect(codes).not.toContain('PDF_TEXT_LAYER_UNAVAILABLE');
  });

  it('2. text blocks carry SourceRef.kind=pdf, page, bbox, snippet', async () => {
    const bytes = buildMinimalPdfFixture({ pages: [SIMPLE_PDF_TEXT] });
    const r = await ingestPdf({
      sourceId: 'plan-1',
      fileName: 'plan.pdf',
      bytes,
    });
    const block = r.document.pages[0].textBlocks[0];
    expect(block.sourceRef.kind).toBe('pdf');
    expect(block.sourceRef.path).toBe('plan.pdf');
    expect(block.sourceRef.page).toBe('1');
    expect(block.sourceRef.snippet?.length ?? 0).toBeGreaterThan(0);
    expect(block.sourceRef.bbox?.unit).toBe('pt');
    expect(block.bbox?.unit).toBe('pt');
  });

  it('3. PDF-derived nodes never read above 0.65 confidence', async () => {
    const bytes = buildMinimalPdfFixture({ pages: [SIMPLE_PDF_TEXT] });
    const r = await ingestPdf({
      sourceId: 'plan-1',
      fileName: 'plan.pdf',
      bytes,
    });
    for (const n of r.graph.nodes) {
      expect(n.confidence.score).toBeLessThanOrEqual(0.65);
    }
  });

  it('4. real bytes + PirDraftCandidate round-trip preserves PDF SourceRefs', async () => {
    const bytes = buildMinimalPdfFixture({ pages: [SIMPLE_PDF_TEXT] });
    const r = await ingestPdf({
      sourceId: 'plan-1',
      fileName: 'plan.pdf',
      bytes,
    });
    const candidate = buildPirDraftCandidate(r.graph);
    expect(candidate.io.length).toBeGreaterThan(0);
    const ref = candidate.io[0]?.sourceRefs[0];
    expect(ref?.kind).toBe('pdf');
    expect(ref?.page).toBe('1');
    expect(ref?.bbox?.unit).toBe('pt');
  });

  it('5. multi-page real PDF preserves per-page SourceRefs', async () => {
    const bytes = buildMinimalPdfFixture({
      pages: [SIMPLE_PDF_TEXT, TWO_PAGE_PDF_TEXT_PAGE2],
    });
    const r = await ingestPdf({
      sourceId: 'multi',
      fileName: 'multi.pdf',
      bytes,
    });
    expect(r.document.pages.length).toBe(2);
    const pages = new Set(
      r.graph.nodes.flatMap((n) => n.sourceRefs.map((s) => s.page)),
    );
    expect(pages.has('1')).toBe(true);
    expect(pages.has('2')).toBe(true);
  });

  it('6. no Sprint 79 stub diagnostics on a real text-layer PDF', async () => {
    const bytes = buildMinimalPdfFixture({ pages: [SIMPLE_PDF_TEXT] });
    const r = await ingestPdf({
      sourceId: 'plan-1',
      fileName: 'plan.pdf',
      bytes,
    });
    const codes = new Set(r.diagnostics.map((d) => d.code));
    expect(codes.has('PDF_UNSUPPORTED_BINARY_PARSER')).toBe(false);
    expect(codes.has('PDF_TEXT_LAYER_UNAVAILABLE')).toBe(false);
    expect(codes.has('PDF_MALFORMED')).toBe(false);
  });
});
