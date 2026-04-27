#!/usr/bin/env node
/**
 * Sprint 61 — `pnpm release:plan` / `release:check` / `release:pack-dry-run`.
 *
 * Modes:
 *   pnpm release:plan                     — patch plan, Markdown to stdout
 *   pnpm release:plan --bump minor        — minor plan
 *   pnpm release:plan --bump major        — major plan
 *   pnpm release:plan --version 0.2.0     — exact target
 *   pnpm release:plan --json              — JSON plan to stdout
 *   pnpm release:plan --out PATH          — write Markdown plan to PATH
 *   pnpm release:plan --bump patch --write
 *                                         — apply the plan to package.json files
 *                                           (does NOT run pnpm install or publish)
 *   pnpm release:check                    — exit 0 if repo is release-ready
 *   pnpm release:pack-dry-run             — release check + npm pack --dry-run
 *                                           against every publish candidate
 *
 * Exit codes:
 *   0  success / plan ok
 *   1  consistency check failed, plan was not produced, or pack dry-run failed
 *
 * Dependencies: Node built-ins only.
 */

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyReleasePlan,
  buildJsonPlan,
  buildReleasePlan,
  checkPackManifest,
  checkReleaseState,
  EXPECTED_PACKAGE_NAMES,
  loadReleaseWorkspace,
  RELEASE_PACKAGE_DIRS,
  renderMarkdownPlan,
} from './release-plan-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');

function die(message, code = 1) {
  console.error(`release-plan: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    check: false,
    packDryRun: false,
    json: false,
    write: false,
    bump: null,
    version: null,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--check') out.check = true;
    else if (a === '--pack-dry-run') out.packDryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--write') out.write = true;
    else if (a === '--bump') {
      const next = argv[i + 1];
      if (!next) die('--bump requires patch|minor|major');
      out.bump = next;
      i++;
    } else if (a.startsWith('--bump=')) {
      out.bump = a.slice('--bump='.length);
    } else if (a === '--version') {
      const next = argv[i + 1];
      if (!next) die('--version requires X.Y.Z');
      out.version = next;
      i++;
    } else if (a.startsWith('--version=')) {
      out.version = a.slice('--version='.length);
    } else if (a === '--out') {
      const next = argv[i + 1];
      if (!next) die('--out requires a path');
      out.out = resolve(process.cwd(), next);
      i++;
    } else if (a.startsWith('--out=')) {
      out.out = resolve(process.cwd(), a.slice('--out='.length));
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  if (out.bump && !['patch', 'minor', 'major'].includes(out.bump)) {
    die(`--bump must be one of patch|minor|major (got ${JSON.stringify(out.bump)})`);
  }
  if (out.bump && out.version) die('--bump and --version are mutually exclusive');
  if (out.write && !out.bump && !out.version) die('--write requires --bump or --version');
  if (out.check && (out.json || out.out || out.write || out.bump || out.version)) {
    die('--check is exclusive with --json/--out/--write/--bump/--version');
  }
  if (out.packDryRun && (out.json || out.out || out.write || out.bump || out.version)) {
    die('--pack-dry-run is exclusive with --json/--out/--write/--bump/--version');
  }
  if (out.check && out.packDryRun) die('--check and --pack-dry-run are mutually exclusive');
  return out;
}

function printHelp() {
  process.stdout.write(`pnpm release:plan / release:check / release:pack-dry-run

Modes:
  pnpm release:plan                     patch plan as Markdown
  pnpm release:plan --bump minor|major  bump-style plan
  pnpm release:plan --version 0.2.0     exact target plan
  pnpm release:plan --json              JSON plan
  pnpm release:plan --out FILE          write Markdown plan to FILE
  pnpm release:plan --bump <kind> --write
                                        apply the plan to package.json files
  pnpm release:check                    consistency check only
  pnpm release:pack-dry-run             release check + npm pack --dry-run for each candidate
`);
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
  printHelp();
  process.exit(0);
}

const workspace = loadReleaseWorkspace(REPO_ROOT);

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

if (args.check) {
  const { issues, sharedVersion } = checkReleaseState(workspace);
  if (issues.length > 0) {
    reportIssues(issues);
    process.stderr.write(
      `Release check FAILED: ${issues.length} issue(s) across ${RELEASE_PACKAGE_DIRS.length} packages.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Release check passed. (${RELEASE_PACKAGE_DIRS.length} packages at ${sharedVersion})\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --pack-dry-run
// ---------------------------------------------------------------------------

if (args.packDryRun) {
  const { issues, sharedVersion } = checkReleaseState(workspace);
  if (issues.length > 0) {
    reportIssues(issues);
    process.stderr.write('Release pack dry-run FAILED: consistency check did not pass.\n');
    process.exit(1);
  }
  let totalIssues = 0;
  for (const c of workspace.candidates) {
    const expected = {
      name: EXPECTED_PACKAGE_NAMES[c.dir],
      version: sharedVersion,
      requiredEntries:
        c.dir === 'cli'
          ? [
              'package.json',
              'dist/index.js',
              'dist/index.d.ts',
              'schemas/cli-result.schema.json',
              'schemas/serialized-compiler-error.schema.json',
              'schemas/generate-summary.schema.json',
              'schemas/web-zip-summary.schema.json',
            ]
          : ['package.json', 'dist/index.js', 'dist/index.d.ts'],
    };
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: c.packageDir,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      process.stderr.write(
        `npm pack --dry-run for ${expected.name} exited ${result.status}\n  stderr: ${result.stderr ?? ''}\n`,
      );
      process.exit(1);
    }
    let manifest;
    try {
      const raw = result.stdout;
      try {
        manifest = JSON.parse(raw);
      } catch {
        const i = raw.indexOf('[');
        manifest = JSON.parse(raw.slice(i));
      }
    } catch (e) {
      process.stderr.write(
        `cannot parse npm pack JSON for ${expected.name}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exit(1);
    }
    const packIssues = checkPackManifest(manifest, expected);
    if (packIssues.length > 0) {
      reportIssues(packIssues);
      totalIssues += packIssues.length;
    }
  }
  if (totalIssues > 0) {
    process.stderr.write(`Release pack dry-run FAILED: ${totalIssues} issue(s).\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Release pack dry-run passed. (${RELEASE_PACKAGE_DIRS.length} packages, version ${sharedVersion})\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// plan / write
// ---------------------------------------------------------------------------

const target = args.version
  ? { kind: 'exact', version: args.version }
  : { kind: 'bump', bump: args.bump ?? 'patch' };

const plan = buildReleasePlan(workspace, target);

if (args.write) {
  if (!plan.ok) {
    reportIssues(plan.issues);
    process.stderr.write('release-plan --write refused: plan is not ok.\n');
    process.exit(1);
  }
  const written = applyReleasePlan(workspace, plan);
  process.stdout.write(
    `Release package.json files updated to ${plan.target_version}. Wrote ${written.length} file(s).\n` +
      `Run pnpm install, pnpm publish:audit, and pnpm run ci to verify.\n`,
  );
  process.exit(0);
}

if (args.json) {
  process.stdout.write(JSON.stringify(buildJsonPlan(plan), null, 2) + '\n');
  process.exit(plan.ok ? 0 : 1);
}

const markdown = renderMarkdownPlan(plan);
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, markdown, 'utf-8');
  process.stdout.write(`Release plan written to ${args.out}\n`);
} else {
  process.stdout.write(markdown);
}
process.exit(plan.ok ? 0 : 1);
