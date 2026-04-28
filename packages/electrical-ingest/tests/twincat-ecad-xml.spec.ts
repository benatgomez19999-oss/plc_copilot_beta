// Sprint 78A — exhaustive tests for the Beckhoff/TwinCAT ECAD
// Import XML recognizer + ingestor. Architecture invariants:
//   - Detection is structural + descriptive (root === Project AND
//     either Description contains "TcECAD Import" OR a Box/Variable
//     fingerprint).
//   - Generic Project XML is NOT auto-classified as TcECAD.
//   - No fake Siemens %I/%Q address synthesis. Channels carry a
//     deterministic `tcecad:<boxNo>:<channel>` structured address.
//   - SourceRefs always carry kind: 'twincat_ecad', line, path,
//     rawId, and the deterministic XML locator in `symbol`.
//   - Box / interface / CPU context propagates as attributes.
//   - Diagnostics fire on every ambiguous / missing / conflicting
//     case; nothing is silently dropped.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildPirDraftCandidate } from '../src/mapping/pir-candidate.js';
import {
  createDefaultSourceRegistry,
  ingestWithRegistry,
} from '../src/sources/generic.js';
import {
  buildTcecadGraphId,
  createTcecadXmlElectricalIngestor,
  detectTcecadXml,
  extractTcecadVariables,
  ingestTcecadXml,
  parseTcecadXml,
} from '../src/sources/twincat-ecad-xml.js';
import { parseXml } from '../src/sources/xml-utils.js';
import type {
  ElectricalDiagnostic,
  ElectricalGraph,
  ElectricalIngestionInput,
} from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures', 'eplan', 'twincat-ecad-import.xml');

function codes(diags: ElectricalDiagnostic[]): string[] {
  return diags.map((d) => d.code);
}

const MINIMAL_TCECAD = `<?xml version="1.0"?>
<Project>
  <Name>CPU1</Name>
  <Description>TcECAD Import V2.2.12</Description>
  <CPUs>
    <CPU>
      <Name>EAA</Name>
      <Interfaces>
        <Interface>
          <Name>EtherCAT1</Name>
          <Type>ETHERCATPROT</Type>
          <ChannelNo>1</ChannelNo>
          <Boxes>
            <Box>
              <Name>DI1</Name>
              <Type>EL1004</Type>
              <BoxNo>1005</BoxNo>
              <Variables>
                <Variable>
                  <Name>S1</Name>
                  <Comment>sensor</Comment>
                  <IsInput>true</IsInput>
                  <IoName>Input</IoName>
                  <IoGroup>Channel 1</IoGroup>
                  <IoDataType>BOOL</IoDataType>
                </Variable>
              </Variables>
            </Box>
          </Boxes>
        </Interface>
      </Interfaces>
    </CPU>
  </CPUs>
</Project>`;

// =============================================================================
// detectTcecadXml
// =============================================================================

describe('detectTcecadXml', () => {
  it('detects via Description containing TcECAD Import', () => {
    const r = parseXml(MINIMAL_TCECAD);
    expect(detectTcecadXml(r.root)).toBe(true);
  });

  it('detects via Box/Variable structural fingerprint (no Description)', () => {
    const xml = MINIMAL_TCECAD.replace('<Description>TcECAD Import V2.2.12</Description>', '');
    const r = parseXml(xml);
    expect(detectTcecadXml(r.root)).toBe(true);
  });

  it('does NOT detect arbitrary Project XML', () => {
    const r = parseXml('<Project><Name>X</Name></Project>');
    expect(detectTcecadXml(r.root)).toBe(false);
  });

  it('does NOT detect a non-Project root', () => {
    const r = parseXml('<EplanProject><Pages><Page/></Pages></EplanProject>');
    expect(detectTcecadXml(r.root)).toBe(false);
  });

  it('returns false on null root', () => {
    expect(detectTcecadXml(null)).toBe(false);
  });
});

// =============================================================================
// parseTcecadXml — diagnostics
// =============================================================================

describe('parseTcecadXml', () => {
  it('emits TCECAD_XML_DETECTED + extracts variables on a valid input', () => {
    const r = parseTcecadXml(MINIMAL_TCECAD);
    expect(codes(r.diagnostics)).toContain('TCECAD_XML_DETECTED');
    expect(r.variables.length).toBe(1);
    expect(r.variables[0].name).toBe('S1');
  });

  it('emits EPLAN_XML_EMPTY_INPUT for empty / non-string text', () => {
    expect(codes(parseTcecadXml('').diagnostics)).toContain('EPLAN_XML_EMPTY_INPUT');
    expect(codes(parseTcecadXml(undefined as never).diagnostics)).toContain(
      'EPLAN_XML_EMPTY_INPUT',
    );
  });

  it('emits EPLAN_XML_MALFORMED for malformed XML and never throws', () => {
    const r = parseTcecadXml('<Project><unterminated');
    expect(codes(r.diagnostics)).toContain('EPLAN_XML_MALFORMED');
  });

  it('emits EPLAN_XML_UNKNOWN_ROOT for a Project that does not match TcECAD', () => {
    const r = parseTcecadXml('<Project><Name>X</Name></Project>');
    expect(codes(r.diagnostics)).toContain('EPLAN_XML_UNKNOWN_ROOT');
  });

  it('emits TCECAD_XML_NO_VARIABLES when format is recognised but no Variable nodes', () => {
    const xml = `<Project><Description>TcECAD Import</Description><CPUs><CPU><Name>X</Name></CPU></CPUs></Project>`;
    const r = parseTcecadXml(xml);
    expect(codes(r.diagnostics)).toContain('TCECAD_XML_NO_VARIABLES');
  });
});

// =============================================================================
// extractTcecadVariables — context propagation
// =============================================================================

describe('extractTcecadVariables', () => {
  it('captures CPU / interface / box context for every variable', () => {
    const r = parseXml(MINIMAL_TCECAD);
    const vars = extractTcecadVariables(r.root!);
    expect(vars).toHaveLength(1);
    const v = vars[0];
    expect(v.cpuName).toBe('EAA');
    expect(v.interfaceName).toBe('EtherCAT1');
    expect(v.interfaceType).toBe('ETHERCATPROT');
    expect(v.interfaceChannelNo).toBe('1');
    expect(v.boxName).toBe('DI1');
    expect(v.boxType).toBe('EL1004');
    expect(v.boxNo).toBe('1005');
  });

  it('captures variable Comment, IsInput, IoName, IoGroup, IoDataType', () => {
    const r = parseXml(MINIMAL_TCECAD);
    const v = extractTcecadVariables(r.root!)[0];
    expect(v.comment).toBe('sensor');
    expect(v.isInput).toBe(true);
    expect(v.ioName).toBe('Input');
    expect(v.ioGroup).toBe('Channel 1');
    expect(v.ioDataType).toBe('BOOL');
  });

  it('preserves XML locator (sourcePath) for every variable', () => {
    const r = parseXml(MINIMAL_TCECAD);
    const v = extractTcecadVariables(r.root!)[0];
    expect(v.sourcePath).toContain('/Variable[1]');
  });

  it('records 1-based line of the opening <Variable> tag', () => {
    const r = parseXml(MINIMAL_TCECAD);
    const v = extractTcecadVariables(r.root!)[0];
    expect(typeof v.line).toBe('number');
    expect(v.line).toBeGreaterThan(0);
  });
});

// =============================================================================
// ingestTcecadXml — graph mapping
// =============================================================================

describe('ingestTcecadXml — minimal input', () => {
  it('produces a deterministic graph id + sourceKind=twincat_ecad', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD });
    expect(r.graph.id).toBe(buildTcecadGraphId('s'));
    expect(r.graph.id).toBe('electrical_twincat_ecad:s');
    expect(r.graph.sourceKind).toBe('twincat_ecad');
  });

  it('creates module + plc_channel + device for an input variable', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD });
    const kinds = r.graph.nodes.map((n) => n.kind).sort();
    expect(kinds).toContain('plc_module');
    expect(kinds).toContain('plc_channel');
    // Device kind is one of: sensor / safety_device / valve / motor /
    // unknown depending on the comment; "sensor" matches.
    expect(kinds.some((k) => k === 'sensor' || k === 'unknown')).toBe(true);
  });

  it('creates a `signals` edge for input variables', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD });
    expect(r.graph.edges.find((e) => e.kind === 'signals')).toBeDefined();
  });

  it('creates a `drives` edge for output variables', () => {
    const xml = MINIMAL_TCECAD.replace('<IsInput>true</IsInput>', '<IsInput>false</IsInput>');
    const r = ingestTcecadXml({ sourceId: 's', text: xml });
    expect(r.graph.edges.find((e) => e.kind === 'drives')).toBeDefined();
  });

  it('creates a `belongs_to` edge between channel and module', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD });
    expect(r.graph.edges.find((e) => e.kind === 'belongs_to')).toBeDefined();
  });

  it('every node carries a SourceRef with kind "twincat_ecad"', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD, fileName: 'tc.xml' });
    for (const n of r.graph.nodes) {
      expect(n.sourceRefs.every((ref) => ref.kind === 'twincat_ecad')).toBe(true);
    }
  });

  it('every node SourceRef carries path + line + rawId + symbol', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD, fileName: 'tc.xml' });
    for (const n of r.graph.nodes) {
      const ref = n.sourceRefs[0];
      expect(ref.path).toBe('tc.xml');
      expect(typeof ref.line).toBe('number');
      expect(ref.rawId).toBeDefined();
      expect(ref.symbol).toBeDefined();
    }
  });

  it('every edge carries a SourceRef', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD });
    for (const e of r.graph.edges) {
      expect(e.sourceRefs.length).toBeGreaterThan(0);
    }
  });

  it('uses a deterministic structured address (tcecad:<box>:<channel>)', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD });
    const channel = r.graph.nodes.find((n) => n.kind === 'plc_channel')!;
    expect(channel.attributes['structured_address']).toBe('tcecad:1005:Channel 1');
    expect(channel.attributes['family']).toBe('twincat_ecad');
  });

  it('emits TCECAD_XML_STRUCTURED_ADDRESS_USED info diagnostic', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD });
    expect(codes(r.graph.diagnostics)).toContain('TCECAD_XML_STRUCTURED_ADDRESS_USED');
  });

  it('preserves Box / Interface / CPU context as attributes on the device node', () => {
    const r = ingestTcecadXml({ sourceId: 's', text: MINIMAL_TCECAD });
    const device = r.graph.nodes.find((n) => n.id.startsWith('device:'))!;
    expect(device.attributes['variable_name']).toBe('S1');
    expect(device.attributes['box_name']).toBe('DI1');
    expect(device.attributes['box_type']).toBe('EL1004');
    expect(device.attributes['box_no']).toBe('1005');
    expect(device.attributes['interface_name']).toBe('EtherCAT1');
    expect(device.attributes['cpu_name']).toBe('EAA');
    expect(device.attributes['source_format']).toBe('twincat_ecad_import');
  });
});

// =============================================================================
// ingestTcecadXml — diagnostics on the ambiguous fixture
// =============================================================================

describe('ingestTcecadXml — diagnostic surface', () => {
  let graph: ElectricalGraph;
  beforeAll(() => {
    const text = readFileSync(FIXTURE, 'utf-8');
    graph = ingestTcecadXml({
      sourceId: 'tc-fixture',
      text,
      fileName: 'twincat-ecad-import.xml',
    }).graph;
  });

  it('extracts > 0 variables from the public-shape fixture', () => {
    const devices = graph.nodes.filter((n) => n.id.startsWith('device:'));
    expect(devices.length).toBeGreaterThan(0);
  });

  it('produces both input and output candidates', () => {
    const channels = graph.nodes.filter((n) => n.kind === 'plc_channel');
    const directions = new Set(channels.map((c) => c.attributes['direction']));
    expect(directions.has('input')).toBe(true);
    expect(directions.has('output')).toBe(true);
  });

  it('emits TCECAD_XML_DIRECTION_CONFLICT for the ambiguous variable', () => {
    expect(codes(graph.diagnostics)).toContain('TCECAD_XML_DIRECTION_CONFLICT');
  });

  it('emits TCECAD_XML_UNSUPPORTED_IO_DATATYPE for the STRING variable', () => {
    expect(codes(graph.diagnostics)).toContain('TCECAD_XML_UNSUPPORTED_IO_DATATYPE');
  });

  it('preserves the XML locator on every node', () => {
    for (const n of graph.nodes) {
      expect(n.sourceRefs[0].symbol).toBeTruthy();
    }
  });

  it('infers safety_device from "Notaus" / "E-stop" comments', () => {
    const estop = graph.nodes.find((n) =>
      typeof n.label === 'string' ? /notaus|e-?stop/i.test(n.label) : false,
    );
    expect(estop?.kind).toBe('safety_device');
  });

  it('infers valve from "Magnetventil" comments', () => {
    const valve = graph.nodes.find((n) =>
      typeof n.label === 'string' ? /magnetventil/i.test(n.label) : false,
    );
    expect(valve?.kind).toBe('valve');
  });

  it('infers motor from "Motor Schütz" comments', () => {
    const motor = graph.nodes.find((n) =>
      typeof n.label === 'string' ? /motor.*sch[uü]tz/i.test(n.label) : false,
    );
    expect(motor?.kind).toBe('motor');
  });

  it('infers sensor from "Lichttaster" / "Reedkontakt" comments', () => {
    const sensor = graph.nodes.find((n) =>
      typeof n.label === 'string' ? /lichttaster|reedkontakt/i.test(n.label) : false,
    );
    expect(sensor?.kind).toBe('sensor');
  });
});

// =============================================================================
// PIR draft candidate integration
// =============================================================================

describe('TcECAD → PirDraftCandidate', () => {
  it('produces IO candidates with input/output direction', () => {
    const text = readFileSync(FIXTURE, 'utf-8');
    const graph = ingestTcecadXml({
      sourceId: 'tc',
      text,
      fileName: 'twincat-ecad-import.xml',
    }).graph;
    const candidate = buildPirDraftCandidate(graph);
    expect(candidate.io.length).toBeGreaterThan(0);
    const inputs = candidate.io.filter((io) => io.direction === 'input');
    const outputs = candidate.io.filter((io) => io.direction === 'output');
    expect(inputs.length).toBeGreaterThan(0);
    expect(outputs.length).toBeGreaterThan(0);
  });

  it('IO candidates carry source refs with the XML locator', () => {
    const text = readFileSync(FIXTURE, 'utf-8');
    const graph = ingestTcecadXml({
      sourceId: 'tc',
      text,
      fileName: 'twincat-ecad-import.xml',
    }).graph;
    const candidate = buildPirDraftCandidate(graph);
    expect(
      candidate.io.every((io) => io.sourceRefs.some((r) => r.kind === 'twincat_ecad' && r.symbol)),
    ).toBe(true);
  });
});

// =============================================================================
// Registry integration
// =============================================================================

describe('Registry routing — Sprint 78A TcECAD ingestor', () => {
  it('default registry routes TcECAD XML to the TcECAD ingestor (not EPLAN)', async () => {
    const reg = createDefaultSourceRegistry();
    const result = await ingestWithRegistry(reg, {
      sourceId: 'tc',
      files: [{ path: 'tc.xml', kind: 'xml', content: MINIMAL_TCECAD }],
    } as ElectricalIngestionInput);
    expect(result.graph.sourceKind).toBe('twincat_ecad');
    expect(codes(result.diagnostics)).toContain('TCECAD_XML_DETECTED');
  });

  it('default registry still routes generic EPLAN XML to the EPLAN ingestor', async () => {
    const reg = createDefaultSourceRegistry();
    const result = await ingestWithRegistry(reg, {
      sourceId: 'eplan',
      files: [
        {
          path: 'plan.xml',
          kind: 'xml',
          content: '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0"/></EplanProject>',
        },
      ],
    } as ElectricalIngestionInput);
    expect(result.graph.sourceKind).toBe('eplan-export');
  });

  it('canIngest of TcECAD ingestor rejects non-TcECAD XML', () => {
    const ing = createTcecadXmlElectricalIngestor();
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [
          {
            path: 'plan.xml',
            kind: 'xml',
            content: '<EplanProject><Element tag="B1" kind="sensor"/></EplanProject>',
          },
        ],
      }),
    ).toBe(false);
  });

  it('canIngest of TcECAD ingestor accepts TcECAD XML', () => {
    const ing = createTcecadXmlElectricalIngestor();
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [{ path: 'tc.xml', kind: 'xml', content: MINIMAL_TCECAD }],
      }),
    ).toBe(true);
  });

  it('canIngest of TcECAD ingestor rejects non-XML kinds', () => {
    const ing = createTcecadXmlElectricalIngestor();
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [{ path: 'list.csv', kind: 'csv', content: 'tag,kind\nB1,sensor' }],
      }),
    ).toBe(false);
  });
});
