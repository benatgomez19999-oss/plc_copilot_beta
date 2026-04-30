# Sprint 88E — `motor_vfd_simple` audit (CODESYS first); support deferred

Status: closed at **camino A — support deferred** (no widening, audit-only).
Sister sprints: 87A (CODESYS valve_onoff support), 87C (Siemens valve_onoff support after SCL audit), 88C (Rockwell valve_onoff support after Logix audit), 88D (cross-renderer parity bar).

## TL;DR

- The CODESYS / Siemens / Rockwell renderers are all structurally agnostic for `motor_vfd_simple` (no per-kind switches; same shape as the three valve_onoff audits).
- **The blocker is in PIR, not in the renderers.** `motor_vfd_simple` requires a numeric output role `speed_setpoint_out` that no PIR activity verb or parameter→role binding can drive. Wiring it would require either *value synthesis* (forbidden) or *leaving a required output dangling on a real-world VFD* (industrial risk).
- **Decision: park at audit-only.** No readiness widening. Re-open the audit only after a future sprint adds an explicit numeric-setpoint source mechanism in PIR.
- A single regression test now pins the decision at the capability-table layer:
  [`packages/codegen-core/tests/codegen-readiness.spec.ts`](../packages/codegen-core/tests/codegen-readiness.spec.ts) — `Sprint 88E motor_vfd_simple audit decision (support deferred)`.

## 1. PIR shape under audit

Source: [`packages/pir/src/domain/shapes/equipment.ts`](../packages/pir/src/domain/shapes/equipment.ts) (lines 37–44):

```ts
motor_vfd_simple: {
  type: 'motor_vfd_simple',
  required_io: ['run_out', 'speed_setpoint_out'],
  optional_io: ['running_fb', 'fault_fb', 'speed_fb'],
  required_timing: [],
  optional_timing: ['start_timeout_ms', 'stop_timeout_ms'],
  allowed_activities: ['run'],
}
```

Validator data classes ([`packages/pir/src/validators/rules/equipment.ts`](../packages/pir/src/validators/rules/equipment.ts) lines 26–27):

```ts
if (role === 'speed_setpoint_out') return { direction: 'out', dataClass: 'numeric' };
if (role === 'speed_fb')           return { direction: 'in',  dataClass: 'numeric' };
```

So PIR mandates that a `motor_vfd_simple` must bind:

- a `bool` `run_out` digital output (start/stop coil), and
- a `numeric` `speed_setpoint_out` output (the speed reference itself — typically an analog channel or a fieldbus word).

It permits exactly **one activity verb**: `run`.

## 2. The role-versus-activity gap

`run` is boolean. The only thing the sequence layer can produce for a `motor_vfd_simple.run` activity is a boolean command (mirroring how `motor_simple` lowers a `run` activity into `run_out := run_cmd`).

Nothing in PIR — neither activities, nor parameters, nor recipes — exposes a numeric value to the lowering layer in a way that the sequence FB can write into `speed_setpoint_out` deterministically.

This is the **blocker**. To wire `speed_setpoint_out` v0, the lowering would have to choose one of:

| Option | What it means | Verdict |
|---|---|---|
| **(a) Synthesize a constant** (e.g. `speed_setpoint_out := 0` or `100`) | The lowering invents a number that PIR did not specify. | **Forbidden** by sprint contract: no assumption promotion, no role guessing. |
| **(b) Leave the field dangling** (declare `speed_setpoint` in DUT, never assign to it) | A required *output* role becomes a value the program never writes. On real hardware this means: the VFD reads whatever the analog/fieldbus channel happens to carry — typically zero, sometimes a stale word from a prior commissioning. | **Industrial risk.** A motor that runs at zero speed setpoint will trip on undervoltage or stall, and one that runs at a stale setpoint can ramp at unsafe speed. Either failure mode would land in production-equivalent code. |
| **(c) Add a PIR-level setpoint source** (new role like `speed_setpoint_param: <param_id>`, or a numeric-value activity verb) | A clean fix, but a **PIR schema change**, which is explicitly out of scope for this sprint. | **Out of scope.** |

None of (a) / (b) / (c) is safe to ship inside Sprint 88E's contract.

## 3. Renderer audit (clean)

For completeness — the renderer side is **not** the blocker. The audit confirmed each backend is structurally agnostic, exactly like 87A / 87C / 88C found:

| Backend | Renderer file | Per-kind switch? | UDT_NAMES map? |
|---|---|---|---|
| CODESYS | [`packages/codegen-codesys/src/renderers/types.ts`](../packages/codegen-codesys/src/renderers/types.ts), [`packages/codegen-codesys/src/renderers/codesys-st.ts`](../packages/codegen-codesys/src/renderers/codesys-st.ts) | No | No |
| Siemens | [`packages/codegen-siemens/src/compiler/renderers/types.ts`](../packages/codegen-siemens/src/compiler/renderers/types.ts), [`packages/codegen-siemens/src/compiler/renderers/scl.ts`](../packages/codegen-siemens/src/compiler/renderers/scl.ts) | No | No |
| Rockwell | [`packages/codegen-rockwell/src/renderers/types.ts`](../packages/codegen-rockwell/src/renderers/types.ts), [`packages/codegen-rockwell/src/renderers/rockwell-st.ts`](../packages/codegen-rockwell/src/renderers/rockwell-st.ts) | No | No |

Each renderer iterates `TypeArtifactIR.fields` blindly and translates `StmtIR.Assign` lexically. They will render any IR the lowering produces. **They are not what's holding `motor_vfd_simple` back.**

## 4. codegen-core current state for `motor_vfd_simple`

Three independent gates would all need to be touched for camino B:

1. [`packages/codegen-core/src/compiler/program/types.ts`](../packages/codegen-core/src/compiler/program/types.ts) — `CANONICAL_NAME` and `FIELDS` tables. `motor_vfd_simple` has **no entry** in either today.
2. [`packages/codegen-core/src/compiler/lowering/outputs.ts`](../packages/codegen-core/src/compiler/lowering/outputs.ts) — `wireEquipment()` switch. **No `wireMotorVfdSimple` helper exists**; the default branch already emits `UNSUPPORTED_ACTIVITY`.
3. [`packages/codegen-core/src/compiler/program/compile-project.ts`](../packages/codegen-core/src/compiler/program/compile-project.ts) — `SUPPORTED_TYPES` set. `motor_vfd_simple` is **not** in it.
4. [`packages/codegen-core/src/readiness/codegen-readiness.ts`](../packages/codegen-core/src/readiness/codegen-readiness.ts) — `CORE_SUPPORTED_EQUIPMENT` plus per-target capability tables. `motor_vfd_simple` is **not** in any of them.

All four gates *currently* reject `motor_vfd_simple` in concert. Sprint 88E intentionally keeps that posture.

## 5. What this sprint guarantees

- `motor_vfd_simple` continues to throw `READINESS_FAILED` /
  `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` on every target
  (codesys, siemens, rockwell, core).
- The capability-table assertion is now a regression-pinned test,
  not just a doc claim.
- The renderer audit findings are recorded so the **next** sprint
  that re-opens `motor_vfd_simple` does not re-audit the renderer
  layer from scratch.

## 6. What this sprint does NOT guarantee

- No claim about whether `motor_vfd_simple` *can* be supported on
  CODESYS — only that it cannot be supported **today** without
  either assumption promotion or a PIR change.
- No safety semantics for VFDs (ramps, e-stop chains, fault
  acknowledge, run-permissive). These are explicitly out of scope
  even when support reopens.
- No widening of any target's capability table. No new lowering
  helper. No new canonical type name. No `FIELDS` entry.

## 7. Test coverage layered on top of this audit

Three tests, in three layers, now pin the decision:

| Layer | File | Assertion |
|---|---|---|
| Capability table | [`packages/codegen-core/tests/codegen-readiness.spec.ts`](../packages/codegen-core/tests/codegen-readiness.spec.ts) — *Sprint 88E* block | `motor_vfd_simple` is not in `getTargetCapabilities(t).supportedEquipmentTypes` for any of `core / siemens / codesys / rockwell`. |
| Preflight throw | [`packages/codegen-core/tests/codegen-readiness.spec.ts`](../packages/codegen-core/tests/codegen-readiness.spec.ts) — *87A test 8* | `runTargetPreflight(p, 'rockwell')` on a `motor_vfd_simple` project throws `READINESS_FAILED` with `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` in `cause.diagnostics`. |
| Cross-target integration | [`packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts`](../packages/codegen-integration-tests/tests/valve-onoff-universal-support.spec.ts) — test 5 | The same throw is asserted across `codesys`, `siemens`, and `rockwell` in a parametrised loop. |

## 8. Manual verification checklist

- [ ] Build a tiny PIR with one `motor_vfd_simple` equipment + a
      bool `run_out` and a numeric `speed_setpoint_out`.
- [ ] Run CLI `generate --backend codesys` → expect non-zero exit
      with `READINESS_FAILED` referencing
      `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`.
- [ ] Run CLI `generate --backend siemens` → same.
- [ ] Run CLI `generate --backend rockwell` → same.
- [ ] Confirm no `DUT_MotorVfdSimple` / `UDT_MotorVfdSimple`
      artifact is emitted by any backend.
- [ ] Confirm the readiness panel in `@plccopilot/web` reports
      *Blocked* for all three vendor targets when fed a
      `motor_vfd_simple` fixture.

## 9. Conditions to re-open (future sprint)

Camino B (CODESYS support v0) becomes safely shippable when **all** of these are true:

1. PIR exposes a deterministic numeric source for `speed_setpoint_out` — e.g.:
   - a new `parameter` reference role like `speed_setpoint_param: <param_id>`, with the parameter declared at the equipment / station / machine level and validated at PIR-build time, **or**
   - a new numeric activity verb (e.g. `set_speed`) whose payload is a numeric expression that the lowering can lift into a `Literal` / `ExprIR.Constant`.
2. The PIR validator rejects a `motor_vfd_simple` project that does not bind such a source, with a deterministic JSON path so the review UI can attach the error to the right equipment node.
3. The audit doc is updated with the chosen mechanism, and a fresh per-package CODESYS spec mirrors the 87A `valve_onoff.spec.ts` template.
4. After CODESYS ships, follow-on sprints audit Siemens (87C-style) and Rockwell (88C-style) before any cross-target widening.

Until those four conditions hold, every target stays at `READINESS_FAILED` for `motor_vfd_simple`.

## 10. Closeout: Sprint 88E

- **Path taken:** camino A — audit-only. No support widened.
- **Production code touched:** none.
- **Tests added:** 1 (codegen-core capability-table audit pin).
- **Repo total tests:** 3,476 → 3,477 (`+1`).
- **Gates:** see top-level closeout report (this document is referenced from the commit message).
- **Push status:** NOT pushed.

## 11. Recommended next sprint

- **Sprint 88F (PIR-side)** — design the `speed_setpoint_out`
  source binding. Two candidate shapes worth comparing in the
  doc, no code changes:
  - parameter→role binding (more flexible, requires schema work
    on `Parameter` references), and
  - numeric activity verb (smaller surface, but every consumer
    of `Activity` would need to handle a numeric payload).
  Pick one, write the migration plan, then ship the PIR change in
  88G. Only after 88G is in main does Sprint 88H reopen the
  CODESYS-side support audit.

Alternative if VFD support is not a near-term operator need:

- **Sprint 89** — controlled codegen preview UX (web).
- **Pause-and-listen** — route effort back to ingestion / review
  UX based on actual operator demand.
