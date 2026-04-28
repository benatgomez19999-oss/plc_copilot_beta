# Electrical review workflow — Sprint 75 v0

> **Status: review UI v0 in `@plccopilot/web` (Sprint 75).** Helpers,
> components, fixtures, and 59 new tests. No persistence, no auth,
> no final PIR generation, no codegen changes. The review UI is the
> human-in-the-loop boundary the architecture has always required;
> Sprint 75 makes it load-bearing in code rather than only in
> design docs.

## Why review exists

PLC Copilot's architectural invariant (since Sprint 72):

> A weak prompt must never be able to override hard, source-traceable
> electrical evidence.

Ingestion (CSV in Sprint 73, EPLAN structured XML in Sprint 74)
produces a `PirDraftCandidate`: IO + equipment + assumptions +
diagnostics, every fact carrying a `SourceRef`. The mapper
(`buildPirDraftCandidate`) deliberately emits **draft** candidates,
not final PIR — anything below the equipment-promotion threshold
(confidence < 0.6) lands in `assumptions`, accompanied by a
diagnostic.

The review workflow is the deterministic gate between "the
ingestor extracted these facts from your sources" and "promote
these facts to PIR for codegen". Sprint 75 builds the v0 of that
gate inside the existing web app.

## Decision states

Three states per item (IO / equipment / assumption):

| State | Meaning | Source |
| --- | --- | --- |
| `pending` | The default. The ingestor produced the candidate; no human has reviewed it yet. | Initial state for every item |
| `accepted` | A human has explicitly approved the candidate. Sprint 76's PIR builder may consume it. | Operator click in the review UI |
| `rejected` | A human has explicitly rejected the candidate. Sprint 76 must NOT consume it. | Operator click in the review UI |

**Architectural invariant**: an assumption never starts as `accepted`.
`createInitialReviewState` enforces this; the test suite pins it.

## Confidence thresholds

`classifyConfidence(score)` produces one of four levels with stable
thresholds:

| Score | Level | UX |
| --- | --- | --- |
| `>= 0.8` | `high` | green badge, "High (NN%)" |
| `>= 0.6` | `medium` | amber badge, "Medium (NN%)" — review recommended |
| `< 0.6` | `low` | red badge, "Low (NN%)" — review required before promotion |
| non-numeric / NaN | `unknown` | grey badge, "Unknown" |

The 0.6 boundary aligns with the Sprint 72 mapper's
`minEquipmentConfidence`: anything below it has already been
demoted to an assumption by the time it reaches the UI.

The badge always renders **both colour AND text** so the panel
remains accessible when colour cues fail (colourblind users,
high-contrast modes, screen readers).

## Source-ref drilldown

Every candidate row exposes a "Show N sources" toggle.
`SourceRefPanel` groups refs by `kind` in deterministic order:

```
eplan → eplan-export → csv → xml → pdf → manual → unknown
```

For each ref, the panel renders:

| Field | Source |
| --- | --- |
| Source id | `ref.sourceId` |
| Source kind | `ref.kind` |
| File | `ref.path` (omitted if absent) |
| Line | `ref.line` (omitted if absent) |
| Column | `ref.column` (omitted if absent) |
| Sheet / Page | `ref.sheet` / `ref.page` |
| Raw id | `ref.rawId` |
| **XML locator** | `ref.symbol` — labelled "XML locator" only when `kind === 'eplan' / 'eplan-export'` |
| Symbol | `ref.symbol` — labelled "Symbol" for any other kind |

Missing optional fields are silently omitted — never rendered as
"undefined" / "null". An item with **zero** source refs renders
the explicit warning: *"No source evidence. Review whether the
candidate should exist at all."*

## Diagnostics panel

`ElectricalDiagnosticsList` filters by severity (`error` /
`warning` / `info` / all) via filter chips. Each diagnostic shows:

- severity badge
- `code` (e.g. `CSV_DUPLICATE_ADDRESS`, `EPLAN_XML_INVALID_ADDRESS`)
- `message`
- `hint` (when provided)
- `nodeId` / `edgeId` (when applicable)
- `sourceRef` summary (kind · path · line · symbol)

This is a parallel component to the existing `DiagnosticsPanel.tsx`
(which targets `ArtifactDiagnostic` from codegen). The two share
visual idioms but have different data shapes and stay decoupled.

## "Ready for PIR builder" signal

`isReadyForPirBuilder(candidate, state)` returns `true` only when:

- every IO + equipment + assumption is either `accepted` or `rejected`
  (no `pending`), AND
- no `error`-severity diagnostic remains in the candidate.

Sprint 75 renders the result. **Sprint 76's PIR builder
(`buildPirFromReviewedCandidate` in `@plccopilot/electrical-ingest`)
consumes the same gate as a hard refusal**: it returns
`pir: undefined` plus structured diagnostics whenever the predicate
is false. The web `isReadyForPirBuilder` and the domain-layer
`isReviewedCandidateReadyForPirBuild` agree on semantics; they
share the same review-state shape (`PirBuildReviewState` is
structurally identical to `ElectricalReviewState`).

## Sprint 76 — review → PIR boundary

The builder is the deterministic, accepted-only conversion from
`PirDraftCandidate` to `@plccopilot/pir` `Project`:

| Decision | IO | Equipment | Assumption |
| --- | --- | --- | --- |
| `'accepted'` | mapped to `IoSignal` | mapped to `Equipment` | recorded in `sourceMap` only — never auto-promoted |
| `'rejected'` | excluded (counted) | excluded (counted) | excluded (counted) |
| `'pending'` | gate failure | gate failure | gate failure |

What the builder preserves:
- Every IO + equipment carries a `provenance: { source: 'import' }`
  on the PIR side.
- A `sourceMap` sidecar (keyed by the canonical PIR id like
  `io_b1` or `eq_y1`) carries the original `SourceRef[]` —
  including the EPLAN XML locator from Sprint 74.

What the builder refuses:
- Pending items.
- Candidate-level error diagnostics.
- Accepted IO with no address / unknown direction / unmappable
  address.
- Equipment bindings pointing at non-accepted IO.
- Equipment with more bindings than the chosen PIR `EquipmentType`
  shape supports.
- Accepted equipment with kind `'unknown'` (no safe PIR mapping).
- Empty accepted input (nothing to build from).

Full reference: [`docs/pir-builder-v0.md`](pir-builder-v0.md).

## Why this is NOT final PIR generation

| Sprint | Boundary |
| --- | --- |
| 72 | Architecture + canonical types + EPLAN unsupported stub |
| 73 | CSV ingestor — produces `ElectricalGraph` |
| 74 | EPLAN structured XML ingestor v0 — produces `ElectricalGraph` |
| **75** (this sprint) | Review UI — humans gate `PirDraftCandidate` items |
| 76 | PIR builder — consumes accepted items only, emits valid PIR |
| 77+ | Codegen integration with reviewed PIR |

The Sprint 75 UI **must not invent**, **must not auto-accept**, and
**must not bypass diagnostics**. If those constraints feel
restrictive — they're load-bearing for industrial trust.

## How Sprint 75 prepares Sprint 76

- `setReviewDecision(state, type, id, decision, note?)` is the only
  way state changes — pure, immutable, deterministic. Sprint 76 can
  consume the same shape without reverse-engineering UI behaviour.
- `summarizeReviewState(candidate, state)` produces `ReviewSummary`
  with `accepted` / `rejected` / `pending` / `blockingDiagnostics`
  / `warnings` / `lowConfidencePending`. Sprint 76 uses these
  counts as input to the gate.
- `isReadyForPirBuilder(candidate, state)` is the single gate
  predicate. Sprint 76 can extend it (e.g. add "no rejected items
  with downstream dependencies" semantics) without touching the UI.

## File layout (web)

```
packages/web/
├── src/
│   ├── utils/
│   │   ├── review-state.ts       ← createInitialReviewState / setReviewDecision / summarizeReviewState
│   │   ├── review-confidence.ts  ← classifyConfidence + thresholds
│   │   ├── review-source-refs.ts ← summarizeSourceRef / groupSourceRefsByKind
│   │   └── review-fixtures.ts    ← SAMPLE_REVIEW_CANDIDATE / EMPTY_REVIEW_CANDIDATE
│   └── components/electrical-review/
│       ├── ConfidenceBadge.tsx
│       ├── SourceRefPanel.tsx
│       ├── ReviewDecisionControls.tsx
│       ├── IoCandidateReviewTable.tsx
│       ├── EquipmentCandidateReviewTable.tsx
│       ├── AssumptionsPanel.tsx
│       ├── ElectricalDiagnosticsList.tsx
│       ├── ElectricalReviewPanel.tsx       ← top-level composition
│       └── index.ts                         ← barrel
└── tests/
    ├── review-state.spec.ts        (27 tests)
    ├── review-confidence.spec.ts   (11 tests)
    ├── review-source-refs.spec.ts  (12 tests)
    └── review-fixtures.spec.ts      (9 tests)
```

The web package's vitest config runs in `node` environment (no
DOM); the Sprint 75 tests target the **pure helpers**. React
components are kept as thin presentational shells — typecheck +
the dev server are the verification surface for them. This matches
the existing pattern across the web package (e.g.
`utils/diagnostics.ts` is exhaustively tested; `DiagnosticsPanel.tsx`
is verified by typecheck + manual dev review).

## Industrial language discipline

The UI uses honest terms:

- **"Candidate"** — never "verified", never "official", never
  "confirmed".
- **"Assumption"** — never "inference", never "AI suggestion",
  never "auto-detected".
- **"Source evidence"** — never "metadata", never "extra info".
- **"Review required"** vs **"Ready for PIR builder"** — the only
  two state labels used in the summary header.

A future sprint that calls something "verified" without backing it
with `SourceRef` + accepted decision violates the architecture.
