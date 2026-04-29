# Sprint 83F — manual PDF acceptance pass

> **Status: full per-occurrence drilldown for PDF rollup
> diagnostics.** Sprint 83E added a "Show PDF evidence"
> toggle but multi-page rollups were
> *representative-only*: the UI showed the full page list
> parsed from the message text, while snippet/bbox pointed
> only at the first page where the canonical section was
> detected. Sprint 83F threads per-page `SourceRef` evidence
> through the diagnostic itself via a new optional
> `additionalSourceRefs?: ReadonlyArray<SourceRef>` field on
> `ElectricalDiagnostic`, populates it inside `detectIoTables`
> from the existing per-occurrence tracking, and surfaces it
> in the web UI as a grouped per-page list. The Sprint 83E
> representative-only fallback stays in place verbatim for
> older diagnostics or any rollup that doesn't carry the new
> array. Backwards-compatible additive field — no schema bump
> on existing consumers, no new diagnostic codes, no relaxed
> safety, no new extraction capability, no canvas rendering.

## What changed at the domain layer

1. **`ElectricalDiagnostic.additionalSourceRefs?`** — new
   optional field on the diagnostic shape in
   [`packages/electrical-ingest/src/types.ts`](../packages/electrical-ingest/src/types.ts):
   ```ts
   export interface ElectricalDiagnostic {
     // existing fields unchanged …
     additionalSourceRefs?: ReadonlyArray<SourceRef>;
   }
   ```
   Carries one extra `SourceRef` per non-representative
   occurrence the rollup represents. The first occurrence stays
   in `sourceRef` (so every Sprint 83C/D/E consumer continues
   to see the representative ref unchanged). Older diagnostics
   omit the field entirely.

2. **`NonIoFamilyOccurrence.perPage: Map<number, SourceRef>`** —
   inside [`pdf-table-detect.ts`](../packages/electrical-ingest/src/sources/pdf-table-detect.ts)
   the rollup occurrence shape was extended from a `Set<number>`
   of pages to a `Map<number, SourceRef>` keyed by page number.
   Each page contributes its first matching line's `SourceRef`;
   subsequent same-key matches on the same page remain collapsed
   (Sprint 83B intra-page dedup preserved).

3. **`buildNonIoFamilyRollupDiagnostic`** — emits
   `additionalSourceRefs` populated with one `SourceRef` per
   non-representative page (page-ascending order). Single-page
   rollups omit the field entirely so the diagnostic shape stays
   minimal.

4. **`pdf.ts` cross-page call** unchanged — the Sprint 83C
   single `detectIoTables` invocation is preserved verbatim.

## What changed at the web UI layer

1. **`packages/web/src/utils/pdf-rollup-evidence.ts`** —
   `summarizePdfDiagnosticEvidence` now projects each entry of
   `additionalSourceRefs` (plus the representative) into a
   `perPageEvidence: PdfPerPageEvidence[]` array sorted by page
   ascending. Each entry exposes the existing Sprint 82
   `SourceRefSummary` so the UI can re-use the field rendering.
   When `additionalSourceRefs` covers every page named in the
   rollup message, `representativeOnly` is cleared. When
   coverage is partial (or the field is absent), the Sprint 83E
   rep-only behaviour is preserved verbatim.

2. **`packages/web/src/components/electrical-review/PdfDiagnosticEvidence.tsx`** —
   when `perPageEvidence.length > 1`, renders a `<ul>` of
   per-page entries, each with its own `<dl>` of fields
   (Snippet, Bounding box, Page, Symbol, …). When
   `perPageEvidence.length <= 1`, falls back to the Sprint 83E
   single-`<dl>` layout. The rep-only `role="note"` is rendered
   only when `representativeOnly` is true.

3. **`ElectricalDiagnosticsList.tsx`** — unchanged. PDF
   diagnostics still go through `<PdfDiagnosticEvidence>`;
   non-PDF diagnostics still get their existing one-liner.

## What stays from Sprints 82 / 83A / 83B / 83C / 83D / 83E

- PDF address strictness intact — isolated `I1` / `O2` / `%I1`
  channel markers from PDF still NEVER become buildable PIR
  addresses.
- Family classifier semantics intact — Sprint 83A unchanged.
- Footer / weak-token / body-row hygiene gate intact —
  Sprint 83B suppression unchanged.
- Cross-page `detectIoTables` call intact — Sprint 83C
  unchanged.
- Canonical-section-role keying intact — Sprint 83D rollup
  count contract preserved (numbered TcECAD markers and sibling
  BOM table headers still collapse into one rollup per
  family/role).
- Sprint 83E representative-only notice still appears for older
  diagnostics or partial coverage.
- Diagnostic codes unchanged. The new field is **additive** —
  no schema bump on existing consumers; downstream code that
  doesn't recognise `additionalSourceRefs` continues to read
  `sourceRef` exactly as before.
- `SourceRef` shape unchanged — Sprint 83F adds an array of
  existing `SourceRef`s, not a new shape.
- localStorage shape unchanged. Raw PDF bytes still NEVER
  persisted in the snapshot. The new field carries the same
  short snippets the extractor already populated; no new bytes
  are persisted.
- CSV / EPLAN / TcECAD ingestors untouched.
- Confidence still capped at 0.65, ≥ 0.5.
- No OCR. No symbol recognition. No wire tracing. No
  multi-column / rotated-page support. No automatic codegen.

## Captured automated outcomes

Two new electrical-ingest cases land in the existing
canonicalization spec (`pdf-table-family-rollup-canonicalization.spec.ts`):

- `13b` — multi-page TcECAD-shape mock asserts the BOM rollup
  carries `additionalSourceRefs` with one entry per
  non-representative page (pages 81 + 82 when page 80 is
  representative), each with its own snippet.
- `13c` — single-page rollup omits `additionalSourceRefs`
  entirely (no empty-array noise).

Six new web cases land in the existing
`tests/pdf-rollup-evidence.spec.ts`:

- `1` — `representativeOnly` clears when
  `additionalSourceRefs` covers every page named in the message.
- `2` — partial coverage keeps `representativeOnly = true`
  (older-diagnostics fallback path).
- `3` — repeated pages in `additionalSourceRefs` are deduped.
- `4` — non-PDF refs in `additionalSourceRefs` are dropped
  defensively.
- `5` — missing `additionalSourceRefs` keeps Sprint 83E
  behaviour verbatim (`perPageEvidence === []`,
  `representativeOnly === true`).
- `6` — each per-page entry exposes the Sprint 82
  `SourceRefSummary` fields (Snippet, Bounding box, Page).

| Behaviour | Sprint 83E web UX | Sprint 83F web UX |
| --- | --- | --- |
| `PDF_BOM_TABLE_DETECTED` rollup over pages 80–86 | One snippet + bbox (rep-only) | **One snippet + bbox per page**, grouped by page; no rep-only notice |
| `PDF_CABLE_TABLE_DETECTED` rollup over pages 57–79 | One snippet + bbox (rep-only) | **23 grouped page entries**; no rep-only notice |
| `PDF_CONTENTS_TABLE_IGNORED` on page 3 | One snippet + bbox (single page) | One snippet + bbox (unchanged — single page never triggered the per-page path) |
| Older diagnostic without `additionalSourceRefs` | Rep-only notice | Rep-only notice (fallback preserved) |
| Strict-address `PDF_IO_ROW_EXTRACTED` | Single page; toggle works | Single page; toggle works (unchanged) |
| CSV / EPLAN / TcECAD diagnostic | Legacy one-liner | Legacy one-liner (unchanged) |

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the same 86-page Beckhoff/
   TcECAD demo used in Sprints 82 / 83A / 83B / 83C / 83D / 83E).
3. Press **Ingest**.
4. Expected (Sprint 83F):
   - No pdfjs worker crash (Sprint 81 post-fix).
   - `PDF_TEXT_LAYER_EXTRACTED` reports ~2529 line blocks
     across 86 pages (same shape as 82 → 83E).
   - **Family rollup count: 6–10 (preferred) / ≤ 12 (cap)** —
     the Sprint 83D contract is preserved verbatim.
   - **Each multi-page rollup now exposes per-page evidence.**
     Click "Show PDF evidence" on `PDF_BOM_TABLE_DETECTED`
     (pages 80–86): expanded view should show **seven grouped
     entries** (`Page 80`, `Page 81`, …, `Page 86`), each with
     its own snippet + bbox. The "Representative evidence
     only" notice should NOT appear.
   - Same expectation for `PDF_CABLE_TABLE_DETECTED` (overview
     pages 55–56 → two grouped entries; plan pages 57–79 →
     ~23 grouped entries) and `PDF_TERMINAL_TABLE_DETECTED`
     (pages 49–54 → six grouped entries).
   - `PDF_CONTENTS_TABLE_IGNORED` (pages 2–4 → three grouped
     entries).
   - Single-page rollups (e.g. a one-off `PDF_LEGEND_TABLE_IGNORED`
     on page 7) keep the original single-`<dl>` layout —
     per-page grouping triggers only when there are 2+ pages.
   - Vendor metadata (`Hersteller (Firma) Beckhoff Automation
     GmbH`, `Datum … Seite`, etc.) still emits ZERO
     diagnostics. Module-overview pages with isolated channel
     markers still emit Sprint 82's
     `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS` warnings.
   - **No `plc_channel:%I1` / `%I3` candidates.** Build PIR
     stays disabled / refuses honestly.
   - `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` still fires
     at the end (no IO rows extracted).
5. Also test a Case A strict-address PDF (Sprint 81 fixture):
   ```
   Address Tag Description
   I0.0 B1 Part present
   Q0.0 Y1 Cylinder extend
   ```
   Expected:
   - 2 IO candidates extracted.
   - `PDF_IO_ROW_EXTRACTED` info diagnostics show the toggle
     with single-page evidence (no per-page grouping needed,
     no rep-only notice).
   - Accept all → valid PIR preview with 2 IO + 2 equipment.
   - Strict-address path NOT regressed.
6. Upload a CSV / EPLAN / TcECAD source: confirm those
   diagnostics still display the legacy one-liner unchanged
   (`source: csv · list.csv · line 5`).
7. **Optional rep-only fallback verification.** If feasible
   from devtools: temporarily clear
   `additionalSourceRefs` on a `PDF_BOM_TABLE_DETECTED` row
   and confirm the UI gracefully reverts to Sprint 83E's
   rep-only notice + single `<dl>`. (Automated tests already
   cover this path; the manual check is reassurance.)

## Honest constraints (Sprint 83F)

- **Per-page granularity, not per-occurrence-within-page.**
  Multiple lines on the same page that hit the same canonical
  role (`(family, role)` key) collapse to the first line's
  evidence (Sprint 83B intra-page dedup is preserved). If a
  BOM page has three sibling header lines (Teileliste,
  Benennung, Schaltplan), only the first appears in the
  per-page entry — the others are still suppressed under the
  hygiene/canonical-key path. Future work could surface every
  hit, but the cap is intentional: rollups stay readable.
- **No page-region preview / no bbox overlay rendering.** Bbox
  is surfaced numerically (the Sprint 82 projection); operators
  correlate against the original PDF in another viewer. Adding
  canvas rendering would require introducing pdfjs into the web
  app, which Sprint 83F intentionally does not.
- **localStorage shape unchanged.** Raw PDF bytes were never
  persisted (Sprint 78B privacy default); Sprint 83F adds no
  new persisted state. The diagnostic carries short snippets
  the extractor already populated.
- **No new diagnostic codes.** Sprint 83D codes carry through.
  The new field is purely additive on `ElectricalDiagnostic`.
- **Rep-only fallback remains.** Older diagnostics, partial
  coverage, or any future rollup that omits
  `additionalSourceRefs` continues to render the Sprint 83E
  notice — by design.
- **No layout heuristics, OCR, symbol recognition, wire
  tracing, multi-column / rotated-page support, or codegen.**
  All stay deferred.
- **PDF-derived confidence still capped at 0.65, ≥ 0.5.**
- **PDF snippets remain potentially sensitive.**

## Recommended next sprint

Only if Sprint 83F's manual TcECAD pass shows operators
genuinely want visual context beyond the per-page snippet +
numeric bbox:

- **Sprint 84 — PDF page preview + bbox overlay.** Render the
  PDF page in a canvas (pdfjs) with the bbox highlighted.
  Adds pdfjs to the web bundle (currently isolated to the
  extractor adapter). The bigger architectural step.

If the per-page-grouped textual evidence is sufficient (likely),
the next sprint is best spent elsewhere:

- **Sprint 84 alternative — PDF layout hardening.**
  Multi-column ordering, rotated pages, region clustering,
  better column-position detection from real geometry. New
  extraction capability rather than UX polish.

OCR fallback, symbol recognition, wire-graph reconstruction,
and controlled codegen preview stay later in the roadmap.
