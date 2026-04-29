// Sprint 83D — non-IO rollup canonicalization.
//
// Sprint 83C grouped non-IO family rollups by `(family, signature)`,
// which still produced distinct rollups for numbered TcECAD section
// markers (`=COMPONENTS&EPB/1` vs `/2`) and for the three sibling
// BOM table headers across pages 80–86. Sprint 83D groups by
// `(family, canonical-section-role)` instead so all numbered-marker
// series and sibling header lines collapse into a single rollup.
//
// Pinned contracts:
//   - `normalizeNumberedPdfSectionMarker` strips `/N` / `/N.M`
//     suffixes from canonical TcECAD markers without changing
//     family classification.
//   - `canonicalizeNonIoHeaderRole` returns one stable role per
//     family, with cable + terminal optionally splitting by
//     overview/plan keywords.
//   - `canonicalizeNonIoFamilyRollupKey` is what `detectIoTables`
//     uses internally; same `(family, role)` always produces the
//     same key.
//   - Sprint 83B hygiene gate is unchanged — lines suppressed
//     under 83B stay suppressed under 83D.
//   - Sprint 83A IO-list path NOT regressed.
//   - Sprint 82 channel-marker strictness still holds.

import { describe, expect, it } from 'vitest';

import {
  canonicalizeNonIoFamilyRollupKey,
  canonicalizeNonIoHeaderRole,
  detectIoTables,
  normalizeNumberedPdfSectionMarker,
} from '../src/sources/pdf-table-detect.js';
import type { PdfTableDetectorLine } from '../src/sources/pdf-table-detect.js';
import type { PdfTextBlock } from '../src/sources/pdf-types.js';
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

function familyDiagsByCode(
  diagnostics: ReadonlyArray<{ code: string }>,
  code: string,
): number {
  return diagnostics.filter((d) => d.code === code).length;
}

// =============================================================================
// normalizeNumberedPdfSectionMarker — pure helper
// =============================================================================

describe('normalizeNumberedPdfSectionMarker (Sprint 83D)', () => {
  it('1. recognises =COMPONENTS&EPB/N as bom_parts_list', () => {
    expect(normalizeNumberedPdfSectionMarker('=COMPONENTS&EPB/1')).toEqual({
      marker: 'COMPONENTS_EPB',
      family: 'bom_parts_list',
    });
    expect(normalizeNumberedPdfSectionMarker('=COMPONENTS&EPB/7')).toEqual({
      marker: 'COMPONENTS_EPB',
      family: 'bom_parts_list',
    });
  });

  it('2. recognises =CABLE&EMB/N (incl. /N.M) as cable_list', () => {
    expect(normalizeNumberedPdfSectionMarker('=CABLE&EMB/1')).toEqual({
      marker: 'CABLE_EMB',
      family: 'cable_list',
    });
    expect(normalizeNumberedPdfSectionMarker('=CABLE&EMB/24')).toEqual({
      marker: 'CABLE_EMB',
      family: 'cable_list',
    });
    expect(normalizeNumberedPdfSectionMarker('=CABLE&EMB/3.1')).toEqual({
      marker: 'CABLE_EMB',
      family: 'cable_list',
    });
  });

  it('3. recognises =CONTENTS&EAB / =LEGEND&ETL / =TERMINAL&EMA', () => {
    expect(normalizeNumberedPdfSectionMarker('=CONTENTS&EAB/3')?.family).toBe(
      'contents_index',
    );
    expect(normalizeNumberedPdfSectionMarker('=LEGEND&ETL/6')?.family).toBe(
      'legend',
    );
    expect(normalizeNumberedPdfSectionMarker('=TERMINAL&EMA/7')?.family).toBe(
      'terminal_list',
    );
  });

  it('4. tolerates surrounding text and whitespace', () => {
    expect(
      normalizeNumberedPdfSectionMarker('Page header =CABLE&EMB/12 Kabel')
        ?.family,
    ).toBe('cable_list');
    expect(
      normalizeNumberedPdfSectionMarker('= CABLE & EMB / 12')?.family,
    ).toBe('cable_list');
  });

  it('5. returns null for non-marker text and non-string input', () => {
    expect(normalizeNumberedPdfSectionMarker('Inhaltsverzeichnis')).toBeNull();
    expect(normalizeNumberedPdfSectionMarker('')).toBeNull();
    expect(normalizeNumberedPdfSectionMarker(undefined)).toBeNull();
    expect(normalizeNumberedPdfSectionMarker(123)).toBeNull();
  });
});

// =============================================================================
// canonicalizeNonIoHeaderRole — pure helper
// =============================================================================

describe('canonicalizeNonIoHeaderRole (Sprint 83D)', () => {
  it('1. BOM family always resolves to bom_parts_list role', () => {
    expect(
      canonicalizeNonIoHeaderRole(
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
        'bom_parts_list',
      ),
    ).toBe('bom_parts_list');
    expect(
      canonicalizeNonIoHeaderRole(
        'Teileliste / Stückliste BECKH_P8_Dyn_v2',
        'bom_parts_list',
      ),
    ).toBe('bom_parts_list');
    expect(
      canonicalizeNonIoHeaderRole(
        '=COMPONENTS&EPB/3 Teileliste',
        'bom_parts_list',
      ),
    ).toBe('bom_parts_list');
  });

  it('2. cable family splits overview / plan / index', () => {
    expect(
      canonicalizeNonIoHeaderRole(
        'Kabelübersicht BECKH_P8_Dyn_v2',
        'cable_list',
      ),
    ).toBe('cable_overview');
    expect(
      canonicalizeNonIoHeaderRole('Kabelplan BECKH_P8_Dyn_v3', 'cable_list'),
    ).toBe('cable_plan');
    expect(
      canonicalizeNonIoHeaderRole('=CABLE&EMB/12 Kabel', 'cable_list'),
    ).toBe('cable_index');
  });

  it('3. terminal family splits overview / plan / index', () => {
    expect(
      canonicalizeNonIoHeaderRole(
        'Klemmleistenübersicht BECKH_P8',
        'terminal_list',
      ),
    ).toBe('terminal_overview');
    expect(
      canonicalizeNonIoHeaderRole('Klemmenplan BECKH_P8_Dyn_v2', 'terminal_list'),
    ).toBe('terminal_plan');
    expect(
      canonicalizeNonIoHeaderRole('=TERMINAL&EMA/4 Klemme', 'terminal_list'),
    ).toBe('terminal_index');
  });

  it('4. contents and legend each have a single canonical role', () => {
    expect(
      canonicalizeNonIoHeaderRole(
        'Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter',
        'contents_index',
      ),
    ).toBe('contents_index');
    expect(
      canonicalizeNonIoHeaderRole(
        'Legende Strukturierungsprinzipien Referenzkennzeichen',
        'legend',
      ),
    ).toBe('legend');
  });

  it('5. unknown / io_list families yield null', () => {
    expect(canonicalizeNonIoHeaderRole('anything', 'unknown')).toBeNull();
    expect(canonicalizeNonIoHeaderRole('anything', 'io_list')).toBeNull();
  });
});

// =============================================================================
// canonicalizeNonIoFamilyRollupKey — composed key
// =============================================================================

describe('canonicalizeNonIoFamilyRollupKey (Sprint 83D)', () => {
  it('1. numbered BOM markers + BOM table headers share one canonical key', () => {
    const k1 = canonicalizeNonIoFamilyRollupKey({
      family: 'bom_parts_list',
      text: '=COMPONENTS&EPB/1 Teileliste',
    });
    const k2 = canonicalizeNonIoFamilyRollupKey({
      family: 'bom_parts_list',
      text: '=COMPONENTS&EPB/7 Teileliste',
    });
    const k3 = canonicalizeNonIoFamilyRollupKey({
      family: 'bom_parts_list',
      text: 'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
    });
    expect(k1.key).toBe(k2.key);
    expect(k1.key).toBe(k3.key);
    expect(k1.role).toBe('bom_parts_list');
  });

  it('2. cable overview vs cable plan have different keys (intentional split)', () => {
    const overview = canonicalizeNonIoFamilyRollupKey({
      family: 'cable_list',
      text: 'Kabelübersicht BECKH_P8_Dyn_v2',
    });
    const plan = canonicalizeNonIoFamilyRollupKey({
      family: 'cable_list',
      text: 'Kabelplan BECKH_P8_Dyn_v3',
    });
    expect(overview.key).not.toBe(plan.key);
    expect(overview.role).toBe('cable_overview');
    expect(plan.role).toBe('cable_plan');
  });

  it('3. all numbered =CABLE&EMB/N entries collapse to one key', () => {
    const keys = [1, 2, 3, 12, 24].map((n) =>
      canonicalizeNonIoFamilyRollupKey({
        family: 'cable_list',
        text: `=CABLE&EMB/${n} Kabel`,
      }).key,
    );
    expect(new Set(keys).size).toBe(1);
  });
});

// =============================================================================
// detectIoTables — Sprint 83D rollup integration
// =============================================================================

describe('detectIoTables — Sprint 83D rollup canonicalization', () => {
  // Test 1 — Numbered BOM components collapse to ONE rollup.
  it('1. =COMPONENTS&EPB/1..7 lines emit ONE BOM rollup, not seven', () => {
    const lines: PdfTableDetectorLine[] = [];
    for (let n = 1; n <= 7; n++) {
      lines.push(
        line(
          `=COMPONENTS&EPB/${n} Teileliste BECKH_P8_Dyn_v2`,
          79 + n,
          1,
        ),
      );
    }
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(familyDiagsByCode(result.diagnostics, 'PDF_BOM_TABLE_DETECTED')).toBe(
      1,
    );
    const bom = result.diagnostics.find(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    )!;
    expect(bom.message).toContain('80–86');
  });

  // Test 2 — Numbered cable EMB entries collapse.
  it('2. =CABLE&EMB/1..24 with Kabelplan emit ONE cable rollup', () => {
    const lines: PdfTableDetectorLine[] = [];
    for (let n = 1; n <= 24; n++) {
      lines.push(line(`=CABLE&EMB/${n} Kabelplan BECKH_P8_Dyn_v3`, 50 + n, 1));
    }
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(
      familyDiagsByCode(result.diagnostics, 'PDF_CABLE_TABLE_DETECTED'),
    ).toBe(1);
    const cable = result.diagnostics.find(
      (d) => d.code === 'PDF_CABLE_TABLE_DETECTED',
    )!;
    expect(cable.message).toContain('51–74');
  });

  // Test 3 — Contents EAB entries collapse.
  it('3. =CONTENTS&EAB/1..3 with Inhaltsverzeichnis emit ONE contents rollup', () => {
    const lines: PdfTableDetectorLine[] = [
      line(
        '=CONTENTS&EAB/1 Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter',
        2,
        1,
      ),
      line(
        '=CONTENTS&EAB/2 Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter',
        3,
        1,
      ),
      line(
        '=CONTENTS&EAB/3 Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter',
        4,
        1,
      ),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(
      familyDiagsByCode(result.diagnostics, 'PDF_CONTENTS_TABLE_IGNORED'),
    ).toBe(1);
    const contents = result.diagnostics.find(
      (d) => d.code === 'PDF_CONTENTS_TABLE_IGNORED',
    )!;
    expect(contents.message).toContain('2–4');
  });

  // Test 4 — Legend ETL entries collapse.
  it('4. =LEGEND&ETL/1..6 with Legende emit ONE legend rollup', () => {
    const lines: PdfTableDetectorLine[] = [];
    for (let n = 1; n <= 6; n++) {
      lines.push(
        line(
          `=LEGEND&ETL/${n} Legende Strukturierungsprinzipien Referenzkennzeichen`,
          5 + n,
          1,
        ),
      );
    }
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(
      familyDiagsByCode(result.diagnostics, 'PDF_LEGEND_TABLE_IGNORED'),
    ).toBe(1);
    const legend = result.diagnostics.find(
      (d) => d.code === 'PDF_LEGEND_TABLE_IGNORED',
    )!;
    expect(legend.message).toContain('6–11');
  });

  // Test 5 — Terminal EMA entries collapse.
  it('5. =TERMINAL&EMA/1..7 with Klemmenplan emit ONE terminal rollup', () => {
    const lines: PdfTableDetectorLine[] = [];
    for (let n = 1; n <= 7; n++) {
      lines.push(
        line(
          `=TERMINAL&EMA/${n} Klemmenplan BECKH_P8_Dyn_v2`,
          48 + n,
          1,
        ),
      );
    }
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(
      familyDiagsByCode(result.diagnostics, 'PDF_TERMINAL_TABLE_DETECTED'),
    ).toBe(1);
    const terminal = result.diagnostics.find(
      (d) => d.code === 'PDF_TERMINAL_TABLE_DETECTED',
    )!;
    expect(terminal.message).toContain('49–55');
  });

  // Test 6 — Sibling BOM table headers across same page series.
  it('6. three sibling BOM headers across pages 80–82 emit ONE BOM rollup', () => {
    const lines: PdfTableDetectorLine[] = [
      line('Teileliste / Stückliste BECKH_P8_Dyn_v2', 80, 1),
      line(
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
        80,
        2,
      ),
      line('Teileliste / Stückliste BECKH_P8_Dyn_v2', 81, 1),
      line(
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
        81,
        2,
      ),
      line('Teileliste / Stückliste BECKH_P8_Dyn_v2', 82, 1),
      line(
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
        82,
        2,
      ),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(
      familyDiagsByCode(result.diagnostics, 'PDF_BOM_TABLE_DETECTED'),
    ).toBe(1);
    const bom = result.diagnostics.find(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    )!;
    expect(bom.message).toContain('80–82');
  });

  // Test 7 — Cable overview vs cable plan stay distinct.
  it('7. Kabelübersicht (55–56) and Kabelplan (57–60) stay as TWO rollups', () => {
    const lines: PdfTableDetectorLine[] = [
      line('Kabelübersicht BECKH_P8_Dyn_v2', 55, 1),
      line('Kabelübersicht BECKH_P8_Dyn_v2', 56, 1),
      line('Kabelplan BECKH_P8_Dyn_v3', 57, 1),
      line('Kabelplan BECKH_P8_Dyn_v3', 58, 1),
      line('Kabelplan BECKH_P8_Dyn_v3', 59, 1),
      line('Kabelplan BECKH_P8_Dyn_v3', 60, 1),
    ];
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(
      familyDiagsByCode(result.diagnostics, 'PDF_CABLE_TABLE_DETECTED'),
    ).toBe(2);
    const cableMessages = result.diagnostics
      .filter((d) => d.code === 'PDF_CABLE_TABLE_DETECTED')
      .map((d) => d.message);
    // One message references the overview span, one the plan span.
    expect(cableMessages.some((m) => m.includes('55–56'))).toBe(true);
    expect(cableMessages.some((m) => m.includes('57–60'))).toBe(true);
  });

  // Test 8 — Terminal plan pages collapse.
  it('8. Klemmenplan pages 49–54 collapse to ONE terminal rollup', () => {
    const lines: PdfTableDetectorLine[] = [49, 50, 51, 52, 53, 54].map((p) =>
      line('Klemmenplan BECKH_P8_Dyn_v2', p, 1),
    );
    const result = detectIoTables({ sourceId: 's1', lines });
    expect(
      familyDiagsByCode(result.diagnostics, 'PDF_TERMINAL_TABLE_DETECTED'),
    ).toBe(1);
    const terminal = result.diagnostics.find(
      (d) => d.code === 'PDF_TERMINAL_TABLE_DETECTED',
    )!;
    expect(terminal.message).toContain('49–54');
  });

  // Test 9 — Sprint 83B footer suppression preserved.
  it('9. footer / title-block lines still suppress (zero family rollups)', () => {
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

  // Test 10 — Strict IO-list path NOT regressed.
  it('10. strict IO-list path still produces a real PDF table candidate', () => {
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
    expect(familyDiagCount(result.diagnostics)).toBe(0);
  });
});

// =============================================================================
// ingestPdf — cross-page integration through the real pipeline
// =============================================================================

describe('ingestPdf — Sprint 83D realistic TcECAD-shaped fixture', () => {
  // Test 11 — Sprint 82 channel-marker strictness preserved.
  it('11. channel-marker strictness still holds (no buildable %I1)', async () => {
    const r = await ingestPdf({
      sourceId: 'page24',
      fileName: 'page24.pdf',
      text: 'I1 Sensor light barrier\n%I1\nO2 Valve',
    });
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel')).toEqual([]);
  });

  // Test 12 — Cross-page integration: numbered cable markers across pages.
  it('12. =CABLE&EMB/N markers across pages 3–4 emit ONE cable rollup with "3–4"', async () => {
    const text = [
      '--- page 3 ---',
      '=CABLE&EMB/1 Kabelplan BECKH_P8_Dyn_v3',
      '--- page 4 ---',
      '=CABLE&EMB/24 Kabelplan BECKH_P8_Dyn_v3',
    ].join('\n');
    const r = await ingestPdf({
      sourceId: 'tcecad-mini',
      fileName: 'tcecad-mini.pdf',
      text,
    });
    expect(familyDiagsByCode(r.diagnostics, 'PDF_CABLE_TABLE_DETECTED')).toBe(1);
    const cable = r.diagnostics.find(
      (d) => d.code === 'PDF_CABLE_TABLE_DETECTED',
    )!;
    expect(cable.message).toContain('3–4');
  });

  // Test 13 — Full TcECAD-shape mock: hard <= 12 cap on family rollups.
  it('13. realistic TcECAD shape stays under the 12-rollup hard cap', async () => {
    const lines: string[] = [];
    // Contents pages 2–4 with numbered EAB markers + canonical title.
    for (let p = 2; p <= 4; p++) {
      lines.push(`--- page ${p} ---`);
      lines.push(
        `=CONTENTS&EAB/${p - 1} Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter`,
      );
    }
    // Terminal plan pages 49–54 with numbered EMA markers + Klemmenplan.
    for (let p = 49; p <= 54; p++) {
      lines.push(`--- page ${p} ---`);
      lines.push(`=TERMINAL&EMA/${p - 48} Klemmenplan BECKH_P8_Dyn_v2`);
    }
    // Cable overview pages 55–56.
    for (let p = 55; p <= 56; p++) {
      lines.push(`--- page ${p} ---`);
      lines.push(`Kabelübersicht BECKH_P8_Dyn_v2`);
    }
    // Cable plan pages 57–79 with numbered EMB markers + Kabelplan.
    for (let p = 57; p <= 79; p++) {
      lines.push(`--- page ${p} ---`);
      lines.push(`=CABLE&EMB/${p - 56} Kabelplan BECKH_P8_Dyn_v3`);
    }
    // BOM pages 80–86 with numbered EPB markers + Teileliste + canonical
    // header.
    for (let p = 80; p <= 86; p++) {
      lines.push(`--- page ${p} ---`);
      lines.push(`=COMPONENTS&EPB/${p - 79} Teileliste BECKH_P8_Dyn_v2`);
      lines.push(
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
      );
    }
    // Footer / vendor metadata noise on the last page.
    lines.push('Datum 22.10.2013 TcECAD Import V2.2.12 Teileliste Seite');
    lines.push('Bearb RAL =CABLE');

    const r = await ingestPdf({
      sourceId: 'tcecad-full',
      fileName: 'tcecad-full.pdf',
      text: lines.join('\n'),
    });

    const familyCount = familyDiagCount(r.diagnostics);
    // Hard target: <= 12 family rollups. Prefer 5 (BOM, cable
    // overview, cable plan, contents, terminal). Verify we are
    // well within the cap.
    expect(familyCount).toBeLessThanOrEqual(12);

    // Each canonical group emits exactly one rollup.
    expect(familyDiagsByCode(r.diagnostics, 'PDF_BOM_TABLE_DETECTED')).toBe(1);
    expect(familyDiagsByCode(r.diagnostics, 'PDF_CONTENTS_TABLE_IGNORED')).toBe(
      1,
    );
    expect(
      familyDiagsByCode(r.diagnostics, 'PDF_TERMINAL_TABLE_DETECTED'),
    ).toBe(1);
    // Cable splits into overview and plan — two rollups.
    expect(familyDiagsByCode(r.diagnostics, 'PDF_CABLE_TABLE_DETECTED')).toBe(
      2,
    );

    // Page-range message coverage.
    const findDiag = (code: string) =>
      r.diagnostics.find((d) => d.code === code);
    expect(findDiag('PDF_CONTENTS_TABLE_IGNORED')?.message).toContain('2–4');
    expect(findDiag('PDF_TERMINAL_TABLE_DETECTED')?.message).toContain('49–54');
    expect(findDiag('PDF_BOM_TABLE_DETECTED')?.message).toContain('80–86');
    const cableMessages = r.diagnostics
      .filter((d) => d.code === 'PDF_CABLE_TABLE_DETECTED')
      .map((d) => d.message);
    expect(cableMessages.some((m) => m.includes('55–56'))).toBe(true);
    expect(cableMessages.some((m) => m.includes('57–79'))).toBe(true);

    // No IO candidates extracted from a non-IO TcECAD PDF.
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel')).toEqual([]);
  });

  // Sprint 83F — full per-occurrence drilldown threading.
  it('13b. multi-page rollup carries one additionalSourceRef per non-representative page (Sprint 83F)', async () => {
    const text = [
      '--- page 80 ---',
      '=COMPONENTS&EPB/1 Teileliste BECKH_P8_Dyn_v2',
      '--- page 81 ---',
      '=COMPONENTS&EPB/2 Teileliste BECKH_P8_Dyn_v2',
      '--- page 82 ---',
      '=COMPONENTS&EPB/3 Teileliste BECKH_P8_Dyn_v2',
    ].join('\n');
    const r = await ingestPdf({
      sourceId: 'tcecad-mini',
      fileName: 'tcecad-mini.pdf',
      text,
    });
    const bom = r.diagnostics.find(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    )!;
    expect(bom).toBeDefined();
    expect(bom.sourceRef?.kind).toBe('pdf');
    expect(bom.sourceRef?.page).toBe('80');
    // Sprint 83F threads page 81 + 82 onto the diagnostic so the
    // operator UI can render per-page evidence without re-walking
    // the document.
    expect(bom.additionalSourceRefs?.length).toBe(2);
    const additionalPages = (bom.additionalSourceRefs ?? []).map(
      (ref) => ref.page,
    );
    expect(additionalPages).toEqual(['81', '82']);
    // Each additional ref carries its own snippet + bbox per page,
    // not just a page number — the projection is full evidence.
    const a81 = bom.additionalSourceRefs?.[0];
    expect(a81?.snippet).toContain('=COMPONENTS&EPB/2');
    expect(a81?.symbol).toBeDefined();
  });

  it('13c. single-page rollup omits additionalSourceRefs (no empty array noise)', async () => {
    const r = await ingestPdf({
      sourceId: 'single',
      fileName: 'single.pdf',
      text: [
        '--- page 3 ---',
        '=CONTENTS&EAB/1 Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter',
      ].join('\n'),
    });
    const contents = r.diagnostics.find(
      (d) => d.code === 'PDF_CONTENTS_TABLE_IGNORED',
    )!;
    expect(contents).toBeDefined();
    expect(contents.sourceRef?.page).toBe('3');
    expect(contents.additionalSourceRefs).toBeUndefined();
  });

  // Test 14 — Mixed strict-address PDF + canonicalized rollup keep IO path.
  it('14. mixed strict-address PDF + numbered BOM keeps 2 IO + 1 BOM rollup', async () => {
    const text = [
      '--- page 80 ---',
      '=COMPONENTS&EPB/1 Teileliste BECKH_P8_Dyn_v2',
      'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
      '--- page 81 ---',
      '=COMPONENTS&EPB/2 Teileliste BECKH_P8_Dyn_v2',
      '--- page 1 ---',
      'Address Tag Description',
      'I0.0 B1 Part present',
      'Q0.0 Y1 Cylinder extend',
    ].join('\n');
    const r = await ingestPdf({
      sourceId: 'mixed',
      fileName: 'mixed.pdf',
      text,
    });
    // IO path: 2 channels.
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel').length).toBe(
      2,
    );
    // BOM path: 1 rollup spanning pages 80–81.
    expect(familyDiagsByCode(r.diagnostics, 'PDF_BOM_TABLE_DETECTED')).toBe(1);
    const bom = r.diagnostics.find((d) => d.code === 'PDF_BOM_TABLE_DETECTED')!;
    expect(bom.message).toContain('80–81');
  });
});
