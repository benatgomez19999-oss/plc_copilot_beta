# Sprint 88M — Structured XML parameter extraction (EPLAN + TcECAD)

Status: closed locally (gates green; not pushed).
Sister sprints: 88E (audit), 88F (Option A design), 88G (PIR + codegen
lowering), 88H (CODESYS), 88I (Siemens), 88J (Rockwell), 88K (parity
bar), **88L** (CSV parameter extraction). 88M extends 88L's pattern
to structured XML — EPLAN XML and TcECAD / TwinCAT ECAD XML — using
a single shared helper.

## What this sprint adds

Both EPLAN XML and TcECAD XML ingestors now recognise two new
explicit-metadata XML elements:

- `<Parameter>` — declares one numeric machine `Parameter`.
  Required attributes: `id` (or `parameter_id` / `name`),
  `dataType` (∈ `int` / `dint` / `real` — bool refused),
  `default` (a finite number). Optional: `unit`, `label`,
  `description`.
- `<SetpointBinding>` — declares one explicit
  `<equipment.id, role>` → `<parameter.id>` edge. Required
  attributes: `equipmentId` (or `equipment_id` / `tag`), `role`
  (today only `speed_setpoint_out`), `parameterId` (or
  `parameter_id`).

Both shapes are read from XML attributes (CSS-style camelCase)
**or** from child element text content (TcECAD `<Name>...</Name>`
style). Lower-case alternatives and snake_case fallbacks are
accepted on a per-field basis. Tag matching itself is
case-insensitive.

A single shared helper drives both ingestors:

- [`packages/electrical-ingest/src/mapping/structured-parameter-draft.ts`](../packages/electrical-ingest/src/mapping/structured-parameter-draft.ts)
  exports `extractStructuredParameterDraft(root, ctx)` and
  `isStructuredParameterDraftEmpty(draft)`. Pure / deterministic;
  walks an already-parsed XML tree once and returns an
  `ElectricalParameterDraft` (the same sidecar Sprint 88L attached
  on `graph.metadata.parameterDraft`).

Each ingestor calls the helper at graph-build time, attaches the
sidecar only when something explicit was seen, and pipes the
helper's diagnostics into the graph diagnostic stream.
`buildPirDraftCandidate` consumes `parameterDraft` exactly the same
way it does for CSV: parameters land on
`PirDraftCandidate.parameters[]`, and bindings land on the matching
equipment candidate's `ioSetpointBindings`. Review → PIR build is
unchanged from Sprint 88L.

## Supported XML shapes

### EPLAN

```xml
<EplanProject schemaVersion="0.1">
  <Parameters>
    <Parameter id="p_m01_speed" dataType="real" default="50" unit="Hz"
               label="M01 speed setpoint"/>
  </Parameters>
  <SetpointBindings>
    <SetpointBinding equipmentId="M01" role="speed_setpoint_out"
                     parameterId="p_m01_speed"/>
  </SetpointBindings>
  <Pages>
    <!-- Existing <Element> device + IO declarations are unchanged. -->
  </Pages>
</EplanProject>
```

The helper recognises `<Parameter>` / `<SetpointBinding>` anywhere in the
tree; the wrapper `<Parameters>` / `<SetpointBindings>` containers above are
just for editorial clarity and have no parser effect.

### TcECAD

```xml
<Project>
  <Description>TcECAD Import V2.2.12</Description>
  <Parameters>
    <Parameter id="p_m01_speed" dataType="real" default="50" unit="Hz"
               label="M01 speed setpoint"/>
  </Parameters>
  <SetpointBindings>
    <SetpointBinding equipmentId="M01" role="speed_setpoint_out"
                     parameterId="p_m01_speed"/>
  </SetpointBindings>
  <CPUs>
    <!-- Existing <CPU>/<Interface>/<Box>/<Variable> hierarchy unchanged. -->
  </CPUs>
</Project>
```

## Field aliases (per-field fallback order)

| Logical field | Accepted attribute / child names |
|---|---|
| Parameter id | `id`, `parameterId`, `parameter_id`, `name` |
| Parameter data type | `dataType`, `data_type`, `datatype`, `dtype` |
| Parameter default | `default`, `defaultValue`, `default_value` |
| Parameter unit | `unit`, `units`, `eu` |
| Parameter label | `label`, `description` |
| Binding equipment id | `equipmentId`, `equipment_id`, `equipmentid`, `tag` |
| Binding role | `role`, `io_role` |
| Binding parameter id | `parameterId`, `parameter_id`, `parameterid`, `param_id` |

For each field the helper first checks attributes (case-insensitive),
then falls back to a child element with the same lowercase tag.
The first non-empty hit wins.

## Diagnostics

| Code | Severity | Source | Fires when |
|---|---|---|---|
| `STRUCTURED_PARAMETER_EXTRACTED` | info | helper | a parameter element produced a clean draft entry |
| `STRUCTURED_PARAMETER_DUPLICATE_ID` | warning | helper | second `<Parameter>` with the same id; dropped (first wins) |
| `STRUCTURED_PARAMETER_METADATA_INCOMPLETE` | error | helper | parameter element has no id / parameter_id / name |
| `STRUCTURED_PARAMETER_METADATA_NOT_NUMERIC` | error | helper | dataType is `bool` or unrecognised |
| `STRUCTURED_PARAMETER_DEFAULT_INVALID` | error | helper | default is missing or non-finite |
| `STRUCTURED_SETPOINT_BINDING_TARGET_MISSING` | error | helper | binding has no equipmentId / tag |
| `STRUCTURED_SETPOINT_BINDING_PARAMETER_MISSING` | error | helper | binding has no parameterId |
| `STRUCTURED_SETPOINT_BINDING_ROLE_UNSUPPORTED` | error | helper | role is empty or not `speed_setpoint_out` |

The Sprint 88L `PIR_BUILD_*` diagnostics on the builder side are
unchanged and apply identically: a binding to a missing or
rejected parameter still refuses the equipment with the same code
regardless of whether the binding came from CSV, EPLAN, or TcECAD.

## What does NOT happen (explicit non-goals)

- **No inference.** `<Comment>`, `<Description>`, `<Label>`,
  `<Remark>`, `<FunctionText>`, free-text labels, or numeric
  values embedded in unrelated attributes are NEVER parsed for
  parameter metadata. Only `<Parameter>` and `<SetpointBinding>`
  elements drive the draft.
- **No alias proliferation.** Sprint 88M v0 only ships the field
  aliases in the table above. The `<Variable Kind="parameter">`
  attribute-discriminated alias mentioned in the prompt is
  *deferred* — it would collide with the existing TcECAD
  `<Variable>` IO model and adds no real expressiveness; if a
  real fixture demands it, a future sprint will add a guarded
  pass.
- **No unit scaling.** `unit` is documentation only.
- **No safety semantics.** No fault latching, e-stop chains,
  permissive logic, ramps, reset, fwd/rev, jog. Untouched.
- **No PDF / OCR / layout work.**
- **No range/min/max validation.** A future sprint may layer
  `min` / `max` parsing if real fixtures expose it.
- **No multi-source merge UX.** Cross-source duplicates stay
  governed by Sprint 88A's diagnostics; multi-file XML imports
  currently union parameter drafts, with operators expected to
  resolve duplicates through review.
- **No vendor codegen change.** Sprints 88G–88K already shipped
  the codegen surface; 88M is purely an ingestion change.
- **No PIR schema change.** All PIR types and validators are
  untouched.
- **No `motor_vfd_simple` candidate-kind inference for
  EPLAN/TcECAD device-row paths.** Operators reviewing a
  structured XML import still correct the equipment kind in the
  review UI before promoting to PIR (Sprint 88L's flow).

## Files touched

### `@plccopilot/electrical-ingest`

- [`src/types.ts`](../packages/electrical-ingest/src/types.ts) — 8 new
  `STRUCTURED_*` diagnostic codes added to the closed
  `ElectricalDiagnosticCode` union.
- [`src/diagnostics.ts`](../packages/electrical-ingest/src/diagnostics.ts) —
  severity table extended for the new codes (mirroring CSV's
  layout: extracted=info, duplicate=warning, metadata-error=error).
- [`src/mapping/structured-parameter-draft.ts`](../packages/electrical-ingest/src/mapping/structured-parameter-draft.ts) — new
  shared helper.
- [`src/sources/eplan-xml.ts`](../packages/electrical-ingest/src/sources/eplan-xml.ts) —
  `EplanXmlParseResult.root?` exposed; `ingestEplanXml` calls the
  helper and attaches the sidecar; multi-file
  `createEplanXmlElectricalIngestor` merges per-file drafts into
  one combined sidecar.
- [`src/sources/twincat-ecad-xml.ts`](../packages/electrical-ingest/src/sources/twincat-ecad-xml.ts) —
  `TcecadParseResult.root?` exposed; `ingestTcecadXml` and the
  registry-facing TcECAD ingestor mirror the EPLAN wiring.

### Fixtures

- [`packages/electrical-ingest/tests/fixtures/eplan/structured-parameters-eplan.xml`](../packages/electrical-ingest/tests/fixtures/eplan/structured-parameters-eplan.xml)
  — new EPLAN fixture with explicit `<Parameter>` +
  `<SetpointBinding>` elements alongside legacy `<Element>` rows.
- [`packages/electrical-ingest/tests/fixtures/eplan/structured-parameters-twincat.xml`](../packages/electrical-ingest/tests/fixtures/eplan/structured-parameters-twincat.xml)
  — new TcECAD fixture mirroring the EPLAN shape.

### Tests

- [`packages/electrical-ingest/tests/structured-parameter-extraction.spec.ts`](../packages/electrical-ingest/tests/structured-parameter-extraction.spec.ts) — 15 new tests covering both ingestors:
  - happy path parameter + binding extraction (EPLAN + TcECAD),
  - per-field invalid-shape diagnostics (bool dataType, missing default, missing id),
  - unsupported role drops the binding,
  - missing parameterId surfaces the dedicated diagnostic,
  - duplicate parameter id keeps first, warns,
  - legacy fixtures (no structured elements) leave metadata clean,
  - free-text comments mentioning numbers do NOT yield parameters,
  - end-to-end review → PIR build with `motor_vfd_simple` populates `machine.parameters` + `Equipment.io_setpoint_bindings` and passes R-EQ-05.

### Docs

- [`docs/electrical-ingest-structured-parameter-extraction-sprint-88M.md`](electrical-ingest-structured-parameter-extraction-sprint-88M.md) — this file.
- [`docs/electrical-ingestion-architecture.md`](electrical-ingestion-architecture.md) — Sprint 88M status entry.

## Tests before → after

| Package | Before | After | Δ |
|---|---:|---:|---:|
| `@plccopilot/electrical-ingest` | 688 | 703 | +15 |
| **Repo total** | **3,584** | **3,599** | **+15** |

PIR (44), codegen-core (771), CODESYS (63), Siemens (184), Rockwell (78), codegen-integration-tests (165), CLI (757), web (834) all unchanged.

## Manual verification checklist

- [ ] EPLAN XML with `<Parameter>` + `<SetpointBinding>` elements ingests cleanly; `result.graph.metadata.parameterDraft` carries the parameter and binding map.
- [ ] TcECAD XML with the same elements behaves identically.
- [ ] `buildPirDraftCandidate(graph)` produces a candidate with `parameters[]` populated and the matching equipment's `ioSetpointBindings` set.
- [ ] Accept-all review of that candidate produces a PIR with `machine.parameters[0]` and `equipment.io_setpoint_bindings.speed_setpoint_out`. PIR validation passes; no R-EQ-05 issues.
- [ ] Drop the `<Parameter>` element → `STRUCTURED_PARAMETER_*` diagnostics fire and the build refuses the equipment via the existing `PIR_BUILD_SETPOINT_BINDING_REFERENCES_MISSING_PARAMETER`.
- [ ] `dataType="bool"` parameter element → `STRUCTURED_PARAMETER_METADATA_NOT_NUMERIC`; no parameter created.
- [ ] `<SetpointBinding role="bogus">` → `STRUCTURED_SETPOINT_BINDING_ROLE_UNSUPPORTED`; no binding.
- [ ] Free-text comments / labels / descriptions mentioning numbers do NOT create parameters.
- [ ] Legacy EPLAN / TcECAD XML (no `<Parameter>` / `<SetpointBinding>` elements) — `metadata.parameterDraft` is undefined; behaviour identical to pre-Sprint-88M.
- [ ] `motor_vfd_simple` end-to-end story: structured XML import → review → PIR → CODESYS / Siemens / Rockwell codegen all green.

## Honest constraints

- **Structured-only.** No inference. The legacy `<Element>` /
  `<Variable>` parsers are unchanged; `<Comment>`,
  `<Description>`, `<Label>` are not parsed for parameter
  metadata.
- **Not a vendor schema certification.** EPLAN / TcECAD vendor
  exports rarely ship with structured `<Parameter>` /
  `<SetpointBinding>` elements out of the box. Sprint 88M's
  fixtures are *representative*, not certified — they document
  the format we accept, not what every commercial export
  happens to produce. A future sprint may layer recognised
  vendor-specific aliases (e.g. EPLAN `Property` / Beckhoff
  `Initialization`) once a real fixture demonstrates them.
- **Per-field aliases are conservative.** We support the names
  in the alias table and nothing else. Operator-authored
  alternative names (`speedref`, `freq`, `hz`) are NOT silently
  remapped; the operator either matches the documented field
  names or the field stays absent and the per-row diagnostic
  fires.
- **Multi-file XML imports union parameter drafts.** A
  parameter-id collision across two files in a single ingest
  produces two `STRUCTURED_PARAMETER_DUPLICATE_ID` diagnostics
  (one per file from the helper's per-tree pass) plus a single
  resolution chosen by file order. A future sprint may add
  cross-source provenance + an explicit conflict-resolution UX
  if multi-source XML imports become common.
- **TcECAD `<Variable>` aliases deferred.** The prompt
  proposed `<Variable Kind="parameter">` as an attribute alias.
  This collides with the legacy TcECAD `<Variable>` IO model
  inside `<Box>` ancestors and adds no expressive power over
  standalone `<Parameter>`. Skipped in v0; a guarded version
  would require either a Kind-attribute filter in the legacy
  variable extractor or a strict parent-element check.
- **No production codegen change.** Vendor capability tables,
  lowering, and renderers untouched.
- **Backward-compatible snapshots.** `metadata.parameterDraft`
  remains optional; legacy graphs round-trip unchanged.
- **pdfjs Windows shutdown flake** in `electrical-ingest`
  (documented since Sprint 84) may surface during
  `pnpm -r test`. Per-package isolated re-runs are clean.

## Recommended next sprint

The `motor_vfd_simple` story is now complete end-to-end:

```
CSV / EPLAN / TcECAD structured metadata
       │
       ▼
   Review (PirBuildReviewState)
       │
       ▼
   buildPirFromReviewedCandidate
       │
       ▼
   PIR (Project) with machine.parameters + Equipment.io_setpoint_bindings
       │
       ▼
   compileProject → ProgramIR
       │
       ├─▶ CODESYS (Sprint 88H)
       ├─▶ Siemens (Sprint 88I)
       └─▶ Rockwell (Sprint 88J)

Cross-renderer parity bar — Sprint 88K.
```

Logical next moves:

- **Sprint 89 — controlled codegen preview UX (web).** The
  pipeline is end-to-end real, so an explicit per-target preview
  before file generation is the natural next operator surface.
- **Alternative — Parameter range / unit cross-validation.**
  When a real fixture exposes `min` / `max` / `unit` metadata,
  a guarded R-EQ-05B sub-rule could check the parameter's
  declared range against the role's expected unit /
  scale. Defer until evidence demands it.
- **Pause-and-listen** — route effort to whichever direction
  operator feedback exposes (additional equipment kinds, recipe
  → parameter UX, multi-source merge UX, etc.).
