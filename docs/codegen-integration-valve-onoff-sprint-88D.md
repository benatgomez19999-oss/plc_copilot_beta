# Sprint 88D — Codegen integration tests for `valve_onoff` (universal support)

Status: closed (gates green; not pushed).
Sister sprints: 87A (CODESYS valve_onoff support), 87C (Siemens valve_onoff support after SCL audit), 88C (Rockwell valve_onoff support after Logix audit).

## Why this sprint exists

Sprints 87A → 88C widened readiness for `valve_onoff` one vendor at a
time. Each widening shipped a per-package spec that pins **its own**
target's artifact shape:

- `packages/codegen-codesys/tests/valve-onoff.spec.ts`
- `packages/codegen-siemens/tests/valve-onoff.spec.ts`
- `packages/codegen-rockwell/tests/valve-onoff.spec.ts`

Each per-package spec is the source of truth for its target's lexical
conventions (e.g. CODESYS `DUT_…`, Siemens `UDT_…`, Rockwell `UDT_…`
plus `ROCKWELL_EXPERIMENTAL_BACKEND` diagnostic). What none of them
guards is **parity** — the property that future renderer drift on one
backend cannot accidentally relax the contract the other two still
honour.

Sprint 88D adds that parity bar at integration scope.

## What this sprint guarantees

The new spec
[`packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts`][spec]
takes one PIR fixture (one machine, one station, one `valve_onoff`,
one bool output `solenoid_out`) and runs it through **all three**
production targets — CODESYS, Siemens, Rockwell — asserting that:

1. Every target produces a non-empty artifact list with both the
   expected type artifact (`DUT_ValveOnoff` / `UDT_ValveOnoff`) and
   the station FB (`FB_StDose`).
2. Every type artifact contains exactly the v0 minimal field set:
   `cmd_open : BOOL/Bool` and `fault : BOOL/Bool`. No
   `cmd_close`, no `fb_open` / `fb_closed`, no `position`, no
   `busy`, no `done`.
3. Every station FB contains an `open_cmd → io_v01_sol` assignment
   in its target's lexical convention (Siemens `#`-prefix +
   double-quoted IO; CODESYS / Rockwell unquoted) and the
   lowering breadcrumb `v01 (valve_onoff)`.
4. `runTargetPreflight` returns clean for `valve_onoff` on every
   vendor target — no `READINESS_FAILED`, no
   `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
5. `motor_vfd_simple` (still outside `CORE_SUPPORTED_EQUIPMENT`)
   throws `READINESS_FAILED` with
   `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` on every vendor
   target. Sprint 87A → 88C did not accidentally open the rest of
   the equipment set.
6. No backend synthesises `v01_close_cmd` / `v01_close_out` /
   `v01_fb_open` / `v01_fb_closed` / `v01_busy` / `v01_done` /
   `v01_position`, and no backend drives `v01.fault := …` from
   the lowering.
7. Every manifest is clean of `UNSUPPORTED_*` /
   `READINESS_FAILED` / `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`
   for `valve_onoff`. Rockwell still carries
   `ROCKWELL_EXPERIMENTAL_BACKEND` (legacy global diagnostic;
   intentional, not target-of-this-sprint).
8. Generation is deterministic across two runs of the same
   fixture for every target.

The spec is parametrised over targets, so the assertion grid is
8 logical tests × 3 targets = **22 effective tests** in a single
spec file (some tests are vendor-cross-cutting and run once each).

## What this sprint does NOT guarantee

- **No safety semantics.** The spec asserts shape, not correctness
  for any operator-grade safety standard. `valve_onoff` is a
  structural support claim, never a vendor-certification claim.
- **No coverage for non-`valve_onoff` parity.** The pneumatic
  cylinder + simple motor parity bars live in
  `backend-equivalence.spec.ts`. Sprint 88D layers on top of them.
- **No automatic codegen.** `valve_onoff` still requires explicit
  operator action.
- **No assumption promotion** — the fixture binds `solenoid_out`
  explicitly.
- **No rollup over equipment kinds.** A future `motor_vfd_simple`
  audit (Sprint 88E or later) would add its own parametrised
  parity spec, not extend this one.

## Targets covered

| Target | Type artifact | Station FB | Bool token |
|---|---|---|---|
| CODESYS | `codesys/DUT_ValveOnoff.st` | `codesys/FB_StDose.st` | `BOOL` |
| Siemens | `siemens/UDT_ValveOnoff.scl` | `siemens/FB_StDose.scl` | `Bool` |
| Rockwell | `rockwell/UDT_ValveOnoff.st` | `rockwell/FB_StDose.st` | `BOOL` |

## Manual verification checklist

For each backend, generate the same fixture via CLI:

```sh
pnpm --filter @plccopilot/cli exec plc-codegen \
    generate --backend codesys  --in path/to/valve.pir.json --out out/codesys
pnpm --filter @plccopilot/cli exec plc-codegen \
    generate --backend siemens  --in path/to/valve.pir.json --out out/siemens
pnpm --filter @plccopilot/cli exec plc-codegen \
    generate --backend rockwell --in path/to/valve.pir.json --out out/rockwell
```

Confirm:

- [ ] `<target>/<DUT|UDT>_ValveOnoff.<st|scl>` exists with
      `cmd_open` and `fault` and **no** other fields.
- [ ] `<target>/FB_StDose.<st|scl>` contains an `io_v01_sol :=
      v01_open_cmd` (or quoted `#`-prefixed Siemens equivalent)
      assignment and the comment `v01 (valve_onoff)`.
- [ ] No `cmd_close` / `fb_open` / `busy` / `done` / `position`
      identifiers anywhere in the rendered code or type artifacts.
- [ ] Manifest contains no `UNSUPPORTED_*` /
      `READINESS_FAILED`. Rockwell still carries
      `ROCKWELL_EXPERIMENTAL_BACKEND` — that is legacy and not in
      scope here.
- [ ] Swap `equipment[0].type` to `motor_vfd_simple` and rerun
      each backend; every backend should error with
      `READINESS_FAILED` (CLI exit code non-zero, error references
      `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`).

## Relation to 87A / 87C / 88C

```
            valve_onoff support           parity bar
            ────────────────────         ─────────────
CODESYS  ───┤ Sprint 87A                  Sprint 88D
            │ widened readiness           ↑   reads
Siemens   ──┤ Sprint 87C                  │   the same
            │ widened after SCL audit     │   fixture
Rockwell ───┤ Sprint 88C                  │   through
              widened after Logix audit   ↓   all three
                                          ─── targets
```

If a future sprint changes any backend's `valve_onoff` rendering
(field names, FB body shape, manifest diagnostics, artifact paths),
this integration spec is the first place it will fail. The fix
should be either (a) propagate the change to the other two
backends so parity holds, or (b) explicitly document the
divergence and tighten the per-target spec — never relax the
parity bar to make the spec green.

## Closeout: Sprint 88D

- **Production code touched:** none. Pure test + docs sprint.
- **Tests added:** 1 spec file × 22 effective tests inside
  `@plccopilot/codegen-integration-tests` (109 → 131).
- **Repo total tests:** 3,454 → 3,476 (`+22`).
- **Gates:**
  - `pnpm --filter @plccopilot/codegen-integration-tests typecheck` ✅
  - `pnpm --filter @plccopilot/codegen-integration-tests test` ✅
  - `pnpm --filter @plccopilot/codegen-core test` ✅
  - `pnpm --filter @plccopilot/codegen-codesys test` ✅
  - `pnpm --filter @plccopilot/codegen-siemens test` ✅
  - `pnpm --filter @plccopilot/codegen-rockwell test` ✅
  - `pnpm -r typecheck` ✅
  - `pnpm -r test` ✅ (per-package; documented Windows pdfjs
    shutdown flake on `electrical-ingest` reproduced once during
    the recursive driver, cleared on per-package re-run — same
    pattern documented since Sprint 84)
  - `pnpm publish:audit --check` ✅
  - `pnpm run ci` ✅ exit 0

## Recommended next sprints

- **88E** — `motor_vfd_simple` audit on the first vendor
  renderer (likely CODESYS). Same template as 87A: audit first,
  widen readiness only if the renderer is structurally agnostic,
  ship a per-package support spec, then a follow-up integration
  parity spec mirroring 88D.
- **89** — Operator-driven controlled codegen preview (web UX),
  if real operators are ready for explicit per-target preview.
- **Pause-and-listen** — if no operator demand for further
  equipment kinds, pause codegen widening and route effort back
  to ingestion / review UX.

[spec]: ../packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts
