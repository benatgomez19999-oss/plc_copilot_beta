# Electrical-plan ingestion architecture

> **Status: cross-renderer `motor_vfd_simple` parity bar
> (Sprint 88K, tests-only); `motor_vfd_simple` universally supported
> across CODESYS / Siemens / Rockwell after the Logix audit (Sprint
> 88J); Siemens support (Sprint 88I); CODESYS support (Sprint 88H);
> PIR + codegen-core lowering (Sprint 88G); PIR design *Option A —
> Parameter→role binding* (Sprint 88F); audit deferred (Sprint 88E);
> cross-renderer `valve_onoff` parity bar (Sprint 88D); Rockwell
> valve_onoff support after Logix audit (Sprint 88C).** Sprint 72
> scaffolded the architecture. Sprint 73 added the CSV ingestor.
> Sprint 74 added the EPLAN structured XML ingestor v0. Sprint 75
> added the Review UI v0. Sprint 76 added the PIR builder v0.
> Sprint 77 wired the full path in `@plccopilot/web`. Sprint 78A
> added the Beckhoff/TwinCAT ECAD Import XML recognizer + the
> empty-candidate UX fix. Sprint 78B layered local review-session
> persistence + downloadable artefacts. Sprint 79 opened the
> second strategic source category — PDF — with architecture +
> types + an honest binary stub. Sprint 80 replaced that stub
> with a real text-layer extractor backed by `pdfjs-dist` (legacy
> Node build), behind an isolated adapter that's the only file in
> the codebase importing pdfjs. **Sprint 81** adds the first
> usable IO/table extraction layer on top: a per-page table
> detector that recognises IO-list-shaped headers (English +
> German), assembles `PdfTableCandidate`s, and feeds a multi-
> pattern IO-row extractor (address-first / tag-first /
> tag+direction+address / address+tag+direction). Confidence on
> PDF-derived nodes stays ≤ 0.65, review-first stays load-bearing,
> and OCR / symbol recognition / wire tracing / multi-column /
> rotated-page support stay deferred. Sprint 81 also includes
> the first deterministic acceptance harness — see
> [`docs/pdf-manual-acceptance-sprint-81.md`](pdf-manual-acceptance-sprint-81.md).
> Raw PDF bytes are NEVER persisted in the snapshot (privacy).

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

## Sprint 78B — operator workflow on top of the same review model

Sprint 78B is purely a `@plccopilot/web` change. It does **not**
touch the domain ingestion model — every guarantee from Sprint
72 onwards (sourceRefs everywhere, structured diagnostics, no
silent drops, review-first promotion) is preserved verbatim.

What 78B adds, layered on top:

1. **Snapshot type** (`electrical-review-session.v1`) that pins the
   exact pieces of state needed to restore a review session: source
   metadata, the full `PirDraftCandidate`, the `ElectricalReviewState`,
   the registry-side ingestion diagnostics, and (when present) a
   build summary. See
   [`docs/electrical-review-session-format.md`](electrical-review-session-format.md).
2. **Storage** layer over `localStorage` (single-slot v0) with
   defensive restore: malformed entries are cleared on read,
   storage-disabled environments fall through gracefully.
3. **Export** layer that serialises the snapshot + each downstream
   artefact (PIR JSON, sourceMap, build diagnostics, ingestion
   diagnostics) and bundles them into a `JSZip` review bundle. The
   availability projection (`computeExportAvailability`) is the
   single source of truth for which downloads are enabled.
4. **UX:** `ReviewSessionPanel` (save now / load last / clear /
   download / import) and `ExportArtifactsPanel` (per-artefact
   download buttons + bundle).

The downstream contracts that PDF ingestion (Sprint 79) will
inherit from 78B:

- **The same review model.** A future `PdfDocument` ingestor will
  emit a `PirDraftCandidate` with page/bbox `SourceRef`s; the same
  review UI + the same persistence layer + the same export bundle
  apply unchanged.
- **The same gate semantics.** Empty/pending/error refuses;
  accepted-only build; structured-honest addresses.
- **The same privacy default.** Raw source content (PDF bytes)
  must not be persisted in the snapshot; `contentHash` is fine
  for local identity.

This keeps both branches of the strategic requirement — structured
ECAD exports today and PDF documents tomorrow — funnelling through
the same review/persist/export model. A weak prompt cannot
override that model: it has no surface area in any of these layers.

## Sprint 88K — Cross-renderer `motor_vfd_simple` parity bar

Tests-only sprint mirroring Sprint 88D for valve_onoff. Sprints
88H/88I/88J each shipped a per-package end-to-end spec for
`motor_vfd_simple`; none of them guarded parity *across* the
three production backends. Sprint 88K adds that guardrail at
integration scope. The new spec at
[`packages/codegen-integration-tests/tests/motor-vfd-simple-universal-support.spec.ts`](../packages/codegen-integration-tests/tests/motor-vfd-simple-universal-support.spec.ts)
takes one PIR fixture (single station, single
`motor_vfd_simple`, bool `run_out`, numeric `speed_setpoint_out`,
machine-level numeric `Parameter p_m01_speed`,
`io_setpoint_bindings.speed_setpoint_out → p_m01_speed`) and runs
it through CODESYS, Siemens, and Rockwell — pinning identical
type-artifact field set
(`cmd_run`/`speed_setpoint`/`fault`), the run + parameter-sourced
setpoint assignments in each target's lexical convention, the
no-synthesised-literal invariant on the speed-setpoint RHS
(target-specific regex against
`io_m01_speed_aw := <number>;` and `:= TRUE/FALSE;`), the
deterministic lowering breadcrumbs, no synthesised
close/busy/done/position/reverse/reset/jog/permissive/ramp/
fault-latch identifiers, manifest cleanliness with
`ROCKWELL_EXPERIMENTAL_BACKEND` retained on Rockwell, preflight
passing on every vendor target, the
`pneumatic_cylinder_1pos`-still-rejected regression bar,
determinism (byte-identical artifacts + stable manifest
diagnostic codes across two runs), and unique artifact paths.
33 effective tests in a single parametrised spec. No production
code touched. See
[`docs/codegen-integration-motor-vfd-simple-sprint-88K.md`](codegen-integration-motor-vfd-simple-sprint-88K.md)
for the full guarantee/non-guarantee list and the recommended
Sprint 88L sequence.

## Sprint 88J — Rockwell `motor_vfd_simple` audit + widening (universal convergence)

Audit-first sprint mirroring 88C / 88H / 88I. The Rockwell/Logix
renderer was audited against the 9-point checklist (per-equipment
switch, hard-coded UDT_NAMES, TypeArtifactIR.fields rendering,
Assign rendering, SymbolRef → parameter rendering via shared
`renderStorage`, naming conversion, manifest diagnostics, FB body
walking, Logix tag-name constraints) and came back fully clean.
Sprint 88G's `wireMotorVfdSimple` already produces the IR; the
Logix renderer emits it generically the moment the readiness
capability table opens. Rockwell now joins the wider set, and the
narrow `ROCKWELL_SUPPORTED_EQUIPMENT` constant is removed —
all four targets (`core` / `codesys` / `siemens` / `rockwell`)
converge on `CORE_SUPPORTED_EQUIPMENT`. New per-package
end-to-end spec at
[`packages/codegen-rockwell/tests/motor-vfd-simple.spec.ts`](../packages/codegen-rockwell/tests/motor-vfd-simple.spec.ts)
pins: `UDT_MotorVfdSimple` exact field set
(`cmd_run : BOOL`, `speed_setpoint : REAL`, `fault : BOOL`),
the run command and parameter-sourced setpoint assignments
(`io_m01_run := mot01_run_cmd` and
`io_m01_speed_aw := p_m01_speed;`), the no-synthesised-literal
invariant on the speed setpoint RHS (regex against
`:= TRUE/FALSE/<number>;`), the no-extra-signals contract,
manifest cleanliness with `ROCKWELL_EXPERIMENTAL_BACKEND`
retained, the `UNBOUND_ROLE` / `UNBOUND_SETPOINT_SOURCE` paths,
determinism, and no-duplicate-paths. Codegen-core readiness
tests, the 88D cross-renderer parity bar, the web readiness-view
spec, and the CLI generate spec all updated; the
"unsupported-universal" guardrail moves from `motor_vfd_simple`
to `pneumatic_cylinder_1pos`. The cross-renderer
`motor_vfd_simple` parity bar (mirror of 88D for valve_onoff)
lands in Sprint 88K. See
[`docs/codegen-motor-vfd-rockwell-sprint-88J.md`](codegen-motor-vfd-rockwell-sprint-88J.md)
for the full audit findings, the readiness vendor matrix
(`core: ✅`, `codesys: ✅`, `siemens: ✅`, `rockwell: ✅`),
the honest constraints, and the recommended Sprint 88K/L sequence.

## Sprint 88I — Siemens `motor_vfd_simple` audit + widening

Audit-first sprint mirroring 87C (Siemens valve_onoff) and 88H
(CODESYS motor_vfd_simple). The Siemens/SCL renderer was audited
against the 8-point checklist (per-equipment switch, hard-coded
UDT_NAMES, TypeArtifactIR.fields rendering, Assign rendering,
SymbolRef→parameter rendering via shared `renderStorage`, naming
convention, manifest diagnostics, FB header / VAR section
generation) and came back fully clean. Sprint 88G's
`wireMotorVfdSimple` already produces the IR; the SCL renderer
emits it generically the moment the readiness capability table
opens. The Siemens capability table now uses
`CORE_SUPPORTED_EQUIPMENT` (which includes `motor_vfd_simple`);
the prior `SIEMENS_ROCKWELL_SUPPORTED_EQUIPMENT` constant is
renamed to `ROCKWELL_SUPPORTED_EQUIPMENT` since only Rockwell
remains on the narrower set until Sprint 88J. The Siemens public
helper map (`UDT_NAMES`) gains a `motor_vfd_simple → UDT_MotorVfdSimple`
entry so `udtName('motor_vfd_simple')` returns the canonical
name. New per-package end-to-end spec at
[`packages/codegen-siemens/tests/motor-vfd-simple.spec.ts`](../packages/codegen-siemens/tests/motor-vfd-simple.spec.ts)
pins: `UDT_MotorVfdSimple` exact field set
(`cmd_run : Bool;`, `speed_setpoint : Real;`, `fault : Bool;`),
the run command and the parameter-sourced setpoint assignments
(`"io_m01_run" := #mot01_run_cmd;` and
`"io_m01_speed_aw" := "p_m01_speed";`), the no-synthesised-literal
invariant on the speed setpoint RHS, the no-extra-signals
contract, manifest cleanliness, the `UNBOUND_ROLE` /
`UNBOUND_SETPOINT_SOURCE` paths, public helper consistency,
determinism, and no-duplicate-paths. Codegen-core readiness
tests, the Sprint 88D cross-renderer parity bar, and the web
readiness-view spec all updated to reflect the
Rockwell-only-blocked split. See
[`docs/codegen-motor-vfd-siemens-sprint-88I.md`](codegen-motor-vfd-siemens-sprint-88I.md)
for the full audit findings, the readiness vendor matrix
(`core: ✅`, `codesys: ✅`, `siemens: ✅`, `rockwell: ❌`), the
honest constraints, and the recommended Sprint 88J/K/L sequence.

## Sprint 88H — CODESYS `motor_vfd_simple` audit + widening

Audit-first sprint (mirror 87A/87C/88C template). The CODESYS
renderer was audited against the 7-point checklist (per-equipment
switch, hard-coded UDT_NAMES map, TypeArtifactIR.fields rendering,
Assign StmtIR rendering, station FB rendering, manifest
diagnostics, naming conversion) and came back fully clean. Sprint
88G's `wireMotorVfdSimple` already produces the IR; the renderer
emits it generically the moment the readiness capability table
opens. The CODESYS capability table now uses
`CORE_SUPPORTED_EQUIPMENT` (which includes `motor_vfd_simple`);
Siemens and Rockwell stay on the narrower
`SIEMENS_ROCKWELL_SUPPORTED_EQUIPMENT` set until their per-target
audits in Sprint 88I and 88J. New per-package end-to-end spec at
[`packages/codegen-codesys/tests/motor-vfd-simple.spec.ts`](../packages/codegen-codesys/tests/motor-vfd-simple.spec.ts)
pins: `DUT_MotorVfdSimple` exact field set
(`cmd_run/speed_setpoint/fault`), the run command and the
parameter-sourced setpoint assignments, the no-synthesised-literal
invariant on the speed setpoint RHS (regex against `:= <number>`),
the no-extra-signals contract, manifest cleanliness, the
`UNBOUND_ROLE`/`UNBOUND_SETPOINT_SOURCE` paths, determinism, and
no-duplicate-paths. Codegen-core readiness tests, the Sprint 88D
cross-renderer parity bar, and the web readiness-view spec all
updated to reflect the per-vendor split. See
[`docs/codegen-motor-vfd-codesys-sprint-88H.md`](codegen-motor-vfd-codesys-sprint-88H.md)
for the full audit findings, the readiness vendor matrix
(`core: ✅`, `codesys: ✅`, `siemens: ❌`, `rockwell: ❌`), the
honest constraints, and the recommended Sprint 88I/J/K/L
sequence.

## Sprint 88G — PIR `io_setpoint_bindings` + codegen-core `motor_vfd_simple` lowering

Implementation sprint following Sprint 88F's Option A decision.
Adds an optional `io_setpoint_bindings: Record<string, Id>` field
on `Equipment` (PIR), validator rule **R-EQ-05** (every required
numeric output role must have a parameter setpoint source; every
declared entry must be well-formed), and a new `wireMotorVfdSimple`
helper in codegen-core that wires `run_out := run_cmd` plus
`speed_setpoint_out := <bound parameter symbol>` — never a
synthesised literal. The codegen-core compile pipeline now emits
`UDT_MotorVfdSimple` (`cmd_run : Bool`, `speed_setpoint : Real`,
`fault : Bool`) for `motor_vfd_simple` projects. **Vendor capability
tables stay closed**: `runTargetPreflight` continues to throw
`READINESS_FAILED` / `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`
on CODESYS, Siemens, and Rockwell. The `core` capability table
widens to mirror `compileProject`'s `SUPPORTED_TYPES`. Per-vendor
audits (88H CODESYS, 88I Siemens, 88J Rockwell) reopen the vendor
tables one at a time. See
[`docs/pir-motor-vfd-setpoint-binding-sprint-88G.md`](pir-motor-vfd-setpoint-binding-sprint-88G.md)
for the full file-by-file change list, the new diagnostic codes
(`UNBOUND_SETPOINT_SOURCE`, `UNKNOWN_SETPOINT_PARAMETER`), and the
recommended Sprint 88H plan.

## Sprint 88F — PIR design for `motor_vfd_simple` numeric setpoint binding (Option A)

Design-only sprint. Sprint 88E established that the renderer side is
structurally agnostic and the blocker is in PIR — `speed_setpoint_out`
is a required numeric output with no PIR-level mechanism to drive a
value into it. Sprint 88F audits the existing PIR `Parameter` /
`Activity` / `Recipe` machinery and compares two ways to close the
gap: **Option A — parameter→role binding** (a new optional
`io_setpoint_bindings: Record<role, parameter_id>` on `Equipment`,
reusing the existing `Parameter` validation + symbol-resolver +
`DB_Global_Params` lowering) versus **Option B — numeric activity
verb / `Action[]` payload** (extending `Activity` to carry a numeric
value into a setpoint output). The recommendation is **Option A**:
the setpoint is a process parameter, not a sequence event;
Option A reuses three mature facilities and touches one PIR type,
one validator rule, and one lowering helper, while Option B
conflates state-entry semantics with process-parameter semantics,
forces a breaking change to `activate: string[]` (or activates
the long-deferred `Action[]` lowering path), and loses recipe
override "for free." A concrete Sprint 88G implementation plan +
acceptance criteria is provided in
[`docs/pir-motor-vfd-speed-setpoint-design-sprint-88F.md`](pir-motor-vfd-speed-setpoint-design-sprint-88F.md).
Capability tables stay closed for `motor_vfd_simple` until 88G
ships and the per-vendor audits (88H/88I/88J) follow.

## Sprint 88E — `motor_vfd_simple` audit (support deferred)

Audit-first sprint, halted at *camino A — support deferred*. The
CODESYS / Siemens / Rockwell renderers are all structurally
agnostic for the kind (same shape that 87A / 87C / 88C found for
`valve_onoff`); the blocker is in PIR. `motor_vfd_simple` requires
a numeric `speed_setpoint_out` role with **no** PIR-level
mechanism (no numeric activity verb, no parameter→role binding)
to drive a value into it. Any v0 lowering would need to either
synthesise a value (forbidden by sprint contract — assumption
promotion) or leave a required output dangling on a real-world
VFD (industrial risk: stale or zero speed reference). A future
sprint must first design an explicit numeric-setpoint source in
PIR before any renderer-side widening can ship safely. One
capability-table-level test now pins the audit decision in
[`packages/codegen-core/tests/codegen-readiness.spec.ts`](../packages/codegen-core/tests/codegen-readiness.spec.ts);
the per-target preflight throw (87A test 8) and the cross-target
integration loop (88D test 5) keep the rejection covered. See
[`docs/codegen-motor-vfd-simple-audit-sprint-88E.md`](codegen-motor-vfd-simple-audit-sprint-88E.md)
for the full audit findings, the conditions under which support
re-opens, and the recommended next sprint.

## Sprint 88D — Cross-renderer `valve_onoff` parity bar

Tests-only sprint. Sprints 87A → 88C each shipped a per-package
spec pinning **its own** target's `valve_onoff` artifact shape;
none of them guarded **parity** across the three production
backends. Sprint 88D adds
[`packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts`](../packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts)
which runs a single `valve_onoff` PIR fixture through CODESYS,
Siemens and Rockwell and asserts: (a) the type artifact carries
exactly `cmd_open` + `fault` on every backend, (b) every station
FB wires `open_cmd → io_v01_sol` in its target's lexical
convention, (c) no backend synthesises close output / position
feedback / busy / done / fault latch, (d) `runTargetPreflight`
returns clean for every vendor target, (e) `motor_vfd_simple`
still throws `READINESS_FAILED` on every vendor target (no
accidental opening), and (f) generation is deterministic.
22 effective tests, no production code touched. See
[`docs/codegen-integration-valve-onoff-sprint-88D.md`](codegen-integration-valve-onoff-sprint-88D.md)
for the full guarantee/non-guarantee list.

## Sprint 88C — Rockwell valve_onoff support after Logix audit

Third per-target equipment-support widening. After auditing
the Rockwell/Logix renderer (no per-equipment-kind dispatch;
fully IR-driven UDT + Assign rendering; no `UDT_NAMES` map —
canonical names flow through `core.canonicalTypeName`; global
`ROCKWELL_*` diagnostics never gated on equipment type),
Sprint 88C widens Rockwell's capability table to include
`valve_onoff`. With this sprint, all four codegen targets
(`core`, `siemens`, `codesys`, `rockwell`) converge on the
widened `CORE_SUPPORTED_EQUIPMENT` set; the
`ROCKWELL_SUPPORTED_EQUIPMENT` "narrow" bucket is removed.

No new lowering, no new DUT shape, no safety semantics —
Sprint 87A's `wireValveOnoff` + `UDT_ValveOnoff` carry through
unchanged. The Sprint 87A Rockwell rejection spec was
replaced with a support spec that pins the artifact list,
deterministic ST output, and the unchanged `UNBOUND_ROLE`
contract for missing bindings. The Sprint 87C CLI
`[READINESS_FAILED]` test was retargeted from `valve_onoff`
to `motor_vfd_simple` (still unsupported on every target) so
the rich-error UX is still pinned end-to-end.

Documented in
[`docs/codegen-equipment-support-sprint-88C.md`](codegen-equipment-support-sprint-88C.md).

## Sprint 88A — Cross-source duplicate detection v0

A read-only audit layer between Sprint 85's same-candidate
hardening and the per-item PIR build loop. Detects duplicates
that span ≥ 2 distinct `SourceRef.sourceId` values (CSV +
EPLAN, EPLAN + TcECAD, …) and emits three new
`PirBuildDiagnostic` codes:

- `PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_ADDRESS` (warning)
- `PIR_BUILD_CROSS_SOURCE_DUPLICATE_IO_TAG` (warning)
- `PIR_BUILD_CROSS_SOURCE_DUPLICATE_EQUIPMENT_ID` (warning)

New module
[`packages/electrical-ingest/src/mapping/cross-source-duplicates.ts`](../packages/electrical-ingest/src/mapping/cross-source-duplicates.ts)
exports two pure helpers:

- `summarizeCrossSourceDuplicates(candidate, state)` — walks
  the accepted subset, groups by canonical address /
  normalised tag / raw equipment id, returns groups that span
  ≥ 2 distinct sourceIds. No vendor coercion: TcECAD
  structured names and PDF channel-marker text do NOT collapse
  with Siemens parsed addresses.
- `diagnoseCrossSourceDuplicates(summary)` — turns the summary
  into a deterministic, deduplicated `PirBuildDiagnostic[]`.

Wired into `buildPirFromReviewedCandidate` immediately after
Sprint 85's `diagnoseHardenedGraph`. Sprint 76's gate semantics,
Sprint 85's same-candidate warnings, and the sourceMap sidecar
are all preserved verbatim. The detector never auto-merges,
never picks a winner, and never coerces vendor-specific
addresses.

The web UX as of Sprint 87C imports one source per session, so
this detector stays dormant on today's review snapshots — the
audit layer ships ahead of the (future) multi-source review UX
so the safety contract is in place when it lands.

Documented in
[`docs/cross-source-duplicates-sprint-88A.md`](cross-source-duplicates-sprint-88A.md).

## Sprint 87C — Siemens valve_onoff support after SCL audit

Second per-target equipment-support widening. After auditing
the Siemens SCL renderer (no per-equipment-kind dispatch;
fully IR-driven) Sprint 87C widens Siemens's capability table
to include `valve_onoff`. No new lowering, no new DUT shape,
no safety semantics — Sprint 87A's `wireValveOnoff` +
`UDT_ValveOnoff` carry through unchanged.

Changes:

- `siemens` capability bucket now uses `CORE_SUPPORTED_EQUIPMENT`
  (the widened set). The legacy `SIEMENS_ROCKWELL_SUPPORTED_EQUIPMENT`
  set was renamed `ROCKWELL_SUPPORTED_EQUIPMENT` and now serves
  Rockwell only.
- `packages/codegen-siemens/src/naming.ts` adds `valve_onoff:
  'UDT_ValveOnoff'` to `UDT_NAMES` for public-helper
  consistency with `canonicalTypeName`.
- Tests: Sprint 87A's Siemens rejection spec became a support
  spec (UDT shape, FB wiring, deterministic re-runs, manifest
  cleanliness, unchanged `UNBOUND_ROLE` contract). Sprint 87A
  Rockwell rejection spec carries through. CLI `[READINESS_FAILED]`
  test was retargeted from `siemens` to `rockwell` (the only
  vendor target that still rejects `valve_onoff`). Web Sprint
  87B readiness-view tests updated: Siemens ready, Rockwell
  blocked.

Documented in
[`docs/codegen-equipment-support-sprint-87C.md`](codegen-equipment-support-sprint-87C.md).

## Sprint 87B — Codegen readiness UX in web

`@plccopilot/web` now runs `preflightProject` BEFORE the
operator presses Generate and surfaces the diagnostics as a
compact `CodegenReadinessPanel`. The panel sits between the
existing `<Toolbar>` and the `compileError` banner, reading
the existing `appliedProject` + `backend` selector — no new
state, no duplicate selector. Status verdicts: `unavailable`
(no PIR) / `ready` / `warning` / `blocked`.

The Sprint 86 fallback path (CompileClientError surfacing
`READINESS_FAILED` *after* Generate) is preserved; Sprint 87B
adds the *prevention* layer.

When the `backend` selector value is `'all'` the panel stacks
one card per vendor target. The Sprint 87A per-target split is
visible operator-side: a project containing `valve_onoff`
shows `ready` for CODESYS and `blocked` for Siemens / Rockwell
with the same `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`
group, hint, path, and symbol the codegen-core preflight
already produces.

UX-only sprint — no automatic codegen, no new equipment
support, no schema bump, no worker-protocol change. Documented
in [`docs/codegen-readiness-ux-sprint-87B.md`](codegen-readiness-ux-sprint-87B.md).

## Sprint 87A — Target equipment support v0 (`valve_onoff` for CODESYS)

The first per-target equipment-support split. Sprint 86 left
all four codegen targets on the same supported set; Sprint 87A
widens **CODESYS only** with `valve_onoff` (single-coil
spring-return solenoid valve). Siemens and Rockwell continue
to reject the kind via `READINESS_FAILED` +
`READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.

Changes:

- `compileProject.SUPPORTED_TYPES` adds `valve_onoff` (the
  vendor-neutral lowering accepts it). The CLI / web tests for
  Siemens / Rockwell rejection still pass because preflight
  rejects before `compileProject` runs.
- `SUPPORTED_ACTIVITIES` adds `valve_onoff: ['open']`. One
  spring-return activity; no separate close.
- `wireValveOnoff` in
  [`packages/codegen-core/src/compiler/lowering/outputs.ts`](../packages/codegen-core/src/compiler/lowering/outputs.ts)
  emits one `solenoid_out := <valve>_open_cmd` assignment per
  active state.
- `UDT_ValveOnoff` (rendered as `DUT_ValveOnoff` for CODESYS)
  with two fields: `cmd_open : Bool`, `fault : Bool`.
- Readiness capability tables split — `core` / `codesys`
  include `valve_onoff`; `siemens` / `rockwell` stay on the
  Sprint 86 baseline (3 kinds).

No new safety semantics, no synthesised close output, no
position feedback. Documented in
[`docs/codegen-equipment-support-sprint-87A.md`](codegen-equipment-support-sprint-87A.md).

## Sprint 86 — Codegen readiness diagnostics v0

A small pure preflight in `@plccopilot/codegen-core` runs at
the start of every target façade
(`generateSiemensProject` / `generateCodesysProject` /
`generateRockwellProject`). It walks the PIR once, collects
`READINESS_*` diagnostics for unsupported equipment / IO data
types / IO memory areas, duplicate equipment ids / IO ids /
addresses / generated symbols, placeholder sequences, and
no-generatable-objects. When any error severity diagnostic is
found, the façade throws a single `CodegenError('READINESS_FAILED', …)`
with the rolled-up list attached as `cause` — operators see
every blocking issue at once instead of just the first
`UNSUPPORTED_EQUIPMENT` throw.

New module
[`packages/codegen-core/src/readiness/codegen-readiness.ts`](../packages/codegen-core/src/readiness/codegen-readiness.ts)
exports:

- `preflightProject(project, options)` — pure / total walker.
- `runTargetPreflight(project, target)` — façade-side helper
  that throws on blocking errors.
- `getTargetCapabilities(target)` — per-target capability
  table (equipment kinds, IO data types, IO memory areas).
- `CodegenTarget`, `TargetCapabilities`, `PreflightResult`,
  `PreflightOptions` — public types.

`READINESS_FAILED` was added to `CODEGEN_ERROR_CODES`. Eight
new readiness codes were added to `DiagnosticCode`. No PIR
mutation, no automatic merging or renaming, no schema bump,
no new generated code. The CLI / web error formatters still
work unchanged because the rolled-up message is single-line.

Documented in
[`docs/codegen-readiness-sprint-86.md`](codegen-readiness-sprint-86.md).

## Sprint 85 — Electrical graph / PIR hardening v0

A small pure layer between the review gate and the per-item
PIR build loop. Sprint 76's builder emitted per-item failure
diagnostics (`PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS`,
`PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID`, …) and a generic
`PIR_BUILD_EMPTY_ACCEPTED_INPUT` when nothing built. On
TcECAD-style inputs that hid the *root cause* — operators saw
the post-hoc cascade with no pointer to the unbuildable IO that
triggered it.

New module
[`packages/electrical-ingest/src/mapping/electrical-graph-hardening.ts`](../packages/electrical-ingest/src/mapping/electrical-graph-hardening.ts)
exports two pure helpers:

- `summarizeAcceptedGraph(candidate, state)` — derives a
  read-only graph summary (accepted IO/equipment ids, buildable
  vs unbuildable IO, equipment→IO references, duplicates,
  orphans).
- `diagnoseHardenedGraph(candidate, summary)` — turns the
  summary into a deduplicated, deterministic list of root-cause
  `PirBuildDiagnostic`s.

Eight new codes added to `PirBuildDiagnosticCode`:

- `PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO` (error)
- `PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO` (warning)
- `PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO` (warning)
- `PIR_BUILD_DUPLICATE_IO_ADDRESS` (warning, one per group)
- `PIR_BUILD_DUPLICATE_IO_TAG` (info)
- `PIR_BUILD_ACCEPTED_IO_ORPHANED` (info, single rolled-up)
- `PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED` (warning, one per equipment)
- `PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING` (warning)

`buildPirFromReviewedCandidate` runs the hardening pass after
the gate and before the per-item loop; existing per-item codes
keep their meaning and still fire as cascades. The Sprint 76
gate semantics (`isReviewedCandidateReadyForPirBuild`,
accepted-only filtering, pending/error blocking, empty-candidate
rejection), the `sourceMap` sidecar contract, the address
strictness rules, and every existing PIR_BUILD_* test are
preserved verbatim.

Volume / UX hardening only — no schema bump, no new
extraction capability, no automatic merging of duplicates, no
address synthesis, no automatic codegen.

Documented in
[`docs/electrical-graph-hardening-sprint-85.md`](electrical-graph-hardening-sprint-85.md).

## Sprint 84.1B — PDF layout diagnostic rollups

Diagnostic-hygiene sprint. Sprint 84 / 84.1 emitted layout
diagnostics per page; on the 86-page TcECAD fixture that
produced dozens of `PDF_LAYOUT_MULTI_COLUMN_DETECTED` /
`PDF_LAYOUT_REGION_CLUSTERED` rows. Sprint 84.1B keeps the same
diagnostic codes and emits them as compact rollups:

- New module
  [`pdf-layout-diagnostics.ts`](../packages/electrical-ingest/src/sources/pdf-layout-diagnostics.ts)
  with `LayoutPageFinding` and `buildLayoutDiagnosticRollups`.
  Pure / DOM-free / total.
- `pdf.ts` (text-mode + bytes-mode) accumulates per-page
  findings and emits one rollup per code at the end of the
  layout pass. Compressed page ranges via the existing
  `compressPageRanges` helper, plus a count summary.
- `PDF_LAYOUT_ROTATION_SUSPECTED` keeps per-page emission —
  rare and operationally important.

Sprint 82's strictness, Sprint 83A's classifier, Sprint 83B's
hygiene gate, Sprint 83C's cross-page call, Sprint 83D's
canonical-section-role keying, Sprint 83E's rep-only fallback,
Sprint 83F's per-page `additionalSourceRefs`, Sprint 84's
column-aware ordering + rotation flagging, and Sprint 84.1's
region-aware table walking are all preserved verbatim. Volume /
UX hardening only — no new extraction capability, no schema
bump on existing consumers, no canvas rendering. Confidence
still capped at 0.65.

Manual acceptance:
[`docs/pdf-manual-acceptance-sprint-84-1B.md`](pdf-manual-acceptance-sprint-84-1B.md).

## Sprint 84.1 — PDF region-aware table walking

Wires the Sprint 84 region-clustering helper into the PDF
detector path:

- `PdfTableDetectorLine` gained an optional
  `regionId?: string` field. Backwards-compatible —
  detector lines without it fall through to Sprint 81/83
  unscoped behaviour.
- `pdf.ts` (text-mode + bytes-mode) clusters each page's
  ordered blocks via `clusterBlocksIntoRegions` and tags
  detector lines with `pdf:p<page>:r<index>` ids when the page
  resolves into ≥ 2 regions. One info diagnostic per page
  where clustering fired: `PDF_LAYOUT_REGION_CLUSTERED`.
- `detectIoTables` header→rows walk now stops at a region
  boundary: a header in region A cannot absorb data rows in
  region B (footer / title-block / unrelated narrative on the
  same ordered line stream).

Sprint 82's strictness, Sprint 83A's classifier, Sprint 83B's
hygiene gate, Sprint 83C's cross-page single call, Sprint 83D's
canonical-section-role keying, Sprint 83E's helper-side
projection, Sprint 83F's per-page `additionalSourceRefs`, and
Sprint 84's column-aware ordering + multi-column / rotation
diagnostics are all preserved verbatim. Volume / safety
hardening only — no new extraction capability, no schema bump
on existing consumers, no canvas rendering. Confidence still
capped at 0.65.

Manual acceptance:
[`docs/pdf-manual-acceptance-sprint-84-1.md`](pdf-manual-acceptance-sprint-84-1.md).

## Sprint 84 — PDF layout hardening v0

Layout-analysis helpers on top of the Sprint 80 line-grouper.
New module
[`packages/electrical-ingest/src/sources/pdf-layout.ts`](../packages/electrical-ingest/src/sources/pdf-layout.ts):

- `detectColumnLayout(blocks, options)` — clusters block
  centerlines from `bbox.x + bbox.width/2`. Returns
  `{ columns, multiColumn, orientation }`.
- `orderBlocksByLayout(blocks, options)` — column-by-column
  reading order; no-op for blocks without geometry (Sprint 79
  test-mode preserved).
- `clusterBlocksIntoRegions(blocks, options)` — vertical-gap
  clustering. Exposed in v0 for tests + future v1 wiring; not
  yet consumed by `detectIoTables`.
- `detectPageRotation(page)` — heuristic flag; v0 does NOT
  un-rotate.

Two new info-only diagnostic codes — `PDF_LAYOUT_MULTI_COLUMN_DETECTED`,
`PDF_LAYOUT_ROTATION_SUSPECTED` — surface the layout signals
to the operator. `pdf.ts` (text-mode + bytes-mode) now reorders
blocks per page through `orderBlocksByLayout` before forwarding
detector lines to the existing single cross-page
`detectIoTables` call from Sprint 83C.

Sprint 82's strictness, Sprint 83A's classifier, Sprint 83B's
hygiene gate, Sprint 83C's single cross-page call, Sprint 83D's
canonical-section-role keying, Sprint 83E's helper-side
evidence projection, and Sprint 83F's per-page
`additionalSourceRefs` are all preserved verbatim. Volume / UX
hardening only — no new extraction capability, no schema bump
on existing consumers, no canvas rendering. Confidence still
capped at 0.65.

Manual acceptance:
[`docs/pdf-manual-acceptance-sprint-84.md`](pdf-manual-acceptance-sprint-84.md).

## Sprint 83F — PDF rollup full per-occurrence drilldown

Removes the Sprint 83E representative-only cliff for
multi-page PDF rollup diagnostics by threading per-page
`SourceRef` evidence through the diagnostic itself.

- `ElectricalDiagnostic` gained an additive optional
  `additionalSourceRefs?: ReadonlyArray<SourceRef>` field.
  Backwards-compatible: older consumers ignore the field; older
  diagnostics omit it entirely. No new diagnostic codes.
- Inside `detectIoTables`, `NonIoFamilyOccurrence.perPage` now
  tracks one `SourceRef` per page (replacing the Sprint 83C
  `Set<number>` of pages). Sprint 83B intra-page dedup is
  preserved as a property of the canonical-key grouping.
- `buildNonIoFamilyRollupDiagnostic` populates
  `additionalSourceRefs` page-ascending (representative excluded);
  single-page rollups omit the field.
- The web UI projects each entry into a per-page evidence list
  and renders it under a `Page N` heading. Sprint 83E
  representative-only notice still appears for older
  diagnostics or partial coverage.

Sprint 82's strictness gate, Sprint 83A's family classifier,
Sprint 83B's hygiene gates, Sprint 83C's cross-page call, and
Sprint 83D's canonical-section-role keying are preserved
verbatim. Volume / UX hardening only — no new extraction
capability, no schema bump on existing consumers, no canvas
rendering. Confidence still capped at 0.65.

Manual acceptance:
[`docs/pdf-manual-acceptance-sprint-83F.md`](pdf-manual-acceptance-sprint-83F.md).

## Sprint 83D — PDF non-IO rollup canonicalization

Volume / UX hardening sprint on top of Sprint 83C's cross-page
rollups. Sprint 83C grouped non-IO diagnostics by `(family,
signature)`, which still produced distinct rollups for numbered
TcECAD section markers (`=COMPONENTS&EPB/1` vs `/2`, …) and for
the three sibling BOM table headers across pages 80–86. Sprint
83D replaces the signature-based key with a *canonical section
role* per family:

- `normalizeNumberedPdfSectionMarker(text)` — recognises
  `=COMPONENTS&EPB/N`, `=CABLE&EMB/N`, `=CONTENTS&EAB/N`,
  `=LEGEND&ETL/N`, `=TERMINAL&EMA/N` (incl. `/N.M`) and returns
  `{ marker, family }` with the numeric suffix discarded.
- `canonicalizeNonIoHeaderRole(text, family)` — derives the
  per-family role: BOM / contents / legend each map to a single
  bucket; cable splits `cable_overview` / `cable_plan` /
  `cable_index`; terminal splits
  `terminal_overview` / `terminal_plan` / `terminal_index`.
- `canonicalizeNonIoFamilyRollupKey({ family, text })` —
  composes the rollup key. `detectIoTables` keys its
  `Map<key, NonIoFamilyOccurrence>` by this canonical key
  instead of the Sprint 83C `(family, signature)` key.
- Diagnostic codes (`PDF_BOM_TABLE_DETECTED`,
  `PDF_TERMINAL_TABLE_DETECTED`, `PDF_CABLE_TABLE_DETECTED`,
  `PDF_CONTENTS_TABLE_IGNORED`, `PDF_LEGEND_TABLE_IGNORED`,
  `PDF_TABLE_HEADER_REJECTED`) are unchanged. No schema bump.

Sprint 82's address strictness, Sprint 83A's family classifier,
Sprint 83B's hygiene helpers, and Sprint 83C's cross-page
`detectIoTables` call from `pdf.ts` are all preserved verbatim.
Sprint 83D is volume / UX only — no new extraction capability,
no UI work.

For the realistic TcECAD-shape mock (numbered EPB / EMB / EAB /
ETL / EMA markers across all five sections + canonical headers
+ footer noise) Sprint 83D emits exactly **5** family rollups:
BOM, contents, terminal, cable overview, cable plan. Hard cap
is **12**; preferred target is 6–10. Sprint 83C on the same
shape produced 7+.

Manual acceptance:
[`docs/pdf-manual-acceptance-sprint-83D.md`](pdf-manual-acceptance-sprint-83D.md).

## Sprint 83C — PDF non-IO diagnostic rollups

Volume / UX hardening sprint on top of Sprint 83B's diagnostic
hygiene. Sprint 83B suppressed footer / weak / body-row noise
and collapsed within-page repeats but kept per-page granularity,
so identical BOM canonical headers on pages 80–86 each emitted
their own `PDF_BOM_TABLE_DETECTED`. The 86-page TcECAD PDF still
produced 7+ family diagnostics — operationally noisy.

Sprint 83C aggregates non-IO family diagnostics across pages by
`(family, signature)` only:

- `compressPageRanges(pages)` — pure helper. Sorts, dedups, drops
  non-finite / non-positive entries, coalesces consecutive runs
  into `"X–Y"` (en-dash). Returns `""` / `"1"` / `"80–86"` /
  `"3, 49–54"`.
- `detectIoTables` non-IO branch — accumulates each occurrence
  into a `Map<key, NonIoFamilyOccurrence>` keyed by
  `${family}:${signature}` (page deliberately removed from the
  key). At end of scan, occurrences are sorted by family name
  then min page and one rollup info diagnostic is emitted per
  group with the message format `Ignored ${label} sections on
  ${pagePhrase}. These are not IO lists. First evidence:
  "${snippet}" (${reason}).`
- The diagnostic codes (`PDF_BOM_TABLE_DETECTED`,
  `PDF_TERMINAL_TABLE_DETECTED`, `PDF_CABLE_TABLE_DETECTED`,
  `PDF_CONTENTS_TABLE_IGNORED`, `PDF_LEGEND_TABLE_IGNORED`,
  `PDF_TABLE_HEADER_REJECTED`) are unchanged. No schema bump.
- `pdf.ts` text-mode and bytes-mode paths now call
  `detectIoTables` ONCE across all pages and redistribute the
  returned `tableCandidates` back to each `PdfPage` by
  `pageNumber`, so cross-page aggregation actually fires in the
  real pipeline.

Sprint 82's address strictness, Sprint 83A's family classifier,
and Sprint 83B's hygiene helpers are preserved verbatim. Sprint
83C is volume / UX only — no new extraction capability.

For the TcECAD-shaped multi-page mock (BOM 80–86 + cable 49–54 +
contents 3 + terminal 1) Sprint 83C emits **at most 4** family
rollups, down from Sprint 83B's 7+.

Manual acceptance:
[`docs/pdf-manual-acceptance-sprint-83C.md`](pdf-manual-acceptance-sprint-83C.md).

## Sprint 83B — PDF diagnostic hygiene + classifier throttling

Diagnostic-hygiene sprint surfaced by the Sprint 83A manual run
on `TcECAD_Import_V2_2_x.pdf`. Sprint 83A's classifier was safe
(BOM headers no longer became IO-list candidates), but the
non-IO branch fired once per **line**, producing hundreds of
duplicate non-IO family diagnostics across vendor-metadata
footers, repeated title-block lines, and body rows that
incidentally hit a strong family token.

Sprint 83B layers three cooperating helpers in
`packages/electrical-ingest/src/sources/pdf-table-detect.ts`:

- `isFooterOrTitleBlockLine` recognises repeated
  title-block/footer metadata (`Datum … Seite`, `Bearb …`,
  `Änderungsdatum …`, `Anzahl der Seiten …`, trailing `Seite N
  von M`). Footer lines never produce a non-IO diagnostic.
- `passesNonIoFamilyHeaderShapeGate` requires either a
  canonical family-title regex (`Stückliste`, `Klemmenplan`,
  `Kabelübersicht`, `Inhaltsverzeichnis`, `Legende`, …) OR
  ≥ 3 strong family-token hits AND ≥ 4 total non-trivial
  tokens. Single-strong-token lines (`Fabrikat BECKHOFF`,
  `Klemmen `) and body rows (`=CABLE&EMB/24 2`) are
  suppressed.
- `nonIoFamilyDiagnosticSignature` produces a normalised dedup
  key. The `detectIoTables` dedup key is now
  `${sourceId}:${page}:${family}:${signature}`, collapsing
  intra-page repeats while preserving per-page granularity.

Sprint 82's address strictness and Sprint 83A's family
classifier semantics are preserved verbatim. Sprint 83B is
hygiene only — no new extraction capability.

The realistic TcECAD-style integration test asserts ≤ 2 family
diagnostics for a 9-line mock page (footer + vendor metadata +
canonical BOM header + body rows), down from the Sprint 83A
6+ baseline.

Manual acceptance:
[`docs/pdf-manual-acceptance-sprint-83B.md`](pdf-manual-acceptance-sprint-83B.md).

## Sprint 83A — PDF table-family classifier hardening

Sprint 83A closes a diagnostic-noise gap surfaced by the Sprint
82 manual run on `TcECAD_Import_V2_2_x.pdf`. Sprint 81's
`detectIoTableHeader` flagged BOM headers (e.g.
`Benennung (BMK) Menge Bezeichnung Typnummer Hersteller
Artikelnummer` on pages 80–86) as IO-list-shaped because
`bmk → tag` + `bezeichnung → description` satisfied the role
floor. Sprint 83A introduces a per-family classifier
(`classifyPdfTableHeader`) that resolves headers into one of
`'io_list' | 'bom_parts_list' | 'terminal_list' | 'cable_list'
| 'contents_index' | 'legend' | 'unknown'` using strong-token
sets. `detectIoTableHeader` returns `null` for any non-IO
family even when the role floor passes; `detectIoTables` emits
family-specific info diagnostics
(`PDF_BOM_TABLE_DETECTED`, `PDF_TERMINAL_TABLE_DETECTED`,
`PDF_CABLE_TABLE_DETECTED`, `PDF_CONTENTS_TABLE_IGNORED`,
`PDF_LEGEND_TABLE_IGNORED`, `PDF_TABLE_HEADER_REJECTED`) instead
of the over-broad Sprint 81 `PDF_TABLE_HEADER_DETECTED`. CSV /
EPLAN / TcECAD ingestors are NOT affected — the family
classifier is PDF-only.

Sprint 82's address strictness gate is preserved verbatim: the
`%I1`/`%I3` PIR-build regression remains closed.

Full reference + manual-acceptance regression:
[`docs/pdf-ingestion-architecture.md`](pdf-ingestion-architecture.md),
[`docs/pdf-manual-acceptance-sprint-83A.md`](pdf-manual-acceptance-sprint-83A.md).

## Sprint 82 — PDF address strictness + source-evidence hardening

Safety/hardening sprint surfaced by manual testing on the public
86-page `TcECAD_Import_V2_2_x.pdf`. Sprint 81's IO-row extractor
was promoting Beckhoff-style channel markers (`I1`, `O2`, `%I1`)
to buildable PIR addresses (`%I1`, `%I3`) — schema-valid PIR but
semantically wrong. Sprint 82 closes that gap with:

- New `classifyPdfAddress(token)` (in
  [`pdf-address-strictness.ts`](../packages/electrical-ingest/src/sources/pdf-address-strictness.ts))
  returning `'strict_plc_address' | 'channel_marker' |
  'ambiguous' | 'invalid'`. Strict requires explicit byte-bit
  notation (`I0.0`, `%Q0.1`, `%IX0.0`, Rockwell tag form).
- `extractIoRow` rejects rows whose **tag column** is itself a
  channel marker (the `I1 I2` page-24 noise shape). Non-strict
  **address columns** are preserved as evidence but not promoted
  to buildable addresses.
- `buildGraphFromIoRows` skips the `plc_channel:` node + edge for
  non-strict rows. Device evidence is preserved with
  `attributes.channel_marker` + `attributes.address_classification`
  so the operator can audit during review.
- 8 new `PDF_*` diagnostic codes (channel-marker / ambiguous /
  strict-required / build-blocked / source-snippet-missing /
  source-bbox-missing).
- CSV / EPLAN / TcECAD ingestors are NOT affected. The
  strictness classifier is invoked from PDF row extraction only.

Web side: `review-source-refs.ts` projection now surfaces the
PDF `snippet` and `bbox` fields the extractor populates. Earlier
sprints had the data on the `SourceRef` but the UI dropped it.
The Sprint 81 manual TcECAD run confirmed the gap. `'twincat_ecad'`
also added to the projection's `KIND_ORDER` so its drilldown
groups under the structured-source family.

Full reference + manual-acceptance regression:
[`docs/pdf-ingestion-architecture.md`](pdf-ingestion-architecture.md),
[`docs/pdf-manual-acceptance-sprint-82.md`](pdf-manual-acceptance-sprint-82.md).

## Sprint 81 — PDF IO/table extraction v0

Sprint 81 stays inside `@plccopilot/electrical-ingest`. No new
runtime deps; `pdfjs-dist` is already there from Sprint 80. Two
files added:

- [`src/sources/pdf-table-detect.ts`](../packages/electrical-ingest/src/sources/pdf-table-detect.ts)
  — header-keyword classifier (English + German + abbreviated
  forms), `looksLikeIoRow` predicate, and the per-page assembler
  `detectIoTables` that turns a list of line blocks into
  `PdfTableCandidate` records.
- [`tests/pdf-acceptance.spec.ts`](../packages/electrical-ingest/tests/pdf-acceptance.spec.ts)
  — first deterministic PDF acceptance harness, paired with
  [`docs/pdf-manual-acceptance-sprint-81.md`](pdf-manual-acceptance-sprint-81.md).

`extractIoRow` (in `pdf.ts`) is now multi-pattern: address-first,
tag-first, tag+direction+address, address+tag+direction. The
matched pattern is recorded in the row's `reasons` trail, and an
explicit-direction column that conflicts with the address
direction raises `PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT`
(warning) — address direction wins.

Sprint 81 also extended the test fixture builder with
`buildTabularPdfFixture(pages)` so tests can place labelled cells
at exact `(x, y)` PDF-point positions. The bytes path uses real
pdfjs item geometry; the test-mode text path falls back to
whitespace-split tokens (with a hard ≥ 2 keyword floor to block
false positives).

The snapshot/export contract is unchanged. New optional fields
on `PdfTableRowCandidate` (`rawText`, `kind`, `sourceRef`) and
`PdfTableCandidate.headerLayout` are additive — Sprint 80
snapshots load cleanly.

## Sprint 80 — PDF text-layer extraction v0

Sprint 80 replaces Sprint 79's binary stub with a real text-layer
extractor. The new dependency is `pdfjs-dist@^5.7.284` (Mozilla
PDF.js, Apache 2.0); it lands as a runtime dep of
`@plccopilot/electrical-ingest` only. Web code still goes through
the registry — no static import of pdfjs in the web bundle.

The adapter lives in
[`packages/electrical-ingest/src/sources/pdf-text-layer.ts`](../packages/electrical-ingest/src/sources/pdf-text-layer.ts)
and is the **only** file in the codebase that imports pdfjs. Full
reference + coordinate-system semantics + failure-path table:
[`docs/pdf-text-layer-extraction.md`](pdf-text-layer-extraction.md).

What changes vs Sprint 79:

- **`ingestPdf` is now async.** The extractor is async, so the
  driver wraps it and returns `Promise<IngestPdfResult>`. The
  registry-facing wrapper was already async; downstream callers
  in web were already awaiting it.
- **Real text-layer extraction on bytes.** Bytes that pass the
  `%PDF-` header check go through `extractPdfTextLayer`
  (pdfjs-dist legacy build). Each page becomes a `PdfPage`; each
  baseline-Y-clustered group of items becomes a `PdfTextBlock`
  with a real `PdfBoundingBox` (unit `'pt'`) and a verbatim
  `snippet`.
- **Sprint 79 stub diagnostics retired on the success path.**
  `PDF_UNSUPPORTED_BINARY_PARSER` and `PDF_TEXT_LAYER_UNAVAILABLE`
  no longer fire on real text-layer PDFs. The success diagnostic
  is `PDF_TEXT_LAYER_EXTRACTED` (info).
- **Honest failure paths.** `PDF_DEPENDENCY_LOAD_FAILED` (error)
  for a failed dynamic import; `PDF_TEXT_LAYER_EXTRACTION_FAILED`
  (error) for a failed parse; `PDF_ENCRYPTED_NOT_SUPPORTED`
  (error) when pdfjs raises `PasswordException`;
  `PDF_TEXT_LAYER_EMPTY_PAGE` (warning) when a page has zero
  items (typical for scanned-image-only pages).
- **Fallback to the test-mode parser.** When bytes extraction
  fails AND a `text` body was also supplied, the ingestor honours
  the Sprint 79 test-mode parser. Both diagnostic sets are
  preserved.
- **No OCR, no symbol recognition, no table detection.** Sprint
  80 keeps every Sprint 79 limit; only the binary parsing
  capability changes.
- **Confidence ladder unchanged.** PDF-derived blocks read at 0.5
  / 0.6, never above 0.65. Lines from a real PDF do NOT read
  higher than lines from the test-mode parser — both go through
  the same regex.

Web integration: the file picker reads `.pdf` via
`arrayBuffer()` (Sprint 79); Sprint 80 changes only what happens
*downstream* — uploading a real selectable-text PDF now produces
a populated review session, where Sprint 79 produced an empty
graph + structured "stub" diagnostics.

The Sprint 78B persistence/export layer is unchanged. PDF bytes
remain NEVER-persisted; PDF SourceRefs (with the new `bbox`
field) round-trip through the snapshot exactly like Sprint 79.

## Sprint 79 — PDF ingestion architecture v0

Sprint 79 lands the PDF source category as a first-class peer of
CSV / EPLAN XML / TcECAD XML. The architecture, not a fake
parser:

- **Source kind.** `ElectricalSourceKind` already had `'pdf'` from
  the Sprint 72 prep work; Sprint 79 makes it produce real
  ingestor output (an empty graph + structured diagnostics for
  bytes-only inputs, or extracted text-blocks + IO candidates for
  the test-mode text path).
- **Document model** lives in
  [`packages/electrical-ingest/src/sources/pdf-types.ts`](../packages/electrical-ingest/src/sources/pdf-types.ts).
  `PdfDocument` → `PdfPage` → `PdfTextBlock` (with optional
  `PdfBoundingBox`) → `PdfTableCandidate` (reserved; never
  populated in v0).
- **SourceRef extensions.** Two optional fields added to the
  cross-cutting `SourceRef`: `bbox?: SourceRefBoundingBox` and
  `snippet?: string`. Existing CSV / EPLAN / TcECAD ingestors are
  unaffected (both are optional).
- **Diagnostics.** 12 new `PDF_*` codes covering the full v0 scope
  (empty / malformed / encrypted / page-limit / no-binary-parser /
  no-text-layer / no-OCR / no-table-detection / no-electrical-
  extraction / no-text-blocks / per-block-extracted / ambiguous-
  IO-row).
- **Registry integration.** Default registry now lists 5 ingestors
  (CSV → TcECAD XML → EPLAN XML → PDF → unsupported stub). PDF
  claims `.pdf` files (extension OR `kind: 'pdf'` OR `%PDF-`
  magic) before the unsupported stub catches anything.
- **Web integration.** `detectInputKind` now returns
  `'csv' | 'xml' | 'pdf' | 'unknown'`; the workspace's file picker
  reads `.pdf` files via `arrayBuffer()` (not `text()`) and
  forwards the bytes to the registry. The Sprint 78B snapshot's
  `inputKind` union is extended to include `'pdf'` (raw bytes are
  NEVER persisted).
- **Honest binary stub.** Bytes-only inputs validate the `%PDF-`
  magic, sniff `/Encrypt`, and emit `PDF_UNSUPPORTED_BINARY_PARSER`
  + `PDF_TEXT_LAYER_UNAVAILABLE` + `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED`.
  No fake parsing.
- **Test-mode text path.** Pre-extracted text + the convention
  `--- page N ---` exercises the architecture end-to-end. A single
  conservative regex extracts `<address> <tag> [<label>]` rows;
  derived candidates never read above 0.65 confidence.

The contract that matters: every PDF-derived fact carries a
`SourceRef` with `kind: 'pdf'`, `page`, optional `bbox`, and a
`snippet`. Promotion to PIR still requires explicit human review
through the same Sprint 75/76/77/78B pipeline.

Full reference: [`docs/pdf-ingestion-architecture.md`](pdf-ingestion-architecture.md).

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
| 74 | EPLAN structured XML ingestor v0 + minimal hand-rolled XML parser; 12 more diagnostic codes; XML routing owned by the EPLAN XML ingestor. |
| 75 | Review UI v0 in `@plccopilot/web` — pure helpers + thin React components, 59 new web tests. |
| 76 | PIR builder v0 in `@plccopilot/electrical-ingest`. Hard gate, role remap, sourceMap sidecar, validation against `@plccopilot/pir`. 67 new tests. |
| 77 | Web end-to-end wiring in `@plccopilot/web`. 43 new web tests. |
| 78A | Beckhoff/TwinCAT ECAD Import XML recognizer + empty-candidate UX fix. New diagnostics: 10 `TCECAD_XML_*` codes. Domain + web gates aligned: empty candidate is no longer "ready". `runElectricalIngestion` routes through the default registry so TcECAD claims XML first; EPLAN unchanged. 41 new electrical-ingest tests + 2 new web tests. |
| 78B | Web review-session persistence + downloadable artefacts. New web utils: `electrical-review-session`, `electrical-review-storage`, `electrical-review-export`. New components: `ReviewSessionPanel`, `ExportArtifactsPanel`. Snapshot schema `electrical-review-session.v1` (raw source content NOT persisted by default). Single-slot localStorage; defensive restore; per-artefact JSON downloads + ZIP bundle. **No backend, no auth, no upload, no codegen.** 85 new web tests. |
| 79 | PDF ingestion architecture v0. `'pdf'` source kind activated; `PdfDocument`/`PdfPage`/`PdfTextBlock`/`PdfTableCandidate` model + `PdfBoundingBox`. `SourceRef` extended with `bbox` + `snippet`. 12 `PDF_*` diagnostics. Honest binary stub + deterministic test-mode text path. Registry: CSV → TcECAD → EPLAN → PDF → unsupported (5 ingestors). Web: `'pdf'` `DetectedInputKind`, bytes upload via `arrayBuffer()`, snapshot `inputKind` extended. Raw PDF bytes NEVER persisted. 40 electrical-ingest tests + 13 web tests. |
| 80 | PDF text-layer extraction v0. `pdfjs-dist@^5.7.284` (legacy Node build) added as runtime dep of `@plccopilot/electrical-ingest`. Isolated adapter + line-grouping. `ingestPdf` is now async. 5 new diagnostics. Sprint 79 stub codes retired on the success path. 22 domain tests + 2 web tests. |
| 81 | PDF IO/table extraction v0. New `sources/pdf-table-detect.ts`. `extractIoRow` multi-pattern. 13 new `PDF_*` diagnostics. First deterministic PDF acceptance harness (`pdf-acceptance.spec.ts` — 4 cases). 36 new domain tests. |
| 82 | PDF address strictness + source-evidence hardening. New `sources/pdf-address-strictness.ts`. `extractIoRow` rejects channel-marker tags; non-strict addresses preserved as evidence. `buildGraphFromIoRows` skips `plc_channel:` + edges for non-strict rows. 8 new `PDF_*` diagnostics. Web `review-source-refs.ts` surfaces `snippet` + `bbox`. 42 new domain tests + 4 new web tests. Manual TcECAD regression: `%I1`/`%I3` PIR builds no longer reproduce. |
| 83A | PDF table-family classifier hardening. New `classifyPdfTableHeader` returning `'io_list' \| 'bom_parts_list' \| 'terminal_list' \| 'cable_list' \| 'contents_index' \| 'legend' \| 'unknown'` with strong-token sets per family + auditable reasons. `detectIoTables` emits family-specific info diagnostics deduped by `(family, page, blockId)`. 7 new `PDF_*` diagnostics. 35 new domain tests. |
| **83B** (this sprint) | **PDF diagnostic hygiene + classifier throttling.** Sprint 83A non-IO branch fired once per line; Sprint 83B adds `isFooterOrTitleBlockLine` (5 footer regexes), `passesNonIoFamilyHeaderShapeGate` (≥ 3 strong tokens AND ≥ 4 total tokens, OR canonical title-pattern), and signature-based per-page dedup (`${sourceId}:${page}:${family}:${signature}`). Vendor metadata + repeated footers + body rows that incidentally hit a strong family token are now suppressed. The Sprint 83A test for the bare `Kabel Ader Quelle Ziel` cable header was updated to use the canonical `Kabelübersicht …` form (which still passes the gate). 36 new domain tests. **Manual TcECAD regression:** non-IO family diagnostics drop from hundreds to a manageable count; safety guarantees (no `%I1`/`%I3` PIR build, no IO candidates from BOM pages) preserved. |
| 83 (planned) | PDF source-evidence UX — optional page preview with bbox overlays, click-through from candidate to source region, better operator trust during review. |
| 83C (alt) | PDF layout hardening — multi-column ordering, rotated pages, coordinate normalisation, region clustering, better column-position detection. |
| 83D (alt) | More structured-source hardening — XML namespaces, EDZ/EPDZ archive extraction, additional TcECAD/EPLAN schema variants. |
| later | OCR fallback (only as a flagged opt-in), symbol/connection-graph recognition, cross-page references, Siemens TIA hardware-config import, controlled codegen preview gated on accepted PIR. |

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

Sprint 72 added 81 new tests. Sprint 73 added 46 more (CSV).
Sprint 74 added 66 more (XML utils + EPLAN-XML). Sprint 75 added
59 web-side tests inside `@plccopilot/web`. Sprint 76 added 67
more in `electrical-ingest` (`pir-builder.spec.ts`). Sprint 77
added 43 web-side tests. Sprint 78A added 41 electrical-ingest
tests (`twincat-ecad-xml.spec.ts`) + 2 web tests (empty-candidate
UX). Sprint 78B added 85 web tests across the four new
review-session/storage/export/workflow specs. Sprint 79 added 40
electrical-ingest tests (`pdf.spec.ts`) + 13 web tests (PDF
detection + flow + session round-trip + privacy). Sprint 80 added 22 electrical-ingest tests (`pdf-text-layer.spec.ts`) +
2 web tests (real-bytes path through `runElectricalIngestion`).
Sprint 81 added 36 electrical-ingest tests across
`pdf-table-detect.spec.ts` + `pdf-acceptance.spec.ts`. The
Sprint 81 post-fixes added 8 web tests (`canIngestElectricalSource`
helper) + 4 electrical-ingest tests (pdfjs worker regression).
Sprint 82 added 42 electrical-ingest tests (strictness classifier
+ gate inside `ingestPdf` + `PdfDraftCandidate` channel-marker
regression) + 4 web tests (source-ref drilldown surfacing PDF
snippet / bbox).
Sprint 83A added 35 electrical-ingest tests
(`pdf-table-family.spec.ts`).
**Sprint 83B adds 36 electrical-ingest tests**
(`pdf-table-family-throttling.spec.ts`) covering
`isFooterOrTitleBlockLine` (7), `passesNonIoFamilyHeaderShapeGate`
(9), `nonIoFamilyDiagnosticSignature` (4), `detectIoTables`
integration (12 — footer / weak-token / BOM-canonical / dedup /
body-row / IO regression), and `ingestPdf` end-to-end with the
realistic TcECAD-style fixture (4 — compact diagnostic stream,
Sprint 82 channel-marker regression, strict-address regression,
mixed BOM page + real IO page). No web changes.
`electrical-ingest`: 480 → 516 (+36). Web: 797 → 797 (no change).
Repo total: 3158 → 3194 (+36). Existing codegen tests are
unchanged.

The review workflow + PIR-builder gate semantics live in
[`docs/electrical-review-workflow.md`](electrical-review-workflow.md);
the builder's API + diagnostics + role-remap rules live in
[`docs/pir-builder-v0.md`](pir-builder-v0.md).
