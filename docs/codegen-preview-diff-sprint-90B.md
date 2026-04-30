# Sprint 90B — Controlled codegen preview diff UX

> **Status: shipped in `@plccopilot/web`.** Layered on the Sprint 89
> preview panel + Sprint 90A download bundle. Adds a single
> ephemeral *Preview diff* section that compares the most recent
> successful preview against the previous successful preview the
> operator has seen in the same React session. Pure / DOM-free
> helper; no worker change; no localStorage; no export-bundle
> change; no codegen-core / vendor / electrical-ingest / PIR
> change.

## Why

By Sprint 90A the operator can:

- Run a Sprint 89 preview to see what *Generate* would produce.
- Download a deterministic JSON bundle of the current preview.

What was still missing: a way to answer *"what changed since the
last preview I ran?"* without reading two JSON dumps side by side.
Sprint 90B closes that gap with a small, opinionated diff projection
of the same already-computed preview state.

## What ships

### New pure helper

[`packages/web/src/utils/codegen-preview-diff.ts`](../packages/web/src/utils/codegen-preview-diff.ts)

Exports:

- `buildCodegenPreviewDiff(previous, current, options?) → CodegenPreviewDiffView`
- `summarizeCodegenPreviewDiff(diff) → CodegenPreviewDiffSummary`
- `deterministicContentHash(content) → string`  
  FNV-1a 32-bit hex hash. Dependency-free, deterministic, used as
  the artifact identity for the panel — *not* a cryptographic
  primitive.
- Types: `CodegenPreviewDiffView`, `CodegenPreviewTargetDiff`,
  `CodegenPreviewArtifactDiff`, `CodegenPreviewDiagnosticDiff`,
  `CodegenPreviewArtifactDiffLine`, `CodegenPreviewDiffSummary`.
- Constants: `MAX_DIFF_LINES_PER_ARTIFACT = 80`,
  `MAX_DIFF_BYTES_PER_ARTIFACT = 8 * 1024`.

Helper invariants:

- DOM-free, total, deterministic. Two calls on the same inputs
  produce byte-identical JSON.
- Never mutates the input views (deep-equal before/after pinned
  by tests).
- Tolerates `null` / `undefined` baseline or current — returns a
  meaningful `state: 'no-baseline' | 'no-current' | 'no-inputs'`.
- Compares by target + artifact `path`. Targets sort in the panel
  display order **siemens → codesys → rockwell**; artifacts sort
  by path inside each target.
- Compares artifact content from the Sprint 90A `content` field
  (full content), never against the Sprint 89 `previewText`
  snippet.
- Manifest diagnostics dedupe on a stable identity key
  `severity|code|message|path|hint`.
- Per-artifact textual diff is line-based (first divergence + a
  small context window before it; hard caps on lines and bytes;
  `truncated: true` flagged honestly).
- Selection mismatch (`previous.selection !== current.selection`)
  is surfaced via `selectionMatch: false`, not silently masked.

### Diff state in `CodegenPreviewPanel`

[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)
keeps the Sprint 89 phase machine + Sprint 90A download button
unchanged, and adds a tiny ephemeral state slot:

```ts
interface DiffSlots {
  previous: CodegenPreviewView | null;
  current:  CodegenPreviewView | null;
}
```

When a *new successful* preview lands (gated by Sprint 90A's
`isPreviewDownloadable({ view, stale: false })`), the slots advance
atomically — `previous = slots.current; current = newView`. A
failed / blocked / unavailable refresh leaves the slots untouched,
so a bad refresh never regresses the operator's baseline. Both
slots live only in React state — refresh the browser and they
vanish. Generate, the worker protocol, the canonical export bundle,
and Sprint 78B's per-session storage are untouched.

### Diff section in the panel

The new `<PreviewDiffSection>` renders below the Sprint 89 cards,
using the existing visual vocabulary (cards + `<details>`):

- **Stale view** → diff is paused with an honest "Refresh to
  re-compare" notice. No diff is recomputed against a stale
  current view.
- **No previous successful preview** → headline reads
  *"No previous preview to compare yet."*
- **Both sides successful + identical** →
  *"No changes from previous preview."*
- **Both sides successful + different** → one
  `<PreviewDiffTargetRow>` per *changed* target, with collapsible
  *Artifact changes* and *Diagnostic changes* lists. Changed
  artifacts show a compact unified-diff sample (line caps:
  ≤ 80 lines / 8 KB; truncation flagged).
- **Current preview is failed / blocked / unavailable** → the
  panel still shows the last known *previous* baseline state in
  the headline, but explicitly notes *"Current preview produced
  no successful target — comparing against the previous
  successful preview is not meaningful."* No artifact diffs are
  fabricated against the failed run.
- **Selection mismatch** (e.g. user previewed `siemens`, then
  switched to `all` and refreshed) → headline appends
  *"(different backend selections)"* and the per-target rows
  remain honest (siemens-only baseline → siemens unchanged,
  codesys + rockwell come in as `added`).

### Tests

[`packages/web/tests/codegen-preview-diff.spec.ts`](../packages/web/tests/codegen-preview-diff.spec.ts)
— 27 helper-level tests (no React Testing Library):

- Null / missing inputs (3): both null → `no-inputs`; baseline
  null → `no-baseline`; current null → `no-current`.
- Identity / unchanged (1): identical previews → unchanged with
  zeroed counts.
- Artifact diffs (4): added, removed, changed (with diff sample +
  hashes), unchanged (identical hash, no diff sample).
- Target-level transitions (3): target added, target removed,
  status changed `ready → failed`.
- Manifest diagnostics (3): added, removed, duplicates deduped
  before diffing.
- Deterministic sort (2): targets in display order; backend
  `'all'` mixed ready / blocked still diffs per target without
  fabricating changed artifacts on the blocked side.
- Content fidelity (4): full content used (snippet would have
  collapsed both sides identical); line-cap truncation; byte-cap
  truncation; cap constants pinned.
- Determinism, immutability, privacy, selection mismatch (7):
  no input mutation; byte-identical repeated calls; serialised
  diff contains no raw source markers (no `row_kind,` /
  `<EplanProject` / `<TcecadProject` / `%PDF-` / `pir_version`);
  `selectionMatch: false` surfaced; `summarizeCodegenPreviewDiff`
  matches inline summary; hash stable + sensitive; oversized
  content (> `MAX_PREVIEW_BYTES`) still hashes / diffs without
  crashing.

## Hard rules

- **Pure helper.** No DOM, no I/O, no clock, no random, no input
  mutation. The panel is a thin renderer.
- **Built from current preview state.** The vendor pipeline is
  *not* re-run for the diff. Both sides come from already-
  projected `CodegenPreviewView`s.
- **Ephemeral baseline.** Stored in React state only. Lost on
  page reload. Never persisted to `localStorage`. Never folded
  into the canonical session export. Never written to disk.
- **Failed / blocked refreshes do not regress the baseline.**
  Slots advance only when the new view is downloadable (matches
  Sprint 90A's gate). The operator can keep comparing against
  their last known good preview while iterating.
- **Stale views do not recompute.** When project / backend
  selection changes, the diff section pauses with a "Refresh to
  re-compare" notice rather than racing.
- **No fabricated diffs on blocked / failed targets.** When a
  target's current view is `blocked` / `failed` / `unavailable`,
  the helper emits status / diagnostic transitions only; no
  ghost "changed" artifacts are created.
- **No worker / Generate / export-bundle change.** The canonical
  flow stays exactly as it was after Sprint 90A.

## Manual verification checklist

1. `pnpm web:dev`. Load a simple CSV → review → Build PIR → Apply.
2. Click *Preview generated artifacts*. Expected: a `ready` /
   `ready_with_warnings` preview with the diff section showing
   *"No previous preview to compare yet."*
3. Click *Refresh preview* without changing anything. Expected:
   diff section flips to *"No changes from previous preview."*
4. Make a small project change (rename an equipment item, swap
   one IO address) → *Refresh preview*. Expected: per-target
   diff card with the affected artifacts listed under *Artifact
   changes*; the *Show diff sample* `<details>` reveals the
   line-by-line `+/-` sample, truncated only if the artifact is
   genuinely large.
5. Change the backend selection. Expected: panel goes stale, and
   the diff section reads *"Diff is paused while the preview is
   stale. Refresh the preview to re-compare against the previous
   successful run."*
6. *Refresh preview* in the new selection. Expected: diff
   compares against the previous successful preview from the
   prior selection; the headline appends
   *"(different backend selections)"* and per-target additions /
   removals reflect that honestly.
7. Backend `'all'`. Run preview, modify a parameter binding,
   refresh. Expected: three target cards in order siemens →
   codesys → rockwell, with diffs grouped per target.
8. `motor_vfd_simple` with a parameter binding: change a
   parameter id or name; expected the diff highlights the
   affected station / type artifact.
9. `pneumatic_cylinder_1pos`: readiness-blocked. Run preview;
   diff section reads
   *"Current preview produced no successful target — comparing
   against the previous successful preview is not meaningful."*
   No fabricated changed artifacts.
10. Click *Download preview bundle*. Confirm the JSON contains
    only the *current* preview content — never any diff state.
11. Refresh the browser tab. Both preview and diff disappear.
    *Generate* still works exactly as before.

## What stays out

- No Myers / Patience diff — the line-based first-divergence
  algorithm is intentional and tested.
- No syntax-highlight library, no monaco diff editor, no
  fancy renderer. The `<pre>` block is enough.
- No persisted history. Browsing prior diffs is a separate
  feature for a future sprint.
- No diff export. The Sprint 90A bundle stays the operator's
  durable artifact; the diff is a transient UI projection.
- No PIR / codegen-core / vendor / electrical-ingest / worker
  / export-bundle change. Web-only.
