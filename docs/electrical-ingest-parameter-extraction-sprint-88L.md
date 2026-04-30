# Sprint 88L — Electrical-ingest parameter extraction for `motor_vfd_simple`

Status: closed locally (gates green; not pushed).
Sister sprints: 88E (audit), 88F (Option A design), 88G (PIR + codegen
lowering), 88H (CODESYS), 88I (Siemens), 88J (Rockwell), 88K (parity
bar). 88L closes the operator-authored-parameters-only constraint
that 88G acknowledged: a structured CSV source can now declare
machine `Parameter`s and an `io_setpoint_bindings` edge end-to-end.

## What this sprint adds

CSV ingestion learns two new explicit-metadata row types:

- `row_kind=parameter` — declares one numeric machine `Parameter`.
  Required cells: `parameter_id`, `data_type` (∈ `int`/`dint`/`real`
  — no `bool`, mirrors PIR R-EQ-05 sub-rule B5), `default` (a
  finite number). Optional: `unit` (documentation only — no
  scaling), `label`, `comment`.
- `row_kind=setpoint_binding` — declares one explicit edge
  `<equipment.id, role>` → `<parameter.id>`. Required cells:
  `tag` (the equipment id), `role` (today only `speed_setpoint_out`),
  `parameter_id`. Anything else surfaces a deterministic
  diagnostic and the binding is dropped.

The CSV ingestor stashes the result on `graph.metadata.parameterDraft`
(a new optional sidecar). `buildPirDraftCandidate` reads the
sidecar and threads it onto the `PirDraftCandidate`:

- `draft.parameters` → `candidate.parameters[]`.
- `draft.setpointBindings[<eq_id>]` → matching equipment
  candidate's `ioSetpointBindings` (key matched against raw tag
  and the candidate's `eq_device:` / `eq_` prefix-stripped form).
- `draft.diagnostics` → `candidate.diagnostics`, deduplicated.

Review → PIR build (`buildPirFromReviewedCandidate`) gains a
parameter bag in `PirBuildReviewState.parameterCandidates`.
Pending parameter decisions block the build with the new
`PIR_BUILD_PARAMETER_CANDIDATE_PENDING` diagnostic, mirroring
the IO/equipment/assumption gates. Accepted parameters are
materialised onto `machine.parameters[]`. Equipment whose
`ioSetpointBindings` reference an accepted parameter end up
with `Equipment.io_setpoint_bindings` populated and survive
PIR validation including R-EQ-05.

## Supported CSV format (Sprint 88L)

The new headers (case-insensitive, with aliases) are additive on
top of the existing canonical CSV columns. Legacy CSVs without
`row_kind` rows continue to flow through the device pipeline
unchanged — no behavioural change for non-Sprint-88L sources.

| Header | Aliases | Required for | Notes |
|---|---|---|---|
| `row_kind` | `record_kind`, `record` | parameter / binding rows | absent / empty → legacy device-row pipeline |
| `parameter_id` | `param_id` | parameter, setpoint_binding | stable id for the machine `Parameter` |
| `data_type` | `dtype`, `datatype` | parameter | `int` / `dint` / `real` only |
| `default` | `default_value` | parameter | finite number; never inferred |
| `unit` | `units`, `eu` | optional | documentation only — no scaling |
| `tag` | `equipment_id` | setpoint_binding | matches an equipment candidate id (raw tag) |
| `role` | `io_role` | setpoint_binding | `speed_setpoint_out` (Sprint 88L only) |
| `label` | — | optional | flows into `Parameter.name` when set |
| `comment` | — | optional | flows into `Parameter.description` when set |

### End-to-end example

CSV (parameter + binding rows; equipment + IO authored elsewhere
or via the existing 1:1 device-row pattern):

```csv
row_kind,tag,kind,address,direction,data_type,role,parameter_id,default,unit,label
parameter,,,,,real,,p_m01_speed,50,Hz,M01 speed setpoint
setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,
```

After review (accept-all) the resulting PIR satisfies R-EQ-05:

```jsonc
{
  "machines": [{
    "parameters": [
      { "id": "p_p_m01_speed", "data_type": "real", "default": 50, "unit": "Hz", "name": "M01 speed setpoint" }
    ],
    "stations": [{
      "equipment": [{
        "id": "eq_mot01",
        "type": "motor_vfd_simple",
        "io_bindings": { "run_out": "io_io_m01_run", "speed_setpoint_out": "io_io_m01_speed_aw" },
        "io_setpoint_bindings": { "speed_setpoint_out": "p_p_m01_speed" }
      }]
    }]
  }]
}
```

(The `p_` / `io_` / `eq_` prefixes come from
`canonicalisePirId`'s namespace prefixing — unchanged from prior
sprints.)

## Diagnostics

Closed-union additions. All deterministic, per-row, never
spamming.

| Code | Severity | Source | When it fires |
|---|---|---|---|
| `CSV_PARAMETER_EXTRACTED` | info | csv.ts | a parameter row landed cleanly in the draft |
| `CSV_PARAMETER_DUPLICATE_ID` | warning | csv.ts | second row with the same `parameter_id`; dropped (first wins) |
| `CSV_PARAMETER_METADATA_INCOMPLETE` | error | csv.ts | missing `parameter_id` or `default` |
| `CSV_PARAMETER_METADATA_NOT_NUMERIC` | error | csv.ts | `data_type` is `bool` / unrecognised |
| `CSV_SETPOINT_BINDING_TARGET_MISSING` | error | csv.ts / pir-candidate.ts | binding's `tag` is empty, or its target equipment id is not in the candidate equipment list |
| `CSV_SETPOINT_BINDING_PARAMETER_MISSING` | error | csv.ts | binding has no `parameter_id` |
| `CSV_SETPOINT_BINDING_ROLE_UNSUPPORTED` | error | csv.ts | role is empty or not in `{speed_setpoint_out}` |
| `PIR_BUILD_PARAMETER_CANDIDATE_PENDING` | error | pir-builder.ts | parameter decision is `'pending'` at build time |
| `PIR_BUILD_ACCEPTED_PARAMETER_INVALID` | error | pir-builder.ts | accepted parameter fails the builder's shape checks (e.g. mutated to `bool` after CSV) |
| `PIR_BUILD_SETPOINT_BINDING_REFERENCES_MISSING_PARAMETER` | error | pir-builder.ts | accepted equipment binds a role to a parameter id that's not in the candidate parameters list |
| `PIR_BUILD_SETPOINT_BINDING_REFERENCES_UNACCEPTED_PARAMETER` | error | pir-builder.ts | binding references a parameter that was rejected or that failed to build |

## What does NOT happen (explicit non-goals)

- **No parameter synthesis.** Every parameter requires explicit
  `data_type` + `default`. Free-text comments like `Conveyor
  motor: nominal 50 Hz` never become parameters.
- **No role guessing.** Bindings only attach when the operator
  declares `(equipment_id, role, parameter_id)` explicitly.
- **No unit scaling.** `unit` is documentation; the operator
  commissions the parameter in the unit the drive expects.
- **No safety semantics.** No fault latching, no e-stop, no
  permissive logic, no ramps, no reset, no fwd/rev, no jog. The
  equipment's `fault` field stays exposed but undriven.
- **No EPLAN / TcECAD parameter extraction.** Both ingestors
  remain a safe no-op for parameters: when the source carries no
  explicit `Parameter` / `Setpoint` metadata, the
  `parameterDraft` sidecar is simply absent. A future sprint
  adds structured-attribute parsing if real fixtures expose it.
- **No PDF / OCR / layout work.**
- **No web UI redesign.** The `parameterCandidates` review bag
  is plumbed through `ElectricalReviewState` so a generic review
  panel can render parameter rows the same way IO rows render;
  the existing UI components are not redesigned in this sprint.
- **No production codegen change.** Sprint 88G–88K already
  shipped the codegen surface; 88L is purely an ingestion +
  builder change.

## Files touched

### `@plccopilot/electrical-ingest`
- [`src/types.ts`](../packages/electrical-ingest/src/types.ts) — `PirParameterCandidate` interface; `motor_vfd_simple` joins `PirEquipmentCandidate.kind`; optional `ioSetpointBindings` on `PirEquipmentCandidate`; optional `parameters[]` on `PirDraftCandidate`; `ElectricalParameterDraft` sidecar on `ElectricalGraph.metadata`; closed-union additions to `ElectricalDiagnosticCode`.
- [`src/diagnostics.ts`](../packages/electrical-ingest/src/diagnostics.ts) — severity for the new codes (info / warning / error).
- [`src/index.ts`](../packages/electrical-ingest/src/index.ts) — public re-exports for `ElectricalParameterDraft` + `PirParameterCandidate`.
- [`src/sources/csv.ts`](../packages/electrical-ingest/src/sources/csv.ts) — new canonical headers + aliases; row-kind dispatch; `extractParameterRow` + `extractSetpointBindingRow`; sidecar attachment on the graph metadata.
- [`src/mapping/kind-aliases.ts`](../packages/electrical-ingest/src/mapping/kind-aliases.ts) — `motor_vfd_simple` / `vfd` map to the existing `motor` graph node kind.
- [`src/mapping/io-role-inference.ts`](../packages/electrical-ingest/src/mapping/io-role-inference.ts) — `inferEquipmentRole` reads `node.attributes.raw_kind` to pick `motor_vfd_simple` candidate kind when the source declares it.
- [`src/mapping/pir-candidate.ts`](../packages/electrical-ingest/src/mapping/pir-candidate.ts) — `applyParameterDraft` Pass 3 reads the sidecar onto the candidate.
- [`src/mapping/pir-builder.ts`](../packages/electrical-ingest/src/mapping/pir-builder.ts) — `motor_vfd_simple` joins `mapCandidateEquipmentKind`; new `PirBuildDiagnosticCode` entries; parameter-pending gate; `buildParameter` helper; `buildEquipment` accepts a `paramCtx` and wires `io_setpoint_bindings` (refusing the equipment when bindings are unmet); accepted parameters land in `machine.parameters[]`; `hasReviewableCandidates` and `isReviewedCandidateReadyForPirBuild` know about parameters.
- [`src/mapping/review-types.ts`](../packages/electrical-ingest/src/mapping/review-types.ts) — `parameterCandidates?` bag + `getReviewedDecision` extension for `'parameter'`.
- [`tests/parameter-extraction-motor-vfd-simple.spec.ts`](../packages/electrical-ingest/tests/parameter-extraction-motor-vfd-simple.spec.ts) — new spec, 16 tests pinning the contract.

### `@plccopilot/web`
- [`src/utils/review-state.ts`](../packages/web/src/utils/review-state.ts) — `parameterCandidates?` bag; `'parameter'` joins `ReviewItemType`; `createInitialReviewState` seeds the bag when the candidate has parameters; `setReviewDecision` / `getReviewDecision` handle the new bag; `summarizeReviewState` and `hasReviewableItems` count parameters.

### Docs
- [`docs/electrical-ingest-parameter-extraction-sprint-88L.md`](electrical-ingest-parameter-extraction-sprint-88L.md) — this file.
- [`docs/electrical-ingestion-architecture.md`](electrical-ingestion-architecture.md) — Sprint 88L status entry.

## Tests before → after

| Package | Before | After | Δ |
|---|---:|---:|---:|
| `@plccopilot/electrical-ingest` | 672 | 688 | +16 |
| **Repo total** | **3,568** | **3,584** | **+16** |

PIR (44), codegen-core (771), CODESYS (63), Siemens (184), Rockwell (78), codegen-integration-tests (165), CLI (757), web (834) all unchanged.

## Manual verification checklist

- [ ] CSV with explicit `row_kind=parameter` + `row_kind=setpoint_binding` rows ingests cleanly; `result.graph.metadata.parameterDraft` carries the parameter and the binding map.
- [ ] `buildPirDraftCandidate(graph)` produces a candidate with `parameters[]` populated and the matching equipment's `ioSetpointBindings` set.
- [ ] Accept-all review of that candidate produces a PIR with `machine.parameters[0]` and `equipment[0].io_setpoint_bindings.speed_setpoint_out` referencing the accepted parameter id.
- [ ] PIR validation passes (no R-EQ-05 issues).
- [ ] Drop the parameter row → `PIR_BUILD_SETPOINT_BINDING_REFERENCES_MISSING_PARAMETER` fires; the equipment is dropped from the build.
- [ ] Reject the parameter at review → `PIR_BUILD_SETPOINT_BINDING_REFERENCES_UNACCEPTED_PARAMETER`; the equipment is dropped.
- [ ] `data_type=bool` parameter row → `CSV_PARAMETER_METADATA_NOT_NUMERIC`; no parameter created.
- [ ] Setpoint binding with a role outside the supported set → `CSV_SETPOINT_BINDING_ROLE_UNSUPPORTED`; no binding created.
- [ ] Free-text comments mentioning numbers do NOT yield parameters.
- [ ] Legacy CSV (no `row_kind` rows) — no `parameterDraft` sidecar attached; behaviour identical to pre-Sprint-88L.

## Honest constraints

- **Operator-authored CSV only in v0.** EPLAN / TcECAD ingestors remain no-ops for parameter metadata until a real fixture exposes structured `Parameter` attributes.
- **CSV is 1:1 device/IO.** The existing CSV format gives one device + one IO per row. For `motor_vfd_simple` (2 outputs) the operator declares two device rows and the equipment gets two `device:*` candidate ids. Sprint 88L does not change that — it only adds the parameter + binding rows alongside.
- **Binding key match is by raw tag.** The binding's `tag` cell must equal the candidate equipment id (or its `eq_device:` / `eq_` prefix-stripped form). Renames between source and review are not auto-resolved; the binding fires `CSV_SETPOINT_BINDING_TARGET_MISSING`.
- **No backward-incompatible JSON change.** `parameters` and `parameterCandidates` are optional on the candidate / review state; existing snapshots round-trip.
- **No production codegen change.** Sprint 88L exclusively touches ingestion + builder + review-state. Vendor capability tables, lowering, and renderers are unchanged.
- **pdfjs Windows shutdown flake** in `electrical-ingest` (documented since Sprint 84) may surface during `pnpm -r test`. Per-package isolated re-runs are clean. Sprint 88L did not introduce a new failure mode.

## Recommended next sprints

- **Sprint 88M** — extend parameter extraction to EPLAN / TcECAD when a real fixture exposes structured `Parameter` / `Setpoint` attributes. Same operator-authored-explicit constraint applies; no inference from descriptions.
- **Sprint 89** — controlled codegen preview UX (web). The `motor_vfd_simple` story is now end-to-end (ingest → review → PIR → codegen on every vendor), so an explicit per-target preview is the natural next operator surface.
- **Pause-and-listen** — route effort to whichever direction operator feedback exposes (more equipment kinds, recipe→parameter UX, parameter range/unit cross-validation, etc.).
