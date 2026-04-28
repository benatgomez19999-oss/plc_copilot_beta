# Beckhoff/TwinCAT ECAD Import XML — Sprint 78A v0

> **This is structured XML v0 for the Beckhoff/TwinCAT ECAD Import
> shape, not a vendor-certified Beckhoff schema reference.** PLC
> Copilot is not affiliated with or endorsed by Beckhoff Automation
> GmbH & Co. KG. Real TcECAD exports often *resemble* the schema
> below; the project makes no guarantee about covering any
> particular real-world export verbatim. Tests are the source of
> truth: see `packages/electrical-ingest/tests/twincat-ecad-xml.spec.ts`
> and the fixture next to it.

## Why a dedicated recognizer?

Sprint 77 manual testing fed a public TcECAD export
(`TC ECAD IMPORT V2_2_x.xml`) through the Sprint 74 EPLAN XML
ingestor. The EPLAN ingestor's `<Element>` walker found nothing
under the `<Project>/<CPUs>/.../<Variable>` shape and returned an
empty candidate. The web UI then flipped to "READY TO BUILD"
because no items were pending — Sprint 77's `isReadyForPirBuilder`
predicate didn't account for the "no items at all" case. Two
real bugs surfaced:

1. **Format gap.** TcECAD has a fundamentally different shape from
   the EPLAN `<Element>` family. It needs its own recognizer.
2. **Empty-candidate UX bug.** The gate predicate treated empty
   inputs as ready. Sprint 78A aligned the web + domain gates
   (`hasReviewableCandidates(candidate)`) so the button stays
   disabled with a clear "no reviewable candidates" reason.

## Detection

`detectTcecadXml(root)` returns true when **any** of the following
holds:

1. Root tag is `Project` AND a `<Description>` child contains
   `TcECAD Import` (case-insensitive).
2. Any `<Variable>` descendant has all three of `<IsInput>` +
   `<IoName>` + `<IoDataType>` siblings — the structural
   fingerprint of the format.

Anything else (a generic `<Project>`, an `<EplanProject>`, an
`<svg>`, etc.) returns `false` so the file falls through to the
next ingestor in the chain.

## Recognised structure

```xml
<Project>
  <Name>...</Name>
  <Description>TcECAD Import V2.2.12</Description>
  <CPUs>
    <CPU>
      <Name>...</Name>
      <Interfaces>
        <Interface>
          <Name>...</Name>
          <Type>ETHERCATPROT</Type>
          <ChannelNo>1</ChannelNo>
          <Boxes>
            <Box>
              <Name>...</Name>
              <Type>EL1004</Type>
              <BoxNo>1005</BoxNo>
              <Variables>
                <Variable>
                  <Name>S1_1</Name>
                  <Comment>Lichttaster — Sensor on conveyor entry</Comment>
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
</Project>
```

The walker climbs back through ancestors so each `<Variable>`
record carries the full provenance chain
(`cpuName / interfaceName / interfaceType / interfaceChannelNo /
boxName / boxType / boxNo`).

## Mapping rules

For each recognised `<Variable>`:

| TcECAD field | PLC Copilot graph |
| --- | --- |
| `<Name>` | Device node id (canonicalised) + variable_name attribute + SourceRef.rawId |
| `<Comment>` | Device node label + comment attribute |
| `<IsInput>true` | direction = `'input'` |
| `<IsInput>false` | direction = `'output'` |
| `<IoName>` | io_name attribute + cross-check vs `IsInput` (fires `TCECAD_XML_DIRECTION_CONFLICT`) |
| `<IoGroup>` | io_group attribute + part of structured address |
| `<IoDataType>` | signal_type ('bool' for BOOL; 'int'/'real' for word/double; warning for STRING etc.) |

For each `<Box>`: a `plc_module` node is created once and reused
across the variables that share it.

For each variable a deterministic structured address is built:
`tcecad:<boxNo>:<ioGroup>` (e.g. `tcecad:1005:Channel 1`). The
channel label embeds the direction — `tcecad:1005:Channel 1
(input)` — so the Sprint 72 candidate mapper's label-pattern
fallback can read the direction. **No Siemens-style %I/%Q
synthesis** — the structured address is honest, and the PIR
builder will refuse it because it doesn't map to PIR's `IoAddress`
schema. That refusal is correct: an operator should not ship PIR
without resolving the address mapping.

## Edges

| Edge kind | When |
| --- | --- |
| `signals` (`device → channel`) | Variable with `IsInput=true` |
| `drives` (`channel → device`) | Variable with `IsInput=false` |
| `belongs_to` (`channel → module`) | Every variable, once per box |

## Kind inference

`inferKindFromText(name + comment)` — priority order:

| Priority | Pattern (case-insensitive) | Kind |
| --- | --- | --- |
| 1 | `notaus` / `e-?stop` / `emergency` / `safety` | `safety_device` |
| 2 | `magnetventil` / `valve` / `solenoid` / `ventil` / `sov` | `valve` |
| 3 | `lichttaster` / `reedkontakt` / `druckschalter` / `sensor` / `prox` / `switch` / `limit` / `signal` / `input` | `sensor` |
| 4 | `motor` / `schütz` / `servo` / `drive` / `reglerfreigabe` / `antrieb` / `conveyor` / `pump` | `motor` |
| 5 | KIND_ALIASES (shared with CSV / EPLAN) | varies |
| 6 | `IsInput=true` fallback | `sensor` (low confidence) |
| 7 | otherwise | `unknown` (low confidence) |

Sensor priority sits **above** motor on purpose: a comment like
"Lichttaster on conveyor entry" should classify as sensor, not
motor (Sprint 78A regression test pins this).

## Diagnostics

| Code | Severity | When |
| --- | --- | --- |
| `TCECAD_XML_DETECTED` | info | `detectTcecadXml` matched (one-off announcement) |
| `TCECAD_XML_NO_VARIABLES` | warning | Recognised root, no `<Variable>` descendants |
| `TCECAD_XML_MISSING_VARIABLE_NAME` | error | A `<Variable>` has no `<Name>` — skipped |
| `TCECAD_XML_MISSING_BOX_CONTEXT` | error | A `<Variable>` has no `<Box>` ancestor — skipped |
| `TCECAD_XML_UNSUPPORTED_IO_DATATYPE` | warning | `<IoDataType>` is not a known mapping (e.g. `STRING`) — signal_type stays unknown |
| `TCECAD_XML_UNKNOWN_DIRECTION` | warning | `<IsInput>` is missing or unparseable |
| `TCECAD_XML_DUPLICATE_VARIABLE` | warning | Duplicate `<Name>` — first wins, others skipped |
| `TCECAD_XML_STRUCTURED_ADDRESS_USED` | info | Per-variable; reminds the operator the channel address is `tcecad:` style and won't pass the PIR address parser |
| `TCECAD_XML_DIRECTION_CONFLICT` | warning | `<IsInput>` disagrees with `<IoName>` |
| `TCECAD_XML_PARTIAL_EXTRACTION` | warning | Recognised + variables present but no device nodes mapped |

## SourceRefs

Every node and edge carries a `SourceRef` with:

- `sourceId` — caller-supplied
- `kind: 'twincat_ecad'` (Sprint 78A new union member)
- `path` — input file name
- `line` — 1-based line of the opening `<Variable>` tag (or
  `<Box>` for module nodes)
- `rawId` — variable name (or box name for module nodes)
- `symbol` — XML locator path
  (`/Project[1]/CPUs[1]/CPU[1]/Interfaces[1]/Interface[1]/Boxes[1]/Box[2]/Variables[1]/Variable[3]`)

## What v0 explicitly does NOT do

- **No Siemens-style %I/%Q synthesis.** Channels carry the
  structured `tcecad:<boxNo>:<ioGroup>` address; the PIR builder
  will refuse to map it (correctly). Operators should resolve the
  Box → Siemens address mapping out-of-band before promoting PIR.
- **No EDZ / EPDZ archive extraction.** This is an XML-only
  ingestor.
- **No XML namespace handling.** Namespaced tags
  (`<beckhoff:Project>`) are matched by literal string only.
- **No deep validation.** A `<Variable>` with all three required
  children (IsInput/IoName/IoDataType) is accepted; missing
  optional fields are recorded but don't block extraction.
- **No vendor schema certification.** The recognizer matches a
  shape; it makes no claim about coverage of any specific
  Beckhoff/TwinCAT TC ECAD version.

## Adding real-world TcECAD samples

1. **Anonymise first.** Strip customer / project / site / personal
   identifiers from `<Description>` / `<Name>` / `<Comment>`.
   Replace customer-specific tag prefixes (`=S1.7+S1-…`) with
   neutral placeholders.
2. Place the sanitised XML under
   `packages/electrical-ingest/tests/fixtures/eplan/`.
3. Add a focused test asserting whatever shape the fixture
   exposes.
4. Run `pnpm --filter @plccopilot/electrical-ingest test`.
5. Drop the same XML into the web workspace (Sprint 77 path) for
   manual verification.
