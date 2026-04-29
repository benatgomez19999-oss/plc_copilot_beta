// Sprint 83B — diagnostic-hygiene tests for the non-IO family
// branch. The Sprint 83A `detectIoTables` non-IO branch fired
// once per line, which on real-world 86-page PDFs (the
// `TcECAD_Import_V2_2_x.pdf` manual run) inflated the
// diagnostic stream into hundreds of duplicate per-line
// entries. Sprint 83B adds:
//
//   - `isFooterOrTitleBlockLine` — recognises page footers /
//     title-block metadata, suppresses diagnostics for them.
//   - `passesNonIoFamilyHeaderShapeGate` — requires either ≥ 3
//     strong family tokens OR a canonical family-title regex
//     match (e.g. "Stückliste", "Klemmenplan",
//     "Inhaltsverzeichnis", "Legende").
//   - Signature-based dedup — collapses identical headers
//     within a (sourceId, page, family) tuple to one
//     diagnostic.
//
// Sprint 82/83A safety guarantees stay intact: channel markers
// still don't promote, strict addresses still build IO
// candidates, the PIR builder still refuses unsafe inputs.

import { describe, expect, it } from 'vitest';

import {
  detectIoTables,
  isFooterOrTitleBlockLine,
  nonIoFamilyDiagnosticSignature,
  passesNonIoFamilyHeaderShapeGate,
  classifyPdfTableHeader,
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

// =============================================================================
// isFooterOrTitleBlockLine — pure helper
// =============================================================================

describe('isFooterOrTitleBlockLine (Sprint 83B)', () => {
  it('1. recognises "Datum 22.10.2013 ... Seite" footer line', () => {
    expect(
      isFooterOrTitleBlockLine(
        'Datum 22.10.2013 TcECAD Import V2.2.12 Teileliste Seite',
      ),
    ).toBe(true);
  });

  it('2. recognises "Bearb RAL =CABLE" editor field', () => {
    expect(isFooterOrTitleBlockLine('Bearb RAL =CABLE')).toBe(true);
    expect(isFooterOrTitleBlockLine('Bearb RAL =TERMINAL')).toBe(true);
  });

  it('3. recognises "Änderungsdatum 30.10.2013 von RalfL Anzahl der Seiten 86"', () => {
    expect(
      isFooterOrTitleBlockLine(
        'Änderungsdatum 30.10.2013 von RalfL Anzahl der Seiten 86',
      ),
    ).toBe(true);
  });

  it('4. recognises trailing "Seite N von M" page counters', () => {
    expect(isFooterOrTitleBlockLine('Seite 5 von 10')).toBe(true);
    expect(isFooterOrTitleBlockLine('Seite 5/10')).toBe(true);
  });

  it('5. does NOT match a real BOM canonical header line', () => {
    expect(
      isFooterOrTitleBlockLine(
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
      ),
    ).toBe(false);
  });

  it('6. does NOT match a real IO-list header line', () => {
    expect(isFooterOrTitleBlockLine('Address Tag Description')).toBe(false);
  });

  it('7. defensive on non-string / empty / whitespace input', () => {
    expect(isFooterOrTitleBlockLine(null)).toBe(false);
    expect(isFooterOrTitleBlockLine('')).toBe(false);
    expect(isFooterOrTitleBlockLine('   ')).toBe(false);
  });
});

// =============================================================================
// passesNonIoFamilyHeaderShapeGate — pure helper
// =============================================================================

describe('passesNonIoFamilyHeaderShapeGate (Sprint 83B)', () => {
  it('1. canonical BOM header (Stückliste title) passes', () => {
    const c = classifyPdfTableHeader('Stückliste Benennung Menge Hersteller');
    expect(passesNonIoFamilyHeaderShapeGate(
      'Stückliste Benennung Menge Hersteller',
      c,
    )).toBe(true);
  });

  it('2. real-observed BOM header (≥ 3 strong tokens, ≥ 4 total) passes', () => {
    const text =
      'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer';
    const c = classifyPdfTableHeader(text);
    expect(passesNonIoFamilyHeaderShapeGate(text, c)).toBe(true);
  });

  it('3. weak single-token line "Fabrikat BECKHOFF" is suppressed', () => {
    const c = classifyPdfTableHeader('Fabrikat BECKHOFF');
    expect(passesNonIoFamilyHeaderShapeGate('Fabrikat BECKHOFF', c)).toBe(false);
  });

  it('4. vendor metadata "Hersteller (Firma) Beckhoff Automation GmbH" is suppressed', () => {
    const text = 'Hersteller (Firma) Beckhoff Automation GmbH';
    const c = classifyPdfTableHeader(text);
    expect(passesNonIoFamilyHeaderShapeGate(text, c)).toBe(false);
  });

  it('5. body row "Bearb RAL =CABLE" is suppressed (footer regex catches it before token count)', () => {
    const c = classifyPdfTableHeader('Bearb RAL =CABLE');
    expect(passesNonIoFamilyHeaderShapeGate('Bearb RAL =CABLE', c)).toBe(false);
  });

  it('6. canonical Klemmenplan title passes', () => {
    const c = classifyPdfTableHeader('Klemmenplan Klemme Ziel');
    expect(passesNonIoFamilyHeaderShapeGate(
      'Klemmenplan Klemme Ziel',
      c,
    )).toBe(true);
  });

  it('7. canonical Kabelübersicht title passes', () => {
    const c = classifyPdfTableHeader('Kabelübersicht Kabel Ader Quelle Ziel');
    expect(passesNonIoFamilyHeaderShapeGate(
      'Kabelübersicht Kabel Ader Quelle Ziel',
      c,
    )).toBe(true);
  });

  it('8. bare "Kabel Ader Quelle Ziel" (only 2 strong cable tokens) is suppressed', () => {
    const c = classifyPdfTableHeader('Kabel Ader Quelle Ziel');
    expect(passesNonIoFamilyHeaderShapeGate(
      'Kabel Ader Quelle Ziel',
      c,
    )).toBe(false);
  });

  it('9. defensive on non-string / empty input', () => {
    const c = classifyPdfTableHeader('');
    expect(passesNonIoFamilyHeaderShapeGate(null, c)).toBe(false);
    expect(passesNonIoFamilyHeaderShapeGate('', c)).toBe(false);
  });
});

// =============================================================================
// nonIoFamilyDiagnosticSignature — dedup key normalisation
// =============================================================================

describe('nonIoFamilyDiagnosticSignature (Sprint 83B)', () => {
  it('1. trims + lowercases + collapses whitespace', () => {
    expect(
      nonIoFamilyDiagnosticSignature('  Hello   WORLD  '),
    ).toBe('hello world');
  });

  it('2. caps long signatures at 120 chars', () => {
    const long = 'Lorem '.repeat(50); // ~300 chars
    expect(nonIoFamilyDiagnosticSignature(long).length).toBeLessThanOrEqual(120);
  });

  it('3. defensive on non-string input', () => {
    expect(nonIoFamilyDiagnosticSignature(null)).toBe('');
    expect(nonIoFamilyDiagnosticSignature(123)).toBe('');
  });

  it('4. identical text yields identical signature (dedup-friendly)', () => {
    const a = 'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer';
    const b = 'BENENNUNG  (BMK) Menge   bezeichnung Typnummer Hersteller Artikelnummer';
    expect(nonIoFamilyDiagnosticSignature(a)).toBe(
      nonIoFamilyDiagnosticSignature(b),
    );
  });
});

// =============================================================================
// detectIoTables — Sprint 83B throttling integration
// =============================================================================

describe('detectIoTables — Sprint 83B throttling', () => {
  // ---- A. Footer suppression ----------------------------------------------

  it('A.1. footer "Datum ... Seite" emits NO non-IO family diagnostic', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Datum 22.10.2013 TcECAD Import V2.2.12 Teileliste Seite', 1, 1),
      ],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
    expect(result.tables).toEqual([]);
  });

  it('A.2. "Bearb RAL =CABLE" footer emits NO non-IO family diagnostic', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line('Bearb RAL =CABLE', 1, 1)],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  it('A.3. "Änderungsdatum ... Anzahl der Seiten 86" emits NO non-IO family diagnostic', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line(
          'Änderungsdatum 30.10.2013 von RalfL Anzahl der Seiten 86',
          1,
          1,
        ),
      ],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  // ---- B. Weak single-token suppression -----------------------------------

  it('B.1. "Fabrikat BECKHOFF" emits NO non-IO family diagnostic', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line('Fabrikat BECKHOFF', 1, 1)],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  it('B.2. "Hersteller (Firma) Beckhoff Automation GmbH" emits NO non-IO family diagnostic', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line('Hersteller (Firma) Beckhoff Automation GmbH', 1, 1)],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  it('B.3. "Klemmen " single-token line emits NO non-IO family diagnostic', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line('Klemmen ', 1, 1)],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  // ---- C. BOM canonical header still detected -----------------------------

  it('C.1. real BOM canonical header emits ONE PDF_BOM_TABLE_DETECTED + creates no table', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line(
          'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
          1,
          1,
        ),
      ],
    });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_BOM_TABLE_DETECTED');
    expect(codes).not.toContain('PDF_TABLE_HEADER_DETECTED');
    expect(result.tables).toEqual([]);
  });

  // ---- D. Deduplication ---------------------------------------------------

  it('D.1. same BOM header repeated 5x on the same page collapses to ONE diagnostic', () => {
    const text =
      'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer';
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line(text, 80, 1),
        line(text, 80, 2),
        line(text, 80, 3),
        line(text, 80, 4),
        line(text, 80, 5),
      ],
    });
    const bomDiags = result.diagnostics.filter(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    );
    expect(bomDiags.length).toBe(1);
  });

  it('D.2. same BOM header on two different pages collapses into ONE rollup with the combined range (Sprint 83C)', () => {
    const text =
      'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer';
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line(text, 80, 1), line(text, 81, 1)],
    });
    const bomDiags = result.diagnostics.filter(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    );
    // Sprint 83B emitted one diagnostic per page; Sprint 83C
    // collapses them into one rollup with the consecutive range
    // "80–81". Per-page granularity is preserved inside the
    // message instead of by diagnostic count.
    expect(bomDiags.length).toBe(1);
    expect(bomDiags[0].message).toContain('80–81');
  });

  // ---- E. Body rows with family markers are suppressed --------------------

  it('E.1. "=CABLE&EMB/24 2" body row emits NO non-IO family diagnostic', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line('=CABLE&EMB/24 2', 1, 1)],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  it('E.2. "=TERMINAL&EMA/7 1.1" body row emits NO non-IO family diagnostic', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line('=TERMINAL&EMA/7 1.1', 1, 1)],
    });
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });

  // ---- F. IO-list regression ---------------------------------------------

  it('F.1. real IO-list header still produces a PdfTableCandidate + 2 IO rows', () => {
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
  });
});

// =============================================================================
// ingestPdf — Sprint 83B integration with realistic TcECAD-style fixture
// =============================================================================

describe('ingestPdf — Sprint 83B realistic non-IO page', () => {
  it('1. compact diagnostic stream on a TcECAD-style mixed non-IO page', async () => {
    // Mimics a real TcECAD page-80-ish layout: footer + vendor
    // metadata + canonical BOM header + repeated BOM body rows.
    // Sprint 83B should produce ONE BOM diagnostic for the canonical
    // header, and zero diagnostics for the surrounding noise.
    const text = [
      'Datum 22.10.2013 TcECAD Import V2.2.12 Teileliste Seite',
      'Bearb RAL =CABLE',
      'Hersteller (Firma) Beckhoff Automation GmbH',
      'Fabrikat BECKHOFF',
      'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
      '=CABLE&EMB/24 2',
      '=CABLE&EMB/26 2',
      '=TERMINAL&EMA/7 1.1',
      'Änderungsdatum 30.10.2013 von RalfL Anzahl der Seiten 86',
    ].join('\n');
    const r = await ingestPdf({
      sourceId: 'tcecad-mock',
      fileName: 'tcecad-mock.pdf',
      text,
    });
    const familyCount = familyDiagCount(r.diagnostics);
    // Hard upper bound: at most 2 family diagnostics for this
    // entire mock page (one BOM canonical header). The Sprint
    // 83A baseline was 6+ for the same input.
    expect(familyCount).toBeLessThanOrEqual(2);
    expect(familyCount).toBeGreaterThanOrEqual(1);
    // No IO candidates, no PIR-buildable evidence.
    expect(r.graph.nodes).toEqual([]);
    expect(r.graph.edges).toEqual([]);
  });

  it('2. Sprint 82 channel-marker strictness regression still holds', async () => {
    const r = await ingestPdf({
      sourceId: 'page24',
      fileName: 'page24.pdf',
      text: 'I1 Sensor light barrier',
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

  it('4. mixed BOM page + real IO-list page → 1 BOM diag + IO candidates extracted', async () => {
    const r = await ingestPdf({
      sourceId: 'mixed',
      fileName: 'mixed.pdf',
      text: [
        '--- page 80 ---',
        'Datum 22.10.2013 TcECAD Teileliste Seite',
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
        '--- page 1 ---',
        'Address Tag Description',
        'I0.0 B1 Part present',
        'Q0.0 Y1 Cylinder extend',
      ].join('\n'),
    });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_BOM_TABLE_DETECTED');
    expect(codes).toContain('PDF_TABLE_HEADER_DETECTED');
    // Strict-address path still produces two channels.
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel').length).toBe(2);
    // Footer line did NOT produce its own family diagnostic.
    const bomDiags = codes.filter((c) => c === 'PDF_BOM_TABLE_DETECTED');
    expect(bomDiags.length).toBe(1);
  });
});
