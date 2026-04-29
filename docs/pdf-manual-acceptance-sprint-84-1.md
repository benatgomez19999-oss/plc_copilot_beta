# Sprint 84.1 — manual PDF acceptance pass

> **Status: PDF region-aware table walking on top of Sprint 84
> layout hardening v0.** Sprint 84 introduced
> `clusterBlocksIntoRegions` as a pure helper but did not
> consume it in the table detector. Sprint 84.1 wires region
> clustering into `pdf.ts` and adds a `regionId` barrier inside
> `detectIoTables`, so a header in one vertical region cannot
> absorb data rows from a different region (footer / title-
> block / unrelated narrative on the same ordered line stream).
> Volume / UX / safety hardening only — no new buildable
> evidence, no canvas rendering, no OCR. The region barrier is
> backwards-compatible: when detector lines have no `regionId`,
> the walk falls through to Sprint 81/83 unscoped behaviour.

## How region boundaries are represented

A new optional `regionId?: string` field on `PdfTableDetectorLine`:

```ts
export interface PdfTableDetectorLine {
  block: PdfTextBlock;
  items?: Array<{ text: string; x: number; width: number }>;
  pageNumber: number;
  regionId?: string; // Sprint 84.1
}
```

`pdf.ts` populates the field per-page when geometry resolves
≥ 2 vertical regions via `clusterBlocksIntoRegions`. Each region
gets a deterministic id of the form `pdf:p<page>:r<index>`
(1-based). Single-region pages stay unscoped — the field stays
absent and behaviour is identical to Sprint 84 / 83 / 81.

### `detectIoTables` API change

The header→rows walk now stops at a region boundary:

```ts
while (j < lines.length) {
  const next = lines[j];
  if (
    line.regionId !== undefined &&
    next.regionId !== undefined &&
    next.regionId !== line.regionId
  ) {
    break;
  }
  // ... rest of Sprint 81 walk unchanged
}
```

The barrier requires **both** the header and the candidate row
to carry `regionId`s. Mixed inputs (one tagged, one not) fall
through to unscoped behaviour — defensive default for callers
that haven't migrated to region-aware tagging yet.

## What changed at the wiring layer

`pdf.ts` text-mode and bytes-mode paths now run
`clusterBlocksIntoRegions` on each page's already-ordered
blocks (Sprint 84 column-aware ordering still happens first).
When the result is ≥ 2 regions:

- One info diagnostic per page:
  `PDF_LAYOUT_REGION_CLUSTERED`. Sparse — never per-row.
- Each block gets a deterministic region id. The detector
  lines forwarded to `detectIoTables` carry this id, scoping
  every header→rows walk to a single region.

When the result is a single region (most pages on most PDFs),
no diagnostic fires and no `regionId` is set; behaviour is
identical to Sprint 84.

## What stays from Sprints 82 / 83A / 83B / 83C / 83D / 83E / 83F / 84

- PDF address strictness intact — Sprint 82 unchanged.
- Family classifier semantics intact — Sprint 83A unchanged.
- Footer / weak-token / body-row hygiene gate intact —
  Sprint 83B unchanged.
- Cross-page `detectIoTables` call intact — Sprint 83C
  unchanged.
- Canonical-section-role keying intact — Sprint 83D rollup
  count contract preserved.
- Sprint 83E representative-only fallback unchanged.
- Sprint 83F per-page `additionalSourceRefs` drilldown
  unchanged.
- Sprint 84 column-aware reading order + multi-column /
  rotation diagnostics unchanged.
- Diagnostic codes for non-IO families unchanged.
  `PDF_LAYOUT_REGION_CLUSTERED` is purely additive.
- `SourceRef` shape unchanged.
- localStorage shape unchanged. Raw PDF bytes still NEVER
  persisted in the snapshot.
- CSV / EPLAN / TcECAD ingestors untouched.
- Confidence still capped at 0.65, ≥ 0.5.
- No OCR. No symbol recognition. No wire tracing. No
  rotated-page correction. No automatic codegen. No canvas
  rendering. No geometry-based column role inference (deferred
  to Sprint 84.2).

## Captured automated outcomes

A new spec lives at
`packages/electrical-ingest/tests/pdf-region-table-walking.spec.ts`
(9 tests):

- **Region barrier tests** (6) — table+footer regions / title
  block above table / two-column page (left=IO, right=narrative)
  / BOM region still rolls up / unscoped fallback (Sprint 81/83
  behaviour) / mixed regionId/no-regionId fallback.
- **`ingestPdf` integration tests** (3) — text-mode without
  bboxes does NOT emit `PDF_LAYOUT_REGION_CLUSTERED` (so existing
  tests stay clean), strict-address Sprint 81 fixture still
  extracts 2 IO candidates, multi-page TcECAD-shape mock
  preserves Sprint 83D rollup count + Sprint 83F
  `additionalSourceRefs` threading.

| Behaviour | Sprint 84 | Sprint 84.1 |
| --- | --- | --- |
| Header in region A + ghost-row footer in region B | Walk would absorb the footer row | **Walk stops at the region boundary**; footer row not consumed |
| Title block above IO table | Title might pollute the walk | Title region detected separately; only table region produces a candidate |
| Two-column page: IO left, narrative right (e.g. `I0.1 looks like an IO row in narrative prose`) | Sprint 84 ordering puts IO first — narrative still in same line stream | **Region barrier** stops the walk before the narrative |
| BOM region (rollup classification) | Rollup as Sprint 83D | Rollup unchanged — region tagging doesn't affect non-IO branch |
| Single-region page | Sprint 81/83 walk | Sprint 81/83 walk (no `regionId` set) |
| Text-mode (no bboxes) | No layout diagnostics | No layout diagnostics, no `regionId` |
| Strict-address Sprint 81 fixture | 2 IO candidates | 2 IO candidates |
| TcECAD `%I1`/`%I3` channel markers | Refused | Refused |
| Sprint 83F `additionalSourceRefs` | Populated | Populated (unchanged) |

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprints 82 → 84).
3. Press **Ingest**.
4. Expected (Sprint 84.1):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks
     across 86 pages (same shape as 82 → 84).
   - **Family rollup count: 6–10 (preferred) / ≤ 12 (cap)** —
     Sprint 83D contract preserved verbatim.
   - **Per-page drilldown unchanged** — Sprint 83F grouped
     per-page evidence still appears under each rollup toggle.
   - **Possible new `PDF_LAYOUT_REGION_CLUSTERED` info
     diagnostics** — one per page where geometry resolves into
     ≥ 2 vertical regions. Whether this fires on TcECAD depends
     on the underlying pdfjs output; both are non-fatal info
     messages and don't change extraction.
   - `PDF_LAYOUT_MULTI_COLUMN_DETECTED` and
     `PDF_LAYOUT_ROTATION_SUSPECTED` from Sprint 84 still fire
     when applicable.
   - **No `plc_channel:%I1` / `%I3` candidates.** Build PIR
     stays disabled / refuses.
   - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` still fires
     at the end (no IO rows extracted).
5. Strict-address Sprint 81 fixture:
   ```
   Address Tag Description
   I0.0 B1 Part present
   Q0.0 Y1 Cylinder extend
   ```
   Expected:
   - 2 IO candidates extracted.
   - Accept all → valid PIR preview with 2 IO + 2 equipment.
   - Strict-address path NOT regressed.
6. Optional: upload a PDF with a known IO table + footer block,
   and verify only the table region rows extract.
7. Upload a CSV / EPLAN / TcECAD source: confirm those
   diagnostics still display the legacy one-liner unchanged.

## Honest constraints (Sprint 84.1)

- **No new extraction capability.** Region barriers PREVENT
  unsafe absorption; they don't extract anything new.
- **Region clustering is heuristic.** Default
  `vGapMultiplier=2.0` (twice the median block height). Mistuned
  PDFs fall back to a single region (no scoping) — the detector
  proceeds with Sprint 84 ordering and Sprint 81 walk, no
  regression.
- **Region barrier requires both endpoints to be tagged.**
  Mixed inputs (e.g. a future migration where some lines stay
  unscoped) fall through to unscoped Sprint 81/83 walk by
  design. Tests explicitly cover this fallback.
- **No region-level rollup of the non-IO branch.** Sprint 83D
  canonical-section-role rollups still group across pages by
  `(family, role)`; region tagging doesn't subdivide them. A
  BOM region on page 80 and a BOM region on page 81 still
  collapse into one rollup as before.
- **No region-level confidence boosting.** Confidence still
  capped at 0.65. Region scoping is a correctness gate, not a
  trust signal.
- **No diagnostic per region.** Only one
  `PDF_LAYOUT_REGION_CLUSTERED` per page where ≥ 2 regions
  appear; granular per-region noise would defeat the Sprint
  83D/F rollup hygiene work.
- **No layout heuristics, OCR, symbol recognition, wire
  tracing, multi-column / rotated-page CORRECTION, or codegen.**
  All stay deferred.
- **No geometry-based column role inference.** That's the
  scope of Sprint 84.2, deferred until operator feedback shows
  string-position regex falls short on real PDFs.
- **PDF-derived confidence still capped at 0.65, ≥ 0.5.**
- **PDF snippets remain potentially sensitive.**
- **localStorage shape unchanged.** Raw PDF bytes still NEVER
  persisted.

## Is Sprint 84.2 (geometry-aware column hints) still needed?

**Conditional on operator feedback.** Sprint 84.1 closes the
"footer / title-block / unrelated-narrative absorbed by IO
walk" failure mode that geometry naturally exposes. It does NOT
address column-role mis-attribution within a real IO table —
that's the scope of Sprint 84.2 and only matters once operators
report concrete cases where the existing string-position regex
chooses the wrong role for a real IO row. Until then, Sprint
84.1 is the higher-leverage change.

## Recommended next sprint

Three options listed by evidence-to-effort ratio:

1. **Sprint 84.2 — geometry-aware column hints** (preferred
   only if operators see column mis-attribution on real-world
   IO lists). Use `PdfTableDetectorLine.items` per-cell `x` /
   `width` to assign `address` / `tag` / `direction` /
   `description` roles by geometry instead of by string-position
   regex. Targeted refactor of `detectIoTableHeader`.
2. **Sprint 84.3 — region-aware non-IO rollup boundaries** (if
   manual TcECAD pass surfaces a real case where two non-IO
   regions of the same family on the same page should be
   aggregated separately rather than collapsed). Add region
   into the canonical key. Risk: rollup count grows; UX gain is
   uncertain.
3. **Sprint 85 — PDF page preview + bbox overlay** (only if
   operators specifically ask for visual context). Adds pdfjs
   canvas to the web bundle.

Default to 84.2 if the manual TcECAD pass surfaces concrete
column-attribution failures. Otherwise hold layout work and
move to a different domain (e.g. electrical-graph hardening,
codegen-side improvements).

OCR fallback, symbol recognition, wire-graph reconstruction,
and controlled codegen preview stay later in the roadmap.
