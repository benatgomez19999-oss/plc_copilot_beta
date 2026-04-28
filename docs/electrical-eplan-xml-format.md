# EPLAN structured XML format — Sprint 74 v0

> **This is structured XML v0, not a vendor-certified EPLAN export
> contract.** PLC Copilot is not affiliated with or endorsed by
> EPLAN GmbH & Co. KG. Files exported by EPLAN often *resemble*
> the schema below, but the project makes no guarantee about
> covering any particular real-world EPLAN export verbatim. The
> source of truth is always the live tests under
> `packages/electrical-ingest/tests/eplan-xml.spec.ts` and the
> fixtures next to them.

## Why hand-rolled XML?

The monorepo policy is "no new runtime dependencies for
ingestion". A full W3C DOM is overkill for the structured shapes
we want to ingest — element trees with attributes, child
elements, text content, and `<![CDATA[]]>`. The Sprint 74 parser
in [`xml-utils.ts`](../packages/electrical-ingest/src/sources/xml-utils.ts)
is small, deterministic, and never throws; the entire surface is
~250 lines and is exercised by the parser-level tests in
`eplan-xml.spec.ts`.

Out of scope (would require a heavier parser):

- XML namespaces (the prefix is treated as part of the tag name).
- DTD / external entity resolution.
- Mixed-content semantics where text and child elements interleave
  meaningfully.

## Accepted fixture structure

All of the following are equivalent shapes the ingestor recognises.
Each `<Element>` node becomes one device record. Attributes inside
an element take precedence over child elements when both are
present.

### Project-level wrapping (preferred)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<EplanProject schemaVersion="0.1">
  <Pages>
    <Page sheet="=A1/12">
      <Element id="el-001" tag="B1" kind="sensor" address="%I0.0" direction="input"/>
      ...
    </Page>
  </Pages>
</EplanProject>
```

Recognised root tags (case-insensitive): `EplanProject`, `Project`,
`ElectricalProject`. Generic wrappers also accepted: `Pages`,
`Elements`, `Electrical`, `ElectricalList`, `DeviceList`. A document
with an unknown root **but** with `<Element>` descendants is
tentatively accepted as `eplan_generic_xml` with no extra
diagnostic.

### Pure attribute form

```xml
<Element id="el-002" tag="B2" kind="sensor"
         address="%I0.1" direction="input"
         label="Part clamped"
         terminal="2" terminal-strip="X1" cable="W12"
         sheet="=A1/12"/>
```

### Pure nested-children form

```xml
<Element id="el-003">
  <Tag>Y1</Tag>
  <Kind>valve</Kind>
  <Description>Cylinder extend</Description>
  <PlcChannel address="%Q0.0" direction="output" plc="CPU1" module="DO16" channel="0"/>
  <Terminal id="X2:4" strip="X2"/>
  <Cable id="W13"/>
  <Wire id="C8"/>
</Element>
```

## Tag resolution priority

Element id (`id="el-001"`) is **not** a device tag — it identifies
the source element, not the device. If the element only carries an
`id` attribute, the ingestor emits `EPLAN_XML_MISSING_DEVICE_TAG`
and skips the element.

Resolution order:

1. `tag` attribute on the `<Element>`
2. `<Tag>` child element
3. `device-tag` / `equipment-id` attribute
4. `<Name>` child element
5. _(no fallback to `id` / `name` attribute — that is the
   architecture invariant)_

## Sheet / page inheritance

Sheet attributes on the nearest `<Page>` ancestor are inherited as
`SourceRef.sheet` for every `<Element>` inside it. An element's own
`sheet` attribute or `<Sheet>` child overrides the inherited value.

## Attribute aliases recognised

| Canonical | Aliases (case-insensitive) |
| --- | --- |
| `tag` | `tag`, `device-tag`, `equipment-id` |
| `kind` | `kind`, `type`, `devicetype`, `equipmenttype` |
| `address` | `address`, `ioaddress`, `plcaddress` |
| `direction` | `direction`, `iodirection`, `dir` |
| `label` | `label`, `description`, `text` |
| `terminal` | `terminal` (attribute), `<Terminal id|tag|name>` (child) |
| `terminal_strip` | `terminalstrip`, `strip` (attribute or child) |
| `cable` | `cable`, `cableid` (attribute or `<Cable>` child) |
| `wire` | `wire`, `wireid`, `conductor` (attribute or `<Wire>` child) |
| `sheet` / `page` | `sheet`, `page` (attribute or `<Sheet>` / `<Page>` child / inherited) |
| `function` / `location` | attribute or child |
| `plc` / `module` / `channel` | attribute or `<PlcChannel>` child attribute |

The ingestor reads the `<PlcChannel>` child first when present;
otherwise direct attributes on the `<Element>` itself.

## Address formats

Reuses Sprint 73's `detectPlcAddress`:

- Siemens — `%I0.0`, `%Q1.7`, `%IW10`, `%MW100`
- Codesys — `%IX0.0`, `%QX1.7`
- Rockwell — `Local:1:I.Data[0].0`, `Local:1:O.Data[0].0`
- Generic — `I0.0`, `Q1.7`, `DI0`, `DO0.5`

Anything else → `EPLAN_XML_INVALID_ADDRESS` (warning); no PLC
channel is created.

## Source-ref shape

Every node and edge created from an XML element carries a
`SourceRef` with:

- `sourceId` — caller-supplied
- `kind: 'eplan'`
- `path` — the input file name
- `line` — 1-based line of the opening `<Element>` tag
- `rawId` — the resolved device tag
- `sheet` — inherited from `<Page>` or the element's own `sheet` attribute
- `symbol` — XML locator (e.g. `/EplanProject[1]/Pages[1]/Page[2]/Element[3]`)

The locator is deterministic and one-to-one with the source
position — useful for the future review UI to deep-link directly
to the offending XML node.

## Adding real-world EPLAN samples

When you have a real EPLAN export to test against:

1. **Anonymise first.** Strip customer / project / site
   identifiers from `<Description>` / `<Function>` / `<Location>`
   and any IP-sensitive comments. Replace device tags with
   neutral identifiers if the original tags reveal product line
   structure.
2. Place the sanitised XML under
   `packages/electrical-ingest/tests/fixtures/eplan/`. Keep file
   names lowercase + dash-separated.
3. Add a focused test in
   [`tests/eplan-xml.spec.ts`](../packages/electrical-ingest/tests/eplan-xml.spec.ts).
   Prefer **stable assertions** (graph contains a `device:X` node
   with these source refs) over **full JSON snapshots** —
   ordering invariants in the graph are not strict, and
   snapshots will rot on any structural refactor.
4. If the fixture surfaces a missing alias / missing diagnostic /
   missing tag-resolution path, fix it generically rather than
   special-casing the fixture.

## Comparing parsed graph vs source XML

```ts
import { parseEplanXml, ingestEplanXml } from '@plccopilot/electrical-ingest';

const text = readFileSync('plan.xml', 'utf-8');
const parsed = parseEplanXml(text);
console.log('format:', parsed.format);
console.log('elements:', parsed.elements.length);
const result = ingestEplanXml({ sourceId: 'plan-1', text, fileName: 'plan.xml' });
for (const n of result.graph.nodes) {
  console.log(n.id, n.kind, n.sourceRefs[0].symbol);
}
```

The XML locator (`SourceRef.symbol`) lets you walk back to the
original XML element with any DOM-aware editor and verify
extraction by hand.

## Known v0 limitations (honest)

- No support for EDZ / EPDZ archive extraction. Real EPLAN exports
  are often shipped as `.elt` / `.edz` archives — those land in a
  later sprint.
- No XML schema validation. The parser is permissive and will
  cheerfully accept any well-formed XML, surfacing semantic
  problems via diagnostics rather than refusing to run.
- No XML namespaces. A namespaced tag (`<eplan:Element>`) will be
  recognised only by string match against the namespaced name;
  most fixtures don't use namespaces, but if you do, document the
  namespace explicitly in your fixture comments.
- No mixed-content handling beyond simple "child elements then
  text" — text nodes interleaved with child elements are
  concatenated into the parent's `text` and may surprise downstream
  readers. Keep fixtures non-interleaved.
- The `sheet` attribute on an `<Element>` overrides its parent
  `<Page>`'s sheet — by design — but the test coverage for this
  edge case is light. Add a test if you rely on it.
