# Sprint 87C — Siemens valve_onoff support after SCL renderer audit

> **Status: second per-target equipment-support widening.**
> Sprint 87A added `valve_onoff` for CODESYS only; Siemens and
> Rockwell rejected the kind via `READINESS_FAILED` +
> `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`. Sprint 87C audits
> the Siemens SCL renderer and confirms it is structurally
> equipment-kind-agnostic, so widening Siemens's readiness
> capability table — plus a one-line addition to the
> `UDT_NAMES` public helper — is enough to ship `valve_onoff`
> for Siemens. Rockwell stays narrow until its Logix renderer is
> audited the same way.

## What changed

| Decision | Value |
| --- | --- |
| Equipment kind | `valve_onoff` (already in PIR's `EquipmentType` union; lowering + DUT shipped in Sprint 87A) |
| Newly-supported target | `siemens` |
| Targets that still support | `codesys` (Sprint 87A), `core` (vendor-neutral baseline) |
| Targets that still reject | `rockwell` (Logix renderer not yet audited) |

No new lowering, no new DUT shape, no new safety semantics — Sprint 87A's `wireValveOnoff` (one assignment per active state, role binding `solenoid_out`, single `open` activity) and `UDT_ValveOnoff` (`cmd_open : Bool`, `fault : Bool`) carry through unchanged.

## SCL renderer audit (full evidence)

The audit confirmed Siemens is **structurally agnostic** to equipment kind. Concrete findings:

1. **No equipment-type switch in the renderer.** `packages/codegen-siemens/src/**` contains zero `switch (eq.type)` blocks. The only kind-specific table is `UDT_NAMES` in [`packages/codegen-siemens/src/naming.ts`](../packages/codegen-siemens/src/naming.ts) — a public-helper lookup, not part of the actual UDT generation path.
2. **UDT rendering is IR-driven.** [`packages/codegen-siemens/src/compiler/renderers/types.ts`](../packages/codegen-siemens/src/compiler/renderers/types.ts) walks `TypeArtifactIR.fields` directly. The IR is produced by core's `buildEquipmentTypesIR`, which Sprint 87A already taught about `valve_onoff`.
3. **Station FB body is IR-driven.** `lowerStation` returns `StmtIR[]`; Siemens `renderStmt` emits `target := expr;` for `Assign` nodes with no per-kind logic. `wireValveOnoff`'s `solenoid_out := <eq>_open_cmd` flows through unchanged.
4. **`buildSymbolTable` is per-kind agnostic.** Symbol context indexes equipment by id only.
5. **Manifest is per-kind agnostic.** Just lists artifact paths.
6. **Canonical naming is shared.** Siemens consumes `canonicalTypeName` from core; the deprecated `siemensTypeName` is a back-compat alias. `UDT_ValveOnoff` (already in core's `CANONICAL_NAME` since Sprint 87A) flows through unchanged.

**Verdict from the audit**: widening the readiness capability set in `codegen-core/src/readiness/codegen-readiness.ts` plus adding `valve_onoff` to `UDT_NAMES` for public-helper consistency is sufficient. No renderer changes.

## Minimal lowering contract (unchanged from Sprint 87A)

Pinned by [`packages/codegen-siemens/tests/valve-onoff.spec.ts`](../packages/codegen-siemens/tests/valve-onoff.spec.ts):

- **DUT** — `siemens/UDT_ValveOnoff.scl` containing exactly:
  - `cmd_open : Bool;`
  - `fault : Bool;`
  - No `cmd_close`, no `fb_open`, no `busy`, no fault latching.
- **Station FB** — emits `#<eq>_open_cmd : BOOL;` declaration plus a deterministic `"<eq.solenoid_out>" := #<eq>_open_cmd;` assignment when the active state's `activity.activate` includes `<eq.id>.open`.
- **No close output** — spring-return assumed; the lowering does not synthesise a close coil.
- **Missing `solenoid_out` binding** still surfaces as `UNBOUND_ROLE` (Sprint 76 contract).
- **Manifest carries no `UNSUPPORTED_*` / `READINESS_FAILED` compiler diagnostics** for a clean `valve_onoff` project.
- **Generation is deterministic across runs** (byte-identical artifacts when the same project + clock are passed).

## Readiness behaviour — before vs after

| Caller | Pre-87C | Sprint 87C |
| --- | --- | --- |
| `compileProject(p)` directly with `valve_onoff` | Accepts (Sprint 87A widened core) | Accepts (unchanged) |
| `generateCodesysProject(p)` | Succeeds (87A) | Succeeds |
| `generateSiemensProject(p)` | **Throws `READINESS_FAILED`** | **Succeeds; emits Siemens artifacts** |
| `generateRockwellProject(p)` | Throws `READINESS_FAILED` | Throws `READINESS_FAILED` (unchanged) |
| `preflightProject(p, { target: 'core' })` | Clean | Clean |
| `preflightProject(p, { target: 'codesys' })` | Clean | Clean |
| `preflightProject(p, { target: 'siemens' })` | Error: unsupported equipment | **Clean** |
| `preflightProject(p, { target: 'rockwell' })` | Error: unsupported equipment | Error: unsupported equipment |

## Files touched

**`@plccopilot/codegen-core`** (.ts + .js mirrors)
- `src/readiness/codegen-readiness.ts` — capability table split: `siemens` widens to `CORE_SUPPORTED_EQUIPMENT`; the legacy `SIEMENS_ROCKWELL_SUPPORTED_EQUIPMENT` set was renamed to `ROCKWELL_SUPPORTED_EQUIPMENT` and now serves Rockwell only.
- `tests/codegen-readiness.spec.ts` — Sprint 87A per-target tests updated (Siemens accepts; Rockwell still blocks; capability table assertions reflect the new split; `runTargetPreflight` no-throw on Siemens).

**`@plccopilot/codegen-siemens`** (.ts + .js mirrors)
- `src/naming.ts` — `UDT_NAMES` adds `valve_onoff: 'UDT_ValveOnoff'` for public-helper consistency.
- `tests/valve-onoff.spec.ts` (NEW, 7 tests) — replaces the Sprint 87A rejection spec with an end-to-end support spec covering UDT shape, station FB wiring, deterministic re-runs, public `udtName` lookup, manifest cleanliness, and the unchanged `UNBOUND_ROLE` contract for a missing binding.
- `tests/valve-onoff-rejection.spec.ts` (DELETED).

**`@plccopilot/codegen-rockwell`**
- `tests/valve-onoff-rejection.spec.ts` (UNCHANGED) — Sprint 87A's Rockwell rejection spec stays load-bearing for Sprint 87C.

**`@plccopilot/web`**
- `tests/codegen-readiness-view.spec.ts` — Sprint 87A `valve_onoff` tests updated: Siemens now expects `ready`; Rockwell expects `blocked`. Hint / message assertions point at Rockwell instead of Siemens.

**`@plccopilot/cli`**
- `tests/generate.spec.ts` — the existing `[READINESS_FAILED]` test was using `valve_onoff` against `siemens`, which now succeeds. Switched the test to invoke `--backend rockwell` (the only target that still rejects `valve_onoff`) so the rich error UX is still exercised end-to-end.

**Docs**
- `docs/codegen-equipment-support-sprint-87C.md` (NEW).
- `docs/electrical-ingestion-architecture.md` — refreshed status + Sprint 87C note.

No `@plccopilot/codegen-codesys` changes. No `@plccopilot/electrical-ingest` / `@plccopilot/pir` changes. No new schema entries. No worker-protocol change.

## Test / gate summary

| Package | Pre-87C | Sprint 87C | Notes |
| --- | --- | --- | --- |
| `@plccopilot/codegen-core` | 755 | 755 | 0 net (existing readiness tests updated, no new tests) |
| `@plccopilot/codegen-codesys` | 52 | 52 | unchanged |
| `@plccopilot/codegen-siemens` | 166 | **172** | -1 (deleted rejection spec) +7 (new support spec) |
| `@plccopilot/codegen-rockwell` | 60 | 60 | unchanged (Sprint 87A rejection spec carries through) |
| `@plccopilot/codegen-integration-tests` | 109 | 109 | unchanged |
| `@plccopilot/cli` | 757 | 757 | 0 net (existing test reframed to Rockwell) |
| `@plccopilot/electrical-ingest` | 650 | 650 | unchanged |
| `@plccopilot/web` | 832 | 832 | 0 net (existing Sprint 87A tests retargeted) |
| `@plccopilot/pir` | 36 | 36 | unchanged |
| **Repo total** | **3,417** | **3,423** | **+6 net** |

Gates green: `pnpm -r typecheck`, `pnpm -r test`, `pnpm publish:audit --check`, `pnpm run ci`. No flakes observed on this run.

## Honest constraints

- **No new equipment support.** Only Siemens widens to match Sprint 87A's CODESYS capability for `valve_onoff`. Other unsupported PIR kinds (`pneumatic_cylinder_1pos`, `motor_vfd_simple`, `sensor_analog`, `indicator_light`, `supervisor`) still rejected by every target.
- **Rockwell does NOT gain `valve_onoff` support.** Logix renderer audit is future work.
- **No safety logic generation.** Spring return assumed; no close output, no position feedback, no fault latching synthesised. The DUT exposes a `fault` bit but the lowering does not drive it.
- **No automatic codegen from web.** Generate stays explicit; Sprint 87B readiness panel surfaces the new "Siemens ready" state operator-side.
- **No assumption promotion / address synthesis / role guessing.** Missing `solenoid_out` binding fires `UNBOUND_ROLE` with the canonical JSON path.
- **No target certification.** Sprint 87C documents that Siemens *renders* `valve_onoff` deterministically; it does not promise vendor compliance.
- **`.ts` / `.js` source-tree mirrors maintained** for `codegen-core/readiness` and `codegen-siemens/naming`.
- **Web UX unchanged.** The Sprint 87B `CodegenReadinessPanel` automatically picks up the widened Siemens capability without any UI change.

## Operator manual verification

1. Hand-build / re-use a PIR fixture with one `valve_onoff` bound to `solenoid_out` and `state.activity.activate = ['valveId.open']` (the same fixture from Sprint 87A's manual checklist).
2. `pnpm cli generate --backend siemens --input <valve_onoff_fixture>.json --out /tmp/siemens-valve` — should exit `0`. Verify `/tmp/siemens-valve/siemens/UDT_ValveOnoff.scl` exists with the documented field set, and `siemens/FB_<station>.scl` contains:
   - the local declaration `<eq>_open_cmd : BOOL;`
   - the deterministic assignment `"<eq.solenoid_out>" := #<eq>_open_cmd;`
   - no `close`, `feedback`, or fault-latch text.
3. `pnpm cli generate --backend codesys --input <valve_onoff_fixture>.json` — still exits `0` (Sprint 87A unchanged).
4. `pnpm cli generate --backend rockwell --input <valve_onoff_fixture>.json` — should exit `1`, stderr `[READINESS_FAILED] … READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET …` naming `valve_onoff` and target `rockwell`.
5. Web flow: `pnpm web:dev`, load the `valve_onoff` PIR. Sprint 87B Codegen Readiness panel should show:
   - `siemens` → **Ready**.
   - `codesys` → **Ready**.
   - `rockwell` → **Blocked** with the equipment-kind-not-supported group naming `valve_onoff` + `rockwell`.
   - With `backend = 'all'`, three stacked cards: two ready + one blocked.
6. Confirm Generate stays explicit. Click Generate with `siemens` selected — artifacts should download cleanly. Click with `rockwell` — the existing Sprint 86 banner still surfaces `[READINESS_FAILED]`.

## Recommended next sprint

1. **Sprint 87D — controlled codegen preview** stays deferred until 87B + 87C have had real operator exposure.
2. **Sprint 88 — Logix renderer audit + Rockwell `valve_onoff` widening**, mirroring 87C. Audit is the gating step; the readiness widening + UDT_NAMES update is mechanical once the audit clears.
3. **Sprint 88 alt — cross-source duplicate detection** if multi-source review sessions surface real duplicate-IO / duplicate-address conflicts.

Default after 87C: pick 88 (Rockwell audit) only when an operator engagement asks for `valve_onoff` on Logix; otherwise hold codegen widening and prefer operator-driven priorities.
