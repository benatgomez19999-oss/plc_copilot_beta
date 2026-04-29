# Sprint 86 — Codegen readiness diagnostics v0

> **Status: target-aware preflight on top of the Sprint 76+
> codegen pipeline.** Sprints 79 → 84.1B finished the PDF
> ingestion arc. Sprint 85 hardened the reviewed → PIR handoff
> with root-cause diagnostics. Sprint 86 closes the loop by
> hardening the **PIR → codegen** handoff: a small pure
> `preflightProject` helper walks the PIR before
> `compileProject` runs, surfaces every readiness issue at
> once, and (when blocking errors are found) throws a single
> `READINESS_FAILED` `CodegenError` with the rolled-up list
> attached. Volume / UX hardening only — no new generated
> code, no automatic fixes, no schema bump on existing
> generators.

## What codegen readiness is

A pure walker over a `Project` from `@plccopilot/pir`. It
collects `Diagnostic` entries (the existing codegen-core type)
keyed by a small set of new `READINESS_*` codes:

- `READINESS_PIR_EMPTY` — null project / no machines.
- `READINESS_NO_GENERATABLE_OBJECTS` — machine has no IO,
  station has no equipment, etc.
- `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` — equipment
  type outside the target's capability set.
- `READINESS_UNSUPPORTED_IO_DATA_TYPE` — IO data type outside
  the target's set.
- `READINESS_UNSUPPORTED_IO_MEMORY_AREA` — IO memory area
  outside the target's set.
- `READINESS_DUPLICATE_EQUIPMENT_ID` — same equipment id
  appears twice in a machine.
- `READINESS_DUPLICATE_IO_ID` — same IO id appears twice in
  a machine.
- `READINESS_DUPLICATE_IO_ADDRESS` — two IO at the same
  `memory_area+byte+bit`.
- `READINESS_DUPLICATE_GENERATED_SYMBOL` — two distinct
  equipment ids that render to the same `code_symbol`.
- `READINESS_PLACEHOLDER_SEQUENCE` — Sprint 76 stub sequence
  (`init → terminal`) detected; codegen will produce a no-op
  state machine.

The walker is target-aware: each codegen target carries a
`TargetCapabilities` record (supported equipment kinds, IO
data types, IO memory areas). `core` is the vendor-neutral
default and matches `compileProject`'s built-in scope check.
`siemens` / `codesys` / `rockwell` start with the same set
today; future sprints may narrow them per target without
touching the readiness machinery.

The walker is **purely additive**: it never mutates the
project, never invents data, never picks a winner on
duplicates, never relaxes the existing `compileProject`
checks. When invoked stand-alone (via `preflightProject`) it
returns a `PreflightResult` with `diagnostics` sorted via the
existing `sortDiagnostics`. When invoked via
`runTargetPreflight` (the helper each target façade now
calls), it throws a single `CodegenError('READINESS_FAILED',
…)` if any error severity diagnostic was found — the rolled
up list is attached as `cause`.

## What it does not do

- **No new equipment support.** The capability tables mirror
  `compileProject`'s existing `SUPPORTED_TYPES` set.
- **No automatic codegen from web.** The web flow already
  refuses to call `generate` without an explicit operator
  action; Sprint 86 doesn't change that.
- **No automatic fixing.** Duplicates are flagged, never
  merged or renamed. Unsupported types are flagged, never
  remapped. Placeholder sequences are flagged, never replaced.
- **No target certification.** The capability tables are the
  *current* set the generators actually emit safely. A target
  that adds a kind in Sprint 87 widens its table; that does
  not promise certification or vendor support.
- **No safety logic generation.** Sprint 86 is purely
  diagnostic; the existing safety review path is unchanged.
- **No PDF, OCR, layout, symbol, wire, or canvas changes.**
  The PDF arc stays paused.
- **No schema bump.** `Project`, `Equipment`, `IoSignal`,
  `Sequence`, `MemoryArea`, `SignalDataType`, `EquipmentType`
  are unchanged.

## Target behavior

Each target façade (`generateSiemensProject`,
`generateCodesysProject`, `generateRockwellProject`) now
calls `runTargetPreflight(project, '<target>')` at the very
start of the entry function:

- If preflight is clean → control falls through to
  `compileProject` exactly as before. Non-blocking warnings /
  info diagnostics are NOT auto-injected into the manifest in
  v0; the operator can call `preflightProject` directly to
  read them.
- If preflight has any error severity diagnostic →
  `READINESS_FAILED` is thrown. The error's `path` /
  `stationId` / `symbol` / `hint` come from the first
  blocking diagnostic; the full sorted list is attached as
  `cause: { diagnostics, target }` for tools that want to
  surface it.

The rolled-up message is **single-line** so the existing
`formatSerializedCompilerError` / `CompileClientError`
formatters continue to work without changes.

## Diagnostic severity meaning

Sprint 86 follows the existing `Diagnostic` severity union:

- `error` — blocking. The target's `runTargetPreflight` will
  throw `READINESS_FAILED`; no artifacts are emitted.
- `warning` — non-blocking. Currently emitted for
  duplicate-id and duplicate-symbol cases. The build proceeds;
  the operator should review the duplicates before consuming
  the artifacts.
- `info` — non-blocking. Currently emitted for
  no-generatable-objects and placeholder-sequence cases. The
  build proceeds; the diagnostic is informational only.

## Examples of blocking vs non-blocking diagnostics

**Blocking** (throws `READINESS_FAILED`):

- A station carries `equipment.type === 'valve_onoff'` and
  the target only supports the core set →
  `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
- A machine has zero machines (technically caught earlier by
  `compileProject`'s `NO_MACHINE`, but the readiness pass
  surfaces it first with a richer hint) →
  `READINESS_PIR_EMPTY`.
- An IO uses `data_type: 'string'` against a target that
  doesn't list it → `READINESS_UNSUPPORTED_IO_DATA_TYPE`.

**Non-blocking** (proceeds to `compileProject`):

- Two distinct equipment ids share the same `code_symbol` →
  `READINESS_DUPLICATE_GENERATED_SYMBOL` (warning). Build
  continues; codegen will collide and the existing tag-table
  emit-time error will catch it.
- A station has zero equipment →
  `READINESS_NO_GENERATABLE_OBJECTS` (info). Build emits an
  empty station FB.
- A station's sequence is the `init → terminal` placeholder →
  `READINESS_PLACEHOLDER_SEQUENCE` (info). Build emits a
  no-op state machine.

## How this relates to Sprint 85

Sprint 85 added a hardening layer between **reviewed
candidate** and the **PIR builder** in
`@plccopilot/electrical-ingest`. It surfaces root-cause
diagnostics for the IO ↔ equipment graph (missing /
unaccepted / unbuildable refs, duplicate addresses, orphans,
…) before the per-item PIR build emits its cascade.

Sprint 86 is the symmetric layer on the OTHER side of PIR:
between **a built PIR project** and the **codegen targets**.
It surfaces root-cause diagnostics for the PIR ↔ codegen
handoff (unsupported equipment for target, duplicate symbols,
placeholder sequences, …) before the per-target compile
emits its first throw.

The two sprints share architectural shape:
- pure helper module (`electrical-graph-hardening.ts` /
  `codegen-readiness.ts`),
- new diagnostic codes appended to the existing union,
- wiring at the entry point of the next pipeline stage,
- non-blocking warnings/info; blocking errors throw a single
  rolled-up wrapper.

## Honest constraints (Sprint 86)

- **No automatic codegen from web.** The web flow keeps the
  explicit-action gate.
- **No PIR mutation.** The walker is read-only.
- **No assumption promotion.** Sprint 76's assumption path is
  unchanged.
- **No address synthesis.** `IoAddress` invariants are
  unchanged; readiness only surfaces issues, never fixes
  them.
- **No equipment role guessing.** Unsupported kinds are
  flagged; no inference.
- **No schema bump.** Capability tables are TypeScript
  constants in `codegen-core/src/readiness/`.
- **No new ingestor or generator capabilities.** Sprint 86
  adds *diagnostics*, not features.
- **No web UI changes.** The existing diagnostic display
  consumes the new codes via the same severity-based path.
- **`.ts`/`.js` source mirrors.** The codegen packages keep
  source-tree `.js` artifacts alongside `.ts` for vite/vitest
  consumers; Sprint 86 mirrors every readiness change in both
  files. Future sprints should keep this invariant.

## Manual verification checklist (operator-side)

The AI cannot run the web app or invoke the CLI in production.
The operator should run:

1. **CSV simple valid input still generates.** Open a
   review session, accept all candidates, build the PIR, and
   download the Siemens bundle. Manifest should contain
   `compiler_diagnostics`; **no** `READINESS_FAILED` should
   appear.
2. **TcECAD XML refusal honest.** Open a TcECAD-shaped review
   session where addresses are non-Siemens. Build PIR refuses
   honestly via Sprint 85's existing path; codegen never
   runs.
3. **PDF TcECAD manual fixture refusal honest.** Same as
   Sprint 85 manual checklist — no `plc_channel:%I1` /
   `%I3` candidates; build PIR remains blocked.
4. **Unsupported-target equipment.** Modify a fixture to use
   `equipment.type = 'valve_onoff'` and invoke `pnpm cli
   generate --backend siemens`. Expected: exit 1 with
   `[READINESS_FAILED] … READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET …`
   in stderr. Path / station / symbol / hint preserved.
5. **Duplicate-symbol fixture.** Create two equipment with
   distinct ids but identical `code_symbol`. Invoke any
   target. Expected: build proceeds; the manifest carries the
   `READINESS_DUPLICATE_GENERATED_SYMBOL` warning.
6. **Web does NOT auto-codegen.** Confirm the web flow still
   requires an explicit "Generate" action.
7. **Export bundle / sourceMap unaffected.** The
   `electrical-review-session-snapshot` shape is unchanged.

## Files touched

- `packages/codegen-core/src/readiness/codegen-readiness.ts`
  + `.js` mirror (NEW).
- `packages/codegen-core/src/readiness/run-preflight.ts`
  + `.js` mirror (NEW).
- `packages/codegen-core/src/index.ts` + `.js` mirror —
  barrel exports.
- `packages/codegen-core/src/types.ts` + `.js` mirror —
  `READINESS_FAILED` added to `CODEGEN_ERROR_CODES`.
- `packages/codegen-core/src/compiler/diagnostics.ts` —
  `READINESS_*` codes added to `DiagnosticCode`.
- `packages/codegen-siemens/src/generators/project.ts`
  + `.js` mirror — preflight wiring.
- `packages/codegen-codesys/src/generators/codesys-project.ts`
  + `.js` mirror — preflight wiring.
- `packages/codegen-rockwell/src/generators/rockwell-project.ts`
  + `.js` mirror — preflight wiring.
- `packages/codegen-core/tests/codegen-readiness.spec.ts`
  (NEW, 14 tests).
- `packages/cli/tests/generate.spec.ts` — updated
  unsupported-equipment test to expect `[READINESS_FAILED]`
  with the same metadata content.
- `packages/web/tests/worker-client.spec.ts` — updated three
  unsupported-equipment tests to expect `READINESS_FAILED`
  with the same metadata content.
- `docs/codegen-readiness-sprint-86.md` (NEW).
- `docs/electrical-ingestion-architecture.md` — refreshed
  status.

## Recommended next sprint

Three options ranked by evidence-to-effort:

1. **Sprint 87A — expand supported equipment kinds in one
   target.** Pick the highest-priority unsupported kind
   reported by an operator and implement the dispatch
   (`compileProject` `SUPPORTED_TYPES`, lowering switch,
   activity table). Real new value, narrow surface.
2. **Sprint 87B — review UX for codegen readiness
   diagnostics in the web app.** Surface the readiness
   diagnostics in the existing diagnostics panel before the
   operator hits "Generate" so they fix issues earlier.
3. **Sprint 87C — cross-source duplicate detection.**
   Currently dedup is per-source. Multi-source review
   sessions (CSV + EPLAN) need a merger pass. Worth doing
   only if operators report this case.

Default to 87A unless operator feedback says otherwise. 87D
(controlled codegen preview) stays deferred until readiness
has been load-bearing for at least one real engagement.
