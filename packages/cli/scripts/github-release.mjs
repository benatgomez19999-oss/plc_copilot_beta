#!/usr/bin/env node
// Sprint 69 — `pnpm release:github`.
//
// Validates the inputs + release notes for a GitHub Release of an
// already-published @plccopilot version. Two modes:
//
//   pnpm release:github --validate-only --version 0.1.0 --tag v0.1.0
//     Local validation only — no network, no token, no confirm. Used by
//     the workflow's preflight job and by hand on the operator's
//     machine.
//
//   pnpm release:github --version 0.1.0 --tag v0.1.0
//                       --confirm "create GitHub release v0.1.0"
//     Real mode. Spawns `gh release create` with the validated argv.
//     Requires `gh` on PATH and a token with `contents: write` scope
//     (the workflow gives `${{ secrets.GITHUB_TOKEN }}` to the job).
//     Refuses to start if the tag already has a release (idempotency
//     guard — re-running is operator-controlled, not silent).
//
// This script is **never** allowed to spawn an npm command. The defence-
// in-depth check `assertNoNpmMutationSurface` runs against every argv
// before spawn; the parser also rejects `--publish` / `--dry-run` /
// `--no-dry-run` / `--dist-tag` / `--yes` / `-y` at parse time.
//
// Exit codes:
//   0  validate-only / release created (or already exists, in --skip-existing-release mode)
//   1  any input / notes / asset / gh failure

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleaseWorkspace } from './release-plan-lib.mjs';
import {
  GITHUB_RELEASE_PACKAGE_ORDER,
  assertNoNpmMutationSurface,
  buildGhReleaseCreateArgs,
  buildGhReleaseViewArgs,
  expectedGithubReleaseConfirmation,
  expectedGithubReleaseTag,
  expectedGithubReleaseTitle,
  parseGithubReleaseArgs,
  validateGithubReleaseAssets,
  validateGithubReleaseInputs,
  validateReleaseNotesForGithubRelease,
} from './github-release-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEFAULT_TARBALL_DIR = resolve(REPO_ROOT, '.release-artifacts', 'tarballs');

function die(message, code = 1) {
  process.stderr.write(`release-github: ${message}\n`);
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

function spawnGh(args) {
  // Defence-in-depth: refuse to spawn if any npm-mutation surface ever
  // leaked into the argv (tests pin both halves).
  assertNoNpmMutationSurface(args);
  return spawnSync('gh', [...args], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
}

const parsed = parseGithubReleaseArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  reportIssues(parsed.errors);
  process.exit(1);
}
const rawOptions = parsed.options ?? {};
if (rawOptions.help) {
  process.stdout.write(`pnpm release:github --validate-only --version X.Y.Z [--tag vX.Y.Z]
pnpm release:github --version X.Y.Z [--tag vX.Y.Z] --confirm "create GitHub release vX.Y.Z" [--notes-file PATH]

Validates inputs + release notes for a GitHub Release of an
already-published @plccopilot version. Real mode shells out to
\`gh release create\` and uploads the six release tarballs +
manifest.json from .release-artifacts/tarballs (override the
location with \`RELEASE_ARTIFACTS_DIR\`).

Always runs against a tag of shape v<version>. The runner never
mutates npm — \`assertNoNpmMutationSurface\` rejects publish /
dist-tag / npm tokens at the spawn boundary.

Package set:
  ${GITHUB_RELEASE_PACKAGE_ORDER.join('\n  ')}
`);
  process.exit(0);
}

const workspace = loadReleaseWorkspace(REPO_ROOT);
const { options, issues: optionIssues } = validateGithubReleaseInputs(
  { ...rawOptions },
  workspace,
);
if (optionIssues.length > 0) {
  reportIssues(optionIssues);
  process.exit(1);
}

// Resolve the release notes path: explicit `--notes-file` wins;
// otherwise default to docs/releases/<version>.md.
const notesFile =
  typeof options.notesFile === 'string' && options.notesFile.length > 0
    ? resolve(REPO_ROOT, options.notesFile)
    : resolve(REPO_ROOT, 'docs', 'releases', `${options.version}.md`);

if (!existsSync(notesFile)) {
  reportIssues([
    {
      level: 'error',
      code: 'GITHUB_RELEASE_NOTES_MISSING',
      message: `release notes file not found: ${notesFile}`,
      recommendation:
        'Create docs/releases/<version>.md (the canonical home for first-class release notes) before tagging.',
    },
  ]);
  process.exit(1);
}
const notesMarkdown = readFileSync(notesFile, 'utf-8');
const notesIssues = validateReleaseNotesForGithubRelease(notesMarkdown, {
  version: options.version,
});
if (notesIssues.length > 0) {
  reportIssues(notesIssues);
  process.exit(1);
}

if (options.validateOnly) {
  process.stdout.write(
    `GitHub Release inputs valid. ` +
      `(version ${options.version}, tag ${options.tag}, ` +
      `${GITHUB_RELEASE_PACKAGE_ORDER.length} packages; NO RELEASE CREATED)\n`,
  );
  process.exit(0);
}

// -------------------------------------------------------------------------
// Real path. From here on every spawn talks to GitHub.
// -------------------------------------------------------------------------

process.stdout.write(
  `Real GitHub release creation engaged. (version ${options.version}, tag ${options.tag})\n` +
    `Confirmation: ${expectedGithubReleaseConfirmation(options.version)}\n`,
);

// Asset discovery: the workflow runs `pnpm release:pack-artifacts` into
// `.release-artifacts/tarballs/`. Operator can override with
// `RELEASE_ARTIFACTS_DIR=...` for local testing.
const tarballDir = process.env.RELEASE_ARTIFACTS_DIR
  ? resolve(REPO_ROOT, process.env.RELEASE_ARTIFACTS_DIR)
  : DEFAULT_TARBALL_DIR;
const manifestPath = resolve(tarballDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  die(
    `manifest not found at ${manifestPath}. Run \`pnpm release:pack-artifacts --out ${tarballDir} --clean\` first.`,
  );
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
} catch (e) {
  die(`failed to parse manifest at ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
}
if (!manifest || !Array.isArray(manifest.packages)) {
  die(`manifest at ${manifestPath} is malformed (missing packages[]).`);
}
if (manifest.version !== options.version) {
  die(
    `manifest reports version ${JSON.stringify(manifest.version)} but --version is ${JSON.stringify(options.version)}. ` +
      'Re-run release:pack-artifacts after the version is in sync.',
  );
}

const tarballPaths = [];
for (const name of GITHUB_RELEASE_PACKAGE_ORDER) {
  const entry = manifest.packages.find((p) => p && p.name === name);
  if (!entry || typeof entry.filename !== 'string') {
    die(`manifest is missing an entry for ${name}.`);
  }
  tarballPaths.push(resolve(tarballDir, entry.filename));
}

const assetIssues = validateGithubReleaseAssets(
  { tarballPaths, manifestPath },
  { existsFn: (p) => existsSync(p) },
);
if (assetIssues.length > 0) {
  reportIssues(assetIssues);
  die('asset preflight failed; aborting before contacting GitHub.');
}

// Idempotency guard — refuse if a release for this tag already exists.
{
  const args = buildGhReleaseViewArgs({ tag: options.tag });
  const result = spawnGh(args);
  if (result.error) {
    die(
      `spawning gh release view failed: ${result.error.message}. ` +
        'Confirm `gh` is on PATH and authenticated.',
    );
  }
  if (result.status === 0) {
    die(
      `a GitHub Release for tag ${options.tag} already exists. ` +
        'Refusing to re-create. Inspect or delete the existing release manually if you really need to re-run.',
    );
  }
  // gh exits non-zero when the release isn't found; that's the happy
  // path here. We don't try to discriminate between "not found" and
  // "auth failed" because the next step (release create) will surface
  // any auth issue with a much clearer error.
}

const ghArgs = buildGhReleaseCreateArgs({
  version: options.version,
  tag: options.tag,
  title: expectedGithubReleaseTitle(options.version),
  notesFile,
  assetPaths: [...tarballPaths, manifestPath],
});

process.stdout.write(
  `gh ${ghArgs.join(' ')}\n` +
    `(${tarballPaths.length} tarball(s) + manifest.json from ${tarballDir})\n`,
);

const createResult = spawnGh(ghArgs);
if (createResult.error) {
  die(`spawning gh release create failed: ${createResult.error.message}.`);
}
if (createResult.status !== 0) {
  process.stderr.write(
    `gh release create exited ${createResult.status}.\n  stderr: ${truncate(createResult.stderr)}\n`,
  );
  die('GitHub Release creation FAILED.');
}

// Verification — re-read the release after creation.
{
  const args = buildGhReleaseViewArgs({ tag: options.tag });
  const result = spawnGh(args);
  if (result.error || result.status !== 0) {
    process.stderr.write(
      `post-create gh release view exited ${result.status}.\n  stderr: ${truncate(result.stderr)}\n`,
    );
    die('post-create verification FAILED — the release may or may not exist; check GitHub directly.');
  }
}

if (options.json) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        version: options.version,
        tag: options.tag,
        title: expectedGithubReleaseTitle(options.version),
        notes_file: notesFile,
        asset_count: tarballPaths.length + 1,
        tarball_dir: tarballDir,
      },
      null,
      2,
    ) + '\n',
  );
} else {
  process.stdout.write(
    `\nGitHub Release ${options.tag} created. ` +
      `(${tarballPaths.length} tarball(s) + manifest.json uploaded)\n`,
  );
}
process.exit(0);
