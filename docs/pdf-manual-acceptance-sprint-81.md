# Sprint 81 — manual PDF acceptance pass

> **Status: deterministic acceptance harness landed; web manual
> upload pass deferred to the operator.** Sprint 81 introduces the
> first explicit acceptance testing for PDF ingestion. The harness
> runs four representative deterministic cases (no real-world
> customer PDFs) so the same exact run can be reproduced on any
> machine without binary fixtures, network access, or proprietary
> data.

## Why a deterministic harness

Sprint 81's acceptance scope was "first manual PDF verification";
real-world PDFs vary too much to commit as test inputs (and the
project explicitly bans committing customer/proprietary
documents). The harness covers the four shapes operators are most
likely to hand off:

| Case | Title | Bytes built by |
| --- | --- | --- |
| A | Tabular IO list (Address / Tag / Description, 4 data rows) | `buildTabularPdfFixture` |
| B | Tag-first IO list with explicit Direction column (English) | `buildTabularPdfFixture` |
| C | Selectable-text PDF with no IO rows (narrative paragraph) | `buildMinimalPdfFixture` |
| D | Malformed bytes (not a PDF magic header) | `TextEncoder.encode` |

All cases live in
[`packages/electrical-ingest/tests/pdf-acceptance.spec.ts`](../packages/electrical-ingest/tests/pdf-acceptance.spec.ts).
The fixture builders are committed (no binary blobs) at
[`packages/electrical-ingest/tests/fixtures/pdf/build-fixture.ts`](../packages/electrical-ingest/tests/fixtures/pdf/build-fixture.ts).

## Running the harness

```sh
pnpm --filter @plccopilot/electrical-ingest test -- pdf-acceptance
```

Expected output (Sprint 81 v0):

```
Test Files  1 passed (1)
     Tests  4 passed (4)
```

The tests assert structural outcomes rather than inspect a
human-readable summary; the captured assertions ARE the
acceptance criteria.

## Captured results

### Case A — Tabular IO list (Address / Tag / Description)

| Outcome | Value |
| --- | --- |
| `graph.sourceKind` | `pdf` |
| Page count | `1` |
| Text blocks (line-grouped) | `≥ 5` (1 header + 4 data) |
| Table candidates | `1` |
| Table rows | `5` (1 header + 4 data) |
| `plc_channel:` nodes | `4` |
| Required diagnostics | `PDF_TEXT_LAYER_EXTRACTED`, `PDF_TABLE_HEADER_DETECTED`, `PDF_TABLE_CANDIDATE_DETECTED`, `PDF_MANUAL_REVIEW_REQUIRED` |
| Sprint 79 stub codes (must NOT appear) | `PDF_UNSUPPORTED_BINARY_PARSER`, `PDF_TEXT_LAYER_UNAVAILABLE` |

### Case B — Tag-first + Direction column

| Outcome | Value |
| --- | --- |
| Table candidates | `1` |
| Header columns recognised | includes `'direction'` role |
| `plc_channel:` nodes | `2` |
| `PDF_IO_ROW_ADDRESS_DIRECTION_CONFLICT` | NOT raised (B1+input matches I-address direction) |

### Case C — Narrative selectable-text PDF (no IO rows)

| Outcome | Value |
| --- | --- |
| Text blocks | `≥ 1` (paragraph extracted) |
| `plc_channel:` nodes | `0` |
| `graph.edges` | `[]` |
| Required diagnostics | `PDF_TEXT_LAYER_EXTRACTED`, `PDF_ELECTRICAL_EXTRACTION_NOT_IMPLEMENTED` |
| `PDF_MANUAL_REVIEW_REQUIRED` | NOT raised (no rows to review) |

### Case D — Malformed bytes

| Outcome | Value |
| --- | --- |
| `graph.nodes` | `[]` |
| Required diagnostics | `PDF_MALFORMED` |
| `PDF_TEXT_LAYER_EXTRACTED` | NOT raised |

## Web upload pass — operator instructions

Sprint 81 also requires at least one manual upload through the
web workspace. The deterministic harness above covers the
behaviour at the domain layer; the operator should confirm that
the web flow surfaces the same behaviour end-to-end.

> **The operator runs this — not the AI.** Sprint 81 cannot
> open a browser. The instructions below produce the binary
> fixture the operator can drop into the workspace's file picker.

### Generating the operator-side fixtures

The same fixture builder used by the harness can produce the
binary bytes off-line. From a Node REPL inside the repo:

```js
import { buildTabularPdfFixture, buildMinimalPdfFixture } from
  './packages/electrical-ingest/tests/fixtures/pdf/build-fixture.js';
import { writeFileSync } from 'node:fs';

writeFileSync('case-A-io-table.pdf', buildTabularPdfFixture({
  pages: [{ rows: [
    { y: 720, cells: [
      { text: 'Address', x: 50 }, { text: 'Tag', x: 150 },
      { text: 'Description', x: 220 },
    ]},
    { y: 700, cells: [
      { text: 'I0.0', x: 50 }, { text: 'B1', x: 150 },
      { text: 'Part present', x: 220 },
    ]},
    { y: 682, cells: [
      { text: 'Q0.0', x: 50 }, { text: 'Y1', x: 150 },
      { text: 'Cylinder extend', x: 220 },
    ]},
  ]}]
}));
```

Or if the dev environment doesn't have a TS-aware Node runner:
type the assertions in `tests/pdf-acceptance.spec.ts` reproduce
the same shape.

### Checklist

1. `pnpm web:dev` — open the Electrical ingestion (preview) card.
2. Upload `case-A-io-table.pdf`. Expect:
   - Detected: pdf badge.
   - Diagnostics include `PDF_TEXT_LAYER_EXTRACTED`,
     `PDF_TABLE_HEADER_DETECTED`, `PDF_TABLE_CANDIDATE_DETECTED`.
   - 4 IO candidates render in the review table.
   - Per-row source ref shows `kind: pdf`, `page: 1`, real
     `bbox` (unit `'pt'`), and the verbatim row text.
   - Build PIR button stays disabled until every item is
     reviewed (Sprint 78A gate).
3. Upload `case-C-narrative.pdf`. Expect:
   - Text blocks shown but no IO candidates.
   - Build PIR stays disabled (empty candidate, Sprint 78A).
4. Upload `case-D-malformed.pdf`. Expect:
   - `PDF_MALFORMED` (error) in diagnostics.
   - Empty review.
5. (Optional) Upload a real public scanned PDF. Expect:
   - Per-page `PDF_TEXT_LAYER_EMPTY_PAGE` warnings.
   - `PDF_NO_TEXT_BLOCKS`.
   - No graph candidates; build button disabled.

## Honest constraints (Sprint 81)

- **No real-world customer PDFs were tested.** The deterministic
  harness exercises four shapes; real plant drawings will surface
  layout cases Sprint 81 doesn't yet handle.
- **No multi-column PDFs.** The detector clusters lines by Y;
  multi-column reading order is deferred.
- **No rotated pages.** Sprint 81's single-column line-grouping
  has no rotation support.
- **No table detection beyond IO-list shape.** Borderless tables
  with column headers like `Channel | Description | Type` are
  recognised; richer table extraction (merged cells, multi-row
  headers, repeated headers across page breaks) is deferred.
- **No OCR.** Scanned PDFs surface `PDF_TEXT_LAYER_EMPTY_PAGE`
  warnings + `PDF_OCR_NOT_ENABLED` info; no extraction is
  attempted.
- **No PIR auto-promotion.** Every PDF-derived candidate stays
  pending until reviewed.
- **PDF-derived confidence stays ≤ 0.65.** Even with a header-
  aware extraction, PDF rows never read at a confidence higher
  than structured CSV/XML rows.

## Recommendation for Sprint 82

If real-world PDFs are now the bottleneck (the harness is
green; web upload looks usable):

- **Sprint 82 — PDF extraction hardening:** multi-column
  ordering, rotated pages, coordinate normalisation, better
  column-position detection, row/column confidence scoring,
  richer UI for the source drilldown (bbox overlays).

If the layout problem looks bigger than that:

- **Sprint 82A — PDF layout architecture:** explicit
  `PdfLayoutRegion` model, region clustering, optional page-
  preview component with bbox overlays.

OCR, symbol recognition, and wire-graph reconstruction stay
later in the roadmap.
