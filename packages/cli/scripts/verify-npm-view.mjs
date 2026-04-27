#!/usr/bin/env node
// Sprint 65 — `pnpm release:npm-view`.
//
// Manual post-publish gate: queries `npm view <pkg>@<version>` for
// every release candidate, verifies the registry payload (name,
// version, dist.tarball, dist.integrity), and optionally checks that
// a dist-tag (next/latest/beta) resolves to the same version.
//
// Not in `pnpm run ci` — this command 404s before the first real
// publish. Manual command + the post-publish-verify workflow are the
// only paths that run it.
//
// Modes:
//   pnpm release:npm-view                           # workspace version, npmjs.org
//   pnpm release:npm-view --version 0.1.0
//   pnpm release:npm-view --tag next                # also verify the dist-tag
//   pnpm release:npm-view --registry https://...
//   pnpm release:npm-view --json                    # machine-readable summary
//   pnpm release:npm-view --help

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  RELEASE_PACKAGE_DIRS,
  loadReleaseWorkspace,
} from './release-plan-lib.mjs';
import {
  buildNpmViewPackageArgs,
  buildNpmViewTagArgs,
  expectedForCandidate,
  isNpmViewNotFoundError,
  parseNpmViewArgs,
  parseNpmViewJson,
  validateNpmViewOptions,
  validateNpmViewPackageMetadata,
  validateNpmViewTagVersion,
} from './verify-npm-view-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function reportIssues(issues) {
  for (const i of issues) {
    const head = i.package ? `${i.package} — ${i.code}` : i.code;
    process.stderr.write(`error: ${head}: ${i.message}\n`);
    if (i.recommendation) process.stderr.write(`  fix: ${i.recommendation}\n`);
  }
}

function truncate(s, max = 600) {
  if (typeof s !== 'string') return String(s);
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

const parsed = parseNpmViewArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  reportIssues(parsed.errors);
  process.exit(1);
}
const rawOptions = parsed.options ?? {};
if (rawOptions.help) {
  process.stdout.write(`pnpm release:npm-view [--version X.Y.Z] [--tag next|latest|beta] [--registry URL] [--json]

Manual post-publish gate. Queries the registry for every release
candidate's metadata and reports any mismatch. Not part of \`pnpm run ci\`.

Defaults:
  --version  workspace shared version (today: 0.1.0)
  --registry https://registry.npmjs.org
`);
  process.exit(0);
}

const workspace = loadReleaseWorkspace(REPO_ROOT);
const { options, issues: optionIssues } = validateNpmViewOptions(rawOptions, workspace);
if (optionIssues.length > 0) {
  reportIssues(optionIssues);
  process.exit(1);
}

let totalIssues = 0;
const summary = [];

for (const dir of RELEASE_PACKAGE_DIRS) {
  const expected = expectedForCandidate(dir, options.version, options.tag ?? null);

  // 1. version metadata
  const viewArgs = buildNpmViewPackageArgs({
    packageName: expected.name,
    version: options.version,
    registry: options.registry,
  });
  const viewResult = spawnSync('npm', [...viewArgs], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  if (viewResult.error) {
    reportIssues([
      {
        level: 'error',
        code: 'NPM_VIEW_SPAWN_FAILED',
        package: expected.name,
        message: `spawning npm view failed: ${viewResult.error.message}`,
        recommendation: 'Check that npm is on PATH.',
      },
    ]);
    totalIssues++;
    continue;
  }
  if (viewResult.status !== 0) {
    if (isNpmViewNotFoundError(viewResult.stderr, viewResult.stdout)) {
      reportIssues([
        {
          level: 'error',
          code: 'NPM_VIEW_NOT_FOUND',
          package: expected.name,
          message: `npm view could not find ${expected.name}@${options.version} on ${options.registry}.`,
          recommendation:
            'This is expected before the first real publish. Run after the publish workflow completes.',
        },
      ]);
    } else {
      reportIssues([
        {
          level: 'error',
          code: 'NPM_VIEW_NONZERO',
          package: expected.name,
          message: `npm view exited ${viewResult.status}.\n  stderr: ${truncate(viewResult.stderr)}`,
          recommendation: null,
        },
      ]);
    }
    totalIssues++;
    summary.push({ name: expected.name, status: 'failed' });
    continue;
  }

  const metadata = parseNpmViewJson(viewResult.stdout);
  const metadataIssues = validateNpmViewPackageMetadata(metadata, expected);
  if (metadataIssues.length > 0) {
    reportIssues(metadataIssues);
    totalIssues += metadataIssues.length;
    summary.push({ name: expected.name, status: 'failed' });
    continue;
  }

  const entry = {
    name: expected.name,
    version: metadata.version,
    tarball: metadata.dist?.tarball ?? null,
    integrity: metadata.dist?.integrity ?? null,
    shasum: metadata.dist?.shasum ?? null,
    tag_version: null,
  };

  // 2. optional tag check
  if (options.tag) {
    const tagArgs = buildNpmViewTagArgs({
      packageName: expected.name,
      tag: options.tag,
      registry: options.registry,
    });
    const tagResult = spawnSync('npm', [...tagArgs], {
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    });
    if (tagResult.status !== 0) {
      const code = isNpmViewNotFoundError(tagResult.stderr, tagResult.stdout)
        ? 'NPM_VIEW_TAG_NOT_FOUND'
        : 'NPM_VIEW_TAG_NONZERO';
      reportIssues([
        {
          level: 'error',
          code,
          package: expected.name,
          message: `npm view tag ${JSON.stringify(options.tag)} failed (status=${tagResult.status}).`,
          recommendation:
            code === 'NPM_VIEW_TAG_NOT_FOUND'
              ? 'Set the dist-tag with `npm dist-tag add` after publish.'
              : null,
        },
      ]);
      totalIssues++;
      summary.push({ ...entry, status: 'failed' });
      continue;
    }
    const tagValue = parseNpmViewJson(tagResult.stdout);
    const tagIssues = validateNpmViewTagVersion(tagValue, { ...expected, tag: options.tag });
    if (tagIssues.length > 0) {
      reportIssues(tagIssues);
      totalIssues += tagIssues.length;
      summary.push({ ...entry, status: 'failed' });
      continue;
    }
    entry.tag_version = String(tagValue);
  }

  summary.push({ ...entry, status: 'ok' });
}

if (totalIssues > 0) {
  process.stderr.write(
    `\nnpm view verification FAILED: ${totalIssues} issue(s) across ${RELEASE_PACKAGE_DIRS.length} packages.\n`,
  );
  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        { ok: false, version: options.version, registry: options.registry, tag: options.tag, packages: summary },
        null,
        2,
      ) + '\n',
    );
  }
  process.exit(1);
}

if (options.json) {
  process.stdout.write(
    JSON.stringify(
      { ok: true, version: options.version, registry: options.registry, tag: options.tag, packages: summary },
      null,
      2,
    ) + '\n',
  );
} else {
  const tagSuffix = options.tag ? `, tag ${options.tag}` : '';
  process.stdout.write(
    `npm view verification passed. (${RELEASE_PACKAGE_DIRS.length} packages at ${options.version} on ${options.registry}${tagSuffix})\n`,
  );
}
process.exit(0);
