# PlcCopilot

**PlcCopilot** is a TypeScript monorepo that compiles a vendor-neutral
project description (PIR — *Project Intermediate Representation*) into
PLC artifacts for multiple industrial backends (Siemens TIA, Codesys IEC
61131-3, Rockwell Studio 5000).

The compiler core is fully decoupled from any single backend. New backends
plug in by consuming the same `ProgramIR` and contributing a renderer +
namespace map.

## Architecture

```
PIR (project description)
  │
  ▼
@plccopilot/codegen-core
  compileProject(project, options?) ──► ProgramIR
  │                                     • blocks            (FunctionBlockIR)
  │                                     • typeArtifacts     (UDT IR)
  │                                     • dataBlocks        (DB IR — alarms / params / recipes)
  │                                     • tagTables         (logical rows; backends format)
  │                                     • diagnostics       (sorted, deduped)
  │                                     • features          (resolved flags)
  │                                     • manifest          (neutral metadata)
  ▼
@plccopilot/codegen-<backend>
  renderProgramArtifacts<Backend>(program) ──► GeneratedArtifact[]
                                              (.scl / .st / .csv / manifest.json)
```

### Packages

| Package | Role | Status |
|---|---|---|
| `@plccopilot/pir` | Vendor-neutral project schema (frozen v0.1) | stable |
| `@plccopilot/codegen-core` | Compiler pipeline: IR, lowering, expressions, symbols, diagnostics, `compileProject`, `serializeProgramIR` | stable |
| `@plccopilot/codegen-siemens` | Siemens TIA SCL backend (`.scl` / `.csv` / `manifest.json`) | **production** |
| `@plccopilot/codegen-codesys` | Codesys IEC 61131-3 ST backend (`.st` text only) | **experimental POC** |
| `@plccopilot/codegen-rockwell` | Rockwell Studio 5000 ST backend (one-shot bits, pseudo-IEC TON) | **experimental POC** |
| `@plccopilot/codegen-integration-tests` | Cross-backend equivalence + leakage tests | internal |
| `@plccopilot/cli` | `plccopilot` binary — generate / validate / inspect | MVP |
| `@plccopilot/web` | Local browser-only React app for inspecting PIR + artifacts | MVP |

The core is enforced backend-neutral by `codegen-core/tests/no-backend-leakage.spec.ts`
— any backend-specific filesystem prefix, namespace literal, or vendor
keyword in `codegen-core/src/` fails the suite.

## Installation

Requires **Node ≥ 20** and **pnpm ≥ 8** (Node 22 in CI). Install from repo root:

```sh
pnpm install
```

## Commands

| Command | Effect |
|---|---|
| `pnpm typecheck` | Run `tsc --noEmit` in every package |
| `pnpm test` | Run `vitest run` in every package |
| `pnpm cli:build` | Compile the CLI to `packages/cli/dist/` |
| `pnpm schemas:check` | Build the CLI then verify `packages/cli/schemas` is in sync |
| `pnpm cli:smoke` | Build the CLI then exercise the compiled `dist/index.js` (help, schema, error envelope, inspect) |
| `pnpm cli:pack-smoke` | Build the CLI then validate `npm pack --dry-run` contents and `package.json` metadata |
| `pnpm cli:tarball-smoke` | Build the CLI, produce a real `.tgz`, extract it, and run the extracted bin (requires system `tar`) |
| `pnpm build:packages-base` | Compile `@plccopilot/pir` + `@plccopilot/codegen-core` to `dist/index.js` + `dist/index.d.ts` |
| `pnpm base:dist-smoke` | Validate the base packages' dist artefacts (no source leakage; runtime API loads under Node) |
| `pnpm build:packages-vendor` | Compile `codegen-codesys` + `codegen-rockwell` + `codegen-siemens` (in topological order) |
| `pnpm vendor:dist-smoke` | Validate each vendor backend's dist artefact + run its `generate*Project` façade against the weldline fixture |
| `pnpm consumer:install-smoke` | Pack all 6 publish candidates, `npm install` them in a fresh temp project outside the workspace, run the installed bin (requires system `tar` + `npm`) |
| `pnpm release:check` | Validate every publish candidate's name / version / dist exports / explicit dep ranges / `.npmrc` |
| `pnpm release:plan` | Print a Markdown release plan (`--bump patch\|minor\|major`, `--version X.Y.Z`, `--json`, `--out FILE`, `--write` to apply) |
| `pnpm release:pack-dry-run` | `release:check` + `npm pack --dry-run --json` for every candidate |
| `pnpm release:publish-dry-run` | `release:check` + `npm publish --dry-run --json` for every candidate (hardcoded `--dry-run`; never publishes) |
| `pnpm release:notes` | Generate a deterministic Markdown release-notes scaffold (`--bump`, `--version`, `--json`, `--out`) |
| `pnpm release:pack-artifacts --out <dir>` | Pack all 6 candidates to `<dir>` + write `<dir>/manifest.json` (CI uploads as `plccopilot-release-tarballs`) |
| `pnpm release:publish-real --validate-only --version X.Y.Z --tag <tag>` | Validate publish inputs without contacting the registry (no token, no confirm). Used by the manual publish workflow's preflight |
| `pnpm release:registry-smoke [--version X.Y.Z] [--registry URL]` | _(Sprint 64, manual)_ `npm install @plccopilot/cli@<version>` from a real registry into a fresh temp project, then run the installed bin end-to-end. **Not in `pnpm run ci`** — it 404s before the first publish |
| `pnpm release:npm-view [--version X.Y.Z] [--tag <next\|latest\|beta>] [--registry URL] [--json]` | _(Sprint 65, manual)_ `npm view` every release candidate, validate name / version / dist.tarball / dist.integrity, optionally check that a dist-tag resolves to the same version. Not in `pnpm run ci` |
| `pnpm release:provenance [--version X.Y.Z] [--json]` | _(Sprint 65)_ Local-only stub that confirms the publish workflow grants `id-token: write` + references `--provenance`, and that the publish command builder still hardcodes `--provenance` for every supported tag. Does not contact the registry; safe for `ci:contracts`-style invocation but kept manual today |
| `pnpm release:promote-latest --validate-only --version X.Y.Z` | _(Sprint 68)_ Local-only validation for the dist-tag promote runner. No token, no confirm, no registry contact. Mirrors the workflow's preflight job |
| `pnpm release:promote-latest --version X.Y.Z --confirm "promote @plccopilot X.Y.Z to latest"` | _(Sprint 68)_ Real mode — moves the `latest` dist-tag to the version that's already on `next`. Requires `NODE_AUTH_TOKEN`; never publishes a tarball; idempotent (skips packages whose `latest` already matches). **Only invoked by the GitHub Actions workflow.** |
| `pnpm release:github --validate-only --version X.Y.Z [--tag vX.Y.Z]` | _(Sprint 69)_ Local-only validation for the GitHub Release runner. Asserts the workspace, the tag (`v<version>`), and `docs/releases/<version>.md` are in the post-promotion shape. No token, no confirm, no network |
| `pnpm release:github --version X.Y.Z [--tag vX.Y.Z] --confirm "create GitHub release vX.Y.Z"` | _(Sprint 69)_ Real mode — shells out to `gh release create v<version>` with the canonical argv (six tarballs + manifest.json, `--title "PLC Copilot v<version>"`, `--notes-file docs/releases/<version>.md`). Never mutates npm — `assertNoNpmMutationSurface` rejects publish/dist-tag/npm tokens. **Only invoked by the GitHub Actions workflow.** |
| `pnpm publish:audit` | Regenerate `docs/publishability-audit.md` from every `packages/*/package.json` (`--check` / `--json` / `--out` also supported) |
| `pnpm run ci:contracts` | Base build + base smoke + vendor build + vendor smoke + CLI build + schema check + CLI smokes + consumer install smoke + release check + release pack dry-run + audit `--check` (the contract gate) |
| `pnpm run ci` | `ci:contracts` + typecheck + test (what GitHub Actions runs) |
| `pnpm --filter @plccopilot/codegen-siemens test` | Test a single package |

> Use `pnpm run ci` (not `pnpm ci`) — pnpm reserves the bare `ci` verb for an
> npm-compatible install command that is currently unimplemented.

> **`@plccopilot/*` 0.1.0 is on npm under both `next` and `latest`.**
> Sprint 67 published the six packages under `next`; Sprint 68
> closeout promoted the same artefacts to `latest` after the human
> inspection period passed. `npm install @plccopilot/cli` (no tag,
> resolves `latest`) installs `0.1.0`. See
> [`docs/releases/0.1.0.md`](docs/releases/0.1.0.md) for the release
> notes and [`docs/first-publish-postmortem.md`](docs/first-publish-postmortem.md)
> for the publish + promotion run record. The runbook at
> [`docs/first-publish-checklist.md`](docs/first-publish-checklist.md)
> is preserved verbatim for the next coordinated release.
>
> **GitHub Release status: pending.** Sprint 69 landed the tooling
> (`pnpm release:github`,
> [`.github/workflows/create-github-release.yml`](.github/workflows/create-github-release.yml),
> tests) but the operator dispatch that creates the `v0.1.0` tag +
> Release page on github.com has not yet been run. npm-side state
> is unaffected.

### Contract and CLI smoke checks (sprints 53–65)

Eleven gates run before `typecheck` / `test` in CI. Sprint 63 added the
manual publish workflow; sprint 64 added the registry-install smoke;
**sprint 65 layers the post-publish audit pack** on top: a
`pnpm release:npm-view` runner that asserts every release candidate's
`npm view` payload (name, version, `dist.tarball`, `dist.integrity`,
optional dist-tag), and a `pnpm release:provenance` *stub* that
verifies the publish workflow is configured for OIDC provenance —
locally, without contacting the registry. The
[`post-publish-verify.yml`](.github/workflows/post-publish-verify.yml)
workflow now runs all three checks in order: `provenance` (local) →
`npm-view` → `registry-smoke`. **None of the registry-dependent
commands are part of `pnpm run ci`** — they 404 until the first real
publish. The first-publish runbook lives at
[`docs/first-publish-checklist.md`](docs/first-publish-checklist.md). Sprint 60 closed the
publishability loop (no `private`, no `workspace:*`, dist-pointing
exports, real consumer install smoke from `os.tmpdir()`); sprint 61 added
the cross-package release planner + pack dry-run; sprint 62 added
`release:publish-dry-run` (hardcoded `--dry-run`), the deterministic
release-notes scaffold, and the `plccopilot-release-tarballs` CI artifact
(14-day retention). **Sprint 63 layers the actual publish path** behind
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) — a
manual `workflow_dispatch` workflow with `dry_run` defaulting to true, a
preflight job that re-runs the full contract gate, and a separate
`publish` job gated by `inputs.dry_run == false`, the protected
`npm-publish` environment, an exact confirmation string, and
`secrets.NPM_TOKEN`. Real publish always emits
`npm publish --provenance --access public --tag <tag>` via
`pnpm release:publish-real`. The workflow is the **only** codepath that
can land a real publish; nothing in regular CI publishes.

Workspace dev/typecheck/test flows still resolve `@plccopilot/*` to
source via `tsconfig.paths` and `vitest.config.ts` aliases — package
`exports` and `dependencies` only govern published runtime / external
consumers. Full release flow in [`docs/release-process.md`](docs/release-process.md);
generated release notes live under [`docs/releases/`](docs/releases/).

Workspace dev/typecheck/test flows still resolve `@plccopilot/*` to source
via `tsconfig.paths` and `vitest.config.ts` aliases — package `exports`
and `dependencies` only govern published runtime / external consumers.

1. **Schema sync** — `node packages/cli/dist/index.js schema --check packages/cli/schemas`
   fails if the static `*.schema.json` files drift from the generators in
   `packages/cli/src/json-schema.ts`. Regenerate with `pnpm cli schema --out packages/cli/schemas`.
2. **CLI dist smoke** — `node packages/cli/scripts/smoke-cli-dist.mjs` spawns
   the compiled bin on a clean Node process and asserts `help`, `schema --name`,
   `schema --check`, the `--json` error envelope, and `inspect --json` against
   the weldline fixture. The script is dependency-free (Node built-ins only)
   and exits 1 with a clear message if `dist/index.js` is missing.
3. **CLI pack smoke** (sprint 54) — `node packages/cli/scripts/smoke-cli-pack.mjs`
   runs `npm pack --dry-run --json` against `packages/cli` and validates the
   manifest:
   - **Required entries** present: `package.json`, `dist/index.js`, the four
     `schemas/*.schema.json`.
   - **Forbidden entries** absent: `src/`, `tests/`, `scripts/`, `node_modules/`,
     `.tsbuildinfo`, `tsconfig*.json`, `vitest.config.ts`.
   - **Exact schema set** — fails if a rogue `schemas/*.schema.json` shows up.
   - **`package.json` metadata** — `name`, `bin.plccopilot`, `files`, and the
     four schema subpath `exports`.
   - Emits a non-fatal warning if `exports["."]` points at source TS (the
     workspace ships source-as-API; published consumers should use the bin or
     schema subpaths).
4. **CLI tarball smoke** (sprint 55) — `node packages/cli/scripts/smoke-cli-tarball.mjs`
   produces a real `.tgz` (`npm pack --json --pack-destination …`), extracts
   it with system `tar`, and validates:
   - The extracted manifest matches gate 3's contract (required, forbidden,
     exact schema set, metadata) on actual extracted files.
   - The extracted `schemas/*.schema.json` are **byte-equal** to the
     committed snapshots.
   - The extracted bin runs four commands from a fresh cwd: `help`,
     `schema --name cli-result`, `schema --check <extracted schemas dir>`,
     and `totally-unknown --json`. Each one's exit code, stdout shape, and
     empty stderr are asserted.
   - **Requires `tar` on PATH.** Every `ubuntu-latest` runner has it; on
     Windows 10+ it ships as `tar.exe`. The smoke fails loudly if it's
     missing.
   - Set `PLC_COPILOT_KEEP_TARBALL_SMOKE=1` to keep the temp dir
     (`packages/cli/.tarball-smoke-tmp/`) for debugging instead of letting
     the script clean it up.

> The tarball smoke extracts under `packages/cli/.tarball-smoke-tmp/` rather
> than `os.tmpdir()` because the CLI's runtime imports the workspace
> codegen / pir packages, which today ship TS source. Node 24 refuses to
> type-strip files under `node_modules/`, so the extracted bin needs to
> resolve those deps via the workspace's existing symlinks. A future
> "consumer install smoke" sprint will exercise a real `npm install <tgz>`
> against compiled deps.
5. **Base package dist smoke** (sprint 57) — `pnpm build:packages-base`
   then `node packages/cli/scripts/smoke-base-dist.mjs`. Compiles
   `@plccopilot/pir` + `@plccopilot/codegen-core` via `tsc -p tsconfig.build.json`
   and asserts:
   - `dist/index.js` AND `dist/index.d.ts` exist for both packages.
   - `dist/` does not contain `tests/`, `src/`, `fixtures/`, `*.spec.js`,
     or `.tsbuildinfo` files.
   - Emitted `.js` files do **not** reference `../pir/src` or
     `packages/pir/src` — cross-package imports stay as bare
     `@plccopilot/*` specifiers (sourcemaps are excluded from this scan
     since they legitimately point back to source).
   - Each package dynamically imports under Node and exposes its
     known runtime surface (`ProjectSchema`, `validate`, `tokenize`,
     `analyzeExpression`, `parseEquipmentRoleRef` for pir;
     `stableJson`, `CodegenError`, `serializeCompilerError`,
     `formatSerializedCompilerError`, `compileProject` for codegen-core).
   - A functional check parses the weldline fixture with
     `pir.ProjectSchema` and round-trips a `CodegenError` through
     `serializeCompilerError` + `formatSerializedCompilerError`.

   This is the first gate that exercises base-package publish artefacts
   end-to-end. The vendor codegen packages (sprint 58) and the
   `exports` flip (sprint 59) extend the chain.

6. **Vendor package dist smoke** (sprint 58) — `pnpm build:packages-vendor`
   then `node packages/cli/scripts/smoke-vendor-dist.mjs`. Compiles
   `@plccopilot/codegen-codesys`, `@plccopilot/codegen-rockwell`, and
   `@plccopilot/codegen-siemens` (in topological order — siemens
   re-exports from codesys + rockwell, so those build first), then asserts:
   - Every vendor emitted `dist/index.js` + `dist/index.d.ts`.
   - Each `dist/` is junk-free (no `tests/`, `src/`, `fixtures/`,
     `*.spec.js`, `.tsbuildinfo`).
   - Emitted `.js` keeps cross-package imports as bare `@plccopilot/*`
     specifiers — no `../pir/src` or `../codegen-core/src` paths leak in.
   - Each façade — `generateCodesysProject`, `generateRockwellProject`,
     `generateSiemensProject` — dynamically imports under Node and is
     callable with `(project, opts)`.
   - A functional pass parses the weldline fixture with
     `pir.ProjectSchema` and runs each façade with
     `{ manifest: { generatedAt: '2026-01-01T00:00:00.000Z' } }`,
     verifying the result is a non-empty `GeneratedArtifact[]` containing
     at least one path under the expected backend prefix
     (`codesys/`, `rockwell/`, `siemens/`).

7. **Consumer install smoke** (sprint 60) — `node packages/cli/scripts/smoke-consumer-install.mjs`
   is the canonical "would-this-actually-publish" gate:
   - Pre-flight: every publish candidate's source `package.json` must have
     dist, no `private: true`, no `workspace:*` runtime range, and the
     dist-pointing exports/types from sprint 59.
   - Packs all six candidates with `npm pack --json --pack-destination`
     into a temp dir at `os.tmpdir()/plccopilot-consumer-install-*/tarballs`.
   - Extracts each tarball and re-runs the same manifest checks against
     the post-pack `package.json` — `npm pack` does not rewrite `workspace:*`
     or strip `private`, so this catches regressions immediately.
   - Creates a brand-new consumer project, `npm install --ignore-scripts <all six tarballs>`
     (topological order so each `0.1.0` range resolves to a sibling local
     tarball without ever consulting a registry).
   - Runs the installed bin via `node_modules/.bin/plccopilot`:
     `help`, `schema --name cli-result`, `schema --check <installed schemas>`,
     `totally-unknown --json`, `inspect --json`, `validate --json`, and
     `generate --backend siemens --json` against a copied weldline fixture.
   - Cleans up the temp tree on exit. Set
     `PLC_COPILOT_KEEP_CONSUMER_SMOKE=1` to keep it for debugging — the
     path is printed.

8. **Release metadata check + pack dry-run** (sprint 61) — `pnpm release:check`
   followed by `pnpm release:pack-dry-run`:
   - The check step validates every publish candidate (`pir`,
     `codegen-core`, `codegen-codesys`, `codegen-rockwell`,
     `codegen-siemens`, `cli`) against the release contract: explicit
     publish list, expected names, no `private: true`, strict
     `MAJOR.MINOR.PATCH` versions, **shared** version across candidates,
     `main` / `types` / `exports["."]` pointing at dist, `files` includes
     `dist` (and `schemas` for the CLI), CLI bin + schema subpaths, no
     `workspace:*` runtime ranges, every internal dep range matching the
     shared version, and `.npmrc` keeping
     `link-workspace-packages=true`.
   - The pack-dry-run step reuses the same expected-entries contract on
     each candidate's `npm pack --dry-run --json` manifest, so the
     release-tooling perspective (whole release set) catches drift the
     CLI-only pack/tarball smokes can't see.
   - Use `pnpm release:plan` (Markdown) or `pnpm release:plan --json` to
     prepare the next bump; `--write` applies it in place. See
     [`docs/release-process.md`](docs/release-process.md).

9. **Publishability audit** (sprint 56) — `node packages/cli/scripts/publish-audit.mjs --check`
   regenerates the audit in memory and fails if the committed
   `docs/publishability-audit.md` is stale. The audit walks every
   `packages/*/package.json`, classifies each as **publishable**,
   **internal**, or **app**, and emits findings (blockers / warnings /
   infos) such as `private: true` on a publish candidate, runtime
   `workspace:*` deps, missing `tsconfig.build.json`, missing dist or
   types files, schema exports without `schemas` in `files`, etc.
   - **CI does not require zero blockers.** It only requires that the
     committed report mirrors current workspace state. Any change to a
     `package.json`, `tsconfig.build.json`, build script, or new
     package directory must ship with a regenerated audit (`pnpm publish:audit`).
   - **`pnpm publish:audit --json`** prints a JSON report (timestamped,
     stable key ordering) for agents and CI consumers; `--out <path.md>`
     writes the markdown to a custom path.
   - The audit also computes a topological build order across
     publishable candidates so future "compile internal packages"
     sprints have a clear sequence.

All eleven gates run from the repo root via `pnpm run ci:contracts`. CI
uses Node 24 so the compiled bin can load workspace `src/index.ts`
modules through Node's built-in TypeScript stripping. The consumer
install smoke does **not** need TS stripping — it runs entirely against
compiled dist that was delivered through real `npm install <tgz>`. The
release tooling is **plan-only / dry-run-only**: even
`release:publish-dry-run` hardcodes `--dry-run` so no codepath can land
a real publish.

## Imports — preferred

```ts
// Pure pipeline (any backend or tooling)
import {
  compileProject,
  serializeProgramIR,
  type ProgramIR,
  type CompilerFeatures,
  type Diagnostic,
} from '@plccopilot/codegen-core';

// Siemens backend
import { generateSiemensProject } from '@plccopilot/codegen-siemens';

// Codesys backend (experimental)
import { generateCodesysProject } from '@plccopilot/codegen-codesys';

// Rockwell backend (experimental)
import { generateRockwellProject } from '@plccopilot/codegen-rockwell';
```

## Imports — deprecated (still working for legacy consumers)

```ts
// ⚠ These re-exports from `@plccopilot/codegen-siemens` are @deprecated.
//   They will continue to resolve in 0.x but emit IDE warnings. Migrate
//   to the dedicated backend packages above.

import {
  generateCodesysProject,                // → @plccopilot/codegen-codesys
  generateRockwellProject,               // → @plccopilot/codegen-rockwell
  renderFunctionBlockCodesys,            // → @plccopilot/codegen-codesys
  siemensTypeName,                       // → @plccopilot/codegen-core (canonicalTypeName)
  // …
} from '@plccopilot/codegen-siemens';
```

## Backend status

- **Siemens** — production backend. Emits TIA-compatible SCL with
  `S7_Optimized_Access`, DATA_BLOCK / TYPE / FUNCTION_BLOCK, CSV tag
  table, manifest.json. Exhaustive test coverage in
  `packages/codegen-siemens/tests/`.
- **Codesys** — experimental POC. Emits plausible IEC 61131-3 ST
  (FUNCTION_BLOCK, GVL_*, DUT_*) as `.st` text files. **Not** a packaged
  Codesys project; the engineer imports manually.
- **Rockwell** — experimental POC. Emits Logix-flavoured ST with
  one-shot bit edge detection and pseudo-IEC TON. **Not** an L5X
  archive; flagged by `ROCKWELL_NO_L5X_EXPORT` /
  `ROCKWELL_TIMER_PSEUDO_IEC` diagnostics.

## CLI — `plccopilot`

A local command-line wrapper around the codegen packages. Compile a PIR
JSON to disk in one shot.

### Build the binary

```sh
pnpm cli:build       # compiles packages/cli/dist/index.js
```

After building you can invoke it via Node directly:

```sh
node packages/cli/dist/index.js <command> [options]

# or via the workspace script:
pnpm cli <command> [options]
```

(`pnpm publish`-time the `bin` mapping registers `plccopilot` on `PATH`;
during local development just call `node ... dist/index.js`.)

### `generate`

```sh
plccopilot generate \
  --input ./pir.json \
  --backend siemens \
  --out ./generated
```

Flags:
- `--input <path>` (required) — PIR JSON file
- `--backend <name>` (required) — `siemens` | `codesys` | `rockwell` | `all`
- `--out <dir>` (required) — output directory; created if missing
- `--generated-at <iso>` (optional) — manifest timestamp; useful for
  reproducible builds

`--backend all` runs the three backends sequentially and writes them to
their canonical subdirectories (`siemens/`, `codesys/`, `rockwell/`)
inside `--out`. A single `summary.json` is written at `--out`.

Exit codes:
- `0` — artifacts written, no error diagnostics
- `1` — file / JSON / schema / codegen / write error
- `2` — generation succeeded but artifacts carry `severity=error` diagnostics

Example output:

```
Generated 9 artifacts for backend siemens
Output: /home/me/proj/generated
Diagnostics: 2 info, 1 warning, 0 errors
```

### `validate`

```sh
plccopilot validate --input ./pir.json
```

Runs `ProjectSchema.parse` followed by `validate(project)` from
`@plccopilot/pir`. Prints each issue and a summary line.

Exit codes:
- `0` — schema OK and `validate(project).ok === true`
- `1` — file / JSON / schema parse error
- `2` — validation report contains at least one `severity=error` issue

### `inspect`

```sh
plccopilot inspect --input ./pir.json
```

Prints a quick summary: project id/name, PIR version, machine count,
per-machine equipment / IO / parameters / recipes / alarms counts, and
each station's state + transition counts.

Exit codes:
- `0` — printed
- `1` — file / JSON / schema parse error

### Machine-readable output (`--json`, `--debug`)

Sprint 45 added two global flags consumed by every command for CI / agent /
orchestrator workflows.

- `--json` — Emit a single deterministic JSON payload on stdout. The
  payload is serialised via `stableJson` from `@plccopilot/codegen-core`,
  so byte order is stable across runs (suitable for diffing in CI).
  When `--json` is set the CLI never mixes human prints with JSON; stderr
  stays empty in expected paths.
- `--debug` — Include `error.stack` in serialised errors. Has no effect
  on success payloads. Without `--debug` the CLI never prints stack
  traces (default UX).

Errors are emitted using the `SerializedCompilerError` wire shape from
`@plccopilot/codegen-core` (`code`, `path`, `stationId`, `symbol`, `hint`,
optional `cause`, optional `stack` only with `--debug`). Identical shape
to the one the web worker sends to the App banner — every consumer can
share the same parser.

Examples:

```sh
# generate JSON-mode (success)
pnpm cli generate -- \
  --input ./pir.json \
  --backend siemens \
  --out ./generated \
  --json

# validate JSON-mode (deterministic CI output)
pnpm cli validate -- --input ./pir.json --json

# inspect JSON-mode (project metadata only)
pnpm cli inspect -- --input ./pir.json --json

# debug a failing generation (stack appended)
pnpm cli generate -- \
  --input ./bad-pir.json \
  --backend siemens \
  --out ./out \
  --json --debug
```

Example success payload (`generate --backend siemens --json`):

```json
{
  "ok": true,
  "command": "generate",
  "generated_at": "2026-04-26T10:15:30.000Z",
  "backend": "siemens",
  "out_dir": "/abs/path/out",
  "artifact_count": 9,
  "written_files": ["/abs/path/out/siemens/FB_StLoad.scl", "..."],
  "diagnostics": { "errors": 0, "warnings": 1, "info": 2 },
  "summary_path": "/abs/path/out/summary.json"
}
```

Example error payload (`UNKNOWN_PARAMETER`, no `--debug`):

```json
{
  "ok": false,
  "command": "generate",
  "generated_at": "2026-04-26T10:15:30.000Z",
  "error": {
    "name": "CodegenError",
    "code": "UNKNOWN_PARAMETER",
    "message": "Recipe \"r_default\" references unknown parameter \"p_ghost_param\".",
    "path": "machines[0].recipes[0].values.p_ghost_param",
    "symbol": "p_ghost_param",
    "hint": "Define the parameter in machine.parameters or remove it from the recipe."
  }
}
```

With `--debug` the same payload includes a `stack` field on `error`.

Exit codes are unchanged across human and JSON mode: `0` on success,
`1` on hard error (file / JSON / schema / codegen / write), `2` on
diagnostic-error or validation-error reports.

### JSON Schemas (`schema` subcommand)

Sprint 46 publishes JSON Schemas (draft 2020-12) for every CLI JSON
payload. CI / agents that already run a JSON Schema validator (Ajv,
ajv-cli, kube-validator, ...) can fetch the contract on demand and
hard-pin every `--json` output they consume.

```sh
# Print the umbrella schema for every --json result (default).
pnpm cli schema
pnpm cli schema --name cli-result

# Print only the SerializedCompilerError envelope schema.
pnpm cli schema --name serialized-compiler-error

# Sprint 50 — write schema(s) to disk instead of stdout.
pnpm cli schema --out ./schemas
pnpm cli schema --name generate-summary --out ./schemas
```

When `--out <dir>` is set, the `schema` subcommand:
- creates the directory recursively if missing,
- writes one or many `*.schema.json` files (every published schema if
  `--name` is omitted, only the matching one otherwise),
- emits a single human stdout line (`Wrote N schema files to <abs-dir>`
  or `Wrote schema file to <abs-path>`),
- exits 0 on success, 1 on unknown `--name` or when `--out` points at
  an existing non-directory.

The written files are byte-identical to `stableJson(SCHEMA_CONST)`,
so they replace the version-controlled snapshots one-for-one. To
regenerate the in-repo schemas after changing the TypeScript
constants — portably across Windows / Unix without shell redirect:

```sh
pnpm cli schema --out packages/cli/schemas
```

The CLI test suite (`packages/cli/tests/schema-out.spec.ts`) cross-checks
that every schema written via `--out` matches both the constant in
`json-schema.ts` AND the version-controlled file on disk, so any
drift between the three surfaces fails CI loudly.

#### Sync guard (`schema --check <dir>`, sprint 52)

Read-only verification — never writes. Useful as a pre-push hook
or CI step that fails before tests if schemas drifted:

```sh
# CI guard
pnpm cli schema --check packages/cli/schemas

# selective: only verify one schema in a directory
pnpm cli schema --name web-zip-summary --check packages/cli/schemas
```

Behaviour:
- exit `0` when every expected schema file is present AND
  byte-identical to `stableJson(SCHEMA_CONST)`.
- exit `1` when any of:
  - **missing** — an expected schema file is absent
  - **changed** — a present file differs from the canonical bytes
  - **unexpected** — an extra file lives in the directory
- mutually exclusive with `--out` (running both at once is a CLI
  usage error: exit 1 with `error: --out and --check cannot be used
  together`).
- `--name X --check <dir>` verifies only that one schema and
  ignores other files in the directory — handy when checking a
  directory that mixes published schemas with project-specific ones.

Output sample on drift:
```
error: schema check failed for /abs/path/schemas
- missing: web-zip-summary.schema.json
- changed: cli-result.schema.json
- unexpected: old.schema.json
```

Recommended CI snippet (regenerate-then-verify is also a one-liner):

```sh
pnpm cli schema --check packages/cli/schemas
pnpm -r test
```

Notes:
- The `schema` subcommand always prints a **JSON Schema**, never a
  `CliJsonResult`. Don't pipe it through the same parser you use for
  `generate --json` outputs.
- `generate --json`, `validate --json`, `inspect --json` outputs are
  guaranteed to validate against `cli-result` (which uses `oneOf` to
  cover the four payload shapes: generate success, validate result,
  inspect success, error envelope).
- All error envelopes (in any command + the dispatcher's "unknown
  command" path) use the same `SerializedCompilerError` shape — also
  exposed standalone via `--name serialized-compiler-error`.
- `--debug` may add `error.stack`; the schema marks it optional, so
  validation passes whether stack is present or not.
- The schema is versioned via the exported `CLI_JSON_SCHEMA_VERSION`
  constant (currently `1`). Non-additive changes to any payload shape
  bump this value.

#### Contract validation (sprint 47)

The CLI test suite includes a contract pin: every real `--json`
payload (`generate`, `validate`, `inspect`, error envelopes for
both per-command failures and the dispatcher's "unknown command"
path) is fed through a minimal JSON-Schema validator and asserted
to satisfy `cli-result`. The validator (`packages/cli/tests/schema-validator.ts`)
is intentionally scoped to the JSON-Schema subset our published
schemas use — it is not a general-purpose validator and is not
exported as a public API.

External consumers should run the published schemas through a
standards-compliant validator such as Ajv:

```sh
pnpm cli generate \
  --input packages/pir/src/fixtures/weldline.json \
  --backend siemens --out /tmp/plc --json \
  | ajv validate -s ./cli-result.schema.json -d -
```

Where `./cli-result.schema.json` is the output of
`pnpm cli schema --name cli-result`.

#### Static schema files (sprint 48)

The schemas are also materialised as version-controlled files inside
the published `@plccopilot/cli` package, so consumers don't need to
spawn the CLI binary just to fetch the contract:

```
packages/cli/schemas/cli-result.schema.json
packages/cli/schemas/serialized-compiler-error.schema.json
```

Generate them on demand from the runtime source:

```sh
pnpm cli schema --name cli-result > cli-result.schema.json
pnpm cli schema --name serialized-compiler-error > serialized-compiler-error.schema.json
```

After publishing the package, consumers import the files via package
subpath exports:

```js
// Node ESM consumer
import schema from '@plccopilot/cli/schemas/cli-result.schema.json' with { type: 'json' };
```

The CLI's `package.json` lists the `schemas/` directory under `files`
and exposes both schema files as named subpath exports, so they ride
along with the package on `npm publish` without leaking dist-only
internals.

**Sync contract** — the test suite (`packages/cli/tests/schema-files.spec.ts`)
asserts the static `*.schema.json` files are byte-equivalent to
`stableJson(SCHEMA_CONST)` for both schemas. Editing the TypeScript
constants in `packages/cli/src/json-schema.ts` without regenerating the
files (or vice-versa) will break the test suite. To regenerate after
an intentional change:

```sh
pnpm cli schema --name cli-result > packages/cli/schemas/cli-result.schema.json
pnpm cli schema --name serialized-compiler-error > packages/cli/schemas/serialized-compiler-error.schema.json
pnpm cli schema --name generate-summary > packages/cli/schemas/generate-summary.schema.json
pnpm cli schema --name web-zip-summary > packages/cli/schemas/web-zip-summary.schema.json
```

(or, portably across Windows / Unix, regenerate them all in one shot:
`pnpm cli schema --out packages/cli/schemas`)

Bump `CLI_JSON_SCHEMA_VERSION` if the change is non-additive.

#### `summary.json` schema (sprint 49)

`plccopilot generate` writes a `summary.json` file to the output
directory. Its shape is **distinct** from the CLI stdout JSON
(`cli-result`):

- `summary.json` carries `artifacts: string[]` (PIR-relative paths
  inside the output dir) — the CLI stdout payload uses
  `written_files: string[]` (absolute paths).
- `summary.json` for `--backend all` nests every per-backend run
  including its `artifacts` list — the stdout `runs[]` only counts.
- No `generated_at` in `summary.json` (stays content-deterministic).

Two contracts, two schemas. `cli-result.schema.json` validates stdout;
`generate-summary.schema.json` validates the on-disk file.

```sh
# Runtime source-of-truth
pnpm cli schema --name generate-summary > generate-summary.schema.json

# Or import the published static file:
#   @plccopilot/cli/schemas/generate-summary.schema.json
```

CI example pipelining a real generation through the schema:

```sh
pnpm cli generate \
  --input project.json --backend siemens --out ./out

ajv validate \
  -s node_modules/@plccopilot/cli/schemas/generate-summary.schema.json \
  -d ./out/summary.json
```

#### `web-zip-summary.schema.json` (sprint 51)

The Web MVP's "Download ZIP" button bundles a `summary.json` at the
root of `plccopilot-artifacts.zip`. That file has a **distinct**
shape from the CLI's `summary.json` and is now governed by its own
schema:

```
@plccopilot/cli/schemas/web-zip-summary.schema.json
```

Differences vs `generate-summary` (CLI on-disk):
- Carries `generated_at` (the Web stamps wall clock at click time);
  the CLI stays content-deterministic and omits the timestamp.
- Counts live FLAT at the root (`errors`/`warnings`/`info`) — not
  inside a nested `diagnostics` object. This was the pre-sprint-51
  inline shape and is preserved verbatim to avoid breaking
  integrators that already parse downloaded ZIPs.
- `artifactCount` is camelCase (inherits from `CompileSummary`);
  `generated_at` is snake_case. The inconsistency is observable and
  historic.

```sh
# Print the schema (runtime source of truth)
pnpm cli schema --name web-zip-summary > web-zip-summary.schema.json

# Or import the published static file:
#   @plccopilot/cli/schemas/web-zip-summary.schema.json
```

CI example validating a Web-downloaded ZIP:

```sh
unzip plccopilot-artifacts.zip summary.json -d ./
ajv validate \
  -s node_modules/@plccopilot/cli/schemas/web-zip-summary.schema.json \
  -d ./summary.json
```

`generate-summary` and `web-zip-summary` are intentionally separate
contracts — the runtime sources differ, the field sets differ, and
both shapes are expected to evolve independently.

### `summary.json` shape

Single-backend run:

```json
{
  "backend": "siemens",
  "artifact_count": 10,
  "diagnostics": { "errors": 0, "warnings": 1, "info": 2 },
  "artifacts": [
    "siemens/FB_StLoad.scl",
    "siemens/FB_StWeld.scl",
    "siemens/FB_Alarms.scl",
    "siemens/UDT_Cylinder2Pos.scl",
    "siemens/UDT_MotorSimple.scl",
    "siemens/DB_Global_Params.scl",
    "siemens/DB_Recipes.scl",
    "siemens/DB_Alarms.scl",
    "siemens/Tags_Main.csv",
    "siemens/manifest.json"
  ]
}
```

`--backend all`:

```json
{
  "backend": "all",
  "runs": [
    { "backend": "siemens",  "artifact_count": 10, "diagnostics": {...}, "artifacts": [...] },
    { "backend": "codesys",  "artifact_count": 9,  "diagnostics": {...}, "artifacts": [...] },
    { "backend": "rockwell", "artifact_count": 9,  "diagnostics": {...}, "artifacts": [...] }
  ]
}
```

### Limitations (MVP)

- `summary.json` aggregates `artifact.diagnostics` only. The same
  diagnostic also appears in each backend's `manifest.json` under
  `compiler_diagnostics`; reading both would double-count, so the
  manifest copy is intentionally ignored. `validate` is the right tool
  for full diagnostic inspection.
- `generate --backend all` is sequential. The first backend that throws
  aborts the whole run with exit 1; partial artifacts already on disk
  are NOT cleaned up (you decide whether to wipe `--out` first).
- Output paths are derived from `artifact.path`. Path traversal (`../`)
  and absolute paths are rejected at write time.

## Web MVP

A browser-only React app for inspecting PIR projects and the artifacts the
codegen packages produce. **Everything runs in your browser** — no server,
no cloud, no upload. The PIR JSON you load never leaves the tab.

### Run it locally

```sh
pnpm web:dev          # starts Vite at http://localhost:5173
pnpm web:build        # type-checks then builds the static bundle
pnpm web:preview      # serves the built bundle locally for smoke-checking
```

### Privacy

The Web MVP runs fully in the browser. **PIR files are not uploaded
anywhere** — no server, no cloud, no telemetry. The only persistence is
your own browser's `localStorage` (see "Persistence" below) which you can
clear with one click.

**Monaco is self-hosted.** The Web MVP bundles `monaco-editor` (and its
JSON / editor workers) locally — no CDN fetch, no `jsdelivr` dependency,
no external network call once the page loads. Monaco is code-split:
the chunks only download when you open the first artifact or the PIR
JSON viewer, but always from the same origin as the app. **The Web MVP
works fully offline after `pnpm web:build`.**

### What you get

1. **Upload PIR JSON** — click the upload button **or drag a `.json` file
   anywhere on the page**. A fullscreen overlay highlights the drop
   target while you drag. If you drop multiple files the first `.json`
   is used and an info banner mentions it; non-JSON drops surface as
   inline errors. The browser parses the file via `ProjectSchema.safeParse`;
   failures render inline with the first 8 Zod issues.
2. **Persistence (localStorage)** — the last loaded PIR is mirrored into
   `localStorage` under `plccopilot:last-project`. Reload the tab and it
   restores automatically with a "Restored from local browser storage"
   note. The **Clear saved project** button wipes it. Storage is
   best-effort: quota / security errors never break the app, and stale
   entries that no longer match the PIR schema are auto-cleared on next
   load. Generated artifacts and diagnostics are NOT persisted (they're
   cheap to recompute, bulky to store).
3. **Project summary** — id / name / pir_version / counts of stations,
   equipment, IO, alarms, parameters, recipes.
4. **PIR Structure navigator** — read-only collapsible tree of the applied
   PIR (Project → Machine → Station → Equipment) on the left, **rich
   resolved detail card** on the right. The detail card dispatches per
   node kind:
   - **Project** — id / name / pir_version / machines count. Surfaces
     vendor extensions when present (`target.vendor` / `target.family` /
     `target.tia_version`, `naming` profile, `tags`).
   - **Machine** — counters (stations / equipment / io / alarms /
     interlocks / parameters / recipes / safety_groups / modes), an IO
     direction breakdown (inputs vs outputs), an equipment-type
     histogram sorted by count (ties alphabetical), and an alarms-by-
     severity badge row (critical / warn / info).
   - **Station** — id / name, allowed_modes (vendor extension), a
     sequence summary (states, transitions, initial state, terminal
     states), the equipment list with id + type, and three relation
     lists: alarms, interlocks (matched against any equipment in the
     station), and safety groups (matched by `affects.kind === 'station'`
     OR by an equipment-target inside the station).
   - **Equipment** — id / type / display_name / code_symbol, an **IO
     bindings table** (Role | IO id | Status | Address | Type | Direction
     | Display name) where missing IO targets surface as a red `missing`
     badge instead of crashing, a timing table when present, related
     alarms / interlocks / safety groups, and provenance when present.
     Bindings are alphabetically sorted by role for deterministic display.
   - **Copy JSONPath** copies the bracket-indexed path
     (`$.machines[0].stations[1].equipment[2]`) to the clipboard. The
     same path syntax is what the in-editor markers and the
     `findJsonPathLine` helper consume.
   - **Severity-coloured focus highlights (sprint 29).** When a jump
     comes from the validation cycle (`⚠ N` badge), the focus pulse
     is tinted by `Issue.severity`: red for `error`, amber for
     `warning`, blue for `info`. Jumps from any other source —
     change-badge cycles, FieldDiff rows, the node-level `Find in PIR
     editor` button — keep the sprint-25/26 neutral palette (blue
     line + yellow value box). Tone is propagated through
     `handleFocusInEditor(path, severity?)`: every existing
     single-arg caller stays neutral by default, only the validation
     cycle passes a severity. The tinted decoration classes layer
     over the base via `focusToneClassSuffix` (returns `''`,
     `'-error'`, `'-warning'`, or `'-info'`), so the geometry and
     fade-out lifecycle from earlier sprints are unchanged.
   - **Find in PIR editor** scrolls Monaco to the matching line via
     `findJsonPathLine` + `revealLineInCenter`, focuses the editor, and
     drops a **transient two-tier highlight**:
     - A whole-line tint plus a small accent strip in the
       line-decoration column (sprint 25). Always painted — the line
       cue works even when the precise value range can't be located.
     - When `findJsonPathValueRange` resolves the exact byte range of
       the JSON value (string body with quotes, number tokens
       including signs / exponents, balanced object / array) a second
       inline decoration tints just that range in yellow with a thin
       outline — pinpointing the JSON value, not the surrounding
       whitespace. Works for strings (including escaped quotes /
       backslashes), numbers, booleans, null, nested objects, and
       arrays of primitives or objects. If the locator fails (path
       missing, JSON malformed, unterminated string) the value tier
       is silently skipped — the line cue still appears.
     Both decorations fade together after ~1.5 seconds so they don't
     get in the way of subsequent typing. Re-clicking the same node
     still re-scrolls **and re-plays the highlight** (a nonce defeats
     React's prop-equality short-circuit; a second jump arriving
     before the first highlight fades atomically replaces it instead
     of letting the older fade-out timer nuke the newer decorations).
     The CSS respects `prefers-reduced-motion: reduce`. When Monaco is
     in fallback mode (load timeout, sandbox / CSP), the focus effect
     no-ops cleanly — no scroll, no decoration, no crash.
   - All resolution is done by **pure helpers** in `utils/pir-resolvers.ts`
     (`getMachineByIndex`, `resolveIoBinding`, `resolveEquipmentRelations`,
     `resolveStationRelations`, `resolveMachineSummary`) so the detail
     panels are testable without a DOM. Out-of-range indices return
     `null` / `[]`; vendor-extension fields (`alarm.equipment_id`,
     `alarm.station_id`, `equipment.safety_group_ids`, `machine.modes`,
     `station.allowed_modes`, `state.initial`/`state.terminal` booleans)
     are read defensively so the navigator works on both core and
     extended PIRs without forcing a schema change.
   - **Applied / Draft view toggle.** The structure card header now
     carries a two-button toggle — `Applied` and `Draft` — plus a
     coloured pill that always says which project the tree is resolving
     against (`Applied` or `Draft — not applied`). Applied mirrors what
     Generate / Validate currently see; Draft renders the in-flight
     edits the moment the draft is schema-valid and distinct from
     applied. The Draft button is disabled (with a tooltip explaining
     why) when the draft matches applied or fails to parse / schema-
     validate. **Generate / Validate always read the applied project
     regardless of the view mode** — the toggle is purely cosmetic /
     inspection.
   - **Safe visual edits (draft only).** Each detail card renders a
     small `Edit (draft only)` section with a few editable scalar fields
     — Project: `name`. Machine / Station: `name`, `description`.
     Equipment: `display_name`, `code_symbol`, `description`. Every save
     writes to the **draft JSON** through a JSONPath patch
     (`utils/json-patch.ts`) and immediately appears in the Monaco PIR
     editor; **the applied project is unchanged** until you click Apply,
     so Generate / Validate keep using the previous values and the
     artifact view is not invalidated. A header banner confirms each
     visual save and the navigator **auto-promotes to the Draft view**
     so the edited value is visible in the detail card straight away
     (no more stale-applied confusion). The banner clears as soon as you
     start typing in Monaco directly. Patch failures (malformed path,
     missing key, array out of range, invalid JSON) surface inline as a
     red banner — the draft is never partially modified.
   - **Auto-fallback.** If the draft becomes invalid while you are in
     Draft view (rare — possible if you save an empty `code_symbol`
     against the regex, or hand-edit Monaco into a schema violation),
     the navigator automatically falls back to Applied and a yellow
     banner explains why. Selection is preserved when the same JSONPath
     exists in the new view; otherwise it is cleared with a one-line
     `Selected node does not exist in the <mode> view.` note.
   - **Validation-issue indicators (sprint 28).** A second pill `⚠ N`
     surfaces validation issues from `validate(project)` next to each
     affected node. Source depends on the structure view:
     - **Applied view** — uses the latest `validationReport` (i.e. the
       result of the user's last click on the **Validate** button). If
       the user hasn't validated yet, no `⚠` badges appear; running
       Validate populates them. The badges always reflect the applied
       project, never the draft.
     - **Draft view** — uses `draftProjectState.report` when the
       draft is schema-valid (the same `validate()` call that drives
       the editor's domain markers). If the draft is JSON-malformed
       or schema-invalid, `⚠` badges are not rendered — the editor
       markers already cover those failures and the badges would be
       redundant.
     The pill is **severity-tinted**: red `has-errors` if any errors
     are present, amber `has-warnings` if only warnings, blue
     `info-only` otherwise. Hovering shows the breakdown
     (`2 errors · 1 warning`, `3 info`, …) via
     `formatValidationSeverityBreakdown`. Clicking the pill cycles
     the editor through every issue under that branch — App keeps a
     per-node click counter in a ref (`validationCycleRef`) that
     resets whenever the source issue list changes (Validate pressed,
     view mode toggled, draft becomes valid / invalid, project
     swapped). **A small `⋯` button next to the pill (sprint 30)
     opens a per-node `ValidationIssuesList` panel** — a compact
     full-width card rendered below the tree/details grid that lists
     every issue under the node with severity tone, rule code,
     message, JSONPath, and a Jump button. Each Jump reuses the
     severity-coloured focus pulse, and the list stays open between
     jumps so the user can sweep through issues without reopening.
     The trigger toggles: clicking the same node's `⋯` closes the
     panel, clicking a different node's replaces it. The panel
     auto-closes when the open node's filtered list goes empty
     (Apply clears issues, view-mode flip, project swap). Display
     order inside the panel is `error → warning → info`, then by
     path / rule / report-index, so identical inputs always render
     identically. The same `handleFocusInEditor` focus-pulse drives the
     scroll, so the value-range highlight (sprint 26) and validation
     marker (sprint 27) layer correctly. Tab order across a row is
     `twist → label → ● change badge → ⚠ validation badge → ⋯ list
     trigger`; the existing metadata count (`2 stations`, `3 eq.`)
     sits at the row's right edge.

     Sprint 31 / 32 turns the panel into a mini issue navigator:
     - **Severity filter chips** (`All` / `Errors` / `Warnings` /
       `Info`) with per-bucket counts. The active filter has
       `aria-pressed="true"` and a tinted background. Clicking a
       chip with zero matches keeps the panel open and shows
       `No <severity> issues under this node.` so the user can flip
       back to a populated chip without reopening from the tree.
       **Sprint 32 lifts the filter to App and persists it via
       `localStorage`** (`plccopilot:validation-issue-filter`), so a
       chosen "Errors only" preference survives across node
       selections, panel opens, project loads, and tab reloads. A
       corrupt or unknown stored value falls back to `'all'`; saving
       is best-effort and never throws on quota / privacy mode.
     - **Sprint 32 — single-button rows.** Each issue row is now one
       focusable `<button>` spanning the row width with a 3px
       severity-toned left border (red / amber / blue), a hover /
       focus accent, and a `Jump ↗` hint. Clicking anywhere on the
       row (or pressing Enter / Space when focused) jumps the
       editor — no separate Jump button. HTML stays valid: no
       nested buttons, the list is `<ul>` of `<li>` of `<button>`.
       The filter chips and Close button remain real buttons
       outside the list.
     - **Sprint 32 / 33 — keyboard navigation.** The rows list
       uses a **roving-tabindex pattern**: only one row is in the
       document tab order at a time (`tabIndex={0}`); every other
       row is `tabIndex={-1}`. Tab from the filter chips lands on
       the active row only — Tab again leaves the list. Inside the
       list, `ArrowDown` / `ArrowUp` cycle through visible rows
       with wrap-around, `Home` jumps to the first row, `End` to
       the last; the active index is updated and the matching row
       is focused programmatically. `preventDefault()` suppresses
       page scrolling. Enter / Space activate the focused row
       natively. Click / focus on a row mirrors the active index
       so mouse and keyboard converge. The clamp helper keeps the
       active index in range when the visible list shrinks
       (filter change, Apply clears issues).
     - **Sprint 33 — Alt+1 / Alt+2 / Alt+3 / Alt+4** switch the
       global filter to All / Errors / Warnings / Info from
       anywhere on the page. Same `isTypingTarget` guard as Alt+L
       (no fire while typing in inputs / textareas / Monaco).
       Modifiers Ctrl / Meta / Shift disqualify the chord — only
       a clean Alt+digit triggers. Filter chip state and persisted
       storage are updated identically to clicking the chip.
     - **Sprint 33 / 34 — restore the open panel on reload.** App
       persists the open-panel marker via
       `saveOpenValidationPanel(projectId, nodePath | null)`
       whenever the state changes (open / close / auto-close).
       Sprint 34 makes the storage **project-scoped** — the key
       is `${PREFIX}${projectId}` so a saved panel for one
       project cannot ever leak into another. On project load a
       once-per-project restore effect reads the saved nodePath
       and reopens the panel **iff** the node still exists in
       the structure tree AND has at least one issue under it.
       Failed validation clears the stale entry. Sprint 34 also
       loosens the gate: the restore now fires the moment a
       validation source is ready (report exists OR the draft is
       schema-valid), not just when issues are non-empty — so a
       freshly-restored zero-issue report can clear stale saved
       markers.
     - **Sprint 34 — persistent validation report.** Clicking
       Validate or Apply now saves the produced
       `ValidationReport` under
       `plccopilot:validation-report:${projectId}`. Project loads
       (mount restore, file upload, drag/drop) call
       `loadValidationReport(project.id)` and rehydrate the
       report when found, surfacing a small banner:
       `Restored validation report from local browser storage.`
       The banner clears the moment the user clicks Validate or
       Apply (a fresh report supersedes the cache). Combined with
       the project-scoped open-panel marker, this makes the panel
       reopen **immediately** after a tab reload — no manual
       Validate click required. The cache is per-project; a stale
       entry whose shape doesn't match (`ok` not boolean,
       `issues` not array, payload `projectId` mismatch) is
       cleared on read so a known-bad cache cannot survive.
     - **Sprint 34 — Alt+L moves focus into the list.** When
       Alt+L opens the panel for the selected node, App bumps a
       focus-request nonce that `ValidationIssuesList` consumes
       to focus the first visible issue row (after one
       `requestAnimationFrame` so the DOM has rendered). Mouse
       `⋯` clicks deliberately do NOT bump the nonce, so they
       never steal focus from the structure tree. If the active
       severity filter hides every issue, no row is focused —
       the panel stays open with the empty-filter message and
       the user can flip chips. The severity filter remains a
       global UI preference (sprint 32), not project-scoped.
     - **Sprint 35 — restore-banner with age + tone + Discard.**
       The restore banner now reads e.g.
       `Restored validation report from local browser storage
       (5 min ago). Last result: 2 errors, 1 warning, 0 info.`
       Age phrases follow the `formatRelativeAge` rules
       (`just now` / `N min ago` / `N h ago` / `N d ago`,
       floored). The banner inherits the dominant severity
       tone of the cached report — red when any errors,
       amber when only warnings, blue otherwise — so the
       reload colour matches the issues the panel is about to
       show. A small inline **Discard** button drops the
       cached report (`clearValidationReport`), closes the
       panel, and clears its persisted marker, all in one
       click. Banner is rebuilt from the live wall clock on
       each load so the age stays fresh across sessions.
     - **Sprint 35 — 24h cache freshness window.**
       `loadValidationReport` now clears + ignores any
       cached report older than `VALIDATION_REPORT_MAX_AGE_MS`
       (24 h). The contract is `> max` (boundary equality is
       still fresh) and future-dated entries are tolerated
       (clock skew between save and load is not stale).
       `nowMs` and `maxAgeMs` are dependency-injection points
       on `LoadValidationReportOptions` — production calls use
       `Date.now()` per call; tests override for determinism.
       Pure helpers in `utils/time.ts` (`parseIsoTimeMs`,
       `formatRelativeAge`, `isOlderThanMs`) keep all the
       arithmetic out of React.
     - **Sprint 35 — Ctrl/Cmd+Shift+V Validate shortcut.**
       The toolbar `Validate` handler is now the stable
       `runValidation` callback shared with a window-level
       keydown listener. The chord is `Ctrl+Shift+V` on
       Linux / Windows or `Cmd+Shift+V` on macOS — encoded by
       the pure `isValidateShortcut` predicate
       (`utils/keyboard-shortcuts.ts`): exactly one of
       `ctrlKey`/`metaKey`, `shiftKey` true, `altKey` false,
       case-insensitive `v`. The same `isTypingTarget` guard
       as Alt+L / Alt+1..4 prevents the shortcut from firing
       while the user is typing in any input or in Monaco.
       The toolbar tooltip now hints at the chord.
     - **Sprint 35 — restore moves focus into the panel.**
       When the project-scoped open-panel marker rehydrates
       on load, App now ALSO bumps the validation-panel
       focus nonce — same path Alt+L uses — so the user
       lands one Tab / arrow key away from triaging issues
       instead of having to mouse over to the panel.
     - **Live node label** — the panel header always reflects the
       current label of the open node, so renaming a field via the
       editor while the panel is open updates the heading instantly.
       App stores only the JSONPath in its open-state; the label is
       derived per render via `findPirStructureNodeByPath` against
       the live structure tree. The panel auto-closes when the open
       node disappears from the tree (project swap, draft schema
       break) or when its full issue list goes empty (Apply, view-
       mode flip).
     - **Alt+L** opens / closes the panel for the currently
       selected structure node. The shortcut is gated by an
       `isTypingTarget` guard so it never fires while the user is
       typing in an `<input>` / `<textarea>` / `<select>` /
       contentEditable element / Monaco editor. No node selected,
       or no issues under it, → the shortcut is a no-op.
     - The currently-open node's `⋯` button gets an `.open` class
       (and `aria-pressed="true"`) so the user can see at a glance
       which row spawned the panel.
   - **Pending-change indicators.** When the draft is valid and differs
     from applied, a small yellow `● N` pill appears next to every
     changed node in the structure tree — `N` is the count of pending
     diff entries that touch the node or any of its descendants, so
     collapsed branches still report the rolled-up total at a glance.
     One field edit on equipment `cyl01` shows `● 1` next to the
     equipment, its station, its machine, and the project root; three
     edits on the same equipment show `● 3` at every ancestor; edits
     spread across two equipment in the same station sum at the
     station / machine / root and stay separate on each equipment
     row. **The pill itself is a clickable button** — clicking it (or
     pressing Enter / Space when focused) jumps the Monaco PIR editor
     to the *first* changed JSON line under that branch via the App's
     existing focus-pulse mechanism. The click `stopPropagation()`s so
     the row doesn't also expand or get selected — selection still
     belongs to the row label, expand/collapse to the twist arrow.
     **Repeated clicks cycle through every change under that branch**
     in the same deterministic `pirDiffs` order — first click jumps
     to change 1, second click to change 2, …, after N clicks the
     cycle wraps back to change 1. Per-node click counters live in a
     ref inside App (no React re-render on click) and are cleared
     automatically whenever `pirDiffs` changes (any visual edit, any
     Apply, any new project load), so the cycle restarts at the first
     descendant change after every diff change. **Hovering the pill
     now shows a kind-aware breakdown** (`2 changed · 1 added`,
     `1 added · 1 removed`, `3 changed`, …) computed by
     `structureChangeBreakdownsFromDiffs` — the visible `● N` is still
     the total, but the tooltip and aria-label expose how many
     `changed` / `added` / `removed` entries roll up under the branch.
     Order in the phrase is fixed (`changed → added → removed`); zero
     buckets are omitted; the full tooltip reads `<breakdown> in
     draft. Click repeatedly to cycle through them.` and the
     aria-label is `Jump through N pending change(s) under <label>.
     <breakdown>.` This is informational only — visible badge,
     cycle behavior, and Apply / Generate semantics are unchanged.
     Selecting a node with pending edits
     reveals an additional `Pending changes` section in the detail
     card listing each changed scalar with `Applied` (struck-through,
     muted) vs `Draft` (accent-colored) values. Today the diff
     surfaces the same scalars that are inline-editable — Project /
     Machine / Station `name` and `description`; Equipment
     `display_name` / `code_symbol` / `description`. Tables / lists /
     IO bindings / sequences are NOT diffed at the field level (use
     the Monaco diff editor for those). **Each Pending changes row is
     a clickable button** — clicking (or pressing Enter / Space when
     focused) scrolls the Monaco PIR editor to the matching JSON line
     via the same focus-pulse mechanism as the node-level **Find in
     PIR editor** button. A small `Jump to JSON ↗` hint at the bottom
     of each row signals the affordance. Re-clicking the same row
     re-fires the scroll (the focus pulse increments a nonce so React
     can't dedupe the request). The diff layer remains purely
     informational — Generate / Validate keep reading the applied
     project, Apply remains the only path that promotes a draft.
   - **What is editable**: only safe scalars on existing records. Names
     are required; `description` and `code_symbol` accept empty string
     (the existing draft validation pipeline will flag a regex violation
     on `code_symbol` before Apply if you save it empty). What is **NOT**
     editable from the navigator: `id`, `type`, `pir_version`, IO
     bindings, timing, sequences, alarms, interlocks, safety groups —
     and no array insert / delete from this layer. Use the Monaco
     editor for those.
   - The navigator is otherwise strictly read-only: no drag-and-drop, no
     auto-Apply, no schema mutation. **Apply remains the single path that
     promotes a draft to the working project.**
5. **PIR JSON editor** — pretty-printed editable Monaco editor with line
   numbers, JSON syntax highlighting, native search (Ctrl/Cmd+F), and
   inline Monaco markers placed **on the exact JSON value** when the
   path can be resolved. The pipeline is debounced (300 ms): JSON
   parse → `ProjectSchema.safeParse` → domain `validate(project)`. A
   status pill summarises the current draft: `Clean` / `Unsaved
   changes` / `Invalid JSON` / `Invalid PIR schema` / `Unsaved · N
   validation errors`.
   - **Sprint 27 — exact-range markers.** Every Zod schema issue and
     every domain-validation issue with a JSONPath now points its
     squiggle at the precise value (string body with quotes, number
     tokens, balanced object / array body) via the same
     `findJsonPathValueRange` helper that drives the focus highlight.
     Schema markers read `PIR schema: <message>`, validation markers
     read `[<rule_id>] <message>`. Marker severity preserves
     `error` / `warning` / `info` from `validate(project)`. When the
     locator can't resolve the path (root issue, malformed JSON
     inside the value, stale path against a freshly-shrunk document)
     the marker falls back to a full-line range, then to line 1 — it
     is always renderable, never throws. JSON syntax errors keep
     pointing at the parser's reported line / column. Apply gating is
     unchanged: `Invalid JSON` and `Invalid PIR schema` still block
     Apply, `validate(project)` errors / warnings / info do not.
   - **Apply JSON** promotes the draft to the working project AND
     synchronously runs `validate(nextProject)`, so the Applied-mode
     `⚠ N` badges from sprint 28 light up immediately on the next
     render — no separate Validate click required after Apply. The
     apply banner reflects the validation outcome:
     `Applied JSON changes. Validation passed.` when `report.ok`,
     otherwise `Applied JSON changes. Validation found N errors,
     M warnings, K info.` (zero buckets are still shown so the
     banner shape is stable across reports). The
     "artifacts may be stale" notice keeps its own yellow banner —
     they coexist on screen. Apply is still **disabled** while the
     draft fails JSON parse or PIR schema validation; domain
     `validate()` errors / warnings / info do NOT block Apply.
   - **Show diff** swaps the editor for a Monaco diff view (read-only,
     side-by-side) of the applied JSON vs. the unsaved draft. Works
     even when the draft is invalid JSON — the diff compares text, not
     parsed values. **Hide diff** returns to the editor. Apply remains
     the only path that promotes the draft.
   - **Reset to applied** discards the draft.
   - **Copy JSON** exports the draft to clipboard.
   - The artifact preview keeps a strict read-only Monaco — only the PIR
     itself is editable.
   - **Generate and Validate always read the applied project, never the
     in-flight draft.** Invalid edits cannot reach the codegen pipeline.
   - When you Apply changes after a generate, the existing artifacts
     stay visible but a "Artifacts may be stale" banner appears until
     you click Generate again.
6. **Validate** — runs `validate(project)` from `@plccopilot/pir`. Issues
   appear in a sortable diagnostics table (full-width version below the
   PIR viewer).
7. **Generate** — pick a backend (Siemens / Codesys / Rockwell / all) and
   compile in-page. The compile runs in a **dedicated Web Worker**, so the
   UI stays responsive even on large PIRs (drag overlay, scroll, button
   feedback all keep working while bytes are being produced). The
   Generate button still disables to block double-trigger; the worker
   tracks requests by id so out-of-order responses cannot leak stale
   state. If the worker constructor failed at app boot (CSP, sandboxed
   iframe, very old browser), the client falls back to a main-thread
   compile transparently — a one-line "Web Worker unavailable" banner is
   the only visible difference. If the compile throws, the previous
   artifact list stays visible next to the inline error so you can
   compare. On success the previously-selected artifact is preserved by
   basename — swapping `siemens` → `codesys` keeps you on `FB_StLoad`.
8. **Artifact tree + preview** — left pane groups artifacts by backend
   directory; right pane shows path, kind, language, line count, char
   count, attached diagnostics, and the full content in a **Monaco
   read-only editor** with line numbers and native search (Ctrl/Cmd+F).
   Syntax highlighting:
   - `.scl` (Siemens SCL) and `.st` (IEC 61131-3 ST) — custom Monarch
     tokenizer with keyword set, `(* … *)` block comments, `// …` line
     comments, `#fb-local` refs, `"PLC tag"` literals, `T#5000MS` time
     literals.
   - `.json` — Monaco built-in.
   - `.csv` and unknown — plaintext.
   Monaco is bundled locally (no CDN); if for any reason it fails to
   mount within 8 seconds, the preview falls back to a plain `<pre>`
   view with no loss of content. A **Copy all** button copies the
   artifact text to clipboard via the Clipboard API (with a
   `<textarea>` + `execCommand` fallback).
   When you regenerate (a new compile after at least one previous one),
   each artifact preview gains a **Show diff with previous** toggle
   that opens a Monaco read-only diff view between the previous and
   current generation of that exact path. The button is disabled when
   the content is unchanged (and a small "No content changes from the
   previous generation" note explains why). Diff is exact-path only —
   comparing across backends (e.g. `siemens/FB_StLoad.scl` vs
   `codesys/FB_StLoad.st`) is intentionally out of scope for this
   sprint. Uploading a new PIR clears the previous-generation
   reference; pressing Apply on the editor preserves it.
9. **Download** — three options:
   - **Download ZIP** — produces a real `plccopilot-artifacts.zip` with
     directory structure preserved (`siemens/…`, `codesys/…`,
     `rockwell/…`) plus a `summary.json` at the root. Powered by JSZip.
   - **Download bundle (.json)** — single-file `plccopilot-bundle.json`
     with every artifact's path / kind / content / diagnostics. Useful
     for re-ingesting via tooling.
   - **Per-artifact "Download"** button in the preview pane.

### What it does NOT do

- No accounts, no auth, no network IO.
- No DOM-heavy testing in the unit suite (`vitest` only covers the pure
  compile / diagnostics / storage / download / selection / worker-protocol
  utilities).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — pipeline + IR contract
- [`docs/backend-authoring.md`](docs/backend-authoring.md) — cookbook for adding a new backend
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — install, test, and contribution rules

## License

Internal — proprietary.
