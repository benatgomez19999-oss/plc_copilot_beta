// Sprint 84.1B — integration tests proving the per-page layout
// emission was replaced by cross-page rollups. Uses real
// bytes-mode fixtures so the layout helpers actually fire (text-
// mode without geometry continues to emit nothing — covered by
// `pdf-layout-integration.spec.ts`).

import { describe, expect, it } from 'vitest';

import { ingestPdf } from '../src/sources/pdf.js';
import { buildTabularPdfFixture } from './fixtures/pdf/build-fixture.js';

interface PageRow {
  y: number;
  cells: Array<{ text: string; x: number }>;
}

function multiColumnPage(
  topY: number,
  rows: number,
): PageRow[] {
  // Left and right columns are placed on different y values so the
  // Sprint 80 line-grouper produces separate line blocks per cell.
  // (Same-y cells glue into one block with a wide bbox, which
  // would collapse onto a single centerline.)
  const out: PageRow[] = [];
  for (let i = 0; i < rows; i++) {
    out.push({
      y: topY - i * 16,
      cells: [{ text: `left ${i + 1}`, x: 50 }],
    });
    out.push({
      y: topY - i * 16 - 8,
      cells: [{ text: `right ${i + 1}`, x: 350 }],
    });
  }
  return out;
}

function regionClusteredPage(): PageRow[] {
  // One block of rows near the top, a big vertical gap, then
  // another cluster near the bottom. The gap is well above
  // 2× median block height so `clusterBlocksIntoRegions`
  // resolves two regions.
  const out: PageRow[] = [];
  for (let i = 0; i < 5; i++) {
    out.push({
      y: 720 - i * 16,
      cells: [{ text: `top ${i + 1}`, x: 50 }],
    });
  }
  for (let i = 0; i < 5; i++) {
    out.push({
      y: 300 - i * 16,
      cells: [{ text: `bot ${i + 1}`, x: 50 }],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-column rollup
// ---------------------------------------------------------------------------

describe('ingestPdf — Sprint 84.1B multi-column rollup', () => {
  it('1. three pages with multi-column layout produce ONE rollup, not three', async () => {
    const bytes = buildTabularPdfFixture({
      pages: [
        { rows: multiColumnPage(720, 6) },
        { rows: multiColumnPage(720, 6) },
        { rows: multiColumnPage(720, 6) },
      ],
    });
    const r = await ingestPdf({
      sourceId: 'multi',
      fileName: 'multi.pdf',
      bytes,
    });
    const multi = r.diagnostics.filter(
      (d) => d.code === 'PDF_LAYOUT_MULTI_COLUMN_DETECTED',
    );
    // The rollup contract: at most one diagnostic per code.
    expect(multi).toHaveLength(1);
    // Message should reference all three pages compactly.
    expect(multi[0].message).toContain('pages 1–3');
    expect(multi[0].message).toContain('column-aware reading order');
    // The rollup is info severity and carries no per-page sourceRef.
    expect(multi[0].severity).toBe('info');
    expect(multi[0].sourceRef).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Region-cluster rollup
// ---------------------------------------------------------------------------

describe('ingestPdf — Sprint 84.1B region-cluster rollup', () => {
  it('1. multi-page region clustering produces ONE rollup with compressed page range', async () => {
    const bytes = buildTabularPdfFixture({
      pages: [
        { rows: regionClusteredPage() },
        { rows: regionClusteredPage() },
        { rows: regionClusteredPage() },
      ],
    });
    const r = await ingestPdf({
      sourceId: 'region',
      fileName: 'region.pdf',
      bytes,
    });
    const region = r.diagnostics.filter(
      (d) => d.code === 'PDF_LAYOUT_REGION_CLUSTERED',
    );
    expect(region).toHaveLength(1);
    expect(region[0].message).toContain('vertical regions');
    // Page phrase compresses the three pages into one range.
    expect(region[0].message).toMatch(/pages 1[–-]3/);
  });
});

// ---------------------------------------------------------------------------
// Text-mode preserved (Sprint 84 contract)
// ---------------------------------------------------------------------------

describe('ingestPdf — Sprint 84.1B text-mode preserved', () => {
  it('1. text-mode (no bboxes) emits NO layout-rollup diagnostics', async () => {
    const r = await ingestPdf({
      sourceId: 'text',
      fileName: 'text.pdf',
      text: [
        '--- page 1 ---',
        'Address Tag Description',
        'I0.0 B1 Part present',
        'Q0.0 Y1 Cylinder extend',
      ].join('\n'),
    });
    const layoutCodes = new Set([
      'PDF_LAYOUT_MULTI_COLUMN_DETECTED',
      'PDF_LAYOUT_REGION_CLUSTERED',
      'PDF_LAYOUT_ROTATION_SUSPECTED',
    ]);
    const layoutDiags = r.diagnostics.filter((d) => layoutCodes.has(d.code));
    expect(layoutDiags).toHaveLength(0);
    // Sprint 81 strict-address path still produces 2 IO channels.
    expect(
      r.graph.nodes.filter((n) => n.kind === 'plc_channel').length,
    ).toBe(2);
  });

  it('2. multi-page TcECAD-shape mock keeps Sprint 83D BOM rollup + Sprint 83F additionalSourceRefs', async () => {
    const r = await ingestPdf({
      sourceId: 'tcecad',
      fileName: 'tcecad.pdf',
      text: [
        '--- page 80 ---',
        '=COMPONENTS&EPB/1 Teileliste BECKH_P8_Dyn_v2',
        '--- page 81 ---',
        '=COMPONENTS&EPB/2 Teileliste BECKH_P8_Dyn_v2',
        '--- page 82 ---',
        '=COMPONENTS&EPB/3 Teileliste BECKH_P8_Dyn_v2',
      ].join('\n'),
    });
    const bom = r.diagnostics.find(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    );
    expect(bom).toBeDefined();
    expect(bom?.additionalSourceRefs?.length).toBe(2);
    // No layout-rollup noise from text-mode.
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_LAYOUT_MULTI_COLUMN_DETECTED'),
    ).toBe(false);
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_LAYOUT_REGION_CLUSTERED'),
    ).toBe(false);
  });
});
