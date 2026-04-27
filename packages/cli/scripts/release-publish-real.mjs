#!/usr/bin/env node
// Sprint 63 — `pnpm release:publish-real`.
//
// Real npm publish runner. Two modes:
//
//   pnpm release:publish-real --validate-only --version X.Y.Z --tag <next|latest|beta>
//     Validates inputs against the workspace. Does NOT publish, does
//     NOT require NODE_AUTH_TOKEN, does NOT require --confirm. The
//     publish workflow's preflight job uses this to fail fast on
//     misaligned versions before reaching the protected environment.
//
//   pnpm release:publish-real --version X.Y.Z --tag <tag>
//                              --confirm "publish @plccopilot X.Y.Z"
//     Real publish. Requires NODE_AUTH_TOKEN in the environment.
//     Refuses to run unless --confirm matches the expected string
//     exactly. Spawns `npm publish --provenance --access public --tag <tag>`
//     for every release candidate in publish order. Stops on the
//     first failure.
//
// This script is the only place in the repo that can produce a real
// publish. The workflow's `npm-publish` GitHub Actions environment
// adds a manual approval gate around it.
//
// Exit codes:
//   0  validate-only / publish completed successfully
//   1  any input / token / publish failure (no rollback attempted)

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
  PUBLISH_ORDER,
  VALID_NPM_TAGS,
  buildNpmPublishCommand,
  expectedPublishConfirmation,
  validatePublishInputs,
} from './release-publish-real-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function die(message, code = 1) {
  process.stderr.write(`release-publish-real: ${message}\n`);
  process.exit(code);
}

function reportIssues(issues) {
  for (const i of issues) {
    process.stderr.write(`error: ${i.code}: ${i.message}\n`);
    if (i.recommendation) process.stderr.write(`  fix: ${i.recommendation}\n`);
  }
}

function parseArgs(argv) {
  const out = {
    version: null,
    tag: null,
    confirm: '',
    validateOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--validate-only') out.validateOnly = true;
    else if (a === '--version') {
      const next = argv[i + 1];
      if (!next) die('--version requires X.Y.Z');
      out.version = next;
      i++;
    } else if (a.startsWith('--version=')) {
      out.version = a.slice('--version='.length);
    } else if (a === '--tag') {
      const next = argv[i + 1];
      if (!next) die('--tag requires next|latest|beta');
      out.tag = next;
      i++;
    } else if (a.startsWith('--tag=')) {
      out.tag = a.slice('--tag='.length);
    } else if (a === '--confirm') {
      const next = argv[i + 1];
      if (next === undefined) die('--confirm requires the literal confirmation string');
      out.confirm = next;
      i++;
    } else if (a.startsWith('--confirm=')) {
      out.confirm = a.slice('--confirm='.length);
    } else if (a === '--dry-run' || a === '--no-dry-run') {
      die(
        `${a} is not a valid release:publish-real flag. Use \`pnpm release:publish-dry-run\` for dry-run.`,
      );
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`pnpm release:publish-real --validate-only --version X.Y.Z --tag next|latest|beta
pnpm release:publish-real --version X.Y.Z --tag <tag> --confirm "publish @plccopilot X.Y.Z"

Real npm publish runner. Always emits \`npm publish --provenance --access public --tag <tag>\`
in the canonical order:
  ${PUBLISH_ORDER.join('\n  ')}

The runner refuses to publish unless --confirm matches exactly:
  publish @plccopilot <version>

Real-mode requires NODE_AUTH_TOKEN in the environment. The repo wires
this up only via the GitHub Actions \`npm-publish\` environment.
`);
  process.exit(0);
}

const workspace = loadReleaseWorkspace(REPO_ROOT);
const { issues, expectedConfirm } = validatePublishInputs(
  {
    version: args.version,
    tag: args.tag,
    confirm: args.confirm,
    env: process.env,
    validateOnly: args.validateOnly,
  },
  workspace,
);
if (issues.length > 0) {
  reportIssues(issues);
  die(
    `Publish input validation FAILED (${issues.length} issue${issues.length === 1 ? '' : 's'}).`,
  );
}

if (args.validateOnly) {
  process.stdout.write(
    `Publish inputs valid. (version ${args.version}, tag ${args.tag}, validate-only — no token, no confirm checked, NO PACKAGES PUBLISHED)\n`,
  );
  process.exit(0);
}

// -------------------------------------------------------------------------
// Real publish path. From here on every spawn talks to the registry.
// -------------------------------------------------------------------------

const publishArgs = buildNpmPublishCommand({ tag: args.tag });
// Defence-in-depth — if a future refactor sneaks `--dry-run` in, abort.
if (publishArgs.includes('--dry-run')) {
  die('publish argv unexpectedly contains --dry-run; refusing to continue.');
}

process.stdout.write(
  `Real publish path engaged. (version ${args.version}, tag ${args.tag})\n` +
    `Confirmation: ${expectedConfirm}\n` +
    `Order: ${PUBLISH_ORDER.join(' -> ')}\n`,
);

const summary = [];
for (const c of workspace.candidates) {
  const expectedName = EXPECTED_PACKAGE_NAMES[c.dir];
  process.stdout.write(`Publishing ${expectedName}@${args.version} ...\n`);
  const result = spawnSync('npm', publishArgs, {
    cwd: c.packageDir,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) {
    die(`spawning npm publish for ${expectedName} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(
      `\nnpm publish for ${expectedName} exited ${result.status}.\n` +
        `Stopping immediately. Earlier packages in this run are now on the registry — see\n` +
        `docs/release-process.md "Partial publish recovery" before retrying.\n`,
    );
    process.exit(1);
  }
  summary.push({ package: expectedName, version: args.version, status: 'published' });
}

process.stdout.write(
  `\nReal publish completed. (${RELEASE_PACKAGE_DIRS.length} packages, version ${args.version}, tag ${args.tag})\n`,
);

// Echo the canonical summary on stdout so a workflow log can grep it.
process.stdout.write(JSON.stringify({ ok: true, version: args.version, tag: args.tag, results: summary }) + '\n');
process.exit(0);
