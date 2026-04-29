# Sprint 84.1B — manual PDF acceptance pass

> **Status: PDF layout diagnostic rollups on top of Sprint 84.1
> region-aware table walking.** Sprint 84 added
> `PDF_LAYOUT_MULTI_COLUMN_DETECTED` and Sprint 84.1 added
> `PDF_LAYOUT_REGION_CLUSTERED`. Both fired once *per page* —
> on the 86-page TcECAD fixture that produced dozens of layout
> diagnostic rows in the operator panel, undoing the Sprint
> 83B → 83F rollup hygiene work in a different dimension.
> Sprint 84.1B keeps the same diagnostic *codes* and emits them
> as compact rollups: one diagnostic per code, with a compressed
> page-range string and (when there's variation) a count
> summary. Volume / UX hardening only — no schema bump, no new
> diagnostic codes, no extraction-capability change.

## What changed at the domain layer

A new pure-helper module
[`packages/electrical-ingest/src/sources/pdf-layout-diagnostics.ts`](../packages/electrical-ingest/src/sources/pdf-layout-diagnostics.ts)
adds two exports:

```ts
export interface LayoutPageFinding {
  page: number;
  count: number;
}

export interface LayoutDiagnosticRollupInput {
  multiColumnPages: ReadonlyArray<LayoutPageFinding>;
  regionClusterPages: ReadonlyArray<LayoutPageFinding>;
}

export function buildLayoutDiagnosticRollups(
  input: LayoutDiagnosticRollupInput,
): ElectricalDiagnostic[];
```

Behaviour:

- **One diagnostic per code, max.** `multiColumnPages` produces
  zero or one `PDF_LAYOUT_MULTI_COLUMN_DETECTED`;
  `regionClusterPages` produces zero or one
  `PDF_LAYOUT_REGION_CLUSTERED`.
- **Compressed page ranges** via the existing Sprint 83C
  `compressPageRanges` helper (`"pages 1, 5, 7–9"`,
  `"pages 1–86"`, etc.).
- **Count summary** trails the message:
  - All findings same count → `(N columns)` /
    `Region count: N.`
  - Findings vary → `Column counts ranged from MIN to MAX.` /
    `Region counts ranged from MIN to MAX.`
- **Single-page** uses singular `page N` phrasing (matches the
  Sprint 83F rollup convention).
- **Defensive against bad input.** Non-finite / non-positive
  pages, non-finite counts, and duplicate pages are silently
  dropped.
- **Deterministic order.** Multi-column rollup is emitted
  before region-cluster rollup (matching the Sprint 84 / 84.1
  per-page emission convention).
- **No `sourceRef` on rollups.** The rollups span many pages —
  inventing a single representative `SourceRef` would be
  misleading, and per-page evidence is already covered by
  Sprint 83F `additionalSourceRefs` (for non-IO rollups) or by
  the page-list message text (for layout rollups).

`pdf.ts` (text-mode + bytes-mode) now accumulates
`LayoutPageFinding`s across pages instead of pushing a
diagnostic per page, then calls `buildLayoutDiagnosticRollups`
once at the end of the layout pass. `PDF_LAYOUT_ROTATION_SUSPECTED`
keeps its **per-page** emission — rotation is rare and
operationally important; collapsing it would lose page identity.

## What stays from Sprints 82 → 84.1

- PDF address strictness intact — Sprint 82 unchanged.
- Family classifier semantics intact — Sprint 83A unchanged.
- Footer / weak-token / body-row hygiene gate intact —
  Sprint 83B unchanged.
- Cross-page `detectIoTables` call intact — Sprint 83C
  unchanged.
- Canonical-section-role keying intact — Sprint 83D rollup
  count contract preserved.
- Sprint 83E representative-only fallback notice unchanged.
- Sprint 83F per-page `additionalSourceRefs` drilldown
  unchanged.
- Sprint 84 column-aware reading order intact — `pdf.ts` still
  reorders per page via `orderBlocksByLayout`.
- Sprint 84.1 region-aware table walking intact — `regionId`
  tagging on `PdfTableDetectorLine` and the header→rows region
  barrier in `detectIoTables` are unchanged.
- Diagnostic codes unchanged: same three layout codes
  (`PDF_LAYOUT_MULTI_COLUMN_DETECTED`,
  `PDF_LAYOUT_REGION_CLUSTERED`,
  `PDF_LAYOUT_ROTATION_SUSPECTED`). No schema bump.
- `SourceRef` shape unchanged.
- localStorage shape unchanged. Raw PDF bytes still NEVER
  persisted in the snapshot.
- CSV / EPLAN / TcECAD ingestors untouched.
- Confidence still capped at 0.65, ≥ 0.5.
- No OCR. No symbol recognition. No wire tracing. No
  rotated-page CORRECTION (still v0 flag-only). No automatic
  codegen. No canvas rendering.

## Captured automated outcomes

Two new specs land:

1. **`tests/pdf-layout-diagnostics.spec.ts` (11 tests)** —
   pure helper coverage:
   - empty input → zero diagnostics,
   - single multi-column page singular phrasing,
   - consecutive multi-column pages → `pages X–Y`,
   - non-consecutive multi-column pages → `pages 1, 5, 7–9`,
   - same-count tail vs `ranged from MIN to MAX`,
   - single region-cluster page singular phrasing,
   - 86-page region-cluster compresses + min/max,
   - non-finite / non-positive / duplicate findings dropped
     defensively,
   - per-page de-dup,
   - multi-column emitted before region-cluster,
   - rollups carry no `sourceRef`.

2. **`tests/pdf-layout-diagnostic-rollups.integration.spec.ts`
   (4 tests)** — bytes-mode integration via
   `buildTabularPdfFixture` + `ingestPdf`:
   - 3 pages with multi-column layout produce **ONE**
     `PDF_LAYOUT_MULTI_COLUMN_DETECTED` rollup with
     `pages 1–3`, not three.
   - 3 pages with vertically-clustered regions produce
     **ONE** `PDF_LAYOUT_REGION_CLUSTERED` rollup with
     `pages 1–3`, not three.
   - text-mode (no bboxes) emits **zero** layout diagnostics
     (Sprint 84 contract preserved); strict-address Sprint 81
     fixture still produces 2 IO channels.
   - text-mode multi-page TcECAD-shape mock keeps Sprint 83D
     BOM rollup + Sprint 83F `additionalSourceRefs` threading,
     and emits **zero** layout diagnostics.

| Behaviour | Sprint 84.1 | Sprint 84.1B |
| --- | --- | --- |
| 86-page PDF where every page is multi-column | 86 `PDF_LAYOUT_MULTI_COLUMN_DETECTED` rows | **1** rollup with `pages 1–86` + count summary |
| 86-page PDF where region clustering fires every page | 86 `PDF_LAYOUT_REGION_CLUSTERED` rows | **1** rollup with `pages 1–86` + count summary |
| Single-page rotation flag | Per-page (unchanged) | **Per-page (unchanged)** — rotation kept granular by design |
| Sprint 83D non-IO family rollups | 6–10 (preferred) / ≤ 12 (cap) | **Same** — rollup count unchanged |
| Sprint 83F per-page `additionalSourceRefs` | Populated | **Same** — unchanged |
| Strict-address Sprint 81 fixture → 2 IO candidates | Yes | **Yes** |
| TcECAD `%I1`/`%I3` channel markers | Refused | **Refused** |
| Text-mode (no bboxes) | Zero layout diagnostics | **Zero layout diagnostics** |

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprints 82 → 84.1).
3. Press **Ingest**.
4. Expected (Sprint 84.1B):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks
     across 86 pages (same shape as 82 → 84.1).
   - **Family rollup count: 6–10 (preferred) / ≤ 12 (cap)** —
     Sprint 83D contract preserved verbatim. Manual run shows
     7 effective non-IO family rollups (BOM, cable overview,
     cable plan, contents, legend, terminal overview, terminal
     plan).
   - **Per-page evidence drilldown unchanged** — Sprint 83F
     grouped per-page evidence still appears under each rollup
     toggle.
   - **Layout diagnostics now compact:**
     - `PDF_LAYOUT_MULTI_COLUMN_DETECTED` × **1** (rollup),
       message like `Detected multi-column layout on pages …;
       using column-aware reading order. Column counts ranged
       from N to M.`
     - `PDF_LAYOUT_REGION_CLUSTERED` × **1** (rollup), message
       like `Clustered page layout into vertical regions on
       pages 1–86; … Region counts ranged from N to M.`
     - `PDF_LAYOUT_ROTATION_SUSPECTED` × **0** (TcECAD doesn't
       fire it; if any page does, it stays per-page).
   - **No `plc_channel:%I1` / `%I3` candidates.** Build PIR
     stays disabled / refuses honestly.
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
6. Upload a CSV / EPLAN / TcECAD source: confirm those
   diagnostics still display the legacy one-liner unchanged.

## Honest constraints (Sprint 84.1B)

- **Volume / UX change only — no new extraction capability.**
  Per-page layout findings still drive Sprint 84 / 84.1
  ordering + region tagging exactly as before; only the
  *diagnostic surface* is collapsed.
- **`PDF_LAYOUT_ROTATION_SUSPECTED` stays per-page.** Rotation
  is rare and operationally important. Collapsing it into a
  rollup would lose page identity (operators want to know
  *which page* should be rotated for review). If a future
  fixture surfaces 10+ rotated pages, this can be reconsidered.
- **No per-region or per-column drilldown.** The rollup
  message carries the page list and count summary; operators
  who need per-page geometry should consult the bytes-mode
  reproduction. Sprint 83F-style `additionalSourceRefs` is
  reserved for evidence-bearing rollups (non-IO families) — the
  layout rollups span every page on the document and inventing
  a representative `SourceRef` would be misleading.
- **Count summary is min/max only when findings vary.** Same-
  count finding sets get `(N columns)` / `Region count: N.`
  to keep the message short.
- **Same-page de-dup.** Idempotent re-runs of the layout
  helpers per page are absorbed by `uniqValidPages` — only the
  first finding for a given page is kept.
- **No layout heuristics, OCR, symbol recognition, wire
  tracing, multi-column / rotated-page CORRECTION, or codegen.**
  All stay deferred.
- **No geometry-based column role inference** (still scope of
  Sprint 84.2).
- **localStorage shape unchanged.** Raw PDF bytes still NEVER
  persisted.
- **PDF-derived confidence still capped at 0.65, ≥ 0.5.**

## Recommended next sprint

Three options ranked by evidence-to-effort:

1. **Sprint 84.2 — geometry-aware column hints.** Use
   `PdfTableDetectorLine.items` per-cell `x`/`width` to assign
   `address` / `tag` / `direction` / `description` roles by
   geometry instead of by string-position regex. Targeted
   refactor of `detectIoTableHeader`. Worth doing only if
   operators report concrete column-attribution failures on
   real-world IO lists.
2. **Sprint 84.3 — region-aware non-IO rollup boundaries.**
   Add region into the canonical `(family, role)` key so two
   regions of the same family on the same page aggregate
   separately. Risk: rollup count grows; UX gain uncertain.
3. **Sprint 85 — PDF page preview + bbox overlay.** Adds pdfjs
   canvas to the web bundle. Bigger architectural step; only
   worth doing on operator request.

**Default: hold further PDF investment.** The PDF layer is now
load-bearing through Sprints 79 → 84.1B. The diagnostic stream
is compact and accurate, evidence is per-page where it matters,
and safety gates haven't moved. Move to a different domain
(electrical-graph hardening, codegen-side improvements) until
operator feedback on a real engagement surfaces a concrete PDF
failure mode the current pipeline can't handle.

OCR fallback, symbol recognition, wire-graph reconstruction,
and controlled codegen preview stay later in the roadmap.
