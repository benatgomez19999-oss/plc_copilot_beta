# Electrical-plan ingestion architecture

> **Status: structured XML ingestion v0 live (Sprint 74).** Sprint
> 72 scaffolded the architecture + canonical model + helpers + an
> honest unsupported-EPLAN stub. Sprint 73 added the CSV ingestor
> + 12 new diagnostic codes. **Sprint 74** adds a hand-rolled
> minimal XML parser + the EPLAN structured-export ingestor v0 with
> 12 more diagnostic codes; the default registry now routes
> `kind: 'csv'` → CSV ingestor, `kind: 'xml'` → EPLAN XML ingestor
> (which surfaces unknown roots honestly), and the unsupported stub
> is the catch-all for `edz` / `epdz` / `pdf` / `unknown`. Still no
> PDF/OCR, no EDZ archive extraction, no final PIR builder.

## Why this matters

PLC programming rarely starts on a blank page. By the time a PLC
copilot is useful, the electrical plan usually already exists:

- Mechanical design comes first; electrical design follows.
- Electrical subcontractors often build cabinets and wiring before
  PLC code is written.
- The plan encodes load-bearing facts: what's wired to what, which
  PLC channels exist, which device is at which terminal, which
  cable runs where.

These facts are **deterministic, source-traceable evidence** —
strictly stronger than free-form prompt text. A copilot that
*understands the plan* can ground its suggestions; a copilot that
ignores the plan ends up guessing.

## What can be inferred from electrical plans

Realistically, from a normalised electrical graph the system can
recover:

- That terminal A is connected to terminal B (wires, cables).
- That a PLC channel exists at address `%I0.0` / `Local:1:I.Data[0].0`.
- The presence and rough class of devices (sensor, motor, valve,
  cylinder) when labels and IEC 61346 tags are present.
- Which device is wired to which channel.
- Which cabinet / module / strip a device belongs to.
- Power supply topology when explicitly drawn.

## What CANNOT be inferred from electrical plans

These claims are out of scope for ingestion alone — even the best
plan does not encode them:

- Full **sequence logic** (the order in which equipment moves, when,
  why, with what dwell times).
- **Operator intent** (UI workflows, recipe parameters, alarms the
  customer cares about).
- **Future programmer decisions** (naming conventions for variables
  that don't exist on the schematic, abstraction boundaries).
- **Timing behaviour** unless explicitly specified (pulse widths,
  watchdog timeouts).
- **Safety-logic intent** beyond the wired safety-relay
  architecture (the plan shows what the safety chain does, not
  what the operator wants it to mean).

When the system later generates code, anything in this list must
come from human review or explicit prompt input — never from
guessing on top of the graph.

## Architectural principle

```
EPLAN export / PDF / XML / CSV / EDZ
        │
        ▼  (source ingestor — Sprint 73+)
ElectricalGraph (canonical, source-agnostic)
        │
        ▼  (validateElectricalGraph + diagnostics)
ElectricalGraph + Diagnostics + Confidence
        │
        ▼  (buildPirDraftCandidate)
PirDraftCandidate
   ├── PirIoCandidate[]
   ├── PirEquipmentCandidate[]
   ├── PirMappingAssumption[]
   └── ElectricalDiagnostic[]
        │
        ▼  (human review — future review UI)
PirDraft (post-review)
        │
        ▼  (PIR builder — future sprint)
PIR
        │
        ▼  (existing codegen pipeline)
Vendor artefacts (Siemens / CODESYS / Rockwell)
```

Every stage carries `sourceRefs` and `confidence`. The mapper
emits **assumptions and diagnostics**, not silent inventions.

## Package layout (`@plccopilot/electrical-ingest`)

```
packages/electrical-ingest/
├── package.json          ← private: true, no main/exports (internal only)
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts          ← public barrel (for monorepo consumers)
│   ├── types.ts          ← canonical types — source-agnostic
│   ├── diagnostics.ts    ← create / dedupe / sort / count helpers
│   ├── confidence.ts     ← clamp / combine / min / fromEvidence
│   ├── graph.ts          ← index / find / validate / tracePath / connectedComponents
│   ├── normalize.ts      ← normalise IDs / labels / attributes / detectPlcAddress
│   ├── sources/
│   │   ├── trace.ts      ← formatSourceRef / mergeSourceRefs / sourceRefsEqual
│   │   ├── eplan.ts      ← EPLAN ingestion interfaces + unsupported stub
│   │   └── generic.ts    ← SourceRegistry + ingestWithRegistry
│   └── mapping/
│       ├── io-role-inference.ts  ← infer direction / signal type / equipment kind
│       └── pir-candidate.ts      ← buildPirDraftCandidate (graph → draft)
└── tests/                ← graph / confidence / diagnostics / pir-candidate / trace / sources
```

The package is **private** (not on npm). The publish-audit classifier
treats it as `internal` automatically because there is no `main` /
`exports` / `bin` field. Sprint 72 stops at the candidate model —
no dist build, no consumers wired into codegen yet.

## Confidence model

Scores are floats in `[0, 1]`. Helpers in `confidence.ts` clamp
out-of-range values rather than throwing.

Combining supporting evidence uses a complement-product:
`combined = 1 − ∏(1 − sᵢ · wᵢ)`. Multiple independent sources
reduce residual doubt; conflicting evidence (negative weight)
subtracts from the result with a hard floor at 0. Reasons are
deduplicated and sorted deterministically.

The candidate mapper applies a `minEquipmentConfidence` threshold
(default 0.6) — anything below becomes an *assumption* that the
review UI must surface, not a final equipment record.

## Diagnostics

| Code | Severity | When |
| --- | --- | --- |
| `DUPLICATE_NODE_ID` | error | Two nodes with the same id. |
| `EDGE_ENDPOINT_MISSING` | error | Edge references a non-existent node. |
| `SOURCE_REF_MISSING` | error | Node / edge / candidate has no source refs. |
| `PLC_CHANNEL_DUPLICATE_MAPPING` | error | Two channels claim the same address. |
| `AMBIGUOUS_DEVICE_KIND` | warning | Multiple plausible classifications, none dominant. |
| `LOW_CONFIDENCE_DEVICE_CLASSIFICATION` | warning | Equipment role inferred below threshold. |
| `PLC_CHANNEL_UNRESOLVED` | warning | Direction (input/output) could not be inferred. |
| `IO_SIGNAL_MISSING_ADDRESS` | warning | plc_channel without a usable address. |
| `INCOMPLETE_WIRING_CHAIN` | warning | Wired chain ends mid-graph (no PLC, no device). |
| `UNKNOWN_DEVICE_ROLE` | warning | No evidence at all for device classification. |
| `UNSUPPORTED_SOURCE_FEATURE` | info | Honest "not implemented yet" marker. |

Diagnostics are immutable plain objects. `sortElectricalDiagnostics`
returns a stable order; `dedupeElectricalDiagnostics` collapses
structural duplicates while preserving first-seen order.

## Source ingestion

`ElectricalSourceIngestor` (alias: `EplanIngestor`) is the single
interface every concrete source implements:

```ts
interface ElectricalSourceIngestor {
  canIngest(input: ElectricalIngestionInput): boolean;
  ingest(input: ElectricalIngestionInput): Promise<ElectricalIngestionResult>;
}
```

The `SourceRegistry` accepts ingestors and dispatches based on
`canIngest` (first match wins, registration order). Sprint 74's
`createDefaultSourceRegistry()` ships pre-loaded with:

1. **CSV ingestor** (`createCsvElectricalIngestor`, Sprint 73) —
   handles `kind: 'csv'` files with inline content (string or
   `Uint8Array`).
2. **EPLAN XML ingestor** (`createEplanXmlElectricalIngestor`,
   Sprint 74) — handles every `kind: 'xml'` file with content.
   Even unknown XML roots are owned by this ingestor (it emits
   `EPLAN_XML_UNKNOWN_ROOT` instead of falling through silently).
3. **Unsupported EPLAN stub** (`createUnsupportedEplanIngestor`,
   Sprint 72) — fall-through for `edz` / `epdz` / `pdf` /
   `unknown` until real parsers ship.

### Sprint 72 — unsupported EPLAN stub

`createUnsupportedEplanIngestor()`:

- `canIngest === true` for known file kinds (`xml` / `edz` /
  `pdf` / `csv` / `unknown`); `false` for empty / malformed input.
- On `ingest`, returns an empty graph + one global
  `UNSUPPORTED_SOURCE_FEATURE` error + one info-level diagnostic
  per file with the path attached as a SourceRef.
- **Never throws.** Architecture invariant: stubs surface their
  limitations as diagnostics, they do not fail.

### Sprint 73 — CSV ingestor

The first concrete structured-source ingestor.
[`packages/electrical-ingest/src/sources/csv.ts`](../packages/electrical-ingest/src/sources/csv.ts)
+ [`tests/csv.spec.ts`](../packages/electrical-ingest/tests/csv.spec.ts).

#### Supported CSV dialect

Comma delimiter, CRLF or LF, quoted fields, `""`-escaped quotes
inside quotes, empty cells, blank lines (skipped). Anything else
emits a diagnostic — the parser **never throws**.

| Limit | Behaviour |
| --- | --- |
| Empty / non-string input | `CSV_EMPTY_INPUT` |
| First non-blank line is missing or all-blank | `CSV_MISSING_HEADER` |
| Two raw headers map to the same canonical column | `CSV_DUPLICATE_HEADER` |
| Row has a different cell count than the header | `CSV_ROW_WIDTH_MISMATCH` (warning, row kept with empty cells) |
| Quoted field never closes | `CSV_UNCLOSED_QUOTE` (row skipped) |
| Non-comma delimiter requested | `CSV_UNSUPPORTED_DELIMITER` |

#### Canonical columns + aliases

| Canonical | Aliases recognised (case-insensitive) |
| --- | --- |
| `tag` | `tag`, `device_tag`, `equipment`, `equipment_id` |
| `kind` | `kind`, `type`, `device_type`, `equipment_type` |
| `address` | `address`, `io_address`, `plc_address` |
| `direction` | `direction`, `io_direction`, `dir` |
| `label` | `label`, `description`, `text` |
| `terminal` | `terminal`, `terminal_id`, `terminal_point` |
| `terminal_strip` | `terminal_strip`, `strip` |
| `cable` | `cable`, `cable_id` |
| `wire` | `wire`, `wire_id`, `conductor` |
| `sheet` | `sheet`, `drawing`, `source_page` |
| `page` | `page` |
| `plc` | `plc`, `cpu` |
| `module` | `module`, `card`, `io_module` |
| `channel` | `channel` |
| `signal` | `signal`, `signal_id`, `io_signal` |
| `role` | `role`, `io_role` |
| `device`, `function`, `location`, `comment` | pass-through |

#### Mapping rules (per row)

For each non-blank data row:

1. **Device node** — id `device:<normalised tag>`. Kind looked up
   via the kind-alias table (`sensor`, `valve`, `motor`, `plc`,
   `safety_device`, `power_supply`, `actuator`, `cylinder`, …).
   Unknown kind → kind `unknown` + `CSV_UNKNOWN_KIND` warning.
2. **PLC channel node** — when `address` is present and parses via
   `detectPlcAddress`. Id `plc_channel:<address>` (the `%` is
   preserved in the id). Adds `signal_type=bool` for bit-addressed
   channels. Direction-versus-address conflict → `CSV_DIRECTION_ADDRESS_CONFLICT`.
3. **Edge between device and channel** — for inputs `device →
   channel` (`signals`); for outputs `channel → device` (`drives`).
4. **Terminal node** — when `terminal` is present. Edge
   `device → terminal` (`wired_to`). When both terminal + channel
   exist, also `terminal → channel` (`wired_to`).
5. **Cable / wire nodes** — when present, plus `terminal → cable`
   / `terminal → wire` edges.

Every node + edge carries a `SourceRef` with `kind: 'csv'`,
`line: <CSV line number>`, `path: <fileName>`, `rawId: <tag>`,
`sheet: <sheet/page>`. Source refs propagate when multiple rows
reference the same shared infrastructure (e.g. two devices on the
same terminal strip).

#### Cross-row checks

- **Duplicate tag** — first wins; later rows skipped with
  `CSV_DUPLICATE_TAG`. Never silently merged.
- **Duplicate address** — both device nodes survive; the channel
  exists once with merged source refs; `CSV_DUPLICATE_ADDRESS`
  flagged because shared inputs are legitimate but suspicious.

#### Confidence

| Evidence | Score |
| --- | --- |
| Known kind alias | 0.85 |
| Empty / unknown kind | 0.4 (capped) + warning |
| Parsed address | 0.85 |
| Terminal / cable / wire edges | 0.65–0.8 |

Combined via the existing `confidenceFromEvidence`
complement-product. Low-confidence devices fall through to
`PirDraftCandidate` assumptions, not final equipment — same
threshold (0.6) the Sprint 72 mapper enforces.

#### Example (golden fixture)

[`tests/fixtures/simple-electrical-list.csv`](../packages/electrical-ingest/tests/fixtures/simple-electrical-list.csv):

```csv
tag,kind,address,direction,label,terminal,terminal_strip,cable,sheet
B1,sensor,%I0.0,input,Part present,1,X1,W12,=A1/12
Y1,valve,%Q0.0,output,Cylinder extend,4,X2,W13,=A1/13
M1,motor,%Q0.2,output,Conveyor motor,2,X3,W14,=A1/14
```

Becomes a graph with deterministic ids — `device:B1`, `device:Y1`,
`device:M1`, `plc_channel:%I0.0`, `plc_channel:%Q0.0`,
`plc_channel:%Q0.2`, `terminal:1`, `cable:W12`, `cable:W13`, etc. —
each with a CSV source ref pointing at its row line. Feeding the
graph to `buildPirDraftCandidate` produces 5 IO candidates and 3
equipment candidates (sensor_discrete + valve_solenoid +
motor_simple) at confidence ≥ 0.6.

#### What CSV is NOT

CSV is **not** the final EPLAN strategy. It is the first
deterministic structured source — easy to author, easy to test
against, easy for operators to hand-fill from a printout. The
Sprint 74 EPLAN structured-export parser added support for
EPLAN-style XML; this CSV ingestor stays as the simple/manual
fallback.

### Sprint 74 — EPLAN structured XML ingestor v0

The first XML-shaped ingestion path.
[`packages/electrical-ingest/src/sources/eplan-xml.ts`](../packages/electrical-ingest/src/sources/eplan-xml.ts)
+ [`xml-utils.ts`](../packages/electrical-ingest/src/sources/xml-utils.ts)
+ [`tests/eplan-xml.spec.ts`](../packages/electrical-ingest/tests/eplan-xml.spec.ts)
+ [`docs/electrical-eplan-xml-format.md`](electrical-eplan-xml-format.md).

> **Honesty note:** This is *structured XML v0*, not a guaranteed
> EPLAN export schema. Fixtures are described as "representative
> structured XML"; real EPLAN exports often resemble this shape but
> we make no vendor-certified compatibility claim. The
> trademark/affiliation note in the architecture root applies here
> too.

#### XML parser

A hand-rolled minimal parser ships in
[`xml-utils.ts`](../packages/electrical-ingest/src/sources/xml-utils.ts)
because the monorepo policy is "no new runtime dependencies for
ingestion" and the structured fixtures we care about are
well-formed XML that doesn't need a full W3C DOM. Supports:

- Open / close / self-closing element tags.
- Quoted attributes (single + double quotes); unquoted are also
  accepted but real EPLAN exports always quote.
- Text content with the canonical entities decoded (`&lt; &gt; &amp;
  &quot; &apos;`) plus decimal / hex numeric character references.
- `<![CDATA[...]]>` (content preserved verbatim).
- `<?xml ... ?>` declarations, `<!-- ... -->` comments,
  `<?...?>` processing instructions, and `<!DOCTYPE ...>` blocks
  — all skipped.
- Deterministic locator paths per element (`/Root[1]/Child[2]/Element[3]`)
  for source-ref construction.
- 1-based line + column tracking surviving CRLF / LF.
- **Never throws.** Malformed input produces structured
  `XmlParseError` records, surfaced as `EPLAN_XML_MALFORMED`
  diagnostics by the ingestor.

Out of scope: XML namespaces (the prefix is treated as part of the
tag name), DTD / external entity resolution, mixed-content
semantics.

#### Detection

`detectEplanXmlFormat(root)` returns one of three labels:

| Label | When |
| --- | --- |
| `eplan_project_xml` | Root tag is `EplanProject` / `Project` / `ElectricalProject`. |
| `eplan_generic_xml` | Root tag is `Pages` / `Elements` / similar; OR any document containing `<Element>` descendants. |
| `unknown_xml` | Anything else — emits `EPLAN_XML_UNKNOWN_ROOT` (warning). With `strict: true`, also emits `EPLAN_XML_UNSUPPORTED_FORMAT` (error). |

The XML ingestor's `canIngest` returns `true` for **every**
`kind: 'xml'` file with inline content — including unknown roots
— so XML never falls to the silent unsupported stub. Diagnostics
are the architecture-correct way to surface "we saw your XML but
don't know what to do with it".

#### Element extraction

The walker hunts for `<Element>` (case-insensitive) descendants
under the root. Sheet / page attributes from any ancestor `<Page>`
are inherited. Two interchangeable element shapes are supported:

```xml
<!-- Attribute form -->
<Element id="el-1" tag="B1" kind="sensor" address="%I0.0" direction="input"
         label="Part present"
         terminal="X1:1" terminal-strip="X1" cable="W12" sheet="=A1/12"/>

<!-- Nested-children form -->
<Element id="el-2">
  <Tag>B2</Tag>
  <Kind>sensor</Kind>
  <Label>Part clamped</Label>
  <PlcChannel address="%I0.1" direction="input" plc="CPU1" module="DI16" channel="1"/>
  <Terminal id="X1:2" strip="X1"/>
  <Cable id="W12"/>
  <Wire id="C7"/>
</Element>
```

Tag resolution priority (deliberate — element `id` attribute is
*element numbering*, not device tag, so it is **not** in the
fallback chain): `tag` attribute → `<Tag>` child → `device-tag` /
`equipment-id` attribute → `<Name>` child. Missing → element is
skipped + `EPLAN_XML_MISSING_DEVICE_TAG`.

#### Mapping rules

Same shape as the CSV mapper (Sprint 73). Each element produces:

1. **Device node** — kind from the shared `KIND_ALIASES` table
   (extracted in Sprint 74 to avoid duplication between CSV and
   XML). Unknown kind → kind `unknown` + `EPLAN_XML_UNKNOWN_KIND`.
2. **PLC channel node** — when `address` parses via
   `detectPlcAddress`. Direction-vs-address conflict →
   `EPLAN_XML_DIRECTION_ADDRESS_CONFLICT`.
3. **Edge** — `device → channel` (`signals`) for inputs;
   `channel → device` (`drives`) for outputs.
4. **Terminal / cable / wire nodes** + `wired_to` edges when
   present.

Every node and edge carries a `SourceRef` with `kind: 'eplan'`,
`line: <element line>`, `path: <fileName>`, `rawId: <tag>`,
`sheet: <inherited sheet>`, **and a deterministic XML locator**
in `symbol` (e.g. `/EplanProject[1]/Pages[1]/Page[3]/Element[2]`)
so the future review UI can deep-link directly to the source XML
node.

#### Cross-element checks

- **Duplicate tag** — first wins; later element skipped with
  `EPLAN_XML_DUPLICATE_TAG`. Never silently merged.
- **Duplicate address** — both device nodes survive; the channel
  exists once with merged source refs; `EPLAN_XML_DUPLICATE_ADDRESS`
  flagged.

#### Diagnostics added (Sprint 74)

| Code | Default severity | When |
| --- | --- | --- |
| `EPLAN_XML_EMPTY_INPUT` | error | Empty / non-string input. |
| `EPLAN_XML_MALFORMED` | error | XML parse error (mismatched / unterminated tags, etc.). |
| `EPLAN_XML_UNKNOWN_ROOT` | warning | Root tag isn't recognised; partial recovery may still happen. |
| `EPLAN_XML_UNSUPPORTED_FORMAT` | warning | (only with `strict: true`) refuses to extract from unknown root. |
| `EPLAN_XML_MISSING_DEVICE_TAG` | error | Element has no resolvable device tag — element skipped. |
| `EPLAN_XML_UNKNOWN_KIND` | warning | `kind` doesn't match any alias — device kept with kind `unknown`. |
| `EPLAN_XML_INVALID_ADDRESS` | warning | `address` doesn't parse — channel + edge skipped. |
| `EPLAN_XML_DUPLICATE_TAG` | warning | First wins; duplicate skipped. |
| `EPLAN_XML_DUPLICATE_ADDRESS` | warning | Multiple devices on one channel — both kept, channel merged. |
| `EPLAN_XML_DIRECTION_ADDRESS_CONFLICT` | warning | `direction` attribute disagrees with the address-implied direction. |
| `EPLAN_XML_MISSING_SOURCE_REF` | warning | Reserved for future use (currently unused; structure-only). |
| `EPLAN_XML_PARTIAL_EXTRACTION` | warning | Recognised root but no `<Element>` descendants. |

#### Confidence

Same model as Sprint 73 (complement-product). Identical thresholds:
known kind = 0.85, address parsed = 0.85, terminal/cable/wire = 0.65–0.8,
unknown kind capped at 0.4 + warning. The candidate mapper's
threshold (0.6) is unchanged; XML and CSV produce comparable
confidence shapes.

#### Example fixture (golden)

[`tests/fixtures/eplan/simple-eplan-export.xml`](../packages/electrical-ingest/tests/fixtures/eplan/simple-eplan-export.xml):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<EplanProject schemaVersion="0.1">
  <Pages>
    <Page sheet="=A1/12">
      <Element id="el-001" tag="B1" kind="sensor">
        <Label>Part present</Label>
        <PlcChannel address="%I0.0" direction="input" plc="CPU1" module="DI16" channel="0"/>
        <Terminal id="1" strip="X1"/>
        <Cable id="W12"/>
        <Wire id="C7"/>
      </Element>
      <Element id="el-002" tag="B2" kind="sensor"
               address="%I0.1" direction="input"
               label="Part clamped"
               terminal="2" terminal-strip="X1" cable="W12"/>
    </Page>
  </Pages>
</EplanProject>
```

Becomes a graph with deterministic ids — `device:B1`, `device:B2`,
`plc_channel:%I0.0`, `plc_channel:%I0.1`, `terminal:1`, `terminal:2`,
`cable:W12`, `wire:C7` — each with an EPLAN source ref pointing at
its element line + XML locator. Feeding the graph to
`buildPirDraftCandidate` produces 5 IO candidates and 3 equipment
candidates from the full simple fixture (sensor_discrete +
valve_solenoid + motor_simple).

#### What EPLAN XML v0 is NOT

- **Not the final EPLAN strategy.** It supports a representative
  structured XML schema. Real EPLAN exports may need additional
  shape recognisers, namespace handling, or EDZ archive
  extraction; those land in future sprints.
- **Not PDF / OCR.** Files with `kind: 'pdf'` still fall through
  to the unsupported stub.
- **Not EDZ archive extraction.** `kind: 'edz'` / `epdz` are
  archives — out of scope for v0.
- **Not in-process Sigstore for trust.** Trust still flows from
  CI provenance + npm audit signatures (Sprint 70/71); ingestion
  does not authenticate the source XML.

## Trademark / provenance note

This package ingests files **exported by** EPLAN software but is
not affiliated with or endorsed by EPLAN GmbH & Co. KG. The
file-kind names (`xml`, `edz`, `pdf`, `csv`) refer to file
containers, not vendor schemas. The package is named
`@plccopilot/electrical-ingest`, not `eplan` — EPLAN is one source
among several, and the architecture explicitly supports CSV,
structured XML, manual entry, and a future PDF fallback.

## Industrial safety

Generated PIR candidates are **never** automatically promoted to
final PIR. Operator review is required by design. Source-traceable
electrical facts outrank any prompt text — when prompts disagree
with the wired evidence, the evidence wins. The architecture
encodes this by:

- Forcing every node, edge, and candidate to carry `sourceRefs`.
- Marking unverifiable claims as **assumptions** with their own
  confidence and source list.
- Failing gracefully (diagnostic, not exception) on any branch
  the system can't fully justify.

## Sprint roadmap

| Sprint | Goal |
| --- | --- |
| 72 | Architecture + canonical model + helpers + unsupported EPLAN stub + tests + this doc. |
| 73 | CSV terminal/device list → ElectricalGraph; 12 new diagnostic codes; default registry routes CSV → CSV ingestor → EPLAN stub fall-through. |
| **74** (this sprint) | EPLAN structured XML ingestor v0 + minimal hand-rolled XML parser; 12 more diagnostic codes; XML routing owned by the EPLAN XML ingestor (unknown roots emit `EPLAN_XML_UNKNOWN_ROOT`, never fall through silently). |
| 75 | Review UI: confidence panel, source-ref drilldown, accept/reject assumptions. |
| 76 | PIR draft → PIR builder; integrate with the existing codegen pipeline. |
| later | EDZ archive extraction (real EPLAN containers), PDF fallback (only as last resort, OCR clearly flagged), Siemens TIA hardware-config import as an alternative source. |

Each future sprint stays narrow: a single concrete source format
or a single review-UX feature, never a "magically understand the
machine" pivot. The codegen pipeline downstream stays unchanged
in this sprint.

## Running locally

```sh
pnpm --filter @plccopilot/electrical-ingest typecheck
pnpm --filter @plccopilot/electrical-ingest test

# All packages, repo-wide:
pnpm -r typecheck
pnpm -r test
pnpm run ci
```

Sprint 72 added 81 new tests (graph + confidence + diagnostics +
sources + trace + pir-candidate). Sprint 73 added 46 more (CSV).
**Sprint 74 adds 66 more** (XML utils + EPLAN-XML detection +
parser + mapping + diagnostics + registry routing + PIR candidate
integration + golden fixtures) for a package-local total of 193.
Existing codegen tests are unchanged.
