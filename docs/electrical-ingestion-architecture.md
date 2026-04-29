# Electrical-plan ingestion architecture

> **Status: PDF non-IO diagnostic hygiene + classifier throttling (Sprint 83B).** Sprint 72
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
