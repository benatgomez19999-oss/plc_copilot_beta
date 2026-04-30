// Sprint 74 — EPLAN structured XML ingestor v0.
//
// Honest scope:
//   - Accepts a small, fixture-driven XML schema that EPLAN
//     exports often *resemble*: a top-level `EplanProject` (or
//     similar) wrapping `Page`s of `Element`s, each with optional
//     PlcChannel / Terminal / Cable / Wire children.
//   - Provides `canIngest === true` for any `kind: 'xml'` file
//     with content (so it owns XML routing) but reports honestly
//     when the structure isn't recognised: emits
//     `EPLAN_XML_UNKNOWN_ROOT` / `EPLAN_XML_UNSUPPORTED_FORMAT` and
//     returns an empty graph rather than inventing nodes.
//   - Reuses Sprint 73's helpers verbatim: `detectPlcAddress`,
//     `KIND_ALIASES`, `confidenceFromEvidence`, `mergeSourceRefs`,
//     `normalizeNodeId`. Same diagnostics severity model.
//   - Never throws on malformed input — the parser surfaces
//     errors structurally.
//
// NOT in scope:
//   - PDF / OCR (Sprint 76+).
//   - EDZ / EPDZ archive extraction (still falls through to the
//     unsupported stub for non-XML EPLAN bundles).
//   - Real EPLAN schema guarantee — fixtures are described as
//     "representative structured XML", not vendor-certified
//     compatibility. See `docs/electrical-eplan-xml-format.md`.

import { confidenceFromEvidence, confidenceOf } from '../confidence.js';
import { createElectricalDiagnostic } from '../diagnostics.js';
import { KIND_ALIASES, knownKindHintList } from '../mapping/kind-aliases.js';
import {
  extractStructuredParameterDraft,
  isStructuredParameterDraftEmpty,
} from '../mapping/structured-parameter-draft.js';
import { detectPlcAddress, normalizeNodeId } from '../normalize.js';
import { mergeSourceRefs } from './trace.js';
import {
  findAllElements,
  findElement,
  getAttribute,
  getChildText,
  parseXml,
  walkElements,
  type XmlElement,
} from './xml-utils.js';
import type {
  ElectricalDiagnostic,
  ElectricalEdge,
  ElectricalEdgeKind,
  ElectricalGraph,
  ElectricalIngestionInput,
  ElectricalIngestionResult,
  ElectricalNode,
  ElectricalNodeKind,
  ElectricalSourceIngestor,
  Evidence,
  SourceRef,
} from '../types.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type EplanXmlDetectedFormat =
  | 'eplan_project_xml'
  | 'eplan_generic_xml'
  | 'unknown_xml';

const PROJECT_ROOTS = new Set([
  'eplanproject',
  'project',
  'electricalproject',
]);
const GENERIC_ROOTS = new Set([
  'electrical',
  'electricallist',
  'devicelist',
  'pages',
  'elements',
]);

export function detectEplanXmlFormat(root: XmlElement | null): EplanXmlDetectedFormat {
  if (!root) return 'unknown_xml';
  const lower = root.tagLower;
  if (PROJECT_ROOTS.has(lower)) return 'eplan_project_xml';
  if (GENERIC_ROOTS.has(lower)) return 'eplan_generic_xml';
  // Even an unfamiliar root may yield useful data if it contains
  // <Element> descendants — accept tentatively as "generic".
  for (const el of walkElements(root)) {
    if (el.tagLower === 'element') return 'eplan_generic_xml';
  }
  return 'unknown_xml';
}

// ---------------------------------------------------------------------------
// Element extraction
// ---------------------------------------------------------------------------

export interface EplanXmlElementRecord {
  /** Synthetic id derived from element id / tag / locator order. */
  elementId: string;
  /** Tag/equipment id (canonical handle for the device). */
  tag?: string;
  /** Raw kind text from the XML, before alias resolution. */
  kind?: string;
  address?: string;
  direction?: string;
  label?: string;
  terminal?: string;
  terminalStrip?: string;
  cable?: string;
  wire?: string;
  sheet?: string;
  page?: string;
  function?: string;
  location?: string;
  plc?: string;
  module?: string;
  channel?: string;
  /** Locator path inside the XML document — e.g. `/EplanProject/Pages/Page[1]/Element[2]`. */
  sourcePath: string;
  /** All raw attributes from the source element, for diagnostics + future enrichment. */
  attributes: Record<string, string>;
  /** 1-based line of the opening `<Element>` tag. */
  line: number;
}

export interface EplanXmlParseResult {
  format: EplanXmlDetectedFormat;
  elements: EplanXmlElementRecord[];
  /** Page-level `sheet` / `name` annotations, indexed by element id. Useful for sheet inheritance. */
  diagnostics: ElectricalDiagnostic[];
  /**
   * Sprint 88M — parsed XML root, exposed so structured
   * extractors (`extractStructuredParameterDraft`) can walk the
   * tree without re-parsing. `null` when the XML failed to parse
   * or had no root element.
   */
  root?: XmlElement | null;
}

export interface EplanXmlIngestionOptions {
  minConfidence?: number;
  /**
   * If true, an `unknown_xml` format becomes a hard error rather
   * than a warning. Default false — we keep "unknown root" honest
   * but non-fatal so callers see whatever data we *can* recover.
   */
  strict?: boolean;
  formatHint?: 'eplan-xml' | 'eplan-project-xml' | 'unknown';
}

export interface EplanXmlIngestionInput {
  sourceId: string;
  text: string;
  fileName?: string;
  options?: EplanXmlIngestionOptions;
}

function makeXmlSourceRef(
  sourceId: string,
  fileName: string | undefined,
  line: number,
  rawId: string | undefined,
  sheet: string | undefined,
  symbol: string,
): SourceRef {
  const ref: SourceRef = {
    sourceId,
    kind: 'eplan',
    line,
    symbol,
  };
  if (typeof fileName === 'string' && fileName.length > 0) ref.path = fileName;
  if (typeof rawId === 'string' && rawId.length > 0) ref.rawId = rawId;
  if (typeof sheet === 'string' && sheet.length > 0) ref.sheet = sheet;
  return ref;
}

/**
 * Extract one `<Element>` (or equivalent) from the XML tree into
 * the canonical record shape. Sprint 74 v0 supports two patterns:
 *
 *   - Attributes on the element itself:
 *       <Element id="el-1" tag="B1" kind="sensor" address="%I0.0" .../>
 *   - Nested children:
 *       <Element id="el-1">
 *         <Tag>B1</Tag>
 *         <Kind>sensor</Kind>
 *         <PlcChannel address="%I0.0" direction="input"/>
 *         <Terminal id="X1:1" strip="X1"/>
 *         <Cable id="W12"/>
 *       </Element>
 *
 * The two are interchangeable; the extractor checks attributes
 * first then falls back to children.
 */
function extractElementRecord(
  el: XmlElement,
  inheritedSheet: string | undefined,
  inheritedPage: string | undefined,
): EplanXmlElementRecord {
  const attrs: Record<string, string> = {};
  for (const a of el.attrs) attrs[a.name.toLowerCase()] = a.value;

  // PlcChannel (nested) overrides direct address/direction/etc.
  const plcChannelEl = el.children.find((c) => c.tagLower === 'plcchannel' || c.tagLower === 'channel');
  const terminalEl = el.children.find((c) => c.tagLower === 'terminal');
  const cableEl = el.children.find((c) => c.tagLower === 'cable');
  const wireEl = el.children.find((c) => c.tagLower === 'wire' || c.tagLower === 'conductor');

  // Priority: explicit `tag` attribute > <Tag> child > explicit
  // device-tag / equipment-id attributes > <Name> child. We do NOT
  // fall back to a generic `id` / `name` attribute — those usually
  // identify the *element* (e.g. `id="el-003"` from EPLAN's element
  // numbering), not the *device tag*. An element without a real
  // device tag should fail closed (`EPLAN_XML_MISSING_DEVICE_TAG`)
  // rather than silently invent a device whose id is the element
  // numbering id.
  const tag =
    getAttribute(el, 'tag') ??
    getChildText(el, 'tag') ??
    getAttribute(el, 'device-tag', 'equipment-id') ??
    getChildText(el, 'name') ??
    undefined;

  const kindFromAttr = getAttribute(el, 'kind', 'type', 'devicetype', 'equipmenttype');
  const kindFromChild = getChildText(el, 'kind') ?? getChildText(el, 'type');
  const kind = kindFromAttr ?? kindFromChild ?? undefined;

  const addressFromAttr = getAttribute(el, 'address', 'ioaddress', 'plcaddress');
  const addressFromChannel = plcChannelEl
    ? getAttribute(plcChannelEl, 'address', 'ioaddress', 'plcaddress')
    : null;
  const address = addressFromChannel ?? addressFromAttr ?? undefined;

  const directionFromAttr = getAttribute(el, 'direction', 'iodirection', 'dir');
  const directionFromChannel = plcChannelEl ? getAttribute(plcChannelEl, 'direction', 'dir') : null;
  const direction = directionFromChannel ?? directionFromAttr ?? undefined;

  const labelFromAttr = getAttribute(el, 'label', 'description', 'text');
  const labelFromChild =
    getChildText(el, 'label') ?? getChildText(el, 'description') ?? getChildText(el, 'text');
  const label = labelFromAttr ?? labelFromChild ?? undefined;

  const terminalFromAttr = getAttribute(el, 'terminal');
  const terminalFromChild = terminalEl
    ? getAttribute(terminalEl, 'id', 'tag', 'name')
    : null;
  const terminal = terminalFromChild ?? terminalFromAttr ?? undefined;

  const stripFromAttr = getAttribute(el, 'terminalstrip', 'strip');
  const stripFromChild = terminalEl ? getAttribute(terminalEl, 'strip') : null;
  const terminalStrip = stripFromChild ?? stripFromAttr ?? undefined;

  const cableFromAttr = getAttribute(el, 'cable', 'cableid');
  const cableFromChild = cableEl ? getAttribute(cableEl, 'id', 'tag', 'name') : null;
  const cable = cableFromChild ?? cableFromAttr ?? undefined;

  const wireFromAttr = getAttribute(el, 'wire', 'wireid', 'conductor');
  const wireFromChild = wireEl ? getAttribute(wireEl, 'id', 'tag', 'name') : null;
  const wire = wireFromChild ?? wireFromAttr ?? undefined;

  const sheet = getAttribute(el, 'sheet') ?? getChildText(el, 'sheet') ?? inheritedSheet ?? undefined;
  const page = getAttribute(el, 'page') ?? getChildText(el, 'page') ?? inheritedPage ?? undefined;

  const fn = getAttribute(el, 'function') ?? getChildText(el, 'function') ?? undefined;
  const loc = getAttribute(el, 'location') ?? getChildText(el, 'location') ?? undefined;

  const plc = plcChannelEl ? getAttribute(plcChannelEl, 'plc') : getAttribute(el, 'plc');
  const module = plcChannelEl
    ? getAttribute(plcChannelEl, 'module', 'card')
    : getAttribute(el, 'module', 'card');
  const channel = plcChannelEl
    ? getAttribute(plcChannelEl, 'channel')
    : getAttribute(el, 'channel');

  // Synthesise an elementId. Prefer the source's id attribute;
  // otherwise fall back to the locator (always unique per document).
  const elementId =
    getAttribute(el, 'id', 'elementid') ?? `xmlnode:${el.locator}`;

  return {
    elementId,
    tag,
    kind,
    address,
    direction,
    label,
    terminal,
    terminalStrip,
    cable,
    wire,
    sheet,
    page,
    function: fn ?? undefined,
    location: loc ?? undefined,
    plc: plc ?? undefined,
    module: module ?? undefined,
    channel: channel ?? undefined,
    sourcePath: el.locator,
    attributes: attrs,
    line: el.line,
  };
}

/**
 * Walk the XML tree picking out `<Element>` nodes (case-insensitive).
 * Inherits `sheet` / `name` attributes from any ancestor `<Page>`.
 */
function extractAllElements(root: XmlElement): EplanXmlElementRecord[] {
  const out: EplanXmlElementRecord[] = [];

  function descend(
    el: XmlElement,
    inheritedSheet: string | undefined,
    inheritedPage: string | undefined,
  ): void {
    let sheet = inheritedSheet;
    let page = inheritedPage;
    if (el.tagLower === 'page') {
      const sheetAttr = getAttribute(el, 'sheet', 'id', 'name');
      const pageAttr = getAttribute(el, 'page', 'number');
      if (sheetAttr) sheet = sheetAttr;
      if (pageAttr) page = pageAttr;
    }
    if (el.tagLower === 'element') {
      out.push(extractElementRecord(el, sheet, page));
    }
    for (const c of el.children) descend(c, sheet, page);
  }

  descend(root, undefined, undefined);
  return out;
}

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

/**
 * Parse an XML string into the canonical element-record list.
 * Pure. Returns `format: 'unknown_xml'` + `EPLAN_XML_UNKNOWN_ROOT`
 * when the root tag isn't recognised; still attempts to extract
 * any `<Element>` nodes so callers see partial recovery.
 */
export function parseEplanXml(
  text: string,
  options: EplanXmlIngestionOptions = {},
): EplanXmlParseResult {
  const diagnostics: ElectricalDiagnostic[] = [];
  if (typeof text !== 'string' || text.length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'EPLAN_XML_EMPTY_INPUT',
        message: 'EPLAN XML input was empty.',
      }),
    );
    return { format: 'unknown_xml', elements: [], diagnostics, root: null };
  }

  const parsed = parseXml(text);
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'EPLAN_XML_MALFORMED',
          message: `XML parse error at line ${e.line} col ${e.column}: ${e.message}`,
        }),
      );
    }
  }
  if (!parsed.root) {
    return { format: 'unknown_xml', elements: [], diagnostics, root: null };
  }

  const format = detectEplanXmlFormat(parsed.root);
  if (format === 'unknown_xml') {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'EPLAN_XML_UNKNOWN_ROOT',
        message: `XML root <${parsed.root.tag}> is not a recognised EPLAN structure.`,
        hint:
          'recognised roots: EplanProject, Project, ElectricalProject, Electrical, Pages, Elements, or any document containing <Element> descendants.',
      }),
    );
    if (options.strict === true) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'EPLAN_XML_UNSUPPORTED_FORMAT',
          severity: 'error',
          message: `strict mode: refusing to extract from unsupported XML format ${JSON.stringify(parsed.root.tag)}.`,
        }),
      );
      return { format, elements: [], diagnostics, root: parsed.root };
    }
  }

  const elements = extractAllElements(parsed.root);
  if (elements.length === 0 && format !== 'unknown_xml') {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'EPLAN_XML_PARTIAL_EXTRACTION',
        message:
          'XML root looked like an EPLAN structure but contained no <Element> children — nothing to ingest.',
      }),
    );
  }
  return { format, elements, diagnostics, root: parsed.root };
}

// ---------------------------------------------------------------------------
// Mapping — element record → graph fragment
// ---------------------------------------------------------------------------

export interface XmlRowMappingResult {
  nodes: ElectricalNode[];
  edges: ElectricalEdge[];
  diagnostics: ElectricalDiagnostic[];
}

export function mapEplanXmlElementToFragment(
  rec: EplanXmlElementRecord,
  context: { sourceId: string; fileName?: string },
): XmlRowMappingResult {
  const nodes: ElectricalNode[] = [];
  const edges: ElectricalEdge[] = [];
  const diagnostics: ElectricalDiagnostic[] = [];

  if (!rec.tag || rec.tag.length === 0) {
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'EPLAN_XML_MISSING_DEVICE_TAG',
        message: `EPLAN XML element at ${rec.sourcePath} (line ${rec.line}) has no tag — skipping.`,
        sourceRef: makeXmlSourceRef(
          context.sourceId,
          context.fileName,
          rec.line,
          rec.elementId,
          rec.sheet,
          rec.sourcePath,
        ),
      }),
    );
    return { nodes, edges, diagnostics };
  }

  const baseRef = makeXmlSourceRef(
    context.sourceId,
    context.fileName,
    rec.line,
    rec.tag,
    rec.sheet ?? rec.page,
    rec.sourcePath,
  );

  // -------------------------------------------------------------
  // Device node
  // -------------------------------------------------------------
  const rawKind = (rec.kind ?? '').toLowerCase();
  let deviceKind: ElectricalNodeKind = 'unknown';
  const kindEvidence: Evidence[] = [];
  if (rawKind.length === 0) {
    kindEvidence.push({
      source: 'eplan-xml-kind-empty',
      score: 0.2,
      reason: 'kind attribute/element empty',
    });
  } else {
    const mapped = KIND_ALIASES.get(rawKind);
    if (mapped) {
      deviceKind = mapped;
      kindEvidence.push({
        source: 'eplan-xml-kind',
        score: 0.85,
        reason: `kind=${rawKind} → ${mapped}`,
      });
    } else {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'EPLAN_XML_UNKNOWN_KIND',
          message: `EPLAN XML element ${JSON.stringify(rec.tag)} at line ${rec.line} has unknown kind ${JSON.stringify(rawKind)}.`,
          sourceRef: baseRef,
          hint: `recognised kinds: ${knownKindHintList()}.`,
        }),
      );
      kindEvidence.push({
        source: 'eplan-xml-kind',
        score: 0.4,
        reason: `unknown kind=${rawKind}; capped`,
      });
    }
  }

  const deviceId = normalizeNodeId(`device:${rec.tag}`);
  const attributes: Record<string, string | number | boolean> = {
    raw_tag: rec.tag,
  };
  if (rawKind.length > 0) attributes['raw_kind'] = rawKind;
  if (rec.function) attributes['function'] = rec.function;
  if (rec.location) attributes['location'] = rec.location;
  if (rec.elementId) attributes['xml_element_id'] = rec.elementId;
  attributes['xml_source_path'] = rec.sourcePath;

  const deviceNode: ElectricalNode = {
    id: deviceId,
    kind: deviceKind,
    label: rec.label ?? rec.tag,
    sourceRefs: [baseRef],
    confidence: confidenceFromEvidence(kindEvidence),
    attributes,
  };
  nodes.push(deviceNode);

  // -------------------------------------------------------------
  // PLC channel node
  // -------------------------------------------------------------
  let channelNode: ElectricalNode | null = null;
  if (rec.address) {
    const detected = detectPlcAddress(rec.address);
    if (!detected) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'EPLAN_XML_INVALID_ADDRESS',
          message: `EPLAN XML element ${JSON.stringify(rec.tag)} (line ${rec.line}) has unrecognised PLC address ${JSON.stringify(rec.address)}.`,
          sourceRef: baseRef,
          hint: 'use a strict form: %I0.0 / %Q1.7 / Local:1:I.Data[0].0 / I0.0 / Q1.7.',
        }),
      );
    } else {
      const channelId = normalizeNodeId(`plc_channel:${detected.raw}`);
      const channelAttrs: Record<string, string | number | boolean> = {
        address: detected.raw,
        family: detected.family,
        direction: detected.direction,
      };
      if (rec.plc) channelAttrs['plc'] = rec.plc;
      if (rec.module) channelAttrs['module'] = rec.module;
      if (rec.channel) channelAttrs['channel'] = rec.channel;

      // Direction conflict check.
      const colDir = (rec.direction ?? '').toLowerCase();
      if (
        colDir.length > 0 &&
        (colDir === 'input' || colDir === 'output') &&
        detected.direction !== 'unknown' &&
        colDir !== detected.direction
      ) {
        diagnostics.push(
          createElectricalDiagnostic({
            code: 'EPLAN_XML_DIRECTION_ADDRESS_CONFLICT',
            message: `EPLAN XML element ${JSON.stringify(rec.tag)} (line ${rec.line}) has direction=${colDir} but address ${detected.raw} implies ${detected.direction}.`,
            sourceRef: baseRef,
          }),
        );
      }

      const isBit = /\.\d+$/.test(detected.raw) || /[A-Z]X\d/i.test(detected.raw);
      if (isBit) channelAttrs['signal_type'] = 'bool';

      channelNode = {
        id: channelId,
        kind: 'plc_channel',
        label: detected.raw,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.85, `address ${detected.raw} parsed as ${detected.family}`),
        attributes: channelAttrs,
      };
      nodes.push(channelNode);

      const edgeKind: ElectricalEdgeKind =
        detected.direction === 'output' ? 'drives' : 'signals';
      edges.push({
        id: normalizeNodeId(
          `e_${detected.direction === 'output' ? channelNode.id : deviceNode.id}_${detected.direction === 'output' ? deviceNode.id : channelNode.id}_${edgeKind}`,
        ),
        kind: edgeKind,
        from: detected.direction === 'output' ? channelNode.id : deviceNode.id,
        to: detected.direction === 'output' ? deviceNode.id : channelNode.id,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.8, 'eplan-xml device ↔ channel binding'),
        attributes: {},
      });
    }
  }

  // -------------------------------------------------------------
  // Terminal + cable + wire (same shape as CSV)
  // -------------------------------------------------------------
  let terminalNode: ElectricalNode | null = null;
  if (rec.terminal) {
    const termId = normalizeNodeId(`terminal:${rec.terminal}`);
    terminalNode = {
      id: termId,
      kind: 'terminal',
      label: rec.terminal,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.8, 'eplan-xml terminal'),
      attributes: {
        terminal: rec.terminal,
        ...(rec.terminalStrip ? { strip: rec.terminalStrip } : {}),
      },
    };
    nodes.push(terminalNode);
    edges.push({
      id: normalizeNodeId(`e_${deviceNode.id}_${terminalNode.id}_wired_to`),
      kind: 'wired_to',
      from: deviceNode.id,
      to: terminalNode.id,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.8, 'eplan-xml device wired_to terminal'),
      attributes: {},
    });
    if (channelNode) {
      edges.push({
        id: normalizeNodeId(`e_${terminalNode.id}_${channelNode.id}_wired_to`),
        kind: 'wired_to',
        from: terminalNode.id,
        to: channelNode.id,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.7, 'eplan-xml terminal wired_to channel'),
        attributes: {},
      });
    }
  }

  if (rec.cable) {
    const cableId = normalizeNodeId(`cable:${rec.cable}`);
    nodes.push({
      id: cableId,
      kind: 'cable',
      label: rec.cable,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.7, 'eplan-xml cable'),
      attributes: { cable: rec.cable },
    });
    if (terminalNode) {
      edges.push({
        id: normalizeNodeId(`e_${terminalNode.id}_${cableId}_wired_to`),
        kind: 'wired_to',
        from: terminalNode.id,
        to: cableId,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.7, 'eplan-xml terminal wired_to cable'),
        attributes: {},
      });
    }
  }
  if (rec.wire) {
    const wireId = normalizeNodeId(`wire:${rec.wire}`);
    nodes.push({
      id: wireId,
      kind: 'wire',
      label: rec.wire,
      sourceRefs: [baseRef],
      confidence: confidenceOf(0.65, 'eplan-xml wire'),
      attributes: { wire: rec.wire },
    });
    if (terminalNode) {
      edges.push({
        id: normalizeNodeId(`e_${terminalNode.id}_${wireId}_wired_to`),
        kind: 'wired_to',
        from: terminalNode.id,
        to: wireId,
        sourceRefs: [baseRef],
        confidence: confidenceOf(0.65, 'eplan-xml terminal wired_to wire'),
        attributes: {},
      });
    }
  }

  return { nodes, edges, diagnostics };
}

// ---------------------------------------------------------------------------
// Graph id + ingestor
// ---------------------------------------------------------------------------

export function buildEplanXmlGraphId(sourceId: string): string {
  return `electrical_eplan_xml:${sourceId}`;
}

export function ingestEplanXml(
  input: EplanXmlIngestionInput,
): ElectricalIngestionResult {
  const sourceId = input.sourceId;
  const fileName = input.fileName;
  const parseResult = parseEplanXml(input.text, input.options ?? {});
  const diagnostics: ElectricalDiagnostic[] = [...parseResult.diagnostics];
  const allNodes: ElectricalNode[] = [];
  const allEdges: ElectricalEdge[] = [];

  const seenTags = new Map<string, number>();
  const channelToDevices = new Map<string, string[]>();

  for (const rec of parseResult.elements) {
    if (rec.tag) {
      if (seenTags.has(rec.tag)) {
        diagnostics.push(
          createElectricalDiagnostic({
            code: 'EPLAN_XML_DUPLICATE_TAG',
            message: `EPLAN XML element at line ${rec.line} has duplicate tag ${JSON.stringify(rec.tag)} (first seen at line ${seenTags.get(rec.tag)}). Element skipped.`,
            sourceRef: makeXmlSourceRef(
              sourceId,
              fileName,
              rec.line,
              rec.tag,
              rec.sheet ?? rec.page,
              rec.sourcePath,
            ),
          }),
        );
        continue;
      }
      seenTags.set(rec.tag, rec.line);
    }

    const fragment = mapEplanXmlElementToFragment(rec, { sourceId, fileName });
    diagnostics.push(...fragment.diagnostics);

    for (const n of fragment.nodes) {
      const existing = allNodes.find((x) => x.id === n.id);
      if (!existing) {
        allNodes.push(n);
      } else {
        existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, n.sourceRefs);
      }
    }
    for (const e of fragment.edges) {
      const existing = allEdges.find((x) => x.id === e.id);
      if (!existing) {
        allEdges.push(e);
      } else {
        existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, e.sourceRefs);
      }
    }

    const channelNode = fragment.nodes.find((n) => n.kind === 'plc_channel');
    const deviceNode = fragment.nodes.find(
      (n) => n.kind !== 'plc_channel' && n.id.startsWith('device:'),
    );
    if (channelNode && deviceNode) {
      const list = channelToDevices.get(channelNode.id) ?? [];
      list.push(deviceNode.id);
      channelToDevices.set(channelNode.id, list);
    }
  }

  for (const [channelId, deviceIds] of channelToDevices) {
    if (deviceIds.length > 1) {
      const node = allNodes.find((n) => n.id === channelId);
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'EPLAN_XML_DUPLICATE_ADDRESS',
          message: `PLC channel ${node?.label ?? channelId} is referenced by ${deviceIds.length} devices (${deviceIds.join(', ')}).`,
          nodeId: channelId,
          hint:
            'shared inputs / common returns are legitimate, but verify against the schematic.',
        }),
      );
    }
  }

  const metadata: ElectricalGraph['metadata'] = {
    sourceFiles: fileName ? [fileName] : [],
    generator: 'electrical-ingest@eplan-xml-v0',
  };
  // Sprint 88M — extract structured `<Parameter>` / `<SetpointBinding>`
  // elements if any. Pure / deterministic; only attaches the sidecar
  // when the source carries explicit metadata (legacy EPLAN exports
  // stay untouched).
  if (parseResult.root) {
    const draft = extractStructuredParameterDraft(parseResult.root, {
      sourceId,
      kind: 'eplan',
      fileName,
    });
    if (!isStructuredParameterDraftEmpty(draft)) {
      metadata.parameterDraft = draft;
      diagnostics.push(...draft.diagnostics);
    }
  }
  const graph: ElectricalGraph = {
    id: buildEplanXmlGraphId(sourceId),
    sourceKind: 'eplan-export',
    nodes: allNodes,
    edges: allEdges,
    diagnostics: [...diagnostics],
    metadata,
  };
  return { graph, diagnostics };
}

/**
 * Build a registry-facing ingestor matching `ElectricalSourceIngestor`.
 * `canIngest` accepts any `kind: 'xml'` file with inline content;
 * `ingest` performs format detection internally so unknown XML
 * roots emit a diagnostic rather than falling through silently.
 *
 * Pre-detection peek (`canIngest`) deliberately accepts more
 * generously than `parseEplanXml` will recognise, so that the XML
 * never falls to the unsupported stub for arbitrary XML — we own
 * the "honest unknown root" diagnostic path here.
 */
export function createEplanXmlElectricalIngestor(): ElectricalSourceIngestor {
  return {
    canIngest(input: ElectricalIngestionInput): boolean {
      if (!input || typeof input !== 'object') return false;
      if (!Array.isArray(input.files) || input.files.length === 0) return false;
      return input.files.every(
        (f) => f && typeof f === 'object' && f.kind === 'xml' && f.content !== undefined,
      );
    },
    async ingest(input: ElectricalIngestionInput): Promise<ElectricalIngestionResult> {
      const diagnostics: ElectricalDiagnostic[] = [];
      const allNodes: ElectricalNode[] = [];
      const allEdges: ElectricalEdge[] = [];
      const sourceFiles: string[] = [];
      // Sprint 88M — merge per-file parameter drafts into a single
      // sidecar so multi-file EPLAN imports flow through the same
      // PIR-builder hook as a single-file ingest.
      const combinedParameters: import('../types.js').PirParameterCandidate[] = [];
      const combinedSetpointBindings: Record<string, Record<string, string>> = {};
      const combinedDraftDiagnostics: ElectricalDiagnostic[] = [];

      for (const file of input.files) {
        if (!file || typeof file !== 'object' || file.kind !== 'xml') continue;
        sourceFiles.push(file.path);
        let text: string;
        if (typeof file.content === 'string') {
          text = file.content;
        } else if (file.content instanceof Uint8Array) {
          text = new TextDecoder('utf-8').decode(file.content);
        } else {
          diagnostics.push(
            createElectricalDiagnostic({
              code: 'EPLAN_XML_EMPTY_INPUT',
              message: `EPLAN XML file ${JSON.stringify(file.path)} has no inline content; loader must read the file first.`,
              sourceRef: { sourceId: input.sourceId, kind: 'eplan', path: file.path },
            }),
          );
          continue;
        }
        const partial = ingestEplanXml({
          sourceId: input.sourceId,
          fileName: file.path,
          text,
          options: input.options as EplanXmlIngestionOptions | undefined,
        });
        diagnostics.push(...partial.diagnostics);
        for (const n of partial.graph.nodes) {
          const existing = allNodes.find((x) => x.id === n.id);
          if (!existing) allNodes.push(n);
          else existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, n.sourceRefs);
        }
        for (const e of partial.graph.edges) {
          const existing = allEdges.find((x) => x.id === e.id);
          if (!existing) allEdges.push(e);
          else existing.sourceRefs = mergeSourceRefs(existing.sourceRefs, e.sourceRefs);
        }
        const partialDraft = partial.graph.metadata.parameterDraft;
        if (partialDraft) {
          combinedParameters.push(...partialDraft.parameters);
          for (const [eqId, roleMap] of Object.entries(partialDraft.setpointBindings)) {
            combinedSetpointBindings[eqId] = {
              ...(combinedSetpointBindings[eqId] ?? {}),
              ...roleMap,
            };
          }
          combinedDraftDiagnostics.push(...partialDraft.diagnostics);
        }
      }

      const metadata: ElectricalGraph['metadata'] = {
        sourceFiles,
        generator: 'electrical-ingest@eplan-xml-v0',
      };
      if (
        combinedParameters.length > 0 ||
        Object.keys(combinedSetpointBindings).length > 0 ||
        combinedDraftDiagnostics.length > 0
      ) {
        metadata.parameterDraft = {
          parameters: combinedParameters,
          setpointBindings: combinedSetpointBindings,
          diagnostics: combinedDraftDiagnostics,
        };
      }

      const graph: ElectricalGraph = {
        id: buildEplanXmlGraphId(input.sourceId),
        sourceKind: 'eplan-export',
        nodes: allNodes,
        edges: allEdges,
        diagnostics: [...diagnostics],
        metadata,
      };
      return { graph, diagnostics };
    },
  };
}

// Export the Sprint-72 walk helpers so tests can introspect the
// element tree without re-importing the lower-level utility module.
export { findAllElements, findElement, walkElements };
