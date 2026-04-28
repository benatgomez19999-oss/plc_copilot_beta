# Electrical-plan ingestion architecture

> **Status: scaffold (Sprint 72).** Architecture, types, helpers, and
> an honest unsupported-EPLAN stub are in place. No real EPLAN
> parser, no PDF/OCR, no final PIR builder. Subsequent sprints will
> layer concrete ingestors on top.

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

## Source ingestion (Sprint 72: stub only)

`EplanIngestor` is the single interface every concrete source
implements:

```ts
interface EplanIngestor {
  canIngest(input: EplanIngestionInput): boolean;
  ingest(input: EplanIngestionInput): Promise<EplanIngestionResult>;
}
```

`createUnsupportedEplanIngestor()` returns a stub that:

- Reports `canIngest === true` for known file kinds (`xml` / `edz` /
  `pdf` / `csv` / `unknown`).
- Reports `canIngest === false` for empty / malformed input.
- On `ingest`, returns an empty graph + an `UNSUPPORTED_SOURCE_FEATURE`
  diagnostic (one global, plus one per file at info severity, with
  the file path attached as a SourceRef).
- **Never throws.** Architecture invariant: stubs surface their
  limitations as diagnostics, they do not fail.

The `SourceRegistry` accepts ingestors and dispatches based on
`canIngest`. Future sprints register CSV / structured-XML / real
EPLAN ingestors *in front of* the unsupported stub; the stub stays
as the catch-all.

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
| **72** (this sprint) | Architecture + canonical model + helpers + unsupported EPLAN stub + tests + this doc. |
| 73 | First structured-source parser: CSV terminal/device list → ElectricalGraph. |
| 74 | EPLAN structured-export parser (XML — likely `Project.xml` / `EplanProject.xml` from a `.elt` /  `.epdz` archive). |
| 75 | Review UI: confidence panel, source-ref drilldown, accept/reject assumptions. |
| 76 | PIR draft → PIR builder; integrate with the existing codegen pipeline. |
| later | EDZ macro extraction (vendor symbol library), PDF fallback (only as last resort, OCR clearly flagged), Siemens TIA hardware-config import as an alternative source. |

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

Sprint 72 adds 81 new tests (graph + confidence + diagnostics +
sources + trace + pir-candidate). Existing codegen tests are
unchanged.
