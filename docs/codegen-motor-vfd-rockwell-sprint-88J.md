# Sprint 88J — Rockwell `motor_vfd_simple` audit + widening (universal convergence)

Status: closed locally (gates green; not pushed).
Sister sprints: 88E (audit, support deferred), 88F (Option A design),
88G (PIR + codegen-core lowering), 88H (CODESYS audit + widening),
88I (Siemens audit + widening), **88K** (cross-renderer parity bar
— pending), 88L (electrical-ingest parameter ingestion — pending).

## Audit summary

The Rockwell/Logix renderer was audited against the same 9-point
checklist used in 88H/88I (renderer switch, UDT_NAMES map, fields
rendering, Assign rendering, parameter SymbolRef rendering, naming
conversion, manifest diagnostics, FB body walking, Logix tag-name
constraints). Every check came back **clean**:

| # | Check | Result |
|---|---|---|
| 1 | Per-equipment switch in renderer | ❌ none — `renderStmtRockwell` switches on `StmtIR.kind` only |
| 2 | Hard-coded `UDT_NAMES` map | ❌ none — Rockwell uses canonical name verbatim from `TypeArtifactIR.name` (no rewrite, unlike CODESYS) |
| 3 | `TypeArtifactIR.fields` rendering | ✅ iterates `t.fields` blindly, per-field `dataType` → `iecType()` (`Bool` → `BOOL`, `Real` → `REAL`) |
| 4 | `Assign` `StmtIR` rendering | ✅ generic across `Ref` / `SymbolRef` / `BoolLit` / `NumLit`; no name inspection |
| 5 | `SymbolRef → parameter` rendering | ✅ flows through shared `renderStorage` (`kind: 'global'` → bare identifier on Rockwell — no `#` prefix, no double-quoting) |
| 6 | Naming conversion | ✅ canonical `UDT_*` accepted verbatim |
| 7 | Manifest diagnostics | ✅ per-project (`ROCKWELL_EXPERIMENTAL_BACKEND` / `ROCKWELL_NO_L5X_EXPORT` / `ROCKWELL_TIMER_PSEUDO_IEC`); no per-equipment-kind injection |
| 8 | Station FB / routine body rendering | ✅ `renderFunctionBlockRockwell` walks `varSections` + `body` blindly |
| 9 | Logix tag-name constraints | ✅ all motor_vfd_simple identifiers (`UDT_MotorVfdSimple`, `mot01_run_cmd`, `p_m01_speed`, `io_m01_speed_aw`) fit the 40-char/`[A-Za-z_][A-Za-z0-9_]*` Logix limit |

**Verdict — clean.** Sprint 88G's `wireMotorVfdSimple` already
produces the IR; the Logix renderer emits it generically the
moment the readiness capability table opens. No Rockwell-side
production code changes were required.

## What this sprint widens

### Readiness convergence

[packages/codegen-core/src/readiness/codegen-readiness.ts](../packages/codegen-core/src/readiness/codegen-readiness.ts)
+ [`.js` mirror](../packages/codegen-core/src/readiness/codegen-readiness.js):

- Removed the narrow `ROCKWELL_SUPPORTED_EQUIPMENT` constant (no
  vendor target is on a narrower set anymore).
- All four targets — `core`, `codesys`, `siemens`, `rockwell` —
  now reference the single `CORE_SUPPORTED_EQUIPMENT` set, which
  includes `motor_vfd_simple`.

### Readiness vendor matrix after Sprint 88J

| Target | `motor_vfd_simple` accepted? |
|---|---|
| `core` | ✅ |
| `codesys` | ✅ — Sprint 88H |
| `siemens` | ✅ — Sprint 88I |
| `rockwell` | ✅ — Sprint 88J |

### What did NOT change

- No PIR schema/validator changes — Sprint 88G already shipped
  `io_setpoint_bindings` and R-EQ-05.
- No Rockwell renderer code — already structurally agnostic.
- No new diagnostic codes; `ROCKWELL_EXPERIMENTAL_BACKEND` stays.
- No safety logic, no permissive, no fault latching, no ramp,
  no reset, no fwd/rev, no jog, no busy/done/position synthesis.
- No automatic codegen, no electrical-ingest changes, no web UI
  component changes.
- No cross-renderer parity bar yet (Sprint 88K).

## Test changes

### Added: [packages/codegen-rockwell/tests/motor-vfd-simple.spec.ts](../packages/codegen-rockwell/tests/motor-vfd-simple.spec.ts)

End-to-end Rockwell spec mirroring `valve-onoff.spec.ts` and the
sibling 88H/88I motor_vfd_simple specs. 11 tests pin:

1. Preflight passes (no `READINESS_FAILED` throw).
2. `rockwell/UDT_MotorVfdSimple.st` exists and contains exactly
   `cmd_run : BOOL`, `speed_setpoint : REAL`, `fault : BOOL`.
   None of `cmd_open` / `cmd_close` / `fb_open` / `fb_closed` /
   `busy` / `done` / `position` / `reset` / `reverse` /
   `permissive` / `ramp` appear.
3. Station FB body contains the run breadcrumb +
   `io_m01_run := mot01_run_cmd` (Rockwell convention: bare
   global identifiers).
4. Station FB body contains the setpoint breadcrumb +
   `io_m01_speed_aw := p_m01_speed;` (parameter renders as a
   bare global via shared `renderStorage` with `kind: 'global'`).
5. The speed-setpoint assignment RHS is **never** a literal
   (regex against `:= TRUE / FALSE / <number>;`).
6. No synthesised `mot01_close` / `mot01_busy` / `mot01_done` /
   `mot01_position` / `mot01_reverse` / `mot01_reset` /
   `mot01_permissive` / `mot01_ramp` / `mot01.fault := …`
   identifiers anywhere (block + line comments stripped before
   scanning).
7. Manifest carries no `UNSUPPORTED_*` / `READINESS_FAILED` /
   `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`. Retains
   `ROCKWELL_EXPERIMENTAL_BACKEND`.
8. Missing `speed_setpoint_out` IO binding still throws
   `UNBOUND_ROLE`.
9. Missing `io_setpoint_bindings` still throws
   `UNBOUND_SETPOINT_SOURCE`.
10. Generation is deterministic across two runs.
11. Exactly one `UDT_MotorVfdSimple` artifact, no duplicate paths.

### Updated: [packages/codegen-core/tests/codegen-readiness.spec.ts](../packages/codegen-core/tests/codegen-readiness.spec.ts)

Sprint 88I per-vendor split block re-titled to "Sprint 88J
convergence (all targets accept)". Four positive pins:
core / codesys / siemens / rockwell each accept
`motor_vfd_simple`. The block stays as a regression bar — any
future sprint that accidentally narrows must surface here.

The 87A test 8 (`runTargetPreflight still throws READINESS_FAILED
for an equipment kind outside CORE_SUPPORTED_EQUIPMENT`)
retargeted from `motor_vfd_simple` to `pneumatic_cylinder_1pos`,
which is the next still-unsupported PIR `EquipmentType`.

### Updated: [packages/codegen-core/tests/motor-vfd-simple.spec.ts](../packages/codegen-core/tests/motor-vfd-simple.spec.ts)

Test 10 flipped from "throws on rockwell" to "does NOT throw on
rockwell (Sprint 88J — post-audit widening)".

### Updated: [packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts](../packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts)

Block 5 retitled and re-shaped:
- Loop iterates `['codesys', 'siemens', 'rockwell']` and asserts
  preflight does NOT throw on any.
- New `it()` asserts `pneumatic_cylinder_1pos` still throws on
  Rockwell as a regression bar for an actually-unsupported kind.

### Updated: [packages/web/tests/codegen-readiness-view.spec.ts](../packages/web/tests/codegen-readiness-view.spec.ts)

- Test 4: motor_vfd_simple → no vendor blocks (loop
  `[codesys, siemens, rockwell]`).
- New test 5: `pneumatic_cylinder_1pos` blocks every vendor —
  the rejection-UX guardrail moves to the next genuinely
  unsupported kind.

### Updated: [packages/cli/tests/generate.spec.ts](../packages/cli/tests/generate.spec.ts)

`writeProjectWithUnsupportedEquipment` retargeted from
`motor_vfd_simple` to `pneumatic_cylinder_1pos`. Comment
refreshed to reflect that motor_vfd_simple no longer exercises
the rejection UX on any vendor after Sprints 88H/88I/88J.
Assertions updated: `pneumatic_cylinder_1pos` in the rolled-up
message; the Hint enumeration now includes `motor_vfd_simple`
among the supported types.

## Fixture contract (Rockwell-specific spec)

```jsonc
{
  "id": "mot01",
  "type": "motor_vfd_simple",
  "code_symbol": "M01",
  "io_bindings": {
    "run_out":            "io_m01_run",            // Q0.0, BOOL
    "speed_setpoint_out": "io_m01_speed_aw"        // Q100,  REAL
  },
  "io_setpoint_bindings": {
    "speed_setpoint_out": "p_m01_speed"            // → machine.parameters[]
  }
}
```

with one machine-level numeric parameter:

```jsonc
{ "id": "p_m01_speed", "data_type": "real", "default": 50,
  "min": 0, "max": 100, "unit": "Hz" }
```

and one state activating the motor:

```jsonc
{ "id": "st_running", "kind": "normal",
  "activity": { "activate": ["mot01.run"] } }
```

Rockwell output (excerpts pinned by the spec):

```st
TYPE UDT_MotorVfdSimple :
STRUCT
    cmd_run : BOOL;
    speed_setpoint : REAL;
    fault : BOOL;
END_STRUCT
END_TYPE
```

```st
(* mot01 (motor_vfd_simple): run_cmd -> run_out *)
io_m01_run := mot01_run_cmd;
(* mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out *)
io_m01_speed_aw := p_m01_speed;
```

## Honest constraints

- **No vendor certification claim.** All three vendor backends
  now structurally emit a `motor_vfd_simple` shape; that is
  **not** a guarantee that the generated code meets any
  operator/site safety standard.
- **No safety semantics.** No fault latching, no e-stop chains,
  no permissive logic, no ramps, no reset, no fwd/rev, no jog,
  no busy/done/position synthesis. The UDT's `fault` field is
  exposed but undriven by lowering; alarm/interlock layers drive
  it.
- **No assumption promotion.** Speed setpoint comes from the
  bound `Parameter`; the lowering never synthesises a literal.
  Test 5 of the new spec pins this with a regex forbidding
  `io_m01_speed_aw := TRUE/FALSE/<number>;`.
- **`ROCKWELL_EXPERIMENTAL_BACKEND` retained.** The legacy
  global diagnostic survives — Sprint 88J does not change the
  backend's experimental status, only opens one more equipment
  kind.
- **Operator-authored parameters only in v0.** Sprint 88L will
  add CSV/EPLAN parameter ingestion; until then the operator
  declares `p_m01_speed` (or equivalent) by hand.
- **`.ts/.js` mirror invariant kept** in codegen-core.
- **pdfjs Windows shutdown flake** in `electrical-ingest`
  (documented since Sprint 84) is unrelated to this sprint and
  may surface during `pnpm -r test`; per-package re-runs are
  clean.

## Manual verification checklist

- [ ] Build a tiny PIR with one `motor_vfd_simple` (`run_out` +
      numeric `speed_setpoint_out` IO,
      `io_setpoint_bindings.speed_setpoint_out` → numeric
      machine parameter).
- [ ] CLI `generate --backend rockwell` → exits 0, emits
      `rockwell/UDT_MotorVfdSimple.st` with `cmd_run : BOOL`,
      `speed_setpoint : REAL`, `fault : BOOL`. Station FB body
      has `io_m01_run := mot01_run_cmd;` and
      `io_m01_speed_aw := p_m01_speed;`. No synthesised literal
      as setpoint source.
- [ ] CLI `generate --backend codesys` and `--backend siemens`
      still work (88H/88I regression check).
- [ ] Web readiness panel: CODESYS / Siemens / Rockwell all
      Ready for `motor_vfd_simple`.
- [ ] Drop `io_setpoint_bindings` → Rockwell fails with
      `UNBOUND_SETPOINT_SOURCE`.
- [ ] Drop the IO binding for `speed_setpoint_out` → Rockwell
      fails with `UNBOUND_ROLE`.
- [ ] Manifest contains `ROCKWELL_EXPERIMENTAL_BACKEND` and no
      `UNSUPPORTED_*` / `READINESS_FAILED`.
- [ ] valve_onoff fixtures still generate cleanly on all three
      vendor targets (Sprint 88D parity bar untouched).
- [ ] Swap the equipment to `pneumatic_cylinder_1pos` →
      `READINESS_FAILED` on every vendor target (still genuinely
      unsupported).

## Recommended next sprints

1. **Sprint 88K — cross-renderer `motor_vfd_simple` parity bar.**
   Mirror Sprint 88D for valve_onoff: one fixture, three
   backends, parity-pinned field set + assignment shape + no
   synthesised signals. Locks the convergence achieved in 88H/88I/88J
   against future renderer drift.
2. **Sprint 88L — electrical-ingest parameter extraction.**
   Close the operator-authoring-only constraint by ingesting
   parameters from CSV / EPLAN / TcECAD where the source carries
   numeric metadata (range / unit / default). Rounds out the
   motor_vfd_simple story so a real ingestion path can supply
   the bound `Parameter`.
3. **Alternative: Sprint 89 — controlled codegen preview UX
   (web).** If operators are ready for explicit per-target
   preview before generating files, that's the next UX-side step.
