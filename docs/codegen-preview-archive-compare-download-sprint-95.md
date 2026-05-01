# Sprint 95 — Download archive-comparison bundle

> **Status: shipped in `@plccopilot/web`.** Single explicit
> *Download comparison bundle* button next to the Sprint 94
> *Archived vs current preview* section. The bundle is a small
> auditable JSON serialised straight from the
> `ArchivedPreviewComparisonView` already in React state — no
> codegen re-run, no comparison recompute, no `localStorage`, no
> canonical session export, no raw source bytes, no full
> artifact content.

## Why

Sprints 91 → 94 closed the read-only audit cycle:

- **Sprint 91** — download a deterministic diff bundle.
- **Sprint 92** — import / inspect a saved diff bundle.
- **Sprint 93** — visual polish across panels.
- **Sprint 94** — compare imported diff vs. current preview
  inside the panel.

The Sprint 94 comparison view is already a deterministic answer
to *"is this old diff still relevant against today's preview?"*.
Sprint 95 is the smallest layer that lets the operator save that
answer alongside the Sprint 91 archived diff so the audit trail
survives a browser refresh.

## What ships

### New pure helper

[`packages/web/src/utils/codegen-preview-archive-compare-download.ts`](../packages/web/src/utils/codegen-preview-archive-compare-download.ts)

Exports:

- `isArchiveCompareDownloadable({ comparison, stale? })` — gate
  the panel uses to decide whether to render the button.
  Returns `false` for `null`, `stale === true`,
  `state === 'no-archived-diff'`, or
  `state === 'no-current-preview'`. Returns `true` for
  `unchanged-against-archive`, `changed-against-archive`,
  `partially-comparable`, and `selection-mismatch` (the latter
  archives an honest "you compared apples to oranges" answer).
- `buildCodegenPreviewArchiveCompareBundle({ comparison, createdAt?, snapshotName? })`
  — pure deterministic builder. Whitelist rebuild: copies only
  known fields from the comparison view. Defaults `createdAt`
  to `'1970-01-01T00:00:00.000Z'` and `snapshotName` to
  `'compare'` so tests stay deterministic; production callers
  pass `new Date().toISOString()`.
- `serializeCodegenPreviewArchiveCompareBundle(bundle)` —
  pretty-printed two-space-indent JSON.
- `codegenPreviewArchiveCompareFilename({ snapshotName? })` —
  deterministic filename:
  `plc-copilot-codegen-preview-archive-compare.json` (default)
  or
  `plc-copilot-codegen-preview-archive-compare-${slug}.json`
  with a sanitised snapshot name. The timestamp lives in the
  bundle's `createdAt` field, not in the filename.
- `sanitizeArchiveCompareSnapshotName(name)` — same `[a-z0-9-]+`
  / 64-char slug rules as Sprint 91's
  `sanitizePreviewDiffSnapshotName`.
- Constants:
  `CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_KIND =
  'plc-copilot.codegen-preview-archive-compare'`,
  `CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION = 1`.
- Public types: `CodegenPreviewArchiveCompareBundle`,
  `CodegenPreviewArchiveCompareBundleSelectionBlock`,
  `CodegenPreviewArchiveCompareBundleCounts`,
  `CodegenPreviewArchiveCompareBundleTarget`,
  `CodegenPreviewArchiveCompareBundleArtifactRow`,
  `CodegenPreviewArchiveCompareBundleDiagnosticRow`.

Helper invariants:

- **Pure / DOM-free / total / deterministic** when `createdAt`
  is supplied. The helper never calls `Date.now()` itself.
- **Whitelist rebuild.** Any extra payload (`content`,
  `previewText`, raw source bytes, `pir_version`) the renderer
  never reads but that may have snuck onto the comparison view
  is dropped on the floor. Pinned by tests.
- **No mutation.** Inputs are deep-equal before and after.
- **Stable order.** Targets stay in the comparison view's
  display order (siemens → codesys → rockwell, inherited from
  Sprint 90B); artifact rows sort by path inside each target.
- **No new diff algorithm.** Hashes / sizes / statuses are
  copied verbatim from Sprint 94's view, which already used
  Sprint 90B's `deterministicContentHash`.

### Bundle shape

Frozen by tests; bumped via
`CODEGEN_PREVIEW_ARCHIVE_COMPARE_BUNDLE_VERSION` if the JSON
shape ever changes.

```jsonc
{
  "kind": "plc-copilot.codegen-preview-archive-compare",
  "version": 1,
  "createdAt": "2026-05-01T12:00:00.000Z",
  "snapshotName": "compare",                 // sanitized; default 'compare'
  "selection": {
    "archivedBackend": "codesys",            // or siemens / rockwell / all
    "currentBackend":  "codesys",
    "selectionMatch":  true
  },
  "state": "changed-against-archive",        // ArchivedPreviewComparisonState
  "summary": "Archived diff differs from current preview — …",
  "counts": {
    "targetsCompared": 1,
    "targetsChanged": 1,
    "artifactsSame": 0,
    "artifactsChanged": 1,
    "artifactsMissingCurrent": 0,
    "artifactsNewCurrent": 0,
    "diagnosticsStillPresent": 0,
    "diagnosticsResolved": 0,
    "diagnosticsNewCurrent": 0
  },
  "targets": [
    {
      "target": "codesys",
      "status": "changed",                   // ArchivedTargetComparisonStatus
      "summary": "Target codesys differs from archived diff — 1 changed.",
      "archivedTargetStatus": "artifacts_changed",
      "archivedRecordedCurrentStatus": "ready",
      "currentStatus": "ready",
      "counts": {
        "artifactsSame": 0,
        "artifactsChanged": 1,
        "artifactsMissingCurrent": 0,
        "artifactsNewCurrent": 0,
        "artifactsNotComparable": 0,
        "diagnosticsStillPresent": 0,
        "diagnosticsResolved": 0,
        "diagnosticsNewCurrent": 0
      },
      "artifactComparisons": [
        {
          "path": "codesys/x.st",
          "status": "changed-hash",
          "archivedStatus": "changed",
          "archivedHash": "9a8b7c6d",
          "currentHash":  "1234abcd",
          "archivedSizeBytes": 1,
          "currentSizeBytes": 1
        }
      ],
      "diagnosticComparisons": []
    }
  ]
}
```

### Panel button

[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)

`<ArchivedComparisonSection>` gains a *Download comparison
bundle* button next to *Clear comparison*. The button only
renders when `isArchiveCompareDownloadable({ comparison: view, stale })`
is true — i.e. a non-stale comparison whose state has audit
value. On click the panel calls
`buildCodegenPreviewArchiveCompareBundle({ comparison: view, createdAt: new Date().toISOString() })`,
serialises with `serializeCodegenPreviewArchiveCompareBundle`,
and hands the result to the existing `downloadText` adapter
([`packages/web/src/utils/download.ts`](../packages/web/src/utils/download.ts)).
No zip. No new dependency.

The existing read-only notice gains a privacy reminder:
*"Downloaded comparison bundles contain hashes, statuses, and
capped diagnostic / artifact metadata only — not generated
artifact content."*

### Tests

[`packages/web/tests/codegen-preview-archive-compare-download.spec.ts`](../packages/web/tests/codegen-preview-archive-compare-download.spec.ts)
— 30 helper-level tests. Coverage:

- Gate (8): null, stale, no-archived-diff, no-current-preview;
  unchanged-against-archive, changed-against-archive,
  partially-comparable, selection-mismatch.
- Shape (12): kind + version + state + summary; explicit
  `createdAt` preserved; default `createdAt` is parseable ISO;
  invalid `createdAt` falls back to deterministic default;
  selection block (both backends + selectionMatch); counts
  equal the comparison view counts; target order; artifact
  paths sorted within each target; artifact hash whitelisting;
  diagnostic rows flattened (severity / code / message / status);
  not-comparable target rows survive; selection-mismatch
  faithful; unchanged-against-archive clean state.
- Whitelist / privacy (3): polluted artifact rows do not leak
  `content` / `previewText` / `rawCsv`; polluted top-level
  fields dropped (`%PDF-`, `pir_version`, `<EplanProject>`);
  polluted diagnostic rows dropped.
- Filename / sanitiser (3): default snapshot name omits suffix;
  custom name lands sanitised; sanitiser collapses runs / drops
  unsafe chars / clamps to 64.
- Determinism, immutability, roundtrip (4): no input mutation;
  byte-stable repeated calls; `JSON.parse(serialize(bundle))`
  deep-equals the bundle; empty target list still produces a
  clean bundle.

## Hard rules

- **Pure helper.** No DOM, no I/O, no clock, no random, no
  input mutation.
- **Built from the comparison snapshot already in state.** The
  vendor pipeline is not re-run on Download. The comparison is
  not recomputed.
- **No new format leakage.** No `"content"` key anywhere in the
  bundle (pinned by tests). No `previewText`. No raw source
  markers (`row_kind,`, `<EplanProject`, `<TcecadProject`,
  `%PDF-`). No `pir_version` or other PIR fields.
- **No localStorage.** No canonical export-bundle change. The
  bundle exists only as a Blob the operator's browser saves.
- **No worker / Generate / canonical export change.** Sprints
  89 → 94 helpers and bundle shapes are byte-identical.
- **Stale comparisons are not downloadable.** The button hides
  when the snapshot's inputs moved; the operator must click
  *Compare with current preview* again first.

## Downloadable / non-downloadable states

| State | Downloadable | Notes |
|---|---|---|
| `unchanged-against-archive` | ✅ | Records a clean audit answer. |
| `changed-against-archive` | ✅ | Records the drift with hashes / counts. |
| `partially-comparable` | ✅ | Records overlap + the rest as missing-archived / missing-current. |
| `selection-mismatch` | ✅ | Records the apples-to-oranges answer honestly. |
| `no-archived-diff` | ❌ | No comparison to archive. |
| `no-current-preview` | ❌ | No comparison to archive. |
| Any state, but stale | ❌ | The snapshot's inputs moved. |
| `comparison === null` | ❌ | Operator never clicked Compare. |

## Manual verification checklist

1. `pnpm web:dev`. Load a project / PIR.
2. Run preview, modify the project, refresh preview, *Download
   diff bundle* (Sprint 91), save the JSON.
3. Refresh the browser. Run preview again.
4. *Import diff bundle* the JSON saved in step 2.
5. Click *Compare with current preview*. Expected: comparison
   section appears with a *Download comparison bundle* button.
6. Click *Download comparison bundle*. Save the JSON. Open it:
   - `kind === 'plc-copilot.codegen-preview-archive-compare'`,
   - `version === 1`,
   - `createdAt` is a real ISO timestamp,
   - `state`, `summary`, `selection`, `counts`, `targets[]` all
     present,
   - artifact rows carry `path`, `status`, `archivedHash`,
     `currentHash`, `archivedSizeBytes`, `currentSizeBytes`,
   - **no** `"content"` key anywhere,
   - **no** `previewText` key anywhere,
   - **no** raw source markers (`row_kind,`, `<EplanProject`,
     `%PDF-`, `pir_version`).
7. Tweak the project, refresh preview. Expected: the comparison
   section flips to stale and the *Download comparison bundle*
   button disappears.
8. Click *Compare with current preview* again. Button reappears
   with the new state.
9. Switch the backend to a non-overlapping vendor → click
   Compare. Expected: state reads *Selection mismatch* and the
   button is still available (the bundle records the mismatch
   honestly).
10. Click *Clear comparison*. Expected: the section disappears,
    the download button with it.
11. Click *Generate* (canonical flow). Expected: canonical
    session export bundle byte-identical to its Sprint 94
    shape — no comparison fields, no imported state.
12. Refresh the browser. Expected: comparison snapshot, imported
    diff, live diff, preview — all gone.

## Examples

### Same as archive (downloadable)

```json
{
  "kind": "plc-copilot.codegen-preview-archive-compare",
  "version": 1,
  "createdAt": "2026-05-01T12:00:00.000Z",
  "snapshotName": "compare",
  "selection": { "archivedBackend": "codesys", "currentBackend": "codesys", "selectionMatch": true },
  "state": "unchanged-against-archive",
  "summary": "Current preview matches the archived diff for comparable artifacts and diagnostics.",
  "counts": { /* … */ },
  "targets": [{ "target": "codesys", "status": "same", /* … */ }]
}
```

### Selection mismatch (downloadable)

```json
{
  "state": "selection-mismatch",
  "selection": { "archivedBackend": "codesys", "currentBackend": "rockwell", "selectionMatch": false },
  "summary": "Archived diff was created for backend codesys, but current preview is rockwell. No comparable targets.",
  "targets": [
    { "target": "codesys", "status": "missing-current", /* … */ },
    { "target": "rockwell", "status": "missing-archived", /* … */ }
  ]
}
```

### Stale (NOT downloadable)

The button hides; the section shows *"Comparison is stale —
click Compare with current preview again to refresh."* The
operator must re-click Compare before they can archive a fresh
answer.

## What stays out

- **No imported comparison-bundle parser.** Sprint 96 is the
  natural follow-up if the operator wants to reopen an old
  comparison JSON.
- **No round-trip with the canonical export bundle.** The
  comparison bundle is operator-owned only.
- **No comparison-vs-comparison meta-meta-compare.**
- **No persistence anywhere.** The comparison snapshot vanishes
  on browser refresh; the bundle is whatever the operator saves
  to disk.
- **No new dependencies.** Reuses Sprint 89 / 90A / 90B / 91 /
  92 / 93 / 94 helpers + types.
- **No PIR / codegen-core / vendor renderer / electrical-ingest
  / CLI / worker / canonical Generate / canonical export-bundle
  changes.** Sprint 95 is web-only.
