# Sprint 93 — Visual polish for preview / diff panels

> **Status: shipped in `@plccopilot/web`.** Web-only, no schema /
> contract / worker / Generate / `localStorage` / canonical-export
> change. Sprints 89 → 92 left the readiness / preview / live diff
> / archived diff panels feature-complete; this sprint pulls every
> piece of inline copy and per-component status-class mapping into
> one pure helper so the operator-visible surface is uniform.

## Why

By the close of Sprint 92 the panels were functionally complete
but visually uneven:

- *Manifest diagnostics (2)* vs. *Diagnostics: 2 warnings* —
  same data, different framing.
- Live diff → *Preview diff*; archived → *Archived diff* — same
  feature, different heading verb.
- Three different blue badges for "this is changed" depending
  on which panel you were in.
- No way to expand all per-target rows at once when triaging a
  large `'all'` backend diff.

Sprint 93 fixes the surface without touching the bundle shapes,
the helper contracts, the worker, or the canonical Generate
flow.

## What ships

### New pure helper

[`packages/web/src/utils/codegen-preview-panel-view.ts`](../packages/web/src/utils/codegen-preview-panel-view.ts)

Owns every renderer-shared piece of copy + every status →
polish-token mapping. Pure / DOM-free / total / deterministic;
never mutates inputs.

Exports:

- **Constants** — `IMPORTED_DIFF_READ_ONLY_NOTICE`,
  `STALE_PREVIEW_NOTICE`, `STALE_DIFF_NOTICE`. The renderer
  references these so the wording cannot drift between
  components.
- **Status labels** — `PREVIEW_STATUS_LABEL`,
  `READINESS_STATUS_LABEL`, `TARGET_DIFF_STATUS_LABEL`,
  `ARTIFACT_DIFF_STATUS_LABEL`. Same string in every panel.
- **Polish tokens** — `previewStatusPolishToken`,
  `readinessStatusPolishToken`,
  `targetDiffStatusPolishToken`,
  `artifactDiffStatusPolishToken`,
  `diagnosticChangeStatusPolishToken`, `severityPolishToken`.
  Each returns a `PolishStatusToken`
  (`'ready' | 'warning' | 'blocked' | 'failed' | 'unavailable'
  | 'running' | 'added' | 'removed' | 'changed' | 'unchanged'
  | 'info'`). Unknown statuses fall back to `'unavailable'` /
  `'unchanged'` / `'info'` rather than throwing.
- **Class builder** — `statusBadgeClass(token)` returns the
  unified `badge status-badge status-badge--<token>` class
  string. The renderer attaches this **alongside** the existing
  per-panel class (`.preview-badge--ready`,
  `.readiness-badge--ready`, `.preview-diff-badge--changed`, …)
  so the legacy CSS keeps working and the new palette wins by
  cascade.
- **Summary formatters** — `formatArtifactCountSummary`,
  `formatPreviewSnippetSummary`,
  `formatManifestDiagnosticSummary`,
  `formatReadinessGroupSummary`,
  `formatArtifactChangesSummary`,
  `formatDiagnosticChangesSummary`,
  `formatDiagnosticChangesSummaryFromArtifactDiff`,
  `formatDiffSampleSummary`, `formatTargetDiffOneLiner`,
  `formatArchivedTargetOneLiner`. Examples:
  *Artifacts · 4 files (1 truncated)*,
  *Manifest diagnostics · 1 error · 2 warnings*,
  *Artifact changes · 1 added · 2 changed*,
  *Diff sample · siemens/FB.scl (truncated)*,
  *2 added, 0 removed, 1 changed; no diagnostic changes.*
- **Expand helper** — `setAllExpanded(keys, open)` returns a
  fresh record. (Reserved for future per-key expand modes; the
  current panels use a generation-counter pattern that does not
  call this directly.)

### Renderer updates

**[`packages/web/src/components/CodegenReadinessPanel.tsx`](../packages/web/src/components/CodegenReadinessPanel.tsx)**

- Drops the inline `STATUS_LABEL` map; pulls
  `READINESS_STATUS_LABEL` and the unified
  `statusBadgeClass(readinessStatusPolishToken(view.status))`
  from the helper. Severity badges on the readiness groups now
  use the same `statusBadgeClass(severityPolishToken(...))`.

**[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)**

- Live-diff section heading is now *Live diff* (was *Preview
  diff*). Archived heading was already *Archived diff*. The two
  panels read like a pair.
- Stale notices, the imported-diff read-only notice, and every
  `<details>` summary go through the helper.
- Live + archived diff sections gain *Expand all* /
  *Collapse all* buttons. Implementation: a generation counter
  bumps on each click; per-target `<details>` rows are keyed by
  `target + generation` so they remount with the new initial
  state, after which the user toggles each one freely. State is
  React-local, never persisted.
- Every status badge across `<PreviewCard>`,
  `<PreviewDiffTargetRow>`, `<PreviewDiffArtifactRow>`,
  `<PreviewDiffDiagnosticRow>`, `<ManifestDiagnosticRow>`,
  `<ImportedDiffTargetRow>`, `<ImportedDiffArtifactRow>`, and
  `<ImportedDiffDiagnosticRow>` now attaches both the unified
  `status-badge--<token>` class and the legacy per-panel class.

**[`packages/web/src/styles.css`](../packages/web/src/styles.css)**

- New `.status-badge` base class + `.status-badge--<token>`
  rules for all 11 polish tokens, using the same hex values the
  pre-existing per-panel classes already used. No redesign.
- New `.btn-subtle` for the *Expand all* / *Collapse all*
  buttons so they do not compete with the primary download
  buttons visually.
- New `.codegen-preview-stale` + `.codegen-preview-imported-diff-readonly`
  rules so stale and read-only notices render with a discreet
  visual hint instead of looking like fatal errors.

### Tests

[`packages/web/tests/codegen-preview-panel-view.spec.ts`](../packages/web/tests/codegen-preview-panel-view.spec.ts)
— 24 helper-level tests (no React Testing Library):

- Constants: imported-diff read-only notice, stale notices.
- Status labels: every renderer enum mapped.
- Status → polish-token mapping for preview / readiness /
  target-diff / artifact-diff / diagnostic-change / severity.
- Unknown statuses fall back to safe defaults (no throw).
- `statusBadgeClass` returns the unified class set.
- Summary formatters: 0 / 1 / N artifacts; truncated count;
  severity grouping (error / warning / info, singular /
  plural); zero-bucket skipping in artifact-change summaries;
  truncated marker on diff samples.
- Target one-liner: live + archived versions identical wording.
- `setAllExpanded`: returns fresh map, empty-input edge case,
  no input mutation.

## Hard rules

- **Web-only.** No PIR / codegen-core / vendor renderer /
  electrical-ingest / CLI / worker / canonical Generate /
  canonical export-bundle changes.
- **No new dependencies.** Pure helper + standard React hooks +
  CSS.
- **No bundle / contract / schema changes.** The Sprint 90A
  preview bundle, Sprint 91 diff bundle, and Sprint 92
  imported-bundle parser stay byte-identical. The Sprint 90B
  diff helper stays byte-identical.
- **No persistence.** Expand / collapse state is React-local.
  Refreshing the browser drops it (along with everything else
  Sprints 89–92 keep ephemeral).
- **No re-run of codegen.** Every action that already existed
  keeps the exact same semantics; the polish only changes what
  the operator reads / sees.

## Manual verification checklist

1. `pnpm web:dev`. Load a project / PIR and click *Build PIR* →
   *Apply*.
2. *Codegen readiness* renders cards with the new unified
   badges; severity badges in the readiness groups match the
   live-diff / archived-diff colours for the same severity.
3. Click *Preview generated artifacts*. Each target card's
   `<details>` summaries read *Artifacts · N files*,
   *Manifest diagnostics · …*, *Readiness diagnostics · …*.
4. Pick `'all'` backend → modify project → *Refresh preview*.
   The live-diff section heading reads *Live diff*. Click
   *Expand all*: every target row's *Artifact changes* +
   *Diagnostic changes* `<details>` opens. Click an individual
   `<details>` to close it — it stays closed. Click *Collapse
   all* to remount everything closed.
5. Click *Download diff bundle*. Refresh the browser. Confirm
   the live diff disappears and *Archived diff* shows the empty
   copy.
6. Import the JSON saved in step 5. *Archived diff* renders
   with the same per-target visuals as the live diff, the
   read-only notice has a discreet outlined background (not red,
   not error-shaped), and *Expand all* / *Collapse all* work
   independently from the live-diff controls.
7. Edit the JSON to set `version: 2` and reimport. The error
   block is red on a light-red background — clearly distinct
   from the discreet read-only notice.
8. Confirm *Generate* still works exactly as before. Confirm
   the canonical session export bundle byte-equals its Sprint
   92 shape (no new fields, no polish state, no expand state).
9. Refresh the browser. Confirm *Live diff*, *Archived diff*,
   and the expand/collapse state all reset.

## What stays out

- No comparison between imported diff and current preview.
  That is Sprint 94 if it ships.
- No syntax highlighting / monaco / prettifier in the diff
  sample.
- No drag-and-drop import.
- No persisted expand state across reloads.
- No artifact full-content modal.
- No new bundle format.
- No new dependencies.
