# PlcCopilot — Architecture

This document describes the compile pipeline, the IR contract, and the
boundary between the vendor-neutral compiler core and the backend
packages.

## End-to-end pipeline

```
┌──────────────┐
│ PIR project  │       (vendor-neutral schema; @plccopilot/pir)
│ (JSON / TS)  │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ @plccopilot/codegen-core                                             │
│                                                                      │
│   compileProject(project, options?)                                  │
│     ├── scope check (UNSUPPORTED_EQUIPMENT)                          │
│     ├── feature resolution (resolveFeatures)                         │
│     ├── per-station lowering                                         │
│     │     ├── lowerStation       (sequence + activities + interlocks)│
│     │     ├── lowerSequence      (CASE state OF …)                   │
│     │     ├── lowerStateActivity (cmd_extend := …)                   │
│     │     ├── lowerInterlocks    (override paths)                    │
│     │     ├── lowerOutputWiring  (downstream IO writes)              │
│     │     ├── lowerTimerBlock    (TON ticks)                         │
│     │     └── lowerEdgeTickBlock (R_TRIG / F_TRIG)                   │
│     ├── FB_Alarms (when useDbAlarms + emitFbAlarms)                  │
│     ├── buildEquipmentTypesIR    (UDT / DUT canonical)               │
│     ├── buildDb{Alarms,Params,Recipes}IR                             │
│     ├── buildTagTablesIR         (logical rows)                      │
│     ├── diagnostic aggregation   (sort + dedup)                      │
│     └── strict-mode error escalation                                 │
│                                                                      │
│   ◄── ProgramIR (vendor-neutral) ──►                                 │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────┐  ┌────────────────────────────┐  ┌────────────────────────────┐
│ @plccopilot/codegen-siemens│  │ @plccopilot/codegen-codesys│  │ @plccopilot/codegen-rockwell│
│                            │  │                            │  │                            │
│ renderProgramArtifacts(p)  │  │ renderProgramArtifacts     │  │ renderProgramArtifacts     │
│   • SCL renderer           │  │   Codesys(p)               │  │   Rockwell(p)              │
│   • DATA_BLOCK renderer    │  │   • IEC ST renderer        │  │   • Logix-flavoured ST     │
│   • UDT renderer           │  │   • DUT renderer           │  │   • One-shot edge bits     │
│   • CSV tag renderer       │  │   • GVL renderer           │  │   • Pseudo-IEC TON         │
│   • Manifest renderer      │  │   • Manifest renderer      │  │   • Tag list renderer      │
│   • SIEMENS_NAMESPACES (∅) │  │   • CODESYS_NAMESPACES     │  │   • ROCKWELL_NAMESPACES    │
└─────────────┬──────────────┘  └──────────────┬─────────────┘  └─────────────┬──────────────┘
              ▼                                 ▼                                ▼
        siemens/*.scl                     codesys/*.st                    rockwell/*.st
        siemens/*.csv                     codesys/manifest.json           rockwell/manifest.json
        siemens/manifest.json
```

## IR contract (`ProgramIR`)

Defined in `@plccopilot/codegen-core/compiler/program/program.ts`.

```ts
interface ProgramIR {
  projectId: string;            // PIR project.id
  projectName: string;          // PIR project.name
  pirVersion: string;           // PIR contract version
  target: ProgramTarget;        // {} in core; backends fill at render time
  blocks: FunctionBlockIR[];    // station FBs + FB_Alarms
  typeArtifacts: TypeArtifactIR[];   // canonical UDT_*
  dataBlocks: DataBlockArtifactIR[]; // DB_Alarms / DB_Global_Params / DB_Recipes
  tagTables: TagTableArtifactIR[];   // logical rows with structured PIR addresses
  manifest: ManifestIR;         // metadata-only; no path / generator / artifactPaths in core
  diagnostics: Diagnostic[];    // sorted (severity, code, station, path, symbol, message); deduped
  features: CompilerFeatures;   // resolved feature flags
}
```

### Why everything goes through `ProgramIR`

- **One source of truth.** Adding a backend never touches lowering, IR
  building, expressions, symbol resolution, or diagnostics. Those
  exercise the same code paths regardless of target.
- **Determinism is structural.** Sorting + deduplication happen once in
  `compileProject`. Backends can rely on stable order; their renderers
  are pure functions of the IR.
- **Diagnostics travel with the IR.** Backends inherit base diagnostics
  (`TIMEOUT_NO_AUTO_TRANSITION`, `ALARMS_AS_LOOSE_TAGS`, etc.) and may
  layer their own (`ROCKWELL_*`).

## Backend extension points

Each backend owns three things and three only:

1. **Naming** — output directory, file extensions, manifest path,
   `BackendNamespaceMap` (canonical IR DB name → backend alias). Lives in
   `<package>/src/naming.ts`.
2. **Renderers** — turn IR nodes into text. Statement / expression /
   variable / function-block / UDT / DB / tag list. Each calls
   `renderRef` / `renderSymbol` from core, passing its namespace map.
3. **Manifest + project façade** — assemble `GeneratedArtifact[]` and
   a JSON manifest. The facade is a thin wrapper around
   `compileProject` from core + the renderer pipeline.

Backends MUST NOT:

- import another backend
- mutate `ProgramIR`
- bypass `renderRef` / `renderSymbol` for cross-DB references (use the
  namespace map)
- emit non-deterministic output (rely on `Map` insertion order, etc.)

## Diagnostics

Defined in `@plccopilot/codegen-core/compiler/diagnostics.ts`. Each
diagnostic has:

```ts
{ code, severity, message, path?, stationId?, symbol?, hint?, span? }
```

Severity escalates: `info` → `warning` → `error`. An `error` thrown
during station lowering aborts the compile via `CodegenError`. With
`features.strictDiagnostics: true`, post-station errors also abort.

Backend-specific diagnostic codes (`ROCKWELL_EXPERIMENTAL_BACKEND`,
`ROCKWELL_TIMER_PSEUDO_IEC`, `ROCKWELL_NO_L5X_EXPORT`) are added in the
backend's artifact renderer (see
`packages/codegen-rockwell/src/renderers/artifacts-rockwell.ts`) and
merged into `program.diagnostics` via `withRockwellDiagnostics`.

## Determinism

Every emission is sorted and deduplicated:

- Equipment types: alphabetical by canonical name.
- Diagnostics: severity → code → stationId → path → symbol → message.
- DB fields: insertion order, but the underlying iteration is sorted.
- Tag rows: sorted by id within each section.
- Alarm `set_` / `active_` pairs: alphabetical by alarm id.

`generateBackendProject(project, opts)` called twice with identical
input produces byte-identical output. Verified in
`packages/codegen-integration-tests/tests/backend-equivalence.spec.ts`.

## Integration tests

`@plccopilot/codegen-integration-tests` is a tests-only package. It
depends on PIR + the four codegen packages and asserts:

- **Equivalence** — the three backends emit the same number of station
  FBs, the same alarm sets, the same equipment UDTs from the same
  fixture.
- **Determinism** — every backend's two-run output is byte-identical
  (run interleaved to flush singleton leaks).
- **Cross-backend leakage** — Codesys output never contains
  `"DB_Alarms"` / `S7_Optimized_Access` / Rockwell namespace prefixes;
  Rockwell output never contains GVL_* / Siemens-quoted PLC tags.

## Source-level leakage enforcement

`packages/codegen-core/tests/no-backend-leakage.spec.ts` scans every
`.ts` file under `codegen-core/src/` (after stripping comments) for:

- backend filesystem prefixes (`siemens/`, `codesys/`, `rockwell/`)
- backend file extensions (`.scl`, `.st`)
- backend namespace literals (`GVL_Alarms`, `Alarms.set_`,
  `Alarms` / `Parameters` / `Recipes` aliases)
- vendor keywords (`S7_Optimized_Access`, `Studio 5000`, `ROUTINE`,
  `FUNCTION_BLOCK "<name>"`, `"DB_Alarms".`)

The bare BackendId values (`'siemens'`, `'codesys'`, `'rockwell'`) are
intentionally allowed — they are part of the BackendId union literals
in `compiler/backend.ts` and the only legitimate place they appear.

## Versioning

- `@plccopilot/pir` is the only public API contract; bump the major
  version on any breaking change to the PIR schema.
- `@plccopilot/codegen-core` 0.x is the active surface. 1.0 will drop
  the `siemensTypeName` deprecated alias.
- `@plccopilot/codegen-siemens` 0.x re-exports Codesys / Rockwell
  symbols as `@deprecated`. 1.0 will remove them; consumers must import
  from the dedicated backend packages by then.
