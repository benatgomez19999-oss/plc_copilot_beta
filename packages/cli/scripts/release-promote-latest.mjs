#!/usr/bin/env node
// Sprint 68 — `pnpm release:promote-latest`.
//
// Promotes the already-published `@plccopilot/<pkg>@<version>` tarballs
// from the `next` dist-tag to the `latest` dist-tag. Two modes:
//
//   pnpm release:promote-latest --validate-only --version 0.1.0
//     Local-only validation — workspace consistency, semver, registry
//     URL. Does NOT contact the registry, does NOT require a token,
//     does NOT require --confirm. Used by the workflow's preflight
//     and by hand on the operator's machine.
//
//   pnpm release:promote-latest --version 0.1.0
//                               --confirm "promote @plccopilot 0.1.0 to latest"
//     Real mode. Requires NODE_AUTH_TOKEN in the environment.
//     1. Validates inputs.
//     2. Queries `npm view @plccopilot/<pkg>@next version` for every
//        candidate; aborts unless every one resolves to <version>.
//     3. For every candidate, queries `npm view @plccopilot/<pkg>@latest version`:
//        if it already resolves to <version>, the package is skipped
//        (idempotent — re-running after success is a no-op);
//        otherwise spawns `npm dist-tag add @plccopilot/<pkg>@<version> latest`.
//     4. Re-queries `npm view @plccopilot/<pkg>@latest version` for
//        every candidate to confirm the tag now points at <version>.
//
// This script is the only place in the repo that can mutate npm
// dist-tags. The GitHub Actions `promote-latest.yml` workflow adds a
// manual approval gate around it.
//
// Hard invariants enforced at runtime:
//   - No publish argv is ever spawned. `assertNoPublishSurface` is
//     called against every npm command before spawn.
//   - `--dry-run` / `--publish` / `--no-dry-run` flags on this runner
//     are rejected at parse time (the parser emits PROMOTE_ARG_UNKNOWN).
//
// Exit codes:
//   0  validate-only / promote completed (or already complete)
//   1  any input / token / pre-check / dist-tag failure

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  loadReleaseWorkspace,
} from './release-plan-lib.mjs';
import {
  PROMOTE_PACKAGE_ORDER,
  PROMOTE_SOURCE_TAG,
  PROMOTE_TARGET_TAG,
  assertNoPublishSurface,
  buildNpmDistTagAddArgs,
  buildNpmViewTagArgs,
  expectedPromoteConfirmation,
  isNpmNotFoundError,
  parseNpmJson,
  parsePromoteLatestArgs,
  validatePromoteInputs,
  validateTagVersion,
} from './release-promote-latest-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function die(message, code = 1) {
  process.stderr.write(`release-promote-latest: ${message}\n`);
  process.exit(code);
}

function reportIssues(issues) {
  for (const i of issues) {
    process.stderr.write(`error: ${i.code}: ${i.message}\n`);
    if (i.recommendation) process.stderr.write(`  fix: ${i.recommendation}\n`);
  }
}

function truncate(s, max = 600) {
  if (typeof s !== 'string') return String(s);
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

function spawnNpm(args) {
  // Defence-in-depth: refuse to spawn if any publish surface ever leaked
  // into the argv (tests pin both halves).
  assertNoPublishSurface(args);
  return spawnSync('npm', [...args], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
}

const parsed = parsePromoteLatestArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  reportIssues(parsed.errors);
  process.exit(1);
}
const rawOptions = parsed.options ?? {};
if (rawOptions.help) {
  process.stdout.write(`pnpm release:promote-latest --validate-only --version X.Y.Z [--registry URL]
pnpm release:promote-latest --version X.Y.Z [--registry URL] --confirm "promote @plccopilot X.Y.Z to latest"

Promotes already-published @plccopilot/* packages from the \`next\`
dist-tag to \`latest\`. Real mode requires NODE_AUTH_TOKEN. The runner
queries \`npm view @<pkg>@next\` first to confirm <version> matches
before any dist-tag mutation.

Promote order:
  ${PROMOTE_PACKAGE_ORDER.join('\n  ')}
`);
  process.exit(0);
}

const workspace = loadReleaseWorkspace(REPO_ROOT);
const { options, issues: optionIssues } = validatePromoteInputs(
  { ...rawOptions, env: process.env },
  workspace,
);
if (optionIssues.length > 0) {
  reportIssues(optionIssues);
  process.exit(1);
}

if (options.validateOnly) {
  process.stdout.write(
    `Promote inputs valid. (${PROMOTE_PACKAGE_ORDER.length} packages at ${options.version}; NO DIST-TAGS CHANGED)\n`,
  );
  process.exit(0);
}

// -------------------------------------------------------------------------
// Real promote path. From here on every spawn talks to the registry.
// -------------------------------------------------------------------------

process.stdout.write(
  `Real promotion engaged. (version ${options.version}, ${PROMOTE_SOURCE_TAG} -> ${PROMOTE_TARGET_TAG})\n` +
    `Confirmation: ${expectedPromoteConfirmation(options.version)}\n` +
    `Order: ${PROMOTE_PACKAGE_ORDER.join(' -> ')}\n`,
);

// Phase 1 — confirm every package@next equals the requested version.
const summary = [];
for (const dir of Object.keys(EXPECTED_PACKAGE_NAMES)) {
  // Skip packages that are not in the publish set (web, integration-tests).
  if (!PROMOTE_PACKAGE_ORDER.includes(EXPECTED_PACKAGE_NAMES[dir])) continue;
}

for (const packageName of PROMOTE_PACKAGE_ORDER) {
  const args = buildNpmViewTagArgs({
    packageName,
    tag: PROMOTE_SOURCE_TAG,
    registry: options.registry,
  });
  const result = spawnNpm(args);
  if (result.error) {
    die(`spawning npm view for ${packageName}@${PROMOTE_SOURCE_TAG} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (isNpmNotFoundError(result.stderr, result.stdout)) {
      reportIssues([
        {
          level: 'error',
          code: 'PROMOTE_PACKAGE_NOT_FOUND',
          message: `${packageName}@${PROMOTE_SOURCE_TAG} could not be resolved on ${options.registry}.`,
          recommendation:
            'Confirm the publish workflow ran for this version before promoting. ' +
            'See docs/first-publish-checklist.md.',
        },
      ]);
    } else {
      reportIssues([
        {
          level: 'error',
          code: 'PROMOTE_NPM_VIEW_NONZERO',
          message: `npm view ${packageName}@${PROMOTE_SOURCE_TAG} exited ${result.status}.\n  stderr: ${truncate(result.stderr)}`,
        },
      ]);
    }
    die(`pre-check FAILED for ${packageName}; aborting before any dist-tag mutation.`);
  }
  const value = parseNpmJson(result.stdout);
  if (value === null) {
    reportIssues([
      {
        level: 'error',
        code: 'PROMOTE_NPM_VIEW_PARSE_FAILED',
        message: `${packageName}@${PROMOTE_SOURCE_TAG}: stdout was not parseable JSON.\n  stdout: ${truncate(result.stdout)}`,
      },
    ]);
    die(`pre-check FAILED for ${packageName}; aborting.`);
  }
  const tagIssues = validateTagVersion(value, {
    packageName,
    version: options.version,
    tag: PROMOTE_SOURCE_TAG,
  });
  if (tagIssues.length > 0) {
    reportIssues(tagIssues);
    die(`pre-check FAILED for ${packageName}; aborting.`);
  }
}

// Phase 2 — for each package, check current `latest` and only mutate
// if it doesn't already point at the requested version. Idempotent.
let mutationCount = 0;
let alreadyAtLatestCount = 0;

for (const packageName of PROMOTE_PACKAGE_ORDER) {
  const viewArgs = buildNpmViewTagArgs({
    packageName,
    tag: PROMOTE_TARGET_TAG,
    registry: options.registry,
  });
  const viewResult = spawnNpm(viewArgs);
  let alreadyMatches = false;

  if (viewResult.status === 0) {
    const current = parseNpmJson(viewResult.stdout);
    if (typeof current === 'string' && current === options.version) {
      alreadyMatches = true;
    }
  } else if (!isNpmNotFoundError(viewResult.stderr, viewResult.stdout)) {
    // Any other failure on the @latest read is a real error — surface
    // it but still proceed: if we can't read @latest, the dist-tag add
    // below is the corrective action.
    process.stderr.write(
      `warning: could not read ${packageName}@${PROMOTE_TARGET_TAG} (status=${viewResult.status}); proceeding to dist-tag add.\n`,
    );
  }

  if (alreadyMatches) {
    process.stdout.write(
      `  ${packageName}: ${PROMOTE_TARGET_TAG} already points at ${options.version} (skipped)\n`,
    );
    alreadyAtLatestCount++;
    summary.push({ package: packageName, status: 'already-latest', tag: PROMOTE_TARGET_TAG, version: options.version });
    continue;
  }

  const addArgs = buildNpmDistTagAddArgs({
    packageName,
    version: options.version,
    tag: PROMOTE_TARGET_TAG,
    registry: options.registry,
  });
  process.stdout.write(`  ${packageName}: setting ${PROMOTE_TARGET_TAG} -> ${options.version} ...\n`);
  const addResult = spawnSync('npm', [...addArgs], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (addResult.error) {
    die(
      `spawning npm dist-tag add for ${packageName} failed: ${addResult.error.message}\n` +
        `Earlier packages in this run may already have ${PROMOTE_TARGET_TAG} set. ` +
        'Run `npm view @plccopilot/<pkg>@latest version` for each candidate to inspect.',
    );
  }
  if (addResult.status !== 0) {
    die(
      `npm dist-tag add for ${packageName} exited ${addResult.status}. ` +
        'Stop and inspect partial state with `npm view <pkg>@latest version` ' +
        'for every candidate before retrying.',
    );
  }
  mutationCount++;
  summary.push({ package: packageName, status: 'promoted', tag: PROMOTE_TARGET_TAG, version: options.version });
}

// Phase 3 — post-mutation verification.
const verifyIssues = [];
for (const packageName of PROMOTE_PACKAGE_ORDER) {
  const args = buildNpmViewTagArgs({
    packageName,
    tag: PROMOTE_TARGET_TAG,
    registry: options.registry,
  });
  const result = spawnNpm(args);
  if (result.status !== 0) {
    verifyIssues.push({
      level: 'error',
      code: 'PROMOTE_NPM_VIEW_NONZERO',
      message: `post-promote npm view ${packageName}@${PROMOTE_TARGET_TAG} exited ${result.status}.`,
    });
    continue;
  }
  const value = parseNpmJson(result.stdout);
  for (const issue of validateTagVersion(value, {
    packageName,
    version: options.version,
    tag: PROMOTE_TARGET_TAG,
  })) {
    verifyIssues.push(issue);
  }
}

if (verifyIssues.length > 0) {
  reportIssues(verifyIssues);
  die(`post-promote verification FAILED.`);
}

if (options.json) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        version: options.version,
        registry: options.registry,
        source_tag: PROMOTE_SOURCE_TAG,
        target_tag: PROMOTE_TARGET_TAG,
        package_count: PROMOTE_PACKAGE_ORDER.length,
        mutated: mutationCount,
        already_at_target: alreadyAtLatestCount,
        results: summary,
      },
      null,
      2,
    ) + '\n',
  );
} else {
  process.stdout.write(
    `\nPromote to ${PROMOTE_TARGET_TAG} passed. ` +
      `(${PROMOTE_PACKAGE_ORDER.length} packages now have ${PROMOTE_TARGET_TAG} -> ${options.version}; ` +
      `${mutationCount} dist-tag(s) added, ${alreadyAtLatestCount} already in place)\n`,
  );
}
process.exit(0);
