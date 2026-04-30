# Sprint 88F — PIR-side design: numeric setpoint binding for `motor_vfd_simple`

Status: closed at **decision: Option A — parameter→role binding**. Design-only sprint. No production code touched.

Sister sprints:
- 87A / 87C / 88C — per-vendor `valve_onoff` widening (after renderer audits).
- 88D — cross-renderer `valve_onoff` parity bar.
- 88E — `motor_vfd_simple` audit, support deferred (the immediate predecessor; identifies *exactly* the gap this sprint closes on paper).
- **88G** — implements the design proposed here. Pending.
- **88H** — re-opens CODESYS support for `motor_vfd_simple`. Pending.

## TL;DR

- Sprint 88E found that the renderers can support `motor_vfd_simple` (all three are IR-driven, structurally agnostic). The blocker was PIR: `speed_setpoint_out` is a **required numeric output** that no current PIR mechanism (no numeric activity, no parameter→role binding) can drive without value synthesis or leaving the field dangling.
- This sprint compares two ways to close the gap:
  - **Option A — Parameter→role binding.** Add an optional, role-keyed map on `Equipment` that names a machine-level `Parameter` to drive each numeric output role.
  - **Option B — Numeric activity verb / payload.** Extend `Activity` so a sequence state can carry a numeric value into a setpoint output.
- **Recommendation: Option A.** The setpoint is a *process parameter*, not a sequence event. PIR already has a working `Parameter` machinery (validated, lowered to `DB_Global_Params`, referenced by `Recipe.values`); Option A reuses it with one optional field and one validator rule. Option B collides with the `Activity` semantic (boolean state-entry/transition trigger), forces a breaking change to `activate: string[]`, or activates a long-deferred `Action[]` lowering path that has been a TODO since the early codegen sprints.
- A concrete Sprint 88G implementation plan + acceptance criteria follows. The capability tables stay closed for `motor_vfd_simple` until 88G ships; Sprint 88E's [audit-decision pin test](../packages/codegen-core/tests/codegen-readiness.spec.ts) keeps that bar enforced.

## 1. Audit recap (what already exists)

The audit (full report in the agent run that produced this doc) found:

### `Parameter` is mature

- [`packages/pir/src/domain/types.ts:134-143`](../packages/pir/src/domain/types.ts#L134-L143):
  ```ts
  export interface Parameter {
    id: Id;
    name: string;
    data_type: ParameterDataType; // 'int' | 'dint' | 'real' | 'bool'
    default: number | boolean;
    min?: number;
    max?: number;
    unit?: string;
    description?: string;
  }
  ```
- Scope: **machine-level only** (`Machine.parameters: Parameter[]`).
- Validators ([`packages/pir/src/validators/rules/parameters.ts`](../packages/pir/src/validators/rules/parameters.ts)):
  - **R-PR-02** — `default` must match `data_type` and be inside `[min, max]`.
  - **R-PR-01** — `Recipe.values[param_id]` exists, dtype matches, value in range.
- Codegen consumption — already wired:
  - [`packages/codegen-core/src/compiler/program/data-blocks.ts`](../packages/codegen-core/src/compiler/program/data-blocks.ts) emits `DB_Global_Params` (Siemens) / `GVL_Params` (CODESYS) / equivalent (Rockwell) with each parameter as a global with its `default` as initial value.
  - The symbol resolver registers each parameter as `kind: 'parameter'`, `storage: { kind: 'global', name: p.id }`. Expressions in guards and triggers can already reference parameter ids.
- Fixtures: [`packages/pir/src/fixtures/weldline.json`](../packages/pir/src/fixtures/weldline.json) declares `p_weld_time` (`dint`, 100–10000 ms) and `p_weld_current` (`real`, 50–300 A); recipes reference both.

### `Activity` is shallower than its types suggest

- Activity surface (`Activity.activate?: string[]`, `Activity.on_entry?: Action[]`, `Activity.on_exit?: Action[]`) is wider than the lowering that consumes it.
- `Action.verb` already permits `'set'` and `Action.value: number | boolean` is in the schema — but **no fixture or test exercises it**, and `lowering/activities.ts:31` carries `TODO: edge-driven lowering`.
- The only `Activity` field that is actually lowered today is `activate: string[]` of `"eq.activity"` form, with the activity being a boolean (`run`, `open`, `extend`, …) declared in `EQUIPMENT_SHAPES.allowed_activities`.

### Equipment binding shape

- [`packages/pir/src/domain/types.ts`](../packages/pir/src/domain/types.ts) — `Equipment.io_bindings: Record<string, string>` (role name → IO id).
- [`packages/pir/src/domain/shapes/equipment.ts:37-44`](../packages/pir/src/domain/shapes/equipment.ts#L37-L44) — `motor_vfd_simple` requires `run_out` (bool) + `speed_setpoint_out` (numeric); allows only the `run` activity.
- [`packages/pir/src/validators/rules/equipment.ts`](../packages/pir/src/validators/rules/equipment.ts) — R-EQ-01..R-EQ-04 already enforce required roles, role↔IO dataClass match, and timing invariants.

### Holes (independent of A vs B)

- **Parameters are machine-level only.** Nothing in PIR currently expresses "this parameter belongs to *this equipment instance*". For v0, machine-level is acceptable (a VFD's commissioned setpoint is typically a constant per machine, not per instance).
- **Electrical-ingest does not extract parameters.** [`packages/electrical-ingest/src/mapping/pir-builder.ts`](../packages/electrical-ingest/src/mapping/pir-builder.ts) builds `io[]` and `equipment[]` but never populates `machine.parameters[]`. **Closing this hole is a separate concern from A vs B** — both options need a parameter source eventually (operator UI, CSV column, EPLAN custom field). Sprint 88G will treat parameters as operator-authored for v0.
- **Parameters lack `Provenance`.** Equipment / IO / Machine carry an optional `Provenance` (source origin); Parameter does not. Adding it is a follow-up, not a 88G blocker.

## 2. Option A — Parameter → role binding

### Shape

Add an optional, role-keyed map alongside `io_bindings` on `Equipment`:

```ts
// packages/pir/src/domain/types.ts (proposed for Sprint 88G)
export interface Equipment {
  id: Id;
  name: string;
  type: EquipmentType;
  code_symbol?: string;
  io_bindings: Record<string, Id>;            // existing
  io_setpoint_bindings?: Record<string, Id>;  // NEW: role → parameter id
  // …
}
```

Concrete fixture for `motor_vfd_simple`:

```jsonc
{
  "id": "mot01",
  "type": "motor_vfd_simple",
  "code_symbol": "M01",
  "io_bindings": {
    "run_out":            "io_m01_run",
    "speed_setpoint_out": "io_m01_speed_aw"
  },
  "io_setpoint_bindings": {
    "speed_setpoint_out": "p_m01_speed"   // → machine.parameters[]
  }
}
```

### Validator rule (proposed `R-EQ-05`)

For each `(role, param_id)` in `io_setpoint_bindings`:

1. The `role` must appear in `EQUIPMENT_SHAPES[type].required_io ∪ optional_io`.
2. The role's `roleSpec(role).dataClass` must be `'numeric'`, and `direction` must be `'out'`. (Boolean roles and inputs cannot be setpoint-bound.)
3. The role must also appear as a key in `io_bindings` — i.e. the IO physical channel is bound. The setpoint binding **does not replace** the IO binding; it adds a *value source* for the IO that's already there.
4. `param_id` must exist in the same machine's `parameters[]`.
5. The bound parameter's `data_type` must be numeric (`int` / `dint` / `real`). `bool` parameters are rejected.
6. (Optional, soft) — if both the parameter's `unit` and a future role-level `unit` annotation exist and disagree, surface a warning, not an error. v0 does not perform unit conversion.

This rule slots in next to the existing R-EQ-01..R-EQ-04 in [`packages/pir/src/validators/rules/equipment.ts`](../packages/pir/src/validators/rules/equipment.ts).

### Lowering

A new helper `wireMotorVfdSimple` in [`packages/codegen-core/src/compiler/lowering/outputs.ts`](../packages/codegen-core/src/compiler/lowering/outputs.ts):

```ts
function wireMotorVfdSimple(eq, cmds, table, diagnostics, meta): StmtIR[] {
  const stmts: StmtIR[] = [];

  // run_out := run_cmd  (mirror of motor_simple)
  const runSym = table.resolve(`${eq.id}.run_out`);
  if (!runSym) { /* UNBOUND_ROLE */ return []; }
  const runCmd = cmds.find((c) => c.activity === 'run');
  if (runCmd) {
    stmts.push(ir.comment(`${eq.id} (motor_vfd_simple): run_cmd -> run_out`));
    stmts.push(ir.assign(storageToRef(runSym.storage), ir.refExpr(ref.local(runCmd.varName))));
  }

  // speed_setpoint_out := <bound parameter>
  const spSym = table.resolve(`${eq.id}.speed_setpoint_out`);
  const spParam = eq.io_setpoint_bindings?.speed_setpoint_out;
  if (!spSym) { /* UNBOUND_ROLE */ return []; }
  if (!spParam) {
    // Surface a deterministic readiness diagnostic earlier (see §4
    // — capability table layer would normally have already blocked
    // this case); defensive UNBOUND_SETPOINT_SOURCE keeps the
    // lowering layer total.
    diagnostics.push(diag('error', 'UNBOUND_SETPOINT_SOURCE', …));
    return stmts;
  }
  stmts.push(ir.comment(`${eq.id} (motor_vfd_simple): ${spParam} -> speed_setpoint_out`));
  stmts.push(ir.assign(
    storageToRef(spSym.storage),
    ir.refExpr(ref.global(spParam))   // already registered by symbols/resolver.ts
  ));

  return stmts;
}
```

Single `Assign` per role; no synthesised constants; the parameter symbol is already global thanks to the existing resolver. This composes with the existing `DB_Global_Params` / `GVL_Params` initialisation.

### Pros

- **Zero collision with existing semantics.** `Activity` stays boolean. `Parameter` stays a process value. `Recipe` continues to override parameters by id — *for free*, the same recipe override mechanism that exists today now lets an operator hot-swap a VFD's commissioned setpoint without touching code.
- **Validation re-uses the R-PR-01 pattern.** Existence + dtype checks are mechanically the same.
- **Lowering is one-line.** The codegen symbol resolver already registers parameters as globals; `wireMotorVfdSimple` becomes a 1-helper, ~25-LoC addition.
- **HMI / fieldbus / audit-trail naturally compose.** Anything that can read or write a `Parameter` (recipes today; operator UI tomorrow) flows through to the VFD.
- **Provenance can be added later** without redesign — attach `Provenance` to `Parameter` in a follow-up sprint.
- **Non-breaking schema change.** New optional field. Existing fixtures remain valid. JSON schema additive.

### Cons / risks

- Requires operators (or a future ingestion path) to author the setpoint parameter. We accept that v0 ships parameter authoring through the operator review UI; PDF/EPLAN/CSV ingestion of parameters is deferred.
- Machine-level scope means two `motor_vfd_simple` instances in the same machine would either share a setpoint or each need their own parameter id. The latter is fine in v0 (just declare `p_m01_speed`, `p_m02_speed`); the former is a future enhancement (per-instance overrides).

## 3. Option B — Numeric activity verb / payload

### Shape

Two sub-variants worth considering, neither attractive:

- **B1** — Repurpose `activate: string[]` into `activate: ActivationSpec[]`:
  ```ts
  type ActivationSpec = { target: Id; verb?: string; value?: number | boolean };
  ```
  Allows `{ target: 'mot01', verb: 'set_speed', value: 3000 }` in a state's `activity.activate`.

- **B2** — Activate the dormant `Action[]` lanes (`on_entry`, `on_exit`):
  ```ts
  on_entry: [{ target_equipment_id: 'mot01', verb: 'set', value: 3000 }]
  ```
  This *is already in the schema* (`Action.verb = 'set'`, `Action.value`); only the lowering side is a TODO.

### Pros

- B2 sidesteps the breaking schema change — the data shape already exists.
- Inline value at the call site can feel "more obvious" for one-off pulses.

### Cons / risks

- **Conflates state-entry trigger semantics with process-parameter semantics.** A boolean `run` activity says "the FB should be in a state where run is asserted while we are in this sequence state." A numeric `set_speed: 3000` would say "write 3000 into a register at this edge." That's a different notion of time (continuous-while-in-state vs edge-triggered) and a different notion of authorship (commissioning value vs sequence step).
- **Loses recipe override for free.** Recipes only operate on `Parameter`s. To get recipe override under B you would have to redirect activity payloads through a parameter anyway — at which point Option A is the cheaper path.
- **B1 is a breaking JSON schema change.** Every fixture, every ingestion path, every test that currently authors `activate: ["eq.activity"]` would need migration. The `Schema_FrozenContract.0.1.0` invariant in PIR explicitly opposes breaking shape changes.
- **B2 forces us to ship the long-deferred `Action[]` lowering path** before we have a real consumer for it. That work has been a TODO since at least early Sprint 80s; lifting it as a side-quest of `motor_vfd_simple` couples two unrelated decisions.
- **No clear point at which the value is written.** With Option A, the assignment is a continuous wire (`speed_setpoint_out := p_m01_speed` runs every scan, deterministic). With B2, the value is written *on edge*; what's the value of `speed_setpoint_out` outside that edge? Either the FB has to remember it (state hidden in lowering) or the IO retains its previous value (industrial risk if a parameter override doesn't fire). v0 has no clean answer.
- **Symbol-resolver implications.** B's payload may want to reference parameters anyway (`set_speed: p_m01_speed`), at which point B is just A with extra steps.

## 4. Recommendation — Option A

The setpoint is a process parameter, not a sequence event. Option A:

- Reuses three existing facilities (`Parameter`, R-PR-* validators, `DB_Global_Params` / parameter resolver).
- Touches one PIR type, one validator rule, one lowering helper.
- Does not break any fixture, test, or downstream consumer.
- Composes naturally with recipes (today) and operator UI / fieldbus (tomorrow).
- Keeps `Activity` boolean and `Action[]` deferred until a real edge-driven use case lands.

Option B remains a viable shape *if and when* the codebase gains a real edge-driven write use case (e.g. a recipe-step transition that writes a one-shot value into a register on entry to a state). That use case does not yet exist; designing for it speculatively now would be premature.

## 5. Sprint 88G — implementation plan

This is the concrete plan for the *next* sprint. Each item is intentionally small.

### 5.1 PIR schema + types

| File | Change |
|---|---|
| [`packages/pir/src/domain/types.ts`](../packages/pir/src/domain/types.ts) | Add optional `io_setpoint_bindings?: Record<string, Id>` to `Equipment`. |
| [`packages/pir/src/schemas/equipment.ts`](../packages/pir/src/schemas/equipment.ts) | Add optional `io_setpoint_bindings` JSON schema field — record of string→string, both matching the existing Id pattern. |
| [`packages/pir/src/domain/shapes/equipment.ts`](../packages/pir/src/domain/shapes/equipment.ts) | No change. The roles list already covers `speed_setpoint_out`. |
| [`packages/pir/src/domain/shapes/equipment.js`](../packages/pir/src/domain/shapes/equipment.js) | (mirror of `.ts`, if drift) |

### 5.2 Validators

| File | Change |
|---|---|
| [`packages/pir/src/validators/rules/equipment.ts`](../packages/pir/src/validators/rules/equipment.ts) | Add **R-EQ-05** (`io_setpoint_bindings` resolves) — for each `(role, param_id)`: role is in shape's required/optional IO, role's dataClass is `numeric` and direction `out`, role is also in `io_bindings`, parameter exists in same machine, parameter dtype is numeric. Each failure emits a deterministic JSON path. |
| [`packages/pir/src/validators/rules/equipment.js`](../packages/pir/src/validators/rules/equipment.js) | (mirror) |
| [`packages/pir/tests/rules/equipment.spec.ts`](../packages/pir/tests/rules/equipment.spec.ts) | Add ~5 R-EQ-05 cases: missing param, dtype mismatch (bool param), wrong role (input or boolean role), role not in `io_bindings`, happy path. |

### 5.3 Codegen — readiness widening

| File | Change |
|---|---|
| [`packages/codegen-core/src/readiness/codegen-readiness.ts`](../packages/codegen-core/src/readiness/codegen-readiness.ts) (+ `.js` mirror) | **Do not** add `motor_vfd_simple` to `CORE_SUPPORTED_EQUIPMENT` yet. Sprint 88G ships the PIR + lowering side; Sprint 88H widens CODESYS only after a CODESYS renderer audit. The 88E pin test stays green through 88G. |

### 5.4 Codegen — lowering

| File | Change |
|---|---|
| [`packages/codegen-core/src/compiler/program/types.ts`](../packages/codegen-core/src/compiler/program/types.ts) (+ `.js` mirror) | Add `motor_vfd_simple` to `CANONICAL_NAME` (`'UDT_MotorVfdSimple'`) and `FIELDS` (minimal v0: `cmd_run : Bool`, `speed_setpoint : Real`, `fault : Bool`). |
| [`packages/codegen-core/src/compiler/program/compile-project.ts`](../packages/codegen-core/src/compiler/program/compile-project.ts) (+ `.js` mirror) | Add `'motor_vfd_simple'` to `SUPPORTED_TYPES`. |
| [`packages/codegen-core/src/compiler/lowering/outputs.ts`](../packages/codegen-core/src/compiler/lowering/outputs.ts) (+ `.js` mirror) | Add `wireMotorVfdSimple` helper (sketched in §2). Wire `case 'motor_vfd_simple':` in `wireEquipment`. |
| [`packages/codegen-core/tests/`](../packages/codegen-core/tests/) | Add lowering tests: happy path, missing setpoint binding → `UNBOUND_SETPOINT_SOURCE`, missing run_out binding → `UNBOUND_ROLE` (existing pattern). |

### 5.5 Codegen — vendor renderers

**No changes** in Sprint 88G. The renderers are IR-driven; they will render `UDT_MotorVfdSimple` as soon as the IR exists. But because Sprint 88G keeps `motor_vfd_simple` out of every target's `supportedEquipmentTypes`, no end-user backend produces VFD artifacts yet. Sprints 88H/I/J each audit one renderer and widen one capability table.

### 5.6 Electrical-ingest

**Out of scope for 88G.** Operator-authored parameters are sufficient for v0. Document the gap; Sprint 88L (or later) adds CSV/EPLAN parameter ingestion.

### 5.7 Fixtures

Add a small fixture under [`packages/pir/src/fixtures/`](../packages/pir/src/fixtures/) (e.g. `motor-vfd-simple-min.json`) with one machine, one station, one `motor_vfd_simple`, one numeric parameter, valid `io_setpoint_bindings`. Use it in the lowering tests; do **not** hook it into the existing weldline backend-equivalence fixture (different machine model).

### 5.8 Web

No production changes in 88G. Readiness panel will continue to show `motor_vfd_simple` as **Blocked** for every target until 88H/I/J widen the per-target capability tables. The existing Sprint 87B panel needs no modification.

## 6. Acceptance criteria for Sprint 88G

1. `motor_vfd_simple` with no `io_setpoint_bindings` → R-EQ-05 fails on PIR validate (`missing setpoint binding for required numeric role speed_setpoint_out`).
2. `motor_vfd_simple` with `io_setpoint_bindings.speed_setpoint_out` pointing at a non-existent parameter → R-EQ-05 fails (`unknown parameter`).
3. `motor_vfd_simple` with `io_setpoint_bindings.speed_setpoint_out` pointing at a `bool` parameter → R-EQ-05 fails (`dtype mismatch`).
4. Happy fixture passes PIR validate.
5. `compileProject` on the happy fixture produces:
   - one `UDT_MotorVfdSimple` type artifact in `ProgramIR.equipment_types`,
   - one `Assign` per role (`run_out`, `speed_setpoint_out`) inside the station FB IR,
   - lowering breadcrumbs `mot01 (motor_vfd_simple): run_cmd -> run_out` and `mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out`.
6. `runTargetPreflight` still throws `READINESS_FAILED` on every vendor target (codesys/siemens/rockwell) — capability tables unchanged. Sprint 88E's audit pin test stays green.
7. No constants synthesised. No close-output / fault-latch / ramp / reset / permissive code emitted.
8. Determinism: two compile runs of the happy fixture produce byte-identical IR.
9. Repo `pnpm run ci` exits 0. `.ts/.js` mirrors stay in sync.

## 7. Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Unit / scaling ambiguity.** `speed_setpoint_out` could be Hz, %, rpm, or engineering units depending on drive config. PIR's `Parameter.unit` is a free-form string. | v0 carries `unit` as documentation only; **no scaling math in lowering**. Document in 88G's doc that operator must commission the parameter's value in the unit the drive expects. Future sprint may add `roleSpec(role).expectedUnit` for cross-validation. |
| **Range validation.** A poorly-set `min`/`max` could allow nonsensical setpoints. | R-PR-02 already validates `default ∈ [min, max]`. v0 does **not** require `min`/`max` to be set. Recommend (warning, not error) that VFD-bound parameters declare a range. |
| **Stale setpoint.** If recipes don't fire and operator never updates the parameter, the VFD runs at `default` forever. | Acceptable for v0 — `default` is the commissioned baseline, identical to industry practice for a freshly-deployed drive. The audit explicitly forbids fault latching / safety logic in v0. |
| **Per-instance vs shared parameter.** Two VFDs sharing one parameter is allowed by the schema. | Document as a v0 design choice; allowed but not encouraged. Recommend (style guide, not validator) `p_<eq_id>_speed` naming convention. |
| **Recipe override semantics.** Recipes can change a parameter at runtime; the VFD will follow, instantly. | Already the recipe contract; document that VFD setpoints participate in recipe override the same as any other parameter. **Do not** add a special "lock" flag for VFDs — that's safety logic, deferred. |
| **Provenance gap.** `Parameter` has no `Provenance` field. | Out of scope for 88G; track in a separate sprint. |
| **Boolean activity for run.** `run` is still boolean and lowered the same way as `motor_simple`. | Intentional. v0 keeps `run` semantics aligned with `motor_simple`. Future enhancements (run/jog/forward/reverse) are equipment-shape-level decisions for a different sprint. |

## 8. Out of scope (explicit non-goals)

- No safety logic. No interlocks. No fault latching. No e-stop wiring.
- No speed ramping, no reset, no permissive logic.
- No drive-fault handling. Reading `fault_fb` (already an *optional* role) into an alarm/interlock layer is a separate sprint.
- No reverse direction support (would require expanding `EQUIPMENT_SHAPES`).
- No automatic codegen from web.
- No ingestion-side parameter extraction.
- No vendor certification claim. The output is structural support, not a hardware-ready VFD program.
- No assumption promotion. Every numeric value comes from an explicitly-authored parameter.
- No widening of any vendor capability table in 88G itself.

## 9. Sequence after this sprint

| Sprint | Scope |
|---|---|
| **88G** | PIR change + codegen-core lowering (this design). `motor_vfd_simple` stays blocked at every vendor capability table. |
| **88H** | CODESYS audit (audit-first template, mirror of 87A). Widen CODESYS capability table only if the audit is clean. |
| **88I** | Siemens audit + widening (mirror of 87C). |
| **88J** | Rockwell audit + widening (mirror of 88C). |
| **88K** | Cross-renderer parity bar for `motor_vfd_simple` (mirror of 88D). |
| **88L** | Electrical-ingest: optional CSV/EPLAN parameter extraction. |

If at any audit step (88H/I/J) a vendor's renderer turns out *not* to be structurally agnostic, that audit halts at audit-only — same template as 88E for `motor_vfd_simple` itself.

## 10. Closeout: Sprint 88F

- **Path taken:** decision-only. **Option A — Parameter→role binding.**
- **Production code touched:** none.
- **Files touched:** this doc + a status-line refresh in [`docs/electrical-ingestion-architecture.md`](electrical-ingestion-architecture.md). No tests added — Sprint 88E's audit pin already enforces "stays blocked until binding exists"; duplicating it would be noise.
- **Push status:** NOT pushed.
- **Recommended next sprint:** **Sprint 88G — implement Option A** following §5 of this doc. After 88G lands, Sprint 88H opens the CODESYS renderer audit.
