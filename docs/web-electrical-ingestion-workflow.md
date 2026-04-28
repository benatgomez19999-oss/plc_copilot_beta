# Web electrical-ingestion workflow — Sprint 77

> **Status: end-to-end pipeline live in `@plccopilot/web`
> (Sprint 77).** CSV / EPLAN XML → review → PIR preview, all
> inside the existing dev-mode app. **No automatic PLC codegen.**
> Codegen still requires explicit operator action and is not
> wired into this flow.

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

## Known limitations (Sprint 77)

- **No persistence.** Refreshing the browser resets the workspace.
- **No auth / user attribution.** Anyone with access to the page
  can ingest, accept, reject.
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
