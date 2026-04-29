// Sprint 83C — non-IO family diagnostic rollups.
//
// Sprint 83B made the diagnostic stream less noisy per-page;
// Sprint 83C now collapses multi-page non-IO families into ONE
// rollup diagnostic per `(family, signature)` group with a
// coalesced page-range string ("80–86", "3, 49–54", etc.) and
// a representative first-evidence snippet.
//
// Pinned contracts:
//   - `compressPageRanges` is pure, total, and deterministic.
//   - `detectIoTables` emits one rollup per (family, signature)
//     regardless of page count.
//   - Sprint 83B hygiene gates still apply (footers / weak
//     single-token lines / body rows are suppressed before they
//     reach the rollup bucket).
//   - Sprint 83A IO-list path is not regressed
//     (`PDF_TABLE_HEADER_DETECTED` still fires for real headers).
//   - Sprint 82 channel-marker strictness still holds.
//   - Strict-address PDF still produces IO candidates.

import { describe, expect, it } from 'vitest';

import {
  compressPageRanges,
  detectIoTables,
} from '../src/sources/pdf-table-detect.js';
import type { PdfTextBlock } from '../src/sources/pdf-types.js';
import type { PdfTableDetectorLine } from '../src/sources/pdf-table-detect.js';
import { ingestPdf } from '../src/sources/pdf.js';

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
function line(text: string, page = 1, blockIndex = 1): PdfTableDetectorLine {
  return { block: block(text, page, blockIndex), pageNumber: page };
}

const NON_IO_FAMILY_CODES: ReadonlyArray<string> = [
  'PDF_BOM_TABLE_DETECTED',
  'PDF_TERMINAL_TABLE_DETECTED',
  'PDF_CABLE_TABLE_DETECTED',
  'PDF_CONTENTS_TABLE_IGNORED',
  'PDF_LEGEND_TABLE_IGNORED',
  'PDF_TABLE_HEADER_REJECTED',
];

function familyDiagCount(diagnostics: ReadonlyArray<{ code: string }>): number {
  return diagnostics.filter((d) => NON_IO_FAMILY_CODES.includes(d.code)).length;
}

const BOM_HEADER =
  'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer';
const TERMINAL_HEADER = 'Klemmenplan Klemme Ziel Quelle Anschluss';
const CABLE_HEADER = 'Kabelübersicht Kabel Ader Quelle Ziel';
const CONTENTS_HEADER =
  'Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter';
const LEGEND_HEADER =
  'Legende Strukturierungsprinzipien Referenzkennzeichen';

// =============================================================================
// compressPageRanges — pure helper
// =============================================================================

describe('compressPageRanges (Sprint 83C)', () => {
  it('1. empty array returns empty string', () => {
    expect(compressPageRanges([])).toBe('');
  });

  it('2. single page returns the bare number', () => {
    expect(compressPageRanges([80])).toBe('80');
  });

  it('3. consecutive run coalesces with en-dash', () => {
    expect(compressPageRanges([80, 81, 82, 83, 84, 85, 86])).toBe('80–86');
  });

  it('4. mixed singletons + run produce comma-separated parts', () => {
    expect(compressPageRanges([3, 49, 50, 51, 52, 53, 54])).toBe('3, 49–54');
  });

  it('5. unsorted + duplicates produce stable numeric range output', () => {
    expect(compressPageRanges([86, 80, 81, 82, 86, 84, 85, 83])).toBe('80–86');
    expect(compressPageRanges([3, 80, 49, 81, 50, 82, 86, 53])).toBe(
      '3, 49–50, 53, 80–82, 86',
    );
  });

  it('6. tolerates string inputs (e.g. SourceRef.page)', () => {
    expect(compressPageRanges(['80', 81, '82'])).toBe('80–82');
  });

  it('7. non-finite / non-integer / non-string inputs are dropped defensively', () => {
    // @ts-expect-error — defensiveness probe
    expect(compressPageRanges([NaN, 'abc', null, undefined, 3.5])).toBe('');
    expect(compressPageRanges([3.5, 4, 4, 4])).toBe('4');
  });

  it('8. real TcECAD-shaped sequence: contents + terminal + cable + BOM', () => {
    // Contents pages 2–4, terminal pages 3, 49–54, cable pages
    // 3–4, 55–79, BOM pages 80–86 — verify every family-shape
    // sequence ends up readable.
    expect(compressPageRanges([2, 3, 4])).toBe('2–4');
    expect(compressPageRanges([3, 49, 50, 51, 52, 53, 54])).toBe('3, 49–54');
    expect(
      compressPageRanges([
        3, 4, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70,
        71, 72, 73, 74, 75, 76, 77, 78, 79,
      ]),
    ).toBe('3–4, 55–79');
    expect(compressPageRanges([80, 81, 82, 83, 84, 85, 86])).toBe('80–86');
  });
});

// =============================================================================
// detectIoTables — Sprint 83C rollup integration
// =============================================================================

describe('detectIoTables — Sprint 83C non-IO rollups', () => {
  it('1. BOM header repeated across pages 80–86 emits ONE rollup with "80–86"', () => {
    const lines = [80, 81, 82, 83, 84, 85, 86].map((p) => line(BOM_HEADER, p, 1));
    const result = detectIoTables({ sourceId: 's1', lines });
    const bomDiags = result.diagnostics.filter(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    );
    expect(bomDiags.length).toBe(1);
    expect(bomDiags[0].message).toContain('80–86');
    expect(bomDiags[0].message).toContain('Ignored BOM / parts-list sections');
    expect(bomDiags[0].message).toContain('First evidence:');
    // The sourceRef points at the first occurrence's source line.
    expect(bomDiags[0].sourceRef?.kind).toBe('pdf');
    expect(bomDiags[0].sourceRef?.page).toBe('80');
  });

  it('2. cable headers across non-consecutive pages 3, 4, 55–79 emit ONE rollup with the compressed range', () => {
    const cablePages = [3, 4, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67];
    const lines = cablePages.map((p) => line(CABLE_HEADER, p, 1));
    const result = detectIoTables({ sourceId: 's1', lines });
    const cableDiags = result.diagnostics.filter(
      (d) => d.code === 'PDF_CABLE_TABLE_DETECTED',
    );
    expect(cableDiags.length).toBe(1);
    expect(cableDiags[0].message).toContain('3–4, 55–67');
  });

  it('3. mixed families on the same document produce one rollup per family', () => {
    const lines: PdfTableDetectorLine[] = [
      line(CONTENTS_HEADER, 2, 1),
      line(CONTENTS_HEADER, 3, 1),
      line(CONTENTS_HEADER, 4, 1),
      line(TERMINAL_HEADER, 3, 2),
      line(TERMINAL_HEADER, 49, 1),
      line(TERMINAL_HEADER, 50, 1),
      line(TERMINAL_HEADER, 54, 1),
      line(CABLE_HEADER, 55, 1),
      line(CABLE_HEADER, 79, 1),
      line(BOM_HEADER, 80, 1),
      line(BOM_HEADER, 86, 1),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    const codes = result.diagnostics.map((d) => d.code).filter((c) =>
      NON_IO_FAMILY_CODES.includes(c),
    );
    expect(codes).toEqual([
      // Sorted by family then by representative page.
      'PDF_BOM_TABLE_DETECTED',
      'PDF_CABLE_TABLE_DETECTED',
      'PDF_CONTENTS_TABLE_IGNORED',
      'PDF_TERMINAL_TABLE_DETECTED',
    ]);
    const findDiag = (code: string) =>
      result.diagnostics.find((d) => d.code === code)!;
    expect(findDiag('PDF_CONTENTS_TABLE_IGNORED').message).toContain('2–4');
    expect(findDiag('PDF_TERMINAL_TABLE_DETECTED').message).toContain(
      '3, 49–50, 54',
    );
    expect(findDiag('PDF_CABLE_TABLE_DETECTED').message).toContain('55, 79');
    expect(findDiag('PDF_BOM_TABLE_DETECTED').message).toContain('80, 86');
  });

  it('4. page-1 contents-only document uses the singular "page" phrasing', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line(CONTENTS_HEADER, 1, 1)],
    });
    const contents = result.diagnostics.find(
      (d) => d.code === 'PDF_CONTENTS_TABLE_IGNORED',
    );
    expect(contents).toBeDefined();
    expect(contents!.message).toMatch(/\bpage 1\b/);
  });

  it('5. legend headers on non-consecutive pages 5 and 7 emit ONE rollup with "5, 7"', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line(LEGEND_HEADER, 5, 1), line(LEGEND_HEADER, 7, 1)],
    });
    const legend = result.diagnostics.find(
      (d) => d.code === 'PDF_LEGEND_TABLE_IGNORED',
    );
    expect(legend).toBeDefined();
    expect(legend!.message).toContain('5, 7');
  });

  it('6. footer / title-block lines still suppress (no rollup for them)', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Datum 22.10.2013 TcECAD Import V2.2.12 Teileliste Seite', 1, 1),
        line('Bearb RAL =CABLE', 1, 2),
        line('Änderungsdatum 30.10.2013 von RalfL Anzahl der Seiten 86', 1, 3),
      ],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  it('7. weak single-token vendor metadata still suppresses (no rollup)', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Fabrikat BECKHOFF', 1, 1),
        line('Hersteller (Firma) Beckhoff Automation GmbH', 1, 2),
      ],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  it('8. body rows like "=CABLE&EMB/24 2" still suppress (no rollup)', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('=CABLE&EMB/24 2', 55, 1),
        line('=CABLE&EMB/26 2', 55, 2),
        line('=TERMINAL&EMA/7 1.1', 49, 1),
      ],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  it('9. real IO-list path is NOT regressed by the rollup (Sprint 83A semantics preserved)', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Address Tag Description', 1, 1),
        line('I0.0 B1 Part present', 1, 2),
        line('Q0.0 Y1 Cylinder extend', 1, 3),
      ],
    });
    expect(result.tables.length).toBe(1);
    expect(result.tables[0].rows.length).toBe(3);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_TABLE_HEADER_DETECTED');
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  it('10. rollup ordering is stable: family alphabetical, then by representative page', () => {
    // Same input as test 3, but spell out the expected stable
    // order so future re-orderings break this test loudly.
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line(BOM_HEADER, 80, 1),
        line(CABLE_HEADER, 55, 1),
        line(CONTENTS_HEADER, 2, 1),
        line(TERMINAL_HEADER, 49, 1),
      ],
    });
    const familyOrder = result.diagnostics
      .filter((d) => NON_IO_FAMILY_CODES.includes(d.code))
      .map((d) => d.code);
    expect(familyOrder).toEqual([
      'PDF_BOM_TABLE_DETECTED',
      'PDF_CABLE_TABLE_DETECTED',
      'PDF_CONTENTS_TABLE_IGNORED',
      'PDF_TERMINAL_TABLE_DETECTED',
    ]);
  });
});

// =============================================================================
// ingestPdf — Sprint 83C realistic TcECAD-shaped fixture
// =============================================================================

describe('ingestPdf — Sprint 83C realistic TcECAD-shaped fixture', () => {
  it('1. compact rollup-only diagnostic stream on a TcECAD-shaped multi-page document', async () => {
    // Mock pages roughly mirror the real
    // `TcECAD_Import_V2_2_x.pdf` shape: contents pages 2–4,
    // terminal-list page 49, cable-list pages 55 + 79, BOM
    // canonical header pages 80–82. Plus footer + vendor
    // metadata noise. Sprint 83C should emit AT MOST 4 family
    // rollups (one per family) plus the standard text-layer /
    // table-detection-not-implemented / electrical-extraction-
    // not-implemented info diagnostics.
    const text = [
      '--- page 1 ---',
      'Datum 22.10.2013 TcECAD Import V2.2.12 Teileliste Seite',
      'Hersteller (Firma) Beckhoff Automation GmbH',
      '--- page 2 ---',
      CONTENTS_HEADER,
      '--- page 3 ---',
      CONTENTS_HEADER,
      '--- page 4 ---',
      CONTENTS_HEADER,
      '--- page 49 ---',
      TERMINAL_HEADER,
      '--- page 55 ---',
      CABLE_HEADER,
      '--- page 79 ---',
      CABLE_HEADER,
      '--- page 80 ---',
      BOM_HEADER,
      '=CABLE&EMB/24 2',
      '--- page 81 ---',
      BOM_HEADER,
      '--- page 82 ---',
      BOM_HEADER,
      'Bearb RAL =CABLE',
    ].join('\n');
    const r = await ingestPdf({
      sourceId: 'tcecad-mock',
      fileName: 'tcecad-mock.pdf',
      text,
    });
    const familyCount = familyDiagCount(r.diagnostics);
    // Hard upper bound: 4 family rollups (BOM / cable /
    // contents / terminal). The Sprint 83B baseline for this
    // input was 7+.
    expect(familyCount).toBeLessThanOrEqual(4);
    expect(familyCount).toBeGreaterThanOrEqual(3);

    const findDiag = (code: string) =>
      r.diagnostics.find((d) => d.code === code);

    // Each family rollup carries a compressed range.
    const contentsDiag = findDiag('PDF_CONTENTS_TABLE_IGNORED');
    expect(contentsDiag?.message).toContain('2–4');

    const cableDiag = findDiag('PDF_CABLE_TABLE_DETECTED');
    expect(cableDiag?.message).toContain('55, 79');

    const bomDiag = findDiag('PDF_BOM_TABLE_DETECTED');
    expect(bomDiag?.message).toContain('80–82');

    // No IO candidates, no PIR-buildable evidence.
    expect(r.graph.nodes).toEqual([]);
    expect(r.graph.edges).toEqual([]);
  });

  it('2. Sprint 82 channel-marker strictness regression still holds', async () => {
    const r = await ingestPdf({
      sourceId: 'page24',
      fileName: 'page24.pdf',
      text: 'I1 Sensor light barrier\n%I1\nI3+',
    });
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel')).toEqual([]);
  });

  it('3. strict-address regression still holds', async () => {
    const r = await ingestPdf({
      sourceId: 'strict',
      fileName: 'strict.pdf',
      text: 'I0.0 B1 Part present\nQ0.0 Y1 Cylinder extend',
    });
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel').length).toBe(2);
  });

  it('4. mixed strict-address PDF + BOM rollup: IO path NOT regressed, BOM rolls up cleanly', async () => {
    const r = await ingestPdf({
      sourceId: 'mixed',
      fileName: 'mixed.pdf',
      text: [
        '--- page 80 ---',
        BOM_HEADER,
        '--- page 81 ---',
        BOM_HEADER,
        '--- page 1 ---',
        'Address Tag Description',
        'I0.0 B1 Part present',
        'Q0.0 Y1 Cylinder extend',
      ].join('\n'),
    });
    const codes = r.diagnostics.map((d) => d.code);
    // Strict-address path still produces two channels.
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel').length).toBe(
      2,
    );
    // IO-list header still surfaces as Sprint 83A.
    expect(codes).toContain('PDF_TABLE_HEADER_DETECTED');
    // BOM pages collapse into ONE rollup with "80–81".
    const bomDiags = r.diagnostics.filter(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    );
    expect(bomDiags.length).toBe(1);
    expect(bomDiags[0].message).toContain('80–81');
  });
});
