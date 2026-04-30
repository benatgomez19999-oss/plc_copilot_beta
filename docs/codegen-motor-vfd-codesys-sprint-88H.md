# Sprint 88H — CODESYS `motor_vfd_simple` audit + widening

Status: closed locally (gates green; not pushed).
Sister sprints: 88E (audit, support deferred), 88F (Option A design),
88G (PIR + codegen-core lowering), **88I** (Siemens audit — pending),
**88J** (Rockwell audit — pending), 88K (cross-renderer parity bar —
pending), 88L (electrical-ingest parameter ingestion — pending).

## Audit summary

The CODESYS renderer was audited against the same 7-point checklist
that gated 87A (CODESYS valve_onoff), 87C (Siemens valve_onoff), and
88C (Rockwell valve_onoff). Every check came back clean:

| Check | Result | Where |
|---|---|---|
| 1. Per-equipment switch in renderer | ❌ none | [packages/codegen-codesys/src/renderers/codesys-st.ts](../packages/codegen-codesys/src/renderers/codesys-st.ts), [packages/codegen-codesys/src/generators/codesys-project.ts](../packages/codegen-codesys/src/generators/codesys-project.ts) |
| 2. Hard-coded UDT_NAMES map | ❌ none — names route through `codesysTypeName(canonicalName)` (lexical `^UDT_` → `DUT_` rewrite) | [packages/codegen-core/src/compiler/program/types.ts](../packages/codegen-core/src/compiler/program/types.ts) |
| 3. TypeArtifactIR.fields rendering | ✅ iterates `t.fields` blindly; per-field `dataType` → IEC type via `iecType()` | [packages/codegen-codesys/src/renderers/types.ts](../packages/codegen-codesys/src/renderers/types.ts) |
| 4. Assign StmtIR rendering | ✅ generic across `Ref` / `SymbolRef` / `BoolLit` / `NumLit`; no name inspection | [packages/codegen-codesys/src/renderers/codesys-st.ts](../packages/codegen-codesys/src/renderers/codesys-st.ts) |
| 5. Station FB rendering | ✅ walks `StmtIR[]` from `compileProject` without per-kind logic | same file + `codesys-project.ts` |
| 6. Manifest diagnostics | ✅ verbatim serialisation of `ProgramIR.manifest.compilerDiagnostics`; no per-kind injection | [packages/codegen-codesys/src/generators/codesys-manifest.ts](../packages/codegen-codesys/src/generators/codesys-manifest.ts) |
| 7. Naming conversion | ✅ `codesysTypeName('UDT_MotorVfdSimple')` → `'DUT_MotorVfdSimple'` via the same lexical rewrite that handles every other kind | [packages/codegen-codesys/src/generators/codesys-udts.ts](../packages/codegen-codesys/src/generators/codesys-udts.ts) |

**Verdict — clean.** The renderer was already capable of emitting
`motor_vfd_simple` artifacts the moment Sprint 88G's
`wireMotorVfdSimple` produced the corresponding IR; only the
readiness capability table was holding it back.

## What this sprint widens

### Readiness

[packages/codegen-core/src/readiness/codegen-readiness.ts](../packages/codegen-core/src/readiness/codegen-readiness.ts)
+ [`.js` mirror](../packages/codegen-core/src/readiness/codegen-readiness.js):

- Renamed `VENDOR_SUPPORTED_EQUIPMENT` → `SIEMENS_ROCKWELL_SUPPORTED_EQUIPMENT`
  (semantic clarification — this is now the *narrower* set used by
  the two vendors that haven't been audited for `motor_vfd_simple`
  yet).
- Kept `CORE_SUPPORTED_EQUIPMENT` as the *wider* set (now also used
  by `codesys`).
- `core` and `codesys` capability tables now point at
  `CORE_SUPPORTED_EQUIPMENT`. `siemens` and `rockwell` continue to
  point at `SIEMENS_ROCKWELL_SUPPORTED_EQUIPMENT`.

### Readiness vendor matrix after Sprint 88H

| Target | `motor_vfd_simple` accepted? |
|---|---|
| `core` | ✅ |
| `codesys` | ✅ — Sprint 88H |
| `siemens` | ❌ — Sprint 88I will audit |
| `rockwell` | ❌ — Sprint 88J will audit |

### What did NOT change

- No PIR schema/validator changes — Sprint 88G already shipped
  `io_setpoint_bindings` and R-EQ-05.
- No CODESYS renderer code — already structurally agnostic.
- No Siemens or Rockwell capability widening.
- No new diagnostic codes.
- No safety logic, no permissive, no fault latching, no ramp,
  no reset, no fwd/rev, no jog, no busy/done/position synthesis.
- No automatic codegen, no electrical-ingest changes, no web UI
  changes (one web *test* updated to reflect the per-vendor split).

## Test changes

### Added: [packages/codegen-codesys/tests/motor-vfd-simple.spec.ts](../packages/codegen-codesys/tests/motor-vfd-simple.spec.ts)

End-to-end CODESYS spec mirroring the `valve-onoff.spec.ts`
pattern. 11 tests pin:

1. Preflight passes (no `READINESS_FAILED` throw).
2. `codesys/DUT_MotorVfdSimple.st` exists and contains exactly
   `cmd_run : BOOL`, `speed_setpoint : REAL`, `fault : BOOL`. None
   of `cmd_open` / `cmd_close` / `fb_open` / `fb_closed` / `busy`
   / `done` / `position` / `reset` / `reverse` appear.
3. Station FB body contains the run breadcrumb +
   `io_m01_run := mot01_run_cmd`.
4. Station FB body contains the setpoint breadcrumb +
   `io_m01_speed_aw := p_m01_speed;` (bare global; CODESYS
   convention).
5. The speed-setpoint assignment's RHS is **never** a numeric
   literal (regex against `:= <number>`).
6. No synthesised close/busy/done/position/reverse/reset/permissive/
   ramp/fault-latch identifiers anywhere in the body (block
   comments stripped before scanning).
7. Manifest carries no `UNSUPPORTED_EQUIPMENT` /
   `UNSUPPORTED_ACTIVITY` / `READINESS_FAILED` /
   `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
8. Missing `speed_setpoint_out` IO binding still throws
   `UNBOUND_ROLE`.
9. Missing `io_setpoint_bindings` still throws
   `UNBOUND_SETPOINT_SOURCE`.
10. Generation is deterministic across two runs.
11. Exactly one `DUT_MotorVfdSimple` artifact, no duplicate paths.

### Updated: [packages/codegen-core/tests/codegen-readiness.spec.ts](../packages/codegen-core/tests/codegen-readiness.spec.ts)

Sprint 88E pin block re-titled to "Sprint 88H per-vendor split".
Three tests:

1. `motor_vfd_simple` is rejected by Siemens **and Rockwell**
   (audits 88I/88J pending).
2. `motor_vfd_simple` IS in the `core` capability table (88G).
3. `motor_vfd_simple` IS in the `codesys` capability table (88H —
   new pin).

### Updated: [packages/codegen-core/tests/motor-vfd-simple.spec.ts](../packages/codegen-core/tests/motor-vfd-simple.spec.ts)

Test 8 flipped from "throws on codesys" to "does NOT throw on
codesys (Sprint 88H — post-audit widening)". Tests 9/10 (siemens /
rockwell) keep the rejection bar.

### Updated: [packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts](../packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts)

Block 5 retitled and split:
- Loop iterates `['siemens', 'rockwell']` and asserts
  `READINESS_FAILED` + `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`
  on each.
- New `it()` asserts CODESYS preflight no longer throws for a
  `motor_vfd_simple` project.
- Net test count unchanged (3 → 2 + 1 = 3).

### Updated: [packages/web/tests/codegen-readiness-view.spec.ts](../packages/web/tests/codegen-readiness-view.spec.ts)

Test 4 renamed to "still blocks Siemens + Rockwell (CODESYS opened
in Sprint 88H)". Iterates `['siemens', 'rockwell']` only, plus a
final assertion that CODESYS readiness view does NOT carry
`READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` and is no longer
`'blocked'` for `motor_vfd_simple`.

## Fixture contract (CODESYS-specific spec)

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

## Honest constraints

- **No vendor certification claim.** CODESYS now structurally
  emits a `motor_vfd_simple` shape; that is not a guarantee that
  the generated code meets any operator/site safety standard.
- **No safety semantics.** The DUT's `fault` field is exposed but
  undriven by lowering; alarm/interlock layers drive it. No fault
  latching, no e-stop, no permissive logic, no ramp, no reset, no
  fwd/rev, no jog, no busy/done/position synthesis.
- **No assumption promotion.** The speed setpoint comes from the
  bound machine-level `Parameter`; the lowering never synthesises
  a literal. Test 5 of the new spec pins this with a regex
  forbidding `io_m01_speed_aw := <number>;`.
- **Only CODESYS opened.** Siemens and Rockwell continue to throw
  `READINESS_FAILED` with `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`
  for any `motor_vfd_simple` project.
- **Operator-authored parameters only in v0.** Sprint 88L will
  add CSV/EPLAN parameter ingestion; until then the operator
  declares `p_m01_speed` (or equivalent) by hand.
- **`.ts/.js` mirror invariant kept** across all codegen-core
  changes (`codegen-readiness.ts/.js`).
- **pdfjs Windows shutdown flake** in `electrical-ingest` (documented
  since Sprint 84) is unrelated to this sprint and may surface
  during `pnpm -r test`; per-package re-runs are clean.

## Manual verification checklist

- [ ] Build a tiny PIR with one `motor_vfd_simple` (`run_out` +
      numeric `speed_setpoint_out` IO,
      `io_setpoint_bindings.speed_setpoint_out` → numeric machine
      parameter).
- [ ] CLI `generate --backend codesys` → exits 0, emits
      `codesys/DUT_MotorVfdSimple.st` with the documented field
      set, station FB has `io_m01_run := mot01_run_cmd` and
      `io_m01_speed_aw := p_m01_speed;`, no synthesised literal
      as setpoint source.
- [ ] CLI `generate --backend siemens` → non-zero exit,
      `READINESS_FAILED` → `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
- [ ] CLI `generate --backend rockwell` → same as Siemens.
- [ ] Web readiness panel for the same fixture: CODESYS *Ready*,
      Siemens *Blocked*, Rockwell *Blocked*.
- [ ] Drop `io_setpoint_bindings` → CODESYS generation fails with
      `UNBOUND_SETPOINT_SOURCE`.
- [ ] Drop the IO binding for `speed_setpoint_out` → CODESYS
      generation fails with `UNBOUND_ROLE`.
- [ ] Confirm valve_onoff fixtures still generate cleanly on all
      three vendor targets (Sprint 88D parity bar untouched).

## Recommended next sprints

1. **Sprint 88I — Siemens `motor_vfd_simple` audit + widening.**
   Audit-first template (mirror 88H). Confirm SCL renderer
   structurally agnostic, add a `packages/codegen-siemens/tests/motor-vfd-simple.spec.ts`,
   widen Siemens capability table to `CORE_SUPPORTED_EQUIPMENT`,
   update the per-vendor split tests.
2. **Sprint 88J — Rockwell `motor_vfd_simple` audit + widening.**
   Same template, mirror Sprint 88C's Logix audit pattern.
3. **Sprint 88K — cross-renderer `motor_vfd_simple` parity bar.**
   Mirror Sprint 88D: one fixture, three backends, parity-pinned
   field set + assignment shape + no synthesised signals.
4. **Sprint 88L — electrical-ingest parameter extraction.**
   Close the operator-authoring-only constraint by ingesting
   parameters from CSV / EPLAN / TcECAD where the source carries
   numeric metadata (range / unit / default).

If at any audit step (88I/88J) a renderer turns out *not* to be
structurally agnostic, halt at audit-only — same template Sprint
88E used for the kind itself.
