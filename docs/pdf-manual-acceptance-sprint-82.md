# Sprint 82 — manual PDF acceptance pass

> **Status: safety hardening on top of Sprint 81's IO/table
> extraction.** Sprint 81's manual run on the 86-page public
> Beckhoff/TcECAD demo (`TcECAD_Import_V2_2_x.pdf`) produced a
> schema-valid PIR with `%I1` / `%I3` IO addresses — semantically
> wrong because those tokens were Beckhoff *module channel
> markers* on a hardware-overview page, not real PLC byte/bit
> addresses. **Sprint 82 deliberately regresses that "demo win"**:
> isolated PDF channel markers no longer become buildable PIR
> addresses. Safety wins over demo success.

## What changed at the domain layer

- New `classifyPdfAddress(token)` returns one of
  `'strict_plc_address' | 'channel_marker' | 'ambiguous' |
  'invalid'`. Strict requires explicit byte-bit notation
  (`I0.0` / `%Q0.1` / `%IX0.0`) or the Rockwell tag form.
- `extractIoRow`:
  - Rejects rows where the **tag column** is itself a channel
    marker (the page-24 `I1 I2` shape).
  - Classifies the **address column** with `classifyPdfAddress`.
    Strict addresses pass through unchanged; channel-marker /
    ambiguous addresses are preserved as evidence but produce
    no buildable PLC address.
  - Confidence on non-strict rows takes a `-0.05` penalty
    (still capped at 0.65; never below 0.5).
- `buildGraphFromIoRows`:
  - For strict-address rows: same as before — device + plc_channel
    + edge.
  - For channel-marker / ambiguous rows: device evidence only.
    The row's verbatim address token is preserved as
    `attributes.channel_marker` and the classification sits in
    `attributes.address_classification`. NO `plc_channel:` node,
    NO edge → the PIR builder can never see it as IO →
    `%I1` / `%I3` will never appear in a built PIR.
- New diagnostic codes:
  - `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS` (warning)
  - `PDF_MODULE_CHANNEL_MARKER_DETECTED` (info)
  - `PDF_IO_ROW_REQUIRES_STRICT_ADDRESS` (warning)
  - `PDF_IO_ROW_AMBIGUOUS_ADDRESS` (warning)
  - `PDF_PIR_BUILD_ADDRESS_BLOCKED` (warning, reserved for the
    PIR-build-side reporter)
  - `PDF_SOURCE_SNIPPET_MISSING` / `PDF_SOURCE_BBOX_MISSING`
    (info, reserved)

## What changed at the web layer

`packages/web/src/utils/review-source-refs.ts` now projects the
PDF `snippet` and `bbox` fields that the Sprint 79–81 extractor
already populated — earlier sprints had the data on the
`SourceRef` but the UI dropped it. The Sprint 81 manual run
showed only `kind / file / line / page / symbol` in the source
drilldown; Sprint 82 adds:

- `Snippet` — verbatim row text the operator can audit during
  review.
- `Bounding box` — `x=… y=… w=… h=… (pt)` in PDF point space.

`twincat_ecad` was also added to the projection's `KIND_ORDER`
so the TcECAD ingestor's source refs group with the structured-
source family in the drilldown.

## Captured automated outcomes

The deterministic acceptance harness for Sprint 82 lives in
`packages/electrical-ingest/tests/pdf-address-strictness.spec.ts`
(42 tests) and the Sprint 81 `pdf-acceptance.spec.ts` cases
remain green. New cases pinned this commit:

| Case | Behaviour |
| --- | --- |
| `I0.0 B1 Part present` | Strict — produces `plc_channel:%I0.0` + edge as before. |
| `I1 I2` | Page-24 noise — REJECTED (no candidate). |
| `I1 I3 I4 / O1 O2` (multi-row) | Page-24 noise — REJECTED across rows. |
| `I1 Sensor light barrier` | Channel-marker addr + label tag — DEVICE evidence only, NO `plc_channel:` node, `attributes.channel_marker = 'I1'`. |
| `%I1 Sensor light barrier` | Same as above — `%I1` (no bit) is a channel marker. |
| Mixed strict + non-strict rows | Only the strict row produces `plc_channel:`; the non-strict row stays as device evidence. |

## Web upload pass — operator instructions

The AI cannot open a browser. The operator runs this:

1. `pnpm web:dev`
2. Upload `TcECAD_Import_V2_2_x.pdf` (the 86-page Beckhoff/TcECAD
   demo PDF used in the Sprint 81 manual pass).
3. Press **Ingest**.
4. Expected (Sprint 82):
   - No pdfjs worker crash.
   - `Detected: pdf` + `PDF_TEXT_LAYER_EXTRACTED` + (per page)
     `PDF_TABLE_DETECTION_NOT_IMPLEMENTED`.
   - On pages where the previous run produced `%I1`/`%I3` PIR
     IOs: now `PDF_CHANNEL_MARKER_NOT_PLC_ADDRESS` warnings +
     `PDF_MODULE_CHANNEL_MARKER_DETECTED` info diagnostics. NO
     `plc_channel:%I1` candidates in the review panel.
   - Source-evidence drilldown for any extracted device shows
     `Snippet` + `Bounding box (pt)` fields (the regression
     fix).
   - Build PIR button: stays disabled (empty candidate after
     accepting the channel-marker-only evidence) OR refuses
     with `PIR_BUILD_EMPTY_ACCEPTED_INPUT` if every device row
     was accepted but no `plc_channel:` exists.
5. Also test a generated strict-address PDF (case A from Sprint
   81's `pdf-acceptance.spec.ts`):
   ```
   I0.0 B1 Part present
   Q0.0 Y1 Cylinder extend
   ```
   Expected:
   - 2 IO candidates extracted.
   - Accept all → valid PIR preview with 2 IO + 2 equipment.
   - This path has NOT regressed.

## Honest constraints (Sprint 82)

- The `TcECAD_Import_V2_2_x.pdf` page-24 case is the canonical
  regression scenario. Other Beckhoff PDFs may use slightly
  different module-overview shapes that the strictness gate
  doesn't yet recognise as channel markers — they will land
  in the `'ambiguous'` bucket and emit
  `PDF_IO_ROW_REQUIRES_STRICT_ADDRESS`.
- Channel marker variants beyond what `pdf-address-strictness.ts`
  recognises today (e.g. `DI1` / `DO1` module labels in
  certain Beckhoff layouts) will fall through to `'ambiguous'`
  rather than `'channel_marker'`. Both classifications produce
  the same end result (no buildable PLC address) — only the
  diagnostic message differs.
- Sprint 82 does NOT improve tag/equipment-id selection beyond
  rejecting channel-marker tags. Real subcontractor PDFs often
  carry richer tags nearby (e.g. `+S1-DI1`, `S1_1_S1_G10_2`)
  that Sprint 82 still does not promote — that is Sprint 83's
  job.
- No OCR. No symbol recognition. No wire tracing. No multi-
  column or rotated-page layouts. No automatic codegen.
- PDF-derived confidence stays ≤ 0.65. PDF rows never read
  higher than structured CSV/XML rows.
- Raw PDF bytes still NEVER persisted in the snapshot. Snippets
  ARE persisted (Sprint 78B/79 contract) and remain
  potentially sensitive.

## Recommendation for Sprint 83

If the operator's Sprint 82 manual upload pass on
`TcECAD_Import_V2_2_x.pdf` confirms no more `%I1`/`%I3` PIR
builds, **Sprint 83 should focus on PDF source-evidence UX**:
optional page preview with bbox overlays, click-through from a
candidate to its source region, better operator trust.

Alternative if the layout problem looks structural:
**Sprint 83A — PDF layout hardening** (multi-column ordering,
rotated pages, coordinate normalisation, region clustering,
better column-position detection from real geometry).

OCR / symbol recognition / wire-graph reconstruction /
controlled codegen preview stay later in the roadmap.
