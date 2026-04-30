# Sprint 89 — Controlled codegen preview UX

Status: closed locally (gates green; not pushed).
Sister sprints: 86 (readiness preflight), 87B (web readiness panel),
88L (CSV parameter extraction), 88M (structured XML parameter
extraction). After 88M the `motor_vfd_simple` pipeline is end-to-end
real (CSV/EPLAN/TcECAD → review → PIR → CODESYS / Siemens / Rockwell);
Sprint 89 lifts the operator-side bottleneck by adding a controlled,
explicit, ephemeral *preview* of generated artifacts before the
canonical Generate flow runs.

## Why

The web flow today is:

```
Source ingest → Review → Apply PIR → Readiness panel → Generate (worker) → Artifact bundle
```

The readiness panel (Sprint 87B) tells the operator whether the
PIR is shaped correctly for a target. It does NOT show the
operator what would actually be emitted. To inspect the artifact
list, paths, manifest diagnostics, or content, the operator had
to commit to Generate, wait for the worker, and read the bundle.

Sprint 89 inserts an explicit **Preview** step between readiness
and Generate:

```
Source ingest → Review → Apply PIR
       │
       ▼
Readiness panel (Sprint 87B) — verdict + grouped diagnostics
       │
       ▼
Codegen preview panel (Sprint 89) — operator clicks
       │   "Preview generated artifacts"
       │   • per-target verdict (ready / ready_with_warnings /
       │     blocked / failed)
       │   • artifact paths sorted by path
       │   • manifest diagnostics grouped by severity, deduped
       │   • per-artifact ephemeral snippet (≤ 40 lines / 4 KB,
       │     marked `truncated` when clipped)
       ▼
Generate (Sprint 86 worker path) — unchanged, canonical
```

## What this sprint adds

### Pure helper

[`packages/web/src/utils/codegen-preview-view.ts`](../packages/web/src/utils/codegen-preview-view.ts)
exports:

- `buildCodegenPreviewView({ project, selection, generatedAt?, generators? })` — pure / DOM-free / total. Never throws.
- `CodegenPreviewView`, `CodegenPreviewTargetView`, `CodegenPreviewArtifactView`, `CodegenPreviewDiagnostic`, `CodegenPreviewError`, `CodegenPreviewStatus`, `CodegenPreviewTarget`.
- `MAX_PREVIEW_LINES = 40` and `MAX_PREVIEW_BYTES = 4 * 1024` — hard caps used for snippet truncation.

The helper:

1. Returns `unavailable` when no project is supplied.
2. For `selection: 'all'`, expands into one target view per vendor (`siemens`, `codesys`, `rockwell`); a failure on one target does not poison the others.
3. For each target, runs `buildCodegenReadinessView({ project, target })` first (Sprint 87B, unchanged):
   - `unavailable` / `blocked` → short-circuits without calling the vendor.
   - `ready` / `warning` → calls `generateXxxProject(project, opts)` synchronously inside `try/catch`.
4. On `CodegenError` / any throw → status `failed` with `{ code, message }`; readiness groups preserved.
5. On success → sorts artifacts by `path` ascending; severity-groups and dedups manifest diagnostics on `code|severity|message`; truncates each artifact's content to `MAX_PREVIEW_LINES` / `MAX_PREVIEW_BYTES` and marks `truncated: true` when clipped.

The `generators?:` override slot lets tests stub vendor functions without mutating production code; production callers omit it.

### Component

[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)
is a thin renderer over the helper:

- Accepts `{ project, target, generatedAt? }`.
- Local ephemeral phases: `idle` → `running` → `has-result` / `stale`.
- Single button: `Preview generated artifacts` (or `Refresh preview` after a result).
- Project / target change invalidates the prior result via a stable signature `${project.id}|${target}`; the panel transitions `has-result → stale` and tells the operator the preview is stale.
- Discards an in-flight `running` result if the selection moves under it.
- Renders per-target cards with status badge, summary, error block (when `failed`), collapsible readiness diagnostics, collapsible manifest diagnostics, and a collapsible artifact list with per-artifact `path`, `≈ N bytes`, and a `<details>`-wrapped `<pre>` snippet.

### App integration

[`packages/web/src/App.tsx`](../packages/web/src/App.tsx) renders the new panel directly below `CodegenReadinessPanel`. The Generate button, the worker flow, and the readiness fallback are all unchanged. The panel only renders when an applied PIR exists.

### Tests

[`packages/web/tests/codegen-preview-view.spec.ts`](../packages/web/tests/codegen-preview-view.spec.ts) — 18 helper tests (no React Testing Library; the component is a thin renderer):

1. `unavailable` for `null` / `undefined` project.
2. Happy single-target `ready`; artifact paths sorted ascending.
3. Manifest warnings → `ready_with_warnings`; duplicates deduped.
4. Truncation by line count.
5. Truncation by byte count.
6. Small content not truncated.
7. `CodegenError` → `failed` with `error.code` preserved.
8. Plain `Error` → `failed` with message preserved.
9. Non-array vendor return → `failed` with `INTERNAL_ERROR`.
10. Backend `'all'` expands into 3 vendor target views.
11. One failed target does not poison the others; aggregate summary names the count.
12. All-blocked → aggregate `blocked` with explanatory summary; blocked targets do NOT call the vendor.
13. Helper does NOT mutate the input project.
14. Duplicate artifact paths preserved (vendor responsibility) but sort is stable.
15. Two runs with same input → byte-identical view.
16. Unsupported equipment → `blocked`; vendor never called.
17. Happy `valve_onoff` project → status `ready` (post-Sprint 88C universal support).
18. (covered above by the `'all'` block).

### Status enum

```ts
type CodegenPreviewStatus =
  | 'unavailable'        // no project
  | 'running'            // transient — only inside the panel
  | 'ready'              // generation succeeded, no warnings
  | 'ready_with_warnings'// generation succeeded, manifest warnings present
  | 'blocked'            // readiness blocks; vendor not called
  | 'failed';            // vendor threw — error.code preserved
```

## Hard rules pinned

- **No automatic codegen.** Preview is explicit-action-only. Changing project or target invalidates the previous preview but never re-runs it. The only trigger is the button.
- **No persistence.** Preview snippets, artifact lists, and manifest diagnostics live exclusively in component state. They are NOT stored in `localStorage` (verified — `saveProject` stores only the PIR JSON, see [`packages/web/src/utils/storage.ts`](../packages/web/src/utils/storage.ts)). They are NOT exported in the session bundle.
- **No raw source bytes.** Preview shows generated artifact content only. PDF bytes / CSV body / XML body never appear in the preview.
- **No vendor certification.** A green preview is not a guarantee the generated code is operator-grade safety-correct. The doc and the panel's own copy spell this out.
- **No worker protocol change.** Generation runs synchronously in-process during preview; the canonical Generate path keeps using the worker. Both paths share the vendor pipeline imports — the preview is a strict sub-execution.
- **No PIR / codegen change.** Vendor capability tables, lowering, renderers, PIR types, and PIR validators all unchanged.
- **No new equipment kinds.**
- **No address synthesis / assumption promotion.**
- **`'core'` not exposed.** The selector union is the existing `BackendChoice = 'siemens' | 'codesys' | 'rockwell' | 'all'`; the helper's `CodegenPreviewTarget` excludes `'core'` because the bare `compileProject` pipeline is never an operator-facing target.

## Manual verification checklist

Run `pnpm web:dev`, then:

- [ ] Load a CSV-only valid simple project → review → Build PIR → Apply.
- [ ] Codegen readiness panel shows `Ready`.
- [ ] Codegen preview panel shows the idle copy + the *Preview generated artifacts* button.
- [ ] Click the button → state goes through `Preparing preview…` → renders one target card with badge `Ready`, artifact count, paths, and a collapsible artifact preview.
- [ ] Click `Generate` (existing button) → same artifacts download as before. Preview did not interfere.
- [ ] Change backend selector to `All` → preview panel transitions to `stale`. Click `Refresh preview` → 3 target cards (CODESYS / Siemens / Rockwell) each render their own status / artifact list.
- [ ] Load a `motor_vfd_simple` PIR with explicit parameter + setpoint binding (Sprint 88L / 88M flow) → preview shows `Ready` on all three vendor targets; each card surfaces the `UDT_MotorVfdSimple` and `FB_St…` paths.
- [ ] Mutate the equipment kind to `pneumatic_cylinder_1pos` → preview shows `Blocked` with `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` group; vendor pipeline did not run.
- [ ] Force a synthetic CodegenError (e.g., remove a required IO binding) → preview shows `Failed` for the affected target with the error code chip; other targets in `'all'` still render their own results.
- [ ] Refresh the page → previous preview is gone (no localStorage rehydration).
- [ ] Export / download the session bundle → bundle does not contain preview snippets or generated artifacts.

## Honest constraints

- **In-process generation.** Preview runs the vendor pipeline on the main thread (synchronous). The vendor pipelines are pure / fast / no I/O, so this is safe for the current data sizes; the canonical Generate path still uses the worker for long-running runs and to keep the UI responsive on bigger projects.
- **Snippet caps are conservative.** 40 lines / 4 KB per artifact. A future sprint can lift these once operator feedback shows it's needed.
- **No React Testing Library.** Mirroring the rest of the web suite, coverage is helper-level. The component is a thin renderer over the tested helper.
- **No CSS shipped in this sprint.** The component reuses the same `.codegen-readiness-*` / `.badge` / `.muted` class conventions; visual polish lives in a future sprint.
- **`generators?:` test slot.** The helper exposes a generators override for tests. Production callers must not pass it; misuse cannot be statically prevented but is documented.
- **pdfjs Windows shutdown flake** (documented since Sprint 84) is unrelated to this sprint and may surface during `pnpm -r test`. Per-package isolated re-runs are clean.

## Tests before → after

| Package | Before | After | Δ |
|---|---:|---:|---:|
| `@plccopilot/web` | 834 | 852 | +18 |
| **Repo total** | **3,599** | **3,617** | **+18** |

PIR (44), codegen-core (771), CODESYS (63), Siemens (184), Rockwell (78), codegen-integration-tests (165), CLI (757), electrical-ingest (703) all unchanged.

## Recommended next sprint

The end-to-end story is now operator-grade for the `motor_vfd_simple` flow. Logical next moves:

- **Sprint 90 — preview content diff vs. last Generate.** Once the operator regenerates, show what changed since the previous preview / Generate run. Builds on Sprint 89's helper.
- **Sprint 90 alternative — preview download.** Let the operator download a snippet bundle directly from the preview panel without committing to the canonical Generate flow.
- **Sprint 90 alternative — parameter range / unit cross-validation.** When real fixtures expose `min` / `max` / `unit` metadata, layer a guarded R-EQ-05B sub-rule.
- **Pause-and-listen** — route effort to whichever direction operator feedback exposes.
