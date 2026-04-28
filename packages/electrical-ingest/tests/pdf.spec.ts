// Sprint 79 — PDF ingestion architecture v0. Tests pin every load-
// bearing invariant: source detection, the test-mode text parser,
// the honest binary stub, conservative IO-row extraction, registry
// routing, and PirDraftCandidate compatibility (so the review/
// persist/export pipeline from Sprints 75–78B carries through).

import { describe, expect, it } from 'vitest';

import {
  buildPirDraftCandidate,
  createDefaultSourceRegistry,
  ingestWithRegistry,
} from '../src/index.js';
import {
  buildPdfGraphId,
  createPdfElectricalIngestor,
  detectPdf,
  ingestPdf,
  parsePdfDocument,
} from '../src/sources/pdf.js';

const PDF_HEADER_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

function pdfBytes(extra: string = ''): Uint8Array {
  const enc = new TextEncoder();
  const tail = enc.encode(extra);
  const out = new Uint8Array(PDF_HEADER_BYTES.length + tail.length);
  out.set(PDF_HEADER_BYTES, 0);
  out.set(tail, PDF_HEADER_BYTES.length);
  return out;
}

const SIMPLE_TEXT_PDF = `--- page 1 ---
I0.0 B1 Part present
Q0.0 Y1 Cylinder extend

--- page 2 ---
Q0.1 M1 Conveyor motor
notes about wiring
`;

// -----------------------------------------------------------------------------
// detectPdf
// -----------------------------------------------------------------------------

describe('detectPdf', () => {
  it('1. detects via .pdf extension on path', () => {
    expect(detectPdf({ path: 'plan.pdf', kind: 'unknown' })).toBe(true);
    expect(detectPdf({ path: 'PLAN.PDF', kind: 'unknown' })).toBe(true);
  });

  it('2. detects via declared kind: "pdf"', () => {
    expect(detectPdf({ path: 'no-extension', kind: 'pdf' })).toBe(true);
  });

  it('3. detects via %PDF- header on Uint8Array content', () => {
    expect(
      detectPdf({ path: 'no-ext', kind: 'unknown', content: pdfBytes() }),
    ).toBe(true);
  });

  it('4. detects via %PDF- header on string content', () => {
    expect(
      detectPdf({ path: 'no-ext', kind: 'unknown', content: '%PDF-1.7\n…' }),
    ).toBe(true);
  });

  it('5. rejects null / non-object / non-pdf shapes', () => {
    expect(detectPdf(null)).toBe(false);
    expect(detectPdf(undefined)).toBe(false);
    expect(detectPdf({ path: 'a.csv', kind: 'csv' })).toBe(false);
    expect(detectPdf({ path: 'a.xml', kind: 'xml' })).toBe(false);
  });

  it('6. rejects bytes that do not start with %PDF-', () => {
    expect(
      detectPdf({
        path: 'mystery',
        kind: 'unknown',
        content: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      }),
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// parsePdfDocument — test-mode text path
// -----------------------------------------------------------------------------

describe('parsePdfDocument — test-mode text path', () => {
  it('1. returns PDF_EMPTY_INPUT on empty / undefined text', () => {
    const r = parsePdfDocument({ sourceId: 's1' });
    expect(r.diagnostics.some((d) => d.code === 'PDF_EMPTY_INPUT')).toBe(true);
    expect(r.document.pages).toEqual([]);
  });

  it('2. splits "--- page N ---" delimiters into pages', () => {
    const r = parsePdfDocument({ sourceId: 's1', text: SIMPLE_TEXT_PDF });
    expect(r.document.pages.length).toBe(2);
    expect(r.document.pages[0].pageNumber).toBe(1);
    expect(r.document.pages[1].pageNumber).toBe(2);
  });

  it('3. treats leading body without a delimiter as page 1', () => {
    const r = parsePdfDocument({
      sourceId: 's1',
      text: 'just some text\nwith no delimiter',
    });
    expect(r.document.pages.length).toBe(1);
    expect(r.document.pages[0].pageNumber).toBe(1);
    expect(r.document.pages[0].textBlocks.length).toBe(2);
  });

  it('4. produces deterministic block ids of the form pdf:<sourceId>:p<page>:b<index>', () => {
    const r = parsePdfDocument({ sourceId: 's1', text: SIMPLE_TEXT_PDF });
    const ids = r.document.pages
      .flatMap((p) => p.textBlocks)
      .map((b) => b.id);
    expect(ids).toContain('pdf:s1:p1:b1');
    expect(ids).toContain('pdf:s1:p1:b2');
    expect(ids).toContain('pdf:s1:p2:b1');
  });

  it('5. attaches a SourceRef with kind "pdf", page, line, snippet, symbol', () => {
    const r = parsePdfDocument({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text: SIMPLE_TEXT_PDF,
    });
    const block = r.document.pages[0].textBlocks[0];
    expect(block.sourceRef.kind).toBe('pdf');
    expect(block.sourceRef.path).toBe('plan.pdf');
    expect(block.sourceRef.page).toBe('1');
    expect(typeof block.sourceRef.line).toBe('number');
    expect(block.sourceRef.snippet).toBe(block.text);
    expect(block.sourceRef.symbol).toMatch(/^pdf:page:1\/line:\d+$/);
  });

  it('6. confidence is in [0,1] and is higher for IO-pattern lines', () => {
    const r = parsePdfDocument({ sourceId: 's1', text: SIMPLE_TEXT_PDF });
    for (const p of r.document.pages) {
      for (const b of p.textBlocks) {
        expect(b.confidence).toBeGreaterThanOrEqual(0);
        expect(b.confidence).toBeLessThanOrEqual(1);
      }
    }
    const ioBlock = r.document.pages[0].textBlocks[0];
    const noteBlock = r.document.pages[1].textBlocks[1];
    expect(ioBlock.confidence).toBeGreaterThan(noteBlock.confidence);
  });

  it('7. emits PDF_TEXT_BLOCK_EXTRACTED + PDF_TABLE_DETECTION_NOT_IMPLEMENTED', () => {
    const r = parsePdfDocument({ sourceId: 's1', text: SIMPLE_TEXT_PDF });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_TEXT_BLOCK_EXTRACTED');
    expect(codes).toContain('PDF_TABLE_DETECTION_NOT_IMPLEMENTED');
  });

  it('8. emits PDF_NO_TEXT_BLOCKS when input has only whitespace', () => {
    const r = parsePdfDocument({ sourceId: 's1', text: '   \n\n  \n' });
    expect(r.diagnostics.some((d) => d.code === 'PDF_NO_TEXT_BLOCKS')).toBe(true);
  });

  it('9. tableCandidates is always [] in v0', () => {
    const r = parsePdfDocument({ sourceId: 's1', text: SIMPLE_TEXT_PDF });
    for (const p of r.document.pages) expect(p.tableCandidates).toEqual([]);
  });

  it('10. respects maxPages and emits PDF_PAGE_LIMIT_EXCEEDED', () => {
    const text = ['--- page 1 ---', 'a', '--- page 2 ---', 'b', '--- page 3 ---', 'c'].join(
      '\n',
    );
    const r = parsePdfDocument({
      sourceId: 's1',
      text,
      options: { maxPages: 2 },
    });
    expect(r.document.pages.length).toBe(2);
    expect(
      r.diagnostics.some((d) => d.code === 'PDF_PAGE_LIMIT_EXCEEDED'),
    ).toBe(true);
  });

  it('11. PDF_OCR_NOT_ENABLED info is raised when allowOcr=true', () => {
    const r = parsePdfDocument({
      sourceId: 's1',
      text: SIMPLE_TEXT_PDF,
      options: { allowOcr: true },
    });
    expect(r.diagnostics.some((d) => d.code === 'PDF_OCR_NOT_ENABLED')).toBe(true);
  });

  it('12. blank lines do not become text blocks but advance line numbers', () => {
    const r = parsePdfDocument({
      sourceId: 's1',
      text: 'first line\n\n\nfourth line',
    });
    const blocks = r.document.pages[0].textBlocks;
    expect(blocks.length).toBe(2);
    // Line numbers reflect the 1-based source line, not the block index.
    expect(blocks[0].sourceRef.line).toBe(1);
    expect(blocks[1].sourceRef.line).toBe(4);
  });
});

// -----------------------------------------------------------------------------
// ingestPdf — bytes path (Sprint 80: real text-layer extraction)
//
// Sprint 79's `validateBytes` stub emitted PDF_UNSUPPORTED_BINARY_PARSER
// + PDF_TEXT_LAYER_UNAVAILABLE for any valid-header byte string.
// Sprint 80 replaces that stub with `pdfjs-dist`, so:
//   - obviously-not-a-PDF bytes still raise PDF_MALFORMED (header
//     check is in front of the extractor);
//   - byte strings that pass the header check but aren't a parseable
//     PDF body raise PDF_TEXT_LAYER_EXTRACTION_FAILED;
//   - real PDFs with selectable text are exercised in
//     pdf-text-layer.spec.ts (this file's text-mode block stays).
// -----------------------------------------------------------------------------

describe('ingestPdf — bytes path (Sprint 80 — real extractor)', () => {
  it('1. emits PDF_MALFORMED when bytes do not start with %PDF-', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'broken.pdf',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    });
    expect(r.diagnostics.some((d) => d.code === 'PDF_MALFORMED')).toBe(true);
    expect(r.graph.nodes).toEqual([]);
    expect(r.graph.edges).toEqual([]);
  });

  it('2. emits PDF_TEXT_LAYER_EXTRACTION_FAILED for a header-only stub body', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'real.pdf',
      bytes: pdfBytes('1.7\n%body…'),
    });
    const codes = r.diagnostics.map((d) => d.code);
    // The Sprint 79 stub-only codes are gone; the real extractor
    // surfaces an extraction-failed diagnostic instead.
    expect(codes).toContain('PDF_TEXT_LAYER_EXTRACTION_FAILED');
    expect(codes).not.toContain('PDF_UNSUPPORTED_BINARY_PARSER');
    expect(codes).not.toContain('PDF_TEXT_LAYER_UNAVAILABLE');
  });

  it('3. emits PDF_TEXT_LAYER_EXTRACTION_FAILED on a non-parseable body even when the literal /Encrypt sub-string is present', async () => {
    // Sprint 79's substring sniff is gone; pdfjs-dist owns
    // encryption detection now and only flags real
    // PasswordException-bearing PDFs. A garbage body containing
    // "/Encrypt" is just garbage to the real parser.
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'encrypted-shaped.pdf',
      bytes: pdfBytes('1.7\nblah /Encrypt 1 0 R\n…'),
    });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_TEXT_LAYER_EXTRACTION_FAILED');
    expect(r.document.metadata?.encrypted).toBeUndefined();
  });

  it('4. emits PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED on bytes-only input that fails to parse', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'x.pdf',
      bytes: pdfBytes('1.7'),
    });
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED',
      ),
    ).toBe(true);
  });

  it('5. NEVER throws on malformed input', async () => {
    await expect(
      ingestPdf({ sourceId: 's1', bytes: new Uint8Array(0) }),
    ).resolves.toBeDefined();
    await expect(ingestPdf(null as never)).resolves.toBeDefined();
    await expect(ingestPdf({ sourceId: 's1' })).resolves.toBeDefined();
  });

  it('6. graph carries sourceKind: "pdf"', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'real.pdf',
      bytes: pdfBytes('1.7'),
    });
    expect(r.graph.sourceKind).toBe('pdf');
    expect(r.graph.id).toBe(buildPdfGraphId({ sourceId: 's1' }));
  });
});

// -----------------------------------------------------------------------------
// ingestPdf — text-mode IO-row extraction (deterministic, low-confidence)
// -----------------------------------------------------------------------------

describe('ingestPdf — text-mode IO-row extraction', () => {
  it('1. extracts simple "<address> <tag> <label>" rows into nodes + edges', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text: SIMPLE_TEXT_PDF,
    });
    expect(r.graph.nodes.length).toBeGreaterThan(0);
    expect(r.graph.edges.length).toBeGreaterThan(0);
    const channelNodes = r.graph.nodes.filter((n) => n.kind === 'plc_channel');
    expect(channelNodes.length).toBe(3); // %I0.0, %Q0.0, %Q0.1
  });

  it('2. infers input direction from %I addresses → "signals" edge', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text: '--- page 1 ---\nI0.0 B1 Part present\n',
    });
    const edge = r.graph.edges[0];
    expect(edge.kind).toBe('signals');
    // Device → channel for inputs.
    expect(edge.from.startsWith('pdf_device:')).toBe(true);
    expect(edge.to.startsWith('plc_channel:')).toBe(true);
  });

  it('3. infers output direction from %Q addresses → "drives" edge', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text: '--- page 1 ---\nQ0.1 M1 Conveyor motor\n',
    });
    const edge = r.graph.edges[0];
    expect(edge.kind).toBe('drives');
    expect(edge.from.startsWith('plc_channel:')).toBe(true);
    expect(edge.to.startsWith('pdf_device:')).toBe(true);
  });

  it('4. every node + edge carries a SourceRef with kind "pdf" and a page', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text: SIMPLE_TEXT_PDF,
    });
    for (const n of r.graph.nodes) {
      expect(n.sourceRefs.length).toBeGreaterThan(0);
      expect(n.sourceRefs[0].kind).toBe('pdf');
      expect(typeof n.sourceRefs[0].page).toBe('string');
    }
    for (const e of r.graph.edges) {
      expect(e.sourceRefs[0].kind).toBe('pdf');
    }
  });

  it('5. confidence on PDF-derived nodes never exceeds 0.65', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text: SIMPLE_TEXT_PDF,
    });
    for (const n of r.graph.nodes) {
      expect(n.confidence.score).toBeLessThanOrEqual(0.65);
    }
  });

  it('6. emits PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED when no IO rows match', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'narrative.pdf',
      text: 'this is just a paragraph with no IO list inside it.',
    });
    expect(
      r.diagnostics.some(
        (d) => d.code === 'PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED',
      ),
    ).toBe(true);
    expect(r.graph.nodes).toEqual([]);
    expect(r.graph.edges).toEqual([]);
  });

  it('7. Sprint 80 — text fallback runs when bytes fail to parse and text is supplied', async () => {
    // Sprint 79 emitted PDF_UNSUPPORTED_BINARY_PARSER + PDF_TEXT_BLOCK_EXTRACTED
    // here. Sprint 80's real extractor fails on a header-only stub, so
    // we instead expect PDF_TEXT_LAYER_EXTRACTION_FAILED + the text-mode
    // fallback's PDF_TEXT_BLOCK_EXTRACTED.
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'mixed.pdf',
      bytes: pdfBytes('1.7'),
      text: '--- page 1 ---\nI0.0 B1 Part present\n',
    });
    expect(r.graph.nodes.length).toBeGreaterThan(0);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_TEXT_LAYER_EXTRACTION_FAILED');
    expect(codes).toContain('PDF_TEXT_BLOCK_EXTRACTED');
    // Sprint 79 stub codes are no longer emitted.
    expect(codes).not.toContain('PDF_UNSUPPORTED_BINARY_PARSER');
    expect(codes).not.toContain('PDF_TEXT_LAYER_UNAVAILABLE');
  });

  it('8. inferred device kind matches label hints (sensor / motor / valve)', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text:
        '--- page 1 ---\nI0.0 B1 sensor part present\nQ0.0 Y1 valve cylinder extend\nQ0.1 M1 motor conveyor\n',
    });
    const devices = r.graph.nodes.filter((n) =>
      n.id.startsWith('pdf_device:'),
    );
    const kinds = new Set(devices.map((d) => d.kind));
    expect(kinds.has('sensor')).toBe(true);
    expect(kinds.has('valve')).toBe(true);
    expect(kinds.has('motor')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// PIR draft candidate from PDF graph
// -----------------------------------------------------------------------------

describe('PDF → PirDraftCandidate', () => {
  it('1. produces a PirDraftCandidate from a simple text PDF', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text: SIMPLE_TEXT_PDF,
    });
    const candidate = buildPirDraftCandidate(r.graph);
    expect(candidate).toBeDefined();
    expect(candidate.io.length).toBeGreaterThan(0);
  });

  it('2. PDF SourceRefs (page, snippet, symbol) survive into the candidate', async () => {
    const r = await ingestPdf({
      sourceId: 's1',
      fileName: 'plan.pdf',
      text: SIMPLE_TEXT_PDF,
    });
    const candidate = buildPirDraftCandidate(r.graph);
    const ref = candidate.io[0]?.sourceRefs[0];
    expect(ref).toBeDefined();
    expect(ref!.kind).toBe('pdf');
    expect(ref!.page).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// Registry routing
// -----------------------------------------------------------------------------

describe('PDF + default registry', () => {
  it('1. default registry resolves a .pdf file to the PDF ingestor', async () => {
    const reg = createDefaultSourceRegistry();
    const ing = reg.resolve({
      sourceId: 's1',
      files: [{ path: 'plan.pdf', kind: 'pdf', content: SIMPLE_TEXT_PDF }],
    });
    expect(ing).not.toBeNull();
  });

  it('2. ingestWithRegistry returns sourceKind=pdf for a PDF input', async () => {
    const reg = createDefaultSourceRegistry();
    const result = await ingestWithRegistry(reg, {
      sourceId: 's1',
      files: [{ path: 'plan.pdf', kind: 'pdf', content: SIMPLE_TEXT_PDF }],
    });
    expect(result.graph.sourceKind).toBe('pdf');
    expect(result.graph.nodes.length).toBeGreaterThan(0);
  });

  it('3. CSV, EPLAN XML, TcECAD XML routes are unchanged', async () => {
    const reg = createDefaultSourceRegistry();
    const csv = reg.resolve({
      sourceId: 's',
      files: [{ path: 'a.csv', kind: 'csv', content: 'tag,kind\nB1,sensor\n' }],
    });
    expect(csv).not.toBeNull();
    const eplanXml = reg.resolve({
      sourceId: 's',
      files: [{ path: 'a.xml', kind: 'xml', content: '<EplanProject/>' }],
    });
    expect(eplanXml).not.toBeNull();
    const tcecadXml = reg.resolve({
      sourceId: 's',
      files: [
        {
          path: 'a.xml',
          kind: 'xml',
          content:
            '<Project><Description>TcECAD Import V2</Description><CPUs/></Project>',
        },
      ],
    });
    expect(tcecadXml).not.toBeNull();
  });

  it('4. binary PDF bytes resolve to the PDF ingestor (header-detected)', async () => {
    const reg = createDefaultSourceRegistry();
    const ing = reg.resolve({
      sourceId: 's',
      files: [{ path: 'mystery', kind: 'unknown', content: pdfBytes('1.7') }],
    });
    expect(ing).not.toBeNull();
  });

  it('5. registry now lists 5 ingestors (CSV / TcECAD / EPLAN / PDF / unsupported)', () => {
    const reg = createDefaultSourceRegistry();
    expect(reg.list().length).toBe(5);
  });
});
