// Sprint 82 — PDF-specific address strictness. Pure / total /
// deterministic tests over `classifyPdfAddress` and the
// `extractIoRow`/`buildGraphFromIoRows` strictness gate.
//
// The user-visible behaviour these tests pin:
//
//   1. CSV-style strict addresses (`%I0.0`, `Q0.1`, `I 0.0`,
//      `%IX0.0`, Rockwell tag form) are recognised as STRICT.
//   2. Beckhoff-shaped channel markers (`I1`, `O2`, `I3+`, `%I1`)
//      are recognised as CHANNEL MARKERS — they MUST NOT be
//      promoted to a buildable PLC address from PDF context.
//   3. Page-24-style noise rows (`I1 I2`) where both columns are
//      channel markers are rejected entirely (no candidate).
//   4. Non-strict rows are preserved as device evidence (so the
//      SourceRef trail survives) but never produce a
//      `plc_channel:` node — therefore the PIR builder cannot
//      synthesise an `%I1` IO from them.
//   5. The TcECAD_Import_V2_2_x.pdf manual-test scenario
//      (page-24 channel markers becoming %I1/%I3 PIR addresses)
//      no longer reproduces.

import { describe, expect, it } from 'vitest';

import {
  classifyPdfAddress,
  isPdfChannelMarker,
  isStrictPdfPlcAddress,
} from '../src/sources/pdf-address-strictness.js';
import { ingestPdf } from '../src/sources/pdf.js';
import { buildPirDraftCandidate } from '../src/index.js';

// =============================================================================
// classifyPdfAddress — table-driven tests
// =============================================================================

describe('classifyPdfAddress (Sprint 82)', () => {
  const STRICT_CASES = [
    'I0.0',
    'Q0.0',
    'Q0.1',
    '%I0.0',
    '%Q0.1',
    '%M0.0',
    'I 0.0',
    'Q 1.2',
    '%IX0.0',
    '%QX0.1',
    'Local:1:I.Data[0].0',
  ];
  const CHANNEL_MARKER_CASES = [
    'I1',
    'I2',
    'I3',
    'I4',
    'O1',
    'O2',
    'Q1',
    'Q2',
    'I1+',
    'O1-',
    '%I1',
    '%Q1',
    '%I3',
  ];
  const AMBIGUOUS_OR_INVALID_CASES = [
    'EL1004',
    '+S1-DI1',
    'BMK',
    '',
    '   ',
    'random text',
  ];

  for (const t of STRICT_CASES) {
    it(`1.x recognises "${t}" as strict_plc_address`, () => {
      expect(classifyPdfAddress(t).classification).toBe('strict_plc_address');
      expect(isStrictPdfPlcAddress(t)).toBe(true);
      expect(isPdfChannelMarker(t)).toBe(false);
    });
  }

  for (const t of CHANNEL_MARKER_CASES) {
    it(`2.x classifies "${t}" as channel_marker`, () => {
      expect(classifyPdfAddress(t).classification).toBe('channel_marker');
      expect(isPdfChannelMarker(t)).toBe(true);
      expect(isStrictPdfPlcAddress(t)).toBe(false);
    });
  }

  for (const t of AMBIGUOUS_OR_INVALID_CASES) {
    it(`3.x classifies "${t}" as ambiguous|invalid (NOT strict, NOT channel_marker)`, () => {
      const c = classifyPdfAddress(t).classification;
      expect(c === 'ambiguous' || c === 'invalid').toBe(true);
      expect(isStrictPdfPlcAddress(t)).toBe(false);
      expect(isPdfChannelMarker(t)).toBe(false);
    });
  }

  it('4. is total / non-throwing on null / non-string', () => {
    expect(classifyPdfAddress(null).classification).toBe('invalid');
    expect(classifyPdfAddress(undefined).classification).toBe('invalid');
    expect(classifyPdfAddress(42).classification).toBe('invalid');
    expect(classifyPdfAddress({ value: 'I0.0' }).classification).toBe('invalid');
  });

  it('5. preserves the verbatim token (trimmed) on the result', () => {
    expect(classifyPdfAddress('   I0.0   ').token).toBe('I0.0');
    expect(classifyPdfAddress('I1+').token).toBe('I1+');
  });
});

// =============================================================================
// ingestPdf — Sprint 82 strictness gate (text-mode)
// =============================================================================

describe('ingestPdf — Sprint 82 strictness gate', () => {
  it('1. strict-address row still produces a buildable candidate (regression)', async () => {
    const r = await ingestPdf({
      sourceId: 'strict',
      fileName: 'strict.pdf',
      text: 'I0.0 B1 Part present',
    });
    const channels = r.graph.nodes.filter((n) => n.kind === 'plc_channel');
    const devices = r.graph.nodes.filter((n) => n.id.startsWith('pdf_device:'));
    expect(channels.length).toBe(1);
    expect(devices.length).toBe(1);
    expect(r.graph.edges.length).toBe(1);
  });

  it('2. page-24 noise row "I1 I2" produces NO candidate (channel-marker tag rejected)', async () => {
    const r = await ingestPdf({
      sourceId: 'page24',
      fileName: 'page24.pdf',
      text: 'I1 I2',
    });
    expect(r.graph.nodes).toEqual([]);
    expect(r.graph.edges).toEqual([]);
  });

  it('3. multiple page-24-style channel-marker rows yield no buildable IO', async () => {
    const r = await ingestPdf({
      sourceId: 'page24',
      fileName: 'page24.pdf',
      text: 'I1 I2\nI3 I4\nO1 O2',
    });
    expect(r.graph.nodes.filter((n) => n.kind === 'plc_channel')).toEqual([]);
    expect(r.graph.edges).toEqual([]);
  });

  it('4. channel-marker addr + label-shaped tag preserves device evidence WITHOUT plc_channel', async () => {
    // `I1 Sensor light barrier on conveyor entry` — addr is a
    // channel marker, tag is a real word. Sprint 82 keeps the
    // device evidence for review but refuses to create a
    // `plc_channel:%I1` node.
    const r = await ingestPdf({
      sourceId: 'mixed',
      fileName: 'mixed.pdf',
      text: 'I1 Sensor light barrier on conveyor entry',
    });
    const channels = r.graph.nodes.filter((n) => n.kind === 'plc_channel');
    const devices = r.graph.nodes.filter((n) => n.id.startsWith('pdf_device:'));
    expect(channels).toEqual([]);
    expect(devices.length).toBe(1);
    expect(devices[0].attributes.channel_marker).toBe('I1');
    expect(devices[0].attributes.address_classification).toBe('channel_marker');
    expect(r.graph.edges).toEqual([]);
  });

  it('5. emits PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS + PDF_MODULE_CHANNEL_MARKER_DETECTED for the channel-marker row', async () => {
    const r = await ingestPdf({
      sourceId: 'mixed',
      fileName: 'mixed.pdf',
      text: 'I1 Sensor light barrier',
    });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS');
    expect(codes).toContain('PDF_MODULE_CHANNEL_MARKER_DETECTED');
  });

  it('6. %I1 (no bit) is treated as channel_marker even with the % prefix', async () => {
    const r = await ingestPdf({
      sourceId: 'percent',
      fileName: 'percent.pdf',
      text: '%I1 Sensor light barrier',
    });
    const channels = r.graph.nodes.filter((n) => n.kind === 'plc_channel');
    expect(channels).toEqual([]);
    const devices = r.graph.nodes.filter((n) => n.id.startsWith('pdf_device:'));
    expect(devices[0].attributes.channel_marker).toBe('%I1');
  });

  it('7. mixed strict + channel-marker rows: only the strict row produces a plc_channel', async () => {
    const r = await ingestPdf({
      sourceId: 'mixed',
      fileName: 'mixed.pdf',
      text: [
        'I0.0 B1 Real address row',
        'I1 Sensor module overview row',
      ].join('\n'),
    });
    const channels = r.graph.nodes.filter((n) => n.kind === 'plc_channel');
    expect(channels.length).toBe(1);
    expect(channels[0].attributes.address).toBe('%I0.0');
  });

  it('8. confidence on non-strict rows stays at the conservative 0.5 floor', async () => {
    const r = await ingestPdf({
      sourceId: 'mixed',
      fileName: 'mixed.pdf',
      text: 'I1 Sensor light barrier',
    });
    const devices = r.graph.nodes.filter((n) => n.id.startsWith('pdf_device:'));
    expect(devices[0].confidence.score).toBeGreaterThanOrEqual(0.5);
    expect(devices[0].confidence.score).toBeLessThanOrEqual(0.65);
  });
});

// =============================================================================
// PIR draft candidate — channel-marker rows must NOT yield IO candidates
// =============================================================================

describe('PDF channel-marker rows → PirDraftCandidate', () => {
  it('1. channel-marker-only PDF yields zero IO candidates (Sprint 82 safety gate)', async () => {
    const r = await ingestPdf({
      sourceId: 'page24',
      fileName: 'page24.pdf',
      text: 'I1 Sensor light barrier\nI3 Sensor part absent',
    });
    const candidate = buildPirDraftCandidate(r.graph);
    expect(candidate.io).toEqual([]);
  });

  it('2. strict-address PDF still yields IO candidates', async () => {
    const r = await ingestPdf({
      sourceId: 'strict',
      fileName: 'strict.pdf',
      text: 'I0.0 B1 Part present\nQ0.0 Y1 Cylinder extend',
    });
    const candidate = buildPirDraftCandidate(r.graph);
    expect(candidate.io.length).toBeGreaterThan(0);
  });
});
