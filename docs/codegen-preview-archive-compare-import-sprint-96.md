# Sprint 96 — Imported archived comparison view

> **Status: shipped in `@plccopilot/web`.** Read-only round trip
> over the Sprint 95 archive-comparison bundle. The operator
> picks a previously downloaded
> `plc-copilot.codegen-preview-archive-compare` v1 JSON, and the
> panel renders it next to the Sprint 92 *Archived diff* section
> with the same visual vocabulary. The imported comparison
> cannot feed Generate, cannot mutate the archived diff, the
> live comparison snapshot, the current preview, the applied
> project, or any other panel state. No vendor pipeline re-run.
> No `localStorage`. No fold into the canonical session export.

## Why

Sprint 95 closed the *write* half of the comparison archive
cycle: operators can save a small auditable JSON of any Sprint
94 archive-vs-current comparison. Sprint 96 closes the *read*
half: the same JSON can be reopened in the browser without
leaving the panel. This unblocks workflows where operators want
to share a comparison verdict with a colleague, attach it to a
ticket, archive it weekly, or open last week's comparison side
by side with this week's — all without any path back into
Generate, the vendor pipeline, or the canonical export bundle.

## What ships

### New pure helper

[`packages/web/src/utils/codegen-preview-archive-compare-import.ts`](../packages/web/src/utils/codegen-preview-archive-compare-import.ts)

Exports:

- `parseCodegenPreviewArchiveCompareBundleText(input: string): ImportedCodegenPreviewArchiveCompareView`
  — single entry-point for the panel. Empty / whitespace-only
  → `'empty'`; bad JSON or v1 contract violation → `'invalid'`
  with a stable `error` string; success → `'loaded'` with the
  validated bundle.
- `parseCodegenPreviewArchiveCompareBundle(value: unknown): ImportedCodegenPreviewArchiveCompareView`
  — same semantics on an already-deserialised value.
- `isSupportedCodegenPreviewArchiveCompareBundle(value: unknown): boolean`
  — predicate the panel can use without inspecting the
  validated bundle.
- Type: `ImportedCodegenPreviewArchiveCompareView`
  (`status: 'empty' | 'loaded' | 'invalid'`, `summary`,
  optional `bundle`, optional `error`).

Helper invariants:

- **Total** — never throws on operator-supplied input.
- **Pure / DOM-free** — no DOM, no I/O, no clock, no random.
  The File API call lives in the panel layer.
- **Whitelist rebuild** — the validator constructs a fresh
  bundle from the v1 contract fields only. Any extra payload
  (a stray `content`, `previewText`, raw source bytes,
  `pir_version`) is dropped on the floor and never surfaces in
  the rebuilt bundle.
- **Deterministic** — two parses of the same input deep-equal.
- **Strict v1** — `kind` must be
  `plc-copilot.codegen-preview-archive-compare` and `version`
  must be `1`. Future bumps fail loudly.
- **No mutation** — the input value is never modified.
- **Reuses the Sprint 95 type tree** — no new bundle format
  introduced.

### Panel section

[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)

A new sibling section at the panel level — *Archived
comparison* — sits below the Sprint 94 live comparison section.

- **Action**: a `<label class="btn">` wrapping a hidden
  `<input type="file" accept="application/json,.json">`. The
  panel reads the file via `file.text()` and hands the string
  to the parser. The input is reset after each pick so
  re-importing the same filename re-fires `onChange`.
- **Empty state**: *"Archived comparison: none. Import a
  previously downloaded plc-copilot.codegen-preview-archive-
  compare JSON to inspect it read-only."*
- **Invalid state**: an error block with a stable, terse
  message (e.g. *"Could not import comparison bundle: expected
  kind plc-copilot.codegen-preview-archive-compare version
  1."*). No stack traces.
- **Loaded state**: filename, `archivedBackend` (and
  `currentBackend` when it differs), `snapshotName`, ISO
  `createdAt`, target count, the bundle's own `summary`
  headline, and per-target rows mirroring the Sprint 94 live
  comparison visuals — same `<details>` hierarchy, same
  status badges via Sprint 93's unified palette, same Expand
  all / Collapse all controls. A read-only notice reads
  *"Imported comparison is read-only. It does not affect the
  archived diff, current preview, Generate, or saved
  session."*
- **Clear**: a *Clear imported comparison* button drops the
  imported state back to empty. Refreshing the browser also
  drops it.

The section is independent of the Sprint 94 live comparison —
the operator can hold both at once without either one
poisoning the other.

### Tests

[`packages/web/tests/codegen-preview-archive-compare-import.spec.ts`](../packages/web/tests/codegen-preview-archive-compare-import.spec.ts)
— 34 helper-level tests. Coverage:

- Empty / malformed text (3): empty, whitespace, malformed
  JSON.
- Wrong kind / version (6): missing kind, Sprint 90A preview
  kind, Sprint 91 diff kind, wrong version, non-object input,
  null/undefined → empty.
- Round trip (9): real Sprint 95 changed bundle, unchanged
  bundle, selection-mismatch bundle, partially-comparable
  bundle, not-comparable target rows, `createdAt` preserved,
  `snapshotName` preserved, counts preserved verbatim,
  artifact + diagnostic order preserved.
- Whitelist / privacy (3): extra top-level fields stripped
  (`content`, `pir_version`, `rawPdfBytes`); extra per-artifact
  fields dropped (`content`, `previewText`, `rawCsv`); extra
  per-target fields dropped (`<EplanProject>`, `%PDF-`).
- Defensive validation (9): missing `targets`, unsupported
  target name, unsupported global state, unsupported target
  status, unsupported artifact status, malformed counts,
  malformed selection, missing `createdAt`, unparseable
  `createdAt`.
- Determinism / immutability / predicate (4): no input
  mutation, deterministic deep-equal, predicate mirrors the
  parser, empty-targets bundle accepted (Sprint 95 contract
  allows it).

## Bundle compatibility

Sprint 96 accepts **only** Sprint 95's v1 contract:

- `kind: 'plc-copilot.codegen-preview-archive-compare'`
- `version: 1`
- `createdAt: <parseable ISO string>`
- `snapshotName: string`
- `selection: { archivedBackend?, currentBackend?, selectionMatch }`
- `state: ArchivedPreviewComparisonState`
- `summary: string`
- `counts: { 9 numeric counters }`
- `targets: Array<{
    target ∈ {codesys, siemens, rockwell},
    status ∈ {same, changed, missing-current, missing-archived, not-comparable},
    summary, counts: { 8 numeric counters },
    artifactComparisons: Array<{ path, status, archivedHash?, currentHash?, archivedSizeBytes?, currentSizeBytes?, archivedStatus? }>,
    diagnosticComparisons: Array<{ status, severity, code, message, path?, hint?, archivedStatus? }>,
    archivedTargetStatus?, archivedRecordedCurrentStatus?, currentStatus?
  }>`

Any field outside this whitelist is dropped from the rebuilt
bundle. The Sprint 90A preview bundle, the Sprint 91 diff
bundle, and the Sprint 92 diff-bundle import payloads are all
rejected with a clear "wrong kind" error — they are different
artefacts, not degraded comparison bundles.

## Hard rules

- **Read-only.** The imported comparison cannot feed Generate,
  cannot change the live comparison snapshot, cannot modify the
  archived diff, cannot re-run the vendor pipeline, cannot
  reconstruct artifacts, cannot "restore" any state.
- **Ephemeral.** Imported state lives in React state only. No
  `localStorage`. No canonical export bundle. Refreshing the
  browser drops it.
- **No new bundle format.** Sprint 96 reuses Sprint 95's
  `CodegenPreviewArchiveCompareBundle` type verbatim.
- **No new dependencies.** Built on the existing File API
  (`file.text()`), the Sprint 95 types, and standard React
  hooks.
- **No worker / Generate / canonical export change.** Sprints
  89 → 95 helpers and bundle shapes are byte-identical.
- **Privacy.** The whitelist rebuild guarantees that even if a
  future format drift sneaks raw source bytes / PIR fields into
  the imported JSON, they never surface in the rebuilt bundle.

## Manual verification checklist

1. `pnpm web:dev`. Load a project / PIR.
2. Run preview, modify the project, refresh preview to produce
   a live diff. Click *Download diff bundle* (Sprint 91), save
   the JSON.
3. Refresh the browser. Run preview again.
4. *Import diff bundle* the JSON saved in step 2.
5. Click *Compare with current preview*. Click *Download
   comparison bundle* (Sprint 95). Save the JSON.
6. Refresh the browser. Confirm preview / diff / comparison
   sections all reset.
7. In the *Archived comparison* section, click *Import
   comparison bundle* and pick the JSON saved in step 5.
   Confirm the section flips to the loaded state with:
   - filename in the metadata line,
   - `archivedBackend` / `currentBackend` (when they differ),
   - `snapshotName`, ISO `createdAt`,
   - state badge + helper-rendered summary,
   - per-target rows with `<details>` *Artifacts ·* /
     *Diagnostics ·* lists,
   - read-only notice.
8. Click *Expand all* / *Collapse all*. Confirm the per-target
   `<details>` open and close in lockstep.
9. Click *Clear imported comparison*. Section returns to empty.
10. Edit the JSON externally (e.g. set `version: 2`) and import.
    Confirm invalid state with terse error and no crash.
11. Try importing a Sprint 91 diff bundle in the comparison
    importer. Confirm rejection with the kind-mismatch error.
12. Confirm the imported comparison has no effect on the live
    comparison snapshot, live diff, current preview, archived
    diff, or applied project.
13. Click *Generate* (canonical flow). Confirm canonical
    session export bundle byte-identical to its Sprint 95 shape
    — no imported-comparison fields.
14. Refresh the browser. Confirm imported comparison
    disappears.

## States

| State | When | Section render |
|---|---|---|
| `empty` | Operator has not picked a file (or cleared) | Empty copy. |
| `invalid` | JSON malformed, wrong kind, wrong version, missing required fields | Stable terse error block. |
| `loaded` | A real Sprint 95 v1 bundle | Metadata line + state badge + summary + per-target rows + read-only notice. |

## What stays out

- **No comparison-vs-current-preview meta-meta-compare.** The
  imported comparison is a one-way audit view.
- **No comparison-vs-comparison meta-meta-compare.**
- **No persistence.** Imported comparisons vanish on reload.
  Operators wanting to keep one already have the source JSON.
- **No syntax highlighting / monaco / pretty-print.**
- **No drag-and-drop.** Plain file picker is enough for v1.
- **No PIR / codegen-core / vendor renderer / electrical-ingest
  / CLI / worker / canonical Generate / canonical export-bundle
  changes.** Sprint 96 is web-only. No new dependencies.
