# Sprint 88I — Siemens `motor_vfd_simple` audit + widening

Status: closed locally (gates green; not pushed).
Sister sprints: 88E (audit, support deferred), 88F (Option A design),
88G (PIR + codegen-core lowering), 88H (CODESYS audit + widening),
**88J** (Rockwell audit — pending), 88K (cross-renderer parity bar —
pending), 88L (electrical-ingest parameter ingestion — pending).

## Audit summary

The Siemens/SCL renderer was audited against the same 8-point
checklist used in 88H. Every check came back **clean**:

| Check | Result | Where |
|---|---|---|
| 1. Per-equipment switch in renderer | ❌ none | [packages/codegen-siemens/src/compiler/renderers/scl.ts](../packages/codegen-siemens/src/compiler/renderers/scl.ts) — `renderStmt` switches on `StmtIR.kind` only |
| 2. Hard-coded `UDT_NAMES` map | Public helper map exists ([packages/codegen-siemens/src/naming.ts](../packages/codegen-siemens/src/naming.ts)) but is for the public `udtName(eqType)` API; the renderer itself uses the canonical name from `TypeArtifactIR.name` (set by `siemensTypeName`/`canonicalTypeName`). Adding the new entry keeps the helper consistent. |
| 3. `TypeArtifactIR.fields` rendering | ✅ iterates `t.fields` blindly; per-field `dataType` rendered verbatim (`Bool`, `Real`) | [packages/codegen-siemens/src/compiler/renderers/types.ts:8-27](../packages/codegen-siemens/src/compiler/renderers/types.ts#L8-L27) |
| 4. `Assign` `StmtIR` rendering | ✅ generic across `Ref` / `SymbolRef` / `BoolLit` / `NumLit`; no name inspection | [packages/codegen-siemens/src/compiler/renderers/scl.ts:52-62](../packages/codegen-siemens/src/compiler/renderers/scl.ts#L52-L62) |
| 5. `SymbolRef` → parameter rendering | ✅ flows through shared `renderStorage` (codegen-core) — `kind: 'global'` storage renders as `"name"` (Siemens convention) regardless of the symbol's `kind: 'parameter'` vs `'io'` etc. | [packages/codegen-core/src/compiler/symbols/render-symbol.ts:30-56](../packages/codegen-core/src/compiler/symbols/render-symbol.ts#L30-L56) |
| 6. Naming conversion | ✅ canonical `UDT_*` accepted verbatim — no `DUT_*` rewrite (that's CODESYS-only) | core's `siemensTypeName` |
| 7. Manifest diagnostics | ✅ verbatim from `ProgramIR.manifest.compilerDiagnostics`; no per-kind injection | [packages/codegen-siemens/src/generators/manifest.ts](../packages/codegen-siemens/src/generators/manifest.ts) |
| 8. FB header / VAR sections | ✅ generic — `renderFunctionBlock` walks `fb.varSections` and `fb.body` blindly | [packages/codegen-siemens/src/compiler/renderers/scl.ts:151-171](../packages/codegen-siemens/src/compiler/renderers/scl.ts#L151-L171) |

**Verdict — clean.** Sprint 88G's `wireMotorVfdSimple` already
produces the IR; the SCL renderer emits it generically the moment
the readiness capability table opens. Only the public
`udtName(eqType)` helper needs an entry to stay consistent.

## What this sprint widens

### Readiness

[packages/codegen-core/src/readiness/codegen-readiness.ts](../packages/codegen-core/src/readiness/codegen-readiness.ts)
+ [`.js` mirror](../packages/codegen-core/src/readiness/codegen-readiness.js):

- Renamed `SIEMENS_ROCKWELL_SUPPORTED_EQUIPMENT` →
  `ROCKWELL_SUPPORTED_EQUIPMENT` (Siemens no longer shares the
  narrower set; only Rockwell does).
- `siemens` capability table now points at
  `CORE_SUPPORTED_EQUIPMENT` (the wider set, includes
  `motor_vfd_simple`).
- `core` and `codesys` continue on `CORE_SUPPORTED_EQUIPMENT`.
- `rockwell` continues on `ROCKWELL_SUPPORTED_EQUIPMENT`.

### Siemens public helper

[packages/codegen-siemens/src/naming.ts](../packages/codegen-siemens/src/naming.ts)
+ [`.js` mirror](../packages/codegen-siemens/src/naming.js):

- Added `motor_vfd_simple: 'UDT_MotorVfdSimple'` to `UDT_NAMES`
  so `udtName('motor_vfd_simple')` returns the canonical name.
  Test 7 in the new spec pins this.

### Readiness vendor matrix after Sprint 88I

| Target | `motor_vfd_simple` accepted? |
|---|---|
| `core` | ✅ |
| `codesys` | ✅ — Sprint 88H |
| `siemens` | ✅ — Sprint 88I |
| `rockwell` | ❌ — Sprint 88J will audit |

### What did NOT change

- No PIR schema/validator changes — Sprint 88G already shipped
  `io_setpoint_bindings` and R-EQ-05.
- No Siemens renderer code — already structurally agnostic.
- No Rockwell capability widening.
- No new diagnostic codes.
- No safety logic, no permissive, no fault latching, no ramp,
  no reset, no fwd/rev, no jog, no busy/done/position synthesis.
- No automatic codegen, no electrical-ingest changes, no web UI
  component changes (one web *test* updated to reflect the
  Rockwell-only rejection).
- No cross-renderer parity bar yet (Sprint 88K handles that).

## Test changes

### Added: [packages/codegen-siemens/tests/motor-vfd-simple.spec.ts](../packages/codegen-siemens/tests/motor-vfd-simple.spec.ts)

End-to-end Siemens spec mirroring the `valve-onoff.spec.ts`
pattern. 12 tests pin:

1. Preflight passes (no `READINESS_FAILED` throw).
2. `siemens/UDT_MotorVfdSimple.scl` exists and contains exactly
   `cmd_run : Bool;`, `speed_setpoint : Real;`, `fault : Bool;`.
   None of `cmd_open` / `cmd_close` / `fb_open` / `fb_closed` /
   `busy` / `done` / `position` / `reset` / `reverse` appear.
3. Station FB body contains the run breadcrumb +
   `"io_m01_run" := #mot01_run_cmd` (Siemens convention: `#` for
   local, `"…"` for global).
4. Station FB body contains the setpoint breadcrumb +
   `"io_m01_speed_aw" := "p_m01_speed"` (parameter renders as a
   double-quoted global, matching the existing `DB_Global_Params`
   convention).
5. The speed-setpoint assignment's RHS is **never** a numeric
   literal (regex against `"io_m01_speed_aw" := <number>;`).
6. No synthesised `mot01_close` / `mot01_busy` / `mot01_done` /
   `mot01_position` / `mot01_reverse` / `mot01_reset` /
   `mot01_permissive` / `mot01_ramp` / `mot01.fault := …`
   identifiers anywhere (line comments stripped before scanning).
7. `udtName('motor_vfd_simple') === 'UDT_MotorVfdSimple'` —
   public helper consistency.
8. Manifest carries no `UNSUPPORTED_EQUIPMENT` /
   `UNSUPPORTED_ACTIVITY` / `READINESS_FAILED` /
   `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
9. Missing `speed_setpoint_out` IO binding still throws
   `UNBOUND_ROLE`.
10. Missing `io_setpoint_bindings` still throws
    `UNBOUND_SETPOINT_SOURCE`.
11. Generation is deterministic across two runs.
12. Exactly one `UDT_MotorVfdSimple` artifact, no duplicate paths.

### Updated: [packages/codegen-core/tests/codegen-readiness.spec.ts](../packages/codegen-core/tests/codegen-readiness.spec.ts)

Sprint 88H pin block re-titled to "Sprint 88I per-vendor split".
Four tests:

1. `motor_vfd_simple` is rejected by Rockwell only (audit 88J
   pending).
2. `motor_vfd_simple` IS in the `core` capability table (88G).
3. `motor_vfd_simple` IS in the `codesys` capability table (88H).
4. `motor_vfd_simple` IS in the `siemens` capability table (88I —
   new pin).

### Updated: [packages/codegen-core/tests/motor-vfd-simple.spec.ts](../packages/codegen-core/tests/motor-vfd-simple.spec.ts)

Test 9 flipped from "throws on siemens" to "does NOT throw on
siemens (Sprint 88I — post-audit widening)". Test 10 (rockwell)
keeps the rejection bar.

### Updated: [packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts](../packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts)

Block 5 retitled and re-shaped:
- One `it()` asserts `rockwell` throws `READINESS_FAILED` +
  `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
- Two positive `it()` assertions: CODESYS preflight passes
  (88H), Siemens preflight passes (88I).
- Net test count unchanged (3 tests: was 2 STILL_CLOSED + 1
  codesys-passes; now 1 rockwell + 1 codesys + 1 siemens).

### Updated: [packages/web/tests/codegen-readiness-view.spec.ts](../packages/web/tests/codegen-readiness-view.spec.ts)

Test 4 renamed and re-shaped:
- Rockwell still asserts the unsupported-UX (`status === 'blocked'`,
  `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` group present, hint
  defined).
- CODESYS + Siemens explicitly asserted *not* `'blocked'` and no
  `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` group.

## Fixture contract (Siemens-specific spec)

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

Siemens output (excerpts pinned by the spec):

```scl
TYPE "UDT_MotorVfdSimple"
VERSION : 0.1
STRUCT
    cmd_run : Bool;
    speed_setpoint : Real;
    fault : Bool;
END_STRUCT;
END_TYPE
```

```scl
// mot01 (motor_vfd_simple): run_cmd -> run_out
"io_m01_run" := #mot01_run_cmd;
// mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out
"io_m01_speed_aw" := "p_m01_speed";
```

## Honest constraints

- **No vendor certification claim.** Siemens now structurally
  emits a `motor_vfd_simple` shape; that is **not** a guarantee
  that the generated code meets any operator/site safety
  standard.
- **No safety semantics.** No fault latching, no e-stop chains,
  no permissive logic, no ramps, no reset, no fwd/rev, no jog,
  no busy/done/position synthesis. The UDT's `fault` field is
  exposed but undriven by lowering; alarm/interlock layers drive
  it.
- **No assumption promotion.** Speed setpoint comes from the
  bound `Parameter`; the lowering never synthesises a literal.
  Test 5 of the new spec pins this with a regex forbidding
  `"io_m01_speed_aw" := <number>;`.
- **Only Siemens opened in 88I.** Rockwell still throws
  `READINESS_FAILED` for any `motor_vfd_simple` project. CODESYS
  was already opened in 88H.
- **Operator-authored parameters only in v0.** Sprint 88L will
  add CSV/EPLAN parameter ingestion; until then the operator
  declares `p_m01_speed` (or equivalent) by hand.
- **`.ts/.js` mirror invariant kept** across all changed
  packages (codegen-core readiness + Siemens naming).
- **pdfjs Windows shutdown flake** in `electrical-ingest`
  (documented since Sprint 84) is unrelated to this sprint and
  may surface during `pnpm -r test`; per-package re-runs are
  clean.

## Manual verification checklist

- [ ] Build a tiny PIR with one `motor_vfd_simple` (`run_out` +
      numeric `speed_setpoint_out` IO,
      `io_setpoint_bindings.speed_setpoint_out` → numeric machine
      parameter).
- [ ] CLI `generate --backend siemens` → exits 0, emits
      `siemens/UDT_MotorVfdSimple.scl` with
      `cmd_run : Bool;`, `speed_setpoint : Real;`,
      `fault : Bool;`. Station FB has
      `"io_m01_run" := #mot01_run_cmd;` and
      `"io_m01_speed_aw" := "p_m01_speed";`. No synthesised
      literal as setpoint source.
- [ ] CLI `generate --backend codesys` still emits the CODESYS
      VFD project (88H regression check).
- [ ] CLI `generate --backend rockwell` → non-zero exit,
      `READINESS_FAILED` → `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
- [ ] Web readiness panel: CODESYS Ready, Siemens Ready,
      Rockwell Blocked.
- [ ] Drop `io_setpoint_bindings` → Siemens generation fails
      with `UNBOUND_SETPOINT_SOURCE`.
- [ ] Drop the IO binding for `speed_setpoint_out` → Siemens
      generation fails with `UNBOUND_ROLE`.
- [ ] Confirm valve_onoff fixtures still generate cleanly on
      all three vendor targets (Sprint 88D parity bar untouched).

## Recommended next sprints

1. **Sprint 88J — Rockwell `motor_vfd_simple` audit + widening.**
   Last vendor to open. Audit-first template (mirror 88H/88I).
   Confirm Logix renderer is structurally agnostic, add
   `packages/codegen-rockwell/tests/motor-vfd-simple.spec.ts`,
   widen Rockwell capability table to `CORE_SUPPORTED_EQUIPMENT`,
   collapse the per-vendor split tests (every target now opens).
2. **Sprint 88K — cross-renderer `motor_vfd_simple` parity bar.**
   Mirror Sprint 88D: one fixture, three backends, parity-pinned
   field set + assignment shape + no synthesised signals.
3. **Sprint 88L — electrical-ingest parameter extraction.**
   Close the operator-authoring-only constraint by ingesting
   parameters from CSV / EPLAN / TcECAD where the source carries
   numeric metadata (range / unit / default).

If at the next audit step (88J) the Logix renderer turns out
*not* to be structurally agnostic, halt at audit-only — same
template Sprint 88E used for the kind itself.
