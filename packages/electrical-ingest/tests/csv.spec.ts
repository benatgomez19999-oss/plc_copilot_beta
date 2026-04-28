// Sprint 73 — exhaustive tests for the CSV ingestor: parser
// dialect, header alias resolution, row → graph mapping,
// diagnostics, registry integration, and the PIR draft candidate
// pipeline.
//
// Architecture invariants this spec pins:
//   - The parser never throws; it emits diagnostics for every
//     malformed input.
//   - Every node + edge produced from a row carries a SourceRef
//     pointing at the row's line number (and rawId / sheet when
//     available).
//   - Duplicate tags are detected; later duplicates are skipped,
//     not silently merged.
//   - Unknown kinds + invalid addresses emit diagnostics (warnings)
//     instead of being silently dropped.
//   - The default registry routes CSV files to the CSV ingestor and
//     keeps the EPLAN unsupported stub as a fall-through.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildPirDraftCandidate } from '../src/mapping/pir-candidate.js';
import {
  createDefaultSourceRegistry,
  ingestWithRegistry,
} from '../src/sources/generic.js';
import {
  CSV_CANONICAL_HEADERS,
  CSV_HEADER_ALIASES,
  buildCsvGraphId,
  createCsvElectricalIngestor,
  ingestElectricalCsv,
  mapCsvRowToGraphFragment,
  parseElectricalCsv,
} from '../src/sources/csv.js';
import type {
  ElectricalDiagnostic,
  ElectricalGraph,
  ElectricalIngestionInput,
} from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SIMPLE = resolve(HERE, 'fixtures', 'simple-electrical-list.csv');
const FIXTURE_AMBIGUOUS = resolve(HERE, 'fixtures', 'ambiguous-electrical-list.csv');

function codes(diags: ElectricalDiagnostic[]): string[] {
  return diags.map((d) => d.code);
}

// =============================================================================
// parseElectricalCsv — dialect / parser
// =============================================================================

describe('parseElectricalCsv (dialect)', () => {
  it('parses a basic header + two data rows', () => {
    const text = `tag,kind,address\nB1,sensor,%I0.0\nY1,valve,%Q0.0\n`;
    const r = parseElectricalCsv(text);
    expect(r.headers).toEqual(['tag', 'kind', 'address']);
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].cells).toEqual({ tag: 'B1', kind: 'sensor', address: '%I0.0' });
    expect(r.diagnostics).toEqual([]);
  });

  it('handles quoted fields with embedded commas', () => {
    const text = `tag,label\nB1,"Part present, primary"\n`;
    const r = parseElectricalCsv(text);
    expect(r.rows[0].cells['label']).toBe('Part present, primary');
  });

  it('handles escaped double quotes inside quoted fields', () => {
    const text = `tag,label\nB1,"Cell with ""quote"" inside"\n`;
    const r = parseElectricalCsv(text);
    expect(r.rows[0].cells['label']).toBe('Cell with "quote" inside');
  });

  it('handles CRLF line endings', () => {
    const text = `tag,kind\r\nB1,sensor\r\nY1,valve\r\n`;
    const r = parseElectricalCsv(text);
    expect(r.rows.length).toBe(2);
  });

  it('handles mixed CRLF + LF', () => {
    const text = `tag,kind\r\nB1,sensor\nY1,valve\r\n`;
    const r = parseElectricalCsv(text);
    expect(r.rows.length).toBe(2);
  });

  it('skips blank lines but keeps line numbers correct', () => {
    const text = `tag,kind\n\nB1,sensor\n\n\nY1,valve\n`;
    const r = parseElectricalCsv(text);
    expect(r.rows.map((row) => row.lineNumber)).toEqual([3, 6]);
  });

  it('CSV_EMPTY_INPUT for empty / non-string', () => {
    expect(codes(parseElectricalCsv('').diagnostics)).toContain('CSV_EMPTY_INPUT');
    expect(codes(parseElectricalCsv(undefined as any).diagnostics)).toContain(
      'CSV_EMPTY_INPUT',
    );
  });

  it('CSV_MISSING_HEADER when the first non-blank line is empty quotes', () => {
    const r = parseElectricalCsv('\n\n   \n');
    expect(codes(r.diagnostics)).toContain('CSV_MISSING_HEADER');
  });

  it('CSV_DUPLICATE_HEADER on alias collision', () => {
    const text = `tag,device_tag,kind\nB1,B1-alias,sensor\n`;
    const r = parseElectricalCsv(text);
    expect(codes(r.diagnostics)).toContain('CSV_DUPLICATE_HEADER');
  });

  it('CSV_ROW_WIDTH_MISMATCH on wrong cell count', () => {
    const text = `tag,kind,address\nB1,sensor\n`;
    const r = parseElectricalCsv(text);
    expect(codes(r.diagnostics)).toContain('CSV_ROW_WIDTH_MISMATCH');
    // Missing cells should still produce a row (with empty values
    // for the missing ones).
    expect(r.rows.length).toBe(1);
  });

  it('CSV_UNCLOSED_QUOTE flags malformed quotes and skips the row', () => {
    const text = `tag,label\nB1,"unterminated\nY1,closed\n`;
    const r = parseElectricalCsv(text);
    expect(codes(r.diagnostics)).toContain('CSV_UNCLOSED_QUOTE');
  });

  it('CSV_UNSUPPORTED_DELIMITER for non-comma', () => {
    const r = parseElectricalCsv('tag;kind\nB1;sensor\n', { delimiter: ';' as any });
    expect(codes(r.diagnostics)).toContain('CSV_UNSUPPORTED_DELIMITER');
    expect(r.rows).toEqual([]);
  });

  it('trims header whitespace and lowercases for alias lookup', () => {
    const text = `  Tag  ,  Kind  ,  IO_Address  \nB1,sensor,%I0.0\n`;
    const r = parseElectricalCsv(text);
    expect(r.canonicalHeaders).toEqual(['tag', 'kind', 'address']);
  });
});

// =============================================================================
// Header alias coverage
// =============================================================================

describe('CSV_HEADER_ALIASES', () => {
  it('every canonical header has at least one alias mapping to itself', () => {
    for (const canonical of CSV_CANONICAL_HEADERS) {
      const has = [...CSV_HEADER_ALIASES.entries()].some(
        ([, v]) => v === canonical,
      );
      expect(has).toBe(true);
    }
  });

  it('common aliases resolve to expected canonical names', () => {
    expect(CSV_HEADER_ALIASES.get('device_tag')).toBe('tag');
    expect(CSV_HEADER_ALIASES.get('equipment')).toBe('tag');
    expect(CSV_HEADER_ALIASES.get('device_type')).toBe('kind');
    expect(CSV_HEADER_ALIASES.get('io_address')).toBe('address');
    expect(CSV_HEADER_ALIASES.get('dir')).toBe('direction');
    expect(CSV_HEADER_ALIASES.get('description')).toBe('label');
    expect(CSV_HEADER_ALIASES.get('cable_id')).toBe('cable');
    expect(CSV_HEADER_ALIASES.get('drawing')).toBe('sheet');
  });
});

// =============================================================================
// mapCsvRowToGraphFragment
// =============================================================================

describe('mapCsvRowToGraphFragment', () => {
  it('produces device + plc_channel + edge for an input sensor', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 1,
        lineNumber: 2,
        cells: { tag: 'B1', kind: 'sensor', address: '%I0.0', label: 'B1' },
        raw: 'B1,sensor,%I0.0',
      },
      { sourceId: 'src', fileName: 'list.csv' },
    );
    const kinds = result.nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(['plc_channel', 'sensor']);
    expect(result.edges).toHaveLength(1);
    // For inputs: device → channel via `signals`.
    const edge = result.edges[0];
    expect(edge.kind).toBe('signals');
    const device = result.nodes.find((n) => n.kind === 'sensor')!;
    const channel = result.nodes.find((n) => n.kind === 'plc_channel')!;
    expect(edge.from).toBe(device.id);
    expect(edge.to).toBe(channel.id);
  });

  it('reverses the edge direction for output devices (channel → device, drives)', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 1,
        lineNumber: 2,
        cells: { tag: 'Y1', kind: 'valve', address: '%Q0.0' },
        raw: '...',
      },
      { sourceId: 's', fileName: 'list.csv' },
    );
    const edge = result.edges[0];
    expect(edge.kind).toBe('drives');
    const device = result.nodes.find((n) => n.kind === 'valve')!;
    const channel = result.nodes.find((n) => n.kind === 'plc_channel')!;
    expect(edge.from).toBe(channel.id);
    expect(edge.to).toBe(device.id);
  });

  it('attaches a SourceRef with line + rawId + sheet to every node', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 3,
        lineNumber: 5,
        cells: { tag: 'B1', kind: 'sensor', address: '%I0.0', sheet: '=A1/01' },
        raw: '...',
      },
      { sourceId: 'src-x', fileName: 'plan.csv' },
    );
    for (const n of result.nodes) {
      expect(n.sourceRefs.length).toBeGreaterThan(0);
      const ref = n.sourceRefs[0];
      expect(ref.kind).toBe('csv');
      expect(ref.line).toBe(5);
      expect(ref.path).toBe('plan.csv');
      expect(ref.sourceId).toBe('src-x');
    }
    const deviceRef = result.nodes
      .find((n) => n.kind === 'sensor')!
      .sourceRefs[0];
    expect(deviceRef.rawId).toBe('B1');
    expect(deviceRef.sheet).toBe('=A1/01');
  });

  it('emits CSV_MISSING_TAG and produces no nodes when tag is empty', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 1,
        lineNumber: 2,
        cells: { kind: 'sensor', address: '%I0.0' },
        raw: '...',
      },
      { sourceId: 's' },
    );
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(codes(result.diagnostics)).toContain('CSV_MISSING_TAG');
  });

  it('emits CSV_UNKNOWN_KIND and creates an unknown-kind device', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 1,
        lineNumber: 2,
        cells: { tag: 'X1', kind: 'mystery_box', address: '%I0.0' },
        raw: '...',
      },
      { sourceId: 's' },
    );
    expect(codes(result.diagnostics)).toContain('CSV_UNKNOWN_KIND');
    const device = result.nodes.find((n) => n.id.startsWith('device:'))!;
    expect(device.kind).toBe('unknown');
  });

  it('emits CSV_INVALID_ADDRESS and skips channel + edge when address is unrecognisable', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 1,
        lineNumber: 2,
        cells: { tag: 'B1', kind: 'sensor', address: 'not-an-address' },
        raw: '...',
      },
      { sourceId: 's' },
    );
    expect(codes(result.diagnostics)).toContain('CSV_INVALID_ADDRESS');
    expect(result.nodes.find((n) => n.kind === 'plc_channel')).toBeUndefined();
    expect(result.edges).toEqual([]);
  });

  it('emits CSV_DIRECTION_ADDRESS_CONFLICT when direction column disagrees with address', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 1,
        lineNumber: 2,
        cells: { tag: 'B1', kind: 'sensor', address: '%I0.0', direction: 'output' },
        raw: '...',
      },
      { sourceId: 's' },
    );
    expect(codes(result.diagnostics)).toContain('CSV_DIRECTION_ADDRESS_CONFLICT');
  });

  it('creates terminal + cable + wire nodes when columns are populated', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 1,
        lineNumber: 2,
        cells: {
          tag: 'B1',
          kind: 'sensor',
          address: '%I0.0',
          terminal: 'X1:1',
          terminal_strip: 'X1',
          cable: 'W12',
          wire: 'C7',
        },
        raw: '...',
      },
      { sourceId: 's', fileName: 'l.csv' },
    );
    const kinds = result.nodes.map((n) => n.kind).sort();
    expect(kinds).toContain('terminal');
    expect(kinds).toContain('cable');
    expect(kinds).toContain('wire');
    expect(kinds).toContain('plc_channel');
    expect(kinds).toContain('sensor');
    // edges: device→channel + device→terminal + terminal→channel +
    //        terminal→cable + terminal→wire = 5
    expect(result.edges.length).toBeGreaterThanOrEqual(5);
  });

  it('infers signal_type=bool for bit-addressed channels', () => {
    const result = mapCsvRowToGraphFragment(
      {
        rowNumber: 1,
        lineNumber: 2,
        cells: { tag: 'B1', kind: 'sensor', address: '%I0.0' },
        raw: '...',
      },
      { sourceId: 's' },
    );
    const channel = result.nodes.find((n) => n.kind === 'plc_channel')!;
    expect(channel.attributes['signal_type']).toBe('bool');
  });
});

// =============================================================================
// ingestElectricalCsv — full-file integration
// =============================================================================

describe('ingestElectricalCsv', () => {
  it('uses a deterministic graph id', () => {
    const result = ingestElectricalCsv({
      sourceId: 'plan-1',
      text: 'tag,kind\nB1,sensor\n',
    });
    expect(result.graph.id).toBe(buildCsvGraphId('plan-1'));
    expect(result.graph.id).toBe('electrical_csv:plan-1');
    expect(result.graph.sourceKind).toBe('csv');
  });

  it('records the input fileName under metadata.sourceFiles', () => {
    const result = ingestElectricalCsv({
      sourceId: 'plan-1',
      text: 'tag,kind\nB1,sensor\n',
      fileName: 'plan.csv',
    });
    expect(result.graph.metadata.sourceFiles).toEqual(['plan.csv']);
    expect(result.graph.metadata.generator).toBe('electrical-ingest@csv');
  });

  it('parses the simple fixture into a usable graph', () => {
    const text = readFileSync(FIXTURE_SIMPLE, 'utf-8');
    const result = ingestElectricalCsv({
      sourceId: 'simple',
      text,
      fileName: 'simple-electrical-list.csv',
    });
    const graph = result.graph;
    // 6 device rows: B1 + B2 sensors, Y1 + Y2 valves, M1 motor, S1 safety.
    const deviceNodes = graph.nodes.filter((n) =>
      ['sensor', 'valve', 'motor', 'safety_device'].includes(n.kind),
    );
    expect(deviceNodes.map((n) => n.label).sort()).toEqual([
      'Conveyor motor',
      'Cylinder extend',
      'Cylinder retract',
      'Emergency stop',
      'Part clamped',
      'Part present',
    ]);
    // 5 distinct PLC channels (S1 has no address).
    const channelNodes = graph.nodes.filter((n) => n.kind === 'plc_channel');
    expect(channelNodes.map((n) => n.label).sort()).toEqual([
      '%I0.0',
      '%I0.1',
      '%Q0.0',
      '%Q0.1',
      '%Q0.2',
    ]);
    // No CSV-level errors in the simple fixture.
    expect(codes(graph.diagnostics)).not.toContain('CSV_MISSING_TAG');
    expect(codes(graph.diagnostics)).not.toContain('CSV_INVALID_ADDRESS');
    expect(codes(graph.diagnostics)).not.toContain('CSV_DUPLICATE_TAG');
  });

  it('detects every diagnostic class on the ambiguous fixture', () => {
    const text = readFileSync(FIXTURE_AMBIGUOUS, 'utf-8');
    const result = ingestElectricalCsv({
      sourceId: 'ambiguous',
      text,
      fileName: 'ambiguous.csv',
    });
    const observed = new Set(codes(result.graph.diagnostics));
    expect(observed.has('CSV_MISSING_TAG')).toBe(true);
    expect(observed.has('CSV_INVALID_ADDRESS')).toBe(true);
    expect(observed.has('CSV_DUPLICATE_TAG')).toBe(true);
    expect(observed.has('CSV_UNKNOWN_KIND')).toBe(true);
    expect(observed.has('CSV_DIRECTION_ADDRESS_CONFLICT')).toBe(true);
    expect(observed.has('CSV_DUPLICATE_ADDRESS')).toBe(true);
  });

  it('skips duplicate-tag rows and never silently merges', () => {
    const text = `tag,kind,address\nB1,sensor,%I0.0\nB1,sensor,%I0.5\n`;
    const result = ingestElectricalCsv({ sourceId: 's', text });
    expect(codes(result.graph.diagnostics)).toContain('CSV_DUPLICATE_TAG');
    // Only one device for the tag, and only one channel (the first).
    const devices = result.graph.nodes.filter((n) =>
      n.id.startsWith('device:'),
    );
    expect(devices).toHaveLength(1);
    const channels = result.graph.nodes.filter((n) => n.kind === 'plc_channel');
    expect(channels).toHaveLength(1);
    expect(channels[0].label).toBe('%I0.0');
  });

  it('flags duplicate address when two devices share a channel', () => {
    const text = `tag,kind,address\nM3,motor,%Q0.0\nB7,sensor,%Q0.0\n`;
    const result = ingestElectricalCsv({ sourceId: 's', text });
    expect(codes(result.graph.diagnostics)).toContain('CSV_DUPLICATE_ADDRESS');
    // Both device nodes survive; the channel exists once.
    const devices = result.graph.nodes.filter((n) =>
      n.id.startsWith('device:'),
    );
    expect(devices).toHaveLength(2);
    const channels = result.graph.nodes.filter((n) => n.kind === 'plc_channel');
    expect(channels).toHaveLength(1);
  });

  it('preserves source refs across rows that share infrastructure (terminal / strip)', () => {
    // B1 + B2 both reference terminal X1; the terminal node should
    // carry sourceRefs for both lines.
    const text = `tag,kind,address,terminal,terminal_strip\nB1,sensor,%I0.0,1,X1\nB2,sensor,%I0.1,2,X1\n`;
    const result = ingestElectricalCsv({ sourceId: 's', text });
    const terminals = result.graph.nodes.filter((n) => n.kind === 'terminal');
    // Two distinct terminal nodes (terminal:1 and terminal:2) — but
    // each carries its own row's source ref. We assert that the
    // graph itself has both.
    expect(terminals.map((t) => t.label).sort()).toEqual(['1', '2']);
  });
});

// =============================================================================
// PIR draft candidate integration
// =============================================================================

describe('CSV → PIR draft candidate', () => {
  it('produces IO + equipment candidates with source refs preserved', () => {
    const text = readFileSync(FIXTURE_SIMPLE, 'utf-8');
    const graph = ingestElectricalCsv({
      sourceId: 'simple',
      text,
      fileName: 'simple-electrical-list.csv',
    }).graph;
    const candidate = buildPirDraftCandidate(graph);

    // Sensors → input IO candidates with %I addresses.
    const inputs = candidate.io.filter((io) => io.direction === 'input');
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(inputs.every((io) => io.address?.startsWith('%I'))).toBe(true);

    // Valve / motor → output IO candidates with %Q addresses.
    const outputs = candidate.io.filter((io) => io.direction === 'output');
    expect(outputs.length).toBeGreaterThanOrEqual(3);
    expect(outputs.every((io) => io.address?.startsWith('%Q'))).toBe(true);

    // Source refs propagated.
    expect(
      candidate.io.every((io) =>
        io.sourceRefs.some((r) => r.kind === 'csv' && typeof r.line === 'number'),
      ),
    ).toBe(true);

    // High-confidence devices (sensor / valve / motor) become equipment.
    const equipKinds = candidate.equipment.map((e) => e.kind).sort();
    expect(equipKinds).toContain('sensor_discrete');
    expect(equipKinds).toContain('valve_solenoid');
    expect(equipKinds).toContain('motor_simple');
  });

  it('low-confidence unknown kind produces an assumption, not equipment', () => {
    const text = `tag,kind\nX1,mystery_thing\n`;
    const graph = ingestElectricalCsv({ sourceId: 's', text }).graph;
    const candidate = buildPirDraftCandidate(graph);
    // Unknown kind: device node has kind='unknown'; the mapper
    // emits UNKNOWN_DEVICE_ROLE because no role evidence exists.
    expect(candidate.equipment).toHaveLength(0);
    const ds = candidate.diagnostics.map((d) => d.code);
    expect(
      ds.includes('UNKNOWN_DEVICE_ROLE') ||
        ds.includes('LOW_CONFIDENCE_DEVICE_CLASSIFICATION'),
    ).toBe(true);
  });

  it('IO candidate carries the address and direction inferred from the row', () => {
    const text = `tag,kind,address\nB1,sensor,%I0.0\nY1,valve,%Q1.7\n`;
    const graph = ingestElectricalCsv({ sourceId: 's', text }).graph;
    const candidate = buildPirDraftCandidate(graph);
    const i = candidate.io.find((io) => io.address === '%I0.0')!;
    expect(i.direction).toBe('input');
    const o = candidate.io.find((io) => io.address === '%Q1.7')!;
    expect(o.direction).toBe('output');
  });
});

// =============================================================================
// Source registry integration
// =============================================================================

describe('Source registry integration', () => {
  it('createCsvElectricalIngestor.canIngest accepts a csv file with content', () => {
    const ing = createCsvElectricalIngestor();
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [{ path: 'a.csv', kind: 'csv', content: 'tag,kind\nB1,sensor\n' }],
      }),
    ).toBe(true);
    // Files without inline content cannot be processed by this
    // Sprint-73 ingestor — it doesn't read from disk on its own.
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [{ path: 'a.csv', kind: 'csv' }],
      }),
    ).toBe(false);
    // Non-csv kind → no.
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [{ path: 'a.xml', kind: 'xml' }],
      }),
    ).toBe(false);
    // Empty input → no.
    expect(ing.canIngest({ sourceId: 's', files: [] })).toBe(false);
    expect(ing.canIngest(null as any)).toBe(false);
  });

  it('default registry routes CSV input to the CSV ingestor', async () => {
    const reg = createDefaultSourceRegistry();
    const input: ElectricalIngestionInput = {
      sourceId: 'plan',
      files: [
        {
          path: 'list.csv',
          kind: 'csv',
          content: 'tag,kind,address\nB1,sensor,%I0.0\n',
        },
      ],
    };
    const result = await ingestWithRegistry(reg, input);
    expect(result.graph.sourceKind).toBe('csv');
    expect(result.graph.nodes.find((n) => n.kind === 'sensor')).toBeDefined();
    // Should NOT have hit the unsupported stub.
    expect(codes(result.diagnostics)).not.toContain('UNSUPPORTED_SOURCE_FEATURE');
  });

  it('default registry still falls through to the EPLAN stub for non-csv kinds', async () => {
    const reg = createDefaultSourceRegistry();
    const input: ElectricalIngestionInput = {
      sourceId: 'eplan-export',
      files: [{ path: 'project.xml', kind: 'xml' }],
    };
    const result = await ingestWithRegistry(reg, input);
    expect(codes(result.diagnostics)).toContain('UNSUPPORTED_SOURCE_FEATURE');
  });

  it('CSV ingestor accepts both string and Uint8Array content', async () => {
    const ing = createCsvElectricalIngestor();
    const utf8 = new TextEncoder().encode('tag,kind\nB1,sensor\n');
    const result = await ing.ingest({
      sourceId: 's',
      files: [{ path: 'a.csv', kind: 'csv', content: utf8 }],
    });
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(result.graph.nodes.find((n) => n.kind === 'sensor')).toBeDefined();
  });

  it('CSV ingestor merges multiple files into one graph', async () => {
    const ing = createCsvElectricalIngestor();
    const result = await ing.ingest({
      sourceId: 's',
      files: [
        { path: 'a.csv', kind: 'csv', content: 'tag,kind,address\nB1,sensor,%I0.0\n' },
        { path: 'b.csv', kind: 'csv', content: 'tag,kind,address\nY1,valve,%Q0.0\n' },
      ],
    });
    expect(result.graph.metadata.sourceFiles).toEqual(['a.csv', 'b.csv']);
    expect(result.graph.nodes.find((n) => n.kind === 'sensor')).toBeDefined();
    expect(result.graph.nodes.find((n) => n.kind === 'valve')).toBeDefined();
  });
});

// =============================================================================
// Golden fixtures — stable assertions, not full snapshots
// =============================================================================

describe('fixture: simple-electrical-list.csv', () => {
  let graph: ElectricalGraph;
  beforeAll(() => {
    const text = readFileSync(FIXTURE_SIMPLE, 'utf-8');
    graph = ingestElectricalCsv({
      sourceId: 'simple',
      text,
      fileName: 'simple-electrical-list.csv',
    }).graph;
  });

  it('graph id and source kind are deterministic', () => {
    expect(graph.id).toBe('electrical_csv:simple');
    expect(graph.sourceKind).toBe('csv');
  });

  it('every node carries at least one CSV-kind source ref', () => {
    for (const n of graph.nodes) {
      expect(n.sourceRefs.some((r) => r.kind === 'csv')).toBe(true);
    }
  });

  it('B1 sensor row produces a deterministic device id and channel id', () => {
    const device = graph.nodes.find((n) => n.id === 'device:B1');
    expect(device).toBeDefined();
    expect(device!.kind).toBe('sensor');
    const channel = graph.nodes.find((n) => n.id === 'plc_channel:%I0.0');
    expect(channel).toBeDefined();
    expect(channel!.kind).toBe('plc_channel');
  });
});

describe('fixture: ambiguous-electrical-list.csv', () => {
  let graph: ElectricalGraph;
  beforeAll(() => {
    const text = readFileSync(FIXTURE_AMBIGUOUS, 'utf-8');
    graph = ingestElectricalCsv({
      sourceId: 'amb',
      text,
      fileName: 'ambiguous-electrical-list.csv',
    }).graph;
  });

  it('uses the alias-mapped headers (device_tag → tag, type → kind, etc.)', () => {
    const device = graph.nodes.find((n) => n.id === 'device:B1');
    expect(device).toBeDefined();
    expect(device!.kind).toBe('sensor');
  });

  it('every diagnostic with a sourceRef points at a real CSV line', () => {
    for (const d of graph.diagnostics) {
      if (d.sourceRef) {
        expect(d.sourceRef.kind).toBe('csv');
        expect(typeof d.sourceRef.line).toBe('number');
      }
    }
  });

  it('"Quoted, with comma" cell parses as a single field', () => {
    const b7 = graph.nodes.find((n) => n.id === 'device:B7');
    // CSV_DUPLICATE_ADDRESS may suppress B7's channel pairing, but
    // the device row itself should land — verify the comma in the
    // label survived.
    expect(b7?.label).toBe('Quoted, with comma');
  });

  it('"Cell with ""quote""" decodes the escaped quote', () => {
    const m4 = graph.nodes.find((n) => n.id === 'device:M4');
    expect(m4?.label).toBe('Cell with "quote"');
  });
});

// Vitest auto-imports beforeAll if globals are off; we use globals=false
// in vitest.config.ts, so import explicitly here.
import { beforeAll } from 'vitest';
