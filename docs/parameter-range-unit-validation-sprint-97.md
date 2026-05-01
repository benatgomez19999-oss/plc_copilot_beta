# Sprint 97 — Parameter range / unit validation v0

> **Status: shipped in `@plccopilot/pir` + `@plccopilot/electrical-ingest`.**
> Adds the first explicit, non-inferential layer over PIR
> Parameter `min` / `max` / `unit`. PIR-side validation rule
> R-PR-03 catches malformed bounds + the role-specific unit
> policy for `motor_vfd_simple.speed_setpoint_out`. Electrical-
> ingest CSV + structured XML extractors read explicit bound
> columns / attributes / child elements and emit per-row
> diagnostics. No automatic scaling, no unit conversion, no
> runtime clamps, no codegen change.

## Why

By the close of Sprint 88M, `motor_vfd_simple` ran end-to-end
through CSV / EPLAN / TcECAD → review → PIR → CODESYS / Siemens
/ Rockwell. The weakest link was `Parameter`: the type already
carried optional `min` / `max` / `unit`, but nothing read them
or enforced coherence. Operators occasionally land bundles with
inverted bounds, defaults outside the declared range, or a
`speed_setpoint_out` parameter expressed in `rpm` that the
codegen pipeline cannot scale for them. Sprint 97 closes the
v0 gap with three small, conservative checks.

## Rule of thumb

**Sprint 97 does not infer, convert, or synthesise.** Every
bound, default, or unit must come from explicit source metadata.
Free-text comments, descriptions, embedded numeric hints — all
ignored.

## Scope

- **PIR** — schema tightening + new validator rule R-PR-03.
- **electrical-ingest** — CSV + structured-XML parameter
  extractors learn `min` / `max` aliases.
- **Codegen** — unchanged. The vendor renderers continue to
  treat the parameter as a `SymbolRef` and Sprint 97 adds no
  generated runtime clamps.

## Data model

`Parameter` already supports `min?`, `max?`, `unit?` from earlier
sprints. Sprint 97 tightens the PIR schema:

```ts
// packages/pir/src/schemas/common.ts (excerpt)
ParameterSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    data_type: z.enum(['int', 'dint', 'real', 'bool']),
    default: z.union([z.number(), z.boolean()]),
    min: z.number().finite().optional(),  // Sprint 97: reject Infinity
    max: z.number().finite().optional(),  // Sprint 97: reject Infinity
    unit: z.string().optional(),
    description: z.string().optional(),
  })
  .strict()
  .refine(
    (p) => p.min === undefined || p.max === undefined || p.min <= p.max,
    { message: 'min must be ≤ max' },
  );
```

Z `min/max` reject `Infinity`, `-Infinity`, and `NaN` at the
schema layer. `min ≤ max` is also schema-enforced.

The `electrical-ingest` `PirParameterCandidate` type gains
`min?: number; max?: number`; `buildParameter` forwards them
verbatim (with a defensive finite check) into PIR's `Parameter`.

## Validation rules

### PIR validator

| Rule | Severity | What it checks |
|---|---|---|
| **R-PR-02** (existing) | error | `default` must match the declared dtype and live within the explicit range. |
| **R-PR-03 (A)** (new) | error | `min` / `max` are finite numbers; `min ≤ max`. Belt-and-braces — the schema also enforces this; the validator rule catches PIRs constructed via `as Project` casts (test fixtures, hand-rolled JSON). |
| **R-PR-03 (B)** (new) | error / info | For every parameter wired as `motor_vfd_simple.speed_setpoint_out`: unit must be one of `Hz` / `hz` / `Hertz` / `HERTZ` (case-insensitive, whitespace-trimmed). Foreign units (`rpm`, `%`, `m/s`, …) hard-fail. **Missing unit is `info`, not error** — Sprint 97 stops short of forcing operators to retro-fit unit strings on every existing PIR. |

`R-PR-03 (B)` walks the equipment side: only parameters bound to
a `motor_vfd_simple.speed_setpoint_out` role are unit-checked. A
parameter with `unit: 'rpm'` that is never wired as a speed
setpoint stays valid.

### electrical-ingest diagnostics

| Code | Severity | When |
|---|---|---|
| `CSV_PARAMETER_RANGE_INVALID` | warning | Unparseable `min` / `max`, inverted bounds (`min > max`). The offending bound is dropped; the rest of the parameter is preserved. |
| `CSV_PARAMETER_DEFAULT_OUT_OF_RANGE` | warning | `default` lies outside `[min, max]` (when both are present). The parameter still extracts; PIR's R-PR-02 surfaces the same condition as a hard error at build time. |
| `STRUCTURED_PARAMETER_RANGE_INVALID` | warning | EPLAN / TcECAD attribute-style or child-element bounds malformed / inverted. |
| `STRUCTURED_PARAMETER_DEFAULT_OUT_OF_RANGE` | warning | EPLAN / TcECAD default outside the declared range. |

All four codes are warnings on purpose: ingestion never blocks
on a bound issue. PIR validation R-PR-02 / R-PR-03 carries the
hard error at build time, with consistent path information.

## CSV format

The CSV ingestor recognises these aliases as the `min` /
`max` canonical columns:

| Canonical | Aliases |
|---|---|
| `min` | `min`, `minimum`, `min_value`, `range_min` |
| `max` | `max`, `maximum`, `max_value`, `range_max` |

Example happy-path CSV:

```csv
row_kind,parameter_id,data_type,default,unit,min,max
parameter,p_m01_speed,real,50,Hz,0,60
setpoint_binding,mot01,,,,,,
```

(The setpoint_binding row above is abbreviated; see Sprint 88L's
docs for the full column list.)

Example with default out of range — extraction emits a
`CSV_PARAMETER_DEFAULT_OUT_OF_RANGE` warning and PIR's R-PR-02
turns it into an error at build time:

```csv
row_kind,parameter_id,data_type,default,unit,min,max
parameter,p_m01_speed,real,200,Hz,0,60
```

Example with foreign unit — extraction succeeds, but PIR's
R-PR-03 (B) hard-fails on validate when the parameter is wired
to `speed_setpoint_out`:

```csv
row_kind,parameter_id,data_type,default,unit,min,max
parameter,p_m01_speed,real,1500,rpm,0,3000
```

## Structured XML (EPLAN / TcECAD)

Both attribute-style and child-element-style declarations are
recognised. Same alias set as CSV (`min` / `minimum` /
`minValue` / `min_value`; same for max).

EPLAN attribute-style:

```xml
<EplanProject>
  <Parameter id="p_m01_speed" dataType="real"
             default="50" unit="Hz" min="0" max="60" />
</EplanProject>
```

TcECAD child-element-style:

```xml
<TcecadProject>
  <Parameter>
    <Id>p_m01_speed</Id>
    <DataType>real</DataType>
    <Default>50</Default>
    <Unit>Hz</Unit>
    <Min>0</Min>
    <Max>60</Max>
  </Parameter>
</TcecadProject>
```

Numbers embedded in `<Description>` / `<Comment>` / `<Label>`
are explicitly **not** parsed. Sprint 97 only reads dedicated
`<Min>` / `<Max>` elements (and their alias forms).

## Backward compatibility

- Existing PIR fixtures without `min` / `max` / `unit` continue
  to validate cleanly. R-PR-03's first sub-rule only fires when
  bounds are actually present.
- Existing CSV / EPLAN / TcECAD legacy bundles without the new
  columns / attributes extract identically to Sprint 88L /
  88M.
- The Sprint 90A preview bundle, Sprint 91 diff bundle, Sprint
  92 imported-diff parser, Sprint 94 comparison view, Sprint
  95 comparison bundle, and Sprint 96 imported-comparison
  parser are all byte-identical.
- Vendor codegen renderers (`codegen-codesys` / `codegen-siemens`
  / `codegen-rockwell`) untouched.

## What R-PR-03 does NOT do

- **No unit conversion.** `rpm` is not auto-scaled to `Hz`.
  `0–100%` is not auto-mapped to `0–50Hz`. The operator either
  restates the parameter in `Hz` or supplies a custom mapping
  outside this v0 check.
- **No runtime clamps.** The generated code does not emit
  saturation, ramp, or limit-enforcement logic around the
  setpoint. R-PR-03 is validation only.
- **No safety semantics.** No drive-enable, no permissive
  logic, no e-stop, no fault latching, no jog. Sprint 97 stays
  well clear of safety-critical surface.
- **No PDF / OCR extraction.** PDF parameters remain a future
  sprint.
- **No web UI.** The web review surface already shows parameter
  candidate metadata; Sprint 97 deliberately did not redesign
  it.

## Manual verification checklist

1. Author a CSV with explicit bounds:

   ```csv
   row_kind,tag,kind,address,direction,data_type,role,parameter_id,default,unit,min,max,label
   parameter,,,,,real,,p_m01_speed,50,Hz,0,60,M01 speed
   setpoint_binding,mot01,,,,,speed_setpoint_out,p_m01_speed,,,,,
   ```

   Plus an `mot01` device row of kind `motor_vfd_simple`.

2. Run `ingestElectricalCsv` → confirm
   `graph.metadata.parameterDraft.parameters[0]` carries
   `min: 0`, `max: 60`, `unit: 'Hz'`.

3. Build the PirDraftCandidate, accept all, run
   `buildPirFromReviewedCandidate`. Confirm
   `result.pir.machines[0].parameters[0]` carries `min: 0`,
   `max: 60`, `unit: 'Hz'`.

4. `validatePirProject(result.pir)` returns no errors.

5. Run CODESYS / Siemens / Rockwell codegen. Confirm the
   generated setpoint assignment is byte-identical to the
   Sprint 88M baseline (no new clamps).

6. Set `default = 100` with `max = 60`. Re-build:
   - electrical-ingest emits `CSV_PARAMETER_DEFAULT_OUT_OF_RANGE`
     warning.
   - PIR validate emits `R-PR-02` error.

7. Set `unit = "rpm"` on a `speed_setpoint_out` parameter:
   - electrical-ingest still extracts cleanly.
   - PIR validate emits `R-PR-03` error with the message
     containing `"rpm"`.

8. Remove `min` and `max` columns entirely:
   - electrical-ingest extracts cleanly.
   - PIR validate passes (no R-PR-03 error).

9. Set `unit = ""` on a `speed_setpoint_out` parameter:
   - PIR validate emits `R-PR-03` info (not error). The PIR
     still builds.

10. Embed `min=10 max=80` in a CSV `comment` cell. Confirm the
    extracted candidate has `min: undefined`, `max: undefined`
    (no inference).

## Migration

Sprint 97 ships zero migration steps:

- All existing fixtures pass.
- All existing test suites pass.
- All existing bundle shapes byte-identical.
- The PIR schema's `.finite()` tightening rejects only NaN /
  Infinity values, which were never legal PIR content under
  R-PR-02 anyway.

If a downstream project is hand-authoring PIR JSON with
`Infinity` bounds, Sprint 97 will reject those at parse time
with a clear Zod error (`Number must be finite`). The fix is
to drop the bound and use `undefined`.

## Recommended next sprint

Three reasonable candidates:

1. **Pause-and-listen** — Sprint 97 is the first non-UI sprint
   in eight. Wait for operator fixtures and feedback before
   layering more.
2. **Sprint 98 — parameter UX polish.** Surface
   `min` / `max` / `unit` clearly on the review parameter
   cards. Pure web-only, helper-driven copy.
3. **Sprint 98 alt — recipe / parameter override guardrails.**
   If real fixtures show recipe values landing outside an
   explicit parameter range, R-PR-01's existing check is
   already on it; this sprint would add ingestion-side
   diagnostics that catch the divergence at write time.
