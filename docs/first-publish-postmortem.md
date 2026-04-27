# First Publish Postmortem — PLC Copilot 0.1.0

> **Status: draft.** This is a fill-in-after-run template prepared in
> Sprint 66. Replace every `TBD`, tick boxes only after the
> corresponding step has actually completed, and update the status
> block once the publish + post-publish verification are signed off.

| Field | Value |
| --- | --- |
| Status | draft |
| Version | `0.1.0` |
| Publish tag | `next` |
| Date | TBD |
| Operator | TBD |
| Reviewer / `npm-publish` environment approver | TBD |

## 1. Preflight (before triggering the real workflow)

- [ ] `pnpm run ci` passed locally on the release commit.
- [ ] `pnpm release:publish-dry-run` passed.
- [ ] `pnpm release:publish-real --validate-only --version 0.1.0 --tag next` passed.
- [ ] `pnpm release:provenance --version 0.1.0` passed.
- [ ] `pnpm consumer:install-smoke` passed.
- [ ] _Actions → Publish packages → Run workflow_ with `dry_run: true`
      passed for the same release commit.
- [ ] `plccopilot-publish-preflight-tarballs` artifact downloaded and
      spot-checked (six `.tgz` + `manifest.json`; one tarball
      hand-extracted; no `src/` / `tests/` / `tsconfig*.json` leakage).

Links (fill in after each step completes):

- CI run: TBD
- Publish dry-run workflow run: TBD
- Tarball artifact URL: TBD

## 2. Real publish execution

| Workflow input | Value |
| --- | --- |
| Workflow | _Actions → Publish packages_ |
| `version` | `0.1.0` |
| `npm_tag` | `next` |
| `dry_run` | `false` |
| `confirm` | `publish @plccopilot 0.1.0` |
| Environment | `npm-publish` (manual approval) |
| Environment approver | TBD |
| Workflow run URL | TBD |

Publish order (each step appears in the workflow log):

1. `@plccopilot/pir`
2. `@plccopilot/codegen-core`
3. `@plccopilot/codegen-codesys`
4. `@plccopilot/codegen-rockwell`
5. `@plccopilot/codegen-siemens`
6. `@plccopilot/cli`

Result (tick exactly one):

- [ ] All 6 packages published.
- [ ] **Partial publish.** Stop and follow §4 below.
- [ ] Failed before publishing any package.

Published package URLs (fill after publish):

- `@plccopilot/pir`: TBD
- `@plccopilot/codegen-core`: TBD
- `@plccopilot/codegen-codesys`: TBD
- `@plccopilot/codegen-rockwell`: TBD
- `@plccopilot/codegen-siemens`: TBD
- `@plccopilot/cli`: TBD

## 3. Post-publish verification

| Field | Value |
| --- | --- |
| Workflow | _Actions → Post-publish verify_ |
| `version` | `0.1.0` |
| `registry` | `https://registry.npmjs.org` |
| `npm_tag` | `next` |
| `check_tag` | `true` |
| Workflow run URL | TBD |

Local commands (re-run on the operator's machine for sign-off):

```sh
pnpm release:provenance    --version 0.1.0
pnpm release:npm-view      --version 0.1.0 --tag next
pnpm release:registry-smoke --version 0.1.0
```

Results (tick after observing each):

- [ ] `release:provenance` stub passed (workflow `id-token: write`
      grant + `--provenance` flag in workflow + command builder).
- [ ] `release:npm-view` passed (name / version / dist.tarball /
      dist.integrity for all 6 candidates; tag `next` resolves to
      `0.1.0`).
- [ ] `release:registry-smoke` passed (`npm install
      @plccopilot/cli@0.1.0` + `help` / `schema --name` /
      `schema --check` / `totally-unknown --json` / `inspect --json` /
      `validate --json` / `generate --backend siemens --json`).

Notes (paste relevant output excerpts):

```
TBD
```

## 4. Issues encountered

> Fill each subsection only if it applies. Leave blank otherwise.

What happened: TBD

Root cause: TBD

Resolution: TBD

Follow-up actions:

- [ ] TBD
- [ ] TBD

### Partial-publish recovery (only if step 2 reported partial)

A partial publish leaves the registry holding versions for the
already-published packages. **Do not rerun the workflow with the same
`version`** — npm rejects re-publishing an existing version. Recovery
options (pick one and document in §4):

1. **Bump and re-publish.** Run
   `pnpm release:plan --bump patch --write`, run dry-run + review,
   then trigger the publish workflow again with the new version. This
   is the safest path.
2. **Manually retry the failed package.** Only if the failure was
   registry-side and the *exact same* version can be retried for the
   *failed* package. Run from a trusted shell with the same token; do
   not resurrect the workflow input to "skip" already-published
   packages.

`--skip-existing` / per-package mode is a future sprint. Sprint 66
deliberately ships no automation for this path.

## 5. Decision: latest promotion

Promote to `latest` now?

- [ ] No — keep on `next`. Reason: TBD
- [ ] Yes — promotion is justified.

If yes, planned commands (run them only after the post-publish
verification in §3 is fully ticked):

```sh
npm dist-tag add @plccopilot/pir@0.1.0            latest
npm dist-tag add @plccopilot/codegen-core@0.1.0   latest
npm dist-tag add @plccopilot/codegen-codesys@0.1.0 latest
npm dist-tag add @plccopilot/codegen-rockwell@0.1.0 latest
npm dist-tag add @plccopilot/codegen-siemens@0.1.0 latest
npm dist-tag add @plccopilot/cli@0.1.0            latest
```

A future sprint will move this behind the same `workflow_dispatch`
gate; today it is manual.

## 6. After-action

- [ ] `docs/releases/0.1.0.md` updated with publish date, workflow
      URLs, and final package URLs. Status flipped from
      "planned first npm release — pending" to "released".
- [ ] `git tag v0.1.0` created and pushed (manual today; sprint 67
      will automate).
- [ ] GitHub Release drafted from
      [`docs/releases/0.1.0.md`](releases/0.1.0.md).
- [ ] CONTRIBUTING / runbook updated if anything in this run
      surprised the operator.
- [ ] Decision recorded on whether to schedule a `latest` promotion.

## 7. Final assessment

Was the publish successful overall?

- [ ] Yes
- [ ] No (explain in §4)

Should we repeat this process (same checklist + workflow inputs) for
the next minor / patch?

- [ ] Yes
- [ ] No — what should change first: TBD

Lessons learned (one or two bullets):

- TBD
