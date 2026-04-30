# Sprint 87B — Codegen readiness UX in web

> **Status: prevention layer for codegen readiness in
> `@plccopilot/web`.** Sprint 86 surfaced
> `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` and friends as a
> `CodegenError(READINESS_FAILED, …)` thrown from each target
> façade — operators only saw it as a banner *after* clicking
> Generate. Sprint 87A made the per-target capability split
> real (`valve_onoff` for CODESYS only). Sprint 87B closes the
> loop by running `preflightProject` BEFORE the operator presses
> Generate and surfacing the diagnostics in a dedicated panel.
> Volume / UX hardening only — no automatic codegen, no new
> equipment support, no schema bump.

## What changed

**Web only.** Three additions in `@plccopilot/web`:

1. **Pure helper** — `packages/web/src/utils/codegen-readiness-view.ts`:
   - `buildCodegenReadinessView({ project, target })` returns a
     `CodegenReadinessView` model (status, severity counts,
     summary, grouped diagnostics).
   - Calls Sprint 86's `preflightProject` under the hood with
     a defensive try/catch — never throws.
   - Sort: error → warning → info → code → path → symbol →
     stationId → message. Defensive dedup on the identity
     tuple.
   - Code titles map (`READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`
     → `"Equipment kind not supported by this target"` etc.)
     with fallback to the raw code for unknown future codes.

2. **React component** — `packages/web/src/components/CodegenReadinessPanel.tsx`:
   - Thin renderer of the view model.
   - Accepts `target: CodegenTarget | 'all'`. When `'all'`,
     stacks one card per vendor target (siemens / codesys /
     rockwell).
   - Status badges + per-group severity badges + items with
     `path` / `stationId` / `symbol` / `hint`.
   - Memoised on `(project, target)` so it doesn't recompute
     on every render.

3. **Wiring in `packages/web/src/App.tsx`** — the panel renders
   right after the existing `<Toolbar>` and BEFORE the
   `compileError` banner. Reads the existing `appliedProject`
   state and the existing `backend` selector value (no new
   state, no duplicate selector). The panel hides when no PIR
   is loaded.

CSS additions (`packages/web/src/styles.css`): scoped
`.codegen-readiness-*` rules following the existing severity-
badge convention. No CSS modules, no Tailwind — vanilla CSS,
matching the rest of the app.

## What it does not do

- **Generate is still explicit.** The button is not disabled
  by readiness state; the existing `CompileClientError` path
  still surfaces `READINESS_FAILED` after a click on a
  blocked target. The new panel is the *prevention* layer; the
  Sprint 86 banner is the *fallback* layer.
- **No automatic codegen, no automatic merge / rename / remap.**
- **No new equipment support.** The capability tables read
  through `@plccopilot/codegen-core`; web doesn't duplicate
  them.
- **No worker-protocol change.** The `compile` request shape,
  `SerializedCompilerError` payload, and `CompileClientError`
  format are unchanged. Existing tests stay green.
- **No localStorage shape change.** Raw PDF bytes still NEVER
  persisted (Sprint 78B privacy default unchanged).
- **No PDF / OCR / layout changes.** The PDF arc stays
  paused.
- **No new infra in tests.** The web suite is vitest node-mode
  with no DOM tooling. The component is intentionally a thin
  renderer of the helper; coverage lives at the helper level.

## How the panel decides the verdict

```
project == null                      → status: 'unavailable'
preflight throws unexpectedly         → status: 'unavailable' + sentinel info group
no diagnostics                        → status: 'ready'
≥ 1 error severity diagnostic         → status: 'blocked'
no errors but ≥ 1 warning             → status: 'warning'
otherwise (info-only)                 → status: 'ready'
```

The summary line names the target verbatim so a multi-target
view (`'all'`) reads cleanly:

- `"Ready for codesys generation."`
- `"Ready for codesys generation with 2 warnings."`
- `"Not ready for siemens generation — 1 blocking issue."`

## Sprint 87A integration — `valve_onoff`

The new panel makes the Sprint 87A per-target split visible:

| Backend | A project containing `valve_onoff` |
| --- | --- |
| `codesys` | **Ready** — no `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` group. |
| `siemens` | **Blocked** — group titled "Equipment kind not supported by this target", item names `valve_onoff`, `siemens`, the path, and the hint. |
| `rockwell` | **Blocked** — same group shape as Siemens. |

Operators can now decide which target to generate for *before*
clicking Generate.

## Manual verification (operator-side)

1. `pnpm web:dev`.
2. Load a simple valid CSV → review → Build PIR. Apply the
   PIR JSON.
3. Pick `codesys` in the backend selector. The Codegen
   Readiness panel should show **Ready**.
4. Pick `siemens` / `rockwell`. Still **Ready** (the small CSV
   only uses common kinds).
5. Load a PIR fixture that contains a `valve_onoff` equipment
   instance. Pick:
   - `codesys` → **Ready**.
   - `siemens` → **Blocked** with
     `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` group naming
     `valve_onoff` + `siemens`.
   - `rockwell` → **Blocked**, same shape.
   - `all` → three stacked cards, two blocked + one ready.
6. With the `valve_onoff` PIR loaded and `siemens` selected,
   click Generate. The existing Sprint 86 banner still fires
   (`[READINESS_FAILED] …`). No crash; both prevention
   (Sprint 87B panel) and fallback (Sprint 86 banner) coexist.
7. Export / download bundle still works on a green CODESYS
   readiness state.
8. PDF / TcECAD / EPLAN / CSV ingestion paths intact.

## Tests

New spec: `packages/web/tests/codegen-readiness-view.spec.ts`
(14 tests). Coverage:

- null / undefined project → `unavailable`.
- Happy CODESYS project → `ready`, zero groups.
- Unsupported equipment for Siemens → `blocked`, equipment
  group present, error severity.
- Duplicate IO address only → `warning`.
- Sprint 87A `valve_onoff` per-target split (CODESYS ready,
  Siemens / Rockwell blocked with explicit group + item +
  hint).
- Sort: error before warning groups when both present.
- Group title fallback for the documented `READINESS_PLACEHOLDER_SEQUENCE`
  info code.
- Helper is pure (input deep-equal before/after, two
  invocations).
- Dedup on duplicate IO id.
- Status counts add up to total items.
- `'all'` shape covered indirectly via per-target tests; the
  component layer simply runs the helper three times.

## Tests / gates

| Package | Pre-87B | Sprint 87B |
| --- | --- | --- |
| `@plccopilot/web` | 818 | **832** (+14) |
| `@plccopilot/codegen-core` | 755 | 755 |
| `@plccopilot/codegen-codesys` | 52 | 52 |
| `@plccopilot/codegen-siemens` | 166 | 166 |
| `@plccopilot/codegen-rockwell` | 60 | 60 |
| `@plccopilot/codegen-integration-tests` | 109 | 109 |
| `@plccopilot/cli` | 757 | 757 |
| `@plccopilot/electrical-ingest` | 650 | 650 |
| `@plccopilot/pir` | 36 | 36 |
| **Repo total** | **3,403** | **3,417** |

Gates green: `pnpm -r typecheck`, `pnpm -r test`, `pnpm
publish:audit --check`, `pnpm run ci`.

## Honest constraints

- **No automatic codegen.** Generate stays explicit.
- **No new equipment support.** 87A's `valve_onoff` for CODESYS
  is the only kind the new panel surfaces as "ready" beyond
  the Sprint 86 baseline.
- **No target certification.** The capability tables are the
  *current* state; Sprint 87B reads them, doesn't promote
  them.
- **No assumption promotion / address synthesis / role
  guessing.** The panel surfaces the same root causes Sprint
  86 / 87A already produced.
- **Generate gating is informational, not enforced.** A future
  sprint may decide to disable Generate when readiness is
  blocked; Sprint 87B intentionally does not, to keep the
  worker-protocol contract and existing CompileClientError
  tests green.
- **No new test infra.** Helper-level coverage only; the
  component is a thin renderer.
- **No PDF / OCR / layout work.**
- **Same `.ts` / `.js` codegen mirror invariant.** Sprint 87B
  does not touch codegen packages.

## Recommended next sprint

1. **Sprint 87C — widen Siemens with one previously-unsupported
   kind** (default candidate: `valve_onoff` after an SCL
   renderer audit), mirroring the 87A pattern.
2. **Sprint 87D — controlled codegen preview**, only after
   readiness UX has been load-bearing for ≥ 1 real engagement.
3. **Sprint 88 — cross-source duplicate detection** if
   multi-source review sessions surface real duplicate-IO /
   duplicate-address conflicts.

Default after 87B: choose based on operator feedback. If no
feedback, prefer 87C only when the SCL renderer audit is
small and safe.
