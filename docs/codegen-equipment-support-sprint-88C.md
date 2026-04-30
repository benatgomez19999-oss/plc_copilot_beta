# Sprint 88C — Rockwell valve_onoff support after Logix renderer audit

> **Status: third per-target equipment-support widening.**
> Sprint 87A added `valve_onoff` for CODESYS only; Sprint 87C
> widened Siemens after the SCL renderer audit. Sprint 88C
> audits the Rockwell/Logix renderer, finds it structurally
> agnostic to equipment kind, and widens Rockwell's readiness
> capability table to ship `valve_onoff`. With this sprint,
> all four codegen targets (`core`, `siemens`, `codesys`,
> `rockwell`) converge on the same supported equipment set —
> the `ROCKWELL_SUPPORTED_EQUIPMENT` "narrow" bucket has no
> remaining purpose and is removed.

## What changed

| Decision | Value |
| --- | --- |
| Equipment kind | `valve_onoff` (PIR `EquipmentType` since baseline; lowering + DUT shipped in Sprint 87A) |
| Newly-supported target | `rockwell` |
| Targets that already supported | `codesys` (Sprint 87A), `siemens` (Sprint 87C), `core` (vendor-neutral baseline) |
| Targets that still reject | none — all four converge on `CORE_SUPPORTED_EQUIPMENT` |

No new lowering, no new DUT shape, no new safety semantics —
Sprint 87A's `wireValveOnoff` (one assignment per active state,
role binding `solenoid_out`, single `open` activity) and
`UDT_ValveOnoff` (`cmd_open : Bool`, `fault : Bool`) carry
through unchanged.

## Logix renderer audit (full evidence)

The audit (read-only, against
[`packages/codegen-rockwell/src/**`](../packages/codegen-rockwell/src))
confirmed Rockwell is **structurally agnostic** to equipment
kind. Concrete findings:

1. **No equipment-type switch in the renderer.** Zero
   `switch (eq.type)` blocks in `codegen-rockwell/src/**`. No
   per-kind branch references `pneumatic_cylinder_2pos`,
   `motor_simple`, or `sensor_discrete` by name.
2. **UDT rendering is field-blind.**
   [`packages/codegen-rockwell/src/renderers/types.ts`](../packages/codegen-rockwell/src/renderers/types.ts)
   `renderTypeArtifactRockwell` iterates `t.fields` directly
   and maps `dataType` strings via a static IEC-type table.
   The Rockwell artifact path is
   `rockwell/${t.name}.st` where `t.name` is whatever core's
   `CANONICAL_NAME` produced (`UDT_ValveOnoff` since Sprint 87A).
3. **Assign rendering is IR-driven.** The Rockwell ST renderer
   emits `target := expr;` for `Assign` StmtIR with no
   per-equipment branch. `wireValveOnoff`'s
   `solenoid_out := <eq>_open_cmd` flows through unchanged.
4. **No Rockwell-side `UDT_NAMES` map.** Unlike Siemens (which
   needed a Sprint 87C entry in
   [`packages/codegen-siemens/src/naming.ts`](../packages/codegen-siemens/src/naming.ts)),
   Rockwell consumes `canonicalTypeName` from core directly.
   Nothing to mirror.
5. **Manifest is per-kind agnostic.** The Rockwell manifest
   carries a flat list of artifact paths; no per-equipment
   metadata.
6. **Rockwell-specific diagnostics are GLOBAL, not per-kind.**
   `ROCKWELL_EXPERIMENTAL_BACKEND`, `ROCKWELL_TIMER_PSEUDO_IEC`,
   `ROCKWELL_NO_L5X_EXPORT` are document-level flags, never
   gated on equipment type. `valve_onoff` does not introduce a
   timer or any new IEC construct, so none of these change.
7. **No AOI/UDT distinction in the POC renderer.** Rockwell
   emits text-based UDT syntax only (`TYPE … STRUCT … END_TYPE`
   inside a `*Rockwell UDT POC*` comment block). All kinds —
   cylinder, motor, valve — land in the same envelope.

**Verdict from the audit**: widening Rockwell's capability set
in `codegen-core/src/readiness/codegen-readiness.ts` is
**sufficient to ship `valve_onoff` for Rockwell**. Zero
renderer changes required. No `UDT_NAMES` mirror work
required (Rockwell has no such map).

## Minimal lowering contract (unchanged from Sprints 87A / 87C)

Pinned by [`packages/codegen-rockwell/tests/valve-onoff.spec.ts`](../packages/codegen-rockwell/tests/valve-onoff.spec.ts):

- **UDT** — `rockwell/UDT_ValveOnoff.st` containing exactly:
  - `cmd_open : BOOL;`
  - `fault : BOOL;`
  - No `cmd_close`, no `fb_open`, no `busy`, no fault latching.
- **Station FB** — emits a deterministic
  `io_v01_sol := v01_open_cmd` assignment when the active
  state's `activity.activate` includes `<eq.id>.open`. The
  lowering comment `v01 (valve_onoff)` carries the canonical
  audit breadcrumb.
- **No close output** — spring-return assumed; no close coil
  synthesised.
- **Missing `solenoid_out` binding** still surfaces as
  `UNBOUND_ROLE` (Sprint 76 contract).
- **Manifest carries the existing
  `ROCKWELL_EXPERIMENTAL_BACKEND` info** but no
  `UNSUPPORTED_*` / `READINESS_FAILED` compiler diagnostics
  for a clean `valve_onoff` project.
- **Generation is deterministic** (byte-identical artifacts
  when the same project + clock are passed twice).
- **No duplicate artifact paths**.

## Readiness behaviour — before vs after

| Caller | Pre-88C | Sprint 88C |
| --- | --- | --- |
| `compileProject(p)` directly with `valve_onoff` | Accepts (Sprint 87A widened core) | Accepts (unchanged) |
| `generateCodesysProject(p)` | Succeeds (Sprint 87A) | Succeeds (unchanged) |
| `generateSiemensProject(p)` | Succeeds (Sprint 87C) | Succeeds (unchanged) |
| `generateRockwellProject(p)` | **Throws `READINESS_FAILED`** | **Succeeds; emits Rockwell artifacts** |
| `preflightProject(p, { target: 'rockwell' })` | Error: unsupported equipment | **Clean** |
| `preflightProject(p, { target: 'rockwell' })` with `motor_vfd_simple` (still unsupported) | Error: unsupported equipment | Error: unsupported equipment (unchanged — exercises the rejection UX) |

The Sprint 86 `READINESS_FAILED` rich-error UX (path,
stationId, symbol, hint) is still load-bearing — it now fires
on PIR equipment kinds genuinely outside any target's
capability set (e.g. `motor_vfd_simple`,
`pneumatic_cylinder_1pos`, `sensor_analog`,
`indicator_light`, `supervisor`). The CLI test that previously
exercised it via `valve_onoff + rockwell` was retargeted to
`motor_vfd_simple + rockwell` so the operator-facing UX is
still pinned end-to-end.

## Files touched

**`@plccopilot/codegen-core`** (.ts + .js mirrors)
- `src/readiness/codegen-readiness.ts` / `.js` — Rockwell uses
  `CORE_SUPPORTED_EQUIPMENT`. The
  `ROCKWELL_SUPPORTED_EQUIPMENT` constant was deleted (no
  remaining purpose); re-introduce when a future kind lands on
  a subset of targets.
- `tests/codegen-readiness.spec.ts` — Rockwell now expected to
  accept; new test 8 confirms `motor_vfd_simple` still
  surfaces `READINESS_FAILED` via `runTargetPreflight`.

**`@plccopilot/codegen-rockwell`**
- `tests/valve-onoff.spec.ts` (NEW, 8 tests) — replaces the
  Sprint 87A rejection spec with an end-to-end support spec
  pinning UDT shape, station FB wiring, deterministic re-runs,
  manifest cleanliness, the unchanged `UNBOUND_ROLE` contract,
  no-duplicate-paths, and absence of close/feedback/fault
  latching.
- `tests/valve-onoff-rejection.spec.ts` (DELETED).
- No `src/**` changes — renderer is structurally agnostic.

**`@plccopilot/web`**
- `tests/codegen-readiness-view.spec.ts` — Sprint 87A/87C
  per-target tests updated: Rockwell now expected `ready`. New
  test 4 covers the unsupported-equipment path on every
  vendor target with `motor_vfd_simple`.

**`@plccopilot/cli`**
- `tests/generate.spec.ts` — `[READINESS_FAILED]` test
  retargeted from `valve_onoff + rockwell` (which now succeeds)
  to `motor_vfd_simple + rockwell`. Same UX assertions; only
  the equipment kind changed.

**Docs**
- `docs/codegen-equipment-support-sprint-88C.md` (NEW).
- `docs/electrical-ingestion-architecture.md` — refreshed
  status + Sprint 88C section.

No `@plccopilot/codegen-codesys` / `@plccopilot/codegen-siemens` /
`@plccopilot/electrical-ingest` / `@plccopilot/pir` source
changes. No worker-protocol change. No web component change.
No schema bump. No PIR mutation.

## Test / gate summary

| Package | Pre-88C | Sprint 88C | Notes |
| --- | --- | --- | --- |
| `@plccopilot/codegen-core` | 755 | **756** | +1 (`runTargetPreflight` `motor_vfd_simple` path) |
| `@plccopilot/codegen-codesys` | 52 | 52 | unchanged |
| `@plccopilot/codegen-siemens` | 172 | 172 | unchanged |
| `@plccopilot/codegen-rockwell` | 60 | **67** | -1 deleted rejection spec, +8 new support spec |
| `@plccopilot/codegen-integration-tests` | 109 | 109 | unchanged |
| `@plccopilot/cli` | 757 | 757 | 0 net (existing test retargeted) |
| `@plccopilot/electrical-ingest` | 672 | 672 | unchanged |
| `@plccopilot/web` | 832 | **833** | +1 (motor_vfd_simple cross-target rejection test loops the three vendor targets — registered as one Vitest case) |
| `@plccopilot/pir` | 36 | 36 | unchanged |
| **Repo total** | **3,445** | **3,454** | **+9 net** |

Gates green: `pnpm -r typecheck`, `pnpm -r test` (per-package
runs all clean; the documented Windows `pnpm -r test` segfault
on pdfjs shutdown is non-deterministic and does not represent
a test failure), `pnpm publish:audit --check`, `pnpm run ci`.

## Honest constraints

- **No new equipment support beyond `valve_onoff` widening to
  Rockwell.** `motor_vfd_simple`, `pneumatic_cylinder_1pos`,
  `sensor_analog`, `indicator_light`, `supervisor` still
  rejected by every target.
- **No safety logic generation, no close output, no position
  feedback, no fault latching.** Spring-return assumed; the
  DUT exposes a `fault` bit but the lowering does not drive it.
- **No automatic codegen from web.** Sprint 87B explicit-action
  gate unchanged.
- **No assumption promotion / address synthesis / role
  guessing.** Missing `solenoid_out` still surfaces
  `UNBOUND_ROLE` (Sprint 76 contract).
- **No target certification.** Rockwell still flags itself
  experimental via `ROCKWELL_EXPERIMENTAL_BACKEND`. Sprint 88C
  documents that Rockwell *renders* `valve_onoff`
  deterministically; it does not promise Studio 5000 import
  fidelity.
- **`.ts` / `.js` source-tree mirrors maintained** for
  `codegen-core/readiness`. No `codegen-rockwell` mirror work
  needed (no source changes there).
- **No worker-protocol / web-component change.** Sprint 87B
  panel reads the widened capability table automatically —
  Rockwell ready for `valve_onoff` becomes visible without UI
  changes.

## Operator manual verification

1. Hand-build / re-use a PIR fixture with one `valve_onoff`
   bound to `solenoid_out` and `state.activity.activate =
   ['valveId.open']`.
2. `pnpm cli generate --backend rockwell --input <fixture>.json
   --out /tmp/rockwell-valve` — should exit `0`. Verify
   `/tmp/rockwell-valve/rockwell/UDT_ValveOnoff.st` exists with
   `cmd_open : BOOL` + `fault : BOOL`, and
   `rockwell/FB_<station>.st` contains:
   - `v01_open_cmd` declaration / use.
   - Deterministic assignment `io_v01_sol := v01_open_cmd`.
   - Lowering comment `v01 (valve_onoff)`.
   - No `close`, `feedback`, or fault-latch text.
3. `pnpm cli generate --backend siemens --input <fixture>.json`
   — still exits `0` (Sprint 87C unchanged).
4. `pnpm cli generate --backend codesys --input <fixture>.json`
   — still exits `0` (Sprint 87A unchanged).
5. `pnpm cli generate --backend rockwell` on a fixture with a
   genuinely unsupported kind (`motor_vfd_simple`) — should
   exit `1` with `[READINESS_FAILED] …
   READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET …` naming the
   kind and target. The same UX surfaces on `--backend siemens`
   / `--backend codesys`.
6. Web flow: `pnpm web:dev`, load the `valve_onoff` PIR. The
   Sprint 87B Codegen Readiness panel should show:
   - `siemens` → **Ready**.
   - `codesys` → **Ready**.
   - `rockwell` → **Ready** (the change).
   - With `backend = 'all'`, three stacked cards, all ready.
   - Swap the kind to `motor_vfd_simple` and the same panel
     shows three stacked cards, all blocked, with the new
     unsupported-equipment groups.
7. Confirm Generate stays explicit. Click Generate with
   `rockwell` selected — artifacts download cleanly.
8. PDF / TcECAD / EPLAN / CSV ingestion paths unchanged.
9. Sprint 88A cross-source duplicate diagnostics still fire
   when applicable; Sprint 88C does not interact with that
   path.

## Recommended next sprint

1. **Sprint 89A — controlled codegen preview** in web. After
   Sprints 87B (readiness UX) + 87A/87C/88C (per-target
   widening) + 88A (cross-source detection), the codegen-side
   guarantees are solid enough to consider a *preview* layer
   that shows operators what artifacts would be emitted before
   they download. Defer until at least one real engagement
   has used the existing flow.
2. **Sprint 89B — multi-source review session UX / import
   bundle** — the UX layer on top of Sprint 88A's audit. Only
   if operators ask to combine CSV + EPLAN + TcECAD + PDF in
   one session.
3. **Sprint 89C — next equipment-kind support** — only with
   concrete operator demand. Candidate kinds (still
   unsupported on every target): `pneumatic_cylinder_1pos`,
   `motor_vfd_simple`, `sensor_analog`, `indicator_light`,
   `supervisor`.

**Default after 88C**: hold codegen widening. Sprint 87A → 88C
shipped the v0 valve_onoff path on every vendor target plus
the readiness UX + cross-source audit layer. The system is now
load-bearing across the full `review → PIR → codegen` arc; the
right next move is to wait for real operator feedback before
expanding scope. If forced to pick blind, prefer 89A
(controlled codegen preview) over equipment-kind expansion —
it makes the existing widening *visible* to operators, while
89C adds new code surface without operator signal.
