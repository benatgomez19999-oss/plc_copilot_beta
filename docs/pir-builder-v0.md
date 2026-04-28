# PIR builder v0 — Sprint 76

> **Status: live in `@plccopilot/electrical-ingest` (Sprint 76).**
> The deterministic bridge between a human-reviewed
> `PirDraftCandidate` and a valid `@plccopilot/pir` `Project`.
> Hard gate on pending items + error diagnostics. Accepted-only
> filtering. Source refs preserved via the `sourceMap` sidecar.
> Built PIR validates against `@plccopilot/pir`'s validator. No
> codegen changes; no PLC artefacts produced. 67 new tests.

## Why the builder lives in the domain layer

Sprint 75 built a Review UI in `@plccopilot/web` whose state model
was structurally compatible with what a PIR builder needs.
Sprint 76 deliberately puts the builder in
`@plccopilot/electrical-ingest` (the domain layer), not in web,
because:

- The CLI will need to call the builder eventually (no React).
- Tests live next to the candidate types.
- A circular dependency would result if the builder were in web
  and electrical-ingest needed to import it.

`packages/web` keeps its `isReadyForPirBuilder` helper for the UI's
own gate signalling. The domain-layer builder reads the same
review-state shape (`PirBuildReviewState`) defined in
`packages/electrical-ingest/src/mapping/review-types.ts` —
structurally identical, so web's state object is assignable
without conversion.

## API

```ts
import {
  buildPirFromReviewedCandidate,
  isReviewedCandidateReadyForPirBuild,
  type PirBuildOptions,
  type PirBuildResult,
  type PirBuildReviewState,
} from '@plccopilot/electrical-ingest';

const result: PirBuildResult = buildPirFromReviewedCandidate(
  candidate,
  reviewState,
  { /* PirBuildOptions */ },
);

if (!result.pir) {
  // Builder refused. Surface result.diagnostics to the operator.
  return;
}
// result.pir is a valid Project (already passed @plccopilot/pir's validator).
// result.sourceMap[<pirId>] contains the SourceRefs that backed each PIR object.
```

## Hard gate (in priority order)

1. **`candidate` or `reviewState` is null/non-object** → refuse with
   `PIR_BUILD_REVIEW_NOT_READY`.
2. **Any IO / equipment / assumption is `'pending'`** → refuse with
   one `PIR_BUILD_PENDING_REVIEW_ITEM` per item + a final
   `PIR_BUILD_REVIEW_NOT_READY`.
3. **Candidate carries any `error`-severity diagnostic** → refuse
   with one `PIR_BUILD_ERROR_DIAGNOSTIC_PRESENT` per item + a final
   `PIR_BUILD_REVIEW_NOT_READY`.
4. **No accepted IO + equipment** → refuse with
   `PIR_BUILD_EMPTY_ACCEPTED_INPUT`.

The gate predicate `isReviewedCandidateReadyForPirBuild(candidate,
state)` is exported separately for callers that want to display
"ready / not ready" without running the full builder.

## Accepted-only filtering

| Decision | IO | Equipment | Assumption |
| --- | --- | --- | --- |
| `'accepted'` | mapped to `IoSignal` | mapped to `Equipment` | recorded in `sourceMap` only — **never** auto-promoted to PIR equipment / IO |
| `'rejected'` | excluded; counted in `skippedInputCounts.rejected` | excluded; counted | excluded; counted |
| `'pending'` | gate failure | gate failure | gate failure |

`acceptedInputCounts.assumptions` includes accepted assumptions
even though none of them appear as PIR objects;
`skippedInputCounts.unsupportedAssumptions` mirrors that count.
`PIR_BUILD_UNSUPPORTED_ASSUMPTION` is emitted at `warning`
severity per accepted assumption — explicit, not silent.

## ID canonicalisation

PIR's `IdSchema` is `/^[a-z][a-z0-9_]{1,62}$/`. Candidate ids
contain `:`, `%`, uppercase letters, etc. The builder rewrites
deterministically:

| Candidate id | PIR id |
| --- | --- |
| `device:B1` | `b1` |
| `plc_channel:%I0.0` | `i0_0` |
| `io_plc_channel:%I0.0` (with `'io'` prefix) | `io_i0_0` |
| `io_plc_channel:%Q1.7` (with `'io'` prefix) | `io_q1_7` |
| `eq_device:Y1` (with `'eq'` prefix) | `eq_y1` |
| `assum_device:M9` (with `'assum'` prefix) | `assum_m9` |

Rules:
- Strip well-known scheme prefixes (`device:`, `plc_channel:`,
  `io_plc_channel:`, `eq_device:`, `assum_`, `io_`).
- Lowercase, replace non-`[a-z0-9_]` with `_`, collapse runs of
  `_`, prepend `x` if the first char is a digit, truncate to 63.
- Apply caller's prefix (`'io'`, `'eq'`, `'assum'`).

## Address parsing

`parseCandidateAddress(raw)` maps candidate-style strings into
PIR's `IoAddress`:

| Candidate | PIR | data_type | Notes |
| --- | --- | --- | --- |
| `%I0.0` | `{memory_area: 'I', byte: 0, bit: 0}` | `bool` | |
| `%Q1.7` | `{memory_area: 'Q', byte: 1, bit: 7}` | `bool` | |
| `%IX0.0` | `{memory_area: 'I', byte: 0, bit: 0}` | `bool` | Codesys → Siemens collapse |
| `%IB10` | `{memory_area: 'I', byte: 10}` | `int` | byte → int (PIR has no byte type) |
| `%IW10` | `{memory_area: 'I', byte: 10}` | `int` | |
| `%MD100` | `{memory_area: 'M', byte: 100}` | `real` | double-word |
| `%I0` | `{memory_area: 'I', byte: 0, bit: 0}` | `bool` | bare → bit 0 |
| `Local:1:I.Data[0].0` | `{memory_area: 'I', byte: 0, bit: 0}` | `bool` | slot preserved in `description` |

Anything that doesn't parse → `PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS`,
no PIR record produced for that IO. The builder NEVER invents a
default address.

## Equipment role remap

The Sprint 72 candidate mapper uses generic role names (`drive`,
`drive_1`, `feedback`, `feedback_1`, `io_0`). PIR's
`EQUIPMENT_SHAPES` defines specific role names per type. The
builder remaps:

| Candidate role | `motor_simple` | `valve_onoff` | `sensor_discrete` | `pneumatic_cylinder_2pos` |
| --- | --- | --- | --- | --- |
| `drive` | `run_out` | `solenoid_out` | — (no output) | `solenoid_out` |
| `feedback` | `running_fb` | `open_fb` | `signal_in` | `sensor_extended` |
| `feedback_1` | `fault_fb` | `closed_fb` | (extra → error) | `sensor_retracted` |

Roles already matching a PIR canonical name (operator hand-edited
candidate) pass through. Extras beyond the shape's slot count fail
with `PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID` — the builder never
silently truncates wired evidence.

## Placeholder sequence

PIR's `SequenceSchema` requires `states.min(2) +
transitions.min(1)`. Sprint 76 v0 emits a single placeholder:

```ts
{
  states: [
    { id: 's_init',     name: 'Init',     kind: 'initial' },
    { id: 's_terminal', name: 'Terminal', kind: 'terminal' },
  ],
  transitions: [
    { id: 't_init_to_terminal', from: 's_init', to: 's_terminal', priority: 1 },
  ],
}
```

The placeholder is announced via an info diagnostic
(`PIR_BUILD_PLACEHOLDER_SEQUENCE_USED`) so callers know the PIR
is structurally valid but doesn't yet carry real sequence logic.
Sprint 77+ may consume reviewed sequences from a separate source.

## SourceMap sidecar

PIR's `Provenance` doesn't carry full `SourceRef[]`. The builder
returns a sidecar `Record<string, SourceRef[]>` keyed by **PIR
id** (`io_b1`, `eq_y1`, `assum_m9`):

```ts
result.sourceMap['io_b1'] // → [ { kind: 'csv', path: 'list.csv', line: 2, ... } ]
result.sourceMap['eq_y1'] // → [ { kind: 'eplan', path: 'plan.xml', line: 18, symbol: '/EplanProject[1]/...', ... } ]
```

Every successful build emits an info diagnostic
`PIR_BUILD_SOURCE_REFS_SIDECAR_USED` so consumers know to read
the sidecar.

## Diagnostics (full list)

| Code | Severity | When |
| --- | --- | --- |
| `PIR_BUILD_REVIEW_NOT_READY` | error | gate failure (top-level) |
| `PIR_BUILD_PENDING_REVIEW_ITEM` | error | a candidate item is still pending |
| `PIR_BUILD_ERROR_DIAGNOSTIC_PRESENT` | error | candidate carries an error-severity diagnostic |
| `PIR_BUILD_MISSING_REVIEW_DECISION` | error | reserved (Sprint 76 ships gate-driven equivalent) |
| `PIR_BUILD_ACCEPTED_IO_MISSING_ADDRESS` | error | accepted IO has no address |
| `PIR_BUILD_ACCEPTED_IO_MISSING_DIRECTION` | error | direction is `'unknown'` / undefined |
| `PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS` | error | address can't map to PIR `IoAddress` |
| `PIR_BUILD_UNSUPPORTED_EQUIPMENT_KIND` | error | candidate kind has no PIR equivalent (`unknown`) |
| `PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID` | error | equipment binding refers to non-accepted IO, OR has more bindings than the PIR shape supports |
| `PIR_BUILD_UNSUPPORTED_ASSUMPTION` | warning | accepted assumption recorded in sourceMap, never auto-promoted |
| `PIR_BUILD_SCHEMA_VALIDATION_FAILED` | error / warning | mirror of `@plccopilot/pir`'s validator output |
| `PIR_BUILD_SOURCE_REFS_SIDECAR_USED` | info | one-off announcement on every success |
| `PIR_BUILD_PLACEHOLDER_SEQUENCE_USED` | info | one-off announcement on every success |
| `PIR_BUILD_EMPTY_ACCEPTED_INPUT` | error | nothing accepted to build |

## Validation hookup

After assembling the `Project`, the builder calls
`validate(project)` from `@plccopilot/pir`. Each `Issue` becomes a
`PIR_BUILD_SCHEMA_VALIDATION_FAILED` diagnostic with the
validator's `path` preserved. If any issue has `severity: 'error'`,
the builder discards `pir` and returns the diagnostics — the
caller never sees an invalid `Project`.

## What v0 explicitly does NOT do

- **No sequence inference** — placeholder only. Real sequence
  reviewing is a separate Sprint 77+ scope.
- **No alarm / interlock / parameter / recipe / safety_group
  generation** — empty arrays. PIR allows them; the builder never
  invents.
- **No naming-profile generation** — omitted.
- **No assumption-to-equipment promotion** — accepted assumptions
  stay in the `sourceMap` sidecar with a warning.
- **No address synthesis** — un-mappable addresses are hard errors.
- **No silent truncation of equipment bindings** — extras are hard
  errors.
- **No codegen** — Sprint 76 stops at PIR; codegen consumers run
  separately and unchanged.

## Operator workflow

```
CSV / EPLAN XML (Sprint 73 / 74)
  → ElectricalGraph
  → buildPirDraftCandidate (Sprint 72)
  → PirDraftCandidate
  → ElectricalReviewPanel (Sprint 75 — accept / reject per item)
  → ElectricalReviewState
  → buildPirFromReviewedCandidate (THIS sprint)
  → { pir, diagnostics, sourceMap }   ← validates against @plccopilot/pir
  → (downstream codegen, unchanged from earlier sprints)
```

The web app does not yet wire this end-to-end (Sprint 77 scope).
The builder is callable today from any consumer — CLI, tests,
future review-UI integration.
