# Sprint 88K — Cross-renderer integration parity bar for `motor_vfd_simple`

Status: closed locally (gates green; not pushed).
Sister sprints: 88E (audit, support deferred), 88F (Option A design),
88G (PIR + codegen-core lowering), 88H (CODESYS audit + widening),
88I (Siemens audit + widening), 88J (Rockwell audit + widening, full
convergence), **88L** (electrical-ingest parameter ingestion —
pending).

## Why this sprint exists

Sprints 88H/88I/88J each shipped a per-package end-to-end spec
that pins the per-target shape for `motor_vfd_simple`:

- [`packages/codegen-codesys/tests/motor-vfd-simple.spec.ts`](../packages/codegen-codesys/tests/motor-vfd-simple.spec.ts)
- [`packages/codegen-siemens/tests/motor-vfd-simple.spec.ts`](../packages/codegen-siemens/tests/motor-vfd-simple.spec.ts)
- [`packages/codegen-rockwell/tests/motor-vfd-simple.spec.ts`](../packages/codegen-rockwell/tests/motor-vfd-simple.spec.ts)

What none of those guard is **parity across the three production
backends**. Sprint 88K adds that bar at integration scope, exactly
as Sprint 88D did for `valve_onoff`.

## What this sprint guarantees

The new spec
[`packages/codegen-integration-tests/tests/motor-vfd-simple-universal-support.spec.ts`][spec]
takes one PIR fixture (single station, single
`motor_vfd_simple`, one bool `run_out`, one numeric
`speed_setpoint_out`, one machine-level numeric `Parameter` named
`p_m01_speed`, with `io_setpoint_bindings.speed_setpoint_out →
p_m01_speed`) and runs it through CODESYS, Siemens, and Rockwell.
Every assertion is parametrised over the three vendor targets.

1. **Generation succeeds** — every backend returns a non-empty
   artifact list with the expected type artifact, station FB, and
   manifest paths.
2. **Type artifact field set is identical**: every backend emits
   exactly `cmd_run`, `speed_setpoint`, and `fault` (with the
   target's bool/real lexical convention — `BOOL`/`REAL` on
   CODESYS / Rockwell, `Bool`/`Real` on Siemens). None of
   `cmd_open`, `cmd_close`, `fb_open`, `fb_closed`, `busy`,
   `done`, `position`, `reset`, `reverse`, `jog`, `permissive`,
   `ramp` appear in the type artifact.
3. **Run assignment** — each backend wires the run command into
   `io_m01_run` in its target's lexical convention (Siemens
   `"…"` / `#`, CODESYS / Rockwell bare).
4. **Setpoint assignment from Parameter** — each backend wires
   the bound `p_m01_speed` parameter into `io_m01_speed_aw`. The
   RHS is **never** a numeric literal or a boolean literal: a
   target-specific regex against `io_m01_speed_aw := <number>;`
   and `io_m01_speed_aw := TRUE/FALSE;` (with each target's
   quoting style) must NOT match.
5. **Lowering breadcrumbs preserved** — every backend keeps the
   IR-level `mot01 (motor_vfd_simple): run_cmd -> run_out` and
   `mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out`
   comments verbatim.
6. **No synthesised safety / control signals** — code artifacts
   (`.st` / `.scl`) carry none of `mot01_close*`, `mot01_fb_*`,
   `mot01_busy`, `mot01_done`, `mot01_position`, `mot01_reverse`,
   `mot01_reset`, `mot01_jog`, `mot01_permissive`, `mot01_ramp`,
   and no `mot01[._]fault := …` assignment. (The DUT/UDT
   declares `fault : BOOL` itself — the test only forbids
   *driving* it.)
7. **Manifest cleanliness** — every backend's manifest carries
   no `UNSUPPORTED_*` / `READINESS_FAILED` /
   `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` for
   `motor_vfd_simple`. Rockwell still carries
   `ROCKWELL_EXPERIMENTAL_BACKEND` (legacy, intentional).
8. **Preflight parity** — `runTargetPreflight` returns clean for
   every vendor target; `pneumatic_cylinder_1pos` (still outside
   `CORE_SUPPORTED_EQUIPMENT`) keeps throwing
   `READINESS_FAILED` + `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`
   on every vendor target.
9. **Determinism** — two runs of each backend produce
   byte-identical artifact paths and contents, and stable
   manifest diagnostic codes.
10. **No duplicate paths** — each backend returns unique artifact
    paths.

The spec is parametrised over targets, so the assertion grid is
33 effective tests in a single spec file (10 logical assertions
× 3 targets, plus a few cross-target single-its for determinism
and uniqueness).

## What this sprint does NOT guarantee

- **No safety semantics.** The spec asserts shape, not
  correctness for any operator-grade safety standard.
  `motor_vfd_simple` is a structural support claim, never a
  vendor-certification claim.
- **No new equipment kind support.** Sprint 88K is tests-only;
  production code is untouched.
- **No PIR change.** `io_setpoint_bindings` and R-EQ-05 (Sprint
  88G) are unchanged.
- **No assumption promotion.** The fixture binds a real
  numeric `Parameter` for the speed setpoint; the spec
  pins that the lowering never substitutes a literal.
- **No address synthesis.**
- **No automatic codegen from web.**
- **No ingestion-side parameter extraction.** Operators still
  author `Parameter`s by hand until Sprint 88L.

## Targets covered

| Target | Type artifact | Station FB | Bool token | Real token |
|---|---|---|---|---|
| CODESYS | `codesys/DUT_MotorVfdSimple.st` | `codesys/FB_StRun.st` | `BOOL` | `REAL` |
| Siemens | `siemens/UDT_MotorVfdSimple.scl` | `siemens/FB_StRun.scl` | `Bool` | `Real` |
| Rockwell | `rockwell/UDT_MotorVfdSimple.st` | `rockwell/FB_StRun.st` | `BOOL` | `REAL` |

## Manual verification checklist

For each backend, generate the same fixture via CLI:

```sh
pnpm --filter @plccopilot/cli exec plc-codegen \
    generate --backend codesys  --in vfd.pir.json --out out/codesys
pnpm --filter @plccopilot/cli exec plc-codegen \
    generate --backend siemens  --in vfd.pir.json --out out/siemens
pnpm --filter @plccopilot/cli exec plc-codegen \
    generate --backend rockwell --in vfd.pir.json --out out/rockwell
```

Confirm:

- [ ] `<target>/<UDT|DUT>_MotorVfdSimple.<st|scl>` exists with
      `cmd_run`, `speed_setpoint`, `fault`.
- [ ] `<target>/FB_StRun.<st|scl>` contains the run assignment
      (`io_m01_run := mot01_run_cmd` in the target's lexical
      convention) and the setpoint assignment
      (`io_m01_speed_aw := p_m01_speed` from the bound parameter).
- [ ] No `cmd_open` / `fb_open` / `busy` / `done` / `position` /
      `reset` / `reverse` / `jog` / `permissive` / `ramp`
      identifiers anywhere in the rendered code or type
      artifacts.
- [ ] Manifest contains no `UNSUPPORTED_*` /
      `READINESS_FAILED`. Rockwell still carries
      `ROCKWELL_EXPERIMENTAL_BACKEND`.
- [ ] Swap `equipment[0].type` to `pneumatic_cylinder_1pos` and
      rerun each backend; every backend should error with
      `READINESS_FAILED` (CLI exit code non-zero, error
      references `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`).

## Relation to 88G / 88H / 88I / 88J

```
                motor_vfd_simple support              parity bar
                ──────────────────────────         ─────────────
PIR + core   ───┤ Sprint 88G                        Sprint 88K
                │ io_setpoint_bindings,             ↑   reads
                │ wireMotorVfdSimple                │   the same
CODESYS      ───┤ Sprint 88H                        │   fixture
                │ widened after audit               │   through
Siemens      ───┤ Sprint 88I                        │   all three
                │ widened after SCL audit           │   targets
Rockwell     ───┤ Sprint 88J                        ↓
                  widened after Logix audit         ─── done
```

If a future sprint changes any backend's `motor_vfd_simple`
rendering (field names, FB body shape, manifest diagnostics,
artifact paths, or — crucially — introduces a synthesised
literal as the speed setpoint source), this integration spec is
the first place it will fail. The fix should be either (a)
propagate the change to the other two backends so parity holds,
or (b) explicitly document the divergence and tighten the
per-target spec — never relax the parity bar to make the spec
green.

## Closeout: Sprint 88K

- **Production code touched:** none. Pure test + docs sprint.
- **Tests added:** 1 spec file × 33 effective tests inside
  `@plccopilot/codegen-integration-tests` (132 → 165).
- **Repo total tests:** 3,535 → 3,568 (`+33`).
- **Gates:**
  - `pnpm --filter @plccopilot/codegen-integration-tests typecheck` ✅
  - `pnpm --filter @plccopilot/codegen-integration-tests test` ✅ 165 passed
  - `pnpm --filter @plccopilot/codegen-core test` ✅ 771 passed
  - `pnpm --filter @plccopilot/codegen-codesys test` ✅ 63 passed
  - `pnpm --filter @plccopilot/codegen-siemens test` ✅ 184 passed
  - `pnpm --filter @plccopilot/codegen-rockwell test` ✅ 78 passed
  - `pnpm -r typecheck` ✅
  - `pnpm publish:audit --check` ✅
  - `pnpm run ci` ✅ exit 0 (with the documented Windows pdfjs
    shutdown flake on `electrical-ingest`'s recursive-driver
    run; per-package isolated re-run is clean — 672 passed).

## Recommended next sprint

**Sprint 88L — electrical-ingest parameter extraction for
`motor_vfd_simple`.** Closes the operator-authored-parameters-only
constraint by ingesting parameters from CSV / EPLAN / TcECAD
where the source carries numeric metadata (range / unit /
default). Once 88L lands, a real ingestion path can supply the
bound `Parameter` end-to-end.

Alternative if VFD ingestion is not a near-term priority:

- **Sprint 89** — controlled codegen preview UX (web).
- **Pause-and-listen** — route effort back to ingestion / review
  UX based on actual operator demand.

[spec]: ../packages/codegen-integration-tests/tests/motor-vfd-simple-universal-support.spec.ts
