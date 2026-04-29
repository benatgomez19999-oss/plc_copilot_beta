// Sprint 83A — table-family classifier hardening tests.
//
// Background: the Sprint 82 manual run on
// `TcECAD_Import_V2_2_x.pdf` flagged that the Sprint 81 header
// detector treated BOM/material-list headers like
//   "Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer"
// as IO-list-shaped. They satisfied the role floor (`bmk → tag` +
// `bezeichnung → description`) even though there is no
// `address` / `direction` / `signal` column anywhere on the line.
//
// Sprint 83A pins:
//   1. The classifier returns the right family for each
//      representative header.
//   2. The real observed BOM header classifies as
//      `'bom_parts_list'`.
//   3. Sprint 81's IO-list path stays green.
//   4. Non-IO families do NOT emit `PDF_TABLE_HEADER_DETECTED`.
//   5. Sprint 82's PDF address strictness still holds.

import { describe, expect, it } from 'vitest';

import {
  classifyPdfTableHeader,
  detectIoTableHeader,
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

// =============================================================================
// classifyPdfTableHeader — table-driven family resolution
// =============================================================================

describe('classifyPdfTableHeader (Sprint 83A)', () => {
  it('1. classifies "Address Tag Description" as io_list', () => {
    const r = classifyPdfTableHeader('Address Tag Description');
    expect(r.family).toBe('io_list');
    expect(r.roles).toContain('address');
  });

  it('2. classifies "Tag Address Direction Description" as io_list', () => {
    expect(classifyPdfTableHeader('Tag Address Direction Description').family).toBe(
      'io_list',
    );
  });

  it('3. classifies "Signal Eingang Adresse Kommentar" as io_list', () => {
    expect(classifyPdfTableHeader('Signal Eingang Adresse Kommentar').family).toBe(
      'io_list',
    );
  });

  it('4. classifies "E/A Signal Adresse Kommentar" as io_list', () => {
    expect(classifyPdfTableHeader('E/A Signal Adresse Kommentar').family).toBe(
      'io_list',
    );
  });

  it('5. real-observed: "Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer" classifies as bom_parts_list', () => {
    const header =
      'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer';
    const r = classifyPdfTableHeader(header);
    expect(r.family).toBe('bom_parts_list');
    // Reason should mention BOM tokens (Menge / Hersteller / Typnummer
    // / Artikelnummer all hit STRONG_BOM_TOKENS).
    expect(r.reasons.join(' ').toLowerCase()).toContain('bom');
  });

  it('6. classifies "BMK Menge Bezeichnung Hersteller Artikelnummer" as bom_parts_list', () => {
    expect(
      classifyPdfTableHeader('BMK Menge Bezeichnung Hersteller Artikelnummer').family,
    ).toBe('bom_parts_list');
  });

  it('7. classifies "Part number Manufacturer Quantity Description" as bom_parts_list', () => {
    expect(
      classifyPdfTableHeader('Part number Manufacturer Quantity Description').family,
    ).toBe('bom_parts_list');
  });

  it('8. classifies "Klemme Ziel Quelle Anschluss" as terminal_list', () => {
    expect(classifyPdfTableHeader('Klemme Ziel Quelle Anschluss').family).toBe(
      'terminal_list',
    );
  });

  it('9. classifies "Klemmleistenübersicht Klemme Anschluss Ziel" as terminal_list', () => {
    expect(
      classifyPdfTableHeader('Klemmleistenübersicht Klemme Anschluss Ziel').family,
    ).toBe('terminal_list');
  });

  it('10. classifies "Kabel Ader Quelle Ziel" as cable_list', () => {
    // "Quelle"/"Ziel" alone are also terminal hints, but cable
    // strongly wins here because of "Kabel" + "Ader".
    expect(classifyPdfTableHeader('Kabel Ader Quelle Ziel').family).toBe(
      'cable_list',
    );
  });

  it('11. classifies "Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter" as contents_index', () => {
    expect(
      classifyPdfTableHeader(
        'Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter',
      ).family,
    ).toBe('contents_index');
  });

  it('12. classifies "Legende Strukturierungsprinzipien Referenzkennzeichen" as legend', () => {
    expect(
      classifyPdfTableHeader('Legende Strukturierungsprinzipien Referenzkennzeichen')
        .family,
    ).toBe('legend');
  });

  it('13. ambiguous "BMK Bezeichnung" without IO/BOM strong tokens classifies as unknown', () => {
    expect(classifyPdfTableHeader('BMK Bezeichnung').family).toBe('unknown');
  });

  it('14. header with both Address AND Manufacturer prefers bom unless IO has more hits + address role', () => {
    // BOM: 1 (Manufacturer). IO: 1 (Address). Tie → bom wins
    // (Sprint 83A: BOM beats IO unless IO has strictly more hits
    // AND owns the address role).
    expect(
      classifyPdfTableHeader('Address Description Manufacturer Quantity').family,
    ).toBe('bom_parts_list');
  });

  it('15. role extraction is deterministic: roles preserve input order, no duplicates', () => {
    const r = classifyPdfTableHeader('Address Tag Description Address');
    // Roles should be deduplicated across the row.
    expect(r.roles.filter((x) => x === 'address').length).toBe(1);
  });

  it('16. empty / whitespace input returns family=unknown, confidence 0', () => {
    expect(classifyPdfTableHeader('').family).toBe('unknown');
    expect(classifyPdfTableHeader('   ').family).toBe('unknown');
    expect(classifyPdfTableHeader('').confidence).toBe(0);
  });
});

// =============================================================================
// detectIoTableHeader — only IO-list passes through
// =============================================================================

describe('detectIoTableHeader — Sprint 83A family gate', () => {
  it('1. real BOM header returns null (no IO header layout)', () => {
    expect(
      detectIoTableHeader({
        text:
          'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer',
      }),
    ).toBeNull();
  });

  it('2. terminal-list header returns null', () => {
    expect(
      detectIoTableHeader({ text: 'Klemme Ziel Quelle Anschluss' }),
    ).toBeNull();
  });

  it('3. cable-list header returns null', () => {
    expect(detectIoTableHeader({ text: 'Kabel Ader Quelle Ziel' })).toBeNull();
  });

  it('4. contents-index header returns null', () => {
    expect(
      detectIoTableHeader({
        text: 'Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter',
      }),
    ).toBeNull();
  });

  it('5. legend header returns null', () => {
    expect(
      detectIoTableHeader({
        text: 'Legende Strukturierungsprinzipien Referenzkennzeichen',
      }),
    ).toBeNull();
  });

  it('6. real IO-list header still passes through', () => {
    const h = detectIoTableHeader({ text: 'Address Tag Description' });
    expect(h).not.toBeNull();
    expect(h!.columns.some((c) => c.role === 'address')).toBe(true);
  });
});

// =============================================================================
// detectIoTables — non-IO families emit precise diagnostics, no table
// =============================================================================

describe('detectIoTables — Sprint 83A non-IO family diagnostics', () => {
  it('1. BOM header line emits PDF_BOM_TABLE_DETECTED + creates no table', () => {
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
    expect(result.tables).toEqual([]);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_BOM_TABLE_DETECTED');
    expect(codes).not.toContain('PDF_TABLE_HEADER_DETECTED');
  });

  it('2. terminal-list header emits PDF_TERMINAL_TABLE_DETECTED + creates no table', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line('Klemme Ziel Quelle Anschluss', 1, 1)],
    });
    expect(result.tables).toEqual([]);
    expect(
      result.diagnostics.map((d) => d.code),
    ).toContain('PDF_TERMINAL_TABLE_DETECTED');
  });

  it('3. cable-list header (canonical title) emits PDF_CABLE_TABLE_DETECTED + creates no table', () => {
    // Sprint 83B — the bare "Kabel Ader Quelle Ziel" line carries
    // only 2 strong cable tokens, which is now suppressed by the
    // hygiene gate. The canonical "Kabelübersicht …" title still
    // passes the gate (canonical-title regex match).
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line('Kabelübersicht Kabel Ader Quelle Ziel', 1, 1)],
    });
    expect(result.tables).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'PDF_CABLE_TABLE_DETECTED',
    );
  });

  it('4. contents-index header emits PDF_CONTENTS_TABLE_IGNORED + creates no table', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Inhaltsverzeichnis Seitenbeschreibung Datum Bearbeiter', 1, 1),
      ],
    });
    expect(result.tables).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'PDF_CONTENTS_TABLE_IGNORED',
    );
  });

  it('5. legend header emits PDF_LEGEND_TABLE_IGNORED + creates no table', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Legende Strukturierungsprinzipien Referenzkennzeichen', 1, 1),
      ],
    });
    expect(result.tables).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'PDF_LEGEND_TABLE_IGNORED',
    );
  });

  it('6. real IO-list header still creates a table candidate as before', () => {
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
    expect(codes).not.toContain('PDF_BOM_TABLE_DETECTED');
  });

  it('7. duplicate BOM lines on the same page emit a single diagnostic per (family, page, blockId)', () => {
    const bom =
      'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer';
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line(bom, 80, 1),
        line(bom, 80, 1), // same blockId — deduped
      ],
    });
    const bomDiags = result.diagnostics.filter(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    );
    expect(bomDiags.length).toBe(1);
  });

  it('8. BOM lines on different pages collapse into ONE rollup with the combined page range (Sprint 83C)', () => {
    const bom =
      'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer';
    const result = detectIoTables({
      sourceId: 's1',
      lines: [line(bom, 80, 1), line(bom, 81, 1), line(bom, 82, 1)],
    });
    const bomDiags = result.diagnostics.filter(
      (d) => d.code === 'PDF_BOM_TABLE_DETECTED',
    );
    // Sprint 83A emitted one diagnostic per page; Sprint 83C
    // emits one rollup with the consecutive range "80–82".
    expect(bomDiags.length).toBe(1);
    expect(bomDiags[0].message).toContain('80–82');
  });

  it('9. unknown / generic body lines do NOT emit any family diagnostic (noise floor)', () => {
    const result = detectIoTables({
      sourceId: 's1',
      lines: [
        line('Some random paragraph from the schematic.', 1, 1),
        line('Another body line with no IO content.', 1, 2),
      ],
    });
    const familyCodes = [
      'PDF_BOM_TABLE_DETECTED',
      'PDF_TERMINAL_TABLE_DETECTED',
      'PDF_CABLE_TABLE_DETECTED',
      'PDF_CONTENTS_TABLE_IGNORED',
      'PDF_LEGEND_TABLE_IGNORED',
      'PDF_TABLE_HEADER_REJECTED',
    ];
    for (const code of familyCodes) {
      expect(result.diagnostics.map((d) => d.code)).not.toContain(code);
    }
  });
});

// =============================================================================
// ingestPdf — end-to-end with non-IO family pages (text-mode)
// =============================================================================

describe('ingestPdf — Sprint 83A non-IO family pages', () => {
  it('1. text-mode PDF with only a BOM header produces NO IO candidates and emits PDF_BOM_TABLE_DETECTED', async () => {
    const r = await ingestPdf({
      sourceId: 'bom',
      fileName: 'bom.pdf',
      text:
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer\n' +
        'Some part list body line\n',
    });
    expect(r.graph.nodes).toEqual([]);
    expect(r.graph.edges).toEqual([]);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_BOM_TABLE_DETECTED');
    expect(codes).not.toContain('PDF_TABLE_HEADER_DETECTED');
  });

  it('2. mixed PDF: BOM page on top of a real IO-list page → BOM info + IO table both surface', async () => {
    const r = await ingestPdf({
      sourceId: 'mixed',
      fileName: 'mixed.pdf',
      text:
        '--- page 80 ---\n' +
        'Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer\n' +
        '--- page 1 ---\n' +
        'Address Tag Description\n' +
        'I0.0 B1 Part present\n' +
        'Q0.0 Y1 Cylinder extend\n',
    });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_BOM_TABLE_DETECTED');
    expect(codes).toContain('PDF_TABLE_HEADER_DETECTED');
    // Strict-address path still produces real IO candidates.
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel').length).toBe(2);
  });

  it('3. Sprint 82 strictness still holds for channel markers (regression)', async () => {
    const r = await ingestPdf({
      sourceId: 'page24',
      fileName: 'page24.pdf',
      text: 'I1 Sensor light barrier',
    });
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel')).toEqual([]);
  });

  it('4. strict-address text-mode PDF still extracts IO candidates (regression)', async () => {
    const r = await ingestPdf({
      sourceId: 'strict',
      fileName: 'strict.pdf',
      text: 'I0.0 B1 Part present\nQ0.0 Y1 Cylinder extend',
    });
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel').length).toBe(2);
  });
});
