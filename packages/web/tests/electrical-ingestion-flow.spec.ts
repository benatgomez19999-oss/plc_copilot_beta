// Sprint 77 — pure tests for the web electrical-ingestion flow
// helpers. The web vitest config runs in node (no DOM), so these
// tests target the helpers and walk all the way through the real
// ingestor + the candidate builder.

import { describe, expect, it } from 'vitest';

import {
  detectInputKind,
  ingestElectricalInput,
  createCandidateFromIngestionResult,
  runElectricalIngestion,
} from '../src/utils/electrical-ingestion-flow.js';

const SIMPLE_CSV = `tag,kind,address,direction,label
B1,sensor,%I0.0,input,Part present
Y1,valve,%Q0.0,output,Cylinder extend`;

const SIMPLE_XML = `<?xml version="1.0"?>
<EplanProject>
  <Pages>
    <Page sheet="=A1/12">
      <Element tag="B1" kind="sensor" address="%I0.0" direction="input"/>
      <Element tag="Y1" kind="valve" address="%Q0.0" direction="output"/>
    </Page>
  </Pages>
</EplanProject>`;

// =============================================================================
// detectInputKind
// =============================================================================

describe('detectInputKind', () => {
  it('returns csv for .csv extension', () => {
    expect(detectInputKind('a,b\n1,2', 'list.csv')).toBe('csv');
  });
  it('returns xml for .xml extension', () => {
    expect(detectInputKind('<root/>', 'plan.xml')).toBe('xml');
  });
  it('is case-insensitive on extensions', () => {
    expect(detectInputKind('x', 'Plan.XML')).toBe('xml');
    expect(detectInputKind('x', 'List.CSV')).toBe('csv');
  });
  it('falls through to content sniffing when no fileName', () => {
    expect(detectInputKind('<root/>')).toBe('xml');
    expect(detectInputKind('a,b\n1,2')).toBe('csv');
  });
  it('returns unknown for empty / whitespace input', () => {
    expect(detectInputKind('')).toBe('unknown');
    expect(detectInputKind('   \n')).toBe('unknown');
    expect(detectInputKind(null as never)).toBe('unknown');
  });
  it('returns unknown for content with no commas and no leading <', () => {
    expect(detectInputKind('just some words')).toBe('unknown');
  });
  it('extension wins over content', () => {
    // Content looks like CSV but extension says XML.
    expect(detectInputKind('a,b,c', 'plan.xml')).toBe('xml');
  });
});

// =============================================================================
// ingestElectricalInput
// =============================================================================

describe('ingestElectricalInput', () => {
  it('routes a CSV body through the CSV ingestor', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'csv-1',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    expect(r.graph.sourceKind).toBe('csv');
    expect(r.graph.nodes.find((n) => n.kind === 'sensor')).toBeDefined();
    expect(r.graph.nodes.find((n) => n.kind === 'valve')).toBeDefined();
  });

  it('routes an EPLAN XML body through the EPLAN XML ingestor', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'xml-1',
      text: SIMPLE_XML,
      fileName: 'plan.xml',
    });
    expect(r.graph.sourceKind).toBe('eplan-export');
    expect(r.graph.nodes.find((n) => n.kind === 'sensor')).toBeDefined();
  });

  it('emits an UNSUPPORTED diagnostic for unknown content (no commas + no leading <)', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'unk-1',
      text: 'just plain words without csv-like delimiters or xml tags',
      fileName: 'thing.bin',
    });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('UNSUPPORTED_SOURCE_FEATURE');
  });

  it('does NOT throw on malformed XML — emits diagnostics', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'bad-xml',
      text: '<root><unterminated',
      fileName: 'bad.xml',
    });
    expect(
      r.diagnostics.some((d) => d.code === 'EPLAN_XML_MALFORMED'),
    ).toBe(true);
  });

  it('preserves fileName as the SourceRef path on every node', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'csv-2',
      text: SIMPLE_CSV,
      fileName: 'simple-list.csv',
    });
    for (const n of r.graph.nodes) {
      const ref = n.sourceRefs?.[0];
      if (!ref) continue;
      expect(ref.path).toBe('simple-list.csv');
    }
  });

  it('synthesises a deterministic file path when fileName is missing (csv default)', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'manual',
      text: SIMPLE_CSV,
    });
    expect(r.graph.metadata.sourceFiles?.[0]).toBe('manual.csv');
  });

  it('refuses non-string text without throwing', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'bad',
      text: undefined as never,
    });
    expect(
      r.diagnostics.some((d) => d.code === 'UNSUPPORTED_SOURCE_FEATURE'),
    ).toBe(true);
  });

  it('refuses an empty sourceId', async () => {
    const r = await ingestElectricalInput({
      sourceId: '',
      text: SIMPLE_CSV,
    });
    expect(
      r.diagnostics.some((d) => d.code === 'UNSUPPORTED_SOURCE_FEATURE'),
    ).toBe(true);
  });
});

// =============================================================================
// createCandidateFromIngestionResult
// =============================================================================

describe('createCandidateFromIngestionResult', () => {
  it('builds a candidate from a CSV graph', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'csv',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    const c = createCandidateFromIngestionResult(r);
    expect(c.io.length).toBeGreaterThan(0);
    expect(c.equipment.length).toBeGreaterThan(0);
  });

  it('produces a candidate even for an empty graph (with diagnostics)', async () => {
    const r = await ingestElectricalInput({
      sourceId: 'unk',
      text: 'just words',
    });
    const c = createCandidateFromIngestionResult(r);
    expect(c.io).toEqual([]);
    expect(c.equipment).toEqual([]);
  });
});

// =============================================================================
// runElectricalIngestion (compose helper)
// =============================================================================

describe('runElectricalIngestion', () => {
  it('end-to-end CSV path', async () => {
    const r = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_CSV,
      fileName: 'list.csv',
    });
    expect(r.detectedKind).toBe('csv');
    expect(r.candidate.io.length).toBeGreaterThan(0);
  });

  it('end-to-end EPLAN XML path', async () => {
    const r = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_XML,
      fileName: 'plan.xml',
    });
    expect(r.detectedKind).toBe('xml');
    expect(r.candidate.equipment.length).toBeGreaterThan(0);
  });

  it('unknown input returns detectedKind=unknown + empty candidate', async () => {
    const r = await runElectricalIngestion({
      sourceId: 's',
      text: 'just words',
    });
    expect(r.detectedKind).toBe('unknown');
    expect(r.candidate.io).toEqual([]);
  });
});

// =============================================================================
// Sprint 79 — PDF detection + flow
// =============================================================================

const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

const SIMPLE_PDF_TEXT = `--- page 1 ---
I0.0 B1 Part present
Q0.0 Y1 Cylinder extend
`;

describe('detectInputKind — Sprint 79 PDF', () => {
  it('1. returns "pdf" for .pdf extension', () => {
    expect(detectInputKind('', 'plan.pdf')).toBe('pdf');
  });
  it('2. is case-insensitive on .PDF extension', () => {
    expect(detectInputKind('', 'PLAN.PDF')).toBe('pdf');
  });
  it('3. returns "pdf" when bytes start with %PDF- magic', () => {
    expect(detectInputKind('', null, PDF_HEADER)).toBe('pdf');
  });
  it('4. returns "pdf" when text body starts with literal %PDF-', () => {
    expect(detectInputKind('%PDF-1.7\n…')).toBe('pdf');
  });
  it('5. extension wins over content sniff (csv body in a .pdf is still pdf)', () => {
    expect(detectInputKind('a,b\n1,2', 'list.pdf')).toBe('pdf');
  });
  it('6. plain text without .pdf extension does NOT classify as pdf', () => {
    expect(detectInputKind('--- page 1 ---\nI0.0 B1 sensor', 'notes.txt')).not.toBe(
      'pdf',
    );
  });
});

describe('ingestElectricalInput — Sprint 79 PDF', () => {
  it('1. test-mode text path produces sourceKind=pdf and extracts simple IO rows', async () => {
    const r = await ingestElectricalInput({
      sourceId: 's',
      text: SIMPLE_PDF_TEXT,
      fileName: 'plan.pdf',
    });
    expect(r.graph.sourceKind).toBe('pdf');
    expect(r.graph.nodes.length).toBeGreaterThan(0);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_TEXT_BLOCK_EXTRACTED');
  });

  it('2. binary path with valid header + no text emits honest stub diagnostics', async () => {
    const r = await ingestElectricalInput({
      sourceId: 's',
      text: '',
      fileName: 'real.pdf',
      bytes: PDF_HEADER,
    });
    expect(r.graph.sourceKind).toBe('pdf');
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_UNSUPPORTED_BINARY_PARSER');
    expect(codes).toContain('PDF_TEXT_LAYER_UNAVAILABLE');
    expect(codes).toContain('PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED');
    expect(r.graph.nodes).toEqual([]);
  });

  it('3. malformed bytes (no %PDF- magic) emits PDF_MALFORMED', async () => {
    const r = await ingestElectricalInput({
      sourceId: 's',
      text: '',
      fileName: 'broken.pdf',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_MALFORMED');
    expect(r.graph.nodes).toEqual([]);
  });

  it('4. PDF candidate carries SourceRefs with kind=pdf + page', async () => {
    const r = await runElectricalIngestion({
      sourceId: 's',
      text: SIMPLE_PDF_TEXT,
      fileName: 'plan.pdf',
    });
    expect(r.detectedKind).toBe('pdf');
    expect(r.candidate.io.length).toBeGreaterThan(0);
    const ref = r.candidate.io[0]?.sourceRefs[0];
    expect(ref?.kind).toBe('pdf');
    expect(ref?.page).toBeDefined();
  });
});
