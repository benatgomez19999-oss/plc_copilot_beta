# Sprint 87A — Target equipment support v0 (`valve_onoff` for CODESYS)

> **Status: first per-target equipment-support split.** Sprint 86
> shipped `runTargetPreflight` + per-target capability tables but
> kept all four targets (`core`, `siemens`, `codesys`, `rockwell`)
> on the same supported set. Sprint 87A widens **CODESYS only**
> to add `valve_onoff` (single-coil spring-return solenoid valve);
> Siemens and Rockwell continue to reject the kind via
> `READINESS_FAILED` + `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
> Volume / scope hardening — no automatic codegen, no synthesised
> safety logic, no schema bump.

## Chosen equipment kind and target

| Decision | Value |
| --- | --- |
| Equipment kind | `valve_onoff` (already in [`packages/pir/src/domain/types.ts`](../packages/pir/src/domain/types.ts) `EquipmentType` union) |
| Target | `codesys` (CODESYS / IEC 61131-3 ST renderer) |
| Other targets | `siemens` and `rockwell` reject with `READINESS_FAILED` |

CODESYS was the cleanest choice: every backend funnels through
the same vendor-neutral `compileProject` + `ProgramIR` pipeline
in `@plccopilot/codegen-core`, and the CODESYS renderer is
purely IR-driven. Adding the kind to core's lowering + readiness
capability table is enough for CODESYS to render it; Siemens
and Rockwell are gated out at preflight without touching their
renderers.

## What is now supported

- **PIR `valve_onoff` equipment kind** is part of
  `compileProject.SUPPORTED_TYPES` (Sprint 86's scope check).
- **One activity** — `open` — is registered in
  `SUPPORTED_ACTIVITIES`. The sequence sets `<valve>.open` while
  the valve should be energised; releasing it lets the spring
  close the valve.
- **One role binding** — `solenoid_out` (BOOL output). Required;
  missing the binding fires `UNBOUND_ROLE` with the canonical
  hint.
- **Wiring strategy** `wireValveOnoff` in
  [`packages/codegen-core/src/compiler/lowering/outputs.ts`](../packages/codegen-core/src/compiler/lowering/outputs.ts):
  emits a single comment + assignment
  `solenoid_out := <valve>_open_cmd` per station that uses the
  `open` activity.
- **DUT/UDT** `UDT_ValveOnoff` (renders as `DUT_ValveOnoff` for
  CODESYS) with two fields: `cmd_open : Bool` and `fault : Bool`.
  Pinned in
  [`packages/codegen-core/src/compiler/program/types.ts`](../packages/codegen-core/src/compiler/program/types.ts).

## What remains unsupported

- **Siemens** rejects `valve_onoff` — the SCL renderer has not
  been audited for the kind. Façade throws
  `CodegenError('READINESS_FAILED', …)`.
- **Rockwell** rejects `valve_onoff` — the experimental Logix
  renderer has not been audited for the kind.
- **Other PIR equipment kinds** still in
  `EquipmentType` but absent from `SUPPORTED_TYPES`:
  `pneumatic_cylinder_1pos`, `motor_vfd_simple`, `sensor_analog`,
  `indicator_light`, `supervisor`. All four targets reject these
  via the existing readiness path.
- **Close output** for valves. v0 assumes spring return; no
  separate `close_out` coil is wired.
- **Position feedback / busy / fault latching.** Not synthesised;
  the DUT exposes a `fault` bit but the lowering doesn't drive
  it. Higher-fidelity equipment kinds (e.g. a future
  `valve_onoff_with_feedback`) would add those — out of scope
  for v0.
- **Manual-override / safety interlocks beyond the existing
  generic interlock layer.** Sprint 87A adds zero new safety
  semantics.

## Generated artifact shape (CODESYS)

For a single-station project containing one `valve_onoff`
instance bound to `state.activity.activate = ['v01.open']`,
`generateCodesysProject` emits:

| Path | Kind | Purpose |
| --- | --- | --- |
| `codesys/FB_StDose.st` | `st` | Station FB; the body contains the comment `v01 (valve_onoff): open_cmd -> solenoid_out` and the assignment `io_v01_sol := v01_open_cmd;` (after the Siemens→IEC translation). |
| `codesys/DUT_ValveOnoff.st` | `st` | `TYPE DUT_ValveOnoff : STRUCT cmd_open : BOOL; fault : BOOL; END_STRUCT END_TYPE`. |
| `codesys/manifest.json` | `json` | No `UNSUPPORTED_EQUIPMENT` / `UNSUPPORTED_ACTIVITY` diagnostics for the valve. |

The exact byte content is pinned by
[`packages/codegen-codesys/tests/valve-onoff.spec.ts`](../packages/codegen-codesys/tests/valve-onoff.spec.ts).

## Readiness behaviour — before vs after

| Caller | Pre-87A | Sprint 87A |
| --- | --- | --- |
| `compileProject(p)` directly with `valve_onoff` | throws `UNSUPPORTED_EQUIPMENT` | proceeds (lowering ships `wireValveOnoff`) |
| `generateCodesysProject(p)` | throws `READINESS_FAILED` (Sprint 86 preflight rejected `valve_onoff`) | succeeds; emits CODESYS artifacts |
| `generateSiemensProject(p)` | throws `READINESS_FAILED` | **still throws `READINESS_FAILED`** with `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` for siemens |
| `generateRockwellProject(p)` | throws `READINESS_FAILED` | **still throws `READINESS_FAILED`** for rockwell |
| `preflightProject(p, { target: 'core' })` | error: unsupported equipment | clean (no error) |
| `preflightProject(p, { target: 'codesys' })` | error: unsupported equipment | clean (no error) |
| `preflightProject(p, { target: 'siemens' })` | error: unsupported equipment | error: unsupported equipment (unchanged) |
| `preflightProject(p, { target: 'rockwell' })` | error: unsupported equipment | error: unsupported equipment (unchanged) |

The `core` capability table tracks `compileProject`'s actual
scope so direct callers (codegen-core unit tests, CLI in
`core` debug paths) see consistent behaviour.

## Safety constraints

- **No invented process logic.** `wireValveOnoff` emits exactly
  one assignment per active state; nothing more.
- **No automatic close output.** Spring-return is assumed; if a
  process needs an actively-driven close, a different (future)
  equipment kind is the right fix, not this one.
- **No fault latching.** The DUT exposes `fault : BOOL` but the
  lowering does not drive it. Operators wire fault detection
  through alarms / interlocks the existing PIR layers already
  support.
- **No safety interlocks beyond the existing generic layer.** The
  `interlocks: [{ inhibits: 'v01.open', when: ... }]` shape from
  Sprint 76 is honoured by the existing
  `lowerInterlocks` pass; Sprint 87A doesn't change it.
- **No address synthesis.** Missing `solenoid_out` binding fires
  `UNBOUND_ROLE` with the canonical
  `equipment[i].io_bindings.solenoid_out` JSON path.
- **Per-target gating remains load-bearing.** Operators who want
  `valve_onoff` on Siemens must wait for that target's
  capability table to widen — Sprint 87A does NOT secretly let
  the kind through anywhere it isn't certified.

## Operator manual verification

1. Hand-build a PIR fixture with one `valve_onoff` bound to
   `solenoid_out` and one state `activity.activate =
   ['valveId.open']`. Save it as `valve-test.json`.
2. `pnpm cli generate --backend codesys --input valve-test.json
   --out /tmp/codesys-out` — should exit `0`. Verify
   `/tmp/codesys-out/codesys/DUT_ValveOnoff.st` and
   `FB_<station>.st` exist; the FB body contains
   `v01 (valve_onoff): open_cmd -> solenoid_out`.
3. `pnpm cli generate --backend siemens --input valve-test.json
   --out /tmp/siemens-out` — should exit `1`, stderr
   `[READINESS_FAILED] … READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET …`
   naming `valve_onoff` and target `siemens`.
4. Same for `--backend rockwell`.
5. Web flow: open a review session that ends with a
   `valve_onoff` candidate. Build PIR → pick CODESYS in the
   generation panel. Confirm artifacts land cleanly. Pick
   Siemens / Rockwell — confirm the operator sees the readiness
   error in the diagnostics panel.

## Test / gate summary

| Package | Pre-87A | Sprint 87A | Notes |
| --- | --- | --- | --- |
| `@plccopilot/codegen-core` | 748 | **755** | +7 readiness per-target tests |
| `@plccopilot/codegen-codesys` | 47 | **52** | +5 valve-onoff end-to-end tests |
| `@plccopilot/codegen-siemens` | 165 | **166** | +1 rejection test |
| `@plccopilot/codegen-rockwell` | 59 | **60** | +1 rejection test |
| `@plccopilot/codegen-integration-tests` | 109 | 109 | unchanged |
| `@plccopilot/cli` | 757 | 757 | unchanged |
| `@plccopilot/electrical-ingest` | 650 | 650 | unchanged |
| `@plccopilot/web` | 818 | 818 | unchanged |
| `@plccopilot/pir` | 36 | 36 | unchanged |
| **Repo total** | **3,389** | **3,403** | **+14 new tests** |

Gates green: `pnpm -r typecheck`, `pnpm -r test`,
`pnpm publish:audit --check`, `pnpm run ci`.

## Recommended next sprint

1. **Sprint 87B — review UX for codegen readiness diagnostics
   in the web app** (operator surfaces readiness errors before
   hitting Generate).
2. **Sprint 87C — widen Siemens with one previously-unsupported
   kind**, mirroring the 87A pattern. Default candidate:
   `valve_onoff` for Siemens once an SCL renderer audit is
   complete.
3. **Sprint 88 — controlled codegen preview** (only after
   readiness diagnostics have been load-bearing for ≥ 1 real
   engagement).

Default to 87B unless operators report concrete generation
needs that 87C unlocks.
