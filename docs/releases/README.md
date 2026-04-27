# Release Notes Index

Release notes for `@plccopilot/*` packages live next to this file as
`docs/releases/X.Y.Z.md`. They are **scaffolds** — generate one with:

```sh
pnpm release:notes --bump patch > docs/releases/0.1.1.md
# or
pnpm release:notes --version 0.2.0 > docs/releases/0.2.0.md
```

The generator is deterministic: no timestamps, stable ordering across all
six publish candidates. It expects the workspace to be release-consistent
(`pnpm release:check` passes) and renders the `Highlights` section as
explicit `TODO:` lines that an editor must replace before the actual
publish.

Sprint 66 lands the very first hand-curated release notes file at
[`0.1.0.md`](0.1.0.md). Its status starts as
**`planned first npm release — pending`** because the publish
workflow has not actually run yet — the file is the scaffold the
operator updates immediately after the publish + post-publish
verification are signed off (see
[`../first-publish-postmortem.md`](../first-publish-postmortem.md)).

Commits after the first publish will start landing additional
`X.Y.Z.md` files alongside the corresponding version bumps.

See [`../release-process.md`](../release-process.md) for the full release
flow and [`../first-publish-checklist.md`](../first-publish-checklist.md)
for the very-first-run operational runbook.
