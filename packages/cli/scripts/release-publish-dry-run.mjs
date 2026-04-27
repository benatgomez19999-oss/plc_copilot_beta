#!/usr/bin/env node
// Sprint 62 — `pnpm release:publish-dry-run`.
//
// Runs `npm publish --dry-run --json` against every release candidate
// in publish order. The command is hardcoded — there is no flag or
// environment variable that can produce a non-dry-run invocation.
//
// Modes:
//   pnpm release:publish-dry-run            human summary on stdout
//   pnpm release:publish-dry-run --json     machine-readable summary
//   pnpm release:publish-dry-run --help
//
// Exit codes:
//   0  every candidate's dry-run passed
//   1  any candidate failed (consistency check, npm exit, JSON shape, name/version mismatch)

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  RELEASE_PACKAGE_DIRS,
  checkReleaseState,
  loadReleaseWorkspace,
} from './release-plan-lib.mjs';
import {
  buildPublishDryRunCommand,
  checkPublishDryRunSpawn,
} from './release-publish-dry-run-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function die(message, code = 1) {
  process.stderr.write(`release-publish-dry-run: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { json: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else die(`unknown argument: ${a}`);
  }
  return out;
}

function reportIssues(issues) {
  for (const i of issues) {
    const head = i.package ? `${i.package} — ${i.code}` : i.code;
    process.stderr.write(`error: ${head}: ${i.message}\n`);
    if (i.recommendation) process.stderr.write(`  fix: ${i.recommendation}\n`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`pnpm release:publish-dry-run [--json]

Runs \`npm publish --dry-run --json\` for each of the ${RELEASE_PACKAGE_DIRS.length} release
candidates in publish order. Never publishes for real — the --dry-run
flag is hardcoded.
`);
  process.exit(0);
}

// 1. Pre-flight consistency check.
const workspace = loadReleaseWorkspace(REPO_ROOT);
const { issues: stateIssues, sharedVersion } = checkReleaseState(workspace);
if (stateIssues.length > 0) {
  reportIssues(stateIssues);
  die('release consistency check failed; refusing to dry-run npm publish.');
}

// 2. One dry-run per candidate.
const summary = [];
let totalIssues = 0;
const command = buildPublishDryRunCommand();
for (const c of workspace.candidates) {
  const expected = {
    name: EXPECTED_PACKAGE_NAMES[c.dir],
    version: sharedVersion,
  };
  const result = spawnSync(command.cmd, command.args, {
    cwd: c.packageDir,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  const issues = checkPublishDryRunSpawn(result, expected);
  if (issues.length > 0) {
    reportIssues(issues);
    totalIssues += issues.length;
  }
  summary.push({
    package: expected.name,
    version: expected.version,
    status: issues.length === 0 ? 'ok' : 'failed',
    issues,
  });
}

if (totalIssues > 0) {
  process.stderr.write(
    `Release publish dry-run FAILED: ${totalIssues} issue(s) across ${RELEASE_PACKAGE_DIRS.length} candidates.\n`,
  );
  process.exit(1);
}

if (args.json) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        version: sharedVersion,
        package_count: RELEASE_PACKAGE_DIRS.length,
        results: summary,
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
}

process.stdout.write(
  `Release publish dry-run passed. (${RELEASE_PACKAGE_DIRS.length} packages, version ${sharedVersion}, no packages published)\n`,
);
process.exit(0);
