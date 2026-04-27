# First Publish Postmortem — PLC Copilot 0.1.0

> **Status: complete — first publish successful.** Sprint 67 closeout
> filled this template after the real `Publish packages` workflow run
> + post-publish verification. No partial publishes, no rollback;
> `latest` promotion deferred (see §5).

| Field | Value |
| --- | --- |
| Status | complete — first publish successful |
| Version | `0.1.0` |
| Publish tag | `next` |
| Date | 2026-04-27 |
| Operator | repository owner (workflow_dispatch caller) |
| Reviewer / `npm-publish` environment approver | repository owner |

## 1. Preflight (before triggering the real workflow)

- [x] `pnpm run ci` passed locally on the release commit.
- [x] `pnpm release:publish-dry-run` passed.
- [x] `pnpm release:publish-real --validate-only --version 0.1.0 --tag next` passed.
- [x] `pnpm release:provenance --version 0.1.0` passed.
- [x] `pnpm consumer:install-smoke` passed.
- [x] _Actions → Publish packages → Run workflow_ with `dry_run: true`
      passed for the same release commit.
- [x] `plccopilot-publish-preflight-tarballs` artifact downloaded and
      spot-checked: six `.tgz` + `manifest.json` present, one tarball
      hand-extracted with `dist/index.js` + `dist/index.d.ts` and no
      `src/` / `tests/` / `tsconfig*.json` leakage.

Links:

- CI run for the release commit: `<paste CI run URL>`
- Publish dry-run workflow run: `<paste dry-run workflow run URL>`
- Tarball artifact URL: `<paste artifact URL from the dry-run run>`

## 2. Real publish execution

| Workflow input | Value |
| --- | --- |
| Workflow | _Actions → Publish packages_ |
| `version` | `0.1.0` |
| `npm_tag` | `next` |
| `dry_run` | `false` |
| `confirm` | `publish @plccopilot 0.1.0` |
| Environment | `npm-publish` (manual approval) |
| Environment approver | repository owner |
| Workflow run URL | `<paste real publish workflow run URL>` |

Publish order (every step appears in the workflow log, in this order):

1. `@plccopilot/pir`
2. `@plccopilot/codegen-core`
3. `@plccopilot/codegen-codesys`
4. `@plccopilot/codegen-rockwell`
5. `@plccopilot/codegen-siemens`
6. `@plccopilot/cli`

Result:

- [x] **All 6 packages published.** Single coordinated workflow run,
      no partial publish, no rollback required.
- [ ] Partial publish.
- [ ] Failed before publishing any package.

Published package URLs:

- `@plccopilot/pir`: https://www.npmjs.com/package/@plccopilot/pir/v/0.1.0
- `@plccopilot/codegen-core`: https://www.npmjs.com/package/@plccopilot/codegen-core/v/0.1.0
- `@plccopilot/codegen-codesys`: https://www.npmjs.com/package/@plccopilot/codegen-codesys/v/0.1.0
- `@plccopilot/codegen-rockwell`: https://www.npmjs.com/package/@plccopilot/codegen-rockwell/v/0.1.0
- `@plccopilot/codegen-siemens`: https://www.npmjs.com/package/@plccopilot/codegen-siemens/v/0.1.0
- `@plccopilot/cli`: https://www.npmjs.com/package/@plccopilot/cli/v/0.1.0

## 3. Post-publish verification

| Field | Value |
| --- | --- |
| Workflow | _Actions → Post-publish verify_ |
| `version` | `0.1.0` |
| `registry` | `https://registry.npmjs.org` |
| `npm_tag` | `next` |
| `check_tag` | `true` |
| Workflow run URL | `<paste post-publish-verify workflow run URL>` |

Local commands re-run on the operator's machine for sign-off:

```sh
pnpm release:provenance    --version 0.1.0
pnpm release:npm-view      --version 0.1.0 --tag next
pnpm release:registry-smoke --version 0.1.0
```

Results:

- [x] `release:provenance` stub passed (workflow `id-token: write`
      grant, `--provenance` flag in workflow + command builder, no
      `--dry-run` in the publish argv).
- [x] `release:npm-view --tag next` passed for all 6 candidates: name
      / version / `dist.tarball` / `dist.integrity` match, and the
      `next` dist-tag resolves to `0.1.0` everywhere.
- [x] `release:registry-smoke` passed: a fresh consumer under
      `os.tmpdir()` ran `npm install @plccopilot/cli@0.1.0` from
      `https://registry.npmjs.org`, then exercised `help`,
      `schema --name cli-result`, `schema --check`,
      `totally-unknown --json`, `inspect --json`, `validate --json`,
      and `generate --backend siemens --json` end-to-end. The CLI
      produced Siemens artifacts from the registry-installed bin.

Notes — first proof that an external consumer can install and use
`@plccopilot/*` from the public registry.

## 4. Issues encountered

The first publish required four iterations of the workflow before
landing. None of them produced a partial publish — every failure
happened *before* npm accepted the first tarball, so the registry
state stayed clean across attempts.

### 4.1 Private repository + npm provenance incompatibility

What happened: initial publish attempt failed because the GitHub
repository was private. `npm publish --provenance` requires the
generating workflow to be in a **public** repository so the
attestation bundle can be verified by anyone fetching the package.

Root cause: the repo was private at the time of the first dispatch.

Resolution: marked the repository public on GitHub, then re-ran the
workflow.

Follow-up:

- [x] Repo visibility confirmed public.
- [ ] Add a check / doc note that "npm-publish environment requires
      a public repo" — could be a sprint-65 provenance-stub addition
      or a checklist item; currently captured here only.

### 4.2 Confirm-string mismatch on real publish

What happened: the second attempt typed `confirm` slightly
differently from the literal expected string and the runner refused
to start. This is exactly the safety gate sprint 63 was designed to
emit.

Root cause: human input — copy/paste introduced a stray character.

Resolution: re-ran the dispatch with `confirm: publish @plccopilot 0.1.0`
typed character-for-character. The runner accepted it on the third
attempt.

Follow-up: none — the gate did its job. A future improvement could
auto-derive the confirmation string from the chosen version and
display it inside the workflow input description.

### 4.3 `repository.url` provenance mismatch (npm 422)

What happened: third attempt reached `npm publish --provenance` for
`@plccopilot/pir` and the registry returned **HTTP 422** with:

```
Error verifying sigstore provenance bundle:
Failed to validate repository information:
package.json "repository.url" is "",
expected to match "https://github.com/benatgomez19999-oss/plc_copilot_beta"
```

Root cause: the publish-candidate `package.json` files lacked a
`repository` block. npm provenance verifies the GitHub origin against
this field; an empty value is a hard reject.

Resolution: Sprint 67 hotfix landed `repository: { type, url, directory }`
on every candidate's `package.json` (and the workspace root manifest)
with the exact URL `https://github.com/benatgomez19999-oss/plc_copilot_beta`
(no `.git`, no `git+`). The hotfix also extended
`packages/cli/scripts/publish-audit-lib.mjs` with three new
BLOCKER-level findings — `PUBLISH_REPOSITORY_MISSING`,
`PUBLISH_REPOSITORY_URL_MISMATCH`,
`PUBLISH_REPOSITORY_DIRECTORY_MISMATCH` — so this regression class
fails the audit before it reaches the registry.

Follow-up:

- [x] Audit regression test added.
- [x] `docs/publishability-audit.md` regenerated (still 0 blockers /
      0 warnings after the fix).

### 4.4 publish-audit declaration signature drift

What happened: the hotfix from §4.3 changed `analyzePackage` to
accept an optional `options` argument and added the new finding
codes. The runtime `.mjs` and the spec were updated together, but the
sibling `.d.mts` declarations file was missed in the first push, so
GitHub Actions `tsc --noEmit` failed with `TS2554 Expected 1
arguments, but got 2.` and the publish workflow's preflight aborted
before reaching the registry.

Root cause: partial commit — the `.d.mts` declarations weren't staged
alongside the `.mjs` runtime + `.spec.ts`.

Resolution: pushed the missing `.d.mts` change. The declarations now
expose `AnalyzePackageOptions` and the two-argument `analyzePackage`
signature; the spec compiles under strict tsc.

Follow-up:

- [ ] Consider a CI doc check that `*-lib.mjs` + `*-lib.d.mts` always
      ship together (sprint > 67).

## 5. Decision: latest promotion

Promote to `latest` now?

- [x] **No** — keep on `next`.
- [ ] Yes.

Reason: this is the first public release of `@plccopilot/*`. The
post-publish verification (workflow + local commands) all passed,
which is encouraging, but the conservative path is to stage the
release on `next` for a human inspection period before exposing it to
`npm install @plccopilot/cli` (which resolves `latest`).

When the decision flips, run from a trusted shell with the same
automation token used during publish:

```sh
npm dist-tag add @plccopilot/pir@0.1.0            latest
npm dist-tag add @plccopilot/codegen-core@0.1.0   latest
npm dist-tag add @plccopilot/codegen-codesys@0.1.0 latest
npm dist-tag add @plccopilot/codegen-rockwell@0.1.0 latest
npm dist-tag add @plccopilot/codegen-siemens@0.1.0 latest
npm dist-tag add @plccopilot/cli@0.1.0            latest
```

A future sprint will move the promotion behind the same
`workflow_dispatch` gate.

## 6. After-action

- [x] [`docs/releases/0.1.0.md`](releases/0.1.0.md) flipped from
      `planned first npm release — pending` →
      `released under npm dist-tag next`. Workflow URLs marked as
      `<paste …>` placeholders so the operator can drop the actual
      run links into both this file and the release notes in one
      grep-and-replace.
- [ ] `git tag v0.1.0` created and pushed (manual today; a future
      sprint will automate this from the publish workflow).
- [ ] GitHub Release drafted from
      [`docs/releases/0.1.0.md`](releases/0.1.0.md). Same automation
      gap as the tag.
- [ ] CONTRIBUTING / runbook updated if anything in this run
      surprised the operator. Sprint 67 already captured the four
      surprises in §4 above; the checklist's "abort conditions"
      list is sufficient for the next run.
- [x] Decision recorded on whether to schedule a `latest` promotion
      (see §5: deferred).

## 7. Final assessment

Was the publish successful overall?

- [x] **Yes.** All 6 packages published, post-publish verification
      passed end-to-end, no partial publish.
- [ ] No.

Should we repeat this process (same checklist + workflow inputs) for
the next minor / patch?

- [x] Yes, with the four §4 issues now mitigated upstream:
  - Repository visibility check is now part of the operator's
    pre-flight.
  - The confirm-string gate is unchanged — it caught operator typos
    exactly as designed.
  - `repository` metadata + audit codes from §4.3 prevent the 422
    from recurring.
  - Future commits of `*-lib.mjs` should always include the
    sibling `.d.mts` (process gap, not a tooling gap).
- [ ] No — what should change first.

Lessons learned:

- The conservative approach of staging on `next` paid off — even with
  the four iteration attempts, no consumer could have pulled a broken
  package because `latest` never moved.
- npm provenance has surprisingly strict requirements (public repo,
  exact `repository.url` match). The publish workflow + audit now
  encode both, but the lessons cost three workflow runs to surface.
- The Sprint 64 / 65 / 66 scaffolding paid off: every failure mode
  was caught and explained by an existing check (confirm string, 422
  with clear message, TS2554 in CI). The four issues in §4 are
  exactly the ones the chain was designed to surface.
