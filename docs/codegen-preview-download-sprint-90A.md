# Sprint 90A — Controlled codegen preview download bundle

> **Status: shipped in `@plccopilot/web`.** Single explicit
> *Download preview bundle* action next to the Sprint 89 preview
> panel. JSON-only bundle built **from current preview state**
> (no re-run of the vendor pipeline). Pure / DOM-free / total
> helper; thin browser adapter using the existing
> [`downloadText`](../packages/web/src/utils/download.ts).
> No localStorage. No inclusion in canonical session export.

## Why

Sprint 89 gave the operator an in-browser preview of what
*Generate* would produce: per-target status, manifest
diagnostics, and short content snippets capped at 40 lines /
4 KB so the panel stays scannable. Operators almost immediately
asked to *take that material out of the browser* — to paste
into a code review, attach to a Jira ticket, or diff against the
output of a previous PIR — without first having to commit to the
canonical Generate flow.

Sprint 90A is the smallest layer that closes that gap:

- One explicit user action. No auto-download, no piggy-backing
  on any other button.
- Bundle is a strict pass-through of vendor pipeline output that
  is already present in the Sprint 89 view. The pipeline is
  **not** re-run on click.
- The bundle never reaches `localStorage`, never folds into the
  canonical session export, never persists across the page.

## What ships

### New pure helper

[`packages/web/src/utils/codegen-preview-download.ts`](../packages/web/src/utils/codegen-preview-download.ts)

- `isPreviewDownloadable({ view, stale }) → boolean`
  Gate the panel uses to decide whether to render the button.
  Returns `false` for any of: `view == null`, `stale === true`,
  `view.status === 'unavailable'`, or no target with
  `status ∈ {'ready', 'ready_with_warnings'}` AND
  `artifacts.length > 0`.
- `buildCodegenPreviewBundle(view) → CodegenPreviewBundle`
  Single-arg deterministic builder. Reads
  `CodegenPreviewArtifactView.content` (full, uncapped) from the
  Sprint 89 view; never mutates the input.
- `serializeCodegenPreviewBundle(bundle) → string`
  Pretty-printed two-space-indent JSON.
- `makeCodegenPreviewBundleFilename(selection) → string`
  Returns `plc-copilot-codegen-preview-${selection}.json`. No
  timestamp / random suffix — the helper stays deterministic for
  tests; the component layer is free to override at click time
  if it ever wants a wall-clock suffix.
- `bundleHasArtifacts(bundle) → boolean`
  Convenience predicate the panel can use after building.

### Sprint 89 view extension

[`packages/web/src/utils/codegen-preview-view.ts`](../packages/web/src/utils/codegen-preview-view.ts)
gains a non-rendered `content: string` field on
`CodegenPreviewArtifactView`. The panel **still renders only the
truncated `previewText` snippet** — the new field exists solely
so the download helper can reach the full content without
re-running the vendor pipeline. Sprint 89's 18 panel-helper
tests are unchanged.

### Panel button

[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)
renders a *Download preview bundle* button next to the existing
*Refresh preview* / *Preview generated artifacts* button. The
button only appears when `phase.kind === 'has-result'` AND
`isPreviewDownloadable({ view, stale: false }) === true`. On
click it calls
`downloadText(makeCodegenPreviewBundleFilename(view.selection),
serializeCodegenPreviewBundle(buildCodegenPreviewBundle(view)),
'application/json')`. Stale and idle states do not render the
button at all.

### Tests

[`packages/web/tests/codegen-preview-download.spec.ts`](../packages/web/tests/codegen-preview-download.spec.ts)
— 24 helper-level tests, no React Testing Library:

- `isPreviewDownloadable` gate: null view, stale view,
  unavailable backend, ready with artifacts, all-blocked,
  all-failed, ready-with-zero-artifacts.
- `buildCodegenPreviewBundle`: kind + version + selection
  pinned; full artifact content survives the Sprint 89 line
  cap; full artifact content survives the Sprint 89 byte cap;
  artifacts deterministically path-sorted; manifest diagnostics
  shallow-cloned and decoupled from the input view.
- Backend `'all'`: all-blocked produces a manifest with every
  target recorded but `artifacts: []` and no fabricated content;
  mixed all (multiple ready / ready_with_warnings) carries every
  target's manifest diagnostics into the bundle.
- Filename helper: vendor selections, the `'all'` suffix, no
  timestamp / digit-group leak.
- Determinism + immutability: two calls on the same view yield
  byte-identical JSON; the helper never mutates
  `view.targets[…].artifacts[…]`.
- Privacy: serialised bundle text contains no `row_kind,`
  (CSV column header), no `<EplanProject` / `<TcecadProject`
  (XML root markers), no `%PDF-` (PDF magic), no `pir_version`
  (PIR-shape leak).
- `bundleHasArtifacts`: positive + empty-artifact cases.

## Bundle shape

Frozen by tests; bumped via `CODEGEN_PREVIEW_BUNDLE_VERSION` if
the JSON shape ever changes.

```jsonc
{
  "kind": "plc-copilot-codegen-preview",
  "version": 1,
  "selection": "siemens",            // or "codesys" / "rockwell" / "all"
  "status": "ready_with_warnings",   // aggregate verdict
  "summary": "1 target ready (warnings).",
  "targets": [
    {
      "target": "siemens",
      "status": "ready_with_warnings",
      "summary": "Generated 4 artifacts (2 warnings).",
      "artifacts": [
        {
          "path": "siemens/FB_StLoad.scl",
          "content": "FUNCTION_BLOCK \"FB_StLoad\"\n…",
          "sizeBytes": 1234,
          "kind": "scl"
        }
      ],
      "diagnostics": [
        {
          "severity": "warning",
          "code": "MISSING_PARAM_HINT",
          "message": "…",
          "path": "…",
          "hint": "…"
        }
      ],
      "error": { "code": "E_TARGET_FAILED", "message": "…" }
    }
  ]
}
```

- `selection` is the operator's backend choice as displayed in
  the panel — copied verbatim from the Sprint 89 view.
- `status` and `summary` mirror the panel's aggregate verdict /
  one-liner.
- `targets[].artifacts` is **empty** for every non-successful
  target (`unavailable` / `running` / `blocked` / `failed`) so
  the manifest still records why a target is missing without
  fabricating placeholders.
- `targets[].diagnostics` is the same severity-grouped, deduped
  manifest diagnostic list the panel shows under
  *Manifest diagnostics* — shallow-cloned per call.
- `targets[].error` is present only on `status === 'failed'`
  targets and preserves the original `CodegenError` `code`
  alongside the rendered message.
- Artifacts are path-sorted (`localeCompare`) for deterministic
  diffs across runs.

## Privacy guarantees

The bundle is a strict pass-through of vendor pipeline output.
What is in it:

- Generated code only (vendor artifact `content`, plus the
  artifact's `path` / `sizeBytes` / `kind`).
- Aggregate + per-target status, summary, manifest diagnostics,
  and (for failed targets) the original `CodegenError`.

What is **never** in it:

- Raw source bytes for any electrical ingestion source
  (CSV body, EPLAN XML body, TcECAD XML body, PDF bytes).
- The PIR `Project` payload itself (`pir_version`, `equipment[]`
  payloads, `io.channels[]`, etc.). The bundle records only the
  vendor outputs the preview already showed.
- A wall-clock timestamp. The helper is deterministic; if a
  future caller wants a clock suffix it can override at click
  time without touching the helper.

The privacy test in
[`packages/web/tests/codegen-preview-download.spec.ts`](../packages/web/tests/codegen-preview-download.spec.ts)
pins this with negative `not.toContain` assertions for the
characteristic markers above.

## Hard rules

- **Pure helper.** No DOM, no I/O, no clock, no random, no
  input mutation. Browser download is a one-line adapter on top
  of `downloadText`.
- **Built from current preview state.** The vendor pipeline is
  not re-run on download. The Sprint 89 view's
  `CodegenPreviewArtifactView.content` carries the full text;
  the helper just transcribes it.
- **Explicit user action.** The panel renders a separate
  *Download preview bundle* button. No auto-download, no
  piggy-backing on Generate, no piggy-backing on Refresh.
- **Disappear when nothing meaningful to download.** Stale
  views, all-blocked / all-failed previews, `unavailable`
  selections, and idle / running states do not render the
  button at all.
- **No persistence.** The Blob lives only as long as the
  operator's download. The helper never writes to
  `localStorage`. The bundle is not folded into the canonical
  session export.

## Manual verification checklist

1. Open `@plccopilot/web` in dev mode with an applied PIR.
2. Pick a backend in the codegen panel. Click
   *Preview generated artifacts*.
3. Wait for the preview to land in `ready` /
   `ready_with_warnings`. Confirm the *Download preview bundle*
   button appears next to *Refresh preview*.
4. Change the backend selection. The panel goes stale; the
   *Download preview bundle* button disappears.
5. Refresh the preview. Click *Download preview bundle*.
   Confirm the browser saves
   `plc-copilot-codegen-preview-<selection>.json`.
6. Open the JSON: `kind`, `version`, `selection`, `status`,
   `summary`, `targets[]` with full-content artifacts and
   manifest diagnostics. No raw CSV / XML / PDF bytes; no
   `pir_version` field; no wall-clock timestamp.
7. Pick backend `'all'`. Confirm every target appears in
   `targets[]` (even ones the readiness panel reported as
   blocked); blocked / failed / unavailable targets carry
   `artifacts: []`.
8. Apply a project that has no successful target (e.g. a
   readiness-blocked PIR for every backend). Confirm the
   *Download preview bundle* button does **not** appear.

## What stays out

- No zip bundle. The Sprint 78B-style multi-file zip already
  exists for canonical Generate output; Sprint 90A intentionally
  ships only the JSON manifest.
- No diff between two preview bundles. That is a UX layer for
  another sprint.
- No bundle re-ingestion. The bundle is a read-only artifact
  the operator can paste / archive; the CLI does not consume it.
- No persistence anywhere. If the operator wants to keep a
  bundle, they save the file the browser hands them.
