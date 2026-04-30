# Sprint 88G — Implement `io_setpoint_bindings` + `motor_vfd_simple` core lowering

Status: closed locally (gates green; not pushed).
Sister sprints: 88E (audit, support deferred), 88F (design, Option A chosen),
88H (CODESYS audit + widening — pending), 88I (Siemens), 88J (Rockwell),
88K (cross-renderer parity bar), 88L (electrical-ingest parameter ingestion).

## Decision implemented

**Option A — Parameter→role binding** from Sprint 88F:

```ts
// New optional field on Equipment (PIR 0.1.0).
io_setpoint_bindings?: Record<string, Id>;   // role → parameter id
```

For `motor_vfd_simple`, this binds the required numeric output role
`speed_setpoint_out` to a numeric `Parameter` declared at machine
scope. The lowering writes the parameter symbol (already a global
in the symbol table thanks to the existing resolver) into the bound
IO every scan. **No literal value is ever synthesised; no fallback;
no dangling output.**

## Vendor capability tables — closed by design

`motor_vfd_simple` is **not** in any vendor target's
`supportedEquipmentTypes` after Sprint 88G:

| Target | `motor_vfd_simple` accepted? |
|---|---|
| `core` | ✅ (mirrors `compileProject`'s widened `SUPPORTED_TYPES`) |
| `codesys` | ❌ — `READINESS_FAILED` / `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` |
| `siemens` | ❌ — same |
| `rockwell` | ❌ — same |

The split lets codegen-core's own lowering tests exercise
`wireMotorVfdSimple` while every vendor façade keeps refusing the
kind. Sprints 88H/88I/88J open the vendor capability tables one
audit at a time.

## What changed

### PIR

- [packages/pir/src/domain/types.ts](../packages/pir/src/domain/types.ts) — added
  optional `io_setpoint_bindings?: Record<string, Id>` to `Equipment`.
- [packages/pir/src/schemas/equipment.ts](../packages/pir/src/schemas/equipment.ts) —
  added the matching zod field.
- [packages/pir/src/validators/rules/equipment.ts](../packages/pir/src/validators/rules/equipment.ts)
  + [`.js` mirror](../packages/pir/src/validators/rules/equipment.js) — added
  **R-EQ-05** with two sub-rules:
  - **(A)** every required numeric-output role on the equipment shape
    must have a setpoint source in `io_setpoint_bindings`,
  - **(B)** every entry in `io_setpoint_bindings` must reference a
    known role (numeric output, also bound in `io_bindings`) and a
    numeric machine-level parameter that exists.
- [packages/pir/tests/rules/equipment.spec.ts](../packages/pir/tests/rules/equipment.spec.ts) —
  added 8 R-EQ-05 cases covering happy path, missing setpoint source,
  unknown parameter, bool parameter, unknown role, input role, role
  not in `io_bindings`, and weldline-fixture backwards compatibility.

### codegen-core

- [packages/codegen-core/src/compiler/program/types.ts](../packages/codegen-core/src/compiler/program/types.ts)
  + [`.js` mirror](../packages/codegen-core/src/compiler/program/types.js) — added
  `motor_vfd_simple` to `CANONICAL_NAME` (`UDT_MotorVfdSimple`) and
  `FIELDS` (`cmd_run : Bool`, `speed_setpoint : Real`, `fault : Bool`).
- [packages/codegen-core/src/compiler/program/compile-project.ts](../packages/codegen-core/src/compiler/program/compile-project.ts)
  + [`.js` mirror](../packages/codegen-core/src/compiler/program/compile-project.js) —
  added `'motor_vfd_simple'` to `SUPPORTED_TYPES`; refreshed the
  stale Sprint 87A comment.
- [packages/codegen-core/src/compiler/lowering/helpers.ts](../packages/codegen-core/src/compiler/lowering/helpers.ts)
  + [`.js` mirror](../packages/codegen-core/src/compiler/lowering/helpers.js) — added
  `motor_vfd_simple: ['run']` to `SUPPORTED_ACTIVITIES`.
- [packages/codegen-core/src/compiler/lowering/outputs.ts](../packages/codegen-core/src/compiler/lowering/outputs.ts)
  + [`.js` mirror](../packages/codegen-core/src/compiler/lowering/outputs.js) — added
  `wireMotorVfdSimple`:
  - `run_out := <run command>` (mirrors `wireMotorSimple`),
  - `speed_setpoint_out := <bound parameter symbol>` always (no
    constant synthesis, no fallback),
  - emits `UNBOUND_ROLE` if either IO binding is missing,
  - emits `UNBOUND_SETPOINT_SOURCE` if `io_setpoint_bindings.speed_setpoint_out`
    is absent (defensive — PIR R-EQ-05 enforces this),
  - emits `UNKNOWN_SETPOINT_PARAMETER` if the bound parameter id
    is not a registered parameter symbol.
- [packages/codegen-core/src/compiler/diagnostics.ts](../packages/codegen-core/src/compiler/diagnostics.ts) —
  added two new diagnostic codes: `UNBOUND_SETPOINT_SOURCE`,
  `UNKNOWN_SETPOINT_PARAMETER`. (No `.js` mirror change — the
  union type is TS-only.)
- [packages/codegen-core/src/readiness/codegen-readiness.ts](../packages/codegen-core/src/readiness/codegen-readiness.ts)
  + [`.js` mirror](../packages/codegen-core/src/readiness/codegen-readiness.js) — split
  `CORE_SUPPORTED_EQUIPMENT` into `VENDOR_SUPPORTED_EQUIPMENT`
  (vendor targets stay narrow) and a wider `CORE_SUPPORTED_EQUIPMENT`
  (`core` target accepts `motor_vfd_simple`).
- [packages/codegen-core/tests/codegen-readiness.spec.ts](../packages/codegen-core/tests/codegen-readiness.spec.ts) —
  Sprint 88E pin tightened to vendor targets only; new test pins
  the `core` target widening.
- [packages/codegen-core/tests/motor-vfd-simple.spec.ts](../packages/codegen-core/tests/motor-vfd-simple.spec.ts) — new
  spec, 11 tests covering UDT shape, run wiring, parameter→setpoint
  wiring, no-synthesis invariant, no-extra-signals, determinism, and
  vendor-rejection on every vendor target plus core acceptance.

### Vendors

No production code changes. The renderers remain structurally
agnostic (verified in 87A/87C/88C audits). They will render
`UDT_MotorVfdSimple` as soon as their capability tables open — that
happens in Sprints 88H/88I/88J, not here.

### CLI / web / electrical-ingest

No changes. The split keeps every existing user-facing path
behaviourally identical for `motor_vfd_simple`: vendor backends
still throw `READINESS_FAILED`. Operator-authored parameters fill
the setpoint slot in 88G; ingestion-side parameter extraction is
deferred to Sprint 88L.

## Behaviour summary

### PIR validation

- `motor_vfd_simple` without `io_setpoint_bindings.speed_setpoint_out`
  → R-EQ-05 sub-rule A fires.
- Binding to non-existent parameter → sub-rule B4 fires.
- Binding to a `bool` parameter → sub-rule B5 fires.
- Binding to an unknown role → sub-rule B1 fires.
- Binding to an input or boolean role → sub-rule B2 fires.
- Binding for a role missing from `io_bindings` → sub-rule B3 fires.
- Existing fixtures without `io_setpoint_bindings` (e.g. weldline)
  remain clean — sub-rule A never fires for kinds that have no
  required numeric output role; sub-rule B has nothing to iterate.

### codegen-core lowering

For a happy `motor_vfd_simple` project, `compileProject` emits:

1. `UDT_MotorVfdSimple` type artifact with exactly
   `cmd_run : Bool`, `speed_setpoint : Real`, `fault : Bool`.
2. Inside the station FB body's *Output wiring* section:
   - `mot01 (motor_vfd_simple): run_cmd -> run_out` comment +
     Assign of the local run command into the bound `run_out` IO.
   - `mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out`
     comment + Assign of the bound parameter symbol (`SymbolRef` to
     `kind: 'parameter'`) into the bound `speed_setpoint_out` IO.
3. No `NumLit` for the speed setpoint expression — the Assign's
   `expr` is exclusively a `SymbolRef`.
4. No close output, busy/done, position feedback, fault latch,
   reverse, reset, ramp, or permissive — none of those identifiers
   appear anywhere in the body.

### Vendor preflight

For the same project, every vendor target throws:

```ts
runTargetPreflight(p, 'codesys')   // throws CodegenError READINESS_FAILED
runTargetPreflight(p, 'siemens')   // throws CodegenError READINESS_FAILED
runTargetPreflight(p, 'rockwell')  // throws CodegenError READINESS_FAILED
```

with `cause.diagnostics` containing
`READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`. The `core` target
does **not** throw.

## What this sprint does NOT do

- No vendor capability widening — `motor_vfd_simple` stays blocked
  on CODESYS / Siemens / Rockwell. Sprints 88H/88I/88J reopen them
  individually after audits.
- No safety semantics — no fault latching, no interlocks, no e-stop,
  no permissive logic, no drive-fault handling.
- No speed ramping, no reset, no fwd/rev, no dwell, no jog.
- No assumption promotion — every numeric value comes from a
  validated `Parameter`.
- No address synthesis — `io_bindings.speed_setpoint_out` must
  point to an existing IO.
- No automatic codegen from web.
- No PIR `Provenance` on `Parameter` — separate sprint.
- No electrical-ingest parameter extraction — separate sprint (88L).
- No web UI changes.
- No worker-protocol or localStorage changes.
- No PDF / OCR / layout work.

## Honest constraints

- **Operator-authored parameters only in v0.** The PIR builder
  does not synthesise parameter entries from CSV / EPLAN / PDF
  sources. Operators must declare `p_m01_speed` (or equivalent)
  by hand until Sprint 88L closes that gap.
- **Unit / scaling stay free-form.** `Parameter.unit` is a
  documentation string; no Hz↔%↔rpm conversion is performed.
  Operators commission the parameter's value in the unit the
  drive expects.
- **Recipe override semantics inherited as-is.** A recipe
  activation will swap the VFD setpoint instantly. v0 does not
  add a "lock" flag — that's safety logic.
- **`fault` field is exposed but undriven.** Lowering does not
  write to the DUT's `fault` bit; alarm/interlock layers drive
  it.
- **Determinism verified.** Two compile runs of the happy
  fixture produce byte-identical IR (test 7 of the new spec).
- **Mirrors invariant kept.** Every codegen-core `.ts` change has
  a matching `.js` update; PIR validator `.ts/.js` mirror updated
  in lockstep.
- **Windows pdfjs shutdown flake** (documented since Sprint 84) is
  unrelated to this sprint and may surface during `pnpm -r test`;
  per-package re-runs are clean.

## Gates run

| Gate | Result |
|---|---|
| `pnpm --filter @plccopilot/pir typecheck` | ✅ |
| `pnpm --filter @plccopilot/pir test` | ✅ 36 → 44 (+8 R-EQ-05 cases) |
| `pnpm --filter @plccopilot/codegen-core typecheck` | ✅ |
| `pnpm --filter @plccopilot/codegen-core test` | ✅ 757 → 769 (+12: 11 new spec + 1 added 88E split test) |
| `pnpm --filter @plccopilot/codegen-codesys test` | ✅ 52 |
| `pnpm --filter @plccopilot/codegen-siemens test` | ✅ 172 |
| `pnpm --filter @plccopilot/codegen-rockwell test` | ✅ 67 |
| `pnpm --filter @plccopilot/codegen-integration-tests test` | ✅ 131 |
| `pnpm --filter @plccopilot/cli test` | ✅ 757 |
| `pnpm --filter @plccopilot/web test` | ✅ 833 |
| `pnpm --filter @plccopilot/electrical-ingest test` | ✅ 672 |
| `pnpm -r typecheck` | ✅ |
| `pnpm publish:audit --check` | ✅ |
| `pnpm run ci` | ✅ exit 0 |

## Manual verification checklist

1. Build a tiny PIR with one `motor_vfd_simple` (`run_out` + numeric
   `speed_setpoint_out`, `io_setpoint_bindings.speed_setpoint_out`
   pointing at a numeric machine parameter).
2. PIR validate → no R-EQ-* errors.
3. Drop `io_setpoint_bindings` → R-EQ-05 sub-rule A fires.
4. Restore binding, change parameter to `bool` → R-EQ-05 sub-rule
   B5 fires.
5. CLI `generate --backend codesys` → non-zero exit, error references
   `READINESS_FAILED` → `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`
   (vendor still closed).
6. Same for `--backend siemens` and `--backend rockwell`.
7. Inspect codegen-core IR for the happy fixture — confirm
   `UDT_MotorVfdSimple` field set is exactly `cmd_run/speed_setpoint/fault`,
   the speed-setpoint Assign expression is a `SymbolRef` to the bound
   parameter (kind: `parameter`), and no `NumLit` appears as the
   setpoint source.

## Recommended next sprint

**Sprint 88H — CODESYS `motor_vfd_simple` audit + widening.**
Audit-first template (mirror 87A/87C/88C):

1. Re-confirm the CODESYS renderer is structurally agnostic for
   `motor_vfd_simple` (Sprint 88E's audit recap already says yes;
   re-verify against any 88G drift).
2. Add a `packages/codegen-codesys/tests/motor-vfd-simple.spec.ts`
   end-to-end spec mirroring `valve-onoff.spec.ts`: emits
   `DUT_MotorVfdSimple.st` with the documented field set, FB body
   contains the canonical assignments, manifest is clean, missing
   role surfaces UNBOUND_ROLE, generation is deterministic.
3. Widen `codesys` capability table to use `CORE_SUPPORTED_EQUIPMENT`
   (rejoining the wider set, this time intentionally including
   `motor_vfd_simple`).
4. Update Sprint 88E pin scope to `['siemens', 'rockwell']` only.
5. Update the cross-renderer parity test (Sprint 88D) to relax its
   "motor_vfd_simple blocks every vendor target" assertion to
   "blocks Siemens + Rockwell" (CODESYS now passes).

If the audit surfaces an unexpected per-kind hazard, halt at
audit-only — same template Sprint 88E used.

After 88H lands: 88I (Siemens), 88J (Rockwell), 88K (parity bar
mirroring 88D), 88L (ingestion parameter extraction).
