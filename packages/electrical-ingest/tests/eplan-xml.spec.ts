// Sprint 74 — exhaustive tests for the EPLAN structured XML
// ingestor v0: low-level parser, format detection, element
// extraction, row → graph mapping, diagnostics, registry routing,
// PIR draft candidate integration, and golden-fixture invariants.
//
// Architecture invariants this spec pins:
//   - The XML parser never throws; malformed input emits structured
//     errors as EPLAN_XML_MALFORMED diagnostics.
//   - Every node + edge produced from an XML element carries a
//     SourceRef pointing at the element's line + locator.
//   - Unknown XML roots are surfaced honestly via
//     EPLAN_XML_UNKNOWN_ROOT — nothing is silently invented.
//   - The XML ingestor owns ALL `kind: 'xml'` files in the default
//     registry; the unsupported EPLAN stub never sees them.
//   - Sprint 73 CSV ingestor is unaffected.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildPirDraftCandidate } from '../src/mapping/pir-candidate.js';
import {
  buildEplanXmlGraphId,
  createEplanXmlElectricalIngestor,
  detectEplanXmlFormat,
  ingestEplanXml,
  mapEplanXmlElementToFragment,
  parseEplanXml,
} from '../src/sources/eplan-xml.js';
import {
  createDefaultSourceRegistry,
  ingestWithRegistry,
} from '../src/sources/generic.js';
import {
  decodeEntities,
  findAllElements,
  findElement,
  getAttribute,
  getChildText,
  parseXml,
} from '../src/sources/xml-utils.js';
import type {
  ElectricalDiagnostic,
  ElectricalGraph,
  ElectricalIngestionInput,
} from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SIMPLE = resolve(HERE, 'fixtures', 'eplan', 'simple-eplan-export.xml');
const FIXTURE_AMBIGUOUS = resolve(HERE, 'fixtures', 'eplan', 'ambiguous-eplan-export.xml');

function codes(diags: ElectricalDiagnostic[]): string[] {
  return diags.map((d) => d.code);
}

// =============================================================================
// xml-utils — low-level parser
// =============================================================================

describe('parseXml (low-level)', () => {
  it('parses a minimal element with attributes', () => {
    const r = parseXml('<root id="x" name="y"/>');
    expect(r.errors).toEqual([]);
    expect(r.root?.tag).toBe('root');
    expect(r.root?.attrMap.get('id')).toBe('x');
    expect(r.root?.attrMap.get('name')).toBe('y');
  });

  it('parses nested elements + text', () => {
    const r = parseXml('<root><child>hi</child></root>');
    expect(r.root?.children.length).toBe(1);
    expect(r.root?.children[0].tag).toBe('child');
    expect(r.root?.children[0].text).toBe('hi');
  });

  it('decodes XML entities in attributes + text', () => {
    const r = parseXml('<root attr="a &amp; b">x &lt; y</root>');
    expect(r.root?.attrMap.get('attr')).toBe('a & b');
    expect(r.root?.text).toBe('x < y');
  });

  it('handles CDATA blocks', () => {
    const r = parseXml('<root><![CDATA[<not parsed>]]></root>');
    expect(r.root?.text).toBe('<not parsed>');
  });

  it('skips XML declarations / comments / processing instructions', () => {
    const r = parseXml(
      '<?xml version="1.0"?><!-- comment --><?pi data?><root/>',
    );
    expect(r.errors).toEqual([]);
    expect(r.root?.tag).toBe('root');
  });

  it('records line numbers correctly across CRLF + LF', () => {
    const r = parseXml('\r\n\r\n<root>\n  <child/>\n</root>');
    expect(r.root?.line).toBe(3);
    expect(r.root?.children[0].line).toBe(4);
  });

  it('emits an error (no throw) on empty input', () => {
    const r = parseXml('');
    expect(r.root).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('emits an error (no throw) on no root element', () => {
    const r = parseXml('   <!-- only comment -->   ');
    expect(r.root).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('emits an error on mismatched close tag (recoverable)', () => {
    const r = parseXml('<root><a></b></root>');
    expect(r.root).not.toBeNull();
    expect(r.errors.some((e) => /mismatched/.test(e.message))).toBe(true);
  });

  it('builds a deterministic locator path for siblings', () => {
    const r = parseXml('<root><a/><a/><b/></root>');
    expect(r.root?.children[0].locator).toBe('/root[1]/a[1]');
    expect(r.root?.children[1].locator).toBe('/root[1]/a[2]');
    expect(r.root?.children[2].locator).toBe('/root[1]/b[1]');
  });

  it('decodeEntities decodes named + numeric refs', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('unknown &foo;')).toBe('unknown &foo;');
  });

  it('findAllElements / findElement work case-insensitively', () => {
    const r = parseXml('<Root><Item id="1"/><item id="2"/></Root>');
    const all = findAllElements(r.root!, 'item');
    expect(all.length).toBe(2);
    expect(findElement(r.root!, 'item')?.attrMap.get('id')).toBe('1');
  });

  it('getAttribute falls through aliases', () => {
    const r = parseXml('<el data-x="hi"/>');
    expect(getAttribute(r.root!, 'missing', 'data-x')).toBe('hi');
  });

  it('getChildText returns trimmed first-child text', () => {
    const r = parseXml('<root><label>  hello  </label></root>');
    expect(getChildText(r.root!, 'label')).toBe('hello');
    expect(getChildText(r.root!, 'absent')).toBeNull();
  });
});

// =============================================================================
// detectEplanXmlFormat
// =============================================================================

describe('detectEplanXmlFormat', () => {
  it('classifies known EPLAN-style roots', () => {
    expect(detectEplanXmlFormat(parseXml('<EplanProject/>').root)).toBe(
      'eplan_project_xml',
    );
    expect(detectEplanXmlFormat(parseXml('<Project/>').root)).toBe(
      'eplan_project_xml',
    );
    expect(detectEplanXmlFormat(parseXml('<ElectricalProject/>').root)).toBe(
      'eplan_project_xml',
    );
  });

  it('classifies generic roots as eplan_generic_xml', () => {
    expect(detectEplanXmlFormat(parseXml('<Pages/>').root)).toBe(
      'eplan_generic_xml',
    );
    expect(detectEplanXmlFormat(parseXml('<Elements/>').root)).toBe(
      'eplan_generic_xml',
    );
  });

  it('promotes a stranger root to generic if it contains <Element> descendants', () => {
    const r = parseXml('<Custom><Element tag="B1"/></Custom>');
    expect(detectEplanXmlFormat(r.root)).toBe('eplan_generic_xml');
  });

  it('returns unknown_xml for entirely unfamiliar XML', () => {
    expect(detectEplanXmlFormat(parseXml('<svg><path/></svg>').root)).toBe(
      'unknown_xml',
    );
  });

  it('returns unknown_xml for null root', () => {
    expect(detectEplanXmlFormat(null)).toBe('unknown_xml');
  });
});

// =============================================================================
// parseEplanXml — element extraction + diagnostics
// =============================================================================

describe('parseEplanXml', () => {
  it('extracts elements from attribute-only form', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0" direction="input"/></EplanProject>',
    );
    expect(r.format).toBe('eplan_project_xml');
    expect(r.elements.length).toBe(1);
    const el = r.elements[0];
    expect(el.tag).toBe('B1');
    expect(el.kind).toBe('sensor');
    expect(el.address).toBe('%I0.0');
    expect(el.direction).toBe('input');
    expect(el.sourcePath).toContain('/Element[1]');
  });

  it('extracts elements from nested-children form', () => {
    const r = parseEplanXml(
      '<EplanProject><Element id="el-1"><Tag>B1</Tag><Kind>sensor</Kind><PlcChannel address="%I0.0" direction="input"/></Element></EplanProject>',
    );
    const el = r.elements[0];
    expect(el.tag).toBe('B1');
    expect(el.kind).toBe('sensor');
    expect(el.address).toBe('%I0.0');
    expect(el.direction).toBe('input');
  });

  it('inherits sheet from parent <Page>', () => {
    const r = parseEplanXml(
      '<EplanProject><Pages><Page sheet="=A1/12"><Element tag="B1" kind="sensor"/></Page></Pages></EplanProject>',
    );
    expect(r.elements[0].sheet).toBe('=A1/12');
  });

  it('emits EPLAN_XML_EMPTY_INPUT for empty / non-string', () => {
    expect(codes(parseEplanXml('').diagnostics)).toContain('EPLAN_XML_EMPTY_INPUT');
    expect(codes(parseEplanXml(undefined as any).diagnostics)).toContain(
      'EPLAN_XML_EMPTY_INPUT',
    );
  });

  it('emits EPLAN_XML_MALFORMED on a parse error but never throws', () => {
    const r = parseEplanXml('<root><unterminated');
    expect(codes(r.diagnostics)).toContain('EPLAN_XML_MALFORMED');
  });

  it('emits EPLAN_XML_UNKNOWN_ROOT for an unfamiliar root', () => {
    const r = parseEplanXml('<svg><path/></svg>');
    expect(r.format).toBe('unknown_xml');
    expect(codes(r.diagnostics)).toContain('EPLAN_XML_UNKNOWN_ROOT');
  });

  it('emits EPLAN_XML_UNSUPPORTED_FORMAT only when strict=true', () => {
    const r1 = parseEplanXml('<svg/>');
    expect(codes(r1.diagnostics)).toContain('EPLAN_XML_UNKNOWN_ROOT');
    expect(codes(r1.diagnostics)).not.toContain('EPLAN_XML_UNSUPPORTED_FORMAT');
    const r2 = parseEplanXml('<svg/>', { strict: true });
    expect(codes(r2.diagnostics)).toContain('EPLAN_XML_UNSUPPORTED_FORMAT');
  });

  it('emits EPLAN_XML_PARTIAL_EXTRACTION when root looks right but has no <Element>', () => {
    const r = parseEplanXml('<EplanProject><Pages/></EplanProject>');
    expect(codes(r.diagnostics)).toContain('EPLAN_XML_PARTIAL_EXTRACTION');
  });
});

// =============================================================================
// mapEplanXmlElementToFragment — row → graph
// =============================================================================

describe('mapEplanXmlElementToFragment', () => {
  it('creates device + plc_channel + signals edge for an input sensor', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0" direction="input"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], {
      sourceId: 's',
      fileName: 'plan.xml',
    });
    const kinds = fragment.nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(['plc_channel', 'sensor']);
    expect(fragment.edges.length).toBe(1);
    expect(fragment.edges[0].kind).toBe('signals');
    const device = fragment.nodes.find((n) => n.kind === 'sensor')!;
    const channel = fragment.nodes.find((n) => n.kind === 'plc_channel')!;
    expect(fragment.edges[0].from).toBe(device.id);
    expect(fragment.edges[0].to).toBe(channel.id);
  });

  it('reverses the edge direction for output devices (channel → device, drives)', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="Y1" kind="valve" address="%Q0.0" direction="output"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], {
      sourceId: 's',
      fileName: 'plan.xml',
    });
    expect(fragment.edges[0].kind).toBe('drives');
    const device = fragment.nodes.find((n) => n.kind === 'valve')!;
    const channel = fragment.nodes.find((n) => n.kind === 'plc_channel')!;
    expect(fragment.edges[0].from).toBe(channel.id);
    expect(fragment.edges[0].to).toBe(device.id);
  });

  it('attaches a SourceRef with line + path + symbol locator + rawId to every node', () => {
    const xml =
      '<EplanProject>\n' +
      '  <Pages>\n' +
      '    <Page sheet="=A1/12">\n' +
      '      <Element tag="B1" kind="sensor" address="%I0.0" direction="input"/>\n' +
      '    </Page>\n' +
      '  </Pages>\n' +
      '</EplanProject>';
    const r = parseEplanXml(xml);
    const fragment = mapEplanXmlElementToFragment(r.elements[0], {
      sourceId: 'src-1',
      fileName: 'plan.xml',
    });
    for (const n of fragment.nodes) {
      expect(n.sourceRefs.length).toBeGreaterThan(0);
      const ref = n.sourceRefs[0];
      expect(ref.kind).toBe('eplan');
      expect(ref.path).toBe('plan.xml');
      expect(ref.sourceId).toBe('src-1');
      expect(typeof ref.line).toBe('number');
      expect(ref.symbol).toContain('/Element[1]');
    }
    const deviceRef = fragment.nodes
      .find((n) => n.kind === 'sensor')!
      .sourceRefs[0];
    expect(deviceRef.rawId).toBe('B1');
    expect(deviceRef.sheet).toBe('=A1/12');
  });

  it('attaches a SourceRef to every edge', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0" direction="input" terminal="X1:1" cable="W12"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], {
      sourceId: 's',
    });
    for (const e of fragment.edges) {
      expect(e.sourceRefs.length).toBeGreaterThan(0);
      expect(e.sourceRefs[0].kind).toBe('eplan');
    }
  });

  it('propagates function/location into device attributes', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="B1" kind="sensor" function="position-sense" location="cabinet-A1"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], { sourceId: 's' });
    const device = fragment.nodes.find((n) => n.kind === 'sensor')!;
    expect(device.attributes['function']).toBe('position-sense');
    expect(device.attributes['location']).toBe('cabinet-A1');
  });

  it('emits EPLAN_XML_MISSING_DEVICE_TAG and produces no nodes when tag is empty', () => {
    const r = parseEplanXml(
      '<EplanProject><Element kind="sensor" address="%I0.0"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], { sourceId: 's' });
    expect(fragment.nodes).toEqual([]);
    expect(fragment.edges).toEqual([]);
    expect(codes(fragment.diagnostics)).toContain('EPLAN_XML_MISSING_DEVICE_TAG');
  });

  it('emits EPLAN_XML_UNKNOWN_KIND and creates an unknown-kind device', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="X1" kind="mystery_box"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], { sourceId: 's' });
    expect(codes(fragment.diagnostics)).toContain('EPLAN_XML_UNKNOWN_KIND');
    const device = fragment.nodes.find((n) => n.id.startsWith('device:'))!;
    expect(device.kind).toBe('unknown');
  });

  it('emits EPLAN_XML_INVALID_ADDRESS and skips channel + edge', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="B1" kind="sensor" address="not-an-address"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], { sourceId: 's' });
    expect(codes(fragment.diagnostics)).toContain('EPLAN_XML_INVALID_ADDRESS');
    expect(fragment.nodes.find((n) => n.kind === 'plc_channel')).toBeUndefined();
    expect(fragment.edges).toEqual([]);
  });

  it('emits EPLAN_XML_DIRECTION_ADDRESS_CONFLICT when direction disagrees with address', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0" direction="output"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], { sourceId: 's' });
    expect(codes(fragment.diagnostics)).toContain(
      'EPLAN_XML_DIRECTION_ADDRESS_CONFLICT',
    );
  });

  it('creates terminal + cable + wire nodes when present', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0" terminal="X1:1" strip="X1" cable="W12" wire="C7"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], { sourceId: 's' });
    const kinds = fragment.nodes.map((n) => n.kind).sort();
    expect(kinds).toContain('terminal');
    expect(kinds).toContain('cable');
    expect(kinds).toContain('wire');
    expect(kinds).toContain('plc_channel');
    expect(kinds).toContain('sensor');
    expect(fragment.edges.length).toBeGreaterThanOrEqual(5);
  });

  it('infers signal_type=bool for bit-addressed channels', () => {
    const r = parseEplanXml(
      '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0"/></EplanProject>',
    );
    const fragment = mapEplanXmlElementToFragment(r.elements[0], { sourceId: 's' });
    const channel = fragment.nodes.find((n) => n.kind === 'plc_channel')!;
    expect(channel.attributes['signal_type']).toBe('bool');
  });
});

// =============================================================================
// ingestEplanXml — full-file integration
// =============================================================================

describe('ingestEplanXml', () => {
  it('uses a deterministic graph id', () => {
    const r = ingestEplanXml({
      sourceId: 'plan-1',
      text: '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0"/></EplanProject>',
    });
    expect(r.graph.id).toBe(buildEplanXmlGraphId('plan-1'));
    expect(r.graph.id).toBe('electrical_eplan_xml:plan-1');
    expect(r.graph.sourceKind).toBe('eplan-export');
  });

  it('records the input fileName under metadata.sourceFiles', () => {
    const r = ingestEplanXml({
      sourceId: 'plan-1',
      text: '<EplanProject><Element tag="B1" kind="sensor"/></EplanProject>',
      fileName: 'plan.xml',
    });
    expect(r.graph.metadata.sourceFiles).toEqual(['plan.xml']);
    expect(r.graph.metadata.generator).toBe('electrical-ingest@eplan-xml-v0');
  });

  it('skips duplicate-tag elements and never silently merges', () => {
    const xml =
      '<EplanProject>' +
      '<Element tag="B1" kind="sensor" address="%I0.0"/>' +
      '<Element tag="B1" kind="sensor" address="%I0.5"/>' +
      '</EplanProject>';
    const r = ingestEplanXml({ sourceId: 's', text: xml });
    expect(codes(r.graph.diagnostics)).toContain('EPLAN_XML_DUPLICATE_TAG');
    const devices = r.graph.nodes.filter((n) => n.id.startsWith('device:'));
    expect(devices).toHaveLength(1);
    const channels = r.graph.nodes.filter((n) => n.kind === 'plc_channel');
    expect(channels).toHaveLength(1);
    expect(channels[0].label).toBe('%I0.0');
  });

  it('flags duplicate address when two devices share a channel', () => {
    const xml =
      '<EplanProject>' +
      '<Element tag="M3" kind="motor" address="%Q0.0" direction="output"/>' +
      '<Element tag="B7" kind="sensor" address="%Q0.0" direction="input"/>' +
      '</EplanProject>';
    const r = ingestEplanXml({ sourceId: 's', text: xml });
    expect(codes(r.graph.diagnostics)).toContain('EPLAN_XML_DUPLICATE_ADDRESS');
  });

  it('returns an empty graph (with diagnostic) for unknown XML root, no throw', () => {
    const r = ingestEplanXml({ sourceId: 's', text: '<svg><path/></svg>' });
    expect(r.graph.nodes).toEqual([]);
    expect(r.graph.edges).toEqual([]);
    expect(codes(r.graph.diagnostics)).toContain('EPLAN_XML_UNKNOWN_ROOT');
  });

  it('does not throw on weird-but-valid XML (e.g. only metadata)', () => {
    expect(() =>
      ingestEplanXml({
        sourceId: 's',
        text: '<EplanProject><Pages><Page sheet="x"/></Pages></EplanProject>',
      }),
    ).not.toThrow();
  });
});

// =============================================================================
// PIR draft candidate integration
// =============================================================================

describe('EPLAN XML → PIR draft candidate', () => {
  it('produces input IO candidates from sensors', () => {
    const xml =
      '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0" direction="input"/></EplanProject>';
    const graph = ingestEplanXml({ sourceId: 's', text: xml }).graph;
    const candidate = buildPirDraftCandidate(graph);
    expect(candidate.io.length).toBe(1);
    expect(candidate.io[0].direction).toBe('input');
    expect(candidate.io[0].address).toBe('%I0.0');
    expect(
      candidate.io[0].sourceRefs.some((r) => r.kind === 'eplan'),
    ).toBe(true);
  });

  it('produces output IO + valve equipment for an output valve', () => {
    const xml =
      '<EplanProject><Element tag="Y1" kind="valve" address="%Q0.0" direction="output"/></EplanProject>';
    const graph = ingestEplanXml({ sourceId: 's', text: xml }).graph;
    const candidate = buildPirDraftCandidate(graph);
    expect(candidate.io[0].direction).toBe('output');
    const equip = candidate.equipment.find((e) => e.kind === 'valve_solenoid');
    expect(equip).toBeDefined();
  });

  it('produces motor equipment candidate from XML motor row', () => {
    const xml =
      '<EplanProject><Element tag="M1" kind="motor" address="%Q0.2" direction="output"/></EplanProject>';
    const graph = ingestEplanXml({ sourceId: 's', text: xml }).graph;
    const candidate = buildPirDraftCandidate(graph);
    expect(candidate.equipment.some((e) => e.kind === 'motor_simple')).toBe(true);
  });

  it('unknown kind becomes assumption / diagnostic, never confident equipment', () => {
    const xml =
      '<EplanProject><Element tag="X1" kind="mystery_box"/></EplanProject>';
    const graph = ingestEplanXml({ sourceId: 's', text: xml }).graph;
    const candidate = buildPirDraftCandidate(graph);
    expect(candidate.equipment).toHaveLength(0);
    const ds = candidate.diagnostics.map((d) => d.code);
    expect(
      ds.includes('UNKNOWN_DEVICE_ROLE') ||
        ds.includes('LOW_CONFIDENCE_DEVICE_CLASSIFICATION'),
    ).toBe(true);
  });

  it('preserves XML source refs into IO + equipment candidates', () => {
    const xml =
      '<EplanProject><Pages><Page sheet="=A1/12">' +
      '<Element tag="B1" kind="sensor" address="%I0.0" direction="input"/>' +
      '</Page></Pages></EplanProject>';
    const graph = ingestEplanXml({
      sourceId: 's',
      text: xml,
      fileName: 'plan.xml',
    }).graph;
    const candidate = buildPirDraftCandidate(graph);
    const io = candidate.io[0];
    expect(io.sourceRefs.some((r) => r.kind === 'eplan' && r.sheet === '=A1/12')).toBe(
      true,
    );
  });
});

// =============================================================================
// Source registry routing
// =============================================================================

describe('Source registry — Sprint 74 routing', () => {
  it('XML ingestor canIngest accepts XML files with content; rejects other kinds', () => {
    const ing = createEplanXmlElectricalIngestor();
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
    ).toBe(true);
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [{ path: 'plan.xml', kind: 'xml' }],
      }),
    ).toBe(false);
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [{ path: 'a.csv', kind: 'csv', content: 'tag,kind\n' }],
      }),
    ).toBe(false);
    expect(ing.canIngest({ sourceId: 's', files: [] })).toBe(false);
  });

  it('default registry routes CSV to CSV ingestor (Sprint 73 unchanged)', async () => {
    const reg = createDefaultSourceRegistry();
    const result = await ingestWithRegistry(reg, {
      sourceId: 'plan',
      files: [
        {
          path: 'list.csv',
          kind: 'csv',
          content: 'tag,kind,address\nB1,sensor,%I0.0\n',
        },
      ],
    } as ElectricalIngestionInput);
    expect(result.graph.sourceKind).toBe('csv');
    expect(codes(result.diagnostics)).not.toContain('UNSUPPORTED_SOURCE_FEATURE');
    expect(codes(result.diagnostics)).not.toContain('EPLAN_XML_UNKNOWN_ROOT');
  });

  it('default registry routes supported XML to the EPLAN XML ingestor', async () => {
    const reg = createDefaultSourceRegistry();
    const result = await ingestWithRegistry(reg, {
      sourceId: 'plan',
      files: [
        {
          path: 'plan.xml',
          kind: 'xml',
          content:
            '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0"/></EplanProject>',
        },
      ],
    } as ElectricalIngestionInput);
    expect(result.graph.sourceKind).toBe('eplan-export');
    expect(result.graph.nodes.find((n) => n.kind === 'sensor')).toBeDefined();
    // Should NOT have hit the unsupported stub.
    expect(codes(result.diagnostics)).not.toContain('UNSUPPORTED_SOURCE_FEATURE');
  });

  it('default registry handles unknown XML root with EPLAN_XML_UNKNOWN_ROOT (no fall-through)', async () => {
    const reg = createDefaultSourceRegistry();
    const result = await ingestWithRegistry(reg, {
      sourceId: 's',
      files: [{ path: 'svg.xml', kind: 'xml', content: '<svg><path/></svg>' }],
    } as ElectricalIngestionInput);
    expect(codes(result.diagnostics)).toContain('EPLAN_XML_UNKNOWN_ROOT');
    expect(codes(result.diagnostics)).not.toContain('UNSUPPORTED_SOURCE_FEATURE');
  });

  it('edz / pdf still fall through to the unsupported EPLAN stub', async () => {
    const reg = createDefaultSourceRegistry();
    const r1 = await ingestWithRegistry(reg, {
      sourceId: 's',
      files: [{ path: 'a.edz', kind: 'edz' }],
    } as ElectricalIngestionInput);
    expect(codes(r1.diagnostics)).toContain('UNSUPPORTED_SOURCE_FEATURE');

    const r2 = await ingestWithRegistry(reg, {
      sourceId: 's',
      files: [{ path: 'a.pdf', kind: 'pdf' }],
    } as ElectricalIngestionInput);
    expect(codes(r2.diagnostics)).toContain('UNSUPPORTED_SOURCE_FEATURE');
  });

  it('XML ingestor accepts Uint8Array content', async () => {
    const ing = createEplanXmlElectricalIngestor();
    const utf8 = new TextEncoder().encode(
      '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0"/></EplanProject>',
    );
    const r = await ing.ingest({
      sourceId: 's',
      files: [{ path: 'plan.xml', kind: 'xml', content: utf8 }],
    });
    expect(r.graph.nodes.find((n) => n.kind === 'sensor')).toBeDefined();
  });

  it('XML ingestor merges multiple XML files into one graph', async () => {
    const ing = createEplanXmlElectricalIngestor();
    const r = await ing.ingest({
      sourceId: 's',
      files: [
        {
          path: 'a.xml',
          kind: 'xml',
          content: '<EplanProject><Element tag="B1" kind="sensor" address="%I0.0"/></EplanProject>',
        },
        {
          path: 'b.xml',
          kind: 'xml',
          content: '<EplanProject><Element tag="Y1" kind="valve" address="%Q0.0" direction="output"/></EplanProject>',
        },
      ],
    });
    expect(r.graph.metadata.sourceFiles).toEqual(['a.xml', 'b.xml']);
    expect(r.graph.nodes.find((n) => n.kind === 'sensor')).toBeDefined();
    expect(r.graph.nodes.find((n) => n.kind === 'valve')).toBeDefined();
  });
});

// =============================================================================
// Golden fixtures
// =============================================================================

describe('fixture: simple-eplan-export.xml', () => {
  let graph: ElectricalGraph;
  beforeAll(() => {
    const text = readFileSync(FIXTURE_SIMPLE, 'utf-8');
    graph = ingestEplanXml({
      sourceId: 'simple',
      text,
      fileName: 'simple-eplan-export.xml',
    }).graph;
  });

  it('parses without errors', () => {
    expect(codes(graph.diagnostics)).not.toContain('EPLAN_XML_MALFORMED');
    expect(codes(graph.diagnostics)).not.toContain('EPLAN_XML_UNKNOWN_ROOT');
  });

  it('graph id and source kind are deterministic', () => {
    expect(graph.id).toBe('electrical_eplan_xml:simple');
    expect(graph.sourceKind).toBe('eplan-export');
  });

  it('every node carries at least one EPLAN-kind source ref', () => {
    for (const n of graph.nodes) {
      expect(n.sourceRefs.some((r) => r.kind === 'eplan')).toBe(true);
    }
  });

  it('every device row produces a deterministic device id', () => {
    for (const tag of ['B1', 'B2', 'Y1', 'Y2', 'M1', 'S1']) {
      expect(graph.nodes.find((n) => n.id === `device:${tag}`)).toBeDefined();
    }
  });

  it('produces 5 distinct PLC channels (S1 has no address)', () => {
    const channels = graph.nodes.filter((n) => n.kind === 'plc_channel');
    expect(channels.map((c) => c.label).sort()).toEqual([
      '%I0.0',
      '%I0.1',
      '%Q0.0',
      '%Q0.1',
      '%Q0.2',
    ]);
  });

  it('Page <Page sheet=...> is inherited as SourceRef.sheet', () => {
    const b1 = graph.nodes.find((n) => n.id === 'device:B1')!;
    expect(b1.sourceRefs.some((r) => r.sheet === '=A1/12')).toBe(true);
  });
});

describe('fixture: ambiguous-eplan-export.xml', () => {
  let graph: ElectricalGraph;
  beforeAll(() => {
    const text = readFileSync(FIXTURE_AMBIGUOUS, 'utf-8');
    graph = ingestEplanXml({
      sourceId: 'amb',
      text,
      fileName: 'ambiguous-eplan-export.xml',
    }).graph;
  });

  it('does not throw and emits expected diagnostic classes', () => {
    const observed = new Set(codes(graph.diagnostics));
    expect(observed.has('EPLAN_XML_MISSING_DEVICE_TAG')).toBe(true);
    expect(observed.has('EPLAN_XML_INVALID_ADDRESS')).toBe(true);
    expect(observed.has('EPLAN_XML_DUPLICATE_TAG')).toBe(true);
    expect(observed.has('EPLAN_XML_UNKNOWN_KIND')).toBe(true);
    expect(observed.has('EPLAN_XML_DIRECTION_ADDRESS_CONFLICT')).toBe(true);
    expect(observed.has('EPLAN_XML_DUPLICATE_ADDRESS')).toBe(true);
  });

  it('every diagnostic with sourceRef points at a real XML line', () => {
    for (const d of graph.diagnostics) {
      if (d.sourceRef && d.sourceRef.kind === 'eplan') {
        expect(typeof d.sourceRef.line).toBe('number');
      }
    }
  });

  it('escaped XML entities round-trip in element label', () => {
    const m4 = graph.nodes.find((n) => n.id === 'device:M4');
    expect(m4?.label).toBe('Cell with "escaped & quote"');
  });

  it('XML comment inside an element does not break extraction', () => {
    const m4 = graph.nodes.find((n) => n.id === 'device:M4');
    expect(m4?.attributes['function']).toBe('conveyor');
  });
});
