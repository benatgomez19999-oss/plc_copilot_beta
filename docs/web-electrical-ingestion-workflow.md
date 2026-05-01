# Web electrical-ingestion workflow — Sprint 77 → … → 94

> **Status: end-to-end pipeline live in `@plccopilot/web`
> (Sprint 77 → 78A → 78B → 79 → 80 → 81 → 82 → 87B → 89 → 90A → 90B → 91 → 92 → 93 → 94).**
> CSV / EPLAN XML / TcECAD XML / **PDF (real text-layer + IO-list
> table extraction + Sprint 82 address strictness)** → review →
> PIR preview → **local persistence + downloadable artefacts**,
> all inside the existing dev-mode app. **Sprint 87B** added the
> codegen readiness panel above Generate; **Sprint 89** added an
> explicit, operator-driven *codegen preview* panel below the
> readiness panel — the operator can inspect the artifact list,
> manifest diagnostics, and short ephemeral content snippets
> (≤ 40 lines / 4 KB per artifact) BEFORE pressing Generate.
> **Sprint 90A** then adds a single explicit *Download preview
> bundle* button next to *Refresh preview*: it serialises the
> current preview state (full-content artifacts, status, summary,
> diagnostics, per-target error blocks) into a deterministic JSON
> file the operator saves locally — no re-run of the vendor
> pipeline, no auto-download, no inclusion in canonical session
> exports. **Sprint 90B** layers an ephemeral *Preview diff*
> section underneath: when a new successful preview lands, the
> prior successful preview becomes the baseline and the panel
> shows per-target status transitions, artifact added /
> removed / changed (with a compact line-based diff sample,
> ≤ 80 lines / 8 KB, truncation flagged), and diagnostic
> added / removed. The diff lives in React state only — lost on
> reload, never persisted to localStorage, never folded into the
> canonical session export. Failed / blocked refreshes do not
> regress the baseline. **Sprint 91** then adds a single
> explicit *Download diff bundle* button next to the diff
> headline: it serialises the Sprint 90B diff into a small
> auditable JSON file (no `"content"` key — diff archive, not
> artifact archive) the operator saves locally, gated on the
> same Sprint 90A successful-preview semantics. Stale views
> hide the button and prompt the operator to refresh. **Sprint
> 92** then closes the diff archive cycle: the operator can
> import a previously-downloaded
> `plc-copilot.codegen-preview-diff` v1 JSON and view it in a
> read-only *Archived diff* section that mirrors the live diff's
> visuals. The imported diff cannot feed Generate, cannot modify
> the applied project, cannot change the Sprint 90B preview
> baseline / current, cannot re-run the vendor pipeline, cannot
> reach localStorage, and cannot fold into the canonical session
> export. Wrong kind / wrong version / malformed JSON surface as
> a stable invalid state with no crash. Refreshing the browser
> drops the imported diff. **Sprint 93** is a web-only visual
> polish pass: every renderer-shared piece of copy and status →
> CSS-class mapping moves into a single pure helper, the live
> + archived diff sections gain *Expand all* / *Collapse all*
> controls (React-local, never persisted), and the unified
> `status-badge--<token>` palette gives the same colour to the
> same status across readiness / preview / live diff / archived
> diff. No bundle / contract / Generate / worker / localStorage
> / canonical export-bundle change. **Sprint 94** then closes
> the audit cycle by adding a *Compare with current preview*
> button to the archived diff section: the operator runs a
> fresh preview, clicks Compare, and the panel renders a
> deterministic read-only meta-compare (an
> `ArchivedPreviewComparisonView` produced by a pure helper
> `compareImportedDiffWithCurrentPreview`) showing per-target
> drift — `same-hash` / `changed-hash` / `missing-current` /
> `new-current` artifact transitions plus `still-present` /
> `resolved` / `new-current` diagnostic transitions. Selection
> mismatch surfaces as `selection-mismatch` (no overlap) or
> `partially-comparable` (some overlap). The snapshot stores
> refs to the bundle + preview it was built against and marks
> itself stale when either moves. *Clear comparison* drops the
> snapshot. No vendor-pipeline re-run on Compare; no archived-
> bundle mutation; no Generate / worker / canonical export-
> bundle / localStorage change. Preview, download bundle, diff,
> diff bundle, imported diff, expand state, and the new
> comparison snapshot are never automatic, never persisted to
> localStorage, and never included in export bundles.
> **Sprint 82** is a
> safety/hardening sprint: isolated Beckhoff-style channel
> markers (`I1`, `O2`, `%I1`) are no longer promoted to
> buildable PIR addresses. Source-evidence drilldown now
> surfaces the PDF `snippet` + `bbox` the extractor populates.
> **No automatic PLC codegen. No backend, no auth, no upload,
> no OCR.** Raw source content (CSV/XML body, PDF bytes) is not
> persisted by default.
>
> Sprint 81 includes the first deterministic PDF acceptance
> harness; Sprint 82's regression scenario is documented in
> [`docs/pdf-manual-acceptance-sprint-82.md`](pdf-manual-acceptance-sprint-82.md).
> Sprint 83A adds a table-family classifier so BOM / terminal /
> cable / contents / legend headers no longer surface as
> IO-list-shaped. **Sprint 83B** then throttles the classifier's
> diagnostic stream — repeated footers, vendor-metadata lines,
> and body rows that incidentally hit a strong family token are
> now suppressed; identical headers within a page collapse to
> one diagnostic. Sprint 83C then aggregates the surviving
> non-IO family diagnostics across pages into a single rollup
> per `(family, signature)` group with a compressed page range.
> **Sprint 83D** replaces that signature-based key with a
> *canonical section role* per family — numbered TcECAD markers
> (`=COMPONENTS&EPB/1..7`, `=CABLE&EMB/1..24`,
> `=CONTENTS&EAB/1..3`, `=LEGEND&ETL/1..6`,
> `=TERMINAL&EMA/1..7`) and sibling BOM table headers across
> pages 80–86 collapse into one rollup per family/role. Volume /
> UX only — no schema change, no UI work, no loosened safety.
> Source-evidence drilldown UX (page preview, bbox overlays,
> click-through into all pages a rollup covered) remains a
> future sprint. Sprint 83A acceptance:
> [`docs/pdf-manual-acceptance-sprint-83A.md`](pdf-manual-acceptance-sprint-83A.md).
> Sprint 83B acceptance:
> [`docs/pdf-manual-acceptance-sprint-83B.md`](pdf-manual-acceptance-sprint-83B.md).
> Sprint 83C acceptance:
> [`docs/pdf-manual-acceptance-sprint-83C.md`](pdf-manual-acceptance-sprint-83C.md).
> Sprint 83D acceptance:
> [`docs/pdf-manual-acceptance-sprint-83D.md`](pdf-manual-acceptance-sprint-83D.md).
> **Sprint 83E** then adds the first operator-facing PDF
> source-evidence UX on top of the now-stable diagnostic
> stream: every PDF-source diagnostic gets a compact
> "Show PDF evidence" toggle that reveals the full page list
> from the rollup message, the representative SourceRef
> snippet + bounding box, and an honest `representative-only`
> notice when the rollup covers more pages than the source
> reference can drill into. CSV / EPLAN / TcECAD flows keep
> their existing one-liner unchanged. Volume / UX only — no
> schema change, no new extraction capability, no page
> preview / bbox overlay rendering yet. Sprint 83E acceptance:
> [`docs/pdf-manual-acceptance-sprint-83E.md`](pdf-manual-acceptance-sprint-83E.md).
> **Sprint 83F** then removes the Sprint 83E representative-only
> cliff for multi-page rollups: an additive optional
> `additionalSourceRefs` field on `ElectricalDiagnostic` carries
> one `SourceRef` per non-representative page, and the web UI
> renders them as a grouped per-page evidence list. The Sprint
> 83E rep-only notice survives as a fallback for older
> diagnostics or partial coverage. Backwards-compatible —
> existing consumers ignore the new field; older diagnostics
> omit it entirely. Sprint 83F acceptance:
> [`docs/pdf-manual-acceptance-sprint-83F.md`](pdf-manual-acceptance-sprint-83F.md).
> **Sprint 84** then adds layout-analysis helpers in the
> ingestor (column-aware reading order, region clustering,
> rotation heuristic) and surfaces two new info diagnostics
> (`PDF_LAYOUT_MULTI_COLUMN_DETECTED`,
> `PDF_LAYOUT_ROTATION_SUSPECTED`). Multi-column pages now read
> column-by-column instead of interleaving by y-coordinate. v0
> only reorders + flags — no new extraction capability, no UI
> change, no canvas rendering. Sprint 84 acceptance:
> [`docs/pdf-manual-acceptance-sprint-84.md`](pdf-manual-acceptance-sprint-84.md).
> **Sprint 84.1** then wires region clustering into the PDF
> detector path: detector lines carry an optional `regionId`,
> and the IO header→rows walk stops at region boundaries so a
> header can no longer absorb a footer/title-block/narrative
> line that happens to look IO-shaped. One sparse info
> diagnostic per page (`PDF_LAYOUT_REGION_CLUSTERED`). UX-
> visible only when the operator scans diagnostics; the rollup
> stream and per-page evidence remain identical. Sprint 84.1
> acceptance:
> [`docs/pdf-manual-acceptance-sprint-84-1.md`](pdf-manual-acceptance-sprint-84-1.md).
> **Sprint 84.1B** then collapses the per-page
> `PDF_LAYOUT_MULTI_COLUMN_DETECTED` and
> `PDF_LAYOUT_REGION_CLUSTERED` emission into one rollup per
> code with a compressed page-range message — diagnostic-
> hygiene only, same codes, no schema change, no new UI.
> `PDF_LAYOUT_ROTATION_SUSPECTED` stays per-page (rare and
> operationally important). Sprint 84.1B acceptance:
> [`docs/pdf-manual-acceptance-sprint-84-1B.md`](pdf-manual-acceptance-sprint-84-1B.md).
> **Sprint 87B** then surfaces codegen readiness as a
> compact `CodegenReadinessPanel` between the toolbar and the
> compile-error banner. The panel runs `preflightProject` on
> the applied PIR for the selected backend (or all three when
> `backend=all`) and shows verdict + grouped diagnostics
> BEFORE the operator clicks Generate. Generate stays explicit;
> the Sprint 86 `READINESS_FAILED` fallback banner is
> preserved. Sprint 87B acceptance:
> [`docs/codegen-readiness-ux-sprint-87B.md`](codegen-readiness-ux-sprint-87B.md).

## Run the dev server

```sh
pnpm install               # if you just pulled
pnpm web:dev               # alias for `pnpm --filter @plccopilot/web dev`
```

The app opens on `http://localhost:5173` (default Vite port).

## Where the workflow lives

The existing PIR-JSON workflow is unchanged. Sprint 77 mounts the
new electrical-ingestion path as a separate, collapsed card at
the bottom of the page:

```
Electrical ingestion (preview)
  CSV / EPLAN XML → review → PIR preview · Sprint 77 · no automatic codegen
```

Click the card to expand it. The card is self-contained — its
state is independent of the PIR-JSON workspace above.

## Sample CSV input

Paste this into the workspace's text area (or upload a `.csv`
file with the same content):

```csv
tag,kind,address,direction,label
B1,sensor,%I0.0,input,Part present
Y1,valve,%Q0.0,output,Cylinder extend
M1,motor,%Q0.1,output,Conveyor motor
```

Set the file name to `simple-list.csv`. Click **Ingest**.

Expected behaviour:
- "Detected: csv" badge appears.
- Three IO candidates land in the review table (`%I0.0`, `%Q0.0`,
  `%Q0.1`).
- Three equipment candidates: sensor / valve / motor.
- No assumptions, no errors. Two info-level diagnostics may
  appear (the CSV ingestor is verbose about row mapping).

## Sample EPLAN XML input

```xml
<?xml version="1.0"?>
<EplanProject>
  <Pages>
    <Page sheet="=A1/12">
      <Element tag="B1" kind="sensor" address="%I0.0" direction="input"/>
      <Element tag="Y1" kind="valve" address="%Q0.0" direction="output"/>
      <Element tag="M1" kind="motor" address="%Q0.1" direction="output"/>
    </Page>
  </Pages>
</EplanProject>
```

Set file name to `plan.xml`. Click **Ingest**.

Expected behaviour:
- "Detected: xml" badge.
- Same three IO + three equipment candidates as the CSV path.
- Source refs include the EPLAN XML locator
  (`/EplanProject[1]/Pages[1]/Page[1]/Element[N]`).

## Accept / reject decisions

The Sprint 75 review panel shows for each candidate:
- **Accept** / **Reject** / **Reset** buttons (radio group).
- Confidence badge.
- "Show N sources" toggle for the source-ref drilldown.

Architecture invariants:
- **Pending by default.** Nothing is auto-accepted, especially
  not assumptions.
- **Low-confidence pending items** are highlighted in the summary
  header.
- **Source evidence** is one click away on every row.

## Build PIR preview

The **Build PIR preview** button is **disabled** while the gate
is false. Hover for a tooltip listing the reasons; an explicit
"Why it's disabled" block appears below the button. Reasons map
to the same diagnostics the domain builder would emit:

- "N IO candidates still pending review"
- "N equipment candidates still pending review"
- "N assumptions still pending review"
- "N error-severity ingestion diagnostics blocking build"

Once every item is accepted or rejected and there are no
error-severity ingestion diagnostics, the button enables. Click
it to:

1. Run `buildPirPreview` (which calls the Sprint 76 domain
   builder).
2. Render the **PIR build diagnostics** (severity-filtered).
3. Render the **PIR preview JSON** (only when `result.pir` is
   defined and the validator passed).
4. Render the **Source evidence** sidecar (`result.sourceMap`)
   with per-PIR-id drilldown.

## Honest disclaimers visible in the UI

- **"PIR preview, not final PIR."** The PIR preview validates
  against `@plccopilot/pir` but is not the same thing as a
  ready-to-deploy PLC program.
- **"Codegen is not run automatically."** The disclaimer block
  appears under the Build button on every render.
- **"Placeholder sequence."** When the builder emits a placeholder
  `init → terminal` sequence (Sprint 76 v0), the JSON preview
  shows an explicit note above the JSON — never hidden.
- **"Source refs are preserved in `sourceMap` sidecar."** The PIR
  schema does not carry `SourceRef[]` directly; the sidecar
  carries them, and the JSON preview links to it explicitly.

## Common situations

### Build refused with "PIR_BUILD_PENDING_REVIEW_ITEM"

You haven't accepted/rejected every item. The button stays
disabled. Open each row and click Accept or Reject.

### Build refused with "PIR_BUILD_ERROR_DIAGNOSTIC_PRESENT"

The ingestion produced an error-severity diagnostic (e.g. a
malformed CSV header or a missing tag in the EPLAN XML). Fix the
source and re-ingest — the builder refuses to run on top of an
error.

### Build refused with "PIR_BUILD_EMPTY_ACCEPTED_INPUT"

Every IO + equipment was rejected. Accept at least one to build.

### Build refused with "PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID"

An accepted equipment binds to an IO that you rejected. Either
accept the IO, or reject the equipment. Sprint 76's gate is
strict by design — it refuses to silently drop wired evidence.

### Build refused with "PIR_BUILD_UNSUPPORTED_EQUIPMENT_KIND"

The candidate has `kind: 'unknown'`; PIR has no safe equivalent.
Reject the equipment row and re-build, or fix the source data so
the kind resolves to a known alias (sensor / motor / valve / etc.).

### Build succeeded but JSON has a placeholder sequence

That's by design (Sprint 76 v0). The note above the JSON
explains. Real sequence wiring is a future-sprint scope.

## Testing with Beckhoff/TwinCAT ECAD XML

Sprint 78A added a Beckhoff/TwinCAT ECAD Import recognizer for XML
exports that *don't* match the EPLAN `<Element>` family. If your
sample looks like this:

```xml
<Project>
  <Description>TcECAD Import V2.2.12</Description>
  <CPUs><CPU>...<Interfaces><Interface><Boxes><Box>
    <Name>...</Name><Type>EL1004</Type><BoxNo>1005</BoxNo>
    <Variables><Variable>
      <Name>S1_1</Name><Comment>Lichttaster</Comment>
      <IsInput>true</IsInput><IoName>Input</IoName>
      <IoGroup>Channel 1</IoGroup><IoDataType>BOOL</IoDataType>
    </Variable></Variables>
  </Box></Boxes></Interface></Interfaces></CPU></CPUs>
</Project>
```

…it will route to the TcECAD recognizer (sourceKind: `twincat_ecad`)
ahead of the EPLAN ingestor.

Expected outcome:

- IO candidates **are** extracted (one per `<Variable>` with all
  three of `<IsInput>`, `<IoName>`, `<IoDataType>` siblings).
- Each candidate carries a structured `tcecad:<boxNo>:<ioGroup>`
  address — **not** Siemens %I/%Q.
- An info diagnostic
  (`TCECAD_XML_STRUCTURED_ADDRESS_USED`) explains why per
  variable.
- After accepting all candidates, **the PIR builder will refuse**
  with `PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS` because the
  structured address doesn't map to PIR's `IoAddress` schema.
  This is correct — the operator must resolve the Box → Siemens
  address mapping out-of-band before promoting PIR.

Sprint 78A also fixes the empty-candidate UX bug: an unrecognised
XML now keeps the **Build PIR preview** button disabled with a
"no reviewable candidates" reason instead of flipping the UI to
"Ready to build". Verified via the public `TC ECAD IMPORT V2_2_x.xml`
sample during manual testing.

Full format reference + diagnostic table:
[`docs/twincat-ecad-xml-format.md`](twincat-ecad-xml-format.md).

## Sprint 78B — Local persistence + downloadable artefacts

The workspace now autosaves the active review session to your
browser's `localStorage` after every ingestion + every decision
+ every build attempt. Refreshing the page no longer wipes the
review.

### Review session panel

A **Review session** card sits above the review tables. It shows:

- **Saved locally** / **Not saved yet** / **No session** badge.
- File name, detected source kind, source id, last update / last
  save timestamps, and the lightweight content hash (FNV-1a 32-bit
  hex — non-cryptographic, used for local identity only).
- Buttons: **Save now**, **Load last**, **Clear saved**,
  **Download review session**, **Import session**.

### What gets persisted

The persisted snapshot follows
[`docs/electrical-review-session-format.md`](electrical-review-session-format.md):

- `schemaVersion: 'electrical-review-session.v1'`
- `createdAt` / `updatedAt` (ISO 8601)
- Source metadata (`sourceId`, `fileName`, `inputKind`,
  `sourceKind`, `contentHash`)
- The full `PirDraftCandidate` (IO, equipment, assumptions,
  diagnostics)
- The full `ElectricalReviewState` (your accept/reject decisions)
- The ingestion-side diagnostics (`ElectricalDiagnostic[]`)
- (Optional) the most recent `build` summary — pir, sourceMap,
  diagnostics, accepted/skipped counts

**What is NOT persisted by default:** the raw CSV / XML body. The
default policy is to keep the extracted *evidence* (which is
already structured and de-identified) but **drop the source text**,
because electrical drawings can carry confidential customer /
project / site identifiers. If you need to re-ingest from the
exact same input later, hold on to the source file separately —
it's not in `localStorage`.

### Downloads (Export artefacts panel)

Below the build output, an **Export artefacts** panel exposes:

- `plccopilot-{base}-review-session.json` — the snapshot above.
- `plccopilot-{base}-ingestion-diagnostics.json` — registry/ingestor diagnostics.
- `plccopilot-{base}-pir-preview.json` — only enabled when the
  builder produced a schema-valid PIR.
- `plccopilot-{base}-source-map.json` — the per-PIR-id sourceRef
  sidecar (only enabled when non-empty).
- `plccopilot-{base}-build-diagnostics.json` — enabled after any
  build attempt, including refusals.
- `plccopilot-{base}-review-bundle.zip` — every available artefact
  above, plus a `summary.json` index. Uses the existing JSZip
  dependency.

`{base}` is derived from your input file name (sanitised: ASCII
letters/digits/`._-` only, capped at 64 chars). When no file name
is set, `plccopilot-{suffix}` is used.

### Privacy note

Persistence is **local-only**. The workspace never uploads, syncs,
or attributes a user. The notice in the panel reads:

> Saved locally in this browser only. **No upload.** Raw source
> content (CSV / XML body) is **not persisted by default** —
> only the extracted candidate, your review decisions, and
> diagnostics. No PLC codegen is run.

### Restore semantics

- **Load last** reads the most recent saved snapshot. Decisions are
  restored exactly. The build result is *not* replayed — pir /
  sourceMap on disk may be stale relative to the current code, so
  you must press **Build PIR preview** again if you want a live
  preview after a restore.
- **Import session** lets you pick a `*.review-session.json` file.
  The same defensive validator runs (schemaVersion, source shape,
  candidate / reviewState shape, build shape) and any malformed
  field surfaces a non-fatal notice in the panel.
- **Clear saved** removes the slot. The in-memory session is
  preserved.

### TcECAD case (refused build) — what's still useful

For the TcECAD path observed in Sprint 78A manual testing
(structured `tcecad:<boxNo>:<channel>` addresses, builder refuses
honestly because they don't map to PIR `IoAddress`):

- **PIR preview download** is **disabled** (no valid PIR was
  produced).
- **Source map download** is **disabled** (build did not produce
  one).
- **Build diagnostics download** is **enabled** and useful — it
  carries the refusal reasons (`PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS`,
  `PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID`, `PIR_BUILD_EMPTY_ACCEPTED_INPUT`).
- **Ingestion diagnostics + review session + bundle download** are
  enabled — operators can hand the bundle to a colleague who
  resolves the Box → Siemens address mapping out-of-band before
  re-ingesting.

## Sprint 79 — PDF ingestion (v0)

The workspace now accepts PDF input as a first-class peer of CSV
and XML. Two paths through the same registry:

### Test-mode text path

For testing the architecture without a binary parser dependency,
paste **already-extracted PDF text** into the textarea, using the
convention `--- page N ---` to delimit pages:

```
--- page 1 ---
I0.0 B1 Part present
Q0.0 Y1 Cylinder extend

--- page 2 ---
Q0.1 M1 Conveyor motor
notes about wiring
```

Set the file name to `plan.pdf`. Press **Ingest**. Expected:

- "Detected: pdf" badge appears.
- Text blocks are extracted with `SourceRef.kind === 'pdf'`,
  `page`, `line`, and `snippet` (verbatim line content).
- The conservative IO-row regex matches the three rows above and
  produces three IO + three device candidates with low-but-honest
  confidence (≤ 0.65 — strictly below structured CSV/XML rows).
- The diagnostics list includes `PDF_TEXT_BLOCK_EXTRACTED` (info)
  and `PDF_TABLE_DETECTION_NOT_IMPLEMENTED` (info — Sprint 79
  v0 does not detect tables).

### Binary path (Sprint 80 — real text-layer extraction)

Upload a real `.pdf` file via the file picker. The workspace
reads it via `arrayBuffer()` and forwards the bytes to the
registry. The Sprint 79 honest-stub banner from
[`docs/web-electrical-ingestion-workflow.md`](web-electrical-ingestion-workflow.md)
still warns that PDF binary uploads are accepted but the workshop
may produce only diagnostics on scanned PDFs.

The Sprint 80 ingestor (`ingestPdf` async + adapter at
`packages/electrical-ingest/src/sources/pdf-text-layer.ts`):

- Validates `%PDF-` magic. Mismatch → `PDF_MALFORMED` (error).
- Calls `extractPdfTextLayer` (pdfjs-dist legacy build) with
  `disableFontFace`, `useSystemFonts: false`, `useWorkerFetch:
  false`, `isEvalSupported: false` — Node-friendly settings.
- Per page: walks text items, clusters them by baseline-Y into
  deterministic lines (helper at `pdf-text-normalize.ts`),
  produces `PdfTextBlock`s with combined PDF-point bboxes
  (unit `'pt'`) and verbatim snippets.
- Runs the Sprint 79 conservative IO-row regex over each line.
  Matches produce low-confidence (≤ 0.65) `pdf_device:` /
  `plc_channel:` graph nodes + `signals` / `drives` edges.

Expected behaviour on a real selectable-text PDF whose content
includes IO-list rows:

- Diagnostics include `PDF_TEXT_LAYER_EXTRACTED` (info: N line
  blocks across M pages) + `PDF_TABLE_DETECTION_NOT_IMPLEMENTED`
  (info — roadmap reminder).
- Review tables show extracted IO + device candidates with
  source-ref drilldown showing `kind: pdf`, `page: N`, `line: M`,
  `bbox` in PDF points, and the verbatim snippet.

Expected behaviour on a scanned PDF (no embedded text):

- Per-page `PDF_TEXT_LAYER_EMPTY_PAGE` (warning).
- `PDF_NO_TEXT_BLOCKS` (warning) when every page is empty.
- No graph candidates. Build PIR button stays disabled.

Expected behaviour on a malformed / encrypted / unsupported
PDF:

- `PDF_TEXT_LAYER_EXTRACTION_FAILED` (error) for malformed
  bodies. pdfjs failed `getDocument`.
- `PDF_ENCRYPTED_NOT_SUPPORTED` (error) when pdfjs raised
  `PasswordException`. `metadata.encrypted = true`.
- `PDF_DEPENDENCY_LOAD_FAILED` (error) on a partial reinstall
  where the dynamic import of pdfjs-dist itself fails.

If the operator uploaded bytes AND pasted text, and the bytes
extraction failed, the ingestor falls back to the Sprint 79
test-mode parser. Both diagnostic sets are preserved.

The Build PIR button stays disabled until every reviewable item
is accepted/rejected (Sprint 78A gate), regardless of source.
The review-session panel still saves the snapshot, and the
export panel still offers per-artefact downloads + a bundle —
useful for sharing extracted PDF evidence even when the builder
refuses (e.g., unrecognised addresses).

### What is NOT supported in Sprint 79 v0

- **No OCR**, even with `allowOcr: true` (the flag raises
  `PDF_OCR_NOT_ENABLED` info).
- **No layout-aware table detection** (`PDF_TABLE_DETECTION_NOT_IMPLEMENTED`
  info on every parse).
- **No symbol or connection-graph recognition.**
- **No production binary parser.** A real parser arrives in a
  future sprint (likely `pdfjs-dist`-based) — Sprint 79's stub
  refuses to fake the work.

### How exports/session treat PDF-derived evidence

- **Raw PDF bytes are NEVER persisted.** Neither in `localStorage`
  (autosave snapshot) nor in any download. The `contentHash` for
  binary inputs hashes a small projection (length + first/last 64
  bytes) — non-cryptographic, used for local identity only.
- **Snippets ARE persisted** inside `SourceRef.snippet`. They
  carry verbatim source-text excerpts (≤ 160 chars per line) so
  the review UI's drilldown can show the operator "where did this
  fact come from?". Treat exported review sessions as potentially
  sensitive.
- **PDF SourceRefs round-trip** through the snapshot — `kind: 'pdf'`,
  `page`, `line`, `snippet`, `symbol` (and `bbox` once the
  production binary parser ships) all survive a refresh + load
  last cycle.

Full reference: [`docs/pdf-ingestion-architecture.md`](pdf-ingestion-architecture.md).

## Known limitations (Sprint 78B)

- **Single-slot v0.** Only one session is persisted at a time. Per-
  source slots are reserved (`plccopilot:electricalReview:session:<id>`)
  but not yet exposed.
- **No raw source persistence.** By design (privacy). Re-ingestion
  requires re-uploading the source file.
- **No auth / user attribution.** Anyone with access to the page
  can ingest, accept, reject. The session JSON carries no user
  identity field.
- **Build result not replayed on restore.** The operator must press
  Build PIR preview again — codegen is still never automatic.
- **No automatic codegen.** A future sprint may add a controlled,
  manual codegen-preview step gated on accepted PIR; Sprint 77
  does NOT.
- **No DOM-level tests.** The web vitest config still runs in
  `node` mode; the workflow's pure helpers are exhaustively
  tested. Components are verified by typecheck and the dev
  server.
- **Manual file upload only.** No drag-and-drop, no cloud
  storage, no GitHub integration. Paste text or use the file
  picker.

## How to contribute a real EPLAN XML sample

1. **Anonymise first.** Strip customer / project / site
   identifiers from `<Description>` / `<Function>` / `<Location>`
   and any IP-sensitive comments.
2. Place the sanitised XML under
   `packages/electrical-ingest/tests/fixtures/eplan/`.
3. Add a focused test in `tests/eplan-xml.spec.ts` (Sprint 74)
   asserting whatever shape the fixture exposes.
4. Run `pnpm --filter @plccopilot/electrical-ingest test` to
   verify.
5. The same XML, dropped into the web workspace, will exercise
   the Sprint 77 path end-to-end.
