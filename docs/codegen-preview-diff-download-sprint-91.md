# Sprint 91 — Controlled codegen preview diff download bundle

> **Status: shipped in `@plccopilot/web`.** Single explicit
> *Download diff bundle* action sits next to the Sprint 90B
> *Preview diff* headline. The bundle is a small auditable JSON
> built **from the already-computed Sprint 90B diff** — no re-run
> of the vendor pipeline, no Generate change, no worker change.
> No `localStorage`. No inclusion in the canonical session export.
> No raw source bytes. No PIR fields. The diff archive carries
> only Sprint 90B's already-capped diff sample (≤ 80 lines / 8 KB
> per artifact, `truncated: true` flagged honestly) — never the
> full artifact content.

## Why

Sprint 90B let the operator *see* what changed between the most
recent successful preview and the prior successful one in the
same React session. Operators asked for a way to *take that diff
out of the browser* — paste into a code review, attach to a Jira
ticket, archive next to the Sprint 90A preview bundle — without
the bulk of a full artifact bundle and without any path for the
diff to leak raw source bytes.

Sprint 91 is the smallest layer that closes that gap:

- One explicit user action. No auto-download, no piggy-backing
  on Generate / Preview / *Download preview bundle*.
- Bundle is built from the Sprint 90B diff that the panel
  already computed for rendering. The vendor pipeline is **not**
  re-run on click.
- Bundle is a **diff archive**, not an **artifact archive**.
  Unchanged artifacts are omitted; changed artifacts carry only
  Sprint 90B's already-capped line-based sample plus FNV-1a
  hashes for identity. The Sprint 90A *full content* field is
  intentionally absent.
- Bundle never reaches `localStorage`, never folds into the
  canonical session export, never persists across the page.

## What ships

### New pure helper

[`packages/web/src/utils/codegen-preview-diff-download.ts`](../packages/web/src/utils/codegen-preview-diff-download.ts)

Exports:

- `isPreviewDiffDownloadable({ previousView, currentView, stale })`
  — gate the panel uses to decide whether to render the button.
  Returns `false` for any of: stale, missing baseline, missing
  current, or current view that is not itself a Sprint 90A
  downloadable preview (failed / blocked / unavailable / no
  artifacts).
- `buildCodegenPreviewDiffBundle({ previousView, currentView, snapshotName? })`
  — single-arg deterministic builder. Internally calls
  `buildCodegenPreviewDiff` exactly once; never mutates inputs.
- `serializeCodegenPreviewDiffBundle(bundle)` — pretty-printed
  two-space-indent JSON.
- `createCodegenPreviewDiffFilename(bundle)` — deterministic
  filename derived from the bundle's selection + sanitised
  snapshot name. No timestamp.
- `sanitizePreviewDiffSnapshotName(name)` — reduces free-form
  input to a `[a-z0-9-]+` slug, collapses runs, trims dashes,
  capped at 64 chars; empty / whitespace-only / all-punctuation
  input collapses to `''` so the caller can fall back to the
  default `'diff'`.
- Constants: `CODEGEN_PREVIEW_DIFF_BUNDLE_KIND =
  'plc-copilot.codegen-preview-diff'`,
  `CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION = 1`.
- Types: `CodegenPreviewDiffBundle`,
  `CodegenPreviewDiffBundleTarget`,
  `CodegenPreviewDiffBundleArtifactChange`,
  `CodegenPreviewDiffBundleDiagnosticChange`,
  `CodegenPreviewDiffBundleCounts`,
  `CodegenPreviewDiffBundleSelectionBlock`.

Helper invariants:

- Pure / DOM-free / total / deterministic. Two calls on the
  same inputs produce byte-identical JSON.
- Never mutates the input views.
- Tolerates any combination of inputs the gate rejects (the
  builder is called by the panel only after the gate passes,
  but the internal `buildCodegenPreviewDiff` is happy to receive
  anything — failure is silently surfaced via the diff state).
- Backend `'all'` target order is preserved
  (siemens → codesys → rockwell), inheriting Sprint 90B's sort.
- Manifest diagnostics inherit Sprint 90B's dedupe on
  `severity|code|message|path|hint`.
- Selection mismatch (`previous.selection !== current.selection`)
  is recorded in the bundle as `selection.selectionMatch: false`
  with both backends preserved for auditability.
- Bundle's `targets[].artifactChanges[]` filters out
  `unchanged` rows on purpose — the bundle is a diff archive.
- No `"content"` key anywhere in the bundle (pinned by tests).

### Bundle shape

Frozen by tests; bumped via `CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION`
if the JSON shape ever changes.

```jsonc
{
  "kind": "plc-copilot.codegen-preview-diff",
  "version": 1,
  "snapshotName": "diff",
  "selection": {
    "backend": "codesys",            // or siemens / rockwell / all
    "previousBackend": "codesys",
    "selectionMatch": true
  },
  "state": "changed",                // or "unchanged"
  "summary": "1 of 1 target changed — 1 added, 0 removed, 1 changed artifacts.",
  "counts": {
    "targetsCompared": 1,
    "targetsChanged": 1,
    "artifactsAdded": 1,
    "artifactsRemoved": 0,
    "artifactsChanged": 1,
    "diagnosticsChanged": 0
  },
  "targets": [
    {
      "target": "codesys",
      "state": "changed",
      "targetStatus": "artifacts_changed",
      "previousStatus": "ready",
      "currentStatus": "ready",
      "counts": {
        "artifactsAdded": 1,
        "artifactsRemoved": 0,
        "artifactsChanged": 1,
        "diagnosticsAdded": 0,
        "diagnosticsRemoved": 0
      },
      "artifactChanges": [
        {
          "path": "codesys/add.st",
          "status": "added",
          "currentSizeBytes": 1,
          "currentHash": "8e3f5d4d"
        },
        {
          "path": "codesys/keep.st",
          "status": "changed",
          "previousSizeBytes": 1,
          "currentSizeBytes": 5,
          "previousHash": "abcd1234",
          "currentHash": "5678ef90",
          "diff": {
            "truncated": false,
            "firstDifferingLine": 1,
            "lines": [
              { "status": "removed", "previousLine": 1, "text": "K" },
              { "status": "added",   "currentLine":  1, "text": "K_NEW" }
            ]
          }
        }
      ],
      "diagnosticChanges": []
    }
  ]
}
```

Per-target `artifactChanges[]` is sorted by path; `state` is the
coarse `unchanged | changed` verdict; `targetStatus` is Sprint
90B's fine-grained transition (`unchanged`, `added`, `removed`,
`status_changed`, `artifacts_changed`, `diagnostics_changed`)
kept for auditability.

### Panel button

[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)
renders a *Download diff bundle* button next to the *Preview
diff* headline. The button only appears when:

- `phase.kind === 'has-result'` (not stale, not idle, not
  running),
- the diff baseline (`diffSlots.previous`) exists,
- the current preview is itself a Sprint 90A downloadable
  preview (no failed / blocked / unavailable / empty-artifacts
  states surface a diff bundle).

On click the panel calls
`buildCodegenPreviewDiffBundle({ previousView, currentView })`,
serialises with `serializeCodegenPreviewDiffBundle`, and hands
the result to the existing `downloadText` adapter
([packages/web/src/utils/download.ts](../packages/web/src/utils/download.ts)).
Same Blob + synthetic `<a download>` + `revokeObjectURL` flow as
the Sprint 90A preview bundle. No zip dependency.

### Tests

[`packages/web/tests/codegen-preview-diff-download.spec.ts`](../packages/web/tests/codegen-preview-diff-download.spec.ts)
— 26 helper-level tests, no React Testing Library. Coverage:

- `isPreviewDiffDownloadable` gate (8): both null, no baseline,
  no current, stale, current failed, current all-blocked,
  unchanged, changed.
- Bundle happy paths (6): unchanged shape, changed paths with
  added / removed / changed, backend `'all'` target order +
  mixed counts, selection mismatch surfaces both backends,
  counts match Sprint 90B summary, status_changed preserves
  previousStatus / currentStatus and emits no fabricated
  artifact rows.
- Diagnostics + samples (4): added / removed surface, dedup
  preserved, capped diff sample (no `OLD_300` / `NEW_300`,
  no `"content"` key), unchanged artifacts omitted from
  `artifactChanges[]`.
- Filename / snapshot name (3): default omits suffix, custom
  name lands sanitised, sanitiser collapses runs / drops unsafe
  chars / clamps to 64 chars / handles undefined / null.
- Determinism, immutability, privacy (5): no input mutation;
  byte-identical repeated builds; no raw source markers
  (`row_kind,` / `<EplanProject` / `<TcecadProject` / `%PDF-`)
  and no `"pir_version"` in the serialised bundle; oversized
  single-line content past the diff byte cap is dropped (no
  `huge` substring, no `"content"` key); full Sprint 90A content
  fidelity preserved (snippet-truncated identical content does
  not collapse a real change).

## Hard rules

- **Pure helper.** No DOM, no I/O, no clock, no random, no input
  mutation. Browser download is a one-line adapter on top of
  `downloadText`.
- **Built from the already-computed Sprint 90B diff.** The
  vendor pipeline is not re-run on download. No Generate
  pathway is touched. The worker protocol is not touched.
- **Diff archive, not artifact archive.** No
  `"content":` key anywhere in the bundle. Unchanged artifacts
  do not appear in `artifactChanges[]`. Changed artifacts carry
  only Sprint 90B's already-capped line-based sample.
- **No raw source bytes.** No CSV / EPLAN / TcECAD / PDF body
  ever crosses the boundary. Privacy negative assertions pin
  this in tests.
- **No PIR-shape fields.** No `pir_version`, no project payload,
  no equipment / IO / parameters tree. Tests pin this.
- **Explicit user action.** A separate *Download diff bundle*
  button. No auto-download, no piggy-backing on Refresh / Preview
  / *Download preview bundle*. Stale views show a "Refresh
  preview to download an up-to-date diff bundle" notice.
- **No persistence.** Blob lives only as long as the operator's
  download. The helper never writes to `localStorage`. The
  bundle is never folded into the canonical session export.
- **No new dependencies.** Built on `downloadText`, the Sprint
  90B diff helper, and the Sprint 90A downloadability gate.

## Manual verification checklist

1. `pnpm web:dev`. Load a simple CSV → review → Build PIR → Apply.
2. Click *Preview generated artifacts*. Expected: a `ready` /
   `ready_with_warnings` preview, no diff visible (no baseline
   yet). The *Download diff bundle* button must NOT appear yet.
3. *Refresh preview* without changes. Expected: the diff section
   reads *"No changes from previous preview."*; the *Download
   diff bundle* button appears next to the diff headline.
4. Make a small project change → *Refresh preview*. Expected:
   *Download diff bundle* button still visible; click it. The
   browser saves
   `plc-copilot-codegen-preview-diff-<backend>.json`.
5. Open the JSON. Confirm:
   - `kind === 'plc-copilot.codegen-preview-diff'`,
     `version === 1`,
   - `selection.backend`, `selection.previousBackend`,
     `selection.selectionMatch` honest,
   - `state === 'changed'` with the expected counts,
   - `targets[].artifactChanges[]` only carries non-unchanged
     entries,
   - changed artifacts carry `diff.lines` capped (≤ 80) and
     `truncated` flagged when applicable,
   - **no** `"content"` key anywhere,
   - **no** `pir_version`, `<EplanProject`, `<TcecadProject`,
     `%PDF-`, or `row_kind,` substrings.
6. Change the backend selection. Expected: panel goes stale, the
   diff section reads *"…Refresh the preview to re-compare
   against the previous successful run and download an up-to-
   date diff bundle."*, and the *Download diff bundle* button
   disappears.
7. *Refresh preview* in the new selection. Confirm the
   *Download diff bundle* button reappears and the resulting
   JSON honestly reflects `selectionMatch: false` with both
   backends recorded.
8. Backend `'all'` with a mid-iteration parameter binding edit:
   bundle's `targets[]` is in display order siemens → codesys
   → rockwell, with per-target counts and diagnostics.
9. `pneumatic_cylinder_1pos`: readiness-blocked. The current
   view is not downloadable; *Download diff bundle* must NOT
   appear, regardless of whether a baseline exists.
10. Click *Download preview bundle*. Confirm the Sprint 90A
    bundle is unchanged (still carries the full preview state,
    with `content` fields per artifact).
11. Refresh the browser tab. Both preview and diff disappear;
    `localStorage` schema unchanged. *Generate* still works
    exactly as before.

## What stays out

- No diff-bundle import / re-ingestion. The bundle is a
  read-only artifact the operator archives or pastes; the CLI
  does not consume it.
- No syntax-highlight / monaco / pretty-print rendering. The
  diff sample stays a flat `+/-` line list inherited from
  Sprint 90B.
- No persistence anywhere. Diff bundles are saved only when the
  operator explicitly clicks the button and the browser writes
  the file to disk.
- No PIR / codegen-core / vendor renderer / electrical-ingest /
  CLI / worker / canonical Generate / canonical export-bundle
  changes. Sprint 91 is web-only.
