# Sprint 92 — Imported preview diff view

> **Status: shipped in `@plccopilot/web`.** Read-only round trip
> over the Sprint 91 diff bundle. The operator picks a previously
> downloaded `plc-copilot.codegen-preview-diff` v1 JSON, and the
> panel renders it next to the live preview / diff with the same
> visual vocabulary. The imported diff cannot feed Generate, cannot
> change preview baseline / current, cannot mutate the applied
> project, cannot re-run the vendor pipeline, cannot reach
> `localStorage`, and cannot fold into the canonical session
> export.

## Why

Sprint 91 closed the *write* half of the diff archive cycle:
operators can save a small, auditable JSON of any preview-vs-
preview comparison. Sprint 92 closes the *read* half: the same
JSON can be reopened in the browser without leaving the panel.
This unblocks four common operator workflows — pasting a diff
into a code review, attaching it to a Jira ticket, archiving
weekly snapshots, and comparing today's bundle against last
week's by opening both in two windows — without any path back
into Generate or the vendor pipeline.

## What ships

### New pure helper

[`packages/web/src/utils/codegen-preview-diff-import.ts`](../packages/web/src/utils/codegen-preview-diff-import.ts)

Exports:

- `parseCodegenPreviewDiffBundleText(input: string): ImportedCodegenPreviewDiffView`
  — single entry-point for the panel. Accepts the raw text from
  `<input type="file">.text()`. Empty / whitespace-only input
  returns `status: 'empty'`; bad JSON or contract violations
  return `status: 'invalid'` with a stable `error` string;
  success returns `status: 'loaded'` with the validated bundle.
- `parseCodegenPreviewDiffBundle(value: unknown): ImportedCodegenPreviewDiffView`
  — same semantics on an already-deserialised value. Useful
  when the panel decoded the file via paste / drag-and-drop.
- `isSupportedCodegenPreviewDiffBundle(value: unknown): boolean`
  — predicate the panel can use without inspecting the validated
  bundle.
- Type: `ImportedCodegenPreviewDiffView`
  (`status` ∈ `'empty' | 'loaded' | 'invalid'`, `summary`,
  optional `bundle`, optional `error`).

Helper invariants:

- **Total** — never throws on operator-supplied input.
- **Pure / DOM-free** — no DOM, no I/O, no clock, no random.
  The File API call lives in the panel layer.
- **Whitelist rebuild** — the validator constructs a fresh
  bundle from the v1 contract fields only. Any extra fields
  (e.g. a stray `content`, `pir_version`, raw source bytes)
  are dropped on the floor and never surface in the rebuilt
  bundle. Tests pin this with negative `not.toContain`
  assertions.
- **Deterministic** — two calls on the same input deep-equal.
- **Strict v1** — `kind` must be `plc-copilot.codegen-preview-diff`
  and `version` must be `1`. A future format bump fails loudly
  rather than silently auto-upgrading.
- **No mutation** — the helper does not modify the input
  object.
- **Reuses Sprint 91 types** — the validated bundle is exactly
  `CodegenPreviewDiffBundle` from
  [`packages/web/src/utils/codegen-preview-diff-download.ts`](../packages/web/src/utils/codegen-preview-diff-download.ts).
  Sprint 92 introduces no new bundle format.

### Panel section

[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)
keeps every Sprint 89 / 90A / 90B / 91 surface intact and adds a
new sibling section under the live preview body:

- **Section heading**: *Archived diff*.
- **Always visible** — independent of the `phase` machine. The
  operator can import a saved diff even when no live preview
  has been generated.
- **Action**: a `<label class="btn">` wrapping a hidden
  `<input type="file" accept="application/json,.json">`. The
  panel reads the file via `file.text()` and hands the string
  to `parseCodegenPreviewDiffBundleText`. The input is reset
  after each pick so re-importing the same filename re-fires
  `onChange`.
- **Empty state**: *"Imported diff: none. Import a previously
  downloaded plc-copilot.codegen-preview-diff JSON to inspect
  it read-only."*
- **Invalid state**: an error block with a stable, terse
  message (e.g. *"Could not import diff bundle: expected kind
  plc-copilot.codegen-preview-diff version 1."*). No stack
  traces, no JSON-parser internals.
- **Loaded state**: filename (when known), backend selection
  (with a *"was X"* suffix when the bundle records a different
  previous backend), snapshot name, target count, the bundle's
  own `summary` headline, and a per-target render that mirrors
  the Sprint 90B live diff — same `<details>` hierarchy, same
  `+/-` line samples, same status badges. A read-only notice
  reads *"Imported diff is read-only. It does not affect the
  current preview, Generate, or saved session."*
- **Clear**: a *Clear imported diff* button drops the imported
  state back to `empty`. Refreshing the browser also drops it
  (no persistence anywhere).

### Tests

[`packages/web/tests/codegen-preview-diff-import.spec.ts`](../packages/web/tests/codegen-preview-diff-import.spec.ts)
— 28 helper-level tests, no React Testing Library. Coverage:

- Empty / malformed text (3): empty, whitespace, malformed JSON.
- Wrong kind / version (5): missing kind, wrong kind (Sprint 90A
  preview bundle kind), wrong version, non-object input,
  null/undefined → empty.
- Round trip (7): real Sprint 91 changed bundle, real Sprint 91
  unchanged bundle, no mutation, two parses deep-equal,
  selection / counts preserved verbatim, artifact + diagnostic
  ordering preserved, backend `'all'` round trip.
- Whitelist / privacy (3): extra top-level fields stripped
  (`content`, `pir_version`, raw payloads), extra per-artifact
  fields dropped (`content`, `rawCsv`), extra per-target fields
  dropped (`<EplanProject>` substring).
- Defensive validation (8): missing `targets` array, unsupported
  target name (`core`), negative count, missing selection
  backend, unsupported state, malformed diagnostic (missing
  code), missing `snapshotName` defaults to `'diff'`,
  `previousBackend: null` accepted.
- `isSupportedCodegenPreviewDiffBundle` predicate (2): true for
  valid bundle; false for null / empty / wrong-kind input.

## Bundle compatibility

Sprint 92 accepts **only** Sprint 91's v1 contract:

- `kind: 'plc-copilot.codegen-preview-diff'`
- `version: 1`
- `selection: { backend, previousBackend, selectionMatch }`
- `state: 'unchanged' | 'changed'`
- `summary: string`
- `counts: { targetsCompared, targetsChanged, artifactsAdded,
  artifactsRemoved, artifactsChanged, diagnosticsChanged }`
- `targets: Array<{ target, state, targetStatus, counts,
  artifactChanges, diagnosticChanges, previousStatus?,
  currentStatus? }>`

Any field outside this whitelist is dropped from the rebuilt
bundle. The Sprint 90A *preview bundle* (`kind:
'plc-copilot-codegen-preview'`) is rejected with a clear "wrong
kind" error — it is a different artefact, not a degraded diff.

## Hard rules

- **Read-only.** The imported diff cannot feed Generate, cannot
  change `appliedProject`, cannot modify Sprint 90B preview
  baseline / current, cannot re-run the vendor pipeline, cannot
  reconstruct artifacts, cannot "restore" a preview state.
- **Ephemeral.** Imported state lives in React state only. No
  `localStorage`. No canonical export bundle. Refreshing the
  browser drops the imported diff.
- **No new bundle format.** Sprint 92 reuses Sprint 91's
  `CodegenPreviewDiffBundle` type verbatim.
- **No new dependencies.** Built on the existing File API
  (`file.text()`), the Sprint 91 types, and standard React
  hooks.
- **No worker / Generate / export-bundle change.** Generate
  still runs in the existing worker exactly as before. The
  canonical session export is byte-identical to its Sprint 91
  shape.
- **Privacy.** The whitelist rebuild guarantees that even if a
  future format drift sneaks raw source bytes / PIR fields into
  the imported JSON, they never surface in the rebuilt bundle.

## Manual verification checklist

1. `pnpm web:dev`. Load a project / PIR and click *Preview
   generated artifacts*.
2. Modify the project so the next preview will diff. *Refresh
   preview* → live diff appears.
3. Click *Download diff bundle* (Sprint 91). Save the JSON.
4. Refresh the browser tab. Confirm preview / live diff /
   download buttons all reset to idle (no persistence).
5. In the *Archived diff* section, click *Import diff bundle*
   and pick the JSON saved in step 3. Confirm:
   - the section flips to the loaded state,
   - filename appears in the metadata line,
   - backend, snapshot name, and target count are correct,
   - per-target rows render with the same badges and `<details>`
     entries the live diff shows,
   - the read-only notice appears.
6. Click *Clear imported diff*. Confirm the section returns to
   the empty state and the filename label disappears.
7. Re-import the same file (the `<input>` reset means the
   onChange refires). Confirm the loaded state returns
   identically.
8. Edit the JSON externally (e.g. set `version: 2`) and import.
   Confirm the section flips to invalid with a terse error and
   no crash.
9. Import a Sprint 90A *preview bundle* (different `kind`).
   Confirm rejection with the same kind-mismatch error.
10. Confirm the imported diff has no effect on the live preview
    or live diff: re-run *Refresh preview* and watch the live
    diff update independently.
11. Click *Generate* (canonical flow). Confirm the canonical
    session export bundle does NOT include the imported diff
    (byte-identical to its Sprint 91 shape).
12. Refresh the browser. Confirm the imported diff disappears.

## What stays out

- **No drag-and-drop.** A plain file picker is enough for the
  v1 round trip.
- **No persistence.** Imported diffs vanish on reload. If the
  operator wants to keep one, the source JSON is already on
  disk.
- **No "compare imported vs current".** That is Sprint 93 if it
  ships at all; for now the imported view is a standalone
  read-only snapshot.
- **No artifact reconstruction / "restore preview from diff".**
  The diff bundle deliberately omits full artifact content, so
  there is nothing to reconstruct.
- **No syntax highlighting / monaco / pretty-print.** The diff
  sample stays the same flat `+/-` block as the live diff.
- **No PIR / codegen-core / vendor renderer / electrical-ingest
  / CLI / worker / canonical Generate / canonical export-bundle
  changes.** Sprint 92 is web-only.
