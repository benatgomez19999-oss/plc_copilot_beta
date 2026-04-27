# PlcCopilot.TiaAgent

MVP bridge between `@plccopilot/codegen-siemens` and TIA Portal V19 Openness.
Windows-only. .NET 8 / x64.

## Build

Requires TIA Portal V19 with Openness installed, **or** a local copy of
`Siemens.Engineering.dll` pointed at via MSBuild property / env var.

```powershell
# Using the default install path (V19):
dotnet build -c Release

# Or an explicit DLL:
dotnet build -c Release -p:TiaOpennessDll="D:\Siemens\...\Siemens.Engineering.dll"
```

Tests don't touch Openness and can run anywhere:

```powershell
dotnet test tests/PlcCopilot.TiaAgent.Tests
```

## Run

```powershell
plccopilot-tia-agent `
  --project   "C:\TIA\DemoProject.ap19" `
  --artifacts "C:\generated\siemens" `
  --out       "C:\generated\result.json"
```

Options:

| flag               | meaning                                                            |
|--------------------|--------------------------------------------------------------------|
| `--project`        | existing TIA V19 project (`.ap19`)                                 |
| `--artifacts`      | directory with SCL / CSV / manifest.json from the generator        |
| `--out`            | where to write `result.json`                                       |
| `--copy-csv-to`    | optional — copy CSV artifacts here for manual TIA tag import       |
| `--verbose`, `-v`  | verbose logging                                                    |

## Exit codes

- `0` compile succeeded with no errors
- `1` ran end-to-end but compile or import failed (see `result.json`)
- `2` CLI args invalid (see stderr)

## Prerequisites

- Windows 10/11 x64
- TIA Portal V19 with Openness feature enabled
- The calling user must be a member of the local group
  `Siemens TIA Openness`. Log out + in after adding.

## Known limits (MVP)

- SCL only (FBs / UDTs / DBs go through `ExternalSource.GenerateBlocksFromSource`).
- CSV tag import is **not** implemented — CSVs land in `skipped` with reason
  `csv_import_not_implemented`.
- `manifest.json` is informational only.
- Line numbers in compile issues are `null` — V19 Openness
  `CompilerResultMessage` does not expose source line directly.
