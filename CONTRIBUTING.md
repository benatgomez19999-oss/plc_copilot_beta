# Contributing to PlcCopilot

## Setup

```sh
# Required: Node 24+ and pnpm 8+ (CI uses Node 24, pnpm 9).
pnpm install
```

This installs every workspace package, links them via symlinks, and
prepares both `tsc` and `vitest` to resolve cross-package imports.

> Why Node 24? The CLI's compiled `dist/index.js` imports workspace
> packages whose `main` points at `src/index.ts`. Node 24 (and 23+)
> strips TypeScript at runtime by default, so the compiled bin can
> load sibling sources without a separate build step per package.

## Running tests

```sh
pnpm typecheck                                       # all packages
pnpm test                                            # all packages
pnpm --filter @plccopilot/codegen-core test          # one package
pnpm --filter @plccopilot/codegen-siemens test:watch # interactive
pnpm run ci                                          # contracts + typecheck + test (CI script)
```

Note: `pnpm run ci` (not `pnpm ci`). pnpm reserves the bare `ci` verb
for an unimplemented npm-compat install command.

## Pre-PR checklist (sprints 53–62)

Run these from the repo root before opening a PR:

```sh
pnpm build:packages-base    # compile pir + codegen-core dist
pnpm base:dist-smoke        # validate the base packages' dist artefacts
pnpm build:packages-vendor  # compile codesys + rockwell + siemens dist
pnpm vendor:dist-smoke      # validate each vendor's dist + façade
pnpm cli:build              # compile packages/cli/dist/
pnpm schemas:check          # CLI schema sync guard
pnpm cli:smoke              # exercise the compiled bin on a clean Node process
pnpm cli:pack-smoke         # validate the package as it would be published (dry-run)
pnpm cli:tarball-smoke      # build a real .tgz, extract it, run the extracted bin
pnpm consumer:install-smoke # npm install all 6 tarballs in a fresh temp project + run bin
pnpm release:check          # validate cross-package release metadata
pnpm release:pack-dry-run   # release-tooling pack dry-run for every candidate
pnpm release:publish-dry-run # npm publish --dry-run for every candidate (Sprint 62)
pnpm release:publish-real --validate-only --version 0.1.0 --tag next # Sprint 63 — input-only, no registry
pnpm publish:audit          # regenerate docs/publishability-audit.md if needed
pnpm -r typecheck           # strict TS across every package
pnpm -r test                # full test suite
```

Or, equivalently, the single shortcut:

```sh
pnpm run ci            # ci:contracts + typecheck + test
```

If your PR touches `packages/cli/package.json` (`files`, `exports`, `bin`),
`packages/cli/schemas/`, `tsconfig.build.json`, or the CLI build scripts,
re-run all three CLI smokes explicitly so the failure mode is in your
terminal:

```sh
pnpm cli:build
node packages/cli/scripts/smoke-cli-dist.mjs
node packages/cli/scripts/smoke-cli-pack.mjs
node packages/cli/scripts/smoke-cli-tarball.mjs
```

If your PR touches `packages/pir` or `packages/codegen-core` source / public
API / build configuration, re-run the base build + smoke explicitly:

```sh
pnpm build:packages-base
node packages/cli/scripts/smoke-base-dist.mjs
```

If your PR touches any vendor backend (`packages/codegen-codesys`,
`packages/codegen-rockwell`, `packages/codegen-siemens`) — source, public API,
`tsconfig.build.json`, or build script — re-run the vendor build + smoke too.
Build base packages first because each vendor's `tsc` reads `pir`/`core` types
from their committed `dist/index.d.ts`:

```sh
pnpm build:packages-base
pnpm build:packages-vendor
node packages/cli/scripts/smoke-vendor-dist.mjs
```

### Post-publish verification (sprints 64–65)

Once a real publish has landed, verify it from a fresh consumer
context with the layered audit:

```sh
pnpm release:provenance --version 0.1.0    # local-only stub (sprint 65)
pnpm release:npm-view    --version 0.1.0 --tag next   # registry metadata (sprint 65)
pnpm release:registry-smoke --version 0.1.0           # install + bin (sprint 64)

# Or trigger them in order from CI:
# Actions → Post-publish verify → Run workflow
```

`release:provenance` is safe to run anywhere — it doesn't contact
the registry. The other two **404 before the first publish by
design** and are deliberately excluded from `pnpm run ci`. The first-publish runbook (token, environment,
dry-run, real publish, partial-publish recovery) lives in
[`docs/first-publish-checklist.md`](docs/first-publish-checklist.md).

### First-publish docs (sprint 66)

For the very first npm publish, three companion documents control
the human side of the run:

- [`docs/first-publish-checklist.md`](docs/first-publish-checklist.md)
  — operator runbook with explicit abort conditions.
- [`docs/first-publish-postmortem.md`](docs/first-publish-postmortem.md)
  — template the operator + reviewer fill in **after** the publish.
- [`docs/releases/0.1.0.md`](docs/releases/0.1.0.md) — first-release
  notes scaffold; status starts as
  `planned first npm release — pending` until the postmortem is
  signed off.

Do **not** flip the status of `releases/0.1.0.md` to "released" until
both the publish workflow and the post-publish verify workflow are
fully green and the postmortem template's checklists are ticked. The
first publish ships under the `next` dist-tag — promotion to `latest`
is intentionally deferred and recorded in §5 of the postmortem.

### Promote-to-`latest` workflow (sprint 68)

Promoting `next` → `latest` is its own manual workflow
(`.github/workflows/promote-latest.yml`). It mutates only npm
dist-tags; it never republishes tarballs. The runner
(`pnpm release:promote-latest`) refuses to spawn anything containing
`publish` (`assertNoPublishSurface`), and the parser rejects
`--dry-run` / `--no-dry-run` / `--publish` / `--yes` / `-y` at parse
time.

What you _can_ run locally — and what you _should_ before opening a
promote PR / dispatching the workflow — is the validate-only mode:

```sh
pnpm release:promote-latest --validate-only --version 0.1.0
```

That confirms the workspace is consistent and the inputs are
well-formed. It does **not** require `NODE_AUTH_TOKEN`, does **not**
require `--confirm`, and does **not** contact the registry.

The full real-promotion flow (preflight, environment approval,
post-mutation verification) lives in
[`docs/release-process.md → Promoting next → latest`](docs/release-process.md#promoting-next--latest-sprint-68).

### Manual publish workflow (sprint 63)

The repo's only path to a real `npm publish` is the manual
`.github/workflows/publish.yml` workflow. **Never run the real
`pnpm release:publish-real` (without `--validate-only`) on your laptop.**
The runner refuses to start without `NODE_AUTH_TOKEN` and the exact
confirmation string, but the safer rule is: real publishes only run
inside the protected `npm-publish` GitHub Actions environment, with
manual approval, after a green dry-run on the same inputs.

What you _can_ run locally — and what you _should_ before opening a
release PR — is the validate-only mode:

```sh
pnpm release:publish-real --validate-only --version 0.1.0 --tag next
```

That confirms every `packages/*/package.json#version` matches `0.1.0`
and that `next` is a valid tag. It does **not** require `NODE_AUTH_TOKEN`,
it does **not** require `--confirm`, and it does **not** contact the
registry.

See [`docs/release-process.md`](docs/release-process.md#manual-npm-publish-workflow-sprint-63)
for the full real-publish flow, including partial-publish recovery.

### Pre-release tooling (sprint 62)

The repo also ships:

```sh
pnpm release:publish-dry-run                        # npm publish --dry-run --json for all 6 candidates
pnpm release:notes                                  # Markdown release-notes scaffold to stdout
pnpm release:notes --version 0.2.0 --out docs/releases/0.2.0.md
pnpm release:pack-artifacts --out .release-artifacts/tarballs --clean
```

`release:publish-dry-run` is wired into `ci:contracts` and the GitHub
Actions workflow; the artifact pack runs only in CI (uploaded as
`plccopilot-release-tarballs`). The `release:publish-dry-run` script
hardcodes `--dry-run` and rejects any forwarded arg that would remove
it (`--no-dry-run`, `--publish`, `--yes`, `-y`) — the safety is
enforced both at the runner level and in the helper-lib unit tests.

`release:notes` is on-demand: nothing is committed under
`docs/releases/X.Y.Z.md` until a real release is being prepared.

### Release tooling (sprint 61)

The repo ships a release planner that keeps the six publish candidates
versioned in lockstep:

```sh
pnpm release:check             # consistency check, exit 1 on drift
pnpm release:plan              # Markdown patch plan
pnpm release:plan --bump minor # alternative bump
pnpm release:plan --version X.Y.Z
pnpm release:plan --json       # JSON for agents / CI
pnpm release:plan --bump patch --write   # apply (no install / no publish)
pnpm release:pack-dry-run      # release:check + npm pack --dry-run for all 6
```

Both `release:check` and `release:pack-dry-run` run inside
`ci:contracts`, so a missed coordinated bump fails CI rather than the
registry. See [`docs/release-process.md`](docs/release-process.md) for
the full release flow. **Sprint 61 is plan-only** — the tool never runs
`npm publish`.

### Publishability rules (sprint 60)

The six publish candidates (`pir`, `codegen-core`, `codegen-codesys`,
`codegen-rockwell`, `codegen-siemens`, `cli`) are now publish-ready: no
`private: true`, no `workspace:*` runtime ranges, dist-pointing exports
from sprint 59, and a green consumer install smoke as the proof. When
touching any of those packages' `package.json`, **do not**:

- Re-introduce `private: true` on a publish candidate. (`web` and
  `codegen-integration-tests` stay private; that's intentional.)
- Use `workspace:*` for a runtime dependency. `npm pack` does **not**
  rewrite the protocol, so `workspace:*` ships verbatim and breaks
  `npm install`. Use the explicit version (today: `"0.1.0"`).
- Drop `link-workspace-packages=true` from `.npmrc` — pnpm needs it to
  link sibling packages now that the ranges are explicit semver.

When you bump a package's version, bump every dependent's range to
match (e.g., bumping `pir` to `0.2.0` requires `codegen-core`,
`codegen-codesys`, `codegen-rockwell`, `codegen-siemens`, and `cli` to
declare `"@plccopilot/pir": "0.2.0"`). The consumer install smoke will
fail loudly if a sibling tarball can't satisfy a range. A future
release-management sprint will automate this.

### Public exports policy (sprint 59)

Every publishable package's root `exports["."]` is the publish contract and
**must** point at compiled dist:

```json
"main": "./dist/index.js",
"types": "./dist/index.d.ts",
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

Do **not** point `exports["."]` back at `./src/*.ts`. Workspace dev still
finds source through `tsconfig.paths` (typecheck) and `vitest.config.ts`
aliases (tests); package `exports` is only consulted by Node and external
consumers. The base / vendor / CLI dist smokes will fail loudly if a
revert lands a source-pointing export.

If you add a brand-new publishable package, mirror the same shape in its
`package.json` and add it to the `build:packages-*` chain in the root
`package.json`.

If your PR touches **any** `packages/*/package.json` (exports, files, bin,
dependencies, scripts), or adds/removes a `tsconfig.build.json`, or adds a
brand-new package directory, regenerate the publishability audit:

```sh
pnpm publish:audit            # rewrites docs/publishability-audit.md
pnpm publish:audit --check    # CI runs this — fails on drift
```

CI does **not** require zero publish blockers in the audit; it only requires
the committed `docs/publishability-audit.md` to match the live workspace.
Sprints 57–60 will land the dist builds, exports flips, and the consumer
install smoke that drive the blocker count down.

The tarball smoke needs the system `tar` binary on `PATH` (every CI runner
ships it; Windows 10+ has `tar.exe`). To debug a failing run, set
`PLC_COPILOT_KEEP_TARBALL_SMOKE=1` and the script will leave the extracted
package at `packages/cli/.tarball-smoke-tmp/extract/package/`.

The four contract gates (`schemas:check`, `cli:smoke`, `cli:pack-smoke`,
`cli:tarball-smoke`) catch four classes of regression that the unit tests
miss:

- Static `packages/cli/schemas/*.schema.json` drifting from the
  generators in `packages/cli/src/json-schema.ts`. Regenerate with
  `pnpm cli schema --out packages/cli/schemas`.
- The compiled `dist/index.js` failing to start under a clean Node
  process — broken imports, missing shebang, dropped commands. The
  dist smoke exits 1 with a clear message; if it fires, run
  `pnpm cli:build` and re-check.
- The publishable package losing required entries (e.g. `dist/` or
  `schemas/` falling out of `package.json` `files`) or gaining junk
  (e.g. `tests/` or `tsconfig.json` leaking through). The pack smoke
  spawns `npm pack --dry-run --json` and asserts the exact contract.
- The real tarball failing on extraction or runtime — e.g., missing
  shebang once compressed, schema bytes drifting between source and
  pack, or the extracted bin throwing on `help` / `schema`. The tarball
  smoke produces a real `.tgz`, extracts it with system `tar`, asserts
  byte-equal schemas, and runs four commands against the extracted bin.
- The publishability audit drifting from the actual workspace — a new
  package, a flipped `exports`, a runtime dep added without rethinking
  `workspace:*`, etc. `pnpm publish:audit --check` regenerates the
  report in memory and diffs against `docs/publishability-audit.md`.

## Writing a new test

Tests live under `packages/<pkg>/tests/`. Use `vitest`. Imports MUST go
through package barrels — never reach into another package's `src/`.

```ts
// ✅ Correct
import { compileProject, type ProgramIR } from '@plccopilot/codegen-core';
import { generateSiemensProject } from '@plccopilot/codegen-siemens';

// ❌ Wrong — bypasses public API
import { compileProject } from '../../codegen-core/src/index.js';
```

For tests that exercise more than one backend, place them in
`packages/codegen-integration-tests/tests/`. That package depends on all
four codegen packages and is the only one allowed to.

Fixtures live in `packages/pir/src/fixtures/` (currently `weldline.json`).

## Adding a new backend

See [`docs/backend-authoring.md`](docs/backend-authoring.md) for the full
cookbook. Short version: create
`packages/codegen-<vendor>/`, depend on `@plccopilot/codegen-core` and
`@plccopilot/pir`, ship a `BackendNamespaceMap`, a renderer, a manifest
generator, and a `generate<Vendor>Project` façade. The `ProgramIR`
contract is fixed — backends adapt to it, not the other way around.

## Architectural rules

These are enforced by tests; PRs that break them won't merge.

1. **`codegen-core` does not know any backend.** No backend filesystem
   prefixes (`siemens/`, `codesys/`, `rockwell/`), no extension literals
   (`.scl`, `.st`), no Siemens / Codesys / Rockwell namespace strings
   (`S7_Optimized_Access`, `GVL_Alarms`, `Alarms.set_`, `ROUTINE`).
   Enforced by `packages/codegen-core/tests/no-backend-leakage.spec.ts`.

2. **A backend may import `@plccopilot/codegen-core`.** Never the other way
   around.

3. **A backend MUST NOT import another backend.** If you're tempted, the
   logic belongs in `codegen-core` (or in `codegen-integration-tests` if
   it's a comparison test).

4. **PIR is frozen at v0.1.** Any change requires a migration and a
   version bump. Don't add fields opportunistically.

5. **Output must be deterministic.** Two consecutive runs with the same
   inputs produce byte-identical artifacts. Sort everything that goes to
   disk; never iterate `Map`/`Set` insertion order without sorting.

6. **Any change to ProgramIR shape needs tests.** Add at least one assert
   in `packages/codegen-core/tests/compile-project-neutrality.spec.ts` or
   `tests/serialize.spec.ts`. If a serialized field changes, document it
   explicitly in the PR.

7. **No new dependencies without justification.** The pipeline is pure
   TypeScript + Node built-ins. Adding a runtime dep affects every
   downstream consumer.

8. **Diagnostics are first-class.** Surface limitations through the
   `Diagnostic` channel; never silently degrade. If your backend has a
   POC limitation, mint a `ROCKWELL_*` / `CODESYS_*` style code and emit
   it (`info` for documentation, `warning` for "this won't import
   directly", `error` for "we cannot lower this").

## Commit hygiene

- One concept per PR. Rename + behaviour change in the same commit makes
  bisecting hard.
- Lockfile changes belong in their own commit when possible.
- If a snapshot or serialized output changes, the PR description must
  state which test asserts the new shape and why it changed.

## Asking for review

A PR opens with three things visible at a glance:

1. **What changed**: 2-line summary.
2. **What stayed**: confirm no functional change to alarms / timers /
   edges / state machine / interlocks / UDT fields / recipe flattening.
3. **Test impact**: which tests were added or updated, and whether any
   snapshot bytes shifted.
