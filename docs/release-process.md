# PLC Copilot Release Process

This document covers the release-tooling scaffold landed in **Sprint 61**.
It does **not** push anything to a registry — that is intentional. Sprint 61
is plan-only.

## Publish candidates

The repo today has six publish candidates (in publish order):

1. `@plccopilot/pir`
2. `@plccopilot/codegen-core`
3. `@plccopilot/codegen-codesys`
4. `@plccopilot/codegen-rockwell`
5. `@plccopilot/codegen-siemens`
6. `@plccopilot/cli`

The list is hard-coded in
[`packages/cli/scripts/release-plan-lib.mjs`](../packages/cli/scripts/release-plan-lib.mjs)
(`RELEASE_PACKAGE_DIRS`) so a future package can't accidentally enter the
publish set without an intentional edit. The remaining workspace packages
(`web`, `codegen-integration-tests`) stay private — they are not release
candidates.

## Versioning policy (Sprint 61)

- Strict `MAJOR.MINOR.PATCH`. Pre-release identifiers (`-alpha`) and build
  metadata (`+sha`) are explicitly rejected for now.
- Every publish candidate must share the same version. The release tool
  treats this as the canonical "release version" and bumps all six packages
  together.
- Internal runtime dependency ranges (`dependencies` / `peerDependencies` /
  `optionalDependencies`) must be **exact** strict semver matching the
  shared version (currently `"0.1.0"`). No `^`/`~`/`workspace:*`.
- `.npmrc` must keep `link-workspace-packages=true` so pnpm still links
  sibling packages locally despite the explicit semver ranges.

## Tooling

| Command | Purpose |
| --- | --- |
| `pnpm release:check` | Validate consistency: names, versions, dist-pointing exports, dep ranges, `.npmrc`. Exit 1 with a clear list of issues if anything drifts. |
| `pnpm release:plan` | Print a Markdown plan for a patch bump (current → current+patch). |
| `pnpm release:plan --bump minor` | Same, minor bump. |
| `pnpm release:plan --bump major` | Same, major bump. |
| `pnpm release:plan --version X.Y.Z` | Plan with an exact target. Refuses non-strict semver and non-incrementing targets. |
| `pnpm release:plan --json` | Stable JSON plan (for agents / CI consumers). |
| `pnpm release:plan --out FILE.md` | Write the Markdown plan to a file. |
| `pnpm release:plan --bump <kind> --write` | Apply the plan to every candidate's `package.json` (version + every internal dep range). Does **not** run `pnpm install`, does **not** publish. |
| `pnpm release:pack-dry-run` | Run `release:check`, then `npm pack --dry-run --json` for every candidate. Asserts required entries, forbidden prefixes (src/tests/scripts/node_modules), `tsbuildinfo`/`tsconfig*.json`/`vitest.config.ts`, and reports a single line on success. |
| `pnpm release:publish-dry-run` | _(Sprint 62)_ Run `npm publish --dry-run --json` for every candidate. The script hardcodes `--dry-run`; there is no flag or env var that can produce a real publish. Verifies `name`/`version` match and `files[]` is non-empty. |
| `pnpm release:notes` | _(Sprint 62)_ Render deterministic Markdown release notes for the next bump. `--bump <kind>` / `--version X.Y.Z` / `--json` / `--out FILE.md` supported. The generated `Highlights` section is `TODO:` placeholders by design — edit before publishing. |
| `pnpm release:pack-artifacts --out <dir>` | _(Sprint 62)_ Pack every candidate into `<dir>` and write `<dir>/manifest.json`. CI uses this to upload the six tarballs as the `plccopilot-release-tarballs` artifact. `--clean` empties prior `*.tgz` + `manifest.json` first. |
| `pnpm release:publish-real --validate-only --version X.Y.Z --tag <next\|latest\|beta>` | _(Sprint 63)_ Validate publish inputs against the live workspace. **Never publishes** in `--validate-only` mode. Token-less. Used by the manual publish workflow's preflight job. |
| `pnpm release:publish-real --version X.Y.Z --tag <tag> --confirm "publish @plccopilot X.Y.Z"` | _(Sprint 63)_ Real publish runner. Refuses to run unless `NODE_AUTH_TOKEN` is set, the confirmation matches exactly, every package's `package.json#version` equals the input, and the tag is in the allow-list. Always emits `npm publish --provenance --access public --tag <tag>`. **Only invoked by the GitHub Actions workflow** under the protected `npm-publish` environment. |
| `pnpm release:registry-smoke [--version X.Y.Z] [--registry URL]` | _(Sprint 64, manual only)_ `npm install @plccopilot/cli@<version>` from a real registry into a fresh temp project, run `help` / `schema` / `inspect` / `validate` / `generate --backend siemens`. Detects "package not yet published" 404s and prints a friendly "expected before first publish" message. **Not in `ci:contracts`.** |
| `pnpm release:npm-view [--version] [--tag] [--registry] [--json]` | _(Sprint 65, manual only)_ `npm view` every release candidate, validate name / version / dist.tarball / dist.integrity, optionally check that the dist-tag resolves to the same version. **Not in `ci:contracts`.** |
| `pnpm release:provenance [--version] [--json]` | _(Sprint 65)_ Local-only stub that confirms the publish path is *configured* for provenance: workflow YAML grants `id-token: write` + references `--provenance`, and the publish command builder hardcodes `--provenance` for every tag. Safe to run anywhere. Deep attestation verification against Sigstore is reserved for a future sprint. |
| `pnpm release:promote-latest --validate-only --version X.Y.Z [--registry URL]` | _(Sprint 68)_ Local-only validation for the dist-tag promote runner. No token, no confirm, no registry contact. Used by the workflow's preflight + by hand on the operator's machine. |
| `pnpm release:promote-latest --version X.Y.Z --confirm "promote @plccopilot X.Y.Z to latest"` | _(Sprint 68)_ Real mode — moves the `latest` dist-tag to a version already on `next`. Refuses to start unless `NODE_AUTH_TOKEN` is set, the confirmation matches exactly, every package@next resolves to `<version>` first, and the runner's argv passes `assertNoPublishSurface`. Idempotent: packages already at `latest -> <version>` are skipped. **Only invoked by the GitHub Actions workflow.** |
| `pnpm release:github --validate-only --version X.Y.Z [--tag vX.Y.Z]` | _(Sprint 69)_ Local-only validation for the GitHub Release runner. Asserts the workspace is at `<version>`, the tag equals `v<version>`, and `docs/releases/<version>.md` is in the post-promotion shape (no "pending", mentions every package and `latest`). No token, no confirm, no network. Used by the workflow's preflight + by hand on the operator's machine. |
| `pnpm release:github --version X.Y.Z [--tag vX.Y.Z] --confirm "create GitHub release vX.Y.Z"` | _(Sprint 69)_ Real mode — shells out to `gh release create` with the canonical argv (tag `v<version>`, six tarballs + `manifest.json` from `.release-artifacts/tarballs/`, `--title "PLC Copilot v<version>"`, `--notes-file docs/releases/<version>.md`). Refuses to start if a release for the tag already exists. Never mutates npm — `assertNoNpmMutationSurface` rejects any argv with a publish / dist-tag / npm token. **Only invoked by the GitHub Actions workflow.** |

`release:check`, `release:pack-dry-run`, and `release:publish-dry-run`
are wired into [`pnpm run ci:contracts`](../package.json) (and the
GitHub Actions [`ci.yml`](../.github/workflows/ci.yml) workflow), so a
missed coordinated bump or a regressed manifest fails CI rather than the
registry. CI additionally runs `release:pack-artifacts` and uploads the
six tarballs + `manifest.json` as the `plccopilot-release-tarballs`
artifact (14-day retention) for reviewer inspection.

## Release flow

The current flow is **manual** — Sprint 61 deliberately stops short of
`npm publish`. When you're ready to ship a release:

```sh
# 0. Workspace must be clean and on the right branch.

# 1. Verify the contract end-to-end.
pnpm run ci

# 2. Generate the plan and review it.
pnpm release:plan --bump patch        # or --bump minor / --version X.Y.Z

# 3. Apply the plan in place.
pnpm release:plan --bump patch --write

# 4. Re-install so the lockfile picks up the new versions.
pnpm install

# 5. Re-run all gates against the new version.
pnpm run ci

# 6. Final manifest sanity (optional, redundant with ci:contracts).
pnpm release:check
pnpm release:pack-dry-run
pnpm release:publish-dry-run     # Sprint 62 — npm publish --dry-run

# 7. Generate (and edit!) the release notes scaffold.
pnpm release:notes --bump patch > docs/releases/0.1.1.md
# Replace every TODO: in Highlights with the real change summary.

# 8. (Optional but useful) Build the actual six tarballs locally to
#    inspect what CI would upload as the release artifact.
pnpm release:pack-artifacts --out .release-artifacts/tarballs --clean

# 9. (Out of scope for sprints 61–62) Run the actual publish:
#    npm publish packages/pir
#    npm publish packages/codegen-core
#    npm publish packages/codegen-codesys
#    npm publish packages/codegen-rockwell
#    npm publish packages/codegen-siemens
#    npm publish packages/cli
#
#    Strictly in this order — each later package depends on the previous.
#    A future sprint will add `--dry-run` publish smoke + provenance.
```

## What the tool does NOT do

- Does not run `npm publish` for real. `release:publish-dry-run`
  hardcodes `--dry-run` and refuses any forwarded arg that would
  remove it (`--no-dry-run` / `--publish` / `--yes` / `-y`).
- Does not configure registry auth.
- Does not create git tags or GitHub releases.
- Does not sign or generate provenance.
- Does not commit a `CHANGELOG.md` or any specific
  `docs/releases/X.Y.Z.md` — `release:notes` is on-demand only.
- Does not bump versions automatically — `release:plan --write` only
  runs when explicitly passed.

These are intentional next-sprint items. Sprints 61–62 leave the
boundary right before the registry: every release-set check, the pack +
publish dry-run, the changelog scaffold, and the artifact upload are
green, but no real publish has been performed.

## Failure modes the tool catches

`release:check` will fail with one or more of:

| Issue code | When it fires |
| --- | --- |
| `PACKAGE_DIR_MISSING` | A directory listed in `RELEASE_PACKAGE_DIRS` is gone. |
| `PACKAGE_JSON_UNREADABLE` | `package.json` cannot be parsed. |
| `PACKAGE_NAME_MISMATCH` | The on-disk name disagrees with `EXPECTED_PACKAGE_NAMES`. |
| `PACKAGE_PRIVATE` | A candidate was marked `private: true`. |
| `VERSION_INVALID` | Version is not strict `X.Y.Z`. |
| `VERSION_MISMATCH` | Candidates disagree on a single shared version. |
| `MAIN_NOT_DIST` / `TYPES_NOT_DIST` | `main`/`types` does not point at compiled dist. |
| `EXPORTS_DEFAULT_NOT_DIST` / `EXPORTS_TYPES_NOT_DIST` | `exports["."]` regression to source. |
| `FILES_MISSING_DIST` / `FILES_MISSING_SCHEMAS` | Pack would lose required directories. |
| `CLI_BIN_MISSING` / `CLI_SCHEMA_EXPORT_MISSING` | CLI metadata regression. |
| `DEP_WORKSPACE_PROTOCOL` | A runtime dep still uses `workspace:*`. |
| `DEP_RANGE_INVALID` / `DEP_RANGE_MISMATCH` | A range is non-strict-semver or doesn't match the shared version. |
| `NPMRC_LINK_MISSING` | Root `.npmrc` lost `link-workspace-packages=true`. |

`release:plan` adds:

| Issue code | When it fires |
| --- | --- |
| `TARGET_VERSION_INVALID` | `--version` is not strict semver, or `--bump` was requested but candidates disagree on a current version. |
| `TARGET_NOT_INCREMENT` | `--version` is not strictly greater than the current shared version. |

`release:pack-dry-run` adds (one per candidate):

| Issue code | When it fires |
| --- | --- |
| `PACK_NAME_MISMATCH` / `PACK_VERSION_MISMATCH` | npm reports something unexpected for the candidate. |
| `PACK_REQUIRED_MISSING` | A required entry (`package.json`, `dist/index.js`, `dist/index.d.ts`, CLI schemas) is not in the manifest. |
| `PACK_FORBIDDEN_PREFIX` / `PACK_FORBIDDEN_EXACT` / `PACK_FORBIDDEN_SUFFIX` | Source / test / config files leaked into the pack. |

## Failure modes the new tools catch

`release:publish-dry-run` adds:

| Issue code | When it fires |
| --- | --- |
| `PUBLISH_DRY_RUN_SPAWN_FAILED` | `npm` is not on PATH or the spawn errored. |
| `PUBLISH_DRY_RUN_NONZERO` | `npm publish --dry-run` exited non-zero (e.g., npm rejected the tarball before even contacting the registry). |
| `PUBLISH_DRY_RUN_NO_JSON` | stdout could not be parsed as a JSON object — usually paired with a non-zero exit. |
| `PUBLISH_DRY_RUN_NAME_MISMATCH` / `PUBLISH_DRY_RUN_VERSION_MISMATCH` | npm reports a different name / version than the source `package.json`. |
| `PUBLISH_DRY_RUN_NO_FILES` | npm reported an empty `files[]` — pack would publish nothing. |

`release:pack-artifacts` does not have its own issue codes; it reuses
the consistency check and fails fast if the resulting directory does
not contain exactly the six expected tarballs.

## Promoting `next` → `latest` (Sprint 68)

After a release has soaked under `next` long enough for human
inspection, the dist-tag promotion to `latest` is run manually
through the same protected `npm-publish` GitHub Actions environment.
The workflow only mutates dist-tags — it never republishes a tarball.

### Preflight (local)

```sh
# 1. Confirm the version matches every package.json + the npm-view
#    contract holds for the source tag.
pnpm release:check
pnpm release:npm-view --version 0.1.0 --tag next
pnpm release:promote-latest --validate-only --version 0.1.0
```

All three must exit 0 before triggering the workflow.

### Triggering the promote

1. _Actions → Promote latest → Run workflow_.
2. Inputs:
   - `version`: `0.1.0` (the version already on `next`).
   - `registry`: `https://registry.npmjs.org` (default).
   - `confirm`: literal `promote @plccopilot 0.1.0 to latest` (must
     match the runner's `expectedPromoteConfirmation` byte-for-byte).
3. The `preflight` job runs first (validate + read-only `npm view
   @<pkg>@next`). If green, the `promote` job queues for
   environment approval. Approve only after re-reading the inputs.
4. The `promote` job:
   - Re-validates inputs inside the protected `npm-publish`
     environment.
   - Exports `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`.
   - Calls `pnpm release:promote-latest --version <v> --registry <r>
     --confirm "<confirm>"`.
   - The runner queries `npm view @<pkg>@next` per candidate and
     aborts unless every one resolves to `<version>`.
   - For each candidate it queries `npm view @<pkg>@latest` and only
     calls `npm dist-tag add` when the tag doesn't already point at
     `<version>`. Re-runs after success are no-ops.
   - Final phase verifies every `@<pkg>@latest` resolves to
     `<version>`.

### Post-promotion verification

```sh
pnpm release:npm-view      --version 0.1.0 --tag latest
pnpm release:registry-smoke --version 0.1.0
```

Both must pass. Then update [`releases/0.1.0.md`](releases/0.1.0.md)
to record the promotion (date + workflow URL) and tick §5 of
[`first-publish-postmortem.md`](first-publish-postmortem.md) from
"deferred" to "completed".

### Safety contract (encoded in tests)

- Workflow trigger is `workflow_dispatch` only — no push, schedule,
  or pull_request.
- `confirm` input is required and must equal the runner's expected
  string exactly.
- Promote job uses the protected `npm-publish` environment with at
  least one required reviewer.
- The workflow YAML has **no** shell line that runs `npm publish`
  or `npm dist-tag add` directly — only `pnpm release:promote-latest`
  is invoked. The runner's `assertNoPublishSurface` check rejects any
  argv that would inject `publish` / `--publish` / `--no-dry-run`.
- The runner's parser also rejects `--dry-run` / `--no-dry-run` /
  `--publish` / `--yes` / `-y` at parse time (the runner is
  promotion-only; dry-run for npm publish lives in
  `release:publish-dry-run`).
- Idempotent: packages whose `latest` already matches `<version>` are
  skipped, so a re-run after a successful promotion is a no-op.

### Failure modes

| Issue code | When it fires |
| --- | --- |
| `PROMOTE_INPUT_VERSION_REQUIRED/INVALID/MISMATCH` | Operator passed a version that's not strict X.Y.Z, doesn't match the workspace, or is missing. |
| `PROMOTE_INPUT_REGISTRY_INVALID` | `--registry` is empty / not http(s). |
| `PROMOTE_INPUT_CONFIRM_REQUIRED/MISMATCH` | Real-mode confirm is missing or differs from `promote @plccopilot <version> to latest`. |
| `PROMOTE_ENV_VAR_MISSING` | `NODE_AUTH_TOKEN` not present (real mode only). |
| `PROMOTE_TAG_SOURCE_MISMATCH` | Pre-flight: `@<pkg>@next` does not resolve to `<version>`. **Aborts before any dist-tag mutation.** |
| `PROMOTE_TAG_TARGET_MISMATCH` | Post-flight: `@<pkg>@latest` doesn't resolve to `<version>` after the run. |
| `PROMOTE_PACKAGE_NOT_FOUND` | `@<pkg>@next` returned 404 (package or tag missing). |
| `PROMOTE_NPM_VIEW_NONZERO/PARSE_FAILED` | `npm view` exited non-zero or didn't return parseable JSON. |
| `PROMOTE_DIST_TAG_NONZERO/SPAWN_FAILED` | The dist-tag add call itself failed; runner stops immediately and prints partial-state guidance. |

## Creating the GitHub Release (Sprint 69)

After a version has been published to npm under `next` (Sprint 67),
promoted to `latest` (Sprint 68), and the post-promotion verification
has passed, the matching git tag + GitHub Release are created via a
separate manual workflow. This step does **not** mutate npm and never
involves `NPM_TOKEN`.

### What the workflow does

[`.github/workflows/create-github-release.yml`](../.github/workflows/create-github-release.yml)
is `workflow_dispatch`-only with two jobs:

1. **`preflight`** (read-only): runs `release:github --validate-only`,
   `release:npm-view --version <v> --tag latest`, `release:check`, and
   `publish:audit --check`. Fails fast if the workspace, the registry,
   or the release notes are out of shape — no GitHub-side state is
   mutated here.
2. **`create`** (`contents: write`): re-validates inputs, then runs
   `pnpm build:packages-base` + `build:packages-vendor` + `cli:build`
   from a fresh runner, packs the six tarballs via
   `pnpm release:pack-artifacts --out .release-artifacts/tarballs --clean`,
   and shells out to `pnpm release:github` with the operator-supplied
   confirm. The runner builds the `gh release create` argv via
   `buildGhReleaseCreateArgs` (frozen), calls
   `assertNoNpmMutationSurface`, refuses if a release for the tag
   already exists, then spawns `gh` with `GH_TOKEN` from
   `secrets.GITHUB_TOKEN`.

### Inputs

| Input | Value |
| --- | --- |
| `version` | the npm version that's already on `latest` (e.g. `0.1.0`) |
| `tag` | must equal `v<version>` (e.g. `v0.1.0`) |
| `registry` | `https://registry.npmjs.org` (default) |
| `confirm` | literal `create GitHub release v<version>` (byte-for-byte) |

### Preflight (local, no GitHub)

```sh
pnpm release:github --validate-only --version 0.1.0 --tag v0.1.0
pnpm release:npm-view --version 0.1.0 --tag latest
```

Both must exit 0 before triggering the workflow. The first checks the
workspace + the live `docs/releases/0.1.0.md` against the GitHub-Release
contract; the second confirms the version really is on `latest` on
the registry.

### Triggering

1. _Actions → Create GitHub Release → Run workflow_.
2. Inputs as above.
3. Approve when the create job queues for environment review (only if
   you've configured an environment on the workflow; the default
   `contents: write` permission alone does not require approval, and
   the workflow does not declare an environment for this release).
4. After success, paste the release URL + tag URL into
   `docs/releases/<version>.md` (replacing the `<paste …>` placeholders
   in the GitHub Release section) and remove the **Status: pending**
   line.

### Tag-pointing decision

The npm tarballs were published from the Sprint 67 commit, before the
Sprint 68 + 69 closeout docs landed. `v0.1.0` is intentionally placed
on the **release-closeout commit** (current `HEAD` when the workflow
runs), not on the publish commit:

- The npm tarballs are immutable. `git tag` placement does not change
  what the registry serves.
- The closeout commit is the complete release record — it includes the
  filled postmortem, the promoted-to-latest doc, and the GitHub
  Release tooling itself.
- Future patches (`v0.1.1`) will get a new tag at their own publish
  commit, so the historical separation is preserved per-version.

If a future release needs strict source-tarball parity (e.g. for a
reproducible-build attestation), it can pass `--target <sha>` to
`gh release create` from a custom branch — but Sprint 69 does not.

### Safety contract (encoded in tests)

- Workflow trigger is `workflow_dispatch` only — no push, schedule,
  or pull_request.
- Top-level `permissions: contents: read`; only the `create` job
  upgrades to `contents: write`.
- The runner asserts every gh argv with `assertNoNpmMutationSurface`
  before spawn — `publish` / `--publish` / `--no-dry-run` / `dist-tag`
  / `npm` tokens are refused.
- The parser also rejects `--publish` / `--dry-run` / `--no-dry-run`
  / `--dist-tag` / `--yes` / `-y` at parse time.
- Workflow YAML has **no** `npm publish` / `npm dist-tag` shell line —
  only `gh release create` (via `pnpm release:github`).
- `release:github --validate-only` rejects release notes that still
  contain `planned first npm release — pending` or
  `Do not promote to latest yet`, missing `latest` mention, or any
  missing release-candidate package name.

### Failure modes

| Issue code | When it fires |
| --- | --- |
| `GITHUB_RELEASE_VERSION_REQUIRED/INVALID/MISMATCH` | `--version` is missing, not strict X.Y.Z, or doesn't match the workspace. |
| `GITHUB_RELEASE_TAG_REQUIRED/MISMATCH` | `--tag` is missing or doesn't equal `v<version>`. |
| `GITHUB_RELEASE_CONFIRM_REQUIRED/MISMATCH` | Real-mode confirm is missing or differs from `create GitHub release v<version>`. |
| `GITHUB_RELEASE_NOTES_MISSING` | `docs/releases/<version>.md` does not exist or is empty. |
| `GITHUB_RELEASE_NOTES_PENDING_STATUS` | Release notes still contain a historical "pending" / "do not promote" phrase. |
| `GITHUB_RELEASE_NOTES_LATEST_MISSING` | Release notes do not mention the `latest` dist-tag. |
| `GITHUB_RELEASE_NOTES_PACKAGE_MISSING` | Release notes do not list every release candidate. |
| `GITHUB_RELEASE_NOTES_VERSION_MISSING` | Release notes do not mention the version string. |
| `GITHUB_RELEASE_ASSET_MISSING` | Tarball / manifest count is wrong, a path is not `.tgz`, or a file is missing on disk. |
| `GITHUB_RELEASE_ARG_UNKNOWN` | An argv flag hints at npm mutation (`--publish` / `--dist-tag` / etc.) and is rejected at parse time. |

## Manual npm publish workflow (Sprint 63)

The repo ships a manual publish pipeline at
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml). It
is the **only** path that can land a real `npm publish` — there is no
codepath in normal CI, no scheduled trigger, and no `npm publish` shell
command anywhere outside the runner.

### Triggering a dry-run

1. Open _Actions → Publish packages_.
2. Click _Run workflow_.
3. Inputs:
   - `version`: must match every `packages/*/package.json#version`
     (today: `0.1.0`).
   - `npm_tag`: one of `next` / `latest` / `beta`.
   - `dry_run`: **leave true (default)**.
   - `confirm`: empty.
4. Submit. Only the `preflight` job runs:
   - `pnpm release:publish-real --validate-only --version $version --tag $npm_tag`
   - `pnpm run ci` (full contract gate, including `release:publish-dry-run`)
   - `pnpm release:pack-artifacts ...` and an artifact upload
     (`plccopilot-publish-preflight-tarballs`, 14-day retention).

A dry-run never contacts the registry for a real publish, never
requires `NPM_TOKEN`, and never enters the protected environment.

### Triggering a real publish

Pre-conditions:

- A successful dry-run for the same `version` + `npm_tag`.
- Tarballs in the dry-run artifact reviewed by a second pair of eyes.
- `NPM_TOKEN` exists as a GitHub Actions secret.
- The `npm-publish` environment is configured with at least one
  required reviewer (manual-approval gate).

Steps:

1. _Actions → Publish packages → Run workflow_.
2. Inputs:
   - `version`: same as in the dry-run.
   - `npm_tag`: same.
   - `dry_run`: `false`.
   - `confirm`: the literal string `publish @plccopilot <version>`
     (e.g., `publish @plccopilot 0.1.0`). The runner refuses to start
     if the string differs by even one character.
3. Submit. The `preflight` job runs; if it passes, the `publish` job
   queues for environment approval. Approve only after re-checking
   the inputs.
4. The `publish` job:
   - re-runs `release:publish-real --validate-only` inside the
     protected environment,
   - exports `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`,
   - calls
     ```sh
     pnpm release:publish-real \
       --version <version> --tag <npm_tag> --confirm "publish @plccopilot <version>"
     ```
   - the runner spawns `npm publish --provenance --access public --tag <npm_tag>`
     for every candidate in this order:
     ```
     @plccopilot/pir
     @plccopilot/codegen-core
     @plccopilot/codegen-codesys
     @plccopilot/codegen-rockwell
     @plccopilot/codegen-siemens
     @plccopilot/cli
     ```
   - it stops on the first non-zero exit and prints a partial-publish
     warning.

### Partial publish recovery

`npm publish` is not transactional across packages. If
`@plccopilot/codegen-core` publishes and `@plccopilot/codegen-codesys`
fails, the registry already holds `core@<version>` and the workflow
exits 1.

Recovery path:

1. **Do not rerun the workflow with the same `version`.** npm rejects
   re-publishing an existing version.
2. Diagnose the failure (registry error, network, tarball regression).
3. If the cause is a tarball regression, **bump the version** with
   `pnpm release:plan --bump patch --write`, re-run the dry-run,
   review, and start a new real publish.
4. If the cause is registry-side and a single failed package can be
   retried as the same version, do it manually from a trusted shell —
   never resurrect the workflow input to "skip" already-published
   packages, that's a Sprint 64+ feature.

### What the workflow still does NOT do

- Does not create a git tag for the released version.
- Does not open a GitHub Release with notes.
- Does not commit the release-notes file under `docs/releases/`.
- Does not retry / skip-existing on partial publish.
- Does not verify provenance attestations after the fact (the
  registry smoke loads the package end-to-end, but does not assert
  the provenance bundle; that is a future sprint).
- Does not support per-package patch publishes.

These are intentional next-sprint items.

## Post-publish verification (Sprints 64–65)

After a successful real publish, run the three layered checks from the
`Post-publish verify` workflow (or locally, in the same order):

```sh
# 1. Local-only stub — no registry contact.
pnpm release:provenance --version 0.1.0

# 2. Registry metadata for every candidate. Optional tag check resolves
#    @plccopilot/<pkg>@<tag> back to the same version.
pnpm release:npm-view --version 0.1.0 --tag next

# 3. Full install + bin smoke from a real registry into os.tmpdir().
pnpm release:registry-smoke --version 0.1.0
```

GitHub: _Actions → Post-publish verify → Run workflow_. Inputs:
`version`, `registry` (default `https://registry.npmjs.org`),
`npm_tag` (default `next`), `check_tag` (default `true`). The workflow
runs `provenance` → `npm-view` → `registry-smoke` in that order so a
broken publish workflow surfaces *before* hitting the network.

All three checks are manual-only — they 404 before the first real
publish, and `pnpm run ci` deliberately does not depend on them. The
full first-publish runbook (npm token creation, environment reviewers,
dry-run + real publish + partial-publish recovery, plus the new
post-publish steps) lives in
[`first-publish-checklist.md`](first-publish-checklist.md).

## First-publish execution pack (Sprints 66 + 67 + 68 + 69)

Sprint 66 wrapped the very-first-publish run in three companion
docs; Sprint 67 closed it out by actually executing the publish
under the `next` dist-tag; **Sprint 68 closeout** promoted the
release to `latest` after the human inspection period passed;
**Sprint 69** added the GitHub Release tooling (workflow + helper +
tests). The actual `git tag v0.1.0` + GitHub Release creation is
operator-driven — see the "Creating the GitHub Release" section
above for the dispatch checklist:

- [`first-publish-checklist.md`](first-publish-checklist.md) —
  execution-sequence runbook with explicit **abort conditions**.
  Preserved verbatim for the next coordinated release.
- [`first-publish-postmortem.md`](first-publish-postmortem.md) —
  filled record of the Sprint 67 publish (preflight ticks, real-publish
  inputs, six published package URLs, post-publish verification, the
  four iterations needed to mitigate npm-provenance corner cases) and
  the Sprint 68 closeout promotion decision: `[x] Yes — promotion
  is justified and completed`, with the `Promote latest` workflow URL
  + post-promotion verification commands.
- [`releases/0.1.0.md`](releases/0.1.0.md) — release notes for
  `0.1.0`. Status flipped twice:
  1. Sprint 67 closeout: `planned first npm release — pending` →
     `released under npm dist-tag next`.
  2. Sprint 68 closeout: → `released and promoted to npm dist-tag
     latest`. The doc preserves both phases of the timeline so a
     future reader can reconstruct the run.

After Sprint 68 closeout, every `@plccopilot/<pkg>` resolves to
`0.1.0` on **both** `next` and `latest`. `npm install @plccopilot/cli`
with no explicit tag installs `0.1.0`.

**Sprint 69 closeout** dispatched the `Create GitHub Release`
workflow on 2026-04-28. The git tag `v0.1.0` and the matching
GitHub Release page now exist; the six release tarballs +
`manifest.json` are attached as Release assets. The
"GitHub Release (Sprint 69)" section of
[`releases/0.1.0.md`](releases/0.1.0.md) records the workflow inputs
verbatim (including the literal `create GitHub release v0.1.0`
confirm string) for postmortem traceability. npm-side state is
unchanged — no tarballs were republished, no dist-tags were
touched.

### Provenance stub scope (Sprint 65)

`release:provenance` is a *stub* — it does NOT pull attestation
bundles from the npm registry. It guards two things, locally:

1. **Publish workflow** (`.github/workflows/publish.yml`) grants
   `id-token: write` to the publish job AND references `--provenance`
   somewhere in its run lines.
2. **Publish command builder**
   (`packages/cli/scripts/release-publish-real-lib.mjs#buildNpmPublishCommand`)
   still emits `--provenance` for every supported tag, AND never
   emits `--dry-run`.

Real attestation-bundle verification (downloading the npm provenance
bundle, walking the certificate chain against Sigstore Fulcio, etc.)
is reserved for a future sprint.

## Future work

- First-real-publish rehearsal — done in Sprint 67.
- Git tag + GitHub Release tooling + execution — done in Sprint 69
  (`v0.1.0` tag + Release page created on 2026-04-28).
- Per-package patch mode for hotfixes.
- Skip-existing / resume-after-partial-failure mode.
- Changelog automation (commit-driven) once the project ships
  user-facing milestones.
- Deep npm-provenance attestation verification (Sigstore Fulcio
  chain walk + OIDC claim matching). Sprint 65 stub only checks the
  publish path is configured for provenance.
