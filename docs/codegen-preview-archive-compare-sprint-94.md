# Sprint 94 — Compare archived diff with current preview

> **Status: shipped in `@plccopilot/web`.** Read-only meta-compare
> between a Sprint 91 archived diff bundle (loaded via Sprint 92's
> import) and the live Sprint 89 preview view, rendered next to
> the existing *Archived diff* / *Live diff* sections. The
> comparison cannot feed Generate, cannot mutate the archived
> diff, cannot mutate the current preview, cannot change the
> Sprint 90B baseline / current slots, cannot re-run the vendor
> pipeline, cannot reach `localStorage`, and cannot fold into the
> canonical session export bundle.

## Why

By the close of Sprint 93 the archived diff round trip was
complete:

- **Sprint 89** — controlled preview UX.
- **Sprint 90A** — download preview bundle.
- **Sprint 90B** — live preview diff (previous successful vs.
  current).
- **Sprint 91** — download diff bundle (deterministic JSON).
- **Sprint 92** — import / read-only render of a saved diff
  bundle.
- **Sprint 93** — visual polish + Expand all / Collapse all.

Operators routinely need to answer *"is this old diff still
relevant against today's preview?"* without leaving the panel.
Sprint 94 is the smallest layer that closes that question: it
takes the archived `CodegenPreviewDiffBundle` already loaded by
Sprint 92 and the `CodegenPreviewView` already produced by
Sprint 89, and renders a deterministic comparison between them.

## What ships

### New pure helper

[`packages/web/src/utils/codegen-preview-archive-compare.ts`](../packages/web/src/utils/codegen-preview-archive-compare.ts)

Single export:

```ts
compareImportedDiffWithCurrentPreview(args: {
  importedBundle: CodegenPreviewDiffBundle | null | undefined;
  currentView:    CodegenPreviewView       | null | undefined;
}): ArchivedPreviewComparisonView
```

Plus the public types: `ArchivedPreviewComparisonView`,
`ArchivedPreviewComparisonState`, `ArchivedPreviewComparisonTarget`,
`ArchivedTargetComparisonStatus`, `ArchivedArtifactComparison`,
`ArchivedArtifactComparisonStatus`, `ArchivedDiagnosticComparison`,
`ArchivedDiagnosticComparisonStatus`,
`ArchivedTargetCounts`, `ArchivedPreviewComparisonCounts`.

Helper invariants:

- **Pure** — no DOM, no I/O, no clock, no random.
- **Total** — never throws on any combination of null / partial
  inputs. Unknown enum values fall back to safe defaults.
- **Deterministic** — byte-identical output for byte-identical
  inputs.
- **No mutation** — both inputs are deep-equal before / after
  (pinned by tests).
- **No new diff algorithm** — artifact identity reuses
  `deterministicContentHash` from Sprint 90B; diagnostic
  identity reuses the `severity|code|message|path|hint` tuple
  Sprints 90B / 91 / 92 already use.
- **No raw payload leakage** — the comparison view is hashes /
  counts / paths / diagnostic identities. No `"content"` key
  anywhere; no raw source markers (pinned by tests).
- **Stable target order** — siemens → codesys → rockwell, same
  as Sprint 90B's display order.
- **Stable artifact / diagnostic order** — paths sort
  alphabetically inside a target; diagnostics sort by severity
  (error → warning → info) → status → code → message.

### Comparison states

`ArchivedPreviewComparisonState`:

| State | Meaning |
|---|---|
| `no-archived-diff` | No imported bundle loaded. |
| `no-current-preview` | Imported bundle present but no live preview. |
| `selection-mismatch` | Backends differ entirely; no overlapping targets. |
| `partially-comparable` | Backends differ but at least one overlapping target. |
| `unchanged-against-archive` | Every comparable artifact + diagnostic matches. |
| `changed-against-archive` | At least one drift detected. |

Per-target `ArchivedTargetComparisonStatus`:

| Status | Meaning |
|---|---|
| `same` | All comparable artifacts match, no diagnostic delta. |
| `changed` | At least one artifact / diagnostic drifted. |
| `missing-current` | Target was in the archive but absent today. |
| `missing-archived` | Target is in current preview but the archive did not record it. |
| `not-comparable` | Current target is blocked / failed / unavailable; hashes can't be computed. |

Per-artifact `ArchivedArtifactComparisonStatus`:

| Status | Meaning |
|---|---|
| `same-hash` | Path present in both, hashes match the archive's `currentHash`. |
| `changed-hash` | Path present in both, hashes diverge. |
| `missing-current` | Path was in the archive's mentioned set but absent today. |
| `new-current` | Path is in current preview but the archive did not mention it. |
| `not-comparable` | Hash unavailable on the archived side (e.g. tampered bundle). |

Per-diagnostic `ArchivedDiagnosticComparisonStatus`:

| Status | Meaning |
|---|---|
| `still-present` | Same identity present in current preview's manifest diagnostics. |
| `resolved` | Archive recorded it; current preview no longer shows it. |
| `new-current` | Current preview shows it; archive never mentioned it. |
| `not-comparable` | Reserved for forward compatibility. |

### Panel section

[`packages/web/src/components/CodegenPreviewPanel.tsx`](../packages/web/src/components/CodegenPreviewPanel.tsx)

- New *Compare with current preview* button inside the
  *Archived diff* header. Visible when an imported bundle is
  loaded; disabled (with a tooltip) when no successful current
  preview is available. The button wires through the new
  `onCompareArchiveWithCurrent` handler that calls the helper
  exactly once and stores the snapshot in React state.
- New `<ArchivedComparisonSection>` rendered as a sibling
  beneath the imported section, only when the operator has
  clicked Compare. Contents:
  - Stable headline mapped from `ArchivedPreviewComparisonState`
    (e.g. *Same as archive*, *Changed vs archive*, *Partial
    overlap*) plus the helper's per-state summary string.
  - Read-only notice: *"Comparison is read-only. It does not
    modify the archived diff, current preview, Generate, or
    saved session."*
  - Per-target rows mirroring the Sprint 90B / 92 visuals:
    `<details>` for *Artifacts ·* and *Diagnostics ·* with
    counts, status badges via the Sprint 93 unified palette,
    and Expand all / Collapse all controls (generation-counter
    pattern, same as Sprint 93).
  - *Clear comparison* button drops the snapshot back to null.
- **Stale detection.** The comparison snapshot stores refs to
  the bundle and the preview view it was built against. When
  either reference changes (operator imports a different
  bundle, refreshes preview, or clears either side), the panel
  marks the section stale with a *"Comparison is stale —
  click Compare with current preview again to refresh"* notice.
  No automatic recompute.
- **Generate, worker, export bundle, localStorage** all
  unchanged.

### Tests

[`packages/web/tests/codegen-preview-archive-compare.spec.ts`](../packages/web/tests/codegen-preview-archive-compare.spec.ts)
— 29 helper-level tests. Coverage:

- Null / missing inputs (3): both null, archived only, current
  only.
- Identity / unchanged (1).
- Artifact transitions (5): changed-hash, missing-current,
  new-current, not-comparable (no archived hash), full-content
  fidelity past Sprint 89 snippet caps.
- Target transitions (5): missing-current, missing-archived,
  not-comparable on blocked / failed current, target order
  siemens → codesys → rockwell.
- Diagnostics (4): still-present, resolved, new-current,
  duplicate dedupe.
- Selection (3): match true, mismatch with no overlap →
  `selection-mismatch`, mismatch with overlap →
  `partially-comparable`.
- Determinism, immutability, sort (3): no input mutation,
  byte-stable repeated calls, artifact-path sort within target.
- Privacy / shape (5): no `"content"` key, no raw source
  markers, summary counts equal sum of per-target counts,
  unknown / extra fields ignored, empty target list still
  produces a clean view, current preview with zero artifacts on
  a ready archive target → not-comparable / changed.

## Hard rules

- **Pure helper.** No DOM, no I/O, no clock, no random, no
  input mutation.
- **Built from the already-loaded snapshots.** The vendor
  pipeline is not re-run on Compare. The archived diff is
  read-only.
- **Read-only side effects.** No state outside the comparison
  snapshot is touched. Imported diff, live diff slots, applied
  project, Generate, worker, canonical export bundle,
  `localStorage` schema — all unchanged.
- **Ephemeral.** The comparison snapshot lives in React state
  only. Refreshing the browser drops it (along with everything
  else Sprints 89–93 keep ephemeral).
- **Honest about coverage gaps.** Sprint 91 deliberately omits
  unchanged artifacts from `artifactChanges`. The comparison
  classifies any path in current preview not mentioned by the
  archive as `new-current` — operators interpret it as "either
  unchanged at write time and silently dropped, or genuinely
  new today; the archive doesn't tell us which".
- **No new dependencies.** Built on the existing helpers, types,
  and Sprint 93 polish primitives.

## Manual verification checklist

1. `pnpm web:dev`. Load a project / PIR.
2. Run preview, modify the project, refresh preview to produce
   a live diff.
3. Click *Download diff bundle* (Sprint 91). Save the JSON.
4. Refresh the browser tab.
5. Run preview against the (still-modified) project.
6. Click *Import diff bundle* and pick the JSON saved in step 3.
   Expected: archived section shows the loaded diff. The
   *Compare with current preview* button is enabled.
7. Click *Compare with current preview*. Expected: a new
   *Archived vs current preview* section appears below the
   archived section, with the *Same as archive* badge and the
   helper's matching summary.
8. Tweak the project so one artifact's content changes. Refresh
   preview. Expected: the archived comparison flips to a stale
   notice; the badge does not update until you click Compare
   again.
9. Click Compare again. Expected: badge flips to *Changed vs
   archive*; per-target rows show the artifact `changed-hash`
   entry under *Artifacts*.
10. Switch the backend selection (e.g. codesys → all). Refresh
    preview. Click Compare. Expected: state reads *Partial
    overlap* (the codesys target overlaps; siemens / rockwell
    come in as `missing-archived`).
11. Pick a `pneumatic_cylinder_1pos`-shaped project so the
    preview is readiness-blocked. Click Compare. Expected: the
    target row reads *not-comparable* with *blocked* in the
    current-status hint.
12. Click *Clear comparison*. Expected: section disappears.
    Click *Clear imported diff*. Expected: archived section
    flips back to its empty copy.
13. Click *Generate* (canonical flow). Expected: the canonical
    session export bundle does NOT include the imported diff or
    the comparison snapshot — byte-identical to its Sprint 93
    shape.
14. Refresh the browser. Expected: imported diff, comparison,
    live diff, preview — all gone.

## Examples of states

### Same as archive

> *Same as archive — Current preview matches the archived diff
> for comparable artifacts and diagnostics.*

### Changed vs archive

> *Changed vs archive — Archived diff differs from current
> preview — 1 target(s) changed, 1 artifact hash change(s),
> 1 diagnostic change(s).*

### Selection mismatch

> *Selection mismatch — Archived diff was created for backend
> codesys, but current preview is rockwell. No comparable
> targets.*

### Partial overlap

> *Partial overlap — Archived diff (codesys) and current preview
> (all) overlap on 3 target(s); no changes against the archive
> on overlapping targets.*

## What stays out

- **No new diff algorithm.** Hash compare is the floor; line
  diffs stay in the archived bundle's `diff.lines` from Sprint
  91.
- **No artifact reconstruction.** The archived bundle
  deliberately omits full content; the comparison only walks
  hashes / paths / diagnostic identities.
- **No "restore preview from archive" path.** The archived
  bundle is read-only; the comparison is a one-way audit.
- **No comparison bundle download.** Sprint 95 is the natural
  follow-up if the operator wants to archive the meta-compare.
- **No comparing imported diff against another imported diff.**
- **No persistence anywhere.** Comparison vanishes on browser
  refresh.
- **No new dependencies.** Reuses Sprint 89 / 90A / 90B / 91 /
  92 / 93 helpers.
- **No PIR / codegen-core / vendor renderer / electrical-ingest
  / CLI / worker / canonical Generate / canonical export-bundle
  changes.** Sprint 94 is web-only.
