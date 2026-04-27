# First Publish Checklist

This is the operational runbook for the **first real** `npm publish` of
the `@plccopilot/*` packages. The repo's CI / smoke / release tooling
already proves the artefacts are correct; this checklist captures the
one-time human steps around the publish itself.

After the first publish lands, future bumps follow the standard flow in
[`release-process.md`](release-process.md) — this checklist exists
mainly so the very first run is not winging it.

## Companion documents

- [`releases/0.1.0.md`](releases/0.1.0.md) — release notes for the
  first publish. Sprint 67 closeout flipped the status to
  `released under npm dist-tag next` once the workflow + post-publish
  verification both passed.
- [`first-publish-postmortem.md`](first-publish-postmortem.md) — the
  filled record of the Sprint 67 run, including the four iterations
  that hit (private repo + provenance, confirm-string mismatch,
  `repository.url` provenance 422, publish-audit declaration drift)
  before the final successful publish.

> **Status: first publish complete.** The runbook below is preserved
> for the next coordinated release. The four issues that surfaced on
> the first attempt are now mitigated upstream — see the postmortem's
> §4 for details and the audit's `PUBLISH_REPOSITORY_*` codes for the
> regression guard.

## Execution sequence (TL;DR)

1. **Prereqs** — npm scope, names, 2FA, granular token (§1–§2 below).
2. **Local preflight** — `pnpm run ci`,
   `pnpm release:publish-dry-run`,
   `pnpm release:publish-real --validate-only --version 0.1.0 --tag next`,
   `pnpm release:provenance --version 0.1.0` (§3).
3. **GitHub dry-run** — _Actions → Publish packages → Run workflow_,
   `dry_run: true`, inspect tarball artifact (§4).
4. **Real publish** — _Actions → Publish packages → Run workflow_,
   `dry_run: false`, `confirm: publish @plccopilot 0.1.0` (§5).
5. **Post-publish** — _Actions → Post-publish verify → Run workflow_
   (`check_tag: true`) (§6) and run the local commands from the
   [postmortem template](first-publish-postmortem.md#3-post-publish-verification).
6. **Fill** [`first-publish-postmortem.md`](first-publish-postmortem.md)
   and update [`releases/0.1.0.md`](releases/0.1.0.md) once
   verification is green (§9).

## Abort conditions

Stop and **do not** proceed to the real publish in §5 if any of these
are true:

- Local `pnpm run ci` failed.
- `pnpm release:publish-dry-run` failed.
- `pnpm release:publish-real --validate-only ...` failed.
- `pnpm release:provenance` failed (publish workflow lost
  `id-token: write`, `--provenance`, or the command-builder
  invariant).
- The GitHub `Publish packages` `dry_run: true` run did not finish
  green.
- The `plccopilot-publish-preflight-tarballs` artifact is missing
  or the manifest doesn't list six tarballs.
- `secrets.NPM_TOKEN` is not configured (or has expired).
- The `npm-publish` GitHub Actions environment has no required
  reviewer.
- The operator cannot type the `confirm` string
  (`publish @plccopilot 0.1.0`) exactly — including spaces, case,
  and no trailing newline.

## Publish candidates (publish order)

1. `@plccopilot/pir`
2. `@plccopilot/codegen-core`
3. `@plccopilot/codegen-codesys`
4. `@plccopilot/codegen-rockwell`
5. `@plccopilot/codegen-siemens`
6. `@plccopilot/cli`

## 1. Registry / scope prerequisites

- [ ] An npm account with publish rights on the `@plccopilot` scope.
      If the scope does not yet exist on npm, create it under the
      target organisation (`Settings → Organizations → Create`).
- [ ] All six package names resolve to "not found" or to your scope —
      verify with `npm view @plccopilot/pir`, etc. If a name is taken
      by an unrelated user, stop and rename here before publishing.
- [ ] Two-factor auth on the npm account is set to "auth-only" or
      higher (npm requires 2FA on publish for new packages).
- [ ] An organisation **automation token** with `publish` rights is
      generated and copied (it is shown once).

## 2. GitHub repo prerequisites

- [ ] `secrets.NPM_TOKEN` exists at the repo level (or org level
      shared to this repo) — paste the automation token from step 1.
- [ ] The `npm-publish` GitHub Actions environment exists
      (`Settings → Environments → npm-publish`).
- [ ] The environment has at least one **required reviewer** — the
      manual-approval gate is the last human checkpoint before a
      registry write.
- [ ] The repo has `id-token: write` allowed for the publish workflow
      (already set in
      [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
      under the `publish` job's `permissions:`). Provenance requires it.

## 3. Local preflight

Run from a clean checkout of the branch you intend to release:

```sh
git status                               # working tree clean
pnpm install --frozen-lockfile

pnpm run ci                              # full Sprint 53–63 contract gate
pnpm release:check                       # cross-package release metadata
pnpm release:pack-dry-run                # npm pack --dry-run for every candidate
pnpm release:publish-dry-run             # npm publish --dry-run for every candidate
pnpm release:publish-real --validate-only --version 0.1.0 --tag next
pnpm release:notes --bump patch          # eyeball the next-bump scaffold (informational)
```

Every command above must exit 0. If any step fails, stop and fix
before involving the registry.

## 4. GitHub dry-run

1. Open _Actions → Publish packages_.
2. _Run workflow_:
   - `version`: `0.1.0`
   - `npm_tag`: `next` (recommended for the very first publish)
   - `dry_run`: **true** (default)
   - `confirm`: empty
3. Wait for the `preflight` job to complete.
4. Download the `plccopilot-publish-preflight-tarballs` artifact and
   spot-check:
   - exactly six `*.tgz` files,
   - `manifest.json` lists all six with the expected version,
   - randomly extract one tarball and verify it contains `dist/index.js`
     + `dist/index.d.ts` and no source / tests / config leakage.

## 5. Real publish

> Only proceed after step 4 is green AND a second pair of eyes has
> reviewed the artefacts.

1. _Actions → Publish packages → Run workflow_.
2. Inputs:
   - `version`: `0.1.0` (same as the dry-run).
   - `npm_tag`: `next` (recommended for first publish — promote later).
   - `dry_run`: **false**.
   - `confirm`: literal `publish @plccopilot 0.1.0` (exact, including
     spaces, no trailing newline). The runner refuses to start if
     this differs by even one character.
3. The `preflight` job runs first. The `publish` job then queues for
   environment approval — open the run page and approve only after
   re-reading the inputs.
4. The `publish` job:
   - Re-validates inputs inside the protected environment.
   - Exports `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`.
   - Calls `pnpm release:publish-real --version <v> --tag <tag>
     --confirm "publish @plccopilot <v>"`.
   - The runner spawns
     `npm publish --provenance --access public --tag <tag>` for each
     candidate in publish order and stops on the first failure.

## 6. Post-publish verification

Once the workflow finishes successfully, run the layered audit added
in Sprint 65 — locally first, then in CI for sign-off.

Either run all three from a single dispatch:

- [ ] _Actions → Post-publish verify → Run workflow_ with the same
      `version` / `registry` / `npm_tag` you used to publish.
      The workflow runs `release:provenance` → `release:npm-view` →
      `release:registry-smoke` in order so a broken publish path
      fails before any network call.

Or step-by-step locally:

- [ ] Local provenance stub (no registry contact, fastest signal):
  ```sh
  pnpm release:provenance --version 0.1.0
  ```
  Confirms the publish workflow YAML still grants `id-token: write`
  and references `--provenance`, and that the publish command builder
  hardcodes `--provenance` for every supported tag.
- [ ] Registry metadata for every candidate (with tag check):
  ```sh
  pnpm release:npm-view --version 0.1.0 --tag next
  ```
  Validates `name` / `version` / `dist.tarball` / `dist.integrity`
  per package and asserts that the `next` dist-tag resolves to the
  same version.
- [ ] Full install + bin smoke from registry:
  ```sh
  pnpm release:registry-smoke --version 0.1.0
  ```
  `npm install`s `@plccopilot/cli@0.1.0` into a fresh temp project
  and exercises `help`, `schema --name`, `schema --check`,
  `totally-unknown --json`, `inspect --json`, `validate --json`, and
  `generate --backend siemens --json`. **This is the first proof
  that an external consumer can actually use the package.**
- [ ] Spot-check the provenance badge on each package's npm page
      (small "Provenance" indicator). Sprint 65's stub does not
      verify the attestation bundle yet — a future sprint will.

## 7. Promote to `latest` (optional, later)

The first publish ships under the `next` tag so a real bug doesn't
poison consumers running `npm install @plccopilot/cli`. Once the
release has soaked for a day or two (and the post-publish smoke is
green) promote:

```sh
npm dist-tag add @plccopilot/cli@0.1.0 latest
# repeat for each of the other 5 packages
```

A future sprint may automate this from the workflow.

## 8. Partial publish recovery

If the publish job exits non-zero partway through, the registry
already holds every package up to the failed one, but **not** the
later ones. npm does not support transactional cross-package publishes.

Recovery:

1. **Do not rerun the workflow with the same `version`.** npm will
   reject re-publishing an already-published version.
2. Diagnose the failure (network glitch, registry rejection,
   tarball regression).
3. If the cause is a tarball regression, bump the version with
   `pnpm release:plan --bump patch --write`, run the dry-run again,
   review, and start a brand-new real publish for the new version.
4. If the cause is registry-side and the same version can be retried
   for the failed package, do it manually from a trusted shell with
   the same token — never resurrect the workflow input to "skip"
   already-published packages, that's a Sprint 66+ feature.

## 9. After-action checklist

- [ ] Tag the commit (manual `git tag v0.1.0 && git push --tags` for
      now — automation arrives in a later sprint).
- [ ] Open a GitHub Release and paste the rendered `release:notes`
      output (or generate `docs/releases/0.1.0.md` from the scaffold).
- [ ] Update `docs/release-process.md` if anything in the runbook
      surprised you — the next person doing this should not hit the
      same surprise.
